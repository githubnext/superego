// Types for a profile's author, as they'd have them outside this repo: `superego profile new` writes a tsconfig.json and
// links node_modules to the author types in its data dir, and nothing else is there. A profile and a UI module using the
// real SDK and UI check; a mistake in either doesn't.
import { execFile, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { setUpProfileTypes } from '@superego/client/author-types'
import { builtTypes } from '@superego/sdk/types'

const CLI = fileURLToPath(new URL('../../../app/bin/superego.ts', import.meta.url))
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
let home: string

function superego(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, SUPEREGO_HOME: home, SUPEREGO_APP: home }, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolve(stdout)
    })
  })
}

/** `tsc --noEmit` in the profile, as an editor checks it: its output, and whether it passed. */
function check(dir: string) {
  const run = spawnSync(process.execPath, [TSC, '--noEmit', '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: dir, encoding: 'utf8' })
  return { ok: run.status === 0, output: run.stdout + run.stderr }
}

beforeAll(async () => {
  home = realpathSync(await mkdtemp(join(tmpdir(), 'superego-profile-types-')))
  await builtTypes()
}, 240_000)
// With the author types `profile new` copied in (the one test file that has its own: author-types.ts): some 2,000 files,
// that take seconds to remove on a busy machine.
afterAll(async () => { await rm(home, { recursive: true, force: true }) }, 120_000)

it("gives a new profile types: 'superego', 'superego/ui', React and JSX check, and mistakes don't", async () => {
  const made = JSON.parse(await superego(['profile', 'new', 'desk', '--user', '--json'])) as { dir: string; written: string[] }
  const dir = made.dir
  expect(dir).toBe(join(home, 'profiles', 'desk'))
  expect(readlinkSync(join(dir, 'node_modules'))).toBe(join(home, 'types', 'node_modules'))
  expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n')
  // Nothing of this computer in what a project would commit.
  expect(readFileSync(join(dir, 'tsconfig.json'), 'utf8')).not.toContain(home)
  expect(check(dir)).toMatchObject({ ok: true })

  await writeFile(join(dir, 'profile.ts'), `import { defineProfile } from 'superego'
export default defineProfile({ description: 'A desk', thinking: 'low', extensions: ['./desk.ts'], ui: ['./board.tsx'], panes: { board: 'the board' } })
`)
  await writeFile(join(dir, 'desk.ts'), `import { readFile } from 'node:fs/promises'
import { defineAction, defineDaemonExtension, defineExtension, defineTool, obj, str, type Block } from 'superego'

export default defineDaemonExtension({
  name: 'desk', version: '0.1.0', api: '^3.0',
  setup(superego) {
    const notes = superego.scopedValue<string[]>('desk.notes', [])
    superego.agent(defineExtension({
      name: 'desk',
      tools: [defineTool({
        name: 'desk_add', description: 'Add a note.', parameters: obj({ text: str() }),
        async execute({ text }, api) {
          const thread = superego.threads.of(api.conversationId)!
          notes.update(thread, (list) => [...list, text.toUpperCase()])
          return { output: [{ type: 'text', text: await readFile('/dev/null', 'utf8') }] }
        },
      })],
    }))
    superego.action(defineAction({ id: 'desk.clear', title: 'Clear', runs: 'machine', expose: ['ui', 'cli'], params: obj({ thread: str() }), run: ({ thread }) => { notes.delete(thread); return null } }))
    const view: Block[] = [{ type: 'list', items: [{ title: 'A note', buttons: [{ id: 'clear', label: 'Clear', action: 'desk.clear' }] }] }]
    void view
  },
})
`)
  await writeFile(join(dir, 'board.tsx'), `import { useState } from 'react'
import { defineUiExtension, PaneHeader, useDispatch, useValue, XIcon, type PaneProps } from 'superego/ui'

function Board({ machine, thread }: PaneProps) {
  const notes = useValue<string[]>(machine, 'desk.notes', { scope: thread.id })
  const dispatch = useDispatch()
  const [open, setOpen] = useState(true)
  return (
    <div>
      <PaneHeader><button type="button" onClick={() => void dispatch('desk.clear', { thread: thread.id })}><XIcon size={12} /></button></PaneHeader>
      {open && notes?.map((note) => <p key={note} onClick={() => setOpen(false)}>{note}</p>)}
    </div>
  )
}

export default defineUiExtension({ name: 'desk', version: '0.1.0', api: '^3.0', setup: (superego) => superego.pane('board', { title: 'Board', component: Board }) })
`)
  expect(check(dir)).toEqual({ ok: true, output: '' })

  // Mistakes: a setting that isn't one, a hook's argument of the wrong type, and an element's unknown prop.
  await writeFile(join(dir, 'wrong.tsx'), `import { defineProfile } from 'superego'
import { useValue, type PaneProps } from 'superego/ui'
export const spec = defineProfile({ description: 7 })
export function Wrong({ machine }: PaneProps) {
  const value = useValue<number>(machine, 42)
  return <div colour="red">{value}</div>
}
`)
  const wrong = check(dir)
  expect(wrong.ok).toBe(false)
  expect(wrong.output).toMatch(/wrong\.tsx\(3,\d+\): error TS2322: Type 'number' is not assignable to type 'string'/)
  expect(wrong.output).toMatch(/wrong\.tsx\(5,\d+\): error TS/)
  expect(wrong.output).toMatch(/wrong\.tsx\(6,\d+\): error TS2322: .*colour/)
}, 240_000)

it("sets up a profile made before, and leaves what's an author's own", () => {
  // As `profile types` does for each one that's there (cli.test.ts runs it through the daemon).
  const dir = join(home, 'profiles', 'older')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.gitignore'), 'dist')
  writeFileSync(join(dir, 'profile.ts'), `import { defineProfile } from 'superego'\nexport default defineProfile({ prompt: 'Hi' })\n`)
  const types = join(home, 'types')
  const first = setUpProfileTypes(dir, types)
  expect(first.written.map((file) => file.slice(dir.length + 1)).sort()).toEqual(['.gitignore', 'node_modules', 'tsconfig.json'])
  expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('dist\nnode_modules\n')
  expect(check(dir)).toMatchObject({ ok: true })
  // Again: nothing to do. An author's own tsconfig stays.
  expect(setUpProfileTypes(dir, types)).toEqual({ written: [], notes: [] })
  writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": false } }')
  expect(setUpProfileTypes(dir, types).notes).toEqual([expect.stringContaining('left as it is')])
  expect(lstatSync(join(dir, 'node_modules')).isSymbolicLink()).toBe(true)
})
