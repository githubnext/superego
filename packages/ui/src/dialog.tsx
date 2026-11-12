import type { ReactNode } from 'react'
import { Dialog as Base } from '@base-ui/react/dialog'
import { IconButton } from './button.tsx'

/**
 * A modal dialog (Base UI): the page behind it is inert, focus stays inside, and it closes on Escape, on a click on
 * the backdrop, or with its close button, all through `onClose`. Menus, popovers and tooltips inside it layer above it
 * and take Escape first. Mount it to open it, or pass `open`.
 */
export function Dialog({ open = true, onClose, title, actions, children, className = '', size = 'medium', label }: {
  open?: boolean
  onClose(): void
  title?: ReactNode
  /** Beside the close button in the header. */
  actions?: ReactNode
  children: ReactNode
  className?: string
  size?: 'small' | 'medium' | 'large'
  /** The accessible name when there is no `title`. */
  label?: string
}) {
  return (
    <Base.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Base.Portal>
        <Base.Backdrop className="superego-dialog__backdrop" />
        <Base.Popup className={`superego-dialog superego-dialog--${size} ${className}`} aria-label={label}>
          <div className="superego-dialog__frame">
            {(title || actions) && (
              <header className="superego-dialog__header">
                <Base.Title className="superego-dialog__title">{title}</Base.Title>
                <div className="superego-dialog__actions">{actions}<Base.Close render={<IconButton label="Close" />}>✕</Base.Close></div>
              </header>
            )}
            <div className="superego-dialog__body">{children}</div>
          </div>
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  )
}
