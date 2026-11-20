// What an artifact is served: the one fence on a thread's files that's kept. The editor, links and folder panes open
// any file on the thread's machine (its agent can read them all anyway), but an artifact's files are asked for by the
// page itself, a script the agent wrote from whatever it read: it gets the thread's folder and nothing past it.
import { expect, it } from 'vitest'
import { artifactFile } from '../src/index.ts'

it('serves an artifact the files of its thread’s folder', () => {
  expect(artifactFile('report/index.html')).toBe('report/index.html')
  expect(artifactFile('report/./css/../app.css')).toBe('report/app.css')
  expect(artifactFile('a//b.js')).toBe('a/b.js')
})

it('refuses an address that leaves the folder, whatever the page asks', () => {
  expect(artifactFile('../secret.txt')).toBeUndefined()
  expect(artifactFile('report/../../secret.txt')).toBeUndefined()
  expect(artifactFile('/etc/hosts')).toBeUndefined()
  expect(artifactFile('~/.ssh/id_ed25519')).toBeUndefined()
  expect(artifactFile('~')).toBeUndefined()
  expect(artifactFile('')).toBeUndefined()
  // A name that only starts like home is a file in the folder.
  expect(artifactFile('~notes.html')).toBe('~notes.html')
})
