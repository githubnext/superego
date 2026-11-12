// Settings, drawn generically from what each endpoint registers: the app's own settings and every machine's. Sections
// may name a custom component (`ui`) drawn below their settings; the Providers section is one.
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { useLocalState } from './local-state.ts'
import type { AuthEvent, AuthPrompt, Json, Notifications, ProviderAuthInfo, SectionInfo, SettingInfo, SettingsSnapshot } from '@superego/protocol'
import { Button, Dialog, FontPicker, Select, StatusGlyph, Switch, TextField } from '@superego/ui'
import { remoteCommand } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import type { UiGrant } from '../ui-trust.ts'

import { machine as client, has, loadFonts, useSettings } from './client.ts'
import { mergeSettings, type MergedSetting } from './merge-settings.ts'
import { Keymap } from './Keymap.tsx'
import { useApp, useRegistry } from './extension.tsx'

const APP = 'app'
const MACHINES = '$machines'
const ALL = '$all'

export function SettingsView({ machines, onClose }: { machines: MachineEntry[]; onClose(): void }) {
  const [kept, setTarget] = useLocalState('settings.target', APP)
  // The section kept from last time, unless its machine has gone since.
  const target = kept === APP || kept === MACHINES || kept === ALL || machines.some((m) => m.id === kept) ? kept : APP
  const machine = machines.find((m) => m.id === target)
  const connected = target === APP || machine?.state === 'connected'
  const supported = target === APP || has(machine, 'settings')
  const snapshot = useSettings(target, target !== MACHINES && target !== ALL && connected && supported)
  const editable = machines.filter((m) => m.state === 'connected' && has(m, 'settings'))

  return (
    <Dialog title="Settings" size="large" onClose={onClose} className="settings">
      <div className="settings__body">
        <nav className="settings__nav">
          <button className={target === APP ? 'is-selected' : ''} onClick={() => setTarget(APP)}>General</button>
          {!window.superego.web && <button className={target === MACHINES ? 'is-selected' : ''} onClick={() => setTarget(MACHINES)}>Machines</button>}
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
            : !supported ? <p className="settings__note">The superego on {machine?.label} is too old to change its settings from here. Update it there.</p>
            : !snapshot ? <p className="settings__note">Loading…</p>
            : snapshot.sections.map((section) => <Section key={section.id} target={target} section={section} values={snapshot.values} />)}
        </div>
      </div>
    </Dialog>
  )
}

function Section({ target, section, values }: { target: string; section: SectionInfo; values: SettingsSnapshot['values'] }) {
  const dispatch = useRegistry().router.dispatch
  const custom = useRegistry().settings
  const Custom = section.ui ? custom.get(section.ui) : undefined
  return (
    <section className="settings-section">
      <h2>{section.title}</h2>
      {section.description && <p className="settings__note">{section.description}</p>}
      {section.settings.filter((s) => !s.hidden).map((setting) => (
        <Setting key={setting.key} setting={setting} value={values[setting.key] ?? null}
          apply={(value) => dispatch(target === APP ? 'app.settings.set' : 'settings.set', { key: setting.key, value }, { machine: target, source: 'settings' })} />
      ))}
      {Custom && <Custom target={target} section={section} />}
    </section>
  )
}

/** One setting's row. `apply` changes it wherever it lives; `mixed` shows that the machines it spans disagree. */
function Setting({ setting, value, apply, mixed, note }: {
  setting: SettingInfo; value: Json; apply(value: Json): Promise<unknown>; mixed?: boolean; note?: string
}) {
  const [error, setError] = useState<string>()
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
      nullLabel={setting.nullLabel} loadFonts={loadFonts} onChange={set} />; break
    case 'color': control = <ColorField label={setting.title} value={typeof value === 'string' ? value : String(setting.default ?? '')} fallback={String(setting.default ?? '')} disabled={disabled} onChange={set} onInvalid={setError} />; break
    case 'keymap': return <Keymap setting={setting} value={value} apply={apply} />
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
  const [flow, setFlow] = useState<{ provider: string; id?: string; events: AuthEvent[] }>()
  const [keyFor, setKeyFor] = useState<string>()
  const machine = client(target)

  useEffect(() => machine.on('auth.event', ({ flow: id, event }: Notifications['auth.event']) => {
    setFlow((current) => current?.id === id ? { ...current, events: [...current.events, event] } : current)
    // Open the provider's sign-in page in the browser as soon as the flow has one.
    if (event.type === 'auth_url') window.open(event.url, '_blank')
  }), [target])

  const start = async (provider: string, type: 'api_key' | 'oauth', key?: string) => {
    setFlow({ provider, events: [] })
    try {
      const { flow: id } = await dispatch('auth.login', { provider, type, ...(key ? { key } : {}) }, { machine: target, source: 'settings' }) as { flow: string }
      setFlow((current) => current && { ...current, id })
    } catch (error) {
      setFlow({ provider, events: [{ type: 'failed', message: (error as Error).message }] })
    }
  }
  const last = flow?.events.at(-1)
  const finished = last?.type === 'done' || last?.type === 'failed'

  return (
    <div className="providers">
      {providers.map((provider) => (
        <div key={provider.id} className="provider">
          <div className="setting__label">
            <div>{provider.name}</div>
            <div className="settings__note">{describe(provider)}</div>
          </div>
          <div className="provider__actions">
            {keyFor === provider.id ? (
              <form onSubmit={(e) => { e.preventDefault(); const key = new FormData(e.currentTarget).get('key') as string; setKeyFor(undefined); if (key) void start(provider.id, 'api_key', key) }}>
                <TextField name="key" type="password" autoFocus placeholder="API key" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setKeyFor(undefined) } }} />
              </form>
            ) : (
              <>
                {provider.oauth && <Button onClick={() => void start(provider.id, 'oauth')}>{provider.oauth}</Button>}
                {provider.apiKey && <Button onClick={() => setKeyFor(provider.id)}>API key…</Button>}
                {provider.stored && <Button onClick={() => void dispatch('auth.logout', { provider: provider.id }, { machine: target, source: 'settings' })}>Sign out</Button>}
              </>
            )}
          </div>
        </div>
      ))}
      {flow && (
        <div className="auth-flow">
          <div className="auth-flow__head">
            <b>Signing in to {providers.find((p) => p.id === flow.provider)?.name ?? flow.provider}</b>
            {finished ? <Button onClick={() => setFlow(undefined)}>Close</Button>
              : <Button onClick={() => { if (flow.id) void dispatch('auth.cancel', { flow: flow.id }, { machine: target, source: 'settings' }) }}>Cancel</Button>}
          </div>
          <FlowEvents flowId={flow.id} events={flow.events} target={target} />
        </div>
      )}
    </div>
  )
}

function describe(provider: ProviderAuthInfo) {
  if (!provider.auth) return 'Not signed in'
  const how = provider.auth.type === 'oauth' ? 'signed in' : 'API key'
  return `${how}${provider.auth.source ? ` · ${provider.auth.source}` : ''} · ${provider.models} models`
}

function FlowEvents({ flowId, events, target }: { flowId?: string; events: AuthEvent[]; target: string }) {
  const dispatch = useRegistry().router.dispatch
  const closed = new Set(events.flatMap((e) => e.type === 'prompt_closed' ? [e.id] : []))
  const [answered, setAnswered] = useState<Set<string>>(new Set())
  return (
    <div className="auth-flow__events">
      {events.map((event, index) => {
        switch (event.type) {
          case 'auth_url': return <p key={index}>A sign-in page opened in your browser. <a href={event.url} target="_blank" rel="noreferrer">Open it again</a>{event.instructions ? ` — ${event.instructions}` : ''}</p>
          case 'device_code': return <p key={index}>Enter <code>{event.userCode}</code> at <a href={event.verificationUri} target="_blank" rel="noreferrer">{event.verificationUri}</a></p>
          case 'info': return <p key={index}>{event.message}</p>
          case 'progress': return <p key={index} className="settings__note">{event.message}</p>
          case 'done': return <p key={index} className="auth-flow__done">Signed in.</p>
          case 'failed': return <p key={index} className="setting__error">{event.message}</p>
          case 'prompt':
            if (closed.has(event.id) || answered.has(event.id) || !flowId) return null
            return <PromptField key={index} prompt={event.prompt} onAnswer={(value) => {
              setAnswered((set) => new Set(set).add(event.id))
              void dispatch('auth.respond', { flow: flowId, prompt: event.id, value }, { machine: target, source: 'settings' })
            }} />
          default: return null
        }
      })}
    </div>
  )
}

function PromptField({ prompt, onAnswer }: { prompt: AuthPrompt; onAnswer(value: string): void }) {
  const input = useRef<HTMLInputElement>(null)
  if (prompt.type === 'select') {
    return <div className="auth-flow__prompt"><p>{prompt.message}</p>{prompt.options.map((o) => <Button key={o.id} onClick={() => onAnswer(o.id)}>{o.label}</Button>)}</div>
  }
  return (
    <form className="auth-flow__prompt" onSubmit={(e) => { e.preventDefault(); if (input.current?.value) onAnswer(input.current.value) }}>
      <label>{prompt.message}</label>
      <div className="auth-flow__row">
        <TextField ref={input} autoFocus type={prompt.type === 'secret' ? 'password' : 'text'} placeholder={prompt.placeholder} />
        <Button type="submit" variant="primary">Continue</Button>
      </div>
    </form>
  )
}

/** The machines this app connects to: this computer, and any reached over ssh. */
function Machines({ machines, onOpen }: { machines: MachineEntry[]; onOpen(id: string): void }) {
  const appConfig = useApp()
  const DEFAULT_REMOTE_COMMAND = remoteCommand(appConfig)
  const [adding, setAdding] = useState(false)
  const [via, setVia] = useState(false)
  const [error, setError] = useState<string>()
  const app = client(APP) as unknown as { call(method: string, params: unknown): Promise<unknown> }
  const dispatch = useRegistry().router.dispatch
  const act = (id: string, params: Record<string, unknown>) => { setError(undefined); return dispatch(id, params, { machine: APP, source: 'settings' }).catch((e: Error) => { setError(e.message); throw e }) }

  return (
    <section className="settings-section">
      <h2>Machines</h2>
      <p className="settings__note">
        Every machine runs its own {appConfig.name} daemon with its own threads, models and credentials. Other machines are reached with
        {' '}<code>ssh &lt;target&gt; {DEFAULT_REMOTE_COMMAND}</code> (they need {appConfig.name}, which Install copies over ssh, and ssh access: keys, or Log in for a password or code), or with
        any command that pipes stdio to a daemon, such as <code>docker exec -i</code>.
      </p>
      {machines.map((m) => (
        <div key={m.id} className="machine-row">
          <div className="setting__label">
            <div>
              <StatusGlyph status={{ state: m.state === 'connected' ? 'idle' : m.state === 'connecting' ? 'working' : m.state === 'disabled' ? 'idle' : 'error' }} />{' '}
              {m.remote ? <input className="machine-row__label" defaultValue={m.label} aria-label="Name"
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== m.label) void act('machines.update', { id: m.id, label: e.target.value.trim() }) }} /> : m.label}
            </div>
            <div className="settings__note">
              {m.remote ? <code>{m.remote.route}</code> : 'Local daemon'}
              {m.machine && m.machine.hostname !== m.label ? ` · ${m.machine.hostname}` : ''} · {m.state === 'needs-login' ? 'needs login' : m.state === 'host-key' ? 'host key' : m.state}{m.error && m.state !== 'connected' ? ` — ${m.error}` : ''}
            </div>
            {m.remote && m.state === 'connected' && m.keepsRunning && (m.keepsRunning.service === null || m.keepsRunning.afterLogout === false) && (
              <div className="settings__note machine-row__warning">
                The daemon there stops at logout or reboot, and so does the work in it. On that machine, run <code>{appConfig.id} daemon install</code>.
              </div>
            )}
          </div>
          <div className="provider__actions">
            {m.state === 'connected' && <Button onClick={() => onOpen(m.id)}>Settings</Button>}
            {m.state === 'needs-login' && <Button onClick={() => void act('machines.login', { id: m.id })} title="Opens a terminal where ssh can ask for your password or code">Log in</Button>}
            {m.state === 'host-key' && <Button onClick={() => void act('machines.reconnect', { id: m.id })}>Retry</Button>}
            {m.remote?.ssh && (m.errorKind === 'not_installed' || m.state === 'connected') && (
              <Button onClick={() => void act('machines.install', { id: m.id, service: true })} title={`Copies ${appConfig.name} to ${m.label} over ssh and keeps its daemon running there`}>
                {m.errorKind === 'not_installed' ? 'Install' : 'Update'}
              </Button>
            )}
            {m.errorKind === 'wrong_machine' && <Button onClick={() => void act('machines.trust', { id: m.id })} title="Use whichever machine answers there now, e.g. after a reinstall">Trust this machine</Button>}
            {(m.errorKind === 'version_mismatch' || m.errorKind === 'duplicate_machine') && <Button onClick={() => void act('machines.reconnect', { id: m.id })}>Retry</Button>}
            {m.remote && <Switch label={`Connect to ${m.label}`} checked={m.remote.enabled} onChange={(enabled) => void act('machines.update', { id: m.id, enabled })} />}
            {m.remote && <Button onClick={() => void act('machines.remove', { id: m.id })}>Remove</Button>}
          </div>
        </div>
      ))}
      {adding ? (
        <form className="machine-add" onSubmit={(e) => {
          e.preventDefault()
          const form = new FormData(e.currentTarget)
          const fields = via ? { label: form.get('label'), via: form.get('via') } : { label: form.get('label'), target: form.get('target'), command: form.get('command') }
          void act('machines.add', fields).then(() => setAdding(false), () => {})
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
      <AllowedProfileUis machines={machines} />
    </section>
  )
}

/** The remote profile UIs allowed to run in this window, to forget one by one (it asks again next time). */
function AllowedProfileUis({ machines }: { machines: MachineEntry[] }) {
  const [grants, setGrants] = useState<UiGrant[]>([])
  const load = () => { void (window.superego.call('app', 'ui.trust.list', {}) as Promise<UiGrant[]>).then(setGrants, () => {}) }
  useEffect(load, [])
  if (!grants.length) return null
  return (
    <>
      <h3>Allowed profile UIs</h3>
      <p className="settings__note">Code from these machines' profiles may run in this window, as of the version shown.</p>
      {grants.map((grant) => (
        <div key={`${grant.machine}${grant.dir}`} className="machine-row">
          <div className="setting__label">
            <div>{machines.find((m) => m.machine?.id === grant.machine)?.label ?? grant.machine}</div>
            <div className="settings__note"><code>{grant.dir}</code> · {grant.hash.slice(0, 8)}</div>
          </div>
          <Button onClick={() => void (window.superego.call('app', 'ui.trust.forget', grant) as Promise<unknown>).then(load)}>Forget</Button>
        </div>
      ))}
    </>
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
