import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifySsh, controlPath, linkArgs, loginArgs, loginScript, shellQuote, terminalLaunch } from '../src/ssh.ts'
import { loginInTerminal } from '../src/login.ts'
import { openSsh, sshLinkArgs } from '../src/transports.ts'
import { sshRun } from '../src/install.ts'

const kind = (stderr: string) => classifySsh(stderr)?.kind

describe('classifySsh', () => {
  it('reads a refused login as needing one', () => {
    expect(kind('user@box: Permission denied (publickey,password).')).toBe('needs_login')
    expect(kind('user@box: Permission denied (publickey,keyboard-interactive).')).toBe('needs_login')
    expect(kind('Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures')).toBe('needs_login')
  })

  it('tells an unknown host key from a changed one, with ssh-keygen as the way out', () => {
    expect(kind('No ED25519 host key is known for box and you have requested strict checking.\nHost key verification failed.')).toBe('host_key_unknown')
    expect(kind('Host key verification failed.')).toBe('host_key_unknown')
    const changed = classifySsh('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nOffending ED25519 key in /home/me/.ssh/known_hosts:3\nHost key verification failed.')
    expect(changed).toMatchObject({ kind: 'host_key_changed', message: expect.stringContaining('ssh-keygen -R') })
  })

  it('tells a closed port from an unreachable machine', () => {
    expect(kind('ssh: connect to host box port 22: Connection refused')).toBe('refused')
    expect(kind('ssh: Could not resolve hostname box: nodename nor servname provided, or not known')).toBe('unreachable')
    expect(kind('ssh: connect to host box port 22: Operation timed out')).toBe('unreachable')
    expect(kind('ssh: connect to host box port 22: No route to host')).toBe('unreachable')
    expect(classifySsh('ssh: connect to host box port 22: Network is unreachable')!.message).toContain('Network is unreachable')
  })

  it('knows when superego is not there', () => {
    expect(kind('bash: superego: command not found')).toBe('not_installed')
    expect(kind('sh: 1: superego: not found')).toBe('not_installed')
  })

  it('leaves what it does not know', () => {
    expect(classifySsh('')).toBeUndefined()
    expect(classifySsh('something odd')).toBeUndefined()
  })
})

describe('the shared master', () => {
  it('puts the socket under the data dir, one per target, and moves it to tmp when the path is too long for a socket', () => {
    const a = controlPath('/data', 'me@box')
    expect(a).toMatch(/^\/data\/ssh\/[0-9a-f]{12}\.sock$/)
    expect(controlPath('/data', 'me@other')).not.toBe(a)
    expect(controlPath('/data', 'me@box')).toBe(a)
    const long = controlPath(`/${'x'.repeat(100)}`, 'me@box', { tmp: '/tmp' })
    expect(long.startsWith('/tmp/')).toBe(true)
    expect(Buffer.byteLength(long)).toBeLessThan(100)
  })

  it('has links ride it without making one, and never prompt', () => {
    const control = '/data/ssh/abc.sock'
    const args = sshLinkArgs('me@box', 'superego connect --start', control)
    expect(args).toEqual(expect.arrayContaining(['-o', 'ControlMaster=no', `ControlPath=${control}`, 'BatchMode=yes']))
    expect(args.slice(-3)).toEqual(['--', 'me@box', 'superego connect --start'])
    expect(args).not.toContain('ControlPersist=4h')
    expect(linkArgs()).not.toContain('ControlMaster=no')
  })

  it('makes the master persistent and in the background, and may prompt', () => {
    const args = loginArgs('/data/ssh/abc.sock')
    expect(args).toEqual(expect.arrayContaining(['-M', 'ControlPath=/data/ssh/abc.sock', 'ControlPersist=4h', '-fN']))
    expect(args).not.toContain('BatchMode=yes')
  })

  it('writes the terminal script with the target quoted', () => {
    const script = loginScript("me@box'; rm -rf ~", '/data/ssh/abc.sock')
    expect(script).toContain('-M')
    expect(script).toContain(shellQuote("me@box'; rm -rf ~"))
    expect(script.startsWith('#!/bin/sh')).toBe(true)
  })
})

describe('opening a terminal for a login', () => {
  const dirs: string[] = []
  const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'superego-login-')); dirs.push(dir); return dir }
  afterEach(() => { dirs.length = 0 })

  it('knows the terminal on each platform', () => {
    expect(terminalLaunch('/x/login.command', 'darwin')).toEqual({ program: 'open', args: ['-a', 'Terminal', '/x/login.command'] })
    expect(terminalLaunch('/x/login.command', 'linux', (name) => name === 'x-terminal-emulator')).toEqual({ program: 'x-terminal-emulator', args: ['-e', 'sh', '/x/login.command'] })
    expect(terminalLaunch('/x/login.command', 'linux', () => false)).toBeUndefined()
  })

  it('writes a runnable script, opens the terminal, and says when the master is up', async () => {
    const dataDir = temp()
    const launched: [string, string[]][] = []
    let up = false
    const config = { id: 'abcdef12-0000', label: 'Box', target: 'me@box', enabled: true }
    const { script, done } = loginInTerminal(config, {
      dataDir, platform: 'darwin', launch: (program, args) => launched.push([program, args]), alive: () => up, pollMs: 10, timeoutMs: 5000,
    })
    expect(launched).toEqual([['open', ['-a', 'Terminal', script]]])
    expect(script.endsWith('.command')).toBe(true)
    expect(statSync(script).mode & 0o100).toBeTruthy()
    expect(readFileSync(script, 'utf8')).toContain(`ControlPath=${controlPath(dataDir, 'me@box')}`)
    setTimeout(() => { up = true }, 50)
    expect(await done).toBe(true)
    expect(existsSync(script)).toBe(false)
  })

  it('gives up when no login comes', async () => {
    const { done } = loginInTerminal({ id: 'abcdef12-0000', label: 'Box', target: 'me@box', enabled: true }, {
      dataDir: temp(), platform: 'darwin', launch: () => {}, alive: () => false, pollMs: 10, timeoutMs: 50,
    })
    expect(await done).toBe(false)
  })

  it('refuses where there is no terminal, and for a machine with no ssh', () => {
    const config = { id: 'abcdef12-0000', label: 'Box', target: 'me@box', enabled: true }
    expect(() => loginInTerminal(config, { dataDir: temp(), platform: 'linux', hasProgram: () => false })).toThrow(expect.objectContaining({ kind: 'no_terminal' }))
    expect(() => loginInTerminal({ ...config, via: 'docker exec -i box superego connect' }, { dataDir: temp(), platform: 'darwin' })).toThrow(/no login/)
  })
})

describe('ssh failures reach the caller as kinds', () => {
  const dirs: string[] = []
  const savedPath = process.env.PATH
  afterEach(() => { process.env.PATH = savedPath })

  /** A stand-in `ssh` first on PATH: logs its arguments, prints `stderr` and exits with `code`, or runs the command locally. */
  function fakeSsh(behaviour: { stderr?: string; code?: number }) {
    const dir = mkdtempSync(join(tmpdir(), 'superego-fakessh-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin/ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(join(dir, 'args'))}\n${behaviour.stderr ? `echo ${shellQuote(behaviour.stderr)} >&2\n` : ''}exit ${behaviour.code ?? 0}\n`)
    chmodSync(join(dir, 'bin/ssh'), 0o755)
    process.env.PATH = `${join(dir, 'bin')}:${savedPath}`
    return dir
  }

  it('a refused login becomes needs_login, from the transport and from a run', async () => {
    const dir = fakeSsh({ stderr: 'me@box: Permission denied (publickey,keyboard-interactive).', code: 255 })
    const transport = await openSsh('me@box', 'superego connect --start', controlPath(dir, 'me@box'))
    await expect(transport.peer.call('hello', {})).rejects.toMatchObject({ kind: 'needs_login' })
    expect(readFileSync(join(dir, 'args'), 'utf8')).toContain(`ControlPath=${controlPath(dir, 'me@box')}`)
    await expect(sshRun({ id: 'x', label: 'Box', target: 'me@box', enabled: true }, dir)('true')).rejects.toMatchObject({ kind: 'needs_login' })
  })

  it('a changed host key is its own kind', async () => {
    fakeSsh({ stderr: 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.', code: 255 })
    const transport = await openSsh('me@box', 'superego connect --start')
    await expect(transport.peer.call('hello', {})).rejects.toMatchObject({ kind: 'host_key_changed' })
  })

  it('an unclassified failure keeps ssh\'s own last line', async () => {
    fakeSsh({ stderr: 'something odd', code: 255 })
    const transport = await openSsh('me@box', 'superego connect --start')
    await expect(transport.peer.call('hello', {})).rejects.toMatchObject({ kind: 'ssh', message: 'ssh: something odd' })
  })
})
