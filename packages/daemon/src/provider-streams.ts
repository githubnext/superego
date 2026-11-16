// A provider's requests, wrapped: what the daemon adds around a model's answers (recording them, refusing them while
// its credentials are rejected, asking for a faster tier), each without reaching into the provider itself.
import type { Provider } from '@earendil-works/pi-ai/models'

type Stream = Provider['streamSimple']

/** `provider`, every request it streams (`stream` and `streamSimple`) going through `around`, which `call`s it in turn. */
export function wrapStreams<T extends Provider>(provider: T, around: (call: Stream, ...args: Parameters<Stream>) => ReturnType<Stream>): T {
  return new Proxy(provider, {
    get(target, key, receiver) {
      if (key !== 'stream' && key !== 'streamSimple') return Reflect.get(target, key, receiver)
      const call = ((...args: Parameters<Stream>) => (target[key] as Stream).apply(target, args)) as Stream
      return (...args: Parameters<Stream>) => around(call, ...args)
    },
  })
}
