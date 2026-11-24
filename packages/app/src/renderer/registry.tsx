// The window's extension registry: everything the app's extensions (and the core, and each profile's UI) registered,
// each with its owner. Everything an extension registers is owned by it, and its teardown removes all of it at once (a
// `Lifetime`: its signal aborts, its setup's cleanup runs, and what it registers after is refused). What it draws is
// drawn apart (`Contained`): a component that throws takes only its own place. A profile's UI is owned by that profile
// on its machine too, and draws only in that profile's threads there (`seenIn`); its styles reach only what it draws
// (profile-style.ts). Where a profile lives says how far its UI reaches: a project's profile's spaces (and their links)
// are its project's (`Owner.project`), seen in that project's threads and spaces only; the user's global profile's are the
// app's; any other profile of the user's adds none.
import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import { contractProblem, Lifetime, parseVersion, UNVERSIONED } from '@superego/protocol'
import type { AppConfig, DataViewInfo, DeclaredSection, ExtensionAbout, ExtensionManifest, ProfileRef, SettingsSnapshot, ThreadInfo } from '@superego/protocol'
import { createWindowRouter, type WindowAction, type WindowContext, type WindowRouter } from './actions.tsx'
import { watched } from './client.ts'
import { createStore } from './local-state.ts'
import { APP } from '../shared/app-settings.ts'
import { PLACES, THREAD_PLACES } from '../shared/layout.ts'
import type { CompletionProvider, SentWith } from './composer.ts'
import { dataIcon, DataViewBody } from './data-views.tsx'
import { addStyle } from './profile-style.ts'
import { onMachine } from './machine-view.tsx'
import { checkTheme, type Theme } from '@superego/ui/themes'
import type {
  BehaviourSlot, EntryProps, LinkHandler, NewThreadField, PaneKind, PaneProps, SettingsComponentProps, SlotProps, SpaceKind, ToolCallProps, ToolRow, UiApi,
  UiExtension, View, ViewProps, WindowEvent, WindowEvents, WindowState, WorkPart, WorkRun,
} from './extension-api.ts'

/**
 * Who registered something: an extension, whether it's optional (a thread can go without it), and for a profile's UI,
 * that profile on its machine (`profileScope`). `speaks` for an app's UI half: whether it draws for threads on
 * `machine`, by the version that machine runs its extension at (see `speaks`).
 */
export type Owner = {
  extension: string; optional: boolean; profile?: string; data?: true; speaks?(machine: string): boolean
  /** A global profile's UI (`global: true`): installed as the app's, but taken down with its profile (its scope). */
  global?: string
  /**
   * A project's profile's spaces and the links that open them: its project's, seen in that project's threads and spaces
   * only (`seenIn`), whichever profile those run. `profile`: which of the project's profiles it is, by name (its default
   * wins a kind two of them declare: `spaceFor`). Its other registrations are its threads' alone, as any profile's.
   */
  project?: InProject & { profile: string }
}

/** A project on a machine, by its root: a repository's main checkout, or a folder (`ThreadInfo.project.root`). */
export type InProject = { machine: string; root: string }
export const sameProject = (a: InProject | undefined, b: InProject | undefined) => Boolean(a && b && a.machine === b.machine && a.root === b.root)

/**
 * The project a project's profile is of, on `machine`: the folder whose `.superego/profiles` holds it. None for the
 * user's own profiles.
 */
export function projectOfProfile(machine: string, profile: Pick<ProfileRef, 'scope' | 'dir' | 'name'>): (InProject & { profile: string }) | undefined {
  if (profile.scope !== 'project') return undefined
  const root = /^(.*?)[\\/]\.superego[\\/]profiles[\\/][^\\/]+[\\/]?$/.exec(profile.dir)?.[1]
  return root ? { machine, root, profile: profile.name } : undefined
}

/**
 * Whether a UI half at `version` works with a machine whose manifest of its extension is `there`: at the same major
 * (below 1.0, the same minor: semver's 0.x minors break). One the machine doesn't announce it does: its daemon half is
 * off there (the thread goes without it), or it has none.
 */
export const speaks = (version: string | undefined, there: ExtensionManifest | undefined) =>
  !there || major(version ?? UNVERSIONED) === major(there.version ?? UNVERSIONED)
const major = (version: string) => {
  const [major = 0, minor = 0] = parseVersion(version) ?? []
  return major > 0 ? `${major}` : `0.${minor}`
}
export type Owned<T> = T & { owner: Owner }

/** A thread as lookups see it: on a machine, maybe with a profile. */
export type Where = { machine: string; thread: ThreadInfo }

/** A profile's UI, as the registry tells profiles apart: by machine and folder (the same path on two machines is two). */
export const profileScope = (machine: string, profile: Pick<ProfileRef, 'dir'>) => `${machine}\u0000${profile.dir}`
/** Whether a profile's scope (`profileScope`) is on `machine`. */
export const scopeIsOn = (scope: string, machine: string) => scope.startsWith(`${machine}\u0000`)
/** The profile's scope `where` draws in, if its thread has a profile. */
export const scopeOf = (where: Where | undefined) => where?.thread.profile ? profileScope(where.machine, where.thread.profile) : undefined

/** Everything the app's extensions registered, in the order they were listed, each with its owner. */
export type Registry = {
  app: AppConfig
  /** What the app's extensions are, as each declares itself: told to every machine, so UI-only ones are known there. */
  extensions: ExtensionAbout[]
  slots: { [S in BehaviourSlot]: Owned<{ component: ComponentType<SlotProps[S]>; order: number }>[] }
  /**
   * The views declared, by id (`<extension>.<name>`): where each goes is the layout's. A machine's data view
   * (`dataViews`) is one too, drawn by the core, with the machines that have it (`machines`).
   */
  views: Owned<View & { id: string; machines?: string[] }>[]
  /** The data views each machine declares (its daemon halves' `superego.view`), by machine. */
  dataViews: Record<string, DataViewInfo[]>
  /** Take the data views `machine` declares now (none: it's gone, or switched them off). */
  setDataViews(machine: string, views: DataViewInfo[]): void
  /** The extensions each machine runs, as it announces them (`hello.extensions`): what the UI halves draw for its threads. */
  machineExtensions: Record<string, ExtensionManifest[]>
  /** Take what `machine` announces now (none: it's gone). */
  setMachineExtensions(machine: string, extensions: ExtensionManifest[]): void
  /** Drawn by a `component`, or described by a `row`. `fold: false`: its calls show outside the fold of their run of work. */
  tools: Owned<{ name: string; component?: ComponentType<ToolCallProps>; row?: ToolRow; fold: boolean }>[]
  entries: Owned<{ kind: string; component: ComponentType<EntryProps> }>[]
  links: Owned<LinkHandler>[]
  panes: Owned<PaneKind & { kind: string }>[]
  /**
   * Spaces (`superego.space`), by kind, each with the machine it opens on (a global or project profile's, its own). A
   * project's (`owner.project`) are that project's: the same kind in two projects is two (`spaceFor`, `projectSpaces`).
   */
  spaces: Owned<SpaceKind & { kind: string; machine?: string }>[]
  work: Owned<{ divide: (run: WorkRun) => WorkPart[] | undefined }>[]
  settings: Owned<{ ui: string; component: ComponentType<SettingsComponentProps> }>[]
  /** The New thread dialog's fields, by the extension each is of (its `options` key). */
  newThreadFields: Owned<NewThreadField & { name: string }>[]
  router: WindowRouter
  appSettings: Owned<DeclaredSection>[]
  /** Themes for code and the terminal (`superego.theme`), checked: the Appearance pickers list them by their owner. */
  themes: Owned<Theme>[]
  completions: Owned<CompletionProvider<any>>[]
  sentWith: Owned<SentWith>[]
  listeners: Owned<{ event: WindowEvent; listener: (event: never) => void }>[]
  /** The window as it is now: the shell keeps it, through `emit`. */
  window: WindowState
  /**
   * Tell listeners what happened, after updating `window` to match. `thread.status` reaches only listeners whose
   * extension the thread has (and a profile's, only its own threads); a listener that throws is logged and skipped.
   */
  emit<E extends WindowEvent>(event: E, payload: WindowEvents[E]): void
  /**
   * Set up a profile's UI halves on `machine`, after tearing down what that profile set up before. One that fails
   * to start is logged and left out, the rest set up; the failures are returned. `global`: a global profile's
   * (`global: true`), set up as the app's: in any place, for every thread. Otherwise its threads' own, but for a
   * project's profile (`scope: 'project'`), whose spaces are its project's (`Owner.project`).
   */
  installProfile(machine: string, profile: ProfileRef, extensions: UiExtension[], options?: { global?: boolean }): { extension: string; error: unknown }[]
  /** Tear down every extension set up, the core's last: as the window closing would (a test's end). */
  teardown(): void
  /** Changes whenever extensions are added or removed at runtime; `subscribe` to hear it. */
  version: number
  subscribe(listener: () => void): () => void
}

export function createRegistry(app: AppConfig, extensions: UiExtension[], core: (superego: UiApi) => void): Registry {
  const listeners = new Set<() => void>()
  /** The teardown of each extension set up, by owner (`<profile scope>/<name>`). */
  const teardowns = new Map<string, () => void>()
  const ownerKey = (owner: Owner) => `${owner.profile ?? owner.global ?? ''}/${owner.extension}`
  const registry: Registry = {
    app, extensions: extensions.map(({ name, title, description, required, version, api, panes }) => ({
      name, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(required ? { required } : {}),
      ...(version ? { version } : {}), ...(api ? { api } : {}), ...(panes ? { panes } : {}),
    })),
    slots: { 'header.chips': [], 'thread.badge': [], 'composer.above': [], 'details.section': [], 'editor.side': [], 'editor.bar': [], 'overlay': [], 'onboarding': [] },
    views: [], dataViews: {}, machineExtensions: {}, tools: [], entries: [], links: [], panes: [], spaces: [], work: [], settings: [], newThreadFields: [], router: createWindowRouter(), appSettings: [], themes: [], completions: [], sentWith: [], listeners: [],
    window: {
      focused: typeof document === 'undefined' || document.hasFocus(),
      visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
      selection: undefined, thread: undefined, machines: [], threads: {},
    },
    emit(event, payload) {
      if (event === 'focus') registry.window.focused = (payload as WindowEvents['focus']).focused
      if (event === 'visibility') registry.window.visible = (payload as WindowEvents['visibility']).visible
      if (event === 'select') registry.window.selection = (payload as WindowEvents['select']).selection
      const where = event === 'thread.status' ? payload as WindowEvents['thread.status'] : undefined
      const hearing = registry.listeners.filter((l) => l.event === event)
      for (const { listener } of where ? seenIn(hearing, where) : hearing) {
        try { (listener as (payload: unknown) => void)(payload) } catch (error) { console.error(`A ${event} listener failed`, error) }
      }
    },
    version: 0,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setDataViews(machine, views) {
      if (JSON.stringify(registry.dataViews[machine] ?? []) === JSON.stringify(views)) return
      registry.dataViews = { ...registry.dataViews, [machine]: views }
      placeDataViews()
      registry.version++
      for (const listener of listeners) listener()
    },
    setMachineExtensions(machine, extensions) {
      if (JSON.stringify(registry.machineExtensions[machine] ?? []) === JSON.stringify(extensions)) return
      registry.machineExtensions = { ...registry.machineExtensions, [machine]: extensions }
      registry.version++
      for (const listener of listeners) listener()
    },
    teardown() {
      for (const [key, teardown] of [...teardowns].reverse()) if (key !== '/core') teardown()
      teardowns.get('/core')?.()
      registry.version++
      for (const listener of listeners) listener()
    },
    installProfile(machine, profile, list, options = {}) {
      const scope = profileScope(machine, profile)
      for (const [key, teardown] of [...teardowns]) if (key.startsWith(`${scope}/`)) teardown()
      const failed: { extension: string; error: unknown }[] = []
      for (const extension of list) {
        try { setUp(extension, scope, options.global ? 'global' : projectOfProfile(machine, profile)) } catch (error) {
          console.error(`Profile extension ${extension.name} failed to start`, error)
          failed.push({ extension: extension.name, error })
        }
      }
      registry.version++
      for (const listener of listeners) listener()
      return failed
    },
  }

  /**
   * Window actions of profiles' UI, by id: one action in the router per id, however many profiles (or one profile on
   * several machines) define it, offered while a thread of one of them is shown and run as that profile's.
   */
  const profileActions = new Map<string, { entries: { action: WindowAction; scope: string }[]; off: () => void }>()
  function registerProfileAction(action: WindowAction, scope: string): () => void {
    const shown = (c: WindowContext) => {
      const thread = c.selection && c.threadOf(c.selection)
      return thread?.profile ? profileScope(c.selection!.machine, thread.profile) : undefined
    }
    let held = profileActions.get(action.id)
    if (!held) {
      const entries: { action: WindowAction; scope: string }[] = []
      const { when: _when, run: _run, ...info } = action
      const own = (c: WindowContext) => entries.find((e) => e.scope === shown(c))
      const off = registry.router.register({
        ...info,
        when: (c) => { const e = own(c); return Boolean(e) && (e!.action.when?.(c) ?? true) },
        run: (params, c) => {
          const e = own(c)
          if (!e) throw new Error(`${action.id} is a profile's: show one of its threads to run it`)
          return e.action.run(params, c)
        },
      })
      profileActions.set(action.id, held = { entries, off })
    }
    if (held.entries.some((e) => e.scope === scope)) throw new Error(`Action ${action.id} is already defined`)
    const entry = { action, scope }
    held.entries.push(entry)
    const it = held
    return () => {
      it.entries.splice(it.entries.indexOf(entry), 1)
      if (!it.entries.length) { it.off(); if (profileActions.get(action.id) === it) profileActions.delete(action.id) }
    }
  }

  /** Set up one extension: everything it adds is owned by it, and its teardown takes all of it away again. */
  function setUp(extension: UiExtension, scope?: string, reach?: 'global' | Owner['project']) {
    // A global profile's is the app's in all but its teardown (by its scope): `profile` is a thread-bound profile's
    // (a project's too, but for its spaces: `project`).
    const global = reach === 'global'
    const project = typeof reach === 'object' ? reach : undefined
    const profile = global ? undefined : scope
    if (!/^[a-z][a-z0-9-]*$/.test(extension.name)) throw new Error(`Extension name "${extension.name}" must be lowercase letters, digits and dashes`)
    // One whose versions don't read, or that needs an extension API this window isn't, is refused before it runs.
    const problem = contractProblem(extension)
    if (problem) throw new Error(problem)
    // The core's and a profile's own aren't the machine's to turn off; a bundled extension is, unless it's required.
    const owner: Owner = {
      extension: extension.name, optional: !scope && extension.name !== 'core' && !extension.required,
      ...(profile ? { profile } : {}), ...(global && scope ? { global: scope } : {}),
    }
    // An app's UI half draws for a machine's threads only where it speaks with that machine's half (a profile's comes
    // from the machine itself; the core is the app).
    // Asked for every tool call a transcript draws, so worked out once for each list a machine announces.
    if (!scope && extension.name !== 'core') {
      const spoken = new WeakMap<ExtensionManifest[], boolean>()
      owner.speaks = (machine) => {
        const there = registry.machineExtensions[machine]
        if (!there) return true
        let answer = spoken.get(there)
        if (answer === undefined) spoken.set(there, answer = speaks(extension.version, there.find((e) => e.name === extension.name)))
        return answer
      }
    }
    // A name is the extension's prefix: one of each among the app's, and a profile's can't take one of theirs.
    if (teardowns.has(ownerKey(owner)) || (scope && teardowns.has(`/${extension.name}`))) throw new Error(`An extension named ${extension.name} is already set up`)
    // Everything it registers goes through its lifetime: undone together at teardown, and refused after.
    const life = new Lifetime(`${scope ? 'Profile extension' : 'Extension'} ${extension.name}`)
    const add = <T,>(list: Owned<T>[], item: T, by: Owner = owner) => {
      life.live('anything')
      const entry = { ...item, owner: by } as Owned<T>
      list.push(entry)
      life.add(() => { const at = list.indexOf(entry); if (at >= 0) list.splice(at, 1) })
      return entry
    }
    /**
     * A name of its own: `<extension>.<more>`, or for views, entry kinds and settings sections (`bare`) the extension's
     * own name too (the core's are any).
     */
    const own = (name: string, what: string, bare = false) => {
      if (extension.name === 'core' || name.startsWith(`${extension.name}.`) || (bare && name === extension.name)) return
      throw new Error(`Extension ${extension.name} must name its ${what} "${extension.name}.<name>", not "${name}"`)
    }
    /** One of a kind per scope: a second registration of the same name is refused (the first stays), with a warning. */
    const unique = <T extends Record<K, string>, K extends keyof T>(list: Owned<T>[], key: K, item: T, what: string, by: Owner = owner) => {
      life.live(`the ${what} ${item[key]}`)
      const taken = list.find((e) => e[key] === item[key] && e.owner.profile === profile)
      if (taken) return console.warn(`Extension ${extension.name}: ${what} ${item[key]} is already drawn by ${taken.owner.extension}; keeping that one`)
      add(list, item, by)
    }
    /** A view, checked: a profile's fit only the places that show one of its threads. */
    const declare = (id: string, view: View) => {
      if (view.fits.some((place) => !PLACES.includes(place))) console.warn(`Extension ${extension.name}: view ${id} fits a place there isn't (${view.fits.join(', ')})`)
      const fits = profile ? view.fits.filter((place) => THREAD_PLACES.includes(place)) : view.fits
      if (!fits.length) return console.warn(`Profile extension ${extension.name}: view ${id} fits no place a profile's UI draws in`)
      // A global profile's window view is told the machine its profile is on.
      const on = global && scope && view.context === 'window' ? scope.slice(0, scope.indexOf('\u0000')) : undefined
      const component = on ? onMachine(on, view.component as ComponentType<ViewProps>) : view.component
      unique(registry.views, 'id', { ...view, fits, id, component }, 'view')
    }
    const api: UiApi = {
      app,
      signal: life.signal,
      view(id, view) {
        own(id, 'views', true)
        declare(id, view as View)
        // A thread view that fits a pane is a pane kind too, of its id: opened from the pane menu while it's placed there.
        if (view.context === 'thread' && view.fits.includes('pane')) {
          const Component = view.component as ComponentType<ViewProps<'thread'>>
          unique(registry.panes, 'kind', {
            kind: id, title: view.title, component: ({ machine, thread }: PaneProps) => <Component place="pane" machine={machine} thread={thread} />,
            ...(view.icon ? { icon: view.icon } : {}), ...(view.width ? { width: view.width } : {}),
          }, 'pane kind')
        }
      },
      slot(slot: BehaviourSlot, component: ComponentType<any>, options?: { order?: number }) {
        // A profile's UI draws in its threads' slots; the overlay and onboarding are the app's, with no thread.
        if (profile && (slot === 'overlay' || slot === 'onboarding')) return console.warn(`Profile extension ${extension.name} can't fill the ${slot}`)
        const list = registry.slots[slot as BehaviourSlot] as Owned<{ component: ComponentType<never>; order: number }>[]
        add(list, { component: component as never, order: options?.order ?? 100 })
        list.sort((a, b) => a.order - b.order)
      },
      on(event, listener) {
        const entry = add(registry.listeners, { event, listener: listener as (event: never) => void })
        return () => { const at = registry.listeners.indexOf(entry); if (at >= 0) registry.listeners.splice(at, 1) }
      },
      get window() { return registry.window },
      appSetting: (key) => watched<SettingsSnapshot>(APP, 'settings.watch', {})?.values[key] as never,
      tool: (name, view, options) => {
        if (name.indexOf('*') !== -1 && name.indexOf('*') !== name.length - 1) return console.warn(`Extension ${extension.name}: tool ${name}: a * may only end a name (a prefix)`)
        unique(registry.tools, 'name', { name, ...(isComponent(view) ? { component: view } : { row: view }), fold: options?.fold !== false }, 'tool')
      },
      entry(kind, component) {
        own(kind, 'entry kinds', true)
        unique(registry.entries, 'kind', { kind, component }, 'entry kind')
      },
      link: (handler) => { add(registry.links, handler) },
      work(divide) {
        if (profile) return console.warn(`Profile extension ${extension.name}: dividing work from a profile's UI isn't supported yet`)
        add(registry.work, { divide })
      },
      settings(ui, component) {
        own(ui, 'settings sections', true)
        unique(registry.settings, 'ui', { ui, component }, 'settings section')
      },
      space(kind, space) {
        own(kind, 'spaces')
        // Bound to a profile's threads, it'd have nowhere to open: only the app's, a global profile's (the app's) and
        // a project's profile's (its project's, `Owner.project`).
        if (profile && !project) return console.warn(`Profile extension ${extension.name}: space ${kind} needs its profile to be global (global: true) or a project's`)
        const machine = scope?.slice(0, scope.indexOf('\u0000'))
        // A project's, and its links, are seen in its project only.
        const by: Owner = project ? { ...owner, project } : owner
        unique(registry.spaces, 'kind', { ...space, kind, ...(machine ? { machine } : {}) }, 'space', by)
        // Its links open it.
        if (space.match) {
          const scheme = space.match
          add(registry.links, {
            match: scheme,
            open: (href) => registry.router.dispatch('space.open', {
              kind, params: space.params?.(href) ?? { href }, ...(machine ? { machine } : {}), ...(project ? { project: project.root } : {}),
            }, { source: 'link' }).then(() => undefined, (error: Error) => error.message),
          }, by)
        }
      },
      pane(kind, pane) {
        unique(registry.panes, 'kind', { ...pane, kind }, 'pane kind')
        // Offered in the pane menu: a view of the pane menu, of the kind's name, placed there by default.
        if (pane.menu) {
          const title = typeof pane.title === 'function' ? pane.title({ id: '', kind }) ?? kind : pane.title
          declare(kind, { title, ...(pane.icon ? { icon: pane.icon } : {}), context: 'thread', fits: ['pane'], default: 'pane', component: () => null })
        }
      },
      newThreadField(field) {
        // The dialog has no thread yet: a profile's UI has nowhere to draw.
        if (profile) return console.warn(`Profile extension ${extension.name}: New thread fields from a profile's UI aren't supported yet`)
        unique(registry.newThreadFields, 'name', { ...field, name: extension.name }, 'New thread field')
      },
      style(css) {
        life.live('a style')
        // A profile's is scoped to what it draws (profile-style.ts); an app's is the window's.
        const remove = addStyle(css, { extension: extension.name, scope: profile })
        life.add(remove, 'a style')
        return remove
      },
      theme(theme) {
        const checked = checkTheme(theme, `${profile ? 'Profile extension' : 'Extension'} ${extension.name}'s theme`)
        own(checked.id, 'themes')
        unique(registry.themes, 'id', { ...checked }, 'theme')
      },
      dispatch: (id, params, options) => registry.router.dispatch(id, params, { source: extension.name, ...options }),
      action(action) {
        own(action.id, 'actions')
        // A profile's: offered (keys, the palette) only while one of its threads is shown, and run as that one's.
        if (profile) {
          life.live(`the action ${action.id}`)
          life.add(registerProfileAction(action, profile))
          return
        }
        // Not offered while a thread is shown that goes without this extension, or whose machine it doesn't speak with.
        const { when } = action
        const has = (c: WindowContext) => !c.selection || drawsFor(owner, { machine: c.selection.machine, thread: c.threadOf(c.selection) })
        life.live(`the action ${action.id}`)
        life.add(registry.router.register(owner.speaks ? { ...action, when: (c) => has(c) && (when?.(c) ?? true) } : action))
      },
      appSettings(section) {
        if (profile) return console.warn(`Profile extension ${extension.name}: app settings from a profile's UI aren't supported yet`)
        for (const setting of section.settings) own(setting.key, 'settings')
        add(registry.appSettings, section)
      },
      store(key, initial, options) {
        // Its own: `<extension>.<key>`, whether given so or as the bare key.
        const name = key.startsWith(`${extension.name}.`) ? key : `${extension.name}.${key}`
        life.live(`the store ${name}`)
        // A profile's is kept apart for each profile on each machine: the same profile folder elsewhere is another.
        return createStore(scope ? `profile.${encodeURIComponent(scope)}.${name}` : name, initial, options)
      },
      composer: {
        complete: (provider) => { add(registry.completions, provider as CompletionProvider<any>) },
        sentWith: (sent) => { add(registry.sentWith, sent as SentWith) },
      },
    }
    const teardown = () => {
      life.dispose()
      teardowns.delete(ownerKey(owner))
    }
    teardowns.set(ownerKey(owner), teardown)
    try {
      const cleanup = extension.setup(api)
      if (typeof cleanup === 'function') life.add(cleanup, 'a cleanup')
    } catch (error) { teardown(); throw error }
  }

  /**
   * The machines' data views, as views: one per id however many machines have it (a profile's, one per profile on
   * each machine), after the extensions' own; one an extension's UI declares already is theirs. Made again as a
   * machine's change.
   */
  function placeDataViews() {
    const drop = <T,>(list: Owned<T>[]) => { for (let i = list.length - 1; i >= 0; i--) if (list[i]!.owner.data) list.splice(i, 1) }
    drop(registry.views)
    drop(registry.panes)
    for (const [machine, infos] of Object.entries(registry.dataViews)) {
      for (const info of infos) {
        for (const profile of info.profiles?.map((dir) => profileScope(machine, { dir })) ?? [undefined]) {
          const same = registry.views.find((v) => v.id === info.id && v.owner.profile === profile)
          if (same) {
            if (same.owner.data && !same.machines!.includes(machine)) same.machines!.push(machine)
            else if (!same.owner.data) console.warn(`Data view ${info.id} on ${machine}: ${same.owner.extension}'s UI declares it already; keeping that one`)
            continue
          }
          const owner: Owner = { extension: info.extension, optional: !profile, ...(profile ? { profile } : {}), data: true }
          const icon = dataIcon(info.icon)
          const component = (props: ViewProps) => <DataViewBody id={info.id} {...props} />
          registry.views.push({
            id: info.id, title: info.title, ...(icon ? { icon } : {}), context: info.context, fits: info.fits,
            ...(info.default !== undefined ? { default: info.default } : {}), ...(info.narrow !== undefined ? { narrow: info.narrow } : {}),
            ...(info.order !== undefined ? { order: info.order } : {}), component, machines: [machine], owner,
          })
          // A pane kind of its id, unless one (a UI half's, with no view of the id) is drawn already.
          if (info.context === 'thread' && info.fits.includes('pane') && !registry.panes.some((p) => p.kind === info.id && p.owner.profile === profile)) {
            registry.panes.push({ kind: info.id, title: info.title, ...(icon ? { icon } : {}), component: ({ machine, thread }: PaneProps) => <DataViewBody id={info.id} place="pane" machine={machine} thread={thread} />, owner })
          }
        }
      }
    }
  }

  setUp({ name: 'core', required: true, setup: core })
  for (const extension of extensions) setUp(extension)
  return registry
}

/** A component (a function, or `memo`/`forwardRef`'s object) rather than a `ToolRow`. */
const isComponent = (view: ComponentType<ToolCallProps> | ToolRow): view is ComponentType<ToolCallProps> =>
  typeof view === 'function' || '$$typeof' in view

const RegistryContext = createContext<Registry | undefined>(undefined)
export const RegistryProvider = ({ registry, children }: { registry: Registry; children: ReactNode }) =>
  <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>

export function useRegistry(): Registry {
  const registry = useContext(RegistryContext)
  if (!registry) throw new Error('superego hooks need mountApp')
  return registry
}

/** The extension a registration is of, by name: what "<extension> failed to draw" says. */
export const whose = (entry: object | undefined, otherwise = 'An extension') => (entry as { owner?: Owner } | undefined)?.owner?.extension ?? otherwise

/** The profile's scope a registration is of, if a profile's: what it draws is marked with, for its styles (`Contained`). */
export const scopeOfEntry = (entry: object | undefined) => (entry as { owner?: Owner } | undefined)?.owner?.profile

/** The registry, where there is one (Markdown drawn outside the app has none). */
export const useOptionalRegistry = () => useContext(RegistryContext)

/** The app this UI belongs to. */
export const useApp = () => useRegistry().app

/** The project `where`'s thread is in, on its machine. */
export const projectOf = (where: Where | undefined): InProject | undefined =>
  where?.thread.project ? { machine: where.machine, root: where.thread.project.root } : undefined

/**
 * What `where` sees of `list`: the app's, but not those of optional extensions its thread goes without; its own
 * profile's (only that profile's, on that machine); and its project's (`Owner.project`: a project's spaces and their
 * links), whatever profile it runs. `project`: the project it's in, without a thread (a project's space); default, its
 * thread's.
 */
export const seenIn = <T,>(list: Owned<T>[], where: Where | undefined, project: InProject | undefined = projectOf(where)) => {
  const scope = scopeOf(where)
  return list.filter(({ owner }) => owner.project ? sameProject(owner.project, project)
    : owner.profile ? owner.profile === scope : !where || drawsFor(owner, where))
}

/**
 * Whether an app's extension draws for a thread on `machine` (unknown here: as far as the machine says): not when the
 * thread goes without it, nor when the machine runs it at a major its UI half doesn't speak.
 */
export const drawsFor = (owner: Owner, { machine, thread }: { machine: string; thread: ThreadInfo | undefined }) =>
  !(owner.optional && thread?.without?.includes(owner.extension)) && owner.speaks?.(machine) !== false

/** The first of `list` that's a profile's own, else the first: a profile's UI goes before the app's. */
export const preferProfile = <T extends { owner: Owner }>(list: T[]): T | undefined => list.find((entry) => entry.owner.profile) ?? list[0]

/** The one of `list` that `where` sees by `match`: its profile's own first, else the app's. */
export const lookUp = <T,>(list: Owned<T>[], where: Where | undefined, match: (entry: T) => boolean): Owned<T> | undefined =>
  preferProfile(seenIn(list, where).filter(match))
