/// <reference path="./env.d.ts" />
// answer-ui, UI half. show_ui's blocks draw in the transcript, live for good: what's pressed is sent to the thread as a
// message. ask_ui's wait above the composer (the composer takes an answer in words); in the transcript, a line while
// it waits, then the blocks locked on the answer given. Both are drawn as themselves, out of the run's fold.
import { defineUiExtension, has, useComposerClaim, useDispatch, useValue, type MachineEntry, type ToolCallProps } from '@superego/app/ui'
import { describeReply, type Reply } from '@superego/blocks'
import { Blocks } from '@superego/blocks/ui'
import type { ThreadInfo } from '@superego/protocol'
import { about, ANSWER, ASK, ASKING, SHOW, type AskDetails, type Asking, type Spec } from './shared.ts'
import './styles.css'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.slot('composer.above', Waiting)
    // Never folded away with the run's other steps: they're for the user to see.
    superego.tool(SHOW, Shown, { fold: false })
    superego.tool(ASK, Asked, { fold: false })
  },
})

/** What the call drew: its details once it ran, else its arguments (a call still streaming in, or one that failed). */
function specOf({ call, result, live }: ToolCallProps): Spec | undefined {
  const details = (result?.details ?? live?.details) as Spec | undefined
  if (Array.isArray(details?.blocks)) return details
  const args = call.arguments as Partial<Spec>
  return Array.isArray(args.blocks) ? { blocks: args.blocks, ...(typeof args.title === 'string' ? { title: args.title } : {}) } : undefined
}

function Shown(props: ToolCallProps) {
  const { machine, thread, result } = props
  const dispatch = useDispatch()
  const spec = specOf(props)
  if (result?.isError || !spec) return <div className="answer-ui-note">{result?.isError ? result.text.split('\n')[0] : 'drawing…'}</div>
  // Done drawing, it stays live: pressing something later is the user's next message.
  const reply = (r: Reply) => dispatch('thread.send', { thread: thread.id, text: describeReply(spec.blocks, r) }, { machine: machine.id, source: 'answer-ui' })
  return (
    <section className="answer-ui">
      {spec.title && <h3 className="answer-ui__title">{spec.title}</h3>}
      <Blocks key={props.call.id} machine={machine} thread={thread} blocks={spec.blocks} {...(result ? { onReply: reply } : {})} />
    </section>
  )
}

function Asked(props: ToolCallProps) {
  const { machine, thread, result } = props
  const details = (result?.details ?? props.live?.details) as AskDetails | undefined
  const spec = specOf(props)
  if (details?.answer && spec) {
    return (
      <section className="answer-ui is-answered">
        {spec.title && <h3 className="answer-ui__title">{spec.title}</h3>}
        <Blocks machine={machine} thread={thread} blocks={spec.blocks} answer={details.answer} {...(spec.submit ? { submitLabel: spec.submit } : {})} />
      </section>
    )
  }
  const title = spec?.title ?? 'A question'
  if (result) return <div className="answer-ui-note"><span className="answer-ui-note__q">? {title}</span> {result.isError ? result.text.split('\n')[0] : 'not answered'}</div>
  return <div className="answer-ui-note"><span className="answer-ui-note__q">? {title}</span> waiting for your answer, above the message box</div>
}

function Waiting({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  // The thread's own scope: null where the daemon half isn't set up; none from a major this half doesn't speak.
  const waiting = useValue<Asking[]>(machine, ASKING, { scope: thread.id })
  // The oldest first; answering it brings up the next.
  const asking = Array.isArray(waiting) && has(machine, 'ext:answer-ui@<2') ? waiting[0] : undefined
  return asking ? <AskCard key={asking.id} machine={machine} thread={thread} asking={asking} /> : null
}

function AskCard({ machine, thread, asking }: { machine: MachineEntry; thread: ThreadInfo; asking: Asking }) {
  const dispatch = useDispatch()
  const answer = (reply: Reply) => dispatch(ANSWER, { id: asking.id, ...reply }, { machine: machine.id, source: 'answer-ui' })
  // An answer in words is typed in the composer itself.
  useComposerClaim({ placeholder: 'Or answer in your own words', submit: (text) => answer({ values: {}, text }) })
  return (
    <div className="answer-ui-ask" role="group" aria-label="The agent asks">
      <div className="answer-ui-ask__label">needs you</div>
      {asking.title && <div className="answer-ui-ask__title">{asking.title}</div>}
      <div className="answer-ui-ask__body">
        <Blocks machine={machine} thread={thread} blocks={asking.blocks} onReply={answer} {...(asking.submit ? { submitLabel: asking.submit } : {})} />
      </div>
    </div>
  )
}
