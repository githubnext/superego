// Notifications and the app icon's count, in the window. On the desktop the main process decides and shows both for
// every window (main/notify.ts): a window only says which thread it shows (`app.shown`), which the count leaves out
// while it has the focus. In a browser the page does both, by the same rule (shared/notifications.ts): Web
// Notifications once allowed (offered over the composer while a thread works, never on load), and the count on an
// installed web app's icon.
import { useEffect, useRef, useState } from 'react'
import { unreadThreads } from '@superego/protocol'
import { BellIcon, IconButton, XIcon } from '@superego/ui'
import { APP } from '../shared/app-settings.ts'
import { BADGE, browserNotification, createNotices, NOTIFY, type ThreadNotification } from '../shared/notifications.ts'
import { call, useAppSetting } from './client.ts'
import type { ComposerWhere } from './composer.ts'
import type { UiApi } from './extension-api.ts'
import { useLocalState } from './local-state.ts'
import { useAllThreads, useRejections, useSelection } from './state.tsx'

export function registerNotifications(core: UiApi) {
  core.slot('composer.above', Offer, { order: 300 })
}

/** What the window does for notifications and the count: drawn once, in the shell. */
export function Notifications() {
  return window.superego.web ? <InBrowser /> : <Shown />
}

/** On the desktop: tell the app which thread this window shows. */
function Shown() {
  const { selection } = useSelection()
  useEffect(() => {
    void call(APP, 'app.shown', { selection: selection ?? null }).catch((error) => console.error(error))
  }, [selection?.machine, selection?.thread])
  return null
}

/** Whether the page is in front: it has the focus, and shows. */
const inFront = () => document.hasFocus() && document.visibilityState !== 'hidden'
function useInFront() {
  const [front, setFront] = useState(inFront)
  useEffect(() => {
    const check = () => setFront(inFront())
    window.addEventListener('focus', check)
    window.addEventListener('blur', check)
    document.addEventListener('visibilitychange', check)
    return () => { window.removeEventListener('focus', check); window.removeEventListener('blur', check); document.removeEventListener('visibilitychange', check) }
  }, [])
  return front
}

/** In a browser: notify of what every machine's threads and providers do, and count what's unread on the icon. */
function InBrowser() {
  const threads = useAllThreads()
  const rejections = useRejections()
  const { selection, select } = useSelection()
  const [notifyOn] = useAppSetting<boolean>(NOTIFY)
  const [badgeOn] = useAppSetting<boolean>(BADGE)
  const front = useInFront()
  const notices = useRef(createNotices())
  // The latest, for the effects below, which run on the lists changing alone.
  const latest = useRef({ notifyOn, select })
  latest.current = { notifyOn, select }

  const show = (notice: ThreadNotification) => {
    if (latest.current.notifyOn === false || inFront() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const { machine, thread } = notice
    try {
      // One per thread (its tag), however many tabs show it; clicking it brings this one forward, showing the thread.
      const { title, body } = browserNotification(notice)
      const notification = new Notification(title, { body, tag: `${machine}/${thread}` })
      notification.onclick = () => {
        window.focus()
        notification.close()
        latest.current.select({ machine, thread })
      }
    } catch { /* a phone's browser, which shows them only from a service worker */ }
  }
  useEffect(() => {
    for (const [machine, list] of Object.entries(threads)) if (list) for (const notice of notices.current.threads(machine, list)) show(notice)
  }, [threads])
  useEffect(() => {
    for (const [machine, list] of Object.entries(rejections)) if (list) for (const notice of notices.current.rejections(machine, list)) show(notice)
  }, [rejections])

  // The thread being looked at isn't counted: the one shown while the page is in front.
  const looking = front ? selection : undefined
  const all = Object.entries(threads).flatMap(([machine, list]) => (list ?? []).map((thread) => ({ machine, thread })))
  const count = badgeOn === false ? 0 : unreadThreads(all, looking).length
  useEffect(() => {
    if (!('setAppBadge' in navigator)) return
    void (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {})
  }, [count])
  return null
}

/**
 * Whether this browser shows notifications from a page: a phone's (Android Chrome, say) has `Notification` but shows
 * them only from a service worker, which the window has none of, and throws when one is made. Tried once, while it's
 * not allowed yet, so the try never shows anything.
 */
let pageNotifications: boolean | undefined
function showsPageNotifications() {
  if ((navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile) return false
  try {
    new Notification('', { silent: true }).close()
    return true
  } catch {
    return false
  }
}
const asking = () => window.superego.web && typeof Notification !== 'undefined' && Notification.permission === 'default' &&
  (pageNotifications ??= showsPageNotifications())

/** In a browser that hasn't been asked: offered while the thread works, so you hear when it's done. */
function Offer({ thread }: ComposerWhere) {
  const [on] = useAppSetting<boolean>(NOTIFY)
  const [declined, setDeclined] = useLocalState('notifications.declined', false, { shared: true })
  const [, answered] = useState<NotificationPermission>()
  if (!asking() || declined || on === false || thread.status.state !== 'working') return null
  return (
    <div className="notify-offer">
      <button type="button" className="notify-offer__ask" onClick={() => void Notification.requestPermission().then(answered)}>
        <BellIcon size={13} aria-hidden />Notify me when it's done
      </button>
      <IconButton label="Not now" className="notify-offer__no" onClick={() => setDeclined(true)}><XIcon size={12} aria-hidden /></IconButton>
    </div>
  )
}
