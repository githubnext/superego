/// <reference path="./env.d.ts" />
// ask-user, UI half: the question an agent is waiting on shows above the composer: its context, then a card joined to
// the composer with the question and its numbered options (a free answer is typed below them); in the transcript, the
// question and the answer it got.
import { useState } from 'react'
import { defineUiExtension, useDispatch, has, keyLabel, Markdown, useComposer, useComposerClaim, useValue, type MachineEntry, type ToolCallProps } from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { about, ANSWER, PENDING, TOOL, type AskDetails, type Option, type Question } from './shared.ts'
import { answerOf, keyMove, partsOf } from './question.ts'
import './styles.css'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.slot('composer.above', Waiting)
    superego.tool(TOOL, Asked)
  },
})

/** The questions this machine's agents wait on; none where the daemon half isn't installed. */
function usePending(machine: MachineEntry) {
  return useValue<Question[]>(machine.id, machine.state === 'connected' && has(machine, 'ext:ask-user'), PENDING) ?? []
}

function Waiting({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const questions = usePending(machine).filter((q) => q.thread === thread.id)
  // The oldest question first; answering it brings up the next.
  const question = questions[0]
  return question ? <QuestionCard key={question.id} machine={machine} question={question} /> : null
}

function QuestionCard({ machine, question }: { machine: MachineEntry; question: Question }) {
  const [error, setError] = useState<string>()
  // The option ↑/↓ highlighted, for ⏎ to pick.
  const [active, setActive] = useState<number>()
  // Typing a free answer drops it: ⏎ then sends what's typed.
  const highlighted = useComposer().text.trim() ? undefined : active
  const dispatch = useDispatch()
  // From an older daemon, options are plain labels.
  const options = question.options.map((option): Option => typeof option === 'string' ? { label: option } : option)
  const { context, ask } = partsOf(question.question)
  const answer = (value: string) => {
    setError(undefined)
    return dispatch(ANSWER, { id: question.id, answer: value }, { machine: machine.id, source: 'ask-user' }).catch((e: Error) => { setError(e.message); throw e })
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
    <div className="ask-user" role="group" aria-label="The agent asks">
      <div className="ask-user__label">Needs you</div>
      {context && <div className="ask-user__context"><Markdown text={context} /></div>}
      <div className="ask-user__card dock__join">
        {ask && <div className="ask-user__ask"><Markdown text={ask} /></div>}
        {options.length > 0 && (
          <div className="ask-user__options">
            {options.map((option, index) => (
              <button key={option.label} type="button" className={`ask-user__option ${index === highlighted ? 'is-active' : ''}`} onClick={() => void answer(option.label).catch(() => {})}>
                <span className="ask-user__key" aria-hidden>{index < 9 ? keyLabel(`ctrl+${index + 1}`) : ''}</span>
                <span className="ask-user__option-text">
                  <span className="ask-user__option-label">{option.label}</span>
                  {option.description && <span className="ask-user__option-description">{option.description}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
        {error && <div className="ask-user__error">{error}</div>}
      </div>
    </div>
  )
}

function Asked({ call: toolCall, result, live }: ToolCallProps) {
  const details = (result?.details ?? live?.details) as AskDetails | undefined
  const { context, ask } = partsOf(details?.question ?? String(toolCall.arguments.question ?? ''))
  // While it waits, the card above the composer shows the context; once settled, it stays here with the answer.
  return (
    <div className="ask-user-asked">
      {result && context && <div className="ask-user-asked__context"><Markdown text={context} /></div>}
      <div className="ask-user-asked__line">
        {ask && <span className="ask-user-asked__q">? {ask}</span>}
        {details?.answer !== undefined ? <span className="ask-user-asked__a">→ {details.answer}</span>
          : result ? <span className="ask-user-asked__a is-muted">{result.isError ? 'not answered' : result.text}</span>
          : <span className="ask-user-asked__a is-muted">waiting for your answer</span>}
      </div>
    </div>
  )
}
