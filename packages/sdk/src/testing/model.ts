// A scripted model: what it answers each turn, in order. `say` ends a turn with text; `callTool` asks for tools to run
// (their results go back to the model, and its next turn is the next in the script).
//
//   model: [callTool('enqueue', { what: 'lint' }), say('Queued.')]

/** One answer of the model's, as the replay provider reads it. */
export type Turn = { at: number; provider: string; model: string; message: { role: 'assistant'; content: unknown[]; stopReason: 'stop' | 'toolUse' } }

const turn = (content: unknown[], stopReason: 'stop' | 'toolUse'): Turn => ({ at: 0, provider: 'test', model: 'test', message: { role: 'assistant', content, stopReason } })

let calls = 0

/** A turn that answers with `text`, ending the run. */
export const say = (text: string): Turn => turn([{ type: 'text', text }], 'stop')

/** A turn that calls a tool with `args` (`id`: the call's, else one made up); several in one turn: `callTools`. */
export const callTool = (name: string, args: Record<string, unknown> = {}, id = `call-${++calls}`): Turn =>
  turn([{ type: 'toolCall', id, name, arguments: args }], 'toolUse')

/** A turn that calls several tools at once. */
export const callTools = (...tools: { name: string; args?: Record<string, unknown>; id?: string }[]): Turn =>
  turn(tools.map(({ name, args = {}, id = `call-${++calls}` }) => ({ type: 'toolCall', id, name, arguments: args })), 'toolUse')
