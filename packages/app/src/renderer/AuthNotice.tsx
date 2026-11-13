// One notice for each provider that rejected a machine's credentials, however many threads it stopped: what happened,
// how many wait, and signing in again (or retrying now). The threads go on by themselves once it's signed in again.
// Dismissed, it stays away until the provider rejects them again.
import { Button } from '@superego/ui'
import { waitingPhrase } from '../shared.ts'
import { useRegistry } from './extension.tsx'
import { useLocalState } from './local-state.ts'
import { useMachines, useRejections, useShell } from './state.tsx'

export function AuthNotice() {
  const machines = useMachines()
  const rejections = useRejections()
  const { signIn } = useShell()
  const dispatch = useRegistry().router.dispatch
  const [dismissed, setDismissed] = useLocalState<string[]>('auth.dismissed', [])
  const all = machines.flatMap((machine) => machine.state !== 'connected' ? [] : (rejections[machine.id] ?? []).map((rejection) => ({
    machine, rejection, key: `${machine.id}/${rejection.provider}/${rejection.since}`,
  })))
  const shown = all.filter((notice) => !dismissed.includes(notice.key))
  if (!shown.length) return null
  // Only those still rejected are kept dismissed: the list doesn't grow.
  const dismiss = (key: string) => setDismissed((list) => [...list.filter((k) => all.some((n) => n.key === k)), key])

  return (
    <>
      {shown.map(({ machine, rejection, key }) => (
        <div key={key} className="service-notice auth-notice" role="status" aria-live="polite">
          <div className="service-notice__label" title={rejection.detail}>{rejection.summary}{machine.remote ? ` on ${machine.label}` : ''}.</div>
          <div className="auth-notice__detail">{rejection.retrying ? 'Retrying…' : waitingPhrase(rejection.threads.length)}</div>
          <div className="service-notice__actions">
            <Button variant="primary" onClick={() => signIn(machine.id, rejection.provider)}>Sign in again</Button>
            <Button disabled={rejection.retrying} onClick={() => void dispatch('auth.retry', { provider: rejection.provider }, { machine: machine.id, source: 'notice' }).catch((error) => console.error(error))}>
              Retry now
            </Button>
            <Button onClick={() => dismiss(key)}>Dismiss</Button>
          </div>
        </div>
      ))}
    </>
  )
}
