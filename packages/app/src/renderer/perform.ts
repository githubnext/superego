// Another client asking this window to run one of its actions (`client.perform`). Taken only from the window's own
// machine: the desktop's 'local' daemon, or in a browser the daemon that served the page. A machine it merely reaches
// doesn't steer it. And only the navigation in PERFORMABLE, whatever the daemon let through.
import { PERFORMABLE, type Notifications } from '@superego/protocol'
import type { SuperegoEvent } from '../shared.ts'

/** What to dispatch for `event`, if it is a perform this window takes. */
export function performed(event: SuperegoEvent): { action: string; params: Record<string, unknown>; source: string } | undefined {
  if (event.method !== 'client.perform' || event.machine !== 'local') return undefined
  const { from, action, params } = event.params as Notifications['client.perform']
  if (typeof action !== 'string' || !PERFORMABLE.has(action)) return undefined
  return { action, params: params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}, source: `${from?.label ?? 'another client'} (${from?.kind ?? 'client'})` }
}
