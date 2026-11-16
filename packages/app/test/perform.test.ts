import { expect, it } from 'vitest'
import { performed } from '../src/renderer/perform.ts'

const from = { id: 'c1', kind: 'superego-cli', label: 'desk', connectedAt: 0, activeAt: 0, via: 'socket' as const }
const ask = (machine: string, action: string, params?: unknown) => performed({ machine, method: 'client.perform', params: { from, action, ...(params !== undefined ? { params } : {}) } })

it('takes navigation from its own machine', () => {
  expect(ask('local', 'thread.select', { machine: 'local', thread: 't1' })).toEqual({ action: 'thread.select', params: { machine: 'local', thread: 't1' }, source: 'desk (superego-cli)' })
  expect(ask('local', 'pane.next')).toMatchObject({ action: 'pane.next', params: {} })
})

it('ignores a machine it only reaches, and anything that is not navigation', () => {
  expect(ask('box', 'thread.select', { machine: 'local', thread: 't1' })).toBeUndefined()
  for (const action of ['thread.new', 'app.newWindow', 'app.reloadPackages', 'pane.closeFocused', 'app.meta', 'thread.startRename', 'app.settings']) expect(ask('local', action)).toBeUndefined()
  expect(performed({ machine: 'local', method: 'threads.changed', params: {} })).toBeUndefined()
})
