// Archiving a thread and bringing it back, as buttons: in the title bar, the composer of an archived thread, and a
// phone's thread sheet.
import type { ThreadInfo } from '@superego/protocol'
import { ArchiveIcon, ArrowCounterClockwiseIcon, Button, IconButton } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { useRegistry } from './registry.tsx'

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
