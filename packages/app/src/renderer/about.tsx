// Settings → About: this app's version and, in a released app, its updates: when it last looked, a check now, and the
// restart onto an update that's ready.
import { useState } from 'react'
import type { SectionInfo } from '@superego/protocol'
import { Button } from '@superego/ui'
import { APP } from '../shared/app-settings.ts'
import type { UpdateState } from '../shared/updates.ts'
import { useApp, useRegistry } from './registry.tsx'

export function About({ section }: { target: string; section: SectionInfo }) {
  const { name } = useApp()
  const dispatch = useRegistry().router.dispatch
  const [error, setError] = useState<string>()
  const state = section.data as UpdateState | undefined
  if (!state) return null
  const run = (action: string) => {
    setError(undefined)
    void dispatch(action, {}, { machine: APP, source: 'settings' }).catch((e: Error) => {
      console.error(`${action}:`, e)
      setError(e.message)
    })
  }
  const note = {
    off: undefined,
    idle: state.checked ? `Up to date. Checked ${new Date(state.checked).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.` : undefined,
    checking: 'Checking for updates…',
    downloading: 'Downloading an update…',
    ready: `${state.next} is ready.`,
    installing: 'Restarting…',
    error: undefined,
  }[state.phase]

  return (
    <div className="setting">
      <div className="setting__label">
        <div>{name} {state.version}</div>
        {note && <div className="settings__note">{note}</div>}
        {state.error && <div className="setting__error">{state.error}</div>}
        {error && <div className="setting__error">{error}</div>}
      </div>
      {state.phase !== 'off' && (
        <div className="setting__control">
          {state.phase === 'ready' || state.phase === 'installing'
            ? <Button variant="primary" disabled={state.phase === 'installing'} onClick={() => run('app.update.install')}>Restart</Button>
            : <Button disabled={state.phase === 'checking' || state.phase === 'downloading'} onClick={() => run('app.update.check')}>Check for Updates</Button>}
        </div>
      )}
    </div>
  )
}
