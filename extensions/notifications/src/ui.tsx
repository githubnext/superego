/// <reference path="./env.d.ts" />
// notifications, UI half: a notification when a thread finishes, fails or needs you while the window is in the
// background, saying what it did, asks or failed on (threadNotification; a child working for its parent only when it needs
// you), and one when a provider rejects a machine's credentials (not one per thread it stops); clicking it shows the
// thread. The desktop app shows it (once, however many windows ask, and only while none has the focus); a browser with
// Web Notifications, once allowed: offered over the composer when you set a thread to work, never on load. With no
// window open, the desktop app notifies by itself, by this extension's setting. And how many threads are unread, on
// the app's icon: the desktop app counts them itself (the windows say what they show), a browser where it badges an
// installed web app.
import { useEffect, useState } from 'react'
import {
  BADGE, call, defineUiExtension, NOTIFY, unreadCount, useAppSetting, useProjects, type ComposerWhere, type Selection, type Store, type WindowState,
} from '@superego/app/ui'
import { BellIcon, IconButton, XIcon } from '@superego/ui'
import { notificationFor, rejectionNotification } from './notify.ts'
import { about } from './shared.ts'
import './styles.css'

/** Whether the browser's offer to notify was turned down here. */
let declined: Store<boolean>

export default defineUiExtension({
  ...about,
  setup(superego) {
    declined = superego.store<boolean>('declined', false, { persist: true, shared: true })
    superego.appSettings({
      id: 'notifications', title: 'Notifications', order: 60,
      settings: [{
        key: NOTIFY, title: 'Notify when a thread finishes, fails or needs you', default: true, type: 'boolean',
        description: 'While the window is in the background.',
      }, { key: BADGE, title: 'Show unread count on the app icon', default: true, type: 'boolean' }],
    })
    if (window.superego.web) {
      looking = superego.store<Selection | null>('looking', lookingAt(superego.window))
      const look = () => looking.set(lookingAt(superego.window))
      for (const event of ['select', 'focus', 'visibility'] as const) superego.on(event, look)
      if ('setAppBadge' in navigator) superego.slot('overlay', WebBadge)
    } else {
      // The desktop app counts, but the thread a window with the focus shows: it's being looked at.
      const shown = (selection: Selection | undefined) => void call('app', 'app.shown', { selection: selection ?? null }).catch(() => {})
      shown(superego.window.selection)
      superego.on('select', ({ selection }) => shown(selection))
    }
    superego.on('thread.status', (event) => {
      if (superego.appSetting<boolean>(NOTIFY) === false) return
      const notice = notificationFor(event, superego.window)
      if (notice) void call('app', 'app.notify', notice).catch(() => {})
    })
    // A provider rejecting the credentials: one notification, not one for each thread it stops (they're quiet).
    superego.on('auth.rejected', (event) => {
      if (superego.appSetting<boolean>(NOTIFY) === false) return
      const notice = rejectionNotification(event, superego.window)
      if (notice) void call('app', 'app.notify', notice).catch(() => {})
    })
    superego.slot('composer.above', Offer, { order: 300 })
  },
})

/** The thread being looked at: the one shown while the window has the focus and shows. */
const lookingAt = ({ focused, visible, selection }: Readonly<WindowState>) => focused && visible && selection ? { machine: selection.machine, thread: selection.thread } : null
let looking: Store<Selection | null>

/** In a browser that badges an installed web app: how many threads are unread, but the one being looked at. */
function WebBadge() {
  const [on] = useAppSetting<boolean>(BADGE)
  const { projects } = useProjects()
  const shown = looking.use()
  const count = on === false ? 0 : unreadCount(projects.flatMap((s) => s.threads.map((thread) => ({ machine: s.machine.id, thread }))), shown ?? undefined)
  useEffect(() => {
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
  const no = declined.use()
  const [, answered] = useState<NotificationPermission>()
  if (!asking() || no || on === false || thread.status.state !== 'working') return null
  return (
    <div className="notify-offer">
      <button type="button" className="notify-offer__ask" onClick={() => void Notification.requestPermission().then(answered)}>
        <BellIcon size={13} aria-hidden />Notify me when it's done
      </button>
      <IconButton label="Not now" className="notify-offer__no" onClick={() => declined.set(true)}><XIcon size={12} aria-hidden /></IconButton>
    </div>
  )
}
