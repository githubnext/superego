import { useRef, type ReactNode } from 'react'
import { Dialog as Base } from '@base-ui/react/dialog'
import { IconButton } from './button.tsx'
import { CaretLeftIcon } from './icons.tsx'
import { usePortalAttributes } from './portal.tsx'
import { popupFocus } from './touch.ts'

/**
 * A modal dialog (Base UI): the page behind it is inert, focus stays inside, and it closes on Escape, on a click on
 * the backdrop, or with its close button, all through `onClose`. Menus, popovers and tooltips inside it layer above it
 * and take Escape first. Mount it to open it, or pass `open`.
 */
export function Dialog({ open = true, onClose, title, actions, back, children, className = '', size = 'medium', label }: {
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
}) {
  const marked = usePortalAttributes()
  // Opened, the focus goes to the first thing in it to use; under a finger the dialog itself holds it (touch.ts).
  const popup = useRef<HTMLDivElement>(null)
  const initialFocus = popupFocus(popup)
  return (
    <Base.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Base.Portal>
        <Base.Backdrop {...marked} className="superego-dialog__backdrop" />
        <Base.Popup {...marked} ref={popup} initialFocus={initialFocus} className={`superego-dialog superego-dialog--${size} ${className}`} aria-label={label}>
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
            <div className="superego-dialog__body">{children}</div>
          </div>
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  )
}
