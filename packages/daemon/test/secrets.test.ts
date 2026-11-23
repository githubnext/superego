// The machine's secret store (secrets.ts): the OS keychain where it takes a value, else an encrypted file in the data
// folder, only the user's; whichever it is, where each key went is kept, and nothing about a value is in the clear.
import { readFile, stat, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineApp } from '@superego/protocol'
import { FileSecretStore, type Keychain } from '../src/secrets.ts'

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
  expect(warn.mock.calls[0]!.join(' ')).toMatch(/didn't take mail\.token.*D-Bus/)
  warn.mockRestore()

  for (const file of ['secrets.json', 'secrets.key']) {
    expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(dir, file), 'utf8')).not.toContain('hush')
  }
  // The index says what's set, not what it is.
  expect(JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')).secrets['mail.token']).toMatchObject({ in: 'file' })

  const again = new FileSecretStore({ app, dataDir: dir, where: 'file' })
  expect(again.has('mail.token')).toBe(true)
  expect(again.keys()).toEqual(['mail.token'])
  expect(await again.get('mail.token')).toBe('fmu1-hush-hush')
  await again.set('mail.token', undefined)
  expect(again.has('mail.token')).toBe(false)
  expect(await again.get('mail.token')).toBeUndefined()
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
