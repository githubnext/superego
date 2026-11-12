// What ssh needs beyond `ssh host command`: one shared ControlMaster connection per target that every link rides, a login
// step that opens it in a real terminal (passwords, codes and hardware keys can't be answered by a background process),
// and reading ssh's complaints so "log in" and "host key changed" aren't just errors.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** How long a login's master stays up with nothing riding it. */
export const LOGIN_PERSIST = '4h'

/**
 * The master's socket for `target`: under the data dir when the path fits a socket (~104 bytes, and ssh adds a suffix
 * while binding), else in tmp.
 */
export function controlPath(dataDir: string, target: string, options: { tmp?: string } = {}): string {
  const name = `${createHash('sha256').update(target).digest('hex').slice(0, 12)}.sock`
  const inside = join(dataDir, 'ssh', name)
  if (Buffer.byteLength(inside) < 90) return inside
  return join(options.tmp ?? tmpdir(), `superego-ssh-${createHash('sha256').update(dataDir).digest('hex').slice(0, 8)}-${name}`)
}

const KEEPALIVE = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']

/**
 * Arguments before the target for a connection that does work (a link, an install). It rides the master when there is
 * one (ControlMaster=no: it never makes one) and is an ordinary connection when there isn't. BatchMode: no prompts,
 * there is no terminal.
 */
export const linkArgs = (control?: string) => [
  ...(control ? ['-o', 'ControlMaster=no', '-o', `ControlPath=${control}`] : []),
  '-o', 'BatchMode=yes', ...KEEPALIVE,
]

/** The master: ssh in this terminal (so it may ask), then in the background with nothing to run. Put the target after. */
export const loginArgs = (control: string) => [
  '-M', '-o', `ControlPath=${control}`, '-o', `ControlPersist=${LOGIN_PERSIST}`, ...KEEPALIVE, '-fN',
]

/** Whether a master answers on `control`. */
export function masterAlive(control: string, target: string): boolean {
  if (!existsSync(control)) return false
  return spawnSync('ssh', ['-O', 'check', '-o', `ControlPath=${control}`, '--', target], { stdio: 'ignore', timeout: 5000 }).status === 0
}

export type SshFailure = {
  /** `needs_login`, `host_key_changed`, `host_key_unknown`, `refused`, `unreachable` or `not_installed`. */
  kind: string
  message: string
}

/**
 * What ssh's complaint means. Anything else is not classified: the caller shows ssh's last line as it is.
 * `needs_login`: the server wants something a background process can't give (a password, a code, a key not loaded).
 */
export function classifySsh(stderr: string): SshFailure | undefined {
  const text = stderr.trim()
  if (!text) return undefined
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key in/i.test(text)) {
    return { kind: 'host_key_changed', message: 'The host key changed since you last connected, so this may not be the same machine. If that is expected, remove the old key with ssh-keygen -R <host>.' }
  }
  if (/No .* host key is known|Host key verification failed|host key is not known/i.test(text)) {
    return { kind: 'host_key_unknown', message: 'The host key is not known yet. Log in once to check and accept it.' }
  }
  if (/permission denied|authentication failed|too many authentication failures|no supported authentication methods|keyboard-interactive/i.test(text)) {
    return { kind: 'needs_login', message: 'ssh needs you to log in (a password, a code, or a key that is not loaded).' }
  }
  if (/connection refused/i.test(text)) return { kind: 'refused', message: 'The connection was refused: ssh is not listening there.' }
  if (/could not resolve|name or service not known|no route to host|network is unreachable|timed out|connection closed by|connection reset|host is down|nodename nor servname/i.test(text)) {
    const last = text.split('\n').filter(Boolean).at(-1)!
    return { kind: 'unreachable', message: `The machine could not be reached: ${last.replace(/^ssh: /, '')}` }
  }
  if (/(sh|bash|zsh): (\d+: )?\S*: (command )?not found|command not found/i.test(text)) {
    return { kind: 'not_installed', message: 'Superego is not installed there, or is not on the PATH of a non-login shell. Install it with: superego machines install <machine>' }
  }
  return undefined
}

/** A word for a POSIX shell. */
export const shellQuote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`

/**
 * How to open `scriptPath` (a shell script) in a real terminal window: Terminal on macOS (a .command file opens in it),
 * `x-terminal-emulator` elsewhere. Undefined where there is none.
 */
export function terminalLaunch(scriptPath: string, platform: NodeJS.Platform = process.platform, hasProgram: (name: string) => boolean = onPath): { program: string; args: string[] } | undefined {
  if (platform === 'darwin') return { program: 'open', args: ['-a', 'Terminal', scriptPath] }
  if (hasProgram('x-terminal-emulator')) return { program: 'x-terminal-emulator', args: ['-e', 'sh', scriptPath] }
  return undefined
}

function onPath(name: string) {
  return (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, name)))
}

/** What a terminal runs for a login: the master, then a word on how it went. */
export function loginScript(target: string, control: string): string {
  const ssh = ['ssh', ...loginArgs(control), '--', target].map((word, i) => i === 0 ? word : shellQuote(word)).join(' ')
  return [
    '#!/bin/sh',
    `echo ${shellQuote(`Logging in to ${target}. Answer what ssh asks.`)}`,
    `if ${ssh}; then`,
    '  echo "Logged in. You can close this window."; sleep 1',
    'else',
    '  echo "ssh did not log in. Press return to close."; read _',
    'fi',
    '',
  ].join('\n')
}
