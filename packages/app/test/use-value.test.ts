// @vitest-environment happy-dom
// useValue with a scope: only that part of a live value, from a daemon that scopes it, or picked here from an older one.
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { MachineEntry } from '../src/shared.ts'
import { useValue } from '../src/renderer/client.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function bridge(answer: (params: { key: string; scope?: string }) => unknown) {
  const asked: unknown[] = []
  const listeners = new Set<(event: { machine: string; method: string; params: unknown }) => void>()
  window.superego = {
    call: async (_machine: string, method: string, params: { key: string; scope?: string }) => {
      if (method !== 'value.watch') return null
      asked.push(params)
      return { sub: `s${asked.length}`, value: answer(params) }
    },
    onEvent: (listener: (event: { machine: string; method: string; params: unknown }) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  } as never
  return { asked, tell: (sub: string, value: unknown) => { for (const l of listeners) l({ machine: 'm', method: 'value.changed', params: { sub, key: 'builds.queue', value } }) } }
}

const machine = (features: string[]): MachineEntry => ({ id: 'm', label: 'm', state: 'connected', features } as unknown as MachineEntry)

async function render(entry: MachineEntry, scope: string) {
  let seen: unknown
  function Probe() { seen = useValue<string[]>(entry, 'builds.queue', { scope }); return null }
  const root = createRoot(document.createElement('div'))
  await act(async () => { root.render(h(Probe)) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return { seen: () => seen, unmount: () => act(() => root.unmount()) }
}

it("watches only the thread's scope where the daemon scopes values", async () => {
  const { asked, tell } = bridge((p) => p.scope === 't1' ? ['mine'] : 'whole')
  const view = await render(machine(['scoped-values']), 't1')
  expect(asked).toEqual([{ key: 'builds.queue', scope: 't1' }])
  expect(view.seen()).toEqual(['mine'])
  await act(async () => { tell('s1', ['mine', 'more']) })
  expect(view.seen()).toEqual(['mine', 'more'])
  await view.unmount()
})

it('watches it whole from an older daemon, and picks the scope here', async () => {
  const { asked, tell } = bridge(() => ({ t2: ['theirs'], t3: ['other'] }))
  const view = await render(machine([]), 't2')
  expect(asked).toEqual([{ key: 'builds.queue' }])
  expect(view.seen()).toEqual(['theirs'])
  await act(async () => { tell('s1', { t3: ['other'] }) })
  expect(view.seen()).toBeNull()
  await view.unmount()
})
