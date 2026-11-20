// Superego never uses a Claude subscription's own token (docs/research/claude-subscriptions.md, §4b). pi-ai treats any
// Anthropic key containing "sk-ant-oat" as one, and then sends it as Claude Code would (its user agent, `x-app: cli`,
// Claude Code's beta header): impersonating Claude Code, which Anthropic forbids. pi-ai finds such a token in the
// environment (ANTHROPIC_OAUTH_TOKEN, or any of its Anthropic variables holding one), in a stored key, or in a stored
// OAuth sign-in. Here the auth context hides the first, and the Anthropic provider refuses the rest, so no request
// pi-ai builds ever carries one.
import { defaultProviderAuthContext, type AuthContext, type AuthResult } from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai/models'

/** What every Claude subscription (OAuth) token contains, as pi-ai tells them apart. */
const SUBSCRIPTION_TOKEN = 'sk-ant-oat'

/** Why a subscription token is refused, and what to use instead. */
export const SUBSCRIPTION_REFUSED = 'Claude subscription tokens (sk-ant-oat…) only work in Claude Code itself. Use an API key from console.anthropic.com: Claude Max, Team and Ultra plans include monthly API credits for one.'

const isSubscriptionToken = (value: string | null | undefined) => value?.includes(SUBSCRIPTION_TOKEN) ?? false

/**
 * The process's environment as pi-ai sees it, without Claude subscription tokens: ANTHROPIC_OAUTH_TOKEN, and any other
 * variable holding one (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN set to a `claude setup-token`, say), read as unset.
 * Each one hidden is said once on the console, so a provider that seems not signed in has a reason.
 */
export function withoutSubscriptionEnv(base: AuthContext = defaultProviderAuthContext()): AuthContext {
  const said = new Set<string>()
  return {
    async env(name) {
      const value = await base.env(name)
      if (value === undefined || (name !== 'ANTHROPIC_OAUTH_TOKEN' && !isSubscriptionToken(value))) return value
      if (!said.has(name)) {
        said.add(name)
        console.warn(`Ignoring ${name}: ${SUBSCRIPTION_REFUSED}`)
      }
      return undefined
    },
    fileExists: (path) => base.fileExists(path),
  }
}

/**
 * Anthropic's provider without Claude subscriptions: no OAuth sign-in (so a stored one is never used, or renewed),
 * a subscription token given as an API key is refused when it's entered, and refused again should one be stored
 * anyway (by hand, or before this check): whatever its key's source, a request never carries one.
 */
export function withoutSubscriptionAuth<T extends Provider>(provider: T): T {
  const { oauth: _oauth, apiKey, ...auth } = provider.auth
  if (!apiKey) return { ...provider, auth }
  const refuse = (result: AuthResult | undefined) => {
    const bearer = Object.entries(result?.auth.headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
    if (isSubscriptionToken(result?.auth.apiKey) || isSubscriptionToken(bearer)) {
      console.error(`${provider.name}: ${SUBSCRIPTION_REFUSED}`)
      throw new Error(SUBSCRIPTION_REFUSED)
    }
    return result
  }
  return {
    ...provider,
    auth: {
      ...auth,
      apiKey: {
        ...apiKey,
        ...(apiKey.login ? {
          async login(interaction) {
            const credential = await apiKey.login!(interaction)
            if (isSubscriptionToken(credential.key)) throw new Error(SUBSCRIPTION_REFUSED)
            return credential
          },
        } : {}),
        resolve: async (input) => refuse(await apiKey.resolve(input)),
      },
    },
  }
}
