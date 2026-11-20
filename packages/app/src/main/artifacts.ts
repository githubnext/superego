// Artifacts: HTML the agent wrote, served from the thread's machine on a scheme of their own (superego-artifact://, see
// shared/bridge.ts's artifactUrl), sandboxed, to the web views that show them (web-views.ts) alone. What a page may be
// served (its thread's folder, and nothing a symlink leads to past it) is the thread's machine's to say: `artifact.read`.
import { protocol, type Session } from 'electron'
import type { Link } from '@superego/client'

/** What an artifact may do: run its own scripts and forms, nothing of the app's (an opaque origin). */
const ARTIFACT_POLICY = "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https: 'unsafe-inline' 'unsafe-eval'"

const ARTIFACT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
}

export const SCHEME = 'superego-artifact'

/** Before the app is ready: the scheme, as a standard and secure one that can be fetched from. */
export function registerArtifactScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

/** Once it's ready: serve `<machine>/<thread>/<path>` from the thread's folder on that machine, in `session`. */
export function serveArtifacts(session: Session, linkOf: (machine: string) => Link | undefined) {
  session.protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    let machine: string, thread: string | undefined, rest: string[]
    try {
      machine = decodeURIComponent(url.hostname)
      ;[thread, ...rest] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return new Response('Not an address of a file', { status: 400 })
    }
    const link = linkOf(machine)
    if (!link || !thread || !rest.length) return new Response('Not found', { status: 404 })
    const path = rest.join('/')
    if (link.hello && !link.has('artifact-read')) return new Response(`${link.label} runs a Superego that can't serve artifacts: update it`, { status: 502 })
    try {
      const { content } = await link.call('artifact.read', { thread, path }) as { content: string }
      return new Response(Buffer.from(content, 'base64'), { headers: {
        'content-type': ARTIFACT_TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream',
        'content-security-policy': ARTIFACT_POLICY,
      } })
    } catch (error) {
      const kind = (error as { kind?: string }).kind
      return new Response(error instanceof Error ? error.message : 'Not found', { status: kind === 'forbidden' ? 403 : 404 })
    }
  })
}
