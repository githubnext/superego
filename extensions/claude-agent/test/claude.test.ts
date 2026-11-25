// Finding the user's `claude`: from their login shell's PATH (as the daemon read it), never what the shell says `claude`
// is (an alias there, with flags, isn't a file to run); the daemon's PATH after it. Each test has a PATH of its own, so
// the machine's own `claude` is never what's found.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readLoginEnv } from '@superego/daemon'
import { findClaude, onPath } from '../src/claude.ts'

const dirs: string[] = []
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'claude-find-')); dirs.push(dir); return dir }
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url))
const { PATH: path } = process.env
beforeEach(() => { process.env.PATH = scratch() })
afterEach(() => {
  process.env.PATH = path
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A folder with an executable `claude` in it. */
function withClaude() {
  const bin = scratch()
  writeFileSync(join(bin, 'claude'), '#!/bin/bash\n'); chmodSync(join(bin, 'claude'), 0o755)
  return bin
}

it('finds claude on the login shell\'s PATH, where the shell has it aliased with flags', async () => {
  // The daemon's read of a login shell: a file of the checkout's, not one written here, run by bash
  // (fixtures/login-shell says why): on a busy machine a program can take seconds to start, past the 5s it's given.
  expect(await findClaude(undefined, () => readLoginEnv({ shell: fixture('login-shell') }))).toBe(fixture('bin/claude'))
})

it('takes the given claude over any other, without reading the login shell', async () => {
  expect(await findClaude('/opt/claude', () => { throw new Error('read') })).toBe('/opt/claude')
})

it('finds nothing on a PATH without claude', async () => {
  expect(await onPath(scratch())).toBeUndefined()
  expect(await findClaude(undefined, async () => ({ env: { PATH: scratch() } }))).toBeUndefined()
})

it("looks on the daemon's PATH when the login shell couldn't be read, and says why when it isn't there either", async () => {
  const unread = async () => ({ error: "Couldn't read your login shell's environment (zsh): it didn't answer within 5s" })
  await expect(findClaude(undefined, unread)).rejects.toThrow("Couldn't read your login shell's environment (zsh): it didn't answer within 5s")
  const bin = withClaude()
  process.env.PATH = bin
  expect(await findClaude(undefined, unread)).toBe(join(bin, 'claude'))
})
