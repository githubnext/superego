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
    // pi resolving auth before asking: a refresh that failed, nothing to sign in with.
    'OAuth refresh failed for openai',
    'OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}',
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
    'request id req_4011234 failed',
  ])('is not: %s', (error) => {
    expect(authFailure(error)).toBe(false)
  })
})

describe('rejectionSummary', () => {
  it('says what happened, by how the provider was signed in', () => {
    expect(rejectionSummary('Anthropic', 'api_key', '401 invalid x-api-key')).toBe('Anthropic rejected the API key')
    expect(rejectionSummary('OpenAI', 'oauth', '401 token_expired')).toBe('OpenAI rejected the sign-in')
    expect(rejectionSummary('OpenAI', 'oauth', 'OAuth refresh failed for openai')).toBe("Couldn't renew the sign-in to OpenAI")
    expect(rejectionSummary('Anthropic', undefined, 'Provider is not configured: anthropic')).toBe("Anthropic isn't signed in")
    expect(rejectionSummary('Gateway', undefined, '503 credential validation failed')).toBe('Gateway rejected the credentials')
  })
})
