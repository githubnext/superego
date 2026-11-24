// Data views: views a machine's daemon halves declare as data (`superego.view` there), drawn here with the core's
// own components. What one shows is blocks (`Block[]`, the schema agents draw with), from a live value or a method of
// the extension's; its buttons run the extension's own actions, there, as the window may. Nothing of the extension's
// runs in the window, so a remote machine's, or a project profile's, needs no consent to run code here; its buttons
// still have that machine's authority. What a machine sends is checked as it lands (declarations: data-view-check.ts;
// blocks: `<Blocks>`, which draws blocks that fail as their first error), and a view that fails to draw says so in its
// place, not in the shell's. The registry makes each a view (see `setDataViews`), and the layout places it as any other.
import type { ComponentType, ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import type { Block, DataIcon, DataViewInfo, Json, ThreadInfo } from '@superego/protocol'
import {
  ArchiveIcon, BellIcon, ChatsIcon, CheckIcon, ColumnsIcon, FileTextIcon, FolderSimpleIcon, GearSixIcon, GlobeIcon, ListIcon, Panel,
  SparkleIcon, TableIcon, TerminalIcon, WrenchIcon,
} from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { Blocks, type BlocksHost } from './blocks/blocks.tsx'
import { call, useMethod, useValue } from './client.ts'
import { useRegistry, type Registry } from './registry.tsx'
import type { Place } from '../shared/layout.ts'
import { useAllThreads, useMachines } from './state.tsx'

type IconComponent = ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
const ICONS: Record<DataIcon, IconComponent> = {
  list: ListIcon, table: TableIcon, folder: FolderSimpleIcon, file: FileTextIcon, bell: BellIcon, check: CheckIcon, gear: GearSixIcon,
  globe: GlobeIcon, sparkle: SparkleIcon, terminal: TerminalIcon, wrench: WrenchIcon, chats: ChatsIcon, archive: ArchiveIcon, columns: ColumnsIcon,
}
/** The glyph a data view names, if it names one there is. */
export const dataIcon = (name: DataIcon | undefined): IconComponent | undefined => name ? ICONS[name] : undefined

/** The declaration of `id` on `machine` that `thread` sees: its profile's own first, else the machine's. */
function declaredOn(registry: Registry, machine: string, id: string, thread?: ThreadInfo): DataViewInfo | undefined {
  const all = (registry.dataViews[machine] ?? []).filter((v) => v.id === id)
  const dir = thread?.profile?.dir
  return all.find((v) => dir && v.profiles?.includes(dir)) ?? all.find((v) => !v.profiles)
}

/**
 * A data view in a place: a thread's, from its machine; the window's, from every machine that has it (each under its
 * name, when there are several). Drawn as views are, apart (`Contained`, where it's placed).
 */
export function DataViewBody({ id, place, machine, thread }: { id: string; place: Place; machine?: MachineEntry; thread?: ThreadInfo }) {
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const machines = useMachines()
  const view = registry.views.find((v) => v.id === id && v.owner.data)
  // In the sidebar, a panel under its title, as the sidebar's own are; beside the thread, a heading; a pane's tab says it already.
  const framed = (title: string, children: ReactNode) => place === 'sidebar'
    ? <Panel title={title} className="data-view data-view--sidebar">{children}</Panel>
    : <div className={`data-view data-view--${place}`}>{place === 'beside' && <h5 className="data-view__heading">{title}</h5>}{children}</div>
  if (machine && thread) {
    const info = declaredOn(registry, machine.id, id, thread)
    return info ? framed(info.title, <Source info={info} machine={machine} thread={thread} />) : null
  }
  // A machine away says so, under its name; one switched off isn't there.
  const on = machines.filter((m) => m.state !== 'disabled' && declaredOn(registry, m.id, id))
  return framed(view?.title ?? id, on.map((m) => (
    <section key={m.id} className="data-view__machine">
      {on.length > 1 && <h6 className="data-view__machine-name">{m.label}</h6>}
      <Source info={declaredOn(registry, m.id, id)!} machine={m} />
    </section>
  )))
}

function Source({ info, machine, thread }: { info: DataViewInfo; machine: MachineEntry; thread?: ThreadInfo }) {
  if (machine.state === 'disconnected') return <div className="data-view__empty">{machine.label} is offline.</div>
  return info.value
    ? <FromValue info={info} value={info.value} machine={machine} thread={thread} />
    : <FromMethod info={info} method={info.method!} machine={machine} thread={thread} />
}

/** Fed by a live value: a thread view's by the thread's scope (a scoped value's, or a plain one's entry by its id). */
function FromValue({ info, value, machine, thread }: { info: DataViewInfo; value: string; machine: MachineEntry; thread?: ThreadInfo }) {
  // Undefined until it's heard; null when it's never been set, and a thread view's with nothing for this thread: none.
  // A thread view with no thread (a sidebar with none shown) has nothing to show.
  const scope = info.context === 'thread' ? thread?.id ?? '' : undefined
  const live = useValue<Json>(machine, value, scope === undefined ? {} : { scope })
  return <ViewBlocks blocks={scope === '' && live !== undefined ? null : live} info={info} machine={machine} thread={thread} />
}

/** Fed by a method: read again as the thread moves on (a window view: any thread on the machine), and after a button ran. */
function FromMethod({ info, method, machine, thread }: { info: DataViewInfo; method: string; machine: MachineEntry; thread?: ThreadInfo }) {
  const connected = machine.state === 'connected'
  const threads = useAllThreads()[machine.id]
  const moved = info.context === 'thread' ? `${thread?.id}:${thread?.activeAt}:${thread?.status.state}` : (threads ?? []).map((t) => `${t.id}:${t.activeAt}:${t.status.state}`).join()
  const { data, error, refetch } = useMethod<Json>(machine.id, method, info.context === 'thread' ? { thread: thread?.id } : {}, { enabled: connected, refresh: moved })
  // Answered, it's read: null (or nothing) is none.
  return <ViewBlocks blocks={data === undefined ? undefined : data ?? null} error={error?.message} info={info} machine={machine} thread={thread} ran={refetch} />
}

/**
 * A view's blocks, drawn for its extension: its buttons run that extension's actions (`runViewAction`), and the method
 * is read again after one ran. `blocks` undefined: not read yet; null or none: nothing to show. What isn't blocks the
 * extension may draw is refused whole, in place (`<Blocks>`).
 */
export function ViewBlocks({ blocks, error, info, machine, thread, ran }: {
  blocks: unknown; error?: string | undefined; info: Pick<DataViewInfo, 'extension' | 'context'>; machine: MachineEntry; thread?: ThreadInfo | undefined; ran?: () => void
}) {
  const registry = useRegistry()
  const { extension } = info
  const host: BlocksHost = {
    by: 'extension', extension,
    run: async (action, params) => {
      const result = await runViewAction(registry, machine.id, extension, action, params)
      ran?.()
      return result
    },
  }
  const none = blocks === null || (Array.isArray(blocks) && !blocks.length)
  return (
    <>
      {error && <div className="data-view__error">{error}</div>}
      {blocks === undefined ? !error && <div className="data-view__empty">Loading…</div>
        : none ? <div className="data-view__empty">Nothing here yet.</div>
        // A window view has no thread, even drawn beside one: no panes to open, no folder to read images from.
        : <Blocks machine={machine} thread={info.context === 'thread' ? thread : undefined} blocks={blocks as Block[]} host={host} />}
    </>
  )
}

/**
 * A button of `extension`'s data view on `machine`, pressed: the extension's action it names, run there (never one of
 * the window's, another extension's, or another machine's), as the window may run it (exposed to the UI), logged as
 * this window's are.
 */
export function runViewAction(registry: Pick<Registry, 'router'>, machine: string, extension: string, action: string, params: Json = {}): Promise<unknown> {
  if (!action.startsWith(`${extension}.`)) return Promise.reject(new Error(`${action} isn’t one of ${extension}’s actions`))
  return registry.router.router.track(action, params, `view → ${machine}`, () => call(machine, 'action.run', { id: action, params, exposure: 'ui' }), { secret: registry.router.secretOf(machine, action) })
}
