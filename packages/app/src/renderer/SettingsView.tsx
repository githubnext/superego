// Settings, drawn generically from what each endpoint registers: the app's own settings and every machine's. Sections
// may name a custom component (`ui`) drawn below their settings; the Providers section is one.
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import { useLocalState } from './local-state.ts'
import { AUTH_REJECTED, type Json, type ProviderAuthInfo, type ProviderRejection, type SectionInfo, type SettingInfo, type SettingsSnapshot } from '@superego/protocol'
import { Button, Dialog, FontPicker, Select, StatusGlyph, Switch, TextField } from '@superego/ui'
import { remoteCommand } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'

import { machine as client, loadFonts, useSettings, useValue } from './client.ts'
import { fonts } from './fonts.ts'
import { takeProviderFocus } from './provider-focus.ts'
import { waitingPhrase } from '../shared.ts'
import { mergeSettings, type MergedSetting } from './merge-settings.ts'
import { Keymap } from './Keymap.tsx'
import { driftNote, MachineDrift } from './machine-drift.tsx'
import { settingsView, useApp, useRegistry } from './extension.tsx'
import { Contained } from './contained.tsx'
import { useMachines, useSettingsDialog } from './state.tsx'
import { useMachineProblems } from './machine-problems.ts'
import { useAllowedUi, useDeclinedUi } from './profile-ui.ts'
import { RevokedUiNotice, sizeOf } from './profile-ui-notice.tsx'
import { SignInFlow } from './sign-in-flow.tsx'

const APP = 'app'
/** Settings → Machines (also opened by Update: see actions.tsx). */
const MACHINES = '$machines'
const ALL = '$all'

/** Settings: wide, a pane beside the rail (Escape goes back); on a phone, a dialog. */
export function SettingsView({ machines, onClose, pane = false }: { machines: MachineEntry[]; onClose(): void; pane?: boolean }) {
  const [kept, setTarget] = useLocalState('settings.target', APP)
  // The section kept from last time, unless its machine has gone since.
  const target = kept === APP || kept === MACHINES || kept === ALL || machines.some((m) => m.id === kept) ? kept : APP
  const machine = machines.find((m) => m.id === target)
  const connected = target === APP || machine?.state === 'connected'
  const snapshot = useSettings(target, target !== MACHINES && target !== ALL && connected)
  const editable = machines.filter((m) => m.state === 'connected')
  useEffect(() => {
    if (!pane) return
    // Escape that something in it took (a picker closing, a field) stays there.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pane, onClose])

  const body = (
      <div className="settings__body">
        <nav className="settings__nav">
          <button className={target === APP ? 'is-selected' : ''} onClick={() => setTarget(APP)}>General</button>
          <button className={target === MACHINES ? 'is-selected' : ''} onClick={() => setTarget(MACHINES)}>Machines</button>
          {editable.length > 1 && <button className={target === ALL ? 'is-selected' : ''} onClick={() => setTarget(ALL)}>All machines</button>}
          {machines.filter((m) => m.state !== 'disabled').map((m) => (
            <button key={m.id} className={`settings__nav-machine ${target === m.id ? 'is-selected' : ''}`} onClick={() => setTarget(m.id)}>
              <StatusGlyph status={{ state: m.state === 'connected' ? 'idle' : 'error' }} /> {m.label}
            </button>
          ))}
        </nav>
        <div className="settings__content">
          {target === MACHINES ? <Machines machines={machines} onOpen={setTarget} />
            : target === ALL ? <AllMachines machines={editable} />
            : !connected ? <p className="settings__note">{machine?.label} is {machine?.state}. Its settings live on it, so they show once it is back.</p>
            : !snapshot ? <p className="settings__note">Loading…</p>
            : snapshot.sections.filter((section) => section.ui || section.settings.some((s) => !s.hidden)).map((section) => <Section key={section.id} target={target} section={section} values={snapshot.values} />)}
        </div>
      </div>
  )
  return pane
    ? <section className="settings settings--pane" aria-label="Settings">{body}</section>
    : <Dialog title="Settings" size="large" onClose={onClose} className="settings">{body}</Dialog>
}

function Section({ target, section, values }: { target: string; section: SectionInfo; values: SettingsSnapshot['values'] }) {
  const dispatch = useRegistry().router.dispatch
  const registry = useRegistry()
  const Custom = section.ui ? settingsView(registry, section.ui, target) : undefined
  return (
    <section className="settings-section">
      <h2>{section.title}</h2>
      {section.description && <p className="settings__note">{section.description}</p>}
      {section.settings.filter((s) => !s.hidden).map((setting) => (
        <Setting key={setting.key} setting={setting} value={values[setting.key] ?? null}
          apply={(value) => dispatch(target === APP ? 'app.settings.set' : 'settings.set', { key: setting.key, value }, { machine: target, source: 'settings' })} />
      ))}
      {Custom && <Contained name={section.ui!}><Custom target={target} section={section} /></Contained>}
    </section>
  )
}

/** The layout's row: to its text, and back to the defaults. Always here, whatever the layout hides. */
function LayoutControl() {
  const dispatch = useRegistry().router.dispatch
  const { close } = useSettingsDialog()
  const run = (id: string) => void dispatch(id, {}, { source: 'settings' }).catch((error) => console.error(error))
  return (
    <span className="setting__buttons">
      <Button onClick={() => { close(); run('layout.edit') }}>Edit layout…</Button>
      <Button onClick={() => run('layout.reset')}>Reset</Button>
    </span>
  )
}

/** One setting's row. `apply` changes it wherever it lives; `mixed` shows that the machines it spans disagree. */
function Setting({ setting, value, apply, mixed, note }: {
  setting: SettingInfo; value: Json; apply(value: Json): Promise<unknown>; mixed?: boolean; note?: string
}) {
  const [error, setError] = useState<string>()
  const knownFonts = useSyncExternalStore(fonts.subscribe, fonts.get)
  const set = (next: Json) => {
    setError(undefined)
    apply(next).catch((e: Error) => setError(e.message))
  }
  if (mixed) value = null
  const disabled = Boolean(setting.disabled)
  let control
  switch (setting.type) {
    case 'boolean': control = <Switch label={setting.title} checked={!mixed && value === true} disabled={disabled} onChange={set} />; break
    case 'choice': control = setting.slider
      ? <StepSlider label={setting.title} options={setting.options} value={typeof value === 'string' ? value : null} disabled={disabled} onChange={set} />
      : <Select aria-label={setting.title} options={setting.options} value={typeof value === 'string' ? value : null} disabled={disabled}
      placeholder={mixed ? 'Mixed' : undefined} nullLabel={setting.nullable ? setting.nullLabel ?? 'Default' : undefined} onChange={set} />; break
    case 'number': control = <TextField type="number" aria-label={setting.title} defaultValue={String(value ?? '')} min={setting.min} max={setting.max} step={setting.step}
      disabled={disabled} onBlur={(e) => set(Number(e.target.value))} />; break
    case 'font': control = <FontPicker label={setting.title} value={typeof value === 'string' ? value : null} monospace={setting.monospace}
      nullLabel={setting.nullLabel} fonts={knownFonts} loadFonts={loadFonts} onChange={set} />; break
    case 'color': control = <ColorField label={setting.title} value={typeof value === 'string' ? value : String(setting.default ?? '')} fallback={String(setting.default ?? '')} disabled={disabled} onChange={set} onInvalid={setError} />; break
    case 'keymap': return <Keymap setting={setting} value={value} apply={apply} />
    case 'layout': control = <LayoutControl />; break
    case 'string': control = <TextField type={setting.secret ? 'password' : 'text'} aria-label={setting.title} defaultValue={typeof value === 'string' ? value : ''}
      placeholder={setting.placeholder} disabled={disabled} onBlur={(e) => set(e.target.value)} />; break
  }
  return (
    <div className="setting" data-key={setting.key}>
      <div className="setting__label">
        <div>{setting.title}</div>
        {(setting.description || setting.disabled) && <div className="settings__note">{setting.disabled ?? setting.description}</div>}
        {(mixed || note) && <div className="settings__note">{[mixed && 'Mixed: the machines differ.', note].filter(Boolean).join(' ')}</div>}
        {error && <div className="setting__error">{error}</div>}
      </div>
      <div className="setting__control">{control}</div>
    </div>
  )
}

/** A choice along a scale: a slider that stops at each option, named under its stops. */
function StepSlider({ label, options, value, disabled, onChange }: {
  label: string; options: { value: string; label: string }[]; value: string | null; disabled: boolean; onChange(value: string): void
}) {
  const at = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <span className="step-slider">
      <input type="range" aria-label={label} aria-valuetext={options[at]?.label} min={0} max={options.length - 1} step={1} value={at} disabled={disabled}
        onChange={(e) => onChange(options[Number(e.target.value)]!.value)} />
      <span className="step-slider__stops" aria-hidden>
        {options.map((option, index) => <span key={option.value} className={index === at ? 'is-current' : ''}>{option.label}</span>)}
      </span>
    </span>
  )
}

/** A colour as sRGB hex, for the system picker (which knows no other): drawn and read back, so any CSS colour works. */
function hexOf(color: string) {
  const context = document.createElement('canvas').getContext('2d')
  if (!context || !CSS.supports('color', color)) return '#000000'
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('')}`
}

/**
 * A colour: its swatch (click it for the system picker) and the CSS it is, to type any colour the browser reads
 * (display-p3, oklch, a name); back to the default when it isn't that.
 */
function ColorField({ label, value, fallback, disabled, onChange, onInvalid }: {
  label: string; value: string; fallback: string; disabled?: boolean; onChange(value: string): void; onInvalid(message: string): void
}) {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  const commit = (next: string) => {
    const trimmed = next.trim()
    if (trimmed === value) return
    if (!CSS.supports('color', trimmed)) { onInvalid(`“${trimmed}” isn't a colour`); setText(value); return }
    onChange(trimmed)
  }
  return (
    <span className="color-field">
      <label className="color-field__swatch" style={{ background: value }} title="Pick a colour">
        <input type="color" aria-label={`${label}: pick`} value={hexOf(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </label>
      <TextField aria-label={label} value={text} disabled={disabled} spellCheck={false} onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value) }} />
      {value !== fallback && <Button onClick={() => onChange(fallback)} disabled={disabled}>Reset</Button>}
    </span>
  )
}

type ProfileRow = {
  name: string; scope: 'user' | 'project'; dir: string; allowed: boolean
  description?: string; model?: string; extends?: string; extensions?: number; ui?: number; without?: string[]; error?: string
}

/** Settings → a machine → Profiles: each one, whose it is, and what it changes about the agent. */
export function Profiles({ section }: { target: string; section: SectionInfo }) {
  const profiles = (section.data ?? []) as ProfileRow[]
  if (!profiles.length) return <p className="settings__note">None yet.</p>
  return (
    <div className="profiles">
      {profiles.map((profile) => {
        // A project's lives in <project>/.superego/profiles/<name>.
        const project = profile.scope === 'project' ? profile.dir.split('/').at(-4) : undefined
        const changes = [
          profile.model,
          profile.extends && `extends ${profile.extends.replace(/^user:/, 'your ')}`,
          profile.extensions ? `${profile.extensions} extension${profile.extensions > 1 ? 's' : ''}` : undefined,
          profile.ui ? 'its own UI' : undefined,
          profile.without?.length ? `without ${profile.without.join(', ')}` : undefined,
        ].filter(Boolean)
        return (
          <div key={profile.dir} className="profile-row">
            <div className="setting__label">
              <div>{profile.name} <span className="profile-row__scope">{project ?? 'yours'}</span></div>
              {profile.description && <div className="settings__note">{profile.description}</div>}
              {changes.length > 0 && <div className="settings__note">{changes.join(' · ')}</div>}
              {profile.error && <div className="setting__error">{profile.error}</div>}
            </div>
            {!profile.allowed && <span className="settings__note" title={`superego profile allow ${profile.name}, in ${project}`}>Not allowed yet</span>}
          </div>
        )
      })}
    </div>
  )
}

export function Providers({ target, section }: { target: string; section: SectionInfo }) {
  const dispatch = useRegistry().router.dispatch
  const providers = (section.data ?? []) as ProviderAuthInfo[]
  // The sign-in going on, if one is: each new one drawn afresh (`n`).
  const [signing, setSigning] = useState<{ provider: string; type: 'api_key' | 'oauth'; key?: string; n: number }>()
  // Opened to sign in to one again ("Sign in again"): there, with its key's field open when it takes a key.
  const [focused] = useState(() => takeProviderFocus(target))
  const [keyFor, setKeyFor] = useState<string | undefined>(() => providers.find((p) => p.id === focused && p.apiKey && !p.oauth)?.id)
  const focusedRow = useRef<HTMLDivElement>(null)
  useEffect(() => { focusedRow.current?.scrollIntoView({ block: 'center' }) }, [])
  const rejected = useValue<ProviderRejection[]>(useMachines().find((m) => m.id === target), AUTH_REJECTED)
  const start = (provider: string, type: 'api_key' | 'oauth', key?: string) =>
    setSigning((current) => ({ provider, type, ...(key ? { key } : {}), n: (current?.n ?? 0) + 1 }))

  return (
    <div className="providers">
      {providers.map((provider) => {
        const rejection = rejected?.find((r) => r.provider === provider.id)
        return (
        <div key={provider.id} className={`provider ${provider.id === focused ? 'is-focused' : ''}`} ref={provider.id === focused ? focusedRow : undefined}>
          <div className="setting__label">
            <div>{provider.name}</div>
            <div className="settings__note">{describe(provider)}</div>
            {rejection && <div className="setting__error">{rejection.summary}. {waitingPhrase(rejection.threads.length)}</div>}
          </div>
          <div className="provider__actions">
            {keyFor === provider.id ? (
              <form onSubmit={(e) => { e.preventDefault(); const key = new FormData(e.currentTarget).get('key') as string; setKeyFor(undefined); if (key) start(provider.id, 'api_key', key) }}>
                <TextField name="key" type="password" autoFocus placeholder="API key" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setKeyFor(undefined) } }} />
              </form>
            ) : (
              <>
                {provider.oauth && <Button onClick={() => start(provider.id, 'oauth')}>{provider.oauth}</Button>}
                {provider.apiKey && <Button onClick={() => setKeyFor(provider.id)}>API key…</Button>}
                {provider.stored && <Button onClick={() => void dispatch('auth.signOut', { provider: provider.id }, { machine: target, source: 'settings' })}>Sign out</Button>}
                {rejection && !rejection.retrying && <Button onClick={() => void dispatch('auth.retry', { provider: provider.id }, { machine: target, source: 'settings' })}>Retry now</Button>}
              </>
            )}
          </div>
        </div>
        )
      })}
      {signing && (
        <SignInFlow
          key={signing.n} machine={target}
          title={`Signing in to ${providers.find((p) => p.id === signing.provider)?.name ?? signing.provider}`}
          start={() => dispatch('auth.signIn', { provider: signing.provider, type: signing.type, ...(signing.key ? { key: signing.key } : {}) }, { machine: target, source: 'settings' }) as Promise<{ flow: string }>}
          onClose={() => setSigning(undefined)}
        />
      )}
    </div>
  )
}

function describe(provider: ProviderAuthInfo) {
  if (!provider.auth) return 'Not signed in'
  const how = provider.auth.type === 'oauth' ? 'signed in' : 'API key'
  return `${how}${provider.auth.source ? ` · ${provider.auth.source}` : ''} · ${provider.models} models`
}

/** The machines this app connects to: this computer, and any reached over ssh. */
/** What failed between this window and a connected machine (see machine-problems.ts), on its row. */
function MachineProblems({ machine }: { machine: string }) {
  return useMachineProblems(machine).map((p) => <div key={p.what} className="settings__note machine-row__warning">{p.what} failed: {p.message}</div>)
}

function Machines({ machines, onOpen }: { machines: MachineEntry[]; onOpen(id: string): void }) {
  const appConfig = useApp()
  const DEFAULT_REMOTE_COMMAND = remoteCommand(appConfig)
  const [adding, setAdding] = useState(false)
  const [via, setVia] = useState(false)
  const [error, setError] = useState<string>()
  const app = client(APP) as unknown as { call(method: string, params: unknown): Promise<unknown> }
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
              <StatusGlyph status={{ state: m.state === 'connected' ? 'idle' : m.state === 'connecting' ? 'working' : m.state === 'disabled' ? 'idle' : 'error' }} />{' '}
              {m.remote && !web ? <input className="machine-row__label" defaultValue={m.label} aria-label="Name"
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== m.label) void act('machine.edit', { id: m.id, label: e.target.value.trim() }) }} /> : m.label}
            </div>
            <div className="settings__note">
              {m.remote ? <code>{m.remote.route}</code> : 'This computer'}
              {m.machine && m.machine.hostname !== m.label ? ` · ${m.machine.hostname}` : ''} · {m.state === 'needs-login' ? 'needs login' : m.state === 'host-key' ? 'host key' : m.state}{m.error && m.state !== 'connected' ? ` — ${m.error}` : ''}
            </div>
            {m.state === 'connected' && <MachineProblems machine={m.id} />}
            {driftNote(m, appConfig.name) && <div className="settings__note machine-row__drift"><MachineDrift machine={m} side="bottom" /> {driftNote(m, appConfig.name)!.text}</div>}
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
function AllMachines({ machines }: { machines: MachineEntry[] }) {
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
