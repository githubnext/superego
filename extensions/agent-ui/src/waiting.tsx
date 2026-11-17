// What the agent waits on, above the composer: the oldest of its questions (ask_user) and forms (ask_ui), one at a
// time; answering it brings up the next. The card claims the composer, so what's typed there answers it in words.
import { useState } from 'react'
import { Blocks, Glyph, keyLabel, Markdown, STATUS_WORDS, useComposer, useComposerClaim, useValue, type MachineEntry } from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { answerOf, keyMove, partsOf } from './question.ts'
import { useAnswer } from './reply.ts'
import { ASK_USER, WAITING, type Question, type Spec, type Waiting as Entry } from './shared.ts'

export function Waiting({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  // The thread's own scope: null where the daemon half isn't set up.
  const first = useValue<Entry[]>(machine, WAITING, { scope: thread.id })?.[0]
  if (!first) return null
  return (
    <div className="agent-ui-waiting" role="group" aria-label="The agent asks">
      <div className="agent-ui-waiting__label"><Glyph shape="question" />{STATUS_WORDS.question}</div>
      {first.tool === ASK_USER
        ? <QuestionCard key={first.id} machine={machine} id={first.id} question={first} />
        : <FormCard key={first.id} machine={machine} thread={thread} id={first.id} spec={first} />}
    </div>
  )
}

function QuestionCard({ machine, id, question }: { machine: MachineEntry; id: string; question: Question }) {
  const [error, setError] = useState<string>()
  // The option ↑/↓ highlighted, for ⏎ to pick.
  const [active, setActive] = useState<number>()
  // Typing a free answer drops it: ⏎ then sends what's typed.
  const highlighted = useComposer().text.trim() ? undefined : active
  const send = useAnswer(machine, id)
  const { options } = question
  const { context, ask } = partsOf(question.question)
  const answer = (text: string) => {
    setError(undefined)
    return send({ text }).catch((e: Error) => { setError(e.message); throw e })
  }
  // A free answer is typed in the composer itself, which the card sits on; a number picks that option, as do ⌃1–⌃9,
  // and ↑/↓ then ⏎ from an empty box.
  useComposerClaim({
    placeholder: options.length ? 'Or answer in your own words…' : 'Your answer…',
    submit: (typed) => answer(answerOf(typed, options)),
    keyDown(event, typed) {
      const move = keyMove(event, typed, highlighted, options.length)
      if (!move) return false
      if ('pick' in move) void answer(options[move.pick]!.label).catch(() => {})
      else setActive(move.active)
      return true
    },
  })
  return (
    <>
      {context && <div className="agent-ui-waiting__context"><Markdown text={context} /></div>}
      <div className="agent-ui-question dock__join">
        {ask && <div className="agent-ui-question__ask"><Markdown text={ask} /></div>}
        {options.length > 0 && (
          <div className="agent-ui-question__options">
            {options.map((option, index) => (
              <button key={option.label} type="button" className={`agent-ui-question__option ${index === highlighted ? 'is-active' : ''}`} onClick={() => void answer(option.label).catch(() => {})}>
                <span className="agent-ui-question__key" aria-hidden>{index < 9 ? keyLabel(`ctrl+${index + 1}`) : ''}</span>
                <span className="agent-ui-question__option-text">
                  <span className="agent-ui-question__option-label">{option.label}</span>
                  {option.description && <span className="agent-ui-question__option-description">{option.description}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
        {error && <div className="agent-ui-question__error">{error}</div>}
      </div>
    </>
  )
}

function FormCard({ machine, thread, id, spec }: { machine: MachineEntry; thread: ThreadInfo; id: string; spec: Spec }) {
  const answer = useAnswer(machine, id)
  // An answer in words is typed in the composer itself.
  useComposerClaim({ placeholder: 'Or answer in your own words…', submit: (text) => answer({ text }) })
  return (
    <>
      {spec.title && <div className="agent-ui-form__title">{spec.title}</div>}
      <div className="agent-ui-form">
        <Blocks machine={machine} thread={thread} blocks={spec.blocks} host={{ by: 'agent', reply: answer }} {...(spec.submit ? { submitLabel: spec.submit } : {})} />
      </div>
    </>
  )
}
