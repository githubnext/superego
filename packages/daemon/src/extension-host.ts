// The extension host: every daemon half set up here (the core's, the bundled ones, profiles'), and the extensions
// windows declare, in one registry; what each registered about threads, and for which; and the API a daemon half's
// setup is given (`DaemonApi`), everything it registers going through its lifetime, undone together at teardown.
import { defineExtension, type Extension, hook, ToolTask } from '@earendil-works/pi-durable'
import {
  type ChannelAcceptor, Channels, compareVersion, contractProblem, dataViewProblem, EXTENSION_API, FEATURES, Lifetime, manifestOf, paramsParser,
  parseVersion, RpcError, UNVERSIONED, DATA_VIEWS, type DataViewInfo, type ExtensionAbout, type ExtensionReport, type ExtensionsReport, type Json,
  type RpcPeer, type ThreadInfo,
} from '@superego/protocol'
import { registerExtensionSettings } from './extension-settings.ts'
import type { AgentChoice, AgentPartsThread, DaemonApi, DaemonExtension, LiveValue, ScopedValue, SendTransform, StatusContribution, ThreadHooks, ToolCallRecord } from './extension.ts'
import { clone, stateOf, type Host, type ThreadMeta } from './host.ts'
import type { ProfileHost } from './profile-host.ts'
import type { LoadedProfile, ProfileRef } from './profiles.ts'
import type { RunRecord } from './recap.ts'
import type { Relay } from './relay.ts'
import type { Threads } from './threads.ts'

/**
 * Names no extension can take: the core's own namespaces (its methods, actions and settings are `<namespace>.<…>`), so
 * an extension's method can't be shadowed by the core's, nor its settings mixed in with them. A test keeps it in step.
 */
export const RESERVED = new Set([
  'action', 'agent', 'app', 'auth', 'core', 'daemon', 'extension', 'extensions', 'file', 'hello', 'model', 'pane', 'profile', 'profiles',
  'providers', 'settings', 'thread', 'threads', 'unwatch', 'value', 'view', 'watch', 'web',
  // Its own settings sections besides.
  'outside', 'onboarding',
  // A connection's own (heartbeat, channels), who is connected, and the machines this one reaches.
  'ping', 'ch', 'clients', 'client', 'machine', 'machines', 'relay',
])

/** An agent part as set up: as installed, how to take it away, and how to put another (of its name) in its place. */
export type Installed = { installed: Extension; undo(): void; replace(next: Extension): Extension }

/** Where a daemon half is from: the core's own, the app's bundled ones, or a profile's (by its file). */
export type Source = { source: 'core' | 'bundled' | 'profile'; file?: string }

/**
 * An extension known here: a daemon half set up (or being set up) for the daemon's life or a profile's, or one a window
 * declared (no daemon half, `source: 'window'`). Its name is claimed while it's here: everything it registers is
 * `<name>.<…>`, so a second of that name is refused rather than mixed in.
 */
type ExtensionRecord = {
  about: ExtensionAbout
  source: Source['source'] | 'window'
  file?: string
  /** A profile's: the folders of the profiles that have it (changing as profiles share it). */
  profiles?: Set<string>
  /** Set up, and announced (`hello.extensions`); a window's always is. */
  ready: boolean
  /** What it registered, for the inspector. */
  registered: Map<string, string[]>
}

/**
 * Something an extension registered about threads, in the order they were set up: whose, and (a profile's) for which
 * profiles' threads (their folders).
 */
type Owned<T> = { value: T; owner: string; profiles?: Set<string> }

/** What an extension says of itself, and only that: the fields `ExtensionAbout` has, each of its type (a window's declaration is anyone's JSON). */
function aboutOf(about: ExtensionAbout): ExtensionAbout {
  const { name, title, description, required, version, api } = about
  return {
    name, ...(typeof title === 'string' && title ? { title } : {}), ...(typeof description === 'string' && description ? { description } : {}), ...(required === true ? { required } : {}),
    ...(typeof version === 'string' ? { version } : {}), ...(typeof api === 'string' ? { api } : {}),
  }
}

/** The extension host: made before the profile host and the threads, which it reaches as they're needed (`later`). */
export function createExtensionHost(host: Host, later: { profiles(): ProfileHost; threads(): Threads; relay(): Relay }) {
  const { options, settings, router, registry, values, changed } = host
  const partsLimit = options.agentPartsLimit ?? 5_000

  /** Every extension known here, by name, in the order each came. */
  const records = new Map<string, ExtensionRecord>()
  /** Those that failed to set up, by their file (a profile's) or name, until one sets up in their place. */
  const failures = new Map<string, ExtensionReport>()
  /** The extensions that can be gone without here, by name: the core's, the bundled ones and the windows', once set up. */
  const known = (name: string) => {
    const record = records.get(name)
    return record && record.ready && record.source !== 'profile' ? record.about : undefined
  }
  const switchable = () => [...records.values()].filter((r) => r.ready && r.source !== 'profile').map((r) => r.about)

  /**
   * The agent parts every thread has unless it goes without the extension that gave them (see `withoutFor`): the core's
   * own and the bundled extensions', each with its extension (one may give several).
   */
  const builtins: { part: Extension; owner: string }[] = []
  /** The agent parts a thread has: every built-in but those of the extensions it goes without. */
  const partsFor = (without: Set<string>) => builtins.filter((b) => !without.has(b.owner)).map((b) => b.part)

  const threadHooks: Owned<ThreadHooks>[] = []
  const factSources: Owned<(thread: { id: string; state: Json | undefined }) => Json | undefined>[] = []
  /** Extensions saying which threads are quiet (`quiet`). */
  const quietSources: Owned<(thread: { id: string; state: Json | undefined }) => boolean>[] = []
  const recaps: Owned<(run: RunRecord) => string | undefined>[] = []
  const toolWatchers: Owned<(record: ToolCallRecord) => void | Promise<void>>[] = []
  const choosers: Owned<(thread: { id?: string; state: Json | undefined; profile?: ProfileRef }) => AgentChoice | undefined>[] = []
  /**
   * An extension's `agentParts`: what it adds to each thread's agent at submit, from parts it gives with `always:
   * false` (see `partsAdded`).
   */
  const adders: Owned<(thread: AgentPartsThread) => Extension[] | undefined | void | Promise<Extension[] | undefined | void>>[] = []
  /**
   * Agent parts given to no thread but those an `agentFor` or `agentParts` of their extension gives them to: by
   * extension, by the name it gave them, to as installed now (replaced, it's the new one).
   */
  const chosenParts = new Map<string, Map<string, Extension>>()
  /**
   * The kinds of pane the agent can open, and what each shows, as extensions describe them (`superego.pane`; the window
   * draws them, the extension's UI half registering the same kind): the core's own `panes`, and any other's.
   */
  const paneKinds: Owned<{ kind: string; about: string }>[] = []
  const contributors: Owned<(threadId: string) => StatusContribution | undefined>[] = []
  /** Extensions' send transforms, in the order registered. */
  const transforms: Owned<SendTransform>[] = []
  /** Extensions' read methods, `<name>.<method>`: plain requests, looked up when called (a profile's come and go). */
  const methods = new Map<string, (params: unknown) => Promise<Json>>()
  /** Extensions' channels, by kind (`<name>.<kind>`): byte streams a client opens, accepted by their extension. */
  const channelKinds = new Map<string, ChannelAcceptor>()
  /** The connections open now: told what this daemon offers, and taking extensions' channels. */
  const connections = new Set<RpcPeer>()

  /** Whether what an extension registered is for a thread: one it doesn't go without, and of its profile if a profile's. */
  const appliesTo = (entry: Owned<unknown>, without: Set<string>, meta?: ThreadMeta) =>
    !without.has(entry.owner) && (!entry.profiles || Boolean(meta?.profile && entry.profiles.has(meta.profile.dir)))
  /** The optional extensions turned off on this machine or left out by a profile. */
  function switchedOff(profile?: LoadedProfile): Set<string> {
    const without = new Set<string>()
    for (const { name, required } of switchable()) {
      if (!required && (settings.get(`extensions.${name}`) === false || profile?.spec.without?.includes(name))) without.add(name)
    }
    return without
  }
  /** Choosers that threw once: logged then, not on every thread's info after. */
  const failedChoosers = new WeakSet<object>()
  /** A thread's agent as extensions choose it (`agentFor`): the first answer, if any, and whose it is (`by`). */
  function choiceOf(id: string | undefined, meta: ThreadMeta, off: Set<string>): (AgentChoice & { by: string }) | undefined {
    for (const chooser of choosers) {
      if (!appliesTo(chooser, off, meta)) continue
      try {
        const choice = chooser.value({ ...(id ? { id } : {}), state: stateOf(meta, chooser.owner), ...(meta.profile ? { profile: meta.profile } : {}) })
        if (choice) return { ...choice, by: chooser.owner }
      } catch (error) {
        if (!failedChoosers.has(chooser)) console.error(`Extension ${chooser.owner}: agentFor failed:`, error)
        failedChoosers.add(chooser)
      }
    }
    return undefined
  }
  /**
   * The optional extensions a thread goes without: turned off on this machine, left out by its profile, or left out
   * by the extension that chose its agent (Ego's). One answer for its agent's parts, the pane kinds it's told of, the
   * hooks and facts that are for it, and the UI the window draws for it. With the choice it was worked out from.
   */
  function choiceAndWithout(id?: string, meta?: ThreadMeta, profile?: LoadedProfile) {
    const without = switchedOff(profile)
    const choice = meta && choiceOf(id, meta, without)
    for (const name of choice?.without ?? []) {
      const about = known(name)
      if (about && !about.required) without.add(about.name)
    }
    return { choice, without }
  }
  /** What a thread goes without, with the profile it has loaded now (none: the built-ins' answer for no thread). */
  const withoutFor = (id?: string, meta?: ThreadMeta) => choiceAndWithout(id, meta, meta && later.profiles().loaded(meta)).without

  /**
   * The pane kinds a thread's agent is told of: the core's and those of extensions it has, and its profile's. A kind
   * both describe is told as its profile's, as the window draws it.
   */
  function panesOf(id: string) {
    const meta = host.mounted.get(id)?.meta
    const profile = meta && later.profiles().loaded(meta)
    const without = withoutFor(id, meta)
    const kinds = new Map<string, string>()
    for (const { value, profiles } of paneKinds.filter((p) => appliesTo(p, without, meta))) if (!profiles) kinds.set(value.kind, value.about)
    for (const { value, profiles } of paneKinds.filter((p) => appliesTo(p, without, meta))) if (profiles) kinds.set(value.kind, value.about)
    for (const [kind, about] of Object.entries(profile?.spec.panes ?? {})) kinds.set(kind, about)
    return [...kinds].map(([kind, about]) => ({ kind, about }))
  }

  /** What extensions say about a thread (`facts`), by extension: those it doesn't go without, as for hooks. */
  function factsOf(id: string, meta: ThreadMeta, without: Set<string>): Pick<ThreadInfo, 'facts'> {
    const facts: Record<string, Json> = {}
    for (const source of factSources) {
      if (!appliesTo(source, without, meta)) continue
      try {
        const fact = source.value({ id, state: stateOf(meta, source.owner) })
        if (fact !== undefined) facts[source.owner] = fact
      } catch (error) {
        console.error(`Extension ${source.owner}: facts of thread ${id} failed:`, error)
      }
    }
    return Object.keys(facts).length ? { facts } : {}
  }
  /** Whether an extension it doesn't go without says a thread is quiet (`quiet`). */
  function quietOf(id: string, meta: ThreadMeta, without: Set<string>): Pick<ThreadInfo, 'quiet'> {
    for (const source of quietSources) {
      if (!appliesTo(source, without, meta)) continue
      try {
        if (source.value({ id, state: stateOf(meta, source.owner) })) return { quiet: true }
      } catch (error) {
        console.error(`Extension ${source.owner}: whether thread ${id} is quiet failed:`, error)
      }
    }
    return {}
  }
  /** Status contributors that threw once: logged then, not on every thread's info after. */
  const failedContributors = new WeakSet<object>()
  /** What a thread waits on, as the extensions it has say (`status`): the first to say something. */
  function blockedOf(id: string, without: Set<string>, meta: ThreadMeta) {
    for (const contributor of contributors) {
      if (!appliesTo(contributor, without, meta)) continue
      try {
        const blocked = contributor.value(id)
        if (blocked) return { blocked }
      } catch (error) {
        // A throw counts as nothing, as facts' and choosers' do.
        if (!failedContributors.has(contributor)) console.error(`Extension ${contributor.owner}: status of thread ${id} failed:`, error)
        failedContributors.add(contributor)
      }
    }
    return {}
  }

  /** What an `agentParts` did wrong, said once (not on every turn of every thread). */
  const adderSaid = new WeakMap<object, Set<string>>()
  const once = (adder: object, what: string, say: () => void): undefined => {
    const said = adderSaid.get(adder) ?? new Set<string>()
    adderSaid.set(adder, said)
    if (!said.has(what)) { said.add(what); say() }
    return undefined
  }
  /**
   * What extensions add to a thread's agent at submit (`agentParts`), each in the order they were set up: asked all at
   * once, each given `agentPartsLimit` to answer. One that throws or takes longer adds nothing to this turn (logged).
   * Only parts the extension gave with `always: false`, by the name it gave them.
   */
  async function partsAdded(id: string, meta: ThreadMeta, without: Set<string>, profile: LoadedProfile | undefined): Promise<Extension[]> {
    const applying = adders.filter((adder) => appliesTo(adder, without, meta))
    if (!applying.length) return []
    const thread: AgentPartsThread = {
      id, hidden: Boolean(meta.hidden), ...(meta.owner ? { owner: meta.owner } : {}),
      ...(meta.profile && profile ? { profile: { ref: meta.profile, spec: clone(profile.spec) } } : {}),
    }
    const answers = await Promise.all(applying.map(async (adder) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const parts = await Promise.race([
          Promise.resolve().then(() => adder.value(clone(thread))),
          new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), partsLimit) }),
        ])
        if (parts === 'late') { console.warn(`Extension ${adder.owner}: agentParts took over ${partsLimit / 1000}s; this turn goes without its parts`); return [] }
        return (parts ?? []).map((part) => chosenParts.get(adder.owner)?.get(part.name) ?? once(adder, `gave ${part.name}`, () => console.warn(`agentParts of ${adder.owner} gave ${part.name}, which it doesn't give with agent(part, { always: false })`)))
          .filter((part) => part !== undefined)
      } catch (error) {
        once(adder, 'failed', () => console.error(`Extension ${adder.owner}: agentParts failed:`, error))
        return []
      } finally {
        clearTimeout(timer)
      }
    }))
    return answers.flat()
  }

  /**
   * What a turn runs with: the thread's own choices, else what an extension chose for it (`agentFor`: Ego's), else its
   * profile's, else this machine's settings. `id` is unset for a thread being made: then only its model and thinking
   * count (no `agentParts` are asked).
   */
  async function agentOf(id: string | undefined, meta: ThreadMeta) {
    const profiles = later.profiles()
    const profile = meta.profile ? await profiles.profileOf(meta.profile) : undefined
    const { choice, without } = choiceAndWithout(id, meta, profile)
    const { model, thinkingLevel } = host.agent.resolve({
      model: meta.model ?? choice?.model ?? profile?.spec.model, thinking: meta.thinking ?? choice?.thinking ?? profile?.spec.thinking,
    })
    // Only parts its own extension gave with `always: false`.
    const chosen = (choice?.extensions ?? []).map((part) => chosenParts.get(choice!.by)?.get(part.name) ?? console.warn(`agentFor of ${choice!.by} chose ${part.name}, which it doesn't give with agent(part, { always: false })`)).filter((part) => part !== undefined)
    const added = id === undefined ? [] : await partsAdded(id, meta, without, profile)
    // Each part once: one a chooser and an adder both give, where the chooser put it.
    const extensions = [...new Set([...partsFor(without), ...chosen, ...added, ...(profile ? profiles.partsOf(profile) : []), toolCallsPart])]
    // Always said, never left as it was: instructions a chooser gave go when it no longer answers.
    const instructions = choice?.instructions ?? (profile?.spec.prompt || null)
    return { model, thinkingLevel, extensions, instructions, without }
  }

  /**
   * Every thread's agent has this: it tells extensions' `toolCalls` of each call that ended, without waiting for them
   * or letting them change the result. Not an extension of its own, so nothing goes without it.
   */
  const toolCallsPart = defineExtension({
    name: 'tool-calls',
    hooks: [hook(ToolTask, {
      afterTool(call, result, api) {
        const id = String(api.conversationId)
        const m = host.mounted.get(id)
        if (!m || !toolWatchers.length) return undefined
        const without = withoutFor(id, m.meta)
        // What the model is told: the output's text, then what went wrong (an error's message comes as a diagnostic).
        const text = [
          ...(result.output ?? []).flatMap((block) => block.type === 'text' ? [block.text] : []),
          ...(result.diagnostics ?? []).map((d) => d.message),
        ].join('\n')
        const record: ToolCallRecord = {
          thread: id,
          call: { id: call.id, name: call.name, args: call.arguments as Json },
          result: { isError: Boolean(result.isError), ...(text ? { text } : {}) },
        }
        for (const watcher of toolWatchers) {
          if (!appliesTo(watcher, without, m.meta)) continue
          void Promise.resolve().then(() => watcher.value(record)).catch((error: unknown) => console.error(`Extension ${watcher.owner}: toolCalls failed:`, error))
        }
        return undefined
      },
    })],
  })
  registry.install(toolCallsPart)

  // The core's own: extensions' data views (`superego.view`), as the window draws them (DataViewInfo[]).
  const setViews = values.core(DATA_VIEWS, [])
  /** Each with the profiles it's for (a profile's: their folders, which change as profiles share it). */
  const dataViews: { info: DataViewInfo; profiles?: Set<string> }[] = []
  /** Tell watchers the views as they are now: a profile's only once a profile has it. */
  const publishViews = () => {
    setViews(dataViews.filter((v) => !v.profiles || v.profiles.size).map((v) => v.profiles ? { ...v.info, profiles: [...v.profiles] } : v.info))
  }

  /** The extensions set up and on: those switched off on this machine aren't offered. */
  const offered = () => [...records.values()].filter((r) => r.ready && r.source !== 'window' && (r.about.required || settings.get(`extensions.${r.about.name}`) !== false))
    .map((r) => manifestOf(r.about))
  /**
   * What this daemon offers, as `hello` says and `features.changed` keeps current: the protocol's features, and every
   * extension set up now but those switched off on this machine, each at its version.
   */
  const offer = () => ({ features: [...FEATURES] as string[], extensions: offered() })
  let announcedOffer = ''
  let announcing = false
  /**
   * Tell every client what this daemon offers, once it changed (after whatever changed it settles). Not once it's
   * restarting or closing: its extensions going then are its end, and a client asking after them would be refused.
   */
  function announce() {
    const stopping = () => host.state.restarting || host.state.closing
    if (announcing || stopping()) return
    announcing = true
    queueMicrotask(() => {
      announcing = false
      if (stopping()) return
      const now = offer()
      if (JSON.stringify(now) === announcedOffer) return
      announcedOffer = JSON.stringify(now)
      for (const peer of connections) peer.notify('features.changed', now)
    })
  }

  /** Take channels of `kind` on a connection: looked up as they're opened, so one gone since is refused. */
  const acceptChannels = (peer: RpcPeer, kind: string) => Channels.of(peer).accept(kind, (channel, params) => {
    const accept = channelKinds.get(kind)
    if (!accept) throw new RpcError('unknown_channel', `No channel of kind ${kind} here`)
    return accept(channel, params)
  })

  const named = (extension: string, name: string) => {
    if (!name.startsWith(`${extension}.`)) throw new Error(`Extension ${extension} must name things "${extension}.<name>", not "${name}"`)
    return name
  }

  /**
   * Set up a daemon half: a bundled one (for the daemon's life), or a profile's (`agent` then adds to the
   * selection of the profiles that have it, `profiles`: their folders). Everything it registers is its own, and the
   * returned teardown undoes all of it: its agent parts, actions, values, status, settings, hooks and its name.
   * `agentExtension` installs an agent part, and gives it to every thread it's for when `always`: the installed part
   * (a profile's are renamed), how to undo it, and how to put another in its place.
   */
  async function setUp(extension: DaemonExtension, agentExtension: (extension: Extension, always: boolean) => Installed, profiles?: Set<string>, from: Source = { source: 'bundled' }): Promise<() => void> {
    const report = (state: 'failed' | 'refused' | 'timed out', error: string) => {
      failures.set(from.file ?? extension.name, { ...manifestOf(extension), ...(extension.title ? { title: extension.title } : {}), ...from, ...(profiles ? { profiles: [...profiles] } : {}), state, error, registered: {}, watches: [] })
    }
    const refuse = (why: string) => { report('refused', why); return new Error(why) }
    if (!/^[a-z][a-z0-9-]*$/.test(extension.name)) throw refuse(`Extension name "${extension.name}" must be lowercase letters, digits and dashes`)
    if (RESERVED.has(extension.name)) throw refuse(`The name ${extension.name} is the core's own`)
    if (records.has(extension.name)) throw refuse(`An extension named ${extension.name} is already set up`)
    // One whose versions don't read, or that needs an extension API this host isn't, is refused before it runs.
    const problem = contractProblem(extension)
    if (problem) throw refuse(problem)
    // What it registers, for the inspector: kept while it's set up.
    const registered = new Map<string, string[]>()
    const note = (kind: string, what: string) => { registered.set(kind, [...registered.get(kind) ?? [], what]) }
    const record: ExtensionRecord = { about: aboutOf(extension), ...from, ...(profiles ? { profiles } : {}), ready: false, registered }
    records.set(extension.name, record)
    // Everything it registers goes through its lifetime: undone together at teardown, and refused after.
    const life = new Lifetime(`Extension ${extension.name}`)
    const undo = (step: () => unknown, what: string) => life.add(step, what)
    undo(() => { records.delete(extension.name); announce() }, 'its name')
    const ownKey = (key: string) => {
      if (key !== extension.name && !key.startsWith(`${extension.name}.`)) throw new Error(`Extension ${extension.name} must name its settings "${extension.name}.<key>", not "${key}"`)
    }
    /** Keep something it registered about threads in `list`, as its own, until it's torn down. */
    function own<T>(list: Owned<T>[], value: T, what: string) {
      life.live(what)
      const entry: Owned<T> = { value, owner: extension.name, ...(profiles ? { profiles } : {}) }
      list.push(entry)
      undo(() => { list.splice(list.indexOf(entry), 1); changed() }, what)
    }
    const threads = later.threads()
    const api: DaemonApi = {
      app: options.app,
      dataDir: options.dataDir,
      agentsDir: host.agentsDir,
      signal: life.signal,
      agent(agentPart, { always = true } = {}) {
        life.live(`the agent part ${agentPart.name}`)
        const name = agentPart.name
        const given = chosenParts.get(extension.name) ?? new Map<string, Extension>()
        if (!always && given.has(name)) throw new Error(`Extension ${extension.name} already gives an agent part named ${name}`)
        note('agent parts', always ? name : `${name} (only where its agentFor or agentParts gives it)`)
        const part = agentExtension(agentPart, always)
        if (!always) chosenParts.set(extension.name, given.set(name, part.installed))
        let removed = false
        const remove = () => {
          if (removed) return
          removed = true
          part.undo()
          if (always) return
          given.delete(name)
          if (!given.size && chosenParts.get(extension.name) === given) chosenParts.delete(extension.name)
        }
        undo(remove, 'an agent part')
        return Object.assign(() => remove(), {
          replace(next: Extension) {
            life.live(`the agent part ${name}`)
            if (removed) throw new Error(`Extension ${extension.name}: the agent part ${name} was removed`)
            if (next.name !== name) throw new Error(`Extension ${extension.name}: the agent part ${name} can only be replaced by one of the same name, not ${next.name}`)
            const installed = part.replace(next)
            if (!always) given.set(name, installed)
          },
          remove,
        })
      },
      agentParts(add) { own(adders, add as (typeof adders)[number]['value'], 'an agentParts'); note('agentParts', 'an agentParts') },
      auth: {
        flow(to, run) {
          life.live('a sign-in flow')
          const flow = host.flows.start((event) => to.notify('auth.event', { flow, event }), run, life.signal)
          return { flow }
        },
      },
      settings: {
        register(section) {
          life.live(`the settings ${section.id}`)
          ownKey(section.id)
          for (const setting of section.settings) ownKey(setting.key)
          note('settings', section.id)
          undo(settings.register(section), 'settings')
        },
        get: (key) => settings.get(key),
        snapshot: () => settings.snapshot(),
        onChange: (listener) => { life.live('a settings listener'); undo(settings.onChange(listener), 'a settings listener') },
      },
      action: (action) => { life.live(`the action ${action.id}`); undo(router.register({ ...action, id: named(extension.name, action.id) }), 'an action'); note('actions', action.keys ? `${action.id} (${action.keys})` : action.id) },
      dispatch: (id, params) => router.dispatch(id, params ?? {}, { source: extension.name, notify: () => {} }, { source: extension.name }),
      actions: (exposure) => router.list(exposure),
      method(name, run, options = {}) {
        const id = named(extension.name, name)
        life.live(`the method ${id}`)
        if (methods.has(id) || router.has(id)) throw new Error(`Method ${id} is already defined`)
        const parse = paramsParser(id, options.params)
        methods.set(id, async (params: unknown) => run(parse(params) as never))
        undo(() => { methods.delete(id) }, 'a method')
        note('methods', id)
      },
      channel(kind, accept) {
        const id = named(extension.name, kind)
        life.live(`the channel ${id}`)
        if (channelKinds.has(id)) throw new Error(`Channel ${id} is already accepted`)
        channelKinds.set(id, accept)
        for (const peer of connections) acceptChannels(peer, id)
        undo(() => { channelKinds.delete(id) }, 'a channel')
        note('channels', id)
      },
      pane(kind, about) {
        if (paneKinds.some((p) => p.value.kind === kind && p.profiles === profiles)) throw new Error(`Pane kind ${kind} is already described`)
        own(paneKinds, { kind, about }, `the pane kind ${kind}`)
        note('pane kinds', kind)
      },
      view(id, view) {
        const name = named(extension.name, id)
        life.live(`the view ${name}`)
        const problem = dataViewProblem(view)
        if (problem) throw new Error(`View ${name} ${problem}`)
        const source = view.value ?? view.method!
        if (!source.startsWith(`${extension.name}.`)) throw new Error(`View ${name} must read a value or method of ${extension.name}'s, not ${source}`)
        if (dataViews.some((v) => v.info.id === name)) throw new Error(`View ${name} is already declared`)
        // A profile's show only in its threads: the places that show one.
        const fits = profiles ? view.fits.filter((p) => p !== 'space') : view.fits
        if (!fits.length) throw new Error(`View ${name} fits no place a profile's view is drawn in (beside, pane)`)
        const entry = { info: { ...view, fits, id: name, extension: extension.name }, ...(profiles ? { profiles } : {}) }
        dataViews.push(entry)
        publishViews()
        note('views', `${name} (${fits.join(', ')}; from ${source})`)
        undo(() => { dataViews.splice(dataViews.indexOf(entry), 1); publishViews() }, 'a view')
        // Told to the agent as a pane kind it can open, when it says what it shows.
        if (view.about && view.context === 'thread' && fits.includes('pane')) api.pane(name, view.about)
      },
      value<T extends Json>(key: string, initial: T): LiveValue<T> {
        const name = named(extension.name, key)
        life.live(`the value ${name}`)
        const value = values.publish(name, initial, life)
        note('values', name)
        return value
      },
      scopedValue<T extends Json>(key: string, initial: T): ScopedValue<T> {
        const name = named(extension.name, key)
        life.live(`the value ${name}`)
        const value = values.publishScoped(name, initial, life)
        note('values', `${name} (scoped)`)
        return value
      },
      status(contribute) { own(contributors, contribute, 'a status'); note('status', 'a status') },
      beforeSend(transform) { own(transforms, transform, 'a send transform'); note('beforeSend', 'a send transform') },
      invalidate() { changed(); later.threads().heedStatus() },
      thread(hooks) { own(threadHooks, hooks as ThreadHooks, 'thread hooks'); note('thread hooks', Object.keys(hooks).join(', ')) },
      state<T extends Json>() {
        const name = extension.name
        return {
          get: async (id: string) => stateOf((await threads.get(id)).meta, name) as T | undefined,
          set: (id: string, next: T | undefined) => threads.editState(id, name, () => next),
          update: (id: string, edit: (current: T | undefined) => T | undefined) => threads.editState(id, name, (current) => edit(current as T | undefined)),
        }
      },
      facts(describe) {
        if (factSources.some((f) => f.owner === extension.name)) throw new Error(`Extension ${extension.name} already says its facts`)
        own(factSources, describe as (typeof factSources)[number]['value'], 'facts')
        note('facts', 'facts')
        changed()
      },
      quiet(describe) {
        own(quietSources, describe as (typeof quietSources)[number]['value'], 'quiet')
        note('quiet', 'quiet')
        changed()
      },
      recap(describe) { own(recaps, describe, 'a recap'); note('recap', 'a recap') },
      toolCalls(watch) { own(toolWatchers, watch, 'a toolCalls watcher'); note('toolCalls', 'a toolCalls watcher') },
      agentFor(choose) { own(choosers, choose as (typeof choosers)[number]['value'], 'an agentFor'); note('agentFor', 'an agentFor'); changed() },
      threads: threads.apiFor(extension.name),
      machines: {
        list: () => later.relay().entries().slice(1),
        call: (machine, method, params) => later.relay().call(machine, method, params ?? {}),
      },
    }
    const teardown = () => { life.dispose() }
    // Given up on when it takes too long: torn down (its signal aborted, what it registered undone, what it registers
    // after refused), so the profiles waiting behind it load. A cleanup it returns after that runs at once.
    const setup = Promise.resolve().then(() => extension.setup?.(api))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), host.setupTimeout) })
    try {
      const cleanup = await Promise.race([setup, timedOut])
      if (cleanup === 'timeout') {
        void setup.then((late) => { if (typeof late === 'function') late() }).catch((error: unknown) => console.error(`Extension ${extension.name}: its setup, given up on, failed after:`, error))
        throw Object.assign(new Error(`its setup didn't finish in ${host.inTime}, so it's torn down. Keep setup quick, and don't await work that loads a profile (starting or reading a thread) in it`), { timedOut: true })
      }
      if (cleanup) undo(cleanup, 'a cleanup')
    } catch (error) {
      teardown()
      report((error as { timedOut?: boolean }).timedOut ? 'timed out' : 'failed', error instanceof Error ? error.message : String(error))
      console.error(`Extension ${extension.name} failed to start:`, error)
      throw new Error(`Extension ${extension.name} failed to start: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    } finally {
      clearTimeout(timer)
    }
    // Offered once it's set up: a client that sees it in `hello.extensions` finds its methods there, and one that fails never shows.
    failures.delete(from.file ?? extension.name)
    record.ready = true
    announce()
    return teardown
  }

  /**
   * Set up one of the core's or the bundled daemon halves, for the daemon's life: each giving every thread its agent
   * parts unless the thread goes without it.
   */
  function setUpBuiltin(extension: DaemonExtension, source: 'core' | 'bundled') {
    return setUp(extension, (part, always) => {
      registry.install(part)
      if (!always) return { installed: part, undo: () => registry.uninstall(part), replace: (next) => { registry.install(next); return next } }
      const entry = { part, owner: extension.name }
      builtins.push(entry)
      return {
        installed: part,
        undo: () => { registry.uninstall(entry.part); builtins.splice(builtins.indexOf(entry), 1) },
        replace: (next) => { registry.install(next); entry.part = next; return next },
      }
    }, undefined, { source })
  }

  /** A switch in Settings for each optional extension: set again as windows declare more. */
  let unregisterSwitches = () => {}
  const registerSwitches = () => {
    unregisterSwitches()
    unregisterSwitches = registerExtensionSettings(settings, switchable())
  }
  // Turning one off changes what threads go without, and what this machine offers: clients are told both.
  let switches = ''
  const unlisten = settings.onChange(() => {
    const now = JSON.stringify(switchable().map(({ name }) => settings.get(`extensions.${name}`)))
    if (now === switches) return
    switches = now
    changed()
    announce()
  })

  /**
   * Extensions a window has whose work is all there (no daemon half): known here as the window declares them, so an
   * optional one has its switch in Settings and a profile can do without it, as with any other. Until a window
   * connects (after a restart), threads aren't told they go without one. Its name is claimed, so no profile's
   * extension takes it. When windows disagree on one, the newest version's word is taken (a new title, now required),
   * whatever order they say it in; never last-come.
   */
  function declare(abouts: ExtensionAbout[]) {
    let news = false
    for (const about of abouts) {
      const name = about?.name
      if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name) || RESERVED.has(name)) continue
      const record = records.get(name)
      if (record && record.source !== 'window') continue
      const next = aboutOf(about)
      if (next.version !== undefined && !parseVersion(next.version)) continue
      const was = record?.about
      if (JSON.stringify(was) === JSON.stringify(next)) continue
      // The newest version's word; two words at one version (windows built apart), settled by their text, so the
      // same one stands whatever order the windows connect in.
      if (was && (compareVersion(next.version ?? UNVERSIONED, was.version ?? UNVERSIONED) || (JSON.stringify(next) > JSON.stringify(was) ? 1 : -1)) < 0) continue
      if (record) record.about = next
      else records.set(name, { about: next, source: 'window', ready: true, registered: new Map() })
      news = true
    }
    if (!news) return
    registerSwitches()
    changed()
  }

  /** What each extension here is and does, and (given a thread) which don't take part in it and why: `extension.inspect`. */
  async function inspect(threadId?: string): Promise<ExtensionsReport> {
    const profiles = later.profiles()
    const off = switchedOff()
    const dirName = new Map(profiles.all().map((p) => [p.dir, `${p.scope === 'project' ? 'project' : 'user'}:${p.name}`]))
    const reports: ExtensionReport[] = []
    // The daemon halves, then those the windows declared.
    const ordered = [...records.values()].sort((a, b) => Number(a.source === 'window') - Number(b.source === 'window'))
    for (const { about, source, file, profiles: dirs, registered } of ordered) {
      const name = about.name
      if (source === 'window') {
        reports.push({ ...manifestOf(about), ...(about.title ? { title: about.title } : {}), source, state: off.has(name) ? 'off' : 'set up', registered: {}, watches: [] })
        continue
      }
      reports.push({
        ...manifestOf(about), ...(about.title ? { title: about.title } : {}), ...(about.required ? { required: true } : {}),
        source, ...(file ? { file } : {}), ...(dirs ? { profiles: [...dirs].map((dir) => dirName.get(dir) ?? dir) } : {}),
        state: off.has(name) ? 'off' : 'set up', registered: Object.fromEntries(registered), watches: values.watchedUnder(name),
      })
    }
    reports.push(...failures.values())
    const report: ExtensionsReport = {
      api: EXTENSION_API,
      extensions: reports,
      profiles: [
        ...profiles.all().map((p) => ({ name: p.name, scope: p.scope, dir: p.dir, state: 'loaded' as const })),
        ...profiles.errors().map(({ ref, error }) => ({ name: ref.name, scope: ref.scope, dir: ref.dir, state: 'failed' as const, error })),
      ],
    }
    if (threadId === undefined) return report
    const { meta } = await later.threads().get(threadId)
    const profile = meta.profile ? await profiles.profileOf(meta.profile).catch(() => undefined) : undefined
    const { choice } = choiceAndWithout(threadId, meta, profile)
    const without: { extension: string; why: string }[] = []
    for (const { name, required } of switchable()) {
      if (required) continue
      if (settings.get(`extensions.${name}`) === false) without.push({ extension: name, why: 'switched off on this machine (Settings → Extensions)' })
      else if (profile?.spec.without?.includes(name)) without.push({ extension: name, why: `its profile ${profile.name} goes without it (without)` })
      else if (choice?.without?.includes(name)) without.push({ extension: name, why: `${choice.by}'s agentFor chose an agent without it` })
    }
    for (const [name, { profiles: dirs }] of records) {
      if (!dirs || (meta.profile && dirs.has(meta.profile.dir))) continue
      without.push({ extension: name, why: `it's a profile's (${[...dirs].map((dir) => dirName.get(dir) ?? dir).join(', ')}), and this thread's profile is ${meta.profile ? meta.profile.name : 'none'}` })
    }
    if (meta.profile && !profile) {
      const why = profiles.error(meta.profile.dir) ?? "it isn't loaded"
      without.push({ extension: `profile ${meta.profile.name}`, why: `none of its extensions: ${why}` })
    }
    return { ...report, thread: { id: threadId, ...(meta.profile ? { profile: `${meta.profile.scope}:${meta.profile.name}` } : {}), without } }
  }

  return {
    setUp, setUpBuiltin, registerSwitches, declare, inspect, known, offer, offered: (name: string) => offered().some((e) => e.name === name),
    publishViews, agentOf, partsFor, switchedOff, withoutFor, panesOf, factsOf, quietOf, blockedOf, appliesTo,
    /** The daemon closing: switches turned meanwhile change nothing. */
    close: () => unlisten(),
    /** The hooks that are for a thread, in order. */
    hooksFor: (without: Set<string>, meta: ThreadMeta) => threadHooks.filter((h) => appliesTo(h, without, meta)),
    /** Whether any extension has a `hook` at all. */
    hears: (hook: keyof ThreadHooks) => threadHooks.some((h) => h.value[hook]),
    recapsFor: (without: Set<string>, meta: ThreadMeta) => recaps.filter((r) => appliesTo(r, without, meta)).map((r) => ({ owner: r.owner, recap: r.value })),
    transformsFor: (without: Set<string>, meta: ThreadMeta) => transforms.filter((t) => appliesTo(t, without, meta)).map((t) => t.value),
    /** An extension's read method, by its id. */
    method: (id: string) => methods.get(id),
    methodIds: () => methods.keys(),
    /** A connection opening: told what this daemon offers from now on, and taking extensions' channels. Returns its end. */
    connect(peer: RpcPeer) {
      connections.add(peer)
      for (const kind of channelKinds.keys()) acceptChannels(peer, kind)
      return () => { connections.delete(peer) }
    },
  }
}

export type ExtensionHost = ReturnType<typeof createExtensionHost>
