// @vitest-environment happy-dom
// A new file or folder from a folder pane: named in place (the header's buttons, a folder's menu, ⌥⌘N), made on the
// thread's machine by `file.create`, never over what's there, and the file opened in the editor.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, type ThreadInfo } from '@superego/protocol'
import { fakeMachine, mountUi, testDaemon, testThread, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import files from '../src/ui.tsx'
import filesDaemon from '../src/daemon.ts'
import { ENTRIES, FOLDER, type FolderEntries } from '../src/shared.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const field = () => $('.files-name__field') as HTMLInputElement | null
const problem = () => $('.files-name__problem')?.textContent
const rightClick = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }))
const menuItem = (text: string) => $$('.superego-menu .superego-menu__item').find((i) => i.textContent === text)
const row = (text: string) => $$('.files-tree__row').find((r) => r.textContent === text)
// A Mac's keys: ⌥⌘N.
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

let ui: TestWindow | undefined
let daemon: TestDaemon | undefined
afterEach(async () => { await ui?.unmount(); ui = undefined; await daemon?.close(); daemon = undefined })

describe('on this machine', () => {
  let repo: string
  let thread: ThreadInfo
  beforeEach(async () => {
    daemon = await testDaemon({ extensions: [filesDaemon] })
    repo = join(daemon.dataDir, 'repo')
    await mkdir(join(repo, 'docs'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'hello\n')
    thread = await daemon.thread(undefined, { cwd: repo })
    ui = await mountUi({ extensions: [files], machines: [daemon] })
  })
  const name = async (typed: string) => { await ui!.type('.files-name__field', typed); await ui!.key('enter') }

  it('makes a file in place and opens it in the editor; a name with slashes makes its folders too', async () => {
    const pane = await ui!.render({ thread: thread.id, pane: { kind: FOLDER, params: { path: '' } } })
    await ui!.until(() => Boolean(row('README.md')), 'listed')
    await pane.click('New file')
    await ui!.until(() => document.activeElement === field(), 'the name field, focused')
    await name('notes.md')
    await ui!.until(() => !field() && Boolean(row('notes.md')), 'made and listed')
    expect(await readFile(join(repo, 'notes.md'), 'utf8')).toBe('')
    const panes = async () => (await daemon!.peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)?.panes ?? []
    await ui!.until(async () => (await panes()).some((p) => p.kind === 'editor' && (p.params as { path?: string }).path === 'notes.md'), 'open in an editor')
    const opened = ui!.calls.filter((c) => c.method === 'action.run' && c.params.id === 'pane.open').map((c) => c.params.params)
    expect(opened).toEqual([{ thread: thread.id, kind: 'editor', params: { path: 'notes.md' } }])

    // Nested: its folders made, and opened in the tree so it shows.
    await pane.click('New file')
    await name('docs/deep/plan.md')
    await ui!.until(() => Boolean(row('plan.md')), 'listed in its folder')
    expect((await stat(join(repo, 'docs/deep/plan.md'))).isFile()).toBe(true)
    expect(row('deep')!.querySelector('.files-tree__caret.is-open')).toBeTruthy()

    // A folder, in the folder selected.
    await pane.click('README.md')
    await pane.click('New folder')
    await name('drafts')
    await ui!.until(() => Boolean(row('drafts')), 'the folder listed')
    expect((await stat(join(repo, 'drafts'))).isDirectory()).toBe(true)
  })

  it("refuses a name that's taken, or isn't one, in the field; Escape leaves without making anything", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const pane = await ui!.render({ thread: thread.id, pane: { kind: FOLDER, params: { path: '' } } })
    await ui!.until(() => Boolean(row('README.md')), 'listed')
    await pane.click('New file')
    await name('README.md')
    await ui!.until(() => problem() === 'README.md is already there', 'refused')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('hello\n')
    expect(field()?.value).toBe('README.md')
    await name('../out.md')
    expect(problem()).toBe("A name can't be . or ..")
    await name('docs/')
    expect(problem()).toBe("A name can't start or end with /, or have // in it")
    await ui!.type('.files-name__field', 'never.md')
    expect(problem()).toBeUndefined()
    await ui!.key('escape')
    await ui!.until(() => !field(), 'gone')
    await expect(stat(join(repo, 'never.md'))).rejects.toThrow()
    expect(ui!.calls.filter((c) => c.method === 'action.run' && c.params.id === 'pane.open')).toEqual([])
    error.mockRestore()
  })

  it('opens the new file with its text focused, ready to type', async () => {
    await ui!.unmount()
    ui = await mountUi({ window: true, extensions: [files], machines: [daemon!], select: { thread: thread.id } })
    await ui.dispatch('pane.open', { thread: thread.id, kind: FOLDER, params: { path: '' } })
    await ui.until(() => Boolean(row('README.md')), 'the folder pane')
    // From the pane's tab, where its buttons are.
    $('[data-column] .panes__tab [aria-label="New file"]')!.click()
    await ui.until(() => document.activeElement === field(), 'the name field, focused')
    await name('todo.md')
    await ui.until(() => Boolean($('[data-column] .file-editor .cm-content')), 'the editor')
    await ui.until(() => document.activeElement === $('[data-column] .file-editor .cm-content'), 'its text focused')
    // ⌥⌘N from the folder pane's tab.
    $('[data-column] .files-tree__row')!.focus()
    expect(await ui.press('mod+alt+n')).toBe('files.new')
    await ui.until(() => document.activeElement === field(), 'the name field, focused')
    // Escape: the focus back in the pane, not lost.
    await ui.key('escape')
    await ui.until(() => !field(), 'gone')
    expect(document.activeElement).toBe($('[data-column] .files-folder')!.closest('[data-column]'))
  })

  it('starts a new file in the folder pane with the keyboard, ⌥⌘N, in the folder selected', async () => {
    const pane = await ui!.render({ thread: thread.id, pane: { kind: FOLDER, params: { path: '' } } })
    await ui!.until(() => Boolean(row('docs')), 'listed')
    expect(await ui!.press('mod+alt+n')).toBeUndefined()
    await pane.click('docs')
    row('docs')!.focus()
    expect(await ui!.press('mod+alt+n')).toBe('files.new')
    await ui!.until(() => document.activeElement === field(), 'the name field, focused')
    await name('inside.md')
    await ui!.until(() => Boolean(row('inside.md')), 'made')
    expect((await stat(join(repo, 'docs/inside.md'))).isFile()).toBe(true)
  })
})

describe("on a remote thread's machine", () => {
  const thread = testThread({ id: 't1', cwd: '/home/me/dev/reforge' })
  const disk: Record<string, FolderEntries['entries']> = { '': [{ name: 'notes', folder: true }], notes: [{ name: 'a.md', folder: false }] }

  it("creates there, from a folder's menu, and opens it there", async () => {
    const created: unknown[] = []
    const opened: unknown[] = []
    const workbox = fakeMachine({
      id: 'workbox', threads: [thread], features: [...FEATURES],
      methods: {
        [ENTRIES]: ({ path }: { path: string }) => ({ entries: disk[path] ?? [] }),
        'file.create': (params: { path: string }) => {
          created.push(params)
          disk.notes!.push({ name: params.path.split('/').at(-1)!, folder: false })
          return { path: `/home/me/dev/reforge/${params.path}` }
        },
        'pane.open': (params) => { opened.push(params); return { id: 'p2' } },
      },
    })
    ui = await mountUi({ extensions: [files], machines: [fakeMachine({ id: 'local' }), workbox] })
    await ui.render({ machine: 'workbox', thread: thread.id, pane: { kind: FOLDER, params: { path: '' } } })
    await ui.until(() => Boolean(row('notes')), 'listed')
    rightClick(row('notes')!)
    await ui.until(() => Boolean(menuItem('New file here')), 'its menu')
    menuItem('New file here')!.click()
    await ui.until(() => Boolean(field()), 'the name field')
    await ui.type('.files-name__field', 'b.md')
    await ui.key('enter')
    await ui.until(() => opened.length === 1, 'opened')
    expect(created).toEqual([{ thread: 't1', path: 'notes/b.md' }])
    expect(opened[0]).toMatchObject({ thread: 't1', kind: 'editor', params: { path: 'notes/b.md' } })
    expect(ui.calls.filter((c) => c.machine === 'local')).toEqual([])
  })

  it("offers nothing new where the machine can't make files", async () => {
    const old = fakeMachine({ id: 'old', threads: [thread], features: FEATURES.filter((f) => f !== 'file-create'), methods: { [ENTRIES]: () => ({ entries: disk[''] }) } })
    ui = await mountUi({ extensions: [files], machines: [old] })
    const pane = await ui.render({ machine: 'old', thread: thread.id, pane: { kind: FOLDER, params: { path: '' } } })
    await ui.until(() => Boolean(row('notes')), 'listed')
    expect(pane.find('[aria-label="New file"]')).toBeNull()
    rightClick(row('notes')!)
    await ui.settle()
    expect(menuItem('New file here')).toBeUndefined()
  })
})
