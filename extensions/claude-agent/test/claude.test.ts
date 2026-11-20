// Finding the user's `claude`: from their login shell's PATH, never what the shell says `claude` is (an alias there,
// with flags, isn't a file to run).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { findClaude, onPath } from '../src/claude.ts'

const dirs: string[] = []
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'claude-find-')); dirs.push(dir); return dir }
const shell = process.env.SHELL
afterEach(() => { process.env.SHELL = shell; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('finds claude on the login shell\'s PATH, where the shell has it aliased with flags', async () => {
  const bin = scratch()
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n'); chmodSync(join(bin, 'claude'), 0o755)
  // A shell whose startup prints noise, whose `claude` is an alias, and whose PATH has claude's folder.
  const sh = join(scratch(), 'zsh')
  writeFileSync(sh, `#!/bin/sh\necho "welcome back"\nalias claude='claude --dangerously-skip-permissions'\nPATH="/nowhere:${bin}:$PATH"\neval "$2"\n`)
  chmodSync(sh, 0o755)
  process.env.SHELL = sh
  expect(await findClaude()).toBe(join(bin, 'claude'))
})

it('takes the given claude over any other', async () => {
  expect(await findClaude('/opt/claude')).toBe('/opt/claude')
})

it('finds nothing on a PATH without claude', async () => {
  expect(await onPath(scratch())).toBeUndefined()
})
