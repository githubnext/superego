// The agent's UI in the transcript. ask_user: the question, then the answer it got. show_ui: its blocks, live for good
// (what's pressed is the user's next message). ask_ui: a line while it waits above the composer, then its blocks locked
// on the answer given. open_ui and update_ui: a line that opens the pane again.
import { Blocks, Markdown, useDispatch, type ToolCallProps } from '@superego/app/ui'
import { partsOf } from './question.ts'
import { useReplyToThread } from './reply.ts'
import { about, KIND, UPDATE, type AskDetails, type QuestionDetails, type Spec } from './shared.ts'

/** A failed call's message, its first line. */
const failure = (text: string) => text.split('\n')[0]

export function Asked({ call, result, live }: ToolCallProps) {
  const details = (result?.details ?? live?.details) as QuestionDetails | undefined
  const { context, ask } = partsOf(details?.question ?? String(call.arguments.question ?? ''))
  // While it waits, the card above the composer shows the context; once settled, it stays here with the answer.
  return (
    <div className="agent-ui-asked">
      {result && context && <div className="agent-ui-asked__context"><Markdown text={context} /></div>}
      <div className="agent-ui-note">
        {ask && <span className="agent-ui-note__q">? {ask}</span>}{' '}
        {details?.answer !== undefined ? <span className="agent-ui-asked__a">→ {details.answer}</span>
          : result ? (result.isError ? failure(result.text) : 'not answered')
          : 'waiting for your answer'}
      </div>
    </div>
  )
}

/** What the call drew: its details once it ran, else its arguments (a call still streaming in, or one that failed). */
function specOf({ call, result, live }: ToolCallProps): Spec | undefined {
  const details = (result?.details ?? live?.details) as Spec | undefined
  if (Array.isArray(details?.blocks)) return details
  const args = call.arguments as Partial<Spec>
  return Array.isArray(args.blocks) ? { blocks: args.blocks, ...(typeof args.title === 'string' ? { title: args.title } : {}) } : undefined
}

export function Shown(props: ToolCallProps) {
  const { machine, thread, result } = props
  const reply = useReplyToThread(machine, thread)
  const spec = specOf(props)
  if (result?.isError || !spec) return <div className="agent-ui-note">{result?.isError ? failure(result.text) : 'drawing…'}</div>
  // Done drawing, it stays live: pressing something later is the user's next message.
  return (
    <section className="agent-ui-blocks">
      {spec.title && <h3 className="agent-ui-blocks__title">{spec.title}</h3>}
      <Blocks key={props.call.id} machine={machine} thread={thread} blocks={spec.blocks} host={result ? { by: 'agent', reply: (r) => reply(spec.blocks, r) } : { by: 'agent' }} />
    </section>
  )
}

export function AskedUi(props: ToolCallProps) {
  const { machine, thread, result } = props
  const details = (result?.details ?? props.live?.details) as AskDetails | undefined
  const spec = specOf(props)
  if (details?.answer && spec) {
    return (
      <section className="agent-ui-blocks is-answered">
        {spec.title && <h3 className="agent-ui-blocks__title">{spec.title}</h3>}
        <Blocks machine={machine} thread={thread} blocks={spec.blocks} host={{ by: 'agent' }} answer={details.answer} {...(spec.submit ? { submitLabel: spec.submit } : {})} />
      </section>
    )
  }
  const title = spec?.title ?? 'A question'
  return (
    <div className="agent-ui-note">
      <span className="agent-ui-note__q">? {title}</span>{' '}
      {result ? (result.isError ? failure(result.text) : 'not answered') : 'waiting for your answer, above the message box'}
    </div>
  )
}

export function Opened({ machine, thread, call, result }: ToolCallProps) {
  const dispatch = useDispatch()
  const details = result?.details as { id?: string; title?: string } | undefined
  const title = details?.title ?? String(call.arguments.title ?? call.arguments.id ?? 'UI')
  if (result?.isError) return <div className="agent-ui-note">▤ {title}: {failure(result.text)}</div>
  const id = details?.id
  const open = () => void dispatch('pane.open', { thread: thread.id, kind: KIND, title, params: { id } }, { machine: machine.id, source: about.name })
  return (
    <div className="agent-ui-note">
      ▤ {call.name === UPDATE ? 'updated' : 'opened'}{' '}
      {id ? <button type="button" className="agent-ui-note__link" onClick={open}>{title}</button> : <span>{title}…</span>}
    </div>
  )
}
