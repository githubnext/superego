import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineApp } from '@superego/protocol'
import { installedCommand, installMachine, nodeIsNewEnough, sshRun, type RemoteRun } from '../src/install.ts'

const app = defineApp({ name: 'Superego', id: 'superego' })
let root: string
let bundle: string

/**
 * A tarball like the real one in shape: main/cli.js answers `daemon status --json`, with `installed` the build it is
 * and `build` what the "running daemon" runs (FAKE_BUILD).
 */
function makeBundle(build: string) {
  const stage = join(root, `stage-${build}`)
  mkdirSync(join(stage, 'main'), { recursive: true })
  writeFileSync(join(stage, 'main/cli.js'), `console.log(JSON.stringify({ running: process.env.FAKE_RUNNING === "1", current: process.env.FAKE_CURRENT === "1", build: process.env.FAKE_BUILD, installed: ${JSON.stringify(build)}, args: process.argv.slice(2) }))\n`)
  writeFileSync(join(stage, 'package.json'), '{"type":"module"}\n')
  const tarball = join(root, `bundle-${build}.tgz`)
  execFileSync('tar', ['-czf', tarball, '-C', stage, '.'])
  return tarball
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'superego-install-'))
  bundle = makeBundle('b1')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A "remote" that is this computer with another HOME (and the PATH given), which is all a script on a remote sees. */
function remote(home: string, env: Record<string, string> = {}): RemoteRun {
  return (script, input) => new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', script], { env: { ...process.env, HOME: home, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdin.on('error', () => {})
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(input)
  })
}
const home = () => mkdtempSync(join(tmpdir(), 'superego-remote-home-'))

describe('installing over ssh', () => {
  it('knows which Node is new enough', () => {
    expect(nodeIsNewEnough('v22.18.0')).toBe(true)
    expect(nodeIsNewEnough('v22.17.9')).toBe(false)
    expect(nodeIsNewEnough('v24.1.0')).toBe(true)
    expect(nodeIsNewEnough('v20.19.0')).toBe(false)
  })

  it('unpacks the bundle under the data dir and writes a shim that names its Node', async () => {
    const h = home()
    const steps: string[] = []
    const installed = await installMachine(remote(h), { app, label: 'Box', bundle, onStep: (s) => steps.push(s) })
    expect(installed.command).toBe(installedCommand(app))
    expect(installed.command).toBe('~/.superego/bin/superego connect --start')
    expect(existsSync(join(h, '.superego/bin/app/main/cli.js'))).toBe(true)
    const shim = join(h, '.superego/bin/superego')
    expect(statSync(shim).mode & 0o100).toBeTruthy()
    expect(readFileSync(shim, 'utf8')).toContain(`exec "${installed.node}" "${join(h, '.superego/bin')}/app/main/cli.js" "$@"`)
    expect(steps[0]).toContain('Checking Node')
    // The shim runs the bundle with no PATH to speak of, and passes its arguments on.
    const out = execFileSync(shim, ['daemon', 'status'], { env: { HOME: h, PATH: '/nonexistent' }, encoding: 'utf8' })
    expect(JSON.parse(out).args).toEqual(['daemon', 'status'])
  })

  it('puts each build in a directory of its own and switches a link, keeping what a running daemon runs', async () => {
    const h = home()
    const bin = join(h, '.superego/bin')
    await installMachine(remote(h), { app, label: 'Box', bundle })
    expect(lstatSync(join(bin, 'app')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(bin, 'app'))).toBe('versions/b1')
    // A newer build, nothing running: the old one goes.
    await installMachine(remote(h), { app, label: 'Box', bundle: makeBundle('b2') })
    expect(readlinkSync(join(bin, 'app'))).toBe('versions/b2')
    expect(readdirSync(join(bin, 'versions'))).toEqual(['b2'])
    // A daemon still running b2 (busy) keeps its files while b3 goes in; once it runs b3, b2 goes too.
    await installMachine(remote(h, { FAKE_RUNNING: '1', FAKE_BUILD: 'b2' }), { app, label: 'Box', bundle: makeBundle('b3') })
    expect(readlinkSync(join(bin, 'app'))).toBe('versions/b3')
    expect(readdirSync(join(bin, 'versions')).sort()).toEqual(['b2', 'b3'])
    await installMachine(remote(h, { FAKE_RUNNING: '1', FAKE_CURRENT: '1', FAKE_BUILD: 'b3' }), { app, label: 'Box', bundle: makeBundle('b3') })
    expect(readdirSync(join(bin, 'versions'))).toEqual(['b3'])
    expect(existsSync(join(bin, 'app.next'))).toBe(false)
    expect(existsSync(join(bin, 'superego.next'))).toBe(false)
  })

  it('moves a copy from before versions aside under the build its daemon runs', async () => {
    const h = home()
    const bin = join(h, '.superego/bin')
    mkdirSync(join(bin, 'app/main'), { recursive: true })
    writeFileSync(join(bin, 'app/main/daemon.js'), 'old')
    await installMachine(remote(h, { FAKE_RUNNING: '1', FAKE_BUILD: 'old1' }), { app, label: 'Box', bundle })
    expect(readlinkSync(join(bin, 'app'))).toBe('versions/b1')
    expect(readFileSync(join(bin, 'versions/old1/main/daemon.js'), 'utf8')).toBe('old')
  })

  it('restarts a running daemon that is behind, and leaves a current one', async () => {
    const behind = await installMachine(remote(home(), { FAKE_RUNNING: '1' }), { app, label: 'Box', bundle })
    expect(behind.daemon).toBe('restarted')
    const current = await installMachine(remote(home(), { FAKE_RUNNING: '1', FAKE_CURRENT: '1' }), { app, label: 'Box', bundle })
    expect(current.daemon).toBe('current')
    expect((await installMachine(remote(home()), { app, label: 'Box', bundle })).daemon).toBeUndefined()
  })

  it('sets up the service when asked, through the shim', async () => {
    const h = home()
    const installed = await installMachine(remote(h), { app, label: 'Box', bundle, service: true })
    // The stand-in cli prints its arguments: `daemon install` is what was run.
    expect(JSON.parse(installed.service!).args).toEqual(['daemon', 'install'])
  })

  it('says plainly when there is no Node there', async () => {
    // A PATH with nothing on it: sh has no node to find.
    await expect(installMachine(remote(home(), { PATH: '/nonexistent' }), { app, label: 'Box', bundle })).rejects.toMatchObject({
      kind: 'install_failed', message: expect.stringContaining('Node.js is not installed on Box'), hint: expect.stringContaining('22.18'),
    })
  })

  it('says plainly when Node is too old', async () => {
    const old: RemoteRun = async (script) => script.includes('node --version') ? { code: 0, stdout: '/usr/bin/node\nv18.20.0\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    await expect(installMachine(old, { app, label: 'Box', bundle })).rejects.toMatchObject({ message: 'Box has Node 18.20.0; Superego needs 22.18 or newer.' })
  })

  it('says when there is no bundle to copy', async () => {
    await expect(installMachine(remote(home()), { app, label: 'Box', bundle: join(root, 'nope.tgz') })).rejects.toMatchObject({ message: expect.stringContaining('No bundle'), hint: expect.stringContaining('pnpm build') })
  })

  it('refuses a machine reached by a command', () => {
    expect(() => sshRun({ id: 'x', label: 'Box', target: '', via: 'docker exec -i box superego connect', enabled: true })).toThrow(/not ssh/)
  })

  it('runs scripts over ssh as one quoted command, riding the master', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'superego-fakessh-'))
    mkdirSync(join(dir, 'bin'))
    // A stand-in `ssh`: drops its options and the target, then runs the command with the shell a remote would use.
    writeFileSync(join(dir, 'bin/ssh'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_ARGS"\nwhile [ "$1" != "--" ]; do shift; done; shift; shift\nexec sh -c "$1"\n')
    chmodSync(join(dir, 'bin/ssh'), 0o755)
    const saved = process.env.PATH
    process.env.PATH = `${join(dir, 'bin')}:${saved}`
    process.env.FAKE_ARGS = join(dir, 'args')
    try {
      const result = await sshRun({ id: 'x', label: 'Box', target: 'me@box', enabled: true }, dir)("echo \"it's $((1+1))\"; cat")
      expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining("it's 2") })
      expect(readFileSync(join(dir, 'args'), 'utf8')).toContain('ControlMaster=no')
    } finally {
      process.env.PATH = saved
      delete process.env.FAKE_ARGS
    }
  })
})
