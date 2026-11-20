// Where a sign-in page sends the browser back to: a loopback address (`http://127.0.0.1:<port>/mcp/callback`), fixed
// per app (`AppConfig.callbackPort`), since an authorization server registers it. The daemon listens there while a
// sign-in waits, and hands each flow the address the browser came back to, by its `state`. A port that's taken (another
// app; or the browser is on another computer) is left alone: the flow's `manual_code` prompt is how then, pasted or
// answered by the desktop app (sign-in-callback.ts) or the command line, which listen on their own computer.
// Plain `node:http`, so the command line can use it too.
import { createServer, type IncomingMessage, type Server } from 'node:http'

export const CALLBACK_PATH = '/mcp/callback'
export const DEFAULT_CALLBACK_PORT = 1456

/** The redirect URI for an app's port. */
export const redirectOf = (port: number) => `http://127.0.0.1:${port}${CALLBACK_PATH}`

const html = (text: string) => `<!doctype html><meta charset="utf-8"><title>${text.split('.')[0]}</title>
<body style="font: 15px system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; text-align: center">
<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p></body>`

/** The browser's connection isn't kept: the listener stops once it's back, and a kept one would outlive it. */
const HTML = { 'content-type': 'text/html; charset=utf-8', connection: 'close' }

/**
 * Where a request to a listener at `base` went: undefined for a target that's no path there (`//…`, `*`, an absolute
 * URL, one that isn't a URL at all), which is turned away rather than thrown: a throw in a listener ends the process.
 */
function addressOf(request: IncomingMessage, base: string | URL): URL | undefined {
  const target = request.url ?? '/'
  return target.startsWith('/') && !target.startsWith('//') ? URL.parse(target, base) ?? undefined : undefined
}

/** What the browser sees once it's back. */
function answer(url: URL): { status: number; text: string } {
  const error = url.searchParams.get('error')
  if (error) return { status: 200, text: `Signing in didn't go through (${error}). You can close this tab and go back to the app.` }
  return { status: 200, text: 'Signed in. You can close this tab and go back to the app.' }
}

/**
 * The daemon's listener: one server on the port while any flow waits, each flow's redirect handed to it by `state`.
 * `log`: what went wrong listening (a taken port).
 */
export class Callbacks {
  readonly port: number
  #waiting = new Map<string, (url: URL) => void>()
  #server?: Server
  #log: (line: string) => void
  constructor(port: number, log: (line: string) => void = () => {}) {
    this.port = port
    this.#log = log
  }

  /**
   * The address the browser comes back to with `state`. Never settles when the port can't be had (pasting is how then);
   * rejects when `signal` aborts.
   */
  wait(state: string, signal: AbortSignal): Promise<URL> {
    return new Promise<URL>((resolve, reject) => {
      const stop = () => { this.#waiting.delete(state); this.#release() }
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener('abort', () => { stop(); reject(signal.reason) }, { once: true })
      this.#waiting.set(state, (url) => { stop(); resolve(url) })
      this.#listen()
    })
  }

  /** Stop listening, whatever waits: the daemon is stopping. */
  close() {
    this.#waiting.clear()
    this.#release()
  }

  #listen() {
    if (this.#server) return
    const server = this.#server = createServer((request, response) => {
      const url = addressOf(request, `http://127.0.0.1:${this.port}`)
      if (!url) return void response.writeHead(400).end()
      if (url.pathname !== CALLBACK_PATH) return void response.writeHead(404).end()
      const done = this.#waiting.get(url.searchParams.get('state') ?? '')
      if (!done) {
        response.writeHead(400, HTML).end(html('This sign-in is no longer going on. Start it again from the app.'))
        return
      }
      const { status, text } = answer(url)
      response.writeHead(status, HTML).end(html(text))
      done(url)
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      this.#log(`can't listen on 127.0.0.1:${this.port} for sign-ins (${error.code ?? error.message}): the address is pasted instead`)
      if (this.#server === server) this.#server = undefined
    })
    server.listen(this.port, '127.0.0.1')
    server.unref()
  }

  #release() {
    if (this.#waiting.size || !this.#server) return
    const server = this.#server
    this.#server = undefined
    if (server.listening) { server.close(); server.closeIdleConnections() }
  }
}

/**
 * Catch one redirect at `callback` on this computer, for a flow running on another (the command line's `-m`): resolves
 * with the whole address the browser was sent to; never settles when the port is taken; rejects when `signal` aborts.
 * `page`: the sign-in page; a request without the `state` it was given is turned away, and the listening goes on.
 */
export function catchRedirect(callback: string, signal: AbortSignal, page?: string): Promise<string> {
  let state: string | undefined
  try { state = page ? new URL(page).searchParams.get('state') ?? undefined : undefined } catch { state = undefined }
  return new Promise<string>((resolve, reject) => {
    const where = new URL(callback)
    const server = createServer((request, response) => {
      const url = addressOf(request, where)
      if (!url) return void response.writeHead(400).end()
      if (url.pathname !== where.pathname) return void response.writeHead(404).end()
      if (state !== undefined && url.searchParams.get('state') !== state) {
        return void response.writeHead(400, HTML).end(html('This isn\'t the sign-in the command line is waiting for.'))
      }
      response.writeHead(200, HTML).end(html(answer(url).text))
      close()
      resolve(url.href)
    })
    const close = () => { if (server.listening) { server.close(); server.closeIdleConnections() } }
    signal.addEventListener('abort', () => { close(); reject(signal.reason) }, { once: true })
    server.on('error', () => {})
    server.listen(Number(where.port), '127.0.0.1')
    server.unref()
  })
}
