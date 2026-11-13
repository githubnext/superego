// ego, daemon half: Ego, Superego's own agent. One hidden thread per machine, in Superego's data folder, made the first
// time it's asked for (`ego.ask`) and kept: never archived, cleared instead (`ego.clear`). Its agent is chosen for that
// thread alone (`agentFor`): what Superego is (tools.ts's prompt) and tools that read and set up, instead of the coding
// tools and the threads' own. Its thread is told apart by this extension's state with it (and the fact `ext.ego`), so
// an older Ego (the core's, marked `meta`) is the same thread here.
import { hostname } from 'node:os'
import { MachineStore } from '@superego/client'
import { defineDaemonExtension, type DaemonExtension } from '@superego/daemon'
import { agentName, defineAction, obj, opt, RpcError, str, type ThreadInfo } from '@superego/protocol'
import { about, ASK, CLEAR, THREAD } from './shared.ts'
import { metaExtension, metaPrompt, type MachineDirectory } from './tools.ts'

/** What Ego goes without, of what every thread has: it changes nothing itself, and starts threads its own way. */
const WITHOUT = ['coding-tools', 'thread-tools']

/**
 * Ego, given the machines this computer reaches (`machines.json` in the data folder, as the app keeps them) to set up.
 * Without them it has no superego_machines tool.
 */
export function ego({ machines }: { machines?: (dataDir: string) => MachineDirectory } = {}): DaemonExtension {
  return defineDaemonExtension({
    ...about,
    setup(superego) {
      const name = agentName(superego.app)
      const { dataDir, threads } = superego
      const tools = metaExtension({
        dir: dataDir,
        dispatch: (id, params) => superego.dispatch(id, params),
        actions: (exposure) => superego.actions(exposure),
        snapshot: () => superego.settings.snapshot(),
        ...(machines ? { machines: () => machines(dataDir) } : {}),
        // The threads it starts are ordinary ones, top-level in their projects.
        threads: { info: (id) => threads.get(id).catch(() => undefined), list: () => threads.list(), answer: (id) => threads.lastAnswer(id), start: (params) => threads.create(params) },
      })
      // Its tools are for its thread only.
      superego.agent(tools, { always: false })
      const state = superego.state<true>()
      superego.facts<true>(({ state }) => state === true ? true : undefined)
      superego.agentFor<true>(({ state }) => state === true ? {
        instructions: metaPrompt({ name: superego.app.name, ...(superego.app.agent ? { agent: superego.app.agent } : {}), id: superego.app.id, dataDir, agentsDir: superego.agentsDir, hostname: hostname() }),
        extensions: [tools], without: WITHOUT,
      } : undefined)

      // Its thread: found among the hidden ones (the newest in use, else the newest, brought back) once, from the start;
      // else made the first time it's asked for, however many ask.
      let id: string | undefined
      // Followed by the window (and older ones' `meta.watch`): its thread as it is now, after anything that changes it.
      const live = superego.value<ThreadInfo | null>(THREAD, null)
      const refresh = async () => { if (id) live.set(await threads.get(id)) }
      const isEgo = (thread: ThreadInfo) => thread.ext?.ego === true
      async function find(): Promise<string | undefined> {
        const all = [...await threads.list({ hidden: true }), ...await threads.list({ hidden: true, archived: true })].filter(isEgo)
        const found = all.find((t) => !t.archived) ?? all[0]
        if (!found) return undefined
        if (found.archived) await threads.unarchive(found.id)
        if (found.title !== name) await superego.dispatch('thread.rename', { id: found.id, title: name })
        return found.id
      }
      const found = find().then((at) => { id = at; return refresh() }).catch((error) => console.error('Ego: finding its thread failed:', error))
      let making: Promise<string> | undefined
      async function thread(): Promise<string> {
        await found
        if (id) return id
        making ??= threads.create({ cwd: dataDir, title: name, hidden: true }).then(async (made) => {
          await state.set(made.id, true)
          return id = made.id
        }).finally(() => { making = undefined })
        return making
      }

      const ours = (thread: ThreadInfo) => thread.id === id
      superego.thread({
        turnStart: (t) => ours(t) ? refresh() : undefined,
        turnEnd: (t) => ours(t) ? refresh() : undefined,
        // Kept, not archived: cleared instead.
        archiving(t) {
          if (isEgo(t)) throw new RpcError('invalid', `${name} isn't archived`, { hint: 'Clear it instead.' })
        },
      })
      superego.action(defineAction({
        id: ASK, title: `Ask ${name} about ${superego.app.name} and how it's set up`, runs: 'machine', expose: ['ui', 'cli'],
        params: obj({ prompt: opt(str()) }),
        async run({ prompt }) {
          const at = await thread()
          if (prompt?.trim()) await threads.submit(at, prompt, { whenBusy: 'followUp' })
          await refresh()
          return threads.get(at)
        },
      }))
      superego.action(defineAction({
        id: CLEAR, title: `Clear ${name}'s conversation`, runs: 'machine', expose: ['ui', 'cli'],
        params: obj({}),
        async run() {
          const at = await thread()
          await threads.clear(at)
          if ((await threads.get(at)).title !== name) await superego.dispatch('thread.rename', { id: at, title: name })
          await refresh()
          return threads.get(at)
        },
      }))
    },
  })
}

export default ego({ machines: (dataDir) => new MachineStore(dataDir) })
