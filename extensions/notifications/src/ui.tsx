/// <reference path="./env.d.ts" />
// notifications, UI half: a notification when a thread finishes, fails or needs you while the window is in the
// background, saying what it did, asks or failed on (threadNotice; a child working for its parent only when it needs
// you), and one when a provider rejects a machine's credentials (not one per thread it stops); clicking it shows the
// thread. The desktop app shows it (once, however many windows ask, and only while none has the focus); a browser with
// Web Notifications, once allowed: offered over the composer when you set a thread to work, never on load. With no
// window open, the desktop app notifies by itself, by this extension's setting.
import { useState } from 'react'
import { call, defineUiExtension, NOTIFY, useAppSetting, type ComposerWhere, type Store } from '@superego/app/ui'
import { BellIcon, IconButton, XIcon } from '@superego/ui'
import { noticeFor, rejectionNotice } from './notify.ts'
import { about } from './shared.ts'
import './styles.css'

/** Whether the browser's offer to notify was turned down here. */
let declined: Store<boolean>

export default defineUiExtension({
  ...about,
  setup(superego) {
    declined = superego.store<boolean>('notifications.declined', false, { persist: true })
    superego.appSettings({
      id: 'notifications', title: 'Notifications', order: 60,
      settings: [{
        key: NOTIFY, title: 'Notify when a thread needs a look', default: true, type: 'boolean',
        description: 'A notification when a thread finishes, fails or needs you while the window is in the background.',
      }],
    })
    superego.on('thread.status', (event) => {
      if (superego.appSetting<boolean>(NOTIFY) === false) return
      const notice = noticeFor(event, superego.window)
      if (notice) void call('app', 'app.notify', notice).catch(() => {})
    })
    // A provider rejecting the credentials: one notification, not one for each thread it stops (they're quiet).
    superego.on('auth.rejected', (event) => {
      if (superego.appSetting<boolean>(NOTIFY) === false) return
      const notice = rejectionNotice(event, superego.window)
      if (notice) void call('app', 'app.notify', notice).catch(() => {})
    })
    superego.slot('composer.above', Offer, { order: 300 })
  },
})

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
