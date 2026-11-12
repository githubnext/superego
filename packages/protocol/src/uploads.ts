// Where a call carries attachments: `thread.submit` and `thread.create`, directly or run by `action.run`. Both ends
// need to know, the client to upload them first and the daemon to put the uploads back in.
import type { AttachmentRef } from './methods.ts'

const CARRIERS = new Set(['thread.submit', 'thread.create'])

/** A call's attachments, from its own params or the params of the action it runs. */
export function attachmentsIn(method: string, params: unknown): AttachmentRef[] | undefined {
  const holder = holderOf(method, params)
  return Array.isArray(holder?.attachments) ? holder.attachments : undefined
}

/** `params` with its attachments replaced. */
export function withAttachments<T>(method: string, params: T, attachments: AttachmentRef[]): T {
  if (CARRIERS.has(method)) return { ...params, attachments }
  const run = params as { params: object }
  return { ...params, params: { ...run.params, attachments } }
}

function holderOf(method: string, params: unknown): { attachments?: unknown } | undefined {
  if (!params || typeof params !== 'object') return undefined
  if (CARRIERS.has(method)) return params
  const run = params as { id?: unknown; params?: unknown }
  if (method === 'action.run' && typeof run.id === 'string' && CARRIERS.has(run.id) && run.params && typeof run.params === 'object') return run.params
  return undefined
}
