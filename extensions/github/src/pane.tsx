// github, UI half: the `pull-request` pane, one pull request beside a thread. It leads with what to fix (failing checks,
// changes asked for, unresolved review comments, conflicts, in one list), then what's still running, with what's done
// folded away (checks passed, reviews that ask nothing); then its conversation, as GitHub's Conversation tab has it
// (comments and reviews with words, oldest first); and the threads that have it, on any machine. Its description under
// its title. Long ones are folded to a few lines. Its tab carries the road to merge. Drawn from the daemon's snapshot
// (`github.pr`, with the conversation), read again as the thread's summary of it changes.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  factsOf, Markdown, PaneButton, PaneHeader, PaneMessage, PaneNote, useAllThreads, useDispatch, useMachines, useMethod, useSelection, useTabNote,
  type PaneProps, type ThreadInfo,
} from '@superego/app/ui'
import { CheckGlyph, CommentGlyph, PrGlyph, Road } from './glyphs.tsx'
import { about, parsePr, problemText, REFRESH, PR, type Check, type Conversation, type GithubFacts, type PrDetail, type PrView, type Remark, type ReviewBy } from './shared.ts'

/** A check's time: "4m 41s", "38s". */
const took = (check: Check) => {
  if (check.startedAt === undefined || check.completedAt === undefined) return undefined
  const s = Math.max(0, Math.round((check.completedAt - check.startedAt) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
/** How long ago: "30s ago", "4m ago", "2h ago", "3d ago". */
const ago = (at: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What it comes to, in a sentence, with its words coloured: "2 checks failing and alice requested changes." */
function Summary({ pr }: { pr: PrDetail }) {
  if (pr.state === 'merged') return <><b className="github-word is-merged">Merged</b>.</>
  if (pr.state === 'closed') return <><b className="github-word is-closed">Closed</b> without merging.</>
  const asked = pr.reviews.filter((r) => r.verdict === 'changes').map((r) => r.who)
  const bits = [
    pr.checks === 'failing' && <b key="c" className="github-word is-fail">{plural(pr.failing, 'check')} failing</b>,
    asked.length > 0 && <b key="r" className="github-word is-changes">{asked.join(', ')} requested changes</b>,
    pr.mergeable === 'conflicting' && <b key="m" className="github-word is-fail">it conflicts with {pr.base ?? 'its base'}</b>,
  ].filter(Boolean)
  if (bits.length) return <>{bits.flatMap((b, i) => i === 0 ? [b] : [i === bits.length - 1 ? ' and ' : ', ', b])}.</>
  if (pr.state === 'draft') return <>A <b className="github-word is-draft">draft</b>{pr.checks === 'pending' ? ': checks running' : ''}.</>
  if (pr.checks === 'pending') return <><b className="github-word is-pending">Checks running</b>{pr.review === 'approved' ? ', approved' : ''}.</>
  if (pr.review === 'approved') return <><b className="github-word is-pass">Approved</b>{pr.checks === 'passing' ? ', checks passing: ready to merge' : ''}.</>
  return <>{pr.checks === 'passing' ? 'Checks passing; ' : ''}waiting for review.</>
}

/** A reviewer's verdict, in words. */
const verdictWord: Record<ReviewBy['verdict'], string> = { approved: 'Approved', changes: 'Changes requested', commented: 'Commented', dismissed: 'Dismissed', pending: 'Pending' }

export function PullRequestPane({ machine, thread, pane }: PaneProps) {
  const url = String((pane.params as { url?: string } | undefined)?.url ?? '')
  const ref = parsePr(url)
  // Read again whenever the thread's summary of it changes (the poller found something new).
  const summary = factsOf<GithubFacts>(thread, about)?.prs.find((p) => p.key === ref?.key)
  const { data, error, refetch } = useMethod<PrView>(machine.id, PR, { url, conversation: true }, { enabled: Boolean(ref), refresh: JSON.stringify(summary ?? null) })
  const dispatch = useDispatch()
  const [refreshing, setRefreshing] = useState<string | false>(false)
  const pr = data?.pr
  useTabNote(pr ? <Road pr={pr} small /> : null, pr ? `${pr.state}/${pr.checks}/${pr.review}/${pr.mergeable}` : '')
  if (!ref) return <PaneMessage>Not a pull request's URL: {url || '(none)'}</PaneMessage>
  if (error) return <PaneMessage>{error.message}</PaneMessage>
  if (!pr) return <PaneMessage>Loading…</PaneMessage>
  const refresh = () => {
    setRefreshing('…')
    dispatch(REFRESH, { pr: url }, { machine: machine.id })
      .then(() => { setRefreshing(false); refetch() }, (failed: Error) => { console.error('github: refreshing failed:', failed); setRefreshing(failed.message) })
  }
  const failing = pr.checkList.filter((c) => c.result === 'fail')
  const running = pr.checkList.filter((c) => c.result === 'pending')
  const passed = pr.checkList.filter((c) => c.result === 'pass' || c.result === 'skipped')
  const asked = pr.reviews.filter((r) => r.verdict === 'changes')
  const quiet = pr.reviews.filter((r) => r.verdict !== 'changes')
  const todo = failing.length + asked.length + pr.comments.length + (pr.mergeable === 'conflicting' ? 1 : 0)
  const live = pr.state === 'open' || pr.state === 'draft'
  const where = machine.id === 'local' ? 'this machine' : machine.label
  return (
    <div className="github-pane">
      <PaneHeader>
        <PaneNote>{pr.repo}</PaneNote>
        <PaneButton onClick={refresh} disabled={refreshing === '…'}>{refreshing === '…' ? 'Refreshing…' : 'Refresh'}</PaneButton>
        <PaneButton onClick={() => window.open(pr.url, '_blank', 'noopener,noreferrer')}>Open on GitHub</PaneButton>
      </PaneHeader>
      <div className="github-pane__body">
        <h1 className="github-pane__title">{pr.title || `${pr.repo}#${pr.number}`}</h1>
        <div className="github-pane__sub">
          <PrGlyph state={pr.state} size={13} />
          <span className={`github-word is-${pr.state ?? 'unknown'}`}>{pr.state ? pr.state[0]!.toUpperCase() + pr.state.slice(1) : 'Unknown'}</span>
          {pr.branch && <> · <code>{pr.branch}</code> → <code>{pr.base}</code></>}
        </div>
        {pr.error && <div className="github-pane__problem">{problemText(pr.error, where)}</div>}
        {typeof refreshing === 'string' && refreshing !== '…' && <div className="github-pane__problem">Refreshing failed: {refreshing}</div>}
        {data.conversation ? <Description text={data.conversation.body} />
          : <div className="github-pane__problem">Its description and conversation couldn't be fetched{pr.error ? '' : ': try Refresh'}.</div>}
        {pr.state && (
          <div className="github-pane__summary">
            <Road pr={pr} />
            <div><Summary pr={pr} /></div>
          </div>
        )}

        {live && todo > 0 && <>
          <h2 className="github-pane__h">To do <span>{todo}</span></h2>
          {failing.map((c) => (
            <div key={`check:${c.name}`} className="github-todo">
              <CheckGlyph result="fail" />
              <span className="github-todo__what">{c.name}</span>
              <span className="github-todo__end">{took(c)}</span>
              <small>Failed{c.url && <> · <a href={c.url} target="_blank" rel="noreferrer">its run</a></>}{c.runId && <> · <code>gh run view {c.runId} --log-failed</code></>}</small>
            </div>
          ))}
          {pr.mergeable === 'conflicting' && (
            <div className="github-todo"><CheckGlyph result="fail" /><span className="github-todo__what">Conflicts with {pr.base ?? 'its base'}</span><span /><small>Merge or rebase it to resolve them</small></div>
          )}
          {asked.map((r) => (
            <div key={`review:${r.who}`} className="github-todo">
              <CommentGlyph />
              <span className="github-todo__what">{r.who} requested changes</span>
              <span className="github-todo__end">{r.at ? ago(r.at) : ''}</span>
              {r.url && <small><a href={r.url} target="_blank" rel="noreferrer">the review</a></small>}
            </div>
          ))}
          {pr.comments.map((c, i) => (
            <div key={`comment:${i}`} className="github-todo">
              <CommentGlyph />
              <div className="github-todo__what github-todo__comment"><Markdown text={c.body} compact lines={4} /></div>
              <span />
              <small className="github-todo__where">
                {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.path}{c.line ? `:${c.line}` : ''}</a> : <>{c.path}{c.line ? `:${c.line}` : ''}</>}
                {' · '}{c.who}{c.outdated ? ' · outdated' : ''}
              </small>
            </div>
          ))}
        </>}

        {live && running.length > 0 && <>
          <h2 className="github-pane__h">Running <span>{running.length}</span></h2>
          {running.map((c) => (
            <div key={c.name} className="github-row"><CheckGlyph result="pending" /><span>{c.name}</span><span className="github-row__end">{c.startedAt ? `started ${ago(c.startedAt)}` : 'queued'}</span></div>
          ))}
        </>}

        {(passed.length > 0 || quiet.length > 0 || (!live && (failing.length > 0 || asked.length > 0))) && <h2 className="github-pane__h">Done</h2>}
        {!live && [...failing, ...running].map((c) => (
          <div key={c.name} className="github-row"><CheckGlyph result={c.result} /><span>{c.name}</span><span className="github-row__end">{took(c)}</span></div>
        ))}
        {passed.length > 0 && (
          <details className="github-fold">
            <summary><CheckGlyph result="pass" /> {plural(passed.length, 'check')} passed</summary>
            {passed.map((c) => (
              <div key={c.name} className="github-row">
                <CheckGlyph result={c.result} />
                {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : <span>{c.name}</span>}
                <span className="github-row__end">{c.result === 'skipped' ? 'skipped' : took(c)}</span>
              </div>
            ))}
          </details>
        )}
        {(live ? quiet : pr.reviews).map((r) => (
          <div key={r.who} className="github-row">
            <CommentGlyph tone={r.verdict === 'approved' ? 'approved' : r.verdict === 'changes' ? 'changes' : 'quiet'} />
            <span>{r.who}</span>
            <span className={`github-row__end${r.verdict === 'approved' ? ' github-word is-pass' : ''}`}>{verdictWord[r.verdict]}</span>
          </div>
        ))}

        {data.conversation && <Talk pr={pr} conversation={data.conversation} />}

        <Threads view={data} url={url} here={thread} machine={machine.id} />
        <div className="github-pane__meta">{pr.head && <>On <code>{pr.head.slice(0, 7)}</code> · </>}{pr.polledAt ? `updated ${ago(pr.polledAt)}` : 'not fetched yet'}</div>
      </div>
    </div>
  )
}

/**
 * Text folded to `height` (CSS) while it runs longer, "Show more" unfolding it. Measured as it changes (an image loaded,
 * the pane resized).
 */
function Folded({ height, children }: { height: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  useLayoutEffect(() => {
    const outer = box.current
    const content = inner.current
    if (!outer || !content || open) return
    const measure = () => setLong(content.scrollHeight > outer.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(content)
    watch.observe(outer)
    return () => watch.disconnect()
  }, [open])
  return <>
    <div ref={box} className={`github-folded${!open && long ? ' is-folded' : ''}`} style={open ? undefined : { maxHeight: height }}>
      <div ref={inner}>{children}</div>
    </div>
    {(long || open) && <button type="button" className="github-folded__more" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
  </>
}

/** Others' words as GitHub shows them: Markdown with its HTML (sanitized), each newline a break. */
const Words = ({ text }: { text: string }) => <Markdown text={text} html breaks compact />

/** Its description, under its title: folded to a few lines while long. */
function Description({ text }: { text: string }) {
  if (!text.trim()) return <div className="github-pane__none">No description.</div>
  return <div className="github-pane__description"><Folded height="12em"><Words text={text} /></Folded></div>
}

/** What a review said, as its remark's head says it. */
const reviewWord: Record<ReviewBy['verdict'], string> = { approved: 'approved', changes: 'requested changes', commented: 'reviewed', dismissed: 'reviewed (dismissed)', pending: 'reviewed' }

/** Its conversation, oldest first: who, when (a link to it on GitHub), what; those before it on GitHub, a link there. */
function Talk({ pr, conversation }: { pr: PrDetail; conversation: Conversation }) {
  const { remarks, earlier } = conversation
  if (!remarks.length && !earlier) return null
  return <>
    <h2 className="github-pane__h">Conversation <span>{remarks.length || ''}</span></h2>
    {earlier > 0 && <a className="github-talk__earlier" href={pr.url} target="_blank" rel="noreferrer">Earlier comments on GitHub</a>}
    {remarks.map((r, i) => <Said key={r.url ?? i} remark={r} />)}
  </>
}

function Said({ remark: r }: { remark: Remark }) {
  const when = r.at ? ago(r.at) : ''
  return (
    <div className={`github-talk${r.verdict ? ` is-review is-${r.verdict}` : ''}`}>
      <div className="github-talk__head">
        {r.verdict ? <CommentGlyph tone={r.verdict === 'approved' ? 'approved' : r.verdict === 'changes' ? 'changes' : 'quiet'} /> : <CommentGlyph tone="quiet" />}
        <b>{r.who}</b>
        {r.verdict && <span className={r.verdict === 'approved' ? 'github-word is-pass' : r.verdict === 'changes' ? 'github-word is-changes' : ''}>{reviewWord[r.verdict]}</span>}
        <span className="github-talk__when">{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{when || 'on GitHub'}</a> : when}</span>
      </div>
      {r.hidden ? <div className="github-pane__none">Hidden: {r.hidden}.</div> : <div className="github-talk__body"><Folded height="16em"><Words text={r.body} /></Folded></div>}
    </div>
  )
}

/** The threads that have it: on every machine the window reaches (by their facts), and this machine's archived ones. */
function Threads({ view, url, here, machine }: { view: PrView; url: string; here: ThreadInfo; machine: string }) {
  const all = useAllThreads()
  const machines = useMachines()
  const { select } = useSelection()
  const key = parsePr(url)?.key
  const live = Object.entries(all).flatMap(([machine, threads]) => (threads ?? [])
    .filter((t) => factsOf<GithubFacts>(t, about)?.prs.some((p) => p.key === key)).map((thread) => ({ machine, id: thread.id, title: thread.title, archived: false })))
  const archived = view.threads.filter((t) => t.archived && !live.some((l) => l.id === t.id)).map((t) => ({ machine, ...t }))
  const listed = [...live, ...archived]
  if (!listed.length) return null
  return <>
    <h2 className="github-pane__h">Threads</h2>
    {listed.map((t) => (
      <div key={`${t.machine}/${t.id}`} className="github-row">
        {t.id === here.id || t.archived ? <span>{t.title}</span> : <button type="button" className="github-row__link" onClick={() => select({ machine: t.machine, thread: t.id })}>{t.title}</button>}
        <span className="github-row__end">
          {t.id === here.id ? 'This thread' : t.archived ? 'Archived' : machines.length > 1 ? machines.find((m) => m.id === t.machine)?.label : ''}
        </span>
      </div>
    ))}
  </>
}
