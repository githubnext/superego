// First-run setup, in the main column: a model to think with, on this computer or another machine. It shows at once on
// a fresh data folder, in the app's first window with nothing selected, and counts as done once a model has answered
// (or it's put away with Done or Skip); and again when asked (Set up models…: Settings → Providers, ⌘K, a composer or
// ⌘N that couldn't send for lack of a model) until it's done, skipped, or a thread is picked. A default that can run
// already (a key in the environment, Claude Code signed in) opens it on that, tried there: one that doesn't answer (a
// revoked key) says so.
//
// Picking: what the machine already has (a key in its environment or login shell, a local model server answering, and
// what extensions find: Claude Code, in the `onboarding` slot), or a way in, each saying what it needs: ChatGPT, GitHub
// Copilot or OpenRouter's sign-in, an API key (whose it is told from the key, and tried before it's kept), a local
// server's address, or any other provider, searched for. Then, for a provider: its default model (its recommended one
// to start with), a few starred, and a test request showing it works. Then the first thread, in ⌘N.
//
// After the model, what extensions say of themselves (the `welcome` slot: Ego's word on asking it for things), and the
// machine's bundled extensions, each with its switch (the very switches of Settings → Extensions, `extensions.<name>`):
// in every state, so a first run that finds a model already still shows them. Not when it was opened from a thread that
// couldn't send: that wants a model, nothing else.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ONBOARDED, type Json, type ModelCatalog, type ModelTest, type ProviderAuthInfo, type SettingInfo, type SettingsSnapshot, type SetupProbe } from '@superego/protocol'
import { Button, CheckIcon, GlobeIcon, KeyIcon, LaptopIcon, MagnifyingGlassIcon, Select, StarIcon, Switch, TerminalIcon, TextField, WarningIcon } from '@superego/ui'
import { has, machine as client, useSettings } from './client.ts'
import { keyProblem, keyProvider, pastedKey } from './key-shapes.ts'
import { useApp, useRegistry } from './registry.tsx'
import { Slot } from './placement.tsx'
import { firstWindow } from './local-state.ts'
import { ModelPicker } from './model-picker.tsx'
import { ProviderForm } from './settings/provider-form.tsx'
import { SignInFlow } from './sign-in-flow.tsx'
import { useMachines, useSelection, useSettingsDialog, useShell, type Selection } from './state.tsx'
import type { MachineEntry } from '../shared/bridge.ts'
import './setup.css'

const LOCAL = 'local'

/**
 * Where setup was asked for: the machine, and the thread to go back to once it's done (a composer that couldn't send);
 * `first` when it opened by itself, on a fresh data folder.
 */
type Asked = { machine: string; back?: Selection; first?: boolean }
let asked: Asked | undefined
const listeners = new Set<() => void>()
const ask = (value: Asked | undefined) => { if (asked === value) return; asked = value; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Show setup for `machine` (this computer unless given), in place of the thread shown (`back`, gone back to once done). */
export function openSetup(machine = LOCAL, back?: Selection) { ask({ machine, ...(back ? { back } : {}) }) }

/**
 * What an extension found on a machine, as the `onboarding` slot's `use` takes it: what it is, a line on it, and the
 * model it runs (another kind of agent's, `<kind>/<model>`), made the machine's default.
 */
export type SetupFound = { label: string; detail: string; model: string }

/** A machine as a sentence names it: "this computer", else its label. */
export const placeName = (machine: Pick<MachineEntry, 'id' | 'label'>) => machine.id === LOCAL ? 'this computer' : machine.label

/**
 * The machine setup shows for now, if it shows: asked for, or on first run (this computer's data folder fresh), at once,
 * as if asked for. It tries what this computer has itself, and counts as done once a model has answered there.
 */
export function useSetup(): string | undefined {
  const local = useMachines().find((m) => m.id === LOCAL)
  const snapshot = useSettings(LOCAL, local?.state === 'connected')
  const wanted = useSyncExternalStore(subscribe, () => asked)
  const { selection } = useSelection()
  const settings = useSettingsDialog()
  const fresh = firstWindow && snapshot?.values[ONBOARDED] === false && has(local, 'model-setup')
  // Shown once for a first run, and not again once put away (a thread picked) while it isn't done.
  const shown = useRef(false)
  useEffect(() => {
    if (!fresh || shown.current || selection) return
    shown.current = true
    ask({ machine: LOCAL, first: true })
  }, [fresh])
  // Picking a thread puts it away; asked for, it comes out from behind Settings.
  useEffect(() => { if (selection) ask(undefined) }, [selection])
  useEffect(() => { if (wanted) settings.close() }, [wanted])
  if (selection) return undefined
  return wanted?.machine
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
/** The sign-ins offered as ways in of their own, a plan or account most people have, each with what it takes. */
const SIGN_INS = [
  { provider: 'openai', label: 'Sign in with ChatGPT', detail: 'Your ChatGPT Plus or Pro plan' },
  { provider: 'github-copilot', label: 'GitHub Copilot', detail: 'Your Copilot plan' },
  { provider: 'openrouter', label: 'OpenRouter', detail: 'Pay as you go, hundreds of models' },
]
/** Providers named first among "More providers": those setup offers no way of its own to. */
const MORE_NAMED = ['amazon-bedrock', 'google-vertex', 'azure']

type Failure = { message: string }
/**
 * What setup has picked: a provider, or another kind of agent (`claude-agent`); its default model to choose and try.
 * What an extension found is named as its row was (Claude Code), with its line.
 */
type Ready = { provider: string; name?: string; detail?: string }
/**
 * The way in being opened under its row: a sign-in (Copilot's to a GitHub Enterprise when `enterprise`, at `domain`
 * once it's given), a key, a local server, any provider.
 */
type Open = { kind: 'signIn'; provider: string; enterprise?: boolean; domain?: string } | { kind: 'key' } | { kind: 'local' } | { kind: 'more' }

/** How a provider is signed in, in a few words: a sign-in, the variable its key is read from, a key, a server's address. */
function howSignedIn(info: ProviderAuthInfo | undefined): string {
  if (info?.custom) return info.custom.baseUrl.replace(/^https?:\/\//, '').replace(/\/v1$/, '')
  if (!info?.auth) return ''
  if (info.auth.type === 'oauth') return 'Signed in'
  return info.auth.source && info.env?.includes(info.auth.source) ? `Key from ${info.auth.source}` : 'API key'
}

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
  // Whether the first look (what's there, and the models) is in: until it is, which view to open on isn't known.
  const [looked, setLooked] = useState(false)
  // Whether the default model answered the test.
  const [talks, setTalks] = useState(false)
  const providers = (snapshot?.sections.find((s) => s.id === 'providers')?.data ?? []) as ProviderAuthInfo[]
  const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? id
  const on = { machine: machineId, source: 'setup' }

  // Connected, and new enough for setup: looked at once it is.
  const settable = machine?.state === 'connected' && has(machine, 'model-setup')
  const look = () => client(machineId).call('setup.probe', {}).then((found) => { setProbe(found); return found }, (error: Error) => {
    console.error(`Looking at what ${machineId} has for models failed`, error)
    setProbe({ message: error.message })
    return undefined
  })
  const models = () => client(machineId).call('agent.models', {}).then((c) => { setCatalog(c); return c })
  useEffect(() => {
    setProbe(undefined); setReady(undefined); setOpen(undefined); setProblem(undefined); setTalks(false); setLooked(false)
    if (!settable) return
    let live = true
    const listed = models().catch((error: Error) => {
      console.error(`Listing ${machineId}'s models failed`, error)
      setProblem(`Couldn't list the models: ${error.message}`)
      return undefined
    })
    // A default that can run already: setup opens on it, to try it, change it or add another.
    void Promise.all([look(), listed]).then(([found, c]) => {
      if (!live) return
      const provider = c?.agents?.find((a) => a.models.some((m) => m.value === c.default.model))?.kind ?? c?.default.model?.split('/')[0]
      if (found?.usable && provider) setReady((was) => was ?? { provider })
      setLooked(true)
    })
    return () => { live = false }
  }, [machineId, settable])
  // Whether the default runs: another kind's as the machine says (setup.probe), a provider's once it has answered here.
  const readyKind = ready && catalog?.agents?.find((a) => a.kind === ready.provider)
  const works = Boolean(ready) && (readyKind ? Boolean(probe && 'usable' in probe && probe.usable) : talks)
  // A model that runs is setup done: a first run doesn't come back once one has.
  const marked = useRef(false)
  useEffect(() => {
    if (!works || marked.current) return
    marked.current = true
    void dispatch('settings.set', { key: ONBOARDED, value: true }, { machine: LOCAL, source: 'setup' }).catch((error: Error) => console.error('Marking setup done failed', error))
  }, [works])

  /** Use a provider: its recommended model the default, unless the default is one of its already. */
  const useProvider = async (provider: string) => {
    setProblem(undefined); setOpen(undefined)
    try {
      const c = await models()
      if (!c.default.model?.startsWith(`${provider}/`)) {
        const own = c.models.filter((m) => m.value.startsWith(`${provider}/`))
        const first = own.find((m) => m.recommended) ?? own[0]
        if (!first) throw new Error(`${nameOf(provider)} offers no models with this sign-in`)
        await dispatch('settings.set', { key: 'agent.model', value: first.value }, on)
        await models()
      }
      setReady({ provider })
    } catch (error) {
      console.error(`Using ${provider} failed`, error)
      setProblem((error as Error).message)
    }
  }
  /** Use what an extension found: its model the machine's default, so new threads run on it. */
  const useFound = async (found: SetupFound) => {
    setProblem(undefined); setOpen(undefined)
    try {
      await dispatch('settings.set', { key: 'agent.model', value: found.model }, on)
      await Promise.all([models(), look()])
      setReady({ provider: found.model.slice(0, found.model.indexOf('/')), name: found.label, detail: found.detail })
    } catch (error) {
      console.error(`Using ${found.label} failed`, error)
      setProblem((error as Error).message)
    }
  }
  const addLocal = async (name: string, baseUrl: string, listed?: string[]) => {
    const { id } = await dispatch('providers.save', { name, baseUrl, ...(listed?.length ? { models: listed } : {}) }, on) as { id: string }
    void look()
    await useProvider(id)
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
        <p>{machine.label} runs an older version of {app.name}. Set up its models in Settings.</p>
        <div className="setup__foot"><Button onClick={() => finish(() => shell.providers(machineId))}>Open Settings</Button></div>
      </div>
    )
  }

  const where = machines.length > 1 && (
    <Select aria-label="Machine" className="setup__machine" value={machineId} options={machines.map((m) => ({ value: m.id, label: m.label }))}
      onChange={(id) => { if (id) ask({ ...asked, machine: id }) }} />
  )
  const back = asked?.back
  const title = back ? 'Set up a model' : asked?.first ? `Welcome to ${app.name}` : `Set up ${app.name}`
  const hello = (awake = false) => (
    <header className="setup__hello">
      <span className={`setup__mark ${awake ? 'is-awake' : ''}`} aria-hidden />
      <h1>{title}</h1>
      {where}
    </header>
  )
  // What else there is to set up: not when it's a thread waiting on a model.
  const rest = !back && (
    <>
      <Slot name="welcome" props={{ machine }} />
      <Extensions machine={machineId} snapshot={snapshot} />
    </>
  )
  const foot = (
    <div className="setup__foot">
      {ready && (back ? <Button variant="primary" onClick={() => finish()}>Back to the thread</Button>
        : <Button variant="primary" onClick={() => finish(() => shell.newThread({ machine: machineId }))}>Start a thread</Button>)}
      <Button variant="ghost" onClick={() => finish()}>{ready ? 'Done' : 'Skip for now'}</Button>
    </div>
  )

  if (!looked) {
    return (
      <div className="setup">
        {hello()}
        <p className="setup__note">Looking…</p>
        {rest}
      </div>
    )
  }

  if (ready) {
    const kind = readyKind
    return (
      <div className="setup">
        {hello(works)}
        <Chosen machine={machineId} provider={ready.provider} name={ready.name ?? kind?.title ?? nameOf(ready.provider)}
          detail={kind ? kind.unavailable ?? ready.detail ?? kind.description ?? '' : howSignedIn(providers.find((p) => p.id === ready.provider))}
          catalog={catalog} onCatalog={models} onTalks={setTalks} />
        <button type="button" className="setup__link setup__another" onClick={() => setReady(undefined)}>Add another provider</button>
        {rest}
        {foot}
      </div>
    )
  }

  const found = probe && 'usable' in probe ? probe : undefined
  const keyProviders = providers.filter((p) => p.apiKey && !p.keyFlow && !p.custom && !SIGN_INS.some((s) => s.provider === p.id && s.provider !== 'openai'))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
  const more = providers.filter((p) => !p.custom && (p.oauth || p.apiKey))
  const named = MORE_NAMED.flatMap((id) => providers.find((p) => p.id === id)?.name ?? [])
  const toggle = (way: Open) => (now: boolean) => setOpen(now ? way : undefined)
  const isOpen = (way: Open) => JSON.stringify(open) === JSON.stringify(way)
  return (
    <div className="setup">
      {hello()}
      {probe && 'message' in probe && <p className="setup__error">Couldn't look at what {placeName(machine)} has: {probe.message}</p>}
      {problem && <p className="setup__error" role="alert">{problem}</p>}

      <section className="setup__found" aria-label="Found">
        <h2>Found on {placeName(machine)}</h2>
        <ul>
          <Slot name="onboarding" props={{ machine, use: (what: SetupFound) => void useFound(what) }} />
          {found?.fromEnv.map((env) => (
            <SetupRow key={env.provider} icon={<KeyIcon size={14} />} title={env.name} detail={`${env.variable}${env.shell ? ', in your shell' : ''}`}
              end={<Button onClick={() => void useProvider(env.provider)}>Use</Button>} />
          ))}
          {found?.local.map((server) => (
            <SetupRow key={server.id} icon={<LaptopIcon size={14} />} title={server.name} detail={server.models.slice(0, 3).join(', ') + (server.models.length > 3 ? `, ${server.models.length - 3} more` : '') || 'No models yet'}
              end={<Button disabled={!server.models.length} onClick={() => void (server.provider
                ? useProvider(server.provider)
                : addLocal(server.name, server.baseUrl, server.models).catch((error: Error) => { console.error(`Adding ${server.name} failed`, error); setProblem(error.message) }))}>Use</Button>} />
          ))}
        </ul>
      </section>

      <section className="setup__ways" aria-label="Ways in">
        <h2>Connect</h2>
        <ul>
          {SIGN_INS.filter((s) => providers.some((p) => p.id === s.provider && p.oauth)).map((s) => {
            const way: Open = { kind: 'signIn', provider: s.provider }
            const enterprise: Open = { ...way, enterprise: true }
            const signing = open?.kind === 'signIn' && open.provider === s.provider ? open : undefined
            const copilot = s.provider === 'github-copilot'
            return (
              <Way key={s.provider} icon={<GlobeIcon size={14} />} title={s.label} detail={s.detail} open={Boolean(signing)} onToggle={toggle(way)}>
                {signing?.enterprise && signing.domain === undefined ? <EnterpriseForm onStart={(domain) => setOpen({ ...enterprise, domain })} />
                  : signing && <SignInFlow key={signing.domain ?? 'github'} machine={machineId} title="Signing in…"
                    start={() => dispatch('auth.signIn', { provider: s.provider, type: 'oauth', ...(copilot ? { domain: signing.domain ?? '' } : {}) }, on) as Promise<{ flow: string }>}
                    onClose={() => setOpen(undefined)} onDone={() => void useProvider(s.provider)} />}
                {copilot && signing && !signing.enterprise && (
                  <p className="setup__note"><button type="button" className="setup__link" onClick={() => setOpen(enterprise)}>Signing in to GitHub Enterprise?</button></p>
                )}
              </Way>
            )
          })}
          <Way icon={<KeyIcon size={14} />} title="Paste an API key" detail={`${keyProviders.slice(0, 3).map((p) => p.name).join(', ')} and more`}
            open={isOpen({ kind: 'key' })} onToggle={toggle({ kind: 'key' })}>
            <KeyForm machine={machineId} providers={keyProviders} all={providers} onDone={(provider) => void useProvider(provider)} />
          </Way>
          <Way icon={<LaptopIcon size={14} />} title="Local model" detail={`Free, runs on ${placeName(machine)}: Ollama, LM Studio and the like`}
            open={isOpen({ kind: 'local' })} onToggle={toggle({ kind: 'local' })}>
            <LocalForm onAdd={addLocal} />
          </Way>
          <Way icon={<MagnifyingGlassIcon size={14} />} title="More providers" detail={`${named.join(', ')} and ${Math.max(more.length - named.length, 0)} more`}
            open={isOpen({ kind: 'more' })} onToggle={toggle({ kind: 'more' })}>
            <MoreProviders machine={machineId} providers={more} onDone={(provider) => void useProvider(provider)} />
          </Way>
        </ul>
      </section>
      {rest}
      {foot}
    </div>
  )
}

const EXTENSION = 'extensions.'

/**
 * The machine's bundled extensions, each with its switch as Settings → Extensions has it (`extensions.<name>`), and all
 * of them at once.
 */
function Extensions({ machine, snapshot }: { machine: string; snapshot: SettingsSnapshot | undefined }) {
  const dispatch = useRegistry().router.dispatch
  const [error, setError] = useState<string>()
  const switches = snapshot?.sections.find((s) => s.id === 'extensions')?.settings.filter((s) => !s.hidden && s.key.startsWith(EXTENSION)) ?? []
  if (!switches.length) return null
  const on = (setting: SettingInfo) => snapshot?.values[setting.key] === true
  const set = (key: string, value: Json) => dispatch('settings.set', { key, value }, { machine, source: 'setup' })
  const change = (settings: SettingInfo[], value: boolean) => {
    setError(undefined)
    Promise.all(settings.filter((s) => on(s) !== value).map((s) => set(s.key, value))).catch((failed: Error) => {
      console.error('Switching extensions failed', failed)
      setError(failed.message)
    })
  }
  return (
    <section className="setup__extensions" aria-label="Extensions">
      <div className="setup__head">
        <h2>Extensions</h2>
        <Button variant="ghost" disabled={switches.every(on)} onClick={() => change(switches, true)}>Enable all</Button>
        <Button variant="ghost" disabled={!switches.some(on)} onClick={() => change(switches, false)}>Disable all</Button>
      </div>
      <ul>
        {switches.map((setting) => (
          <li key={setting.key} className="setup__extension" data-extension={setting.key.slice(EXTENSION.length)}>
            <div className="setup__what">
              <div><span className="setup__title">{setting.title}</span> <code>{setting.key.slice(EXTENSION.length)}</code></div>
              {setting.description && <div className="setup__detail" title={setting.description}>{setting.description}</div>}
            </div>
            <Switch label={setting.title} checked={on(setting)} onChange={(value) => change([setting], value)} />
          </li>
        ))}
      </ul>
      {error && <p className="setup__error" role="alert">{error}</p>}
      <p className="setup__note">Change them any time in Settings.</p>
    </section>
  )
}

const rank = (id: string) => { const at = FIRST_KEYS.indexOf(id); return at < 0 ? Infinity : at }

/** A GitHub Enterprise's address, to sign in to Copilot there. */
function EnterpriseForm({ onStart }: { onStart(domain: string): void }) {
  const [typed, setTyped] = useState('')
  const domain = typed.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return (
    <form className="setup__local" onSubmit={(e) => { e.preventDefault(); if (domain) onStart(domain) }}>
      <TextField aria-label="Your GitHub Enterprise address" autoFocus placeholder="Your GitHub Enterprise address" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <Button type="submit" variant="primary" disabled={!domain}>Continue</Button>
    </form>
  )
}

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

/** A way in: a row that opens what it takes under it. Closing it ends what it started (a sign-in waiting on the browser). */
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

/**
 * A pasted key (a line from a shell file too): whose it is, told from the key (or asked, when it doesn't say), or
 * the provider it's for (`of`: one picked among More providers); refused when it can't be one, and tried with its
 * provider before it's kept.
 */
function KeyForm({ machine, providers, all, of, onDone, onEscape }: {
  machine: string; providers: ProviderAuthInfo[]; all: ProviderAuthInfo[]; of?: ProviderAuthInfo; onDone(provider: string): void; onEscape?(): void
}) {
  const dispatch = useRegistry().router.dispatch
  const [text, setText] = useState('')
  // Picked by hand: the key didn't say, or said wrong.
  const [picked, setPicked] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const [signing, setSigning] = useState<{ provider: string; key: string; n: number }>()
  const detected = of ? undefined : keyProvider(text, all)
  const provider = of?.id ?? picked ?? detected
  const nameOf = (id: string) => all.find((p) => p.id === id)?.name ?? id
  // What's wrong with it before it's sent: a Claude subscription token.
  const wrong = keyProblem(text, { sent: false })
  const asking = !of && Boolean(text.trim()) && !wrong && (!detected || picked !== undefined)
  const options = [...providers, ...provider && !providers.some((p) => p.id === provider) ? all.filter((p) => p.id === provider) : []]
  const submit = () => {
    const wrong = keyProblem(text)
    if (wrong) return setProblem(wrong)
    if (provider) setSigning((was) => ({ provider, key: pastedKey(text).key, n: (was?.n ?? 0) + 1 }))
  }
  return (
    <>
      <form className="setup__key" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <TextField type="password" aria-label={of ? `${of.name} API key` : 'API key'} autoFocus placeholder="Paste a key" value={text}
          onChange={(e) => { setText(e.target.value); setProblem(undefined); setSigning(undefined) }}
          onKeyDown={(e) => { if (onEscape && e.key === 'Escape') { e.preventDefault(); onEscape() } }} />
        {asking && <Select aria-label="Provider" value={provider ?? null} {...provider ? {} : { placeholder: 'Whose key?' }}
          options={options.map((p) => ({ value: p.id, label: p.name }))} onChange={(id) => { if (id) { setPicked(id); setSigning(undefined) } }} />}
        <Button type="submit" variant="primary" disabled={!text.trim() || !provider || Boolean(wrong)}>Add</Button>
      </form>
      {detected && picked === undefined && text.trim() && (
        <p className="setup__note">{nameOf(detected)} key · <button type="button" className="setup__link" onClick={() => setPicked(detected)}>Not {nameOf(detected)}?</button></p>
      )}
      {!of && !text.trim() && (
        <p className="setup__note">Get one from {FIRST_KEYS.map((id, i) => (
          <span key={id}>{i ? (i === FIRST_KEYS.length - 1 ? ' or ' : ', ') : ''}<a href={KEY_PAGES[id]} target="_blank" rel="noreferrer">{nameOf(id)}</a></span>
        ))}.</p>
      )}
      {(wrong ?? problem) && <p className="setup__error" role="alert">{wrong ?? problem}</p>}
      {signing && (
        <SignInFlow key={signing.n} machine={machine} title="Checking the key…"
          start={() => dispatch('auth.signIn', { provider: signing.provider, type: 'api_key', key: signing.key, check: true }, { machine, source: 'setup' }) as Promise<{ flow: string }>}
          onClose={() => setSigning(undefined)} onDone={() => onDone(signing.provider)} />
      )}
    </>
  )
}

/**
 * A local server's address, as typed: its scheme when it's left out, and OpenAI's `/v1` when it's just a host
 * (Ollama's and LM Studio's are both there).
 */
export function localAddress(typed: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed.trim()) ? typed.trim() : `http://${typed.trim()}`
  try {
    const url = new URL(withScheme)
    return url.pathname === '/' || url.pathname === '' ? `${url.origin}/v1` : withScheme.replace(/\/+$/, '')
  } catch {
    // Not an address at all: the machine says so, as it's added.
    return withScheme
  }
}
/** What a local server is called, by its port: Ollama's and LM Studio's own, else its host. */
const serverName = (address: string) => {
  try {
    const url = new URL(address)
    return url.port === '11434' ? 'Ollama' : url.port === '1234' ? 'LM Studio' : url.hostname
  } catch { return 'Local' }
}

/** A local server's address; its models are those it lists. */
function LocalForm({ onAdd }: { onAdd(name: string, baseUrl: string): Promise<void> }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <form className="setup__local" onSubmit={(e) => {
      e.preventDefault()
      const address = localAddress(typed)
      setBusy(true); setError(undefined)
      onAdd(serverName(address), address).catch((failed: Error & { kind?: string }) => {
        console.error('Adding a local model failed', failed)
        setError(failed.kind === 'unreachable' ? `Nothing answered at ${address}. Is the server running?` : failed.message)
      }).finally(() => setBusy(false))
    }}>
      <TextField aria-label="Address" autoFocus placeholder="localhost:11434" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <Button type="submit" variant="primary" disabled={busy || !typed.trim()}>{busy ? 'Adding…' : 'Add'}</Button>
      {error && <p className="setup__error">{error}</p>}
    </form>
  )
}

/** Every provider there is, searched for, signed in to in place; or one of the user's own (an OpenAI-compatible endpoint). */
function MoreProviders({ machine, providers, onDone }: { machine: string; providers: ProviderAuthInfo[]; onDone(provider: string): void }) {
  const dispatch = useRegistry().router.dispatch
  const [query, setQuery] = useState('')
  const [keyFor, setKeyFor] = useState<string>()
  // A sign-in, or a provider's own way of taking its key (a flow asking more than the key: Bedrock's, Vertex's).
  const [signing, setSigning] = useState<{ provider: string; type: 'api_key' | 'oauth'; n: number }>()
  const [own, setOwn] = useState(false)
  const start = (provider: string, type: 'api_key' | 'oauth') => {
    setKeyFor(undefined)
    setSigning((was) => ({ provider, type, n: (was?.n ?? 0) + 1 }))
  }
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const listed = providers.filter((p) => words.every((w) => `${p.name} ${p.id}`.toLowerCase().includes(w)))
    .sort((a, b) => Number(!MORE_NAMED.includes(a.id)) - Number(!MORE_NAMED.includes(b.id)) || a.name.localeCompare(b.name))
  return (
    <>
      <TextField type="search" autoFocus placeholder="Search providers" aria-label="Search providers" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="setup__more">
        {listed.map((p) => (
          <li key={p.id}>
            <div className="setup__provider">
              <span className="setup__what">{p.name}</span>
              {keyFor !== p.id && (
                <span className="setup__actions">
                  {p.oauth && <Button onClick={() => start(p.id, 'oauth')}>Sign in</Button>}
                  {p.apiKey && <Button onClick={() => {
                    if (p.keyFlow) return start(p.id, 'api_key')
                    setSigning(undefined)
                    setKeyFor(p.id)
                  }}>{p.keyFlow ? 'Set up…' : 'API key…'}</Button>}
                </span>
              )}
            </div>
            {keyFor === p.id && <KeyForm machine={machine} providers={[p]} all={providers} of={p} onDone={onDone} onEscape={() => setKeyFor(undefined)} />}
            {signing?.provider === p.id && (
              <SignInFlow key={signing.n} machine={machine} title="Signing in…"
                start={() => dispatch('auth.signIn', { provider: p.id, type: signing.type, ...(signing.type === 'api_key' ? { check: true } : {}) }, { machine, source: 'setup' }) as Promise<{ flow: string }>}
                onClose={() => setSigning(undefined)} onDone={() => onDone(p.id)} />
            )}
          </li>
        ))}
      </ul>
      {words.length > 0 && !listed.length && <p className="setup__note">No provider matches “{query.trim()}”.</p>}
      {own ? <ProviderForm target={machine} onDone={(saved) => { setOwn(false); if (saved) onDone(saved) }} />
        : <p className="setup__note"><button type="button" className="setup__link" onClick={() => setOwn(true)}>Add your own OpenAI-compatible endpoint</button></p>}
    </>
  )
}

/** How many of a provider's models are listed to choose the default from and star; the rest are in the menu after. */
const LISTED = 4

/**
 * A provider chosen: its models to make the default (its recommended ones first) and star, and the default saying hi.
 * Another kind of agent (Claude Code) chosen: its models to make the default, and nothing to try (it says itself
 * whether it's signed in).
 */
function Chosen({ machine, provider, name, detail, catalog, onCatalog, onTalks }: {
  machine: string; provider: string; name: string; detail: string; catalog: ModelCatalog | undefined; onCatalog(): Promise<ModelCatalog>; onTalks(talks: boolean): void
}) {
  const dispatch = useRegistry().router.dispatch
  const [test, setTest] = useState<ModelTest | Failure | 'trying'>()
  const [error, setError] = useState<string>()
  const on = { machine, source: 'setup' }
  const kind = catalog?.agents?.find((a) => a.kind === provider)
  const value = catalog?.default.model
  const tryIt = () => {
    setTest('trying')
    client(machine).call('model.test', {}).then(setTest, (failed: Error) => { console.error('Trying the model failed', failed); setTest({ message: failed.message }) })
  }
  useEffect(() => { if (value && !kind) tryIt() }, [value, Boolean(kind)])
  useEffect(() => onTalks(Boolean(test && test !== 'trying' && !('message' in test))), [test])
  const change = (key: string, next: unknown) => {
    setError(undefined)
    dispatch('settings.set', { key, value: next }, on).then(onCatalog).catch((failed: Error) => { console.error(`Setting ${key} failed`, failed); setError(failed.message) })
  }
  const starred = (catalog?.favourites ?? []).map((f) => f.value)
  const star = (model: string) => change('agent.favourites', starred.includes(model) ? starred.filter((v) => v !== model) : [...starred, model])
  const own: { value: string; label: string; recommended?: boolean }[] = kind ? kind.models : (catalog?.models ?? []).filter((m) => m.value.startsWith(`${provider}/`))
  const order = (m: (typeof own)[number]) => m.value === value ? 0 : m.recommended ? 1 : starred.includes(m.value) ? 2 : 3
  const listed = kind ? own : [...own].sort((a, b) => order(a) - order(b)).slice(0, LISTED)
  const failed = test && test !== 'trying' && 'message' in test
  return (
    <>
      <ul className="setup__rows">
        <SetupRow icon={kind ? <TerminalIcon size={14} /> : failed ? <WarningIcon size={14} className="setup__bad" /> : <CheckIcon size={14} className="setup__ok" />} title={name} detail={detail} />
      </ul>
      <section className="setup__models" aria-label="Default model">
        <h2>Default model</h2>
        <ul>
          {listed.map((m) => (
            <li key={m.value} className={`setup__model ${m.value === value ? 'is-default' : ''}`}>
              {!kind && <button type="button" className={`setup__star ${starred.includes(m.value) ? 'is-on' : ''}`} aria-label={starred.includes(m.value) ? `Unstar ${m.label}` : `Star ${m.label}`}
                aria-pressed={starred.includes(m.value)} onClick={() => star(m.value)}><StarIcon size={13} weight={starred.includes(m.value) ? 'fill' : 'regular'} /></button>}
              <button type="button" className="setup__pick" onClick={() => { if (m.value !== value) change('agent.model', m.value) }}>
                <span>{m.label}</span><span className="setup__detail">{m.value === value ? 'Default' : 'Make default'}</span>
              </button>
            </li>
          ))}
        </ul>
        {own.length > listed.length && (
          <ModelPicker label="Another model" catalog={catalog} value={null} placeholder="Another model…"
            onChange={(next) => { if (next && next !== value) change('agent.model', next) }}
            onStar={(next) => change('agent.favourites', next)} />
        )}
        <p className="setup__note">{kind ? 'New threads run on your Claude Code.' : 'Starred models come first in the model menus.'}</p>
        {error && <p className="setup__error" role="alert">{error}</p>}
      </section>
      {!kind && (
        <div className="setup__test" aria-live="polite">
          <Button disabled={test === 'trying' || !value} onClick={tryIt}>Test</Button>
          {test === 'trying' ? <span className="setup__note">…</span>
            : test && 'message' in test ? <span className="setup__error">{test.message}</span>
            : test && <><span className="setup__bubble">{test.text || '(empty reply)'}</span><span className="setup__ms">{(test.ms / 1000).toFixed(1)} s</span></>}
        </div>
      )}
    </>
  )
}

/**
 * Where sending failed for lack of a model (the composer, ⌘N), or the default couldn't run (`said`: Claude Code signed
 * out): setup for that machine, coming back to `back` once it's done; an older machine's Providers instead. `before`
 * runs first (⌘N closing).
 */
export function NoModel({ machine, back, before, said }: { machine: MachineEntry; back?: Selection; before?(): void; said?: string }) {
  const { select } = useSelection()
  const shell = useShell()
  return (
    <span className="setup-card">
      {said ? `${said}.` : `No model is set up on ${placeName(machine)}.`}{' '}
      <Button variant="primary" onClick={() => {
        before?.()
        if (!has(machine, 'model-setup')) return shell.providers(machine.id)
        openSetup(machine.id, back)
        select(undefined)
      }}>Set up models…</Button>
    </span>
  )
}
