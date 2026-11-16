// The harness's connection to a run's daemon: its unix socket, as the CLI opens it (@superego/client), and the
// protocol's typed calls. Hello says the protocol's generation, so a daemon of another one refuses loudly.
import { openLocal } from '@superego/client'
import { PROTOCOL_VERSION, type Hello, type MethodName, type Params, type Result } from '@superego/protocol'

export type Rpc = {
  call<M extends MethodName>(method: M, params: Params<M>, timeoutMs?: number): Promise<Result<M>>
  /** An action by id, as the command line runs it (`exposure: 'cli'`). Its result is the action's own: the caller types it. */
  action<T>(id: string, params?: unknown): Promise<T>
  close(): void
}

export async function openRpc(socket: string): Promise<Rpc> {
  const transport = await openLocal(socket)
  const call = <M extends MethodName>(method: M, params: Params<M>, timeoutMs = 60_000): Promise<Result<M>> => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs) })
    return Promise.race([transport.peer.call<Result<M>>(method, params), timeout]).finally(() => clearTimeout(timer))
  }
  try {
    await transport.peer.call<Hello>('hello', { client: 'superego-eval', version: PROTOCOL_VERSION, label: 'eval' })
  } catch (error) {
    transport.close()
    throw error
  }
  return {
    call,
    action: async <T>(id: string, params: unknown = {}) => await call('action.run', { id, params, exposure: 'cli' }) as T,
    close: () => transport.close(),
  }
}
