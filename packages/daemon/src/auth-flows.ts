// Sign-in flows: a provider's (agent-settings.ts) and an extension's own (`superego.auth.flow`), carried the same way.
// A flow tells the client that started it what's happening (`auth.event`: a page to open, a code to enter, progress),
// asks it things (`prompt`, answered with `auth.respond`), and ends `done` or `failed`; `auth.cancel` stops it.
import { randomUUID } from 'node:crypto'
import { RpcError, type AuthEvent, type AuthPrompt } from '@superego/protocol'

/** What a flow says on its way: everything but its prompts and its end, which the machinery says for it. */
export type AuthFlowEvent = Exclude<AuthEvent, { type: 'prompt' | 'prompt_closed' | 'done' | 'failed' }>

/** A sign-in flow as its `run` has it. */
export type AuthFlow = {
  /** The flow's id, as the client has it (`auth.respond`, `auth.cancel`). */
  id: string
  /** Aborted when the flow is cancelled, or the daemon (or the extension running it) stops. */
  signal: AbortSignal
  /** Tell the client something: a page to open (`auth_url`), a code to enter (`device_code`), `info` or `progress`. */
  emit(event: AuthFlowEvent): void
  /**
   * Ask the client, and wait for its answer: a key (`secret`), a choice (`select`), the page's redirect URL pasted
   * (`manual_code`). Rejects when the flow is cancelled, or `signal` aborts (the browser's redirect came first, say).
   */
  prompt(prompt: AuthPrompt, options?: { signal?: AbortSignal }): Promise<string>
}

type Running = { abort: AbortController; prompts: Map<string, { resolve(value: string): void; close(): void }> }

export type AuthFlows = {
  /**
   * Run a flow, its events going to `emit`: `done` once `run` resolves, `failed` with its error once it throws
   * (`Cancelled` when cancelled). `signal`: the flow is cancelled when it aborts (its extension torn down). Its id, at once.
   */
  start(emit: (event: AuthEvent) => void, run: (flow: AuthFlow) => Promise<void>, signal?: AbortSignal): string
  /** Answer a flow's prompt; `not_found` when it no longer waits. */
  respond(flow: string, prompt: string, value: string): void
  cancel(flow: string): void
  /** Cancel every flow: the daemon is stopping. */
  close(): void
}

export function createAuthFlows(): AuthFlows {
  const flows = new Map<string, Running>()
  return {
    start(emit, run, signal) {
      const id = randomUUID()
      const flow: Running = { abort: new AbortController(), prompts: new Map() }
      flows.set(id, flow)
      const cancel = () => flow.abort.abort()
      signal?.addEventListener('abort', cancel, { once: true })
      const prompt = (prompt: AuthPrompt, options?: { signal?: AbortSignal }) => new Promise<string>((resolve, reject) => {
        const promptId = randomUUID()
        const close = () => {
          if (!flow.prompts.delete(promptId)) return
          reject(new Error('Prompt closed'))
          emit({ type: 'prompt_closed', id: promptId })
        }
        flow.prompts.set(promptId, {
          // Answered, by whoever: every client showing it can put it away.
          resolve: (value) => { flow.prompts.delete(promptId); emit({ type: 'prompt_closed', id: promptId }); resolve(value) },
          close,
        })
        options?.signal?.addEventListener('abort', close, { once: true })
        flow.abort.signal.addEventListener('abort', close, { once: true })
        emit({ type: 'prompt', id: promptId, prompt })
      })
      const api: AuthFlow = { id, signal: flow.abort.signal, emit: (event) => { if (!flow.abort.signal.aborted) emit(event) }, prompt }
      // After the id is returned: the client knows the flow before it hears of it.
      void Promise.resolve().then(() => run(api)).then(() => {
        emit({ type: 'done' })
      }, (error: unknown) => {
        emit({ type: 'failed', message: flow.abort.signal.aborted ? 'Cancelled' : error instanceof Error ? error.message : String(error) })
      }).finally(() => {
        flows.delete(id)
        signal?.removeEventListener('abort', cancel)
        for (const pending of flow.prompts.values()) pending.close()
      })
      return id
    },
    respond(flow, prompt, value) {
      const pending = flows.get(flow)?.prompts.get(prompt)
      if (!pending) throw new RpcError('not_found', 'That sign-in step is no longer waiting')
      pending.resolve(value)
    },
    cancel(flow) {
      flows.get(flow)?.abort.abort()
    },
    close() {
      for (const flow of flows.values()) flow.abort.abort()
    },
  }
}
