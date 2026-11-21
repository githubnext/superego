// First-run setup, in the main column: a model to think with, on this computer or another machine. It shows on a fresh
// data folder while no model works here (in the app's first window, with nothing selected), and again when asked
// (Set up models…: Settings → Providers, ⌘K, a composer or ⌘N that couldn't send for lack of a model) until it's done,
// skipped, or a thread is picked.
//
// Picking: what the machine already has (a key in its environment or login shell, a local model server answering, and
// what extensions find: Claude Code, in the `onboarding` slot), or a way in: ChatGPT, GitHub Copilot or OpenRouter's
// sign-in, an API key (tried before it's kept), or a local server's address. Then, for a provider: its default model,
// a few starred, and a "Say hi" round trip proving it works. Then the first thread, in ⌘N.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ONBOARDED, type ModelCatalog, type ModelTest, type ProviderAuthInfo, type SetupProbe } from '@superego/protocol'
import { Button, CheckIcon, GlobeIcon, KeyIcon, LaptopIcon, Select, StarIcon, TerminalIcon, TextField } from '@superego/ui'
import { has, machine as client, useSettings } from './client.ts'
import { useApp, useRegistry } from './registry.tsx'
import { Slot } from './placement.tsx'
import { firstWindow } from './local-state.ts'
import { ModelPicker } from './model-picker.tsx'
import { SignInFlow } from './sign-in-flow.tsx'
import { useMachines, useSelection, useSettingsDialog, useShell, type Selection } from './state.tsx'
import type { MachineEntry } from '../shared/bridge.ts'
import './setup.css'

const LOCAL = 'local'

/** Where setup was asked for: the machine, and the thread to go back to once it's done (a composer that couldn't send). */
type Asked = { machine: string; back?: Selection }
let asked: Asked | undefined
const listeners = new Set<() => void>()
const ask = (value: Asked | undefined) => { if (asked === value) return; asked = value; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Show setup for `machine` (this computer unless given), in place of the thread shown (`back`, gone back to once done). */
export function openSetup(machine = LOCAL, back?: Selection) { ask({ machine, ...(back ? { back } : {}) }) }

/** What extensions found on a machine, as the `onboarding` slot's `use` takes it: a profile its threads start with. */
export type SetupFound = { label: string; detail: string; profile: string }

/**
 * The machine setup shows for now, if it shows: asked for, or on first run (this computer's data folder fresh, and no
 * model working there). A first run with a model already working is set as done without showing.
 */
export function useSetup(): string | undefined {
  const local = useMachines().find((m) => m.id === LOCAL)
  const snapshot = useSettings(LOCAL, local?.state === 'connected')
  const wanted = useSyncExternalStore(subscribe, () => asked)
  const { selection } = useSelection()
  const settings = useSettingsDialog()
  const fresh = firstWindow && snapshot?.values[ONBOARDED] === false && has(local, 'model-setup')
  const [needed, setNeeded] = useState<boolean>()
  useEffect(() => {
    if (!fresh || needed !== undefined) return
    client(LOCAL).call('setup.probe', {}).then((probe) => {
      setNeeded(!probe.usable)
      if (probe.usable) void client(LOCAL).call('settings.set', { key: ONBOARDED, value: true }).catch((error: Error) => console.error('Marking setup done failed', error))
    }, (error: Error) => {
      // Shown anyway: it says what failed.
      console.error('Looking at what this computer has for models failed', error)
      setNeeded(true)
    })
  }, [fresh, needed])
  // Picking a thread puts it away; asked for, it comes out from behind Settings.
  useEffect(() => { if (selection) ask(undefined) }, [selection])
  useEffect(() => { if (wanted) settings.close() }, [wanted])
  if (selection) return undefined
  return wanted?.machine ?? (fresh && needed ? LOCAL : undefined)
}

/** Where to get a key, for the providers people most often have one for. */
const KEY_PAGES: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/keys',
  groq: 'https://console.groq.com/keys',
  mistral: 'https://console.mistral.ai/api-keys',
  xai: 'https://console.x.ai',
  deepseek: 'https://platform.deepseek.com/api_keys',
}
/** The key providers offered first, in this order; the rest after, by name. */
const FIRST_KEYS = ['anthropic', 'openai', 'google']
/** The sign-ins offered as ways in of their own: a subscription or account most people have. */
const SIGN_INS = [
  { provider: 'openai', label: 'Sign in with ChatGPT' },
  { provider: 'github-copilot', label: 'GitHub Copilot' },
  { provider: 'openrouter', label: 'OpenRouter' },
]

type Failure = { message: string }
/** What setup has picked: a provider (its default model to choose and try), or a profile an extension made. */
type Ready = { provider: string; detail: string } | ({ profile: string } & SetupFound)
/** The way in being opened under its row. */
type Open = { kind: 'signIn'; provider: string } | { kind: 'key' } | { kind: 'local' }

export function SetupPage({ machine: machineId }: { machine: string }) {
  const app = useApp()
  const dispatch = useRegistry().router.dispatch
  const machines = useMachines().filter((m) => m.state === 'connected' && has(m, 'model-setup'))
  const machine = useMachines().find((m) => m.id === machineId)
  const snapshot = useSettings(machineId, machine?.state === 'connected')
  const { select } = useSelection()
  const shell = useShell()
  const [probe, setProbe] = useState<SetupProbe | Failure>()
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [ready, setReady] = useState<Ready>()
  const [open, setOpen] = useState<Open>()
  const [problem, setProblem] = useState<string>()
  // Whether the default said hi: then it talks.
  const [talks, setTalks] = useState(false)
  const providers = (snapshot?.sections.find((s) => s.id === 'providers')?.data ?? []) as ProviderAuthInfo[]
  const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? id
  const on = { machine: machineId, source: 'setup' }

  const look = () => client(machineId).call('setup.probe', {}).then(setProbe, (error: Error) => {
    console.error(`Looking at what ${machineId} has for models failed`, error)
    setProbe({ message: error.message })
  })
  const models = () => client(machineId).call('agent.models', {}).then((c) => { setCatalog(c); return c })
  useEffect(() => {
    setProbe(undefined); setReady(undefined); setOpen(undefined); setProblem(undefined); setTalks(false)
    if (!has(machine, 'model-setup')) return
    void look()
    // A model working already: setup opens on it, to change it or add another.
    models().then((c) => {
      const provider = c.default.model?.split('/')[0]
      if (provider && c.models.some((m) => m.value === c.default.model)) setReady((was) => was ?? { provider, detail: 'Signed in' })
    }, (error: Error) => setProblem(`Couldn't list the models: ${error.message}`))
  }, [machineId])

  /** Use a provider: its preferred model the default unless the default is one of its already. */
  const useProvider = async (provider: string, detail: string) => {
    setProblem(undefined); setOpen(undefined)
    try {
      const c = await models()
      if (!c.default.model?.startsWith(`${provider}/`)) {
        const first = c.models.find((m) => m.value.startsWith(`${provider}/`))
        if (!first) throw new Error(`${nameOf(provider)} offers no models with this sign-in`)
        await dispatch('settings.set', { key: 'agent.model', value: first.value }, on)
        await models()
      }
      setReady({ provider, detail })
    } catch (error) {
      console.error(`Using ${provider} failed`, error)
      setProblem((error as Error).message)
    }
  }
  const addLocal = async (name: string, baseUrl: string, listed?: string[]) => {
    const { id } = await dispatch('providers.save', { name, baseUrl, ...(listed?.length ? { models: listed } : {}) }, on) as { id: string }
    void look()
    await useProvider(id, baseUrl.replace(/^https?:\/\//, '').replace(/\/v1$/, ''))
  }
  const finish = (then?: () => void) => {
    const back = asked?.back
    ask(undefined)
    void dispatch('settings.set', { key: ONBOARDED, value: true }, { machine: LOCAL, source: 'setup' }).catch((error: Error) => console.error('Marking setup done failed', error))
    if (back) select(back)
    then?.()
  }

  if (!machine || machine.state !== 'connected') return <div className="setup"><p className="setup__error">{machine?.label ?? machineId} isn't connected.</p></div>
  if (!has(machine, 'model-setup')) {
    return (
      <div className="setup">
        <p>{machine.label} runs an older Superego: set up its models in Settings.</p>
        <div className="setup__foot"><Button onClick={() => finish(() => shell.providers(machineId))}>Open Settings</Button></div>
      </div>
    )
  }

  const where = machines.length > 1 && (
    <Select aria-label="Machine" className="setup__machine" value={machineId} options={machines.map((m) => ({ value: m.id, label: m.label }))}
      onChange={(id) => { if (id) ask({ ...asked, machine: id }) }} />
  )
  const back = asked?.back
  const foot = (
    <div className="setup__foot">
      {back ? <Button variant="primary" disabled={!ready} onClick={() => finish()}>Back to the thread</Button>
        : <Button variant="primary" disabled={!ready} onClick={() => finish(() => shell.newThread({ machine: machineId, ...(ready && 'profile' in ready ? { profile: ready.profile } : {}) }))}>Start a thread</Button>}
      <Button variant="ghost" onClick={() => finish()}>{ready ? 'Done' : 'Skip for now'}</Button>
    </div>
  )

  if (ready) {
    return (
      <div className="setup">
        <header className="setup__hello">
          <span className={`setup__mark ${'profile' in ready || talks ? 'is-awake' : ''}`} aria-hidden />
          <h1>{'profile' in ready ? 'Ready.' : talks ? 'It talks.' : 'Almost there.'}</h1>
          {where}
        </header>
        {'profile' in ready ? <>
          <ul className="setup__rows"><SetupRow icon={<TerminalIcon size={14} />} title={ready.label} detail={ready.detail} end={<CheckIcon size={14} className="setup__ok" aria-label="Ready" />} /></ul>
          <p className="setup__note">New threads with the {ready.profile} profile run on it.</p>
        </> : <Chosen machine={machineId} provider={ready.provider} name={nameOf(ready.provider)} detail={ready.detail} catalog={catalog} onCatalog={models} onTalks={setTalks} />}
        <Button variant="ghost" className="setup__another" onClick={() => setReady(undefined)}>Add another way</Button>
        {foot}
      </div>
    )
  }

  const found = probe && 'usable' in probe ? probe : undefined
  const keyProviders = providers.filter((p) => p.apiKey && !p.keyFlow && !p.custom)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
  return (
    <div className="setup">
      <header className="setup__hello">
        <span className="setup__mark" aria-hidden />
        <h1>Who does the thinking?</h1>
        <p>{app.name} runs on a model you bring.</p>
        {where}
      </header>
      {probe && 'message' in probe && <p className="setup__error">Couldn't look at what {machine.label} has: {probe.message}</p>}
      {problem && <p className="setup__error" role="alert">{problem}</p>}

      <section className="setup__found" aria-label="Found">
        <h2>Found on {machine.label === 'This computer' ? 'this computer' : machine.label}</h2>
        <ul>
          <Slot name="onboarding" props={{ machine, use: (what: SetupFound) => setReady({ ...what }) }} />
          {found?.fromEnv.map((env) => (
            <SetupRow key={env.provider} icon={<KeyIcon size={14} />} title={env.name} detail={`${env.variable}${env.shell ? ', in your shell' : ''}`}
              end={<Button onClick={() => void useProvider(env.provider, env.variable)}>Use</Button>} />
          ))}
          {found?.local.map((server) => (
            <SetupRow key={server.id} icon={<LaptopIcon size={14} />} title={server.name} detail={server.models.slice(0, 3).join(', ') + (server.models.length > 3 ? `, ${server.models.length - 3} more` : '') || 'No models yet'}
              end={<Button disabled={!server.models.length} onClick={() => void (server.provider
                ? useProvider(server.provider, server.baseUrl)
                : addLocal(server.name, server.baseUrl, server.models).catch((error: Error) => { console.error(`Adding ${server.name} failed`, error); setProblem(error.message) }))}>Use</Button>} />
          ))}
        </ul>
        {!probe && <p className="setup__note">Looking…</p>}
      </section>

      <section className="setup__ways" aria-label="Ways in">
        <h2>Or</h2>
        <ul>
          {SIGN_INS.filter((s) => providers.some((p) => p.id === s.provider && p.oauth)).map((s) => (
            <Way key={s.provider} icon={<GlobeIcon size={14} />} title={s.label} open={open?.kind === 'signIn' && open.provider === s.provider}
              onToggle={(now) => setOpen(now ? { kind: 'signIn', provider: s.provider } : undefined)}>
              <SignInFlow machine={machineId} title={`Signing in to ${nameOf(s.provider)}`}
                start={() => dispatch('auth.signIn', { provider: s.provider, type: 'oauth' }, on) as Promise<{ flow: string }>}
                onClose={() => setOpen(undefined)} onDone={() => void useProvider(s.provider, 'Signed in')} />
            </Way>
          ))}
          <Way icon={<KeyIcon size={14} />} title="Paste an API key" open={open?.kind === 'key'} onToggle={(now) => setOpen(now ? { kind: 'key' } : undefined)}>
            <KeyForm machine={machineId} providers={keyProviders} onDone={(provider) => void useProvider(provider, 'API key')} />
          </Way>
          <Way icon={<LaptopIcon size={14} />} title="A local model" detail="Ollama, LM Studio, any OpenAI-compatible server" open={open?.kind === 'local'}
            onToggle={(now) => setOpen(now ? { kind: 'local' } : undefined)}>
            <LocalForm onAdd={addLocal} />
          </Way>
        </ul>
        <p className="setup__note">
          <button type="button" className="setup__link" onClick={() => finish(() => shell.providers(machineId))}>Another provider</button>
          {' '}(Bedrock, Vertex and {Math.max(providers.length - 6, 0)} more) in Settings
        </p>
      </section>
      {foot}
    </div>
  )
}

const rank = (id: string) => { const at = FIRST_KEYS.indexOf(id); return at < 0 ? Infinity : at }

/**
 * A row of setup's lists, as an extension draws one among what was found (the `onboarding` slot): an icon, what it is
 * and a line on it, and what's at its end (a Use button, a check).
 */
export function SetupRow({ icon, title, detail, end, children }: { icon: ReactNode; title: ReactNode; detail?: ReactNode; end?: ReactNode; children?: ReactNode }) {
  return (
    <li className="setup__row">
      <div className="setup__line">
        <span className="setup__icon" aria-hidden>{icon}</span>
        <div className="setup__what"><div>{title}</div>{detail && <div className="setup__detail">{detail}</div>}</div>
        {end}
      </div>
      {children}
    </li>
  )
}

/** A way in: a row that opens what it takes under it. */
function Way({ icon, title, detail, open, onToggle, children }: { icon: ReactNode; title: string; detail?: string; open: boolean; onToggle(open: boolean): void; children: ReactNode }) {
  return (
    <li className={`setup__row setup__way ${open ? 'is-open' : ''}`}>
      <button type="button" className="setup__line" aria-expanded={open} onClick={() => onToggle(!open)}>
        <span className="setup__icon" aria-hidden>{icon}</span>
        <span className="setup__what"><span>{title}</span>{detail && <span className="setup__detail">{detail}</span>}</span>
        <span className="setup__caret" aria-hidden>{open ? '−' : '+'}</span>
      </button>
      {open && <div className="setup__open">{children}</div>}
    </li>
  )
}

/** A provider and its key, tried before it's kept; where to get one, for those people often have. */
function KeyForm({ machine, providers, onDone }: { machine: string; providers: ProviderAuthInfo[]; onDone(provider: string): void }) {
  const dispatch = useRegistry().router.dispatch
  const [provider, setProvider] = useState(providers[0]?.id ?? 'anthropic')
  const [key, setKey] = useState('')
  const [signing, setSigning] = useState<{ key: string; n: number }>()
  const page = KEY_PAGES[provider]
  const name = providers.find((p) => p.id === provider)?.name ?? provider
  return (
    <>
      <form className="setup__key" onSubmit={(e) => { e.preventDefault(); if (key.trim()) setSigning((was) => ({ key: key.trim(), n: (was?.n ?? 0) + 1 })) }}>
        <Select aria-label="Provider" value={provider} options={providers.map((p) => ({ value: p.id, label: p.name }))} onChange={(id) => { if (id) { setProvider(id); setSigning(undefined) } }} />
        <TextField type="password" aria-label="API key" autoFocus placeholder={`${name} API key`} value={key} onChange={(e) => setKey(e.target.value)} />
        <Button type="submit" variant="primary" disabled={!key.trim()}>Add</Button>
      </form>
      {page && <p className="setup__note">Get one at <a href={page} target="_blank" rel="noreferrer">{page.replace(/^https:\/\//, '')}</a></p>}
      {signing && (
        <SignInFlow key={signing.n} machine={machine} title={`Trying the key with ${name}`}
          start={() => dispatch('auth.signIn', { provider, type: 'api_key', key: signing.key, check: true }, { machine, source: 'setup' }) as Promise<{ flow: string }>}
          onClose={() => setSigning(undefined)} onDone={() => onDone(provider)} />
      )}
    </>
  )
}

/** A local server's name and address, its models those it lists. */
function LocalForm({ onAdd }: { onAdd(name: string, baseUrl: string): Promise<void> }) {
  const [name, setName] = useState('Ollama')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <form className="setup__local" onSubmit={(e) => {
      e.preventDefault()
      setBusy(true); setError(undefined)
      onAdd(name.trim(), baseUrl.trim() || 'http://127.0.0.1:11434/v1').catch((failed: Error) => { console.error('Adding a local model failed', failed); setError(failed.message) }).finally(() => setBusy(false))
    }}>
      <TextField aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <TextField aria-label="Address" placeholder="http://127.0.0.1:11434/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add'}</Button>
      {error && <p className="setup__error">{error}</p>}
    </form>
  )
}

/** How many of a provider's models are listed to choose the default from and star; the rest are in the menu after. */
const LISTED = 5

/** A provider chosen: its models to make the default and star, and the default saying hi. */
function Chosen({ machine, provider, name, detail, catalog, onCatalog, onTalks }: {
  machine: string; provider: string; name: string; detail: string; catalog: ModelCatalog | undefined; onCatalog(): Promise<ModelCatalog>; onTalks(talks: boolean): void
}) {
  const dispatch = useRegistry().router.dispatch
  const [test, setTest] = useState<ModelTest | Failure | 'trying'>()
  const [error, setError] = useState<string>()
  const on = { machine, source: 'setup' }
  const value = catalog?.default.model
  const tryIt = () => {
    setTest('trying')
    client(machine).call('model.test', {}).then(setTest, (failed: Error) => { console.error('Trying the model failed', failed); setTest({ message: failed.message }) })
  }
  useEffect(() => { if (value) tryIt() }, [value])
  useEffect(() => onTalks(Boolean(test && test !== 'trying' && !('message' in test))), [test])
  const change = (key: string, next: unknown) => {
    setError(undefined)
    dispatch('settings.set', { key, value: next }, on).then(onCatalog).catch((failed: Error) => { console.error(`Setting ${key} failed`, failed); setError(failed.message) })
  }
  const starred = (catalog?.favourites ?? []).map((f) => f.value)
  const star = (model: string) => change('agent.favourites', starred.includes(model) ? starred.filter((v) => v !== model) : [...starred, model])
  const own = (catalog?.models ?? []).filter((m) => m.value.startsWith(`${provider}/`))
  const listed = [...own].sort((a, b) => Number(b.value === value) - Number(a.value === value) || Number(starred.includes(b.value)) - Number(starred.includes(a.value))).slice(0, LISTED)
  return (
    <>
      <ul className="setup__rows">
        <SetupRow icon={<CheckIcon size={14} className="setup__ok" />} title={name} detail={detail} />
      </ul>
      <section className="setup__models" aria-label="Default model">
        <h2>Default model</h2>
        <ul>
          {listed.map((m) => (
            <li key={m.value} className={`setup__model ${m.value === value ? 'is-default' : ''}`}>
              <button type="button" className={`setup__star ${starred.includes(m.value) ? 'is-on' : ''}`} aria-label={starred.includes(m.value) ? `Unstar ${m.label}` : `Star ${m.label}`}
                aria-pressed={starred.includes(m.value)} onClick={() => star(m.value)}><StarIcon size={13} weight={starred.includes(m.value) ? 'fill' : 'regular'} /></button>
              <button type="button" className="setup__pick" onClick={() => { if (m.value !== value) change('agent.model', m.value) }}>
                <span>{m.label}</span><span className="setup__detail">{m.value === value ? 'Default' : 'Make default'}</span>
              </button>
            </li>
          ))}
        </ul>
        {own.length > LISTED && (
          <ModelPicker label="Another model" catalog={catalog} value={null} placeholder="Another model…"
            onChange={(next) => { if (next && next !== value) change('agent.model', next) }}
            onStar={(next) => change('agent.favourites', next)} />
        )}
        <p className="setup__note">Starred models come first in the model menus.</p>
        {error && <p className="setup__error" role="alert">{error}</p>}
      </section>
      <div className="setup__test" aria-live="polite">
        <Button disabled={test === 'trying' || !value} onClick={tryIt}>Say hi</Button>
        {test === 'trying' ? <span className="setup__note">…</span>
          : test && 'message' in test ? <span className="setup__error">{test.message}</span>
          : test && <><span className="setup__bubble">{test.text || '(an empty answer)'}</span><span className="setup__ms">{(test.ms / 1000).toFixed(1)} s</span></>}
      </div>
    </>
  )
}

/**
 * Where sending failed for lack of a model (the composer, ⌘N): setup for that machine, coming back to `back` once
 * it's done; an older machine's Providers instead. `before` runs first (⌘N closing).
 */
export function NoModel({ machine, back, before }: { machine: MachineEntry; back?: Selection; before?(): void }) {
  const { select } = useSelection()
  const shell = useShell()
  return (
    <span className="setup-card">
      No model on {machine.label} yet.{' '}
      <Button variant="primary" onClick={() => {
        before?.()
        if (!has(machine, 'model-setup')) return shell.providers(machine.id)
        openSetup(machine.id, back)
        select(undefined)
      }}>Set up models…</Button>
    </span>
  )
}
