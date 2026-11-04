// The UI half of an extension: `<pkg>/ui`, listed in the app's renderer entry. It fills named slots in the shell, draws
// tool calls and entries in the transcript, adds custom settings components and keyboard commands. Components reach
// everything else (machines, sessions, selection, live values, calls) through the hooks this package exports.
import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { AppConfig, SectionInfo, SessionInfo } from '@mu/protocol'
import type { MachineEntry } from '../shared.ts'

/** Where an extension can put UI. */
export type SlotName =
  /** The column left of the session: session lists, machine trees. With nothing here, the shell shows a compact picker. */
  | 'sidebar'
  /** Right of a session's title: badges, small actions. */
  | 'session.header'
  /** Above the composer: things waiting on the user, suggestions. */
  | 'composer.above'

export type SlotProps = {
  'sidebar': Record<string, never>
  'session.header': { machine: MachineEntry; session: SessionInfo }
  'composer.above': { machine: MachineEntry; session: SessionInfo }
}

/** A tool call in the transcript. `result` is there once it finished; `live` while it runs. */
export type ToolCallProps = {
  machine: MachineEntry
  session: SessionInfo
  call: { id: string; name: string; arguments: Record<string, unknown> }
  result?: { text: string; isError: boolean; details?: unknown }
  live?: { status: 'pending' | 'running' | 'done'; output?: string; details?: unknown }
}

/** An entry of a kind an extension writes (`kind` is its own, like `git.commit`). */
export type EntryProps = { machine: MachineEntry; session: SessionInfo; entry: { id: number; kind: string; data?: unknown } }

export type SettingsComponentProps = { target: string; section: SectionInfo }

export type Command = {
  id: string
  title: string
  /** A shortcut such as `mod+shift+n`; `mod` is ⌘ on macOS and Ctrl elsewhere. */
  keys?: string
  run(): void
}

export type UiApi = {
  app: AppConfig
  slot<S extends SlotName>(slot: S, component: ComponentType<SlotProps[S]>, options?: { order?: number }): void
  /** Draw calls to the tool `name` (of the extension's daemon half, or any other). */
  tool(name: string, component: ComponentType<ToolCallProps>): void
  entry(kind: string, component: ComponentType<EntryProps>): void
  /** Draw the settings section that names `ui` (its daemon half registers the section). */
  settings(ui: string, component: ComponentType<SettingsComponentProps>): void
  command(command: Command): void
}

export type UiExtension = {
  /** The same name as the daemon half, if there is one; the UI uses it to tell whether a machine has that half. */
  name: string
  setup(mu: UiApi): void
}

/** Identity for type inference: `export default defineUiExtension({ name, setup(mu) { … } })`. */
export const defineUiExtension = (extension: UiExtension) => extension

/** Everything the app's extensions registered, in the order they were listed. */
export type Registry = {
  app: AppConfig
  extensions: string[]
  slots: { [S in SlotName]: { component: ComponentType<SlotProps[S]>; order: number; extension: string }[] }
  tools: Map<string, ComponentType<ToolCallProps>>
  entries: Map<string, ComponentType<EntryProps>>
  settings: Map<string, ComponentType<SettingsComponentProps>>
  commands: Command[]
}

export function createRegistry(app: AppConfig, extensions: UiExtension[], core: (mu: UiApi) => void): Registry {
  const registry: Registry = {
    app, extensions: extensions.map((e) => e.name),
    slots: { 'sidebar': [], 'session.header': [], 'composer.above': [] },
    tools: new Map(), entries: new Map(), settings: new Map(), commands: [],
  }
  const api = (extension: string): UiApi => ({
    app,
    slot(slot, component, options) {
      const list = registry.slots[slot] as Registry['slots'][typeof slot]
      list.push({ component: component as never, order: options?.order ?? 100, extension })
      list.sort((a, b) => a.order - b.order)
    },
    tool: (name, component) => { registry.tools.set(name, component) },
    entry: (kind, component) => { registry.entries.set(kind, component) },
    settings: (ui, component) => { registry.settings.set(ui, component) },
    command: (command) => { registry.commands.push(command) },
  })
  core(api('core'))
  for (const extension of extensions) {
    if (!/^[a-z][a-z0-9-]*$/.test(extension.name)) throw new Error(`Extension name "${extension.name}" must be lowercase letters, digits and dashes`)
    extension.setup(api(extension.name))
  }
  return registry
}

const RegistryContext = createContext<Registry | undefined>(undefined)
export const RegistryProvider = ({ registry, children }: { registry: Registry; children: ReactNode }) =>
  <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>

export function useRegistry(): Registry {
  const registry = useContext(RegistryContext)
  if (!registry) throw new Error('mu hooks need mountApp')
  return registry
}

/** The app this UI belongs to. */
export const useApp = () => useRegistry().app

/** Draw every component in `slot`, with `props`. */
export function Slot<S extends SlotName>({ name, props }: { name: S; props: SlotProps[S] }) {
  const entries = useRegistry().slots[name] as { component: ComponentType<SlotProps[S]>; extension: string }[]
  return <>{entries.map(({ component: Component, extension }, index) => <Component key={`${extension}-${index}`} {...props} />)}</>
}
