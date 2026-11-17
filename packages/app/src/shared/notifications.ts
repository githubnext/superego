// Notifications, the app's own: when to notify and what a notification says, one rule for the desktop's main process
// (main/notify.ts, deciding for every window, with none open too) and a browser's page (renderer/notifications.tsx).
// A notification when a thread starts wanting a look (it finished, failed or needs you), and one when a provider rejects
// a machine's credentials (not one per thread it stops), while no window is in front; clicking it shows the thread.
// The count on the app's icon is `unreadThreads` (@superego/protocol). Both switch off in the app's settings.
import { firstLine, lastParagraph, shorten, statusWord, unread, type ProviderRejection, type ThreadInfo } from '@superego/protocol'
import type { SectionSpec } from '@superego/settings'
import type { MachineId } from './bridge.ts'
import { rejectionChanges, statusChanges, type Rejected, type Statuses } from './changes.ts'

/**
 * What a notification says of a thread that wants a look now (it finished, failed or needs you); nothing for any other
 * state. `title` is the thread's; `status` what it wants, in the app's word (Done, Question, Permission, Failed); `text`, in a line, what it did (its recap), what it asks, or
 * why it failed, when that's known. Each place lays it out its own way (`desktopNotification`, `browserNotification`).
 */
export type ThreadNotification = { machine: MachineId; thread: string; title: string; status?: string; text?: string }
export function threadNotification(machine: MachineId, thread: ThreadInfo): ThreadNotification | undefined {
  if (!unread(thread)) return undefined
  const { state, msg } = thread.status
  const status = statusWord(thread.status, thread.quiet)
  // Done, the daemon's recap; blocked, the question (its last paragraph, after any context); error, its first line.
  const text = msg ? state === 'done' ? shorten(msg) : state === 'error' ? firstLine(msg) : lastParagraph(msg) : undefined
  return { machine, thread: thread.id, title: thread.title, status, ...(text ? { text } : {}) }
}

/** A notification's title: the thread's, and what it wants after it ("Release notes — Permission"). */
const titleOf = (notification: ThreadNotification) => notification.status ? `${notification.title} — ${notification.status}` : notification.title

/**
 * A notification as the desktop shows it: the title, the machine's name under it when several are connected, and the
 * text below. One without a status (sign-in's) names the machine there, whatever.
 */
export function desktopNotification(notification: ThreadNotification, machine: { label: string; several: boolean }) {
  return { title: titleOf(notification), ...(machine.several || !notification.status ? { subtitle: machine.label } : {}), body: notification.text ?? '' }
}

/** A notification as a browser shows it, with no subtitle: the title, then the text. */
export function browserNotification(notification: ThreadNotification) {
  return { title: titleOf(notification), body: notification.text ?? '' }
}

/** How many threads wait for sign-in, as the notice says it. */
export const waitingPhrase = (count: number) =>
  count === 0 ? 'New turns wait until you sign in again.' : `${count} thread${count === 1 ? ' is' : 's are'} waiting.`

/**
 * The one notification for a provider rejecting a machine's credentials, however many threads it stops: clicking it
 * shows the first of them (where the notice says what to do). Nothing while none waits.
 */
export function signInNotification(machine: MachineId, rejection: Pick<ProviderRejection, 'summary' | 'threads'>): ThreadNotification | undefined {
  const first = rejection.threads[0]
  return first ? { machine, thread: first, title: rejection.summary, text: `${waitingPhrase(rejection.threads.length)} Sign in again to go on.` } : undefined
}

/**
 * What to notify of as each machine's threads and rejected providers are heard: a thread changing to want a look, and
 * a provider rejecting the credentials (again), once for every thread it stops. What's first heard (on starting, from a
 * new machine) isn't news; what changed while a machine was away (asleep, its link down) is, heard as it reconnects.
 * Whether to show them (the setting, a window in front) is the caller's.
 */
export function createNotices() {
  const statuses: Statuses = new Map()
  const rejected: Rejected = new Map()
  return {
    threads(machine: MachineId, threads: ThreadInfo[]): ThreadNotification[] {
      return statusChanges(statuses, { [machine]: threads })
        .flatMap(({ thread, before }) => before === undefined ? [] : threadNotification(machine, thread) ?? [])
    },
    rejections(machine: MachineId, rejections: ProviderRejection[]): ThreadNotification[] {
      return rejectionChanges(rejected, { [machine]: rejections }).flatMap(({ rejection }) => signInNotification(machine, rejection) ?? [])
    },
  }
}

/** App setting: whether to notify at all. */
export const NOTIFY = 'notifications.enabled'
/** App setting: whether the app's icon shows how many threads are unread (the Dock's, an installed web app's). */
export const BADGE = 'notifications.badge'

/** The app's Notifications settings, on the desktop and in a browser alike. */
export const NOTIFICATION_SETTINGS: SectionSpec = {
  id: 'notifications', title: 'Notifications', order: 62,
  settings: [
    { key: NOTIFY, title: 'Notify when a thread finishes, fails or needs you', default: true, description: 'While the window is in the background.', type: { type: 'boolean' } },
    { key: BADGE, title: 'Show unread count on the app icon', default: true, type: { type: 'boolean' } },
  ],
}
