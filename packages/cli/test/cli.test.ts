import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../src/main.ts', import.meta.url))
let home: string
const env = () => ({ ...process.env, MU_HOME: home, MU_MODEL: 'faux', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' })

/** Run `mu` with `args`; resolves with stdout, rejects with stderr. */
function mu(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: env(), timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolve(stdout)
    })
    if (input !== undefined) child.stdin!.end(input)
  })
}
const muJson = async <T = any>(args: string[], input?: string): Promise<T> => JSON.parse(await mu([...args, '--json'], input))
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('timed out')
}

beforeAll(async () => { home = await mkdtemp(join(tmpdir(), 'mu-cli-')) })
afterAll(async () => {
  for (const dir of [home, join(home, 'second')]) {
    const pid = Number(await readFile(join(dir, 'daemon.pid'), 'utf8').catch(() => '0'))
    if (pid) try { process.kill(pid) } catch {}
  }
  await rm(home, { recursive: true, force: true })
})

describe('mu', () => {
  it('starts the daemon on demand and runs sessions', async () => {
    const created = await muJson(['new', home, '-p', 'hi from the cli'])
    expect(created).toMatchObject({ machine: 'local', cwd: home })
    await until(async () => (await muJson(['sessions']))[0]?.status.state === 'done')
    await mu(['send', created.id, 'again'])
    expect((await mu(['ls'])).split('\n')[0]).toContain('hi from the cli')
    expect(await muJson(['daemon', 'status'])).toMatchObject({ running: true })
  })

  it('reads and changes settings, and stores API keys', async () => {
    await mu(['settings', 'set', 'agent.model', 'faux/faux-1'])
    expect((await muJson(['settings'])).values['agent.model']).toBe('faux/faux-1')
    await mu(['settings', 'reset', 'agent.model'])
    expect((await muJson(['settings'])).values['agent.model']).toBe(null)
    await expect(mu(['settings', 'set', 'agent.model', 'nope/nope'])).rejects.toThrow(/unknown choice/)

    await mu(['auth', 'key', 'anthropic'], 'sk-ant-test\n')
    expect((await muJson(['auth'])).find((p: any) => p.id === 'anthropic')).toMatchObject({ stored: true, auth: { type: 'api_key' } })
    await mu(['auth', 'logout', 'anthropic'])
    expect((await muJson(['auth'])).find((p: any) => p.id === 'anthropic').stored).toBe(false)
  })

  it('manages machines and works on them with -m', async () => {
    const via = `MU_HOME='${join(home, 'second')}' MU_MODEL=faux '${process.execPath}' '${CLI}' connect --start`
    expect(await mu(['machines', 'add', '--via', via, '--name', 'Second'])).toMatch(/Added Second \(/)
    const list = await muJson(['machines'])
    expect(list.map((m: any) => [m.label, m.state])).toEqual([['This computer', 'answers'], ['Second', 'answers']])

    const remote = await muJson(['new', '-m', 'second', '-p', 'over there'])
    expect(remote.machine).not.toBe('local')
    await until(async () => (await muJson(['sessions', '-m', 'Second']))[0]?.status.state === 'done')
    expect((await muJson(['sessions'])).some((s: any) => s.id === remote.id && s.title === 'over there')).toBe(false)

    await mu(['settings', 'set', 'agent.model', 'faux/faux-1', '--all'])
    expect((await muJson(['settings', '-m', 'Second'])).values['agent.model']).toBe('faux/faux-1')
    expect((await muJson(['settings'])).values['agent.model']).toBe('faux/faux-1')

    await mu(['machines', 'disable', 'Second'])
    expect((await muJson(['machines']))[1].state).toBe('disabled')
    await mu(['machines', 'rm', 'Second'])
    expect(await muJson(['machines'])).toHaveLength(1)
    await expect(mu(['sessions', '-m', 'Second'])).rejects.toThrow(/No machine called Second/)
  })

  it('restarts the daemon onto the installed code, keeping sessions', async () => {
    const before = await muJson(['daemon', 'status'])
    expect(before).toMatchObject({ running: true, current: true })
    const restarted = await muJson(['daemon', 'restart'])
    expect(restarted).toMatchObject({ restarted: true, from: before.build, build: before.build })
    const after = await muJson(['daemon', 'status'])
    expect(after.pid).not.toBe(before.pid)
    expect((await muJson(['sessions'])).some((s: any) => s.title === 'hi from the cli')).toBe(true)
  })

  it('stops the daemon', async () => {
    expect(await muJson(['daemon', 'stop'])).toMatchObject({ stopped: true })
    expect(await muJson(['daemon', 'status'])).toMatchObject({ running: false })
  })
})
