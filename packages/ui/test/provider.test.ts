// Providers by pi-ai's ids: whose brand each is, by name, and the provider's own id for one without a mark.
import { expect, it } from 'vitest'
import { modelName, providerOf } from '../src/provider.tsx'

it("names a provider's brand, and falls back to its id", () => {
  expect(providerOf('anthropic')).toBe('Anthropic')
  expect(providerOf('openai')).toBe('OpenAI')
  expect(providerOf('openai-codex')).toBe('OpenAI')
  expect(providerOf('google-vertex')).toBe('Google')
  expect(providerOf('xai')).toBe('xAI')
  expect(providerOf('github-copilot')).toBe('GitHub Copilot')
  expect(providerOf('deepseek')).toBe('deepseek')
  expect(providerOf('replay')).toBe('replay')
})

it("says a model by its id, without the provider", () => {
  expect(modelName('anthropic/claude-opus-4-5')).toBe('claude-opus-4-5')
  expect(modelName('claude-opus-4-5')).toBe('claude-opus-4-5')
})
