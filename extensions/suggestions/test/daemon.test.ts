// suggestions against a real daemon (the echo model): what the user might send next, asked of the thread's model once it
// answers, and taken away as the thread moves on; one may run a skill of the machine's.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MESSAGE_ENTRY } from '@superego/protocol'
import { testDaemon } from '@superego/sdk/testing'
import skills from '@superego/skills/daemon'
import suggestions from '../src/daemon.ts'
import { NEXT, type Suggested } from '../src/shared.ts'

it('asks the thread\'s model for next prompts once it answers, and drops them when the thread moves on', async () => {
  // The echo model answers with the last user message: the agent echoes the prompt, and the side call echoes the
  // transcript, whose last JSON array is the suggestions.
  const daemon = await testDaemon({ extensions: [suggestions], model: 'echo' })
  const thread = await daemon.thread()
  const next = await daemon.watch<Suggested | null>(NEXT, { scope: thread.id })
  await daemon.send(thread.id, '["Run the tests", "Commit this"]')
  expect((await next.until((value) => value !== null, 'the suggestions'))!.prompts).toEqual([{ text: 'Run the tests' }, { text: 'Commit this' }])

  // Its next message takes them away; this answer suggests nothing (its last array is empty), so none come back.
  await daemon.send(thread.id, '[]')
  expect(next.value).toBeNull()
  await daemon.close()
})

it('suggests one of the machine\'s skills as the composer names it, which sent runs it, and drops a skill there isn\'t', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superego-suggestions-'))
  await mkdir(join(dir, 'agents', 'skills', 'commit'), { recursive: true })
  await writeFile(join(dir, 'agents', 'skills', 'commit', 'SKILL.md'), '---\nname: commit\ndescription: Write commit messages.\n---\n\nImperative subjects.\n')
  const daemon = await testDaemon({ extensions: [skills, suggestions], dataDir: dir, model: 'echo' })
  const thread = await daemon.thread(undefined, { cwd: dir })
  const next = await daemon.watch<Suggested | null>(NEXT, { scope: thread.id })
  // Sent as plain words (a named skill would bring its instructions, and their echo), `/commit` written as the model may.
  await daemon.send(thread.id, '["/commit the date fix", "$made-up now", "Run the tests"]')
  const { prompts } = (await next.until((value) => value !== null, 'the suggestions'))!
  expect(prompts).toEqual([
    { text: '$commit the date fix', skill: { name: 'commit', description: 'Write commit messages.' } },
    { text: 'Run the tests' },
  ])

  // Picked, it's sent as typed: the skill goes with it.
  await daemon.send(thread.id, prompts[0]!.text)
  const entries = (JSON.parse(await daemon.transcript(thread.id)) as { kind: string; model?: { content: string | { type: string; text?: string }[] }[] }[])
    .filter((e) => e.kind === MESSAGE_ENTRY)
  const sent = entries.at(-1)!.model![0]!.content as { text?: string }[]
  expect(sent[0]!.text).toBe('$commit the date fix')
  expect(sent[1]!.text).toMatch(/^<skill name="commit" [^]*Imperative subjects\./)
  await daemon.close()
  await rm(dir, { recursive: true, force: true })
})
