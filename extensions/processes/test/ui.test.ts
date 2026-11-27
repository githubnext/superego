// @vitest-environment happy-dom
// processes in the window: the chip saying the most pressing state (and less on a phone), the row's mark from the
// thread's facts, the pane's list (scope headings only once a folder's process is in it) and the selected one's output
// with its runs set apart, a failure seen once shown, and a report's card.
import { afterEach, expect, it } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import processes from '../src/ui.tsx'
import { LIST, OUTPUT, PANE, READ, REPORT, TROUBLE, type ProcessInfo } from '../src/shared.ts'

let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount(); ui = undefined })

const now = Date.now()
const thread = testThread({ id: 't1', title: 'Fix the pane', cwd: '/dev/app', project: { root: '/dev/app', name: 'app' }, facts: { processes: { running: 1, starting: 0, failed: 1 } } })
const base = { owner: { thread: 't1' }, cwd: '/dev/app', grace: 5000, notify: 'exit', restart: 'never', keep: false, by: { thread: 't1' }, run: 1 } as const
const build: ProcessInfo = { ...base, id: 'p_build', command: 'pnpm build', state: 'failed', exitCode: 2, startedAt: now - 9000, endedAt: now - 1000 }
const test: ProcessInfo = { ...base, id: 'p_test', command: 'pnpm test --watch', state: 'running', pid: 42, startedAt: now - 31_000 }
const dev: ProcessInfo = { ...base, id: 'p_dev', owner: { folder: '/dev/app' }, name: 'run', command: 'pnpm dev', ready: 'ready in', notify: 'failure', keep: true, by: { extension: 'run' }, state: 'running', startedAt: now - 60_000 }
const output = 'packages/app build$ tsc\n\u001b[31merror TS2322\u001b[0m: Type string\n\u001b[2m── exited with 2 after 8s ──\u001b[0m\n'

const machine = (list: ProcessInfo[]) => fakeMachine({
  threads: [thread], extensions: ['processes'],
  values: { [LIST]: { t1: list }, [OUTPUT]: { p_build: { end: output.length, start: 0 } } },
  methods: {
    [READ]: ({ id }: { id: string }) => ({ text: id === 'p_build' ? output : '', from: 0, end: id === 'p_build' ? output.length : 0, start: 0, first: 0 }),
    'processes.seen': () => null, 'pane.open': () => null,
  },
})

it('says the most pressing state in the chip, and marks the row', async () => {
  ui = await mountUi({ extensions: [processes], machines: [machine([build, test])] })
  const chip = await ui.render({ slot: 'header.chips', thread: 't1' })
  await ui.until(() => chip.text().includes('Failed · 2'), 'the chip')
  const mark = await ui.render({ slot: 'thread.badge', thread: 't1' })
  expect(mark.container.querySelector('.processes-badge.is-failed')).not.toBeNull()
})

it('lists them in the pane, the folder’s under its heading, and shows the selected one’s output', async () => {
  const fake = machine([build, test, dev])
  ui = await mountUi({ extensions: [processes], machines: [fake] })
  const pane = await ui.render({ pane: { kind: PANE, params: { id: 'p_build' } }, thread: 't1' })
  await ui.until(() => pane.text().includes('error TS2322'), 'its output')
  const headings = [...pane.container.querySelectorAll('.processes-group__title')].map((h) => h.textContent)
  expect(headings).toEqual(['This thread', 'app'])
  const rows = [...pane.container.querySelectorAll('.processes-row')]
  expect(rows.map((r) => r.querySelector('.processes-row__title')?.textContent)).toEqual(['pnpm build', 'pnpm test --watch', 'pnpm dev'])
  expect(rows[0]!.querySelector('.processes-row__state')?.textContent).toBe('Exited with 2 after 8s')
  expect(rows[2]!.querySelector('.processes-tag')?.textContent).toBe('run')
  // The runner's own lines set apart; colours kept.
  expect(pane.container.querySelector('.processes-line--own')?.textContent).toBe('── exited with 2 after 8s ──')
  expect(pane.container.querySelector('.processes-output span[style*="--processes-c1"]')?.textContent).toBe('error TS2322')
  // Shown: its failure is seen.
  await ui.until(() => fake.calls.some((c) => c.method === 'action.run' && c.params.id === 'processes.seen'), 'seen')
})

it('keeps to one process’s list without headings, and draws a report as a card', async () => {
  ui = await mountUi({ extensions: [processes], machines: [machine([build])] })
  const pane = await ui.render({ pane: { kind: PANE }, thread: 't1' })
  await ui.until(() => pane.text().includes('pnpm build'), 'the list')
  expect(pane.container.querySelector('.processes-group__title')).toBeNull()
  expect(ui.registry.entries.some((e) => e.kind === REPORT)).toBe(true)
})

it('says what went wrong in the pane: Processes’ own trouble, and an action that failed', async () => {
  const fake = fakeMachine({
    threads: [thread], extensions: ['processes'],
    values: { [LIST]: { t1: [test] }, [TROUBLE]: "couldn't save its processes: EACCES" },
    methods: {
      [READ]: () => ({ text: '', from: 0, end: 0, start: 0, first: 0 }),
      'processes.stop': () => { throw new Error('No process p_test.') },
      'processes.dismiss': () => null,
    },
  })
  ui = await mountUi({ extensions: [processes], machines: [fake] })
  const pane = await ui.render({ pane: { kind: PANE }, thread: 't1' })
  await ui.until(() => pane.text().includes("couldn't save its processes: EACCES"), 'the trouble')
  const stop = [...pane.container.querySelectorAll('button')].find((b) => b.textContent === 'Stop')!
  stop.click()
  await ui.until(() => pane.text().includes('Couldn’t stop it: No process p_test.'), 'the failure')
  const dismiss = pane.container.querySelector<HTMLButtonElement>('.processes-problem button[aria-label="Dismiss"]')!
  dismiss.click()
  await ui.until(() => fake.calls.some((c) => c.method === 'action.run' && c.params.id === 'processes.dismiss'), 'dismissed')
})
