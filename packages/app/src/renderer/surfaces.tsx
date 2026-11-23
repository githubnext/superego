// Surfaces: views that fill the window's main area where a thread otherwise shows (an app extension's or a global
// profile's `superego.surface`: a notes page, a canvas), each with the thread docked to it: a column beside it, or a
// card over its right side (`agent: 'floating'`). Which thread is docked to which surface is the window's (state.tsx);
// with none, the column asks what to start one with.
import { useState, type CSSProperties } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { ArrowSquareOutIcon, Button, ChatCircleIcon, IconButton, StatusGlyph, TextArea, XIcon } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import type { SurfaceKind } from './extension-api.ts'
import type { SurfaceAt } from './history.ts'
import { machine as client } from './client.ts'
import { Contained } from './contained.tsx'
import { useProfileUi } from './profile-ui.ts'
import { scopeOfEntry, useRegistry, whose, type Owned } from './registry.tsx'
import { useAllThreads, useMachines, useSelection, useSurface } from './state.tsx'
import { ThreadBody } from './thread-body.tsx'

type Surface = Owned<SurfaceKind & { kind: string }>

/** What a floating thread covers of a surface's right side: its width (340px) and its 12px off the edge (app.css). */
const FLOATING_COVERS = 352

/** The surface of `kind` this window has, if any. */
export const useSurfaceKind = (kind: string | undefined): Surface | undefined => {
  const registry = useRegistry()
  return kind ? registry.surfaces.find((s) => s.kind === kind) : undefined
}

/** What a surface is called where it's shown (the title bar, history): its kind's title for its params. */
export function surfaceTitle(kind: Surface | undefined, at: SurfaceAt): string {
  if (!kind) return at.kind
  try { return typeof kind.title === 'function' ? kind.title(at.params) : kind.title } catch (error) {
    console.error(`Surface ${at.kind}: its title failed`, error)
    return at.kind
  }
}

/** The surface open in the main area, and its thread beside it (not on a phone: there it opens as the thread). */
export function SurfaceMain({ at, narrow }: { at: SurfaceAt; narrow: boolean }) {
  const kind = useSurfaceKind(at.kind)
  const machine = useMachines().find((m) => m.id === at.machine)
  const { docked, dock, open, agentShown } = useSurface()
  const threads = useAllThreads()
  const thread = docked && threads[docked.machine]?.find((t) => t.id === docked.thread)
  if (!kind) return <div className="app__empty">Nothing in this window opens {at.kind}.</div>
  if (!machine) return <div className="app__empty">{at.machine} isn't one of this window's machines.</div>
  const Component = kind.component
  const floating = kind.agent === 'floating'
  // A floating card covers the surface's right side by its width and the room right of it (app.css).
  const right = floating && agentShown && !narrow ? FLOATING_COVERS : 0
  return (
    <div className={`surface ${floating ? 'is-floating' : 'is-docked'}`} data-surface={at.kind}>
      <div className="surface__body" style={{ '--surface-inset-right': `${right}px` } as CSSProperties}>
        <Contained name={whose(kind)} scope={scopeOfEntry(kind)}>
          <Component machine={machine} kind={at.kind} params={at.params} thread={thread} open={(params) => open({ ...at, params })} inset={{ right }} />
        </Contained>
      </div>
      {agentShown && !narrow && (
        <aside className="surface__agent" aria-label="The surface's thread">
          {thread
            ? <DockedThread machine={machine} thread={thread} undock={() => dock(undefined)} />
            : <AskAbout machine={machine} at={at} kind={kind} started={(t) => dock({ machine: machine.id, thread: t.id })} />}
        </aside>
      )}
    </div>
  )
}

/** In the title bar while a surface is open: its title, and the button that shows or hides its thread. */
export function SurfaceTitle({ at, narrow }: { at: SurfaceAt; narrow: boolean }) {
  const kind = useSurfaceKind(at.kind)
  const { agentShown, showAgent, docked } = useSurface()
  const { select } = useSelection()
  const Icon = kind?.icon
  return (
    <span className="titlebar__crumb">
      <span className="titlebar__seg titlebar__title">
        {Icon && <Icon size={14} aria-hidden />}
        <span className="thread__title">{surfaceTitle(kind, at)}</span>
        <span className="titlebar__actions">
          {narrow
            ? docked && <IconButton label="Open its thread" className="titlebar__action" onClick={() => select(docked)}><ChatCircleIcon size={14} aria-hidden /></IconButton>
            : <IconButton label={agentShown ? 'Hide its thread' : 'Show its thread'} className={`titlebar__action ${agentShown ? 'is-on' : ''}`} onClick={() => showAgent()}><ChatCircleIcon size={14} aria-hidden /></IconButton>}
        </span>
      </span>
    </span>
  )
}

/** The thread docked to a surface: its head (open it as the thread, undock it), its transcript and composer. */
function DockedThread({ machine, thread, undock }: { machine: MachineEntry; thread: ThreadInfo; undock(): void }) {
  // Its profile's UI (tool rows, slots) draws here as in the thread.
  useProfileUi(machine.id, thread)
  const { select } = useSelection()
  return (
    <>
      <header className="surface__agent-head">
        <StatusGlyph status={thread.status} quiet={thread.quiet} />
        <span className="surface__agent-title" title={thread.title}>{thread.title}</span>
        <IconButton label="Open as thread" onClick={() => select({ machine: machine.id, thread: thread.id })}><ArrowSquareOutIcon size={14} aria-hidden /></IconButton>
        <IconButton label="Undock" onClick={undock}><XIcon size={14} aria-hidden /></IconButton>
      </header>
      <div className="surface__agent-body"><ThreadBody machine={machine} thread={thread} /></div>
    </>
  )
}

/** No thread docked yet: what to ask, which starts one (on the surface's profile, told what's open first) and docks it. */
function AskAbout({ machine, at, kind, started }: { machine: MachineEntry; at: SurfaceAt; kind: Surface; started(thread: ThreadInfo): void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const send = async () => {
    const asked = text.trim()
    if (!asked || busy) return
    let about: string | undefined
    try { about = kind.about?.(at.params) } catch (error) { console.error(`Surface ${at.kind}: its about failed`, error) }
    setBusy(true)
    setError(undefined)
    try {
      const thread = await client(machine.id).call('thread.start', {
        title: surfaceTitle(kind, at),
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
    <div className="surface__ask">
      <header className="surface__agent-head"><ChatCircleIcon size={14} aria-hidden /><span className="surface__agent-title">Ask about this</span></header>
      <div className="surface__ask-body">
        <TextArea value={text} placeholder={`Ask${kind.profile ? ` ${kind.profile}` : ''}…`} rows={3} disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
        <Button onClick={() => void send()} disabled={!text.trim() || busy}>{busy ? 'Starting…' : 'Ask'}</Button>
        {error && <p className="surface__error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
