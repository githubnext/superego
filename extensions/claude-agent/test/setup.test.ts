// Setup's side of Claude Agent: whether Claude Code is installed and signed in (`claude auth status`, run on a fake
// `claude` here, never touching anyone's sign-in), and the "claude" profile it makes, left alone once there.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { testDaemon, type TestDaemon } from '@superego/sdk/testing'
import { claudeAgent } from '../src/daemon.ts'
import { MAKE_PROFILE, STATUS } from '../src/shared.ts'

let dir: string | undefined
let daemon: TestDaemon | undefined
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** A `claude` that answers `auth status` with `json`, and writes down the environment it got. */
function fakeClaude(json: object) {
  dir = mkdtempSync(join(tmpdir(), 'superego-claude-setup-'))
  const file = join(dir, 'claude')
  writeFileSync(file, `#!/bin/sh\nenv > "${dir}/env"\n[ "$1 $2" = "auth status" ] && echo '${JSON.stringify(json)}'\n`)
  chmodSync(file, 0o755)
  return file
}

it('says Claude Code is signed in, asking it without Anthropic credentials', async () => {
  const claude = fakeClaude({ loggedIn: true, authMethod: 'claude.ai', email: 'not-kept@example.com' })
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-should-not-reach-claude'
  try {
    daemon = await testDaemon({ extensions: [claudeAgent({ executable: async () => claude })] })
    expect(await daemon.dispatch(STATUS)).toEqual({ installed: true, loggedIn: true, how: 'claude.ai' })
    expect(readFileSync(join(dir!, 'env'), 'utf8')).not.toContain('ANTHROPIC_API_KEY')
  } finally { delete process.env.ANTHROPIC_API_KEY }
})

it('says when Claude Code is signed out, or not installed', async () => {
  const claude = fakeClaude({ loggedIn: false, authMethod: 'none' })
  daemon = await testDaemon({ extensions: [claudeAgent({ executable: async () => claude })] })
  expect(await daemon.dispatch(STATUS)).toEqual({ installed: true, loggedIn: false })
  await daemon.close()
  daemon = await testDaemon({ extensions: [claudeAgent({ executable: async () => undefined })] })
  expect(await daemon.dispatch(STATUS)).toEqual({ installed: false })
})

it('makes a "claude" profile that picks Claude Agent, and leaves one already there', async () => {
  daemon = await testDaemon({ extensions: [claudeAgent({ executable: async () => undefined })] })
  expect(await daemon.dispatch(MAKE_PROFILE)).toEqual({ name: 'claude' })
  const file = join(daemon.dataDir, 'profiles', 'claude', 'profile.ts')
  expect(readFileSync(file, 'utf8')).toContain("export default { agent: 'claude-agent' }")
  writeFileSync(file, "export default { agent: 'claude-agent', prompt: 'mine' }\n")
  await daemon.dispatch(MAKE_PROFILE)
  expect(readFileSync(file, 'utf8')).toContain("prompt: 'mine'")
})
