/** Verify an unpacked Electron artifact without starting the application. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [appRootArgument, executableArgument] = process.argv.slice(2);
if (!appRootArgument || !executableArgument) {
  throw new Error('Usage: bun run test:electron:package <unpacked app resources/app> <Electron executable>');
}
const appRoot = resolve(appRootArgument);
const executable = resolve(executableArgument);
const sourceRoot = resolve(import.meta.dir, '..');
const expectedVersion = JSON.parse(readFileSync(join(sourceRoot, 'node_modules/electron/package.json'), 'utf8')).version;
const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'craft-electron-package-')));
for (let ancestor = temporaryRoot; ; ancestor = dirname(ancestor)) {
  assert(!existsSync(join(ancestor, 'node_modules')), `Ancestor node_modules would mask omitted dependencies: ${ancestor}`);
  if (ancestor === dirname(ancestor)) break;
}
const environment = {
  PATH: process.env.PATH ?? '',
  HOME: temporaryRoot,
  CRAFT_CONFIG_DIR: join(temporaryRoot, 'config'),
  ELECTRON_RUN_AS_NODE: '1',
};
const version = spawnSync(executable, ['-p', 'JSON.stringify(process.versions)'], {
  cwd: temporaryRoot, env: environment, encoding: 'utf8', timeout: 30_000,
});
assert.equal(version.status, 0, version.stderr || version.error?.message);
const versions = JSON.parse(version.stdout);
assert.equal(versions.electron, expectedVersion, 'Packaged Electron must match the installed locked version');

assert(!existsSync(join(appRoot, 'resources/session-mcp-server/index.js')), 'Stale primary helper must not compete with rebuilt dist helper');
const packagedHelper = join(appRoot, 'dist/resources/session-mcp-server');
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(hash(join(packagedHelper, 'index.js')), hash(join(sourceRoot, 'packages/session-mcp-server/dist/index.js')));
const relocated = join(temporaryRoot, 'app');
mkdirSync(relocated);
// Keep the enclosing app's actual module semantics when relocating the helper.
cpSync(join(appRoot, 'package.json'), join(relocated, 'package.json'));
cpSync(packagedHelper, join(relocated, 'session-mcp-server'), { recursive: true, dereference: true });
const workspace = join(temporaryRoot, 'workspace');
const skill = join(workspace, 'skills/security-fixture/SKILL.md');
mkdirSync(dirname(skill), { recursive: true });
writeFileSync(skill, '---\nname: Security fixture\ndescription: Local package validation fixture\n---\n# Instructions\nUse only local fixture data.\n');
const client = new Client({ name: 'package-validation', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: executable,
  args: [join(relocated, 'session-mcp-server/index.js'), '--session-id', 'package-validation', '--workspace-root', workspace, '--plans-folder', join(workspace, 'plans')],
  cwd: relocated,
  env: environment,
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  await client.ping();
  const { tools } = await client.listTools();
  const plan = tools.find(tool => tool.name === 'SubmitPlan');
  assert.deepEqual(plan?.inputSchema.required, ['planPath']);
  const spawn = tools.find(tool => tool.name === 'spawn_session');
  const permission = spawn?.inputSchema.properties?.permissionMode as { enum?: string[] } | undefined;
  assert.deepEqual(permission?.enum, ['safe', 'ask', 'allow-all']);
  const valid = await client.callTool({ name: 'skill_validate', arguments: { skillSlug: 'security-fixture' } });
  assert.equal(valid.isError, false);
  writeFileSync(skill, '---\nname: 123\ndescription: Invalid local fixture\n---\n# Invalid name\n');
  const invalid = await client.callTool({ name: 'skill_validate', arguments: { skillSlug: 'security-fixture' } });
  assert.equal(invalid.isError, true);
  console.log(JSON.stringify({ electron: versions.electron, node: versions.node, tools: tools.length, protocol: 'passed', schemaValidation: 'passed', relocated }));
} finally {
  await client.close();
}
