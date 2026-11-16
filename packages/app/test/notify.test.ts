// The desktop's notifications and icon count, decided by the main process alone for every window, with none open too:
// a thread wanting a look, one notice as a provider rejects a machine's credentials, nothing over a window in front.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRejection, ThreadInfo } from '@superego/protocol'
import { MemorySettingsStore, SettingsRegistry } from '@superego/settings'
import { registerAppSettings } from '../src/shared/app-settings.ts'
import { BADGE, NOTIFY, type ThreadNotification } from '../src/shared/notifications.ts'

vi.mock('electron', () => ({ app: { isReady: () => true }, Notification: { isSupported: () => false } }))
const { createNotifier } = await import('../src/main/notify.ts')

const thread = (id: string, status: ThreadInfo['status'], more: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title: id, cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status, ...more })
const rejection = (since: number, threads: string[]): ProviderRejection =>
  ({ provider: 'faux', name: 'Faux', summary: 'faux rejected the API key', detail: '401', since, threads })

const notices = () => (globalThis as { superegoNotifications?: ThreadNotification[] }).superegoNotifications!
const badge = () => (globalThis as { superegoBadge?: number }).superegoBadge
let focused = false
let looking: { machine: string; thread: string } | undefined
let all: { machine: string; thread: ThreadInfo }[] = []
/** A notifier with the app's settings at their defaults, but `values`. */
const notifier = (values: Record<string, boolean> = {}) => {
  const settings = new SettingsRegistry(new MemorySettingsStore(values))
  registerAppSettings(settings)
  return Object.assign(createNotifier({
    headless: true, settings, machines: { allThreads: () => all, allLinks: () => [], linkOf: () => undefined },
    windowFocused: () => focused, lookedAt: () => looking, open: () => {},
  }), { settings })
}
beforeEach(() => { focused = false; looking = undefined; all = []; (globalThis as { superegoNotifications?: ThreadNotification[] }).superegoNotifications = [] })
afterEach(() => { delete (globalThis as { superegoNotifications?: unknown }).superegoNotifications; delete (globalThis as { superegoBadge?: unknown }).superegoBadge })

describe('notifications', () => {
  it('notifies of a thread changing to want a look, not of one first heard, on by default', () => {
    const { track } = notifier()
    track('local', [thread('a', { state: 'done' })], false)
    expect(notices()).toEqual([])
    track('local', [thread('a', { state: 'working' })], true)
    track('local', [thread('a', { state: 'done', msg: 'All done.' })], true)
    expect(notices()).toEqual([{ machine: 'local', thread: 'a', title: 'a', status: 'Finished', text: 'All done.' }])
  })

  it('notifies once for a change, however often its list is heard (every window open, one decider)', () => {
    const { track } = notifier()
    track('local', [thread('a', { state: 'working' })], false)
    for (let i = 0; i < 3; i++) track('local', [thread('a', { state: 'done' })], true)
    expect(notices()).toHaveLength(1)
  })

  it('shows nothing over a window in front, and notifies again once none is', () => {
    const { track } = notifier()
    track('local', [thread('a', { state: 'working' }), thread('b', { state: 'working' })], false)
    focused = true
    track('local', [thread('a', { state: 'done' }), thread('b', { state: 'working' })], true)
    expect(notices()).toEqual([])
    focused = false
    track('local', [thread('a', { state: 'done' }), thread('b', { state: 'error' })], true)
    expect(notices().map((n) => n.thread)).toEqual(['b'])
  })

  it('says nothing with the setting off', () => {
    const { track, rejected } = notifier({ [NOTIFY]: false })
    rejected('local', [], false)
    track('local', [thread('a', { state: 'working' })], false)
    track('local', [thread('a', { state: 'done' })], true)
    rejected('local', [rejection(1, ['a'])], true)
    expect(notices()).toEqual([])
  })

  it('notifies once as a provider rejects a machine\'s credentials, not once for each thread it stops', () => {
    const { track, rejected } = notifier()
    rejected('local', [], false)
    track('local', [thread('a', { state: 'working' }), thread('b', { state: 'working' })], false)
    track('local', [thread('a', { state: 'blocked', kind: 'auth', msg: 'faux rejected the API key' }), thread('b', { state: 'working' })], true)
    rejected('local', [rejection(1, ['a'])], true)
    track('local', [thread('a', { state: 'blocked', kind: 'auth' }), thread('b', { state: 'blocked', kind: 'auth' })], true)
    rejected('local', [rejection(1, ['a', 'b'])], true)
    expect(notices()).toEqual([{ machine: 'local', thread: 'a', title: 'faux rejected the API key', text: expect.stringContaining('Sign in again') }])
    // Signed in, then rejected again: another notice.
    rejected('local', [], true)
    rejected('local', [rejection(2, ['b'])], true)
    expect(notices().map((notice) => notice.thread)).toEqual(['a', 'b'])
    // Heard on (re)connecting: not news.
    rejected('local', [rejection(3, ['b'])], false)
    expect(notices()).toHaveLength(2)
  })
})

describe('the app icon\'s count', () => {
  it("counts every machine's unread threads, but the one shown in the window in front, while the setting is on", async () => {
    all = [
      { machine: 'local', thread: thread('a', { state: 'done' }) },
      { machine: 'local', thread: thread('b', { state: 'blocked' }) },
      { machine: 'box', thread: thread('c', { state: 'working' }) },
      { machine: 'box', thread: thread('d', { state: 'done' }, { quiet: true }) },
    ]
    const { refreshBadge, settings } = notifier()
    refreshBadge()
    expect(badge()).toBe(2)
    looking = { machine: 'local', thread: 'b' }
    refreshBadge()
    expect(badge()).toBe(1)
    await settings.set(BADGE, false)
    refreshBadge()
    expect(badge()).toBe(0)
  })
})
