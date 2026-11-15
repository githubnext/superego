import { expect, it } from 'vitest'
import { browserNotice, desktopNotice } from '@superego/app/ui'
import type { Json, Status, ThreadInfo } from '@superego/protocol'
import { noticeFor, rejectionNotice } from '../src/notify.ts'

const thread = (state: Status['state'], msg?: string, more: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id: 't', title: 'Fix the build', cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state, ...(msg ? { msg } : {}) }, ...more })
const away = { focused: false, visible: true }
const notice = (t: ThreadInfo) => noticeFor({ machine: 'box', thread: t, before: 'working' }, away)

it('says what happened: what a run did, the question it asks, why it failed', () => {
  expect(notice(thread('done', 'Merged the notices change into main'))).toEqual({ machine: 'box', thread: 't', title: 'Fix the build', status: 'Finished', text: 'Merged the notices change into main' })
  // The question itself: its last paragraph, after any context, as plain text, shortened.
  const question = `Two ways to go, each with its own cost.\n\n- one\n- two\n\nShould I **rebase** onto main, or merge it, given ${'how much has changed '.repeat(5)}?`
  const asked = notice(thread('blocked', question))!
  expect(asked).toMatchObject({ status: 'Needs you', text: expect.stringMatching(/^Should I rebase onto main, or merge it, given how much.*…$/) })
  expect(asked.text!.length).toBeLessThanOrEqual(100)
  // An error's first line.
  expect(notice(thread('error', '429 Too Many Requests\n{"error":{"type":"rate_limit"}}'))).toMatchObject({ status: 'Failed', text: '429 Too Many Requests' })
})

it("falls back to today's words when there's nothing to say", () => {
  expect(notice(thread('done'))).toEqual({ machine: 'box', thread: 't', title: 'Fix the build', status: 'Finished' })
  expect(notice(thread('error'))).toMatchObject({ status: 'Failed' })
  expect(notice(thread('blocked'))).toMatchObject({ status: 'Needs you' })
  expect(notice(thread('blocked'))!.text).toBeUndefined()
})

it('lays a notice out for the desktop (with a subtitle) and a browser (without)', () => {
  const done = notice(thread('done', 'Merged it'))!
  expect(desktopNotice(done, { label: 'Studio', several: false })).toEqual({ title: 'Fix the build', subtitle: 'Finished', body: 'Merged it' })
  expect(desktopNotice(done, { label: 'Studio', several: true })).toEqual({ title: 'Fix the build', subtitle: 'Finished · Studio', body: 'Merged it' })
  expect(browserNotice(done)).toEqual({ title: 'Fix the build', body: 'Finished: Merged it' })
  const bare = notice(thread('blocked'))!
  expect(desktopNotice(bare, { label: 'Studio', several: false })).toEqual({ title: 'Fix the build', subtitle: 'Needs you', body: '' })
  expect(browserNotice(bare)).toEqual({ title: 'Fix the build', body: 'Needs you' })
})

it('stays quiet when a child working for its parent finishes or fails (its parent hears), not when it needs you', () => {
  const child = (state: Status['state'], ext?: Record<string, Json>) => thread(state, undefined, { parent: 'p', ...(ext ? { ext } : {}) })
  const working = { 'thread-reports': { toParent: true } }
  expect(notice(child('done', working))).toBeUndefined()
  expect(notice(child('error', working))).toBeUndefined()
  expect(notice(child('blocked', working))).toMatchObject({ status: 'Needs you' })
  // Handed to the user (they wrote to it), or without reports: it notifies as any thread does.
  expect(notice(child('done'))).toMatchObject({ status: 'Finished' })
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
  const once = rejectionNotice({ machine: 'box', rejection }, away)!
  expect(once).toEqual({ machine: 'box', thread: 't', title: 'Anthropic rejected the API key', text: '2 threads are waiting. Sign in again to go on.' })
  // As before: the machine under the title on the desktop, the text alone in a browser.
  expect(desktopNotice(once, { label: 'Studio', several: false })).toEqual({ title: 'Anthropic rejected the API key', subtitle: 'Studio', body: '2 threads are waiting. Sign in again to go on.' })
  expect(browserNotice(once).body).toBe('2 threads are waiting. Sign in again to go on.')
  expect(rejectionNotice({ machine: 'box', rejection }, { focused: true, visible: true })).toBeUndefined()
  expect(rejectionNotice({ machine: 'box', rejection: { ...rejection, threads: [] } }, away)).toBeUndefined()
})
