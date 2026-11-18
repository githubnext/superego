// How web pages' site permissions are said: in a Browser pane as its page asks (the browser extension), and in Settings → Site permissions.
import type { PermissionAsk, SitePermission } from './bridge.ts'

/** A site as the user knows it: its host (and port), from its origin. */
export function siteName(origin: string): string {
  try { return new URL(origin).host || origin } catch { return origin }
}

/** "a, b and c". */
const and = (words: string[]) => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

/** What a site wants, after "<site> wants to": "use the camera and microphone", "reach apps on this Mac". */
export function wants(kinds: readonly SitePermission[], computer = 'this Mac'): string {
  const has = (kind: SitePermission) => kinds.includes(kind)
  const parts: string[] = []
  const reach = [...has('loopback-network') ? [`apps on ${computer}`] : [], ...has('local-network') ? ['devices on your network'] : []]
  if (reach.length) parts.push(`reach ${and(reach)}`)
  const use = [...has('camera') ? ['camera'] : [], ...has('microphone') ? ['microphone'] : []]
  if (use.length) parts.push(`use the ${and(use)}`)
  if (has('notifications')) parts.push('show notifications')
  return and(parts)
}

/** "okta.example.com wants to reach apps on this Mac". */
export const askText = (ask: PermissionAsk, computer?: string) => `${siteName(ask.origin)} wants to ${wants(ask.kinds, computer)}`

/** A permission by name, as Settings lists a site's. */
export const permissionName = (kind: SitePermission, computer = 'this Mac'): string => ({
  'loopback-network': `Apps on ${computer}`, 'local-network': 'Devices on your network', camera: 'Camera', microphone: 'Microphone', notifications: 'Notifications',
})[kind]

/** What the computer is called here: "this Mac" on macOS. */
export const thisComputer = (platform: string) => /mac/i.test(platform) ? 'this Mac' : 'this computer'
