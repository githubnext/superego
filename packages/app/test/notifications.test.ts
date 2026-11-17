// When to notify and what a notification says: the one rule (shared/notifications.ts) the desktop's main process and
// a browser's page both follow.
import { describe, expect, it } from 'vitest'
import type { ProviderRejection, Status, ThreadInfo } from '@superego/protocol'
import { browserNotification, createNotices, desktopNotification } from '../src/shared/notifications.ts'

const thread = (state: Status['state'], msg?: string, more: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id: 't', title: 'Fix the build', cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status: { state, ...(msg ? { msg } : {}) }, ...more })
/** The notice for `t` once it changes from working, if any. */
const notice = (t: ThreadInfo) => {
  const notices = createNotices()
  notices.threads('box', [{ ...t, status: { state: 'working' } }])
  return notices.threads('box', [t])[0]
}
const rejection = (since: number, threads = ['t', 'u']): ProviderRejection =>
  ({ provider: 'anthropic', name: 'Anthropic', summary: 'Anthropic rejected the API key', detail: '401 invalid x-api-key', since, threads })

describe('what a notification says', () => {
  it('says what happened: what a run did, the question it asks, why it failed', () => {
    expect(notice(thread('done', 'Merged the notices change into main'))).toEqual({ machine: 'box', thread: 't', title: 'Fix the build', status: 'Done', text: 'Merged the notices change into main' })
    // The question itself: its last paragraph, after any context, as plain text, shortened.
    const question = `Two ways to go, each with its own cost.\n\n- one\n- two\n\nShould I **rebase** onto main, or merge it, given ${'how much has changed '.repeat(5)}?`
    const asked = notice(thread('blocked', question))!
    expect(asked).toMatchObject({ status: 'Question', text: expect.stringMatching(/^Should I rebase onto main, or merge it, given how much.*…$/) })
    expect(asked.text!.length).toBeLessThanOrEqual(100)
    // An error's first line.
    expect(notice(thread('error', '429 Too Many Requests\n{"error":{"type":"rate_limit"}}'))).toMatchObject({ status: 'Failed', text: '429 Too Many Requests' })
  })

  it("says the word alone when there's nothing more to say", () => {
    expect(notice(thread('done'))).toEqual({ machine: 'box', thread: 't', title: 'Fix the build', status: 'Done' })
    expect(notice(thread('error'))).toMatchObject({ status: 'Failed' })
    expect(notice(thread('blocked'))).toMatchObject({ status: 'Question' })
    expect(notice(thread('blocked'))!.text).toBeUndefined()
  })

  it('names what it wants after the title, as the app does: the desktop says the machine under it when there are several', () => {
    const done = notice(thread('done', 'Merged it'))!
    expect(desktopNotification(done, { label: 'Studio', several: false })).toEqual({ title: 'Fix the build — Done', body: 'Merged it' })
    expect(desktopNotification(done, { label: 'Studio', several: true })).toEqual({ title: 'Fix the build — Done', subtitle: 'Studio', body: 'Merged it' })
    expect(browserNotification(done)).toEqual({ title: 'Fix the build — Done', body: 'Merged it' })
    const asks = notice({ ...thread('blocked'), status: { state: 'blocked', kind: 'permission' } })!
    expect(desktopNotification(asks, { label: 'Studio', several: false })).toEqual({ title: 'Fix the build — Permission', body: '' })
    expect(browserNotification(asks)).toEqual({ title: 'Fix the build — Permission', body: '' })
  })
})

describe('when to notify', () => {
  it('notifies of a thread changing to want a look, not of one first heard, nor of other states', () => {
    const notices = createNotices()
    expect(notices.threads('box', [thread('done')])).toEqual([])
    expect(notices.threads('box', [thread('working')])).toEqual([])
    expect(notices.threads('box', [thread('done')])).toHaveLength(1)
    expect(notices.threads('box', [thread('done')])).toEqual([])
    expect(notices.threads('box', [thread('idle')])).toEqual([])
    // The same id on another machine is another thread, first heard there.
    expect(notices.threads('studio', [thread('error')])).toEqual([])
  })

  it('notifies of what changed while a machine was away, as its list is heard again', () => {
    const notices = createNotices()
    notices.threads('box', [thread('working')])
    // Away (asleep, its link down): nothing heard. Back: its list again, with the thread done meanwhile.
    expect(notices.threads('box', [thread('done')])).toHaveLength(1)
  })

  it('stays quiet when a quiet thread (a child working for its parent) finishes or fails, not when it needs you', () => {
    const child = (state: Status['state'], quiet = true) => thread(state, undefined, { parent: 'p', ...(quiet ? { quiet: true as const } : {}) })
    expect(notice(child('done'))).toBeUndefined()
    expect(notice(child('error'))).toBeUndefined()
    expect(notice(child('blocked'))).toMatchObject({ status: 'Question' })
    // Handed to the user (they wrote to it), or without reports: it notifies as any thread does.
    expect(notice(child('done', false))).toMatchObject({ status: 'Done' })
  })

  it('stays quiet for threads waiting for sign-in, and says it once for the provider', () => {
    const waiting: ThreadInfo = { ...thread('blocked'), status: { state: 'blocked', kind: 'auth', msg: 'Anthropic rejected the API key' } }
    expect(notice(waiting)).toBeUndefined()
    const notices = createNotices()
    // What a machine had when first heard isn't news.
    expect(notices.rejections('box', [rejection(1)])).toEqual([])
    expect(notices.rejections('box', [])).toEqual([])
    const once = notices.rejections('box', [rejection(2)])
    expect(once).toEqual([{ machine: 'box', thread: 't', title: 'Anthropic rejected the API key', text: '2 threads are waiting. Sign in again to go on.' }])
    // More threads stopping is the same rejection: no more notices.
    expect(notices.rejections('box', [rejection(2, ['t', 'u', 'v'])])).toEqual([])
    // As before: the machine under the title on the desktop, the text alone in a browser.
    expect(desktopNotification(once[0]!, { label: 'Studio', several: false })).toEqual({ title: 'Anthropic rejected the API key', subtitle: 'Studio', body: '2 threads are waiting. Sign in again to go on.' })
    expect(browserNotification(once[0]!).body).toBe('2 threads are waiting. Sign in again to go on.')
    // None waiting yet: nothing to say.
    expect(notices.rejections('box', [rejection(3, [])])).toEqual([])
    // Rejected again while the machine was away: news, heard as it reconnects.
    expect(notices.rejections('box', [rejection(4)])).toHaveLength(1)
  })
})
