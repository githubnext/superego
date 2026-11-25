// The end of a narrowed sidebar (`superego.sidebarFilter`): each narrowing's own footer, else a quiet line saying how
// many threads it hides.
import { Contained } from './contained.tsx'
import type { Narrowed } from './projects.ts'

export function NarrowedFooter({ narrowed }: { narrowed: Narrowed }) {
  const { by, hidden, shown } = narrowed
  return (
    <>
      {by.map(({ extension, footer: Footer }) => Footer && (
        <Contained key={extension} name={extension}><Footer hidden={hidden} shown={shown} /></Contained>
      ))}
      {hidden > 0 && by.some((n) => !n.footer) && <div className="sidebar-hidden">{hidden} hidden</div>}
    </>
  )
}
