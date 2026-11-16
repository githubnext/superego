// The thread's profile, in the title bar: its name, and pointed at (or clicked), a card of what it is.
import { Fragment, useState } from 'react'
import type { ProfileInfo, ThreadInfo } from '@superego/protocol'
import { IdentificationBadgeIcon, Popover } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { useRegistry } from './registry.tsx'
import { shortPath } from './short-path.ts'

/**
 * The profile's name, opening a card: what it's for, where it lives, and what it brings (its extensions, and what
 * extensions' keys in it bring: its MCP servers, say), as profile.list tells them for the thread's folder once the
 * card first opens.
 */
export function ProfileChip({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo & { profile: NonNullable<ThreadInfo['profile']> } }) {
  const dispatch = useRegistry().router.dispatch
  const [info, setInfo] = useState<ProfileInfo>()
  const ref = thread.profile
  const load = (open: boolean) => {
    if (!open) return
    void dispatch('profile.list', { cwd: thread.cwd }, { machine: machine.id, source: 'titlebar' })
      .then((list) => setInfo((list as ProfileInfo[]).find((p) => p.dir === ref.dir)), () => setInfo(undefined))
  }
  return (
    <Popover hover side="bottom" align="center" className="profile-card" onOpenChange={load}
      trigger={<button type="button" className="header__chip thread__profile"><IdentificationBadgeIcon size={13} aria-hidden /><span>{ref.name}</span></button>}>
      <div className="profile-card__name">{ref.name}</div>
      {info?.description && <p className="profile-card__about">{info.description}</p>}
      <dl>
        <dt>{ref.scope === 'project' ? 'Project' : 'User'}</dt><dd className="profile-card__path">{shortPath(ref.dir)}</dd>
        {info?.extensions && <><dt>Extensions</dt><dd>{info.extensions.join(', ')}</dd></>}
        {Object.entries(info?.brings ?? {}).map(([what, items]) => <Fragment key={what}><dt>{what}</dt><dd>{items.join(', ')}</dd></Fragment>)}
      </dl>
    </Popover>
  )
}
