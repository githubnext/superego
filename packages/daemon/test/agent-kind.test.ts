// Another kind of agent: an extension's task runs a thread's turns in place of a model (`agentKind`, on pi-durable's
// agent `runner`, patches/@earendil-works__pi-durable@1.5.0.patch). pi-durable keeps the run: streaming, entries, the
// answer, and Stop; the daemon picks the kind from the thread's profile, for its whole life.
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createModels } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { AssistantEntry, createRegistry, defineExtension, defineTask, Harness, LiveDoc, MemoryStorage, ToolResultEntry, type ConversationId, type EntryId } from '@earendil-works/pi-durable'
import { defineApp, PROTOCOL_VERSION, type Hello, type ThreadInfo } from '@superego/protocol'
import { connectSocket, defineDaemonExtension, listen, openDaemon } from '../src/index.ts'
import { until } from './until.ts'

const msg = (content: unknown[], stopReason = 'stop') => ({ role: 'assistant', content, api: 'claude-agent', provider: 'claude-agent', model: 'claude', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() })

let release: () => void = () => {}
const Runner = defineTask({
  name: 'probe.turn', version: 1, initial: () => ({ phase: 'run' as const }),
  phases: {
    run: async (_task, runtime, context) => {
      const view = await runtime.context(runtime.conversationId, context)
      const said = JSON.stringify(view.messages.at(-1))
      await runtime.commit(async (tx) => { (await tx.doc(LiveDoc, runtime.conversationId)).generation = { attempt: 1, message: msg([{ type: 'text', text: 'Thinking' }]) as never }; return undefined }, context, { persistence: { kind: 'deferred' } })
      await new Promise<void>((r) => { release = r; runtime.signal.addEventListener('abort', () => r()) })
      runtime.signal.throwIfAborted()
      await runtime.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, runtime.conversationId)
        delete live.generation
        await tx.appendEntry(AssistantEntry, runtime.conversationId, { model: [msg([{ type: 'toolCall', id: 't1', name: 'Bash', arguments: { command: 'ls' } }], 'toolUse')] as never })
        await tx.appendEntry(ToolResultEntry, runtime.conversationId, { data: { diagnostics: [] }, model: [{ role: 'toolResult', toolCallId: 't1', toolName: 'Bash', content: [{ type: 'text', text: 'a b' }], isError: false, timestamp: Date.now() }] as never })
        const answer = await tx.appendEntry(AssistantEntry, runtime.conversationId, { model: [msg([{ type: 'text', text: `Got ${said.length}` }])] as never })
        return { status: 'terminal', outcome: { status: 'completed', result: { entryId: answer.id } } }
      }, context)
    },
  },
  abort: async (_task, runtime, context) => { await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) },
})

it('pi-durable: a runner runs a turn, and Stop ends it keeping what it streamed', async () => {
  const registry = createRegistry()
  registry.install(defineExtension({ name: 'probe', tasks: [Runner] }))
  const harness = await Harness.open(new MemoryStorage(), { registry, models: createModels({ credentials: { get: async () => undefined } as never }) }, ctx)
  harness.resume()
  const c = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { runner: 'probe.turn' } }, ctx)
  await c.submit({ type: 'input', content: 'hi' }, ctx)
  await new Promise((r) => setTimeout(r, 100))
  const live = await harness.snapshot(LiveDoc, c.id as ConversationId, ctx)
  expect(live?.run).toBeDefined()
  expect((live?.generation?.message as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'Thinking' }])
  release()
  await c.waitForIdle(ctx)
  const { items } = await c.entries({}, 10, undefined, ctx)
  expect(items.map((e) => e.kind)).toEqual(['pi.assistant', 'pi.tool-result', 'pi.assistant', 'pi.user'])
  expect((await harness.snapshot(LiveDoc, c.id as ConversationId, ctx))?.run).toBeUndefined()
  // Stop mid-turn: the partial becomes an aborted entry, the run fails `aborted`.
  await c.submit({ type: 'input', content: 'again' }, ctx)
  await new Promise((r) => setTimeout(r, 100))
  await c.abort(ctx)
  const after = await harness.snapshot(LiveDoc, c.id as ConversationId, ctx)
  expect(after).toMatchObject({ runFailure: { reason: 'aborted' } })
  const all = await c.entries({}, 20, undefined, ctx)
  expect(all.items[0]!.model).toMatchObject([{ content: [{ type: 'text', text: 'Thinking' }], stopReason: 'aborted' }])
  await harness.close(ctx)
})

/** A kind of agent that answers with what it was told, without a model. */
const Echo = defineTask<Record<string, never>, { phase: 'run' }, { entryId: EntryId }>({
  name: 'echo-agent.turn', version: 1, initial: () => ({ phase: 'run' }),
  phases: {
    run: async (_task, runtime, context) => {
      const view = await runtime.context(runtime.conversationId, context)
      const said = view.messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : m.content.map((c) => c.type === 'text' ? c.text : '').join('')).at(-1)
      await runtime.commit(async (tx) => {
        const entry = await tx.appendEntry(AssistantEntry, runtime.conversationId, { model: [msg([{ type: 'text', text: `Echo: ${said}` }])] as never })
        return { status: 'terminal', outcome: { status: 'completed', result: { entryId: entry.id } } }
      }, context)
    },
  },
  abort: async (_task, runtime, context) => { await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) },
})
const echo = defineDaemonExtension({ name: 'echo-agent', version: '1.0.0', api: '^5.3', setup(s) { s.agentKind({ name: 'echo-agent', runner: Echo }) } })

async function daemonWith(profile: string) {
  const dir = await mkdtemp(join(tmpdir(), 'superego-agent-kind-'))
  mkdirSync(join(dir, 'profiles', 'default'), { recursive: true })
  writeFileSync(join(dir, 'profiles', 'default', 'profile.ts'), profile)
  // No model on this machine: a thread of another kind doesn't need one.
  delete process.env.SUPEREGO_MODEL
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
  const daemon = await openDaemon({ app: defineApp({ name: 'superego', id: 'superego' }), dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [echo] })
  const server = await listen(daemon, join(dir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
  await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, dir, close: async () => { socket.destroy(); server.close(); await daemon.close(); await rm(dir, { recursive: true, force: true }) } }
}

it("runs the turns of a thread whose profile picks another kind of agent with that kind's runner, no model needed", async () => {
  const { peer, close } = await daemonWith("export default { agent: 'echo-agent' }\n")
  try {
    const thread = await peer.call<ThreadInfo>('thread.start', { prompt: 'Hello there' })
    let info = thread
    await until(async () => { info = (await peer.call<{ thread: ThreadInfo }>('thread.read', { thread: thread.id })).thread; return info.status.state === 'done' })
    expect(info.status.msg).toBe('Echo: Hello there')
    // It has no model of Superego's to show.
    expect(info.model).toBeUndefined()
  } finally { await close() }
})

it('refuses to start a thread with a profile whose kind of agent no extension here has', async () => {
  const { peer, close } = await daemonWith("export default { agent: 'nobody' }\n")
  try {
    await expect(peer.call('thread.start', {})).rejects.toThrow("Profile default runs on nobody, which isn't here")
  } finally { await close() }
})
