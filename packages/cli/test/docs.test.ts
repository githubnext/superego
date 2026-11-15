// The guide's code, compiled: every ```ts and ```tsx block in the guide (skill/guide.md) and the UI topic (skill/ui.md)
// is type-checked against the stable surface ('superego', 'superego/ui', 'superego/testing'), as an author's profile
// is: against the author types, with the tsconfig `superego profile types` writes. A block that's a fragment of a setup
// says so in a comment just before it, `<!-- check: daemon -->` or `<!-- check: ui -->` (`superego` is then that half's
// API, the stable names are imported, and anything after a `;` is added: declarations of what the fragment takes as
// given), or `<!-- check: skip -->`. So the pages can't drift from the API.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { setUpProfileTypes } from '@superego/client/author-types'
import { sharedAuthorTypes } from './author-types.ts'

const SKILL = fileURLToPath(new URL('../skill/', import.meta.url))
/** The pages whose code is checked: the guide, and the UI topic's. */
const PAGES = ['guide.md', 'ui.md']

/** What a fragment of each half is given: its half's API as `superego`, and the stable names it might use. */
const PRELUDES = {
  daemon: [
    `import { arr, bool, defineAction, defineDaemonExtension, defineExtension, defineTool, int, lit, nullable, num, obj, opt, RpcError, spawnGroup, str, union, unknown } from 'superego'`,
    `import type { DaemonApi, ExtensionAbout, Json, SpawnedGroup, ThreadInfo, ViewContent } from 'superego'`,
    `declare const superego: DaemonApi`,
    `type Build = { id: string; command: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; at: number }`,
  ],
  ui: [
    `import { call, defineAction, defineUiExtension, has, Markdown, parseWikilink, useDispatch, useMethod, usePlacement, useSelection, useValue, version } from 'superego/ui'`,
    `import type { MachineEntry, PaneProps, ThreadInfo, UiApi, ViewProps } from 'superego/ui'`,
    `declare const superego: UiApi`,
    `declare const machine: MachineEntry`,
    `type Build = { id: string; command: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; at: number }`,
  ],
} as const

type Block = { line: number; lang: 'ts' | 'tsx'; code: string; mode: string; extra: string }

/** The guide's TypeScript blocks, each with the doc line its code starts on and how it's to be checked. */
export function blocksOf(markdown: string): Block[] {
  const lines = markdown.split('\n')
  const blocks: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*```(ts|tsx)\s*$/.exec(lines[i]!)
    if (!open) continue
    const start = i + 1
    let end = start
    while (end < lines.length && !/^\s*```\s*$/.test(lines[end]!)) end++
    let before = i - 1
    while (before >= 0 && !lines[before]!.trim()) before--
    const check = /^<!-- check: ([\s\S]*?) -->$/.exec(lines[before]?.trim() ?? '')
    const [mode = 'module', ...extra] = (check?.[1] ?? 'module').split(';')
    blocks.push({ line: start + 1, lang: open[1] as 'ts' | 'tsx', code: lines.slice(start, end).join('\n').replace(/^ {2}/gm, (m) => m), mode: mode.trim(), extra: extra.join(';') })
    i = end
  }
  return blocks
}

let dir: string
let types: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-docs-'))
  types = await sharedAuthorTypes()
}, 240_000)
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

/** Each page's blocks, with the page they're from. */
const pageBlocks = async () => (await Promise.all(PAGES.map(async (page) => blocksOf(await readFile(join(SKILL, page), 'utf8')).map((block) => ({ ...block, page }))))).flat()

it("finds the pages' blocks, each checked or skipped on purpose", async () => {
  const blocks = await pageBlocks()
  expect(blocks.filter((b) => b.page === 'guide.md').length).toBeGreaterThan(10)
  for (const block of blocks) expect(['module', 'daemon', 'ui', 'skip'], `the check at ${block.page}:${block.line}`).toContain(block.mode)
})

it("type-checks every TypeScript block in the guide and the UI topic against the stable surface", async () => {
  const blocks = (await pageBlocks()).filter((b) => b.mode !== 'skip')
  const offsets = new Map<string, { page: string; line: number; prelude: number }>()
  for (const block of blocks) {
    const name = `${block.page.replace(/\.md$/, '')}-${block.line}.${block.lang}`
    const prelude = block.mode === 'module' ? [] : [...PRELUDES[block.mode as 'daemon' | 'ui'], ...block.extra.split(';').map((l) => l.trim()).filter(Boolean)]
    // A fragment is a module of its own too, so its names don't meet another block's.
    const head = [...prelude, 'export {}']
    offsets.set(name, { page: block.page, line: block.line, prelude: head.length })
    await writeFile(join(dir, name), `${head.join('\n')}\n${block.code}\n`)
  }
  setUpProfileTypes(dir, types)
  const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
  const output = await new Promise<string>((resolve) => {
    let out = ''
    const child = spawn(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: dir })
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', () => resolve(out))
  })
  // Each error at the line of the page it's on.
  const errors = output.split('\n').filter((l) => /error TS/.test(l)).map((l) => {
    const at = /([a-z]+-\d+\.tsx?)\((\d+),(\d+)\): (.*)$/.exec(l)
    const block = at && offsets.get(at[1]!)
    return block ? `packages/cli/skill/${block.page}:${block.line + Number(at![2]) - block.prelude - 1}: ${at![4]}` : l
  })
  expect(errors).toEqual([])
}, 180_000)
