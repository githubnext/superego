// The app's own notifications, with no window open to decide: a thread wanting a look, and one notice as a machine's
// threads start waiting for sign-in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { MemorySettingsStore, SettingsRegistry } from '@superego/settings'
import { NOTIFY, type ThreadNotification } from '../src/shared/notifications.ts'

vi.mock('electron', () => ({ app: { isReady: () => true }, Notification: { isSupported: () => false } }))
const { createNotifier } = await import('../src/main/notify.ts')

const thread = (id: string, status: ThreadInfo['status'], more: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title: id, cwd: '/', createdAt: 0, activeAt: 0, status, ...more }) as ThreadInfo
const signIn = (id: string) => thread(id, { state: 'blocked', kind: 'auth', msg: 'Sign in to faux' })

const notices = () => (globalThis as { superegoNotifications?: ThreadNotification[] }).superegoNotifications!
let open = false
const notifier = (values: Record<string, boolean> = { [NOTIFY]: true }) => createNotifier({
  headless: true, settings: new SettingsRegistry(new MemorySettingsStore(values)), machines: { allThreads: () => [], allLinks: () => [], linkOf: () => undefined },
  windowOpen: () => open, windowFocused: () => false, lookedAt: () => undefined, open: () => {},
})
beforeEach(() => { open = false; (globalThis as { superegoNotifications?: ThreadNotification[] }).superegoNotifications = [] })
afterEach(() => { delete (globalThis as { superegoNotifications?: unknown }).superegoNotifications })

describe('with no window open', () => {
  it('notifies once as a machine\'s threads start waiting for sign-in, not once each', () => {
    const { track } = notifier()
    track('local', [thread('a', { state: 'idle' })], false)
    track('local', [signIn('a')], true)
    track('local', [signIn('a'), signIn('b')], true)
    expect(notices()).toEqual([{ machine: 'local', thread: 'a', title: 'Sign in to faux', text: expect.stringContaining('Sign in again') }])
    // Signed in, then rejected again: another notice.
    track('local', [thread('a', { state: 'idle' }), thread('b', { state: 'idle' })], true)
    track('local', [thread('a', { state: 'idle' }), signIn('b')], true)
    expect(notices().map((notice) => notice.thread)).toEqual(['a', 'b'])
  })

  it('notifies of a thread changing to want a look, not of one first heard', () => {
    const { track } = notifier()
    track('local', [thread('a', { state: 'done' })], false)
    expect(notices()).toEqual([])
    track('local', [thread('a', { state: 'working' })], true)
    track('local', [thread('a', { state: 'done', msg: 'All done.' })], true)
    expect(notices()).toEqual([{ machine: 'local', thread: 'a', title: 'a', status: 'Finished', text: 'All done.' }])
  })

  it('leaves it to the windows while one is open, and says nothing until a window declared the setting', () => {
    const { track } = notifier()
    open = true
    track('local', [thread('a', { state: 'working' })], true)
    track('local', [thread('a', { state: 'done' })], true)
    track('local', [signIn('b')], true)
    expect(notices()).toEqual([])
    open = false
    const quiet = notifier({})
    quiet.track('local', [thread('a', { state: 'working' })], true)
    quiet.track('local', [thread('a', { state: 'done' }), signIn('b')], true)
    expect(notices()).toEqual([])
  })

  it('leaves out a thread without notifications', () => {
    const { track } = notifier()
    track('local', [thread('a', { state: 'working' }, { without: ['notifications'] })], true)
    track('local', [thread('a', { state: 'done' }, { without: ['notifications'] }), signIn('b')], true)
    expect(notices().map((notice) => notice.thread)).toEqual(['b'])
  })
})
