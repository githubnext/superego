// An API key as pasted: which provider it's for, told by how it starts (or by the variable it was pasted with:
// `export OPENAI_API_KEY=sk-…`), and whether it looks like a key at all, before anything is sent with it.

/** Providers whose keys say whose they are, by their start. A bare `sk-` doesn't: OpenAI's, DeepSeek's and others' do. */
const PREFIXES: readonly [RegExp, string][] = [
  [/^sk-ant-/, 'anthropic'],
  [/^sk-or-/, 'openrouter'],
  [/^sk-(?:proj|svcacct|admin)-/, 'openai'],
  [/^AIza/, 'google'],
  [/^gsk_/, 'groq'],
  [/^xai-/, 'xai'],
  [/^csk-/, 'cerebras'],
  [/^fw_/, 'fireworks'],
  [/^hf_/, 'huggingface'],
  [/^nvapi-/, 'nvidia'],
  [/^tgp_v1_/, 'together'],
]

/** A pasted key: the key itself, and the variable it was pasted with, if it was (`export NAME="…"`). */
export function pastedKey(text: string): { key: string; variable?: string } {
  const trimmed = text.trim()
  const assigned = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/s.exec(trimmed)
  if (!assigned) return { key: trimmed }
  return { key: assigned[2]!.trim().replace(/^(['"])(.*)\1$/s, '$2'), variable: assigned[1]! }
}

/**
 * Which of `providers` a pasted key is for: by the variable it came with (a provider's `env`), else by how it starts.
 * Undefined when it doesn't say.
 */
export function keyProvider(text: string, providers: readonly { id: string; env?: string[] }[]): string | undefined {
  const { key, variable } = pastedKey(text)
  if (variable) {
    const named = providers.find((p) => p.env?.includes(variable))
    if (named) return named.id
  }
  return PREFIXES.find(([pattern]) => pattern.test(key))?.[1]
}

/** Why a pasted key can't be one, if it can't: too short, or with spaces in it (a sentence, two keys). */
export function keyProblem(text: string): string | undefined {
  const { key } = pastedKey(text)
  if (!key) return undefined
  if (/\s/.test(key) || key.length < 20) return "That doesn't look like an API key."
  return undefined
}
