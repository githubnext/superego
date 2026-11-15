// Run an author's test files, one after another in this process, and say how each test went.
import { dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { collect, expect, setFile, setRunning, type Running, type Suite, type Test } from './vitest.ts'

/** How long a test or a hook may take unless it says, as `superego extension test` has always given them. */
const TIMEOUT = 30_000

type Tally = { passed: number; failed: number; skipped: number; todo: number }

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

/** Run each file's tests; resolves to how many passed, failed and were skipped, having printed each. */
export async function runFiles(files: string[], root: string): Promise<Tally & { errors: number }> {
  const tally: Tally = { passed: 0, failed: 0, skipped: 0, todo: 0 }
  // Errors no test caught (a promise left to reject, a throw in a timer): each fails the run.
  const stray: unknown[] = []
  const onStray = (error: unknown) => { stray.push(error) }
  process.on('unhandledRejection', onStray)
  process.on('uncaughtException', onStray)
  let errors = 0
  for (const file of files) {
    const name = relative(root, file) || file
    setFile(file)
    let suite: Suite
    try {
      suite = await collect(() => import(pathToFileURL(file).href))
    } catch (error) {
      errors++
      console.log(`${red('✗')} ${name}\n${indent(describeError(error, root), '    ')}`)
      continue
    }
    console.log(name)
    const only = hasOnly(suite)
    await runSuite(suite, { root, depth: 1, only, skipped: false, tally, eachBefore: [], eachAfter: [] })
    for (const error of stray.splice(0)) {
      errors++
      console.log(`  ${red('✗')} an error outside any test\n${indent(describeError(error, root), '      ')}`)
    }
  }
  setFile(undefined)
  process.off('unhandledRejection', onStray)
  process.off('uncaughtException', onStray)
  return { ...tally, errors }
}

const hasOnly = (suite: Suite): boolean => suite.children.some((child) => child.mode === 'only' || (child.kind === 'suite' && hasOnly(child)))

type Context = {
  root: string
  depth: number
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
        ...ctx, depth: ctx.depth + 1, skipped: skipped || child.mode === 'skip',
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
    try { await timed(hook, TIMEOUT, 'afterAll') } catch (error) {
      ctx.tally.failed++
      console.log(`${pad}${red('✗')} ${suite.name ? `${suite.name}: ` : ''}afterAll\n${indent(describeError(error, ctx.root), pad + '    ')}`)
    }
  }
}

async function runTest(test: Test, ctx: Context, pad: string) {
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
  if (skippedInside && !errors.length) { ctx.tally.skipped++; console.log(`${pad}${dim(`○ ${test.name}`)}`); return }
  if (test.fails) {
    if (errors.length) { ctx.tally.passed++; console.log(`${pad}${green('✓')} ${test.name} ${dim('(failed, as it should)')}${time}`) }
    else { ctx.tally.failed++; console.log(`${pad}${red('✗')} ${test.name}\n${pad}    It passed, but is marked to fail`) }
    return
  }
  if (!errors.length) { ctx.tally.passed++; console.log(`${pad}${green('✓')} ${test.name}${time}`); return }
  ctx.tally.failed++
  console.log(`${pad}${red('✗')} ${test.name}${time}`)
  for (const error of errors) console.log(indent(describeError(error, ctx.root), pad + '    '))
}

export const summary = (t: Tally & { errors: number }) => [
  t.failed ? red(`${t.failed} failed`) : '', t.passed ? green(`${t.passed} passed`) : '', t.skipped ? yellow(`${t.skipped} skipped`) : '',
  t.todo ? dim(`${t.todo} todo`) : '', t.errors ? red(`${t.errors} error${t.errors === 1 ? '' : 's'}`) : '',
].filter(Boolean).join(', ')
