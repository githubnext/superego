import type { ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import { useProfileUi } from './profile-ui.ts'
import { ThreadPanes } from './panes.tsx'
import { ThreadBody } from './thread-body.tsx'

/** A thread: its transcript and composer, and the panes open beside it. */
export function ThreadView({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  // The thread's profile may bring UI of its own (header, beside, composer, tool renderers, panes).
  useProfileUi(machine.id, thread)
  return <ThreadPanes machine={machine} thread={thread} main={<ThreadBody machine={machine} thread={thread} />} />
}
