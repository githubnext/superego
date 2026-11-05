// The part of `ws` the web server uses (its own types aren't installed).
declare module 'ws' {
  import type { IncomingMessage } from 'node:http'
  import type { Duplex } from 'node:stream'
  export class WebSocket {
    readonly OPEN: number
    readyState: number
    send(data: string): void
    terminate(): void
    on(event: 'message', listener: (data: Buffer | string) => void): this
    on(event: 'close' | 'error', listener: () => void): this
  }
  export class WebSocketServer {
    constructor(options: { noServer: true; maxPayload?: number })
    readonly clients: Set<WebSocket>
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WebSocket) => void): void
    close(): void
  }
}
