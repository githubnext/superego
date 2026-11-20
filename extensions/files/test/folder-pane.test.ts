// @vitest-environment happy-dom
// A folder pane: what the thread's machine says is in the folder, a level at a time; a file opens beside the thread in
// the kind that takes it; an empty folder said so, one that can't be read said why.
import { afterEach, expect, it, vi } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import { fileKind } from '@superego/app/ui'
import files from '../src/ui.tsx'
import { ENTRIES, FOLDER, type FolderEntries } from '../src/shared.ts'

let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount() })

const thread = testThread({ id: 't1', cwd: '/home/me/dev/reforge' })
const disk: Record<string, FolderEntries['entries']> = {
  'scripts/recovery/img': [{ name: 'old', folder: true }, { name: 'after.png', folder: false }],
  'scripts/recovery/img/old': [{ name: 'before.png', folder: false }],
  empty: [],
}

it("lists a remote thread's folder from that machine, a level at a time, and opens its images", async () => {
  const opened: unknown[] = []
  const workbox = fakeMachine({
    id: 'workbox', threads: [thread],
    methods: {
      [ENTRIES]: ({ path }: { path: string }) => ({ entries: disk[path]! }),
      'pane.open': (params) => { opened.push(params); return { id: 'p2' } },
    },
  })
  ui = await mountUi({ extensions: [files], machines: [fakeMachine({ id: 'local' }), workbox] })
  const pane = await ui.render({ machine: 'workbox', thread: thread.id, pane: { kind: FOLDER, params: { path: 'scripts/recovery/img/' } } })
  await ui.until(() => pane.text().includes('after.png'))
  expect(pane.text()).not.toContain('before.png')
  await pane.click('old')
  await ui.until(() => pane.text().includes('before.png'))
  expect(ui.calls.filter((c) => c.method === ENTRIES)).toEqual([
    { machine: 'workbox', method: ENTRIES, params: { thread: 't1', path: 'scripts/recovery/img' } },
    { machine: 'workbox', method: ENTRIES, params: { thread: 't1', path: 'scripts/recovery/img/old' } },
  ])
  await pane.click('after.png')
  const kind = fileKind(ui.registry, { machine: 'workbox', thread }, 'scripts/recovery/img/after.png')
  expect(kind).toBeTruthy()
  await ui.until(() => opened.length === 1)
  expect(opened[0]).toMatchObject({ thread: 't1', kind, params: { path: 'scripts/recovery/img/after.png' } })
})

it("says a folder is empty only when it is, and why one can't be read", async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const machine = fakeMachine({
    threads: [thread],
    methods: { [ENTRIES]: ({ path }: { path: string }) => { if (path === 'gone') throw new Error("gone isn't there"); return { entries: disk[path]! } } },
  })
  ui = await mountUi({ extensions: [files], machines: [machine] })
  const empty = await ui.render({ thread: thread.id, pane: { kind: FOLDER, params: { path: 'empty' } } })
  await ui.until(() => empty.text().includes('No files here.'))
  const gone = await ui.render({ thread: thread.id, pane: { kind: FOLDER, params: { path: 'gone' } } })
  await ui.until(() => gone.text().includes("Couldn't read this folder: gone isn't there"))
  expect(gone.text()).not.toContain('No files here.')
  expect(error).toHaveBeenCalled()
  error.mockRestore()
})
