// A daemon closing: once `close()` resolves, nothing writes in its data folder any more, so a test can delete it at once.
// Opened and closed in a loop with what keeps writing in the background: an MCP server's session (its log, its tools'
// cache), a worktree being deleted after its thread was archived, and a settings change still being saved.
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ONBOARDED, type ThreadInfo } from '@superego/protocol'
import { testDaemon } from '@superego/sdk/testing'
import worktrees from '@superego/worktrees/daemon'
import { mcpServersExtension } from '../src/daemon.ts'

const FIXTURE = join(import.meta.dirname, 'fixture.ts')
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Every file in `dir` but the repository's, with its size and when it was last changed. */
async function snapshot(dir: string) {
  const files = new Map<string, string>()
  for (const name of await readdir(dir, { recursive: true }).catch(() => [] as string[])) {
    if (name === 'repo' || name.startsWith('repo/')) continue
    const stat = await lstat(join(dir, name)).catch(() => undefined)
    files.set(name, stat ? `${stat.size} ${stat.mtimeMs}` : 'gone')
  }
  return files
}

it('writes nothing in its data folder once closed', async () => {
  const late: string[] = []
  for (let round = 0; round < 4; round++) {
    const dir = await mkdtemp(join(tmpdir(), 'superego-test-'))
    const d = await testDaemon({ dataDir: dir, model: 'echo', extensions: [mcpServersExtension({ checkWait: 15_000, firstListing: 60_000 }), worktrees], agentPartsLimit: 65_000 })
    // A repository with enough in it that deleting a worktree of it takes a moment.
    const repo = join(dir, 'repo')
    execFileSync('git', ['init', '-q', repo])
    for (let file = 0; file < 200; file++) writeFileSync(join(repo, `${file}.txt`), 'x')
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'])
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'start'])

    // A server every thread has, running for the thread that used it, and started again as the daemon closes.
    await d.dispatch('mcp-servers.add', { name: 'fx', server: { command: process.execPath, args: [FIXTURE], unprofiled: true } })
    await d.thread('hi')
    void d.dispatch('mcp-servers.restart', { server: 'fx' }).catch(() => {})
    // A thread's worktree, archived: deleted in the background.
    const thread = await d.call<ThreadInfo>('thread.start', { cwd: repo, title: 'x', options: { worktrees: true } })
    await d.call('thread.archive', { thread: thread.id })
    // A setting being saved.
    void d.call('settings.set', { key: ONBOARDED, value: true }).catch(() => {})
    await d.close()

    if (round % 2) {
      // Deleted at once, as a test's cleanup does: nothing in the way, and nothing made again after.
      await rm(dir, { recursive: true }).catch((error: Error) => late.push(`${round}: ${error.message}`))
      await pause(1000)
      if (existsSync(dir)) late.push(`${round}: made again: ${(await readdir(dir, { recursive: true })).join(', ')}`)
    } else {
      // Left a while: nothing changes.
      const before = await snapshot(dir)
      await pause(1000)
      const after = await snapshot(dir)
      for (const [name, stat] of after) if (before.get(name) !== stat) late.push(`${round}: ${name} changed`)
      for (const name of before.keys()) if (!after.has(name)) late.push(`${round}: ${name} gone`)
      await rm(dir, { recursive: true })
    }
  }
  expect(late).toEqual([])
}, 120_000)
