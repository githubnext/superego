// terminal, daemon half: the PTY host (pty.ts). A terminal pane's shell starts when a window first attaches to it (its
// channel, `terminal.io`) and runs, attached or not, until the pane closes, its thread is archived or cleared, or the
// daemon stops. Its shell exiting cleanly closes the pane; otherwise a key starts it again. What its programs report
// (OSC 7501) is published per thread, and a terminal blocked on a question shows its thread as blocked too. A window
// may open one running a program instead of a shell (`terminal.run`: Claude Code, to sign in to it), the user's to use.
// What a program in it says would bring it back (OSC 7577) is kept, and run as the terminal next starts after the
// daemon did (a restart, a reboot): once, and forgotten as the pane closes, its thread is archived or its shell exits.
import { randomUUID } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { existsSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { arr, int, obj, str } from '@earendil-works/pi-schema'
import { defineAction, defineDaemonExtension } from '@superego/daemon'
import { RpcError } from '@superego/protocol'
import { asJob, firstProcess, type Shell } from './launch.ts'
import { spawnPty, Terminal, type Launch, type Spawn } from './pty.ts'
import { shown, TOKEN, type Resume } from './resume.ts'
import { about, IO, RESIZE, RUN, STATUS, TERMINAL, type TerminalStatuses } from './shared.ts'
import { ResumeStore } from './store.ts'

/**
 * What a shell inherits from the daemon, less what is only the daemon's own: Electron run as Node, the dev server, and
 * an OSC 7577 token from a terminal the daemon runs in (each terminal hands out its own).
 */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && key !== TOKEN && !/^ELECTRON_(RUN_AS_NODE|RENDERER_URL|NO_ATTACH_CONSOLE)$/.test(key)) out[key] = value
  return { ...out, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'superego', LANG: out.LANG || 'en_US.UTF-8' }
}

/** The user's shell, as a login shell (so it reads their profile even under a service or a bare ssh). */
export function userShell(): Shell {
  let file = process.env.SHELL
  if (!file) try { file = userInfo().shell ?? undefined } catch { /* no passwd entry */ }
  return { file: file || '/bin/sh', args: ['-l'] }
}

/** The daemon half; `spawn` and `shell` are for tests. */
export function terminalExtension({ spawn = spawnPty, shell = userShell }: { spawn?: Spawn; shell?: () => Shell } = {}) {
  return defineDaemonExtension({
    ...about,
    setup(superego) {
      const statuses = superego.scopedValue<TerminalStatuses>(STATUS, {})
      /** Every terminal, by `<thread>/<pane>`. */
      const terminals = new Map<string, Terminal>()
      const keyOf = (thread: string, pane: string) => `${thread}/${pane}`
      /**
       * What a window asked a pane to run instead of a shell (`terminal.run`), by `<thread>/<pane>`: for this daemon's
       * life only, so the pane, kept with its thread, opens a shell after a restart. Never from a pane's params, which
       * agents and outside callers set.
       */
      const programs = new Map<string, string[]>()
      /**
       * What brings each terminal's program back. Not as root: a program that kept the token with fewer rights would
       * gain root's.
       */
      const resumes = process.getuid?.() === 0 ? undefined : new ResumeStore(join(superego.dir, 'resume.json'))
      /** Where what a shell reads to resume a program is written, for it to remove; what's left from before goes. */
      const launches = join(superego.dir, 'launch')
      try { rmSync(launches, { recursive: true, force: true }) } catch (error) { console.error(`terminal: clearing ${launches}:`, error) }

      const forget = (key: string) => {
        try { resumes?.set(key, undefined) } catch (error) { console.error('terminal: forgetting how to resume a terminal:', error) }
      }
      // What's kept for panes that are gone (closed or archived while the daemon was down): forgotten.
      void (async () => {
        for (const key of resumes?.keys() ?? []) {
          const [thread, pane] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)]
          const info = await superego.threads.get(thread).catch((error: unknown) => {
            if (!(error instanceof RpcError && error.kind === 'not_found')) console.error('terminal: looking for a terminal kept to resume:', error)
            return undefined
          })
          if (!info || info.archived || !info.panes?.some((p) => p.id === pane && p.kind === TERMINAL)) forget(key)
        }
      })()

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
        const terminal: Terminal = new Terminal({
          spawn,
          launch: () => launch(key, info.cwd),
          onStatus: () => publish(thread),
          // `exit`: done with it, so its pane goes. Anything else stays to be read, and started again.
          onExit: (code) => {
            if (code === 0) void superego.dispatch('pane.close', { thread: thread, pane }).catch((error) => console.error('terminal: closing its pane:', error))
          },
          ...resumes && {
            onResume: (resume: Resume | undefined) => {
              try { resumes.set(key, resume) } catch (error) {
                console.error('terminal: keeping how to resume a terminal:', error)
                terminal.note(`Couldn't keep how to resume this: ${error instanceof Error ? error.message : String(error)}`)
              }
            },
          },
        })
        terminals.set(key, terminal)
        return terminal
      }

      /**
       * What a terminal starts: the user's login shell; the program a window asked for, in it (`exec`'d, so its first
       * process); or, the first time it starts after the daemon did, the program kept to resume, with the shell above it
       * as it was. Tried once: it's forgotten as it starts, and kept again as it reports again.
       */
      const launch = (key: string, folder: string): Launch => {
        const sh = shell()
        const cwd = existsSync(folder) ? folder : homedir()
        const env = shellEnv()
        const plain = { file: sh.file, args: sh.args, cwd, env }
        // A program runs in the user's login shell too, interactive (where mise and the like put it on the PATH).
        const program = programs.get(key)
        if (program) return { ...plain, args: firstProcess(sh, program) }
        let resume: Resume | undefined
        try { resume = resumes?.take(key) } catch (error) {
          console.error('terminal: taking what resumes a terminal:', error)
          return { ...plain, note: `Couldn't resume what ran here: ${error instanceof Error ? error.message : String(error)}` }
        }
        if (!resume) return plain
        const what = shown(resume.argv)
        if (resume.cwd !== undefined && !existsSync(resume.cwd)) return { ...plain, note: `Not resuming ${what}: ${resume.cwd} is gone` }
        const where = resume.cwd ?? (resume.dir !== undefined && existsSync(resume.dir) ? resume.dir : cwd)
        if (resume.first) return { ...plain, args: firstProcess(sh, resume.argv), cwd: where, note: `Resuming ${what}` }
        let job: ReturnType<typeof asJob>
        try { job = asJob(sh, resume.argv, { dir: join(launches, randomUUID()), env, parent: process.pid }) } catch (error) {
          console.error('terminal: resuming a terminal\'s program:', error)
          return { ...plain, note: `Couldn't resume ${what}: ${error instanceof Error ? error.message : String(error)}` }
        }
        if (!job) return { ...plain, note: `Not resuming ${what}: ${basename(sh.file)} can't run it as its job` }
        return { file: sh.file, args: job.args, cwd: where, env: job.env, note: `Resuming ${what}` }
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
      superego.action(defineAction({
        id: RUN, title: 'Run a program in a terminal',
        description: "Open a terminal pane beside a thread running a program (its whole path, then its arguments) in the user's login shell, for the user to use: its pane closes when it exits cleanly. A window's only.",
        params: obj({ thread: str(), command: arr(str({ minLength: 1 }), { minItems: 1 }) }),
        async run({ thread, command }) {
          const info = await superego.threads.get(thread)
          const n = Math.max(0, ...(info.panes ?? []).filter((p) => p.kind === TERMINAL).map((p) => Number((p.params as { n?: unknown } | undefined)?.n) || 1)) + 1
          const pane = await superego.dispatch('pane.open', { thread, kind: TERMINAL, title: basename(command[0]!), params: { n } }) as { id: string }
          programs.set(keyOf(thread, pane.id), command)
          return pane
        },
      }))
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
        paneClosed: (thread, pane) => {
          if (pane.kind !== TERMINAL) return
          kill(thread.id, pane.id)
          programs.delete(keyOf(thread.id, pane.id))
          forget(keyOf(thread.id, pane.id))
        },
        archived: (thread) => {
          kill(thread.id)
          for (const key of resumes?.keys() ?? []) if (key.startsWith(`${thread.id}/`)) forget(key)
        },
      })
      // Stopping: the shells end, and what would bring their programs back is kept, for the next start.
      return () => {
        for (const terminal of terminals.values()) terminal.kill()
        terminals.clear()
      }
    },
  })
}

export default terminalExtension()
