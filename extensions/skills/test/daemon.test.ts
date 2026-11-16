// The skills extension against a real daemon (the echo model): the agent told what each skill is for, a named skill
// sent with the message, the list the composer completes from, and all of it gone when a machine turns skills off.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { DaemonExtension } from '@superego/daemon'
import { DATA_VIEWS, type DataViewInfo } from '@superego/protocol'
import { testDaemon, type TestDaemon } from '@superego/sdk/testing'
import skills, { skillsExtension } from '../src/daemon.ts'

// The daemon's folder: the agents' skills in agents/skills, its user profile in profiles/default.
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-skills-'))
  const skill = async (name: string, front: string, body: string) => {
    await mkdir(join(dir, 'agents', 'skills', name), { recursive: true })
    await writeFile(join(dir, 'agents', 'skills', name, 'SKILL.md'), `---\n${front}\n---\n\n${body}\n`)
  }
  await skill('commit', 'name: commit\ndescription: >-\n  Write commit\n  messages.', '# Commits\nImperative subjects.')
  await skill('secret', 'name: secret\ndescription: Only by name.\ndisable-model-invocation: true', 'Hush.')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const open = (extension: DaemonExtension = skills) => testDaemon({ extensions: [extension], dataDir: dir, model: 'echo' })

/** Send a new thread `text` and wait for the answer: what the agent was given, and the message as it went in. */
async function send(daemon: TestDaemon, text: string) {
  const thread = await daemon.thread(text, { cwd: dir })
  const all = await daemon.transcript(thread.id)
  const user = (JSON.parse(all) as { kind: string; model?: { content: string | { type: string; text?: string }[] }[] }[]).find((e) => e.kind === 'pi.user')!.model![0]!
  return { all, content: user.content }
}

it('offers the skills to the agent, sends one a message names, and lists them for the composer', async () => {
  const daemon = await open()
  expect(await daemon.call('skills.list', {})).toEqual([
    { name: 'commit', description: 'Write commit messages.' }, { name: 'secret', description: 'Only by name.' },
  ])
  // To browse, as a data view the window draws: offered for a space or beside the thread, not placed.
  const views = await daemon.watch<DataViewInfo[]>(DATA_VIEWS)
  expect(views.value).toEqual([{ id: 'skills.view', extension: 'skills', title: 'Skills', icon: 'sparkle', context: 'window', fits: ['space', 'beside'], method: 'skills.view' }])
  expect(await daemon.call('skills.view', {})).toMatchObject({ items: [
    { id: 'commit', title: '$commit', subtitle: 'Write commit messages.' }, { id: 'secret', title: '$secret', subtitle: 'Only by name.', detail: 'by name' },
  ] })
  const { all, content } = await send(daemon, 'do $commit and /skill:secret, not $HOME')
  // The agent is told what each skill is for and where it is, but not about one kept to being named.
  expect(all).toContain(`<skill name=\\"commit\\" location=\\"${join(dir, 'agents', 'skills', 'commit', 'SKILL.md')}\\">Write commit messages.</skill>`)
  expect(all).not.toContain('Only by name.')
  const blocks = content as { type: string; text?: string }[]
  expect(blocks[0]!.text).toBe('do $commit and /skill:secret, not $HOME')
  expect(blocks).toHaveLength(3)
  expect(blocks[1]!.text).toMatch(/^<skill name="commit" [^]*Imperative subjects\.\n<\/skill>$/)
  expect(blocks[1]!.text).not.toContain('description:')
  expect(blocks[2]!.text).toContain('Hush.')
  await daemon.close()
})

it('switched off on a machine, sends a named skill as plain words and offers none', async () => {
  const daemon = await open()
  await daemon.call('settings.set', { key: 'extensions.skills', value: false })
  const { all, content } = await send(daemon, 'do $commit')
  expect(content).toBe('do $commit')
  expect(all).not.toContain('Write commit messages.')
  await daemon.close()
})

it("keeps `without: ['skills', 'agents-md']` working: two extensions, each left out by its own name", async () => {
  await writeFile(join(dir, 'AGENTS.md'), 'This project uses pnpm.')
  const profile = async (without: string[]) => {
    await mkdir(join(dir, 'profiles', 'default'), { recursive: true })
    await writeFile(join(dir, 'profiles', 'default', 'profile.ts'), `import { defineProfile } from 'superego'\nexport default defineProfile({ without: ${JSON.stringify(without)} })\n`)
  }
  await profile(['skills', 'agents-md'])
  const daemon = await open()
  const both = await send(daemon, 'do $commit')
  expect(both.content).toBe('do $commit')
  expect(both.all).not.toContain('Write commit messages.')
  expect(both.all).not.toContain('This project uses pnpm.')
  // Either one alone leaves the other.
  await profile(['agents-md'])
  const skillsOnly = await send(daemon, 'do $commit')
  expect(skillsOnly.all).toContain('Write commit messages.')
  expect(skillsOnly.all).not.toContain('This project uses pnpm.')
  await profile(['skills'])
  const agentsOnly = await send(daemon, 'do $commit')
  expect(agentsOnly.content).toBe('do $commit')
  expect(agentsOnly.all).toContain('This project uses pnpm.')
  await daemon.close()
})

it("offers the app's own skills from where they are, a skill of the same name in the agents' folder before them", async () => {
  const own = async (folder: string, name: string, description: string) => {
    await mkdir(join(dir, 'app', folder), { recursive: true })
    await writeFile(join(dir, 'app', folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nRead guide.md beside this.\n`)
    return join(dir, 'app', folder)
  }
  const daemon = await open(skillsExtension({ own: [await own('skill', 'superego', 'Use and extend Superego.'), await own('other', 'commit', 'The app\'s commits.')] }))
  expect(await daemon.call('skills.list', {})).toEqual([
    { name: 'commit', description: 'Write commit messages.' }, { name: 'secret', description: 'Only by name.' }, { name: 'superego', description: 'Use and extend Superego.' },
  ])
  const { all, content } = await send(daemon, 'build it with $superego')
  expect(all).toContain(`<skill name=\\"superego\\" location=\\"${join(dir, 'app', 'skill', 'SKILL.md')}\\">Use and extend Superego.</skill>`)
  expect((content as { text?: string }[])[1]!.text).toContain(`paths in it are relative to ${join(dir, 'app', 'skill')}.\n\nRead guide.md beside this.`)
  await daemon.close()
})
