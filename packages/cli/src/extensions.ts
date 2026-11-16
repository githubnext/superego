// `superego extension …`: make an extension in a profile (`new`), check and test it (`test`), load its profile again
// (`reload`), and see what each extension on a machine is and does (`superego extensions`, inspect.ts).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installTypes, linkProfileTypes, setUpProfileTypes } from '@superego/client/author-types'
import { writeStarter, type StarterKind } from './starter.ts'

/**
 * This computer's types for profile authors, `<dataDir>/types`, made current from this Superego's: `built` (a packaged
 * app's out/types), else built from this checkout's sources (cached; a few seconds after they change).
 */
export async function authorTypes(dataDir: string, built?: string): Promise<string> {
  if (built && existsSync(join(built, 'stamp.json'))) return installTypes(built, dataDir)
  let from: string
  try {
    const { builtTypes } = await import(pathToFileURL(createRequire(import.meta.url).resolve('@superego/sdk/types')).href) as typeof import('@superego/sdk/types')
    from = await builtTypes()
  } catch (error) {
    throw new Error(`This Superego has no types for profile authors (${error instanceof Error ? error.message : String(error)})`)
  }
  return installTypes(from, dataDir)
}

/**
 * What runs `superego extension test`'s checks and tests (@superego/sdk's runner/main.ts): `built`, a packaged app's
 * (out/main/author-test.js), else this checkout's source. Run on this process's runtime: the app's Electron as Node, or Node.
 */
function runner(built?: string): string {
  return built ?? createRequire(import.meta.url).resolve('@superego/sdk/runner')
}

/** Make `name` in the profile at `profileDir`, and give the profile types (`typesDir`: `authorTypes`'s). */
export function newExtension(profileDir: string, name: string, kind: StarterKind, typesDir: string) {
  const made = writeStarter(profileDir, name, kind)
  const types = setUpProfileTypes(profileDir, typesDir)
  return { ...made, written: [...made.written, ...types.written], notes: types.notes }
}

/**
 * Check the profile's types (its tsconfig: what `new` wrote) and run its tests, or those of one extension in it
 * (`target`, a folder or file in it), as `superego/testing` runs them: in a process of its own, with the compiler and
 * runner this Superego carries (`built`: a packaged app's). A test file still running after `timeout` seconds is
 * stopped, saying which test it was in. Resolves to the exit code.
 */
export async function testExtension(profileDir: string, target: string | undefined, typesDir: string, { built, timeout }: { built?: string; timeout?: number } = {}): Promise<number> {
  // Its types, linked again if they aren't (a fresh clone of a project's).
  if (existsSync(join(profileDir, 'tsconfig.json'))) linkProfileTypes(profileDir, typesDir)
  return new Promise((done) => {
    const child = spawn(process.execPath, [runner(built), '--types', typesDir, ...(timeout ? ['--timeout', String(timeout)] : []), profileDir, ...(target ? [target] : [])], { cwd: profileDir, stdio: 'inherit' })
    child.on('exit', (code) => done(code ?? 1))
  })
}
