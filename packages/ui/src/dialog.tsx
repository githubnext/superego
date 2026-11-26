import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { Dialog as Base } from '@base-ui/react/dialog'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Drawer } from '@base-ui/react/drawer'
import { Button, IconButton } from './button.tsx'
import { TextField } from './field.tsx'
import { CaretLeftIcon } from './icons.tsx'
import { useNarrow } from './media.ts'
import { usePortalAttributes, type PortalAttributes } from './portal.tsx'
import { popupFocus } from './touch.ts'

/** What a `Dialog` takes. */
export type DialogProps = {
  open?: boolean
  onClose(): void
  title?: ReactNode
  /** Beside the close button in the header. */
  actions?: ReactNode
  /** Under the body, its buttons at the trailing edge: Cancel, then what the dialog is for (Save). */
  footer?: ReactNode
  /**
   * The body edge to edge, without its padding: for what lays out its own (a list, a search field across the top, a
   * form with a foot of its own).
   */
  flush?: boolean
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
  /** What takes the focus as it opens (not under a finger): by default, the first thing in it to use. */
  initialFocus?: () => HTMLElement | boolean | null | undefined
}

/**
 * A modal dialog: the page behind it is inert, focus stays inside, and it closes on Escape, on a click on the
 * backdrop, or with its close button, all through `onClose`. Menus, popovers and tooltips inside it layer above it
 * and take Escape first. Mount it to open it, or pass `open`. Its body has room around what's in it, unless `flush`;
 * a `footer` holds its buttons. To ask before doing something, `ConfirmDialog`; for a name, `PromptDialog`.
 *
 * Wider than a phone it's Base UI's Dialog, centred. On a phone (NARROW) it's iOS's sheet at its large detent: Base
 * UI's Drawer, as the app's drawer and thread sheet are, up from the foot and back down with a swipe. The swipe starts
 * from its bar anywhere and from its body when that's scrolled to its top, follows the finger (resisting upward), and
 * closes past 30% of the sheet's height or on a flick down (the threshold is patches/@base-ui__react@*.patch's);
 * otherwise it springs back. The app behind (inside a `Drawer.Provider`'s `Drawer.Indent`) gets `--drawer-swipe-progress`
 * to step forward by as the sheet goes. No grabber, as iOS's single-height sheets with a bar of their own have none.
 */
export function Dialog(props: DialogProps) {
  return useNarrow() ? <Sheet {...props} /> : <Centred {...props} />
}

const dialogClass = (size: string, flush: boolean, className: string) =>
  `superego-dialog superego-dialog--${size} ${flush ? 'superego-dialog--flush' : ''} ${className}`

function Centred({ open = true, onClose, children, className = '', size = 'medium', flush = false, label, initialFocus, ...frame }: DialogProps) {
  const marked = usePortalAttributes()
  // Opened, the focus goes to the first thing in it to use; under a finger the dialog itself holds it (touch.ts).
  const popup = useRef<HTMLDivElement>(null)
  return (
    <Base.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Base.Portal>
        <Base.Backdrop {...marked} className="superego-dialog__backdrop" />
        <Base.Popup {...marked} ref={popup} initialFocus={popupFocus(popup, initialFocus)} className={dialogClass(size, flush, className)} aria-label={label}>
          <Frame {...frame}><div className="superego-dialog__body">{children}</div></Frame>
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  )
}

function Sheet({ open = true, onClose, children, className = '', size = 'medium', flush = false, label, unsaved = false, initialFocus, ...frame }: DialogProps) {
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
          <Drawer.Popup {...marked} ref={popup} initialFocus={popupFocus(popup, initialFocus)} aria-label={label}
            className={`${dialogClass(size, flush, className)} superego-dialog--sheet`} data-unsaved={unsaved ? '' : undefined}>
            {/* With a mouse, a drag in the body selects its text; the bar drags the sheet. */}
            <Frame {...frame}><Drawer.Content className="superego-dialog__body">{children}</Drawer.Content></Frame>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
      <Discard open={asking} marked={marked} onKeep={() => setAsking(false)} onDiscard={() => { setAsking(false); onClose() }} returnTo={popup} />
    </Drawer.Root>
  )
}

/**
 * The header (when there's a title or actions) over the body, and the footer under it. Its title and ✕ are Base UI's,
 * for a Dialog or a Drawer.
 */
function Frame({ title, actions, back, footer, children }: Pick<DialogProps, 'title' | 'actions' | 'back' | 'footer'> & { children: ReactNode }) {
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
      {footer && <footer className="superego-dialog__footer">{footer}</footer>}
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
        <AlertDialog.Backdrop {...marked} className="superego-action-sheet__backdrop" />
        {/* From the keyboard, Keep Editing has the focus: Enter shouldn't throw the changes away. */}
        <AlertDialog.Popup {...marked} ref={popup} className="superego-action-sheet" initialFocus={popupFocus(popup, () => keep.current)} finalFocus={returnTo}>
          <div className="superego-action-sheet__group">
            <div className="superego-action-sheet__head">
              <AlertDialog.Title className="superego-action-sheet__title">Discard your changes?</AlertDialog.Title>
            </div>
            <button type="button" className="superego-action-sheet__button superego-action-sheet__button--danger" onClick={onDiscard}>Discard Changes</button>
          </div>
          <AlertDialog.Close ref={keep} className="superego-action-sheet__button superego-action-sheet__cancel">Keep Editing</AlertDialog.Close>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

/** What a thrown error says, for the dialog to show. */
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)

/**
 * Running what a dialog's confirming button does: while it runs (a promise) the dialog is busy, and then it closes; if
 * it throws or rejects, the dialog stays open and says why. `busy` and `error` given by the caller are shown as well.
 */
function useRun(onClose: () => void, busy: boolean | undefined, error: string | undefined) {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async (act: () => void | Promise<void>) => {
    setFailure(undefined)
    setPending(true)
    try {
      await act()
    } catch (thrown) {
      console.error(thrown)
      if (mounted.current) { setFailure(reason(thrown)); setPending(false) }
      return
    }
    if (mounted.current) setPending(false)
    onClose()
  }
  const working = Boolean(busy) || pending
  // Escape, or Cancel: not while it runs, or what it ends with would have nowhere to show.
  const close = () => { if (!working) onClose() }
  return { run, close, busy: working, error: error ?? failure, clearFailure: () => setFailure(undefined) }
}

/** The attributes a dialog's portalled parts wear: its tree's, and the mark that hides a page's web views under it. */
const overlay = (marked: PortalAttributes) => ({ ...marked, 'data-superego-overlay': '' })

/** What a `ConfirmDialog` takes. */
export type ConfirmDialogProps = {
  open?: boolean
  /** The question: "Delete “Shoes”?". */
  title: ReactNode
  /** What it means, under it: "Its file goes; this can't be undone." */
  description?: ReactNode
  /** More under the description, when a line of detail needs to be shown. */
  children?: ReactNode
  /** The confirming button's words: say what it does ("Delete"). By default "Confirm". */
  confirmLabel?: string
  cancelLabel?: string
  /** `danger`: it destroys something. Its button is red, and the focus starts on Cancel, so Enter doesn't do it. */
  tone?: 'default' | 'danger'
  /** Busy, its buttons are off; as well as while `onConfirm`'s promise runs. */
  busy?: boolean
  /** Why it couldn't, shown above the buttons; as well as what `onConfirm` threw. */
  error?: string
  /** Pressed: the dialog closes (`onClose`) once it returns or its promise resolves; if that throws, it stays open, saying why. */
  onConfirm(): void | Promise<void>
  /** Cancelled (Cancel, Escape), or done. */
  onClose(): void
  className?: string
}

/**
 * Asks before doing something: a question, what it means, Cancel and the button that does it. Escape cancels; a click
 * beside it doesn't. With `tone="danger"`, the button is red and Cancel has the focus. On a phone, iOS's action sheet
 * at the foot of the screen.
 *
 *     <ConfirmDialog title="Delete “Shoes”?" description="Its file goes; this can't be undone." confirmLabel="Delete"
 *       tone="danger" onConfirm={() => remove(file)} onClose={close} />
 */
export function ConfirmDialog({ open = true, title, description, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default', busy, error, onConfirm, onClose, className = '' }: ConfirmDialogProps) {
  const marked = usePortalAttributes()
  const narrow = useNarrow()
  const popup = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  const state = useRun(onClose, busy, error)
  const danger = tone === 'danger'
  // From the keyboard, Enter does what has the focus: Cancel when what it does destroys something.
  const initialFocus = popupFocus(popup, () => danger ? cancel.current : confirm.current)
  const press = () => { if (!state.busy) void state.run(onConfirm) }
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next) state.close() }}>
      <AlertDialog.Portal>
        {narrow ? (
          <>
            <AlertDialog.Backdrop {...overlay(marked)} className="superego-action-sheet__backdrop" />
            <AlertDialog.Popup {...overlay(marked)} ref={popup} initialFocus={initialFocus} aria-busy={state.busy}
              className={`superego-action-sheet superego-confirm ${className}`} data-tone={tone}>
              <div className="superego-action-sheet__group">
                <div className="superego-action-sheet__head">
                  <AlertDialog.Title className="superego-action-sheet__title">{title}</AlertDialog.Title>
                  {description && <AlertDialog.Description className="superego-action-sheet__message">{description}</AlertDialog.Description>}
                  {children && <div className="superego-action-sheet__message">{children}</div>}
                  {state.error && <p className="superego-action-sheet__error" role="alert">{state.error}</p>}
                </div>
                <button ref={confirm} type="button" disabled={state.busy} onClick={press}
                  className={`superego-action-sheet__button ${danger ? 'superego-action-sheet__button--danger' : ''}`}>{confirmLabel}</button>
              </div>
              <button ref={cancel} type="button" className="superego-action-sheet__button superego-action-sheet__cancel" disabled={state.busy} onClick={state.close}>{cancelLabel}</button>
            </AlertDialog.Popup>
          </>
        ) : (
          <>
            <AlertDialog.Backdrop {...overlay(marked)} className="superego-alert__backdrop" />
            <AlertDialog.Popup {...overlay(marked)} ref={popup} initialFocus={initialFocus} aria-busy={state.busy}
              className={`superego-alert superego-confirm ${className}`} data-tone={tone}>
              <AlertDialog.Title className="superego-alert__title">{title}</AlertDialog.Title>
              {description && <AlertDialog.Description className="superego-alert__message">{description}</AlertDialog.Description>}
              {children && <div className="superego-alert__detail">{children}</div>}
              {state.error && <p className="superego-alert__error" role="alert">{state.error}</p>}
              <div className="superego-alert__actions">
                <Button ref={cancel} disabled={state.busy} onClick={state.close}>{cancelLabel}</Button>
                <Button ref={confirm} variant={danger ? 'danger' : 'primary'} disabled={state.busy} onClick={press}>{confirmLabel}</Button>
              </div>
            </AlertDialog.Popup>
          </>
        )}
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

/** What a `PromptDialog` takes. */
export type PromptDialogProps = {
  open?: boolean
  /** What it asks for: "Rename canvas". */
  title: ReactNode
  description?: ReactNode
  /** The field's name, shown over it; without one, the title names it to a screen reader. */
  label?: string
  /** What the field holds as it opens (a name to change), selected so typing replaces it. */
  defaultValue?: string
  /** The field's text, for a caller that keeps it (with `onChange`); otherwise the dialog does, from `defaultValue`. */
  value?: string
  onChange?(value: string): void
  placeholder?: string
  /** The confirming button's words: say what it does ("Rename"). By default "Save". */
  confirmLabel?: string
  cancelLabel?: string
  /** What's wrong with the text (trimmed) as it's typed, or nothing; while something is, it can't be submitted. */
  validate?(value: string): string | undefined
  /** Whether nothing (or only spaces) can be submitted. */
  allowEmpty?: boolean
  /** Busy, its buttons are off; as well as while `onSubmit`'s promise runs. */
  busy?: boolean
  /** Why it couldn't, shown under the field; as well as what `onSubmit` threw. */
  error?: string
  /** Enter, or the confirming button, with the text trimmed: closes (`onClose`) once it returns or its promise resolves; if that throws, it stays open, saying why. */
  onSubmit(value: string): void | Promise<void>
  /** Cancelled (Cancel, Escape, a click beside it), or done. */
  onClose(): void
  className?: string
}

/**
 * Asks for a line of text (a name): a title, the field and its buttons. The field has the focus as it opens, its text
 * selected; Enter submits it, Escape cancels. Empty (unless `allowEmpty`) or failing `validate`, it can't be submitted.
 * Under a finger, the dialog holds the focus until the field is tapped, so the keyboard doesn't cover it as it opens.
 *
 *     <PromptDialog title="Rename canvas" label="Name" defaultValue={canvas.name} confirmLabel="Rename"
 *       onSubmit={(name) => rename(canvas, name)} onClose={close} />
 */
export function PromptDialog({
  open = true, title, description, label, defaultValue = '', value, onChange, placeholder, confirmLabel = 'Save', cancelLabel = 'Cancel',
  validate, allowEmpty = false, busy, error, onSubmit, onClose, className = '',
}: PromptDialogProps) {
  const marked = usePortalAttributes()
  const popup = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const selected = useRef(false)
  const id = useId()
  const [own, setOwn] = useState(defaultValue)
  const text = value ?? own
  const trimmed = text.trim()
  const state = useRun(onClose, busy, error)
  const invalid = validate?.(trimmed)
  const empty = !allowEmpty && trimmed === ''
  const shown = state.error ?? invalid
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (state.busy || empty || invalid) return
    void state.run(() => onSubmit(trimmed))
  }
  return (
    <Base.Root open={open} onOpenChange={(next) => { if (!next) state.close() }}>
      <Base.Portal>
        <Base.Backdrop {...overlay(marked)} className="superego-alert__backdrop" />
        <Base.Popup {...overlay(marked)} ref={popup} initialFocus={popupFocus(popup, () => field.current)} aria-busy={state.busy}
          className={`superego-alert superego-prompt ${className}`}>
          <form className="superego-prompt__form" onSubmit={submit} noValidate>
            <Base.Title className="superego-alert__title">{title}</Base.Title>
            {description && <Base.Description className="superego-alert__message">{description}</Base.Description>}
            {label && <label className="superego-alert__label" htmlFor={id}>{label}</label>}
            <TextField ref={field} id={id} className="superego-alert__field" value={text} placeholder={placeholder} readOnly={state.busy}
              aria-label={label ? undefined : typeof title === 'string' ? title : undefined} aria-invalid={shown ? true : undefined}
              aria-describedby={shown ? `${id}-error` : undefined} autoComplete="off" spellCheck={false}
              // The first time it has the focus, its text is selected: typing replaces the name it came with.
              onFocus={(event) => { if (!selected.current) { selected.current = true; event.currentTarget.select() } }}
              onChange={(event) => { setOwn(event.target.value); state.clearFailure(); onChange?.(event.target.value) }} />
            {shown && <p id={`${id}-error`} className="superego-alert__error" role="alert">{shown}</p>}
            <div className="superego-alert__actions">
              <Button disabled={state.busy} onClick={state.close}>{cancelLabel}</Button>
              <Button type="submit" variant="primary" disabled={state.busy || empty || Boolean(invalid)}>{confirmLabel}</Button>
            </div>
          </form>
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  )
}
