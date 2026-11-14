// `superego extension …`: make an extension in a profile (`new`), check and test it (`test`), load its profile again
// (`reload`), and see what each extension on a machine is and does (`superego extensions`, inspect.ts).
import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { writeStarter, type StarterKind } from './starter.ts'

/** Where this Superego's author SDK is, and the checkout it's in (for its TypeScript and vitest). */
export function sdkPaths() {
  const sdkDir = dirname(createRequire(import.meta.url).resolve('@superego/sdk/package.json'))
  return { sdkDir, repoDir: resolve(sdkDir, '..', '..') }
}

/** A tool of the checkout's: its bin, run with this Node. */
function tool(pkg: string, bin: string) {
  const { repoDir } = sdkPaths()
  return join(dirname(createRequire(join(repoDir, 'package.json')).resolve(`${pkg}/package.json`)), bin)
}

function run(args: string[], cwd: string, env: Record<string, string> = {}): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
    child.on('exit', (code) => done(code ?? 1))
  })
}

/** Make `name` in the profile at `profileDir`. */
export function newExtension(profileDir: string, name: string, kind: StarterKind) {
  return writeStarter(profileDir, name, kind, sdkPaths())
}

/**
 * Check the profile's types (its tsconfig: what `new` wrote) and run its tests, or those of one extension in it
 * (`target`, a folder in it), as `superego/testing` runs them. Resolves to the exit code.
 */
export async function testExtension(given: string, target?: string): Promise<number> {
  const { sdkDir } = sdkPaths()
  // As vitest names it (through a symlink, /tmp: its real path), so a target in it is found.
  const profileDir = realpathSync(given)
  if (target) target = realpathSync(target)
  if (existsSync(join(profileDir, 'tsconfig.json'))) {
    console.log(`Checking types in ${profileDir}…`)
    const code = await run([tool('typescript', 'bin/tsc'), '-p', join(profileDir, 'tsconfig.json')], profileDir)
    if (code) return code
  }
  return run([tool('vitest', 'vitest.mjs'), 'run', '--config', join(sdkDir, 'vitest.author.ts'), ...(target ? [target] : [])], profileDir, { SUPEREGO_AUTHOR_DIR: profileDir })
}
