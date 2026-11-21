// Claude Agent's UI half in a window: over the composer, the notice when a thread's folder has Claude Code settings of
// its own not allowed, and what Claude Code waits on, answered from there; a subagent's steps under its Agent call.
import { afterEach, expect, it } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import claudeAgent from '../src/ui.tsx'
import { choicesOf } from '../src/approval.tsx'
import { about, ALLOW, ANSWER, CHECK, KEPT, LIMIT, SIGNED_OUT, TERMINAL, WAITING, type Approval, type ProjectFacts, type SubagentSteps } from '../src/shared.ts'

const thread = testThread({ id: '1' })
let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount(); ui = undefined })

const bash: Approval = {
  id: 'toolu_1', thread: thread.id, at: 1, tool: 'Bash', title: 'Bash: npm test -- --watch=false',
  preview: 'npm test -- --watch=false', always: 'Always allow Bash(npm test:*)',
}
const plan: Approval = { id: 'toolu_2', thread: thread.id, at: 2, tool: 'ExitPlanMode', title: 'Plan: Tidy up', plan: '# Tidy up\n\n1. Remove the old file' }

const mount = async (waiting: Approval[], more: Record<string, unknown> = {}) => {
  const machine = fakeMachine({ extensions: ['claude-agent'], threads: [thread], values: { [WAITING]: { [thread.id]: waiting }, ...more } as never })
  ui = await mountUi({ extensions: [claudeAgent], machines: [machine] })
  return machine
}

it('shows the oldest approval above the composer, with Allow, Deny and Always, and answers it', async () => {
  const machine = await mount([bash, plan])
  const drawn = await ui!.render({ slot: 'composer.above', thread: thread.id })
  const text = drawn.text()
  expect(text).toContain('Permission')
  expect(text).toContain('Bash: npm test -- --watch=false')
  expect(text).toContain('Allow')
  expect(text).toContain('Deny')
  expect(text).toContain('Always allow Bash(npm test:*)')
  expect(text).not.toContain('Tidy up')
  await drawn.click('Always allow Bash(npm test:*)')
  expect(machine.calls.find((c) => c.method === 'action.run')?.params).toMatchObject({ id: ANSWER, params: { id: 'toolu_1', choice: 'always' } })
})

it('offers no "always" where Claude Code offers none, and shows a plan to approve or keep planning', async () => {
  expect(choicesOf({ ...bash, always: undefined }).map((c) => c.label)).toEqual(['Allow', 'Deny'])
  const machine = await mount([plan])
  const drawn = await ui!.render({ slot: 'composer.above', thread: thread.id })
  expect(drawn.text()).toContain('Remove the old file')
  expect(choicesOf(plan).map((c) => c.label)).toEqual(['Approve plan', 'Keep planning'])
  await drawn.click('Keep planning')
  expect(machine.calls.find((c) => c.method === 'action.run')?.params).toMatchObject({ id: ANSWER, params: { id: 'toolu_2', choice: 'deny' } })
})

it("says Claude Code isn't signed in, opening a terminal beside the thread to sign in, and looking again", async () => {
  const machine = fakeMachine({
    extensions: ['claude-agent'], threads: [thread], values: { [SIGNED_OUT]: { [thread.id]: true } } as never,
    methods: { 'action.run': ({ id }: { id: string }) => id === CHECK ? { installed: true, path: '/bin/claude', loggedIn: false } : { id: 'p1' } } as never,
  })
  ui = await mountUi({ extensions: [claudeAgent], machines: [machine] })
  const drawn = await ui.render({ slot: 'composer.above', thread: thread.id })
  expect(drawn.text()).toContain('Claude Code isn’t signed in.')
  await drawn.click('Open a terminal')
  expect(machine.calls.find((c) => c.method === 'action.run')?.params).toMatchObject({ id: TERMINAL, params: { thread: thread.id } })
  await drawn.click('Check again')
  await ui.until(() => drawn.text().includes('Still not signed in.'), 'the look')
})

it('notes the plan\'s limit in a Claude Agent thread while Claude Code says it is near, and not once it reset', async () => {
  const claude = testThread({ id: '2', agent: { kind: 'claude-agent', title: 'Claude Agent' } })
  const resetsAt = Date.now() + 3 * 3600_000
  const limit = { status: 'allowed_warning', type: 'five_hour', utilization: 0.8, resetsAt }
  const machine = fakeMachine({ extensions: ['claude-agent'], threads: [claude, thread], values: { [LIMIT]: limit } as never })
  ui = await mountUi({ extensions: [claudeAgent], machines: [machine] })
  const drawn = await ui.render({ slot: 'composer.above', thread: claude.id })
  expect(drawn.find('.claude-agent-limit')?.textContent).toMatch(/^5-hour limit 80% used, resets \S+/)
  // Not in a thread of Superego's own.
  const other = await ui.render({ slot: 'composer.above', thread: thread.id })
  expect(other.find('.claude-agent-limit')).toBeNull()
  await other.unmount()
  await drawn.unmount()
  machine.setValue(LIMIT, { ...limit, resetsAt: Date.now() - 1000 })
  const after = await ui.render({ slot: 'composer.above', thread: claude.id })
  expect(after.find('.claude-agent-limit')).toBeNull()
})

it("draws a subagent's steps under its Agent call, and how it stands", async () => {
  const work: SubagentSteps = {
    status: 'running',
    steps: [{ type: 'toolCall', id: 'toolu_9', name: 'read', arguments: { path: 'notes.txt' } }],
    results: { toolu_9: { text: 'The answer is 42.', isError: false } },
  }
  await mount([], { [KEPT]: { [thread.id]: { subagents: { toolu_8: work } } } })
  const drawn = await ui!.render({ thread: thread.id, tool: { name: 'Agent', id: 'toolu_8', arguments: { description: 'Look into it', prompt: 'Read notes.txt' }, result: { text: 'Async agent launched', isError: false } } })
  expect(drawn.text()).toContain('Running a subagent')
  expect(drawn.text()).toContain('Look into it')
  await drawn.click('Running a subagent')
  expect(drawn.text()).toContain('notes.txt')
})

const project: ProjectFacts = { cwd: '/repo', files: ['.claude/settings.json', '/.mcp.json'], hash: 'abc', onlyInstructions: false, allowed: false, changed: false }
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

it("says plainly when it's only a CLAUDE.md, and opens it", async () => {
  const facts: ProjectFacts = { ...project, files: ['CLAUDE.md'], onlyInstructions: true }
  const { machine, drawn } = await notice(facts)
  expect(drawn!.text()).toContain('This folder has a CLAUDE.md.')
  expect(drawn!.text()).toContain('Claude Code takes it as instructions, so it runs here without it until you allow it.')
  expect(drawn!.text()).not.toContain('hooks')
  await drawn!.click('CLAUDE.md')
  expect(machine.calls).toContainEqual({ method: 'action.run', params: { id: 'pane.open', params: { thread: 't1', kind: 'editor', params: { path: '/repo/CLAUDE.md' } } } })
  await drawn!.click('Allow')
  expect(machine.calls).toContainEqual({ method: 'action.run', params: { id: ALLOW, params: { cwd: '/repo', hash: 'abc' } } })
  await ui!.unmount()
  ui = undefined
  expect((await notice({ ...facts, changed: true })).drawn!.text()).toContain('This folder’s CLAUDE.md changed since you allowed it.')
  await ui!.unmount()
  ui = undefined
  const unsafe = (await notice({ ...facts, unsafe: '/tmp' })).drawn!.text()
  expect(unsafe).toContain('Claude Code also reads instructions from /tmp, which other users on this computer can change, so it runs here without the folder’s CLAUDE.md.')
})
