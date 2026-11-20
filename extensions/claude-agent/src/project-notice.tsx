// A folder's Claude Code settings waiting to be allowed, over the composer of a Claude Agent thread whose folder has
// settings of its own not allowed as they are (the thread's facts, the daemon half's): a notice to allow them, with
// each of their files to open and read first. Put off ("Not now"), it's remembered for those files as they are. Where
// another user could change them, it says so, with nothing to allow.
import { useState } from 'react'
import { factsOf, useDispatch, useLocalState, type SlotProps } from '@superego/app/ui'
import { Button } from '@superego/ui'
import { about, ALLOW, type ProjectFacts } from './shared.ts'

export function ProjectNotice({ machine, thread }: SlotProps['composer.above']) {
  const project = factsOf<ProjectFacts>(thread, about)
  const dispatch = useDispatch()
  const [dismissed, setDismissed] = useLocalState<string[]>('claude-agent.dismissed', [], { shared: true })
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  if (!project || project.allowed || thread.archived) return null
  const key = `${machine.id}:${project.cwd}:${project.hash}`
  if (dismissed.includes(key)) return null
  const allow = () => {
    setError(undefined)
    dispatch(ALLOW, { cwd: project.cwd, hash: project.hash }, { machine: machine.id, source: 'claude-agent' }).catch((e: Error) => setError(e.message))
  }
  const show = (file: string) => void dispatch('pane.open', {
    thread: thread.id, kind: 'editor', params: { path: file.startsWith('/') ? file : `${project.cwd}/${file}` },
  }, { machine: machine.id, source: 'claude-agent' }).catch((e: Error) => setError(e.message))
  return (
    <div className="service-notice claude-project" role="status" aria-live="polite">
      <div className="service-notice__label">
        {project.changed ? 'This folder’s Claude Code settings changed since you allowed them.' : 'This folder has Claude Code settings of its own.'}
      </div>
      <div className="service-notice__note">
        {project.unsafe
          ? <>Claude Code also reads settings from <code>{project.unsafe}</code>, which other users on this computer can change,
            so it runs here with your own settings only (and without the folder’s CLAUDE.md).</>
          : <>Their hooks, MCP servers and permissions can run commands, so Claude Code runs here without them (and without the
            folder’s CLAUDE.md) until you allow them.</>}
      </div>
      {open && (
        <ul className="claude-project__files">
          {project.files.map((file) => <li key={file}><button type="button" className="claude-project__file" onClick={() => show(file)}>{file}</button></li>)}
        </ul>
      )}
      <div className="service-notice__actions">
        {!project.unsafe && <Button variant="primary" onClick={allow}>Allow</Button>}
        <Button onClick={() => setDismissed((list) => [...list.filter((k) => !k.startsWith(`${machine.id}:${project.cwd}:`)), key])}>{project.unsafe ? 'Dismiss' : 'Not now'}</Button>
        <Button variant="ghost" className="claude-project__more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {project.files.length === 1 ? '1 file' : `${project.files.length} files`}
        </Button>
      </div>
      {error && <div className="service-notice__detail">{error}</div>}
    </div>
  )
}
