// The machine's servers file: written for the user alone, and a file that doesn't parse said without quoting it; and a
// profile's mcpServers.
import { statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ConfigFile, profileServerNames, profileServers, profileServersProblem } from '../src/config.ts'

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

it("reads a profile's mcpServers: the machine's servers by name, and its own (a later one of a name winning), and checks it", () => {
  expect(profileServers(['linear', { docs: { command: 'node' } }, 'sentry', 'docs', { docs: { url: 'https://docs.example/mcp' } }])).toEqual({
    names: ['linear', 'sentry'], own: { docs: { url: 'https://docs.example/mcp' } },
  })
  expect(profileServerNames(['linear', { docs: { command: 'node' } }])).toEqual(['linear', 'docs'])
  expect(profileServersProblem(['linear', { docs: { command: 'node', args: ['x'] } }])).toBeUndefined()
  for (const [value, problem] of [
    [{ linear: true }, /must be a list/],
    [['Linear'], /"Linear" isn't a server name/],
    [[{ my__docs: { command: 'node' } }], /"my__docs" isn't a server name/],
    [[{ docs: { command: 'node', url: 'https://x' } }], /docs needs one of a command or a URL, not both/],
    [[{ docs: { args: ['x'] } }], /docs needs one of a command or a URL$/],
    [[{ docs: { url: 'http://docs.example/mcp' } }], /must use https/],
    [[{ docs: { command: 'node', args: 'x' } }], /docs.args must be a list of strings/],
    [[3], /neither a server's name nor an object/],
  ] as const) expect(profileServersProblem(value as never)).toMatch(problem)
})
