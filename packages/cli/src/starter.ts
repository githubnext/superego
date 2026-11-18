// `superego extension new <name>`: a ready-to-run extension in a profile, in the shape of the job. An agent tool (the
// default, `--tool`); a pane, UI half only (`--ui`); a mark in the sidebar from a fact (`--badge`); or a tool whose
// pane shows what it did (`--tool --ui`). Each is the smallest working one of its kind: its version and the extension
// API it needs, a test on superego/testing that passes as made, and a README. Its profile gets types as `superego
// profile types` gives them (extensions.ts), for `superego extension test` and an editor to check it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { EXTENSION_API, RpcError } from '@superego/protocol'

export type StarterKind = 'tool' | 'ui' | 'badge' | 'tool-ui'

/** The shape `extension new`'s flags ask for: a tool unless told otherwise. Throws for flags that don't go together. */
export function starterKind({ tool, ui, badge }: { tool?: boolean; ui?: boolean; badge?: boolean }): StarterKind {
  if (badge && (tool || ui)) throw new RpcError('usage', '--badge is a shape of its own (a daemon half and a UI half): leave out --tool and --ui')
  if (badge) return 'badge'
  if (tool && ui) return 'tool-ui'
  return ui ? 'ui' : 'tool'
}

/** What each shape is, in a few words: for `new` to say what it made. */
export const KIND_SAYS: Record<StarterKind, string> = {
  tool: 'an agent tool',
  ui: 'a pane, UI half only',
  badge: 'a sidebar mark: a daemon half and a UI half',
  'tool-ui': 'an agent tool and a pane of what it did',
}

/** The extension API a new extension asks for: this one's minor (`^4.0`). */
const apiRange = () => `^${EXTENSION_API.split('.').slice(0, 2).join('.')}`

const title = (name: string) => name.split('-').map((w, i) => i ? w : w[0]!.toUpperCase() + w.slice(1)).join(' ')
const snake = (name: string) => name.replace(/-/g, '_')
const fields = (name: string) => `name: '${name}', version: '0.1.0', api: '${apiRange()}', title: '${title(name)}'`
const PROFILE_DIR = `// The profile this extension is in: copied for each test, so editing it there doesn't touch yours.
const profile = new URL('..', import.meta.url).pathname`

// --tool: a tool, and a test that a scripted model calls it.

const toolDaemon = (name: string) => `// ${name}: a tool the agent calls, \`${snake(name)}_count\`. Change what it does in \`execute\`, and what the model
// reads of it in \`description\` and \`parameters\`. The daemon half (\`superego\`) has the threads, live values and actions.
import { defineDaemonExtension, defineExtension, defineTool, obj, str } from 'superego'

export default defineDaemonExtension({
  ${fields(name)},
  setup(superego) {
    superego.agent(defineExtension({
      name: '${name}',
      tools: [defineTool({
        name: '${snake(name)}_count', description: 'Count the words in a text.', parameters: obj({ text: str({ description: 'the text to count' }) }),
        async execute({ text }) {
          const words = text.split(/\\s+/).filter(Boolean).length
          // \`output\` is what the model reads; \`details\`, JSON for the window to draw the call with.
          return { output: [{ type: 'text', text: \`\${words} words\` }], details: { words } }
        },
      })],
    }))
  },
})
`

const toolTest = (name: string) => `// ${name}, tested as it runs: a scripted model calls the tool in a real daemon, and the call has its answer.
// Run with \`superego extension test ${name}\`.
import { afterEach, expect, it } from 'vitest'
import { callTool, say, testDaemon, type TestDaemon } from 'superego/testing'

${PROFILE_DIR}
let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close() })

it('counts the words it is given', async () => {
  daemon = await testDaemon({ profile, model: [callTool('${snake(name)}_count', { text: 'one two three' }), say('Three words.')] })
  const thread = await daemon.thread('How many words?')
  expect(await daemon.toolCalls(thread)).toMatchObject([
    { name: '${snake(name)}_count', args: { text: 'one two three' }, result: { isError: false, text: '3 words' } },
  ])
})
`

// --ui: a pane, UI half only. profile.ts describes it to the agent (`panes`), as there's no daemon half to.

const paneUi = (name: string) => `// ${name}: a pane, UI half only (no daemon half). The agent opens it with \`pane_open({ kind: '${name}' })\` (profile.ts
// describes it to the agent, under \`panes\`), and you from the thread's pane menu. It draws the thread it's beside.
import { defineUiExtension, ListIcon, PaneHeader, PaneNote, type PaneProps } from 'superego/ui'

function Pane({ thread }: PaneProps) {
  return (
    <div className="${name}">
      <PaneHeader><PaneNote>{thread.status.state}</PaneNote></PaneHeader>
      <h2>{thread.title}</h2>
      <p>Works in <code>{thread.cwd}</code>.</p>
    </div>
  )
}

export default defineUiExtension({
  ${fields(name)},
  setup(superego) {
    superego.pane('${name}', { title: '${title(name)}', icon: ListIcon, menu: true, component: Pane })
  },
})
`

const paneTest = (name: string) => `// ${name}, tested in a window of its own over a fake machine: the pane draws the thread it's beside.
// Run with \`superego extension test ${name}\`.
import { afterEach, expect, it } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from 'superego/testing'
import ui from './ui.tsx'

let shown: TestWindow | undefined
afterEach(async () => { await shown?.unmount() })

it('draws the thread it is beside', async () => {
  // A thread of this profile (the one under test), and its UI as that profile's: drawn only in its threads.
  const thread = testThread({ title: 'Fix the tests', cwd: '/work/app' })
  shown = await mountUi({ machines: [fakeMachine({ threads: [thread] })], profile: { extensions: [ui] } })
  const pane = await shown.render({ pane: { kind: '${name}' }, thread: thread.id })
  expect(pane.text()).toContain('Fix the tests')
  expect(pane.text()).toContain('/work/app')
})
`

// --badge: a fact the daemon half sets from the tool calls it hears, and a mark the UI half draws from it.

const badgeShared = (name: string) => `// What ${name} is, for both halves (spread into each), and the fact they share.
export const about = { ${fields(name)} }

/** What the daemon half says of a thread, as \`thread.facts['${name}']\`: the shell command that last failed there. */
export type Failed = { command: string }
`

const badgeDaemon = (name: string) => `// ${name}, daemon half: hears each shell command a thread's agent runs, keeps the last one that failed in the thread's
// state (a command that works clears it), and tells the window as the thread's facts.
import { defineDaemonExtension } from 'superego'
import { about, type Failed } from './shared.ts'

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const failed = superego.state<Failed>()
    // Clients see it as thread.facts['${name}'], worked out from the state whenever the thread's info is.
    superego.facts<Failed>(({ state }) => state)
    superego.toolCalls(async ({ thread, call, result }) => {
      if (call.name !== 'bash') return
      const command = String((call.args as { command?: unknown }).command ?? '')
      await failed.set(thread, result.isError ? { command: command.slice(0, 200) } : undefined)
    })
  },
})
`

const badgeUi = (name: string) => `// ${name}, UI half: a mark after the title of each thread whose last command failed, in the sidebar. It's there before
// the thread is opened: the window loads a profile's UI as soon as it lists one of its threads.
import { defineUiExtension, factsOf, ThreadBadge, WarningIcon, type SlotProps } from 'superego/ui'
import { about, type Failed } from './shared.ts'

function Mark({ thread }: SlotProps['thread.badge']) {
  const failed = factsOf<Failed>(thread, about)
  if (!failed) return null
  return <ThreadBadge label="a command failed" title={\`Failed: \${failed.command}\`}><WarningIcon size={12} aria-hidden /></ThreadBadge>
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.slot('thread.badge', Mark)
  },
})
`

const badgeTest = (name: string) => `// ${name}, tested as it runs: a scripted model runs a command that fails in one thread and one that works in another, in
// a real daemon, and a window over it marks only the first. Run with \`superego extension test ${name}\`.
import { afterEach, expect, it } from 'vitest'
import { callTool, daemonMachine, mountUi, say, testDaemon, type TestDaemon, type TestWindow } from 'superego/testing'
import ui from './ui.tsx'
import { about } from './shared.ts'

${PROFILE_DIR}
let daemon: TestDaemon | undefined
let shown: TestWindow | undefined
afterEach(async () => { await shown?.unmount(); await daemon?.close() })

it('marks the thread whose last command failed, and not the other', async () => {
  daemon = await testDaemon({
    profile,
    model: [callTool('bash', { command: 'exit 3' }), say('It failed.'), callTool('bash', { command: 'true' }), say('It worked.')],
  })
  const failing = await daemon.thread('Run the failing one')
  const working = await daemon.thread('Run the working one')
  // The fact, as clients are told it (toolCalls hears a call just after it ends: wait for it).
  await daemon.until(async () => about.name in await daemon!.facts(failing), 'the failed command')
  expect((await daemon.facts(failing))[about.name]).toEqual({ command: 'exit 3' })
  expect((await daemon.facts(working))[about.name]).toBeUndefined()

  // The mark, as the sidebar draws it.
  shown = await mountUi({ machines: [daemonMachine(daemon)], profile: { extensions: [ui] } })
  const marked = await shown.render({ slot: 'thread.badge', thread: failing.id })
  await shown.until(() => marked.find('[aria-label="a command failed"]') !== null, 'the mark')
  expect(marked.find('[aria-label="a command failed"]')?.getAttribute('title')).toBe('Failed: exit 3')
  expect((await shown.render({ slot: 'thread.badge', thread: working.id })).find('[aria-label="a command failed"]')).toBeNull()
})
`

// --tool --ui: a tool that adds to each thread's items, and a pane of them (described in `about.panes`).

const itemsShared = (name: string) => `// What ${name} is, for both halves (spread into each), and the names they share. \`panes\` describes the pane the UI half
// draws to the agent, so it can open it (\`pane_open\`).
export const about = {
  ${fields(name)},
  panes: { '${name}': "this thread's items, added with ${snake(name)}_add, each with a button to remove it; no params" },
}

/** Each thread's items: a scoped value, one scope per thread. */
export const ITEMS = '${name}.items'
export type Item = { id: string; text: string }
`

const itemsDaemon = (name: string) => `// ${name}, daemon half: a tool the agent adds items with, each thread's items as a live value of its own (a scoped
// value: a window showing a thread hears only that thread's), and an action to remove one.
import { defineAction, defineDaemonExtension, defineExtension, defineTool, obj, str } from 'superego'
import { about, ITEMS, type Item } from './shared.ts'

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const items = superego.scopedValue<Item[]>(ITEMS, [])

    superego.agent(defineExtension({
      name: '${name}',
      tools: [defineTool({
        name: '${snake(name)}_add', description: 'Add an item to this thread\\'s ${title(name).toLowerCase()} list.', parameters: obj({ text: str() }),
        async execute({ text }, api) {
          items.update(superego.threads.of(api.conversationId)!, (list) => [...list, { id: api.callId, text }])
          return { output: [{ type: 'text', text: \`Added: \${text}\` }] }
        },
      })],
    }))

    superego.action(defineAction({
      id: '${name}.remove', title: 'Remove an item', runs: 'machine', expose: ['ui', 'cli'], params: obj({ thread: str(), id: str() }),
      run({ thread, id }) { items.update(thread, (list) => list.filter((item) => item.id !== id)); return null },
    }))

    // A thread's items go with it.
    superego.thread({ archived(thread) { items.delete(thread.id) } })
  },
})
`

const itemsUi = (name: string) => `// ${name}, UI half: the pane of the thread's items, with a button to remove each. The agent opens it with
// \`pane_open({ kind: '${name}' })\`; you, from the thread's pane menu.
import { defineUiExtension, has, ListIcon, PaneMessage, useDispatch, useValue, type PaneProps } from 'superego/ui'
import { about, ITEMS, type Item } from './shared.ts'

function Items({ machine, thread }: PaneProps) {
  const items = useValue<Item[]>(machine, ITEMS, { scope: thread.id })
  const dispatch = useDispatch()
  // The daemon half may not be there: on another machine, an older version of this profile.
  if (!has(machine, 'ext:${name}')) return <PaneMessage>${title(name)} isn't set up on {machine.label}.</PaneMessage>
  if (machine.state !== 'connected') return <PaneMessage>{machine.label} is offline.</PaneMessage>
  if (!items?.length) return <PaneMessage>Nothing yet.</PaneMessage>
  const remove = (id: string) => void dispatch('${name}.remove', { thread: thread.id, id }, { machine: machine.id }).catch((error: Error) => console.error(error))
  return (
    <ul className="${name}">
      {items.map((item) => <li key={item.id}>{item.text} <button type="button" onClick={() => remove(item.id)}>Remove</button></li>)}
    </ul>
  )
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.pane('${name}', { title: '${title(name)}', icon: ListIcon, menu: true, component: Items })
  },
})
`

const itemsTest = (name: string) => `// ${name}, tested as it runs: the agent adds an item with the tool, the thread sees only its own items, and the pane
// draws them. Run with \`superego extension test ${name}\`.
import { afterEach, expect, it } from 'vitest'
import { callTool, daemonMachine, mountUi, say, testDaemon, type TestDaemon, type TestWindow } from 'superego/testing'
import ui from './ui.tsx'
import { ITEMS, type Item } from './shared.ts'

${PROFILE_DIR}
let daemon: TestDaemon | undefined
let shown: TestWindow | undefined
afterEach(async () => { await shown?.unmount(); await daemon?.close() })

it('adds an item to the thread that asked, and to no other', async () => {
  daemon = await testDaemon({ profile, model: [callTool('${snake(name)}_add', { text: 'first' }), say('Added it.')] })
  const thread = await daemon.thread('Add one')
  const other = await daemon.thread()
  expect(await daemon.toolCalls(thread)).toMatchObject([{ name: '${snake(name)}_add', result: { isError: false, text: 'Added: first' } }])
  expect((await daemon.watch<Item[]>(ITEMS, { scope: thread.id })).value.map((item) => item.text)).toEqual(['first'])
  expect((await daemon.watch<Item[]>(ITEMS, { scope: other.id })).value).toEqual([])
})

it('draws the thread\\'s items in its pane, and removes one', async () => {
  daemon = await testDaemon({ profile, model: [callTool('${snake(name)}_add', { text: 'first' }), say('Added it.')] })
  const thread = await daemon.thread('Add one')
  shown = await mountUi({ machines: [daemonMachine(daemon)], profile: { extensions: [ui] } })
  const pane = await shown.render({ pane: { kind: '${name}' }, thread: thread.id })
  await shown.until(() => pane.text().includes('first'), 'the item')
  await pane.click('Remove')
  await shown.until(() => !pane.text().includes('first'), 'the item to go')
})
`

const RUN = (name: string, ui: boolean) => `Send one of this profile's threads a message: it loads with the turn${ui ? ', and the window loads the UI as it lists the\nthread' : ''}. After an edit, the next turn loads it again (or \`superego extension reload\`). A thread started before
the profile was made doesn't have it: start a new one. The guide: \`superego --skill guide\`.
`

const readme = (name: string, kind: StarterKind) => {
  const test = `- \`${name}.test.ts${kind === 'tool' ? '' : 'x'}\`: run it with \`superego extension test ${name}\`, which checks the types too.\n`
  const shared = `- \`shared.ts\`: what it is (its \`version\` and the extension \`api\` it needs), spread into both halves, and what they share.\n`
  if (kind === 'tool') return `# ${title(name)}

An agent tool in this profile.

- \`daemon.ts\`: the tool \`${snake(name)}_count\`, given to the profile's agents (\`superego.agent\`), with its \`version\` and the
  extension \`api\` it needs.
${test}
${RUN(name, false)}`
  if (kind === 'ui') return `# ${title(name)}

A pane in this profile, UI half only.

- \`ui.tsx\`: the pane \`${name}\`, in the thread's pane menu, with its \`version\` and the extension \`api\` it needs.
  \`profile.ts\` describes it to the agent (\`panes\`), so it can open it with \`pane_open\`.
${test}
${RUN(name, true)}`
  if (kind === 'badge') return `# ${title(name)}

A mark in the sidebar, after the title of each thread whose last shell command failed.

- \`daemon.ts\`: hears each tool call (\`superego.toolCalls\`), keeps the last failed command in the thread's \`state\`,
  and tells clients as \`thread.facts['${name}']\` (\`superego.facts\`).
- \`ui.tsx\`: the \`thread.badge\` slot, drawing a \`<ThreadBadge>\` from \`factsOf(thread, about)\`.
${shared}${test}
${RUN(name, true)}`
  return `# ${title(name)}

An agent tool in this profile, and a pane of what it did.

- \`daemon.ts\`: the tool \`${snake(name)}_add\`, each thread's items (\`${name}.items\`, a scoped value), and the action
  \`${name}.remove\`.
- \`ui.tsx\`: the pane \`${name}\`, of the thread's items, in its pane menu; \`about.panes\` describes it to the agent.
${shared}${test}
${RUN(name, true)}`
}

const PROFILE = (name: string) => `import { defineProfile } from 'superego'

export default defineProfile({
  description: '${name}',
})
`

/** The files of a new extension `name` in a profile, by path from the profile's folder. */
function starterFiles(name: string, kind: StarterKind): Record<string, string> {
  const files: Record<StarterKind, Record<string, string>> = {
    tool: { 'daemon.ts': toolDaemon(name), [`${name}.test.ts`]: toolTest(name) },
    ui: { 'ui.tsx': paneUi(name), [`${name}.test.tsx`]: paneTest(name) },
    badge: { 'shared.ts': badgeShared(name), 'daemon.ts': badgeDaemon(name), 'ui.tsx': badgeUi(name), [`${name}.test.tsx`]: badgeTest(name) },
    'tool-ui': { 'shared.ts': itemsShared(name), 'daemon.ts': itemsDaemon(name), 'ui.tsx': itemsUi(name), [`${name}.test.tsx`]: itemsTest(name) },
  }
  return Object.fromEntries(Object.entries({ ...files[kind], 'README.md': readme(name, kind) }).map(([path, content]) => [`${name}/${path}`, content]))
}

/** Where `defineProfile({` opens, to add a field after: undefined when it isn't written so. */
const fieldsStart = (source: string) => {
  const open = /defineProfile\(\s*\{/.exec(source)
  return open ? open.index + open[0].length : undefined
}

/**
 * Add `entry` to the profile's `extensions` (or `ui`) list in profile.ts as written: into the list if there is one,
 * else as a new field. Undefined when it can't tell where (say what to add instead).
 */
export function addToProfile(source: string, field: 'extensions' | 'ui', entry: string): string | undefined {
  const quoted = `'${entry}'`
  if (source.includes(quoted) || source.includes(`"${entry}"`)) return source
  const list = new RegExp(`(^|[\\s,{])${field}\\s*:\\s*\\[`, 'm').exec(source)
  if (list) {
    const at = list.index + list[0].length
    const close = source.indexOf(']', at)
    if (close < 0) return undefined
    const inside = source.slice(at, close).trim()
    return `${source.slice(0, close).replace(/\s*$/, '')}${inside ? (inside.endsWith(',') ? ' ' : ', ') : ''}${quoted}${source.slice(close)}`
  }
  const at = fieldsStart(source)
  if (at === undefined) return undefined
  return `${source.slice(0, at)}\n  ${field}: [${quoted}],${source.slice(at)}`
}

/**
 * Describe a pane kind in the profile's `panes` in profile.ts as written: into the object if there is one, else as a
 * new field. Undefined when it can't tell where.
 */
export function addPaneToProfile(source: string, kind: string, about: string): string | undefined {
  const entry = `'${kind}': ${JSON.stringify(about)}`
  const panes = /(^|[\s,{])panes\s*:\s*\{/m.exec(source)
  if (panes) {
    const at = panes.index + panes[0].length
    const rest = source.slice(at)
    if (new RegExp(`^[^}]*['"]?\\b${kind}\\b['"]?\\s*:`).test(rest)) return source
    return /^\s*\}/.test(rest) ? `${source.slice(0, at)} ${entry} ${rest.trimStart()}` : `${source.slice(0, at)} ${entry},${rest}`
  }
  const at = fieldsStart(source)
  if (at === undefined) return undefined
  return `${source.slice(0, at)}\n  panes: { ${entry} },${source.slice(at)}`
}

/** What the profile's `panes` says of a `--ui` pane, to the agent. */
const PANE_ABOUT = "the thread's title, status and folder; no params"

/** Write a new extension into the profile at `profileDir` (making the profile if there's none): what was written. */
export function writeStarter(profileDir: string, name: string, kind: StarterKind) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('An extension name is lowercase letters, digits and dashes, starting with a letter')
  if (existsSync(join(profileDir, name))) throw new Error(`${join(profileDir, name)} is there already`)
  const written: string[] = []
  const write = (path: string, content: string) => {
    const file = join(profileDir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    written.push(file)
  }
  const profileFile = join(profileDir, 'profile.ts')
  const made = !existsSync(profileFile)
  if (made) write('profile.ts', PROFILE(relative(join(profileDir, '..'), profileDir)))
  const files = starterFiles(name, kind)
  for (const [path, content] of Object.entries(files)) write(path, content)
  // The profile loads it: the daemon half, the UI half, and (with no daemon half to) describes its pane to the agent.
  let source = readFileSync(profileFile, 'utf8')
  const missing: string[] = []
  const add = (next: string | undefined, instead: string) => {
    if (next === undefined) missing.push(instead)
    else source = next
  }
  for (const [field, file] of [['extensions', 'daemon.ts'], ['ui', 'ui.tsx']] as const) {
    const entry = `./${name}/${file}`
    if (files[`${name}/${file}`]) add(addToProfile(source, field, entry), `${field}: ['${entry}']`)
  }
  if (kind === 'ui') add(addPaneToProfile(source, name, PANE_ABOUT), `panes: { '${name}': ${JSON.stringify(PANE_ABOUT)} }`)
  writeFileSync(profileFile, source)
  return { written, madeProfile: made, missing }
}
