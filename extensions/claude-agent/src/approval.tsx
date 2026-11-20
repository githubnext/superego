// What a thread's Claude Code waits on the user for, above the composer: the oldest of its approvals, one at a time.
// A tool call: Allow, Deny, and "Always allow …" when Claude Code offers to remember it. A plan: Approve plan, Keep
// planning. ⌃1–⌃3 pick them, as for a question's options; what's typed in the composer denies it, saying why or what
// to do instead.
import { useState } from 'react'
import { Glyph, keyLabel, Markdown, STATUS_WORDS, useComposer, useComposerClaim, useDispatch, useValue, type MachineEntry } from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { keyMove } from '@superego/agent-ui/question'
import { about, ANSWER, WAITING, type Approval, type Choice } from './shared.ts'

export function Waiting({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  // The thread's own scope: null where the daemon half isn't set up.
  const first = useValue<Approval[]>(machine, WAITING, { scope: thread.id })?.[0]
  if (!first) return null
  return (
    <div className="claude-agent-waiting" role="group" aria-label="Claude Code asks">
      <div className="claude-agent-waiting__label"><Glyph shape="permission" />{STATUS_WORDS.permission}</div>
      <ApprovalCard key={first.id} machine={machine} approval={first} />
    </div>
  )
}

/** The answers an approval offers, in order (⌃1, ⌃2, ⌃3). */
export function choicesOf(approval: Approval): { label: string; choice: Choice }[] {
  if (approval.tool === 'ExitPlanMode') return [{ label: 'Approve plan', choice: 'allow' }, { label: 'Keep planning', choice: 'deny' }]
  return [{ label: 'Allow', choice: 'allow' }, { label: 'Deny', choice: 'deny' }, ...approval.always ? [{ label: approval.always, choice: 'always' as const }] : []]
}

function ApprovalCard({ machine, approval }: { machine: MachineEntry; approval: Approval }) {
  const dispatch = useDispatch()
  const [error, setError] = useState<string>()
  // The answer ↑/↓ highlighted, for ⏎ to pick; typing drops it, so ⏎ then denies with what's typed.
  const [active, setActive] = useState<number>()
  const highlighted = useComposer().text.trim() ? undefined : active
  const plan = approval.tool === 'ExitPlanMode'
  const choices = choicesOf(approval)
  const answer = (choice: Choice, message?: string) => {
    setError(undefined)
    return dispatch(ANSWER, { id: approval.id, choice, ...(message ? { message } : {}) }, { machine: machine.id, source: about.name })
      .catch((e: Error) => { setError(e.message); throw e })
  }
  const pick = (index: number) => void answer(choices[index]!.choice).catch(() => {})
  useComposerClaim({
    placeholder: plan ? 'Or say what to change in the plan…' : 'Or tell Claude what to do instead…',
    submit: (typed) => answer('deny', typed),
    keyDown(event, typed) {
      const move = keyMove(event, typed, highlighted, choices.length)
      if (!move) return false
      if ('pick' in move) pick(move.pick)
      else setActive(move.active)
      return true
    },
  })
  return (
    <>
      {approval.plan && <div className="claude-agent-waiting__plan"><Markdown text={approval.plan} /></div>}
      <div className="claude-agent-approval dock__join">
        <div className="claude-agent-approval__title">{plan ? 'Approve this plan?' : approval.title}</div>
        {approval.reason && <div className="claude-agent-approval__reason">{approval.reason}</div>}
        {approval.preview && <pre className="claude-agent-approval__preview">{approval.preview}</pre>}
        <div className="claude-agent-approval__options">
          {choices.map(({ label }, index) => (
            <button key={label} type="button" className={`claude-agent-approval__option ${index === highlighted ? 'is-active' : ''}`} onClick={() => pick(index)}>
              <span className="claude-agent-approval__key" aria-hidden>{keyLabel(`ctrl+${index + 1}`)}</span>
              <span className="claude-agent-approval__label">{label}</span>
            </button>
          ))}
        </div>
        {error && <div className="claude-agent-approval__error">{error}</div>}
      </div>
    </>
  )
}
