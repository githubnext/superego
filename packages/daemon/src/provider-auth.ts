// Providers that rejected this machine's credentials: telling such a failure from any other (`authFailure`), what
// to call it, and which providers are rejected and which threads wait on them (`Rejections`). Kept in the data dir, so
// a restart neither forgets them nor starts asking a provider that will only say no again.
import { readFileSync } from 'node:fs'
import type { ProviderRejection } from '@superego/protocol'
import { writeQueue } from './write-atomic.ts'

/** What a turn refused without asking the provider says: it reads as an auth failure like the one that started it. */
export const WAITING = 'Waiting for sign-in:'

/**
 * Whether a run's error says the provider refused its credentials: an invalid, expired or revoked key or token, a
 * sign-in that couldn't be renewed, or none to give it. Anthropic's and OpenAI's shapes, pi's own wording for auth it
 * couldn't resolve, and gateways'. Rate limits, overload and plain 403s (a model or region not allowed) are not.
 */
export function authFailure(error: string | undefined): boolean {
  if (!error) return false
  // A refresh that failed counts only when the token endpoint refused the token: one it couldn't reach, that timed
  // out or failed itself (a 5xx) is the network's, and the run fails as any other error does.
  if (REFRESH.test(error)) return REFUSED.test(error)
  return AUTH.some((pattern) => pattern.test(error))
}

const REFRESH = /\b(?:OAuth|token) refresh\b/i
/** A token endpoint refusing a refresh token: OAuth's invalid_grant (expired, revoked, reused), or a 401. */
const REFUSED = /\binvalid_grant\b|\b(?:invalid_token|unauthorized_client|refresh_token_(?:reused|expired|invalid|revoked))\b|\bfailed \(401\)|\bstatus=401\b|\brefresh token (?:\w+ )?(?:is |has been |was )?(?:expired|revoked|invalid|not found)\b/i

const AUTH = [
  // Anthropic: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}
  /authentication_error/i,
  // invalid x-api-key, invalid_api_key (OpenAI's code), Invalid API key
  /\binvalid[ _-]?(?:x-)?api[ _-]?key\b/i,
  // OpenAI: 401 Incorrect API key provided: sk-…
  /\bincorrect api key\b/i,
  /\bapi key (?:is )?(?:invalid|expired|revoked|not valid)\b/i,
  // "OAuth token has expired", "Your authentication token has been invalidated", "credentials have been revoked"
  /\b(?:token|key|credentials?) (?:has |have )?(?:expired|been revoked|been invalidated)\b/i,
  /\b(?:token_expired|invalid_token|expired_token|token_revoked)\b/i,
  // A gateway's: 503 credential validation failed
  /\bcredential validation failed\b/i,
  // pi resolving auth before the request: a refresh that failed, a key it couldn't read, nothing to sign in with.
  /\bOAuth auth derivation failed\b/i,
  /\bAPI key auth failed for provider\b/i,
  /\bProvider is not configured\b/i,
  // A bare 401, however the provider words the rest.
  /^\s*401\b/, /\bstatus(?: code)?:? 401\b/i, /\(401\)/,
  new RegExp(`^${WAITING}`),
]

/** What happened, in a few words, by how the provider was signed in (`type`) and what it said. */
export function rejectionSummary(name: string, type: 'api_key' | 'oauth' | undefined, error: string) {
  if (/\bProvider is not configured\b/i.test(error)) return `${name} isn't signed in`
  if (/\b(?:OAuth|token) refresh\b/i.test(error)) return `Couldn't renew the sign-in to ${name}`
  return type === 'oauth' ? `${name} rejected the sign-in` : type === 'api_key' ? `${name} rejected the API key` : `${name} rejected the credentials`
}

type Rejection = Omit<ProviderRejection, 'threads'> & {
  /** The waiting threads, each with the task its run failed in: a later run of it, failed or not, ends its wait. */
  threads: Record<string, number>
  /** What the credentials were when they were rejected (a hash): changed while the daemon was down, they're retried. */
  credential: string
}

/** Rejected providers and the threads waiting on them, kept in `path`. */
export class Rejections {
  readonly #write: (text: string) => Promise<void>
  readonly #listeners = new Set<() => void>()
  #all = new Map<string, Rejection>()
  constructor(path: string) {
    this.#write = writeQueue(path)
    try {
      for (const rejection of JSON.parse(readFileSync(path, 'utf8')) as Rejection[]) this.#all.set(rejection.provider, rejection)
    } catch { /* none kept, or unreadable: none rejected */ }
  }

  /** Whether turns for `provider` are refused without asking it: rejected, and not being retried. */
  blocks(provider: string) {
    const rejection = this.#all.get(provider)
    return Boolean(rejection && !rejection.retrying)
  }
  get(provider: string): Readonly<Rejection> | undefined { return this.#all.get(provider) }
  all(): readonly Readonly<Rejection>[] { return [...this.#all.values()] }

  /**
   * A run of `thread` failed in task `task` for its credentials: it waits on `provider`, rejected since now unless it
   * was already (a rejection being retried starts over).
   */
  fail(provider: string, thread: string, task: number, about: Pick<Rejection, 'name' | 'summary' | 'detail' | 'credential'>) {
    let rejection = this.#all.get(provider)
    if (!rejection || rejection.retrying) this.#all.set(provider, rejection = { provider, ...about, since: Date.now(), threads: {} })
    for (const other of this.#all.values()) if (other !== rejection) delete other.threads[thread]
    rejection.threads[thread] = task
    this.#changed()
  }

  /** What `thread` waits on, if its run failed in `task` and still waits; anything else of it ends the wait. */
  waiting(thread: string, task: number | undefined): Readonly<Rejection> | undefined {
    for (const rejection of this.#all.values()) if (task !== undefined && rejection.threads[thread] === task) return rejection
    return undefined
  }

  /** `thread` no longer waits (a later run started, it answered, or it's gone). */
  release(thread: string) {
    let changed = false
    for (const rejection of this.#all.values()) {
      if (!(thread in rejection.threads)) continue
      delete rejection.threads[thread]
      changed = true
    }
    if (changed) this.#changed()
  }

  /** Start retrying `provider`: turns for it go to it again. The rejection retried, to `settle` once they're on their way. */
  retry(provider: string): Readonly<Rejection> | undefined {
    const rejection = this.#all.get(provider)
    if (!rejection || rejection.retrying) return undefined
    rejection.retrying = true
    this.#changed()
    return rejection
  }

  /** The retry of `rejection` is under way: it's gone, unless a turn was rejected again meanwhile (and started another). */
  settle(rejection: Readonly<Rejection>) {
    if (this.#all.get(rejection.provider) !== rejection) return
    this.#all.delete(rejection.provider)
    this.#changed()
  }

  /** Written in turn, each as things are when it's written. */
  #saving: Promise<void> = Promise.resolve()
  #changed() {
    this.#saving = this.#write(JSON.stringify(this.all(), null, 2))
      .catch((error: Error) => console.error(`Keeping rejected providers: ${error.message}`))
    for (const listener of this.#listeners) listener()
  }
  /** Once what's changed is written. */
  saved() { return this.#saving }
  /** Hear every change. */
  onChange(listener: () => void) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
}
