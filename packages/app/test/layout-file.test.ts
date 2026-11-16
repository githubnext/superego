// The layout as text: layout.json read and checked, applied as it's saved, the last good layout kept through a mistake,
// and changes made in the window written back, with the views listed at its head.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemorySettingsStore, SettingsRegistry } from '@superego/settings'
import { bodyOf, LayoutFile, layoutHead, parseLayout, withComments, type LayoutView } from '../src/main/layout-file.ts'
import { LAYOUT_SETTING } from '../src/shared.ts'

const views: LayoutView[] = [
  { id: 'threads.details', title: 'Thread details', fits: ['beside', 'pane'] },
  { id: 'ego.button', title: 'Ask Ego', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer' },
]

describe('reading a layout', () => {
  it('reads JSON under a head of comments, and nothing as no changes', () => {
    expect(parseLayout(`${layoutHead(views)}{ "place": { "threads.details": "beside" } }`, views)).toEqual({ layout: { place: { 'threads.details': 'beside' } } })
    expect(parseLayout('// just comments\n', views)).toEqual({ layout: {} })
  })

  it('says what is wrong: bad JSON, not a layout, an unknown place, a place a view does not fit', () => {
    expect(parseLayout('{ "place": ', views)).toMatchObject({ problem: expect.stringMatching(/^Not JSON/) })
    expect(parseLayout('{ "rail": [] }', views)).toMatchObject({ problem: expect.stringMatching(/^Not a layout/) })
    expect(parseLayout('{ "order": { "sidebar": [] } }', views)).toEqual({ problem: 'no place "sidebar"' })
    expect(parseLayout('{ "narrow": { "place": { "ego.button": "beside" } } }', views)).toEqual({ problem: `ego.button doesn't fit "beside" (only rail, drawer)` })
    // Not knowing the views yet, any id goes.
    expect(parseLayout('{ "place": { "nope.view": "beside" } }')).toEqual({ layout: { place: { 'nope.view': 'beside' } } })
  })

  it('applies a view that is not there now, noting it, so it is placed again when it is back', () => {
    expect(parseLayout('{ "place": { "nope.view": "beside" }, "order": { "pane": ["gone.too", "threads.details"] } }', views))
      .toEqual({ layout: { place: { 'nope.view': 'beside' }, order: { pane: ['gone.too', 'threads.details'] } }, missing: ['nope.view', 'gone.too'] })
  })

  it('keeps the comments typed in the body, by the line they were above', () => {
    const body = '// mine\n{\n  "place": {\n    // the details beside\n    "threads.details": "beside"\n  }\n}\n// the end\n'
    expect(withComments(body, { place: { 'threads.details': 'pane', 'ego.button': null } }))
      .toBe('// mine\n{\n  "place": {\n    // the details beside\n    "threads.details": "pane",\n    "ego.button": null\n  }\n}\n// the end\n')
    expect(bodyOf(`${layoutHead(views)}\n// mine\n{}`)).toBe('// mine\n{}')
  })

  it('lists the views and the places each fits at the head', () => {
    const head = layoutHead(views)
    expect(head).toContain('//   ego.button       rail, drawer; rail, on a phone drawer  (Ask Ego)')
    expect(head).toContain('//   threads.details  beside, pane; none  (Thread details)')
    expect(head.split('\n').filter(Boolean).every((line) => line.startsWith('//'))).toBe(true)
  })
})

describe('the layout file', () => {
  let dir: string
  let settings: SettingsRegistry
  let file: LayoutFile
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 250 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(check()).toBe(true)
  }
  const layout = () => JSON.stringify(settings.get('app.layout'))
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'layout-file-'))
    settings = new SettingsRegistry(new MemorySettingsStore({ 'app.layout': { place: { 'ego.button': null } } }))
    settings.register({ id: 'appearance', title: 'Appearance', settings: [LAYOUT_SETTING] })
    file = new LayoutFile(dir, settings)
    await file.start()
    await file.setViews(1, views)
  })
  afterEach(() => { file.stop(); rmSync(dir, { recursive: true, force: true }) })

  it('is written from the setting when there is none, readable, with the views at its head', () => {
    const text = readFileSync(join(dir, 'layout.json'), 'utf8')
    expect(text).toContain('//   threads.details')
    expect(text).toContain('{\n  "place": {\n    "ego.button": null\n  }\n}\n')
  })

  it('applies a save at once, keeps the last good layout through a mistake, and forgets the note once fixed', async () => {
    writeFileSync(file.path, '{ "place": { "threads.details": "beside" } }')
    await wait(() => layout() === '{"place":{"threads.details":"beside"}}')
    writeFileSync(file.path, '{ "place": { "threads.details": "asid')
    await wait(() => file.problem?.startsWith('Not JSON') ?? false)
    expect(layout()).toBe('{"place":{"threads.details":"beside"}}')
    writeFileSync(file.path, '{ "place": { "threads.details": "rail" } }')
    await wait(() => file.problem?.startsWith(`threads.details doesn't fit`) ?? false)
    expect(layout()).toBe('{"place":{"threads.details":"beside"}}')
    // A view no window has now: applied, and noted.
    writeFileSync(file.path, '{ "place": { "threads.detail": "beside" } }')
    await wait(() => layout() === '{"place":{"threads.detail":"beside"}}')
    expect(file.problem).toBeUndefined()
    expect(file.missing).toEqual(['threads.detail'])
    await file.setViews(2, [{ id: 'threads.detail', title: 'Another window\'s', fits: ['beside'] }])
    expect(file.missing).toBeUndefined()
    writeFileSync(file.path, '{}')
    await wait(() => layout() === '{}')
    expect(file.problem).toBeUndefined()
  })

  it('writes changes made in the window back', async () => {
    await settings.set('app.layout', { place: { 'threads.details': 'pane' } })
    await wait(() => readFileSync(file.path, 'utf8').includes('"threads.details": "pane"'))
    expect(readFileSync(file.path, 'utf8')).toContain('// Views')
  })

  it("keeps the window's change when the file is read as it's written", async () => {
    // A look at the file (as the watcher has every so often) in the middle of writing it.
    const set = settings.set('app.layout', { place: { 'threads.details': 'pane' } })
    await new Promise((resolve) => setImmediate(resolve))
    await Promise.all([set, file.read()])
    expect(layout()).toBe('{"place":{"threads.details":"pane"}}')
    expect(readFileSync(file.path, 'utf8')).toContain('"threads.details": "pane"')
  })

  it('leaves a file that does not read as typed when the window changes the layout', async () => {
    writeFileSync(file.path, '{ "place": { "threads.details": "asi')
    await wait(() => file.problem?.startsWith('Not JSON') ?? false)
    await settings.set('app.layout', { place: { 'threads.details': 'pane' } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(readFileSync(file.path, 'utf8')).toBe('{ "place": { "threads.details": "asi')
    expect(file.problem).toMatch(/^Not JSON/)
  })

  it('keeps comments typed in the file when the window changes the layout', async () => {
    writeFileSync(file.path, `${layoutHead(views)}\n// mine\n{ "place": { "ego.button": null } }\n`)
    // Read as saved (what the watcher does once it hears of it): a change from the window before then finds the file
    // saved since, and takes the file's side.
    await file.read()
    await settings.set('app.layout', { place: { 'threads.details': 'pane' } })
    await wait(() => readFileSync(file.path, 'utf8').includes('"threads.details": "pane"'))
    expect(readFileSync(file.path, 'utf8')).toContain('\n\n// mine\n{\n')
  })

  it('keeps what was typed when the views change, putting only the head anew', async () => {
    writeFileSync(file.path, '// mine\n{ "place": { "threads.details": "beside" } }  ')
    await wait(() => layout() === '{"place":{"threads.details":"beside"}}')
    await file.setViews(1, [...views, { id: 'files.folder', title: 'Files', fits: ['space', 'beside', 'pane'] }])
    const text = readFileSync(file.path, 'utf8')
    expect(text).toContain('//   files.folder')
    expect(text.endsWith('{ "place": { "threads.details": "beside" } }  ')).toBe(true)
  })
})
