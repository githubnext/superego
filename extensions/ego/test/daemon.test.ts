// ego against a real daemon: one hidden thread per machine, its agent chosen for it alone, kept across restarts, and
// cleared rather than archived; the work it hands to threads of their own, the settings it changes itself, and what it
// does for an outside agent.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { callTool, say, testDaemon, type TestDaemon, type Turn } from '@superego/sdk/testing'
import type { DaemonExtension } from '@superego/daemon'
import type { SettingsSnapshot, ThreadInfo } from '@superego/protocol'
import threadTools from '@superego/thread-tools/daemon'
import { ego } from '../src/daemon.ts'

const NAME = 'Superego test'
let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close(); daemon = undefined })

const open = async (model: Turn[] = [], more: DaemonExtension[] = []) => daemon = await testDaemon({ extensions: [ego(), ...more], model })
/** Ego's thread, as the window finds it: none until it's first asked for. */
const egoOf = async (d: TestDaemon) => (await d.call<ThreadInfo[]>('thread.list', { hidden: true })).find((t) => t.owner === 'ego')
const threads = (d: TestDaemon) => d.call<ThreadInfo[]>('thread.list', {})
const entries = async (d: TestDaemon, id: string) => (await d.call<{ value: ConversationView }>('thread.watch', { thread: id })).value.entries
const toolsOf = async (d: TestDaemon, id: string) =>
  ((await entries(d, id)).find((e) => e.kind === 'pi.system')!.model![0] as { toolsAdded: { name: string }[] }).toolsAdded.map((t) => t.name).sort()
/** Its tool results, in order. */
const results = async (d: TestDaemon, id: string) => (await entries(d, id))
  .filter((e) => (e.model?.[0] as { role?: string } | undefined)?.role === 'toolResult').map((e) => e.model![0] as { isError: boolean; content: { text: string }[] })
/** Ask Ego as an outside agent would (`superego mcp`), and wait until it has answered `count` tool calls in all. */
const askOutside = async (d: TestDaemon, prompt: string, count: number) => {
  const thread = await d.call<ThreadInfo>('action.run', { id: 'ego.ask', params: { prompt }, exposure: 'outside' })
  await d.until(async () => (await results(d, thread.id)).length === count, `Ego to answer ${count} calls`)
  return d.idle(thread.id)
}

it("keeps its own agent as one hidden thread per machine, in its data folder, knowing Superego, changing only its setup", async () => {
  const d = await open([say('Machines are added in Settings.'), say('Hi.')])
  const thread = await d.call<ThreadInfo>('ego.ask', {})
  expect(thread).toMatchObject({ facts: { ego: true }, hidden: true, cwd: d.dataDir, title: NAME })
  await d.send(thread.id, 'help me add a machine')
  // The same thread again, not another; and in no list.
  expect((await d.call<ThreadInfo>('ego.ask', {})).id).toBe(thread.id)
  expect(await threads(d)).toEqual([])
  expect(await d.call('thread.list', { archived: true })).toEqual([])
  expect((await d.call<{ value: ThreadInfo[] }>('threads.watch', {})).value).toEqual([])
  // Never archived.
  await expect(d.call('thread.archive', { thread: thread.id })).rejects.toMatchObject({ kind: 'invalid' })
  const transcript = await d.transcript(thread.id)
  expect(transcript).toContain(`You are ${NAME}'s own agent`)
  expect(transcript).toContain('What you change yourself is setup')
  // The optional extensions it tells of are this machine's (here, the core's own agent parts and Ego).
  const optional = /optional extensions it does without: ([^\\]*)/.exec(transcript)![1]!.split(', ')
  expect(optional).toEqual(expect.arrayContaining(['coding-tools', 'ego']))
  expect(optional).not.toContain('web-panes')
  // Tools that read, and thread_start; settings and machines it changes itself; nothing that writes files or runs commands.
  const tools = await toolsOf(d, thread.id)
  expect(tools).toEqual(['ls', 'pane_open', 'read', 'superego_actions', 'superego_machines', 'superego_profiles', 'superego_set_setting', 'superego_settings', 'thread_list', 'thread_read', 'thread_start'])
  for (const tool of ['write', 'edit', 'bash', 'superego_run', 'thread_send']) expect(tools).not.toContain(tool)
  // Other threads don't get its tools or prompt, and don't see it.
  const plain = await d.thread('hi')
  expect((await threads(d)).map((t) => t.id)).toEqual([plain.id])
  const other = await d.transcript(plain.id)
  expect(other).not.toContain('superego_settings')
  expect(other).not.toContain(`You are ${NAME}'s own agent`)
  // A thread started with it as its parent (as from the command line) is top-level all the same.
  const started = await d.call<ThreadInfo>('thread.start', { parent: thread.id })
  expect(started.parent).toBeUndefined()
  // Kept across restarts.
  const again = daemon = await d.restart()
  expect((await again.call<ThreadInfo>('ego.ask', {})).id).toBe(thread.id)
  expect((await egoOf(again))!.id).toBe(thread.id)
})

it('clears its thread: the same thread, starting empty again', async () => {
  const d = await open([say('A profile is…'), say('Again.')])
  expect(await egoOf(d)).toBeUndefined()
  const thread = await d.call<ThreadInfo>('ego.ask', {})
  await d.send(thread.id, 'what is a profile?')
  const ended: string[] = []
  d.peer.on('watch.end', (params: { sub: string; reason: string }) => { ended.push(`${params.sub}:${params.reason}`) })
  const watched = await d.call<{ sub: string; value: ConversationView }>('thread.watch', { thread: thread.id })
  expect(watched.value.entries.length).toBeGreaterThan(0)
  expect((await d.call<ThreadInfo>('ego.clear', {})).id).toBe(thread.id)
  // Windows watching it are told to watch again; then it's empty, with nothing earlier to page back to.
  await d.until(() => ended.includes(`${watched.sub}:stopped`))
  const { value } = await d.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
  expect(value.entries).toEqual([])
  expect(value.before).toBeUndefined()
  expect(await d.call('thread.history', { thread: thread.id, before: watched.value.entries.at(-1)!.id as number + 1000 })).toEqual({ entries: [], more: false })
  expect((await d.call<ThreadInfo>('ego.ask', {})).id).toBe(thread.id)
  // It goes on from there.
  await d.send(thread.id, 'again')
  const after = await d.transcript(thread.id)
  expect(after).toContain('again')
  expect(after).not.toContain('what is a profile?')
})

it('takes no messages while switched off: its thread is never run as an ordinary one', async () => {
  const d = await open()
  expect(d.extensions.map((e) => e.name)).toContain('ego')
  const thread = await d.call<ThreadInfo>('ego.ask', {})
  await d.call('settings.set', { key: 'extensions.ego', value: false })
  await d.until(() => !d.extensions.some((e) => e.name === 'ego'))
  await expect(d.call('thread.send', { thread: thread.id, text: 'hi' })).rejects.toMatchObject({ kind: 'invalid' })
})

it("runs as itself whatever the user's default profile says: none of its prompt, tools or without", async () => {
  daemon = await testDaemon({
    extensions: [ego()], model: [say('Hi.')],
    profile: {
      'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ prompt: 'Answer in haiku.', extensions: ['./tool.ts'], without: ['ego'] })\n`,
      'tool.ts': `import { defineExtension, defineTool } from 'superego'
export default defineExtension({ name: 'haiku', tools: [defineTool({ name: 'haiku_tool', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) })] })
`,
    },
  })
  const thread = await daemon.call<ThreadInfo>('ego.ask', {})
  expect(thread.profile).toBeUndefined()
  expect(thread.without ?? []).not.toContain('ego')
  expect(thread.facts).toEqual({ ego: true })
  await daemon.send(thread.id, 'hi')
  const transcript = await daemon.transcript(thread.id)
  expect(transcript).toContain(`You are ${NAME}'s own agent`)
  expect(transcript).not.toContain('Answer in haiku.')
  for (const tool of ['write', 'edit', 'bash', 'haiku_tool']) expect(await toolsOf(daemon, thread.id)).not.toContain(tool)
  // An ordinary thread still has the profile, and goes without Ego as it says.
  const plain = await daemon.thread()
  expect(plain.profile).toMatchObject({ name: 'default' })
  expect(plain.without).toContain('ego')
})

it('finds its thread again when switched on after starting off, instead of making another', async () => {
  const d = await open()
  const thread = await d.call<ThreadInfo>('ego.ask', {})
  expect(thread.owner).toBe('ego')
  await d.call('settings.set', { key: 'extensions.ego', value: false })
  const again = daemon = await d.restart()
  expect(again.extensions.map((e) => e.name)).not.toContain('ego')
  await again.call('settings.set', { key: 'extensions.ego', value: true })
  await again.until(() => again.extensions.some((e) => e.name === 'ego'))
  expect((await again.call<ThreadInfo>('ego.ask', {})).id).toBe(thread.id)
  expect((await again.call<{ value: ThreadInfo[] }>('threads.watch', { hidden: true })).value.map((t) => t.id)).toEqual([thread.id])
})

it("isn't archived by another thread's thread_archive either", async () => {
  const d = await open([], [threadTools])
  const thread = await d.call<ThreadInfo>('ego.ask', {})
  const again = daemon = await d.restart({ model: [callTool('thread_archive', { thread: thread.id }), say('Done.')] })
  const other = await again.thread('tidy up')
  expect(await again.transcript(other.id)).toContain(`${NAME} isn't archived`)
  expect((await egoOf(again))!.archived).toBeUndefined()
})

it('hands work to a thread of its own: top-level in its project, listed, not under Ego', async () => {
  // Its folders are relative to its own, the data folder.
  const d = await open([callTool('thread_start', { prompt: 'Turn on web access', title: 'Web', cwd: 'project' }), say('Started it.'), say('Done.')])
  const project = join(d.dataDir, 'project')
  await mkdir(project)
  const thread = await d.call<ThreadInfo>('ego.ask', {})
  await d.send(thread.id, 'turn on web access')
  const [started] = await threads(d)
  expect(started).toMatchObject({ title: 'Web', cwd: project, project: { root: project } })
  expect(started!.parent).toBeUndefined()
  expect(await d.transcript(thread.id)).toContain(`Started [Web](thread:${started!.id})`)
})

it("changes this machine's settings itself", async () => {
  const d = await open([callTool('superego_set_setting', { key: 'web.port', value: 8888 }), say('Set.')])
  const thread = await d.call<ThreadInfo>('ego.ask', {})
  await d.send(thread.id, 'serve the app on port 8888')
  expect((await d.call<{ value: SettingsSnapshot }>('settings.watch', {})).value.values['web.port']).toBe(8888)
  expect(await threads(d)).toEqual([])
})

it("starts no thread for an outside agent, unless the machine lets outside agents; the user's own turn still does", async () => {
  const start = (title: string) => callTool('thread_start', { prompt: 'Do it', title, cwd: 'project' })
  const again = await open([
    // An outside agent asks: refused, and Ego relays why.
    start('For the agent'), say('Refused.'),
    // The user asks in the window, in the same conversation: started (the thread it started answers too: either text).
    start('For the user'), say('Started.'), say('Done.'),
    // An outside agent's message straight to Ego's thread: refused too.
    start('Sent straight'), say('Refused.'),
    // Once the machine lets outside agents start threads: started.
    start('Allowed'), say('Started.'), say('Done.'),
  ])
  await mkdir(join(again.dataDir, 'project'))
  const titles = async () => (await threads(again)).map((t) => t.title).sort()

  const thread = await askOutside(again, 'start a thread for me', 1)
  expect(await titles()).toEqual([])
  const [refused] = await results(again, thread.id)
  expect(refused).toMatchObject({ isError: true })
  expect(refused!.content[0]!.text).toMatch(/outside agents can't start threads on this machine[\s\S]*Settings → Outside agents → Can start threads/)
  // Ego was told who was asking.
  expect(JSON.stringify((await entries(again, thread.id)).find((e) => (e.model?.[0] as { role?: string } | undefined)?.role === 'user'))).toContain('<outside-agent>')

  await again.send(thread.id, 'start one for me, the user')
  expect(await titles()).toEqual(['For the user'])
  // Done before the next, so each takes the turn meant for it.
  await again.idle((await threads(again))[0]!.id)

  await again.call('action.run', { id: 'thread.send', params: { thread: thread.id, text: 'start another' }, exposure: 'outside' })
  await again.until(async () => (await results(again, thread.id)).length === 3, 'the third answer')
  await again.idle(thread.id)
  expect(await titles()).toEqual(['For the user'])
  expect((await results(again, thread.id))[2]).toMatchObject({ isError: true })

  await again.call('settings.set', { key: 'outside.startThreads', value: true })
  await askOutside(again, 'and now?', 4)
  await again.until(async () => (await titles()).length === 2, 'the allowed thread')
  expect(await titles()).toEqual(['Allowed', 'For the user'])
}, 30_000)
