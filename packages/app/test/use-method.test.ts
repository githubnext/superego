// @vitest-environment happy-dom
// useMethod: a method's answer for a component, called again as what it asks changes, with answers to stale calls dropped.
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { useMethod, type MethodState } from '../src/renderer/client.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A bridge whose calls wait until the test answers them. */
function bridge() {
  const calls: { method: string; params: unknown; resolve(v: unknown): void; reject(e: Error): void }[] = []
  window.superego = { call: (_machine: string, method: string, params: unknown) => new Promise((resolve, reject) => { calls.push({ method, params, resolve, reject }) }) } as never
  return calls
}

let seen: MethodState<string>
function Probe(props: { id: string; enabled?: boolean; refresh?: unknown }) {
  seen = useMethod<string>('m', 'notes.read', { id: props.id }, { enabled: props.enabled ?? true, refresh: props.refresh })
  return null
}

const root = () => { const r = createRoot(document.createElement('div')); return { render: (props: Parameters<typeof Probe>[0]) => act(() => r.render(h(Probe, props))), unmount: () => act(() => r.unmount()) } }
let mounted: ReturnType<typeof root> | undefined
afterEach(async () => { await mounted?.unmount(); mounted = undefined })

it('calls, keeps the answer, and drops one to a call made before the latest', async () => {
  const calls = bridge()
  mounted = root()
  await mounted.render({ id: 'a' })
  expect(calls.map((c) => c.params)).toEqual([{ id: 'a' }])
  expect(seen).toMatchObject({ data: undefined, loading: true })
  await mounted.render({ id: 'b' })
  expect(calls.map((c) => c.params)).toEqual([{ id: 'a' }, { id: 'b' }])
  // b answers first; a's late answer is stale.
  await act(async () => { calls[1]!.resolve('B') })
  await act(async () => { calls[0]!.resolve('A') })
  expect(seen).toMatchObject({ data: 'B', error: undefined, loading: false })
})

it('says why a call failed and keeps the last answer; refetch and refresh call again', async () => {
  const calls = bridge()
  mounted = root()
  await mounted.render({ id: 'a', refresh: 1 })
  await act(async () => { calls[0]!.resolve('first') })
  await act(async () => { seen.refetch() })
  expect(calls).toHaveLength(2)
  await act(async () => { calls[1]!.reject(new Error('gone')) })
  expect(seen).toMatchObject({ data: 'first', loading: false })
  expect(seen.error?.message).toBe('gone')
  await mounted.render({ id: 'a', refresh: 2 })
  expect(calls).toHaveLength(3)
  await act(async () => { calls[2]!.resolve('second') })
  expect(seen).toMatchObject({ data: 'second', error: undefined })
})

it('calls nothing while not enabled, then calls once it is', async () => {
  const calls = bridge()
  mounted = root()
  await mounted.render({ id: 'a', enabled: false })
  expect(calls).toHaveLength(0)
  expect(seen.loading).toBe(false)
  await mounted.render({ id: 'a', enabled: true })
  expect(calls).toHaveLength(1)
})

it('drops an answer that comes after unmounting', async () => {
  const calls = bridge()
  mounted = root()
  await mounted.render({ id: 'a' })
  const before = seen
  await mounted.unmount()
  mounted = undefined
  await act(async () => { calls[0]!.resolve('late') })
  expect(seen).toBe(before)
})
