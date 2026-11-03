import { useEffect, useRef, type ReactNode } from 'react'
import { IconButton } from './button.tsx'

/**
 * A modal dialog on the native `<dialog>`: the page behind it is inert, focus stays inside, and it closes on Escape,
 * on a click on the backdrop, or with its close button, all through `onClose`. A control inside that handles Escape
 * itself (a popover, an inline field) calls `preventDefault()` on the keydown, and the dialog stays open.
 * Mount it to open it; unmount (or `open={false}`) to close it.
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
  const ref = useRef<HTMLDialogElement>(null)
  const pressedOnBackdrop = useRef(false)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={`mu-dialog mu-dialog--${size} ${className}`}
      aria-label={label}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      // Only a click that starts and ends on the backdrop closes: a drag out of a text field doesn't.
      onPointerDown={(event) => { pressedOnBackdrop.current = event.target === ref.current }}
      onClick={(event) => { if (pressedOnBackdrop.current && event.target === ref.current) onClose() }}
    >
      <div className="mu-dialog__frame">
        {(title || actions) && (
          <header className="mu-dialog__header">
            <h1 className="mu-dialog__title">{title}</h1>
            <div className="mu-dialog__actions">{actions}<IconButton label="Close" onClick={onClose}>✕</IconButton></div>
          </header>
        )}
        <div className="mu-dialog__body">{children}</div>
      </div>
    </dialog>
  )
}
