// Settings → Machines (the machines this app connects to: this computer, and any reached over ssh) and Settings → All
// machines (every connected machine's settings at once).
import { useEffect, useState } from 'react'
import { remoteCommand, type Json, type SettingsSnapshot } from '@superego/protocol'
import { Button, CaretRightIcon, DotsThreeIcon, Glyph, IconButton, Menu, Select, TextField, Tooltip, type GlyphShape } from '@superego/ui'
import type { AllowedUi } from '@superego/client'
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

/** A span of time, as the Update button says it: "5m", "14h", "3d". */
const shortly = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
}

/** A machine's state, as a word: none when it's connected, as it should be. */
const stateWord = (m: MachineEntry) =>
  m.state === 'connected' ? undefined : m.state === 'needs-login' ? 'needs login' : m.state === 'host-key' ? 'host key changed' : m.state

const filesOf = (ui: AllowedUi) => `${ui.files.length === 1 ? '1 file' : `${ui.files.length} files`}, ${sizeOf(ui.files.reduce((sum, f) => sum + f.size, 0))}`
const profiles = (n: number) => n === 1 ? '1 profile' : `${n} profiles`

/**
 * Its profiles' UI this computer lets run in its window (see profile-ui.ts), and the ones put off ("Not now"): one line,
 * opening to each, to revoke or allow.
 */
function ProfileUis({ allowed, declined, act }: { allowed: AllowedUi[]; declined: AllowedUi[]; act: Act }) {
  const [open, setOpen] = useState(false)
  if (!allowed.length && !declined.length) return null
  const summary = allowed.length
    ? `UI from ${profiles(allowed.length)} runs here${declined.length ? ` · ${declined.length} not allowed` : ''}`
    : `UI from ${profiles(declined.length)} not allowed`
  return (
    <div className="machine-row__uis">
      <button type="button" className="machine-row__ui-summary" aria-expanded={open} onClick={() => setOpen(!open)}
        title={allowed.length ? 'It runs with this window’s full access' : undefined}>
        <CaretRightIcon className="machine-row__caret" size={10} weight="bold" aria-hidden />{summary}
      </button>
      {open && <>
        {allowed.length > 0 && <div className="settings__note">It runs with this window’s full access, to every machine.</div>}
        {allowed.map((a) => (
          <div key={a.profile.dir} className="machine-row__ui" title={a.profile.dir}>
            <span><b>{a.profile.name}</b> · {filesOf(a)}</span>
            <Button title="Takes out its views and actions. Reload the window after, to stop anything its code left running"
              onClick={() => void act('profile.revokeUi', { machine: a.machine, dir: a.profile.dir }).catch(() => {})}>Revoke</Button>
          </div>
        ))}
        {/* Put off for the sources they were then: to allow from here too. */}
        {declined.map((d) => (
          <div key={d.profile.dir} className="machine-row__ui" title={d.profile.dir}>
            <span><b>{d.profile.name}</b> · not allowed · {filesOf(d)}</span>
            <Button onClick={() => void act('profile.allowUi', { machine: d.machine, profile: d.profile, hash: d.hash, files: d.files }).catch(() => {})}>Allow</Button>
          </div>
        ))}
      </>}
    </div>
  )
}

type Act = (id: string, params: Record<string, unknown>) => Promise<unknown>

/** One machine: its state, name and host on a line, the one thing it needs done beside them, the rest in its ··· menu. */
function MachineRow({ m, web, onOpen }: { m: MachineEntry; web: boolean; onOpen(id: string): void }) {
  const appConfig = useApp()
  const dispatch = useRegistry().router.dispatch
  const [error, setError] = useState<string>()
  const [installing, setInstalling] = useState(false)
  const [said, setSaid] = useState<string>()
  // Its own failures, on its row.
  const act: Act = (id, params) => {
    setError(undefined)
    return dispatch(id, params, { machine: APP, source: 'settings' }).catch((e: Error) => { setError(e.message); throw e })
  }
  const allowed = useAllowedUi().filter((a) => a.machine === m.id)
  const declined = useDeclinedUi().filter((d) => d.machine === m.id)
  const drift = driftNote(m, appConfig.name)
  const word = stateWord(m)
  const facts = [m.machine && m.machine.hostname !== m.label ? m.machine.hostname : undefined, word].filter(Boolean).join(' · ')
  const updating = m.update?.state === 'running'
  const updatable = Boolean(m.remote && m.state !== 'disabled' && !web)
  const update = () => void act('machine.update', { machine: m.id }).catch(() => {})
  // Running another Superego than this computer's, older or not known: Update is what it needs.
  const stale = updatable && m.drift && (m.drift.state === 'behind' || m.drift.state === 'differs' || m.drift.state === 'unknown')
  const stopsEarly = m.remote && m.state === 'connected' && m.keepsRunning && (m.keepsRunning.service === null || m.keepsRunning.afterLogout === false)
  const install = () => {
    setInstalling(true)
    setSaid(undefined)
    void act('machine.installService', { id: m.id }).then((answer) => setSaid((answer as { said?: string } | null)?.said), () => {}).finally(() => setInstalling(false))
  }

  // The one thing it needs, if anything: to log in, be tried again or trusted, or updated.
  const needed = web ? null
    : m.state === 'needs-login' ? <Button variant="primary" className="machine-row__action" onClick={() => void act('machine.login', { id: m.id }).catch(() => {})} title="Opens a terminal where ssh can ask for your password or code">Log in</Button>
    : m.state === 'host-key' ? <Button variant="primary" className="machine-row__action" onClick={() => void act('machine.reconnect', { id: m.id }).catch(() => {})}>Retry</Button>
    : m.errorKind === 'wrong_machine' ? <Button variant="primary" className="machine-row__action" onClick={() => void act('machine.trust', { id: m.id }).catch(() => {})} title="Use whichever machine answers there now, e.g. after a reinstall">Trust this machine</Button>
    : m.errorKind === 'version_mismatch' || m.errorKind === 'duplicate_machine' ? <Button variant="primary" className="machine-row__action" onClick={() => void act('machine.reconnect', { id: m.id }).catch(() => {})}>Retry</Button>
    : updating ? <Button className="machine-row__action" disabled>Updating…</Button>
    : stale && drift ? (
      <Tooltip content={drift.text} side="top">
        <Button variant="primary" className="machine-row__action" onClick={update}>
          {m.drift?.state === 'behind' ? `Update · ${shortly(m.drift.by)} behind` : 'Update'}
        </Button>
      </Tooltip>
    ) : null

  return (
    <div className="machine-row" data-machine={m.id} data-state={m.state}>
      <div className="machine-row__head">
        <Glyph shape={machineGlyph(m.state)} label={word ?? 'connected'} />
        <div className="machine-row__title">
          {m.remote && !web ? <input className="machine-row__label" defaultValue={m.label} aria-label="Name"
            onBlur={(e) => { if (e.target.value.trim() && e.target.value !== m.label) void act('machine.edit', { id: m.id, label: e.target.value.trim() }).catch(() => {}) }} />
            : <span className="machine-row__name">{m.label}</span>}
          {facts && <span className="machine-row__facts" title={m.remote?.route}>{facts}</span>}
          {/* Another Superego, not one to update to (a newer one), or updating: said by a dot. */}
          {drift && !stale && !updating && <MachineDrift machine={m} side="top" />}
          {needed}
        </div>
        <MachineMenu m={m} web={web} offerUpdate={updatable && !stale && !updating} update={update} act={act} onOpen={onOpen} />
      </div>
      <div className="machine-row__notes">
        {m.error && m.state !== 'connected' && <div className="settings__note machine-row__warning">{m.error}</div>}
        {m.state === 'connected' && <MachineProblems machine={m.id} />}
        {m.update?.state === 'failed' && <div className="settings__note machine-row__warning">{drift?.text}</div>}
        {m.update && m.update.state !== 'done' && m.update.log && <pre className="machine-row__log">{m.update.log.trimEnd().split('\n').slice(-12).join('\n')}</pre>}
        {stopsEarly && (
          <div className="settings__note machine-row__line">
            <span className="machine-row__warning" title="The daemon there stops at logout or reboot, and so does the work in it">Stops at logout and reboot</span>
            {web ? <span>· run <code>{appConfig.id} daemon install</code> there</span>
              : <Button className="machine-row__small" disabled={installing} title={`Runs ${appConfig.id} daemon install on ${m.label}`} onClick={install}>{installing ? 'Installing…' : 'Install service'}</Button>}
          </div>
        )}
        {stopsEarly && said && <div className="settings__note">{said}</div>}
        <ProfileUis allowed={allowed} declined={declined} act={act} />
        {/* Revoked after it ran here: a reload clears what its code may have left going. */}
        <RevokedUiNotice machine={m.id} />
        {error && <div className="setting__error">{error}</div>}
      </div>
    </div>
  )
}

/** A machine's ··· menu: its route, its settings, and what's done to it now and then. */
function MachineMenu({ m, web, offerUpdate, update, act, onOpen }: {
  m: MachineEntry; web: boolean; offerUpdate: boolean; update(): void; act: Act; onOpen(id: string): void
}) {
  const appConfig = useApp()
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label={`${m.label}: more`} className="view-menu__button machine-row__menu" />}>
        <DotsThreeIcon size={16} weight="bold" aria-hidden />
      </Menu.Trigger>
      <Menu.Popup align="end">
        {m.remote && <Menu.Group><Menu.GroupLabel className="superego-menu__label machine-row__route">{m.remote.route}</Menu.GroupLabel></Menu.Group>}
        <Menu.Item disabled={m.state !== 'connected'} onClick={() => onOpen(m.id)}>Settings</Menu.Item>
        {offerUpdate && <Menu.Item onClick={update}>Update {appConfig.name}</Menu.Item>}
        {web && m.remote && m.state !== 'disabled' && <Menu.Item onClick={() => void act('machine.reconnect', { id: m.id }).catch(() => {})}>Reconnect</Menu.Item>}
        {m.remote && !web && <>
          <Menu.CheckboxItem checked={m.remote.enabled} onCheckedChange={(enabled) => void act('machine.edit', { id: m.id, enabled }).catch(() => {})}>Connect</Menu.CheckboxItem>
          <Menu.Separator />
          <Menu.Item onClick={() => void act('machine.remove', { id: m.id }).catch(() => {})}>Remove</Menu.Item>
        </>}
      </Menu.Popup>
    </Menu.Root>
  )
}

/** Settings → Machines: this computer, and any reached over ssh. */
export function Machines({ machines, onOpen }: { machines: MachineEntry[]; onOpen(id: string): void }) {
  const appConfig = useApp()
  const DEFAULT_REMOTE_COMMAND = remoteCommand(appConfig)
  const [adding, setAdding] = useState(false)
  const [via, setVia] = useState(false)
  const [error, setError] = useState<string>()
  const dispatch = useRegistry().router.dispatch
  // In a browser, the machines are those the daemon serving the page reaches: they are managed on its computer.
  const web = Boolean(window.superego.web)
  const serving = machines.find((m) => m.id === 'local')?.label ?? 'this machine'

  return (
    <section className="settings-section">
      <h2>Machines</h2>
      <p className="settings__note">
        {web ? <>The machines {serving} reaches. Add, remove and update them in the desktop app there, or with <code>{appConfig.id} machines</code>.</>
          : <>Each machine runs its own {appConfig.name}, with its own threads, models and credentials.</>}
      </p>
      {machines.map((m) => <MachineRow key={m.id} m={m} web={web} onOpen={onOpen} />)}
      {web ? null : adding ? (
        <form className="machine-add" onSubmit={(e) => {
          e.preventDefault()
          const form = new FormData(e.currentTarget)
          const fields = via ? { label: form.get('label'), via: form.get('via') } : { label: form.get('label'), target: form.get('target'), command: form.get('command') }
          setError(undefined)
          void dispatch('machine.add', fields, { machine: APP, source: 'settings' }).then(() => setAdding(false), (e: Error) => setError(e.message))
        }}>
          <Select aria-label="Connect with" value={via ? 'via' : 'ssh'} onChange={(value) => setVia(value === 'via')}
            options={[{ value: 'ssh', label: 'Connect with ssh' }, { value: 'via', label: 'Connect with a command (docker exec, fly ssh, …)' }]} />
          {via ? <>
            <TextField name="via" autoFocus required placeholder={`A command piping stdio to ${appConfig.name}, e.g. docker exec -i box ${DEFAULT_REMOTE_COMMAND}`} />
          </> : <>
            <TextField name="target" autoFocus required placeholder="ssh target: user@host, or a Host from ~/.ssh/config" />
            <TextField name="command" placeholder={`Remote command (default: ${DEFAULT_REMOTE_COMMAND})`} />
            <div className="settings__note">It needs {appConfig.name} installed there, and ssh access: keys, or Log in for a password or code.</div>
          </>}
          <TextField name="label" placeholder="Name (optional)" />
          <div className="provider__actions">
            <Button type="submit" variant="primary">Add machine</Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </div>
          {error && <p className="setting__error">{error}</p>}
        </form>
      ) : <div className="machine-add__open"><Button onClick={() => setAdding(true)}>Add machine…</Button></div>}
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
