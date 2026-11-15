// Signing in to another computer's machine as if it were this one. A sign-in flow sends the browser to a page that
// redirects back to a loopback address (`auth_url`'s `callback`: `http://127.0.0.1:<port>/…`). When the flow's machine
// is this computer, its daemon listens there itself. When it's another computer, the redirect would reach nothing
// there, so the flow also asks for the redirect URL to be pasted (a `manual_code` prompt). The app listens at that
// address on this computer while the flow is open, and answers that prompt with the URL the browser was sent to. The
// machine checks the URL (its `state`) and finishes signing in. A port that's taken here is left alone: pasting works.
import { createServer, type Server } from 'node:http'
import type { AuthEvent } from '@superego/protocol'

/** Answer a machine's flow (`auth.respond`). */
type Respond = (machine: string, params: { flow: string; prompt: string; value: string }) => Promise<unknown>

type Catching = {
  machine: string
  flow: string
  callback: URL
  server: Server
  timer: ReturnType<typeof setTimeout>
  /** The `manual_code` prompt waiting for the URL. */
  prompt?: string
  /** The URL the browser was sent to, once it came. */
  caught?: string
}

/** What a flow's own page says once the browser came back. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font: 15px system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; text-align: center">
<p>You can close this tab and go back to the app.</p></body>`

/** A loopback address the app may listen on: plain http, on this computer, at a port that needs no privilege. */
function loopback(text: string): URL | undefined {
  try {
    const url = new URL(text)
    const port = Number(url.port)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && port >= 1024 ? url : undefined
  } catch { return undefined }
}

/**
 * Catch remote machines' sign-in redirects on this computer: `heard` is given every `auth.event` from a machine on
 * another computer. `timeout`: how long a flow's catcher stays open without its flow ending.
 */
export function createSignInCatcher(respond: Respond, { timeout = 10 * 60_000 } = {}) {
  /** By the port it listens on: a port is one flow's at a time, the newest's. */
  const open = new Map<number, Catching>()
  const forFlow = (machine: string, flow: string) => [...open.values()].find((c) => c.machine === machine && c.flow === flow)

  function stop(catching: Catching) {
    clearTimeout(catching.timer)
    if (catching.server.listening) catching.server.close()
    if (open.get(Number(catching.callback.port)) === catching) open.delete(Number(catching.callback.port))
  }
  function answer(catching: Catching) {
    if (!catching.caught || !catching.prompt) return
    const prompt = catching.prompt
    catching.prompt = undefined
    respond(catching.machine, { flow: catching.flow, prompt, value: catching.caught }).catch(() => {})
  }
  function listen(machine: string, flow: string, callback: URL) {
    const port = Number(callback.port)
    const before = open.get(port)
    if (before) stop(before)
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', callback)
      if (url.pathname !== callback.pathname) return void response.writeHead(404).end()
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
      catching.caught = url.href
      // Caught: the port goes back, and the flow gets it once it asks.
      server.close()
      answer(catching)
    })
    const catching: Catching = { machine, flow, callback, server, timer: setTimeout(() => stop(catching), timeout) }
    catching.timer.unref?.()
    open.set(port, catching)
    // Taken here (another app, this computer's own daemon): pasting it is how.
    server.on('error', () => stop(catching))
    server.listen(port, '127.0.0.1')
  }

  return {
    /** An `auth.event` of `machine`'s flow `flow`, a machine on another computer. */
    heard(machine: string, flow: string, event: AuthEvent) {
      const catching = forFlow(machine, flow)
      if (event.type === 'auth_url' && event.callback) {
        const callback = loopback(event.callback)
        if (callback && !catching) listen(machine, flow, callback)
        return
      }
      if (!catching) return
      if (event.type === 'prompt' && event.prompt.type === 'manual_code') {
        catching.prompt = event.id
        answer(catching)
      } else if (event.type === 'prompt_closed' && event.id === catching.prompt) {
        catching.prompt = undefined
      } else if (event.type === 'done' || event.type === 'failed') {
        stop(catching)
      }
    },
    /** Stop listening for every flow: the app is quitting. */
    close() { for (const catching of [...open.values()]) stop(catching) },
  }
}
