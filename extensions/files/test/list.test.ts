import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { listFiles } from '../src/daemon.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mu-files-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

const put = async (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), content)
  }
}

it("lists a repository's files as git does: tracked and new, not ignored", async () => {
  execFileSync('git', ['init', '-q', dir])
  await put({ '.gitignore': 'dist/\n', 'src/a.ts': '', 'README.md': '', 'dist/out.js': '', 'new.txt': '' })
  execFileSync('git', ['-C', dir, 'add', 'src', 'README.md', '.gitignore'])
  expect(await listFiles(dir)).toEqual({ files: ['.gitignore', 'new.txt', 'README.md', 'src/a.ts'], truncated: false })
})

it('walks a plain folder, leaving out dependencies and hidden folders', async () => {
  await put({ 'notes/a.md': '', 'b.md': '', 'node_modules/x/index.js': '', '.obsidian/app.json': '', '.env': '' })
  expect(await listFiles(dir)).toEqual({ files: ['.env', 'b.md', 'notes/a.md'], truncated: false })
})
