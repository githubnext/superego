// Where a project's own files come from (AGENTS.md, its profiles): within the project, and only what no one but the
// user could have put there. On a shared machine, another user can write /tmp or a group's folder.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentsInstructions } from '../src/agents-md.ts'
import { projectProfiles } from '../src/profiles.ts'
import { projectFolders, trusted } from '../src/project-files.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'superego-project-files-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const write = (path: string, text = '') => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }
const at = (...parts: string[]) => join(root, ...parts)
/** The AGENTS.md files read for a thread in `cwd`, by what they say. */
const instructions = async (cwd: string) => [...(await agentsInstructions(at('agents'), cwd) ?? '').matchAll(/<file path="[^"]*">\n(.*)\n<\/file>/g)].map((m) => m[1])

describe('AGENTS.md', () => {
  beforeEach(() => {
    write('agents/AGENTS.md', 'shared')
    write('AGENTS.md', 'above the repository')
    write('repo/.git/HEAD')
    write('repo/AGENTS.md', 'repository')
    write('repo/packages/AGENTS.md', 'packages')
    mkdirSync(at('repo', 'packages', 'app'))
  })

  it("comes from the repository's top down to the thread's folder, not from above it", async () => {
    expect(await instructions(at('repo', 'packages', 'app'))).toEqual(['shared', 'repository', 'packages'])
    expect(await instructions(at('repo'))).toEqual(['shared', 'repository'])
  })

  it('comes from the folder alone when it is in no repository', async () => {
    write('loose/AGENTS.md', 'loose')
    write('loose/sub/AGENTS.md', 'sub')
    expect(await instructions(at('loose', 'sub'))).toEqual(['shared', 'sub'])
  })

  it('skips what another user could have written: a folder on the way, the folder itself, or the file', async () => {
    chmodSync(at('repo', 'packages'), 0o777)
    expect(await instructions(at('repo', 'packages', 'app'))).toEqual(['shared'])
    expect(await instructions(at('repo', 'packages'))).toEqual(['shared'])
    chmodSync(at('repo', 'packages'), 0o755)
    chmodSync(at('repo', 'packages', 'AGENTS.md'), 0o666)
    expect(await instructions(at('repo', 'packages', 'app'))).toEqual(['shared', 'repository'])
  })
})

describe("a project's profiles", () => {
  const profile = (folder: string) => write(`${folder}/.superego/profiles/default/profile.ts`, 'export default {}\n')

  it("are found up to the repository's top, not above it", () => {
    profile('.')
    write('repo/.git/HEAD')
    mkdirSync(at('repo', 'src'))
    expect(projectProfiles(at('repo', 'src'), [])).toBeUndefined()
    profile('repo')
    expect(projectProfiles(at('repo', 'src'), [])).toBe(at('repo', '.superego', 'profiles'))
  })

  it('are not found where another user could have put them', () => {
    profile('shared')
    write('shared/.git/HEAD')
    mkdirSync(at('shared', 'src'))
    expect(projectProfiles(at('shared', 'src'), [])).toBe(at('shared', '.superego', 'profiles'))
    chmodSync(at('shared', '.superego', 'profiles'), 0o777)
    expect(projectProfiles(at('shared', 'src'), [])).toBeUndefined()
    chmodSync(at('shared', '.superego', 'profiles'), 0o755)
    chmodSync(at('shared'), 0o777)
    expect(projectProfiles(at('shared', 'src'), [])).toBeUndefined()
  })
})

describe.skipIf(process.getuid === undefined)('what only the user could have put there', () => {
  it("is the user's, writable by no one else: by their group only when it's theirs alone", () => {
    const gid = process.getgid!()
    mkdirSync(at('mine'), { mode: 0o755 })
    expect(trusted(at('mine'), null)).toBe(true)
    chmodSync(at('mine'), 0o775)
    expect(trusted(at('mine'), gid)).toBe(true)
    expect(trusted(at('mine'), null)).toBe(false)
    chmodSync(at('mine'), 0o757)
    expect(trusted(at('mine'), gid)).toBe(false)
    expect(trusted(at('missing'), gid)).toBe(false)
    // Root's (`/`) is as good as the user's.
    expect(trusted('/', null)).toBe(true)
  })

  it('stops the walk up at a folder another user can write', () => {
    write('shared/repo/.git/HEAD')
    mkdirSync(at('shared', 'repo', 'src'))
    chmodSync(at('shared', 'repo'), 0o777)
    // Its .git can't be reached: the thread's folder alone.
    expect(projectFolders(at('shared', 'repo', 'src'))).toEqual([at('shared', 'repo', 'src')])
    chmodSync(at('shared', 'repo'), 0o755)
    expect(projectFolders(at('shared', 'repo', 'src'))).toEqual([at('shared', 'repo', 'src'), at('shared', 'repo')])
  })
})
