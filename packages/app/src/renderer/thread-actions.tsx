// Pinning a thread, archiving it and bringing it back, as buttons: in the title bar and the composer of an archived
// thread. (A phone's thread sheet has them as rows: thread-sheet.tsx.)
import type { ThreadInfo } from '@superego/protocol'
import { ArchiveIcon, ArrowCounterClockwiseIcon, Button, IconButton, PushPinIcon } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { useRegistry } from './registry.tsx'
import { useProjects } from './state.tsx'
import { isPinned } from './pins.ts'

/** Pins the thread to the top of the sidebar, or unpins it: filled while it's pinned. Only a thread the sidebar lists. */
export function PinButton({ machine, thread, className = '' }: { machine: MachineEntry; thread: ThreadInfo; className?: string }) {
  const dispatch = useRegistry().router.dispatch
  const pinned = isPinned(useProjects().pins, { machine: machine.id, thread: thread.id })
  if (thread.hidden || thread.archived) return null
  return (
    <IconButton label={pinned ? 'Unpin' : 'Pin'} aria-pressed={pinned} className={`thread__pin ${pinned ? 'is-on' : ''} ${className}`}
      onClick={() => void dispatch(pinned ? 'thread.unpin' : 'thread.pin', { machine: machine.id, thread: thread.id }, { source: 'header' }).catch((error) => console.error(error))}>
      <PushPinIcon size={14} weight={pinned ? 'fill' : 'regular'} aria-hidden />
    </IconButton>
  )
}

/** Puts the thread away (⌘⇧E): out of its project, its worktree kept. Not an extension's own hidden thread. */
export function ArchiveButton({ machine, thread, className = '' }: { machine: MachineEntry; thread: ThreadInfo; className?: string }) {
  const dispatch = useRegistry().router.dispatch
  if (thread.hidden) return null
  return (
    <IconButton label="Archive (⌘⇧E)" className={`thread__archive ${className}`} onClick={() => void dispatch('thread.archive', { thread: thread.id }, { machine: machine.id, source: 'header' }).catch((error) => console.error(error))}>
      <ArchiveIcon size={14} aria-hidden />
    </IconButton>
  )
}

/** Brings an archived thread back: into its project, with its worktree, taking messages again. */
export function UnarchiveButton({ machine, thread, className = '' }: { machine: MachineEntry; thread: ThreadInfo; className?: string }) {
  const dispatch = useRegistry().router.dispatch
  return (
    <Button className={`thread__unarchive ${className}`} onClick={() => void dispatch('thread.unarchive', { thread: thread.id }, { machine: machine.id, source: 'header' }).catch((error) => console.error(error))}>
      <ArrowCounterClockwiseIcon size={14} aria-hidden /> Unarchive
    </Button>
  )
}
