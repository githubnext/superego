// Text that arrives from elsewhere (the agent's edits, another editor) shows itself: what's new flashes and fades, a
// deletion leaves a bar that fades. Only for changes marked as arriving; what's typed here never flashes.
import { StateEffect, StateField, type AnnotationType, type Range, type Transaction } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'

/** How long an arrival stays marked; its CSS animation fades it within this. */
const FOR = 1600

class Cut extends WidgetType {
  eq() { return true }
  toDOM() { const el = document.createElement('span'); el.className = 'cm-arrived-cut'; return el }
}
const added = Decoration.mark({ class: 'cm-arrived' })
const cut = Decoration.widget({ widget: new Cut(), side: 1 })
const line = Decoration.line({ class: 'cm-arrived-line' })
const clear = StateEffect.define<null>()

/** Marks changes carrying `marker` as they arrive, and lets them go once they've faded. */
export function arrivals(marker: AnnotationType<boolean>) {
  const arriving = (tr: Transaction) => tr.docChanged && Boolean(tr.annotation(marker))
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(set, tr) {
      if (tr.effects.some((e) => e.is(clear))) return Decoration.none
      set = set.map(tr.changes)
      if (!arriving(tr)) return set
      const marks: Range<Decoration>[] = []
      const lines = new Set<number>()
      tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        if (toB > fromB) marks.push(added.range(fromB, toB))
        else marks.push(cut.range(fromB))
        for (let n = tr.state.doc.lineAt(fromB).number; n <= tr.state.doc.lineAt(toB).number; n++) lines.add(n)
      })
      for (const n of lines) marks.push(line.range(tr.state.doc.line(n).from))
      return set.update({ add: marks, sort: true })
    },
    provide: (f) => EditorView.decorations.from(f),
  })
  // Each arrival restarts the clock; once it runs out, the marks go (their animation has finished by then).
  const timer = ViewPlugin.fromClass(class {
    handle: ReturnType<typeof setTimeout> | undefined
    readonly view: EditorView
    constructor(view: EditorView) { this.view = view }
    update(update: { transactions: readonly Transaction[] }) {
      if (!update.transactions.some(arriving)) return
      clearTimeout(this.handle)
      this.handle = setTimeout(() => this.view.dispatch({ effects: clear.of(null) }), FOR)
    }
    destroy() { clearTimeout(this.handle) }
  })
  return [field, timer]
}
