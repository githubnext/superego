// github, UI half: a thread's pull requests, drawn from its facts (so a phone or a browser sees what the desktop does,
// never asking GitHub itself). In the title bar, a chip: the leading pull request's glyph, number and road to merge,
// opening a menu (shown beside, on GitHub, in a Browser pane, its URL copied, asked about now, detached; on a phone,
// rows of the thread's sheet). On its row in
// the sidebar, its glyph with a dot for its checks, spelled out on the row's card with the road; in thread details,
// every one with how it came. Its own pane (`pull-request`). A pull request's URL in a message drawn with its state,
// ⌘-click showing it beside. In ⌘K: attach one, show the thread's, go to any thread's. Settings: this machine's gh.
// What happened to it (checks failed, a review, merged), the daemon half's notices in the thread: drawn here, a glyph
// and a headline. Watch… (the chip's menu) wakes the thread's agent when its checks finish or it's reviewed.
import { useState } from 'react'
import {
  copyText, defineAction, defineUiExtension, Dialog, type EntryProps, factsOf, hasWebViews, HeaderChip, Menu, Picker, PromptDialog, score, ThreadBadge, ThreadMenuItem, useAllThreads,
  useDispatch, useMachines, useNarrow, useSelection, type LinkProps, type MachineEntry, type SettingsComponentProps, type SlotProps, type Store, type ThreadInfo, type UiApi,
  type WindowContext,
} from '@superego/app/ui'
import { ArrowClockwiseIcon, ArrowSquareOutIcon, BellIcon, Button, CopyIcon, GitPullRequestIcon, GlobeIcon, LinkBreakIcon, Switch } from '@superego/ui'
import { CheckGlyph, CommentGlyph, PrGlyph, PrMark, Road } from './glyphs.tsx'
import { PullRequestPane } from './pane.tsx'
import {
  about, ATTACH, DETACH, howWord, lead, NOTICE, PANE, parsePr, problemText, REFRESH, road, SECTION, spell, UNWATCH, WATCH, watchWord, word,
  type GhStatus, type GithubFacts, type NoticeData, type PrFact, type PrSummary, type Watch,
} from './shared.ts'
import './styles.css'

/** A thread's pull requests, newest first. */
export const prsOf = (thread: ThreadInfo): PrFact[] => factsOf<GithubFacts>(thread, about)?.prs ?? []

/**
 * What's open now: the Attach prompt (for a thread, with the URL it starts with), the Watch dialog (for a thread's pull
 * request), the Go to picker, or what failed.
 */
type Asking = { attach?: { machine: string; thread: string; url: string }; watch?: { machine: string; thread: string; pr: PrFact }; going?: boolean; failed?: string }

let api: UiApi
let asking: Store<Asking>

/** The pull request's URL on the clipboard, if that's what's there; nothing when it can't be read. */
async function clipboardPr(): Promise<string> {
  try {
    const text = await navigator.clipboard?.readText()
    return text && parsePr(text) ? parsePr(text)!.url : ''
  } catch {
    // Not allowed to read it here (a browser asks first, or says no): the prompt starts empty instead.
    return ''
  }
}
const askAttach = async (machine: string, thread: string) => asking.set({ attach: { machine, thread, url: await clipboardPr() } })

/** Run an action, its failure in the console and, through the promise, to whoever shows it. */
const run = (id: string, params: Record<string, unknown>, machine: string) => api.dispatch(id, params, { machine })
/** Something done from a menu: what went wrong said in the console and in a dialog. */
const reported = (work: Promise<unknown>, what: string) => {
  work.catch((error: Error) => { console.error(`github: ${what} failed:`, error); asking.set({ failed: `${what} failed: ${error.message}` }) })
}

/** Show a pull request beside a thread. */
export const showPr = (machine: string, thread: string, url: string) =>
  reported(run('pane.open', { thread, kind: PANE, params: { url } }, machine), 'Showing the pull request')
const onGitHub = (url: string) => { window.open(url, '_blank', 'noopener,noreferrer') }

export default defineUiExtension({
  ...about,
  setup(superego) {
    api = superego
    asking = superego.store<Asking>('asking', {})
    superego.pane(PANE, {
      title: (pane) => { const ref = parsePr(String((pane.params as { url?: string } | undefined)?.url ?? '')); return ref ? `#${ref.number}` : 'Pull request' },
      icon: GitPullRequestIcon, component: PullRequestPane,
    })
    superego.slot('header.chips', PrChip)
    superego.slot('thread.badge', PrRowMark)
    superego.slot('thread.menu', PrMenuItems)
    superego.slot('details.section', PrDetails)
    superego.slot('overlay', Asks)
    superego.settings(SECTION, GhSection)
    superego.entry(NOTICE, PrNotice)
    superego.link({
      match: (href, kind) => kind === 'link' && Boolean(parsePr(href)),
      render: PrLink,
      open(href, { beside, machine, thread }) {
        const ref = parsePr(href)!
        if (beside && machine && thread && !thread.without?.includes(about.name)) return run('pane.open', { thread: thread.id, kind: PANE, params: { url: ref.url } }, machine).then(() => undefined, (error: Error) => error.message)
        onGitHub(href)
        return undefined
      },
      target: (href) => { const ref = parsePr(href)!; return `${ref.owner}/${ref.repo}#${ref.number}` },
    })
    const shown = (c: WindowContext) => c.selection && c.threadOf(c.selection)
    superego.action(defineAction({
      id: 'github.attach-prompt', title: 'Attach pull request…',
      when: (c) => Boolean(shown(c) && !shown(c)!.without?.includes(about.name)),
      run: async (_p, c) => { if (c.selection) await askAttach(c.selection.machine, c.selection.thread) },
    }))
    superego.action(defineAction({
      id: 'github.show', title: 'Show pull request',
      when: (c) => Boolean(shown(c) && prsOf(shown(c)!).length),
      run: (_p, c) => { const t = c.selection && c.threadOf(c.selection); const pr = t && lead(prsOf(t)); if (pr) showPr(c.selection!.machine, t.id, pr.url) },
    }))
    superego.action(defineAction({ id: 'github.go', title: 'Go to pull request…', run: () => asking.set({ going: true }) }))
  },
})

// ── Title bar ────────────────────────────────────────────────────────────────────────────────────────────────────
/** What a pull request's tooltip says: spelled out, and what's wrong. */
const tooltip = (pr: PrSummary, machine: MachineEntry) =>
  [pr.title ? `${pr.repo}#${pr.number}: ${pr.title}` : `${pr.repo}#${pr.number}`, spell(pr), pr.error && problemText(pr.error, machine.id === 'local' ? 'this machine' : machine.label)].filter(Boolean).join('\n')

/** The leading pull request: its glyph, number and road, `+N` for others; pressed, a menu of what to do with it. */
function PrChip({ machine, thread }: SlotProps['header.chips']) {
  const narrow = useNarrow()
  const prs = prsOf(thread)
  const first = lead(prs)
  if (!first) return null
  const others = prs.filter((p) => p !== first)
  // On a phone, the chip's menu is rows of the thread's sheet under it: no head, no separators.
  const menu = <>
    {!narrow && <><PrMenuHead pr={first} machine={machine} /><Menu.Separator /></>}
    <PrActions machine={machine} thread={thread} pr={first} separated={!narrow} />
    {others.map((pr) => (
      <ThreadMenuItem key={pr.key} icon={GitPullRequestIcon} onClick={() => showPr(machine.id, thread.id, pr.url)}>Show #{pr.number}: {word(pr)}</ThreadMenuItem>
    ))}
  </>
  return (
    <HeaderChip title={tooltip(first, machine)} menu={menu}>
      <span className={`github-chip${first.state === 'closed' ? ' is-closed' : ''}`} aria-label={`Pull request: ${spell(first)}`}>
        <PrGlyph state={first.state} size={13} />
        <span className="github-chip__n">#{first.number}</span>
        <Road pr={first} />
        {others.length > 0 && <span className="github-chip__more">+{others.length}</span>}
        {first.watch && <BellIcon className="github-chip__watch" size={12} aria-label={`Watching ${watchWord(first.watch)}`} />}
      </span>
    </HeaderChip>
  )
}

/** The menu's head: its title, then checks, review and merge, each how it stands. */
function PrMenuHead({ pr, machine }: { pr: PrSummary; machine: MachineEntry }) {
  const [checks, review, merge] = road(pr)
  const stage = (label: string, segment: string | undefined, said: string) => (
    <div className="github-menu__stage"><i className={`github-menu__dot is-${segment ?? 'todo'}`} /><span>{label}</span><span className="github-menu__said">{said}</span></div>
  )
  return (
    <div className="github-menu__head">
      <div className="github-menu__title">{pr.title || `${pr.repo}#${pr.number}`}</div>
      {pr.error && <div className="github-menu__problem">{problemText(pr.error, machine.id === 'local' ? 'this machine' : machine.label)}</div>}
      {pr.state === 'open' || pr.state === 'draft' ? <>
        {stage('Checks', checks, pr.checks === 'failing' ? `${pr.failing} failing` : pr.checks === 'none' ? 'none' : pr.checks)}
        {stage('Review', review, pr.review === 'changes' ? 'changes requested' : pr.review === 'approved' ? 'approved' : pr.review === 'required' ? 'required' : 'not required')}
        {stage('Merge', merge, pr.state === 'draft' ? 'draft' : pr.mergeable === 'conflicting' ? 'conflicts' : merge === 'ready' ? 'ready' : 'not yet')}
      </> : pr.state && <div className="github-menu__said">{word(pr)}</div>}
    </div>
  )
}

/** What to do with a pull request: the chip's menu (on a phone, rows of the thread's sheet). */
function PrActions({ machine, thread, pr, separated }: { machine: MachineEntry; thread: ThreadInfo; pr: PrFact; separated: boolean }) {
  return <>
    <ThreadMenuItem icon={GitPullRequestIcon} keys="github.show" onClick={() => showPr(machine.id, thread.id, pr.url)}>Show pull request</ThreadMenuItem>
    <ThreadMenuItem icon={ArrowSquareOutIcon} onClick={() => onGitHub(pr.url)}>Open on GitHub</ThreadMenuItem>
    {hasWebViews() && (
      <ThreadMenuItem icon={GlobeIcon} onClick={() => reported(run('pane.open', { thread: thread.id, kind: 'browser', params: { url: pr.url } }, machine.id), 'Opening it in a Browser pane')}>Open in Browser pane</ThreadMenuItem>
    )}
    <ThreadMenuItem icon={CopyIcon} onClick={() => reported(copyText(pr.url), 'Copying its URL')}>Copy URL</ThreadMenuItem>
    {separated && <Menu.Separator />}
    <ThreadMenuItem icon={ArrowClockwiseIcon} onClick={() => reported(run(REFRESH, { pr: pr.url }, machine.id), 'Refreshing it')}>Refresh</ThreadMenuItem>
    {(pr.state === 'open' || pr.state === 'draft' || pr.watch) && (
      <ThreadMenuItem icon={BellIcon} onClick={() => asking.set({ watch: { machine: machine.id, thread: thread.id, pr } })}>{pr.watch ? `Watching ${watchWord(pr.watch)}…` : 'Watch…'}</ThreadMenuItem>
    )}
    {separated && <Menu.Separator />}
    <ThreadMenuItem icon={LinkBreakIcon} onClick={() => reported(run(DETACH, { thread: thread.id, pr: pr.key }, machine.id), 'Detaching it')}>Detach</ThreadMenuItem>
  </>
}

// ── Sidebar ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** On its row: the leading pull request's glyph and checks; nothing for a closed one. Spelled out on its card, with the road. */
function PrRowMark({ machine, thread }: SlotProps['thread.badge']) {
  const pr = lead(prsOf(thread))
  if (!pr || pr.state === 'closed') return null
  const label = spell(pr)
  return (
    <ThreadBadge label={label} title={tooltip(pr, machine)} spelled={
      <span className="github-spelled"><PrMark pr={pr} size={12} /><span>#{pr.number}</span><Road pr={pr} /><span className="github-spelled__word">{word(pr).toLowerCase()}</span></span>
    }>
      <PrMark pr={pr} size={12} />
    </ThreadBadge>
  )
}

/** In its row's menu (and a phone's sheet): show it, open it on GitHub, detach it; attach one. */
function PrMenuItems({ machine, thread }: SlotProps['thread.menu']) {
  const pr = lead(prsOf(thread))
  if (thread.without?.includes(about.name)) return null
  return <>
    {pr && <ThreadMenuItem icon={GitPullRequestIcon} keys="github.show" onClick={() => showPr(machine.id, thread.id, pr.url)}>Show pull request #{pr.number}</ThreadMenuItem>}
    {pr && <ThreadMenuItem icon={ArrowSquareOutIcon} onClick={() => onGitHub(pr.url)}>Open #{pr.number} on GitHub</ThreadMenuItem>}
    {pr && <ThreadMenuItem icon={LinkBreakIcon} onClick={() => reported(run(DETACH, { thread: thread.id, pr: pr.key }, machine.id), 'Detaching it')}>Detach #{pr.number}</ThreadMenuItem>}
    <ThreadMenuItem icon={GitPullRequestIcon} keys="github.attach-prompt" onClick={() => void askAttach(machine.id, thread.id)}>Attach pull request…</ThreadMenuItem>
  </>
}

// ── Thread details ───────────────────────────────────────────────────────────────────────────────────────────────
/** Every pull request of the thread, with how it came. */
function PrDetails({ machine, thread }: SlotProps['details.section']) {
  const prs = prsOf(thread)
  if (!prs.length) return null
  return (
    <>
      <h5>Pull requests</h5>
      <ul className="github-details">
        {prs.map((pr) => (
          <li key={pr.key} title={tooltip(pr, machine)}>
            <button type="button" className="github-details__pr" onClick={() => showPr(machine.id, thread.id, pr.url)}>
              <PrMark pr={pr} size={13} />
              <span className="github-details__title">{pr.repo}#{pr.number}{pr.title ? ` ${pr.title}` : ''}</span>
            </button>
            <span className="github-details__said">{word(pr)} · {howWord[pr.how]}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

// ── Links in messages ────────────────────────────────────────────────────────────────────────────────────────────
/** Every thread's pull requests, on every machine the window reaches: which have this one, and how it stands. */
function useWhereIs(key: string | undefined) {
  const all = useAllThreads()
  const found: { machine: string; thread: ThreadInfo; pr: PrFact }[] = []
  if (!key) return found
  for (const [machine, threads] of Object.entries(all)) {
    for (const thread of threads ?? []) {
      const pr = prsOf(thread).find((p) => p.key === key)
      if (pr) found.push({ machine, thread, pr })
    }
  }
  return found
}

/** A pull request's URL in a message: its state's glyph before it, the threads that have it on hover. */
function PrLink({ href, children, title, attributes, open }: LinkProps) {
  const ref = parsePr(href)
  const where = useWhereIs(ref?.key)
  const pr = where[0]?.pr
  const said = [title, pr && spell(pr), where.length ? `On ${where.map((w) => `“${w.thread.title}”`).join(', ')}` : undefined, '⌘-click to show it beside'].filter(Boolean).join('\n')
  return (
    <a {...attributes} href={href} title={said} target="_blank" rel="noreferrer" className={['github-link', attributes?.className].filter(Boolean).join(' ')}
      onClick={(e) => { if (e.metaKey || e.ctrlKey) { e.preventDefault(); void open(true) } }}>
      {pr && <PrGlyph state={pr.state} size={12} />}{children}
    </a>
  )
}

// ── Asking ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** The Attach prompt and the Go to picker, while one is open. */
function Asks() {
  const now = asking.use()
  const close = () => asking.set({})
  if (now.attach) return <AttachPrompt {...now.attach} onClose={close} />
  if (now.watch) return <WatchDialog {...now.watch} onClose={close} />
  if (now.going) return <GoTo onClose={close} />
  if (now.failed) return <Dialog title="GitHub" onClose={close} footer={<Button variant="primary" onClick={close}>OK</Button>}>{now.failed}</Dialog>
  return null
}

function AttachPrompt({ machine, thread, url, onClose }: { machine: string; thread: string; url: string; onClose(): void }) {
  return (
    <PromptDialog title="Attach pull request" description="Its URL: its state then shows on this thread, and it's followed." placeholder="https://github.com/owner/repo/pull/123"
      defaultValue={url} confirmLabel="Attach" onClose={onClose}
      validate={(text) => parsePr(text) ? undefined : "That isn't a pull request's URL."}
      onSubmit={async (text) => { await run(ATTACH, { thread, url: text }, machine) }} />
  )
}

/**
 * Watch…: wake the thread's agent when the pull request's checks finish, when it's reviewed, or both; or stop. Saved
 * on the thread's machine; what fails said in the dialog.
 */
function WatchDialog({ machine, thread, pr, onClose }: { machine: string; thread: string; pr: PrFact; onClose(): void }) {
  const was: Watch = pr.watch ?? {}
  const [checks, setChecks] = useState(was.checks !== false)
  const [reviews, setReviews] = useState(pr.watch ? was.reviews !== false && was.until !== 'checks' : true)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string>()
  const act = (work: Promise<unknown>, what: string) => {
    setBusy(true)
    setFailed(undefined)
    work.then(onClose, (error: Error) => { console.error(`github: ${what} failed:`, error); setFailed(`${what} failed: ${error.message}`); setBusy(false) })
  }
  const save = () => act(run(WATCH, { thread, pr: pr.key, ...(checks ? {} : { checks: false }), ...(reviews ? {} : { reviews: false }) }, machine), 'Watching it')
  const stop = () => act(run(UNWATCH, { thread, pr: pr.key }, machine), 'Stopping')
  return (
    <Dialog title={`Watch #${pr.number}`} size="small" onClose={onClose} footer={<>
      {pr.watch && <Button variant="danger" disabled={busy} onClick={stop}>Stop watching</Button>}
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={busy || (!checks && !reviews)} onClick={save}>{pr.watch ? 'Save' : 'Watch'}</Button>
    </>}>
      <div className="github-watch">
        <p className="github-watch__say">Wake the agent, until it's merged or closed:</p>
        <div className="github-watch__row"><span>When its checks finish</span><Switch label="When its checks finish" checked={checks} onChange={setChecks} /></div>
        <div className="github-watch__row"><span>When it's reviewed</span><Switch label="When it's reviewed" checked={reviews} onChange={setReviews} /></div>
        {failed && <p className="github-watch__problem" role="alert">{failed}</p>}
      </div>
    </Dialog>
  )
}

// ── Notices ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** What happened to a pull request, as the daemon half told the thread: a glyph, a headline, a line of detail. */
function PrNotice({ entry }: EntryProps) {
  const data = entry.data as NoticeData
  const glyph = data.event === 'checks-failed' ? <CheckGlyph result="fail" size={14} />
    : data.event === 'checks-passed' ? <CheckGlyph result="pass" size={14} />
    : data.event === 'changes' ? <CommentGlyph size={14} tone="changes" />
    : data.event === 'approved' ? <CheckGlyph result="pass" size={14} />
    : data.event === 'comments' ? <CommentGlyph size={14} tone="quiet" />
    : <PrGlyph state={data.event === 'merged' ? 'merged' : 'closed'} size={14} />
  return (
    <div className={`github-notice is-${data.event}`}>
      <div className="github-notice__head">{glyph}<span>{data.headline}</span></div>
      {data.detail && <div className="github-notice__detail">{data.detail}</div>}
      {data.watched && <div className="github-notice__detail">Watching #{data.number}.</div>}
    </div>
  )
}

/** Every pull request the window's threads have, newest first: picked, its thread shown, the pull request beside. */
function GoTo({ onClose }: { onClose(): void }) {
  const all = useAllThreads()
  const machines = useMachines()
  const { select } = useSelection()
  const items = Object.entries(all).flatMap(([machine, threads]) => (threads ?? []).flatMap((thread) => prsOf(thread).map((pr) => ({ machine, thread, pr }))))
    .sort((a, b) => b.pr.at - a.pr.at)
  return (
    <Picker label="Go to pull request" placeholder="Pull requests, by number, title or repository" items={items} onClose={onClose}
      empty={items.length ? 'Nothing matches' : 'No thread has a pull request'}
      filter={(list, query) => query ? list.map((i) => ({ i, s: score(query, `#${i.pr.number} ${i.pr.title ?? ''} ${i.pr.repo} ${i.thread.title}`) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.i) : list}
      row={({ machine, thread, pr }) => ({
        key: `${machine}/${thread.id}/${pr.key}`, glyph: <PrMark pr={pr} size={13} />, title: `#${pr.number} ${pr.title ?? ''}`,
        detail: `${pr.repo} · ${thread.title}${machines.length > 1 ? ` · ${machines.find((m) => m.id === machine)?.label ?? machine}` : ''}`,
      })}
      onPick={({ machine, thread, pr }) => { onClose(); select({ machine, thread: thread.id }); showPr(machine, thread.id, pr.url) }} />
  )
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** This machine's gh: signed in as whom, or what's missing and how to fix it; asked again on a click. */
function GhSection({ target, section }: SettingsComponentProps) {
  const status = section.data as GhStatus | null | undefined
  const dispatch = useDispatch()
  const [checking, setChecking] = useState(false)
  const [failed, setFailed] = useState<string>()
  const check = () => {
    setChecking(true)
    setFailed(undefined)
    dispatch(REFRESH, {}, { machine: target }).catch((error: Error) => { console.error('github: checking gh failed:', error); setFailed(error.message) }).finally(() => setChecking(false))
  }
  return (
    <div className="github-settings">
      {!status ? <p className="github-settings__line">Looking for gh…</p>
        : !status.installed ? <p className="github-settings__line is-problem">gh isn't installed here: install it (<a href="https://cli.github.com" target="_blank" rel="noreferrer">cli.github.com</a>), then run <code>gh auth login</code>.</p>
        : status.hosts.length === 0 ? <p className="github-settings__line is-problem">gh {status.version} isn't signed in: run <code>gh auth login</code>.</p>
        : status.hosts.map((h) => (
          <p key={h.host} className={`github-settings__line${h.ok ? '' : ' is-problem'}`}>
            {h.ok ? <>Signed in as <b>{h.login}</b> on {h.host}</> : <>Not signed in on {h.host}{h.error ? `: ${h.error}` : ''}: run <code>gh auth login --hostname {h.host}</code></>}
            {status.version && h === status.hosts[0] && <span className="github-settings__version"> · gh {status.version}</span>}
          </p>
        ))}
      {status?.troubles?.map((t) => <p key={t} className="github-settings__line is-problem">{t}</p>)}
      {failed && <p className="github-settings__line is-problem">{failed}</p>}
      <Button onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</Button>
    </div>
  )
}
