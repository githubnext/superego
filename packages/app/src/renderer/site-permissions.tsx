// Settings → Site permissions: what each site in Preview was allowed or not, as the user answered in its pane, and a
// way to forget it, so the site asks again.
import { useState } from 'react'
import type { SectionInfo } from '@superego/protocol'
import { Button } from '@superego/ui'
import { APP } from '../shared/app-settings.ts'
import type { SiteAnswer, SitePermission, SitePermissions as Answers } from '../shared/bridge.ts'
import { permissionName, siteName, thisComputer } from '../shared/site-permissions.ts'
import { useRegistry } from './registry.tsx'

export function SitePermissions({ section }: { target: string; section: SectionInfo }) {
  const dispatch = useRegistry().router.dispatch
  const [error, setError] = useState<string>()
  const { sites = {}, problem } = (section.data ?? {}) as { sites?: Answers; problem?: string }
  const computer = thisComputer(navigator.platform)
  const origins = Object.keys(sites).sort((a, b) => siteName(a).localeCompare(siteName(b)))
  const forget = (origin: string) => {
    setError(undefined)
    void dispatch('app.sites.forget', { origin }, { machine: APP, source: 'settings' }).catch((e: Error) => {
      console.error(`Forgetting ${origin}:`, e)
      setError(e.message)
    })
  }
  /** "Camera, Notifications" for the ones answered `answer`. */
  const named = (answers: Answers[string], answer: SiteAnswer) =>
    (Object.entries(answers) as [SitePermission, SiteAnswer][]).filter(([, a]) => a === answer).map(([kind]) => permissionName(kind, computer)).join(', ')
  return (
    <>
      {problem && <p className="setting__error">{problem}</p>}
      {error && <p className="setting__error">{error}</p>}
      {!origins.length && <p className="settings__note">Sites in Preview you allow or block show here.</p>}
      {origins.map((origin) => {
        const allowed = named(sites[origin]!, 'granted')
        const blocked = named(sites[origin]!, 'denied')
        return (
          <div className="setting site-permission" key={origin}>
            <div className="setting__label">
              <div title={origin}>{siteName(origin)}</div>
              <div className="settings__note">{[allowed && `Allowed: ${allowed}`, blocked && `Blocked: ${blocked}`].filter(Boolean).join(' · ')}</div>
            </div>
            <div className="setting__control"><Button onClick={() => forget(origin)}>Remove</Button></div>
          </div>
        )
      })}
    </>
  )
}
