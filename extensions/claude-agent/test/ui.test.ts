// The notice over a Claude Agent thread's composer when its folder has Claude Code settings of its own not allowed.
import { afterEach, expect, it } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import claudeAgent from '../src/ui.tsx'
import { about, ALLOW, type ProjectFacts } from '../src/shared.ts'

const project: ProjectFacts = { cwd: '/repo', files: ['.claude/settings.json', '/.mcp.json'], hash: 'abc', allowed: false, changed: false }
let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount(); ui = undefined })

async function notice(facts: ProjectFacts | undefined) {
  const thread = testThread({ id: 't1', cwd: '/repo', ...(facts ? { facts: { [about.name]: facts } } : {}) })
  const machine = fakeMachine({ threads: [thread], methods: { [ALLOW]: () => null, 'pane.open': () => null } })
  ui = await mountUi({ extensions: [claudeAgent], machines: [machine] })
  return { machine, drawn: await ui.render({ slot: 'composer.above', thread }).catch(() => undefined) }
}

it("asks to allow a folder's Claude Code settings, for exactly what it shows, and opens each file to read", async () => {
  const { machine, drawn } = await notice(project)
  expect(drawn!.text()).toContain('This folder has Claude Code settings of its own.')
  expect(drawn!.text()).toContain('runs here without them')
  await drawn!.click('2 files')
  await drawn!.click('.claude/settings.json')
  expect(machine.calls).toContainEqual({ method: 'action.run', params: { id: 'pane.open', params: { thread: 't1', kind: 'editor', params: { path: '/repo/.claude/settings.json' } } } })
  await drawn!.click('Allow')
  expect(machine.calls).toContainEqual({ method: 'action.run', params: { id: ALLOW, params: { cwd: '/repo', hash: 'abc' } } })
})

it('says when they changed since allowed, and nothing once allowed or with none', async () => {
  for (const [facts, says] of [[{ ...project, changed: true }, 'changed since you allowed them'], [{ ...project, allowed: true }, ''], [undefined, '']] as const) {
    expect((await notice(facts)).drawn?.text() ?? '', JSON.stringify(facts)).toContain(says)
    if (!says) expect((await ui!.render({ slot: 'composer.above', thread: 't1' }).catch(() => undefined))?.text() ?? '').toBe('')
    await ui!.unmount()
    ui = undefined
  }
})

it('offers nothing to allow where another user could change them, and says where', async () => {
  const { drawn } = await notice({ ...project, unsafe: '/tmp' })
  expect(drawn!.text()).toContain('Claude Code also reads settings from /tmp, which other users on this computer can change')
  await expect(drawn!.click('Allow')).rejects.toThrow()
  await drawn!.click('Dismiss')
})
