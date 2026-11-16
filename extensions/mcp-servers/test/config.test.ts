// The machine's servers file: written for the user alone, and a file that doesn't parse said without quoting it.
import { statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ConfigFile } from '../src/config.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-mcp-config-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

it('writes the file only the user can read', async () => {
  const file = new ConfigFile(join(dir, 'mcp-servers.json'))
  await file.modify((f) => { f.servers.web = { url: 'https://example.com/mcp', headers: { 'X-Api-Key': 'hunter2-key' } } })
  expect(statSync(file.path).mode & 0o777).toBe(0o600)
  expect((await file.read()).servers.web?.url).toBe('https://example.com/mcp')
})

it("says where a file that doesn't parse is wrong, never what's in it", async () => {
  const file = new ConfigFile(join(dir, 'mcp-servers.json'))
  writeFileSync(file.path, '{\n  "servers": { "web": { "headers": { "Authorization": "Bearer sk-live-secret" } } x\n}')
  const error = await file.read().then(() => undefined, (e: Error) => e)
  expect(error?.message).toMatch(/isn't valid JSON \(line 2, column \d+\)$/)
  expect(error?.message).not.toContain('sk-live-secret')
  expect(error?.message).not.toContain('Bearer')
  await expect(file.modify(() => {})).rejects.toThrow(/isn't valid JSON/)
})
