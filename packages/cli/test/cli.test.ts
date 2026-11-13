import { execFile } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../../../app/bin/superego.ts', import.meta.url))
let home: string
// SUPEREGO_APP: no app here, so daemons run from this checkout's source, never from whatever app/out last built.
const env = () => ({ ...process.env, SUPEREGO_HOME: home, SUPEREGO_APP: home, SUPEREGO_HEADLESS: '1', SUPEREGO_MODEL: 'faux', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' })

/** Run `superego` with `args`; resolves with stdout, rejects with stderr. */
function superego(args: string[], input?: string, cwd?: string, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...env(), ...extraEnv }, timeout: 30_000, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolve(stdout)
    })
    if (input !== undefined) child.stdin!.end(input)
  })
}
const superegoJson = async <T = any>(args: string[], input?: string, cwd?: string): Promise<T> => JSON.parse(await superego([...args, '--json'], input, cwd))
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('timed out')
}

beforeAll(async () => { home = await mkdtemp(join(tmpdir(), 'superego-cli-')) })
afterAll(async () => {
  for (const dir of [home, join(home, 'second'), join(home, 'third')]) {
    const pid = Number(await readFile(join(dir, 'daemon.pid'), 'utf8').catch(() => '0'))
    if (pid) try { process.kill(pid) } catch {}
  }
  await rm(home, { recursive: true, force: true })
})

describe('superego', () => {
  it('starts the daemon on demand and runs threads', async () => {
    const created = await superegoJson(['create', home, '-p', 'hi from the cli'])
    expect(created).toMatchObject({ machine: 'local', cwd: home })
    await until(async () => (await superegoJson(['threads']))[0]?.status.state === 'done')
    await superego(['send', created.id, 'again'])
    expect((await superego(['ls'])).split('\n')[0]).toContain('hi from the cli')
    expect(await superegoJson(['daemon', 'status'])).toMatchObject({ running: true })
  })

  it('reads and changes settings, and stores API keys', async () => {
    await superego(['settings', 'set', 'agent.model', 'faux/faux-1'])
    expect((await superegoJson(['settings'])).values['agent.model']).toBe('faux/faux-1')
    await superego(['settings', 'reset', 'agent.model'])
    expect((await superegoJson(['settings'])).values['agent.model']).toBe(null)
    await expect(superego(['settings', 'set', 'agent.model', 'nope/nope'])).rejects.toThrow(/unknown choice/)

    await superego(['auth', 'key', 'anthropic'], 'sk-ant-test\n')
    expect((await superegoJson(['auth'])).find((p: any) => p.id === 'anthropic')).toMatchObject({ stored: true, auth: { type: 'api_key' } })
    await superego(['auth', 'logout', 'anthropic'])
    expect((await superegoJson(['auth'])).find((p: any) => p.id === 'anthropic').stored).toBe(false)
  })

  it('lists actions and runs any of them with do', async () => {
    const actions = await superegoJson(['actions'])
    expect(actions.map((a: any) => a.id)).toEqual(expect.arrayContaining(['thread.create', 'thread.rename', 'ask-user.answer']))
    expect(await superego(['actions'])).toMatch(/thread\.rename\s+id title\s+Rename the thread/)
    const created = await superegoJson(['do', 'thread.create', '--title', 'via do'])
    await superego(['do', 'thread.rename', '--id', created.id, '--title', 'renamed via do'])
    expect((await superegoJson(['threads'])).find((s: any) => s.id === created.id).title).toBe('renamed via do')
    await superego(['do', 'thread.rename', `--params`, JSON.stringify({ id: created.id, title: 'from json' })])
    expect((await superegoJson(['threads'])).find((s: any) => s.id === created.id).title).toBe('from json')
    await expect(superego(['do', 'thread.rename', '--id', created.id])).rejects.toThrow(/title/)
    await expect(superego(['do', 'nope.nope'])).rejects.toThrow(/nope\.nope/)
    expect((await superegoJson(['actions', 'log'])).some((e: any) => e.id === 'thread.rename' && e.source === 'cli')).toBe(true)
  })

  it("makes a project's profile, loads its extensions in the real daemon, and asks again after an edit", async () => {
    mkdirSync(join(home, 'acme'), { recursive: true })
    const project = realpathSync(join(home, 'acme'))
    const made = await superegoJson(['profile', 'new', 'support'], undefined, project)
    expect(made.dir).toBe(join(project, '.superego', 'profiles', 'support'))
    expect(await superegoJson(['profile'], undefined, project)).toMatchObject([{ name: 'support', scope: 'project', allowed: true }])
    // A prompt and a tool, imported from 'superego' as a profile does: Node's loader in the daemon answers it.
    writeFileSync(join(made.dir, 'profile.ts'), `import { defineProfile } from 'superego'\nexport default defineProfile({ prompt: 'Answer customers.', extensions: ['./orders.ts'] })\n`)
    writeFileSync(join(made.dir, 'orders.ts'), `import { defineExtension, defineTool, obj, str } from 'superego'
export default defineExtension({ name: 'orders', tools: [defineTool({ name: 'find_order', label: 'Find order', description: 'Find an order.', parameters: obj({ number: str() }), async execute() { return { output: [{ type: 'text', text: 'shipped' }] } } })] })
`)
    await expect(superego(['create', project, '-P', 'support'])).rejects.toThrow(/allow/)
    await superego(['profile', 'allow', 'support'], undefined, project)
    const thread = await superegoJson(['create', project, '-P', 'support', '-p', 'hello'])
    expect(thread.profile).toMatchObject({ name: 'support', scope: 'project' })
    await until(async () => (await superegoJson(['threads'])).find((s: any) => s.id === thread.id)?.status.state === 'done')
  })

  it('manages machines and works on them with -m', async () => {
    const via = `SUPEREGO_HOME='${join(home, 'second')}' SUPEREGO_MODEL=faux '${process.execPath}' '${CLI}' connect --start`
    expect(await superego(['machines', 'add', '--via', via, '--name', 'Second'])).toMatch(/Added Second \(/)
    const list = await superegoJson(['machines'])
    expect(list.map((m: any) => [m.label, m.state])).toEqual([['This computer', 'answers'], ['Second', 'answers']])

    const remote = await superegoJson(['create', '-m', 'second', '-p', 'over there'])
    expect(remote.machine).not.toBe('local')
    await until(async () => (await superegoJson(['threads', '-m', 'Second']))[0]?.status.state === 'done')
    expect((await superegoJson(['threads'])).some((s: any) => s.id === remote.id && s.title === 'over there')).toBe(false)

    await superego(['settings', 'set', 'agent.model', 'faux/faux-1', '--all'])
    expect((await superegoJson(['settings', '-m', 'Second'])).values['agent.model']).toBe('faux/faux-1')
    expect((await superegoJson(['settings'])).values['agent.model']).toBe('faux/faux-1')

    // Its profile's UI runs in this computer's window only once allowed here, for exactly what it is now.
    const ui = join(home, 'second', 'profiles', 'default', 'ui')
    mkdirSync(ui, { recursive: true })
    writeFileSync(join(home, 'second', 'profiles', 'default', 'profile.ts'), `import { defineProfile } from 'superego'\nexport default defineProfile({ ui: ['./ui/badge.ts'] })\n`)
    writeFileSync(join(ui, 'badge.ts'), `import { label } from './label.ts'\nexport default { name: 'badge', setup() { console.log(label) } }\n`)
    writeFileSync(join(ui, 'label.ts'), `export const label: string = 'one'\n`)
    await expect(superego(['profile', 'allow-ui', 'default'])).rejects.toThrow(/-m <machine>/)
    const allowed = await superegoJson(['profile', 'allow-ui', 'default', '-m', 'Second'])
    expect(allowed).toMatchObject({ profile: { name: 'default', scope: 'user' }, files: [{ path: 'ui/badge.ts' }, { path: 'ui/label.ts' }] })
    const kept = async () => JSON.parse(await readFile(join(home, 'ui-allowed.json'), 'utf8'))
    expect(await kept()).toMatchObject([{ machine: allowed.machine, hash: allowed.hash }])
    writeFileSync(join(ui, 'label.ts'), `export const label: string = 'two'\n`)
    expect((await superegoJson(['profile', 'allow-ui', 'default', '-m', 'Second'])).hash).not.toBe(allowed.hash)
    expect(await kept()).toHaveLength(1)
    await superego(['profile', 'revoke-ui', 'default', '-m', 'Second'])
    expect(await kept()).toEqual([])
    await superego(['profile', 'allow-ui', 'default', '-m', 'Second'])

    await superego(['machines', 'disable', 'Second'])
    expect((await superegoJson(['machines']))[1].state).toBe('disabled')
    await superego(['machines', 'rm', 'Second'])
    expect(await superegoJson(['machines'])).toHaveLength(1)
    expect(await kept()).toEqual([])
    await expect(superego(['threads', '-m', 'Second'])).rejects.toThrow(/No machine called Second/)
  })

  it('says which Superego each machine runs, and updates one through its own command', async () => {
    // A machine behind a stub: it connects as `connect --start` does, and for `connect --update` says what an install
    // would and restarts its daemon, as install-machine.sh ends.
    const third = join(home, 'third')
    const run = `env SUPEREGO_HOME='${third}' SUPEREGO_MODEL=faux '${process.execPath}' '${CLI}'`
    const stub = join(home, 'machine.sh')
    writeFileSync(stub, `case "$*" in\n  *--update*) echo "pulling"; ${run} daemon restart; echo "Installed";;\n  *) exec ${run} connect --start;;\nesac\n`)
    await superego(['machines', 'add', '--via', `sh '${stub}' connect --start`, '--name', 'Third'])
    const [here, there] = await superegoJson(['machines'])
    expect(here.version).toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/), protocol: 1 })
    expect(there).toMatchObject({ drift: { state: 'current' } })
    expect(await superego(['machines'])).not.toContain('runs an')

    // One that says an older commit, and one too old to say any.
    const older = fileURLToPath(new URL('./fixtures/older.mjs', import.meta.url))
    const behind = here.version.committedAt - 2 * 86_400_000
    await superego(['machines', 'add', '--via', `'${process.execPath}' '${older}' 5e9684c0ffee ${behind} sh '${stub}' connect --start`, '--name', 'Behind'])
    await superego(['machines', 'add', '--via', `'${process.execPath}' '${older}' none 0 sh '${stub}' connect --start`, '--name', 'Old'])
    const listed = await superego(['machines'])
    expect(listed).toMatch(/Behind .* runs an older Superego \(5e9684c, 2 days behind\)/)
    expect(listed).toMatch(/Old .* runs an older Superego that doesn't say which/)
    await superego(['machines', 'rm', 'Behind'])
    await superego(['machines', 'rm', 'Old'])

    const before = (await superegoJson(['daemon', 'status'])).pid
    const updated = await superegoJson(['machines', 'update', 'Third'])
    expect(updated).toMatchObject({ updated: true, from: { commit: here.version.commit }, to: { commit: here.version.commit } })
    expect((await superegoJson(['daemon', 'status'])).pid).toBe(before)
    await expect(superego(['machines', 'update', 'local'])).rejects.toThrow(/updated by hand/)
    await superego(['machines', 'rm', 'Third'])
  })

  it('restarts the daemon onto the installed code, keeping threads and its environment', async () => {
    // Started with a key in its environment (as by `box run superego daemon restart`); restarted from a client without one.
    await superego(['daemon', 'stop'])
    await superego(['daemon', 'restart'], undefined, undefined, { ANTHROPIC_API_KEY: 'sk-ant-env' })
    const before = await superegoJson(['daemon', 'status'])
    expect(before).toMatchObject({ running: true, current: true })
    const restarted = await superegoJson(['daemon', 'restart'])
    expect(restarted).toMatchObject({ restarted: true, from: before.build, build: before.build })
    const after = await superegoJson(['daemon', 'status'])
    expect(after.pid).not.toBe(before.pid)
    expect((await superegoJson(['threads'])).some((s: any) => s.title === 'hi from the cli')).toBe(true)
    expect((await superegoJson(['auth'])).find((p: any) => p.id === 'anthropic')).toMatchObject({ auth: { source: 'ANTHROPIC_API_KEY' } })

    // Restarted from a shell with another key (`box run superego daemon restart` on a daemon the app started): both.
    await superego(['daemon', 'restart'], undefined, undefined, { OPENAI_API_KEY: 'sk-env' })
    const auth = await superegoJson(['auth'])
    expect(auth.find((p: any) => p.id === 'anthropic')).toMatchObject({ auth: { source: 'ANTHROPIC_API_KEY' } })
    expect(auth.find((p: any) => p.id === 'openai')).toMatchObject({ auth: { source: 'OPENAI_API_KEY' } })
  })

  it('marks threads waiting for sign-in, and says how to sign in again', async () => {
    // The scripted model rejects a key that starts with "reject", as Anthropic does one it doesn't know.
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ faux: { type: 'api_key', key: 'reject-me' } }))
    const created = await superegoJson(['create', home, '-p', 'are you there'])
    await until(async () => (await superegoJson(['threads'])).find((t: any) => t.id === created.id)?.status.kind === 'auth')
    const listed = await superego(['threads'])
    expect(listed).toMatch(new RegExp(`${created.id}\\s+~ waiting for sign-in`))
    expect(listed).toContain('faux rejected the API key')
    expect(listed).toContain('superego auth key faux')
    expect(await superego(['auth', 'retry', 'faux'])).toContain('Retrying 1 thread')
    // Signed in again: it goes on by itself.
    writeFileSync(join(home, 'auth.json'), JSON.stringify({}))
    await until(async () => (await superegoJson(['threads'])).find((t: any) => t.id === created.id)?.status.state === 'done')
    expect(await superego(['threads'])).not.toContain('rejected')
  })

  it('prints its skill: the overview, which lists every topic, and each topic', async () => {
    const overview = await superego(['--skill'])
    expect(overview).toMatch(/^---\nname: superego\ndescription: .+\n---\n/)
    const listed = [...overview.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]).sort()
    const pages = (await readdir(fileURLToPath(new URL('../skill/', import.meta.url)))).filter((f) => f !== 'SKILL.md').map((f) => f.replace(/\.md$/, '')).sort()
    expect(listed).toEqual(pages)
    expect(await superego(['--skill', 'profiles'])).toMatch(/^# Profiles\n/)
    await expect(superego(['--skill', 'nope'])).rejects.toThrow(/Topics: bundled, cli/)
  })

  it('stops the daemon', async () => {
    expect(await superegoJson(['daemon', 'stop'])).toMatchObject({ stopped: true })
    expect(await superegoJson(['daemon', 'status'])).toMatchObject({ running: false })
  })
})
