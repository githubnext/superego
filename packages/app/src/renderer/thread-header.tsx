// The thread in the window's title bar: where it is and what it's called (renamed in place), its profile's badge, its pin
// and archive buttons (thread-actions.tsx), and what's said about it at the right (where it runs, extensions' chips, the
// pane menu).
import { useLayoutEffect, useRef, type ComponentType } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { ArchiveIcon, ArrowElbowDownRightIcon, IconButton, IdentificationBadgeIcon, Menu, PencilSimpleIcon, PanePlusIcon, PushPinIcon, StatusGlyph, StatusWord } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { useRegistry } from './registry.tsx'
import { paneMenu, PlacedViews, Slot, useLayout, ViewScopeProvider } from './placement.tsx'
import { ViewContextPopup, withContextMenu } from './view-menu.tsx'
import { ThreadRef } from './thread-ref.tsx'
import { ArchiveButton, PinButton, UnarchiveButton } from './thread-actions.tsx'
import { ProfileBadge } from './profile-card.tsx'
import { startRename, stopRename, useRenaming } from './rename.ts'
import { isPinned } from './pins.ts'
import { useProjects } from './state.tsx'
import { Contained } from './contained.tsx'
import { OverflowBox, OverflowRow, PRIORITY, ShownText, useOverflow } from './overflow.tsx'
import type { ViewProps } from './extension-api.ts'
import type { Registry } from './registry.tsx'

/**
 * Where you are, in the window's title bar: the thread's project (and machine, where it isn't this one), then its mark,
 * title and what it's doing in a word (Working, Question, Failed: not Done, which you're looking at), its profile's
 * badge, and buttons to rename it (or the name being edited), to pin it and to archive it (not an extension's own hidden
 * thread, which that extension looks after), or, archived, to bring it back.
 */
export function ThreadTitle({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const editing = useRenaming() === `${machine.id}/${thread.id}`
  const pinned = isPinned(useProjects().pins, { machine: machine.id, thread: thread.id })
  // A new title (or the field for one) asks for room again: squeezed, its box may not change size with it.
  const overflow = useOverflow()
  useLayoutEffect(() => overflow?.dirty(), [overflow, thread.id, thread.title, editing])
  return (
    <span className="titlebar__crumb">
      <span className="titlebar__seg titlebar__project" title={`${thread.project.name}\n${thread.cwd}`}>
        {machine.id !== 'local' && <>{machine.label}<span className="titlebar__dot">·</span></>}
        {thread.project.name}
      </span>
      <span className="titlebar__sep" aria-hidden>›</span>
      <span className="titlebar__seg titlebar__title">
        <StatusGlyph status={thread.status} quiet={thread.quiet} />
        {editing ? <TitleField machine={machine} thread={thread} /> : (
          <>
            <span className="thread__title" title={thread.title} onDoubleClick={() => startRename(machine.id, thread.id)}>{thread.title.replace(/\.$/, '')}</span>
            {thread.status.state !== 'done' && <StatusWord status={thread.status} quiet={thread.quiet} className="titlebar__word" />}
            {thread.profile && (
              <OverflowBox id="profile" priority={PRIORITY.profile} row={<OverflowRow icon={IdentificationBadgeIcon}>Profile: {thread.profile.name}</OverflowRow>}>
                <ProfileBadge machine={machine} thread={{ ...thread, profile: thread.profile }} />
              </OverflowBox>
            )}
            <span className="titlebar__actions">
              <OverflowBox id="rename" priority={PRIORITY.rename} row={<OverflowRow icon={PencilSimpleIcon}>Rename</OverflowRow>}>
                <IconButton label="Rename" className="titlebar__action" onClick={() => startRename(machine.id, thread.id)}>
                  <PencilSimpleIcon size={13} aria-hidden />
                </IconButton>
              </OverflowBox>
              {!thread.hidden && !thread.archived && (
                <OverflowBox id="pin" priority={PRIORITY.pin} row={<OverflowRow icon={PushPinIcon}>{pinned ? 'Unpin' : 'Pin'}</OverflowRow>}>
                  <PinButton machine={machine} thread={thread} className="titlebar__action" />
                </OverflowBox>
              )}
              {!thread.hidden && !thread.archived && (
                <OverflowBox id="archive" priority={PRIORITY.archive} row={<OverflowRow icon={ArchiveIcon}>Archive</OverflowRow>}>
                  <ArchiveButton machine={machine} thread={thread} className="titlebar__action" />
                </OverflowBox>
              )}
            </span>
          </>
        )}
      </span>
      {thread.archived && <span className="titlebar__archived">Archived</span>}
      {thread.archived && !thread.hidden && <UnarchiveButton machine={machine} thread={thread} />}
    </span>
  )
}

/** The title, editable: ⏎ (or leaving it) renames the thread, esc leaves it as it was. */
function TitleField({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const dispatch = useRegistry().router.dispatch
  const done = useRef(false)
  const finish = (title: string | undefined) => {
    if (done.current) return
    done.current = true
    stopRename()
    const next = title?.trim()
    if (next && next !== thread.title) void dispatch('thread.rename', { thread: thread.id, title: next }, { machine: machine.id, source: 'titlebar' }).catch((error) => console.error(error))
  }
  return (
    <input className="titlebar__field" aria-label="Thread title" defaultValue={thread.title} autoFocus spellCheck={false}
      onFocus={(e) => e.currentTarget.select()} onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(e.currentTarget.value) }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(undefined) }
      }} />
  )
}

/**
 * What the title bar says about the thread, at its right: where it runs (the thread that started it, extensions' chips
 * like its worktree's branch), what extensions add to the header, and panes to open. `panes: false` leaves
 * the pane menu to the caller (a phone's thread sheet lists the panes itself).
 */
export function ThreadTools({ machine, thread, panes = true }: { machine: MachineEntry; thread: ThreadInfo; panes?: boolean }) {
  const where = { machine: machine.id, thread }
  const inMenu = withContextMenu('header', where)
  return (
    <span className="thread__tools">
      <span className="thread__chips">
        {thread.parent && (
          <OverflowBox id="parent" priority={PRIORITY.parent} row={<OverflowRow icon={ArrowElbowDownRightIcon}><ShownText id="parent" title="From" of="a, button" /></OverflowRow>}>
            <span className="header__chip thread__parent">from <ThreadRef machine={machine.id} id={thread.parent} /></span>
          </OverflowBox>
        )}
        <Slot name="header.chips" props={{ machine, thread }} frame={(key, drawn) => (
          <OverflowBox key={key} id={`chip:${key}`} priority={PRIORITY.chips} row={<OverflowRow><ShownText id={`chip:${key}`} /></OverflowRow>}>{drawn}</OverflowBox>
        )} />
      </span>
      <PlacedViews place="header" machine={machine} thread={thread} frame={(view, drawn) => (
        <OverflowBox id={`view:${view.id}`} priority={PRIORITY.header} row={<ViewRow view={view} machine={machine} thread={thread} />}>
          {inMenu(view, drawn)}
        </OverflowBox>
      )} />
      {/* The one way to open a pane, last in the title bar, with panes shown or not. */}
      {panes && <PaneMenu machine={machine} thread={thread} />}
    </span>
  )
}

/**
 * A header view's row in the title bar's ···: its icon, then what its `menuItem` says ("Model: claude-opus-5-5"), else
 * its title and the text it shows.
 */
function ViewRow({ view, machine, thread }: { view: Registry['views'][number]; machine: MachineEntry; thread: ThreadInfo }) {
  const Item = view.menuItem as ComponentType<ViewProps> | undefined
  return (
    <OverflowRow icon={view.icon}>
      {Item
        ? <ViewScopeProvider value={{ machine: machine.id, thread }}><Contained name={view.owner.extension} scope={view.owner.profile} inline><Item place="header" machine={machine} thread={thread} /></Contained></ViewScopeProvider>
        : <ShownText id={`view:${view.id}`} title={view.title} />}
    </OverflowRow>
  )
}

/**
 * Open a pane beside the thread: the kinds that show something without being told what (Changes, a profile's own).
 * Each is a view the layout puts in the pane menu: a right-click on it moves it elsewhere or takes it out.
 */
export function PaneMenu({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const registry = useRegistry()
  const where = { machine: machine.id, thread }
  const kinds = paneMenu(registry, useLayout(where).placed, where)
  if (!kinds.length) return null
  const open = (kind: string) => void registry.router.dispatch('pane.open', { thread: thread.id, kind }, { machine: machine.id, source: 'header' }).catch((error) => console.error(error))
  return (
    <OverflowBox id="panes" priority={PRIORITY.panes} row={<OverflowRow icon={PanePlusIcon}>Open a pane beside…</OverflowRow>}>
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Open a pane beside" className="thread__panes" />}>
        <PanePlusIcon size={18} aria-hidden />
      </Menu.Trigger>
      <Menu.Popup align="end">
        {kinds.map(({ kind, title }) => (
          <Menu.Item key={kind} data-view={kind} onClick={() => open(kind)}
            contextPopup={<ViewContextPopup view={kind} place="pane" machine={machine.id} thread={thread} />}>{title}</Menu.Item>
        ))}
      </Menu.Popup>
    </Menu.Root>
    </OverflowBox>
  )
}
