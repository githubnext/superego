// run, daemon half: each folder's dev command, from its `.superego/run.json` (or the `run.command` setting), defined as
// a process of Processes' that the folder owns (named `run`, `keep`: started again after a restart of the machine if
// it was running, `notify: 'failure'`: its death wakes the thread working there). Processes runs, shows, follows and
// stops it (archiving a folder's last thread stops it); Run keeps the definition in step with the file (looked at as a
// thread there starts or runs a turn, and as the file changes), ⌃R (`run.restart`), `run.stop` and `run.logs`, and tells
// the agent which process is the dev command.
import { watch, type FSWatcher } from 'node:fs'
import { defineExtension, section } from '@earendil-works/pi-durable'
import { obj, opt, str } from '@earendil-works/pi-schema'
import { defineAction, defineDaemonExtension } from '@superego/daemon'
import { RpcError, type ThreadInfo } from '@superego/protocol'
import { DEFAULT_GRACE, findConfig, howToAdd, type FoundConfig } from './config.ts'
import { about, NAME } from './shared.ts'

/** The Processes pane, where its output shows. */
const PANE = 'processes'
type Known = { id: string; name?: string; state: string }

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    superego.settings.register({
      id: 'run', title: 'Run', description: "Each folder's dev command, from its .superego/run.json.",
      settings: [{
        key: 'run.command', title: 'Default command', default: '', type: { type: 'string', placeholder: 'e.g. just run' },
        description: 'Run where a folder has no .superego/run.json. Empty: none.',
      }],
    })

    /** Its config: the folder's run.json, else the setting's command; none, undefined. Throws when the file is wrong. */
    async function configOf(folder: string): Promise<FoundConfig | undefined> {
      const found = await findConfig(folder)
      if (found) return found
      const command = String(superego.settings.get<string>('run.command') ?? '').trim()
      return command ? { command, grace: DEFAULT_GRACE, env: {}, path: 'settings: run.command', dir: folder } : undefined
    }

    const owner = (folder: string) => ({ folder })
    /** What each folder's definition was last put as, so an unchanged one isn't put again. */
    const defined = new Map<string, string>()
    /** The config file each folder's is from, watched for changes. */
    const watching = new Map<string, { path: string; watcher: FSWatcher }>()

    /** The folder's process, as Processes has it now. */
    const processOf = async (folder: string) => (await superego.call('processes.list', { folder }) as Known[]).find((p) => p.name === NAME)

    /** Put the folder's definition in step with its config: defined, changed, or gone (an idle one; a running one stays). */
    async function sync(folder: string): Promise<FoundConfig | undefined> {
      const config = await configOf(folder)
      follow(folder, config)
      if (!config) {
        if (defined.has(folder)) {
          defined.delete(folder)
          const known = await processOf(folder)
          if (known?.state === 'idle') await superego.dispatch('processes.remove', { id: known.id })
        }
        return undefined
      }
      const spec = {
        owner: owner(folder), name: NAME, command: config.command, cwd: config.dir, grace: config.grace, env: config.env,
        notify: 'failure', restart: 'never', keep: true, ...(config.ready ? { ready: config.ready } : {}),
      }
      const text = JSON.stringify(spec)
      if (defined.get(folder) !== text) {
        await superego.dispatch('processes.define', spec)
        defined.set(folder, text)
      }
      return config
    }
    const resync = (folder: string) => void sync(folder).catch((error: Error) => console.error(`run: ${folder}: ${error.message}`))

    /** Watch the file the config came from: an edit puts the definition in step. */
    function follow(folder: string, config: FoundConfig | undefined) {
      const path = config && !config.path.startsWith('settings:') ? config.path : undefined
      const now = watching.get(folder)
      if (now?.path === path) return
      now?.watcher.close()
      watching.delete(folder)
      if (!path || superego.signal.aborted) return
      try {
        const watcher = watch(path, { signal: superego.signal }, () => resync(folder))
        watcher.on('error', () => { watcher.close(); watching.delete(folder) })
        watching.set(folder, { path, watcher })
      } catch (error) {
        console.error(`run: can't watch ${path}: ${(error as Error).message}`)
      }
    }
    superego.settings.onChange(() => { for (const folder of defined.keys()) resync(folder) })

    // ── Actions: ⌃R, ⌘K, `superego do` ──────────────────────────────────────────────────────────────────────────────
    const target = obj({
      thread: opt(str({ description: 'a thread: its folder' })),
      folder: opt(str({ description: 'a folder, instead of a thread' })),
    })
    async function folderOf({ thread, folder }: { thread?: string; folder?: string }) {
      if (folder) return folder
      if (!thread) throw new RpcError('invalid_params', 'Say which thread (--thread) or folder (--folder).')
      return (await superego.threads.get(thread)).cwd
    }
    /** The folder's definition, put now (its config read again): refused, saying how to add one, when there's none. */
    async function ensure(folder: string) {
      const config = await sync(folder).catch((error: Error) => { throw new RpcError('invalid_params', error.message) })
      if (!config) throw new RpcError('not_found', howToAdd(folder), { hint: 'Add .superego/run.json, then restart.' })
    }

    superego.action(defineAction({
      id: 'run.restart', title: 'Restart the dev command', description: "Start this folder's dev command, or restart it if it runs.",
      expose: ['ui', 'cli'], thread: true, params: target, keys: 'ctrl+r',
      run: async (params) => {
        const folder = await folderOf(params)
        await ensure(folder)
        return superego.dispatch('processes.restart', { owner: owner(folder), name: NAME })
      },
    }))
    superego.action(defineAction({
      id: 'run.stop', title: 'Stop the dev command', description: "Stop this folder's dev command.",
      expose: ['ui', 'cli'], thread: true, params: target,
      run: async (params) => superego.dispatch('processes.stop', { owner: owner(await folderOf(params)), name: NAME }),
    }))
    superego.action(defineAction({
      id: 'run.logs', title: 'Show the dev command’s output', description: "Open the folder's dev command beside the thread, in Processes.",
      expose: ['ui', 'cli'], thread: true, params: obj({ thread: opt(str()) }),
      run: async ({ thread }) => {
        if (!thread) throw new RpcError('invalid_params', 'Say which thread (--thread).')
        const folder = await folderOf({ thread })
        await ensure(folder)
        const known = await processOf(folder)
        return superego.dispatch('pane.open', { thread, kind: PANE, ...(known ? { params: { id: known.id } } : {}) })
      },
    }))

    // ── The agent: which process is the dev command ─────────────────────────────────────────────────────────────
    superego.agent(defineExtension({
      name: 'run',
      sections: [section('run', async ({ conversationId }) => {
        const id = superego.threads.of(conversationId as never)
        if (!id) return undefined
        const { cwd } = await superego.threads.get(id)
        if (!defined.has(cwd)) return undefined
        return "This folder's dev command is the process named `run` (from .superego/run.json; the user starts it with ⌃R). "
          + "Use process_logs and process_restart on it (id `run`); don't start the server yourself."
      })],
    }))

    // ── Every folder in use, at setup and as threads start and run ──────────────────────────────────────────────
    const folders = (threads: ThreadInfo[]) => new Set(threads.filter((t) => !t.archived).map((t) => t.cwd))
    void superego.threads.list().then((threads) => { for (const folder of folders(threads)) resync(folder) },
      (error: Error) => console.error(`run: couldn't list threads: ${error.message}`))
    superego.thread({
      started(thread) { resync(thread.cwd) },
      turnStart(thread) { resync(thread.cwd) },
    })

    return () => { for (const { watcher } of watching.values()) watcher.close() }
  },
})
