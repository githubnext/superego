// Shared watches (client.ts), against a fake `window.superego`: one subscription however many want it, let go after
// the last, watched again on reconnecting, after the daemon ends it, and after a failed call.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SuperegoBridge, SuperegoEvent } from '../src/shared/bridge.ts'
import { sharedWatch } from '../src/renderer/client.ts'

type Call = { method: string; params: any }
let calls: Call[]
let listeners: Set<(event: SuperegoEvent) => void>
let fail: number
let next: number

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  listeners = new Set()
  fail = 0
  next = 0
  const bridge: Partial<SuperegoBridge> = {
    async call(_machine, method, params) {
      calls.push({ method, params })
      if (method === 'unwatch') return null
      if (fail > 0) { fail--; throw new Error('nope') }
      return { sub: `s${++next}`, value: 0 }
    },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  ;(globalThis as { window?: unknown }).window = { superego: bridge }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const emit = (method: string, params: unknown) => { for (const listener of listeners) listener({ machine: 'm', method, params }) }
const watches = () => calls.filter((c) => c.method === 'value.watch').length
const unwatches = () => calls.filter((c) => c.method === 'unwatch').map((c) => c.params.sub)
const fold = (_value: number, _method: string, params: { value: number }) => params.value
let n = 0
/** A watch of a key no other test has. */
const fresh = () => {
  const key = `k${++n}`
  return { key, watch: () => sharedWatch<number>('m', 'value.watch', { key }, fold, ['value.changed']) }
}
const settle = () => vi.advanceTimersByTimeAsync(0)

it('holds one subscription however many use it, and lets go a moment after the last', async () => {
  const { watch } = fresh()
  const w = watch()
  expect(watch()).toBe(w)
  const a = {}, b = {}
  const offA = w.subscribe(() => {}), offB = w.subscribe(() => {})
  w.want(a, true)
  w.want(b, true)
  await settle()
  expect(watches()).toBe(1)
  expect(w.value).toBe(0)
  emit('value.changed', { sub: 's1', value: 5 })
  expect(w.value).toBe(5)
  offA()
  w.unwant(a)
  await vi.advanceTimersByTimeAsync(2000)
  expect(unwatches()).toEqual([])
  offB()
  w.unwant(b)
  await vi.advanceTimersByTimeAsync(2000)
  expect(unwatches()).toEqual(['s1'])
  // Gone: the next to want it gets a new one.
  expect(watch()).not.toBe(w)
})

it('runs while any of its users wants it, whatever order they say so in', async () => {
  const w = fresh().watch()
  w.subscribe(() => {})
  const gated = {}, plain = {}
  w.want(plain, true)
  w.want(gated, false)
  await settle()
  expect(watches()).toBe(1)
  w.want(plain, false)
  await settle()
  expect(unwatches()).toEqual(['s1'])
})

it('watches again when the machine is back', async () => {
  const w = fresh().watch()
  w.subscribe(() => {})
  const user = {}
  w.want(user, true)
  await settle()
  w.want(user, false)
  await settle()
  expect(unwatches()).toEqual(['s1'])
  w.want(user, true)
  await settle()
  expect(watches()).toBe(2)
})

it('watches again when the daemon ends the watch (stopped)', async () => {
  const w = fresh().watch()
  w.subscribe(() => {})
  w.want({}, true)
  await settle()
  emit('watch.end', { sub: 's1', reason: 'stopped' })
  await settle()
  expect(watches()).toBe(2)
  // The old one's notifications no longer count.
  emit('value.changed', { sub: 's1', value: 9 })
  expect(w.value).toBe(0)
  emit('value.changed', { sub: 's2', value: 3 })
  expect(w.value).toBe(3)
})

it('tries again after a failed call, once something changes', async () => {
  fail = 1
  const w = fresh().watch()
  w.subscribe(() => {})
  const user = {}
  w.want(user, true)
  await settle()
  expect(w.value).toBeUndefined()
  w.want(user, false)
  w.want(user, true)
  await settle()
  expect(watches()).toBe(2)
  expect(w.value).toBe(0)
})

it("doesn't let a watch that ended before it was subscribed take its successor's place", async () => {
  const { watch } = fresh()
  const stale = watch()
  await vi.advanceTimersByTimeAsync(1500)
  const successor = watch()
  expect(successor).not.toBe(stale)
  successor.subscribe(() => {})
  const off = stale.subscribe(() => {})
  off()
  await vi.advanceTimersByTimeAsync(1500)
  expect(watch()).toBe(successor)
})
