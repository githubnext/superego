// Over the composer of a thread whose profile, on another machine, has UI not allowed in this window: one quiet notice
// to allow it or not, and what it is (its files, each to read as it would run, in a pane). See profile-ui.ts.
import { useState } from 'react'
import { Button, FileTextIcon } from '@superego/ui'
import type { MachineEntry } from '../shared.ts'
import type { PaneProps, UiApi } from './extension.tsx'
import type { ThreadInfo } from '@superego/protocol'
import { Markdown } from './Markdown.tsx'
import { dismissUi, usePendingUi, useProfileSource } from './profile-ui.ts'
import { useRegistry } from './extension.tsx'

/** A size in bytes, as people say it. */
export const sizeOf = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export function registerProfileUi(core: UiApi) {
  core.slot('composer.above', ProfileUiNotice, { order: 50 })
  core.pane('profile-source', {
    title: (pane) => (pane.params as { path?: string } | undefined)?.path?.split('/').at(-1) ?? 'Profile UI', icon: FileTextIcon, file: true, component: SourcePane,
  })
}

function ProfileUiNotice({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const pending = usePendingUi(machine.id, thread.profile)
  const dispatch = useRegistry().router.dispatch
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  if (!pending || thread.archived) return null
  const total = pending.files.reduce((sum, file) => sum + file.size, 0)
  const allow = () => {
    setError(undefined)
    const { machine: id, profile, hash, files } = pending
    void dispatch('profiles.allowUi', { machine: id, profile, hash, files }, { machine: 'app', source: 'profile-ui' }).catch((e: Error) => setError(e.message))
  }
  const show = (path: string) => void dispatch('pane.open', {
    id: thread.id, kind: 'profile-source', params: { dir: pending.profile.dir, name: pending.profile.name, path },
  }, { machine: machine.id, source: 'profile-ui' })
  return (
    <div className="profile-ui-notice" role="status">
      <div>{machine.label}’s profile <b>{pending.profile.name}</b> has UI code. Allow it to run in this window?</div>
      {open && (
        <ul className="profile-ui-notice__files">
          {pending.files.map((file) => (
            <li key={file.path}><button type="button" className="profile-ui-notice__file" onClick={() => show(file.path)}>{file.path}</button> <span>{sizeOf(file.size)}</span></li>
          ))}
        </ul>
      )}
      <div className="profile-ui-notice__actions">
        <Button variant="primary" onClick={allow}>Allow</Button>
        <Button onClick={() => dismissUi(pending)}>Not now</Button>
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {pending.files.length === 1 ? '1 file' : `${pending.files.length} files`}, {sizeOf(total)}
        </Button>
      </div>
      {error && <div className="setting__error">{error}</div>}
    </div>
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
