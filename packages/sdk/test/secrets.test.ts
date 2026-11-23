// An extension's secrets and its own folder, against a real daemon: a secret the user sets reaches the extension and
// nothing else (not a snapshot, `superego settings`, the action log, nor an agent's shell, which can't set one either);
// `superego.dir` is the extension's, only the user's, kept when the extension goes and listed then.
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ActionLogEntry, ExtensionsReport, SettingsSnapshot } from '@superego/protocol'
import { defineDaemonExtension, type DaemonApi } from '../src/index.ts'
import { callTool, say, testDaemon, type TestDaemon, type Turn } from '../src/testing.ts'

const CLI = join(import.meta.dirname, '../../../app/bin/superego.ts')
const SECRET = 'fmu1-hunter2-do-not-leak'
let dir: string
let daemon: TestDaemon | undefined
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-secrets-')) })
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  await rm(dir, { recursive: true, force: true })
})

/** What the extension heard: each change of its token, and what it read then. */
const heard: (string | undefined)[] = []
/** The vault's API, as its last set-up had it: to try it after teardown. */
let given: DaemonApi | undefined

/** An extension that asks for a token, reads it as it changes, and keeps a file in its own folder. */
const vault = defineDaemonExtension({
  name: 'vault', version: '1.0.0', api: '^5.8',
  async setup(superego) {
    given = superego
    superego.settings.register({ id: 'vault', title: 'Vault', settings: [
      { key: 'vault.token', title: 'Vault token', type: { type: 'secret', placeholder: 'fmu1-…' } },
    ] })
    superego.secrets.onChange('vault.token', () => { void superego.secrets.get('vault.token').then((token) => heard.push(token)) })
    superego.method('vault.check', async () => (await superego.secrets.get('vault.token')) === SECRET)
    // The user's consent isn't an extension's to give: its own secret, nor a setting that lets outside agents in.
    superego.method('vault.overreach', async () => Promise.all([
      superego.dispatch('secrets.set', { key: 'vault.token', value: 'mine' }),
      superego.dispatch('settings.set', { key: 'outside.startThreads', value: true }),
    ].map((p) => p.then(() => 'done', (error: { kind?: string }) => error.kind ?? 'failed'))))
    await writeFile(join(superego.dir, 'state.json'), JSON.stringify({ opened: true }))
    // Another extension's secret isn't this one's to read.
    await superego.secrets.get('email.token').then(() => { throw new Error('read email.token') }, (error: Error) => {
      if (!/reads its own secrets/.test(error.message)) throw error
    })
  },
})

/** A daemon with the vault in `dir`, run as `superego` so the command line in its threads' shells says whose it is. */
async function open(model: Turn[] = [], extensions = [vault]) {
  return daemon = await testDaemon({ dataDir: dir, model, extensions, appId: 'superego' } as Parameters<typeof testDaemon>[0])
}

/** The command line, reaching the test's daemon: a user's own terminal unless `thread` says whose shell it is in. */
const superego = (d: TestDaemon) => (args: string[], input = '') => new Promise<{ ok: boolean; out: string }>((resolve) => {
  const child = execFile(process.execPath, [CLI, ...args], {
    env: { ...process.env, SUPEREGO_HOME: dir, SUPEREGO_SOCKET: d.socket, SUPEREGO_THREAD: '' }, timeout: 60_000,
  }, (error, stdout, stderr) => resolve({ ok: !error, out: stdout + stderr }))
  child.stdin!.end(input)
})
/** The same, as an agent types it in its shell. */
const inShell = (args: string) => `SUPEREGO_HOME='${dir}' SUPEREGO_SOCKET="$(ls '${dir}'/d*.sock)" '${process.execPath}' '${CLI}' ${args} 2>&1`

it("gives an extension the secret the user sets, and no one else: not snapshots, the log, the command line or an agent's shell", { timeout: 180_000 }, async () => {
  const d = await open([
    callTool('bash', { command: `echo stolen | ${inShell('secrets set vault.token')}` }),
    callTool('bash', { command: inShell(`do secrets.set --params '${JSON.stringify({ key: 'vault.token', value: 'stolen' })}'`) }),
    callTool('bash', { command: inShell('settings') }),
    callTool('bash', { command: inShell('secrets --json') }),
    say('Done.'),
  ])
  heard.length = 0
  expect(await d.call('vault.check')).toBe(false)
  await d.setSecret('vault.token', SECRET)
  expect(await d.call('vault.check')).toBe(true)
  await d.until(() => heard.length === 1, 'the extension to hear its token')
  expect(heard).toEqual([SECRET])

  // An agent can't set it, and doesn't see it.
  const thread = await d.thread('try')
  const [pipe, dispatch, settings, list] = (await d.toolCalls(thread)).map((call) => call.result!.text)
  expect(pipe).toMatch(/Set a secret: that's the user's consent to give, not an agent's/)
  expect(dispatch).toMatch(/Set a secret: that's the user's consent to give, not an agent's/)
  expect(settings).toMatch(/vault\.token\s+set\s+Vault token/)
  expect(JSON.parse(list!)).toEqual([{ key: 'vault.token', title: 'Vault token', section: 'Vault', set: true }])
  expect(await d.call('vault.check')).toBe(true)

  // Nor does any client: a snapshot says it's set, and settings.set can't touch it.
  const { value } = await d.call<{ value: SettingsSnapshot }>('settings.watch', {})
  expect(value.values['vault.token']).toBe(true)
  expect(value.sections.find((s) => s.id === 'vault')!.settings[0]).toMatchObject({ type: 'secret', consent: true, default: false })
  await expect(d.dispatch('settings.set', { key: 'vault.token', value: `${SECRET}-by-mistake` })).rejects.toMatchObject({ kind: 'secret' })

  // The user, in their own terminal: from stdin, then cleared.
  const cli = superego(d)
  expect(await cli(['secrets', 'set', 'vault.token'], 'replaced-value\n')).toMatchObject({ ok: true, out: expect.stringContaining('vault.token set') })
  await d.until(() => heard.length === 2, 'the extension to hear the new token')
  expect(heard[1]).toBe('replaced-value')
  expect((await cli(['settings'])).out).toMatch(/vault\.token\s+set/)
  // Given as a setting, it's refused before it goes anywhere.
  expect(await cli(['settings', 'set', 'vault.token', 'typed-in-the-open'])).toMatchObject({ ok: false, out: expect.stringContaining('superego secrets set vault.token') })
  expect(await cli(['secrets', 'clear', 'vault.token'])).toMatchObject({ ok: true })
  expect((await cli(['secrets'])).out).toMatch(/vault\.token\s+not set/)
  await d.until(() => heard.length === 3, 'the extension to hear it cleared')
  expect(heard[2]).toBeUndefined()

  // Nor does an extension, for itself or for the user.
  expect(await d.call('vault.overreach')).toEqual(['consent', 'consent'])

  // Keys given in other ways are kept out of the log too.
  await d.dispatch('providers.save', { name: 'Mock', baseUrl: 'http://127.0.0.1:9/v1', key: `${SECRET}-provider`, models: ['m'] })

  // Nowhere a client or an agent reads: the log keeps •••, the settings file has nothing, the transcript neither.
  const log = await d.call<ActionLogEntry[]>('action.log', {})
  expect(log.filter((e) => e.id === 'secrets.set').map((e) => e.params)).toContainEqual({ key: 'vault.token', value: '•••' })
  expect(log.find((e) => e.id === 'providers.save')!.params).toMatchObject({ name: 'Mock', key: '•••' })
  const everywhere = [JSON.stringify(log), await d.transcript(thread), await readFile(join(dir, 'settings.json'), 'utf8').catch(() => ''), await readFile(join(dir, 'secrets.json'), 'utf8')].join('\n')
  expect(everywhere).not.toContain(SECRET)
  expect(everywhere).not.toContain('replaced-value')
  expect(everywhere).not.toContain('typed-in-the-open')
})

it("keeps an extension's own folder, only the user's, after the extension goes, and lists it then", { timeout: 60_000 }, async () => {
  // Made before, open to others (by hand, say): only the user's once the extension has it.
  const folder = join(dir, 'extensions', 'vault')
  await mkdir(folder, { recursive: true, mode: 0o755 })
  await chmod(folder, 0o755)
  const d = await open()
  expect((await stat(folder)).mode & 0o777).toBe(0o700)
  expect(JSON.parse(await readFile(join(folder, 'state.json'), 'utf8'))).toEqual({ opened: true })
  const report = await d.call<ExtensionsReport>('extension.inspect', {})
  expect(report.extensions.find((e) => e.name === 'vault')!.dir).toBe(folder)
  expect(report.folders).toBeUndefined()
  await d.close()
  // Torn down, it takes no more listeners; its folder is where it was.
  expect(() => given!.secrets.onChange('vault.token', () => {})).toThrow(/torn down/)
  expect(given!.dir).toBe(folder)

  // Gone (its profile removed, say): its folder stays, listed for the user to delete.
  const without = await open([], [])
  expect(JSON.parse(await readFile(join(folder, 'state.json'), 'utf8'))).toEqual({ opened: true })
  expect((await without.call<ExtensionsReport>('extension.inspect', {})).folders).toEqual([{ name: 'vault', dir: folder }])
  expect((await superego(without)(['extensions'])).out).toMatch(/Folders of extensions not set up here now[^\n]*\nvault {2}\(.*extensions\/vault\)/)
})
