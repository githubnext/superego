// The box a message is written in, wherever it goes: a thread's composer (composer-view.tsx) and the New thread
// dialog's prompt. What's typed (the caller keeps it), files to go with it (picked, dropped on it or pasted into it),
// completions extensions offer for the word at the caret (`$co` → a skill, see composer.ts), and one button at its end.
// Under it, Attach at the left and what the caller adds at the right. On a phone, as Messages has it: Attach a + at the
// box's leading edge instead, the box a capsule.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import type { Attachment } from '@superego/protocol'
import { Button, FileIcon, HoverCard, IconButton, PaperclipIcon, PlusIcon, TextArea } from '@superego/ui'
import type { HeldItem } from './composer-items.ts'
import { useRegistry } from './registry.tsx'
import { completionsIn } from './lookups.ts'
import { readAttachment } from './attachments.ts'
import { askFor, complete, completing, menuFor, type Completion, type ComposerWhere, type Offered } from './composer.ts'
import { useNarrow } from './media.ts'

/** A number for each provider, to tell when the providers completing a word change. */
const ids = new WeakMap<object, number>()
let lastId = 0
const idOf = (provider: object) => {
  if (!ids.has(provider)) ids.set(provider, ++lastId)
  return ids.get(provider)!
}

export type ComposerBoxProps = {
  where: ComposerWhere
  /** On the outermost element, which files are dropped on: `dock` under a thread. */
  className: string
  text: string
  setText(text: string | ((typed: string) => string)): void
  files: Attachment[]
  setFiles(files: Attachment[] | ((was: Attachment[]) => Attachment[])): void
  /** What panes put in it to go with the message (composer-items.ts), a chip each after the files; and taking one off. */
  items?: readonly HeldItem[]
  onRemoveItem?(id: string): void
  /** Whether it takes files and completes words now (not while something above claims what's typed). */
  open?: boolean
  disabled?: boolean
  placeholder: string
  /** Over the box, in it: what went wrong (sending, reading a file), with what fixes it. */
  error?: ReactNode
  /** A file that couldn't be read. */
  onError(message: string): void
  /** Keys the completions' menu didn't take. */
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void
  /** Send `text`, as a command taken from the menu (`Completion.submit`) asks; without it, a command is only put in. */
  onSubmit?(text: string): void
  inputRef: Ref<HTMLTextAreaElement>
  /** At the box's end: Send, say. */
  action?: ReactNode
  /** Under the box: Attach, and this at the right; none, no footer. */
  footer?: { end?: ReactNode } | false
  /** Above the box, inside what files are dropped on. */
  children?: ReactNode
  'aria-label'?: string
  autoFocus?: boolean
}

export function ComposerBox({ where, className, text, setText, files, setFiles, items = [], onRemoveItem, open = true, disabled, placeholder, error, onError, onKeyDown, onSubmit, inputRef, action, footer = {}, children, autoFocus, ...aria }: ComposerBoxProps) {
  const registry = useRegistry()
  const input = useRef<HTMLTextAreaElement | null>(null)
  const setInput = (node: HTMLTextAreaElement | null) => {
    input.current = node
    if (typeof inputRef === 'function') inputRef(node)
    else if (inputRef) (inputRef as { current: HTMLTextAreaElement | null }).current = node
  }
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const narrow = useNarrow()
  const attach = async (list: FileList | File[]) => {
    try {
      const read = await Promise.all([...list].map(readAttachment))
      setFiles((was) => [...was, ...read])
    } catch (e) { onError((e as Error).message) }
  }

  // Completing a word as it's typed, as extensions offer: ↑↓ pick, ⇥ or ⏎ takes one (⏎ runs a command), esc leaves the
  // word as typed.
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const [caret, setCaret] = useState(0)
  // Wherever the text came from (typed, filled in, sent and emptied), the caret is where the box has it now.
  useLayoutEffect(() => { if (input.current) setCaret(input.current.selectionStart) }, [text])
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<number>()
  const { machine, thread, cwd } = where
  const found = open ? completing(completionsIn(registry, thread ? { machine: machine.id, thread } : undefined), text, caret) : []
  const word = found[0]?.word
  // What the providers offered for the word, kept while they're asked again as the word grows (see menuFor).
  const [offered, setOffered] = useState<Offered>()
  useEffect(() => {
    if (!found.length) return setOffered(undefined)
    return askFor(found, where, setOffered)
  }, [JSON.stringify(found.map((f) => [idOf(f.provider), f.word])), machine.id, thread?.id, thread?.archived, thread?.hidden, cwd])
  const menu = menuFor(found, offered, dismissed)
  useEffect(() => { setPick(0) }, [word?.query, word?.start])
  useEffect(() => { if (!word) setDismissed(undefined) }, [word === undefined])
  /** Put `item` in place of the word; `run`, a command (`submit`) is sent as it's taken. */
  const take = (item: Completion, run = false) => {
    if (!word) return
    const next = complete(text, caret, word.start, item.insert)
    if (run && item.submit && onSubmit) { setDismissed(undefined); onSubmit(next.text); return }
    setText(next.text)
    requestAnimationFrame(() => { input.current?.setSelectionRange(next.caret, next.caret); input.current?.focus(); setCaret(next.caret) })
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && word && !event.metaKey && !event.altKey && !event.ctrlKey) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setPick((pick + (event.key === 'ArrowDown' ? 1 : -1) + menu.length) % menu.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); take(menu[pick] ?? menu[0]!, event.key === 'Enter'); return }
      // Only the menu closes: not a dialog the box is in.
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(word.start); return }
    }
    onKeyDown(event)
  }

  // The box: the words, what goes with them, and the one button at their end.
  const box = (
    <div className="dock__box">
      {(files.length > 0 || items.length > 0) && open && (
        <div className="composer__files">
          {files.map((file, index) => (
            <span key={`${file.name}-${index}`} className="attachment">
              {file.mimeType.startsWith('image/') ? <img src={`data:${file.mimeType};base64,${file.data}`} alt="" /> : <span className="attachment__icon"><FileIcon size={14} aria-hidden /></span>}
              <span className="attachment__name">{file.name}</span>
              <button type="button" className="attachment__remove" aria-label={`Remove ${file.name}`} onClick={() => setFiles((was) => was.filter((_, i) => i !== index))}>×</button>
            </span>
          ))}
          {items.map((item) => <ItemChip key={item.id} item={item} onRemove={() => onRemoveItem?.(item.id)} />)}
        </div>
      )}
      {error && <div className="composer__error">{error}</div>}
      {menu && (
        <div className="completions" role="listbox" aria-label={offered!.title}>
          {menu.map((item, index) => (
            <div key={`${item.label}-${index}`} role="option" aria-selected={index === pick} className={`completions__item ${index === pick ? 'is-active' : ''}`}
              onMouseEnter={() => setPick(index)} onMouseDown={(e) => { e.preventDefault(); take(item, true) }}>
              {item.icon && <span className="completions__icon" aria-hidden>{item.icon}</span>}
              <span className="completions__label">{item.label}</span>
              {item.detail && <span className="completions__detail">{item.detail}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <TextArea ref={setInput} rows={1} value={text} disabled={disabled} aria-label={aria['aria-label']} autoFocus={autoFocus} autoComplete="off"
          onChange={(e) => setText(e.target.value)} onKeyDown={keyDown} onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => { if (open && e.clipboardData.files.length) { e.preventDefault(); void attach(e.clipboardData.files) } }}
          placeholder={placeholder} />
        {action}
      </div>
    </div>
  )

  return (
    <div className={`composer-box ${className} ${dragging ? 'is-dropping' : ''}`}
      onDragOver={(e) => { if (open && !disabled && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={(e) => { setDragging(false); if (open && !disabled && e.dataTransfer.files.length) { e.preventDefault(); void attach(e.dataTransfer.files) } }}>
      {children}
      {narrow
        ? (
          <div className="dock__row">
            {open && footer && <IconButton label="Attach" className="composer__plus" disabled={disabled} onClick={() => picker.current?.click()}><PlusIcon size={20} aria-hidden /></IconButton>}
            {box}
          </div>
        )
        : box}
      {open && footer && <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void attach(e.target.files); e.target.value = '' }} />}
      {footer && (
        <div className="dock__footer">
          {open && !narrow && (
            <Button variant="ghost" className="dock__action composer__attach" disabled={disabled} onClick={() => picker.current?.click()}>
              <PaperclipIcon size={13} aria-hidden />Attach
            </Button>
          )}
          <span className="dock__footer-end">{footer.end}</span>
        </div>
      )}
    </div>
  )
}

/** A pane's item in the composer: its icon (or image) and label, and on hover its image larger and its detail. */
function ItemChip({ item, onRemove }: { item: HeldItem; onRemove(): void }) {
  const image = item.files.find((file) => file.mimeType.startsWith('image/'))
  const src = image && `data:${image.mimeType};base64,${image.data}`
  const chip = (
    <span className={`attachment composer-item ${item.icon ? 'attachment--chip' : ''}`}>
      {item.icon ? <span className="attachment__icon">{item.icon}</span> : src ? <img src={src} alt="" /> : <span className="attachment__icon"><FileIcon size={14} aria-hidden /></span>}
      <span className="attachment__name">{item.label}</span>
      <button type="button" className="attachment__remove" aria-label={`Remove ${item.label}`} onClick={onRemove}>×</button>
    </span>
  )
  if (!src && !item.detail) return chip
  return (
    <HoverCard side="top" className="composer-item__card" card={<>
      {src && <img src={src} alt="" />}
      {item.detail && <code>{item.detail}</code>}
    </>}>{chip}</HoverCard>
  )
}
