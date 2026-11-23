// On first-run setup, among what was found on the machine: Claude Code, when it's installed there, and whether it's
// signed in (`claude auth status`), asked again on Check again once the user has signed in. Using it makes one of
// Claude Agent's models the machine's default: new threads then run on Claude Code, with the user's "claude" profile
// (made with the first of them).
import { useEffect, useState } from 'react'
import { SetupRow, useDispatch, type MachineEntry, type SetupFound } from '@superego/app/ui'
import { Button, TerminalIcon } from '@superego/ui'
import { about, CHECK, signedIn, type ClaudeCheck } from './shared.ts'

export function ClaudeFound({ machine, use }: { machine: MachineEntry; use(found: SetupFound): void }) {
  const dispatch = useDispatch()
  const [status, setStatus] = useState<ClaudeCheck | { failed: string }>()
  const [checking, setChecking] = useState(false)
  const check = (live: () => boolean = () => true) => {
    setChecking(true)
    dispatch(CHECK, {}, { machine: machine.id, source: 'setup' }).then(
      (said) => { if (live()) setStatus(said as ClaudeCheck) },
      (error: Error) => { console.error('Asking whether Claude Code is signed in failed', error); if (live()) setStatus({ failed: error.message }) },
    ).finally(() => { if (live()) setChecking(false) })
  }
  useEffect(() => {
    let live = true
    check(() => live)
    return () => { live = false }
  }, [machine.id])
  if (!status || ('installed' in status && !status.installed)) return null
  if ('failed' in status) return <SetupRow icon={<TerminalIcon size={14} />} title="Claude Code" detail={<span className="setup__error">{status.failed}</span>} />
  if (!status.loggedIn) {
    return (
      <SetupRow icon={<TerminalIcon size={14} />} title="Claude Code" detail={status.error ? signedIn(status) : 'Not signed in: run claude, then /login'}
        end={<Button disabled={checking} onClick={() => check()}>{checking ? 'Checking…' : 'Check again'}</Button>} />
    )
  }
  const detail = signedIn(status)
  // A Max plan has room for Opus; any other, Sonnet.
  const model = `${about.name}/${status.plan === 'max' ? 'opus' : 'sonnet'}`
  return (
    <SetupRow icon={<TerminalIcon size={14} />} title="Claude Code" detail={`${detail} · experimental`}
      end={<Button onClick={() => use({ label: 'Claude Code', detail, model })}>Use</Button>} />
  )
}
