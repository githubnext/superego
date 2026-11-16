// git's daemon half against a real daemon: the changes in a thread's folder as a read, and Changes told to the agent
// while the machine has git on.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ActionInfo, Pane, ThreadInfo } from '@superego/protocol'
import { callTool, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import git from '../src/daemon.ts'
import { DIFF, type Changes } from '../src/shared.ts'

it("reads a thread's changes by git: the diff against HEAD and the files not tracked yet, as a plain read", async () => {
  const daemon = await testDaemon({ extensions: [git] })
  const repo = join(daemon.dataDir, 'repo')
  await mkdir(repo)
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  run('init', '-q')
  await writeFile(join(repo, 'notes.md'), 'one\n')
  run('add', 'notes.md'); run('commit', '-q', '-m', 'notes')
  await writeFile(join(repo, 'notes.md'), 'two\n')
  await writeFile(join(repo, 'new.md'), 'new\n')
  expect(daemon.extensions.map((e) => e.name)).toContain('git')
  const thread = await daemon.thread(undefined, { cwd: repo })
  const changes = await daemon.call<Changes>(DIFF, { thread: thread.id })
  expect(changes.repo).toBe(true)
  expect(changes.diff).toContain('-one')
  expect(changes.diff).toContain('+two')
  expect(changes.untracked).toEqual(['new.md'])
  // A read, not an action; and a folder that isn't a repository says so.
  expect((await daemon.call<ActionInfo[]>('action.list')).map((a) => a.id)).not.toContain(DIFF)
  const plain = await daemon.thread()
  expect(await daemon.call<Changes>(DIFF, { thread: plain.id })).toEqual({ diff: '', untracked: [], repo: false })
  await daemon.close()
})

type Result = { role?: string; toolCallId?: string; isError?: boolean; content?: { text?: string }[] }
/** A thread's tool result for the call `id`. */
const result = async (daemon: TestDaemon, thread: string, id: string) => (JSON.parse(await daemon.transcript(thread)) as { model?: Result[] }[])
  .map((entry) => entry.model?.[0]).find((message) => message?.role === 'toolResult' && message.toolCallId === id)!
const panes = async (daemon: TestDaemon, thread: string) => ((await daemon.call<ThreadInfo[]>('thread.list')).find((t) => t.id === thread)!.panes ?? []) as Pane[]

it('tells the agent it can open Changes and opens it, unless the machine has git off', async () => {
  const open = (id: string) => callTool('pane_open', { kind: 'diff' }, id)
  const daemon = await testDaemon({ extensions: [git], model: [open('on'), say('There.'), open('off'), say('There.')] })
  const on = await daemon.thread('show me')
  expect(await daemon.transcript(on.id)).toContain('\\"diff\\": the changes in the working folder')
  expect((await result(daemon, on.id, 'on')).isError).toBeFalsy()
  expect((await panes(daemon, on.id)).map((p) => p.kind)).toEqual(['diff'])

  await daemon.call('settings.set', { key: 'extensions.git', value: false })
  const off = await daemon.thread('show me')
  expect(await daemon.transcript(off.id)).not.toContain('\\"diff\\": the changes')
  // Refused, naming the kinds there are.
  const refused = await result(daemon, off.id, 'off')
  expect(refused.isError).toBe(true)
  expect(refused.content?.[0]?.text).toContain('no "diff" pane')
  expect(refused.content?.[0]?.text).toContain('"editor"')
  expect(await panes(daemon, off.id)).toEqual([])
  await daemon.close()
})
