// When to notify: a thread starts wanting a look (it finished, failed or needs you), or a provider rejects a machine's
// credentials (once, for all the threads it stops), while the window isn't in front.
import { signInNotification, threadNotification, type ThreadNotification, type WindowEvents, type WindowState } from '@superego/app/ui'

/**
 * The notice for a status change, if it calls for one: a change the window saw happen (not a thread it sees for the
 * first time) to a state that wants a look, while the window hasn't the focus or isn't showing.
 */
export function notificationFor({ machine, thread, before }: WindowEvents['thread.status'], window: Pick<WindowState, 'focused' | 'visible'>): ThreadNotification | undefined {
  if (before === undefined || (window.focused && window.visible)) return undefined
  return threadNotification(machine, thread)
}

/** The one notice for a provider rejecting a machine's credentials, while the window hasn't the focus or isn't showing. */
export function rejectionNotification({ machine, rejection }: WindowEvents['auth.rejected'], window: Pick<WindowState, 'focused' | 'visible'>): ThreadNotification | undefined {
  if (window.focused && window.visible) return undefined
  return signInNotification(machine, rejection)
}
