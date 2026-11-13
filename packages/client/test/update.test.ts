import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineApp } from '@superego/protocol'
import { runUpdate, updateCommand, updateScript, wrapperOf, type MachineConfig } from '../src/index.ts'

const app = defineApp({ name: 'Superego', id: 'superego' })
const machine = (patch: Partial<MachineConfig>): MachineConfig => ({ id: 'm', label: 'mbp', target: 'mbp', enabled: true, ...patch })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

describe('updating a machine', () => {
  let home: string
  let checkout: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'superego-update-'))
    // A machine's checkout, cloned from an origin that has moved on since; its install script says what it got.
    const origin = join(home, 'origin')
    mkdirSync(join(origin, 'scripts'), { recursive: true })
    writeFileSync(join(origin, 'scripts/install-machine.sh'), '#!/bin/sh\necho "installed $(git rev-parse --short HEAD) now=${SUPEREGO_RESTART_NOW:-}"\n')
    chmodSync(join(origin, 'scripts/install-machine.sh'), 0o755)
    git(origin, 'init', '-q', '-b', 'main')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'one')
    checkout = join(home, 'dev/superego')
    git(home, 'clone', '-q', origin, checkout)
    writeFileSync(join(origin, 'NEW'), 'x')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'two')
    // The wrapper install-machine.sh writes, naming the checkout.
    mkdirSync(join(home, '.local/bin'), { recursive: true })
    writeFileSync(join(home, '.local/bin/superego'), `#!/bin/sh\n# Written by ${checkout}/scripts/install-machine.sh\nexec node "${checkout}/app/bin/superego.ts" "$@"\n`)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const run = (script: string) => {
    try { return { ok: true, out: execFileSync('/bin/sh', ['-c', script], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
    catch (error) { return { ok: false, out: String((error as { stderr: string }).stderr) } }
  }

  it('finds the checkout from the wrapper, pulls, and runs its install script', () => {
    const { ok, out } = run(updateScript({ wrapper: wrapperOf('~/.local/bin/superego connect --start') }, true))
    expect(ok).toBe(true)
    expect(out).toContain(`Updating ${checkout}`)
    expect(out).toContain(`installed ${git(checkout, 'rev-parse', '--short', 'HEAD').trim()} now=1`)
    expect(readFileSync(join(checkout, 'NEW'), 'utf8')).toBe('x')
  })

  it('refuses a checkout with changes, a pull that fails, and a wrapper it did not write', () => {
    writeFileSync(join(checkout, 'scripts/install-machine.sh'), '#!/bin/sh\necho changed\n')
    expect(run(updateScript({ dir: checkout }))).toMatchObject({ ok: false, out: expect.stringContaining('has uncommitted changes') })
    git(checkout, 'checkout', '--', '.')
    git(checkout, 'remote', 'set-url', 'origin', join(home, 'gone'))
    expect(run(updateScript({ dir: checkout }))).toMatchObject({ ok: false, out: expect.stringContaining('git pull failed') })
    writeFileSync(join(home, '.local/bin/superego'), '#!/bin/sh\nexec superego "$@"\n')
    expect(run(updateScript({ wrapper: wrapperOf('~/.local/bin/superego') }))).toMatchObject({ ok: false, out: expect.stringContaining('was not written by scripts/install-machine.sh') })
  })

  it('reaches the machine as it is reached: ssh with sh, or its via command asking connect for --update', () => {
    const ssh = updateCommand(machine({ command: '~/.local/bin/superego connect --start' }), app)
    expect(ssh.program).toBe('ssh')
    expect(ssh.args.slice(0, 4)).toEqual(['-T', '-o', 'BatchMode=yes', 'mbp'])
    expect(ssh.args[4]).toMatch(/^sh -c '/)
    expect(ssh.args[4]).toContain('$HOME/.local/bin/superego')
    expect(updateCommand(machine({ via: "ssh -J jump box 'superego connect --start'" }), app, true).args[1]).toBe("ssh -J jump box 'superego connect --update --now'")
    expect(() => updateCommand(machine({ via: 'docker exec -i box nc localhost 9' }), app)).toThrow(/Can't tell how to run the update/)
  })

  it('passes the output on as it goes, and fails with the last thing it said', async () => {
    const stub = join(home, 'stub.sh')
    writeFileSync(stub, 'case "$*" in *--update*) echo pulling; echo installing >&2; [ -n "$FAIL" ] && { echo "superego update: git pull failed in /x" >&2; echo trailing; exit 1; }; exit 0;; esac\n')
    let said = ''
    await runUpdate(machine({ via: `sh ${stub} connect --start` }), app, { onOutput: (text) => { said += text } })
    expect(said).toContain('pulling')
    expect(said).toContain('installing')
    await expect(runUpdate(machine({ via: `FAIL=1 sh ${stub} connect --start` }), app, { onOutput: () => {} }))
      .rejects.toMatchObject({ kind: 'update_failed', message: 'git pull failed in /x' })
  })
})
