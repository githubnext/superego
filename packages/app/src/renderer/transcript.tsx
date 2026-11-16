// What a thread's transcript shows: your messages (and extensions' entries), the agent's answers, and its work folded
// into runs and tasks, each tool call drawn as its tool's row describes it or as an extension draws it.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConversationView, EntryRecord, LiveState } from '@earendil-works/pi-durable'
import { NOTE_ENTRY, waitingForSignIn, type ThreadInfo } from '@superego/protocol'
import { Button, CheckIcon, FileIcon, type Icon as PhosphorIcon, MinusIcon, PauseIcon, StatusGlyph, XIcon } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { divideWork, entryOwner, entryView, sentWithIn, toolOwner, toolRow, toolView, unfoldedTool, useRegistry, type ToolRowCall, type WorkBlock as Block, type WorkPart, type WorkStatus } from './extension.tsx'
import { useRejections, useShell } from './state.tsx'
import { Markdown } from './Markdown.tsx'
import { Chevron, DescribedCall, describeRun, mainKind, RowIcon, Stat, statOf } from './tool-rows.tsx'
import { splitMessage } from './attachments.ts'
import { readSent, type SentBlock } from './composer.ts'
import { Contained } from './contained.tsx'

/** A message in the conversation, as the model sees it. */
export type Message = { role: string; content: string | Block[]; toolCallId?: string; isError?: boolean; details?: unknown; timestamp?: number }

/** The thread a transcript belongs to, for extension renderers. */
const Here = createContext<{ machine: MachineEntry; thread: ThreadInfo }>(undefined as never)

const blocks = (message: Message | undefined): Block[] =>
  !message ? [] : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
const textOf = (message: Message | undefined) => blocks(message).map((b) => b.text ?? '').join('')
/** A tool result's images, as the model was shown them: `{ images }`, or nothing when it has none. */
const imagesOf = (message: Message) => {
  const images = blocks(message).flatMap((b) => {
    const { data, mimeType } = b as { data?: unknown; mimeType?: unknown }
    return b.type === 'image' && typeof data === 'string' && typeof mimeType === 'string' ? [{ data, mimeType }] : []
  })
  return images.length ? { images } : {}
}

/** A thread's transcript: `view` as watched (scrolled back), and the run going on (`live`). */
export function Transcript({ machine, thread, view, live }: { machine: MachineEntry; thread: ThreadInfo; view: ConversationView; live: LiveState | undefined }) {
  const here = useMemo(() => ({ machine, thread }), [machine, thread])
  const registry = useRegistry()
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
  const working = Boolean(live?.run) && here.thread.status.state === 'working'
  const items = useMemo(() => flatten(view.entries, partial, working), [view.entries, partial, working])
  const result = (id: string) => { const message = results.get(id); return message && { text: textOf(message), isError: Boolean(message.isError) } }

  return (
    <Here.Provider value={here}>
    <div className="transcript">
      {view.before !== undefined && <div className="transcript__more">Loading earlier messages…</div>}
      {items.map((item, index) => {
        const last = index === items.length - 1
        switch (item.type) {
          case 'entry': return <Entry key={item.key} entry={item.entry} />
          case 'text': return (
            <div key={item.key} className={`msg msg__text ${item.narration ? 'msg__text--narration' : ''} ${item.streaming ? 'is-streaming' : ''}`}><Markdown text={item.text} /></div>
          )
          case 'work': {
            // Extensions may divide a run into parts (an agent's reported tasks); the last part is the one going on, and a
            // task still running is only ever that one (one left open when its run ends is interrupted).
            const active = last && Boolean(live?.run)
            const parts = divideWork(registry, { machine: here.machine.id, thread: here.thread }, { blocks: item.blocks, active, result })
            return parts.map((part, i) => part.title !== undefined
              ? <Task key={`${item.key}:${i}`} part={part} results={results} running={running} />
              : part.blocks.length ? <Work key={`${item.key}:${i}`} blocks={part.blocks} results={results} running={running} active={active && i === parts.length - 1} /> : null)
          }
          case 'end': return <TurnEnd key={item.key} blocks={divideWork(registry, { machine: here.machine.id, thread: here.thread }, { blocks: item.blocks, active: false, result }).flatMap((part) => part.blocks)} results={results} />
          case 'working': return <Working key={item.key} steps={item.blocks.filter((b) => b.type === 'toolCall').length} since={item.since} />
        }
      })}
      {waitingForSignIn(here.thread.status) ? <WaitingForSignIn /> : live?.runFailure && !live.run && live.runFailure.reason !== 'aborted' && (
        <div className="transcript__error">Run failed: {live.runFailure.reason}{live.runFailure.detail ? ` — ${live.runFailure.detail}` : ''}</div>
      )}
    </div>
    </Here.Provider>
  )
}

/** In place of its failure: the provider rejected the credentials, and the thread goes on once they're fixed. */
function WaitingForSignIn() {
  const { machine, thread } = useContext(Here)
  const { signIn } = useShell()
  const rejection = useRejections()[machine.id]?.find((r) => r.threads.includes(thread.id))
  return (
    <div className="transcript__waiting" title={rejection?.detail}>
      <span>{thread.status.msg}. It goes on once you sign in again.</span>
      {rejection && <Button onClick={() => signIn(machine.id, rejection.provider)}>Sign in again</Button>}
    </div>
  )
}

/**
 * A message you sent: your words, whole, and what went with them below: what extensions put in it (a skill it named,
 * drawn by the extension that sent it along), then its files.
 */
function Sent({ blocks, className, children }: { blocks: SentBlock[]; className: string; children?: ReactNode }) {
  const here = useContext(Here)
  const registry = useRegistry()
  const { found, rest } = readSent(sentWithIn(registry, { machine: here.machine.id, thread: here.thread }), blocks)
  const { text, files } = splitMessage(rest)
  if (!text && !found.length && !files.length && !children) return null
  return (
    <div className={className}>
      {text && <Markdown text={text} breaks />}
      {(found.length > 0 || files.length > 0) && (
        <div className="msg__files">
          {found.map(({ reader: { component: Component, owner }, items }) => <Contained key={`${owner.profile ?? ''}/${owner.extension}`} name={owner.extension} inline><Component {...here} items={items} /></Contained>)}
          <Files files={files} />
        </div>
      )}
      {children}
    </div>
  )
}

/** The files that went with a message. */
function Files({ files }: { files: ReturnType<typeof splitMessage>['files'] }) {
  return (
    <>
      {/* An image shows as itself, its name on hover; other files as a chip with their name. */}
      {files.map((file, index) => file.image
        ? <span key={`${file.path}-${index}`} className="attachment attachment--image" title={file.name}><img src={file.image} alt={file.name} /></span>
        : (
          <span key={`${file.path}-${index}`} className="attachment" title={file.path}>
            <span className="attachment__icon"><FileIcon size={14} aria-hidden /></span>
            <span className="attachment__name">{file.name}</span>
          </span>
        ))}
    </>
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
  | { type: 'working'; key: string; blocks: Block[]; since: number | undefined }

function flatten(entries: readonly EntryRecord[], partial: Message | undefined, working: boolean): Item[] {
  const items: Item[] = []
  const add = (message: Message, key: string, streaming = false) => {
    const list = blocks(message)
    const narration = list.some((b) => b.type === 'toolCall')
    list.forEach((block, index) => {
      const last = items.at(-1)
      if (block.type === 'text' && !narration) {
        // An answer: what the agent says, outside the work.
        if (block.text?.trim()) items.push({ type: 'text', key: `${key}:${index}`, text: block.text, narration, streaming })
      } else if (block.type === 'toolCall' || (block.type === 'thinking' && block.thinking) || (block.type === 'text' && block.text?.trim())) {
        // Work, and what the agent says along the way (text beside tool calls): one fold from a message to the answer.
        if (last?.type === 'work') last.blocks.push(block)
        else items.push({ type: 'work', key: `${key}:${index}`, blocks: [block] })
      }
    })
  }
  // A turn that did work ends with a line saying what it did: the anchor between one turn and the next.
  let turn: Block[] = []
  // When the turn began: the message that started it.
  let since: number | undefined
  const end = (key: string) => {
    if (turn.some((b) => b.type === 'toolCall')) items.push({ type: 'end', key: `end:${key}`, blocks: turn })
    turn = []
  }
  for (const entry of entries) {
    const message = entry.model?.[0] as Message | undefined
    if (message?.role === 'assistant') { add(message, String(entry.id)); turn.push(...blocks(message)) }
    else if (message?.role === 'toolResult' || entry.kind === 'pi.system') continue
    else {
      if (message?.role === 'user') { end(String(entry.id)); since = message.timestamp }
      items.push({ type: 'entry', key: String(entry.id), entry })
    }
  }
  if (partial) { add(partial, 'live', true); turn.push(...blocks(partial)) }
  // While the agent works, the turn so far ends with a line saying so; done, with what it did.
  if (working) items.push({ type: 'working', key: 'working', blocks: turn, since })
  else if (!partial) end('last')
  return items
}

/** "Working · 5 steps · 1m 12s" at the end of the turn going on. */
function Working({ steps, since }: { steps: number; since: number | undefined }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = since === undefined ? undefined : Math.max(0, Math.floor((now - since) / 1000))
  return (
    <div className="transcript__working" role="status">
      <span>Working</span>
      {steps > 0 && <span>{steps === 1 ? '1 step' : `${steps} steps`}</span>}
      {seconds !== undefined && <span>{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</span>}
    </div>
  )
}

/** "6 steps · +11 −2 · 1 failed" under a finished turn. */
function TurnEnd({ blocks, results }: { blocks: Block[]; results: Map<string, Message> }) {
  const rows = useRows()
  const calls = blocks.filter((b) => b.type === 'toolCall')
  const failed = calls.filter((b) => results.get(b.id!)?.isError).length
  const stats = rows.stats(calls, results)
  return (
    <div className="turn-end">
      <span>{calls.length === 1 ? '1 step' : `${calls.length} steps`}</span>
      {(stats.added > 0 || stats.removed > 0) && <span><Stat {...stats} /></span>}
      {failed > 0 && <span>{failed} failed</span>}
    </div>
  )
}

/** The rows of this thread's tools: each tool's, and the lines a run of calls added and removed, summed. */
function useRows() {
  const here = useContext(Here)
  const registry = useRegistry()
  const where = { machine: here.machine.id, thread: here.thread }
  const rowOf = (name: string) => toolRow(registry, name, where)
  const stats = (calls: Block[], results: Map<string, Message>) => calls.reduce((sum, b) => {
    const stat = statOf(rowOf(b.name ?? ''), callOf(here, b, results.get(b.id!)))
    return stat ? { added: sum.added + stat.added, removed: sum.removed + stat.removed } : sum
  }, { added: 0, removed: 0 })
  return { rowOf, stats }
}

function Entry({ entry }: { entry: EntryRecord }) {
  const here = useContext(Here)
  const registry = useRegistry()
  const where = { machine: here.machine.id, thread: here.thread }
  const custom = entryView(registry, entry.kind, where)
  if (custom) { const Custom = custom; return <Contained name={entryOwner(registry, entry.kind, where) ?? entry.kind}><Custom {...here} entry={{ id: entry.id, kind: entry.kind, data: entry.data }} /></Contained> }
  const message = entry.model?.[0] as Message | undefined
  if (message?.role === 'user') {
    return <Sent className="msg msg--user" blocks={blocks(message)} />
  }
  // Superego's own lines (a self-archive that couldn't be done); else the kind, for an entry nothing draws.
  const said = entry.kind === NOTE_ENTRY ? (entry.data as { text?: unknown } | undefined)?.text : undefined
  return <div className="msg msg--note">{typeof said === 'string' ? said : entry.kind}</div>
}

/** A run's blocks as rows: thinking, what the agent said along the way, tool calls. */
const steps = (blocks: Block[], results: Map<string, Message>, running: Slots) => blocks.map((block, index) => block.type === 'thinking'
  ? <Thinking key={index} text={block.thinking ?? ''} />
  : block.type === 'text'
    ? <div key={index} className="step__note"><Markdown text={block.text ?? ''} /></div>
    : <ToolCall key={block.id ?? index} block={block} result={results.get(block.id!)} slot={running.get(block.id!)} />)

/**
 * A run of work. One step shows as itself; more fold into one line saying what was done ("Read 2 files and ran a
 * command"), open while the run is going and closed once the agent has moved on.
 *
 * Rows share one anatomy: a chevron hung in the gutter, then an icon at the text's edge, then the label. What a row
 * opens to sits under its icon; inside a run, rows sit under the run's label.
 */
function Work({ blocks: all, results, running, active }: { blocks: Block[]; results: Map<string, Message>; running: Slots; active: boolean }) {
  const [open, setOpen] = useState<boolean>()
  const { rowOf, stats: sum } = useRows()
  const { blocks, shown } = useUnfolded(all, results, running)
  if (!blocks.length) return shown
  const rows = steps(blocks, results, running)
  // One step, or only what the agent said beside what it shows: as itself.
  if ((blocks.length === 1 && blocks[0]!.type !== 'text') || (shown && blocks.every((b) => b.type === 'text'))) return <><div className="steps">{rows}</div>{shown}</>
  const calls = blocks.filter((b) => b.type === 'toolCall')
  const failed = calls.filter((b) => results.get(b.id!)?.isError).length
  const stats = sum(calls, results)
  const main = mainKind(blocks, rowOf)
  const said = describeRun(blocks, rowOf)
  // Folded, while it works too; opened only by hand.
  const folded = open ?? false
  return (
    <>
      <details className="steps steps--run" open={folded} onToggle={(e) => { const next = e.currentTarget.open; if (next !== folded) setOpen(next) }}>
        <summary className="row">
          <Chevron />
          {active ? <StatusGlyph status={{ state: 'working' }} /> : <RowIcon row={rowOf(main)} thinking={!calls.length} />}
          <span className="row__label row__summary" title={said.join('')}>{said.map((part, i) => i % 2 ? <code key={i} className="row__path">{part}</code> : part)}</span>
          {(stats.added > 0 || stats.removed > 0) && <span className="row__meta"><Stat {...stats} /></span>}
          {failed > 0 && <span className="row__failed">{failed} failed</span>}
        </summary>
        <div className="run__steps">{rows}</div>
      </details>
      {shown}
    </>
  )
}

/**
 * A run's blocks without the calls an extension shows unfolded (`tool(name, component, { fold: false })`: images the
 * agent showed, say), and those calls drawn on their own, to go under the fold.
 */
function useUnfolded(all: Block[], results: Map<string, Message>, running: Slots) {
  const registry = useRegistry()
  const here = useContext(Here)
  const where = { machine: here.machine.id, thread: here.thread }
  const out = all.filter((b) => b.type === 'toolCall' && unfoldedTool(registry, b.name ?? '', where))
  if (!out.length) return { blocks: all, shown: null }
  return { blocks: all.filter((b) => !out.includes(b)), shown: <div className="steps steps--unfolded">{steps(out, results, running)}</div> }
}

/**
 * A titled part of a run (a task the agent reported): how it went, its title, and its outcome under it, all shown
 * folded; its steps under that, opened by hand.
 */
function Task({ part, results, running }: { part: WorkPart; results: Map<string, Message>; running: Slots }) {
  const [open, setOpen] = useState(false)
  const status = part.status ?? 'success'
  const { stats: sum } = useRows()
  const { blocks, shown } = useUnfolded(part.blocks, results, running)
  const calls = blocks.filter((b) => b.type === 'toolCall')
  const stats = sum(calls, results)
  const rows = steps(blocks, results, running)
  const summary = (
    <>
      {status === 'running' ? <StatusGlyph status={{ state: 'working' }} /> : <TaskIcon status={status} />}
      <span className="task__body">
        <span className="task__head">
          <span className="row__label row__summary task__title" title={part.title}>{part.title}</span>
          {(stats.added > 0 || stats.removed > 0) && <span className="row__meta"><Stat {...stats} /></span>}
        </span>
        {part.outcome && <span className="task__outcome">{part.outcome}</span>}
      </span>
    </>
  )
  if (!rows.length) return <><div className={`steps task task--${status}`}><div className="row task__row">{summary}</div></div>{shown}</>
  return (
    <>
      <details className={`steps steps--run task task--${status}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="row task__row" aria-label={`${part.title} — ${TASK_LABELS[status]}`}><Chevron />{summary}</summary>
        <div className="run__steps">{rows}</div>
      </details>
      {shown}
    </>
  )
}

const TASK_LABELS: Record<WorkStatus, string> = { running: 'Running', success: 'Done', failure: 'Failed', inconclusive: 'Inconclusive', interrupted: 'Interrupted' }
const TASK_ICONS: Record<Exclude<WorkStatus, 'running'>, PhosphorIcon> = { success: CheckIcon, failure: XIcon, inconclusive: MinusIcon, interrupted: PauseIcon }
function TaskIcon({ status }: { status: Exclude<WorkStatus, 'running'> }) {
  const Glyph = TASK_ICONS[status]
  return <Glyph className="row__icon task__icon" size={14} weight="bold" aria-label={TASK_LABELS[status]} />
}

function Thinking({ text }: { text: string }) {
  return (
    <details className="step step--thinking">
      <summary className="row"><Chevron /><RowIcon thinking /><span className="row__label">Thinking</span></summary>
      <div className="step__thinking">{text}</div>
    </details>
  )
}

/** A call as its tool's row describes it, or as an extension draws it whole. */
function ToolCall({ block, result, slot }: { block: Block; result: Message | undefined; slot: ReturnType<Slots['get']> }) {
  const here = useContext(Here)
  const registry = useRegistry()
  const where = { machine: here.machine.id, thread: here.thread }
  const call = callOf(here, block, result, slot)
  const Custom = toolView(registry, call.call.name, where)
  // Its row's parts are the extension's code too: drawn apart, whole or described.
  const name = toolOwner(registry, call.call.name, where) ?? call.call.name
  if (Custom) { const { state: _state, ...props } = call; return <Contained name={name}><Custom {...props} /></Contained> }
  return <Contained name={name}><DescribedCall row={toolRow(registry, call.call.name, where)} call={call} /></Contained>
}

/** A call, its result and how it runs, as tool rows (and an extension's view of the call) see them. */
function callOf(here: { machine: MachineEntry; thread: ThreadInfo }, block: Block, result: Message | undefined, slot?: ReturnType<Slots['get']>): ToolRowCall {
  return {
    ...here,
    call: { id: block.id ?? '', name: block.name ?? '', arguments: (block.arguments ?? {}) as Record<string, unknown> },
    ...(result ? { result: { text: textOf(result), isError: Boolean(result.isError), details: result.details, ...imagesOf(result) } } : {}),
    ...(slot ? { live: { status: slot.status, ...(slot.output !== undefined ? { output: slot.output } : {}), details: slot.details } } : {}),
    state: result ? (result.isError ? 'error' : 'done') : slot?.status === 'running' ? 'working' : 'idle',
  }
}

