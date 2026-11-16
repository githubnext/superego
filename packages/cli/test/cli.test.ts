import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { linkAuthorTypes } from './author-types.ts'

const CLI = fileURLToPath(new URL('../../../app/bin/superego.ts', import.meta.url))
let home: string
// SUPEREGO_APP: no app here, so daemons run from this checkout's source, never from whatever app/out last built.
const env = () => ({ ...process.env, SUPEREGO_HOME: home, SUPEREGO_APP: home, SUPEREGO_HEADLESS: '1', SUPEREGO_MODEL: 'faux', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', SUPEREGO_THREAD: '' })

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
/**
 * A test's time for the daemons it starts, from source (some 700 modules): under a second each on an idle machine, but
 * ten seconds and more on a busy one, where every file a process opens waits on the machine's file scanning.
 */
const starting = (daemons: number) => 20_000 + daemons * 20_000
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('timed out')
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'superego-cli-'))
  // The author types `profile new` links a profile to, there before any command waits on them.
  await linkAuthorTypes(home)
}, 240_000)
afterAll(async () => {
  // Each daemon, gone before its files are: one still shutting down writes as the folder is removed. All at once, so
  // their shutdowns overlap.
  await Promise.all([home, join(home, 'second'), join(home, 'third')].map(async (dir) => {
    const pid = Number(await readFile(join(dir, 'daemon.pid'), 'utf8').catch(() => '0'))
    if (!pid) return
    try { process.kill(pid) } catch { return }
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise((r) => setTimeout(r, 50))
    }
  }))
  await rm(home, { recursive: true, force: true })
})

describe('superego', () => {
  it('counts nothing unread without starting a daemon', async () => {
    const empty = join(home, 'empty')
    expect(await superego(['unread', '--count'], undefined, undefined, { SUPEREGO_HOME: empty })).toBe('0\n')
    expect(JSON.parse(await superego(['unread', '--json'], undefined, undefined, { SUPEREGO_HOME: empty }))).toEqual({ count: 0, threads: [] })
    expect(existsSync(join(empty, 'daemon.pid'))).toBe(false)
  })

  it('starts the daemon on demand and runs threads', async () => {
    const created = await superegoJson(['start', home, '-p', 'hi from the cli'])
    expect(created).toMatchObject({ machine: 'local', cwd: home })
    await until(async () => (await superegoJson(['threads']))[0]?.status.state === 'done')
    await superego(['send', created.id, 'again'])
    expect((await superego(['ls'])).split('\n')[0]).toContain('hi from the cli')
    expect(await superegoJson(['daemon', 'status'])).toMatchObject({ running: true })
  }, starting(1))

  it("reads a thread's last answer, waiting while it works, a message just sent too", async () => {
    const created = await superegoJson(['start', home, '-p', 'first question'])
    expect(await superegoJson(['read', created.id, '--wait'])).toMatchObject({ thread: { id: created.id, state: 'done' }, answer: 'echo: first question' })
    await superego(['send', created.id, 'second question'])
    // Right after the send: its answer to that, not the one before.
    expect(await superego(['read', created.id, '--wait'])).toMatch(/^\* done · first question\n\necho: second question\n$/)
    await expect(superego(['read', 'nope'])).rejects.toThrow(/No thread nope/)
  }, starting(1))

  it("prints a command's own usage with --help, and exits 0", async () => {
    const usage = await superego(['extension', 'test', '--help'])
    expect(usage).toMatch(/^Usage:\n {2}superego extension test \[extension\]/)
    expect(usage).toContain('--timeout <seconds>')
    expect(usage).not.toContain('machines')
    expect(await superego(['help', 'profile'])).toContain('superego profile new [name] [--user]')
    await expect(superego(['profile', 'bogus'])).rejects.toThrow(/See: superego profile --help/)
  })

  it('reads and changes settings, and stores API keys', async () => {
    await superego(['settings', 'set', 'agent.model', 'faux/faux-1'])
    expect((await superegoJson(['settings'])).values['agent.model']).toBe('faux/faux-1')
    await superego(['settings', 'reset', 'agent.model'])
    expect((await superegoJson(['settings'])).values['agent.model']).toBe(null)
    await expect(superego(['settings', 'set', 'agent.model', 'nope/nope'])).rejects.toThrow(/unknown choice/)

    await superego(['providers', 'key', 'anthropic'], 'sk-ant-test\n')
    expect((await superegoJson(['providers'])).find((p: any) => p.id === 'anthropic')).toMatchObject({ stored: true, auth: { type: 'api_key' } })
    await superego(['providers', 'sign-out', 'anthropic'])
    expect((await superegoJson(['providers'])).find((p: any) => p.id === 'anthropic').stored).toBe(false)
  })

  it('lists actions and runs any of them with do', async () => {
    const actions = await superegoJson(['actions'])
    expect(actions.map((a: any) => a.id)).toEqual(expect.arrayContaining(['thread.start', 'thread.rename', 'agent-ui.answer']))
    expect(await superego(['actions'])).toMatch(/thread\.rename\s+thread title\s+Rename the thread/)
    const created = await superegoJson(['do', 'thread.start', '--title', 'via do'])
    await superego(['do', 'thread.rename', '--thread', created.id, '--title', 'renamed via do'])
    expect((await superegoJson(['threads'])).find((s: any) => s.id === created.id).title).toBe('renamed via do')
    await superego(['do', 'thread.rename', `--params`, JSON.stringify({ thread: created.id, title: 'from json' })])
    expect((await superegoJson(['threads'])).find((s: any) => s.id === created.id).title).toBe('from json')
    await expect(superego(['do', 'thread.rename', '--thread', created.id])).rejects.toThrow(/title/)
    await expect(superego(['do', 'nope.nope'])).rejects.toThrow(/nope\.nope/)
    expect((await superegoJson(['actions', 'log'])).some((e: any) => e.id === 'thread.rename' && e.source === 'cli')).toBe(true)
  })

  it("makes a project's profile, loads its extensions in the real daemon, and asks again after an edit", async () => {
    mkdirSync(join(home, 'acme'), { recursive: true })
    const project = realpathSync(join(home, 'acme'))
    const made = await superegoJson(['profile', 'new', 'support'], undefined, project)
    expect(made.dir).toBe(join(project, '.superego', 'profiles', 'support'))
    expect(lstatSync(join(made.dir, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(await superegoJson(['profile'], undefined, project)).toMatchObject([{ name: 'support', scope: 'project', allowed: true }])
    // A prompt and a tool, imported from 'superego' as a profile does: Node's loader in the daemon answers it.
    writeFileSync(join(made.dir, 'profile.ts'), `import { defineProfile } from 'superego'\nexport default defineProfile({ prompt: 'Answer customers.', extensions: ['./orders.ts'] })\n`)
    writeFileSync(join(made.dir, 'orders.ts'), `import { defineExtension, defineTool, obj, str } from 'superego'
export default defineExtension({ name: 'orders', tools: [defineTool({ name: 'find_order', label: 'Find order', description: 'Find an order.', parameters: obj({ number: str() }), async execute() { return { output: [{ type: 'text', text: 'shipped' }] } } })] })
`)
    await expect(superego(['start', project, '-P', 'support'])).rejects.toThrow(/allow/)
    await superego(['profile', 'allow', 'support'], undefined, project)
    const thread = await superegoJson(['start', project, '-P', 'support', '-p', 'hello'])
    expect(thread.profile).toMatchObject({ name: 'support', scope: 'project' })
    await until(async () => (await superegoJson(['threads'])).find((s: any) => s.id === thread.id)?.status.state === 'done')
    // Its types again, as after a fresh clone: still allowed, since only its tsconfig.json was written.
    rmSync(join(made.dir, 'node_modules'))
    rmSync(join(made.dir, 'tsconfig.json'))
    expect(await superegoJson(['profile', 'types'], undefined, project)).toMatchObject([{ name: 'support', written: [join(made.dir, 'node_modules'), join(made.dir, 'tsconfig.json')] }])
    expect(existsSync(join(made.dir, 'tsconfig.json'))).toBe(true)
    expect(await superegoJson(['profile'], undefined, project)).toMatchObject([{ name: 'support', allowed: true }])
  })

  it("never gives the user's consent for an agent: run from a thread's shell, it's refused", async () => {
    mkdirSync(join(home, 'agent-made'), { recursive: true })
    const project = realpathSync(join(home, 'agent-made'))
    const agent = (args: string[]) => superego(args, undefined, project, { SUPEREGO_THREAD: 'agent-thread' })
    // Made, but not allowed: that waits for the user.
    expect(await agent(['profile', 'new', 'helper'])).toMatch(/runs only once the user allows it/)
    expect(await superegoJson(['profile'], undefined, project)).toMatchObject([{ name: 'helper', allowed: false }])
    await expect(agent(['profile', 'allow', 'helper'])).rejects.toThrow(/Allow a project profile to run: that's the user's consent to give, not an agent's/)
    await expect(agent(['do', 'profile.allow', '--cwd', project, '--name', 'helper'])).rejects.toThrow(/the user's consent/)
    await expect(agent(['profile', 'allow-ui', 'helper'])).rejects.toThrow(/the user's consent/)
    await expect(agent(['do', 'web.pair'])).rejects.toThrow(/the user's consent/)
    await expect(agent(['do', 'settings.set', '--key', 'outside.startThreads', '--value', 'true'])).rejects.toThrow(/Can start threads: that's the user's consent/)
    // The window's alone, from any command line.
    await expect(agent(['do', 'mcp-servers.allow', '--name', 'any'])).rejects.toThrow(/mcp-servers\.allow can't be run from cli/)
    await expect(superego(['do', 'mcp-servers.allow', '--name', 'any'])).rejects.toThrow(/mcp-servers\.allow can't be run from cli/)
    // What isn't consent, it does.
    await agent(['do', 'settings.set', '--params', JSON.stringify({ key: 'web.port', value: 7778 })])
    expect((await superegoJson(['actions', 'log'])).findLast((e: any) => e.id === 'profile.allow')).toMatchObject({ ok: false, client: { from: 'agent-thread' } })
    // The user, in their own terminal.
    await superego(['profile', 'allow', 'helper'], undefined, project)
    expect(await superegoJson(['profile'], undefined, project)).toMatchObject([{ name: 'helper', allowed: true }])
  }, starting(1))

  it('manages machines and works on them with -m', async () => {
    const via = `SUPEREGO_HOME='${join(home, 'second')}' SUPEREGO_MODEL=faux '${process.execPath}' '${CLI}' connect --start`
    expect(await superego(['machines', 'add', '--via', via, '--name', 'Second'])).toMatch(/Added Second \(/)
    // Gone however this ends (a timeout too), so the tests after it see only their own machines.
    onTestFinished(() => superego(['machines', 'rm', 'Second']).then(() => {}, () => {}))
    const list = await superegoJson(['machines'])
    expect(list.map((m: any) => [m.label, m.state])).toEqual([['This computer', 'answers'], ['Second', 'answers']])

    const remote = await superegoJson(['start', '-m', 'second', '-p', 'over there'])
    expect(remote.machine).not.toBe('local')
    await until(async () => (await superegoJson(['threads', '-m', 'Second']))[0]?.status.state === 'done')
    expect((await superegoJson(['threads'])).some((s: any) => s.id === remote.id && s.title === 'over there')).toBe(false)
    // Unread: this computer's, and the other machine's through this computer's daemon.
    await until(async () => (await superegoJson(['unread'])).threads.some((t: any) => t.id === remote.id))
    const unread = await superegoJson(['unread'])
    expect(unread.threads).toContainEqual({ machine: expect.not.stringMatching(/^local$/), id: remote.id, title: 'over there', state: 'done' })
    expect(unread.threads.some((t: any) => t.machine === 'local')).toBe(true)
    expect(await superego(['unread', '--count'])).toBe(`${unread.count}\n`)
    expect(unread.count).toBe(unread.threads.length)

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
  }, starting(1))

  it('says which Superego each machine runs, and updates one through its own command', async () => {
    // A machine behind a stub: it connects as `connect --start` does, and for `connect --update` says what an install
    // would and restarts its daemon, as install-machine.sh ends.
    const third = join(home, 'third')
    const run = `env SUPEREGO_HOME='${third}' SUPEREGO_MODEL=faux '${process.execPath}' '${CLI}'`
    const stub = join(home, 'machine.sh')
    writeFileSync(stub, `case "$*" in\n  *--update*) echo "pulling"; ${run} daemon restart; echo "Installed";;\n  *) exec ${run} connect --start;;\nesac\n`)
    await superego(['machines', 'add', '--via', `sh '${stub}' connect --start`, '--name', 'Third'])
    onTestFinished(() => superego(['machines', 'rm', 'Third']).then(() => {}, () => {}))
    const all = await superegoJson(['machines'])
    const here = all.find((m: any) => m.id === 'local'), there = all.find((m: any) => m.label === 'Third')
    expect(here.version).toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/), protocol: 2 })
    expect(there).toMatchObject({ drift: { state: 'current' } })
    expect(await superego(['machines'])).not.toContain('runs an')

    // One that says an older commit, and one that knows none (outside git).
    const older = fileURLToPath(new URL('./fixtures/older.mjs', import.meta.url))
    const behind = here.version.committedAt - 2 * 86_400_000
    await superego(['machines', 'add', '--via', `'${process.execPath}' '${older}' 5e9684c0ffee ${behind} sh '${stub}' connect --start`, '--name', 'Behind'])
    await superego(['machines', 'add', '--via', `'${process.execPath}' '${older}' none 0 sh '${stub}' connect --start`, '--name', 'Old'])
    const listed = await superego(['machines'])
    expect(listed).toMatch(/Behind .* runs an older Superego \(5e9684c, 2 days behind\)/)
    expect(listed).toMatch(/Old .* runs a Superego that doesn't know its commit/)
    await superego(['machines', 'rm', 'Behind'])
    await superego(['machines', 'rm', 'Old'])

    const before = (await superegoJson(['daemon', 'status'])).pid
    const updated = await superegoJson(['machines', 'update', 'Third'])
    expect(updated).toMatchObject({ updated: true, from: { commit: here.version.commit }, to: { commit: here.version.commit } })
    expect((await superegoJson(['daemon', 'status'])).pid).toBe(before)
    await expect(superego(['machines', 'update', 'local'])).rejects.toThrow(/updated by hand/)
    await superego(['machines', 'rm', 'Third'])
  }, starting(2))

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
    expect((await superegoJson(['providers'])).find((p: any) => p.id === 'anthropic')).toMatchObject({ auth: { source: 'ANTHROPIC_API_KEY' } })

    // Restarted from a shell with another key (`box run superego daemon restart` on a daemon the app started): both.
    await superego(['daemon', 'restart'], undefined, undefined, { OPENAI_API_KEY: 'sk-env' })
    const auth = await superegoJson(['providers'])
    expect(auth.find((p: any) => p.id === 'anthropic')).toMatchObject({ auth: { source: 'ANTHROPIC_API_KEY' } })
    expect(auth.find((p: any) => p.id === 'openai')).toMatchObject({ auth: { source: 'OPENAI_API_KEY' } })
  }, starting(3))

  it('marks threads waiting for sign-in, and says how to sign in again', async () => {
    // The scripted model rejects a key that starts with "reject", as Anthropic does one it doesn't know.
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ faux: { type: 'api_key', key: 'reject-me' } }))
    const created = await superegoJson(['start', home, '-p', 'are you there'])
    await until(async () => (await superegoJson(['threads'])).find((t: any) => t.id === created.id)?.status.kind === 'auth')
    const listed = await superego(['threads'])
    expect(listed).toMatch(new RegExp(`${created.id}\\s+~ waiting for sign-in`))
    expect(listed).toContain('faux rejected the API key')
    expect(listed).toContain('superego providers key faux')
    expect(await superego(['providers', 'retry', 'faux'])).toContain('Retrying 1 thread')
    // Signed in again: it goes on by itself.
    writeFileSync(join(home, 'auth.json'), JSON.stringify({}))
    await until(async () => (await superegoJson(['threads'])).find((t: any) => t.id === created.id)?.status.state === 'done')
    expect(await superego(['threads'])).not.toContain('rejected')
  })

  it('prints its skill: the overview, which lists every topic, and each topic', async () => {
    const overview = await superego(['--skill'])
    expect(overview).toMatch(/^---\nname: superego\ndescription: .+\n---\n/)
    const listed = [...overview.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]).sort()
    const pages = (await readdir(fileURLToPath(new URL('../skill/', import.meta.url)))).filter((f) => f.endsWith('.md') && f !== 'SKILL.md').map((f) => f.replace(/\.md$/, '')).sort()
    expect(listed).toEqual(pages)
    expect(await superego(['--skill', 'profiles'])).toMatch(/^# Profiles\n/)
    // The guide is one of them (skill.test.ts checks the pages link only to what ships beside them).
    expect(await superego(['--skill', 'guide'])).toMatch(/^# Writing extensions\n/)
    await expect(superego(['--skill', 'nope'])).rejects.toThrow(/Topics: bundled, cli/)
  })

  it('tells which profile extension commands act on: the one you are in, else the default, else how to pick', async () => {
    await superego(['extension', 'new', 'notes', '--user'])
    const profile = join(home, 'profiles', 'default')
    // In its folder (deep in it), no -P or --user needed.
    expect(await superego(['extension', 'reload'], undefined, join(profile, 'notes'))).toMatch(new RegExp(`^Profile default \\(yours, ${profile}\\): the one you're in\\.`))
    const tested = await superego(['extension', 'test', 'notes.test.ts'], undefined, join(profile, 'notes'))
    expect(tested).toMatch(/^Profile default \(yours, .*\): the one you're in/)
    expect(tested).toContain('passed')
    // Elsewhere, the folder's default; a profile that isn't there lists those that are.
    const project = join(home, 'project')
    mkdirSync(join(project, '.superego', 'profiles', 'lab'), { recursive: true })
    writeFileSync(join(project, '.superego', 'profiles', 'lab', 'profile.ts'), `export default {}\n`)
    expect(await superego(['extension', 'reload'], undefined, project)).toMatch(/: the folder's default\. Another: -P <name> --user/)
    const error = await superego(['extension', 'reload', '-P', 'nope'], undefined, project).then(() => '', (e: Error) => e.message)
    expect(error).toMatch(/No profile nope here or of yours\. The profiles here:\n {2}lab +project +.*lab\n {2}default +yours +/)
    expect(error).toContain('Pick one: superego extension reload -P <name> (yours: -P <name> --user)')
  }, starting(1) + 120_000)

  it('stops the daemon', async () => {
    expect(await superegoJson(['daemon', 'stop'])).toMatchObject({ stopped: true })
    expect(await superegoJson(['daemon', 'status'])).toMatchObject({ running: false })
  })
})
