// A thread's composer: what you type (a draft per thread), files to send with it, completions extensions offer, and what
// you sent while the agent was busy, waiting its turn. What's drawn above it can take what's typed (`useComposerClaim`)
// or put words in it (`useComposer`).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { InboxState } from '@earendil-works/pi-durable'
import type { Attachment, ThreadInfo } from '@superego/protocol'
import { ArrowDownIcon, ArrowElbowRightIcon, ArrowUpIcon, Button, FileIcon, IconButton, ListIcon, PaperclipIcon, TextArea, XIcon } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { useRegistry } from './registry.tsx'
import { completionsIn } from './lookups.ts'
import { Slot } from './placement.tsx'
import { useShell } from './state.tsx'
import { ctrlDigit } from '../shared/shortcuts.ts'
import { useLocalState } from './local-state.ts'
import { readAttachment, splitMessage } from './attachments.ts'
import { askFor, complete, completing, menuFor, type Completion, type Offered } from './composer.ts'
import { ProfileSwitch } from './profile-pick.tsx'
import { UnarchiveButton } from './thread-actions.tsx'
import type { Message } from './transcript.tsx'

/**
 * Something above the composer that wants what is typed: an answer to a question, say. The newest claim wins. `keyDown`
 * sees the composer's keys first (with what's typed) and returns true for those it took: picking an option, say.
 */
export type ComposerClaim = { placeholder: string; submit(text: string): Promise<unknown>; keyDown?(event: KeyboardEvent, text: string): boolean }
const ClaimContext = createContext<(claim: ComposerClaim) => () => void>(() => () => {})

/** While mounted (and given a claim), the composer's text goes to `claim.submit` instead of the thread. */
export function useComposerClaim(claim: ComposerClaim | undefined) {
  const register = useContext(ClaimContext)
  const latest = useRef(claim)
  latest.current = claim
  useEffect(() => {
    if (!claim) return
    return register({
      get placeholder() { return latest.current?.placeholder ?? '' },
      submit: (text) => latest.current!.submit(text),
      keyDown: (event, text) => latest.current?.keyDown?.(event, text) ?? false,
    })
  }, [Boolean(claim), register])
}

/** The composer, to what's above it (`composer.above`): what's typed, and ways to put words in it. */
export type Composer = {
  text: string
  /** Replace what's typed with `text`, ready to send or change. */
  fill(text: string): void
  /**
   * Offer `messages` in the empty composer: ←/→ pick one (shown as the placeholder), ⏎ sends it, ⇥ puts it in the box
   * to change. ⌃1–⌃9 send the first nine, from the prompt or anywhere else in the thread's view. Undefined (or none)
   * offers nothing.
   */
  suggest(messages: string[] | undefined): void
  /** Which offered message is picked, while the composer offers them. */
  picked: number | undefined
}
const ComposerContext = createContext<Composer>({ text: '', fill() {}, suggest() {}, picked: undefined })

/** The composer of the thread this is drawn above. */
export const useComposer = () => useContext(ComposerContext)

/** A prompt's transcript: the thread it's under. */
const transcriptOf = (prompt: Element) => prompt.closest('.dock')?.parentElement?.querySelector<HTMLElement>(':scope > .thread__scroll')

/**
 * What you sent while the agent was busy, waiting its turn: a row each over the composer, shown as soon as it's sent,
 * saying when it goes in (a steer after the current step, a follow-up when the agent is done), and taken back with ×.
 * A follow-up can be sent now: it becomes a steer (`thread.steer`). Placed, it becomes
 * an entry in the transcript like any other.
 */
function Queued({ machine, thread, inbox }: { machine: MachineEntry; thread: ThreadInfo; inbox: InboxState | undefined }) {
  const dispatch = useRegistry().router.dispatch
  const items = (inbox?.items ?? []).filter((item) => item.mode !== 'write')
  if (!items.length) return null
  const act = (id: 'thread.withdraw' | 'thread.steer', submission: string) => void dispatch(id, { thread: thread.id, submission }, { machine: machine.id, source: 'composer' })
    .catch((error) => console.error(error))
  const firstFollowUp = items.find((item) => item.mode === 'followUp')
  return (
    <div className="dock__queued">
      {items.map((item) => {
        const content = item.content as Message['content']
        const { text, files } = splitMessage(typeof content === 'string' ? [{ type: 'text', text: content }] : content)
        const words = text.trim().split('\n')[0] || (files.length === 1 ? files[0]!.name : `${files.length} files`)
        return (
          <div key={String(item.id)} className="queued-row">
            <ListIcon size={13} aria-hidden />
            <span className="queued-row__text" title={text}>{words}</span>
            <span className="queued-row__when">{item.mode === 'steer' ? 'Steers after this step' : item === firstFollowUp ? 'Queued · next' : 'Queued'}</span>
            {item.mode === 'followUp' && (
              <IconButton label="Send now" className="queued-row__action queued-row__now" onClick={() => act('thread.steer', String(item.id))}>
                <ArrowElbowRightIcon size={12} aria-hidden />
              </IconButton>
            )}
            <IconButton label="Take back" className="queued-row__action queued-row__remove" onClick={() => act('thread.withdraw', String(item.id))}>
              <XIcon size={11} aria-hidden />
            </IconButton>
          </div>
        )
      })}
    </div>
  )
}

/** A thread's composer, docked under its transcript; `onJump`, offered while scrolled away from the end, goes back down. */
export function ComposerView({ machine, thread, busy, inbox, onJump }: { machine: MachineEntry; thread: ThreadInfo; busy: boolean; inbox: InboxState | undefined; onJump?: () => void }) {
  const { openSettings: onOpenSettings } = useShell()
  const dispatch = useRegistry().router.dispatch
  const [claims, setClaims] = useState<ComposerClaim[]>([])
  const register = useMemo(() => (claim: ComposerClaim) => {
    setClaims((list) => [...list, claim])
    return () => setClaims((list) => list.filter((c) => c !== claim))
  }, [])
  const claim = claims.at(-1)
  // A draft per thread, kept until it's sent: switching threads or reloading doesn't lose it.
  const [text, setText] = useLocalState(`draft.${machine.id}.${thread.id}`, '', { shared: true })
  const [error, setError] = useState<{ kind?: string; message: string }>()
  const input = useRef<HTMLTextAreaElement>(null)
  // Archived, it can be read, not written to, until it's brought back (the Unarchive button where Send would be).
  const archived = Boolean(thread.archived)
  const disabled = machine.state !== 'connected' || archived
  useEffect(() => { input.current?.focus() }, [thread.id])
  // Files going with the next message: picked, dropped on the composer or pasted into it.
  const [files, setFiles] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  useEffect(() => { setFiles([]) }, [thread.id])
  const attach = async (list: FileList | File[]) => {
    try {
      const read = await Promise.all([...list].map(readAttachment))
      setFiles((was) => [...was, ...read])
      setError(undefined)
    } catch (e) { setError({ message: (e as Error).message }) }
  }

  // While the agent works, ⏎ steers it (the message joins the running work after its current step) and ⌃⏎ queues
  // the message for when it's done.
  // Completing a word as it's typed, as extensions offer (`$co` → a skill, see composer.ts): ↑↓ pick, ⇥ or ⏎ takes
  // one, esc leaves the word as typed.
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<number>()
  const found = claim ? undefined : completing(completionsIn(registry, { machine: machine.id, thread }), text, caret)
  const word = found?.word
  // What the provider offered for the word, kept while it's asked again as the word grows (see menuFor).
  const [offered, setOffered] = useState<Offered>()
  useEffect(() => {
    if (!found) return setOffered(undefined)
    return askFor(found, { machine, thread }, setOffered)
  }, [found?.provider, JSON.stringify(word), machine.id, thread.id])
  const menu = menuFor(found, offered, dismissed)
  useEffect(() => { setPick(0) }, [word?.query, word?.start])
  useEffect(() => { if (!word) setDismissed(undefined) }, [word === undefined])
  // What an extension above offers, picked from with ←/→ while the box is empty, and what it puts in.
  const [offers, setOffers] = useState<{ messages: string[]; picked: number }>({ messages: [], picked: 0 })
  const offering = !claim && !text && !busy && offers.messages.length > 0
  const suggested = offering ? offers.messages[offers.picked] : undefined
  const suggest = useCallback((messages: string[] | undefined) => setOffers({ messages: messages ?? [], picked: 0 }), [])
  const composer = useMemo<Composer>(() => ({
    text,
    fill(next) {
      setText(next)
      setCaret(next.length)
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.length, next.length) })
    },
    suggest,
    picked: offering ? offers.picked : undefined,
  }), [text, setText, suggest, offering, offers.picked])
  const take = (item: Completion) => {
    if (!word) return
    const next = complete(text, caret, word.start, item.insert)
    setText(next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => { input.current?.setSelectionRange(next.caret, next.caret); input.current?.focus() })
  }

  /** Send what the box holds (`typed`: a suggestion picked instead). */
  const send = async (whenBusy: 'steer' | 'followUp' = 'steer', typed?: string) => {
    // What the box holds now: a keypress straight after typing can come before the typing's render.
    const value = (typed ?? input.current?.value ?? text).trim()
    const sending = claim ? [] : files
    if (!value && !sending.length) return
    setText('')
    setFiles([])
    setError(undefined)
    try {
      if (claim) { await claim.submit(value); return }
      await dispatch('thread.send', {
        thread: thread.id, text: value, ...(sending.length ? { attachments: sending } : {}), requestId: crypto.randomUUID(), ...(busy ? { whenBusy } : {}),
      }, { machine: machine.id, source: 'composer' })
    } catch (error) {
      setText(value)
      setFiles(sending)
      setError(error as { kind?: string; message: string })
    }
  }
  // ⌃1–⌃9 send that offer, wherever the focus is in this thread's view (its column and the panes beside it).
  const sendRef = useRef(send)
  sendRef.current = send
  const numbered = offering ? offers.messages : undefined
  useEffect(() => {
    if (!numbered) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      const digit = ctrlDigit(event)
      const message = digit === undefined ? undefined : numbered[digit - 1]
      if (!message || event.defaultPrevented || event.repeat) return
      const view = input.current?.closest('.panes') ?? input.current?.closest('.thread')
      if (event.target !== document.body && !(event.target instanceof Node && view?.contains(event.target))) return
      event.preventDefault()
      void sendRef.current('steer', message)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [numbered])
  const abort = () => dispatch('thread.stop', { thread: thread.id }, { machine: machine.id, source: 'composer' })
  /** A project's profile the thread runs, changed (or found where its own moved): allowed as it is now, then sent. */
  const allowAndSend = async (name: string) => {
    try {
      await dispatch('profile.allow', { cwd: thread.cwd, name }, { machine: machine.id, source: 'composer' })
      await send()
    } catch (e) { setError(e as { kind?: string; message: string }) }
  }
  const sendable = Boolean(text.trim()) || (!claim && files.length > 0)
  const onKeyDown = (event: KeyboardEvent) => {
    if (claim?.keyDown?.(event, text)) { event.preventDefault(); return }
    if (menu && word && !event.metaKey && !event.altKey && !event.ctrlKey) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setPick((pick + (event.key === 'ArrowDown' ? 1 : -1) + menu.length) % menu.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); take(menu[pick] ?? menu[0]!); return }
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(word.start); return }
    }
    if (suggested && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const by = event.key === 'ArrowRight' ? 1 : -1
        setOffers((o) => ({ ...o, picked: (o.picked + by + o.messages.length) % o.messages.length }))
        return
      }
      if (event.key === 'Tab') { event.preventDefault(); composer.fill(suggested); return }
      if (event.key === 'Enter') { event.preventDefault(); void send('steer', suggested); return }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event.ctrlKey ? 'followUp' : 'steer') }
    if (event.key === 'Escape' && busy) { event.preventDefault(); void abort() }
    // Esc otherwise leaves the prompt for the thread above it: to read, and scroll from the keyboard.
    else if (event.key === 'Escape') { event.preventDefault(); transcriptOf(event.currentTarget)?.focus({ preventScroll: true, focusVisible: true }) }
  }
  return (
    <ClaimContext.Provider value={register}>
    <ComposerContext.Provider value={composer}>
    <div className={`dock ${dragging ? 'is-dropping' : ''}`}
      onDragOver={(e) => { if (!claim && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={(e) => { setDragging(false); if (!claim && e.dataTransfer.files.length) { e.preventDefault(); void attach(e.dataTransfer.files) } }}>
    {/* Over the box: back to the end, when you've scrolled away from it. */}
    <div className="dock__bar">
      {onJump && (
        <Button className="dock__pill dock__jump" onClick={onJump}>
          <ArrowDownIcon size={13} aria-hidden />
          Jump to bottom
        </Button>
      )}
    </div>
    {!archived && <Queued machine={machine} thread={thread} inbox={inbox} />}
    <div className="dock__above"><Slot name="composer.above" props={{ machine, thread }} /></div>
    <div className="dock__box">
    {files.length > 0 && !claim && (
      <div className="composer__files">
        {files.map((file, index) => (
          <span key={`${file.name}-${index}`} className="attachment">
            {file.mimeType.startsWith('image/') ? <img src={`data:${file.mimeType};base64,${file.data}`} alt="" /> : <span className="attachment__icon"><FileIcon size={14} aria-hidden /></span>}
            <span className="attachment__name">{file.name}</span>
            <button className="attachment__remove" aria-label={`Remove ${file.name}`} onClick={() => setFiles((was) => was.filter((_, i) => i !== index))}>×</button>
          </span>
        ))}
      </div>
    )}
    {error && (
      <div className="composer__error">
        {error.kind === 'no_model' ? <>No model is set up on {machine.label}. <Button onClick={onOpenSettings}>Open Settings</Button></>
          // Its profile gone from under it: another picked for it.
          : error.kind === 'profile_missing' ? <ProfileSwitch machine={machine.id} thread={thread} onSwitched={() => void send()} />
          : error.kind === 'profile_not_allowed' && thread.profile ? <>{error.message} <Button onClick={() => void allowAndSend(thread.profile!.name)}>Allow and send</Button></>
          : error.message}
      </div>
    )}
    {menu && (
      <div className="completions" role="listbox" aria-label={found!.provider.title}>
        {menu.map((item, index) => (
          <div key={`${item.label}-${index}`} role="option" aria-selected={index === pick} className={`completions__item ${index === pick ? 'is-active' : ''}`}
            onMouseEnter={() => setPick(index)} onMouseDown={(e) => { e.preventDefault(); take(item) }}>
            <span className="completions__label">{item.label}</span>
            {item.detail && <span className="completions__detail">{item.detail}</span>}
          </div>
        ))}
      </div>
    )}
    {/* The box holds the words and one button at their end: Send, Steer or Answer, one key, ⏎ (Unarchive, archived). */}
    <div className="composer">
      <TextArea ref={input} rows={1} value={text} disabled={disabled} onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart) }} onKeyDown={onKeyDown}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={(e) => { if (!claim && e.clipboardData.files.length) { e.preventDefault(); void attach(e.clipboardData.files) } }}
        placeholder={archived ? 'Archived: read only' : disabled ? `${machine.label} is ${machine.state}` : claim ? claim.placeholder : busy ? 'Steer the agent…' : suggested ? `${suggested}  ⏎` : 'Reply…'} />
      {archived
        ? <UnarchiveButton machine={machine} thread={thread} className="composer__unarchive" />
        : busy && !claim
          ? sendable && (
            <Button variant="primary" className="composer__steer" title="Steer (⏎)" disabled={disabled} onClick={() => void send()}>
              <ArrowElbowRightIcon size={13} weight="bold" aria-hidden />Steer
            </Button>
          )
          : (
            <IconButton label={`${claim ? 'Answer' : 'Send'} (⏎)`} aria-label={claim ? 'Answer' : 'Send'} className="composer__send" disabled={disabled || !sendable} onClick={() => void send()}>
              <ArrowUpIcon size={15} weight="bold" aria-hidden />
            </IconButton>
          )}
    </div>
    </div>
    {/* Under the box, quietly: attach at the left; while the agent works, Queue and Stop at the right. */}
    {!archived && (
      <div className="dock__footer">
        {!claim && (
          <>
            <Button variant="ghost" className="dock__action composer__attach" disabled={disabled} onClick={() => picker.current?.click()}>
              <PaperclipIcon size={13} aria-hidden />Attach
            </Button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void attach(e.target.files); e.target.value = '' }} />
          </>
        )}
        <span className="dock__footer-end">
          {busy && !claim && sendable && (
            <Button variant="ghost" className="dock__action composer__queue" disabled={disabled} onClick={() => void send('followUp')}>
              <ListIcon size={13} aria-hidden />Queue<kbd>⌃⏎</kbd>
            </Button>
          )}
          {busy && (
            <Button variant="ghost" className="dock__action composer__stop" onClick={() => void abort()}>
              <span className="composer__stop-mark" aria-hidden />Stop<kbd>esc</kbd>
            </Button>
          )}
        </span>
      </div>
    )}
    </div>
    </ComposerContext.Provider>
    </ClaimContext.Provider>
  )
}

