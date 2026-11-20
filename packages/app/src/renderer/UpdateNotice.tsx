// "Superego 0.1.9 is ready": an update of the app downloaded (main/updates.ts), and a restart onto it. Never a modal.
// It shows a download someone asked for too, and a download or an install that failed; a check that failed only says
// so in Settings → About. Wide, in the rail (`rail`). A browser's page has no app to update.
import { useEffect, useState } from 'react'
import { ArrowCircleUpIcon, Button } from '@superego/ui'
import { useApp, useRegistry } from './registry.tsx'
import { RailNotice } from './rail-notice.tsx'
import type { UpdateState } from '../shared/updates.ts'
import { APP } from '../shared/app-settings.ts'

export function UpdateNotice({ rail = false }: { rail?: boolean }) {
  const { name } = useApp()
  const [state, setState] = useState<UpdateState>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (window.superego.web) return
    let live = true
    const off = window.superego.onEvent((event) => { if (event.machine === APP && event.method === 'update.changed') setState(event.params as UpdateState) })
    void (window.superego.call(APP, 'update.get', {}) as Promise<UpdateState>).then(
      (next) => { if (live) setState((current) => current ?? next) },
      (e: Error) => { console.error('update.get:', e); if (live) setError(e.message) })
    return () => { live = false; off() }
  }, [])
  const dispatch = useRegistry().router.dispatch
  if (!state && !error) return null
  const phase = state?.phase
  const shown = error || phase === 'ready' || phase === 'installing' || (phase === 'downloading' && state?.asked) ||
    (phase === 'error' && (state?.failed !== 'check' || state.asked))
  if (!shown) return null

  const run = (action: string) => {
    setError(undefined)
    void dispatch(action, {}, { machine: APP, source: 'notice' }).catch((e: Error) => {
      console.error(`${action}:`, e)
      setError(e.message)
    })
  }
  const label = phase === 'ready' ? `${name} ${state?.next} is ready`
    : phase === 'installing' ? 'Restarting…'
    : phase === 'downloading' ? 'Downloading an update…'
    : 'Update failed'
  const failure = error ?? state?.error
  const notice = (
    <div className="service-notice update-notice" role="status" aria-live="polite">
      <div className="service-notice__label">{label}</div>
      {failure && <div className="service-notice__detail">{failure}</div>}
      {(phase === 'ready' || phase === 'error') && (
        <div className="service-notice__actions">
          {phase === 'ready'
            ? <Button variant="primary" onClick={() => run('app.update.install')}>Restart</Button>
            : <Button onClick={() => run('app.update.check')}>Try again</Button>}
        </div>
      )}
    </div>
  )
  return rail
    ? <RailNotice kind="update" label={label} tone={failure ? 'error' : 'accent'} icon={ArrowCircleUpIcon}>{notice}</RailNotice>
    : notice
}
