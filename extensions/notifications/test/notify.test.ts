import { expect, it } from 'vitest'
import type { Status, ThreadInfo } from '@superego/protocol'
import { noticeFor } from '../src/notify.ts'

const thread = (state: Status['state'], msg?: string): ThreadInfo =>
  ({ id: 't', title: 'Fix the build', cwd: '/', createdAt: 0, activeAt: 0, status: { state, ...(msg ? { msg } : {}) } })
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
