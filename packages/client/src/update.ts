// Updating Superego on another machine: run that machine's own scripts/install-machine.sh (pull, install, build, restart
// its daemon), reached the way the machine is. Over ssh, a script finds the checkout from the `superego` wrapper the
// install wrote; through a `via` command, its `connect --start` becomes `connect --update`, which does the same there.
// A machine on releases updates to the newest: a checkout at a release's tag checks out the newest tag; a Mac running
// the release's app (no checkout) runs the install script from GitHub, which downloads it.
import { spawn } from 'node:child_process'
import { remoteCommand, RpcError, type AppConfig } from '@superego/protocol'
import type { MachineConfig } from './shared.ts'

/** Where releases and the install script are, for a machine on releases without a checkout. */
const REPO = 'githubnext/superego'

/**
 * A POSIX sh script updating the checkout at `dir`, or the one whose `wrapper` (as a shell word) install-machine.sh
 * wrote, or the release app that wrapper runs. It refuses a checkout with changes and a pull that fails, before the
 * install script (which only warns) runs; `now` lets the install restart the daemon though threads are working there.
 */
export function updateScript(where: { dir: string } | { wrapper: string }, now = false): string {
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
  const restartNow = now ? 'SUPEREGO_RESTART_NOW=1 ' : ''
  return [
    'fail() { echo "superego update: $*" >&2; exit 1; }',
    ...'dir' in where ? [`d=${quote(where.dir)}`] : [
      `w=${where.wrapper}`,
      '[ -f "$w" ] || fail "no $w here: install Superego there with scripts/install-machine.sh"',
      'if grep -qx "# Written by scripts/install-machine.sh --release" "$w"; then',
      '  PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
      '  echo "Updating to the newest release"',
      `  s=$(gh api -H "Accept: application/vnd.github.raw" repos/${REPO}/contents/scripts/install-machine.sh) || fail "could not fetch scripts/install-machine.sh from ${REPO} with gh"`,
      `  ${restartNow}exec bash -c "$s" install-machine.sh --release`,
      'fi',
      `d=$(sed -n 's|^# Written by \\(.*\\)/scripts/install-machine\\.sh$|\\1|p' "$w" | head -n 1)`,
      '[ -n "$d" ] || fail "$w was not written by scripts/install-machine.sh: update it by hand"',
    ],
    '[ -x "$d/scripts/install-machine.sh" ] || fail "no scripts/install-machine.sh in $d"',
    '[ -f "$d/scripts/machine-path.sh" ] || fail "no scripts/machine-path.sh in $d: update it by hand once (git pull there, then scripts/install-machine.sh)"',
    // Where git and its credential helper are, as the install script finds them.
    '. "$d/scripts/machine-path.sh"',
    'cd "$d" || fail "no checkout at $d"',
    '[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "$d has uncommitted changes: commit or discard them there first"',
    // At a release's tag: to the newest, whose install script runs (an older one only warns that it can't pull).
    'if ! git symbolic-ref -q HEAD >/dev/null && git describe --tags --exact-match --match "v*" >/dev/null 2>&1; then',
    '  git fetch --tags --force || fail "git fetch failed in $d"',
    '  t=$(git tag --list "v*" --sort=-v:refname | head -n 1)',
    '  echo "Updating $d to $t"',
    '  git -c advice.detachedHead=false checkout --quiet "$t" || fail "could not check out $t in $d"',
    `  ${restartNow}exec "$d/scripts/install-machine.sh" --release`,
    'fi',
    'echo "Updating $d"',
    'git pull --ff-only || fail "git pull failed in $d"',
    `${restartNow}exec "$d/scripts/install-machine.sh"`,
  ].join('\n')
}

/** The wrapper a machine's ssh command runs, as a shell word: `~/.local/bin/superego` is `"$HOME/.local/bin/superego"`. */
export function wrapperOf(command: string): string {
  const program = command.trim().split(/\s+/)[0] ?? ''
  if (!program.includes('/')) return `"$(command -v ${program.replace(/[^\w.-]/g, '') || 'superego'})"`
  return `"${program.replace(/^~\//, '$HOME/').replace(/["`\\]/g, '')}"`
}

/** How to run the update on a machine: the program and its arguments, run here. */
export function updateCommand(config: MachineConfig, app: AppConfig, now = false): { program: string; args: string[] } {
  if (config.via) {
    const pattern = /\bconnect(\s+--start)?(?=['"]?\s*$)/
    if (!pattern.test(config.via)) {
      throw new RpcError('invalid', `Can't tell how to run the update through \`${config.via}\`: run scripts/install-machine.sh there`)
    }
    return { program: '/bin/sh', args: ['-c', config.via.replace(pattern, `connect --update${now ? ' --now' : ''}`)] }
  }
  // sh, whatever the login shell there is.
  const script = updateScript({ wrapper: wrapperOf(config.command ?? remoteCommand(app)) }, now)
  return { program: 'ssh', args: ['-T', '-o', 'BatchMode=yes', config.target, `sh -c '${script.replaceAll("'", `'\\''`)}'`] }
}

/**
 * How to install the daemon's service on a machine (`daemon install` there), so it outlives a logout and a reboot: the
 * program and its arguments, run here. Over ssh, the machine's own wrapper; through a `via` command, its `connect`
 * becomes `daemon install`.
 */
export function serviceCommand(config: MachineConfig, app: AppConfig): { program: string; args: string[] } {
  if (config.via) {
    const pattern = /\bconnect(\s+--start)?(?=['"]?\s*$)/
    if (!pattern.test(config.via)) throw new RpcError('invalid', `Can't tell how to reach ${app.id} through \`${config.via}\`: run ${app.id} daemon install there`)
    return { program: '/bin/sh', args: ['-c', config.via.replace(pattern, 'daemon install')] }
  }
  const script = `exec ${wrapperOf(config.command ?? remoteCommand(app))} daemon install`
  return { program: 'ssh', args: ['-T', '-o', 'BatchMode=yes', config.target, `sh -c '${script.replaceAll("'", `'\\''`)}'`] }
}

/**
 * Run a command reaching a machine, passing on what it prints as it goes. Rejects with `kind` and the last thing it said
 * (its line starting `<prefix>`, else its last), once it ends badly.
 */
function runOn({ program, args }: { program: string; args: string[] }, kind: string, onOutput: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      tail = (tail + text).slice(-4000)
      onOutput(text)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.once('error', (error) => reject(new RpcError(kind, `Could not run ${program}: ${error.message}`)))
    child.once('close', (code) => {
      if (code === 0) return resolve(tail)
      const lines = tail.split('\n').map((line) => line.trim()).filter(Boolean)
      const said = lines.findLast((line) => line.startsWith('superego update:') || line.startsWith('superego:')) ?? lines.at(-1)
      reject(new RpcError(kind, said?.replace(/^superego update: /, '') ?? `${program} ended with exit code ${code}`))
    })
  })
}

/**
 * Update a machine, passing on what the update prints as it goes. Rejects with the reason it gave up (the last line it
 * said), once it ends badly.
 */
export async function runUpdate(config: MachineConfig, app: AppConfig, { now = false, onOutput }: { now?: boolean; onOutput(text: string): void }): Promise<void> {
  await runOn(updateCommand(config, app, now), 'update_failed', onOutput)
}

/** Install the daemon's service on a machine (see `serviceCommand`): what it said, or why it failed. */
export async function installServiceOn(config: MachineConfig, app: AppConfig): Promise<string> {
  return (await runOn(serviceCommand(config, app), 'install_failed', () => {})).trim()
}
