/// <reference path="./env.d.ts" />
// ask-user, UI half: the question an agent is waiting on shows above the composer, with its options and room for a
// free answer; in the transcript, the question and the answer it got.
import { useState } from 'react'
import { call, defineUiExtension, has, useComposerClaim, useValue, type MachineEntry, type ToolCallProps } from '@mu/app/ui'
import type { SessionInfo } from '@mu/protocol'
import { Button } from '@mu/ui'
import { ANSWER, PENDING, TOOL, type AskDetails, type Question } from './shared.ts'
import './styles.css'

export default defineUiExtension({
  name: 'ask-user',
  setup(mu) {
    mu.slot('composer.above', Waiting)
    mu.tool(TOOL, Asked)
  },
})

/** The questions this machine's agents wait on; none where the daemon half isn't installed. */
function usePending(machine: MachineEntry) {
  return useValue<Question[]>(machine.id, machine.state === 'connected' && has(machine, 'ext:ask-user'), PENDING) ?? []
}

function Waiting({ machine, session }: { machine: MachineEntry; session: SessionInfo }) {
  const questions = usePending(machine).filter((q) => q.session === session.id)
  // The oldest question first; answering it brings up the next.
  const question = questions[0]
  return question ? <QuestionCard key={question.id} machine={machine} question={question} /> : null
}

function QuestionCard({ machine, question }: { machine: MachineEntry; question: Question }) {
  const [error, setError] = useState<string>()
  const answer = (value: string) => {
    setError(undefined)
    return call(machine.id, ANSWER, { id: question.id, answer: value }).catch((e: Error) => { setError(e.message); throw e })
  }
  // A free answer is typed in the composer itself.
  useComposerClaim({ placeholder: question.options.length ? 'Answer, or pick above' : 'Your answer', submit: answer })
  return (
    <div className="ask-user" role="group" aria-label="The agent asks">
      <div className="ask-user__label">needs you</div>
      <div className="ask-user__question">{question.question}</div>
      {question.options.length > 0 && (
        <div className="ask-user__options">
          {question.options.map((option) => <Button key={option} onClick={() => void answer(option).catch(() => {})}>{option}</Button>)}
        </div>
      )}
      {error && <div className="ask-user__error">{error}</div>}
    </div>
  )
}

function Asked({ call: toolCall, result, live }: ToolCallProps) {
  const details = (result?.details ?? live?.details) as AskDetails | undefined
  const question = details?.question ?? String(toolCall.arguments.question ?? '')
  return (
    <div className="ask-user-asked">
      <span className="ask-user-asked__q">? {question}</span>
      {details?.answer !== undefined ? <span className="ask-user-asked__a">→ {details.answer}</span>
        : result ? <span className="ask-user-asked__a is-muted">{result.isError ? 'not answered' : result.text}</span>
        : <span className="ask-user-asked__a is-muted">waiting for your answer</span>}
    </div>
  )
}
