/// <reference path="./env.d.ts" />
// agent-ui, UI half: what the agent waits on, above the composer (waiting.tsx); its UI in the transcript
// (transcript.tsx); and the `ui` pane, drawing the blocks it keeps for it (see daemon.ts), redrawn as it updates them.
import { defineUiExtension, useValue, type PaneProps } from '@superego/app/ui'
import { Blocks } from '@superego/blocks/ui'
import { useReplyToThread } from './reply.ts'
import { about, ASK, ASK_USER, KIND, OPEN, PANES, SHOW, UPDATE, type ThreadPanes } from './shared.ts'
import { Asked, AskedUi, Opened, Shown } from './transcript.tsx'
import { Waiting } from './waiting.tsx'
import './styles.css'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.slot('composer.above', Waiting)
    superego.tool(ASK_USER, Asked)
    // Never folded away with the run's other steps: they're for the user to see.
    superego.tool(SHOW, Shown, { fold: false })
    superego.tool(ASK, AskedUi, { fold: false })
    superego.tool(OPEN, Opened)
    superego.tool(UPDATE, Opened)
    superego.pane(KIND, { title: (pane) => pane.title ?? 'UI', component: UiPane })
  },
})

function UiPane({ machine, thread, pane }: PaneProps) {
  const reply = useReplyToThread(machine, thread)
  // The thread's own scope: null until the daemon half has read it from the thread (or when it keeps none).
  const specs = useValue<ThreadPanes>(machine, PANES, { scope: thread.id })
  const { id } = (pane.params ?? {}) as { id?: string }
  if (!specs) return <div className="pane-empty">Loading…</div>
  const spec = id ? specs[id] : undefined
  if (!spec) return <div className="pane-empty">This pane’s UI is gone.</div>
  return (
    <div className="agent-ui-pane">
      {/* Redrawn whole when the agent updates it: its inputs start again from what it says. */}
      <Blocks key={spec.at} machine={machine} thread={thread} blocks={spec.blocks} onReply={(r) => reply(spec.blocks, r)} />
    </div>
  )
}
