/** Validate an assembled distribution without access to source-tree dependencies. */
import { cpSync, existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const sourceRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const distribution = resolve(process.argv[2] ?? 'dist/server')
if (!existsSync(join(distribution, 'vendor/bun/bun'))) {
  throw new Error(`Build the standalone server first; no bundled Bun in ${distribution}`)
}

const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'craft-server-package-')))
const fromSource = relative(sourceRoot, temporaryRoot)
if (!fromSource || (!fromSource.startsWith('..') && !isAbsolute(fromSource))) {
  throw new Error('Package validation must run outside the source checkout')
}
for (let ancestor = temporaryRoot; ; ancestor = dirname(ancestor)) {
  if (existsSync(join(ancestor, 'node_modules'))) {
    throw new Error(`Ancestor dependencies would mask packaging omissions: ${ancestor}`)
  }
  if (dirname(ancestor) === ancestor) break
}

const relocated = join(temporaryRoot, 'package')
cpSync(distribution, relocated, { recursive: true, dereference: true })
console.log(`Validating relocated package: ${relocated}`)
const result = spawnSync(join(relocated, 'vendor/bun/bun'), [
  '--no-install',
  'test',
  './packages/server-core/src/runtime/platform-headless-image.test.ts',
], {
  cwd: relocated,
  stdio: 'inherit',
  env: { ...process.env, CRAFT_CONFIG_DIR: join(temporaryRoot, 'config') },
})
if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`Relocated package validation failed (${result.status ?? result.signal}); preserved at ${relocated}`)
}
console.log('Relocated package native image checks passed; artifact preserved for inspection.')
