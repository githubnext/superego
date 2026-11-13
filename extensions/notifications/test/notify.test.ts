import { expect, it } from 'vitest'
import type { Status, ThreadInfo } from '@superego/protocol'
import { noticeFor, rejectionNotice } from '../src/notify.ts'

const thread = (state: Status['state'], msg?: string): ThreadInfo =>
  ({ id: 't', title: 'Fix the build', cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state, ...(msg ? { msg } : {}) } })
const away = { focused: false, visible: true }

it('says a thread finished, failed or needs you', () => {
  expect(noticeFor({ machine: 'box', thread: thread('done'), before: 'working' }, away)).toEqual({ machine: 'box', thread: 't', title: 'Fix the build', body: 'Finished' })
  expect(noticeFor({ machine: 'box', thread: thread('error', 'out of credit'), before: 'working' }, away)?.body).toBe('Failed: out of credit')
  expect(noticeFor({ machine: 'box', thread: thread('blocked'), before: 'working' }, away)?.body).toBe('Needs you')
})

it('stays quiet while the window is in front, for other states, and for threads seen for the first time', () => {
  expect(noticeFor({ machine: 'box', thread: thread('done'), before: 'working' }, { focused: true, visible: true })).toBeUndefined()
  expect(noticeFor({ machine: 'box', thread: thread('done'), before: 'working' }, { focused: true, visible: false })).toBeDefined()
  expect(noticeFor({ machine: 'box', thread: thread('working'), before: 'idle' }, away)).toBeUndefined()
  expect(noticeFor({ machine: 'box', thread: thread('idle'), before: 'done' }, away)).toBeUndefined()
  expect(noticeFor({ machine: 'box', thread: thread('done'), before: undefined }, away)).toBeUndefined()
})

it('stays quiet for a thread waiting for sign-in, and says it once for the provider', () => {
  const waiting = { ...thread('blocked', 'Anthropic rejected the API key'), status: { state: 'blocked' as const, kind: 'auth' as const, msg: 'Anthropic rejected the API key' } }
  expect(noticeFor({ machine: 'box', thread: waiting, before: 'working' }, away)).toBeUndefined()
  const rejection = { provider: 'anthropic', name: 'Anthropic', summary: 'Anthropic rejected the API key', detail: '401 invalid x-api-key', since: 1, threads: ['t', 'u'] }
  expect(rejectionNotice({ machine: 'box', rejection }, away)).toEqual({ machine: 'box', thread: 't', title: 'Anthropic rejected the API key', body: '2 threads are waiting. Sign in again to go on.' })
  expect(rejectionNotice({ machine: 'box', rejection }, { focused: true, visible: true })).toBeUndefined()
  expect(rejectionNotice({ machine: 'box', rejection: { ...rejection, threads: [] } }, away)).toBeUndefined()
})
