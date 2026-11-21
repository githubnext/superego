// On first-run setup, among what was found on the machine: Claude Code, when it's installed there, and whether it's
// signed in (`claude auth status`). Using it makes the user's "claude" profile, which new threads can start with.
import { useEffect, useState } from 'react'
import { SetupRow, useDispatch, type MachineEntry, type SetupFound } from '@superego/app/ui'
import { Button, TerminalIcon } from '@superego/ui'
import { CHECK, MAKE_PROFILE, signedIn, type ClaudeCheck } from './shared.ts'

export function ClaudeFound({ machine, use }: { machine: MachineEntry; use(found: SetupFound): void }) {
  const dispatch = useDispatch()
  const [status, setStatus] = useState<ClaudeCheck | { failed: string }>()
  const [problem, setProblem] = useState<string>()
  useEffect(() => {
    let live = true
    dispatch(CHECK, {}, { machine: machine.id, source: 'setup' }).then(
      (said) => { if (live) setStatus(said as ClaudeCheck) },
      (error: Error) => { console.error('Asking whether Claude Code is signed in failed', error); if (live) setStatus({ failed: error.message }) })
    return () => { live = false }
  }, [machine.id])
  if (!status || ('installed' in status && !status.installed)) return null
  if ('failed' in status) return <SetupRow icon={<TerminalIcon size={14} />} title="Claude Code" detail={<span className="setup__error">{status.failed}</span>} />
  const detail = status.loggedIn || status.error ? signedIn(status) : 'Not signed in. Run claude, then /login.'
  const take = () => {
    setProblem(undefined)
    dispatch(MAKE_PROFILE, {}, { machine: machine.id, source: 'setup' }).then(
      (made) => use({ label: 'Claude Code', detail, profile: (made as { name: string }).name }),
      (error: Error) => { console.error('Making the Claude profile failed', error); setProblem(error.message) })
  }
  return (
    <SetupRow icon={<TerminalIcon size={14} />} title="Claude Code" detail={problem ? <span className="setup__error">{problem}</span> : `${detail} · runs as the claude profile`}
      end={<Button disabled={!status.loggedIn} onClick={take}>Use</Button>} />
  )
}
