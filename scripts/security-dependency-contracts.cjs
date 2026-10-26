#!/usr/bin/env node
'use strict';
// Offline dependency contracts: no installs, shell commands, network, or app launch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { gzipSync } = require('node:zlib');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.match(process.argv[i], /^--[a-z-]+$/);
  assert.ok(process.argv[i + 1], `Missing value for ${process.argv[i]}`);
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
args.modules = path.resolve(args.modules ?? path.join(__dirname, '..', 'node_modules'));
const resolver = createRequire(path.join(path.dirname(args.modules), '__craft_contract_resolver__.cjs'));
const packages = [];
const tests = [];
const facts = {};
let networkAttempts = 0;
function blockedNetwork() { networkAttempts++; throw new Error('Network disabled by offline contract fixture'); }
globalThis.fetch = blockedNetwork;
require('node:net').Socket.prototype.connect = blockedNetwork;
require('node:http').request = blockedNetwork;
require('node:https').request = blockedNetwork;
require('node:http').get = blockedNetwork;
require('node:https').get = blockedNetwork;

function metadata(entry, name) {
  let dir = path.dirname(fs.realpathSync(entry));
  while (true) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (p.name === name) return { name, version: p.version, root: dir, entry };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Cannot identify package ${name} for ${entry}`);
    dir = parent;
  }
}
function load(name, flag = name) {
  const entry = resolver.resolve(args[flag] ? path.resolve(args[flag]) : path.join(args.modules, name));
  const info = metadata(entry, name);
  packages.push(info);
  return { value: resolver(entry), info, require: createRequire(path.join(info.root, 'package.json')) };
}
async function test(name, kind, run) {
  const start = performance.now();
  try { await run(); tests.push({ name, kind, status: 'pass', ms: Math.round(performance.now() - start) }); }
  catch (error) { tests.push({ name, kind, status: 'fail', ms: Math.round(performance.now() - start), error: error.message }); }
}
async function withTmp(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'craft-critical-contract-'));
  try { return await run(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

// A small independent USTAR encoder permits unsafe path entries that tar.c would normalize.
function archive(entries) {
  const parts = [];
  for (const { name, data = Buffer.alloc(0), type = '0', link = '' } of entries) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const h = Buffer.alloc(512);
    const field = (s, offset, width) => { assert.ok(Buffer.byteLength(s) < width); h.write(s, offset, width, 'utf8'); };
    const octal = (n, offset, width) => field(n.toString(8).padStart(width - 1, '0'), offset, width);
    field(name, 0, 100); octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(body.length, 124, 12); octal(1, 136, 12); h.fill(32, 148, 156);
    h.write(type, 156, 1); field(link, 157, 100); h.write('ustar\0', 257, 6); h.write('00', 263, 2);
    const checksum = h.reduce((sum, byte) => sum + byte, 0);
    h.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

async function tarGroup() {
  const { value: tar } = load('tar');
  const extract = async (bytes, dest, options = {}) => {
    await fsp.mkdir(dest, { recursive: true });
    const stream = new PassThrough();
    const done = pipeline(stream, tar.x({ C: dest, gzip: true, ...options }));
    stream.end(gzipSync(bytes));
    await done;
  };
  await test('streamed gzip installation preserves nested binary and Unicode files', 'compatibility', () => withTmp(async dir => {
    const binary = Buffer.from([0, 1, 127, 128, 255, 0]);
    const text = 'Résumé — 雪\n';
    const dest = path.join(dir, 'dest');
    await extract(archive([{ name: 'bin/data', data: binary }, { name: 'docs/read me.txt', data: text }]), dest);
    assert.deepEqual(await fsp.readFile(path.join(dest, 'bin/data')), binary);
    assert.equal(await fsp.readFile(path.join(dest, 'docs/read me.txt'), 'utf8'), text);
  }));
  await test('parent traversal and symlink traversal cannot replace sibling sentinel', 'security', () => withTmp(async dir => {
    const dest = path.join(dir, 'dest');
    const outside = path.join(dir, 'outside');
    await fsp.mkdir(outside); await fsp.writeFile(path.join(outside, 'sentinel'), 'original');
    await extract(archive([
      { name: '../outside/sentinel', data: 'parent traversal' },
      { name: 'link', type: '2', link: '../outside' },
      { name: 'link/sentinel', data: 'symlink traversal' },
      { name: 'safe', data: 'accepted' },
    ]), dest);
    assert.equal(await fsp.readFile(path.join(outside, 'sentinel'), 'utf8'), 'original');
    assert.equal(await fsp.readFile(path.join(dest, 'safe'), 'utf8'), 'accepted');
  }));
  await test('hardlink outside extraction directory is rejected', 'security', () => withTmp(async dir => {
    const dest = path.join(dir, 'dest');
    await fsp.writeFile(path.join(dir, 'sentinel'), 'original');
    await extract(archive([{ name: 'hardlink', type: '1', link: '../sentinel' }]), dest);
    assert.equal(fs.existsSync(path.join(dest, 'hardlink')), false);
    assert.equal(await fsp.readFile(path.join(dir, 'sentinel'), 'utf8'), 'original');
  }));
  await test('bounded 64 KiB gzip expansion exceeds configured ratio and aborts', 'security', () => withTmp(async dir => {
    const bytes = archive([{ name: 'zeros', data: Buffer.alloc(64 * 1024) }]);
    facts.tarBound = { expandedBytes: bytes.length, compressedBytes: gzipSync(bytes).length, configuredRatio: 10 };
    await assert.rejects(extract(bytes, path.join(dir, 'dest'), { maxDecompressionRatio: 10 }), /decompress|ratio|abort/i);
  }));
}

async function shellGroup() {
  const { value: shell } = load('shell-quote');
  await test('CLI parsing retains arguments and separates control operators', 'compatibility', () => {
    assert.deepEqual(shell.parse('FOO=bar node "my script.js" --name=\'A B\' | cat && printf ok'),
      ['FOO=bar', 'node', 'my script.js', '--name=A B', { op: '|' }, 'cat', { op: '&&' }, 'printf', 'ok']);
    assert.deepEqual(shell.parse('echo "$NAME"', { NAME: 'value with spaces' }), ['echo', 'value with spaces']);
  });
  await test('ordinary command argument quoting preserves punctuation, Unicode, and newline data', 'compatibility', () => {
    const words = ['', 'simple', 'two words', "single'quote", 'double"quote', '$NAME', '`data`', '; && |', 'line\nbreak', '雪'];
    assert.deepEqual(shell.parse(shell.quote(words), {}), words);
  });
  for (const newline of ['\n', '\r', '\u2028', '\u2029']) {
    await test(`invalid object operator containing U+${newline.charCodeAt(0).toString(16).padStart(4, '0')} is rejected`, 'security', () => {
      assert.throws(() => shell.quote([{ op: ';' + newline + 'fixture_marker' }]), TypeError);
    });
  }
  await test('env callback cannot introduce an invalid operator into quote()', 'security', () => {
    const tokens = shell.parse('echo $INPUT', () => ({ op: ';\nfixture_marker' }));
    assert.throws(() => shell.quote(tokens), TypeError);
  });
  try { facts.ordinaryCommentQuote = { supported: true, result: shell.quote(['echo', 'ok', { comment: 'fixture' }, 'plain']) }; }
  catch (error) { facts.ordinaryCommentQuote = { supported: false, error: error.message }; }
  for (const newline of ['\n', '\r', '\u2028', '\u2029']) {
    await test(`string after comment containing U+${newline.charCodeAt(0).toString(16).padStart(4, '0')} is rejected`, 'security', () => {
      assert.throws(() => shell.quote(['echo', 'ok', { comment: 'fixture' }, 'data' + newline + 'fixture_marker;#']), TypeError);
    });
  }
  await test('parsed URL fragment comment cannot enable a later newline argument', 'security', () => {
    const tokens = shell.parse('echo https://example.invalid/#fragment');
    assert.ok(tokens.some(token => token && typeof token === 'object' && 'comment' in token));
    assert.throws(() => shell.quote(tokens.concat('data\nfixture_marker;#')), TypeError);
  });
}

async function protobufGroup() {
  const { value: pb, info } = load('protobufjs');
  const Type = pb.Root.fromJSON({ nested: { Fixture: { fields: {
    label: { type: 'string', id: 1 }, count: { type: 'uint64', id: 2 },
    blob: { type: 'bytes', id: 3 }, values: { rule: 'repeated', type: 'sint32', id: 4 },
  } } } }).lookupType('Fixture');
  const message = { label: '雪', count: '9007199254740993', blob: Buffer.from([0, 255]), values: [-1, 0, 300] };
  const wire = Buffer.from('0a03e99baa1081808080808080101a0200ff22040100d804', 'hex');
  await test('protobuf reflection preserves fixed wire vector including uint64 beyond JS safe integer', 'compatibility', () => {
    const input = Type.fromObject(message);
    assert.equal(Type.verify(input), null);
    assert.deepEqual(Buffer.from(Type.encode(input).finish()), wire);
    assert.deepEqual(Type.toObject(Type.decode(wire), { longs: String, bytes: Buffer }), message);
  });
  await test('protobuf ignores an unknown wire field without altering known data', 'compatibility', () => {
    assert.deepEqual(Type.toObject(Type.decode(Buffer.concat([wire, Buffer.from([0x98, 0x06, 0x07])])), { longs: String, bytes: Buffer }), message);
  });
  await test('protobuf rejects a truncated uint64 varint', 'security', () => {
    assert.throws(() => Type.decode(Buffer.from([0x10, 0x80])), /range|buffer|index/i);
  });
  // BufferReader.string historically clamps to the remaining buffer. Record this
  // observed behavior rather than claiming a guarantee the API does not provide.
  try { facts.truncatedStringBufferObservation = Type.toObject(Type.decode(Buffer.from([0x0a, 0x7f, 0x61]))); }
  catch (error) { facts.truncatedStringBufferObservation = { rejected: error.message }; }
  // Actual GenAI statically generated model decoder imports protobufjs/minimal.js.
  const genaiEntry = resolver.resolve(args.genai ? path.resolve(args.genai) : path.join(args.modules, '@google/genai'));
  const genaiInfo = metadata(genaiEntry, '@google/genai'); packages.push(genaiInfo);
  const genaiRequire = createRequire(path.join(genaiInfo.root, 'package.json'));
  const tokenizerEntry = genaiRequire.resolve('@google/genai/tokenizer');
  const pbEntry = createRequire(tokenizerEntry).resolve('protobufjs/minimal.js');
  const actualPb = metadata(pbEntry, 'protobufjs'); packages.push({ ...actualPb, consumer: '@google/genai/tokenizer' });
  facts.sameProtobufPackageAsTokenizer = fs.realpathSync(info.root) === fs.realpathSync(actualPb.root);
  const minimal = resolver(pbEntry);
  const { LocalTokenizer } = genaiRequire('@google/genai/tokenizer');
  function model() {
    const w = minimal.Writer.create();
    for (const [piece, score, type] of [['<unk>', 0, 2], ['a', 0, 1], ['b', 0, 1], ['ab', 5, 1]]) {
      w.uint32(10).fork().uint32(10).string(piece).uint32(21).float(score).uint32(24).int32(type).ldelim();
    }
    w.uint32(18).fork().uint32(24).int32(2).uint32(32).int32(4).ldelim();
    w.uint32(26).fork().uint32(24).bool(false).uint32(32).bool(false).uint32(40).bool(false).ldelim();
    return w.finish();
  }
  await test('actual GenAI decoder and public token APIs accept an in-memory SentencePiece BPE model', 'compatibility', async () => {
    const tokenizer = new LocalTokenizer('gemini-2.0-flash-001');
    assert.equal(typeof tokenizer.baseTokenizer?.ProcessorClass, 'function', 'GenAI internal test seam changed; do not silently skip');
    // Inject only the local model: bypass all fetch/cache reads and writes.
    tokenizer.baseTokenizer.processor = new tokenizer.baseTokenizer.ProcessorClass(model());
    assert.deepEqual(await tokenizer.countTokens('abab'), { totalTokens: 2 });
    assert.deepEqual(await tokenizer.computeTokens('ab'), { tokensInfo: [{ tokenIds: ['3'], tokens: ['YWI='], role: 'user' }] });
    assert.deepEqual(await tokenizer.computeTokens([{ role: 'model', parts: [{ text: 'a' }, { text: 'b' }] }]),
      { tokensInfo: [{ tokenIds: ['1', '2'], tokens: ['YQ==', 'Yg=='], role: 'model' }] });
    assert.throws(() => new tokenizer.baseTokenizer.ProcessorClass(Buffer.from([0x0a, 0x7f, 0x61])), /range|buffer|index/i);
  });
}

async function xmlGroup() {
  const { value: xml, require: xmlRequire } = load('@aws-sdk/xml-builder', 'xml-builder');
  try { packages.push({ ...metadata(xmlRequire.resolve('fast-xml-parser'), 'fast-xml-parser'), consumer: '@aws-sdk/xml-builder' }); }
  catch { facts.externalXmlParser = 'Not resolved; this AWS builder may bundle/replace its parser'; }
  await test('AWS XmlNode serialization escapes text and attributes without changing values', 'compatibility', () => {
    const text = 'Résumé <&> "quote" \'single\'\r\n雪';
    const out = xml.XmlNode.of('Key', text).addAttribute('name', '<&"').toString();
    assert.equal(out, '<Key name="&lt;&amp;&quot;">Résumé &lt;&amp;&gt; &quot;quote&quot; &apos;single&apos;&#x0D;&#x0A;雪</Key>');
    assert.deepEqual(xml.parseXML(out), { Key: { '#text': text, name: '<&"' } });
  });
  await test('AWS parser preserves S3 list/error response shapes, repeated entries and numeric strings', 'compatibility', () => {
    const list = '<ListBucketResult xmlns="urn:fixture"><Name>bucket</Name><Contents><Key>a &amp; b</Key><Size>001</Size></Contents><Contents><Key>雪</Key><Size>2</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>';
    assert.deepEqual(xml.parseXML(list), { ListBucketResult: { Name: 'bucket', Contents: [{ Key: 'a & b', Size: '001' }, { Key: '雪', Size: '2' }], IsTruncated: 'false', xmlns: 'urn:fixture' } });
    assert.deepEqual(xml.parseXML('<Error><Code>NoSuchKey</Code><Message> missing </Message><RequestId>0001</RequestId></Error>'),
      { Error: { Code: 'NoSuchKey', Message: ' missing ', RequestId: '0001' } });
  });
  await test('AWS parser rejects malformed closing tags', 'security', () => assert.throws(() => xml.parseXML('<root><Key>x</root>')));
  await test('DOCTYPE dotted entity name cannot shadow a built-in XML entity', 'security', () => {
    const input = '<!DOCTYPE root [<!ENTITY l. "REPLACED">]><root><Key>&lt;b&gt;</Key></root>';
    let result;
    try { result = xml.parseXML(input); }
    catch (error) { facts.xmlDtdPolicy = `Rejected: ${error.message}`; return; }
    assert.equal(result.root.Key, '<b>');
  });
}

async function proxyGroup() {
  const { value: proxy } = load('proxy-addr');
  const req = (remote, forwarded) => ({ socket: { remoteAddress: remote }, connection: { remoteAddress: remote }, headers: { 'x-forwarded-for': forwarded } });
  await test('untrusted direct client cannot replace its IP using forwarded headers', 'compatibility', () => {
    assert.equal(proxy(req('203.0.113.1', '198.51.100.2'), []), '203.0.113.1');
    assert.equal(proxy(req('127.0.0.1', '198.51.100.2, 10.2.3.4'), ['loopback', '10.0.0.0/8']), '198.51.100.2');
  });
  await test('correct IPv4-mapped subnet trusts its intended range only', 'compatibility', () => {
    const trust = proxy.compile('::ffff:10.0.0.0/104');
    assert.equal(trust('10.2.3.4'), true); assert.equal(trust('203.0.113.1'), false);
  });
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
    await test(`IPv6 trust subnet ${subnet} does not trust arbitrary IPv4 peer`, 'security', () => {
      let trust;
      try { trust = proxy.compile(subnet); } catch (error) { return; }
      assert.equal(trust('203.0.113.1'), false);
      assert.equal(proxy(req('203.0.113.1', '198.51.100.2'), trust), '203.0.113.1');
    });
  }
}

async function ftpGroup() {
  const { value: ftp } = load('basic-ftp');
  // Exercise real directory traversal logic with only protocol operations replaced.
  // The sink records paths; it does not write any downloaded file.
  async function listingDownload(names, root) {
    const client = new ftp.Client();
    const destinations = [];
    client.pwd = async () => '/fixture'; client.cd = async () => ({ code: 250, message: 'fixture' });
    client.list = async () => names.map(name => ({ name, isFile: true, isDirectory: false }));
    client.downloadTo = async (destination, remote) => { destinations.push({ destination, remote }); return { code: 226, message: 'fixture' }; };
    let error;
    try { await client.downloadToDir(root); } catch (e) { error = e.message; }
    finally { client.close(); }
    return { destinations, error };
  }
  await test('FTP ordinary directory names preserve destination and remote name', 'compatibility', () => withTmp(async dir => {
    const result = await listingDownload(['report.txt', 'snow 雪.txt'], dir);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.destinations, ['report.txt', 'snow 雪.txt'].map(remote => ({ destination: path.join(dir, remote), remote })));
  }));
  await test('FTP directory traversal listing never reaches a sink outside chosen directory', 'security', () => withTmp(async dir => {
    const root = path.join(dir, 'dest');
    const result = await listingDownload(['../outside.txt'], root);
    for (const { destination } of result.destinations) {
      const relative = path.relative(root, destination);
      assert.ok(relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative), `Escaped download destination: ${relative}`);
    }
    facts.ftpTraversal = result;
  }));
}

const groups = { tar: tarGroup, shell: shellGroup, protobuf: protobufGroup, xml: xmlGroup, proxy: proxyGroup, ftp: ftpGroup };
if (!args.worker) {
  const selected = args.groups ? args.groups.split(',') : Object.keys(groups);
  const reports = [];
  for (const group of selected) {
    assert.ok(groups[group], `Unknown group: ${group}`);
    const result = spawnSync(process.execPath, ['--max-old-space-size=256', __filename, ...process.argv.slice(2), '--worker', group],
      { timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024,
        // A preserved tree can be renamed outside a directory named node_modules.
        // Restore only that tree's top-level lookup; nested package resolution wins.
        env: { ...process.env, NODE_PATH: args.modules } });
    let report;
    try { report = JSON.parse(result.stdout); }
    catch { report = { group, fatal: result.error?.message || result.stderr || 'Missing JSON worker result', exitCode: result.status, signal: result.signal }; }
    reports.push(report);
  }
  const allTests = reports.flatMap(x => x.tests || []);
  const failures = allTests.filter(t => t.status !== 'pass').length + reports.filter(x => x.fatal).length;
  const report = { at: new Date().toISOString(), node: process.version, modules: args.modules, reports,
    summary: { pass: allTests.length - allTests.filter(t => t.status !== 'pass').length, fail: failures },
    limitations: [
      'Offline dependency contracts only: not full Craft runtime, packaged Electron, provider integration, Windows, or advisory closure proof.',
      'GenAI uses a synthetic BPE vocabulary and its private ProcessorClass seam to avoid downloading/caching a real model.',
      'The protobuf reflection code-generation advisory is not exploited here; actual GenAI uses its static generated model decoder.',
      'Both tested protobuf versions accept an oversized string length in a Node Buffer by clamping it; this separate observation is recorded, not claimed fixed.',
      'Tar ratio test uses only 64 KiB with explicit threshold 10; this is not a large-file benchmark or complete tar advisory corpus.',
      'FTP protocol operations and file-download sink are replaced by in-memory stubs; Craft get-uri uses stream download, not downloadToDir.',
      'Package overrides select a test entry only; they do not change nested consumer resolution. Inspect each reported consumer package path/version.'
    ] };
  console.log(JSON.stringify(report, null, 2)); process.exitCode = failures ? 1 : 0;
} else {
  (async () => {
    let fatal;
    try { await groups[args.worker](); } catch (error) { fatal = error.stack; }
    await test('offline guard observed no network attempt', 'safety', () => assert.equal(networkAttempts, 0));
    console.log(JSON.stringify({ group: args.worker, packages, facts, tests, ...(fatal ? { fatal } : {}) }));
    process.exitCode = fatal || tests.some(t => t.status !== 'pass') ? 1 : 0;
  })();
}
