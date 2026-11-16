// The app's command line on the PATH, from Settings → Command line: `~/.local/bin/<id>`. A packaged app writes a script
// that runs the CLI built into it (out/main/cli.js) on its own Electron as Node; run from a checkout, it links the app's
// bin, as `pnpm link:cli` does.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '@superego/protocol'
import type { CommandLineInfo } from '../shared/bridge.ts'

export type CommandLineOptions = {
  app: AppConfig
  /** The app's directory (Electron's `app.getAppPath()`): the checkout's app, or the bundle's app.asar. */
  appPath: string
  packaged: boolean
  /** The executable a script runs the CLI on: the packaged app's own. */
  executable: string
  home?: string
  /** The user's login shell, asked what it would run; unset, nobody is asked. */
  shell?: string
}

export function commandLine({ app, appPath, packaged, executable, home = homedir(), shell }: CommandLineOptions) {
  const path = join(home, '.local', 'bin', app.id)

  /** What belongs at `path`: a script's text, or a link's target. */
  function wanted(): { kind: 'script'; script: string } | { kind: 'link'; target: string } | null {
    if (packaged) {
      const cli = join(appPath, 'out', 'main', 'cli.js')
      return existsSync(cli) ? { kind: 'script', script: script(app, executable, cli) } : null
    }
    let pkg: { bin?: string | Record<string, string> }
    try { pkg = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as typeof pkg } catch { return null }
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[app.id]
    return bin ? { kind: 'link', target: join(appPath, bin) } : null
  }

  function state(): CommandLineInfo['state'] {
    let stat
    try { stat = lstatSync(path) } catch { return 'missing' }
    const want = wanted()
    if (!want) return 'other'
    if (want.kind === 'link') return stat.isSymbolicLink() && readlinkSync(path) === want.target ? 'installed' : 'other'
    return stat.isFile() && readFileSync(path, 'utf8') === want.script ? 'installed' : 'other'
  }

  // A login shell is slow to start: asked once, and again after a change.
  let found: Promise<string | null | undefined> | undefined
  const lookup = () => found ??= shell ? which(shell, app.id) : Promise.resolve(path)

  return {
    path,
    async info(): Promise<CommandLineInfo> {
      const now = state()
      const info: CommandLineInfo = { path, kind: wanted()?.kind ?? null, state: now }
      if (now !== 'installed') return info
      const resolved = await lookup()
      return resolved === undefined || resolved === path ? info : { ...info, shadowed: resolved }
    },
    /** Put this app's command at `path`, over whatever is there. */
    install() {
      const want = wanted()
      if (!want) throw new Error(packaged ? `This build of ${app.name} has no command line` : `${app.name}'s package.json names no bin for ${app.id}`)
      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      rmSync(path, { force: true })
      if (want.kind === 'link') symlinkSync(want.target, path)
      else writeFileSync(path, want.script, { mode: 0o755 })
      found = undefined
    },
    /** Take it away, if it's this app's. */
    uninstall() {
      if (state() === 'installed') rmSync(path, { force: true })
      found = undefined
    },
  }
}

/** The script a packaged app installs: its CLI on its own Electron as Node. */
export function script(app: AppConfig, executable: string, cli: string): string {
  return `#!/bin/sh
# ${app.name}'s command line, installed from its Settings: the copy inside the app, so it updates with it.
ELECTRON_RUN_AS_NODE=1 exec ${quote(executable)} ${quote(cli)} "$@"
`
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/** What `name` is to a login, interactive shell (where PATH is set up): null if nothing, undefined if it didn't say. */
function which(shell: string, name: string): Promise<string | null | undefined> {
  // Between markers: an interactive shell's startup files may print what they like.
  const mark = '__superego_which__'
  return new Promise((done) => {
    execFile(shell, ['-ilc', `printf '${mark}%s${mark}' "$(command -v ${name})"`], { timeout: 5000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }, (_error, stdout) => {
      const match = String(stdout ?? '').match(new RegExp(`${mark}(.*?)${mark}`))
      // No answer at all (it timed out, say): unknown, so taken as found.
      done(match ? match[1] || null : undefined)
    })
  })
}
