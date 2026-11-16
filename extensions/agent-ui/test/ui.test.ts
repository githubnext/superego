// agent-ui's `ui` pane in a window: the UI the agent drew, and what it says when there's none to draw.
import { afterEach, expect, it } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import agentUi from '../src/ui.tsx'
import { KIND, PANES, type ThreadPanes } from '../src/shared.ts'

const thread = testThread({ id: '1' })
let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount(); ui = undefined })

const pane = (id: string) => ({ pane: { kind: KIND, params: { id } }, thread: thread.id })

it("draws the pane's UI; says it's gone when the thread keeps none of that id", async () => {
  const kept: ThreadPanes = { status: { id: 'status', title: 'Build', blocks: [{ type: 'markdown', text: 'All green.' }], at: 1 } }
  ui = await mountUi({ extensions: [agentUi], machines: [fakeMachine({ extensions: ['agent-ui'], threads: [thread], values: { [PANES]: { [thread.id]: kept } } })] })
  expect((await ui.render(pane('status'))).text()).toContain('All green.')
  expect((await ui.render(pane('nope'))).text()).toContain('This pane’s UI is gone.')
})

it('says so for a thread that keeps none, and for a machine where agent-ui is off, rather than loading forever', async () => {
  ui = await mountUi({ extensions: [agentUi], machines: [fakeMachine({ extensions: ['agent-ui'], threads: [thread], values: { [PANES]: { [thread.id]: {} } } })] })
  expect((await ui.render(pane('status'))).text()).toContain('This pane’s UI is gone.')
  await ui.unmount()
  ui = await mountUi({ extensions: [agentUi], machines: [fakeMachine({ label: 'box', threads: [thread] })] })
  expect((await ui.render(pane('status'))).text()).toContain('Agent UI is off on box.')
})
