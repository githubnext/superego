// `superego extension test`'s own process: check a profile's types, then run its tests (or those in one folder or
// file of it), as the daemon and the window load its files. Run by the command line, on this Superego's runtime (the
// app's Electron as Node, or a checkout's Node):
//
//   <runtime> main.ts --types <author types> [--timeout <seconds>] <profile dir> [file or folder in it]
//
// The tests run in a worker process of their own (this file again, with --worker), which this one stops when a file
// runs longer than the time limit (a loop that never ends: no test's own timeout fires through one), saying which test
// it was in, and goes on with the files after it in another. Exits 0 when the types check and every test passes.
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { hook, provide } from './hooks.ts'
import type { Progress, Tally } from './run.ts'

const { values, positionals } = parseArgs({ options: { types: { type: 'string' }, timeout: { type: 'string' }, worker: { type: 'boolean' } }, allowPositionals: true })
const [given, target] = positionals
if (!given || (!values.types && !values.worker)) {
  console.error('Usage: main.ts --types <author types> [--timeout <seconds>] <profile dir> [file or folder in it]')
  process.exit(2)
}
// By its real path, as Node names the modules in it.
const dir = realpathSync(resolve(given))
/** How long a test file may run, in seconds. */
const LIMIT = Number(values.timeout) > 0 ? Number(values.timeout) : 60

const red = (text: string) => process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[31m${text}\x1b[0m` : text

/** What a worker tells this process as it goes. */
type Message = { type: 'file'; file: string } | { type: 'test'; path: string[] | undefined }
  | { type: 'tally'; tally: Tally & { errors: number }; /** The file is done: else, how its tests have gone so far. */ done: boolean }

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
  const { summary } = await import('./run.ts')
  const started = Date.now()
  const tally = await supervise(files)
  console.log(`\n${summary(tally)} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  return tally.failed || tally.errors ? 1 : 0
}

/**
 * Run `files` in a worker, and another for those after one it had to stop: one that ran past the limit, or whose
 * process ended before it did (a test calling process.exit, say).
 */
async function supervise(files: string[]): Promise<Tally & { errors: number }> {
  // Stopped itself (an agent's command timing out, say): the worker too, which may be in a loop that never ends.
  let worker: ChildProcess | undefined
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(name, () => { worker?.kill('SIGKILL'); process.kill(process.pid, name) })
  }
  const total = { passed: 0, failed: 0, skipped: 0, todo: 0, errors: 0 }
  const add = (tally: Tally & { errors: number }) => { for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += tally[key] }
  let next = 0
  while (next < files.length) {
    let running: string[] | undefined
    let hung = false
    /** How the tests of the file running have gone so far. */
    let sofar: (Tally & { errors: number }) | undefined
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      // This file again, as the worker: the app's bundle (author-test.js) or main.ts, on this runtime and its flags.
      const child = worker = fork(process.argv[1]!, ['--worker', dir, ...files.slice(next)], { stdio: 'inherit' })
      let timer: NodeJS.Timeout | undefined
      child.on('message', (message: Message) => {
        if (message.type === 'file') {
          clearTimeout(timer)
          running = undefined
          sofar = undefined
          timer = setTimeout(() => { hung = true; child.kill('SIGKILL') }, LIMIT * 1000)
        } else if (message.type === 'test') {
          running = message.path
        } else if (!message.done) {
          sofar = message.tally
        } else {
          clearTimeout(timer)
          add(message.tally)
          next++
        }
      })
      child.on('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }) })
    })
    if (next >= files.length) break
    // It stopped in the middle of a file: say where, and go on after it, with what it had run.
    if (sofar) add(sofar)
    const name = relative(dir, files[next]!) || files[next]!
    const pad = '  '.repeat(running?.length ?? 0)
    const where = running ? `${pad}${red('✗')} ${running.at(-1)}` : `${red('✗')} ${name}`
    // Finish the line the test's name started.
    if (running) process.stdout.write(process.stdout.isTTY ? '\r\x1b[K' : '\n')
    if (hung) {
      console.log(`${where}: still running after ${LIMIT}s, so ${running ? 'its file was' : 'it was'} stopped${running ? '' : ' while loading'}.`)
      console.log(`${pad}    A loop that never ends? It ran ${running ? `in ${running.join(' › ')}` : `as ${name} loaded`}. More time: --timeout <seconds>`)
    } else {
      console.log(`${where}: its process ended (${signal ?? `exit code ${code}`}) before ${running ? 'the test did' : 'the file finished'}`)
    }
    if (running && running.at(-1) !== 'beforeAll' && running.at(-1) !== 'afterAll') total.failed++
    else total.errors++
    next++
  }
  return total
}

/** The worker: run each file, telling the process that started it how it goes. */
async function work(files: string[]): Promise<number> {
  // Written as it's printed, not when the event loop next turns: a loop that never ends would keep it.
  for (const stream of [process.stdout, process.stderr]) (stream as unknown as { _handle?: { setBlocking?: (on: boolean) => void } })._handle?.setBlocking?.(true)
  // The process that started it gone (killed outright): nothing to tell, and no one to stop it.
  process.on('disconnect', () => process.exit(1))
  const send = (message: Message) => new Promise<void>((done) => { process.send!(message, () => done()) })
  hook()
  provide((await import('./modules.ts')).modules)
  const { runFile } = await import('./run.ts')
  for (const file of files) {
    await send({ type: 'file', file })
    const tally = { passed: 0, failed: 0, skipped: 0, todo: 0 }
    // Each test as it starts, and how the file's have gone as each ends.
    const progress: Progress = (path) => path ? send({ type: 'test', path }) : send({ type: 'tally', tally: { ...tally, errors: 0 }, done: false }).then(() => send({ type: 'test', path }))
    const errors = await runFile(file, dir, tally, progress)
    await send({ type: 'tally', tally: { ...tally, errors }, done: true })
  }
  return 0
}

// Done when the tests are: what they left running (a daemon not closed, a timer) doesn't keep it.
const exit = (code: number) => process.stdout.write('', () => process.exit(code))
;(values.worker ? work(positionals.slice(1)) : main()).then(exit, (error: unknown) => { console.error(error); exit(1) })
