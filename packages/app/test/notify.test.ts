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
    track('local', [thread('a', { state: 'done' })])
    expect(notices()).toEqual([])
    track('local', [thread('a', { state: 'working' })])
    track('local', [thread('a', { state: 'done', msg: 'All done.' })])
    expect(notices()).toEqual([{ machine: 'local', thread: 'a', title: 'a', status: 'Done', text: 'All done.' }])
  })

  it('shows nothing over a window in front, and notifies again once none is', () => {
    const { track } = notifier()
    track('local', [thread('a', { state: 'working' }), thread('b', { state: 'working' })])
    focused = true
    track('local', [thread('a', { state: 'done' }), thread('b', { state: 'working' })])
    expect(notices()).toEqual([])
    focused = false
    track('local', [thread('a', { state: 'done' }), thread('b', { state: 'error' })])
    expect(notices().map((n) => n.thread)).toEqual(['b'])
  })

  it('says nothing with the setting off', () => {
    const { track, rejected } = notifier({ [NOTIFY]: false })
    rejected('local', [])
    track('local', [thread('a', { state: 'working' })])
    track('local', [thread('a', { state: 'done' })])
    rejected('local', [rejection(1, ['a'])])
    expect(notices()).toEqual([])
  })

  it('notifies once as a provider rejects a machine\'s credentials, not once for each thread it stops', () => {
    const { track, rejected } = notifier()
    rejected('local', [])
    track('local', [thread('a', { state: 'working' }), thread('b', { state: 'working' })])
    track('local', [thread('a', { state: 'blocked', kind: 'auth', msg: 'faux rejected the API key' }), thread('b', { state: 'working' })])
    rejected('local', [rejection(1, ['a'])])
    track('local', [thread('a', { state: 'blocked', kind: 'auth' }), thread('b', { state: 'blocked', kind: 'auth' })])
    rejected('local', [rejection(1, ['a', 'b'])])
    expect(notices()).toEqual([{ machine: 'local', thread: 'a', title: 'faux rejected the API key', text: expect.stringContaining('Sign in again') }])
    // Signed in, then rejected again: another notice.
    rejected('local', [])
    rejected('local', [rejection(2, ['b'])])
    expect(notices().map((notice) => notice.thread)).toEqual(['a', 'b'])
  })

  it('notifies once of what changed while a machine was away, as it reconnects', () => {
    const { track, rejected } = notifier()
    track('box', [thread('a', { state: 'working' }), thread('b', { state: 'working' })])
    rejected('box', [])
    // The link drops (the laptop sleeps): nothing is heard. Meanwhile a finishes and the provider rejects the key.
    // It reconnects: the lists are heard afresh, and what changed is news, once.
    track('box', [thread('a', { state: 'done', msg: 'All done.' }), thread('b', { state: 'working' })])
    rejected('box', [rejection(1, ['b'])])
    expect(notices().map((n) => n.title)).toEqual(['a', 'faux rejected the API key'])
    // Heard again (another window, a second watch): nothing more.
    track('box', [thread('a', { state: 'done', msg: 'All done.' }), thread('b', { state: 'working' })])
    rejected('box', [rejection(1, ['b'])])
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
