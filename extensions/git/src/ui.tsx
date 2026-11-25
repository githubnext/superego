// git, UI half: Changes, a pane beside the thread (from its pane menu, ⌘⇧D, or the agent's pane_open "diff") with what
// changed in its folder, file by file, refreshed as the thread moves on. Its header picks what they're measured from
// (uncommitted, staged, since the branch left main, since its upstream), kept in the pane's params. Its tab in the strip
// says how much: +N −N. Files git doesn't track yet are listed under it, each to open beside.
import { defineAction, defineUiExtension, Diff, DiffStat, fileKind, PaneButton, PaneHeader, PaneMessage, PaneNote, parseDiff, useDispatch, useMethod, useRegistry, useTabNote, type PaneProps } from '@superego/app/ui'
import { ArrowsLeftRightIcon, CaretDownIcon, Menu } from '@superego/ui'
import './styles.css'
import { about, baseLabel, CHANGES, DIFF, type Base, type BaseChoice, type Changes, type ChangesParams } from './shared.ts'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.pane(CHANGES, { title: 'Changes', icon: ArrowsLeftRightIcon, component: ChangesPane, menu: true })
    superego.action(defineAction({
      id: 'git.changes', title: 'Show changes', keys: 'mod+shift+d',
      when: (c) => Boolean(c.selection),
      run: async (_p, c) => { if (c.selection) await c.dispatch('pane.open', { thread: c.selection.thread, kind: CHANGES }, { machine: c.selection.machine, source: 'git' }) },
    }))
  },
})

/** The folder's changes by git, from the base the pane keeps, refreshed as the thread moves on. */
function ChangesPane({ machine, thread, pane }: PaneProps) {
  const registry = useRegistry()
  const dispatch = useDispatch()
  const { base } = (pane.params ?? {}) as ChangesParams
  const { data: changes, error, refetch } = useMethod<Changes>(machine.id, DIFF, { thread: thread.id, ...(base ? { base } : {}) }, { refresh: `${thread.activeAt}/${thread.status.state}` })
  const files = changes?.repo ? parseDiff(changes.diff) : []
  const added = files.reduce((sum, f) => sum + f.added, 0)
  const removed = files.reduce((sum, f) => sum + f.removed, 0)
  useTabNote(added || removed ? <DiffStat added={added} removed={removed} /> : null, `${added}/${removed}`)
  if (error) return <PaneMessage>{error.message}</PaneMessage>
  if (!changes) return <PaneMessage>Loading…</PaneMessage>
  if (!changes.repo) return <PaneMessage>{thread.cwd} isn't a git repository.</PaneMessage>
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  const open = (path: string) => {
    const kind = fileKind(registry, { machine: machine.id, thread }, path)
    if (kind) void dispatch('pane.open', { thread: thread.id, kind, params: { path } }, { machine: machine.id, source: 'git' })
  }
  const pick = (next: Base) =>
    void dispatch('pane.update', { thread: thread.id, pane: pane.id, params: { base: next } satisfies ChangesParams }, { machine: machine.id, source: 'git' })
  return (
    <div className="git-changes">
      <PaneHeader>
        <BasePicker bases={changes.bases} base={changes.base} onPick={pick} />
        <PaneNote>{count(files.length, 'file')}{changes.untracked.length ? ` · ${changes.untracked.length} new` : ''}</PaneNote>
        <PaneButton onClick={refetch}>Refresh</PaneButton>
      </PaneHeader>
      {!files.length && !changes.untracked.length && <PaneMessage>No changes.</PaneMessage>}
      <Diff diff={files} />
      {changes.untracked.length > 0 && (
        <div className="git-untracked">New, not tracked yet: {changes.untracked.map((path) => (
          <button key={path} type="button" className="git-untracked__file" onClick={() => open(path)}>{path}</button>
        ))}</div>
      )}
    </div>
  )
}

/** In the header: the base the changes are measured from, a menu of the ones the folder offers. */
function BasePicker({ bases, base, onPick }: { bases: BaseChoice[]; base: Base; onPick(base: Base): void }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="pane-header__button git-base" aria-label="Changes from">
        {baseLabel(bases.find((b) => b.base === base)!)}<CaretDownIcon size={10} weight="bold" aria-hidden />
      </Menu.Trigger>
      <Menu.Popup>
        <Menu.RadioGroup value={base} onValueChange={onPick}>
          {bases.map((b) => <Menu.RadioItem key={b.base} value={b.base} closeOnClick>{baseLabel(b)}</Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Popup>
    </Menu.Root>
  )
}
