// Run an author's test files, one after another in this process, and say how each test went.
import { dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { collect, expect, setFile, setRunning, type Running, type Suite, type Test } from './vitest.ts'

/** How long a test or a hook may take unless it says, as `superego extension test` has always given them. */
const TIMEOUT = 30_000

export type Tally = { passed: number; failed: number; skipped: number; todo: number }

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: number) => (text: string) => tty ? `\x1b[${code}m${text}\x1b[0m` : text
const green = paint(32), red = paint(31), dim = paint(2), yellow = paint(33)

/** Run `fn` with a time limit: a promise it returns rejects past it. */
async function timed(fn: () => unknown, ms: number, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out in ${ms}ms`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Where the runner's own code is (a packaged app's out/main, where the rest of Superego is too): not in a stack shown. */
const ours = dirname(fileURLToPath(import.meta.url))
const shown = { depth: 8, maxStringLength: 600, maxArrayLength: 50, breakLength: 120 }

/** An error as it's shown: its stack, and for an assertion what was expected and what came. */
function describeError(error: unknown, root: string): string {
  if (!(error instanceof Error)) return inspect(error)
  const e = error as Error & { showDiff?: boolean; actual?: unknown; expected?: unknown }
  const stack = (e.stack ?? `${e.name}: ${e.message}`).split('\n')
    .filter((line) => !/^\s+at /.test(line) || !(line.includes(ours + '/') || line.includes(pathToFileURL(ours).href + '/') || /node:internal|\/node_modules\//.test(line)))
    .map((line) => line.replace(pathToFileURL(root).href + '/', '').replace(root + '/', ''))
    .join('\n')
  const diff = e.showDiff && 'expected' in e
    ? `\n\n${green('Expected:')} ${inspect(e.expected, shown)}\n${red('Received:')} ${inspect(e.actual, shown)}`
    : ''
  // A type imported as a value: the file loads with its types stripped, as the daemon loads a profile's.
  const hint = /does not provide an export named/.test(e.message) ? `\n\nIf it's a type, import it as one (\`import { type Name }\`): files load with their types stripped, as the daemon loads them.` : ''
  return stack + diff + hint
}

const indent = (text: string, by: string) => text.split('\n').map((line) => by + line).join('\n')

/**
 * What a runner outside this process is told as the tests go: the test (or hook) starting, by its suites' names and
 * its own, and undefined when it's over. Waited on before it starts, so it's told even if the test never yields.
 */
export type Progress = (path: string[] | undefined) => unknown

/** The line of the test running now, written up to its name; finished in place as it ends, unless something printed meanwhile. */
let pending: string | undefined
let write: (text: string) => void = (text) => { process.stdout.write(text) }

/** Run a file's tests, adding to `tally` how each went, having printed it; resolves to how many errors came outside tests. */
export async function runFile(file: string, root: string, tally: Tally, progress: Progress = () => {}): Promise<number> {
  // Errors no test caught (a promise left to reject, a throw in a timer): each fails the run.
  const stray: unknown[] = []
  const onStray = (error: unknown) => { stray.push(error) }
  process.on('unhandledRejection', onStray)
  process.on('uncaughtException', onStray)
  // Anything else printed (a test's console.log) starts on a line of its own.
  const streams = [process.stdout, process.stderr] as const
  const originals = streams.map((stream) => stream.write)
  const own = originals[0]!.bind(process.stdout) as (text: string) => boolean
  write = (text) => { own(text) }
  streams.forEach((stream, i) => {
    stream.write = function (this: NodeJS.WriteStream, ...args: unknown[]) {
      if (pending !== undefined) { pending = undefined; own('\n') }
      return (originals[i] as (...a: unknown[]) => boolean).apply(this, args)
    } as typeof stream.write
  })
  let errors = 0
  try {
    const name = relative(root, file) || file
    setFile(file)
    let suite: Suite | undefined
    try {
      suite = await collect(() => import(pathToFileURL(file).href))
    } catch (error) {
      errors++
      console.log(`${red('✗')} ${name}\n${indent(describeError(error, root), '    ')}`)
    }
    if (suite) {
      console.log(name)
      await runSuite(suite, { root, depth: 1, path: [], only: hasOnly(suite), skipped: false, tally, eachBefore: [], eachAfter: [], progress })
    }
    for (const error of stray.splice(0)) {
      errors++
      console.log(`  ${red('✗')} an error outside any test\n${indent(describeError(error, root), '      ')}`)
    }
  } finally {
    streams.forEach((stream, i) => { stream.write = originals[i]! })
    write = (text) => { process.stdout.write(text) }
    setFile(undefined)
    process.off('unhandledRejection', onStray)
    process.off('uncaughtException', onStray)
  }
  return errors
}

const hasOnly = (suite: Suite): boolean => suite.children.some((child) => child.mode === 'only' || (child.kind === 'suite' && hasOnly(child)))

type Context = {
  root: string
  depth: number
  /** The names of the suites it's in. */
  path: string[]
  progress: Progress
  only: boolean
  skipped: boolean
  tally: Tally
  /** Each test's hooks from the suites it's in, outermost first. */
  eachBefore: Suite['hooks']['beforeEach']
  eachAfter: Suite['hooks']['afterEach']
}

/** Whether anything in `suite` will run (else its beforeAll and afterAll don't). */
const runs = (suite: Suite, only: boolean, inOnly: boolean): boolean => suite.children.some((child) => {
  if (child.mode === 'skip' || child.mode === 'todo') return false
  const chosen = inOnly || child.mode === 'only'
  return child.kind === 'test' ? !only || chosen : runs(child, only, chosen)
})

async function runSuite(suite: Suite, ctx: Context, inOnly = false): Promise<void> {
  const pad = '  '.repeat(ctx.depth)
  const active = !ctx.skipped && suite.mode !== 'skip' && suite.mode !== 'todo' && runs(suite, ctx.only, inOnly || suite.mode === 'only')
  const teardown: Suite['hooks']['afterAll'] = []
  let failedSetup: unknown
  if (active) {
    for (const hook of suite.hooks.beforeAll) {
      try {
        let back: unknown
        await ctx.progress([...ctx.path, 'beforeAll'])
        await timed(async () => { back = await hook() }, TIMEOUT, 'beforeAll')
        if (typeof back === 'function') teardown.unshift(back as () => unknown)
      } catch (error) { failedSetup = error; break }
    }
  }
  if (failedSetup) {
    ctx.tally.failed++
    console.log(`${pad}${red('✗')} ${suite.name ? `${suite.name}: ` : ''}beforeAll\n${indent(describeError(failedSetup, ctx.root), pad + '    ')}`)
  }
  const chosenHere = inOnly || suite.mode === 'only'
  for (const child of suite.children) {
    const skipped = !active || Boolean(failedSetup)
    if (child.kind === 'suite') {
      console.log(`${pad}${child.name}`)
      await runSuite(child, {
        ...ctx, depth: ctx.depth + 1, path: [...ctx.path, child.name], skipped: skipped || child.mode === 'skip',
        eachBefore: [...ctx.eachBefore, ...suite.hooks.beforeEach], eachAfter: [...suite.hooks.afterEach, ...ctx.eachAfter],
      }, chosenHere)
      continue
    }
    const chosen = chosenHere || child.mode === 'only'
    if (child.mode === 'todo') { ctx.tally.todo++; console.log(`${pad}${dim(`○ ${child.name} (todo)`)}`); continue }
    if (skipped || child.mode === 'skip' || (ctx.only && !chosen)) { ctx.tally.skipped++; console.log(`${pad}${dim(`○ ${child.name}`)}`); continue }
    await runTest(child, { ...ctx, eachBefore: [...ctx.eachBefore, ...suite.hooks.beforeEach], eachAfter: [...suite.hooks.afterEach, ...ctx.eachAfter] }, pad)
  }
  for (const hook of [...teardown, ...(active ? suite.hooks.afterAll : [])]) {
    await ctx.progress([...ctx.path, 'afterAll'])
    try { await timed(hook, TIMEOUT, 'afterAll') } catch (error) {
      ctx.tally.failed++
      console.log(`${pad}${red('✗')} ${suite.name ? `${suite.name}: ` : ''}afterAll\n${indent(describeError(error, ctx.root), pad + '    ')}`)
    }
  }
}

async function runTest(test: Test, ctx: Context, pad: string) {
  await ctx.progress([...ctx.path, test.name])
  // Its name as it starts: which one it is, should it never end.
  pending = tty ? `${pad}${dim('…')} ${test.name}` : `${pad}${test.name} …`
  write(pending)
  try {
    await runTestNow(test, ctx, pad)
  } finally {
    pending = undefined
    await ctx.progress(undefined)
  }
}

/** Finish the test's line: in place, or on a line of its own when something printed since it started. */
function finish(pad: string, glyph: string, name: string, after: string) {
  if (pending !== undefined && !tty) write(` ${glyph}${after}\n`)
  else write(`${pending !== undefined ? '\r\x1b[K' : ''}${pad}${glyph} ${name}${after}\n`)
  pending = undefined
}

async function runTestNow(test: Test, ctx: Context, pad: string) {
  const started = Date.now()
  const timeout = test.timeout ?? TIMEOUT
  const state: Running = { name: test.name, finished: [], failed: [] }
  const errors: unknown[] = []
  let skippedInside = false
  const context = {
    task: { name: test.name }, expect, signal: new AbortController().signal,
    skip: (note?: string) => { skippedInside = true; throw Object.assign(new Error(note ?? 'skipped'), { skipped: true }) },
    onTestFinished: (fn: () => unknown) => { state.finished.push(fn) },
    onTestFailed: (fn: () => unknown) => { state.failed.push(fn) },
  }
  setRunning(state)
  expect.setState({
    assertionCalls: 0, isExpectingAssertions: false, isExpectingAssertionsError: null, expectedAssertionsNumber: null,
    expectedAssertionsNumberErrorGen: null, currentTestName: test.name, testPath: undefined,
  })
  const cleanups: (() => unknown)[] = []
  try {
    for (const hook of ctx.eachBefore) {
      let back: unknown
      await timed(async () => { back = await hook(context) }, timeout, 'beforeEach')
      if (typeof back === 'function') cleanups.unshift(back as () => unknown)
    }
    await timed(() => test.fn!(context), timeout, 'The test')
    const { assertionCalls, expectedAssertionsNumber, isExpectingAssertions } = expect.getState()
    if (expectedAssertionsNumber !== null && assertionCalls !== expectedAssertionsNumber) throw new Error(`Expected ${expectedAssertionsNumber} assertions, but ${assertionCalls} were made`)
    if (isExpectingAssertions && assertionCalls === 0) throw new Error('Expected at least one assertion, but none were made')
  } catch (error) {
    if (!(skippedInside && (error as { skipped?: boolean }).skipped)) errors.push(error)
  }
  for (const hook of [...cleanups, ...ctx.eachAfter]) {
    try { await timed(() => hook(context), timeout, 'afterEach') } catch (error) { errors.push(error) }
  }
  const failing = test.fails ? errors.length === 0 : errors.length > 0
  for (const fn of [...(failing ? state.failed : []), ...state.finished]) {
    try { await timed(fn, timeout, 'onTestFinished') } catch (error) { errors.push(error) }
  }
  setRunning(undefined)
  const ms = Date.now() - started
  const time = ms >= 100 ? dim(` ${ms}ms`) : ''
  if (skippedInside && !errors.length) { ctx.tally.skipped++; finish(pad, dim('○'), dim(test.name), ''); return }
  if (test.fails) {
    if (errors.length) { ctx.tally.passed++; finish(pad, green('✓'), test.name, ` ${dim('(failed, as it should)')}${time}`) }
    else { ctx.tally.failed++; finish(pad, red('✗'), test.name, ''); write(`${pad}    It passed, but is marked to fail\n`) }
    return
  }
  if (!errors.length) { ctx.tally.passed++; finish(pad, green('✓'), test.name, time); return }
  ctx.tally.failed++
  finish(pad, red('✗'), test.name, time)
  for (const error of errors) write(indent(describeError(error, ctx.root), pad + '    ') + '\n')
}

export const summary = (t: Tally & { errors: number }) => [
  t.failed ? red(`${t.failed} failed`) : '', t.passed ? green(`${t.passed} passed`) : '', t.skipped ? yellow(`${t.skipped} skipped`) : '',
  t.todo ? dim(`${t.todo} todo`) : '', t.errors ? red(`${t.errors} error${t.errors === 1 ? '' : 's'}`) : '',
].filter(Boolean).join(', ')
