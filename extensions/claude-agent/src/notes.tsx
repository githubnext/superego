// Over the composer of a Claude Agent thread: Claude Code not signed in on its machine, when a turn failed for it, with
// the way to sign in (Claude Code's own `/login`, in a terminal beside the thread that Superego opens running `claude`,
// and leaves to the user); and, quietly, the plan's limit when Claude Code says one is near or reached. Both only what
// the user's own Claude Code reports to them.
import { useState } from 'react'
import { useDispatch, useValue, type SlotProps } from '@superego/app/ui'
import { Button } from '@superego/ui'
import { about, CHECK, LIMIT, limitNote, SIGNED_OUT, TERMINAL, type Limit } from './shared.ts'

/**
 * Claude Code isn't signed in: a terminal to sign in, and a look again once it is (the thread goes on then). How to
 * sign in is the thread's status, said in the transcript.
 */
export function SignInNotice({ machine, thread }: SlotProps['composer.above']) {
  const waits = useValue<boolean>(machine, SIGNED_OUT, { scope: thread.id })
  const dispatch = useDispatch()
  const [error, setError] = useState<string>()
  const [looking, setLooking] = useState(false)
  if (!waits || thread.archived) return null
  const on = { machine: machine.id, source: about.name }
  const terminal = () => {
    setError(undefined)
    dispatch(TERMINAL, { thread: thread.id }, on).catch((e: Error) => { console.error('Opening Claude Code in a terminal failed', e); setError(e.message) })
  }
  const look = () => {
    setError(undefined)
    setLooking(true)
    dispatch(CHECK, {}, on).then(
      (found) => { setLooking(false); if (!(found as { loggedIn?: boolean }).loggedIn) setError('Still not signed in.') },
      (e: Error) => { console.error('Looking at Claude Code failed', e); setLooking(false); setError(e.message) })
  }
  return (
    <div className="service-notice claude-agent-signin" role="status" aria-live="polite">
      <div className="service-notice__label">Claude Code isn’t signed in{machine.id === 'local' ? '' : ` on ${machine.label}`}.</div>
      <div className="service-notice__actions">
        <Button variant="primary" onClick={terminal}>Open a terminal</Button>
        <Button onClick={look} disabled={looking}>{looking ? 'Looking…' : 'Check again'}</Button>
      </div>
      {error && <div className="service-notice__detail">{error}</div>}
    </div>
  )
}

/** The plan's limit, near or reached, in a line: "5-hour limit 80% used, resets 14:20". */
export function LimitNote({ machine, thread }: SlotProps['composer.above']) {
  const limit = useValue<Limit | null>(machine, LIMIT)
  const said = thread.agent?.kind === about.name ? limitNote(limit) : undefined
  if (!said || thread.archived) return null
  return <div className="claude-agent-limit" role="status">{said}</div>
}
