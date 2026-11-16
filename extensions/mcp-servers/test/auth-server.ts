// A fake authorization server and the MCP server it guards, on one loopback port, from the SDK's server-side auth
// pieces: `mcpAuthRouter` (metadata, dynamic registration, authorize, token) over an in-memory provider, and
// `requireBearerAuth` in front of the fixture server (fixture.ts) over Streamable HTTP. Signing in is approved at once:
// the authorize page redirects straight back with a code. Refresh tokens rotate: each works once (`invalid_grant` after).
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { fixtureServer } from './fixture.ts'

export type AuthServerOptions = {
  /** Seconds an access token lasts (default an hour). */
  expiresIn?: number
  /** A client registered by hand; with it, no dynamic registration. */
  client?: { client_id: string; client_secret?: string; redirect_uris: string[] }
}

export async function serveOAuth(options: AuthServerOptions = {}) {
  const seen = {
    registered: [] as OAuthClientInformationFull[],
    authorized: [] as AuthorizationParams[],
    /** Each token request: its grant, the client, the resource it asked for. */
    grants: [] as { grant: 'code' | 'refresh'; client: string; resource?: string; refused?: boolean }[],
    /** The Authorization header of each request to the MCP server. */
    bearer: [] as (string | undefined)[],
  }
  let expiresIn = options.expiresIn ?? 3600
  const clients = new Map<string, OAuthClientInformationFull>()
  if (options.client) clients.set(options.client.client_id, options.client)
  const codes = new Map<string, { client: string; params: AuthorizationParams }>()
  const access = new Map<string, { client: string; expiresAt: number; scopes: string[]; resource?: URL }>()
  const refresh = new Map<string, { client: string; scopes: string[]; resource?: URL }>()
  let n = 0
  const issue = (client: string, scopes: string[], resource?: URL): OAuthTokens => {
    n++
    const token = `access-${n}-${randomUUID()}`
    const refreshToken = `refresh-${n}-${randomUUID()}`
    access.set(token, { client, expiresAt: Date.now() + expiresIn * 1000, scopes, ...(resource ? { resource } : {}) })
    refresh.set(refreshToken, { client, scopes, ...(resource ? { resource } : {}) })
    return { access_token: token, token_type: 'bearer', expires_in: expiresIn, refresh_token: refreshToken, scope: scopes.join(' ') }
  }

  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: (id) => clients.get(id),
      ...(options.client ? {} : {
        registerClient: (client: OAuthClientInformationFull) => {
          seen.registered.push(client)
          clients.set(client.client_id, client)
          return client
        },
      }),
    },
    async authorize(client, params, res) {
      seen.authorized.push(params)
      const code = randomUUID()
      codes.set(code, { client: client.client_id, params })
      const back = new URL(params.redirectUri)
      back.searchParams.set('code', code)
      if (params.state !== undefined) back.searchParams.set('state', params.state)
      res.redirect(back.href)
    },
    async challengeForAuthorizationCode(_client, code) {
      const found = codes.get(code)
      if (!found) throw new InvalidGrantError('no such code')
      return found.params.codeChallenge
    },
    async exchangeAuthorizationCode(client, code, _verifier, _redirect, resource) {
      const found = codes.get(code)
      seen.grants.push({ grant: 'code', client: client.client_id, ...(resource ? { resource: resource.href } : {}) })
      if (!found || found.client !== client.client_id) throw new InvalidGrantError('no such code')
      codes.delete(code)
      return issue(client.client_id, found.params.scopes ?? [], resource)
    },
    async exchangeRefreshToken(client, token, _scopes, resource) {
      const found = refresh.get(token)
      seen.grants.push({ grant: 'refresh', client: client.client_id, ...(resource ? { resource: resource.href } : {}), ...(found ? {} : { refused: true }) })
      if (!found || found.client !== client.client_id) throw new InvalidGrantError('refresh token is not valid')
      // Rotated: it works once.
      refresh.delete(token)
      return issue(client.client_id, found.scopes, resource)
    },
    async verifyAccessToken(token) {
      const found = access.get(token)
      if (!found || found.expiresAt < Date.now()) throw new InvalidTokenError('token is not valid')
      return { token, clientId: found.client, scopes: found.scopes, expiresAt: Math.floor(found.expiresAt / 1000), ...(found.resource ? { resource: found.resource } : {}) }
    },
  }

  const app = createMcpExpressApp()
  const http = createServer(app)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as { port: number }
  const base = `http://127.0.0.1:${port}`
  const url = `${base}/mcp`
  const off = { rateLimit: false as const }
  // A stalled token endpoint: its requests wait, unanswered, until it's let go.
  let stalled: (() => void)[] | undefined
  app.use('/token', (_req: any, _res: any, next: any) => { if (stalled) stalled.push(next); else next() })
  app.use(mcpAuthRouter({
    provider, issuerUrl: new URL(base), resourceServerUrl: new URL(url), scopesSupported: ['tools'],
    authorizationOptions: off, clientRegistrationOptions: off, tokenOptions: off, revocationOptions: off,
  }))
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  app.all('/mcp', (req: any, _res: any, next: any) => { seen.bearer.push(req.headers.authorization); next() },
    requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(url)) }),
    async (req: any, res: any) => {
      const id = req.headers['mcp-session-id'] as string | undefined
      let transport = id ? sessions.get(id) : undefined
      if (id && !transport) return void res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })
      if (!transport) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => { sessions.set(sid, transport!) } })
        await fixtureServer().connect(transport)
      }
      await transport.handleRequest(req, res, req.body)
    })

  return {
    url, base, seen,
    /** The browser: open the sign-in page, and answer with where it redirects to (not followed). */
    async approve(page: string): Promise<string> {
      const response = await fetch(page, { redirect: 'manual' })
      const location = response.headers.get('location')
      if (!location) throw new Error(`the sign-in page answered ${response.status}: ${await response.text()}`)
      return location
    },
    /** Every access token stops working (refresh tokens still do). */
    expireAccess() { access.clear() },
    /** Every refresh token stops working too. */
    revokeAll() { access.clear(); refresh.clear() },
    /** How long tokens issued from now on last. */
    set expiresIn(seconds: number) { expiresIn = seconds },
    /** The token endpoint stops answering (`true`), or answers again, everything it held let through (`false`). */
    set stall(on: boolean) {
      const held = stalled
      stalled = on ? held ?? [] : undefined
      if (!on) for (const next of held ?? []) next()
    },
    /** Token requests waiting on the stall. */
    get stalledCount() { return stalled?.length ?? 0 },
    close: () => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()) }),
  }
}
