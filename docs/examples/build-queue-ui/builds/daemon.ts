// builds, daemon half: a build queue per thread. The agent queues commands with `enqueue_build`; they run one at a
// time in the thread's folder. Each thread's queue is a scoped value, so a window showing a thread hears only its own;
// the UI half (ui.tsx) draws it, and cancels a build with `builds.cancel`.
import { spawn } from 'node:child_process'
import { defineAction, defineDaemonExtension, defineExtension, defineTool, obj, RpcError, str } from 'superego'
import { about, QUEUE, type Build } from './shared.ts'

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const queue = superego.scopedValue<Build[]>(QUEUE, [])
    /** The build running now, by its id: to stop it. */
    const running = new Map<string, AbortController>()
    const change = (thread: string, edit: (builds: Build[]) => Build[]) => queue.update(thread, edit)
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
    // A thread put away takes its queue with it.
    superego.thread({
      archived(thread) {
        for (const build of queue.get(thread.id)) running.get(build.id)?.abort()
        queue.delete(thread.id)
      },
    })
  },
})
