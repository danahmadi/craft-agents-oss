/** Explicit offline integration gate; requires an already installed Tesseract. */
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ImageConverter } from 'markitdown-js'

const require = createRequire(import.meta.url)
const { recognize } = require('node-tesseract-ocr') as typeof import('node-tesseract-ocr')
const binary = process.env.TESSERACT_BINARY || 'tesseract'
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).split('\n')[0]
const temporaryRoot = mkdtempSync(join(tmpdir(), 'craft-ocr-runtime-'))
const image = join(temporaryRoot, 'image $(printf injected) `printf literal`.png')
copyFileSync(join(import.meta.dir, 'fixtures/converters/ocr-text.png'), image)
const expected = 'CRAFT SECURITY 123'
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
assert.equal(normalize(await recognize(image, { binary })), expected)
assert.equal(normalize(await recognize(readFileSync(image), { binary })), expected)
await assert.rejects(recognize(join(temporaryRoot, 'absent.png'), { binary }))

// Exercise the actual MarkItDown ImageConverter OCR call. Metadata extraction and
// model description are independent of OCR and replaced to avoid external tools
// or providers. Tesseract itself and recognize() remain real and unchanged.
const converter = new ImageConverter()
Object.assign(converter, { _getMetadata: async () => null, _getLlmDescription: async () => null })
// ImageConverter uses the normal tesseract lookup and passes no custom config.
// The already provisioned binary's directory is a local process-only PATH entry.
const previousPath = process.env.PATH
if (binary.includes('/')) process.env.PATH = `${dirname(binary)}:${previousPath ?? ''}`
try {
  const result = await converter.convert(image, { fileExtension: '.png' })
  assert.equal(normalize(result?.textContent ?? ''), `# Text: ${expected}`)
} finally {
  process.env.PATH = previousPath
}
console.log(JSON.stringify({ version, localFilename: 'passed', bufferInput: 'passed', missingFile: 'passed', imageConverter: 'passed', temporaryRoot }))
