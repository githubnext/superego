// The note pane: a note as Obsidian shows it, live preview to read and edit in one place (Superego's file editor), and
// the notes linking to it below. Show in graph centres the graph on it.
// [[wikilinks]] are this profile's: anywhere in its threads (a message, ⌃O, a note), [[Note#Heading|alias]] opens the
// note pane on the note the vault's rules find (a path, a title anywhere in the vault, an alias), at that heading.
import { useEffect, useState } from 'react'
import { defineUiExtension, FileEditor, useDispatch, Button, type PaneProps } from 'superego/ui'

type Note = { path: string; title: string; line?: number; backlinks: { path: string; title: string }[] }
type Params = { path?: string; heading?: string; block?: string }

/**
 * `wikilink:Note#Heading` (each part URI-encoded) taken apart, as superego/ui's `parseWikilink` does; its own, so this
 * loads in an app from before that export.
 */
function parseWikilink(href: string): { target: string; heading?: string; block?: string } | undefined {
  if (!href.toLowerCase().startsWith('wikilink:')) return undefined
  const [target = '', part] = href.slice('wikilink:'.length).split('#', 2)
  const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
  const sub = part ? decode(part) : ''
  return { target: decode(target), ...(sub.startsWith('^') ? { block: sub.slice(1) } : sub ? { heading: sub } : {}) }
}

function NotePane({ machine, thread, pane }: PaneProps) {
  const dispatch = useDispatch()
  const { path, heading, block } = (pane.params ?? {}) as Params
  const [note, setNote] = useState<Note>()
  const [error, setError] = useState<string>()
  const open = (kind: string, params: Record<string, unknown>, title?: string) => void dispatch('pane.open', { id: thread.id, kind, params, ...(title ? { title } : {}) }, { machine: machine.id })

  // Which note (a [[name]] resolves as Obsidian would) and what links to it, again as the thread moves on.
  useEffect(() => {
    if (!path) return
    dispatch('vault.note', { id: thread.id, path, ...(heading ? { heading } : {}), ...(block ? { block } : {}) }, { machine: machine.id })
      .then((n) => { setNote(n as Note); setError(undefined) }, (e: Error) => setError(e.message))
  }, [thread.id, path, heading, block, thread.activeAt])

  if (!path) return <div className="pane-empty">No note given.</div>
  if (error) return <div className="pane-empty">{error}</div>
  if (!note) return <div className="pane-empty">Reading…</div>
  return (
    <FileEditor key={note.path} machine={machine} thread={thread} path={note.path} {...(note.line ? { line: note.line } : {})}
      actions={<Button onClick={() => open('graph', { focus: note.path })}>Show in graph</Button>}>
      {note.backlinks.length > 0 && (
        <div className="vault-note__backlinks">
          <h3>Linked from</h3>
          {note.backlinks.map((b) => <a key={b.path} href="#" onClick={(e) => { e.preventDefault(); open('note', { path: b.path }, b.title) }}>{b.title}</a>)}
        </div>
      )}
    </FileEditor>
  )
}

export default defineUiExtension({
  name: 'vault-note',
  setup(superego) {
    superego.pane('note', {
      title: (pane) => (pane.params as { path?: string } | undefined)?.path?.split('/').at(-1)?.replace(/\.md$/, '') ?? 'Note',
      component: NotePane,
      // Notes named in the thread ([[GitHub]], `Work/GitHub/GitHub.md`) open here.
      opens: (path) => /\.md$/i.test(path),
    })
    // [[wikilinks]], ahead of the core's (which looks for a file of that name): the note the vault finds, in the note
    // pane, at its heading. Why not, if the vault has no such note.
    superego.link({
      match: 'wikilink:',
      async open(href, { machine, thread }) {
        const link = parseWikilink(href)
        if (!machine || !thread || !link?.target) return 'not a note'
        const params = { path: link.target, ...(link.heading ? { heading: link.heading } : {}), ...(link.block ? { block: link.block } : {}) }
        try {
          const found = await superego.dispatch('vault.note', { id: thread.id, ...params }, { machine }) as Note
          await superego.dispatch('pane.open', { id: thread.id, kind: 'note', title: found.title, params: { ...params, path: found.path } }, { machine })
          return undefined
        } catch (error) { return (error as Error).message }
      },
      target: (href) => { const link = parseWikilink(href); return link ? `${link.target}${link.heading ? ` › ${link.heading}` : ''}` : href },
    })
    // Pane styles: a profile's UI brings its own.
    const style = document.createElement('style')
    style.dataset.profile = 'obsidian'
    style.textContent = `
      .vault-graph { flex: 1; display: flex; flex-direction: column; min-height: 0; }
      .vault-graph__canvas { flex: 1; width: 100%; min-height: 0; cursor: grab; touch-action: none; }
      .vault-graph__legend { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; flex: 2 !important; }
      .vault-graph__legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
      .vault-note__backlinks { margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--superego-border); display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; }
      .vault-note__backlinks a { color: var(--superego-accent); text-decoration: none; }
      .vault-note__backlinks h3 { width: 100%; margin: 0 0 4px; font-size: 12px; color: var(--superego-muted); font-weight: 600; }
    `
    document.querySelector('style[data-profile="obsidian"]')?.remove()
    document.head.append(style)
  },
})
