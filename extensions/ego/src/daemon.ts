// ego, daemon half: Ego, Superego's own agent. One hidden thread per machine, in Superego's data folder, made the first
// time it's asked for (`ego.ask`) and kept: never archived, cleared instead (`ego.clear`). Its agent is chosen for that
// thread alone (`agentFor`): what Superego is (tools.ts's prompt) and tools that read and set up, instead of the coding
// tools and the threads' own. Its thread is the hidden one it owns (`owner`), with this extension's state set (and the
// fact `facts.ego` for windows).
//
// Outside agents (`superego mcp`) ask it too (`ego.ask`, or `thread.send` to its thread), but start threads through it
// no more than they may themselves: each message one sends goes with a block saying so (`OUTSIDE`, for the model and the
// window), and while `outside.startThreads` is off, thread_start refuses when the message its call answers came from one
// (`threads.answering`). A turn the user asks for in the window, in the same conversation, still starts threads. Nor do they set up MCP servers through it:
// superego_mcp_servers refuses whenever the message it's answering came from one, whatever the setting.
import { hostname } from 'node:os'
import { defineDaemonExtension, OUTSIDE_THREADS, type DaemonExtension } from '@superego/daemon'
import { agentName, defineAction, obj, opt, RpcError, str, type ThreadInfo } from '@superego/protocol'
import { about, ASK, CLEAR, OUTSIDE } from './shared.ts'
import { egoPrompt, egoTools } from './tools.ts'

/** What Ego goes without, of what every thread has: it changes nothing itself, and starts threads its own way. */
const WITHOUT = ['coding-tools', 'thread-tools']

/** Ego. */
export function ego(): DaemonExtension {
  return defineDaemonExtension({
    ...about,
    setup(superego) {
      const name = agentName(superego.app)
      const { dataDir, threads } = superego
      const isEgo = (thread: ThreadInfo) => thread.owner === about.name
      /** Whether tool call `callId` answers an outside agent's message: one not to be found counts as one. */
      const fromOutside = async (conversation: number, callId: string) => {
        const origin = await threads.answering(conversation, callId)
        return !origin || origin.exposure === 'outside'
      }
      const tools = egoTools({
        dir: dataDir,
        dispatch: (id, params) => superego.dispatch(id, params),
        actions: (exposure) => superego.actions(exposure),
        snapshot: () => superego.settings.snapshot(),
        machines: superego.machines,
        // The threads it starts are ordinary ones, top-level in their projects.
        threads: { info: (id) => threads.get(id).catch(() => undefined), list: () => threads.list(), answer: (id) => threads.lastAnswer(id), start: (params) => threads.start(params) },
        // Read as it's called: the setting may have changed since the message came.
        async refuseStart(conversation, callId) {
          if (superego.settings.get(OUTSIDE_THREADS) === true) return undefined
          if (!await fromOutside(conversation, callId)) return undefined
          return "An outside agent asked for this, and outside agents can't start threads on this machine. The user can allow it in Settings → Outside agents → Can start threads."
        },
        // MCP servers run commands and reach the user's accounts: never set up for an outside agent, whatever it may do.
        async refuseServers(conversation, callId) {
          if (!await fromOutside(conversation, callId)) return undefined
          return 'An outside agent asked for this. Outside agents never set up MCP servers: the user does, in Settings → MCP servers (or asks here in the window).'
        },
      })
      // An outside agent's message to Ego says so.
      superego.beforeSend(({ thread, exposure, content }) => exposure === 'outside' && isEgo(thread) ? [{ type: 'text', text: OUTSIDE }, ...content] : undefined)
      // Its tools are for its thread only.
      superego.agent(tools, { always: false })
      const state = superego.state<true>()
      superego.facts<true>(({ state }) => state === true ? true : undefined)
      superego.agentFor<true>(({ state }) => state === true ? {
        instructions: egoPrompt({ name: superego.app.name, ...(superego.app.agent ? { agent: superego.app.agent } : {}), id: superego.app.id, dataDir, agentsDir: superego.agentsDir, hostname: hostname() }),
        extensions: [tools], without: WITHOUT,
      } : undefined)

      // Its thread: among the hidden ones it owns (`owner`, which, unlike its facts, is there while it's off), the one
      // last in use, brought back if archived; else made the first time it's asked for, however many ask. Looked for
      // from the start, and again whenever it's asked for and none was found yet (switched on later, say).
      let id: string | undefined
      async function find(): Promise<string | undefined> {
        const all = [...await threads.list({ hidden: true }), ...await threads.list({ hidden: true, archived: true })].filter(isEgo)
        // Newest first as listed; the one used last wins, so a second Ego made while the first was missed is no
        // surprise to whoever's been talking to it since.
        const found = all.filter((t) => !t.archived).sort((a, b) => b.activeAt - a.activeAt)[0] ?? all[0]
        if (!found) return undefined
        if (found.archived) await threads.unarchive(found.id)
        if (await state.get(found.id) !== true) await state.set(found.id, true)
        if (found.title !== name) await superego.dispatch('thread.rename', { thread: found.id, title: name })
        return found.id
      }
      let looking: Promise<string | undefined> | undefined
      const look = () => looking ??= find().then((at) => id = at).finally(() => { looking = undefined })
      look().catch((error) => console.error('Ego: finding its thread failed:', error))
      let making: Promise<string> | undefined
      async function thread(): Promise<string> {
        if (id) return id
        if (await look()) return id!
        making ??= threads.start({ cwd: dataDir, title: name, hidden: true }).then(async (made) => {
          await state.set(made.id, true)
          return id = made.id
        }).finally(() => { making = undefined })
        return making
      }

      superego.thread({
        // Kept, not archived: cleared instead.
        archiving(t) {
          if (isEgo(t)) throw new RpcError('invalid', `${name} isn't archived`, { hint: 'Clear it instead.' })
        },
      })
      superego.action(defineAction({
        id: ASK, title: `Ask ${name} about ${superego.app.name} and how it's set up`, runs: 'machine', expose: ['ui', 'cli', 'outside'],
        description: `Send \`prompt\` to ${name}, this machine's own agent, in its one thread (made the first time). That thread comes back; read its answer as any thread's.`,
        params: obj({ prompt: opt(str()) }),
        async run({ prompt }, { exposure }) {
          const at = await thread()
          if (prompt?.trim()) await threads.send(at, prompt, { whenBusy: 'followUp', ...(exposure ? { exposure } : {}) })
          return threads.get(at)
        },
      }))
      superego.action(defineAction({
        id: CLEAR, title: `Clear ${name}'s thread`, runs: 'machine', expose: ['ui', 'cli'],
        params: obj({}),
        async run() {
          const at = await thread()
          await threads.clear(at)
          if ((await threads.get(at)).title !== name) await superego.dispatch('thread.rename', { thread: at, title: name })
          return threads.get(at)
        },
      }))
    },
  })
}

export default ego()
