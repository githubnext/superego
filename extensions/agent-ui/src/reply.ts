// How what the user does with the agent's UI gets back to it: to blocks that don't wait (show_ui in the transcript, a
// `ui` pane), as their next message in the thread; to what the agent waits on (ask_user, ask_ui), as its answer.
import { useDispatch, type MachineEntry } from '@superego/app/ui'
import { describeReply, type Block, type Reply } from '@superego/blocks'
import type { ThreadInfo } from '@superego/protocol'
import { about, ANSWER } from './shared.ts'

/** Send a reply to `blocks` to the thread as the user's next message (`→ Option B`). */
export function useReplyToThread(machine: MachineEntry, thread: ThreadInfo) {
  const dispatch = useDispatch()
  return (blocks: Block[], reply: Reply) =>
    dispatch('thread.send', { thread: thread.id, text: describeReply(blocks, reply) }, { machine: machine.id, source: about.name })
}

/** Answer what the agent waits on, by its id: in words (`text`), or the blocks' values and the button pressed. */
export function useAnswer(machine: MachineEntry, id: string) {
  const dispatch = useDispatch()
  return (reply: Partial<Reply>) => dispatch(ANSWER, { id, ...reply }, { machine: machine.id, source: about.name })
}
