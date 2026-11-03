// JSON-RPC 2.0, one message per line. Transport-agnostic: a unix socket, ssh stdio, or Electron IPC all carry the
// same lines. Both ends use the same `RpcPeer`: either side may call, handle, or notify.

export type RpcErrorData = { kind: string; hint?: string }
export type RpcErrorObject = { code: number; message: string; data?: RpcErrorData }

type Request = { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
type Response = { jsonrpc: '2.0'; id: number; result?: unknown; error?: RpcErrorObject }
type Notification = { jsonrpc: '2.0'; method: string; params?: unknown }
type Message = Request | Response | Notification

export class RpcError extends Error {
  readonly kind: string
  readonly code: number
  readonly hint?: string
  constructor(kind: string, message: string, options: { code?: number; hint?: string } = {}) {
    super(message)
    this.kind = kind
    this.code = options.code ?? -32000
    this.hint = options.hint
  }
}

export type Handler = (params: any) => unknown
export type NotificationHandler = (params: any) => void

export class RpcPeer {
  #send: (line: string) => void
  #next = 1
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  #handlers = new Map<string, Handler>()
  #listeners = new Map<string, Set<NotificationHandler>>()
  #any = new Set<(method: string, params: unknown) => void>()
  #closed: Error | undefined

  constructor(send: (line: string) => void) {
    this.#send = send
  }

  /** Feed one line received from the other end. Malformed lines are ignored. */
  receive(line: string): void {
    if (!line.trim()) return
    let message: Message
    try { message = JSON.parse(line) } catch { return }
    if ('id' in message && 'method' in message) void this.#dispatch(message)
    else if ('id' in message) this.#settle(message)
    else if ('method' in message) {
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params)
      for (const listener of this.#any) listener(message.method, message.params)
    }
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed)
    const id = this.#next++
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.#closed) this.#write({ jsonrpc: '2.0', method, params })
  }

  handle(method: string, handler: Handler): void {
    this.#handlers.set(method, handler)
  }

  on(method: string, listener: NotificationHandler): () => void {
    let set = this.#listeners.get(method)
    if (!set) this.#listeners.set(method, (set = new Set()))
    set.add(listener)
    return () => set.delete(listener)
  }

  /** Every notification, for relays that forward them without knowing their names. */
  onAny(listener: (method: string, params: unknown) => void): () => void {
    this.#any.add(listener)
    return () => this.#any.delete(listener)
  }

  get methods(): string[] {
    return [...this.#handlers.keys()]
  }

  /** Reject every pending call; later calls reject at once. */
  close(reason = new RpcError('closed', 'Connection closed')): void {
    if (this.#closed) return
    this.#closed = reason
    for (const pending of this.#pending.values()) pending.reject(reason)
    this.#pending.clear()
  }

  #write(message: Message) {
    this.#send(JSON.stringify(message) + '\n')
  }

  #settle(response: Response) {
    const pending = this.#pending.get(response.id)
    if (!pending) return
    this.#pending.delete(response.id)
    if (response.error) {
      const { data, message, code } = response.error
      pending.reject(new RpcError(data?.kind ?? 'error', message, { code, hint: data?.hint }))
    } else pending.resolve(response.result ?? null)
  }

  async #dispatch(request: Request) {
    const handler = this.#handlers.get(request.method)
    try {
      if (!handler) throw new RpcError('unknown_method', `Unknown method ${request.method}`, { code: -32601 })
      const result = await handler(request.params ?? {})
      if (!this.#closed) this.#write({ jsonrpc: '2.0', id: request.id, result: result ?? null })
    } catch (error) {
      if (this.#closed) return
      const rpc = error instanceof RpcError ? error : new RpcError('internal', error instanceof Error ? error.message : String(error))
      this.#write({ jsonrpc: '2.0', id: request.id, error: { code: rpc.code, message: rpc.message, data: { kind: rpc.kind, hint: rpc.hint } } })
    }
  }
}

/** Split a stream of text chunks into lines. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      onLine(line)
    }
  }
}
