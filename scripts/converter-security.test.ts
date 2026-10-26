import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { RSSConverter } from 'markitdown-js'

const require = createRequire(import.meta.url)
const root = mkdtempSync(join(tmpdir(), 'craft-converter-security-'))
const wrapperPath = require.resolve('node-tesseract-ocr')

// Load the actual installed wrapper with only its process boundary replaced.
// No shell is ever executed, including when these tests run against the baseline.
function instrumentWrapper(error: Error | null = null) {
  const calls: { binary: string; args: string[] }[] = []
  const chunks: Buffer[] = []
  let ended = false
  let url = ''
  const stdin = { write: (chunk: Buffer) => chunks.push(chunk), end: () => { ended = true } }
  const module = { exports: {} as typeof import('node-tesseract-ocr') }
  runInNewContext(readFileSync(wrapperPath, 'utf8'), {
    module, Buffer, console,
    require(name: string) {
      if (name === 'child_process') return {
        exec() { throw new Error('Shell execution is forbidden') },
        execFile(binary: string, args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) {
          calls.push({ binary, args })
          queueMicrotask(() => callback(error, 'recognized text\n', 'diagnostic'))
          return { stdin }
        },
      }
      if (name === 'https') return {
        get(input: string, callback: (response: { pipe: (target: typeof stdin) => void }) => void) {
          url = input
          callback({ pipe(target) { expect(target).toBe(stdin); target.write(Buffer.from('remote fixture')); target.end() } })
        },
      }
      throw new Error(`Unexpected dependency: ${name}`)
    },
  }, { filename: wrapperPath })
  return { recognize: module.exports.recognize, calls, chunks, state: () => ({ ended, url }) }
}

describe('patched OCR process boundary', () => {
  test('passes hostile filename, executable path, options and presets as literal arguments', async () => {
    const wrapper = instrumentWrapper()
    const filename = '/fixture/image $(printf injected) `echo token` ; & ".png'
    const result = await wrapper.recognize(filename, {
      binary: '/fixture/bin with spaces/tesseract', lang: 'eng+deu', psm: 6, dpi: 300,
      'tessdata-dir': '/fixture/data with spaces', tessedit_char_whitelist: 'ABC $() ; &',
      presets: ['txt', 'literal preset'], debug: false,
    })
    expect(result).toBe('recognized text\n')
    expect(wrapper.calls).toEqual([{ binary: '/fixture/bin with spaces/tesseract', args: [
      filename, 'stdout', '-l', 'eng+deu', '--psm', '6', '--dpi', '300',
      '--tessdata-dir', '/fixture/data with spaces', '-c', 'tessedit_char_whitelist=ABC $() ; &',
      'txt', 'literal preset',
    ] }])
    expect(wrapper.chunks).toHaveLength(0)
  })

  test('preserves Buffer and array stdin handling', async () => {
    for (const [input, expected] of [[Buffer.from([0, 255, 10]), Buffer.from([0, 255, 10])], [['first', 'second'], Buffer.from('first\nsecond')]] as const) {
      const wrapper = instrumentWrapper()
      await wrapper.recognize(input as Buffer | string[])
      expect(wrapper.calls[0]).toEqual({ binary: 'tesseract', args: ['stdin', 'stdout'] })
      expect(Buffer.concat(wrapper.chunks)).toEqual(expected)
      expect(wrapper.state().ended).toBe(true)
    }
  })

  test('preserves URL stream routing without a network call', async () => {
    const wrapper = instrumentWrapper()
    await wrapper.recognize('https://fixture.invalid/image.png')
    expect(wrapper.state()).toEqual({ ended: true, url: 'https://fixture.invalid/image.png' })
    expect(Buffer.concat(wrapper.chunks).toString()).toBe('remote fixture')
  })

  test('preserves process error rejection', async () => {
    const error = new Error('fixture process failure')
    await expect(instrumentWrapper(error).recognize('/fixture/image.png')).rejects.toBe(error)
  })

  test('real execFile preserves literal argv/stdin and missing-binary errors', async () => {
    const binary = join(root, 'fake tesseract')
    writeFileSync(binary, `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[0]==='stdin'){let chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>console.log(JSON.stringify({args,stdin:Buffer.concat(chunks).toString('base64')})));}else{console.log(JSON.stringify({args}));}\n`)
    chmodSync(binary, 0o755)
    const { recognize } = require('node-tesseract-ocr') as typeof import('node-tesseract-ocr')
    const filename = join(root, 'image $(printf injected) `echo literal`.png')
    expect(JSON.parse(await recognize(filename, { binary, psm: 6 })).args).toEqual([filename, 'stdout', '--psm', '6'])
    expect(JSON.parse(await recognize(Buffer.from([0, 255]), { binary })).stdin).toBe('AP8=')
    await expect(recognize(filename, { binary: join(root, 'missing binary') })).rejects.toHaveProperty('code', 'ENOENT')
  })
})

const xmlFixtures = [
  { name: 'generic XML attributes, namespaces, entities and CDATA', xml: '<root xmlns:n="urn:test"><item id="a" n:kind="x">One &amp; two</item><group><child><![CDATA[<literal>]]></child><child>é</child></group></root>', expected: { title: null, textContent: '# root\n\n - item: One & two\n   id - "a"\n   n:kind - "x"\n - group: \n     - child: <literal>\n     - child: é' } },
  // Preserve existing upstream feed formatting, including its object coercion;
  // repairing feed presentation is outside this security patch.
  { name: 'RSS', xml: '<rss><channel><title>News &amp; Notes</title><description>Updates</description><item><title>Entry</title><description><![CDATA[<b>Bold</b>]]></description></item></channel></rss>', expected: { title: 'News & Notes', textContent: '# News & Notes\nUpdates\n\n## Entry.\n[object Object].\n\n' } },
  { name: 'Atom', xml: '<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><entry><title>Item</title><summary>Summary &amp; more</summary></entry></feed>', expected: { title: 'Feed', textContent: '# Feed\n\n## Item\n[object Object]\n' } },
]

const cjs = require(join(dirname(require.resolve('markitdown-js/package.json')), 'dist/markitdown.cjs')) as { RSSConverter: typeof RSSConverter }
for (const [format, Converter] of [['ESM', RSSConverter], ['CJS', cjs.RSSConverter]] as const) {
  describe(`patched ${format} XML consumer`, () => {
    for (const fixture of xmlFixtures) test(`preserves ${fixture.name} output`, async () => {
      const file = join(root, `${format}-${xmlFixtures.indexOf(fixture)}.xml`)
      writeFileSync(file, fixture.xml)
      expect(await new Converter().convert(file, { fileExtension: '.xml' })).toEqual(fixture.expected)
    })
    for (const xml of ['<one/><two/>', '<one><two></one>', '<one>&undefined;</one>']) test(`rejects malformed XML ${xml}`, async () => {
      const file = join(root, `${format}-malformed.xml`)
      writeFileSync(file, xml)
      expect(await new Converter().convert(file, { fileExtension: '.xml' })).toBeNull()
    })
  })
}
