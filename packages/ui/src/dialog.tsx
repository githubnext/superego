import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { Dialog as Base } from '@base-ui/react/dialog'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Drawer } from '@base-ui/react/drawer'
import { IconButton } from './button.tsx'
import { CaretLeftIcon } from './icons.tsx'
import { useNarrow } from './media.ts'
import { usePortalAttributes, type PortalAttributes } from './portal.tsx'
import { popupFocus } from './touch.ts'

type Props = {
  open?: boolean
  onClose(): void
  title?: ReactNode
  /** Beside the close button in the header. */
  actions?: ReactNode
  /** Back to the page this one was opened from, in the dialog (a phone's Settings): before the title, saying where. */
  back?: { label: string; onBack(): void }
  children: ReactNode
  className?: string
  size?: 'small' | 'medium' | 'large'
  /** The accessible name when there is no `title`. */
  label?: string
  /**
   * Holds input that closing would lose (a form not yet saved). On a phone, a swipe down or a tap above the sheet
   * then only tugs at it, as iOS's sheet does, and asks before discarding; ✕ and Escape still close it outright.
   */
  unsaved?: boolean
}

/**
 * A modal dialog: the page behind it is inert, focus stays inside, and it closes on Escape, on a click on the
 * backdrop, or with its close button, all through `onClose`. Menus, popovers and tooltips inside it layer above it
 * and take Escape first. Mount it to open it, or pass `open`.
 *
 * Wider than a phone it's Base UI's Dialog, centred. On a phone (NARROW) it's iOS's sheet at its large detent: Base
 * UI's Drawer, as the app's drawer and thread sheet are, up from the foot and back down with a swipe. The swipe starts
 * from its bar anywhere and from its body when that's scrolled to its top, follows the finger (resisting upward), and
 * closes past 30% of the sheet's height or on a flick down (the threshold is patches/@base-ui__react@*.patch's);
 * otherwise it springs back. The app behind (inside a `Drawer.Provider`'s `Drawer.Indent`) gets `--drawer-swipe-progress`
 * to step forward by as the sheet goes. No grabber, as iOS's single-height sheets with a bar of their own have none.
 */
export function Dialog(props: Props) {
  return useNarrow() ? <Sheet {...props} /> : <Centred {...props} />
}

function Centred({ open = true, onClose, children, className = '', size = 'medium', label, ...frame }: Props) {
  const marked = usePortalAttributes()
  // Opened, the focus goes to the first thing in it to use; under a finger the dialog itself holds it (touch.ts).
  const popup = useRef<HTMLDivElement>(null)
  return (
    <Base.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Base.Portal>
        <Base.Backdrop {...marked} className="superego-dialog__backdrop" />
        <Base.Popup {...marked} ref={popup} initialFocus={popupFocus(popup)} className={`superego-dialog superego-dialog--${size} ${className}`} aria-label={label}>
          <Frame {...frame}><div className="superego-dialog__body">{children}</div></Frame>
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  )
}

function Sheet({ open = true, onClose, children, className = '', size = 'medium', label, unsaved = false, ...frame }: Props) {
  const marked = usePortalAttributes()
  const popup = useRef<HTMLDivElement>(null)
  // Asked whether to discard what it holds, after a swipe or a tap outside tried to close it.
  const [asking, setAsking] = useState(false)
  return (
    <Drawer.Root open={open} swipeDirection="down" onOpenChange={(next, details) => {
      if (next) return
      if (unsaved && (details.reason === 'swipe' || details.reason === 'outside-press')) {
        // Base UI springs the sheet back when its close is cancelled.
        details.cancel()
        setAsking(true)
        return
      }
      onClose()
    }}>
      <Drawer.Portal>
        <Drawer.Backdrop {...marked} className="superego-dialog__backdrop" />
        <Drawer.Viewport {...marked} className="superego-dialog__viewport">
          <Drawer.Popup {...marked} ref={popup} initialFocus={popupFocus(popup)} aria-label={label}
            className={`superego-dialog superego-dialog--${size} superego-dialog--sheet ${className}`} data-unsaved={unsaved ? '' : undefined}>
            {/* With a mouse, a drag in the body selects its text; the bar drags the sheet. */}
            <Frame {...frame}><Drawer.Content className="superego-dialog__body">{children}</Drawer.Content></Frame>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
      <Discard open={asking} marked={marked} onKeep={() => setAsking(false)} onDiscard={() => { setAsking(false); onClose() }} returnTo={popup} />
    </Drawer.Root>
  )
}

/** The header (when there's a title or actions) over the body. Its title and ✕ are Base UI's, for a Dialog or a Drawer. */
function Frame({ title, actions, back, children }: Pick<Props, 'title' | 'actions' | 'back'> & { children: ReactNode }) {
  return (
    <div className="superego-dialog__frame">
      {(title || actions) && (
        <header className={`superego-dialog__header ${back ? 'has-back' : ''}`}>
          {back && (
            <button type="button" className="superego-dialog__back" onClick={back.onBack}>
              <CaretLeftIcon size={18} weight="bold" aria-hidden />{back.label}
            </button>
          )}
          <Base.Title className="superego-dialog__title">{title}</Base.Title>
          {/* On a phone the bar is iOS's (app.css): ✕ at the leading edge, the title in the middle, the actions at
              the trailing edge; so the actions are a part of their own, and so is ✕. */}
          <div className="superego-dialog__actions">
            {actions && <span className="superego-dialog__extra">{actions}</span>}
            <Base.Close render={<IconButton label="Close" className="superego-dialog__close" />}>✕</Base.Close>
          </div>
        </header>
      )}
      {children}
    </div>
  )
}

/** iOS's question when a sheet holding changes is swiped away: an action sheet at the foot, to discard or keep editing. */
function Discard({ open, marked, onKeep, onDiscard, returnTo }: {
  open: boolean; marked: PortalAttributes; onKeep(): void; onDiscard(): void; returnTo: RefObject<HTMLElement | null>
}) {
  const popup = useRef<HTMLDivElement>(null)
  const keep = useRef<HTMLButtonElement>(null)
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next) onKeep() }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop {...marked} className="superego-discard__backdrop" />
        {/* From the keyboard, Keep Editing has the focus: Enter shouldn't throw the changes away. */}
        <AlertDialog.Popup {...marked} ref={popup} className="superego-discard" initialFocus={popupFocus(popup, () => keep.current)} finalFocus={returnTo}>
          <div className="superego-discard__group">
            <AlertDialog.Title className="superego-discard__title">Discard your changes?</AlertDialog.Title>
            <button type="button" className="superego-discard__button superego-discard__button--danger" onClick={onDiscard}>Discard Changes</button>
          </div>
          <AlertDialog.Close ref={keep} className="superego-discard__button superego-discard__keep">Keep Editing</AlertDialog.Close>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
