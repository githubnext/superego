// The machine's secret store (secrets.ts): the OS keychain where it takes a value, else an encrypted file in the data
// folder, only the user's; whichever it is, where each key went is kept, and nothing about a value is in the clear.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { defineApp } from '@superego/protocol'
import { FileSecretStore, systemKeychain, type Keychain } from '../src/secrets.ts'

const app = defineApp({ name: 'Superego test', id: 'superego-test' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-secrets-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** A keychain in memory; `fails`: one that refuses every write (none answering, or locked). */
function fakeKeychain(fails = false): Keychain & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    name: 'secret-service', values,
    async set(key, value) { if (fails) throw new Error('Cannot autolaunch D-Bus without X11 $DISPLAY'); values.set(key, value) },
    async get(key) { return values.get(key) },
    async delete(key) { values.delete(key) },
  }
}

it('keeps a secret encrypted in the data folder when there is no keychain, only the user\'s, across a restart', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = new FileSecretStore({ app, dataDir: dir, keychain: fakeKeychain(true) })
  await store.set('mail.token', 'fmu1-hush-hush')
  expect(store.where('mail.token')).toBe('file')
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls[0]!.join(' ')).toMatch(/secret-service didn't take a secret.*D-Bus/)
  warn.mockRestore()

  for (const file of ['secrets.json', 'secrets.key']) {
    expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(dir, file), 'utf8')).not.toContain('hush')
  }
  // The index says what's set, not what it is.
  expect(JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')).secrets['mail.token']).toMatchObject({ in: 'file' })

  const again = new FileSecretStore({ app, dataDir: dir, where: 'file' })
  expect(again.has('mail.token')).toBe(true)
  expect(await again.get('mail.token')).toBe('fmu1-hush-hush')
  await again.set('mail.token', undefined)
  expect(again.has('mail.token')).toBe(false)
  expect(await again.get('mail.token')).toBeUndefined()
})

it("says a secret in the file can't be read once its key is gone, and makes no new key reading it", async () => {
  const store = new FileSecretStore({ app, dataDir: dir, where: 'file' })
  await store.set('mail.token', 'fmu1-hush-hush')
  await rm(join(dir, 'secrets.key'))
  const again = new FileSecretStore({ app, dataDir: dir, where: 'file' })
  await expect(again.get('mail.token')).rejects.toThrow(/can't be read with .*secrets\.key.*set it again/)
  await expect(stat(join(dir, 'secrets.key'))).rejects.toMatchObject({ code: 'ENOENT' })
  // Set again, it's read again.
  await again.set('mail.token', 'fmu1-anew')
  expect(await new FileSecretStore({ app, dataDir: dir, where: 'file' }).get('mail.token')).toBe('fmu1-anew')
})

it('puts a secret in the keychain when it takes it, and takes it out when it goes elsewhere or is cleared', async () => {
  const keychain = fakeKeychain()
  const store = new FileSecretStore({ app, dataDir: dir, keychain })
  await store.set('mail.token', 'in-the-keychain')
  expect(store.where('mail.token')).toBe('secret-service')
  expect(keychain.values.get('mail.token')).toBe('in-the-keychain')
  expect(await readFile(join(dir, 'secrets.json'), 'utf8')).not.toContain('in-the-keychain')
  // Read from the keychain by a daemon started again.
  expect(await new FileSecretStore({ app, dataDir: dir, keychain }).get('mail.token')).toBe('in-the-keychain')
  // A daemon told to keep secrets in the file can't read one in the keychain: it says so.
  await expect(new FileSecretStore({ app, dataDir: dir, where: 'file' }).get('mail.token')).rejects.toThrow(/in the secret-service, which this daemon doesn't use: set it again/)
  // Set again where the keychain doesn't take it: in the file now, and gone from the keychain.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const locked = new FileSecretStore({ app, dataDir: dir, keychain: Object.assign(fakeKeychain(true), { values: keychain.values, delete: keychain.delete }) })
  await locked.set('mail.token', 'moved')
  vi.restoreAllMocks()
  expect(locked.where('mail.token')).toBe('file')
  expect(keychain.values.size).toBe(0)
  expect(await locked.get('mail.token')).toBe('moved')
})

it('says why, rather than writing over it, when secrets.json can\'t be read', async () => {
  await writeFile(join(dir, 'secrets.json'), '{ not json')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const store = new FileSecretStore({ app, dataDir: dir, where: 'file' })
  expect(error).toHaveBeenCalledWith(expect.stringMatching(/secrets\.json can't be read/))
  error.mockRestore()
  await expect(store.set('mail.token', 'x')).rejects.toThrow(/can't be read .*move it aside/)
  expect(await readFile(join(dir, 'secrets.json'), 'utf8')).toBe('{ not json')
})

it('never caches a value read before it was replaced', async () => {
  const keychain = fakeKeychain()
  await new FileSecretStore({ app, dataDir: dir, keychain }).set('mail.token', 'old')
  // A read that the keychain answers only after the value is replaced.
  let answer!: () => void
  const get = keychain.get.bind(keychain)
  keychain.get = async (key) => { const value = await get(key); await new Promise<void>((resolve) => { answer = resolve }); return value }
  const store = new FileSecretStore({ app, dataDir: dir, keychain })
  const reading = store.get('mail.token')
  await new Promise((resolve) => setTimeout(resolve, 10))
  await store.set('mail.token', 'new')
  answer()
  expect(await reading).toBe('old')
  expect(await store.get('mail.token')).toBe('new')
})

it("stops asking a keychain that didn't take a secret, for the rest of the run, and says where secrets went", async () => {
  const keychain = fakeKeychain(true)
  let asked = 0
  const set = keychain.set.bind(keychain)
  keychain.set = (key, value) => { asked++; return set(key, value) }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = new FileSecretStore({ app, dataDir: dir, keychain })
  await store.set('a.token', 'one')
  await store.set('b.token', 'two')
  expect(asked).toBe(1)
  expect(warn).toHaveBeenCalledTimes(1)
  warn.mockRestore()
  expect(store.about('b.token')).toMatch(/^Kept encrypted in .*secrets\.json: the secret-service didn't take a secret/)
  expect(store.about('c.token')).toBeUndefined()
})

/**
 * Fakes of macOS's `security` and Linux's `secret-tool` on PATH, keeping items as files, and noting each call (its
 * arguments, and how long the input was) in `calls`.
 */
async function fakeTools() {
  const bin = join(dir, 'bin')
  const items = join(dir, 'items')
  await mkdir(bin)
  await mkdir(items)
  const head = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2), input = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, JSON.stringify({ args, input: input.length }) + '\\n')
const item = (...parts) => path.join(${JSON.stringify(items)}, parts.join('~'))
const at = (flag) => args[args.lastIndexOf(flag) + 1]
`
  await writeFile(join(bin, 'security'), head + `
if (args[0] === '-i') {
  const words = input.trim().split(' ')
  if (input.length > 4096) { process.stderr.write('unknown command "' + input.slice(4095, 4120) + '"'); process.exit(1) }
  fs.writeFileSync(item(words[words.indexOf('-s') + 1], words[words.indexOf('-a') + 1]), words[words.indexOf('-w') + 1])
} else if (args[0] === 'find-generic-password') {
  if (!fs.existsSync(item(at('-s'), at('-a')))) process.exit(44)
  process.stdout.write(fs.readFileSync(item(at('-s'), at('-a')), 'utf8') + '\\n')
} else if (args[0] === 'delete-generic-password') {
  if (!fs.existsSync(item(at('-s'), at('-a')))) process.exit(44)
  fs.rmSync(item(at('-s'), at('-a')))
}
`)
  await writeFile(join(bin, 'secret-tool'), head + `
const file = item(at('app'), at('store'), at('key'))
if (args[0] === 'store') fs.writeFileSync(file, input)
else if (args[0] === 'lookup') { if (!fs.existsSync(file)) process.exit(1); process.stdout.write(fs.readFileSync(file, 'utf8')) }
else if (args[0] === 'clear') fs.rmSync(file, { force: true })
`)
  await chmod(join(bin, 'security'), 0o755)
  await chmod(join(bin, 'secret-tool'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  onTestFinished(() => { process.env.PATH = path })
  const calls = async () => (await readFile(join(dir, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; input: number })
  return { calls }
}

it("uses macOS's security with the value only on stdin, and never gives it one too long for its command line", async () => {
  const { calls } = await fakeTools()
  const store = new FileSecretStore({ app, dataDir: dir, keychain: systemKeychain(app, dir, 'darwin') })
  await store.set('mail.token', 'fmu1-short')
  expect(store.where('mail.token')).toBe('keychain')
  expect(await new FileSecretStore({ app, dataDir: dir, keychain: systemKeychain(app, dir, 'darwin') }).get('mail.token')).toBe('fmu1-short')
  const long = 'x'.repeat(3_500)
  const said = vi.spyOn(console, 'warn')
  await store.set('mail.jwt', long)
  expect(store.where('mail.jwt')).toBe('file')
  // Not given to it, so it never cut it short, kept a piece of it or said one: and the keychain is still used.
  expect(said).not.toHaveBeenCalled()
  said.mockRestore()
  expect((await calls()).every((call) => call.input < 4000)).toBe(true)
  expect(JSON.stringify(await calls())).not.toContain('fmu1-short')
  await store.set('mail.other', 'still-the-keychain')
  expect(store.where('mail.other')).toBe('keychain')
  await store.set('mail.token', undefined)
  expect((await calls()).at(-1)!.args.slice(0, 1)).toEqual(['delete-generic-password'])
})

it("uses secret-tool with the value only on stdin: stored, looked up, not found, cleared", async () => {
  const { calls } = await fakeTools()
  const keychain = systemKeychain(app, dir, 'linux')!
  expect(await keychain.get('mail.token')).toBeUndefined()
  const store = new FileSecretStore({ app, dataDir: dir, keychain })
  await store.set('mail.token', 'fmu1-linux')
  expect(store.where('mail.token')).toBe('secret-service')
  expect(await new FileSecretStore({ app, dataDir: dir, keychain }).get('mail.token')).toBe('fmu1-linux')
  expect((await calls()).find((call) => call.args[0] === 'store')!.args).toEqual(['store', '--label=Superego test: mail.token', 'app', 'superego-test', 'store', expect.stringMatching(/^superego-test-secrets-/), 'key', 'mail.token'])
  expect(JSON.stringify(await calls())).not.toContain('fmu1-linux')
  await store.set('mail.token', undefined)
  expect(await keychain.get('mail.token')).toBeUndefined()
})

