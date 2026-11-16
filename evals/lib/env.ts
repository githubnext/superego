// One run's world: a fresh home outside the repository, a daemon of its own on the installed build, and a sandbox that
// keeps the agent (and anything it runs) out of the real home, where Superego's source, the user's ~/.superego and
// their credentials live.
//
//   <run>/home                 HOME for the daemon and everything it runs
//   <run>/home/.superego       SUPEREGO_HOME: settings, threads, profiles, and the SDK's types (types/) as the app installs them
//   <run>/home/.agents         SUPEREGO_AGENTS: empty; the skills extension offers the app's own `superego` skill (out/skill)
//   <run>/home/code/myproject  the user's project: a small git repository, where a plain thread starts
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Install } from './install.ts'
import { openRpc, type Rpc } from './rpc.ts'

/** The spike's optional extensions: every other optional one was turned off (thread-reports too, wrongly). */
export const SPIKE_KEEP = new Set(['coding-tools', 'panes', 'agents-md', 'skills', 'ego'])
/**
 * Optional extensions a run turns off by default, from the app's defaults: suggestions makes a side call to the thread's
 * model after every answer, which no thread's cost counts (so no budget would), and has nothing to do with the work.
 */
export const OFF_BY_DEFAULT = new Set(['suggestions'])

export type WorldOptions = {
  model: string
  /** A finished run's world, its daemon started again (to check it again). */
  reuse?: boolean
  /** Which optional extensions are on: the spike's few, or the app's defaults (but `OFF_BY_DEFAULT`). */
  extensions?: 'spike' | 'defaults'
  /** Install the SDK's types in ~/.superego/types first, as the app does when it starts. */
  types?: boolean
}

export type World = {
  dir: string
  home: string
  dataDir: string
  project: string
  env: Record<string, string>
  rpc: Rpc
  daemon: ChildProcess
  /** Run the installed CLI as the user would, in the world (not sandboxed: the harness's own calls). */
  cli(args: string[], cwd?: string): string
  stop(): Promise<void>
}

/** A run's world, new; or with `reuse`, the one a finished run left, its daemon started again (to check it again). */
export async function makeWorld(dir: string, install: Install, { model, reuse = false, extensions: keep = 'defaults', types = true }: WorldOptions): Promise<World> {
  const home = join(dir, 'home')
  const dataDir = join(home, '.superego')
  const agents = join(home, '.agents')
  const project = join(home, 'code', 'myproject')
  for (const d of [dataDir, join(agents, 'skills'), project, join(dir, 'tmp')]) mkdirSync(d, { recursive: true })
  // The SDK's types, as the app installs them at start (main/start.ts): there before anything asks for them.
  if (types && !existsSync(join(dataDir, 'types', 'stamp.json'))) cpSync(join(install.out, 'types'), join(dataDir, 'types'), { recursive: true })
  if (!reuse) {
    writeFileSync(join(project, 'README.md'), '# myproject\n\nA small project of mine.\n')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore', env: { ...gitEnv, HOME: home } })
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-qm', 'First commit')
  }

  // Nothing of the real home: Superego's checkout, ~/.superego, ~/.agents, ssh keys and gh's token are all under it.
  const realHome = homedir()
  const sandbox = join(dir, 'sandbox.sb')
  writeFileSync(sandbox, `(version 1)\n(allow default)\n(deny file-read* file-write* (subpath "${realHome}"))\n`)

  const env: Record<string, string> = {
    HOME: home, SUPEREGO_HOME: dataDir, SUPEREGO_AGENTS: agents, TMPDIR: join(dir, 'tmp'),
    PATH: [join(install.dir, 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    LANG: 'en_US.UTF-8', USER: process.env.USER ?? 'user', SHELL: '/bin/zsh', TERM: 'xterm-256color',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...gitEnv,
  }
  // Provider keys, from the harness's environment (never printed, never written).
  const secrets: Record<string, string> = {}
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) if (process.env[key]) secrets[key] = process.env[key]!
  const log = openSync(join(dir, 'daemon.out'), 'a')
  const daemon = spawn('sandbox-exec', ['-f', sandbox, install.bin, 'daemon'], { cwd: home, env: { ...env, ...secrets }, stdio: ['ignore', log, log], detached: true })
  const socket = join(dataDir, 'superego.sock')
  for (let i = 0; i < 150 && !existsSync(socket); i++) await sleep(100)
  if (!existsSync(socket)) throw new Error(`daemon didn't start: ${readFileSync(join(dir, 'daemon.out'), 'utf8').slice(-1000)}`)
  const rpc = await openRpc(socket)

  // The machine as the run wants it: the model, and only the extensions it keeps.
  await rpc.call('settings.set', { key: 'agent.model', value: model })
  const snapshot = await rpc.call<{ sections: { id: string; settings: { key: string }[] }[] }>('settings.watch', {})
  const extensions = (snapshot as any).value.sections.find((s: any) => s.id === 'extensions')?.settings ?? []
  await rpc.call('unwatch', { sub: (snapshot as any).sub }).catch(() => {})
  for (const { key } of extensions) {
    const name = key.replace(/^extensions\./, '')
    if (keep === 'spike' ? !SPIKE_KEEP.has(name) : OFF_BY_DEFAULT.has(name)) await rpc.call('settings.set', { key, value: false })
  }

  return {
    dir, home, dataDir, project, env, rpc, daemon,
    cli: (args, cwd = home) => execFileSync(install.bin, args, { cwd, env, encoding: 'utf8', timeout: 120_000 }),
    async stop() {
      rpc.close()
      try { process.kill(-daemon.pid!, 'SIGTERM') } catch {}
      for (let i = 0; i < 50 && daemon.exitCode === null && daemon.signalCode === null; i++) await sleep(100)
      try { process.kill(-daemon.pid!, 'SIGKILL') } catch {}
      // Anything the agent left running (a dev server, a watcher) that names the run's folder.
      try { execFileSync('pkill', ['-f', dir]) } catch {}
      // …and anything working in it (an agent's own headless app, run from a folder of the run's).
      try {
        const cwds = execFileSync('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8' })
        let pid = ''
        for (const line of cwds.split('\n')) {
          if (line.startsWith('p')) pid = line.slice(1)
          else if (line.startsWith('n') && line.slice(1).replace(/^\/private/, '').startsWith(dir.replace(/^\/private/, ''))) try { process.kill(Number(pid), 'SIGKILL') } catch {}
        }
      } catch {}
    },
  }
}

const gitEnv = { GIT_AUTHOR_NAME: 'Eval User', GIT_AUTHOR_EMAIL: 'eval@example.com', GIT_COMMITTER_NAME: 'Eval User', GIT_COMMITTER_EMAIL: 'eval@example.com' }
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
