import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ConversationView, EntryRecord, LiveState } from '@earendil-works/pi-durable'
import type { SessionInfo } from '@mu/protocol'
import { Button, StatusGlyph, statusLabel, TextArea } from '@mu/ui'
import type { MachineEntry } from '../shared.ts'
import { machine as client, useSessionView } from './client.ts'
import { Slot, useRegistry, type ToolCallProps } from './extension.tsx'
import { useShell } from './state.tsx'

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }
type Message = { role: string; content: string | Block[]; toolCallId?: string; isError?: boolean; details?: unknown }

/** The session a transcript belongs to, for extension renderers. */
const Here = createContext<{ machine: MachineEntry; session: SessionInfo }>(undefined as never)

const blocks = (message: Message | undefined): Block[] =>
  !message ? [] : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
const textOf = (message: Message | undefined) => blocks(message).map((b) => b.text ?? '').join('')

export function SessionView({ machine, session }: { machine: MachineEntry; session: SessionInfo }) {
  const view = useSessionView(machine.id, machine.state === 'connected', session.id)
  const live = view?.docs['pi.live'] as LiveState | undefined
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [view])

  return (
    <Here.Provider value={{ machine, session }}>
    <div className="session">
      <header className="session__header">
        <StatusGlyph status={session.status} />
        <span className="session__title">{session.title}</span>
        <span className="session__meta">{machine.label} · {session.cwd} · {statusLabel(session.status)}</span>
        <span className="session__slot"><Slot name="session.header" props={{ machine, session }} /></span>
      </header>
      <div className="session__scroll" ref={scroller}
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
        {view ? <Transcript view={view} live={live} /> : <div className="app__empty">Loading…</div>}
      </div>
      <div className="session__above"><Slot name="composer.above" props={{ machine, session }} /></div>
      <Composer machine={machine} session={session} busy={Boolean(live?.run)} />
    </div>
    </Here.Provider>
  )
}

function Transcript({ view, live }: { view: ConversationView; live: LiveState | undefined }) {
  // Tool results render inside the call that asked for them.
  const results = useMemo(() => {
    const map = new Map<string, Message>()
    for (const entry of view.entries) {
      const message = entry.model?.[0] as Message | undefined
      if (message?.role === 'toolResult' && message.toolCallId) map.set(message.toolCallId, message)
    }
    return map
  }, [view.entries])
  const running = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]))
  const partial = live?.generation?.message as Message | undefined

  return (
    <div className="transcript">
      {view.before !== undefined && <div className="transcript__more">Earlier messages not loaded</div>}
      {view.entries.map((entry) => <Entry key={entry.id} entry={entry} results={results} running={running} />)}
      {partial && <Assistant message={partial} results={results} running={running} streaming />}
      {live?.run && !partial && <div className="transcript__thinking">working…</div>}
      {live?.runFailure && !live.run && live.runFailure.reason !== 'aborted' && (
        <div className="transcript__error">Run failed: {live.runFailure.reason}{live.runFailure.detail ? ` — ${live.runFailure.detail}` : ''}</div>
      )}
    </div>
  )
}

type Slots = Map<string, NonNullable<LiveState['tools']>[number]>

function Entry({ entry, results, running }: { entry: EntryRecord; results: Map<string, Message>; running: Slots }) {
  const custom = useRegistry().entries.get(entry.kind)
  const here = useContext(Here)
  if (custom) { const Custom = custom; return <Custom {...here} entry={{ id: entry.id, kind: entry.kind, data: entry.data }} /> }
  const message = entry.model?.[0] as Message | undefined
  if (message?.role === 'user') return <div className="msg msg--user">{textOf(message)}</div>
  if (message?.role === 'assistant') return <Assistant message={message} results={results} running={running} />
  if (message?.role === 'toolResult') return null
  if (entry.kind === 'pi.system') return null
  return <div className="msg msg--note">{entry.kind}</div>
}

function Assistant({ message, results, running, streaming }: { message: Message; results: Map<string, Message>; running: Slots; streaming?: boolean }) {
  return (
    <div className={`msg msg--assistant ${streaming ? 'is-streaming' : ''}`}>
      {blocks(message).map((block, index) => {
        if (block.type === 'text') return <div key={index} className="msg__text">{block.text}</div>
        if (block.type === 'thinking') return block.thinking ? <details key={index} className="msg__thinking"><summary>thinking</summary>{block.thinking}</details> : null
        if (block.type === 'toolCall') return <ToolCall key={index} block={block} result={results.get(block.id!)} slot={running.get(block.id!)} />
        return null
      })}
    </div>
  )
}

function ToolCall({ block, result, slot }: { block: Block; result: Message | undefined; slot: ReturnType<Slots['get']> }) {
  const custom = useRegistry().tools.get(block.name ?? '')
  const here = useContext(Here)
  if (custom) {
    const Custom = custom
    const props: ToolCallProps = {
      ...here,
      call: { id: block.id ?? '', name: block.name ?? '', arguments: (block.arguments ?? {}) as Record<string, unknown> },
      ...(result ? { result: { text: textOf(result), isError: Boolean(result.isError), details: result.details } } : {}),
      ...(slot ? { live: { status: slot.status, ...(slot.output !== undefined ? { output: slot.output } : {}), details: slot.details } } : {}),
    }
    return <Custom {...props} />
  }
  const args = block.arguments as Record<string, unknown> | undefined
  const summary = typeof args?.command === 'string' ? args.command : typeof args?.path === 'string' ? args.path : JSON.stringify(args ?? {})
  const output = result ? textOf(result) : slot?.output
  const state = result ? (result.isError ? 'error' : 'done') : slot?.status === 'running' ? 'working' : 'idle'
  return (
    <details className={`tool tool--${state}`}>
      <summary><StatusGlyph status={{ state }} /> <b>{block.name}</b> <span className="tool__summary">{summary}</span></summary>
      {output && <pre className="tool__output">{output}</pre>}
    </details>
  )
}

function Composer({ machine, session, busy }: { machine: MachineEntry; session: SessionInfo; busy: boolean }) {
  const { openSettings: onOpenSettings } = useShell()
  const [text, setText] = useState('')
  const [error, setError] = useState<{ kind?: string; message: string }>()
  const input = useRef<HTMLTextAreaElement>(null)
  const disabled = machine.state !== 'connected'
  useEffect(() => { input.current?.focus() }, [session.id])

  const send = async () => {
    const value = text.trim()
    if (!value) return
    setText('')
    setError(undefined)
    try {
      await client(machine.id).call('session.submit', { id: session.id, text: value, requestId: crypto.randomUUID(), ...(busy ? { whenBusy: 'steer' as const } : {}) })
    } catch (error) {
      setText(value)
      setError(error as { kind?: string; message: string })
    }
  }
  const abort = () => client(machine.id).call('session.abort', { id: session.id })
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
    if (event.key === 'Escape' && busy) { event.preventDefault(); void abort() }
  }
  return (
    <>
    {error && (
      <div className="composer__error">
        {error.kind === 'no_model' ? <>No model is set up on {machine.label}. <Button onClick={onOpenSettings}>Open Settings</Button></> : error.message}
      </div>
    )}
    <div className="composer">
      <TextArea ref={input} rows={1} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
        placeholder={disabled ? `${machine.label} is ${machine.state}` : busy ? 'Steer the running agent… (Esc to stop)' : 'Ask anything'} />
      <div className="composer__actions">
        {busy && <Button onClick={() => void abort()}>Stop</Button>}
        <Button variant="primary" disabled={disabled || !text.trim()} onClick={() => void send()}>{busy ? 'Steer' : 'Send'}</Button>
      </div>
    </div>
    </>
  )
}
