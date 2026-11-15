// "Restart required": the background process runs older code than is installed. Outside the transcript and never a
// modal: restart now, when idle, or later (which leaves a quiet reminder). Wide, in the rail (`rail`).
import { useEffect, useState } from 'react'
import { ArrowClockwiseIcon, Button } from '@superego/ui'
import { useRegistry } from './extension.tsx'
import { RailNotice } from './rail-notice.tsx'
import type { ServiceAction, ServiceState } from '../main/restart.ts'

export function ServiceNotice({ rail = false }: { rail?: boolean }) {
  const [state, setState] = useState<ServiceState>()
  useEffect(() => {
    let live = true
    const off = window.superego.onEvent((event) => { if (event.machine === 'app' && event.method === 'service.changed') setState(event.params as ServiceState) })
    void (window.superego.call('app', 'service.get', {}) as Promise<ServiceState>).then((next) => { if (live) setState((current) => current ?? next) })
    return () => { live = false; off() }
  }, [])
  const dispatch = useRegistry().router.dispatch
  if (!state || state.phase === 'current') return null

  const act = (action: ServiceAction) => void dispatch('service.act', { action }, { machine: 'app', source: 'notice' }).catch((error: Error) => {
    setState((current) => current && { ...current, phase: 'error', deferred: false, error: error.message })
  })
  const restarting = state.phase === 'restarting'
  const waiting = state.phase === 'waiting'
  const label = restarting ? 'Restarting…' : waiting ? 'Restart when idle' : state.phase === 'error' ? 'Restart failed' : 'Restart required'
  const detail = state.error ?? (waiting
    ? 'The background process restarts once no agent is working.'
    : 'The background process runs older code than is installed. Restart it to use the new version; threads and their history are kept.')

  if (state.deferred && !rail) {
    return <div className="service-notice is-deferred"><Button title={detail} onClick={() => act('review')}>Restart required…</Button></div>
  }
  const notice = (
    <div className="service-notice" role="status" aria-live="polite">
      <div className="service-notice__label" title={detail}>{label}</div>
      {state.phase === 'error' ? <div className="service-notice__detail">{state.error}</div> : rail && <div className="service-notice__note">{detail}</div>}
      {!restarting && (
        <div className="service-notice__actions">
          {!waiting && (state.busy
            ? <Button onClick={() => act('restart')}>Restart when idle</Button>
            : <Button variant="primary" onClick={() => act('restart')}>{state.phase === 'error' ? 'Try again' : 'Restart now'}</Button>)}
          {(waiting || state.busy) && <Button onClick={() => act('interrupt')} title="Stops working agents now; they resume after the restart">Now…</Button>}
          <Button onClick={() => act('later')}>{waiting ? 'Cancel' : 'Later'}</Button>
        </div>
      )}
    </div>
  )
  // Put off, a quiet mark; opened, it's reviewed: the reminder is up again until put off again.
  return rail
    ? <RailNotice kind="service" label={state.deferred ? 'Restart required' : label} tone={state.phase === 'error' ? 'error' : 'accent'} icon={ArrowClockwiseIcon}
      quiet={state.deferred} {...(state.deferred ? { onOpen: () => act('review') } : {})}>{notice}</RailNotice>
    : notice
}
