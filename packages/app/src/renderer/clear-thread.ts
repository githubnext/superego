// Starting a thread over (`/clear` in its composer, or Clear thread in ⌘K): a new thread like it takes its place, and
// it's archived. Started first, so a thread that can't start (its profile gone, no model) leaves this one as it was;
// then shown where this one was (selected, or docked to a space), pinned where it was pinned; then this one archived.
import { arr, obj, opt, str, unknown, type ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'
import { APP } from '../shared/app-settings.ts'
import { defineWindowAction, type WindowContext } from './actions.tsx'
import { has } from './client.ts'
import { startFrom } from './NewThread.tsx'
import { isPinned, PINS, pinsOf } from './pins.ts'
import type { Registry } from './registry.tsx'
import { takes } from './slash-commands.ts'
import type { NewThreadStart } from './state.tsx'

/** Whether `path` is `root` or in it. */
function within(path: string, root: string) {
  const base = root.replace(/[\\/]+$/, '')
  return path === root || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
}

/**
 * What a thread started in place of `thread` takes after it: as ⌘N's (its project, profile, model, thinking, what
 * extensions' fields take from it, where `machine` has them), in its own folder when that's in its project (a
 * subfolder of the checkout); a thread in a worktree starts from the project's checkout, to get a worktree of its own.
 */
export function startLike(registry: Registry, machine: MachineEntry, thread: ThreadInfo): NewThreadStart {
  const { options, ...like } = startFrom(registry, machine.id, thread)
  const kept = Object.fromEntries(Object.entries(options ?? {}).filter(([name]) => has(machine, `ext:${name}`)))
  return { ...like, ...within(thread.cwd, thread.project.root) ? { cwd: thread.cwd } : {}, ...Object.keys(kept).length ? { options: kept } : {} }
}

/** A failure after the new thread started: it stays, with what it was sent. */
export class ArchiveFailed extends Error {
  readonly started: ThreadInfo
  constructor(started: ThreadInfo, cause: unknown) {
    super(`Started a new thread, but couldn't archive this one: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.started = started
  }
}

/** Start `at` over: a new thread like it, sent `prompt` and `attachments` if given, in its place; it archived. */
export async function clearThread(registry: Registry, c: WindowContext, at: { machine: string; thread: string }, first: { prompt?: string; attachments?: unknown[] } = {}): Promise<ThreadInfo> {
  const thread = c.threadOf(at)
  if (!thread) throw new Error(`No thread ${at.thread} on ${at.machine} here`)
  if (!takes('clear', thread)) throw new Error(thread.archived ? `${thread.title} is archived` : `${thread.title} isn't one the sidebar lists: it can't be started over here`)
  const machine = c.machines.find((m) => m.id === at.machine)
  if (!machine) throw new Error(`${at.machine} isn't one of this window's machines`)
  const { machine: _machine, ...start } = startLike(registry, machine, thread)
  const created = await c.dispatch('thread.start', {
    ...start, ...first.prompt ? { prompt: first.prompt } : {}, ...first.attachments?.length ? { attachments: first.attachments } : {},
  }, { machine: at.machine, source: 'clear' }) as ThreadInfo
  const next = { machine: at.machine, thread: created.id }
  // Where it was: docked to the space open, it stays there; otherwise it's shown. Docked to other spaces, there too.
  const docked = c.docked?.machine === at.machine && c.docked.thread === at.thread
  c.redock(at, next)
  if (!(c.space && docked)) c.select(next)
  try {
    const pins = pinsOf(c.appSetting(PINS))
    if (isPinned(pins, at)) {
      await c.dispatch('app.settings.set', { key: PINS, value: pins.map((pin) => pin.machine === at.machine && pin.thread === at.thread ? next : pin) }, { machine: APP, source: 'clear' })
    }
    await c.dispatch('thread.archive', { thread: at.thread }, { machine: at.machine, source: 'clear' })
  } catch (error) {
    throw new ArchiveFailed(created, error)
  }
  return created
}

/** Clear thread, for ⌘K and the composer's `/clear`: the selected thread, or `thread` on `machine`. */
export const clearThreadAction = (registry: () => Registry) => defineWindowAction({
  id: 'thread.clear', title: 'Clear thread',
  description: 'Start over in a new thread like this one (its folder, profile, model and thinking), and archive this one; `prompt` and `attachments` go to the new one',
  params: obj({ machine: opt(str()), thread: opt(str()), prompt: opt(str()), attachments: opt(arr(unknown())) }),
  thread: true,
  when: (c) => Boolean(c.selection && !c.space && takes('clear', c.threadOf(c.selection))),
  run: ({ machine, thread, prompt, attachments }, c) => {
    const at = machine && thread ? { machine, thread } : c.selection
    if (!at) throw new Error('No thread to clear')
    return clearThread(registry(), c, at, { ...prompt ? { prompt } : {}, ...attachments ? { attachments } : {} })
  },
})
