// The thread in the window's title bar: where it is and what it's called (renamed in place), its archive buttons
// (thread-actions.tsx), and what's said about it at the right (where it runs, its profile, extensions' chips, the pane
// menu).
import { useRef } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { IconButton, Menu, PencilSimpleIcon, PanePlusIcon, StatusGlyph } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { paneMenu, PlacedViews, Slot, useLayout, useRegistry } from './extension.tsx'
import { ViewContextMenu, withContextMenu } from './view-menu.tsx'
import { ThreadRef } from './thread-ref.tsx'
import { ArchiveButton, UnarchiveButton } from './thread-actions.tsx'
import { ProfileChip } from './profile-card.tsx'
import { startRename, stopRename, useRenaming } from './rename.ts'

/**
 * Where you are, in the window's title bar: the thread's project (and machine, where it isn't this one), then its status
 * and title, with buttons to rename it (or the name being edited) and to archive it (not an extension's own hidden
 * thread, which that extension looks after), or, archived, to bring it back.
 */
export function ThreadTitle({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const editing = useRenaming() === `${machine.id}/${thread.id}`
  return (
    <span className="titlebar__crumb">
      <span className="titlebar__seg titlebar__project" title={`${thread.project.name}\n${thread.cwd}`}>
        {machine.id !== 'local' && <>{machine.label}<span className="titlebar__dot">·</span></>}
        {thread.project.name}
      </span>
      <span className="titlebar__sep" aria-hidden>›</span>
      <span className="titlebar__seg titlebar__title">
        <StatusGlyph status={thread.status} />
        {editing ? <TitleField machine={machine} thread={thread} /> : (
          <>
            <span className="thread__title" title={thread.title} onDoubleClick={() => startRename(machine.id, thread.id)}>{thread.title.replace(/\.$/, '')}</span>
            <IconButton label="Rename" className="titlebar__action" onClick={() => startRename(machine.id, thread.id)}>
              <PencilSimpleIcon size={13} aria-hidden />
            </IconButton>
            {!thread.archived && <ArchiveButton machine={machine} thread={thread} className="titlebar__action" />}
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
 * like its worktree's branch, its profile), what extensions add to the header, and panes to open. `panes: false` leaves
 * the pane menu to the caller (a phone's thread sheet lists the panes itself).
 */
export function ThreadTools({ machine, thread, panes = true }: { machine: MachineEntry; thread: ThreadInfo; panes?: boolean }) {
  return (
    <span className="thread__tools">
      <span className="thread__chips">
        {thread.parent && <span className="header__chip thread__parent">from <ThreadRef machine={machine.id} id={thread.parent} /></span>}
        <Slot name="header.chips" props={{ machine, thread }} />
        {thread.profile && <ProfileChip machine={machine} thread={{ ...thread, profile: thread.profile }} />}
      </span>
      <PlacedViews place="header" machine={machine} thread={thread} frame={withContextMenu('header', { machine: machine.id, thread })} />
      {/* The one way to open a pane, last in the title bar, with panes shown or not. */}
      {panes && <PaneMenu machine={machine} thread={thread} />}
    </span>
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
  const open = (kind: string) => void registry.router.dispatch('pane.open', { thread: thread.id, kind }, { machine: machine.id, source: 'header' })
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Open a pane beside" className="thread__panes" />}>
        <PanePlusIcon size={18} aria-hidden />
      </Menu.Trigger>
      <Menu.Popup align="end">
        {kinds.map(({ kind, title }) => (
          <ViewContextMenu key={kind} view={kind} place="pane" machine={machine.id} thread={thread}><Menu.Item onClick={() => open(kind)}>{title}</Menu.Item></ViewContextMenu>
        ))}
      </Menu.Popup>
    </Menu.Root>
  )
}
