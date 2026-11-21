// Check a profile's types as `tsc -p <its tsconfig.json>` does, with the TypeScript compiler in this Superego: its native
// `tsc`, from the platform's package beside `typescript` (a packaged app copies both into out/node_modules), with its
// standard library's declarations beside it. The rest ('superego', React, Node, vitest) comes from the profile's
// node_modules, linked to the author types, so nothing need be installed.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The native `tsc` of the `typescript` this Superego carries, for this platform. */
export function compiler(): string {
  const typescript = createRequire(import.meta.url).resolve('typescript/package.json')
  const platform = `@typescript/typescript-${process.platform}-${process.arch}`
  let found: string
  try {
    found = createRequire(typescript).resolve(`${platform}/package.json`)
  } catch {
    throw new Error(`No TypeScript compiler for this platform (${platform}) in this Superego`)
  }
  // A packaged app's is resolved inside its archive (app.asar), which Electron reads files from but can't run them from:
  // it's run from where the archive's unpacked files are.
  const exe = join(dirname(found), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc').replace(/\.asar([\\/])/, '.asar.unpacked$1')
  if (!existsSync(exe)) throw new Error(`TypeScript's compiler isn't where its package says: ${exe}`)
  return exe
}

/** Check the project `tsconfig` names; resolves to how many errors it found (one when the compiler fails some other way). */
export async function checkTypes(tsconfig: string): Promise<number> {
  const args = ['-p', tsconfig, '--noEmit', '--pretty', process.stdout.isTTY && !process.env.NO_COLOR ? 'true' : 'false']
  const { code, output } = await new Promise<{ code: number | null; output: string }>((done, fail) => {
    const child = spawn(compiler(), args, { cwd: dirname(tsconfig), stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.on('error', fail)
    child.on('close', (code) => done({ code, output }))
  })
  if (output.trim()) console.log(output.replace(/\n*Found \d+ errors?.*\n*$/s, '').trimEnd())
  // A diagnostic's first line: `file(1,2): error TS…` plain, `file:1:2 - error TS…` pretty, `error TS…` for one with no file.
  const errors = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((line) => /^\S.*?\berror TS\d+:|^error TS\d+:/.test(line)).length
  return code === 0 ? 0 : Math.max(errors, 1)
}
