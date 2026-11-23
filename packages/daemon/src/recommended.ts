// The models a provider is best started on: what setup makes the default once it's signed in, what a key is tried on,
// and what's listed first to pick from. pi lists a provider's models by name, so its first is seldom the one to use
// (Google's is a deep-research preview, Groq's an 8B model): these are picked by hand, the best first, for the
// providers people sign in to; the rest start on their first model that's for chatting.

/** By provider, the models to start on, best first: the first one a sign-in offers is the default. */
export const RECOMMENDED: Record<string, readonly string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.1-terra'],
  'github-copilot': ['claude-sonnet-5.5', 'gpt-6.1-sol', 'claude-opus-5.5', 'gemini-4-carbon'],
  openrouter: ['~anthropic/claude-sonnet-latest', '~openai/gpt-sol-latest', '~google/gemini-pro-latest', '~anthropic/claude-opus-latest'],
  google: ['gemini-pro-latest', 'gemini-flash-latest'],
  'google-vertex': ['gemini-4-carbon', 'gemini-3.8-flash'],
  groq: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
  xai: ['grok-4.7'],
  mistral: ['mistral-large-latest', 'devstral-latest', 'mistral-medium-latest'],
  deepseek: ['deepseek-v4-pro', 'deepseek-flash'],
  moonshotai: ['kimi-k3.1-pro', 'kimi-k3'],
  'kimi-coding': ['k3.1-pro', 'kimi-for-coding'],
  zai: ['glm-5.3', 'glm-5.3-flash'],
  cerebras: ['gpt-oss-120b'],
  minimax: ['MiniMax-M3'],
}

/** Providers whose recommended model is the default before any other's, in this order, when several are signed in. */
export const FIRST = ['anthropic', 'openai']

/**
 * Whether a model's id says it isn't for chatting: embeddings, rerankers, speech, moderation, research and robotics
 * previews, batch-only variants. Local servers list such models beside their chat ones (Ollama's nomic-embed-text).
 */
export const notForChat = (id: string) =>
  /embed|rerank|whisper|(^|[-_/])tts|transcribe|moderation|safeguard|deep-research|computer-use|robotics|[:-]batch$/i.test(id)

/**
 * The models of `models` (a provider's, as its sign-in offers them) to start on, best first: those recommended that are
 * offered, else the first one for chatting.
 */
export function recommendedOf<M extends { id: string }>(provider: string, models: readonly M[]): M[] {
  const picked = (RECOMMENDED[provider] ?? []).flatMap((id) => models.filter((m) => m.id === id))
  if (picked.length) return picked
  const first = models.find((m) => !notForChat(m.id))
  return first ? [first] : []
}
