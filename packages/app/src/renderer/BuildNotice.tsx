// "App updated": the window runs another build than the main process (see ../main-build.ts), and may call what it
// doesn't know. Restarting the app brings both onto the build on disk. Wide, in the rail (`rail`). A packaged app's
// never differ; a browser's page has no main process.
import { useEffect, useState } from 'react'
import { ArrowClockwiseIcon, Button } from '@superego/ui'
import { build, onBuild } from './window-build.ts'
import { useRegistry } from './registry.tsx'
import { RailNotice } from './rail-notice.tsx'
import { APP } from '../shared/app-settings.ts'

type Drift = { differs: boolean; error?: string }

export function BuildNotice({ rail = false }: { rail?: boolean }) {
  const [drift, setDrift] = useState<Drift>({ differs: false })
  const [restarting, setRestarting] = useState(false)
  useEffect(() => {
    if (window.superego.web) return
    let live = true
    const compare = (next: string | undefined) => void (window.superego.call(APP, 'app.build', { build: next }) as Promise<{ differs: boolean }>).then(
      ({ differs }) => { if (live) setDrift({ differs }) },
      (error: Error & { kind?: string }) => {
        if (!live) return
        // A main process that doesn't know the method is older than this window: that's the drift itself.
        if (error.kind === 'unknown_method') return setDrift({ differs: true })
        console.error('app.build:', error)
        setDrift({ differs: false, error: error.message })
      })
    compare(build)
    const off = onBuild(compare)
    return () => { live = false; off() }
  }, [])
  const dispatch = useRegistry().router.dispatch
  if (!drift.differs && !drift.error) return null

  const restart = () => {
    setRestarting(true)
    void dispatch('app.restart', {}, { machine: APP, source: 'notice' }).catch((error: Error) => {
      console.error('app.restart:', error)
      setRestarting(false)
      setDrift((current) => ({ ...current, error: error.message }))
    })
  }
  const label = drift.differs ? (restarting ? 'Restarting…' : 'App updated') : 'Build check failed'
  const notice = (
    <div className="service-notice build-notice" role="status" aria-live="polite">
      <div className="service-notice__label">{label}</div>
      {drift.differs && <div className="service-notice__note">The app was updated: restart to use it.</div>}
      {drift.error && <div className="service-notice__detail">{drift.error}</div>}
      {!restarting && (
        <div className="service-notice__actions">
          <Button variant="primary" onClick={restart}>Restart</Button>
        </div>
      )}
    </div>
  )
  return rail
    ? <RailNotice kind="build" label={label} tone={drift.error ? 'error' : 'accent'} icon={ArrowClockwiseIcon}>{notice}</RailNotice>
    : notice
}
