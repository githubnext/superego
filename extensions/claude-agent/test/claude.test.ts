// Finding the user's `claude`: from their login shell's PATH, never what the shell says `claude` is (an alias there,
// with flags, isn't a file to run); the daemon's PATH after it. Each test has a PATH of its own, so the machine's own
// `claude` is never what's found.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { findClaude, onPath } from '../src/claude.ts'

const dirs: string[] = []
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'claude-find-')); dirs.push(dir); return dir }
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url))
const { SHELL: shell, PATH: path } = process.env
beforeEach(() => { process.env.PATH = scratch() })
afterEach(() => {
  process.env.SHELL = shell; process.env.PATH = path
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A folder with an executable `claude` in it. */
function withClaude() {
  const bin = scratch()
  writeFileSync(join(bin, 'claude'), '#!/bin/bash\n'); chmodSync(join(bin, 'claude'), 0o755)
  return bin
}

it('finds claude on the login shell\'s PATH, where the shell has it aliased with flags', async () => {
  // A file of the checkout's, not one written here, run by bash (fixtures/login-shell says why): on a busy machine a
  // program can take seconds to start, past the 5s the shell is given.
  process.env.SHELL = fixture('login-shell')
  expect(await findClaude()).toBe(fixture('bin/claude'))
})

it('takes the given claude over any other', async () => {
  expect(await findClaude('/opt/claude')).toBe('/opt/claude')
})

it('finds nothing on a PATH without claude', async () => {
  expect(await onPath(scratch())).toBeUndefined()
})

it("looks on the daemon's PATH when the login shell can't be asked, and says why when it isn't there either", async () => {
  process.env.SHELL = join(scratch(), 'no-such-shell')
  await expect(findClaude()).rejects.toThrow(/Couldn't read the PATH of your login shell \(.*no-such-shell\)/)
  const bin = withClaude()
  process.env.PATH = bin
  expect(await findClaude()).toBe(join(bin, 'claude'))
})
