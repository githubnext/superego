/// <reference path="./env.d.ts" />
// pane-ui, UI half: the `ui` pane, drawing the blocks the agent keeps for it (see daemon.ts), redrawn as it updates
// them; what the user presses is sent to the thread as a message. In the transcript, open_ui and update_ui are a line
// that opens the pane again.
import { defineUiExtension, has, useDispatch, useValue, type PaneProps, type ToolCallProps } from '@superego/app/ui'
import { describeReply, type Reply } from '@superego/blocks'
import { Blocks } from '@superego/blocks/ui'
import { about, KIND, OPEN, SPECS, UPDATE, type ThreadSpecs } from './shared.ts'
import './styles.css'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.pane(KIND, { title: (pane) => pane.title ?? 'UI', component: UiPane })
    superego.tool(OPEN, Opened)
    superego.tool(UPDATE, Opened)
  },
})

function UiPane({ machine, thread, pane }: PaneProps) {
  const dispatch = useDispatch()
  const speaks = has(machine, 'ext:pane-ui@^2')
  // The thread's own scope: null until the daemon half has read it from the thread (or when it keeps none).
  const specs = useValue<ThreadSpecs>(machine, SPECS, { scope: thread.id })
  const { id } = (pane.params ?? {}) as { id?: string }
  if (!speaks) return <div className="pane-empty">No UI panes on {machine.label}.</div>
  if (!specs) return <div className="pane-empty">Loading…</div>
  const spec = id ? specs[id] : undefined
  if (!spec) return <div className="pane-empty">This pane’s UI is gone.</div>
  const reply = (r: Reply) => dispatch('thread.send', { thread: thread.id, text: describeReply(spec.blocks, r) }, { machine: machine.id, source: 'pane-ui' })
  return (
    <div className="pane-ui">
      <div className="pane-ui__body">
        {/* Redrawn whole when the agent updates it: its inputs start again from what it says. */}
        <Blocks key={spec.at} machine={machine} thread={thread} blocks={spec.blocks} onReply={reply} />
      </div>
    </div>
  )
}

function Opened({ machine, thread, call, result }: ToolCallProps) {
  const dispatch = useDispatch()
  const details = result?.details as { id?: string; title?: string } | undefined
  const title = details?.title ?? String(call.arguments.title ?? call.arguments.id ?? 'UI')
  if (result?.isError) return <div className="pane-ui-note">▤ {title}: {result.text.split('\n')[0]}</div>
  const id = details?.id
  const open = () => void dispatch('pane.open', { thread: thread.id, kind: KIND, title, params: { id } }, { machine: machine.id, source: 'pane-ui' })
  return (
    <div className="pane-ui-note">
      ▤ {call.name === UPDATE ? 'updated' : 'opened'}{' '}
      {id ? <button type="button" className="pane-ui-note__link" onClick={open}>{title}</button> : <span>{title}…</span>}
    </div>
  )
}
