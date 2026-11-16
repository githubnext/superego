import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defineApp } from '@superego/protocol'
import {
  installService, keepsRunning, launchdLabel, launchdPlist, RESTART_EXIT, restartVia, saveRestartEnv, serviceInstalled, servicePath, startService, systemdUnit,
  takeRestartEnv, uninstallService, type Run,
} from '../src/service.ts'

const app = defineApp({ name: 'Superego', id: 'superego', bundleId: 'com.example.superego' })
const homes: string[] = []
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'superego-service-')); homes.push(dir); return dir }
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** Records every system command instead of running it; `answers` says what some of them print. */
function recorder(answers: Record<string, { code?: number; stdout?: string }> = {}) {
  const calls: string[] = []
  const run: Run = (command, args) => {
    const line = [command, ...args].join(' ')
    calls.push(line)
    const answer = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1]
    return { code: answer?.code ?? 0, stdout: answer?.stdout ?? '', stderr: '' }
  }
  return { calls, run }
}

describe('service files', () => {
  it('writes a systemd user unit that restarts the daemon and says which service it runs under', () => {
    const unit = systemdUnit(app, { command: ['/usr/bin/node', '/home/me/.superego/bin/app/main/daemon.js'], env: { PATH: '/usr/bin:/my dir/bin', SUPEREGO_SERVICE: 'systemd' } })
    expect(unit).toContain('ExecStart=/usr/bin/node /home/me/.superego/bin/app/main/daemon.js\n')
    expect(unit).toContain('Environment="PATH=/usr/bin:/my dir/bin"')
    expect(unit).toContain('Environment=SUPEREGO_SERVICE=systemd')
    // A stop stays stopped; a crash, or a restart's own exit code, brings it back.
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain(`RestartForceExitStatus=${RESTART_EXIT}`)
    expect(unit).not.toContain('Restart=always')
    expect(unit).toContain('WantedBy=default.target')
  })

  it('escapes what systemd would expand: $ only on ExecStart, % everywhere', () => {
    const unit = systemdUnit(app, { command: ['/bin/x', '50%', '$HOME'], env: { KEY: 'a$b c%d' } })
    expect(unit).toContain('ExecStart=/bin/x "50%%" "$$HOME"')
    expect(unit).toContain('Environment="KEY=a$b c%%d"')
  })

  it('writes a launchd agent that keeps the daemon alive, escaping XML', () => {
    const plist = launchdPlist(app, { command: ['/usr/local/bin/node', '/Users/me/a&b/daemon.js'], env: { PATH: '/usr/bin' }, log: '/Users/me/.superego/daemon.log' })
    expect(plist).toContain('<key>Label</key><string>com.example.superego.daemon</string>')
    expect(plist).toContain('<string>/Users/me/a&amp;b/daemon.js</string>')
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/)
    expect(plist).toContain('<key>PATH</key><string>/usr/bin</string>')
    expect(plist).toContain('<key>StandardErrorPath</key><string>/Users/me/.superego/daemon.log</string>')
  })
})

describe('installing a service', () => {
  it('on Linux: writes the unit under the home, enables it and turns lingering on', () => {
    const h = home()
    const { calls, run } = recorder({ 'loginctl show-user': { stdout: 'Linger=yes\n' } })
    const result = installService({ app, platform: 'linux', home: h, user: 'me', run }, { command: ['/usr/bin/node', '/d/daemon.js'], log: '/d/log' })
    expect(result).toMatchObject({ kind: 'systemd', lingering: true, notes: [] })
    expect(result.file).toBe(join(h, '.config/systemd/user/superego.service'))
    expect(readFileSync(result.file, 'utf8')).toContain('Environment=SUPEREGO_SERVICE=systemd')
    expect(calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable superego.service', 'loginctl enable-linger me'])
    expect(serviceInstalled({ app, platform: 'linux', home: h })).toBe(true)
  })

  it('on Linux: says so when lingering cannot be turned on', () => {
    const { run } = recorder({ 'loginctl enable-linger': { code: 1 }, 'loginctl show-user': { stdout: 'Linger=no\n' } })
    const result = installService({ app, platform: 'linux', home: home(), user: 'me', run }, { command: ['/n'], log: '/l' })
    expect(result.lingering).toBe(false)
    expect(result.notes[0]).toContain('loginctl enable-linger me')
  })

  it('on Linux without a user service manager: fails with that', () => {
    const { run } = recorder({ 'systemctl --user daemon-reload': { code: 1 } })
    expect(() => installService({ app, platform: 'linux', home: home(), user: 'me', run }, { command: ['/n'], log: '/l' })).toThrow(/systemctl --user is not available/)
  })

  it('on macOS: writes the agent under LaunchAgents without loading it', () => {
    const h = home()
    const { calls, run } = recorder()
    const result = installService({ app, platform: 'darwin', home: h, uid: 501, run }, { command: ['/n', '/d.js'], log: '/l' })
    expect(result).toMatchObject({ kind: 'launchd', lingering: null })
    expect(result.file).toBe(join(h, 'Library/LaunchAgents/com.example.superego.daemon.plist'))
    expect(readFileSync(result.file, 'utf8')).toContain('<key>SUPEREGO_SERVICE</key><string>launchd</string>')
    expect(calls).toEqual([])
  })

  it('a copy with its own data dir is not what a service runs', () => {
    process.env.SUPEREGO_HOME = '/somewhere'
    try {
      const h = home()
      expect(() => installService({ app, platform: 'linux', home: h, run: recorder().run }, { command: ['/n'], log: '/l' })).toThrow(/default instance/)
      expect(serviceInstalled({ app, platform: 'linux', home: h })).toBe(false)
    } finally {
      delete process.env.SUPEREGO_HOME
    }
  })

  it('starts the daemon through the service, and only when one is installed', () => {
    const h = home()
    const linux = recorder()
    expect(startService({ app, platform: 'linux', home: h, run: linux.run })).toBe(false)
    installService({ app, platform: 'linux', home: h, user: 'me', run: linux.run }, { command: ['/n'], log: '/l' })
    linux.calls.length = 0
    expect(startService({ app, platform: 'linux', home: h, run: linux.run })).toBe(true)
    expect(linux.calls).toEqual(['systemctl --user start superego.service'])

    const mac = recorder({ 'launchctl print': { code: 113 } })
    installService({ app, platform: 'darwin', home: h, uid: 501, run: mac.run }, { command: ['/n'], log: '/l' })
    expect(startService({ app, platform: 'darwin', home: h, uid: 501, run: mac.run })).toBe(true)
    expect(mac.calls).toEqual([`launchctl print gui/501/${launchdLabel(app)}`, `launchctl bootstrap gui/501 ${servicePath({ app, platform: 'darwin', home: h })}`])
    const loaded = recorder()
    startService({ app, platform: 'darwin', home: h, uid: 501, run: loaded.run })
    expect(loaded.calls[1]).toBe(`launchctl kickstart gui/501/${launchdLabel(app)}`)
  })

  it('removes it, stopping its daemon', () => {
    const h = home()
    const { calls, run } = recorder()
    installService({ app, platform: 'linux', home: h, user: 'me', run }, { command: ['/n'], log: '/l' })
    calls.length = 0
    expect(uninstallService({ app, platform: 'linux', home: h, user: 'me', run })).toBe(true)
    expect(existsSync(servicePath({ app, platform: 'linux', home: h }))).toBe(false)
    expect(calls).toEqual(['systemctl --user disable --now superego.service', 'systemctl --user daemon-reload'])
    expect(uninstallService({ app, platform: 'linux', home: h, user: 'me', run })).toBe(false)
  })
})

describe('restarting', () => {
  it('under a service, leaves it to the service; with one installed, starts it; else, or when that fails, spawns', () => {
    const h = home()
    const nothing = recorder()
    expect(restartVia({ app, platform: 'linux', home: h, run: nothing.run }, {})).toBe('self')
    expect(nothing.calls).toEqual([])
    expect(restartVia({ app, platform: 'linux', home: h, run: nothing.run }, { SUPEREGO_SERVICE: 'systemd' })).toBe('manager')
    expect(nothing.calls).toEqual([])

    installService({ app, platform: 'linux', home: h, user: 'me', run: recorder().run }, { command: ['/n'], log: '/l' })
    const started = recorder()
    expect(restartVia({ app, platform: 'linux', home: h, run: started.run }, {})).toBe('service')
    expect(started.calls).toEqual(['systemctl --user start superego.service'])
    const failed = recorder({ 'systemctl --user start': { code: 1 } })
    expect(restartVia({ app, platform: 'linux', home: h, run: failed.run }, {})).toBe('self')
  })

  it('leaves the restart\'s environment for the successor a service starts, once', async () => {
    const dir = home()
    await saveRestartEnv(dir, { ANTHROPIC_API_KEY: 'k', SSH_AUTH_SOCK: '/run/agent' })
    expect(statSync(join(dir, 'restart-env.json')).mode & 0o777).toBe(0o600)
    expect(takeRestartEnv(dir)).toEqual({ ANTHROPIC_API_KEY: 'k', SSH_AUTH_SOCK: '/run/agent' })
    expect(existsSync(join(dir, 'restart-env.json'))).toBe(false)
    expect(takeRestartEnv(dir)).toEqual({})
  })
})

describe('keepsRunning, as hello reports it', () => {
  it('is nothing for a daemon no service started: it ends with the machine', async () => {
    expect(await keepsRunning(app, { env: {} })).toEqual({ service: null, afterLogout: false })
  })

  it('under systemd it is whether the user lingers', async () => {
    const env = { SUPEREGO_SERVICE: 'systemd' }
    expect(await keepsRunning(app, { env, user: 'me', run: recorder({ 'loginctl show-user me': { stdout: 'Linger=yes\n' } }).run })).toEqual({ service: 'systemd', afterLogout: true })
    expect(await keepsRunning(app, { env, user: 'me', run: recorder({ 'loginctl show-user me': { stdout: 'Linger=no\n' } }).run })).toEqual({ service: 'systemd', afterLogout: false })
    expect(await keepsRunning(app, { env, user: 'me', run: recorder({ 'loginctl show-user me': { code: 1 } }).run })).toEqual({ service: 'systemd', afterLogout: null })
  })

  it('under launchd it is not known: the agent lasts as long as the login session', async () => {
    expect(await keepsRunning(app, { env: { SUPEREGO_SERVICE: 'launchd' } })).toEqual({ service: 'launchd', afterLogout: null })
  })
})
