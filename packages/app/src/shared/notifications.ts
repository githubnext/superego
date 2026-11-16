// What a notification of a thread says, and the count on the app's icon: pure, for the desktop's main process and the
// window alike. The settings that switch them on (`NOTIFY`, `BADGE`) are declared by the notifications extension for
// now; the main process reads them with no window open too.
import { firstLine, lastParagraph, shorten, STATUS_WORDS, unread, type ProviderRejection, type ThreadInfo } from '@superego/protocol'
import type { MachineId } from './bridge.ts'

/** What happened to a thread, as its notification says first: the desktop's subtitle, the start of a browser's body. */
export type NotificationStatus = (typeof STATUS_WORDS)['done' | 'blocked' | 'error']

/**
 * What a notification says of a thread that wants a look now (it finished, failed or needs you); nothing for any other
 * state. `title` is the thread's; `status` what happened; `text`, in a line, what it did (its recap), what it asks, or
 * why it failed, when that's known. `app.notify` shows one, each place laying it out its own way (`desktopNotification`,
 * `browserNotification`): in the desktop app once however many windows ask, in a browser with Web Notifications.
 */
export type ThreadNotification = { machine: MachineId; thread: string; title: string; status?: NotificationStatus; text?: string }
export function threadNotification(machine: MachineId, thread: ThreadInfo): ThreadNotification | undefined {
  if (!unread(thread)) return undefined
  const { state, msg } = thread.status
  const status = STATUS_WORDS[state === 'done' || state === 'error' ? state : 'blocked']
  // Done, the daemon's recap; blocked, the question (its last paragraph, after any context); error, its first line.
  const text = msg ? state === 'done' ? shorten(msg) : state === 'error' ? firstLine(msg) : lastParagraph(msg) : undefined
  return { machine, thread: thread.id, title: thread.title, status, ...(text ? { text } : {}) }
}

/** How many threads are unread, but the one being looked at (`shown`): the count on the app's icon. */
export function unreadCount(threads: { machine: MachineId; thread: ThreadInfo }[], shown?: { machine: MachineId; thread: string }) {
  return threads.filter(({ machine, thread }) => unread(thread) && !(shown?.machine === machine && shown.thread === thread.id)).length
}

/**
 * A notification as the desktop shows it: what happened under the title, with the machine's name when several are connected,
 * and the text below. One without a status (sign-in's) names the machine there, whatever.
 */
export function desktopNotification(notification: ThreadNotification, machine: { label: string; several: boolean }) {
  const subtitle = notification.status ? (machine.several ? `${notification.status} · ${machine.label}` : notification.status) : machine.label
  return { title: notification.title, subtitle, body: notification.text ?? '' }
}

/** A notification as a browser shows it, with no subtitle: "Finished: <text>", or just what happened when there's no text. */
export function browserNotification(notification: ThreadNotification) {
  const body = notification.status ? (notification.text ? `${notification.status}: ${notification.text}` : notification.status) : notification.text ?? ''
  return { title: notification.title, body }
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

/** Whether to notify at all. */
export const NOTIFY = 'notifications.enabled'
/** Whether the app's icon shows how many threads are unread (the Dock's, an installed web app's). */
export const BADGE = 'notifications.badge'

