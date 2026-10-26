import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Exercise the actual bundled helper with local fixture data and no provider credentials. */
export async function validateSessionMcpPackage(distribution: string, temporaryRoot: string): Promise<void> {
  const workspace = join(temporaryRoot, 'mcp-workspace');
  const skillDirectory = join(workspace, 'skills/security-fixture');
  mkdirSync(skillDirectory, { recursive: true });
  const skill = join(skillDirectory, 'SKILL.md');
  writeFileSync(skill, '---\nname: Security fixture\ndescription: Local package validation\n---\n# Instructions\nUse local fixture data.\n');
  const client = new Client({ name: 'server-package-validation', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: join(distribution, 'vendor/bun/bun'),
    args: ['--no-install', join(distribution, 'resources/session-mcp-server/index.js'), '--session-id', 'package-validation', '--workspace-root', workspace, '--plans-folder', join(workspace, 'plans')],
    cwd: distribution,
    env: { PATH: process.env.PATH ?? '', HOME: temporaryRoot, CRAFT_CONFIG_DIR: join(temporaryRoot, 'config') },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    await client.ping();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.find(tool => tool.name === 'SubmitPlan')?.inputSchema.required, ['planPath']);
    const permission = tools.find(tool => tool.name === 'spawn_session')?.inputSchema.properties?.permissionMode as { enum?: string[] } | undefined;
    assert.deepEqual(permission?.enum, ['safe', 'ask', 'allow-all']);
    assert.equal((await client.callTool({ name: 'skill_validate', arguments: { skillSlug: 'security-fixture' } })).isError, false);
    writeFileSync(skill, '---\nname: 123\ndescription: Invalid local fixture\n---\n# Invalid\n');
    assert.equal((await client.callTool({ name: 'skill_validate', arguments: { skillSlug: 'security-fixture' } })).isError, true);
    console.log(`Relocated session helper stdio/schema checks passed (${tools.length} tools).`);
  } finally {
    await client.close();
  }
}
