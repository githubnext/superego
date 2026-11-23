// @vitest-environment happy-dom
// A column dragged wider is kept: with the thread, where its machine can (`pane.resize`), else in the window, by
// thread, as a factor of the window's width; shown again as the thread is shown again.
import { afterEach, expect, it, vi } from 'vitest'
import { FEATURES } from '@superego/protocol'
import { windowFactor } from '../src/renderer/pane-layout.ts'
import { fakeMachine, mountUi, testThread, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
/** The thread's column, as wide as it's drawn. */
const threadWidth = () => parseFloat($('.panes > [data-column="thread"]')?.style.width ?? '')

let ui: TestWindow | undefined
afterEach(async () => {
  await ui?.unmount()
  ui = undefined
  vi.restoreAllMocks()
  localStorage.clear()
})

/** A window 1400 wide whose pane row has 1000 for its columns, showing `paned` (a thread with a pane) on `machine`. */
async function shown(machine: ReturnType<typeof fakeMachine>) {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1400)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('.panes') ? 1000 : 0 })
  ui = await mountUi({ window: true, machines: [machine], select: { thread: 'paned' } })
  await ui.until(() => threadWidth() > 0, 'the thread beside its pane')
  return ui
}

/** The handle after the thread dragged `by` px to the right, and let go. */
function drag(by: number) {
  const gap = $('.panes__gap--thread')!
  gap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 500 }))
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: 500 + by }))
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: 500 + by }))
}

const threads = () => [
  testThread({ id: 'paned', title: 'paned', panes: [{ id: 'p1', kind: 'nothing-drawn' }] }),
  testThread({ id: 'other', title: 'other', panes: [{ id: 'p2', kind: 'nothing-drawn' }] }),
]

it("keeps a dragged width in the window, by thread, where the machine can't keep it", async () => {
  const machine = fakeMachine({ threads: threads(), features: FEATURES.filter((f) => f !== 'pane-resize') })
  await shown(machine)
  const before = threadWidth()
  drag(100)
  await ui!.until(() => threadWidth() === before + 100, 'the thread dragged wider')
  expect(machine.calls.some((c) => c.params?.id === 'pane.resize')).toBe(false)
  const kept = JSON.parse(Object.entries({ ...localStorage }).find(([key]) => key.endsWith('pane.columnWidths'))![1] as string)
  expect(kept).toEqual({ 'local/paned': { thread: { width: windowFactor(before + 100, 1400) } } })

  await ui!.select({ thread: 'other' })
  await ui!.until(() => $('.thread__title')?.textContent === 'other' && threadWidth() === before, 'another thread, at its default')
  await ui!.select({ thread: 'paned' })
  await ui!.until(() => $('.thread__title')?.textContent === 'paned' && threadWidth() === before + 100, 'the width kept, shown again')

  // A double click puts it back, and forgets it.
  $('.panes__gap--thread')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await ui!.until(() => threadWidth() === before, 'put back')
  expect(Object.keys({ ...localStorage }).some((key) => key.endsWith('pane.columnWidths'))).toBe(false)
})

it('keeps a dragged width with the thread where the machine can, not in the window', async () => {
  const machine = fakeMachine({ threads: threads(), features: [...FEATURES], methods: { 'pane.resize': () => null } })
  await shown(machine)
  const before = threadWidth()
  drag(100)
  await ui!.until(() => threadWidth() === before + 100, 'the thread dragged wider')
  await ui!.until(() => machine.calls.some((c) => c.params?.id === 'pane.resize'), 'kept with the thread')
  expect(machine.calls.find((c) => c.params?.id === 'pane.resize')!.params.params).toEqual({ thread: 'paned', width: windowFactor(before + 100, 1400) })
  expect(Object.keys({ ...localStorage }).some((key) => key.endsWith('pane.columnWidths'))).toBe(false)
})
