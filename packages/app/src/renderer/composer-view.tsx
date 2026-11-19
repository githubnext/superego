// A thread's composer: what you type (a draft per thread) in the box (composer-box.tsx: files to send with it,
// completions extensions offer), and what you sent while the agent was busy, waiting its turn. What's drawn above it
// can take what's typed (`useComposerClaim`) or put words in it (`useComposer`).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { InboxState } from '@earendil-works/pi-durable'
import type { Attachment, ThreadInfo } from '@superego/protocol'
import { autoFocusOnOpen, ArrowDownIcon, ArrowElbowRightIcon, ArrowUpIcon, Button, IconButton, ListIcon, XIcon } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { useRegistry } from './registry.tsx'
import { sentWithIn } from './lookups.ts'
import { Slot } from './placement.tsx'
import { useShell } from './state.tsx'
import { ctrlDigit } from '../shared/shortcuts.ts'
import { useLocalState } from './local-state.ts'
import { splitMessage } from './attachments.ts'
import { readSent } from './composer.ts'
import { ComposerBox } from './composer-box.tsx'
import { onGivenBack, takeBack } from './returned.ts'
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
  useEffect(() => { if (autoFocusOnOpen()) input.current?.focus() }, [thread.id])
  // Files going with the next message: picked, dropped on the composer or pasted into it.
  const [files, setFiles] = useState<Attachment[]>([])
  useEffect(() => { setFiles([]) }, [thread.id])
  // Messages you'd queued, given back as the thread was stopped from this window: after what's typed, each its own
  // paragraph, in order, their files with them. Their words as the transcript shows them: without what extensions
  // put in (a skill named) or the files' tags.
  const registry = useRegistry()
  useEffect(() => {
    const take = () => {
      const returned = takeBack(machine.id, thread.id)
      if (!returned.length) return
      const readers = sentWithIn(registry, { machine: machine.id, thread })
      const words = returned.map(({ content }) => {
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
        return splitMessage(readSent(readers, blocks).rest).text.trim()
      })
      setText((typed) => [typed.trim() ? typed.trimEnd() : '', ...words].filter(Boolean).join('\n\n'))
      setFiles((was) => [...was, ...returned.flatMap((message) => message.attachments)])
      const gone = returned.flatMap((message) => message.gone ?? [])
      if (gone.length) setError({ message: `Couldn't bring back ${gone.join(', ')}: ${gone.length === 1 ? 'it was' : 'they were'} sent with a message you'd queued.` })
    }
    take()
    return onGivenBack(take)
  }, [machine.id, thread.id])

  // While the agent works, ⏎ steers it (the message joins the running work after its current step) and ⌃⏎ queues
  // the message for when it's done.
  // What an extension above offers, picked from with ←/→ while the box is empty, and what it puts in.
  const [offers, setOffers] = useState<{ messages: string[]; picked: number }>({ messages: [], picked: 0 })
  const offering = !claim && !text && !busy && offers.messages.length > 0
  const suggested = offering ? offers.messages[offers.picked] : undefined
  const suggest = useCallback((messages: string[] | undefined) => setOffers({ messages: messages ?? [], picked: 0 }), [])
  const composer = useMemo<Composer>(() => ({
    text,
    fill(next) {
      setText(next)
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.length, next.length) })
    },
    suggest,
    picked: offering ? offers.picked : undefined,
  }), [text, setText, suggest, offering, offers.picked])

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
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (claim?.keyDown?.(event, text)) { event.preventDefault(); return }
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
    {/* The box holds the words and one button at their end: Send, Steer or Answer, one key, ⏎ (Unarchive, archived). */}
    <ComposerBox className="dock" where={{ machine, cwd: thread.cwd, thread }} text={text} setText={setText} files={files} setFiles={setFiles}
      open={!claim} disabled={disabled} inputRef={input} onKeyDown={onKeyDown}
      onError={(message) => setError({ message })}
      placeholder={archived ? 'Archived: read only' : disabled ? `${machine.label} is ${machine.state}` : claim ? claim.placeholder : busy ? 'Steer the agent…' : suggested ? `${suggested}  ⏎` : 'Reply…'}
      error={error && (
        error.kind === 'no_model' ? <>No model is set up on {machine.label}. <Button onClick={onOpenSettings}>Open Settings</Button></>
          // Its profile gone from under it: another picked for it.
          : error.kind === 'profile_missing' ? <ProfileSwitch machine={machine.id} thread={thread} onSwitched={() => void send()} />
          : error.kind === 'profile_not_allowed' && thread.profile ? <>{error.message} <Button onClick={() => void allowAndSend(thread.profile!.name)}>Allow and send</Button></>
          : error.message
      )}
      action={archived
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
      // Under the box, quietly: attach at the left; while the agent works, Queue and Stop at the right.
      footer={!archived && {
        end: <>
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
        </>,
      }}>
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
    </ComposerBox>
    </ComposerContext.Provider>
    </ClaimContext.Provider>
  )
}
