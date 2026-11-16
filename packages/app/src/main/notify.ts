// Notifications and the app icon's count on the desktop. The app follows every machine's threads (machines.ts); with
// no window open it notifies by itself when a thread starts wanting a look, or threads start waiting for sign-in; with
// one, each window's notifications extension decides, and asks through `app.notify`. The settings that switch both on
// (`NOTIFY`, `BADGE`) are that extension's: only once a window has declared them does the app notify or count.
import { app, Notification } from 'electron'
import { waitingForSignIn, type ThreadInfo } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import type { ThreadRef } from '../shared/bridge.ts'
import { BADGE, desktopNotification, NOTIFY, signInNotification, threadNotification, unreadCount, type ThreadNotification } from '../shared/notifications.ts'
import type { Machines } from './machines.ts'

/** Its callbacks are never called while it's being made: what they reach may be made after it. */
export type NotifierOptions = {
  headless: boolean
  settings: SettingsRegistry
  machines: Pick<Machines, 'allThreads' | 'allLinks' | 'linkOf'>
  /** Whether a window is open: then each one's notifications extension decides what to notify of. */
  windowOpen(): boolean
  /** Whether a window has the focus: nothing shows over it. */
  windowFocused(): boolean
  /** The thread shown in the window with the focus, if one has it: being looked at. */
  lookedAt(): ThreadRef | undefined
  /** Show a thread, as clicking its notification asks. */
  open(thread: ThreadRef): void
}

export type Notifier = ReturnType<typeof createNotifier>

export function createNotifier({ headless, settings, machines, windowOpen, windowFocused, lookedAt, open }: NotifierOptions) {
  /** Each thread's state as last heard, by `<machine>/<thread>`, to notify of changes alone. */
  const lastStatus = new Map<string, ThreadInfo['status']['state']>()
  /** How many of each machine's threads wait for sign-in. */
  const signingIn = new Map<string, number>()

  /** A machine's threads as now heard (`announce`: changed, not first heard on connecting): notify with no window open. */
  function track(machine: string, threads: ThreadInfo[], announce: boolean) {
    const waiting = threads.filter((t) => waitingForSignIn(t.status) && !t.without?.includes('notifications'))
    // A provider rejecting the credentials: one notice when threads start waiting for sign-in, not one each.
    const before = signingIn.get(machine) ?? 0
    signingIn.set(machine, waiting.length)
    if (announce && !before && waiting.length && !windowOpen() && settings.get(NOTIFY) === true) {
      const notice = signInNotification(machine, { summary: waiting[0]!.status.msg ?? 'Sign in again', threads: waiting.map((t) => t.id) })
      if (notice) notify(notice)
    }
    for (const thread of threads) {
      const key = `${machine}/${thread.id}`
      const before = lastStatus.get(key)
      const now = thread.status.state
      lastStatus.set(key, now)
      if (!announce || before === now || windowOpen()) continue
      // Only once a window has declared the setting: an app without the notifications extension never notifies.
      const notice = threadNotification(machine, thread)
      if (notice && settings.get(NOTIFY) === true && !thread.without?.includes('notifications')) notify(notice)
    }
  }

  let badge = 0
  /**
   * The app icon's count (the Dock's on macOS): every machine's unread threads, but the one shown in the window with
   * the focus (being looked at), while the setting is on. On macOS it shows only with the app allowed to notify.
   * Headless (tests), nothing shows: a test may read it in `globalThis.superegoBadge`.
   */
  function refreshBadge() {
    if (!app.isReady()) return
    const count = settings.get(BADGE) === true ? unreadCount(machines.allThreads(), lookedAt()) : 0
    if (count === badge) return
    badge = count
    if (headless) (globalThis as { superegoBadge?: number }).superegoBadge = count
    else app.setBadgeCount(count)
  }

  /** When each notice was last shown: every window asks, and the first asking shows it. */
  const noticed = new Map<string, number>()
  /**
   * Show a notification of a thread that wants a look, unless a window has the focus; clicking it shows the thread.
   * Headless (tests), nothing shows: a test may collect them in `globalThis.superegoNotifications`.
   */
  function notify(notice: ThreadNotification) {
    const key = JSON.stringify(notice)
    for (const [old, at] of noticed) if (Date.now() - at >= 5_000) noticed.delete(old)
    if (Date.now() - (noticed.get(key) ?? 0) < 5_000) return
    noticed.set(key, Date.now())
    if (headless) return void (globalThis as { superegoNotifications?: ThreadNotification[] }).superegoNotifications?.push(notice)
    if (windowFocused() || !Notification.isSupported()) return
    const several = machines.allLinks().filter((link) => link.state === 'connected').length > 1
    const notification = new Notification(desktopNotification(notice, { label: machines.linkOf(notice.machine)?.label ?? notice.machine, several }))
    notification.on('click', () => open({ machine: notice.machine, thread: notice.thread }))
    notification.show()
  }

  return { track, notify, refreshBadge }
}
