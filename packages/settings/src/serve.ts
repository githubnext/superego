import { randomUUID } from 'node:crypto'
import type { Json, Methods, Notifications } from '@mu/protocol'
import type { SettingsRegistry } from './registry.ts'

type Handlers = { [M in 'settings.watch' | 'settings.set']: (params: Methods[M]['params']) => Promise<Methods[M]['result']> }

/**
 * The `settings.*` methods over `registry` for one connection. `subs` is the connection's subscription table, shared
 * with its other watches so one `unwatch` method serves them all.
 */
export function serveSettings(registry: SettingsRegistry, notify: (params: Notifications['settings.changed']) => void, subs: Map<string, () => unknown>): Handlers {
  return {
    async 'settings.watch'() {
      const sub = randomUUID()
      let last = ''
      const push = async () => {
        const value = await registry.snapshot()
        const json = JSON.stringify(value)
        if (json !== last && subs.has(sub)) { last = json; notify({ sub, value }) }
      }
      const off = registry.onChange(() => { void push() })
      subs.set(sub, off)
      const value = await registry.snapshot()
      last = JSON.stringify(value)
      return { sub, value }
    },
    async 'settings.set'({ key, value }: { key: string; value: Json }) {
      await registry.set(key, value)
      return null
    },
  }
}
