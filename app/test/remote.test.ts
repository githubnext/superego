// The remote bundle for real: build it, "install" it on a remote that is this computer with another HOME (a stand-in
// `ssh` on PATH runs the command there), then reach its daemon the way the app does and ask for hello. Headless, and
// nothing is installed as a service: the service manager's commands go to a recorder.
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { controlPath, installMachine, type RemoteRun } from '@superego/client'
import { FEATURES, lineSplitter, PROTOCOL_VERSION, type Hello } from '@superego/protocol'
import app from '../superego.config.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const bundle = join(appDir, 'out/remote/superego-remote.tgz')
const CLI = join(appDir, 'bin/superego.ts')

let root: string
const homes: string[] = []
const newHome = () => { const dir = mkdtempSync(join(root, 'home-')); homes.push(dir); return dir }

/** A remote: this computer with another HOME, a bare PATH of its own, and no model keys. */
const remoteEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env, HOME: home, SUPEREGO_MODEL: 'faux', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
  SUPEREGO_HOME: undefined, SUPEREGO_SOCKET: undefined, SUPEREGO_HEADLESS: '1',
})
const remote = (home: string): RemoteRun => (script, input) => new Promise((resolve) => {
  const child = spawn('/bin/sh', ['-c', script], { env: remoteEnv(home) })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.on('error', () => {})
  child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  child.stdin.end(input)
})

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'superego-remote-'))
  execFileSync('pnpm', ['exec', 'electron-vite', 'build', '--logLevel', 'error'], { cwd: appDir, stdio: 'ignore' })
  execFileSync(process.execPath, ['scripts/pack-remote.ts'], { cwd: appDir, stdio: 'ignore' })
}, 240_000)

afterAll(() => {
  for (const home of homes) {
    const pid = Number(readFileSync(join(home, '.superego/daemon.pid'), { flag: 'a+', encoding: 'utf8' }) || '0')
    if (pid) try { process.kill(pid) } catch {}
  }
  rmSync(root, { recursive: true, force: true })
})

/** Speak to the daemon through `<shim> connect --start`, as ssh would carry it: one line out, one line back. */
function ask(command: string, env: NodeJS.ProcessEnv, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env })
    const timer = setTimeout(() => { child.kill(); reject(new Error('no answer')) }, 30_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', lineSplitter((line) => {
      const message = JSON.parse(line)
      if (message.id !== 1) return
      clearTimeout(timer)
      child.kill()
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n')
  })
}

describe('the remote bundle', () => {
  it('is one tarball: the CLI and daemon bundled, and the window for Web access', () => {
    const files = execFileSync('tar', ['-tzf', bundle], { encoding: 'utf8' }).split('\n')
    expect(files).toEqual(expect.arrayContaining(['./main/cli.js', './main/daemon.js', './renderer/index.html', './package.json']))
    expect(files).not.toContain('./main/main.js')
  })

  it('installs, starts a daemon from the shim and answers hello', async () => {
    const home = newHome()
    const installed = await installMachine(remote(home), { app, label: 'Fake', bundle })
    expect(installed.command).toBe('~/.superego/bin/superego connect --start')
    // The window is there for Web access, beside the daemon bundle.
    expect(existsSync(join(home, '.superego/bin/app/renderer/index.html'))).toBe(true)

    const hello = await ask(`${installed.command.replace('~', home)}`, remoteEnv(home), 'hello', { client: 'test', version: PROTOCOL_VERSION, features: [...FEATURES] }) as Hello
    expect(hello.version).toBe(PROTOCOL_VERSION)
    expect(hello.features).toEqual(expect.arrayContaining(['threads', 'keeps-running']))
    expect(hello.machine.dataDir).toBe(join(home, '.superego'))
    // No service started it: it will not outlive the machine, and hello says so.
    expect(hello.machine.keepsRunning).toEqual({ service: null, afterLogout: false })
  })

  it('loads a profile that imports from superego, bundled', async () => {
    const home = newHome()
    await installMachine(remote(home), { app, label: 'Fake', bundle })
    mkdirSync(join(home, '.superego/profiles/default'), { recursive: true })
    writeFileSync(join(home, '.superego/profiles/default/profile.ts'), "import { defineProfile } from 'superego'\nexport default defineProfile({ description: 'bundled', prompt: 'Be brief.' })\n")
    const shim = join(home, '.superego/bin/superego')
    const project = mkdtempSync(join(root, 'project-'))
    const created = JSON.parse(execFileSync(shim, ['create', project, '-p', 'hi', '--json'], { env: remoteEnv(home), encoding: 'utf8' }))
    expect(created).toMatchObject({ machine: 'local' })
    expect(execFileSync(shim, ['--skill'], { env: remoteEnv(home), encoding: 'utf8' })).toContain('superego')
    const profiles = execFileSync(shim, ['profile', '--json'], { env: remoteEnv(home), encoding: 'utf8' })
    expect(profiles).toContain('default')
    const threads = JSON.parse(execFileSync(shim, ['ls', '--json'], { env: remoteEnv(home), encoding: 'utf8' }))
    expect(threads[0].profile).toMatchObject({ scope: 'user', name: 'default' })
  })
})

describe('machines add --install, through a stand-in ssh', () => {
  it('installs, points the machine at the shim, and lists it with the stop-at-logout warning; then sets up a service into the temp home', async () => {
    const remoteHome = newHome()
    const local = mkdtempSync(join(root, 'local-'))
    // The stand-in ssh: drops options and target, sets the remote HOME, runs the command as a remote shell would.
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin/ssh'), '#!/bin/sh\necho "$@" >> "$FAKE_SSH_LOG"\nwhile [ "$1" != "--" ]; do shift; done; shift; shift\nunset SUPEREGO_HOME SUPEREGO_SOCKET SUPEREGO_REMOTE_BUNDLE\nexport HOME="$FAKE_REMOTE_HOME"\nexec /bin/sh -c "$1"\n')
    chmodSync(join(root, 'bin/ssh'), 0o755)
    writeFileSync(join(root, 'bin/runner'), '#!/bin/sh\necho "$@" >> "$FAKE_SERVICE_LOG"\nexit 0\n')
    chmodSync(join(root, 'bin/runner'), 0o755)
    const env: NodeJS.ProcessEnv = {
      ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, SUPEREGO_HOME: local, SUPEREGO_HEADLESS: '1', SUPEREGO_MODEL: 'faux',
      SUPEREGO_REMOTE_BUNDLE: bundle, FAKE_REMOTE_HOME: remoteHome, FAKE_SSH_LOG: join(root, 'ssh.log'), FAKE_SERVICE_LOG: join(root, 'service.log'),
      SUPEREGO_SERVICE_RUNNER: join(root, 'bin/runner'), ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    }
    const run = (args: string[]) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60_000 })

    const added = JSON.parse(run(['machines', 'add', 'me@fake', '--name', 'Fake', '--install', '--json']))
    expect(added).toMatchObject({ label: 'Fake', command: '~/.superego/bin/superego connect --start', installed: { command: '~/.superego/bin/superego connect --start' } })
    const stored = JSON.parse(readFileSync(join(local, 'machines.json'), 'utf8'))
    expect(stored[0]).toMatchObject({ target: 'me@fake', command: '~/.superego/bin/superego connect --start' })
    expect(stored[0].daemonId).toBeTruthy()
    // Every ssh the CLI ran was an ordinary background one that rides a master when there is one.
    const log = readFileSync(join(root, 'ssh.log'), 'utf8')
    expect(log).toContain('ControlMaster=no')
    expect(log).toContain('BatchMode=yes')
    expect(log).toContain(`ControlPath=${controlPath(local, 'me@fake')}`)

    const list = run(['machines'])
    expect(list).toMatch(/Fake .*answers \(.*\) - stops at logout or reboot: run superego daemon install there/)

    // `daemon install` on that machine, as `--service` runs it: into its temp home, the system's commands recorded.
    // The daemon the listing started goes away first, so the recorded service manager has no one to hand over from.
    const pid = Number(readFileSync(join(remoteHome, '.superego/daemon.pid'), 'utf8'))
    process.kill(pid)
    for (let i = 0; i < 50 && existsSync(join(remoteHome, '.superego/superego.sock')); i++) await new Promise((r) => setTimeout(r, 100))
    run(['machines', 'install', 'Fake', '--service'])
    const service = readFileSync(join(root, 'service.log'), 'utf8')
    const file = process.platform === 'darwin' ? join(remoteHome, 'Library/LaunchAgents/com.githubnext.superego.daemon.plist') : join(remoteHome, '.config/systemd/user/superego.service')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain(join(remoteHome, '.superego/bin/app/main/daemon.js'))
    expect(service).toMatch(process.platform === 'darwin' ? /launchctl/ : /systemctl --user daemon-reload/)
  }, 120_000)
})
