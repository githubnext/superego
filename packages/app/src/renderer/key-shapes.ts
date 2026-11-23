// An API key as pasted: which provider it's for, told by how it starts (or by the variable it was pasted with:
// `export OPENAI_API_KEY=sk-…`), and whether it looks like a key at all, before anything is sent with it. The provider
// still has the last word: a key it refuses is said so as it's tried.

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

/** How a Claude subscription's token starts (Claude Code's `setup-token`): Anthropic's, but not an API key. */
const SUBSCRIPTION = /^sk-ant-oat/

/**
 * A value as a shell file writes it: in quotes (whose content it is), else up to a `# comment`; a trailing `;` either
 * way.
 */
function shellValue(text: string): string {
  const value = text.trim()
  const quoted = /^(['"])(.*?)\1\s*;?\s*(?:#.*)?$/s.exec(value)
  if (quoted) return quoted[2]!
  return value.replace(/\s+#.*$/s, '').replace(/;\s*$/, '').trim()
}

/**
 * A pasted key: the key itself, and the variable it was pasted with, if it was (`export NAME="…"; # comment`). Of
 * several lines pasted together, the first that sets a variable.
 */
export function pastedKey(text: string): { key: string; variable?: string } {
  for (const line of text.split(/\r?\n/)) {
    const assigned = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (assigned) return { key: shellValue(assigned[2]!), variable: assigned[1]! }
  }
  return { key: shellValue(text) }
}

/**
 * Which of `providers` a pasted key is for: by how it starts, else by the variable it came with (a provider's `env`).
 * Undefined when neither says, or it's no API key at all (a Claude subscription token).
 */
export function keyProvider(text: string, providers: readonly { id: string; env?: string[] }[]): string | undefined {
  const { key, variable } = pastedKey(text)
  if (SUBSCRIPTION.test(key)) return undefined
  const started = PREFIXES.find(([pattern]) => pattern.test(key))?.[1]
  if (started) return started
  return variable ? providers.find((p) => p.env?.includes(variable))?.id : undefined
}

/**
 * Why a pasted key can't be one, if it can't: a Claude subscription token, said at once; and, once it's `sent`, too
 * short or with spaces in it (a sentence, two keys).
 */
export function keyProblem(text: string, { sent = true }: { sent?: boolean } = {}): string | undefined {
  const { key } = pastedKey(text)
  if (!key) return undefined
  if (SUBSCRIPTION.test(key)) return "That's a Claude subscription token, not an API key."
  if (sent && (/\s/.test(key) || key.length < 20)) return "That doesn't look like an API key."
  return undefined
}
