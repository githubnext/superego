// A minimal client of a daemon's unix socket: line-delimited JSON-RPC, as the app and the CLI speak it.
import { connect, type Socket } from 'node:net'

export type Rpc = {
  call<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  close(): void
}

export async function openRpc(socket: string): Promise<Rpc> {
  const conn: Socket = await new Promise((resolve, reject) => {
    const s = connect(socket, () => resolve(s))
    s.once('error', reject)
  })
  let next = 1
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  let buffer = ''
  conn.setEncoding('utf8')
  conn.on('data', (chunk: string) => {
    buffer += chunk
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      let message: any
      try { message = JSON.parse(line) } catch { continue }
      if (message.id === undefined || !pending.has(message.id)) continue // notifications, requests to us
      const waiter = pending.get(message.id)!
      pending.delete(message.id)
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { data: message.error.data }))
      else waiter.resolve(message.result)
    }
  })
  conn.on('close', () => { for (const w of pending.values()) w.reject(new Error('daemon connection closed')); pending.clear() })
  const rpc: Rpc = {
    call(method, params = {}, timeoutMs = 60_000) {
      const id = next++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v as any) }, reject: (e) => { clearTimeout(timer); reject(e) } })
        conn.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    close: () => conn.destroy(),
  }
  await rpc.call('hello', { client: 'superego-eval', version: 2, label: 'eval' }).catch(() => {})
  return rpc
}
