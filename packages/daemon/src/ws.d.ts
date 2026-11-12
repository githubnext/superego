// The part of `ws` the web server (and its tests) use (its own types aren't installed).
declare module 'ws' {
  import type { IncomingMessage } from 'node:http'
  import type { Duplex } from 'node:stream'
  export class WebSocket {
    /** A client, for tests: `ws+unix:///path/to.sock:/rpc` reaches a unix socket. */
    constructor(address: string, options?: { headers?: Record<string, string> })
    readonly OPEN: number
    readyState: number
    send(data: string): void
    terminate(): void
    close(code?: number, reason?: string): void
    on(event: 'message', listener: (data: Buffer | string) => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'open' | 'error', listener: () => void): this
    on(event: 'unexpected-response', listener: (request: unknown, response: IncomingMessage) => void): this
    once(event: 'open', listener: () => void): this
    once(event: 'close', listener: (code: number, reason: Buffer) => void): this
    once(event: 'unexpected-response', listener: (request: unknown, response: IncomingMessage) => void): this
  }
  export class WebSocketServer {
    constructor(options: { noServer: true; maxPayload?: number })
    readonly clients: Set<WebSocket>
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WebSocket) => void): void
    close(): void
  }
}
