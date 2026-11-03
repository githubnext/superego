// Settings, drawn generically from what each endpoint registers: the app's own settings and every machine's. Sections
// may name a custom component (`ui`) drawn below their settings; the Providers section is one.
import { useEffect, useRef, useState, type ComponentType } from 'react'
import type { AuthEvent, AuthPrompt, Json, Notifications, ProviderAuthInfo, SectionInfo, SettingInfo, SettingsSnapshot } from '@mu/protocol'
import { Button, Dialog, FontPicker, Select, StatusGlyph, Switch, TextField } from '@mu/ui'
import { DEFAULT_REMOTE_COMMAND, type MachineEntry } from '../shared.ts'
import { machine as client, has, loadFonts, useSettings } from './client.ts'
import { mergeSettings, type MergedSetting } from './merge-settings.ts'

const APP = 'app'
const MACHINES = '$machines'
const ALL = '$all'

export function SettingsView({ machines, onClose }: { machines: MachineEntry[]; onClose(): void }) {
  const [target, setTarget] = useState(APP)
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
            : !supported ? <p className="settings__note">The mu on {machine?.label} is too old to change its settings from here. Update it there.</p>
            : !snapshot ? <p className="settings__note">Loading…</p>
            : snapshot.sections.map((section) => <Section key={section.id} target={target} section={section} values={snapshot.values} />)}
        </div>
      </div>
    </Dialog>
  )
}

/** Custom section components by the id a section names in `ui`. Extensions will add theirs here. */
const CUSTOM: Record<string, ComponentType<{ target: string; section: SectionInfo }>> = { providers: Providers }

function Section({ target, section, values }: { target: string; section: SectionInfo; values: SettingsSnapshot['values'] }) {
  const Custom = section.ui ? CUSTOM[section.ui] : undefined
  return (
    <section className="settings-section">
      <h2>{section.title}</h2>
      {section.description && <p className="settings__note">{section.description}</p>}
      {section.settings.filter((s) => !s.hidden).map((setting) => (
        <Setting key={setting.key} setting={setting} value={values[setting.key] ?? null}
          apply={(value) => client(target).call('settings.set', { key: setting.key, value })} />
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
    case 'choice': control = <Select aria-label={setting.title} options={setting.options} value={typeof value === 'string' ? value : null} disabled={disabled}
      placeholder={mixed ? 'Mixed' : undefined} nullLabel={setting.nullable ? setting.nullLabel ?? 'Default' : undefined} onChange={set} />; break
    case 'number': control = <TextField type="number" aria-label={setting.title} defaultValue={String(value ?? '')} min={setting.min} max={setting.max} step={setting.step}
      disabled={disabled} onBlur={(e) => set(Number(e.target.value))} />; break
    case 'font': control = <FontPicker label={setting.title} value={typeof value === 'string' ? value : null} monospace={setting.monospace}
      nullLabel={setting.nullLabel} loadFonts={loadFonts} onChange={set} />; break
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

function Providers({ target, section }: { target: string; section: SectionInfo }) {
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
      const { flow: id } = await machine.call('auth.login', { provider, type, ...(key ? { key } : {}) })
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
                {provider.stored && <Button variant="ghost" onClick={() => void machine.call('auth.logout', { provider: provider.id })}>Sign out</Button>}
              </>
            )}
          </div>
        </div>
      ))}
      {flow && (
        <div className="auth-flow">
          <div className="auth-flow__head">
            <b>Signing in to {providers.find((p) => p.id === flow.provider)?.name ?? flow.provider}</b>
            {finished ? <Button variant="ghost" onClick={() => setFlow(undefined)}>Close</Button>
              : <Button variant="ghost" onClick={() => { if (flow.id) void machine.call('auth.cancel', { flow: flow.id }) }}>Cancel</Button>}
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
              void client(target).call('auth.respond', { flow: flowId, prompt: event.id, value })
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
  const [adding, setAdding] = useState(false)
  const [via, setVia] = useState(false)
  const [error, setError] = useState<string>()
  const app = client(APP) as unknown as { call(method: string, params: unknown): Promise<unknown> }
  const act = (method: string, params: unknown) => { setError(undefined); return app.call(method, params).catch((e: Error) => { setError(e.message); throw e }) }

  return (
    <section className="settings-section">
      <h2>Machines</h2>
      <p className="settings__note">
        Every machine runs its own mu daemon with its own sessions, models and credentials. Other machines are reached with
        {' '}<code>ssh &lt;target&gt; {DEFAULT_REMOTE_COMMAND}</code> (they need mu installed and key-based ssh access), or with
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
              {m.machine && m.machine.hostname !== m.label ? ` · ${m.machine.hostname}` : ''} · {m.state}{m.error && m.state !== 'connected' ? ` — ${m.error}` : ''}
            </div>
          </div>
          <div className="provider__actions">
            {m.state === 'connected' && <Button variant="ghost" onClick={() => onOpen(m.id)}>Settings</Button>}
            {m.errorKind === 'wrong_machine' && <Button onClick={() => void act('machines.trust', { id: m.id })} title="Use whichever machine answers there now, e.g. after a reinstall">Trust this machine</Button>}
            {(m.errorKind === 'version_mismatch' || m.errorKind === 'duplicate_machine') && <Button onClick={() => void act('machines.reconnect', { id: m.id })}>Retry</Button>}
            {m.remote && <Switch label={`Connect to ${m.label}`} checked={m.remote.enabled} onChange={(enabled) => void act('machines.update', { id: m.id, enabled })} />}
            {m.remote && <Button variant="ghost" onClick={() => void act('machines.remove', { id: m.id })}>Remove</Button>}
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
            <TextField name="via" autoFocus required placeholder={`A command piping stdio to mu, e.g. docker exec -i box ${DEFAULT_REMOTE_COMMAND}`} />
          ) : (
            <>
              <TextField name="target" autoFocus required placeholder="ssh target: user@host, or a Host from ~/.ssh/config" />
              <TextField name="command" placeholder={`Remote command (default: ${DEFAULT_REMOTE_COMMAND})`} />
            </>
          )}
          <TextField name="label" placeholder="Name (optional)" />
          <div className="provider__actions">
            <Button type="submit" variant="primary">Add machine</Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
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
  const [snapshots, setSnapshots] = useState<Record<string, SettingsSnapshot>>({})
  const onSnapshot = (id: string, snapshot: SettingsSnapshot | undefined) => setSnapshots((all) => {
    const { [id]: _, ...rest } = all
    return snapshot ? { ...rest, [id]: snapshot } : rest
  })
  const label = (id: string) => machines.find((m) => m.id === id)?.label ?? id
  const sections = mergeSettings(snapshots)
  const apply = async (setting: MergedSetting, value: Json) => {
    const results = await Promise.allSettled(setting.machines.map((id) => client(id).call('settings.set', { key: setting.key, value })))
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
