// Over the composer of a thread whose profile, on another machine, has UI not allowed in this window: one quiet notice
// to allow it or not, and what it is (its files, each to read as it would run, in a pane). Put off ("Not now"), it's
// remembered on this computer for those sources, and the thread's header says so instead, a click from asking again.
// See profile-ui.ts.
import { useState } from 'react'
import { Button, FileTextIcon, ShieldWarningIcon } from '@superego/ui'
import type { MachineEntry } from '../shared.ts'
import type { PaneProps, UiApi } from './extension.tsx'
import type { ThreadInfo } from '@superego/protocol'
import { Markdown } from './Markdown.tsx'
import { declineUi, dismissRevokedUi, reopenUi, usePendingUi, useProfileSource, useRevokedUi } from './profile-ui.ts'
import { useRegistry } from './extension.tsx'
import { RailNotice } from './rail-notice.tsx'

/** A size in bytes, as people say it. */
export const sizeOf = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export function registerProfileUi(core: UiApi) {
  core.slot('composer.above', ProfileUiNotice, { order: 50 })
  core.slot('header.chips', ProfileUiMarker)
  core.pane('profile-source', {
    title: (pane) => (pane.params as { path?: string } | undefined)?.path?.split('/').at(-1) ?? 'Profile UI', icon: FileTextIcon, file: true, component: SourcePane,
  })
}

function ProfileUiNotice({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const pending = usePendingUi(machine.id, thread.profile)
  const dispatch = useRegistry().router.dispatch
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  // A browser runs no other machine's profile UI: it has no say of this computer's to ask for (see web-bridge.ts).
  if (!pending || pending.declined || thread.archived || window.superego.web) return null
  const total = pending.files.reduce((sum, file) => sum + file.size, 0)
  const say = (id: 'profiles.allowUi' | 'profiles.declineUi') => {
    setError(undefined)
    const { machine, profile, hash, files } = pending
    return dispatch(id, { machine, profile, hash, files }, { machine: 'app', source: 'profile-ui' }).catch((e: Error) => { setError(e.message); throw e })
  }
  const notNow = () => void say('profiles.declineUi').then(() => declineUi(pending), () => {})
  const show = (path: string) => void dispatch('pane.open', {
    id: thread.id, kind: 'profile-source', params: { dir: pending.profile.dir, name: pending.profile.name, path },
  }, { machine: machine.id, source: 'profile-ui' })
  return (
    <div className="profile-ui-notice" role="status">
      <div>{machine.label}’s profile <b>{pending.profile.name}</b> has UI code. Allow it to run in this window? It would have the window’s full access, to every machine.</div>
      {open && (
        <ul className="profile-ui-notice__files">
          {pending.files.map((file) => (
            <li key={file.path}><button type="button" className="profile-ui-notice__file" onClick={() => show(file.path)}>{file.path}</button> <span>{sizeOf(file.size)}</span></li>
          ))}
        </ul>
      )}
      <div className="profile-ui-notice__actions">
        <Button variant="primary" onClick={() => void say('profiles.allowUi').catch(() => {})}>Allow</Button>
        <Button onClick={notNow}>Not now</Button>
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {pending.files.length === 1 ? '1 file' : `${pending.files.length} files`}, {sizeOf(total)}
        </Button>
      </div>
      {error && <div className="setting__error">{error}</div>}
    </div>
  )
}

/**
 * A remote profile's UI revoked after it ran here: its views and actions are gone, but its code may have left
 * something going (a timer, a listener, a request), and only a fresh window is sure to stop it. Offers that reload, in
 * the window (wide, in the rail: `rail`), and, `machine`, in that machine's row in Settings.
 */
export function RevokedUiNotice({ machine, rail = false }: { machine?: string; rail?: boolean }) {
  const revoked = useRevokedUi().filter((r) => !machine || r.machine === machine)
  if (!revoked.length) return null
  const names = revoked.length === 1 ? `the ${revoked[0]!.profile.name} profile’s` : `the ${revoked.map((r) => r.profile.name).join(', ')} profiles’`
  const notice = (
    <div className={machine ? 'settings__note machine-row__revoked' : 'service-notice revoked-ui-notice'} role="status" aria-live="polite">
      <div className={machine ? undefined : 'service-notice__label'}>
        Revoked {names} UI. Reload the window to make sure none of its code keeps running.
      </div>
      <div className={machine ? undefined : 'service-notice__actions'}>
        <Button variant="primary" onClick={() => location.reload()}>Reload</Button>
        {!machine && <Button onClick={() => dismissRevokedUi(revoked)}>Later</Button>}
      </div>
    </div>
  )
  return rail && !machine ? <RailNotice kind="revoked" label="Reload to stop revoked UI" tone="blocked" icon={ShieldWarningIcon}>{notice}</RailNotice> : notice
}

/** Put off for now: a quiet word among the header's chips, that asks again (the notice) when clicked. */
function ProfileUiMarker({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const pending = usePendingUi(machine.id, thread.profile)
  if (!pending?.declined || thread.archived) return null
  return (
    <button type="button" className="titlebar__chip profile-ui-marker" title={`${machine.label}’s profile ${pending.profile.name} has UI code, not allowed to run here`}
      onClick={() => reopenUi(pending, true)}>
      UI not allowed
    </button>
  )
}

/** A file of a profile's UI, read-only, as the window received it: the code that would run (types stripped). */
function SourcePane({ machine, pane }: PaneProps) {
  const { dir = '', path = '' } = (pane.params ?? {}) as { dir?: string; path?: string }
  const code = useProfileSource(machine.id, dir, path)
  if (code === undefined) return <div className="pane-empty">{path} isn’t loaded in this window.</div>
  const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return (
    <div className="profile-source">
      <div className="settings__note">{path}, as {machine.label} serves it to run in this window. Read-only.</div>
      <Markdown text={`${fence}js\n${code}\n${fence}`} />
    </div>
  )
}
