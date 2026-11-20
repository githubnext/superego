// A folder of a thread's as a folder pane reads it (`files.entries`): what's on disk, ignored and untracked files too,
// and why it can't be read when it can't.
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { testDaemon, type TestDaemon } from '@superego/sdk/testing'
import files from '../src/daemon.ts'
import { ENTRIES, type FolderEntries } from '../src/shared.ts'

let daemon: TestDaemon
let repo: string
beforeEach(async () => {
  daemon = await testDaemon({ extensions: [files] })
  repo = join(daemon.dataDir, 'repo')
  await mkdir(repo)
})
afterEach(() => daemon.close())

const put = async (paths: string[]) => {
  for (const path of paths) {
    if (path.endsWith('/')) { await mkdir(join(repo, path), { recursive: true }); continue }
    await mkdir(join(repo, path, '..'), { recursive: true })
    await writeFile(join(repo, path), '')
  }
}
const entries = async (thread: string, path: string) => (await daemon.call<FolderEntries>(ENTRIES, { thread, path })).entries

it('lists a git-ignored folder, and an untracked one, as they are on disk', async () => {
  execFileSync('git', ['init', '-q', repo])
  await put(['.gitignore', 'scripts/recovery/img/a.png', 'scripts/recovery/img/b.png', 'scripts/recovery/img/old/c.png', 'notes/draft.md', 'README.md'])
  await writeFile(join(repo, '.gitignore'), 'scripts/*\n')
  execFileSync('git', ['-C', repo, 'add', '.gitignore', 'README.md'])
  const thread = await daemon.thread(undefined, { cwd: repo })
  expect(await entries(thread.id, 'scripts/recovery/img')).toEqual([{ name: 'old', folder: true }, { name: 'a.png', folder: false }, { name: 'b.png', folder: false }])
  expect(await entries(thread.id, 'notes')).toEqual([{ name: 'draft.md', folder: false }])
  // The thread's own folder: everything but git's own.
  expect((await entries(thread.id, '')).map((e) => e.name)).toEqual(['notes', 'scripts', '.gitignore', 'README.md'])
})

it('lists a folder outside the thread\'s, by a path relative to it or its whole path', async () => {
  await put(['inner/'])
  await mkdir(join(daemon.dataDir, 'beside'))
  await writeFile(join(daemon.dataDir, 'beside/a.md'), '')
  const thread = await daemon.thread(undefined, { cwd: join(repo, 'inner') })
  expect(await entries(thread.id, '../../beside')).toEqual([{ name: 'a.md', folder: false }])
  expect(await entries(thread.id, join(daemon.dataDir, 'beside'))).toEqual([{ name: 'a.md', folder: false }])
})

it("tells an empty folder from one it can't read", async () => {
  await put(['empty/', 'file.txt', 'locked/secret.txt'])
  const thread = await daemon.thread(undefined, { cwd: repo })
  expect(await entries(thread.id, 'empty')).toEqual([])
  await expect(entries(thread.id, 'gone')).rejects.toThrow("gone isn't there")
  await expect(entries(thread.id, 'file.txt')).rejects.toThrow('file.txt is a file, not a folder')
  if (process.getuid?.() !== 0) {
    await chmod(join(repo, 'locked'), 0o000)
    await expect(entries(thread.id, 'locked')).rejects.toThrow('No permission to read locked')
    await chmod(join(repo, 'locked'), 0o755)
  }
})
