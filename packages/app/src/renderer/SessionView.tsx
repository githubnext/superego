import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ConversationView, EntryRecord, LiveState } from '@earendil-works/pi-durable'
import type { SessionInfo } from '@mu/protocol'
import { Button, IconButton, Menu, StatusGlyph, statusLabel, TextArea } from '@mu/ui'
import type { MachineEntry } from '../shared.ts'
import { machine as client, useSessionView } from './client.ts'
import { fileKind, paneMenu, Slot, useRegistry, type ToolCallProps } from './extension.tsx'
import { useShell } from './state.tsx'
import { Markdown, OpenFile, Scroll } from './Markdown.tsx'
import { useProfileUi } from './profile-ui.ts'
import { SessionPanes } from './panes.tsx'

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }
type Message = { role: string; content: string | Block[]; toolCallId?: string; isError?: boolean; details?: unknown }

/** The session a transcript belongs to, for extension renderers. */
const Here = createContext<{ machine: MachineEntry; session: SessionInfo; firstUser?: number }>(undefined as never)
const firstUser = (here: { firstUser?: number }) => here.firstUser

/** Something above the composer that wants what is typed: an answer to a question, say. The newest claim wins. */
export type ComposerClaim = { placeholder: string; submit(text: string): Promise<unknown> }
const ClaimContext = createContext<(claim: ComposerClaim) => () => void>(() => () => {})

/** While mounted (and given a claim), the composer's text goes to `claim.submit` instead of the session. */
export function useComposerClaim(claim: ComposerClaim | undefined) {
  const register = useContext(ClaimContext)
  const latest = useRef(claim)
  latest.current = claim
  useEffect(() => {
    if (!claim) return
    return register({ get placeholder() { return latest.current?.placeholder ?? '' }, submit: (text) => latest.current!.submit(text) })
  }, [Boolean(claim), register])
}

const blocks = (message: Message | undefined): Block[] =>
  !message ? [] : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
const textOf = (message: Message | undefined) => blocks(message).map((b) => b.text ?? '').join('')

/** A session: its thread, and the panes open beside it. */
export function SessionView({ machine, session }: { machine: MachineEntry; session: SessionInfo }) {
  // The session's profile may bring UI of its own (header, aside, composer, tool renderers, panes).
  useProfileUi(machine.id, session)
  return <SessionPanes machine={machine} session={session} thread={<ThreadView machine={machine} session={session} />} />
}

/** A session's thread: its transcript and composer. Also what a "thread" pane draws. */
export function ThreadView({ machine, session }: { machine: MachineEntry; session: SessionInfo }) {
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  // A file the thread names, opened beside it: in the pane kind that takes it (a profile's, else the editor).
  const sessionRef = useRef(session)
  sessionRef.current = session
  const openFile = useCallback((name: string) => {
    void client(machine.id).call('file.find', { id: session.id, name }).then(({ path }) => {
      if (path) return dispatch('pane.open', { id: session.id, kind: fileKind(registry, sessionRef.current, path), params: { path } }, { machine: machine.id, source: 'thread' })
    }).catch((error) => console.error(error))
  }, [machine.id, session.id, registry])
  const view = useSessionView(machine.id, machine.state === 'connected', session.id)
  const live = view?.docs['pi.live'] as LiveState | undefined
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [view])

  return (
    <OpenFile.Provider value={openFile}>
    <Here.Provider value={{ machine, session, firstUser: view?.before === undefined ? view?.entries.find((e) => (e.model?.[0] as Message | undefined)?.role === 'user')?.id : undefined }}>
    <div className="session">
      <div className="session__scroll" ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          el.parentElement?.classList.toggle('is-scrolled', el.scrollTop > 8)
        }}>
        <div className="session__column">
          <div className="session__crumb">
            <span>{machine.label} · <span title={session.cwd}>{folderName(session.cwd)}</span>{session.profile && <> · <span className="session__profile" title={session.profile.scope === 'project' ? "This project's profile" : 'Your profile'}>{session.profile.name}</span></>} · {statusLabel(session.status)}</span>
            <span className="session__tools">
              <Slot name="session.header" props={{ machine, session }} />
              <PaneMenu machine={machine} session={session} />
              <IconButton label="Archive" className="session__archive" onClick={() => void dispatch('session.archive', { id: session.id }, { machine: machine.id, source: 'header' })}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3.5h12v3H2zM3 6.5v6h10v-6M6.5 9h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>
              </IconButton>
            </span>
          </div>
          <h1 className="session__title">{session.title.replace(/\.$/, '')}</h1>
          {view ? <Transcript view={view} live={live} /> : <div className="transcript__more">Loading…</div>}
        </div>
      </div>
      <Composer machine={machine} session={session} busy={Boolean(live?.run)} />
    </div>
    </Here.Provider>
    </OpenFile.Provider>
  )
}

/** The project folder's own name; home reads as `~`. */
const folderName = (path: string) => { const short = shortPath(path); return short === '~' ? short : short.split('/').filter(Boolean).at(-1) ?? short }

/** A home-relative path: `/Users/me/dev/x` reads as `~/dev/x`. */
export const shortPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')

function Transcript({ view, live }: { view: ConversationView; live: LiveState | undefined }) {
  const here = useContext(Here)
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
  const items = useMemo(() => flatten(view.entries, partial), [view.entries, partial])

  return (
    <div className="transcript">
      {view.before !== undefined && <div className="transcript__more">Earlier messages not loaded</div>}
      {items.map((item, index) => {
        const last = index === items.length - 1
        switch (item.type) {
          case 'entry': return <Entry key={item.key} entry={item.entry} />
          case 'text': return (
            <div key={item.key} className={`msg msg__text ${item.narration ? 'msg__text--narration' : ''} ${item.streaming ? 'is-streaming' : ''}`}><Markdown text={item.text} /></div>
          )
          case 'work': return <Work key={item.key} blocks={item.blocks} results={results} running={running} active={last && Boolean(live?.run)} />
          case 'end': return <TurnEnd key={item.key} blocks={item.blocks} results={results} />
        }
      })}
      {live?.run && !partial && here.session.status.state === 'working' && <div className="transcript__thinking">working…</div>}
      {live?.runFailure && !live.run && live.runFailure.reason !== 'aborted' && (
        <div className="transcript__error">Run failed: {live.runFailure.reason}{live.runFailure.detail ? ` — ${live.runFailure.detail}` : ''}</div>
      )}
    </div>
  )
}

type Slots = Map<string, NonNullable<LiveState['tools']>[number]>

/**
 * What a transcript shows, in order: your messages (and extensions' entries), the agent's text, and runs of work
 * (thinking and tool calls back to back, even across the agent's turns). Text in a turn that goes on to call tools is
 * narration; the text that ends a turn is the answer.
 */
type Item =
  | { type: 'entry'; key: string; entry: EntryRecord }
  | { type: 'text'; key: string; text: string; narration: boolean; streaming?: boolean }
  | { type: 'work'; key: string; blocks: Block[] }
  | { type: 'end'; key: string; blocks: Block[] }

function flatten(entries: readonly EntryRecord[], partial: Message | undefined): Item[] {
  const items: Item[] = []
  const add = (message: Message, key: string, streaming = false) => {
    const list = blocks(message)
    const narration = list.some((b) => b.type === 'toolCall')
    list.forEach((block, index) => {
      const last = items.at(-1)
      if (block.type === 'text') {
        if (block.text?.trim()) items.push({ type: 'text', key: `${key}:${index}`, text: block.text, narration, streaming })
      } else if (block.type === 'toolCall' || (block.type === 'thinking' && block.thinking)) {
        if (last?.type === 'work') last.blocks.push(block)
        else items.push({ type: 'work', key: `${key}:${index}`, blocks: [block] })
      }
    })
  }
  // A turn that did work ends with a line saying what it did: the anchor between one turn and the next.
  let turn: Block[] = []
  const end = (key: string) => {
    if (turn.some((b) => b.type === 'toolCall')) items.push({ type: 'end', key: `end:${key}`, blocks: turn })
    turn = []
  }
  for (const entry of entries) {
    const message = entry.model?.[0] as Message | undefined
    if (message?.role === 'assistant') { add(message, String(entry.id)); turn.push(...blocks(message)) }
    else if (message?.role === 'toolResult' || entry.kind === 'pi.system') continue
    else { if (message?.role === 'user') end(String(entry.id)); items.push({ type: 'entry', key: String(entry.id), entry }) }
  }
  if (partial) add(partial, 'live', true)
  else end('last')
  return items
}

/** "6 steps · +11 −2 · 1 failed" under a finished turn. */
function TurnEnd({ blocks, results }: { blocks: Block[]; results: Map<string, Message> }) {
  const calls = blocks.filter((b) => b.type === 'toolCall')
  const failed = calls.filter((b) => results.get(b.id!)?.isError).length
  const stats = sumStats(calls, results)
  return (
    <div className="turn-end">
      <span>{calls.length === 1 ? '1 step' : `${calls.length} steps`}</span>
      {(stats.added > 0 || stats.removed > 0) && <span><Stat {...stats} /></span>}
      {failed > 0 && <span>{failed} retried</span>}
    </div>
  )
}

function sumStats(calls: Block[], results: Map<string, Message>) {
  return calls.reduce((sum, b) => {
    const diff = diffOf(results.get(b.id!)?.details)
    if (!diff) return sum
    const stat = diffStat(diff)
    return { added: sum.added + stat.added, removed: sum.removed + stat.removed }
  }, { added: 0, removed: 0 })
}

function Entry({ entry }: { entry: EntryRecord }) {
  const custom = useRegistry().entries.get(entry.kind)
  const here = useContext(Here)
  if (custom) { const Custom = custom; return <Custom {...here} entry={{ id: entry.id, kind: entry.kind, data: entry.data }} /> }
  const message = entry.model?.[0] as Message | undefined
  if (message?.role === 'user') {
    // The title is the first message's opening; under it, only the rest of that message.
    const text = textOf(message)
    // A title cut short (…) says too little on its own: then the whole message shows.
    const title = here.session.title
    // A rest that starts mid-sentence (", write nothing") reads better whole, too.
    const tail = entry.id === firstUser(here) && !title.endsWith('…') && text.replace(/\s+/g, ' ').trim().startsWith(title) ? text.trim().slice(title.length).trim() : text
    // After a title that is the message's first clause, the rest reads as its own sentence.
    const clause = /^[:;—–]\s*/.exec(tail)
    const rest = clause ? tail.slice(clause[0].length).replace(/^./, (c) => c.toUpperCase()) : /^[,-]/.test(tail) ? text : tail
    return rest ? <div className="msg msg--user">{rest}</div> : null
  }
  return <div className="msg msg--note">{entry.kind}</div>
}

/**
 * A run of work. One step shows as itself; more fold into one line saying what was done ("Read 2 files and ran a
 * command"), open while the run is going and closed once the agent has moved on.
 *
 * Rows share one anatomy: a chevron hung in the gutter, then an icon at the text's edge, then the label. What a row
 * opens to sits under its icon; inside a run, rows sit under the run's label.
 */
function Work({ blocks, results, running, active }: { blocks: Block[]; results: Map<string, Message>; running: Slots; active: boolean }) {
  const [open, setOpen] = useState<boolean>()
  const rows = blocks.map((block, index) => block.type === 'thinking'
    ? <Thinking key={index} text={block.thinking ?? ''} />
    : <ToolCall key={block.id ?? index} block={block} result={results.get(block.id!)} slot={running.get(block.id!)} />)
  if (blocks.length === 1) return <div className="steps">{rows}</div>
  const calls = blocks.filter((b) => b.type === 'toolCall')
  const failed = calls.filter((b) => results.get(b.id!)?.isError).length
  const stats = sumStats(calls, results)
  const shown = open ?? active
  return (
    <details className="steps steps--run" open={shown} onToggle={(e) => { const next = e.currentTarget.open; if (next !== shown) setOpen(next) }}>
      <summary className="row">
        <Chevron />
        <Icon name={mainKind(blocks)} />
        <span className="row__label">{describe(blocks).map((part, i) => i % 2 ? <code key={i} className="row__path">{part}</code> : part)}</span>
        {(stats.added > 0 || stats.removed > 0) && <span className="row__meta"><Stat {...stats} /></span>}
        {failed > 0 && <span className="row__failed">{failed} failed</span>}
      </summary>
      <div className="run__steps">{rows}</div>
    </details>
  )
}

/** What a run mostly did, by weight: an edit matters more than a command, a command more than a read. */
const WEIGHT = ['edit', 'write', 'bash', 'read']
function mainKind(blocks: Block[]): string {
  const names = blocks.filter((b) => b.type === 'toolCall').map((b) => b.name ?? '')
  return WEIGHT.find((kind) => names.includes(kind)) ?? names[0] ?? 'thinking'
}

/** "Read 2 files, ran 3 commands and edited a file", as text and paths in turn: ['Edited ', 'src/a.ts', ' and ran a command']. */
function describe(blocks: Block[]): string[] {
  const count = new Map<string, number>()
  // Thinking between steps is part of the work; it's named only when that's all there is.
  const tools = blocks.filter((b) => b.type === 'toolCall')
  for (const b of tools.length ? tools : blocks) { const kind = b.type === 'thinking' ? 'thinking' : b.name ?? 'tool'; count.set(kind, (count.get(kind) ?? 0) + 1) }
  const n = (k: number, one: string, many: string) => k === 1 ? one : `${k} ${many}`
  // The weightiest kind leads, naming its file when there's one.
  const main = mainKind(blocks)
  const paths = tools.filter((b) => b.name === main).map((b) => (b.arguments as { path?: unknown } | undefined)?.path)
  const only = paths.length === 1 && typeof paths[0] === 'string' ? paths[0] : undefined
  const ordered = [...count].sort((a, b) => (a[0] === main ? -1 : b[0] === main ? 1 : 0))
  const phrases = ordered.map(([kind, k]) => {
    if (kind === main && only) return `${{ read: 'read', edit: 'edited', write: 'wrote' }[kind] ?? kind} \u0000${only}\u0000`
    switch (kind) {
      case 'thinking': return 'thought'
      case 'read': return `read ${n(k, 'a file', 'files')}`
      case 'bash': return `ran ${n(k, 'a command', 'commands')}`
      case 'edit': return `edited ${n(k, 'a file', 'files')}`
      case 'write': return `wrote ${n(k, 'a file', 'files')}`
      default: return `used ${kind}${k > 1 ? ` ${k}×` : ''}`
    }
  })
  const text = phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}` : phrases[0] ?? ''
  return (text.charAt(0).toUpperCase() + text.slice(1)).split('\u0000')
}

const Chevron = () => <span className="row__chevron" aria-hidden="true">›</span>

function Thinking({ text }: { text: string }) {
  return (
    <details className="step step--thinking">
      <summary className="row"><Chevron /><Icon name="thinking" /><span className="row__label">Thinking</span></summary>
      <div className="step__thinking">{text}</div>
    </details>
  )
}

/** Tool output, up to a dozen whole lines; the rest behind "Show all". */
function Output({ text, className = '' }: { text: string; className?: string }) {
  const [all, setAll] = useState(false)
  const lines = text.replace(/\n+$/, '').split('\n')
  const long = lines.length > CAP + 3
  return (
    <div className={`step__output ${long && !all ? 'is-cut' : ''} ${className}`}>
      <Scroll>{long && !all ? lines.slice(0, CAP).join('\n') : lines.join('\n')}</Scroll>
      {long && <button type="button" className="step__more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    </div>
  )
}
const CAP = 12

const Stat = ({ added, removed }: { added: number; removed: number }) => (
  <>{added > 0 && <span className="stat--add">+{added}</span>}{added > 0 && removed > 0 && ' '}{removed > 0 && <span className="stat--del">−{removed}</span>}</>
)

/** What a step did, as a verb: "Read", "Ran", "Edited"; "Running" while it runs, "Edit failed" when it failed. */
function verbOf(name: string, state: string): string {
  const verbs: Record<string, [string, string, string]> = {
    read: ['Read', 'Reading', 'Read failed'], bash: ['Ran', 'Running', 'Command failed'],
    edit: ['Edited', 'Editing', 'Edit failed'], write: ['Wrote', 'Writing', 'Write failed'],
  }
  const verb = verbs[name]
  if (!verb) return state === 'error' ? `${name} failed` : name
  return state === 'error' ? verb[2] : state === 'working' ? verb[1] : verb[0]
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
  const args = (block.arguments ?? {}) as Record<string, unknown>
  const output = result ? unwrap(textOf(result)) : slot?.output
  const state = result ? (result.isError ? 'error' : 'done') : slot?.status === 'running' ? 'working' : 'idle'
  const diff = !result?.isError ? diffOf(result?.details) : undefined
  const written = block.name === 'write' && typeof args.content === 'string' ? args.content : undefined
  const stat = diff ? diffStat(diff) : undefined
  return (
    <details className={`step step--${state}`}>
      <summary className="row">
        <Chevron />
        {state === 'working' ? <StatusGlyph status={{ state }} /> : <Icon name={block.name ?? ''} />}
        <span className="row__label">{verbOf(block.name ?? '', state)}</span>
        <span className="row__arg">{summaryOf(block.name ?? '', args)}</span>
        {stat && <span className="row__meta"><Stat {...stat} /></span>}
        {written !== undefined && <span className="row__meta">{lineCount(written)} lines</span>}
      </summary>
      {diff ? <Diff diff={diff} />
        : written !== undefined ? <Output text={written} />
        : output ? <Output text={output} className={state === 'error' ? 'is-error' : ''} /> : null}
    </details>
  )
}

/** A tool's error as the harness wraps it (`<harness>[error] …</harness>`), as just the message. */
const unwrap = (text: string) => text.replace(/^\s*<harness>\s*(?:\[error\]\s*)?([\s\S]*?)\s*<\/harness>\s*$/, '$1')

/** What a call is about, in a line: the command, the path, else its arguments. */
function summaryOf(name: string, args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return args.command
  if (typeof args.path === 'string') return args.path
  if (typeof args.pattern === 'string') return args.pattern
  return name ? JSON.stringify(args) : ''
}

const lineCount = (text: string) => text.replace(/\n$/, '').split('\n').length
const diffOf = (details: unknown) => typeof (details as { diff?: unknown } | undefined)?.diff === 'string' ? (details as { diff: string }).diff : undefined
function diffStat(diff: string) {
  const lines = diff.split('\n')
  return { added: lines.filter((l) => l.startsWith('+')).length, removed: lines.filter((l) => l.startsWith('-')).length }
}

/** A small, static glyph per kind of row: a page to read, a prompt to run, a pencil, a new page, a bubble for thinking. */
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    thinking: 'M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3zM12.5 11l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
    read: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8h4M6 10.5h4',
    bash: 'M1.5 3h13v10h-13zM4 6.5l2 1.5-2 1.5M7.5 10h3.5',
    edit: 'M10.5 2.5l3 3-7.5 7.5H3v-3zM9 4l3 3',
    write: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3M8 7.5v4M6 9.5h4',
  }
  return (
    <svg className="row__icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d={paths[name] ?? 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 6v4'} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** An edit's diff, as the edit tool reports it: `+12 added`, `-12 removed`, ` 12 context`, and `...` between hunks. */
function Diff({ diff }: { diff: string }) {
  // The tool numbers context and removed lines by the old file, added lines by the new one. Both columns show:
  // the old number (context, removed) and the new one (context shifted by what changed above it, added).
  const [all, setAll] = useState(false)
  let shift = 0
  const lines = diff.split('\n').map((line) => {
    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : /^\s*\.\.\.\s*$/.test(line) ? 'gap' : 'ctx'
    const match = /^[+\- ](\s*\d+) (.*)$/.exec(line)
    const n = match ? Number(match[1]) : undefined
    const old = n === undefined || kind === 'add' ? '' : String(n)
    const next = n === undefined || kind === 'del' ? '' : kind === 'add' ? String(n) : String(n + shift)
    if (kind === 'add') shift++
    if (kind === 'del') shift--
    return { kind, old, next, text: match ? match[2]! : kind === 'gap' ? '⋯' : line }
  })
  const long = lines.length > CAP * 2
  return (
    <div className="step__output step__diff">
      <Scroll>
        {(long && !all ? lines.slice(0, CAP * 2) : lines).map((line, index) => (
          <span key={index} className={`diff__line diff__line--${line.kind}`}>
            <span className="diff__num">{line.old}</span>
            <span className="diff__num">{line.next}</span>
            <span className="diff__sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
            <span className="diff__text">{line.text}</span>
          </span>
        ))}
      </Scroll>
      {long && <button type="button" className="step__more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    </div>
  )
}

function Composer({ machine, session, busy }: { machine: MachineEntry; session: SessionInfo; busy: boolean }) {
  const { openSettings: onOpenSettings } = useShell()
  const dispatch = useRegistry().router.dispatch
  const [claims, setClaims] = useState<ComposerClaim[]>([])
  const register = useMemo(() => (claim: ComposerClaim) => {
    setClaims((list) => [...list, claim])
    return () => setClaims((list) => list.filter((c) => c !== claim))
  }, [])
  const claim = claims.at(-1)
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
      if (claim) { await claim.submit(value); return }
      await dispatch('session.submit', { id: session.id, text: value, requestId: crypto.randomUUID(), ...(busy ? { whenBusy: 'steer' as const } : {}) }, { machine: machine.id, source: 'composer' })
    } catch (error) {
      setText(value)
      setError(error as { kind?: string; message: string })
    }
  }
  const abort = () => dispatch('session.abort', { id: session.id }, { machine: machine.id, source: 'composer' })
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
    if (event.key === 'Escape' && busy) { event.preventDefault(); void abort() }
  }
  return (
    <ClaimContext.Provider value={register}>
    <div className="dock">
    <div className="dock__above"><Slot name="composer.above" props={{ machine, session }} /></div>
    {error && (
      <div className="composer__error">
        {error.kind === 'no_model' ? <>No model is set up on {machine.label}. <Button onClick={onOpenSettings}>Open Settings</Button></> : error.message}
      </div>
    )}
    <div className="composer">
      <TextArea ref={input} rows={1} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
        placeholder={disabled ? `${machine.label} is ${machine.state}` : claim ? claim.placeholder : busy ? 'Steer the running agent…' : 'Ask anything'} />
      <div className="composer__actions">
        {busy && !claim && <Button className="composer__button" onClick={() => void abort()}>Stop <kbd>esc</kbd></Button>}
        <Button className="composer__button" aria-label={claim ? 'Answer' : busy ? 'Steer' : 'Send'} disabled={disabled || !text.trim()} onClick={() => void send()}>{claim ? 'Answer' : busy ? 'Steer' : 'Send'} <kbd>⏎</kbd></Button>
      </div>
    </div>
    </div>
    </ClaimContext.Provider>
  )
}

/** Open a pane beside the thread: the kinds that show something without being told what (Changes, a profile's own). */
function PaneMenu({ machine, session }: { machine: MachineEntry; session: SessionInfo }) {
  const registry = useRegistry()
  const kinds = paneMenu(registry, session)
  if (!kinds.length) return null
  const open = (kind: string) => void registry.router.dispatch('pane.open', { id: session.id, kind }, { machine: machine.id, source: 'header' })
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Open a pane" className="session__panes" />}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M9 3v10" stroke="currentColor" strokeWidth="1.3" /></svg>
      </Menu.Trigger>
      <Menu.Popup align="end">
        {kinds.map(({ kind, title }) => <Menu.Item key={kind} onClick={() => open(kind)}>{title}</Menu.Item>)}
      </Menu.Popup>
    </Menu.Root>
  )
}
