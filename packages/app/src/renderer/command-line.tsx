// Settings → Command line: the app's command on the PATH, installed (a packaged app) or linked (a checkout).
import { useState } from 'react'
import type { SectionInfo } from '@superego/protocol'
import { Button } from '@superego/ui'
import type { CommandLineInfo } from '../shared/bridge.ts'
import { useApp, useRegistry } from './extension.tsx'
import { shortPath } from './short-path.ts'
import { APP } from '../shared/app-settings.ts'

export function CommandLine({ section }: { target: string; section: SectionInfo }) {
  const { id } = useApp()
  const dispatch = useRegistry().router.dispatch
  const [error, setError] = useState<string>()
  const info = section.data as CommandLineInfo | undefined
  if (!info?.kind) return null
  const run = (action: string) => {
    setError(undefined)
    void dispatch(action, {}, { machine: APP, source: 'settings' }).catch((e: Error) => setError(e.message))
  }
  const path = <code>{shortPath(info.path)}</code>
  const install = info.kind === 'link' ? 'Link' : 'Install'

  return (
    <div className="setting">
      <div className="setting__label">
        <div><code>{id}</code></div>
        <div className="settings__note">
          {info.state === 'missing' && <>Start and open threads from a terminal. {install}s {path}.</>}
          {info.state === 'other' && <>{path} is already there, from somewhere else or an older install.</>}
          {info.state === 'installed' && <>{info.kind === 'link' ? 'Linked' : 'Installed'} at {path}.</>}
        </div>
        {info.shadowed === null && <div className="setting__error">Your shell doesn't find it: add <code>{shortPath(info.path.replace(/\/[^/]+$/, ''))}</code> to your PATH.</div>}
        {info.shadowed && <div className="setting__error">Your shell runs <code>{shortPath(info.shadowed)}</code> instead.</div>}
        {error && <div className="setting__error">{error}</div>}
      </div>
      <div className="setting__control">
        {info.state === 'installed'
          ? <Button onClick={() => run('app.cli.uninstall')}>Remove</Button>
          : <Button variant="primary" onClick={() => run('app.cli.install')}>{info.state === 'other' ? 'Replace' : install}</Button>}
      </div>
    </div>
  )
}
