// What an artifact is served: the one fence on a thread's files that's kept. The editor, links and folder panes open
// any file on the thread's machine (its agent can read them all anyway), but an artifact's files are asked for by the
// page itself, a script the agent wrote from whatever it read: it gets the thread's folder and nothing past it, as
// written and as it really is on disk (symlinks, of the file or a folder on the way, swapped or not).
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { artifactFile, readArtifact } from '../src/artifacts.ts'

let dir: string
let repo: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-artifacts-'))
  repo = join(dir, 'repo')
  await mkdir(join(repo, 'report'), { recursive: true })
  await writeFile(join(repo, 'report/index.html'), '<h1>report</h1>')
  await writeFile(join(dir, 'secret.txt'), 'secret')
  await mkdir(join(dir, 'outside'))
  await writeFile(join(dir, 'outside/key.txt'), 'key')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('serves an artifact the files of its thread’s folder', () => {
  expect(artifactFile('report/index.html')).toBe('report/index.html')
  expect(artifactFile('report/./css/../app.css')).toBe('report/app.css')
  expect(artifactFile('a//b.js')).toBe('a/b.js')
})

it('refuses an address that leaves the folder, whatever the page asks', async () => {
  expect(artifactFile('../secret.txt')).toBeUndefined()
  expect(artifactFile('report/../../secret.txt')).toBeUndefined()
  expect(artifactFile('/etc/hosts')).toBeUndefined()
  expect(artifactFile('~/.ssh/id_ed25519')).toBeUndefined()
  expect(artifactFile('~')).toBeUndefined()
  expect(artifactFile('')).toBeUndefined()
  // A name that only starts like home is a file in the folder.
  expect(artifactFile('~notes.html')).toBe('~notes.html')
  await expect(readArtifact(repo, '../secret.txt')).rejects.toMatchObject({ kind: 'forbidden' })
  await expect(readArtifact(repo, join(dir, 'secret.txt'))).rejects.toMatchObject({ kind: 'forbidden' })
})

it('reads a file really in the folder, through symlinks that stay in it, and a folder that is one itself', async () => {
  expect(String(await readArtifact(repo, 'report/index.html'))).toBe('<h1>report</h1>')
  await symlink('report/index.html', join(repo, 'home.html'))
  await symlink('report', join(repo, 'latest'))
  expect(String(await readArtifact(repo, 'home.html'))).toBe('<h1>report</h1>')
  expect(String(await readArtifact(repo, 'latest/index.html'))).toBe('<h1>report</h1>')
  await symlink(repo, join(dir, 'linked'))
  expect(String(await readArtifact(join(dir, 'linked'), 'report/index.html'))).toBe('<h1>report</h1>')
})

it('refuses a symlink out of the folder: the file’s, or a folder’s on the way', async () => {
  await symlink(join(dir, 'secret.txt'), join(repo, 'secret.txt'))
  await symlink('../outside', join(repo, 'vendor'))
  await mkdir(join(repo, 'deep'))
  await symlink('../../outside', join(repo, 'deep/up'))
  await expect(readArtifact(repo, 'secret.txt')).rejects.toMatchObject({ kind: 'forbidden', message: expect.stringContaining('outside the thread') })
  await expect(readArtifact(repo, 'vendor/key.txt')).rejects.toMatchObject({ kind: 'forbidden' })
  await expect(readArtifact(repo, 'deep/up/key.txt')).rejects.toMatchObject({ kind: 'forbidden' })
  // A sibling folder whose name starts like the thread's is outside it too.
  await mkdir(join(dir, 'repo-other'))
  await writeFile(join(dir, 'repo-other/x.txt'), 'x')
  await symlink('../repo-other/x.txt', join(repo, 'x.txt'))
  await expect(readArtifact(repo, 'x.txt')).rejects.toMatchObject({ kind: 'forbidden' })
})

it('never serves what a symlink swapped back and forth leads to outside', async () => {
  const link = join(repo, 'swap.txt')
  await writeFile(join(repo, 'inside.txt'), 'inside')
  await symlink('inside.txt', link)
  // Swapped in place (a new link renamed over it), so the name always leads somewhere: inside, or out.
  let swapping = true
  let swaps = 0
  const swap = (async () => {
    for (; swapping; swaps++) {
      const next = `${link}.${swaps}`
      await symlink(swaps % 2 ? 'inside.txt' : join(dir, 'secret.txt'), next)
      await rename(next, link)
    }
  })()
  const served = new Set<string>()
  for (let i = 0; i < 300; i++) served.add(await readArtifact(repo, 'swap.txt').then(String, (error: Error) => error.message))
  swapping = false
  await swap
  expect(swaps).toBeGreaterThan(10)
  expect([...served]).not.toContain('secret')
  // What's left, served as ever.
  await symlink('inside.txt', `${link}.last`)
  await rename(`${link}.last`, link)
  expect(String(await readArtifact(repo, 'swap.txt'))).toBe('inside')
})

it('says why not: missing, a folder, not a file, too large', async () => {
  await expect(readArtifact(repo, 'gone.html')).rejects.toMatchObject({ kind: 'not_found' })
  await expect(readArtifact(repo, 'report')).rejects.toMatchObject({ kind: 'invalid' })
  await expect(readArtifact(join(dir, 'nowhere'), 'a.html')).rejects.toMatchObject({ kind: 'not_found' })
  // A FIFO isn't waited on for a writer.
  execFileSync('mkfifo', [join(repo, 'pipe')])
  await expect(readArtifact(repo, 'pipe')).rejects.toMatchObject({ kind: 'invalid' })
})
