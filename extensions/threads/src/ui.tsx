// threads: the Threads sidebar. The pinned threads first, from every project and machine, then projects (a
// repository or folder on a machine) and the threads in each, its pinned at its top; the machine is said on the project,
// where it isn't this computer (Pinned can be hidden from the ··· menu: they still top their projects). Pinned, each
// project and each thread with others under it fold, by their carets or ← and → (the folds are the window's:
// projects.ts). Its views:
// - the list (`threads.list`), a sidebar: sorted recently active, newest first, needs you first or alphabetically (an app
//   setting); with the sidebar hidden, a rail of status glyphs; the key to go anywhere (⌘L) beside its heading, while
//   pointed at; ⌃T puts the keyboard in it, on the selected thread's row (and again, back in the prompt). A row's title is followed by other extensions' marks (the `thread.badge` slot: a worktree's branch,
//   say); a right-click on it pins or unpins it, or archives it; on a phone, so does a swipe (swipe.tsx). Pinned rows are dragged to reorder them, and a
//   project's row dragged among them is pinned there. Pointed at or focused for a moment, a row (or a rail's dot) shows
//   a card of its thread (card.tsx). On a phone, a search field under its title narrows it to the threads that match,
//   archived ones too, as ⌘L finds them
// - details (`threads.details`): what the thread runs with, spent and touched, then what other extensions say of it (the
//   `details.section` slot: its MCP servers, say); beside it or not, ⌘I
// - the model (`threads.model`), in the title bar: its provider's mark, a button that shows or hides the details, and
//   pointed at, a card of the model (whose it is, its thinking, whose choice, what the thread has spent)
// It also draws the thread tools' rows and `thread:` links (rows.tsx); the tools themselves are thread-tools'.
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import {
  call, defineAction, defineUiExtension, fold, isPinned, listArchived, MachineDrift, useProjectSpaces, useSpace, search, shownRows, threadPath, useFold, useNarrow, RailButton, SHOW_PINNED, showProject, Slot, SORT, SpelledBadges, unreadList, useAppSetting, useDispatch, useLocalState, useMachines, usePlacement, useSelection, useProjects, useThreadView, useShell, useShortcut, useRailShortcut,
  type ArchivedThreads, type MachineEntry, type Pin, type Project, type ShownRow, type ShownSection, type Sort, type SidebarRailProps, type WindowContext,
} from '@superego/app/ui'
import { rollup, statusLabel, statusShape, unread, type ThreadInfo } from '@superego/protocol'
import { ArchiveIcon, CaretRightIcon, ChatsIcon, ContextMenu, DotsThreeIcon, Glyph, HOVER_DELAY, HoverCard, IconButton, List, ListItem, MagnifyingGlassIcon, Menu, PlusIcon, ProviderMark, providerOf, PushPinIcon, PushPinSlashIcon, SparkleIcon, StatusGlyph, StatusWord, Tooltip, TooltipProvider, XCircleIcon } from '@superego/ui'
import './styles.css'
import { ago } from './ago.ts'
import { ThreadCard } from './card.tsx'
import { registerLinks, registerRows } from './rows.tsx'
import { about } from './shared.ts'
import { useCoarse, useRowSwipe } from './swipe.tsx'

/** The list, the Threads sidebar; and the action that puts the keyboard in it. */
const LIST = 'threads.list'
const LIST_FOCUS = 'threads.focus'
/** The details view, and the action that puts it beside the thread or takes it away. */
const DETAILS = 'threads.details'
/** The shell's action that hides the sidebar, and shows it again: hidden, the list is dots in the rail. */
const SIDEBAR = 'app.sidebar'
/** How a project's machine is described while it isn't connected; anything else is offline. */
const STATE_WORDS: Partial<Record<MachineEntry['state'], string>> = { connecting: 'connecting…', 'needs-login': 'needs login', 'host-key': 'host key to check', disabled: 'off' }

/** Settings and commands act through the app's settings, so every window and the menu agree. */
const set = (c: Pick<WindowContext, 'dispatch'>, key: string, value: string | boolean) =>
  c.dispatch('app.settings.set', { key, value }, { machine: 'app', source: 'threads' })

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.view(LIST, { title: 'Threads', icon: ChatsIcon, context: 'window', fits: ['sidebar'], default: 'sidebar', component: ThreadsSidebar, railButton: ThreadsRail })
    superego.view(DETAILS, { title: 'Thread details', context: 'thread', fits: ['beside', 'pane'], component: DetailsPane })
    superego.view('threads.model', { title: 'Model', icon: SparkleIcon, context: 'thread', fits: ['header'], default: 'header', component: ModelButton, menuItem: ModelItem })
    registerRows(superego)
    registerLinks(superego)
    const action = (id: string, title: string, run: (c: WindowContext) => void, keys?: string) =>
      superego.action(defineAction({ id, title, ...(keys ? { keys } : {}), run: (_params, c) => run(c) }))
    action(DETAILS, 'Toggle thread details', (c) => void c.dispatch('layout.place', { view: DETAILS, place: 'beside' }, { source: 'threads' }), 'mod+i')
    for (const { value, label } of SORTS) action(`threads.sort.${value}`, `Sort threads: ${label.toLowerCase()}`, (c) => void set(c, SORT, value))
    // ⌘⌥↓ and ⌘⌥↑ too: the same step as thread.next and thread.previous, down the rows the sidebar shows.
    action('threads.next', 'Next thread', (c) => void c.dispatch('thread.next', {}, { source: 'threads' }), 'mod+alt+arrowdown')
    action('threads.previous', 'Previous thread', (c) => void c.dispatch('thread.previous', {}, { source: 'threads' }), 'mod+alt+arrowup')
    // ⌃T: the keyboard in the list, on the selected thread's row (the sidebar shown first); pressed there, back to the prompt.
    action(LIST_FOCUS, 'Focus threads list', (c) => {
      if (document.activeElement?.closest('.threads')) void c.dispatch('focus.prompt', {}, { source: 'threads' })
      else c.focusSidebar(LIST)
    }, 'ctrl+t')
    action('threads.collapse', 'Collapse all threads', (c) => c.fold([...c.sidebar.pinned.length ? [fold.pinned] : [], ...c.sidebar.projects.map(fold.project)], true))
    action('threads.expand', 'Expand all threads', (c) => c.fold(c.sidebar.folded, false))
  },
})

/** The list. Once a row's card has shown, the next row's shows at once. */
const ThreadsSidebar = () => <TooltipProvider delay={HOVER_DELAY}><Threads /></TooltipProvider>

function Threads() {
  const machines = useMachines().filter((m) => m.state !== 'disabled')
  const { projects, sidebar, lastThread, hold } = useProjects()
  const { selection, select } = useSelection()
  const lit = useLit()
  const shown = useMemo(() => shownRows(sidebar, selection), [sidebar, selection?.machine, selection?.thread])
  const setFold = useFold()
  // While the pointer is over the list, rows keep their places: a thread changing state doesn't move under it. The
  // order is held for the whole window, so ⌘⇧[ and ⌘⇧] go down the rows as they stand.
  useEffect(() => () => hold(false), [])

  // The machine is a fact about a project, said where it isn't this computer (or there are several to tell apart).
  const several = machines.length > 1
  const where = (project: Project) => project.machine.state !== 'connected'
    ? `${project.machine.label} · ${STATE_WORDS[project.machine.state] ?? 'offline'}`
    : several || project.machine.id !== 'local' ? project.machine.label : undefined
  const local = machines.find((m) => m.id === 'local')
  const ready = local?.state === 'connected'
  // On a phone, a search field under the title, as iOS lists have one: typed in, the list is the threads that match,
  // as ⌘L finds them (thread-search.ts), the archived after the rest (asked of each machine the first time it's
  // focused, for as long as the drawer's open).
  const narrow = useNarrow()
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState<ArchivedThreads>()
  const asked = useRef(false)
  const askArchived = () => {
    if (asked.current) return
    asked.current = true
    void listArchived(machines).then(setArchived)
  }
  const found = useMemo(() => search([
    ...projects.flatMap((project) => project.threads.map((thread) => ({ machine: project.machine, thread, project, path: threadPath(project.name, thread.title), title: thread.title }))),
    ...(archived?.threads ?? [])
      .filter(({ machine, thread }) => !projects.some((p) => p.machine.id === machine.id && p.threads.some((t) => t.id === thread.id)))
      .map(({ machine, thread }) => ({ machine, thread, archived: true, path: threadPath(thread.project.name, thread.title), title: thread.title })),
  ], query), [projects, archived, query])
  const searching = narrow && query.trim() !== ''

  return (
    <div className={`threads ${ready ? 'is-ready' : ''}`} data-focus-scope onPointerEnter={() => hold(true)} onPointerLeave={() => hold(false)}>
      <div className="threads__head">
        <span>Threads</span>
        <GoKeys />
        <span className="threads__actions">
          <Options />
          <NewThreadButton label="New thread…" />
        </span>
      </div>
      {narrow && projects.length > 0 && (
        <SearchField query={query} onQuery={setQuery} onFocus={askArchived}
          onGo={() => { const first = found[0]; if (first) select({ machine: first.machine.id, thread: first.thread.id }) }} />
      )}
      {searching
        ? <Found query={query} found={found} archived={archived} where={(project) => [project.name, where(project)].filter(Boolean).join(' · ')} />
        : <>
      {projects.length === 0 && <div className="threads__empty">{ready ? 'Start a thread in a folder to see its project here.' : local?.state === 'connecting' || !local?.error ? 'Connecting…' : local.error}</div>}
      {sidebar.pinned.length > 0 && <Pinned section={shown.pinned} where={(project) => [project.name, where(project)].filter(Boolean).join(' · ')} />}
      {shown.projects.map(({ project, ...section }) => (
        <section key={project.key} className={`threads-project ${project.machine.state !== 'connected' ? 'is-stale' : ''} ${section.folded ? 'is-folded' : ''}`}>
          <div className="threads-project__head" onKeyDown={foldKeys(section, setFold)}>
            <button className="threads-project__name" title={project.root} onClick={() => showProject({ select, lastThread }, project)}>
              {project.name}
              {where(project) && <em>{where(project)}</em>}
              {project.machine.remote && <MachineDrift machine={project.machine} />}
            </button>
            <Caret {...section} label={project.name} section />
            <NewThreadButton label={`New thread in ${project.name}`} machine={project.machine} cwd={project.root} />
          </div>
          {!section.folded && <ProjectSpaces machine={project.machine.id} root={project.root} />}
          {section.rows.length > 0 && (
            <List>
              {section.rows.map((row) => (
                <ThreadRow key={row.thread.id} machine={project.machine} thread={row.thread} row={row}
                  selected={lit(project.machine.id, row.thread.id)} />
              ))}
            </List>
          )}
        </section>
      ))}
      <Archived machines={machines} live={projects} />
      </>}
    </div>
  )
}

/**
 * Whether the thread `thread` on `machine` is lit as the selected one: not while a space is open, where only the space
 * is (its row under its project, its rail button).
 */
function useLit() {
  const { selection } = useSelection()
  const { space } = useSpace()
  return (machine: string, thread: string) => !space && selection?.machine === machine && selection.thread === thread
}

/** A project's spaces (its profiles' `superego.space`), above its threads: a row each, lit while it's open. */
function ProjectSpaces({ machine, root }: { machine: string; root: string }) {
  const spaces = useProjectSpaces({ machine, root })
  if (!spaces.length) return null
  return (
    <List className="threads-spaces">
      {spaces.map((space) => (
        <ListItem key={space.kind} selected={space.open} leading={<span className="threads__lead" aria-hidden>▦</span>} onClick={space.show} data-space={space.kind}>
          <span className="threads__title">{space.title}</span>
        </ListItem>
      ))}
    </List>
  )
}

/**
 * The phone's search field, as iOS draws one: a rounded, filled field with a magnifier and "Search"; typed in, a clear
 * button (×) at its end; while it's in use, Cancel beside it, which empties it and puts the keyboard away. Enter (the
 * keyboard's Search) opens the first match; Escape is Cancel. Always shown, under the title: iOS hides a list's field
 * until it's pulled down, but the drawer is short, and a field that's always there is one a reach finds.
 */
function SearchField({ query, onQuery, onFocus, onGo }: { query: string; onQuery(query: string): void; onFocus(): void; onGo(): void }) {
  const input = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const active = focused || query !== ''
  const cancel = () => { onQuery(''); setFocused(false); input.current?.blur() }
  // Pressed, the buttons leave the keyboard where it is: the field keeps the focus until they've done their work.
  const keepFocus = (event: { preventDefault(): void }) => event.preventDefault()
  return (
    <div className={`threads-search ${active ? 'is-active' : ''}`}>
      <label className="threads-search__field">
        <MagnifyingGlassIcon className="threads-search__glass" size={17} weight="bold" aria-hidden />
        <input ref={input} type="search" className="threads-search__input" placeholder="Search" aria-label="Search threads" value={query}
          enterKeyHint="search" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          onFocus={() => { setFocused(true); onFocus() }} onBlur={() => setFocused(false)} onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); onGo() }
            // Escape cancels the search, not the drawer.
            else if (event.key === 'Escape' && active) { event.preventDefault(); event.stopPropagation(); cancel() }
          }} />
        {query && (
          <button type="button" className="threads-search__clear" aria-label="Clear" onMouseDown={keepFocus}
            onClick={() => { onQuery(''); input.current?.focus() }}><XCircleIcon size={17} weight="fill" aria-hidden /></button>
        )}
      </label>
      {active && <button type="button" className="threads-search__cancel" onMouseDown={keepFocus} onClick={cancel}>Cancel</button>}
    </div>
  )
}

type Match = { machine: MachineEntry; thread: ThreadInfo; project?: Project; archived?: boolean }

/**
 * What a search found, best first: the threads in use as the list has them, saying where each is; then the archived,
 * under their heading, to open read only. Nothing found, iOS's empty search: no results, and what was searched for.
 */
function Found({ query, found, archived, where }: { query: string; found: Match[]; archived: ArchivedThreads | undefined; where(project: Project): string }) {
  const lit = useLit()
  const live = found.filter((match) => !match.archived)
  const put = found.filter((match) => match.archived)
  return (
    <section className="threads-found" aria-label="Search results">
      {live.length > 0 && (
        <List>
          {live.map(({ machine, thread, project }) => (
            <ThreadRow key={`${machine.id}/${thread.id}`} machine={machine} thread={thread} where={where(project!)}
              selected={lit(machine.id, thread.id)} />
          ))}
        </List>
      )}
      {put.length > 0 && (
        <div className="threads-archived is-open">
          <div className="threads-found__head">Archived</div>
          <List>{put.map(({ machine, thread }) => <ArchivedRow key={`${machine.id}/${thread.id}`} machine={machine} thread={thread} />)}</List>
        </div>
      )}
      {archived?.failed.map(({ machine, message }) => (
        <div key={machine.id} className="threads__empty threads-archived__error" role="alert">Couldn’t search {machine.label}’s archived threads: {message}</div>
      ))}
      {found.length === 0 && (archived
        ? <div className="threads-found__none" role="status"><strong>No Results for “{query.trim()}”</strong>Check the spelling or try a new search.</div>
        : <div className="threads-found__none" role="status">Searching…</div>)}
    </section>
  )
}

/** What a dragged row carries: its thread, as a pin. */
const DRAGGED = 'application/x-superego-thread'

/**
 * The pinned threads, from every project and machine, in the order they were pinned, each saying where it is. Dragged,
 * a row moves; a project's row dropped here is pinned where it's dropped.
 */
function Pinned({ section, where }: { section: ShownSection; where(project: Project): string }) {
  const { sidebar } = useProjects()
  const lit = useLit()
  const dispatch = useDispatch()
  const setFold = useFold()
  // The gap a drop would land in: before the row at this index (the count: after the last).
  const [gap, setGap] = useState<number>()
  const gapAt = (event: DragEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-pin]')
    if (!row) return sidebar.pinned.length
    const box = row.getBoundingClientRect()
    return Number(row.dataset.pin) + (event.clientY > box.top + box.height / 2 ? 1 : 0)
  }
  const over = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(DRAGGED)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setGap(gapAt(event))
  }
  const drop = (event: DragEvent) => {
    const raw = event.dataTransfer.getData(DRAGGED)
    setGap(undefined)
    if (!raw) return
    event.preventDefault()
    const pin = JSON.parse(raw) as Pin
    // Where it lands among the others: past its own place, one less.
    const from = sidebar.pinned.findIndex(({ project, thread }) => project.machine.id === pin.machine && thread.id === pin.thread)
    const to = gapAt(event)
    const at = from >= 0 && from < to ? to - 1 : to
    if (from === at) return
    void dispatch('thread.pin', { ...pin, at }, { source: 'threads' }).catch((error) => console.error(error))
  }
  return (
    <section className={`threads-project threads-pinned ${section.folded ? 'is-folded' : ''}`} onDragOver={over} onDrop={drop} onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setGap(undefined)
    }}>
      <div className="threads-project__head" onKeyDown={foldKeys(section, setFold)}>
        <button className="threads-project__name" onClick={() => setFold([section.fold], !section.folded)}>Pinned</button>
        <Caret {...section} label="Pinned" section />
      </div>
      {section.rows.length > 0 && (
        <List>
          {/* Folded, only the selected one shows, and it isn't a place to drop. */}
          {section.rows.map(({ project, thread }, index) => (
            <ThreadRow key={`${project.machine.id}/${thread.id}`} machine={project.machine} thread={thread} where={where(project)}
              selected={lit(project.machine.id, thread.id)}
              className={`${project.machine.state !== 'connected' ? 'is-stale' : ''} ${!section.folded && gap === index ? 'is-drop-before' : ''} ${!section.folded && gap === index + 1 && index === section.rows.length - 1 ? 'is-drop-after' : ''}`}
              {...(section.folded ? {} : { 'data-pin': index })} />
          ))}
        </List>
      )}
    </section>
  )
}

/**
 * A thread's row, as a mail app has it: unread, its title semibold with a mark before it (a dot for done, a target for a
 * question or permission, a cross for failed), and a spinner before it while it works; at the end, what it waits on in
 * a word (Question, Permission, Sign in, Failed), or when it was last active (in the accent while unread). Folded, the end sums up
 * the threads under it (`Rollup`). Its marks (`thread.badge`) follow the title; among the pinned, where it is too;
 * under its project, pinned, a pin. The marks and where it is are `threads__more`: in the sidebar no box of its own; on
 * the phone the row's second line, each mark spelled out (the branch's name, not only its icon). A right-click pins or unpins it, or archives it; it can be dragged into the pinned.
 */
function ThreadRow({ machine, thread, selected, row, where, className = '', ...data }: {
  machine: MachineEntry; thread: ThreadInfo; selected: boolean; row?: ShownRow; where?: string; className?: string; 'data-pin'?: number
}) {
  const level = row?.depth ?? 0
  const setFold = useFold()
  const { select } = useSelection()
  const { pins } = useProjects()
  const dispatch = useDispatch()
  const archiveKeys = useShortcut('thread.archive')
  const at = { machine: machine.id, thread: thread.id }
  const on = isPinned(pins, at)
  const shape = statusShape(thread.status, thread.quiet)
  const run = (id: string, options: { machine?: string } = {}) => () =>
    dispatch(id, id === 'thread.archive' ? { thread: thread.id } : at, { source: 'threads', ...options }).catch((error) => console.error(error))
  const pin = run(on ? 'thread.unpin' : 'thread.pin')
  const archive = run('thread.archive', { machine: machine.id })
  // On a phone, under a finger: swiped right, Pin (or Unpin); left, More (the thread's sheet) and Archive, a full swipe's.
  const { threadMenu } = useShell()
  const narrow = useNarrow()
  const finger = useCoarse()
  const badges = <Slot name="thread.badge" props={{ machine, thread }} />
  const swipe = useRowSwipe({
    on: narrow && finger,
    leading: [{ id: 'pin', label: on ? 'Unpin' : 'Pin', icon: on ? PushPinSlashIcon : PushPinIcon, tone: 'pin', run: pin }],
    trailing: [
      { id: 'archive', label: 'Archive', icon: ArchiveIcon, tone: 'archive', run: archive, leaves: true },
      { id: 'more', label: 'More', icon: DotsThreeIcon, tone: 'more', run: () => threadMenu(at) },
    ],
  })
  return (
    <ContextMenu.Root onOpenChange={(open, details) => { if (open && swipe.swiped()) details.cancel() }}>
      <ContextMenu.Trigger>
        <HoverCard card={<ThreadCard machine={machine} thread={thread} {...(row?.folded ? { tucked: row.tucked } : {})} />}>
          <ListItem selected={selected} leading={<span className="threads__lead">{LEADS.has(shape) && <StatusGlyph status={thread.status} quiet={thread.quiet} />}</span>} draggable {...data} data-depth={level}
            {...(row?.fold ? { 'aria-expanded': !row.folded } : {})} onKeyDown={(event) => rowKeys(event, row, setFold)}
            {...swipe.rowProps} className={`${level ? 'threads-child' : ''} ${row?.folded ? 'is-folded' : ''} ${swipe.rowProps.className ?? ''} ${className}`} {...(level ? { style: { '--depth': level } as CSSProperties } : {})}
            onDragStart={(event) => { event.dataTransfer.setData(DRAGGED, JSON.stringify(at)); event.dataTransfer.effectAllowed = 'move' }}
            trailing={(row?.folded && rolledUp([thread, ...row.tucked])) || <RowEnd thread={thread} />}
            onClick={() => select(at)}>
            <span className={`threads__title ${unread(thread) ? 'is-unread' : ''}`}>{thread.title}</span>
            {row?.fold && <Caret fold={row.fold} folded={row.folded} tucked={row.tucked} label={thread.title} />}
            {on && !where && <PushPinIcon className="threads__pin" size={11} weight="fill" aria-label="Pinned" />}
            <span className="threads__more">
              {narrow ? <SpelledBadges>{badges}</SpelledBadges> : badges}
              {where && <em className="threads-pinned__where">{where}</em>}
            </span>
            {swipe.actions}
          </ListItem>
        </HoverCard>
      </ContextMenu.Trigger>
      <ContextMenu.Popup className="threads-row-menu">
        <Menu.Item onClick={pin}>{on ? 'Unpin' : 'Pin'}</Menu.Item>
        <Menu.Item onClick={archive} hint={archiveKeys}>Archive</Menu.Item>
      </ContextMenu.Popup>
    </ContextMenu.Root>
  )
}

/** The states a row marks before its title: those that want a look, and working. */
const LEADS = new Set(['working', 'done', 'question', 'permission', 'error'])

/** The end of a thread's row: what it waits on in a word, or when it was last active. */
function RowEnd({ thread }: { thread: ThreadInfo }) {
  const shape = statusShape(thread.status, thread.quiet)
  if (shape === 'working' || shape === 'idle' || shape === 'done') return <span className={shape === 'done' ? 'threads__ago is-new' : 'threads__ago'}>{ago(thread.activeAt)}</span>
  return <StatusWord status={thread.status} />
}

/**
 * Threads out of sight, summed up where they're folded: a spinner (grey) while any of them works, then the most pressing
 * word (Question, Permission, Failed) or how many are new. Nothing when they're all quiet.
 */
function rolledUp(threads: ThreadInfo[]) {
  const working = threads.some((t) => t.status.state === 'working')
  const wanting = threads.filter(unread)
  const top = rollup(wanting.map((t) => t.status))
  const said = top.state === 'blocked' || top.state === 'error' ? <StatusWord status={top} /> : wanting.length ? <span className="threads-rollup__new">{wanting.length} new</span> : null
  if (!working && !said) return null
  return <span className="threads-rollup">{working && <Glyph shape="working" quiet label="Working" className="threads-rollup__spin" />}{said}</span>
}

/**
 * The caret that folds a section, or the threads under a thread; shown on hover, and while folded. A folded section
 * sums up what's out of sight after it (`rolledUp`), or says how many; a thread's row does at its end.
 */
function Caret({ fold: key, folded, tucked, label, section = false }: { fold: string; folded: boolean; tucked: ThreadInfo[]; label: string; section?: boolean }) {
  const setFold = useFold()
  return (
    <>
      <button type="button" tabIndex={-1} className="threads-caret" aria-expanded={!folded} aria-label={`${folded ? 'Expand' : 'Collapse'} ${label}`}
        onClick={(event) => { event.stopPropagation(); setFold([key], !folded) }}>
        <CaretRightIcon size={10} weight="bold" aria-hidden />
      </button>
      {section && folded && tucked.length > 0 && (
        <span className="threads-tucked">{rolledUp(tucked) ?? tucked.length}</span>
      )}
    </>
  )
}

/** ← and → on a section's heading: fold it, unfold it. */
const foldKeys = (section: ShownSection, setFold: (keys: readonly string[], folded: boolean) => void) => (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
  event.preventDefault()
  setFold([section.fold], event.key === 'ArrowLeft')
}

/**
 * ← and → on a thread's row, as in a tree: ← folds the threads under it, or (none, or folded) goes to the thread it's
 * under, or its section's heading; → unfolds them, or goes to the first.
 */
function rowKeys(event: KeyboardEvent<HTMLLIElement>, row: ShownRow | undefined, setFold: (keys: readonly string[], folded: boolean) => void) {
  if (!row || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  const li = event.currentTarget
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    if (row.fold && !row.folded) return setFold([row.fold], true)
    let above = li.previousElementSibling as HTMLElement | null
    while (above && Number(above.dataset.depth) >= row.depth) above = above.previousElementSibling as HTMLElement | null
    ;(above ?? li.closest('section')?.querySelector<HTMLElement>('.threads-project__name'))?.focus()
  } else if (event.key === 'ArrowRight' && row.fold) {
    event.preventDefault()
    if (row.folded) return setFold([row.fold], false)
    ;(li.nextElementSibling as HTMLElement | null)?.focus()
  }
}

/** The key that goes to any project, thread or pane (the shell's navigator): a faint keycap, shown while pointed at. */
function GoKeys() {
  const dispatch = useDispatch()
  const keys = useShortcut('app.navigator')
  if (!keys) return null
  return (
    <button type="button" className="threads__go" title="Go to a project, thread or pane"
      onClick={() => void dispatch('app.navigator', {}, { source: 'threads' }).catch((error) => console.error(error))}>{keys}</button>
  )
}

/**
 * Threads put away, from every machine and project in one list, newest activity first; closed until opened. Picking one
 * shows it, read only; its Unarchive button brings it back.
 */
function Archived({ machines, live }: { machines: MachineEntry[]; live: Project[] }) {
  const [open, setOpen] = useLocalState('threads.archived.open', false)
  const [threads, setThreads] = useState<{ machine: MachineEntry; thread: ThreadInfo }[]>()
  // The machines that couldn't say theirs, and why: said where the list is, the rest listed.
  const [failed, setFailed] = useState<{ machine: MachineEntry; error: string }[]>([])
  const connected = machines.filter((m) => m.state === 'connected')
  // Asked again whenever the threads in use change: archiving one moves it here, unarchiving moves it back.
  const inUse = live.flatMap((s) => s.threads.map((t) => `${s.machine.id}/${t.id}`)).sort().join(' ')
  const asked = connected.map((m) => m.id).join(' ')
  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.allSettled(connected.map((machine) => call<ThreadInfo[]>(machine.id, 'thread.list', { archived: true })
      .then((list) => list.map((thread) => ({ machine, thread })))))
      .then((results) => {
        if (!alive) return
        const errors = results.flatMap((result, i) => result.status === 'rejected' ? [{ machine: connected[i]!, error: (result.reason as Error)?.message ?? String(result.reason) }] : [])
        for (const { machine, error } of errors) console.error(`Archived threads on ${machine.label}: ${error}`)
        setFailed(errors)
        setThreads(results.flatMap((result) => result.status === 'fulfilled' ? result.value : []).sort((a, b) => b.thread.activeAt - a.thread.activeAt))
      })
    return () => { alive = false }
  }, [open, inUse, asked])
  return (
    <section className={`threads-archived ${open ? 'is-open' : ''}`}>
      <button className="threads-archived__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <CaretRightIcon className="threads-archived__caret" size={11} weight="bold" aria-hidden />
        Archived
        {open && threads && <em>{threads.length}</em>}
      </button>
      {open && failed.map(({ machine, error }) => (
        <div key={machine.id} className="threads__empty threads-archived__error" role="alert">Couldn’t list {machine.label}’s archived threads: {error}</div>
      ))}
      {open && (threads?.length === 0
        ? !failed.length && <div className="threads__empty">Nothing archived.</div>
        : (
          <List>
            {(threads ?? []).map(({ machine, thread }) => <ArchivedRow key={`${machine.id}/${thread.id}`} machine={machine} thread={thread} />)}
          </List>
        ))}
    </section>
  )
}

/** An archived thread's row: its title, where it was, when it was last active; picked, shown read only. */
function ArchivedRow({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const { selection, select } = useSelection()
  const lit = useLit()
  return (
    <ListItem trailing={ago(thread.activeAt)} selected={lit(machine.id, thread.id)}
      onClick={() => select({ machine: machine.id, thread: thread.id })}>
      <span className="threads-archived__title">{thread.title}</span>
      <em className="threads-archived__where">{thread.project.name}{machine.id !== 'local' ? ` · ${machine.label}` : ''}</em>
    </ListItem>
  )
}

/** +: the New thread dialog, in a project's folder on its machine when given one. */
function NewThreadButton({ label, machine, cwd }: { label: string; machine?: MachineEntry; cwd?: string }) {
  const { newThread } = useShell()
  return (
    <IconButton label={label} className="threads__new" disabled={machine && machine.state !== 'connected'}
      onClick={() => newThread({ ...(machine ? { machine: machine.id } : {}), ...(cwd ? { cwd } : {}) })}><PlusIcon size={14} aria-hidden /></IconButton>
  )
}

const SORTS: { value: Sort; label: string }[] = [{ value: 'recent', label: 'Recently active' }, { value: 'created', label: 'Newest first' }, { value: 'status', label: 'Needs you first' }, { value: 'name', label: 'Alphabetical' }]

/** The ··· menu: sort, the Pinned section shown or not, details, hiding the sidebar. */
function Options() {
  const [sort, setSort] = useAppSetting<Sort>(SORT)
  const [showPinned, setShowPinned] = useAppSetting<boolean>(SHOW_PINNED)
  const [details, setDetails] = usePlacement(DETAILS, 'beside')
  const dispatch = useDispatch()
  const sidebarKeys = useShortcut(SIDEBAR)
  const detailsKeys = useShortcut(DETAILS)
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Threads options" className="threads-menu-trigger" />}><DotsThreeIcon size={16} weight="bold" aria-hidden /></Menu.Trigger>
      <Menu.Popup className="threads-menu">
        <Menu.Group>
          <Menu.GroupLabel>Sort</Menu.GroupLabel>
          <Menu.RadioGroup value={sort ?? 'recent'} onValueChange={(value) => void setSort(value as Sort)}>
            {SORTS.map((s) => <Menu.RadioItem key={s.value} value={s.value}>{s.label}</Menu.RadioItem>)}
          </Menu.RadioGroup>
        </Menu.Group>
        <Menu.Separator />
        <Menu.CheckboxItem checked={showPinned !== false} onCheckedChange={(checked) => void setShowPinned(checked).catch((error) => console.error(error))}>Show pinned</Menu.CheckboxItem>
        <Menu.CheckboxItem checked={details} onCheckedChange={(checked) => setDetails(checked)} hint={detailsKeys}>Thread details</Menu.CheckboxItem>
        <Menu.Item onClick={() => void dispatch(SIDEBAR, {}, { source: 'threads' }).catch((error) => console.error(error))} hint={sidebarKeys}>Hide sidebar</Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  )
}

/**
 * In the window's rail: Threads, lit while they're the open sidebar. A click hides the sidebar, the threads then status
 * dots here (the pinned first, as the list has them), and shows the list again; with another sidebar open (or none: Settings, Ego's thread), it shows the list.
 * Something unread you can't see from here shows as a dot on the button, in the most pressing one's colour.
 */
function ThreadsRail({ open, sidebarHidden, show }: SidebarRailProps) {
  const { projects, sidebar } = useProjects()
  const { selection, select } = useSelection()
  const lit = useLit()
  const hidden = open && sidebarHidden
  const toggleKeys = useShortcut(SIDEBAR)
  const tabKeys = useRailShortcut()
  const waiting = unreadList(projects, selection).map(({ thread }) => thread.status)
  const badge = !hidden && waiting.length ? rollup(waiting).state : undefined
  const click = () => show(!open || hidden)
  // As the sidebar lists them, each once: the pinned first, then each project's others.
  const pinned = new Set(sidebar.pinned.map(({ project, thread }) => `${project.machine.id}/${thread.id}`))
  const groups = [
    ...(sidebar.pinned.length ? [{ key: 'pinned', threads: sidebar.pinned }] : []),
    ...sidebar.projects.map((project) => ({
      key: project.key, threads: project.threads.filter((t) => !pinned.has(`${project.machine.id}/${t.id}`)).map((thread) => ({ project, thread })),
    })).filter((group) => group.threads.length),
  ]
  return (
    <TooltipProvider>
      <Tooltip content={!open ? `Show Threads${tabKeys ? ` (${tabKeys})` : ''}` : `${hidden ? 'Show sidebar' : 'Hide sidebar'}${toggleKeys ? ` (${toggleKeys})` : ''}`} side="right">
        <RailButton label="Threads" className="threads-rail__button" on={open} onClick={click}>
          <ChatsIcon size={18} aria-hidden />
          {badge && <span className={`threads-rail__badge threads-rail__badge--${badge}`} />}
        </RailButton>
      </Tooltip>
      {hidden && (
        <nav className="threads-rail" aria-label="Threads">
          {groups.map((group, index) => (
            <div key={group.key} className="threads-rail__group">
              {index > 0 && <div className="threads-rail__sep" />}
              {group.threads.map(({ project, thread }) => (
                <HoverCard key={`${project.machine.id}/${thread.id}`} card={<ThreadCard machine={project.machine} thread={thread} />}>
                  <button className={`threads-rail__dot ${lit(project.machine.id, thread.id) ? 'is-on' : ''} ${project.machine.state !== 'connected' ? 'is-stale' : ''}`}
                    aria-label={`${thread.title}, ${statusLabel(thread.status, thread.quiet)}`} onClick={() => select({ machine: project.machine.id, thread: thread.id })}>
                    <StatusGlyph status={thread.status} quiet={thread.quiet} />
                  </button>
                </HoverCard>
              ))}
            </div>
          ))}
        </nav>
      )}
      <div className="threads-rail__rule" />
    </TooltipProvider>
  )
}

/** Whose choice the model is, by `modelFrom`. */
const MODEL_FROM: Record<NonNullable<ThreadInfo['modelFrom']>, (thread: ThreadInfo) => string> = {
  thread: () => 'This thread',
  extension: () => 'The extension running it',
  profile: (thread) => thread.profile ? `Profile ${thread.profile.name}` : 'Its profile',
  machine: () => "This machine's settings",
}

/**
 * What the model's card says: the model, then whose it is, how hard it thinks, whose choice it is, how full its context
 * is, and what the thread has spent. A thread of another kind of agent (Claude Agent) says so in a line under the model
 * ("high · runs your Claude Code"), and no cost: its agent isn't billed by the token.
 */
export function modelCard(thread: ThreadInfo): { title: string; line?: string; rows: [string, string][] } {
  const context: [string, string][] = thread.context ? [['Context', contextSaid(thread.context)]] : []
  if (thread.agent) {
    const line = [thread.thinking, thread.agent.about].filter(Boolean).join(' · ')
    return {
      title: thread.model ?? thread.agent.title,
      ...(line ? { line } : {}),
      rows: [
        ...thread.modelFrom ? [['Chosen by', MODEL_FROM[thread.modelFrom](thread)] as [string, string]] : [],
        ...context,
      ],
    }
  }
  if (!thread.model) return { title: 'No model yet', rows: thread.cost ? [['Cost', `$${thread.cost.toFixed(2)}`]] : [] }
  return {
    title: thread.model,
    rows: [
      ...thread.provider ? [['Provider', providerOf(thread.provider)] as [string, string]] : [],
      ['Thinking', thread.thinking ?? 'off'],
      ...thread.modelFrom ? [['Chosen by', MODEL_FROM[thread.modelFrom](thread)] as [string, string]] : [],
      ...context,
      ['Cost', `$${(thread.cost ?? 0).toFixed(2)}`],
    ],
  }
}

/** How full a context is: "12% · 120k of 1M". */
export function contextSaid({ tokens, max }: { tokens: number; max: number }) {
  const short = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
  return `${max ? Math.round((tokens / max) * 100) : 0}% · ${short(tokens)} of ${short(max)}`
}

/** The model's row in the title bar's ··· menu, when there's no room for its button. */
function ModelItem({ thread }: { thread: ThreadInfo }) {
  return <>Model: {thread.model ?? 'none'}</>
}

/**
 * In the title bar: the model the thread runs with, as its provider's mark, a button that shows or hides the thread's
 * details (lit while they're shown); pointed at, a card of the model.
 */
export function ModelButton({ thread }: { thread: ThreadInfo }) {
  const [on, setOn] = usePlacement(DETAILS, 'beside')
  const keys = useShortcut(DETAILS)
  const card = modelCard(thread)
  return (
    <HoverCard side="bottom" className="threads-model-card" card={
      <>
        <div className="threads-model-card__name">{card.title}</div>
        {card.line && <div className="threads-model-card__line">{card.line}</div>}
        {card.rows.length > 0 && <dl>{card.rows.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>}
        {keys && <div className="threads-model-card__keys">Thread details <kbd>{keys}</kbd></div>}
      </>
    }>
      <button type="button" className={`threads-model ${on ? 'is-on' : ''}`} aria-pressed={Boolean(on)}
        aria-label={`${card.title}: ${on ? 'hide' : 'show'} thread details`} onClick={() => setOn()}>
        {thread.provider ? <ProviderMark provider={thread.provider} size={15} aria-hidden /> : <SparkleIcon size={15} aria-hidden />}
      </button>
    </HoverCard>
  )
}

type ToolCall = { name: string; arguments?: Record<string, unknown> }

/** The details: facts about the thread, and what its tools did. */
function DetailsPane({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const view = useThreadView(machine.id, machine.state === 'connected', thread.id)
  const { tools, files } = useMemo(() => {
    const tools = new Map<string, { count: number; failed: number }>()
    const files = new Set<string>()
    const failed = new Set<string>()
    for (const entry of view?.entries ?? []) {
      const message = entry.model?.[0] as { role?: string; isError?: boolean; toolCallId?: string; content?: unknown } | undefined
      if (message?.role === 'toolResult' && message.isError && message.toolCallId) failed.add(message.toolCallId)
    }
    for (const entry of view?.entries ?? []) {
      const message = entry.model?.[0] as { role?: string; content?: ({ type: string; id?: string } & ToolCall)[] } | undefined
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue
        const t = tools.get(block.name) ?? { count: 0, failed: 0 }
        t.count++
        if (block.id && failed.has(block.id)) t.failed++
        tools.set(block.name, t)
        const path = block.arguments?.path
        if (typeof path === 'string' && ['read', 'write', 'edit'].includes(block.name)) files.add(path)
      }
    }
    return { tools, files: [...files] }
  }, [view?.entries])
  const time = (at: number) => new Date(at).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
  return (
    <div className="threads-details">
      <h5>Thread</h5>
      <dl>
        <dt>Machine</dt><dd>{machine.label}</dd>
        <dt>Folder</dt><dd>{thread.cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')}</dd>
        {thread.model && <><dt>Model</dt><dd>{thread.model}</dd></>}
        {thread.context && <><dt>Context</dt><dd>{contextSaid(thread.context)}</dd></>}
        <dt>Started</dt><dd>{time(thread.createdAt)}</dd>
        <dt>Active</dt><dd>{ago(thread.activeAt)}</dd>
        {thread.cost !== undefined && <><dt>Cost</dt><dd>${thread.cost.toFixed(2)}</dd></>}
      </dl>
      {tools.size > 0 && (
        <>
          <h5>Tools</h5>
          <dl>{[...tools].map(([name, t]) => <Fragment key={name}><dt>{name}</dt><dd>{t.count}{t.failed ? ` · ${t.failed} failed` : ''}</dd></Fragment>)}</dl>
        </>
      )}
      {files.length > 0 && (
        <>
          <h5>Files touched</h5>
          {files.map((file) => <div key={file} className="threads-details__file">{file}</div>)}
        </>
      )}
      <Slot name="details.section" props={{ machine, thread }} />
    </div>
  )
}
