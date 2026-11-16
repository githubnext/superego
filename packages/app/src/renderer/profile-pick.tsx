// Picking a profile: for a new thread (NewThread.tsx), or for a thread whose own is gone from under it (ProfileSwitch,
// in the composer's error).
import { useEffect, useState } from 'react'
import type { ProfileInfo, ThreadInfo } from '@superego/protocol'
import { Button, Select } from '@superego/ui'
import { useRegistry } from './registry.tsx'

/** Which of `profiles` (as profile.list gives them): by name, the default as none. */
export function ProfileSelect({ profiles, value, onChange }: { profiles: ProfileInfo[]; value: string | null; onChange(value: string | null): void }) {
  const fallback = profiles.find((p) => p.name === 'default')
  return (
    <Select aria-label="Profile" value={value}
      options={profiles.filter((p) => p.name !== 'default').map((p) => ({ value: p.name, label: `${p.name}${p.scope === 'user' ? ' (yours)' : ''}` }))}
      nullLabel={fallback ? `default${fallback.scope === 'user' ? ' (yours)' : ''}` : 'None'} onChange={onChange} />
  )
}

/**
 * In place of the composer's error when the thread's profile is gone and none of that name is left (`profile_missing`):
 * another profile a thread in its folder could start with, or the default, for it to run from now on
 * (thread.setProfile); then what's in the box is sent. A project's profile not allowed yet is allowed with it.
 */
export function ProfileSwitch({ machine, thread, onSwitched }: { machine: string; thread: ThreadInfo; onSwitched(): void }) {
  const dispatch = useRegistry().router.dispatch
  const [profiles, setProfiles] = useState<ProfileInfo[]>()
  const [picked, setPicked] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    dispatch('profile.list', { cwd: thread.cwd }, { machine, source: 'composer' })
      .then((list) => { if (live) setProfiles(list as ProfileInfo[]) }, (e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [machine, thread.cwd])
  const choice = profiles?.find((p) => p.name === (picked ?? 'default'))
  const allow = Boolean(choice && !choice.allowed)
  const go = async () => {
    setBusy(true)
    setError(undefined)
    try {
      if (allow) await dispatch('profile.allow', { cwd: thread.cwd, name: choice!.name }, { machine, source: 'composer' })
      await dispatch('thread.setProfile', { thread: thread.id, ...(picked ? { profile: picked } : {}) }, { machine, source: 'composer' })
      onSwitched()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <div className="profile-switch">
      <span>The {thread.profile?.name ?? ''} profile is gone. Run this thread with</span>
      {profiles && <ProfileSelect profiles={profiles} value={picked} onChange={setPicked} />}
      <Button disabled={!profiles || busy} onClick={() => void go()}>{allow ? 'Allow and send' : 'Send'}</Button>
      {error && <span>{error}</span>}
    </div>
  )
}
