// OAuth for URL servers (the MCP authorization spec), over the SDK's client auth and the store (mcp-auth.json):
//
// - Signing in (`signIn`, run by `mcp-servers.signIn` as a `superego.auth.flow`): the server is asked once without a
//   token, so its `WWW-Authenticate` names its protected resource metadata (RFC 9728) and scope; the SDK's `auth()`
//   finds its authorization server (RFC 8414 or OpenID discovery), registers Superego with it (a configured `clientId`,
//   else dynamic client registration, RFC 7591, once per authorization server and redirect URI, kept as
//   `client:<issuer> <redirect>`), and builds the page to open: authorization code with PKCE (S256), `state`, and
//   `resource` (RFC 8707) as the server's metadata names it. The browser comes back to the app's fixed loopback address
//   (loopback.ts), caught by the daemon or pasted (`manual_code`), the `state` checked; the code is exchanged, and the
//   tokens kept as `oauth:<resource>` with what refreshing them takes.
// - Using them (`OAuthAccess`, a `fetch` for the server's transport): every request to the server's origin carries its
//   access token. One with under a minute left is refreshed first, inside its key's lock in the store (`modify`), so two
//   threads never present the same refresh token (they rotate); no other server, nor Settings, waits on it. Every call
//   to an authorization server is given `TIMEOUT` to answer (a refresh, each step of a sign-in). A `401` refreshes once and tries again. A refresh refused
//   (`invalid_grant`, or the client's gone), or a `401` a refresh doesn't fix, is an `UnauthorizedError`: the runtime
//   puts the server in `needs-sign-in`, and the refused tokens are forgotten.
import { randomBytes } from 'node:crypto'
import { auth, extractWWWAuthenticateParams, refreshAuthorization, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import type { AuthFlow } from '@superego/daemon'
import type { Json } from '@superego/protocol'
import type { Callbacks } from './loopback.ts'
import type { SecretStore } from './store.ts'

/** A token with less than this left is refreshed before it's used. */
const MARGIN = 60_000
/** How long an authorization server gets to answer a request: a refresh, a step of signing in. */
export const TIMEOUT = 15_000

/** `fetchFn`, each request given up after `ms` (and when its own signal, or `also`, aborts). */
export function timed(fetchFn: FetchLike, ms: number, also?: AbortSignal): FetchLike {
  return (url, init) => {
    const signals = [AbortSignal.timeout(ms), ...init?.signal ? [init.signal] : [], ...also ? [also] : []]
    return fetchFn(url, { ...init, signal: AbortSignal.any(signals) })
  }
}

/** What `oauth:<resource>` keeps: the tokens, and what refreshing them takes. */
export type SignedIn = {
  tokens: OAuthTokens
  /** When the access token expires (ms); unset when the server didn't say. */
  expiresAt?: number
  /** When it was signed in (ms). */
  at: number
  /** Where its authorization server is, and what it said of itself: refreshes go there. */
  discovery: OAuthDiscoveryState
  /** The client the tokens were issued to: refreshes present it. */
  client: OAuthClientInformationMixed
  /** The resource indicator (RFC 8707) they were asked for, asked for again on refresh. */
  resource?: string
}

/** A server's OAuth resource, by which its tokens are kept: its canonical URL (no fragment). */
export const resourceOf = (url: string) => resourceUrlFromServerUrl(url).href
export const tokenKey = (resource: string) => `oauth:${resource}`
export const clientKey = (issuer: string, redirect: string) => `client:${issuer} ${redirect}`

const json = <T>(value: T) => value as unknown as Json
const stamped = (entry: SignedIn): SignedIn => {
  const { expires_in } = entry.tokens
  const { expiresAt: _old, ...rest } = entry
  return { ...rest, ...(typeof expires_in === 'number' ? { expiresAt: Date.now() + expires_in * 1000 } : {}) }
}
/** The authorization server turned the grant or the client down: only signing in again helps. */
const turnedDown = (error: unknown) => error instanceof InvalidGrantError || error instanceof InvalidClientError || error instanceof UnauthorizedClientError
const errorText = (error: unknown) => error instanceof Error ? error.message || error.name : String(error)

// ── Using the tokens ────────────────────────────────────────────────────────────────────────────────────────────────

export class OAuthAccess {
  #store: SecretStore
  #fetch: FetchLike
  #timeout: number
  /** Why a resource's tokens were last forgotten, for calls that wanted them at the same time: by resource. */
  #forgotten = new Map<string, string>()
  constructor(store: SecretStore, fetchFn: FetchLike = (url, init) => fetch(url, init), { timeout = TIMEOUT } = {}) {
    this.#store = store
    this.#fetch = fetchFn
    this.#timeout = timeout
  }

  /** What's kept for a resource, if it's signed in. */
  signedIn(resource: string) { return this.#store.read<Json>(tokenKey(resource)) as Promise<SignedIn | undefined> }

  /** Forget a resource's tokens: signed out. */
  forget(resource: string) {
    this.#forgotten.delete(resource)
    return this.#store.delete(tokenKey(resource))
  }

  /**
   * An access token for `resource`, refreshed first (under its key's lock) when it has under a minute left, or when
   * it's `refused`: the one the server just turned away. Throws `UnauthorizedError` when it isn't signed in, or the
   * refresh was refused (the tokens are forgotten then).
   */
  async token(resource: string, refused?: string): Promise<string> {
    const key = tokenKey(resource)
    const stale = (entry: SignedIn) => refused !== undefined
      ? entry.tokens.access_token === refused
      : entry.expiresAt !== undefined && entry.tokens.refresh_token !== undefined && entry.expiresAt - Date.now() < MARGIN
    const gone = () => new UnauthorizedError(this.#forgotten.get(resource) ?? 'it isn\'t signed in')
    const now = await this.signedIn(resource)
    if (!now) throw gone()
    this.#forgotten.delete(resource)
    if (!stale(now)) return now.tokens.access_token
    let why: string | undefined
    const next = await this.#store.modify<Json>(key, async (stored) => {
      const current = stored as SignedIn | undefined
      // Gone, or refreshed by another call while this one waited for the lock.
      if (!current || !stale(current)) return stored
      if (!current.tokens.refresh_token) {
        why = 'the server turned its token away, and there\'s no refresh token to get another with'
        return stored
      }
      try {
        return json(await this.#refresh(current))
      } catch (error) {
        if (turnedDown(error)) {
          why = `refreshing its sign-in was refused (${errorText(error)})`
          this.#forgotten.set(resource, why)
          return undefined
        }
        // Couldn't reach the authorization server: the token it has is good a little longer.
        if (refused === undefined && (current.expiresAt === undefined || current.expiresAt > Date.now())) return stored
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          throw new Error(`its authorization server didn't answer a refresh within ${Math.round(this.#timeout / 1000)}s`)
        }
        throw error
      }
    }) as SignedIn | undefined
    if (why) throw new UnauthorizedError(why)
    if (!next) throw gone()
    return next.tokens.access_token
  }

  async #refresh(current: SignedIn): Promise<SignedIn> {
    const tokens = await refreshAuthorization(current.discovery.authorizationServerUrl, {
      ...(current.discovery.authorizationServerMetadata ? { metadata: current.discovery.authorizationServerMetadata } : {}),
      clientInformation: current.client,
      refreshToken: current.tokens.refresh_token!,
      ...(current.resource ? { resource: current.resource } : {}),
      fetchFn: timed(this.#fetch, this.#timeout),
    })
    return stamped({ ...current, tokens: { ...tokens, ...(current.tokens.issuer ? { issuer: current.tokens.issuer } : {}) } })
  }

  /**
   * A `fetch` for a server's transport: its access token on every request to the resource's origin (and only there);
   * a `401` gets a refreshed token and one more try.
   */
  fetchFor(resource: string): FetchLike {
    const origin = new URL(resource).origin
    const send = (url: string | URL, init: RequestInit | undefined, token: string) => {
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${token}`)
      return this.#fetch(url, { ...init, headers })
    }
    return async (url, init) => {
      if (new URL(url).origin !== origin) return this.#fetch(url, init)
      const sent = await this.token(resource)
      const response = await send(url, init, sent)
      if (response.status !== 401) return response
      const again = await this.token(resource, sent)
      if (again === sent) return response
      await response.body?.cancel().catch(() => {})
      return send(url, init, again)
    }
  }
}

// ── Signing in ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type SignInOptions = {
  store: SecretStore
  /** The server's name, for what the user is told. */
  name: string
  /** The server's URL. */
  url: string
  /** The app's redirect URI (`http://127.0.0.1:<port>/mcp/callback`). */
  redirect: string
  /** Where the daemon listens for it. */
  callbacks: Callbacks
  /** What the authorization server calls the app (dynamic registration). */
  clientName: string
  clientUri?: string
  /** The config's: scopes to ask for, and a client registered by hand (its secret from the store). */
  scopes?: string[]
  clientId?: string
  clientSecret?: string
  fetch?: FetchLike
}

/** The SDK's view of one sign-in: its registration in the store, the rest in memory for as long as the flow runs. */
class SignInProvider implements OAuthClientProvider {
  readonly #o: SignInOptions
  readonly #state = randomBytes(24).toString('base64url')
  authorizationUrl?: URL
  #verifier?: string
  #discovery?: OAuthDiscoveryState
  client?: OAuthClientInformationMixed
  issued?: OAuthTokens
  constructor(options: SignInOptions) { this.#o = options }

  get redirectUrl() { return this.#o.redirect }
  get clientMetadata(): OAuthClientMetadata {
    const { clientName, clientUri, redirect, scopes } = this.#o
    return {
      client_name: clientName, ...(clientUri ? { client_uri: clientUri } : {}),
      redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
    }
  }
  get discovered() { return this.#discovery }
  get stateValue() { return this.#state }
  state() { return this.#state }

  #clientKey() { return this.#discovery ? clientKey(this.#discovery.authorizationServerUrl, this.#o.redirect) : undefined }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const { clientId, clientSecret } = this.#o
    if (clientId) return this.client = { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }
    const key = this.#clientKey()
    const stored = key ? await this.#o.store.read<Json>(key) as OAuthClientInformationMixed | undefined : undefined
    if (stored) this.client = stored
    return stored
  }
  async saveClientInformation(information: OAuthClientInformationMixed) {
    if (this.#o.clientId) return
    this.client = information
    const key = information.issuer ? clientKey(information.issuer, this.#o.redirect) : this.#clientKey()
    if (key) await this.#o.store.modify<Json>(key, () => json(information))
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    // The authorization server no longer knows the registration: register again.
    const key = this.#clientKey()
    if ((scope === 'all' || scope === 'client') && !this.#o.clientId && key) await this.#o.store.delete(key)
    if (scope === 'all' || scope === 'discovery') this.#discovery = undefined
  }

  // A sign-in always goes to the browser: tokens kept from before aren't refreshed here.
  tokens() { return undefined }
  saveTokens(tokens: OAuthTokens) { this.issued = tokens }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url }
  saveCodeVerifier(verifier: string) { this.#verifier = verifier }
  codeVerifier() {
    if (!this.#verifier) throw new Error('No sign-in is going on')
    return this.#verifier
  }
  saveDiscoveryState(state: OAuthDiscoveryState) { this.#discovery = state }
  discoveryState() { return this.#discovery }
}

/** What the browser came back with, read from the address it was sent to (or its query): the code, an error, or why not. */
export function readRedirect(text: string, state: string): { code: string } | { error: string } | { why: string } {
  const given = text.trim()
  let params: URLSearchParams
  try { params = new URL(given).searchParams } catch { params = new URLSearchParams(given.replace(/^[?#]/, '')) }
  const whole = 'Paste the whole address the browser ended up on, from its address bar.'
  if (!params.has('state') && !params.has('code') && !params.has('error')) return { why: `That isn't the address the browser was sent back to. ${whole}` }
  if (params.get('state') !== state) return { why: `That address is from another sign-in. ${whole}` }
  const error = params.get('error')
  if (error) return { error: `${error}${params.get('error_description') ? `: ${params.get('error_description')}` : ''}` }
  const code = params.get('code')
  return code ? { code } : { why: `That address has no code in it. ${whole}` }
}

/** Ask the server without a token, for what its `WWW-Authenticate` says: where its resource metadata is, and the scope. */
async function probe(url: string, fetchFn: FetchLike): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'superego', version: '1.0.0' } },
    }),
  })
  await response.body?.cancel().catch(() => {})
  if (response.status !== 401) return {}
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response)
  return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) }
}

/**
 * Sign in to a server, as `flow`: its page to open (`auth_url`, with the loopback `callback`), and a `manual_code`
 * prompt for the address the browser comes back to, closed when the daemon's own listener catches it first. Keeps the
 * tokens (`oauth:<resource>`) and answers them.
 */
export async function signIn(options: SignInOptions, flow: AuthFlow): Promise<SignedIn> {
  const { name, url, redirect, store } = options
  const fetchFn = timed(options.fetch ?? ((input, init) => fetch(input, init)), TIMEOUT, flow.signal)
  flow.emit({ type: 'progress', message: `Finding out how ${name} signs in…` })
  const asked = await probe(url, fetchFn).catch((error: unknown) => { throw new Error(`Couldn't reach ${name}: ${errorText(error)}`) })
  const scope = options.scopes?.length ? options.scopes.join(' ') : asked.scope
  const how = { serverUrl: url, ...(asked.resourceMetadataUrl ? { resourceMetadataUrl: asked.resourceMetadataUrl } : {}), ...(scope ? { scope } : {}), fetchFn }
  const provider = new SignInProvider(options)
  try {
    await auth(provider, how)
  } catch (error) {
    if (/dynamic client registration/i.test(errorText(error))) {
      throw new Error(`${name}'s authorization server doesn't let apps register themselves: give the server a client id (auth.clientId) registered there`)
    }
    throw new Error(`Couldn't start signing in to ${name}: ${errorText(error)}`)
  }
  const page = provider.authorizationUrl
  if (!page) throw new Error(`${name} didn't give a page to sign in on`)
  const state = provider.stateValue

  // The browser comes back to the daemon's listener, or its address is pasted (or answered by the app's own listener).
  const caught = new AbortController()
  const done = new AbortController()
  const stop = () => done.abort()
  flow.signal.addEventListener('abort', stop, { once: true })
  const listened = options.callbacks.wait(state, done.signal).then((back) => {
    caught.abort()
    return readRedirect(back.href, state)
  })
  flow.emit({ type: 'auth_url', url: page.href, callback: redirect, instructions: `Sign in to ${name} in the browser, at ${page.host}.` })
  const pasted = (async () => {
    let message = `Once you've signed in, the browser goes to ${redirect}. If that page doesn't load, paste its whole address here.`
    for (;;) {
      const text = await flow.prompt({ type: 'manual_code', message, placeholder: `${redirect}?code=…` }, { signal: caught.signal })
      const read = readRedirect(text, state)
      if (!('why' in read)) return read
      message = read.why
    }
  })()
  let back: { code: string } | { error: string } | { why: string }
  try {
    back = await Promise.race([listened, pasted])
  } finally {
    flow.signal.removeEventListener('abort', stop)
    done.abort()
    caught.abort()
  }
  if ('error' in back) throw new Error(`${name} didn't sign you in: ${back.error}`)
  if ('why' in back) throw new Error(back.why)

  flow.emit({ type: 'progress', message: `Signing in to ${name}…` })
  try {
    await auth(provider, { ...how, authorizationCode: back.code })
  } catch (error) {
    throw new Error(`${name} didn't take the sign-in: ${errorText(error)}`)
  }
  const discovery = provider.discovered
  if (!provider.issued || !provider.client || !discovery) throw new Error(`${name} didn't give a token`)
  const resource = discovery.resourceMetadata?.resource
  const entry = stamped({ tokens: provider.issued, at: Date.now(), discovery, client: provider.client, ...(resource ? { resource } : {}) })
  await store.modify<Json>(tokenKey(resourceOf(url)), () => json(entry))
  return entry
}
