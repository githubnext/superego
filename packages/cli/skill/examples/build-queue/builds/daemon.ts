// builds, daemon half: a build queue per thread. The agent queues commands with `enqueue_build`; they run one at a
// time in the thread's folder. Each thread's queue is a scoped value, so a window showing a thread hears only its own,
// and its view (beside the thread, or a pane: ⌘⇧B) is drawn by the window from data, with a Cancel button on each.
import { defineAction, defineDaemonExtension, defineExtension, defineTool, obj, RpcError, spawnGroup, str, type SpawnedGroup, type ViewContent } from 'superego'
import { about, QUEUE, VIEW, type Build } from './shared.ts'

const STATUS = { queued: 'idle', running: 'working', done: 'done', failed: 'error', cancelled: 'idle' } as const

/** What the view shows of a queue: what's waiting and running, then the last few finished. */
const contentOf = (thread: string, builds: Build[]): ViewContent => {
  const open = builds.filter((b) => b.state === 'queued' || b.state === 'running')
  return {
    note: `${open.length} queued or running`,
    items: [...open, ...builds.filter((b) => !open.includes(b)).slice(-5)].map((b) => ({
      id: b.id, title: b.command, subtitle: b.state, status: STATUS[b.state],
      ...(open.includes(b) ? { actions: [{ title: 'Cancel', action: 'builds.cancel', params: { thread, id: b.id } }] } : {}),
    })),
    empty: 'No builds queued.',
  }
}

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const queue = superego.scopedValue<Build[]>(QUEUE, [])
    const view = superego.scopedValue<ViewContent>(VIEW, contentOf('', []))
    /** The build running now, by its id: to stop it. */
    const running = new Map<string, SpawnedGroup>()
    const change = (thread: string, edit: (builds: Build[]) => Build[]) => {
      queue.update(thread, edit)
      view.set(thread, contentOf(thread, queue.get(thread)))
    }
    const setState = (thread: string, id: string, state: Build['state'], from?: Build['state']) =>
      change(thread, (builds) => builds.map((b) => b.id === id && (!from || b.state === from) ? { ...b, state } : b))

    const stateOf = (thread: string, id: string) => queue.get(thread).find((b) => b.id === id)?.state

    /**
     * Run the thread's next build, if none is running: in its folder, as a process group, so that cancelling it (or
     * tearing the extension down: `superego.signal`) stops everything its command started, not just its shell.
     */
    async function next(thread: string) {
      const builds = queue.get(thread)
      const build = builds.find((b) => b.state === 'queued')
      if (!build || builds.some((b) => b.state === 'running')) return
      // Claimed before anything is awaited, so a second call finds it running and leaves it be.
      setState(thread, build.id, 'running')
      const { cwd } = await superego.threads.get(thread)
      if (superego.signal.aborted) return
      // Cancelled meanwhile, or the thread put away: the next, if any.
      if (stateOf(thread, build.id) !== 'running') return void next(thread)
      const run = spawnGroup('sh', ['-c', build.command], { cwd, stdio: 'ignore', signal: superego.signal })
      running.set(build.id, run)
      // Once all of it is gone: only then is it cancelled, or done.
      const { code, stopped } = await run.exited
      running.delete(build.id)
      if (superego.signal.aborted || !stateOf(thread, build.id)) return
      setState(thread, build.id, stopped ? 'cancelled' : code === 0 ? 'done' : 'failed', 'running')
      void next(thread)
    }

    superego.agent(defineExtension({
      name: 'builds',
      tools: [defineTool({
        name: 'enqueue_build',
        description: "Queue a build or check (a shell command) in this thread's folder. Queued builds run one at a time; the user sees the queue and can cancel.",
        parameters: obj({ command: str({ minLength: 1 }) }),
        async execute({ command }, api) {
          const thread = superego.threads.of(api.conversationId)!
          change(thread, (builds) => [...builds, { id: api.callId, command, state: 'queued', at: Date.now() }])
          void next(thread)
          return { output: [{ type: 'text', text: `Queued: ${command}` }] }
        },
      })],
    }))

    superego.action(defineAction({
      id: 'builds.cancel', title: 'Cancel a build', runs: 'machine', expose: ['ui', 'cli'],
      params: obj({ thread: str(), id: str() }),
      // A running build is stopped, all of it, before this answers; it's "cancelled" once nothing of it runs.
      async run({ thread, id }) {
        const state = stateOf(thread, id)
        if (state !== 'queued' && state !== 'running') throw new RpcError('not_found', "That build isn't queued or running")
        await running.get(id)?.stop()
        setState(thread, id, 'cancelled', state)
        return null
      },
    }))
    // ⌘⇧B: the queue as a pane beside the shown thread (its view fits a pane, so it's a pane kind of its id).
    superego.action(defineAction({
      id: 'builds.open', title: 'Show the build queue', runs: 'machine', expose: ['ui', 'cli'], keys: 'mod+shift+b', thread: true,
      params: obj({ thread: str() }),
      run: ({ thread }) => superego.dispatch('pane.open', { thread, kind: VIEW }),
    }))

    superego.view(VIEW, {
      title: 'Builds', icon: 'terminal', context: 'thread', fits: ['beside', 'pane'], default: 'beside', value: VIEW,
      about: "the thread's build queue; no params",
    })
    // A thread put away takes its queue with it.
    superego.thread({
      async archived(thread) {
        const builds = queue.get(thread.id)
        queue.delete(thread.id)
        view.delete(thread.id)
        await Promise.all(builds.map((b) => running.get(b.id)?.stop()))
      },
    })
  },
})
