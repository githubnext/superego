// Board: a rail button showing a space no sidebar holds (its extension declares no sidebar), alone.
import { useEffect } from 'react'
import { defineUiExtension, RailButton, ShapesIcon, useDispatch, type ViewProps } from 'superego/ui'

export default defineUiExtension({
  name: 'board',
  setup(superego) {
    const board = superego.store<boolean>('board', false)

    function Board() {
      useEffect(() => { board.set(true); return () => board.set(false) }, [])
      return <div className="pages-board">{['To do', 'Doing', 'Done'].map((lane) => <section key={lane}><h2>{lane}</h2><div /><div /></section>)}</div>
    }
    function BoardButton({ machine }: ViewProps<'window'>) {
      const dispatch = useDispatch()
      return (
        <RailButton label="Board" on={board.use()} onClick={() => void dispatch('space.open', { kind: 'board.main', machine: machine!.id }).catch((e: Error) => console.error(e))}>
          <ShapesIcon size={18} aria-hidden />
        </RailButton>
      )
    }

    superego.view('board.rail', { title: 'Board', icon: ShapesIcon, context: 'window', fits: ['rail'], default: 'rail', component: BoardButton })
    superego.space('board.main', { title: 'Board', icon: ShapesIcon, component: Board, agent: 'floating' })
    superego.style(`
      .pages-board { display: flex; gap: 16px; padding: 24px; height: 100%; box-sizing: border-box; }
      .pages-board section { flex: 1; background: var(--superego-hover); border-radius: var(--superego-radius); padding: 12px; }
      .pages-board h2 { margin: 0 0 10px; font-size: 13px; color: var(--superego-muted); }
      .pages-board div { height: 48px; margin-bottom: 8px; border-radius: var(--superego-radius); background: var(--superego-surface, var(--superego-bg)); border: 1px solid var(--superego-line); }
    `)
  },
})
