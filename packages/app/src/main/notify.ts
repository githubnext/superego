// Notifications and the app icon's count on the desktop. The app follows every machine's threads and rejected
// providers (machines.ts), so it alone decides, whatever windows are open: a notification when a thread starts wanting
// a look, or a provider rejects a machine's credentials (shared/notifications.ts's rule), unless a window is in front.
// The count leaves out the thread shown in the window with the focus (each window says what it shows: `app.shown`).
import { app, Notification } from 'electron'
import { unreadThreads, type ProviderRejection, type ThreadInfo } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import type { ThreadRef } from '../shared/bridge.ts'
import { BADGE, createNotices, desktopNotification, NOTIFY, type ThreadNotification } from '../shared/notifications.ts'
import type { Machines } from './machines.ts'

/** Its callbacks are never called while it's being made: what they reach may be made after it. */
export type NotifierOptions = {
  headless: boolean
  settings: SettingsRegistry
  machines: Pick<Machines, 'allThreads' | 'allLinks' | 'linkOf'>
  /** Whether a window has the focus: nothing shows over it. */
  windowFocused(): boolean
  /** The thread shown in the window with the focus, if one has it: being looked at. */
  lookedAt(): ThreadRef | undefined
  /** Show a thread, as clicking its notification asks. */
  open(thread: ThreadRef): void
}

export type Notifier = ReturnType<typeof createNotifier>

export function createNotifier({ headless, settings, machines, windowFocused, lookedAt, open }: NotifierOptions) {
  const notices = createNotices()

  /** A machine's threads as now heard. */
  function track(machine: string, threads: ThreadInfo[]) {
    for (const notice of notices.threads(machine, threads)) notify(notice)
  }
  /** A machine's providers that rejected its credentials, as now heard. */
  function rejected(machine: string, rejections: ProviderRejection[]) {
    for (const notice of notices.rejections(machine, rejections)) notify(notice)
  }

  let badge = 0
  /**
   * The app icon's count (the Dock's on macOS): every machine's unread threads, but the one shown in the window with
   * the focus (being looked at), while the setting is on. On macOS it shows only with the app allowed to notify.
   * Headless (tests), nothing shows: a test may read it in `globalThis.superegoBadge`.
   */
  function refreshBadge() {
    if (!app.isReady()) return
    const count = settings.get(BADGE) === true ? unreadThreads(machines.allThreads(), lookedAt()).length : 0
    if (count === badge) return
    badge = count
    if (headless) (globalThis as { superegoBadge?: number }).superegoBadge = count
    else app.setBadgeCount(count)
  }

  /**
   * Show a notification, while the setting is on and no window has the focus; clicking it shows the thread. Headless
   * (tests), nothing shows: a test may collect them in `globalThis.superegoNotifications`.
   */
  function notify(notice: ThreadNotification) {
    if (settings.get(NOTIFY) !== true || windowFocused()) return
    if (headless) return void (globalThis as { superegoNotifications?: ThreadNotification[] }).superegoNotifications?.push(notice)
    if (!Notification.isSupported()) return
    const several = machines.allLinks().filter((link) => link.state === 'connected').length > 1
    const notification = new Notification(desktopNotification(notice, { label: machines.linkOf(notice.machine)?.label ?? notice.machine, several }))
    notification.on('click', () => open({ machine: notice.machine, thread: notice.thread }))
    notification.show()
  }

  return { track, rejected, refreshBadge }
}
