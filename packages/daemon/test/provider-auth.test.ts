import { describe, expect, it } from 'vitest'
import { authFailure, rejectionSummary, WAITING } from '../src/provider-auth.ts'

describe('authFailure', () => {
  it.each([
    // Anthropic, an API key it doesn't know (the one that stopped seven threads).
    '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    // Anthropic, an expired OAuth token.
    '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."},"request_id":"req_011CS"}',
    // A gateway in front of a provider.
    '503 credential validation failed',
    // OpenAI.
    '401 Incorrect API key provided: sk-proj-********************abcd. You can find your API key at https://platform.openai.com/account/api-keys.',
    '401 {"error":{"message":"Incorrect API key provided: sk-abc.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}',
    // Sign in with ChatGPT: a token that expired or was revoked.
    '401 {"error":{"message":"Your authentication token has expired. Please try signing in again.","type":"invalid_request_error","code":"token_expired"}}',
    'Your authentication token has been invalidated. Please try signing in again.',
    // A refresh the token endpoint refused (the refresh token expired, was revoked or used already), as a run fails on it.
    'OAuth refresh failed for openai: OpenAI OAuth token request failed (400): {"error":"invalid_grant","error_description":"The refresh token is invalid or expired."}',
    'OAuth refresh failed for openai: OpenAI OAuth token request failed (401): {"error":"invalid_client"}',
    'OAuth refresh failed for openai: OpenAI Codex token refresh failed (400): {"error":"invalid_grant","error_description":"Invalid refresh token"}',
    'OAuth refresh failed for openai: OpenAI Codex token refresh failed (401): {"error":{"message":"Your refresh token has already been used to generate a new access token. Please try signing in again.","type":"invalid_request_error","code":"refresh_token_reused"}}',
    'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://console.anthropic.com/v1/oauth/token; details=Error: HTTP request failed. status=400; url=https://console.anthropic.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
    'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://console.anthropic.com/v1/oauth/token; details=Error: HTTP request failed. status=401; url=https://console.anthropic.com/v1/oauth/token; body={"type":"error","error":{"type":"authentication_error","message":"Refresh token has been revoked"}}',
    // Nothing to sign in with.
    'API key auth failed for provider anthropic',
    'Provider is not configured: anthropic',
    // A turn refused while waiting for sign-in.
    `${WAITING} Anthropic rejected the API key`,
  ])('is an auth failure: %s', (error) => {
    expect(authFailure(error)).toBe(true)
  })

  it.each([
    undefined,
    '',
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    '500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    '403 {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}',
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
    '429 You exceeded your current quota, please check your plan and billing details. insufficient_quota',
    'fetch failed',
    // A refresh the network failed, or that the token endpoint failed itself: transient, not a refusal.
    'OAuth refresh failed for openai: fetch failed',
    'OAuth refresh failed for openai: OpenAI OAuth token request failed (503): upstream connect error or disconnect/reset before headers',
    'OAuth refresh failed for openai: OpenAI Codex token refresh error: fetch failed',
    'OAuth refresh failed for openai: OpenAI Codex token refresh error: read ECONNRESET',
    'OAuth refresh failed for openai: OpenAI Codex token refresh failed (502): Bad Gateway',
    'OAuth refresh failed for openai: OpenAI Codex token refresh failed (503): {"error":{"message":"The server is overloaded","type":"server_error"}}',
    'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://console.anthropic.com/v1/oauth/token; details=TypeError: fetch failed; cause=Error: getaddrinfo ENOTFOUND console.anthropic.com',
    'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://console.anthropic.com/v1/oauth/token; details=TimeoutError: The operation was aborted due to timeout',
    'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://console.anthropic.com/v1/oauth/token; details=Error: HTTP request failed. status=500; url=https://console.anthropic.com/v1/oauth/token; body={"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    'OAuth refresh failed for openai: The operation was aborted due to timeout',
    // Without the endpoint's answer, nothing says it was refused.
    'OAuth refresh failed for openai',
    'request id req_4011234 failed',
  ])('is not: %s', (error) => {
    expect(authFailure(error)).toBe(false)
  })
})

describe('rejectionSummary', () => {
  it('says what happened, by how the provider was signed in', () => {
    expect(rejectionSummary('Anthropic', 'api_key', '401 invalid x-api-key')).toBe('Anthropic rejected the API key')
    expect(rejectionSummary('OpenAI', 'oauth', '401 token_expired')).toBe('OpenAI rejected the sign-in')
    expect(rejectionSummary('OpenAI', 'oauth', 'OAuth refresh failed for openai: OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}')).toBe("Couldn't renew the sign-in to OpenAI")
    expect(rejectionSummary('Anthropic', undefined, 'Provider is not configured: anthropic')).toBe("Anthropic isn't signed in")
    expect(rejectionSummary('Gateway', undefined, '503 credential validation failed')).toBe('Gateway rejected the credentials')
  })
})

it('gives a failed refresh the token endpoint\'s answer, so a run failing on it can tell', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { SettingsRegistry } = await import('@superego/settings')
  const { createAgentSettings } = await import('../src/agent-settings.ts')
  const dir = await mkdtemp(join(tmpdir(), 'superego-refresh-'))
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 0, clientId: 'client' } }))
  const agent = await createAgentSettings(new SettingsRegistry(), dir, { name: 'superego', id: 'refreshtest' } as never)
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  try {
    const failed = await agent.models.getAuth('openai').then(() => undefined, (error: Error) => error.message)
    expect(failed).toBe('OAuth refresh failed for openai: fetch failed')
    expect(authFailure(failed)).toBe(false)
  } finally {
    globalThis.fetch = realFetch
    agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})
