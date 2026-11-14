/// <reference path="./env.d.ts" />
// git, UI half: Changes, a pane beside the thread (from its pane menu, ⌘⇧D, or the agent's open_pane "diff") with what
// changed in its folder, file by file, refreshed as the thread moves on. Its tab in the strip says how much: +N −N.
// Files git doesn't track yet are listed under it, each to open beside.
import { defineAction, defineUiExtension, Diff, fileKind, has, PaneHeader, parseDiff, useDispatch, useMethod, useRegistry, useTabNote, type PaneProps } from '@superego/app/ui'
import { ArrowsLeftRightIcon } from '@superego/ui'
import './styles.css'
import { about, CHANGES, DIFF, type Changes } from './shared.ts'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.pane(CHANGES, { title: 'Changes', icon: ArrowsLeftRightIcon, component: ChangesPane, menu: true, width: 0.45 })
    superego.action(defineAction({
      id: 'git.changes', title: 'Show changes', keys: 'mod+shift+d',
      // Not on a machine without a git daemon half this speaks: an older Superego there has no git.diff.
      when: (c) => Boolean(c.selection) && has(c.machines.find((m) => m.id === c.selection!.machine), SPEAKS),
      run: async (_p, c) => { if (c.selection) await c.dispatch('pane.open', { id: c.selection.thread, kind: CHANGES }, { machine: c.selection.machine, source: 'git' }) },
    }))
  },
})

/** The git daemon halves this one speaks: 1.x, or one from before versions (0.0.0), whose git.diff is 1.0's. */
const SPEAKS = 'ext:git@<2'

/** The folder's changes by git, refreshed as the thread moves on. */
function ChangesPane({ machine, thread }: PaneProps) {
  const registry = useRegistry()
  const dispatch = useDispatch()
  const able = has(machine, SPEAKS)
  const { data: changes, error, refetch } = useMethod<Changes>(machine.id, DIFF, { id: thread.id }, { enabled: able, refresh: `${thread.activeAt}/${thread.status.state}` })
  const files = changes?.repo ? parseDiff(changes.diff) : []
  const added = files.reduce((sum, f) => sum + f.added, 0)
  const removed = files.reduce((sum, f) => sum + f.removed, 0)
  useTabNote(added || removed ? <span className="strip__note"><span className="stat--add">+{added}</span> <span className="stat--del">−{removed}</span></span> : null, `${added}/${removed}`)
  if (!able) return <div className="pane-empty">Superego on {machine.label} is too old to show changes.</div>
  if (error) return <div className="pane-empty">{error.message}</div>
  if (!changes) return <div className="pane-empty">Loading…</div>
  if (!changes.repo) return <div className="pane-empty">{thread.cwd} isn't a git repository.</div>
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  const open = (path: string) => {
    const kind = fileKind(registry, { machine: machine.id, thread }, path)
    if (kind) void dispatch('pane.open', { id: thread.id, kind, params: { path } }, { machine: machine.id, source: 'git' })
  }
  return (
    <div className="pane-scroll diff-pane">
      <PaneHeader>
        <span className="pane-header__note">{count(files.length, 'file')}{changes.untracked.length ? ` · ${changes.untracked.length} new` : ''}</span>
        <button type="button" className="pane-header__button" onClick={refetch}>Refresh</button>
      </PaneHeader>
      {!files.length && !changes.untracked.length && <div className="pane-empty">No changes.</div>}
      <Diff diff={files} />
      {changes.untracked.length > 0 && (
        <div className="diff-file"><div className="diff-untracked">New, not tracked yet: {changes.untracked.map((path) => (
          <button key={path} className="diff-untracked__file" onClick={() => open(path)}>{path}</button>
        ))}</div></div>
      )}
    </div>
  )
}
