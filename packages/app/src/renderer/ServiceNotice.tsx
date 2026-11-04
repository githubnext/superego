// "Restart required": the background process runs older code than is installed. Outside the transcript and never a
// modal: restart now, when idle, or later (which leaves a quiet reminder).
import { useEffect, useState } from 'react'
import { Button } from '@mu/ui'
import type { ServiceAction, ServiceState } from '../main/restart.ts'

export function ServiceNotice() {
  const [state, setState] = useState<ServiceState>()
  useEffect(() => {
    let live = true
    const off = window.mu.onEvent((event) => { if (event.machine === 'app' && event.method === 'service.changed') setState(event.params as ServiceState) })
    void (window.mu.call('app', 'service.get', {}) as Promise<ServiceState>).then((next) => { if (live) setState((current) => current ?? next) })
    return () => { live = false; off() }
  }, [])
  if (!state || state.phase === 'current') return null

  const act = (action: ServiceAction) => void window.mu.call('app', 'service.act', { action }).catch((error: Error) => {
    setState((current) => current && { ...current, phase: 'error', deferred: false, error: error.message })
  })
  const restarting = state.phase === 'restarting'
  const waiting = state.phase === 'waiting'
  const label = restarting ? 'Restarting…' : waiting ? 'Restart when idle' : state.phase === 'error' ? 'Restart failed' : 'Restart required'
  const detail = state.error ?? (waiting
    ? 'The background process restarts once no agent is working.'
    : 'The background process runs older code than is installed. Restart it to use the new version; sessions and their history are kept.')

  if (state.deferred) {
    return <div className="service-notice is-deferred"><button type="button" title={detail} onClick={() => act('review')}>Restart required</button></div>
  }
  return (
    <div className="service-notice" role="status" aria-live="polite">
      <div className="service-notice__label" title={detail}>{label}</div>
      {state.phase === 'error' && <div className="service-notice__detail">{state.error}</div>}
      {!restarting && (
        <div className="service-notice__actions">
          {!waiting && (state.busy
            ? <Button onClick={() => act('restart')}>Restart when idle</Button>
            : <Button variant="primary" onClick={() => act('restart')}>{state.phase === 'error' ? 'Try again' : 'Restart now'}</Button>)}
          {(waiting || state.busy) && <Button variant="ghost" onClick={() => act('interrupt')} title="Stops working agents now; they resume after the restart">Now…</Button>}
          <Button variant="ghost" onClick={() => act('later')}>{waiting ? 'Cancel' : 'Later'}</Button>
        </div>
      )}
    </div>
  )
}
