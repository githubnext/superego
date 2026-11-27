// Pages: a sidebar listing three pages, each a space in the main area (its section's). The window does the rest:
// which section is shown, which button is lit.
import { useEffect } from 'react'
import { defineUiExtension, FileTextIcon, List, ListItem, useDispatch, type SpaceProps, type ViewProps } from 'superego/ui'

const PAGES: Record<string, string> = {
  roadmap: 'What ships this quarter: the ledger import, the monthly report, and the shared budgets.',
  ideas: 'A reconcile view that puts the bank and the ledger side by side.',
  meeting: 'Thursday: go through the import errors with Maja.',
}

export default defineUiExtension({
  name: 'pages',
  setup(superego) {
    const shown = superego.store<string | null>('shown', null)

    function Pages({ machine }: ViewProps<'window'>) {
      const dispatch = useDispatch()
      const current = shown.use()
      return (
        <div className="pages-list">
          <div className="pages-list__head">Pages</div>
          <List>
            {Object.keys(PAGES).map((name) => (
              <ListItem key={name} selected={current === name} leading={<FileTextIcon size={14} aria-hidden />}
                onClick={() => void dispatch('space.open', { kind: 'pages.page', params: { name }, machine: machine!.id }).catch((e: Error) => console.error(e))}>
                {name}
              </ListItem>
            ))}
          </List>
        </div>
      )
    }
    function Page({ params }: SpaceProps) {
      const name = String(params.name)
      useEffect(() => { shown.set(name); return () => shown.set(null) }, [name])
      return <article className="pages-page"><h1>{name}</h1><p>{PAGES[name]}</p></article>
    }
    superego.view('pages.list', { title: 'Pages', icon: FileTextIcon, context: 'window', fits: ['sidebar'], default: 'sidebar', component: Pages })
    superego.space('pages.page', { title: (params) => String(params.name), icon: FileTextIcon, component: Page, agent: 'docked' })
    superego.style(`
      .pages-list__head { padding: 10px 14px 6px; font-weight: 600; }
      .pages-page { padding: 32px 40px; max-width: 640px; }
      .pages-page h1 { margin: 0 0 12px; font-size: 22px; }
    `)
  },
})
