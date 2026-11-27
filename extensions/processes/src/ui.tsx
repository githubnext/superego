// processes, UI half: a thread's processes (its own and its folder's) as one quiet chip in its header ("● Failed · 3",
// a menu to show them or restart one), a mark on its row in the sidebar while one runs or failed unseen, and a pane
// shaped like Changes: the list on top, the selected one's output below (live, in colour, following the end until
// scrolled up). A report when one wakes the thread is a card with its last lines (a notice of kind `processes.report`,
// its Restart under it); `process:<id>` links open it in the pane; the process_* tools have rows.
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  call, defineUiExtension, factsOf, HeaderChip, PaneMessage, ThreadBadge, ThreadMenuItem, useDispatch, useValue,
  type EntryProps, type MachineEntry, type PaneProps, type SlotProps, type ThreadInfo,
} from '@superego/app/ui'
import {
  ArrowClockwiseIcon, ArrowDownIcon, Button, CheckIcon, Glyph, IconButton, PlayIcon, StopIcon, TerminalIcon, XIcon,
} from '@superego/ui'
import './styles.css'
import { parseLine, type Run, type Style } from './ansi.ts'
import {
  about, ended, endedHow, LIST, live, OUTPUT, PANE, READ, REPORT, SCHEME, span, titleOf,
  type OutputMark, type OutputSlice, type ProcessFacts, type ProcessInfo, type ReportData,
} from './shared.ts'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.slot('header.chips', ProcessesChip)
    superego.slot('thread.badge', ProcessesMark)
    superego.pane(PANE, { title: 'Processes', icon: TerminalIcon, component: ProcessesPane, menu: true })
    superego.entry(REPORT, Report)
    superego.link({
      match: `${SCHEME}:`,
      open(href, { machine, thread }) {
        if (!machine || !thread) return 'Open it from its thread'
        return superego.dispatch('pane.open', { thread: thread.id, kind: PANE, params: { id: href.slice(SCHEME.length + 1) } }, { machine })
          .then(() => undefined, (error: Error) => error.message)
      },
      target: (href) => `Process ${href.slice(SCHEME.length + 1)}`,
    })
    const subject = (c: { call: { arguments: Record<string, unknown> } }) => {
      const { name, command, id } = c.call.arguments as { name?: string; command?: string; id?: string }
      return name ?? (command ? titleOf({ command }) : id) ?? null
    }
    superego.tool('process_start', { icon: TerminalIcon, verbs: ['Started', 'Starting', 'Couldn’t start'], subject, phrase: (n) => n === 1 ? 'started a process' : `started ${n} processes` })
    superego.tool('process_restart', { icon: ArrowClockwiseIcon, verbs: ['Restarted', 'Restarting', 'Couldn’t restart'], subject, phrase: (n) => n === 1 ? 'restarted a process' : `restarted ${n} processes` })
    superego.tool('process_stop', { icon: StopIcon, verbs: ['Stopped', 'Stopping', 'Couldn’t stop'], subject, phrase: (n) => n === 1 ? 'stopped a process' : `stopped ${n} processes` })
    superego.tool('process_logs', { icon: TerminalIcon, verbs: ['Read', 'Reading', 'Couldn’t read'], subject, phrase: (n) => n === 1 ? 'read a process’s output' : `read processes’ output ${n}×` })
    superego.tool('process_wait', { icon: TerminalIcon, verbs: ['Waited on', 'Waiting on', 'Couldn’t wait on'], subject, phrase: (n) => n === 1 ? 'waited on a process' : `waited on processes ${n}×` })
    superego.tool('process_list', { icon: TerminalIcon, verbs: ['Listed processes', 'Listing processes', 'Couldn’t list processes'], subject: () => null, phrase: () => 'listed processes' })
  },
})

const useList = (machine: MachineEntry, thread: ThreadInfo) => useValue<ProcessInfo[]>(machine, LIST, { scope: thread.id }) ?? undefined

function useAct(machine: MachineEntry) {
  const dispatch = useDispatch()
  return (id: string, params: Record<string, unknown>) =>
    void dispatch(id, params, { machine: machine.id, source: about.name }).catch((error: Error) => console.error(`processes: ${id}: ${error.message}`))
}

/** Seconds since, ticking while it's shown. */
function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

const isRun = (p: ProcessInfo) => 'folder' in p.owner && p.name === 'run'

/** A process's mark: what state it's in, as the list, the chip and the report draw it. */
function Mark({ p, size = 'row' }: { p: Pick<ProcessInfo, 'state' | 'ready' | 'exitCode' | 'stopped'>; size?: 'row' | 'chip' }) {
  const cls = `processes-mark processes-mark--${size}`
  if (p.state === 'starting' || p.state === 'stopping') return <Glyph shape="working" className={cls} />
  if (p.state === 'idle') return <PlayIcon className={`${cls} is-idle`} size={10} weight="fill" aria-hidden />
  if (p.state === 'exited' && !p.stopped && p.exitCode === 0) return <CheckIcon className={`${cls} is-done`} size={12} weight="bold" aria-hidden />
  const state = p.state === 'exited' ? 'stopped' : p.state
  return <span className={`${cls} processes-dot is-${state}${p.state === 'running' && p.ready ? ' is-ready' : ''}`} aria-hidden />
}

/** What a row says at its end: its uptime, how it ended. */
function stateText(p: ProcessInfo, now: number) {
  if (p.state === 'idle') return ''
  if (p.state === 'starting') return 'Starting'
  if (p.state === 'stopping') return 'Stopping'
  if (p.state === 'running') return p.startedAt ? span(now - p.startedAt) : 'Running'
  if (p.state === 'lost') return 'Gone with a restart'
  if (p.stopped) return 'Stopped'
  const how = endedHow(p)
  return how.charAt(0).toUpperCase() + how.slice(1)
}

// ── The chip, and its rows in the menu ───────────────────────────────────────────────────────────────────────────────

/** What the chip says: the most pressing first. */
function chipOf(list: ProcessInfo[]): { state: string; label: string } | undefined {
  const failed = list.filter((p) => p.state === 'failed' && !p.seen)
  const starting = list.filter((p) => p.state === 'starting')
  const running = list.filter((p) => p.state === 'running' || p.state === 'stopping')
  const idle = list.filter((p) => p.state === 'idle')
  const total = list.filter((p) => live(p.state) || (p.state === 'failed' && !p.seen)).length
  if (failed.length) return { state: 'failed', label: total > 1 ? `Failed · ${total}` : 'Failed' }
  if (starting.length) return { state: 'starting', label: total > 1 ? `Starting · ${total}` : 'Starting' }
  if (running.length) return { state: 'running', label: running.length > 1 ? `${running.length} running` : 'Running' }
  // Only a definition (Run's, before it's started): what starts it.
  if (idle.length === 1) return { state: 'idle', label: titleOf(idle[0]!) === 'run' ? 'Run' : titleOf(idle[0]!) }
  return undefined
}

function ProcessesChip({ machine, thread }: SlotProps['header.chips']) {
  const list = useList(machine, thread)
  const act = useAct(machine)
  const chip = list && chipOf(list)
  if (!list || !chip) return null
  const show = (id?: string) => act('pane.open', { thread: thread.id, kind: PANE, ...(id ? { params: { id } } : {}) })
  const menu = (
    <>
      <ThreadMenuItem icon={TerminalIcon} keys="processes.show" onClick={() => show()}>Show processes</ThreadMenuItem>
      {list.filter((p) => live(p.state) || p.state === 'failed' || p.state === 'idle').slice(0, 6).map((p) => live(p.state)
        ? <ThreadMenuItem key={p.id} icon={ArrowClockwiseIcon} onClick={() => act('processes.restart', { id: p.id })}>Restart {titleOf(p)}</ThreadMenuItem>
        : <ThreadMenuItem key={p.id} icon={p.state === 'idle' ? PlayIcon : ArrowClockwiseIcon} onClick={() => act('processes.restart', { id: p.id })}>{p.state === 'idle' ? 'Start' : 'Restart'} {titleOf(p)}</ThreadMenuItem>)}
    </>
  )
  const title = list.filter((p) => !ended(p.state) || p.state === 'failed').map((p) => `${titleOf(p)}: ${stateText(p, Date.now())}`).join('\n')
  return (
    <HeaderChip title={title} menu={menu}>
      <span className={`processes-chip is-${chip.state}`}>
        <Mark p={{ state: chip.state === 'failed' ? 'failed' : chip.state === 'idle' ? 'idle' : chip.state === 'starting' ? 'starting' : 'running' }} size="chip" />
        <span>{chip.label}</span>
      </span>
    </HeaderChip>
  )
}

// ── The sidebar mark ─────────────────────────────────────────────────────────────────────────────────────────────────

function ProcessesMark({ thread }: SlotProps['thread.badge']) {
  const facts = factsOf<ProcessFacts>(thread, about)
  if (!facts) return null
  const state = facts.failed ? 'failed' : facts.starting ? 'starting' : 'running'
  const label = facts.failed ? `${facts.failed} process${facts.failed > 1 ? 'es' : ''} failed` : facts.starting ? 'a process starting' : `${facts.running} process${facts.running > 1 ? 'es' : ''} running`
  return (
    <ThreadBadge label={label}>
      <TerminalIcon className={`processes-badge is-${state}`} size={12} weight="bold" aria-hidden />
    </ThreadBadge>
  )
}

// ── The pane ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function ProcessesPane({ machine, thread, pane }: PaneProps) {
  const list = useList(machine, thread)
  const act = useAct(machine)
  const now = useNow()
  const asked = (pane.params as { id?: string } | undefined)?.id
  if (machine.state !== 'connected') return <PaneMessage>{machine.label} is offline.</PaneMessage>
  if (!list) return <PaneMessage>Loading…</PaneMessage>
  if (!list.length) return <PaneMessage>No processes. An agent starts one with process_start; a folder’s dev command comes from its .superego/run.json.</PaneMessage>
  const selected = list.find((p) => p.id === asked) ?? list.find((p) => p.state === 'failed' && !p.seen) ?? list.find((p) => live(p.state)) ?? list[0]!
  const pick = (id: string) => act('pane.update', { thread: thread.id, pane: pane.id, params: { id } })
  // Scope headings only once a folder's process is among them.
  const folders = list.some((p) => 'folder' in p.owner)
  const groups: { title?: string; items: ProcessInfo[] }[] = folders
    ? [
        { title: 'This thread', items: list.filter((p) => !('folder' in p.owner)) },
        { title: thread.project?.name ?? thread.cwd.split('/').pop() ?? 'Folder', items: list.filter((p) => 'folder' in p.owner) },
      ].filter((g) => g.items.length)
    : [{ items: list }]
  return (
    <div className="processes-pane">
      <div className="processes-list" role="listbox" aria-label="Processes">
        {groups.map((group, i) => (
          <div key={i} className="processes-group">
            {group.title && <div className="processes-group__title">{group.title}</div>}
            {group.items.map((p) => <Row key={p.id} p={p} now={now} selected={p.id === selected.id} onPick={() => pick(p.id)} act={act} />)}
          </div>
        ))}
      </div>
      <Selected key={selected.id} machine={machine} p={selected} act={act} />
    </div>
  )
}

function Row({ p, now, selected, onPick, act }: { p: ProcessInfo; now: number; selected: boolean; onPick(): void; act: ReturnType<typeof useAct> }) {
  return (
    <div role="option" aria-selected={selected} tabIndex={0} className={`processes-row is-${p.state}${selected ? ' is-selected' : ''}`} onClick={onPick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick() } }} title={p.command}>
      <Mark p={p} />
      <span className="processes-row__title">{titleOf(p) === 'run' && isRun(p) ? p.command : titleOf(p)}</span>
      {isRun(p) && <span className="processes-tag">Run</span>}
      <span className="processes-row__state">
        {p.state === 'idle'
          ? <Button className="processes-row__start" onClick={(e) => { e.stopPropagation(); act('processes.restart', { id: p.id }) }}>Start</Button>
          : stateText(p, now)}
      </span>
      {p.state !== 'idle' && (
        <span className="processes-row__actions" onClick={(e) => e.stopPropagation()}>
          <IconButton label="Restart" onClick={() => act('processes.restart', { id: p.id })}><ArrowClockwiseIcon size={13} aria-hidden /></IconButton>
          {live(p.state)
            ? <IconButton label="Stop" onClick={() => act('processes.stop', { id: p.id })}><StopIcon size={13} aria-hidden /></IconButton>
            : <IconButton label="Remove" onClick={() => act('processes.remove', { id: p.id })}><XIcon size={13} aria-hidden /></IconButton>}
        </span>
      )}
    </div>
  )
}

/** The selected process: what it runs where, its buttons, and its output. */
function Selected({ machine, p, act }: { machine: MachineEntry; p: ProcessInfo; act: ReturnType<typeof useAct> }) {
  // Seen: its failure no longer marks the thread.
  useEffect(() => { if (p.state === 'failed' && !p.seen) act('processes.seen', { id: p.id }) }, [p.id, p.state, p.seen])
  const home = p.cwd.replace(/^\/(Users|home)\/[^/]+/, '~')
  return (
    <div className="processes-selected">
      <div className="processes-bar">
        <span className="processes-bar__command" title={`${p.command}\n${p.cwd}`}>{p.command}</span>
        <span className="processes-bar__cwd" title={p.cwd}><bdi dir="ltr">{home}</bdi></span>
        <span className="processes-bar__buttons">
          <Button onClick={() => act('processes.restart', { id: p.id })}>
            {p.state === 'idle' ? <PlayIcon size={12} aria-hidden /> : <ArrowClockwiseIcon size={12} aria-hidden />}{p.state === 'idle' ? 'Start' : 'Restart'}
          </Button>
          {live(p.state)
            ? <Button onClick={() => act('processes.stop', { id: p.id })}><StopIcon size={12} aria-hidden />Stop</Button>
            : p.state !== 'idle' && <Button onClick={() => act('processes.remove', { id: p.id })}>Remove</Button>}
        </span>
      </div>
      {p.error && ended(p.state) && p.state !== 'lost' && p.exitCode === undefined && <div className="processes-problem" role="alert">{p.error}</div>}
      <Output machine={machine} p={p} />
    </div>
  )
}

// ── Output: a live tail with colours ─────────────────────────────────────────────────────────────────────────────────

const MAX_LINES = 5000

/** Output as lines of runs, built as it arrives: whole lines parsed once, the line still being written kept raw. */
type Tail = { lines: Run[][]; dropped: number; pending: string; style: Style; have: number | undefined; earlier: boolean }
const emptyTail = (): Tail => ({ lines: [], dropped: 0, pending: '', style: {}, have: undefined, earlier: false })

function append(tail: Tail, text: string) {
  const parts = (tail.pending + text).split('\n')
  tail.pending = parts.pop()!
  for (const line of parts) {
    const parsed = parseLine(line, tail.style)
    tail.style = parsed.style
    tail.lines.push(parsed.runs)
  }
  if (tail.lines.length > MAX_LINES * 1.2) {
    const drop = tail.lines.length - MAX_LINES
    tail.lines.splice(0, drop)
    tail.dropped += drop
    tail.earlier = true
  }
}

const css = (style: Style): CSSProperties | undefined => {
  if (!style.fg && !style.bg && !style.bold && !style.dim && !style.italic && !style.underline && !style.inverse) return undefined
  const [fg, bg] = style.inverse ? [style.bg ?? 'var(--superego-bg)', style.fg ?? 'var(--superego-text)'] : [style.fg, style.bg]
  return {
    color: fg, background: bg, fontWeight: style.bold ? 600 : undefined, opacity: style.dim ? 0.6 : undefined,
    fontStyle: style.italic ? 'italic' : undefined, textDecoration: style.underline ? 'underline' : undefined,
  }
}

const Line = memo(function Line({ runs }: { runs: Run[] }) {
  // A line of the runner's own (dim, `── … ──`): set apart, centred.
  const own = runs.length === 1 && runs[0]!.style.dim && /^── .* ──$/.test(runs[0]!.text)
  if (own) return <div className="processes-line processes-line--own">{runs[0]!.text}</div>
  return <div className="processes-line">{runs.length ? runs.map((run, i) => <span key={i} style={css(run.style)}>{run.text}</span>) : '\u200b'}</div>
})

function Output({ machine, p }: { machine: MachineEntry; p: ProcessInfo }) {
  const mark = useValue<OutputMark>(machine, OUTPUT, { scope: p.id })
  const tail = useRef<Tail>(emptyTail())
  const [, redraw] = useState(0)
  const busy = useRef(false)
  const mounted = useRef(true)
  const latest = useRef(0)
  const [problem, setProblem] = useState<string>()
  latest.current = mark?.end ?? 0
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // Pull what's new whenever the end moves (and once to begin with), one request at a time, until caught up.
  useEffect(() => {
    if (busy.current) return
    busy.current = true
    void (async () => {
      try {
        while (mounted.current) {
          const t = tail.current
          if (t.have !== undefined && latest.current < t.have) { tail.current = emptyTail(); continue }
          if (t.have !== undefined && latest.current <= t.have) break
          const since = t.have ?? 0
          const slice = await call<OutputSlice>(machine.id, READ, { id: p.id, since })
          if (!mounted.current) break
          if (t !== tail.current) continue
          if (slice.from > since) t.earlier = true
          append(t, slice.text)
          t.have = slice.end
          redraw((n) => n + 1)
          setProblem(undefined)
          if (slice.end >= latest.current) break
        }
      } catch (error) {
        console.error(`processes: reading ${p.id}: ${(error as Error).message}`)
        setProblem((error as Error).message)
      } finally {
        busy.current = false
      }
    })()
  }, [mark?.end, machine.id, p.id])

  // Follow the end, until scrolled up from it.
  const scroller = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const onScroll = () => {
    const el = scroller.current
    if (el) setFollowing(el.scrollTop + el.clientHeight >= el.scrollHeight - 24)
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && following) el.scrollTop = el.scrollHeight
  })
  const follow = () => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    setFollowing(true)
  }

  const t = tail.current
  const pending = t.pending ? parseLine(t.pending, t.style).runs : undefined
  const empty = !t.lines.length && !t.pending
  if (problem && empty) return <PaneMessage>Couldn’t read its output: {problem}</PaneMessage>
  if (empty) return <PaneMessage>{p.state === 'idle' ? 'Not started.' : t.have === undefined ? 'Loading…' : 'No output yet.'}</PaneMessage>
  return (
    <div className="processes-output-wrap">
      <div className="processes-output" ref={scroller} onScroll={onScroll}>
        {t.earlier && <div className="processes-line processes-line--own">Earlier output is in its log</div>}
        {t.lines.map((runs, i) => <Line key={t.dropped + i} runs={runs} />)}
        {pending && <Line runs={pending} />}
      </div>
      {!following && (
        <button type="button" className="processes-follow" onClick={follow}><ArrowDownIcon size={12} aria-hidden />Follow</button>
      )}
    </div>
  )
}

// ── A report in the transcript ───────────────────────────────────────────────────────────────────────────────────────

/** A process's end, as it woke the thread: how it ended, its last lines, and a way to its output. */
function Report({ machine, thread, entry }: EntryProps) {
  const act = useAct(machine)
  const data = entry.data as ReportData | undefined
  if (!data) return null
  const open = () => act('pane.open', { thread: thread.id, kind: PANE, params: { id: data.id } })
  const lines: ReactNode = data.tail ? <pre className="processes-report__tail">{data.tail}</pre> : null
  return (
    <div className={`processes-report${data.failed ? ' is-failed' : ''}`}>
      <div className="processes-report__head">
        <Mark p={{ state: data.failed ? 'failed' : 'exited', exitCode: data.failed ? 1 : 0 }} />
        <span className="processes-report__title">{data.title}</span>
        <span className="processes-report__how">{data.how}{data.whileAway ? ', while Superego was stopped' : ''}</span>
        <button type="button" className="processes-report__open" onClick={open}>Open</button>
      </div>
      {lines}
    </div>
  )
}
