// When to notify: a thread starts wanting a look (it finished, failed or needs you) while the window isn't in front.
import { threadNotice, type ThreadNotice, type WindowEvents, type WindowState } from '@superego/app/ui'

/**
 * The notice for a status change, if it calls for one: a change the window saw happen (not a thread it sees for the
 * first time) to a state that wants a look, while the window hasn't the focus or isn't showing.
 */
export function noticeFor({ machine, thread, before }: WindowEvents['thread.status'], window: Pick<WindowState, 'focused' | 'visible'>): ThreadNotice | undefined {
  if (before === undefined || (window.focused && window.visible)) return undefined
  return threadNotice(machine, thread)
}
