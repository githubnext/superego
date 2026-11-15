// The board: this thread's children at a glance, live. What each is doing, how long since it last made progress, a
// flag when the watchdog thinks it's stalled, its worktree, what its branch changed and whether that's merged, its last
// answer in a line, and an Archive button once it's idle. A child's report (what it said when it finished, errored or
// asked) sits under its row; once the child's archived, under Reports; either way until dismissed. Queued starts
// follow. Threads come from what the window knows; the rest from staff.ts.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArchiveIcon, call, defineUiExtension, IconButton, Markdown, PaneHeader, ThreadRef, useDispatch, useThreads, useValue, XIcon,
  type PaneProps,
} from 'superego/ui'

type Changes = { files: { path: string; added: number; removed: number }[]; added: number; removed: number; more?: number }
type Report = { id: string; title: string; at: number; outcome: 'done' | 'error' | 'question'; answer: string; branch?: string; changes?: Changes; merged?: boolean }
type Board = Record<string, {
  stalled: Record<string, { since: number; call?: string }>; queued: { title: string; at: number }[]
  changes?: Record<string, Changes>; reports?: Report[]
}>
type Details = { id: string; answer: string | null; merged: boolean | null }

const ago = (ms: number) => ms < 60_000 ? 'now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
const stateOf = (s: { state: string; kind?: string }) =>
  s.state === 'working' ? 'working' : s.state === 'blocked' ? (s.kind === 'question' ? 'waiting on question' : 'waiting on you') : s.state === 'error' ? 'errored' : 'idle'
const OUTCOME = { done: 'Finished', error: 'Errored', question: 'Asked' }
const merge = (merged: boolean | null | undefined) => merged === true ? ' · merged' : merged === false ? ' · not merged' : ''

/** What a branch changed: +/− and a count, opening to its files. */
function ChangesOf({ changes }: { changes: Changes }) {
  const count = changes.files.length + (changes.more ?? 0)
  return (
    <details className="staff-board__changes">
      <summary><b className="is-added">+{changes.added}</b> <b className="is-removed">−{changes.removed}</b> · {count} {count === 1 ? 'file' : 'files'}</summary>
      <ul>
        {changes.files.map((f) => <li key={f.path}><span>{f.path}</span><b className="is-added">+{f.added}</b><b className="is-removed">−{f.removed}</b></li>)}
        {changes.more ? <li>and {changes.more} more</li> : null}
      </ul>
    </details>
  )
}

/** A report: how it ended and when, the first lines of what it said (all of it on a click), its changes, Dismiss. */
function ReportOf({ report, merged, now, dismiss, title }: { report: Report; merged?: boolean | null; now: number; dismiss(): void; title?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`staff-board__report is-${report.outcome}`}>
      <div className="staff-board__line">
        {title}
        <span className="staff-board__outcome">{OUTCOME[report.outcome]} {now - report.at < 60_000 ? 'just now' : `${ago(now - report.at)} ago`}</span>
        <IconButton label="Dismiss" onClick={dismiss}><XIcon /></IconButton>
      </div>
      {report.answer && (open
        ? <div className="staff-board__said is-open" onClick={() => setOpen(false)}><Markdown text={report.answer} /></div>
        : <div className="staff-board__said" title="Show all" onClick={() => setOpen(true)}>{report.answer.replace(/\n\s*\n/g, '\n')}</div>)}
      {report.changes?.files.length ? <div className="staff-board__meta"><ChangesOf changes={report.changes} /><span>{merge(merged ?? report.merged).slice(3)}</span></div> : null}
    </div>
  )
}

function BoardPane({ machine, thread }: PaneProps) {
  const dispatch = useDispatch()
  const connected = machine.state === 'connected'
  const all = useThreads(machine.id)
  const board = useValue<Board>(machine.id, connected, 'staff.board')
  const children = useMemo(() => (all ?? []).filter((t) => t.parent === thread.id && !t.archived).sort((a, b) => b.createdAt - a.createdAt), [all, thread.id])
  const mine = board?.[thread.id]
  const reports = mine?.reports ?? []
  const reportOf = new Map(reports.map((r) => [r.id, r]))
  // Reports of children archived since: their own section.
  const gone = reports.filter((r) => !children.some((c) => c.id === r.id))
  const dismiss = (child?: string) => void dispatch('staff.dismiss', { id: thread.id, ...(child ? { child } : {}) }, { machine: machine.id })
  const [details, setDetails] = useState<Record<string, Details>>({})
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 20_000); return () => clearInterval(t) }, [])
  // Again whenever a child moves on.
  const changed = [...children.map((c) => `${c.id}:${c.activeAt}:${c.status.state}`), ...reports.map((r) => `${r.id}:${r.at}`)].join(',')
  useEffect(() => {
    if (!connected) return
    let live = true
    call<Details[]>(machine.id, 'staff.details', { id: thread.id }).then((list) => { if (live) setDetails(Object.fromEntries(list.map((d) => [d.id, d]))) }, () => {})
    return () => { live = false }
  }, [machine.id, connected, thread.id, changed])

  const running = children.filter((c) => c.status.state === 'working' || c.status.state === 'blocked').length
  if (!children.length && !mine?.queued.length && !reports.length) return <div className="pane-empty">No threads started yet.</div>
  return (
    <div className="staff-board">
      <PaneHeader>
        <span className="staff-board__count">{running} running{mine?.queued.length ? ` · ${mine.queued.length} queued` : ''}{reports.length ? ` · ${reports.length} ${reports.length === 1 ? 'report' : 'reports'}` : ''}</span>
        {reports.length > 1 && <button type="button" className="staff-board__all" onClick={() => dismiss()}>Dismiss all</button>}
      </PaneHeader>
      <ul>
        {children.map((child) => {
          const stalled = mine?.stalled[child.id]
          const d = details[child.id]
          const tree = (child.ext?.worktrees ?? (child as { worktree?: unknown }).worktree) as { branch: string; removed?: boolean } | undefined
          const report = reportOf.get(child.id)
          const changes = mine?.changes?.[child.id] ?? report?.changes
          const idle = child.status.state === 'idle' || child.status.state === 'done' || child.status.state === 'error'
          return (
            <li key={child.id} className={stalled ? 'is-stalled' : ''}>
              <div className="staff-board__line">
                <ThreadRef machine={machine.id} id={child.id} className="staff-board__title" />
                <span className="staff-board__state">{stateOf(child.status)}</span>
                <span className="staff-board__ago" title="Since its last step">{ago(now - child.activeAt)}</span>
                {idle && <IconButton label="Archive" onClick={() => void dispatch('thread.archive', { id: child.id }, { machine: machine.id })}><ArchiveIcon /></IconButton>}
              </div>
              {stalled && <div className="staff-board__stall">Stalled {ago(now - stalled.since)}{stalled.call ? ` in ${stalled.call.replace(/`/g, '')}` : ''}</div>}
              <div className="staff-board__meta">
                {tree ? <span>{tree.branch.replace(/^superego\//, '')}{merge(d?.merged)}</span> : <span>in place</span>}
                {changes?.files.length ? <ChangesOf changes={changes} /> : null}
                {!report && d?.answer && child.status.state !== 'working' && <span className="staff-board__answer">{d.answer}</span>}
              </div>
              {report && <ReportOf report={{ ...report, changes: undefined }} now={now} dismiss={() => dismiss(child.id)} />}
            </li>
          )
        })}
        {gone.length > 0 && <li className="staff-board__heading">Reports</li>}
        {gone.map((report) => (
          <li key={`r${report.id}`}>
            <ReportOf
              report={report} merged={details[report.id]?.merged} now={now} dismiss={() => dismiss(report.id)}
              title={<ThreadRef machine={machine.id} id={report.id} className="staff-board__title">{report.title}</ThreadRef>}
            />
          </li>
        ))}
        {mine?.queued.map((q, i) => (
          <li key={`q${i}`} className="is-queued">
            <div className="staff-board__line">
              <span className="staff-board__dot" />
              <span className="staff-board__title">{q.title}</span>
              <span className="staff-board__state">queued</span>
              <span className="staff-board__ago">{ago(now - q.at)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default defineUiExtension({
  name: 'staff-board',
  setup(superego) {
    superego.pane('staff-board', { title: 'Board', component: BoardPane, menu: true })
    const style = document.createElement('style')
    style.dataset.profile = 'chief-of-staff'
    style.textContent = `
      .staff-board { flex: 1; min-height: 0; overflow: auto; padding: var(--superego-space-2) var(--superego-space-3); }
      .staff-board > ul { list-style: none; margin: 0; padding: 0; }
      .staff-board > ul > li { padding: var(--superego-space-2) 0; border-bottom: 1px solid var(--superego-border); }
      .staff-board > ul > li:last-child { border-bottom: 0; }
      .staff-board__count { color: var(--superego-muted); font-size: 12px; }
      .staff-board__line { display: flex; align-items: center; gap: 8px; min-height: 24px; }
      .staff-board__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .staff-board__state, .staff-board__ago { color: var(--superego-muted); font-size: 12px; white-space: nowrap; }
      .staff-board__ago { min-width: 3.5em; text-align: right; font-variant-numeric: tabular-nums; }
      .staff-board__meta { display: flex; gap: 10px; margin-left: 18px; color: var(--superego-faint); font-size: 12px; min-width: 0; }
      .staff-board__meta span { white-space: nowrap; }
      .staff-board__answer { overflow: hidden; text-overflow: ellipsis; color: var(--superego-muted); }
      .staff-board__stall { margin-left: 18px; font-size: 12px; color: #c47f17; }
      .staff-board__dot { width: 8px; height: 8px; border-radius: 50%; border: 1px dashed var(--superego-faint); }
      .staff-board li.is-queued .staff-board__title { color: var(--superego-muted); }
      .staff-board__all { margin-left: auto; border: 0; background: none; padding: 0 4px; color: var(--superego-muted); font: inherit; font-size: 12px; cursor: pointer; }
      .staff-board__all:hover { color: var(--superego-text, inherit); }
      .staff-board li.staff-board__heading { padding: var(--superego-space-3) 0 var(--superego-space-1); color: var(--superego-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
      .staff-board__report { margin: 6px 0 0 18px; padding-left: 8px; border-left: 2px solid var(--superego-border); }
      .staff-board__report.is-error { border-left-color: #c4453a; }
      .staff-board__report.is-question { border-left-color: #c47f17; }
      li > .staff-board__report:first-child { margin: 0; padding-left: 0; border-left: 0; }
      .staff-board__outcome { flex: 1; color: var(--superego-muted); font-size: 12px; white-space: nowrap; }
      li > .staff-board__report:first-child .staff-board__outcome { flex: none; }
      .staff-board__said { font-size: 12px; color: var(--superego-muted); white-space: pre-wrap; cursor: pointer;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .staff-board__said.is-open { display: block; white-space: normal; color: inherit; }
      .staff-board__report .staff-board__meta { margin-left: 0; margin-top: 4px; }
      .staff-board__changes[open] { flex-basis: 100%; }
      .staff-board__changes summary { cursor: pointer; white-space: nowrap; list-style: none; }
      .staff-board__changes summary::-webkit-details-marker { display: none; }
      .staff-board__changes b { font-weight: normal; font-variant-numeric: tabular-nums; }
      .staff-board__changes .is-added { color: #3a9a5b; }
      .staff-board__changes .is-removed { color: #c4453a; }
      .staff-board__changes ul { list-style: none; padding: 0; margin: 4px 0 2px; font-family: var(--superego-mono); font-size: 11px; }
      .staff-board__changes li { display: flex; gap: 8px; padding: 1px 0; border: 0; }
      .staff-board__changes li span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .staff-board__meta { flex-wrap: wrap; }
    `
    document.head.querySelector('style[data-profile="chief-of-staff"]')?.remove()
    document.head.append(style)
  },
})
