// terminal, daemon half: the PTY host (pty.ts). A terminal pane's shell starts when a window first attaches to it (its
// channel, `terminal.io`) and runs, attached or not, until the pane closes, its thread is archived or cleared, or the
// daemon stops. Its shell exiting cleanly closes the pane; otherwise a key starts it again. What its programs report
// (OSC 7501) is published per thread, and a terminal blocked on a question shows its thread as blocked too.
import { homedir, userInfo } from 'node:os'
import { existsSync } from 'node:fs'
import { int, obj, str } from '@earendil-works/pi-schema'
import { defineDaemonExtension } from '@superego/daemon'
import { RpcError } from '@superego/protocol'
import { spawnPty, Terminal, type Spawn } from './pty.ts'
import { about, IO, RESIZE, STATUS, TERMINAL, type TerminalStatuses } from './shared.ts'

/** What a shell inherits from the daemon, less what is only the daemon's own: Electron run as Node, the dev server. */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !/^ELECTRON_(RUN_AS_NODE|RENDERER_URL|NO_ATTACH_CONSOLE)$/.test(key)) out[key] = value
  return { ...out, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'superego', LANG: out.LANG || 'en_US.UTF-8' }
}

/** The user's shell, as a login shell (so it reads their profile even under a service or a bare ssh). */
export function userShell(): { file: string; args: string[] } {
  let file = process.env.SHELL
  if (!file) try { file = userInfo().shell ?? undefined } catch { /* no passwd entry */ }
  return { file: file || '/bin/sh', args: ['-l'] }
}

/** The daemon half; `spawn` and `shell` are for tests. */
export function terminalExtension({ spawn = spawnPty, shell = userShell }: { spawn?: Spawn; shell?: () => { file: string; args: string[] } } = {}) {
  return defineDaemonExtension({
    ...about,
    setup(superego) {
      superego.pane(TERMINAL, '{}: a shell in the working folder, for the user (another one beside it: { n: 2 })')
      const statuses = superego.scopedValue<TerminalStatuses>(STATUS, {})
      /** Every terminal, by `<thread>/<pane>`. */
      const terminals = new Map<string, Terminal>()
      const keyOf = (thread: string, pane: string) => `${thread}/${pane}`

      const publish = (thread: string) => {
        const now: TerminalStatuses = {}
        for (const [key, terminal] of terminals) {
          const status = key.startsWith(`${thread}/`) ? terminal.status.status() : undefined
          if (status) now[key.slice(thread.length + 1)] = status
        }
        if (Object.keys(now).length) statuses.set(thread, now)
        else statuses.delete(thread)
        superego.invalidate()
      }
      const kill = (thread: string, pane?: string) => {
        for (const [key, terminal] of terminals) {
          if (pane ? key !== keyOf(thread, pane) : !key.startsWith(`${thread}/`)) continue
          terminal.kill()
          terminals.delete(key)
        }
        publish(thread)
      }

      /** The terminal of a thread's pane, started or not: the pane must be there, and be a terminal. */
      const terminalOf = async (thread: string, pane: string) => {
        const key = keyOf(thread, pane)
        const known = terminals.get(key)
        if (known) return known
        const info = await superego.threads.get(thread)
        if (info.archived) throw new RpcError('archived', 'This thread is archived')
        if (!info.panes?.some((p) => p.id === pane && p.kind === TERMINAL)) throw new RpcError('not_found', `No terminal pane ${pane} beside this thread`)
        // Made while that was asked: the first one made wins.
        if (terminals.has(key)) return terminals.get(key)!
        const { file, args } = shell()
        const terminal = new Terminal({
          file, args, spawn,
          cwd: () => existsSync(info.cwd) ? info.cwd : homedir(),
          env: () => shellEnv(),
          onStatus: () => publish(thread),
          // `exit`: done with it, so its pane goes. Anything else stays to be read, and started again.
          onExit: (code) => {
            if (code === 0) void superego.dispatch('pane.close', { id: thread, pane }).catch((error) => console.error('terminal: closing its pane:', error))
          },
        })
        terminals.set(key, terminal)
        return terminal
      }

      superego.channel(IO, async (channel, params: { thread?: unknown; pane?: unknown; cols?: unknown; rows?: unknown }) => {
        if (typeof params.thread !== 'string' || typeof params.pane !== 'string') throw new RpcError('invalid', 'A terminal is opened by its thread and pane')
        const terminal = await terminalOf(params.thread, params.pane)
        // Started at the size asked for; attached to at the size it had (what's replayed was printed at it), then that.
        if (!terminal.running && typeof params.cols === 'number' && typeof params.rows === 'number') terminal.resize(params.cols, params.rows)
        const detach = terminal.attach(channel)
        if (typeof params.cols === 'number' && typeof params.rows === 'number') terminal.resize(params.cols, params.rows)
        channel.onData((bytes) => terminal.input(bytes))
        channel.ended.then(() => { detach(); channel.end() }, detach)
      })
      superego.method(RESIZE, async ({ thread, pane, cols, rows }) => {
        terminals.get(keyOf(thread, pane))?.resize(cols, rows)
        return null
      }, { params: obj({ thread: str(), pane: str(), cols: int({ minimum: 1 }), rows: int({ minimum: 1 }) }) })

      // A terminal blocked on something (a permission, a question) is its thread's to answer too.
      superego.status((thread) => {
        const blocked = Object.values(statuses.get(thread)).find((s) => s.state === 'blocked')
        return blocked ? { kind: blocked.kind ?? 'question', ...(blocked.msg ? { msg: blocked.msg } : {}) } : undefined
      })
      superego.thread({
        paneClosed: (thread, pane) => { if (pane.kind === TERMINAL) kill(thread.id, pane.id) },
        archived: (thread) => { kill(thread.id) },
      })
      return () => {
        for (const terminal of terminals.values()) terminal.kill()
        terminals.clear()
      }
    },
  })
}

export default terminalExtension()
