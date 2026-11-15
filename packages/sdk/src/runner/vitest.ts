// 'vitest' as `superego extension test` gives it to an author's tests: vitest's own `expect`, `vi`, `assert` and
// `chai`, and a runner of its own behind `describe`, `it`, `test` and their hooks: vitest itself would bring Vite and
// its native compilers into the app. What it lacks says so when it's used: snapshots, module mocks, `expect.poll`.
import { assert, chai, expect, expectTypeOf, assertType, vi as vitestVi } from 'vitest'

// vitest's `expect` and `vi` read what their worker is running from here: our runner is that worker.
const worker = {
  config: { fakeTimers: { loopLimit: 10_000, shouldClearNativeTimers: true }, expect: {}, snapshotOptions: { expand: false } },
  providedContext: {}, filepath: undefined as string | undefined, onCleanup() {}, ctx: {},
}
Object.defineProperty(globalThis, '__vitest_worker__', { value: worker, configurable: true, writable: true, enumerable: false })

const unsupported = (what: string, instead: string) => () => { throw new Error(`${what} isn't supported by superego extension test: ${instead}`) }
expect.extend({
  toMatchSnapshot: unsupported('toMatchSnapshot', 'compare with toEqual'),
  toMatchInlineSnapshot: unsupported('toMatchInlineSnapshot', 'compare with toEqual'),
  toMatchFileSnapshot: unsupported('toMatchFileSnapshot', 'compare with toEqual'),
  toThrowErrorMatchingSnapshot: unsupported('toThrowErrorMatchingSnapshot', 'compare with toThrow'),
  toThrowErrorMatchingInlineSnapshot: unsupported('toThrowErrorMatchingInlineSnapshot', 'compare with toThrow'),
})
const noMocks = unsupported('Mocking a module', 'pass what the code uses in, or use vi.fn and vi.spyOn')
const overrides: Record<PropertyKey, unknown> = { mock: noMocks, doMock: noMocks, unmock: noMocks, doUnmock: noMocks, importMock: noMocks }
export const vi: typeof vitestVi = new Proxy(vitestVi, { get: (target, key) => Object.hasOwn(overrides, key) ? overrides[key] : Reflect.get(target, key) })
export const vitest = vi
export { assert, assertType, chai, expect, expectTypeOf }

// ── The runner ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Fn = (...args: any[]) => unknown
type Mode = 'run' | 'skip' | 'only' | 'todo'
type Hooks = { beforeAll: Fn[]; afterAll: Fn[]; beforeEach: Fn[]; afterEach: Fn[] }
export type Test = { kind: 'test'; name: string; mode: Mode; fn?: Fn; timeout?: number; fails?: boolean }
export type Suite = { kind: 'suite'; name: string; mode: Mode; factory?: Fn; children: (Suite | Test)[]; hooks: Hooks }

const newSuite = (name: string, mode: Mode, factory?: Fn): Suite => ({
  kind: 'suite', name, mode, factory, children: [], hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] },
})

/** The suite being collected (a file's, or a describe's while its factory runs). */
let collecting: Suite | undefined
const current = () => {
  if (!collecting) throw new Error('describe, it, test and their hooks go at the top of a test file or inside a describe')
  return collecting
}

/** Collect a file's suite: `load` imports it (its top-level calls), then each describe's factory runs, in order. */
export async function collect(load: () => Promise<unknown>): Promise<Suite> {
  const file = newSuite('', 'run')
  const into = async (suite: Suite, run: () => unknown) => {
    const outer = collecting
    collecting = suite
    try { await run() } finally { collecting = outer }
    for (const child of suite.children) if (child.kind === 'suite' && child.factory) await into(child, child.factory)
  }
  await into(file, load)
  return file
}

type Flags = { mode?: Mode; fails?: boolean }
type Options = { timeout?: number; skip?: boolean; only?: boolean; todo?: boolean; fails?: boolean }

/** printf-like names for `.each`: %s %d %i %f %j %o %O %#, and `$key` of an object case. */
function nameOf(template: string, args: unknown[], index: number): string {
  let at = 0
  let name = template.replace(/%[sdifjoO#%]/g, (token) => {
    if (token === '%%') return '%'
    if (token === '%#') return String(index)
    const value = args[at++]
    if (token === '%d' || token === '%i') return String(Math.trunc(Number(value)))
    if (token === '%f') return String(Number(value))
    if (token === '%j') return JSON.stringify(value)
    return typeof value === 'string' && token === '%s' ? value : (typeof value === 'object' ? JSON.stringify(value) : String(value))
  })
  const only = args.length === 1 ? args[0] : undefined
  if (only && typeof only === 'object') {
    name = name.replace(/\$([\w.]+)/g, (whole, path: string) => {
      const value = path.split('.').reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], only)
      return value === undefined ? whole : typeof value === 'string' ? value : JSON.stringify(value)
    })
  }
  return name.replace(/\$index/g, String(index))
}

type Register = (name: string, fn: Fn | undefined, options: Options & Flags) => void

/** `it`/`test` or `describe`, with vitest's modifiers: .skip .only .todo .fails .skipIf .runIf .each .concurrent .sequential. */
function chain(register: Register, flags: Flags = {}): any {
  const call = (name: string, a?: Fn | Options | number, b?: Fn | Options | number) => {
    const fn = typeof a === 'function' ? a : typeof b === 'function' ? b : undefined
    const given = typeof a === 'object' ? a : typeof b === 'object' ? b : {}
    const timeout = typeof a === 'number' ? a : typeof b === 'number' ? b : given.timeout
    const mode: Mode = flags.mode ?? (given.skip ? 'skip' : given.only ? 'only' : given.todo || !fn ? 'todo' : 'run')
    register(String(name), fn, { ...given, timeout, mode, fails: flags.fails ?? given.fails })
  }
  const api = call as any
  const with_ = (more: Flags) => chain(register, { ...flags, ...more })
  Object.defineProperties(api, {
    skip: { get: () => with_({ mode: 'skip' }) },
    only: { get: () => with_({ mode: 'only' }) },
    todo: { get: () => with_({ mode: 'todo' }) },
    fails: { get: () => with_({ fails: true }) },
    concurrent: { get: () => with_({}) },
    sequential: { get: () => with_({}) },
    shuffle: { get: () => with_({}) },
  })
  api.skipIf = (condition: unknown) => condition ? with_({ mode: 'skip' }) : with_({})
  api.runIf = (condition: unknown) => condition ? with_({}) : with_({ mode: 'skip' })
  api.each = (cases: unknown[], ...values: unknown[]) => {
    // A tagged template's table: `a | b` then ${…} values, row by row.
    if (Array.isArray(cases) && 'raw' in cases) {
      const keys = (cases as unknown as string[]).join('').split('\n')[0]!.split('|').map((key) => key.trim()).filter(Boolean)
      const rows: Record<string, unknown>[] = []
      for (let i = 0; i < values.length; i += keys.length) rows.push(Object.fromEntries(keys.map((key, k) => [key, values[i + k]])))
      cases = rows
    }
    return (template: string, a?: Fn | Options | number, b?: Fn | Options | number) => {
      const fn = (typeof a === 'function' ? a : b) as Fn
      const rest = typeof a === 'function' ? b : a
      cases.forEach((item, index) => {
        const args = Array.isArray(item) ? item : [item]
        call(nameOf(template, args, index), (...context: unknown[]) => fn(...args, ...context), rest as Options | number | undefined)
      })
    }
  }
  return api
}

export const test = chain((name, fn, options) => {
  current().children.push({ kind: 'test', name, mode: options.mode ?? 'run', fn, ...(options.timeout ? { timeout: options.timeout } : {}), ...(options.fails ? { fails: true } : {}) })
})
export const it = test
export const describe = chain((name, fn, options) => { current().children.push(newSuite(name, options.mode ?? 'run', fn)) })
export const suite = describe

export const beforeAll = (fn: Fn) => { current().hooks.beforeAll.push(fn) }
export const afterAll = (fn: Fn) => { current().hooks.afterAll.push(fn) }
export const beforeEach = (fn: Fn) => { current().hooks.beforeEach.push(fn) }
export const afterEach = (fn: Fn) => { current().hooks.afterEach.push(fn) }

/** The test running now: what `onTestFinished` and `onTestFailed` add to. */
export type Running = { name: string; finished: Fn[]; failed: Fn[] }
let running: Running | undefined
export const setRunning = (test: Running | undefined) => { running = test }
const inTest = (what: string) => {
  if (!running) throw new Error(`${what} goes inside a test`)
  return running
}
export const onTestFinished = (fn: Fn) => { inTest('onTestFinished').finished.push(fn) }
export const onTestFailed = (fn: Fn) => { inTest('onTestFailed').failed.push(fn) }

/** Where the file being run is, for vitest's `expect`. */
export const setFile = (file: string | undefined) => { worker.filepath = file }
