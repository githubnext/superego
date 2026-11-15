// `superego extension test`'s own process: check a profile's types, then run its tests (or those in one folder or
// file of it), as the daemon and the window load its files. Run by the command line, on this Superego's runtime (the
// app's Electron as Node, or a checkout's Node):
//
//   <runtime> main.ts --types <author types> <profile dir> [file or folder in it]
//
// Exits 0 when the types check and every test passes.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { hook, provide } from './hooks.ts'

const { values, positionals } = parseArgs({ options: { types: { type: 'string' } }, allowPositionals: true })
const [given, target] = positionals
if (!given || !values.types) {
  console.error('Usage: main.ts --types <author types> <profile dir> [file or folder in it]')
  process.exit(2)
}
// By its real path, as Node names the modules in it.
const dir = realpathSync(resolve(given))

/** The test files at `at`: it, if it's a file; else every *.test.ts and *.test.tsx in it, but in node_modules or a hidden folder. */
function testFiles(at: string): string[] {
  if (statSync(at).isFile()) return [at]
  const found: string[] = []
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.test\.tsx?$/.test(entry.name)) found.push(path)
    }
  }
  walk(at)
  return found
}

async function main(): Promise<number> {
  const tsconfig = join(dir, 'tsconfig.json')
  if (existsSync(tsconfig)) {
    console.log(`Checking types in ${dir}…`)
    const { checkTypes } = await import('./check.ts')
    const errors = await checkTypes(tsconfig, values.types!)
    if (errors) { console.log(`\n${errors} type error${errors === 1 ? '' : 's'}: no tests run`); return 1 }
  }
  const where = target ? resolve(dir, target) : dir
  const files = testFiles(where)
  if (!files.length) { console.log(`No tests (*.test.ts, *.test.tsx) in ${where}`); return 1 }
  console.log(`Running ${files.length === 1 ? relative(dir, files[0]!) || files[0] : `${files.length} test files`}…\n`)
  hook()
  provide((await import('./modules.ts')).modules)
  const { runFiles, summary } = await import('./run.ts')
  const started = Date.now()
  const tally = await runFiles(files, dir)
  console.log(`\n${summary(tally)} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  return tally.failed || tally.errors ? 1 : 0
}

// Done when the tests are: what they left running (a daemon not closed, a timer) doesn't keep it.
const exit = (code: number) => process.stdout.write('', () => process.exit(code))
main().then(exit, (error: unknown) => { console.error(error); exit(1) })
