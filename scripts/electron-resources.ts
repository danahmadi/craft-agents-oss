import { copyFileSync, cpSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Both resource-copy entry points must preserve the current compiled session helper. */
export function copyElectronResources(root: string): void {
  const sessionPackage = join(root, 'packages/session-mcp-server');
  const builtHelper = join(sessionPackage, 'dist/index.js');
  // Fail before copying any resources if the preceding build did not produce a helper.
  if (!statSync(builtHelper).isFile() || statSync(builtHelper).size === 0) {
    throw new Error(`Build the session MCP server before copying resources: ${builtHelper}`);
  }
  const resources = join(root, 'apps/electron/resources');
  const destination = join(root, 'apps/electron/dist/resources');
  cpSync(resources, destination, {
    recursive: true,
    force: true,
    filter: (source) => source !== join(resources, 'session-mcp-server'),
  });
  const sessionDestination = join(destination, 'session-mcp-server');
  mkdirSync(sessionDestination, { recursive: true });
  copyFileSync(builtHelper, join(sessionDestination, 'index.js'));
  // Preserve CommonJS semantics when nested inside the Electron app's type:module package.
  copyFileSync(join(sessionPackage, 'package.json'), join(sessionDestination, 'package.json'));
}
