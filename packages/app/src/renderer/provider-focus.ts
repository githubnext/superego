// Where Settings → Providers opens to sign in again: a machine's provider, set by "Sign in again" before Settings opens
// and taken by the Providers section of that machine as it shows.

let focus: { machine: string; provider: string } | undefined

/** Open Providers on `machine` at `provider` next time it shows. */
export function focusProvider(machine: string, provider: string) { focus = { machine, provider } }

/** The provider to sign in to on `machine`, once. */
export function takeProviderFocus(machine: string) {
  if (focus?.machine !== machine) return undefined
  const { provider } = focus
  focus = undefined
  return provider
}
