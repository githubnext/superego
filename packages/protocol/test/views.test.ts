// A data view's declaration, checked: a window's fits the sidebar and beside the thread; a thread's, beside it and a pane.
import { expect, it } from 'vitest'
import { dataViewProblem, type DataView } from '../src/views.ts'

const view = (context: DataView['context'], fits: DataView['fits']): DataView => ({ title: 'V', context, fits, value: 'x.v' })

it("takes a window's view in the sidebar or beside, a thread's beside or in a pane, and refuses the rest", () => {
  expect(dataViewProblem(view('window', ['sidebar', 'beside']))).toBeUndefined()
  expect(dataViewProblem(view('thread', ['beside', 'pane']))).toBeUndefined()
  expect(dataViewProblem(view('window', ['pane']))).toBe("can't be drawn in pane (a window view fits sidebar and beside)")
  // A sidebar is a section of the window's, whatever thread is shown.
  expect(dataViewProblem(view('thread', ['sidebar', 'beside']))).toBe("can't be drawn in sidebar (a thread view fits beside and pane)")
})
