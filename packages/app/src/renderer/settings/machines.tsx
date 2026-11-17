// Settings → Machines (the machines this app connects to: this computer, and any reached over ssh) and Settings → All
// machines (every connected machine's settings at once).
import { useEffect, useState } from 'react'
import { remoteCommand, type Json, type SettingsSnapshot } from '@superego/protocol'
import { Button, Glyph, Select, Switch, TextField, type GlyphShape } from '@superego/ui'
import type { MachineEntry } from '../../shared/bridge.ts'
import { useSettings } from '../client.ts'
import { useApp, useRegistry } from '../registry.tsx'
import { driftNote, MachineDrift } from '../machine-drift.tsx'
import { useMachineProblems } from '../machine-problems.ts'
import { mergeSettings, type MergedSetting } from '../merge-settings.ts'
import { useAllowedUi, useDeclinedUi } from '../profile-ui.ts'
import { RevokedUiNotice, sizeOf } from '../profile-ui-notice.tsx'
import { Setting } from './controls.tsx'
import { APP } from '../../shared/app-settings.ts'

/** A machine's connection, as a status glyph. */
export const machineGlyph = (state: MachineEntry['state']): GlyphShape =>
  state === 'connected' || state === 'disabled' ? 'idle' : state === 'connecting' ? 'connecting' : 'offline'

/** What failed between this window and a connected machine (see machine-problems.ts), on its row. */
function MachineProblems({ machine }: { machine: string }) {
  return useMachineProblems(machine).map((p) => <div key={p.what} className="settings__note machine-row__warning">{p.what} failed: {p.message}</div>)
}

/** How a machine's Superego differs from this computer's, or how updating it goes, on its row. */
function DriftNote({ machine }: { machine: MachineEntry }) {
  const note = driftNote(machine, useApp().name)
  return note && <div className="settings__note machine-row__drift"><MachineDrift machine={machine} side="bottom" /> {note.text}</div>
}

/** Settings → Machines: this computer, and any reached over ssh. */
export function Machines({ machines, onOpen }: { machines: MachineEntry[]; onOpen(id: string): void }) {
  const appConfig = useApp()
  const DEFAULT_REMOTE_COMMAND = remoteCommand(appConfig)
  const [adding, setAdding] = useState(false)
  const [via, setVia] = useState(false)
  const [error, setError] = useState<string>()
  const dispatch = useRegistry().router.dispatch
  const act = (id: string, params: Record<string, unknown>) => { setError(undefined); return dispatch(id, params, { machine: APP, source: 'settings' }).catch((e: Error) => { setError(e.message); throw e }) }
  const allowedUi = useAllowedUi()
  const declinedUi = useDeclinedUi()
  // In a browser, the machines are those the daemon serving the page reaches: they are managed on its computer.
  const web = Boolean(window.superego.web)
  const serving = machines.find((m) => m.id === 'local')?.label ?? 'this machine'

  return (
    <section className="settings-section">
      <h2>Machines</h2>
      {web ? (
        <p className="settings__note">
          The machines {serving} reaches: this page uses them through it. Adding, removing, logging in and updating are done in the
          desktop app on {serving} (Settings → Machines), or with <code>{appConfig.id} machines</code> there.
        </p>
      ) : <p className="settings__note">
        Every machine runs its own {appConfig.name} daemon with its own threads, models and credentials. Other machines are reached with
        {' '}<code>ssh &lt;target&gt; {DEFAULT_REMOTE_COMMAND}</code> (they need {appConfig.name} installed, and ssh access: keys, or Log in for a password or code), or with
        any command that pipes stdio to a daemon, such as <code>docker exec -i</code>.
      </p>}
      {machines.map((m) => (
        <div key={m.id} className="machine-row">
          <div className="setting__label">
            <div>
              <Glyph shape={machineGlyph(m.state)} />{' '}
              {m.remote && !web ? <input className="machine-row__label" defaultValue={m.label} aria-label="Name"
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== m.label) void act('machine.edit', { id: m.id, label: e.target.value.trim() }) }} /> : m.label}
            </div>
            <div className="settings__note">
              {m.remote ? <code>{m.remote.route}</code> : 'This computer'}
              {m.machine && m.machine.hostname !== m.label ? ` · ${m.machine.hostname}` : ''} · {m.state === 'needs-login' ? 'needs login' : m.state === 'host-key' ? 'host key' : m.state}{m.error && m.state !== 'connected' ? ` — ${m.error}` : ''}
            </div>
            {m.state === 'connected' && <MachineProblems machine={m.id} />}
            <DriftNote machine={m} />
            {m.update && m.update.state !== 'done' && m.update.log && <pre className="machine-row__log">{m.update.log.trimEnd().split('\n').slice(-12).join('\n')}</pre>}
            {/* Its profiles' UI this computer lets run in its window, each for the sources allowed (see profile-ui.ts). */}
            {allowedUi.filter((a) => a.machine === m.id).map((a) => (
              <div key={a.profile.dir} className="settings__note machine-row__ui" title={a.profile.dir}>
                <span>Profile <b>{a.profile.name}</b>’s UI runs here, with this window’s full access · {a.files.length === 1 ? '1 file' : `${a.files.length} files`}, {sizeOf(a.files.reduce((sum, f) => sum + f.size, 0))}</span>
                <Button title="Takes out its views and actions. Reload the window after, to stop anything its code left running"
                  onClick={() => void act('profile.revokeUi', { machine: m.id, dir: a.profile.dir }).catch(() => {})}>Revoke</Button>
              </div>
            ))}
            {/* Revoked after it ran here: a reload clears what its code may have left going. */}
            <RevokedUiNotice machine={m.id} />
            {/* And the ones put off ("Not now"), for the sources they were then: to allow from here too. */}
            {declinedUi.filter((d) => d.machine === m.id).map((d) => (
              <div key={d.profile.dir} className="settings__note machine-row__ui" title={d.profile.dir}>
                <span>Profile <b>{d.profile.name}</b>’s UI isn’t allowed · {d.files.length === 1 ? '1 file' : `${d.files.length} files`}, {sizeOf(d.files.reduce((sum, f) => sum + f.size, 0))}</span>
                <Button onClick={() => void act('profile.allowUi', { machine: m.id, profile: d.profile, hash: d.hash, files: d.files }).catch(() => {})}>Allow</Button>
              </div>
            ))}
            {m.remote && m.state === 'connected' && m.keepsRunning && (m.keepsRunning.service === null || m.keepsRunning.afterLogout === false) && (
              <div className="settings__note machine-row__warning">
                The daemon there stops at logout or reboot, and so does the work in it. On that machine, run <code>{appConfig.id} daemon install</code>.
              </div>
            )}
          </div>
          <div className="provider__actions">
            {m.state === 'connected' && <Button onClick={() => onOpen(m.id)}>Settings</Button>}
            {web && m.remote && m.state !== 'disabled' && <Button onClick={() => void act('machine.reconnect', { id: m.id })}>Reconnect</Button>}
            {web ? null : <>
            {m.state === 'needs-login' && <Button onClick={() => void act('machine.login', { id: m.id })} title="Opens a terminal where ssh can ask for your password or code">Log in</Button>}
            {m.state === 'host-key' && <Button onClick={() => void act('machine.reconnect', { id: m.id })}>Retry</Button>}
            {m.remote && m.state !== 'disabled' && (
              <Button variant={m.drift && m.drift.state !== 'current' && m.drift.state !== 'ahead' ? 'primary' : 'default'} disabled={m.update?.state === 'running'}
                title={`Run scripts/install-machine.sh on ${m.label}: pull, install, and restart ${appConfig.name} there`}
                onClick={() => void act('machine.update', { machine: m.id }).catch(() => {})}>{m.update?.state === 'running' ? 'Updating…' : 'Update'}</Button>
            )}
            {m.errorKind === 'wrong_machine' && <Button onClick={() => void act('machine.trust', { id: m.id })} title="Use whichever machine answers there now, e.g. after a reinstall">Trust this machine</Button>}
            {(m.errorKind === 'version_mismatch' || m.errorKind === 'duplicate_machine') && <Button onClick={() => void act('machine.reconnect', { id: m.id })}>Retry</Button>}
            {m.remote && <Switch label={`Connect to ${m.label}`} checked={m.remote.enabled} onChange={(enabled) => void act('machine.edit', { id: m.id, enabled })} />}
            {m.remote && <Button onClick={() => void act('machine.remove', { id: m.id })}>Remove</Button>}
            </>}
          </div>
        </div>
      ))}
      {web ? null : adding ? (
        <form className="machine-add" onSubmit={(e) => {
          e.preventDefault()
          const form = new FormData(e.currentTarget)
          const fields = via ? { label: form.get('label'), via: form.get('via') } : { label: form.get('label'), target: form.get('target'), command: form.get('command') }
          void act('machine.add', fields).then(() => setAdding(false), () => {})
        }}>
          <Select aria-label="Connect with" value={via ? 'via' : 'ssh'} onChange={(value) => setVia(value === 'via')}
            options={[{ value: 'ssh', label: 'Connect with ssh' }, { value: 'via', label: 'Connect with a command (docker exec, fly ssh, …)' }]} />
          {via ? (
            <TextField name="via" autoFocus required placeholder={`A command piping stdio to ${appConfig.name}, e.g. docker exec -i box ${DEFAULT_REMOTE_COMMAND}`} />
          ) : (
            <>
              <TextField name="target" autoFocus required placeholder="ssh target: user@host, or a Host from ~/.ssh/config" />
              <TextField name="command" placeholder={`Remote command (default: ${DEFAULT_REMOTE_COMMAND})`} />
            </>
          )}
          <TextField name="label" placeholder="Name (optional)" />
          <div className="provider__actions">
            <Button type="submit" variant="primary">Add machine</Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      ) : <div className="machine-add__open"><Button onClick={() => setAdding(true)}>Add machine…</Button></div>}
      {error && <p className="setting__error">{error}</p>}
    </section>
  )
}

/** Report each machine's settings snapshot up, so the parent can merge them; hooks can't run in a loop. */
function MachineSnapshot({ id, onSnapshot }: { id: string; onSnapshot(id: string, snapshot: SettingsSnapshot | undefined): void }) {
  const snapshot = useSettings(id, true)
  useEffect(() => { onSnapshot(id, snapshot) }, [snapshot])
  useEffect(() => () => onSnapshot(id, undefined), [])
  return null
}

/**
 * Edit every connected machine's settings at once. A bulk edit, not a stored default: it changes the machines connected
 * now; machines that are offline or added later keep their own values.
 */
export function AllMachines({ machines }: { machines: MachineEntry[] }) {
  const dispatch = useRegistry().router.dispatch
  const [snapshots, setSnapshots] = useState<Record<string, SettingsSnapshot>>({})
  const onSnapshot = (id: string, snapshot: SettingsSnapshot | undefined) => setSnapshots((all) => {
    const { [id]: _, ...rest } = all
    return snapshot ? { ...rest, [id]: snapshot } : rest
  })
  const label = (id: string) => machines.find((m) => m.id === id)?.label ?? id
  const sections = mergeSettings(snapshots)
  const apply = async (setting: MergedSetting, value: Json) => {
    const results = await Promise.allSettled(setting.machines.map((id) => dispatch('settings.set', { key: setting.key, value }, { machine: id, source: 'all machines' })))
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${label(setting.machines[index]!)}: ${(result.reason as Error).message}`] : [])
    if (failed.length) throw new Error(failed.join('; '))
  }
  return (
    <>
      {machines.map((m) => <MachineSnapshot key={m.id} id={m.id} onSnapshot={onSnapshot} />)}
      <p className="settings__note">
        Changes go to the {machines.length} machines connected now: {machines.map((m) => m.label).join(', ')}.
        Machines that are offline or added later keep their own settings. Model lists show only what every machine offers.
      </p>
      {sections.map((section) => (
        <section key={section.id} className="settings-section">
          <h2>{section.title}</h2>
          {section.settings.map((setting) => (
            <Setting key={setting.key} setting={setting} value={setting.value} mixed={setting.mixed} apply={(value) => apply(setting, value)}
              note={setting.machines.length < machines.length ? `Only on ${setting.machines.map(label).join(', ')}.` : undefined} />
          ))}
        </section>
      ))}
    </>
  )
}
