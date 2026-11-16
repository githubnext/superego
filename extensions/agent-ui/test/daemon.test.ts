import { afterEach, expect, it } from 'vitest'
import { callTool, callTools, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import type { Json, ThreadInfo } from '@superego/protocol'
import agentUi from '../src/daemon.ts'
import { ANSWER, PANES, WAITING, type ThreadPanes, type Waiting } from '../src/shared.ts'

let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close(); daemon = undefined })

type Message = { role?: string; isError?: boolean; content?: { text?: string }[]; details?: unknown }
const toolResults = async (id: string) =>
  (JSON.parse(await daemon!.transcript(id)) as { model?: Message[] }[]).map((entry) => entry.model?.[0]).filter((m) => m?.role === 'toolResult') as Message[]
const statusOf = async (id: string) => (await daemon!.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id)!.status

const BLOCKS: Json[] = [
  { type: 'markdown', text: 'Which layout?' },
  { type: 'choice', id: 'layout', options: [{ label: 'Grid', value: 'grid' }, { label: 'List', value: 'list', description: 'Denser' }] },
]

it('waits on ask_user and ask_ui in one queue, oldest first, each answered by any client', async () => {
  daemon = await testDaemon({
    extensions: [agentUi],
    model: [
      callTools(
        { name: 'ask_user', id: 'q', args: { question: 'I looked.\n\nWhich colour?', options: ['red', { label: 'blue', description: 'like the sky' }] } },
        { name: 'ask_ui', id: 'f', args: { title: 'Pick a layout', blocks: BLOCKS } },
      ),
      say('Blue lists it is.'),
    ],
  })
  expect(daemon.extensions.map((e) => e.name)).toContain('agent-ui')
  const thread = await daemon.thread()
  // The thread's own scope; another's hears nothing.
  const waiting = await daemon.watch<Waiting[]>(WAITING, { scope: thread.id })
  const other = await daemon.watch<Waiting[]>(WAITING, { scope: 'another' })
  await daemon.call('thread.send', { thread: thread.id, text: 'pick for me' })
  await waiting.until((list) => list.length === 2, 'both to wait')
  expect(waiting.value).toMatchObject([
    { id: 'q', tool: 'ask_user', thread: thread.id, question: 'I looked.\n\nWhich colour?', options: [{ label: 'red' }, { label: 'blue', description: 'like the sky' }] },
    { id: 'f', tool: 'ask_ui', thread: thread.id, title: 'Pick a layout', blocks: BLOCKS },
  ])
  expect(await statusOf(thread.id)).toEqual({ state: 'blocked', kind: 'question', msg: 'I looked.\n\nWhich colour?' })

  await expect(daemon.dispatch(ANSWER, { id: 'nope', text: 'x' })).rejects.toMatchObject({ kind: 'not_found' })
  // A question is answered in words, and some words: blank isn't an answer.
  await expect(daemon.dispatch(ANSWER, { id: 'q', values: {} })).rejects.toMatchObject({ kind: 'invalid' })
  await expect(daemon.dispatch(ANSWER, { id: 'q', text: '   ' })).rejects.toMatchObject({ kind: 'invalid' })
  await daemon.dispatch(ANSWER, { id: 'q', text: ' blue ' })
  // The next comes up, and the thread says so.
  await waiting.until((list) => list.length === 1 && list[0]!.id === 'f', 'the form to be next')
  expect(await statusOf(thread.id)).toEqual({ state: 'blocked', kind: 'question', msg: 'Pick a layout' })

  await expect(daemon.dispatch(ANSWER, { id: 'f', values: ['x'] })).rejects.toMatchObject({ kind: 'invalid' })
  await daemon.dispatch(ANSWER, { id: 'f', values: { layout: 'list' }, button: 'submit' })
  await waiting.until((list) => list.length === 0, 'nothing to wait on')
  await daemon.idle(thread.id)
  expect(other.seen).toEqual([[]])

  const [question, form] = await toolResults(thread.id)
  expect(question!.content![0]!.text).toBe('The user answered: blue')
  expect(question!.details).toMatchObject({ id: 'q', answer: 'blue' })
  expect(JSON.parse(form!.content![0]!.text!)).toEqual({ values: { layout: 'list' }, button: 'submit' })
  // Locked on the answer, with the UI it answered, after a reload too.
  expect(form!.details).toMatchObject({ id: 'f', title: 'Pick a layout', blocks: BLOCKS, answer: { values: { layout: 'list' }, button: 'submit' } })
  expect(await daemon.transcript(thread.id)).toContain('Blue lists it is.')
})

it('takes an answer to ask_ui in words instead', async () => {
  daemon = await testDaemon({ extensions: [agentUi], model: [callTool('ask_ui', { blocks: BLOCKS }, 'f'), say('Fine.')] })
  const thread = await daemon.thread('set it up')
  expect(await statusOf(thread.id)).toMatchObject({ state: 'blocked', msg: 'Waiting for your answer' })
  // Two answers at the same moment (two windows): the first is taken, the second told it's no longer waiting.
  const [first, second] = await Promise.allSettled([
    daemon.dispatch(ANSWER, { id: 'f', text: ' whatever is fastest ' }),
    daemon.dispatch(ANSWER, { id: 'f', text: 'the other one' }),
  ])
  expect(first.status).toBe('fulfilled')
  expect(second).toMatchObject({ status: 'rejected', reason: { kind: 'not_found' } })
  await daemon.until(async () => (await statusOf(thread.id)).state === 'done', 'the run to end')
  const [result] = await toolResults(thread.id)
  expect(JSON.parse(result!.content![0]!.text!)).toEqual({ text: 'whatever is fastest' })
})

it('show_ui returns at once, with the whole UI in its details; bad blocks get errors to fix', async () => {
  daemon = await testDaemon({
    extensions: [agentUi],
    model: [
      callTool('show_ui', { blocks: [{ type: 'markdown', txt: 'oops' }] }),
      callTool('show_ui', { title: 'Layouts', blocks: BLOCKS }),
      callTool('show_ui', { blocks: [{ type: 'buttons', buttons: [{ id: 'rm', label: 'Continue', action: 'machine.remove' }] }] }),
      say('Pick one when you like.'),
    ],
  })
  const thread = await daemon.thread('show me layouts')
  const [bad, good, acting] = await toolResults(thread.id)
  expect(bad!.isError).toBe(true)
  expect(bad!.content![0]!.text).toContain('blocks[0].text: missing')
  expect(bad!.content![0]!.text).toContain('blocks[0].txt: unknown field')
  expect(good!.isError).toBe(false)
  expect(good!.details).toEqual({ title: 'Layouts', blocks: BLOCKS })
  // An agent's buttons answer: never one that runs an action.
  expect(acting!.isError).toBe(true)
  expect(acting!.content![0]!.text).toContain("blocks[0].buttons[0]: an agent's buttons answer; they can't run actions")
})

it('opens a ui pane with { id }, updates its UI by id, and keeps it across a restart', async () => {
  const first: Json[] = [{ type: 'markdown', text: 'Building…' }]
  const second: Json[] = [{ type: 'kv', items: [{ label: 'Tests', value: 'passing' }] }, { type: 'buttons', buttons: [{ id: 'ship', label: 'Ship it' }] }]
  daemon = await testDaemon({
    extensions: [agentUi],
    model: [
      callTool('open_ui', { id: 'status', title: 'Build', blocks: first }),
      callTool('update_ui', { id: 'status', title: 'Build: green', blocks: second }),
      callTool('update_ui', { id: 'nope', blocks: first }),
      say('All green.'),
    ],
  })
  const thread = await daemon.thread('build it')
  const [info] = await daemon.call<ThreadInfo[]>('thread.list', {})
  expect(info!.panes).toEqual([{ id: expect.any(String), kind: 'ui', title: 'Build: green', params: { id: 'status' } }])
  // In the thread's own scope, read from the thread as it's watched (null until then); another's has none: empty.
  const panes = await daemon.watch<ThreadPanes | null>(PANES, { scope: thread.id })
  await panes.until((value) => value !== null)
  expect(panes.value!.status).toMatchObject({ id: 'status', title: 'Build: green', blocks: second })
  const another = await daemon.watch<ThreadPanes | null>(PANES, { scope: 'another' })
  expect(await another.until((value) => value !== null)).toEqual({})

  const results = await toolResults(thread.id)
  expect(results.map((r) => r.isError)).toEqual([false, false, true])
  expect(results[2]!.content![0]!.text).toContain('No UI pane "nope"')

  // Kept with the thread: read again as a pane watches it, after the daemon restarts.
  daemon = await daemon.restart()
  const kept = await daemon.watch<ThreadPanes | null>(PANES, { scope: thread.id })
  await kept.until((value) => value !== null)
  expect(kept.value!.status?.blocks).toEqual(second)
})

it('withdraws what a stopped thread waits on, both kinds, and the queue empties', async () => {
  daemon = await testDaemon({
    extensions: [agentUi],
    model: [callTools({ name: 'ask_user', id: 'q', args: { question: 'Which colour?' } }, { name: 'ask_ui', id: 'f', args: { blocks: BLOCKS } })],
  })
  const thread = await daemon.thread()
  const waiting = await daemon.watch<Waiting[]>(WAITING, { scope: thread.id })
  await daemon.call('thread.send', { thread: thread.id, text: 'ask me' })
  await waiting.until((list) => list.length === 2, 'both to wait')
  await daemon.dispatch('thread.stop', { thread: thread.id })
  await waiting.until((list) => list.length === 0, 'the queue to empty')
  await daemon.idle(thread.id)
  expect((await statusOf(thread.id)).state).not.toBe('blocked')
  const results = await toolResults(thread.id)
  expect(results.map((r) => [r.isError, r.content![0]!.text])).toEqual([[true, expect.stringMatching(/aborted/)], [true, expect.stringMatching(/aborted/)]])
  await expect(daemon.dispatch(ANSWER, { id: 'q', text: 'red' })).rejects.toMatchObject({ kind: 'not_found' })
})

it("tells a pane watching already of each change, live; a thread keeps its newest 20 panes' UI", async () => {
  const blocks = (text: string): Json[] => [{ type: 'markdown', text }]
  daemon = await testDaemon({
    extensions: [agentUi],
    model: [
      callTool('open_ui', { id: 'status', title: 'Build', blocks: blocks('Building…') }),
      callTool('update_ui', { id: 'status', blocks: blocks('Green.') }),
      ...Array.from({ length: 20 }, (_, i) => callTool('open_ui', { id: `p${i}`, title: `P${i}`, blocks: blocks(`${i}`) })),
      say('Done.'),
    ],
  })
  const thread = await daemon.thread()
  // Watched before anything is drawn: then told of the pane as it's opened and as it's updated.
  const panes = await daemon.watch<ThreadPanes | null>(PANES, { scope: thread.id })
  await daemon.send(thread.id, 'build it')
  const drawn = panes.seen.map((value) => (value?.status?.blocks[0] as { text?: string } | undefined)?.text).filter((text) => text !== undefined)
  expect([...new Set(drawn)]).toEqual(['Building…', 'Green.'])
  // 21 opened: the oldest (status) let go of.
  await panes.until((value) => Object.keys(value ?? {}).length === 20 && !value!.status, 'the oldest to go')
  expect(Object.keys(panes.value!).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `p${i}`).sort())
})
