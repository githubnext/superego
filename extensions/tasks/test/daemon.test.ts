// tasks against a real daemon: the agent's task_start and task_finish, a run's done status from the last outcome, and
// Settings → Extensions switching it off.
import { expect, it } from 'vitest'
import type { SettingsSnapshot } from '@superego/protocol'
import { callTool, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import tasks from '../src/daemon.ts'

type Result = { role?: string; isError?: boolean; content?: { text?: string }[] }
/** A thread's tool results, in order. */
const results = async (daemon: TestDaemon, id: string) => (JSON.parse(await daemon.transcript(id)) as { model?: Result[] }[])
  .map((entry) => entry.model?.[0]).filter((message): message is Result => message?.role === 'toolResult')

it('gives the agent the tools, and task_start a task_id that is its own call', async () => {
  const daemon = await testDaemon({ extensions: [tasks], model: [
    callTool('task_start', { title: 'Looking around' }, 'call-1'),
    callTool('task_finish', { task_id: 'call-1', status: 'success', outcome: 'Saw it all' }),
    say('Done.'),
  ] })
  expect(daemon.extensions.map((e) => e.name)).toContain('tasks')
  const thread = await daemon.thread('look around')
  // Its done status says what the run did: the last task's outcome.
  expect(thread.status).toEqual({ state: 'done', msg: 'Saw it all' })
  const [started, finished] = await results(daemon, thread.id)
  expect([started!.isError, finished!.isError]).toEqual([false, false])
  expect(JSON.parse(started!.content![0]!.text!)).toEqual({ task_id: 'call-1', title: 'Looking around' })
  await daemon.close()
})

it('is listed in Settings → Extensions, and switched off there the agent goes without it', async () => {
  const daemon = await testDaemon({ extensions: [tasks], model: [callTool('task_start', { title: 'Looking around' }), say('Done.')] })
  const { value: settings } = await daemon.call<{ value: SettingsSnapshot }>('settings.watch')
  const section = settings.sections.find((s) => s.id === 'extensions')!
  expect(section.settings.map((s) => s.key)).toEqual(['extensions.preset', 'extensions.coding-tools', 'extensions.panes', 'extensions.agents-md', 'extensions.tasks'])
  expect(section.settings.at(-1)).toMatchObject({ title: 'Task reporting', default: true })
  expect(settings.sections.find((s) => s.id === 'profiles')?.data).toEqual([])

  await daemon.call('settings.set', { key: 'extensions.tasks', value: false })
  const thread = await daemon.thread('look around')
  // Without tasks, the answer's first sentence says what the run did.
  expect(thread.status).toEqual({ state: 'done', msg: 'Done.' })
  expect((await results(daemon, thread.id))[0]?.isError).toBe(true)
  await daemon.close()
})
