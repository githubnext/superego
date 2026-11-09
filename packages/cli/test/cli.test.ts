import { execFile } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../../../app/bin/mu.ts', import.meta.url))
let home: string
const env = () => ({ ...process.env, MU_HOME: home, MU_HEADLESS: '1', MU_MODEL: 'faux', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' })

/** Run `mu` with `args`; resolves with stdout, rejects with stderr. */
function mu(args: string[], input?: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: env(), timeout: 30_000, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolve(stdout)
    })
    if (input !== undefined) child.stdin!.end(input)
  })
}
const muJson = async <T = any>(args: string[], input?: string, cwd?: string): Promise<T> => JSON.parse(await mu([...args, '--json'], input, cwd))
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
  it('starts the daemon on demand and runs threads', async () => {
    const created = await muJson(['create', home, '-p', 'hi from the cli'])
    expect(created).toMatchObject({ machine: 'local', cwd: home })
    await until(async () => (await muJson(['threads']))[0]?.status.state === 'done')
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

  it('lists actions and runs any of them with do', async () => {
    const actions = await muJson(['actions'])
    expect(actions.map((a: any) => a.id)).toEqual(expect.arrayContaining(['thread.create', 'thread.rename', 'ask-user.answer']))
    expect(await mu(['actions'])).toMatch(/thread\.rename\s+id title\s+Rename the thread/)
    const created = await muJson(['do', 'thread.create', '--title', 'via do'])
    await mu(['do', 'thread.rename', '--id', created.id, '--title', 'renamed via do'])
    expect((await muJson(['threads'])).find((s: any) => s.id === created.id).title).toBe('renamed via do')
    await mu(['do', 'thread.rename', `--params`, JSON.stringify({ id: created.id, title: 'from json' })])
    expect((await muJson(['threads'])).find((s: any) => s.id === created.id).title).toBe('from json')
    await expect(mu(['do', 'thread.rename', '--id', created.id])).rejects.toThrow(/title/)
    await expect(mu(['do', 'nope.nope'])).rejects.toThrow(/nope\.nope/)
    expect((await muJson(['actions', 'log'])).some((e: any) => e.id === 'thread.rename' && e.source === 'cli')).toBe(true)
  })

  it("makes a project's profile, loads its extensions in the real daemon, and asks again after an edit", async () => {
    mkdirSync(join(home, 'acme'), { recursive: true })
    const project = realpathSync(join(home, 'acme'))
    const made = await muJson(['profile', 'new', 'support'], undefined, project)
    expect(made.dir).toBe(join(project, '.mu', 'profiles', 'support'))
    expect(await muJson(['profile'], undefined, project)).toMatchObject([{ name: 'support', scope: 'project', allowed: true }])
    // A prompt and a tool, imported from 'mu' as a profile does: Node's loader in the daemon answers it.
    writeFileSync(join(made.dir, 'profile.ts'), `import { defineProfile } from 'mu'\nexport default defineProfile({ prompt: 'Answer customers.', extensions: ['./orders.ts'] })\n`)
    writeFileSync(join(made.dir, 'orders.ts'), `import { defineExtension, defineTool, obj, str } from 'mu'
export default defineExtension({ name: 'orders', tools: [defineTool({ name: 'find_order', label: 'Find order', description: 'Find an order.', parameters: obj({ number: str() }), async execute() { return { output: [{ type: 'text', text: 'shipped' }] } } })] })
`)
    await expect(mu(['create', project, '-P', 'support'])).rejects.toThrow(/allow/)
    await mu(['profile', 'allow', 'support'], undefined, project)
    const thread = await muJson(['create', project, '-P', 'support', '-p', 'hello'])
    expect(thread.profile).toMatchObject({ name: 'support', scope: 'project' })
    await until(async () => (await muJson(['threads'])).find((s: any) => s.id === thread.id)?.status.state === 'done')
  })

  it('manages machines and works on them with -m', async () => {
    const via = `MU_HOME='${join(home, 'second')}' MU_MODEL=faux '${process.execPath}' '${CLI}' connect --start`
    expect(await mu(['machines', 'add', '--via', via, '--name', 'Second'])).toMatch(/Added Second \(/)
    const list = await muJson(['machines'])
    expect(list.map((m: any) => [m.label, m.state])).toEqual([['This computer', 'answers'], ['Second', 'answers']])

    const remote = await muJson(['create', '-m', 'second', '-p', 'over there'])
    expect(remote.machine).not.toBe('local')
    await until(async () => (await muJson(['threads', '-m', 'Second']))[0]?.status.state === 'done')
    expect((await muJson(['threads'])).some((s: any) => s.id === remote.id && s.title === 'over there')).toBe(false)

    await mu(['settings', 'set', 'agent.model', 'faux/faux-1', '--all'])
    expect((await muJson(['settings', '-m', 'Second'])).values['agent.model']).toBe('faux/faux-1')
    expect((await muJson(['settings'])).values['agent.model']).toBe('faux/faux-1')

    await mu(['machines', 'disable', 'Second'])
    expect((await muJson(['machines']))[1].state).toBe('disabled')
    await mu(['machines', 'rm', 'Second'])
    expect(await muJson(['machines'])).toHaveLength(1)
    await expect(mu(['threads', '-m', 'Second'])).rejects.toThrow(/No machine called Second/)
  })

  it('restarts the daemon onto the installed code, keeping threads', async () => {
    const before = await muJson(['daemon', 'status'])
    expect(before).toMatchObject({ running: true, current: true })
    const restarted = await muJson(['daemon', 'restart'])
    expect(restarted).toMatchObject({ restarted: true, from: before.build, build: before.build })
    const after = await muJson(['daemon', 'status'])
    expect(after.pid).not.toBe(before.pid)
    expect((await muJson(['threads'])).some((s: any) => s.title === 'hi from the cli')).toBe(true)
  })

  it('stops the daemon', async () => {
    expect(await muJson(['daemon', 'stop'])).toMatchObject({ stopped: true })
    expect(await muJson(['daemon', 'status'])).toMatchObject({ running: false })
  })
})
