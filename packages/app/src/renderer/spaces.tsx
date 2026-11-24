// Spaces: views that fill the window's main area where a thread otherwise shows (an app extension's or a global
// profile's `superego.space`: a notes page, a canvas), each with the thread docked to it: a column beside it, or a
// card over its right side (`agent: 'floating'`). Which thread is docked to which space is the window's (state.tsx);
// with none, the column asks what to start one with.
import { createContext, useContext, useEffect, useState, type CSSProperties } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { ArrowSquareOutIcon, Button, ChatCircleIcon, IconButton, StatusGlyph, TextArea, XIcon } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import type { SpaceKind } from './extension-api.ts'
import type { SpaceAt } from './history.ts'
import { machine as client } from './client.ts'
import { Contained } from './contained.tsx'
import { useProfileUi } from './profile-ui.ts'
import { scopeOfEntry, useRegistry, whose, type Owned } from './registry.tsx'
import { useAllThreads, useMachines, useSelection, useSpace } from './state.tsx'
import { ThreadBody } from './thread-body.tsx'

type Space = Owned<SpaceKind & { kind: string }>

/** What a floating thread covers of a space's right side: its width (340px) and its 12px off the edge (app.css). */
const FLOATING_COVERS = 352

/** The space of `kind` this window has, if any. */
export const useSpaceKind = (kind: string | undefined): Space | undefined => {
  const registry = useRegistry()
  return kind ? registry.spaces.find((s) => s.kind === kind) : undefined
}

/** The space a component draws in, for `useSpaceTitle`. */
const Drawing = createContext<SpaceAt | undefined>(undefined)

/**
 * In a space's component: what it's called now (a note's heading, say), for the title bar and the thread docked to
 * it; remembered for when it opens again. Until it says, its kind's `title(params)`. Elsewhere, nothing.
 */
export function useSpaceTitle(title: string | undefined) {
  const at = useContext(Drawing)
  const { setTitle } = useSpace()
  const trimmed = title?.trim() || undefined
  useEffect(() => { if (at) setTitle(at, trimmed) }, [at && JSON.stringify(at), trimmed])
}

/** What a space is called where it's shown: what it said (`useSpaceTitle`), else its kind's title for its params. */
export function useTitleOf(at: SpaceAt): string {
  const kind = useSpaceKind(at.kind)
  return useSpace().titleOf(at) ?? spaceTitle(kind, at)
}

/** Its kind's title for its params. */
export function spaceTitle(kind: Space | undefined, at: SpaceAt): string {
  if (!kind) return at.kind
  try { return typeof kind.title === 'function' ? kind.title(at.params) : kind.title } catch (error) {
    console.error(`Space ${at.kind}: its title failed`, error)
    return at.kind
  }
}

/** The space open in the main area, and its thread beside it (not on a phone: there it opens as the thread). */
export function SpaceMain({ at, narrow }: { at: SpaceAt; narrow: boolean }) {
  const kind = useSpaceKind(at.kind)
  const machine = useMachines().find((m) => m.id === at.machine)
  const { docked, dock, open, agentShown } = useSpace()
  const threads = useAllThreads()
  const thread = docked && threads[docked.machine]?.find((t) => t.id === docked.thread)
  if (!kind) return <div className="app__empty">Nothing in this window opens {at.kind}.</div>
  if (!machine) return <div className="app__empty">{at.machine} isn't one of this window's machines.</div>
  const Component = kind.component
  const floating = kind.agent === 'floating'
  // A floating card covers the space's right side by its width and the room right of it (app.css).
  const right = floating && agentShown && !narrow ? FLOATING_COVERS : 0
  return (
    <div className={`space ${floating ? 'is-floating' : 'is-docked'}`} data-space={at.kind}>
      <div className="space__body" style={{ '--space-inset-right': `${right}px` } as CSSProperties}>
        <Contained name={whose(kind)} scope={scopeOfEntry(kind)}>
          <Drawing.Provider value={at}><Component machine={machine} kind={at.kind} params={at.params} thread={thread} open={(params) => open({ ...at, params })} inset={{ right }} /></Drawing.Provider>
        </Contained>
      </div>
      {agentShown && !narrow && (
        <aside className="space__agent" aria-label="The space's thread">
          {thread
            ? <DockedThread machine={machine} thread={thread} undock={() => dock(undefined)} />
            : <AskAbout machine={machine} at={at} kind={kind} started={(t) => dock({ machine: machine.id, thread: t.id })} />}
        </aside>
      )}
    </div>
  )
}

/** In the title bar while a space is open: its title, and the button that shows or hides its thread. */
export function SpaceTitle({ at, narrow }: { at: SpaceAt; narrow: boolean }) {
  const kind = useSpaceKind(at.kind)
  const { agentShown, showAgent, docked } = useSpace()
  const { select } = useSelection()
  const Icon = kind?.icon
  const title = useTitleOf(at)
  return (
    <span className="titlebar__crumb">
      <span className="titlebar__seg titlebar__title">
        {Icon && <Icon size={14} aria-hidden />}
        <span className="thread__title">{title}</span>
        <span className="titlebar__actions">
          {narrow
            ? docked && <IconButton label="Open its thread" className="titlebar__action" onClick={() => select(docked)}><ChatCircleIcon size={14} aria-hidden /></IconButton>
            : <IconButton label={agentShown ? 'Hide its thread' : 'Show its thread'} className={`titlebar__action ${agentShown ? 'is-on' : ''}`} onClick={() => showAgent()}><ChatCircleIcon size={14} aria-hidden /></IconButton>}
        </span>
      </span>
    </span>
  )
}

/** The thread docked to a space: its head (open it as the thread, undock it), its transcript and composer. */
function DockedThread({ machine, thread, undock }: { machine: MachineEntry; thread: ThreadInfo; undock(): void }) {
  // Its profile's UI (tool rows, slots) draws here as in the thread.
  useProfileUi(machine.id, thread)
  const { select } = useSelection()
  return (
    <>
      <header className="space__agent-head">
        <StatusGlyph status={thread.status} quiet={thread.quiet} />
        <span className="space__agent-title" title={thread.title}>{thread.title}</span>
        <IconButton label="Open as thread" onClick={() => select({ machine: machine.id, thread: thread.id })}><ArrowSquareOutIcon size={14} aria-hidden /></IconButton>
        <IconButton label="Undock" onClick={undock}><XIcon size={14} aria-hidden /></IconButton>
      </header>
      <div className="space__agent-body"><ThreadBody machine={machine} thread={thread} /></div>
    </>
  )
}

/** No thread docked yet: what to ask, which starts one (on the space's profile, told what's open first) and docks it. */
function AskAbout({ machine, at, kind, started }: { machine: MachineEntry; at: SpaceAt; kind: Space; started(thread: ThreadInfo): void }) {
  const [text, setText] = useState('')
  const title = useTitleOf(at)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const send = async () => {
    const asked = text.trim()
    if (!asked || busy) return
    let about: string | undefined
    try { about = kind.about?.(at.params) } catch (error) { console.error(`Space ${at.kind}: its about failed`, error) }
    setBusy(true)
    setError(undefined)
    try {
      const thread = await client(machine.id).call('thread.start', {
        title,
        prompt: [about, asked].filter(Boolean).join('\n\n'),
        ...(kind.profile ? { profile: kind.profile } : {}),
      })
      setText('')
      started(thread)
    } catch (failure) {
      console.error(`Starting a thread on ${at.kind}`, failure)
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space__ask">
      <header className="space__agent-head"><ChatCircleIcon size={14} aria-hidden /><span className="space__agent-title">Ask about this</span></header>
      <div className="space__ask-body">
        <TextArea value={text} placeholder={`Ask${kind.profile ? ` ${kind.profile}` : ''}…`} rows={3} disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
        <Button onClick={() => void send()} disabled={!text.trim() || busy}>{busy ? 'Starting…' : 'Ask'}</Button>
        {error && <p className="space__error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
