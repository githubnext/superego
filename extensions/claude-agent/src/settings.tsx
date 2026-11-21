// Settings → Claude Agent, under its settings: Claude Code on this machine as last looked at (where it is, its version,
// whether it's signed in), looked at again as it's shown. Not signed in, how to: Claude Code's own `/login`, in a
// terminal beside a thread on that machine (the one shown, else its newest), which Superego opens running `claude` and
// leaves to the user. Superego never signs in for them.
import { useEffect, useState } from 'react'
import { useAllThreads, useDispatch, useSelection, type SettingsComponentProps } from '@superego/app/ui'
import { Button } from '@superego/ui'
import { CHECK, signedIn, TERMINAL, type ClaudeCheck } from './shared.ts'

export function ClaudeSection({ target, section }: SettingsComponentProps) {
  const dispatch = useDispatch()
  const { selection, select } = useSelection()
  const threads = useAllThreads()[target]
  const found = section.data as ClaudeCheck | null | undefined
  const [problem, setProblem] = useState<string>()
  const [looking, setLooking] = useState(false)

  const look = () => {
    setLooking(true)
    setProblem(undefined)
    dispatch(CHECK, {}, { machine: target, source: 'settings' }).then(
      () => setLooking(false),
      (error: Error) => { console.error('Looking at Claude Code failed', error); setProblem(error.message); setLooking(false) })
  }
  // Looked at again as it's shown: signed in since, say.
  useEffect(look, [target])

  // Where its terminal opens: beside the thread shown when it's on this machine, else this machine's newest.
  const host = selection?.machine === target ? selection.thread : threads?.filter((t) => !t.archived && !t.hidden).sort((a, b) => b.activeAt - a.activeAt)[0]?.id
  const terminal = () => {
    if (!host) return
    setProblem(undefined)
    dispatch(TERMINAL, { thread: host }, { machine: target, source: 'settings' }).then(
      () => select({ machine: target, thread: host }),
      (error: Error) => { console.error('Opening Claude Code in a terminal failed', error); setProblem(error.message) })
  }

  if (found === undefined || found === null) return <p className="settings__note">{problem ?? 'Looking for Claude Code…'}</p>
  return (
    <div className="claude-agent-settings">
      {!found.installed
        ? <p className="settings__note">Claude Code isn't installed here: see code.claude.com.</p>
        : <>
          <div className="setting">
            <div className="setting__label">
              <div>Claude Code{found.version ? ` ${found.version}` : ''}</div>
              <div className="claude-agent-settings__path">{found.path}</div>
            </div>
            <div className={`setting__control ${found.loggedIn ? '' : 'claude-agent-settings__out'}`}>{signedIn(found)}</div>
          </div>
          {!found.loggedIn && <p className="settings__note">Run <code>claude</code> and <code>/login</code> in a terminal.</p>}
        </>}
      <div className="claude-agent-settings__buttons">
        {found.installed && !found.loggedIn && (
          <Button onClick={terminal} disabled={!host} title={host ? undefined : 'Start a thread on this machine first: the terminal opens beside it'}>Open a terminal</Button>
        )}
        <Button onClick={look} disabled={looking}>{looking ? 'Looking…' : 'Check again'}</Button>
      </div>
      {problem && <p className="setting__error">{problem}</p>}
    </div>
  )
}
