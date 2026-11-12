import { RpcError, type Hello } from '@superego/protocol'

/**
 * Whether the daemon that answered a machine's route may be that machine. `expected` is the identity remembered from
 * the first connection, absent until then; `connected` are the other machines connected now, by label and identity.
 * Throws `duplicate_machine` for a machine already connected another way, `wrong_machine` for a stranger.
 */
export function checkIdentity(hello: Hello, route: { target: string; expected?: string }, connected: { label: string; id: string }[]): void {
  const twin = connected.find((other) => other.id === hello.machine.id)
  if (twin) throw new RpcError('duplicate_machine', `${route.target} is ${twin.label}, which is already connected`)
  if (route.expected && route.expected !== hello.machine.id) {
    throw new RpcError('wrong_machine', `A different machine (${hello.machine.hostname}) answered at ${route.target}`)
  }
}
