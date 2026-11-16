// `superego extension new <name>`: a ready-to-run extension in a profile. Data-only by default (a daemon half whose
// view the window draws from data); `--ui` adds a UI half that draws it with code of its own. Each comes with its
// version and the extension API it needs, a test on superego/testing, and a README. Its profile gets types as
// `superego profile types` gives them (extensions.ts), for `superego extension test` and an editor to check it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { EXTENSION_API } from '@superego/protocol'

export type StarterKind = 'data-only' | 'ui'

/** The extension API a new extension asks for: this one's minor (`^2.0`). */
const apiRange = () => `^${EXTENSION_API.split('.').slice(0, 2).join('.')}`

const words = (name: string) => name.split('-')
const title = (name: string) => words(name).map((w, i) => i ? w : w[0]!.toUpperCase() + w.slice(1)).join(' ')
const tool = (name: string) => `${name.replace(/-/g, '_')}_add`

const shared = (name: string) => `// What ${name} is, for both halves (spread into each), and the names they share.
export const about = { name: '${name}', version: '0.1.0', api: '${apiRange()}', title: '${title(name)}' }

/** Each thread's items: a scoped value, one scope per thread. */
export const ITEMS = '${name}.items'
export type Item = { id: string; text: string }
`

const daemon = (name: string, kind: StarterKind) => `// ${name}, daemon half: a tool the agent adds items with, each thread's items as a live value of its own (a scoped
// value: a window showing a thread hears only that thread's), an action to clear them${kind === 'data-only' ? ', and a view of them the window\n// draws from data: no UI code' : ''}.
import { defineAction, defineDaemonExtension, defineExtension, defineTool, obj, str${kind === 'data-only' ? ', type ViewContent' : ''} } from 'superego'
import { about, ITEMS, type Item } from './shared.ts'

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const items = superego.scopedValue<Item[]>(ITEMS, [])
${kind === 'data-only' ? `    // What the view shows: the thread's items, each with a button to take it out.
    const view = superego.scopedValue<ViewContent>('${name}.view', { empty: 'Nothing yet.' })
    const show = (thread: string) => {
      const list = items.get(thread)
      view.set(thread, {
        empty: 'Nothing yet.',
        items: list.map((item) => ({ id: item.id, title: item.text, actions: [{ title: 'Remove', action: '${name}.remove', params: { thread, id: item.id } }] })),
        ...(list.length ? { actions: [{ title: 'Clear', action: '${name}.clear', params: { thread } }] } : {}),
      })
    }
` : `    const show = (_thread: string) => {}
`}
    superego.agent(defineExtension({
      name: '${name}',
      tools: [defineTool({
        name: '${tool(name)}', description: 'Add an item to this thread\\'s ${title(name).toLowerCase()} list.', parameters: obj({ text: str() }),
        async execute({ text }, api) {
          const thread = superego.threads.of(api.conversationId)!
          items.update(thread, (list) => [...list, { id: api.callId, text }])
          show(thread)
          return { output: [{ type: 'text', text: \`Added: \${text}\` }] }
        },
      })],
    }))

    superego.action(defineAction({
      id: '${name}.remove', title: 'Remove an item', runs: 'machine', expose: ['ui', 'cli'], params: obj({ thread: str(), id: str() }),
      run({ thread, id }) { items.update(thread, (list) => list.filter((item) => item.id !== id)); show(thread); return null },
    }))
    superego.action(defineAction({
      id: '${name}.clear', title: 'Clear the items', runs: 'machine', expose: ['ui', 'cli'], params: obj({ thread: str() }),
      run({ thread }) { items.delete(thread); show(thread); return null },
    }))
${kind === 'data-only' ? `
    superego.view('${name}.view', { title: '${title(name)}', icon: 'list', context: 'thread', fits: ['beside', 'pane'], default: 'beside', value: '${name}.view' })
` : ''}    // A thread's items go with it.
    superego.thread({ archived(thread) { items.delete(thread.id); show(thread.id) } })
  },
})
`

const ui = (name: string) => `// ${name}, UI half: the thread's items beside it, with a button to remove each, and a shortcut to show or hide them.
import { defineAction, defineUiExtension, has, PaneMessage, useDispatch, useValue, type ViewProps } from 'superego/ui'
import { about, ITEMS, type Item } from './shared.ts'

const VIEW = '${name}.list'

function Items({ machine, thread }: ViewProps<'thread'>) {
  const items = useValue<Item[]>(machine, ITEMS, { scope: thread.id })
  const dispatch = useDispatch()
  // The daemon half may not be there: on another machine, an older version of this profile.
  if (!has(machine, 'ext:${name}')) return <PaneMessage>${title(name)} isn't set up on {machine.label}.</PaneMessage>
  if (machine.state !== 'connected') return <PaneMessage>{machine.label} is offline.</PaneMessage>
  const run = (id: string, params: Record<string, unknown>) => void dispatch(id, params, { machine: machine.id }).catch((error: Error) => console.error(error))
  return (
    <div className="${name}">
      {items?.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>{item.text} <button type="button" onClick={() => run('${name}.remove', { thread: thread.id, id: item.id })}>Remove</button></li>
          ))}
        </ul>
      ) : <PaneMessage>Nothing yet.</PaneMessage>}
    </div>
  )
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.view(VIEW, { title: '${title(name)}', context: 'thread', fits: ['beside', 'pane'], default: 'beside', component: Items })
    // Shown or hidden beside the thread, in this profile's threads.
    superego.action(defineAction({
      id: '${name}.toggle', title: 'Show or hide ${title(name).toLowerCase()}', keys: 'mod+shift+y',
      run: (_params, context) => context.dispatch('layout.place', { view: VIEW, place: 'beside' }),
    }))
  },
})

`

const test = (name: string, kind: StarterKind) => `// ${name}, tested as it runs: the agent adds an item with the tool, the thread sees only its own items${kind === 'ui' ? ', and the\n// window draws them beside the thread' : ''}. Run with \`superego extension test ${name}\`.
import { afterEach, expect, it } from 'vitest'
import { callTool, ${kind === 'ui' ? 'daemonMachine, mountUi, ' : ''}say, testDaemon, type TestDaemon } from 'superego/testing'
${kind === 'ui' ? `import ui from './ui.tsx'
` : ''}import { ITEMS, type Item } from './shared.ts'

// The profile this extension is in: copied for each test, so editing it there doesn't touch yours.
const profile = new URL('..', import.meta.url).pathname
let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close() })

it('adds an item to the thread that asked, and to no other', async () => {
  daemon = await testDaemon({ profile, model: [callTool('${tool(name)}', { text: 'first' }), say('Added it.')] })
  const thread = await daemon.thread('Add one')
  const other = await daemon.thread()
  expect(await daemon.transcript(thread.id)).toContain('Added it.')
  expect((await daemon.watch<Item[]>(ITEMS, { scope: thread.id })).value.map((item) => item.text)).toEqual(['first'])
  expect((await daemon.watch<Item[]>(ITEMS, { scope: other.id })).value).toEqual([])
  await daemon.dispatch('${name}.clear', { thread: thread.id })
  expect((await daemon.watch<Item[]>(ITEMS, { scope: thread.id })).value).toEqual([])
})
${kind === 'ui' ? `
it('draws the thread\\'s items beside it, and removes one', async () => {
  daemon = await testDaemon({ profile, model: [callTool('${tool(name)}', { text: 'first' }), say('Added it.')] })
  const thread = await daemon.thread('Add one')
  const window = await mountUi({ machines: [daemonMachine(daemon)], profile: { ref: thread.profile!, extensions: [ui] } })
  try {
    const beside = await window.render({ place: 'beside', thread: thread.id })
    expect(beside.text()).toContain('first')
    await beside.click('Remove')
    await window.until(() => !beside.text().includes('first'), 'the item to go')
  } finally {
    await window.unmount()
  }
})
` : `
it('shows the items in a view the window draws from data', async () => {
  daemon = await testDaemon({ profile, model: [callTool('${tool(name)}', { text: 'first' }), say('Added it.')] })
  const thread = await daemon.thread('Add one')
  const view = await daemon.watch<{ items?: { title: string }[] }>('${name}.view', { scope: thread.id })
  expect(view.value.items?.map((item) => item.title)).toEqual(['first'])
})
`}`

const readme = (name: string, kind: StarterKind) => `# ${title(name)}

An extension of this profile${kind === 'ui' ? ', with a daemon half and a UI half' : ': a daemon half whose view the window draws from data'}.

- \`daemon.ts\`: the tool \`${tool(name)}\`, each thread's items (\`${name}.items\`, a scoped value), and the actions \`${name}.remove\` and \`${name}.clear\`.
${kind === 'ui' ? `- \`ui.tsx\`: the items beside the thread (\`${name}.list\`), and ⌘⇧Y to show or hide them.\n` : `- \`${name}.view\`: the items beside the thread, drawn by the window from data.\n`}- \`shared.ts\`: what it is (its \`version\` and the extension \`api\` it needs) and the names both halves use.
- \`${name}.test.ts\`: run it with \`superego extension test ${name}\`, which checks the types too.

Send one of this profile's threads a message: it loads with the turn${kind === 'ui' ? ', and the window loads the UI as it shows the\nthread' : ''}. After an edit, the next turn loads it again (or \`superego extension reload\`). A thread started before
the profile was made doesn't have it: start a new one. The guide: \`superego --skill guide\`.
`

const PROFILE = (name: string) => `import { defineProfile } from 'superego'

export default defineProfile({
  description: '${name}',
})
`

/** The files of a new extension `name` in a profile, by path from the profile's folder. */
export function starterFiles(name: string, kind: StarterKind): Record<string, string> {
  return {
    [`${name}/shared.ts`]: shared(name),
    [`${name}/daemon.ts`]: daemon(name, kind),
    ...(kind === 'ui' ? { [`${name}/ui.tsx`]: ui(name) } : {}),
    [`${name}/${name}.test.ts`]: test(name, kind),
    [`${name}/README.md`]: readme(name, kind),
  }
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
  const open = /defineProfile\(\s*\{/.exec(source)
  if (!open) return undefined
  const at = open.index + open[0].length
  return `${source.slice(0, at)}\n  ${field}: [${quoted}],${source.slice(at)}`
}

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
  for (const [path, content] of Object.entries(starterFiles(name, kind))) write(path, content)
  // The profile loads it: the daemon half, and the UI half.
  let source = readFileSync(profileFile, 'utf8')
  const missing: string[] = []
  const entries: ['extensions' | 'ui', string][] = [['extensions', `./${name}/daemon.ts`], ...(kind === 'ui' ? [['ui', `./${name}/ui.tsx`] as ['ui', string]] : [])]
  for (const [field, entry] of entries) {
    const next = addToProfile(source, field, entry)
    if (next === undefined) missing.push(`${field}: ['${entry}']`)
    else source = next
  }
  writeFileSync(profileFile, source)
  return { written, madeProfile: made, missing }
}
