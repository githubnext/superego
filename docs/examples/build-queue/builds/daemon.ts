// builds, daemon half: a build queue per thread. The agent queues commands with `enqueue_build`; they run one at a
// time in the thread's folder. Each thread's queue is a scoped value, so a window showing a thread hears only its own,
// and its view (beside the thread, or a pane: ⌘⇧B) is drawn by the window from data, with a Cancel button on each.
import { spawn } from 'node:child_process'
import { defineAction, defineDaemonExtension, defineExtension, defineTool, obj, RpcError, str, type ViewContent } from 'superego'
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
    const running = new Map<string, AbortController>()
    const change = (thread: string, edit: (builds: Build[]) => Build[]) => {
      queue.update(thread, edit)
      view.set(thread, contentOf(thread, queue.get(thread)))
    }
    const setState = (thread: string, id: string, state: Build['state'], from?: Build['state']) =>
      change(thread, (builds) => builds.map((b) => b.id === id && (!from || b.state === from) ? { ...b, state } : b))

    /** Run the thread's next build, if none is running: in its folder, stopped when cancelled or torn down. */
    async function next(thread: string) {
      const builds = queue.get(thread)
      const build = builds.find((b) => b.state === 'queued')
      if (!build || builds.some((b) => b.state === 'running')) return
      const { cwd } = await superego.threads.get(thread)
      const stop = new AbortController()
      running.set(build.id, stop)
      setState(thread, build.id, 'running')
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn('sh', ['-c', build.command], { cwd, stdio: 'ignore', signal: AbortSignal.any([stop.signal, superego.signal]) })
        child.on('error', () => resolve(null))
        child.on('exit', (exit) => resolve(exit))
      })
      running.delete(build.id)
      if (superego.signal.aborted) return
      setState(thread, build.id, code === 0 ? 'done' : 'failed', 'running')
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
      run({ thread, id }) {
        const build = queue.get(thread).find((b) => b.id === id)
        if (!build || (build.state !== 'queued' && build.state !== 'running')) throw new RpcError('not_found', "That build isn't queued or running")
        setState(thread, id, 'cancelled')
        running.get(id)?.abort()
        return null
      },
    }))
    // ⌘⇧B: the queue as a pane beside the shown thread (its view fits a pane, so it's a pane kind of its id).
    superego.action(defineAction({
      id: 'builds.open', title: 'Show the build queue', runs: 'machine', expose: ['ui', 'cli'], keys: 'mod+shift+b', thread: true,
      params: obj({ id: str() }),
      run: ({ id }) => superego.dispatch('pane.open', { id, kind: VIEW }),
    }))

    superego.view(VIEW, {
      title: 'Builds', icon: 'terminal', context: 'thread', fits: ['aside', 'pane'], default: 'aside', value: VIEW,
      about: "the thread's build queue; no params",
    })
    // A thread put away takes its queue with it.
    superego.thread({
      archived(thread) {
        for (const build of queue.get(thread.id)) running.get(build.id)?.abort()
        queue.delete(thread.id)
        view.delete(thread.id)
      },
    })
  },
})
