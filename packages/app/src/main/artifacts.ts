// Artifacts: HTML the agent wrote, served from the thread's machine on a scheme of their own (superego-artifact://, see
// shared/bridge.ts's artifactUrl), sandboxed.
import { protocol } from 'electron'
import type { Link } from '@superego/client'

/** What an artifact may do: run its own scripts and forms, nothing of the app's (an opaque origin). */
const ARTIFACT_POLICY = "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https: 'unsafe-inline' 'unsafe-eval'"

const ARTIFACT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
}

const SCHEME = 'superego-artifact'

/** Before the app is ready: the scheme, as a standard and secure one that can be fetched from. */
export function registerArtifactScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

/** Once it's ready: serve `<machine>/<thread>/<path>` from the thread's folder on that machine. */
export function serveArtifacts(linkOf: (machine: string) => Link | undefined) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const [thread, ...rest] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const link = linkOf(decodeURIComponent(url.hostname))
    if (!link || !thread || !rest.length) return new Response('Not found', { status: 404 })
    try {
      const path = rest.join('/')
      const { content } = await link.call('file.read', { thread, path, base64: true }) as { content: string }
      return new Response(Buffer.from(content, 'base64'), { headers: {
        'content-type': ARTIFACT_TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream',
        'content-security-policy': ARTIFACT_POLICY,
      } })
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'Not found', { status: 404 })
    }
  })
}
