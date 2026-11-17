// The skill's code, compiled: every ```ts and ```tsx block in its pages (skill/*.md) is type-checked against the stable
// surface ('superego', 'superego/ui', 'superego/testing'), as an author's profile is: against the author types, with
// the tsconfig `superego profile types` writes. A block that's a fragment of a setup says so in a comment just before
// it, `<!-- check: daemon -->` or `<!-- check: ui -->` (`superego` is then that half's API and the stable names are
// imported), or `<!-- check: skip -->` where it's deliberately partial. Anything after a `;` is added, in any mode:
// declarations of what the block takes as given (`<!-- check: module; declare const findOrder: … -->`). So the pages
// can't drift from the API.
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { setUpProfileTypes } from '@superego/client/author-types'
import { paramsParser } from '@superego/protocol'
import { parseDo } from '../src/cli.ts'
import { sharedAuthorTypes } from './author-types.ts'

const SKILL = fileURLToPath(new URL('../skill/', import.meta.url))

/** What a fragment of each half is given: its half's API as `superego`, and the stable names it might use. */
const PRELUDES = {
  daemon: [
    `import { arr, bool, defineAction, defineDaemonExtension, defineExtension, defineTool, hook, int, lit, nullable, num, obj, opt, RpcError, section, spawnGroup, str, union, unknown } from 'superego'`,
    `import type { Block, DaemonApi, ExtensionAbout, Json, SpawnedGroup, ThreadInfo } from 'superego'`,
    `declare const superego: DaemonApi`,
    `type Build = { id: string; command: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; at: number }`,
  ],
  ui: [
    `import { call, defineAction, defineUiExtension, has, Markdown, PaneMessage, parseWikilink, useDispatch, useMethod, usePlacement, useSelection, useValue, version } from 'superego/ui'`,
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

/** Each page's blocks, with the page they're from: every page of the skill. */
const pageBlocks = async () => (await Promise.all((await readdir(SKILL)).filter((f) => f.endsWith('.md')).map(async (page) => blocksOf(await readFile(join(SKILL, page), 'utf8')).map((block) => ({ ...block, page }))))).flat()

it("finds the pages' blocks, each checked or skipped on purpose", async () => {
  const blocks = await pageBlocks()
  expect(blocks.filter((b) => b.page === 'guide.md').length).toBeGreaterThan(5)
  for (const block of blocks) expect(['module', 'daemon', 'ui', 'skip'], `the check at ${block.page}:${block.line}`).toContain(block.mode)
})

it("type-checks every TypeScript block in the skill against the stable surface", async () => {
  const blocks = (await pageBlocks()).filter((b) => b.mode !== 'skip')
  const offsets = new Map<string, { page: string; line: number; prelude: number }>()
  for (const block of blocks) {
    const name = `${block.page.replace(/\.md$/, '')}-${block.line}.${block.lang}`
    const given = block.extra.split(';').map((l) => l.trim()).filter(Boolean)
    const prelude = [...(block.mode === 'module' ? [] : PRELUDES[block.mode as 'daemon' | 'ui']), ...given]
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

/** The words of a command line as a shell splits them: quotes kept together and taken off. */
function words(line: string): string[] {
  return [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!)
}

/** Every `superego do <action> …` in the skill's pages (across a line break too), up to the end of its code. */
export function doCommands(markdown: string): { line: number; argv: string[] }[] {
  return [...markdown.matchAll(/superego\s+do\s+([a-z][\w-]*\.[\w.-]+)([^`\n#]*)/g)].map((m) => ({
    line: markdown.slice(0, m.index).split('\n').length,
    argv: [m[1]!, ...words(m[2]!).filter((w) => w !== '…' && w !== '...')],
  }))
}

it("gives the core's actions params they take", async () => {
  // The params of the core's released actions, as the daemon takes them.
  const actions = JSON.parse(await readFile(new URL('../../protocol/src/released-actions.json', import.meta.url), 'utf8')) as Record<string, Parameters<typeof paramsParser>[1] | null>
  const core = new Set(Object.keys(actions).map((id) => id.split('.')[0]))
  const pages = (await readdir(SKILL)).filter((f) => f.endsWith('.md'))
  const checked: string[] = []
  const wrong: string[] = []
  for (const page of pages) {
    for (const { line, argv } of doCommands(await readFile(join(SKILL, page), 'utf8'))) {
      const { id, params } = parseDo(argv)
      const at = `packages/cli/skill/${page}:${line}: ${id}`
      if (!(id! in actions)) {
        // Another extension's action is its own; a core one the generation didn't release is a typo.
        if (core.has(id!.split('.')[0])) wrong.push(`${at}: no such action`)
        continue
      }
      checked.push(at)
      try { paramsParser(id!, actions[id!] ?? undefined)(params) } catch (e) { wrong.push(`${at}: ${(e as Error).message}`) }
    }
  }
  expect(checked.length).toBeGreaterThan(3)
  expect(wrong).toEqual([])
})

it("names the core's actions' params in cli.md's table as they are", async () => {
  const actions = JSON.parse(await readFile(new URL('../../protocol/src/released-actions.json', import.meta.url), 'utf8')) as Record<string, { properties?: Record<string, unknown>; required?: string[] } | null>
  const rows = (await readFile(join(SKILL, 'cli.md'), 'utf8')).split('\n').filter((l) => l.startsWith('| `'))
  const wrong: string[] = []
  let checked = 0
  for (const row of rows) {
    // Each `id` `param param? param?=a\|b` pair in the row's first cell.
    for (const [, id, names] of row.split(' | ')[0]!.matchAll(/`([a-z][\w-]*\.[\w.-]+)` `([^`]*)`/g)) {
      const schema = actions[id!]
      if (schema === undefined) continue
      checked++
      const given = names!.split(/\s+/).filter(Boolean).map((n) => ({ name: n.replace(/[?=].*$/, ''), optional: /\?/.test(n) }))
      for (const { name, optional } of given) {
        if (!(name in (schema?.properties ?? {}))) wrong.push(`${id}: no param ${name}`)
        else if (!optional !== (schema?.required ?? []).includes(name)) wrong.push(`${id}: ${name} is ${optional ? 'required' : 'optional'}`)
      }
      for (const name of schema?.required ?? []) if (!given.some((g) => g.name === name)) wrong.push(`${id}: ${name} missing`)
    }
  }
  expect(checked).toBeGreaterThan(5)
  expect(wrong).toEqual([])
})

it('reads a `superego do` line as the command line would', () => {
  expect(doCommands("x `superego do pane.open --params '{\"thread\":\"t\",\"kind\":\"editor\"}'` y")).toEqual([
    { line: 1, argv: ['pane.open', '--params', '{"thread":"t","kind":"editor"}'] },
  ])
  expect(doCommands('`superego do\nthread.stop --thread <thread> …`')[0]!.argv).toEqual(['thread.stop', '--thread', '<thread>'])
})
