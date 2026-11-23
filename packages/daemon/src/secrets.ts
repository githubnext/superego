// The machine's secret store: the values of `secret` settings (an extension's API token, say), kept apart from
// settings.json so no snapshot, `superego settings` or agent reading the settings ever sees them.
//
// Where a value goes, tried in order as it's set:
//   - the OS keychain: macOS's (`security`), or the Secret Service on Linux (`secret-tool`, libsecret), when there is one
//     and it answers;
//   - else `<dataDir>/secrets.json`, encrypted (AES-256-GCM) with a key in `<dataDir>/secrets.key`, both 0600: the
//     headless Linux case, and a daemon told to keep secrets in its data folder (`secrets: 'file'`, `<ID>_SECRETS=file`).
// `secrets.json` is also the index: each key set, and where its value is. So whether a key is set is known without
// touching the keychain, and a key keeps reading from where it went even if a keychain appears or goes later.
//
// What it protects against: agents and tools that read settings, snapshots, `superego settings` or the data folder
// (the encrypted file reads as noise; Ego never reads it or the key), and a secret pasted into a transcript by accident.
// What it doesn't: a process running as the user that sets out to read it (from the keychain, which lets the same user
// read it with `security`/`secret-tool`, or the key file and the data). It's a lock against leaks, not a vault.
import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppConfig } from '@superego/protocol'
import type { SecretStore } from '@superego/settings'
import { writeAtomic, writeOnce } from './write-atomic.ts'

/** The files in the data folder that hold secrets, or what unlocks them: never for an agent to read. */
export const SECRET_FILES = ['secrets.json', 'secrets.key']

/** Where one key's value is. */
type Entry = { in: 'keychain' | 'secret-service' } | { in: 'file'; iv: string; tag: string; data: string }
type Index = { version: 1; secrets: Record<string, Entry> }

/** An OS keychain, as the store uses it: a value by its key, in a service of this data folder's own. */
export type Keychain = {
  name: 'keychain' | 'secret-service'
  set(key: string, value: string): Promise<void>
  get(key: string): Promise<string | undefined>
  delete(key: string): Promise<void>
}

/** How long a keychain command may take: one that waits on an unlock prompt nobody sees is given up on. */
const KEYCHAIN_LIMIT = 10_000

/** Run `command`, giving it `input`: its exit code and output. Rejects when it can't run (ENOENT) or takes too long. */
function run(command: string, args: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} didn't answer in ${KEYCHAIN_LIMIT / 1000}s`)) }, KEYCHAIN_LIMIT)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }) })
    // A command that exits before reading its input (one that failed at once) closes the pipe: its exit code says why.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/**
 * The keychain of this platform, if it has a kind we use. Values go in base64, so what the tools print back is always
 * text, and nothing about a value is ever on a command line (`ps` shows those): macOS's gets it on stdin, in its
 * interactive mode; `secret-tool` reads it from stdin.
 */
function systemKeychain(app: AppConfig, dataDir: string): Keychain | undefined {
  // One service per data folder: a test's or a second install's never mixes with yours.
  const service = `${app.id}-secrets-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`
  const decode = (text: string) => Buffer.from(text.trim(), 'base64').toString('utf8')
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64')
  if (process.platform === 'darwin') {
    const check = (what: string, result: { code: number; stderr: string }, ok = [0]) => {
      if (!ok.includes(result.code)) throw new Error(`security ${what} failed (${result.code}): ${result.stderr.trim()}`)
    }
    const keychain: Keychain = {
      name: 'keychain',
      async set(key, value) {
        // Keys are `<name>.<key>` and the service ours, base64 the value: nothing here needs quoting.
        const result = await run('security', ['-i'], `add-generic-password -U -s ${service} -a ${key} -w ${encode(value)}\n`)
        check('add-generic-password', result)
        if (result.stderr.trim()) throw new Error(`security add-generic-password failed: ${result.stderr.trim()}`)
        // Its interactive mode doesn't always say a command failed: read it back.
        if (await keychain.get(key) !== value) throw new Error("security add-generic-password didn't keep the value")
      },
      async get(key) {
        const result = await run('security', ['find-generic-password', '-s', service, '-a', key, '-w'])
        if (result.code === 44) return undefined
        check('find-generic-password', result)
        return decode(result.stdout)
      },
      async delete(key) { check('delete-generic-password', await run('security', ['delete-generic-password', '-s', service, '-a', key]), [0, 44]) },
    }
    return keychain
  }
  if (process.platform === 'linux') {
    const attributes = (key: string) => ['app', app.id, 'store', service, 'key', key]
    return {
      name: 'secret-service',
      async set(key, value) {
        const result = await run('secret-tool', ['store', `--label=${app.name}: ${key}`, ...attributes(key)], encode(value))
        if (result.code !== 0) throw new Error(`secret-tool store failed (${result.code}): ${result.stderr.trim()}`)
      },
      async get(key) {
        const result = await run('secret-tool', ['lookup', ...attributes(key)])
        // Not found is an exit code 1 with nothing said; anything said is a failure.
        if (result.code !== 0) {
          if (!result.stderr.trim()) return undefined
          throw new Error(`secret-tool lookup failed (${result.code}): ${result.stderr.trim()}`)
        }
        return decode(result.stdout)
      },
      async delete(key) {
        const result = await run('secret-tool', ['clear', ...attributes(key)])
        if (result.code !== 0 && result.stderr.trim()) throw new Error(`secret-tool clear failed (${result.code}): ${result.stderr.trim()}`)
      },
    }
  }
  return undefined
}

export type SecretsOptions = {
  app: AppConfig
  dataDir: string
  /** `system`: the OS keychain where there is one, else the encrypted file (the default); `file`: the file only. */
  where?: 'system' | 'file'
  /** The keychain to use instead of this platform's: for tests. */
  keychain?: Keychain
}

/** Where `secret` settings' values are: see the top of this file. */
export class FileSecretStore implements SecretStore {
  readonly path: string
  readonly keyPath: string
  #keychain: Keychain | undefined
  #index: Index
  /** Why secrets.json couldn't be read, if it couldn't: every use says so, rather than writing over it. */
  #broken: string | undefined
  /** Values read or set since the daemon started, so the keychain is asked once. */
  #cache = new Map<string, string>()
  #queue: Promise<unknown> = Promise.resolve()
  /** Said once: secrets go to the file because the keychain didn't take one. */
  #warned = false

  constructor({ app, dataDir, where = 'system', keychain }: SecretsOptions) {
    this.path = join(dataDir, 'secrets.json')
    this.keyPath = join(dataDir, 'secrets.key')
    this.#keychain = where === 'file' ? undefined : keychain ?? systemKeychain(app, dataDir)
    this.#index = { version: 1, secrets: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Index
      if (parsed?.version !== 1 || typeof parsed.secrets !== 'object' || !parsed.secrets) throw new Error('not a secret store this Superego reads')
      this.#index = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#broken = `${this.path} can't be read (${(error as Error).message}): move it aside to start over, which forgets every secret in it`
        console.error(`Secrets: ${this.#broken}`)
      }
    }
  }

  has(key: string) { return Object.hasOwn(this.#index.secrets, key) }
  keys() { return Object.keys(this.#index.secrets) }

  /** Where a key's value is (`keychain`, `secret-service` or `file`), if it's set: for tests and the docs' claims. */
  where(key: string) { return this.#index.secrets[key]?.in }

  async get(key: string): Promise<string | undefined> {
    this.#check()
    const entry = this.#index.secrets[key]
    if (!entry) return undefined
    const cached = this.#cache.get(key)
    if (cached !== undefined) return cached
    let value: string | undefined
    if (entry.in === 'file') value = await this.#decrypt(entry)
    else {
      if (!this.#keychain || this.#keychain.name !== entry.in) throw new Error(`The secret ${key} is in the ${entry.in}, which this daemon doesn't use: set it again`)
      value = await this.#keychain.get(key)
      if (value === undefined) throw new Error(`The secret ${key} is gone from the ${entry.in}: set it again`)
    }
    this.#cache.set(key, value)
    return value
  }

  set(key: string, value: string | undefined): Promise<void> {
    const work = this.#queue.then(async () => {
      this.#check()
      const before = this.#index.secrets[key]
      let entry: Entry | undefined
      if (value !== undefined) {
        if (this.#keychain) {
          try {
            await this.#keychain.set(key, value)
            entry = { in: this.#keychain.name }
          } catch (error) {
            // No keychain answering (a headless machine, a locked one): the file, said once.
            if (!this.#warned) console.warn(`Secrets: the ${this.#keychain.name} didn't take ${key}, so secrets go in ${this.path}, encrypted:`, (error as Error).message)
            this.#warned = true
          }
        }
        entry ??= await this.#encrypt(value)
      }
      const secrets = { ...this.#index.secrets }
      if (entry) secrets[key] = entry
      else delete secrets[key]
      await writeAtomic(this.path, JSON.stringify({ version: 1, secrets } satisfies Index, null, 2) + '\n')
      this.#index = { version: 1, secrets }
      if (value === undefined) this.#cache.delete(key)
      else this.#cache.set(key, value)
      // What the keychain kept of it before, when it's elsewhere now (or cleared).
      if (before && before.in !== 'file' && entry?.in !== before.in) {
        await this.#keychain?.delete(key).catch((error: Error) => console.error(`Secrets: removing ${key} from the ${before.in} failed:`, error.message))
      }
    })
    this.#queue = work.catch(() => {})
    return work
  }

  #check() { if (this.#broken) throw new Error(this.#broken) }

  /** The file's key: made the first time a secret goes in the file, 0600, and kept. */
  async #key(): Promise<Buffer> {
    const read = async () => Buffer.from((await readFile(this.keyPath, 'utf8')).trim(), 'base64')
    try { return await read() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeOnce(this.keyPath, randomBytes(32).toString('base64') + '\n')
    return read()
  }

  async #encrypt(value: string): Promise<Entry> {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', await this.#key(), iv)
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return { in: 'file', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
  }

  async #decrypt(entry: Extract<Entry, { in: 'file' }>): Promise<string> {
    try {
      const decipher = createDecipheriv('aes-256-gcm', await this.#key(), Buffer.from(entry.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8')
    } catch (error) {
      throw new Error(`A secret in ${this.path} can't be read with ${this.keyPath} (${(error as Error).message}): set it again`)
    }
  }
}
