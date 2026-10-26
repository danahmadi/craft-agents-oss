import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyElectronResources } from './electron-resources.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'craft-resource-copy-'));
  mkdirSync(join(root, 'apps/electron/resources/session-mcp-server'), { recursive: true });
  writeFileSync(join(root, 'apps/electron/resources/session-mcp-server/index.js'), 'stale');
  writeFileSync(join(root, 'apps/electron/resources/icon.txt'), 'asset');
  mkdirSync(join(root, 'packages/session-mcp-server/dist'), { recursive: true });
  writeFileSync(join(root, 'packages/session-mcp-server/package.json'), '{"type":"commonjs"}');
  return root;
}

describe('Electron resource assembly', () => {
  it('keeps the rebuilt helper through repeated asset copies and preserves its module type', () => {
    const root = fixture();
    writeFileSync(join(root, 'packages/session-mcp-server/dist/index.js'), 'rebuilt');
    copyElectronResources(root);
    copyElectronResources(root);
    const destination = join(root, 'apps/electron/dist/resources');
    expect(readFileSync(join(destination, 'session-mcp-server/index.js'), 'utf8')).toBe('rebuilt');
    expect(JSON.parse(readFileSync(join(destination, 'session-mcp-server/package.json'), 'utf8')).type).toBe('commonjs');
    expect(readFileSync(join(destination, 'icon.txt'), 'utf8')).toBe('asset');
  });

  it('fails before resource copying when the helper has not been built', () => {
    const root = fixture();
    expect(() => copyElectronResources(root)).toThrow();
    expect(existsSync(join(root, 'apps/electron/dist'))).toBe(false);
  });

  it('rejects an empty helper', () => {
    const root = fixture();
    writeFileSync(join(root, 'packages/session-mcp-server/dist/index.js'), '');
    expect(() => copyElectronResources(root)).toThrow('Build the session MCP server');
    expect(existsSync(join(root, 'apps/electron/dist'))).toBe(false);
  });
});
