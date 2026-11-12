// Tasks out of a run of work: each `task_start` opens one, titled; what follows belongs to it until its `task_finish`
// says how it went. Rebuilt from the transcript every time, so tasks survive reloads and restarts.
import type { WorkBlock, WorkPart, WorkRun } from '@superego/app/ui'
import { ENDINGS, FINISH, START, type Ending } from './shared.ts'

const args = (block: WorkBlock) => (block.arguments ?? {}) as Record<string, unknown>

/** The run as tasks, with any work outside them as untitled parts; undefined when the agent reported none. */
export function divide({ blocks, active, result }: WorkRun): WorkPart[] | undefined {
  if (!blocks.some((b) => b.type === 'toolCall' && (b.name === START || b.name === FINISH))) return undefined
  const parts: WorkPart[] = []
  // The task going on, and its id (its start call's, which task_finish names); work outside a task, untitled.
  let open: WorkPart | undefined
  let openId: string | undefined
  let loose: WorkPart | undefined
  // A task left open when another starts, or when its run ends, was cut off: never done by default.
  const interrupt = () => { if (open) open.status = 'interrupted'; open = openId = undefined }

  for (const block of blocks) {
    const failed = block.id !== undefined && result(block.id)?.isError
    if (block.type === 'toolCall' && block.name === START && !failed && typeof args(block).title === 'string') {
      interrupt()
      // What the agent did just before starting (planning, a look around) belongs to the task it led to.
      const preamble = loose && parts.at(-1) === loose ? parts.pop()!.blocks : []
      open = { title: args(block).title as string, status: 'running', blocks: preamble }
      openId = block.id
      parts.push(open)
      loose = undefined
      continue
    }
    if (block.type === 'toolCall' && block.name === FINISH && !failed) {
      const { task_id: id, status, outcome } = args(block)
      if (ENDINGS.includes(status as Ending)) {
        if (open && id === openId) {
          Object.assign(open, { status, ...(typeof outcome === 'string' ? { outcome } : {}) })
          open = openId = undefined
        } else if (typeof outcome === 'string') {
          // A task started in an earlier run (before you steered, say) ends here; its outcome says what it was.
          interrupt()
          parts.push({ title: outcome, status: status as Ending, blocks: [] })
        }
        loose = undefined
        continue
      }
    }
    if (open) open.blocks.push(block)
    else {
      if (!loose) parts.push(loose = { blocks: [] })
      loose.blocks.push(block)
    }
  }
  if (!active) interrupt()
  return parts
}
