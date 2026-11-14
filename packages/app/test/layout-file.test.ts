// The layout as text: layout.json read and checked, applied as it's saved, the last good layout kept through a mistake,
// and changes made in the window written back, with the views listed at its head.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemorySettingsStore, SettingsRegistry } from '@superego/settings'
import { LayoutFile, layoutHead, parseLayout, type LayoutView } from '../src/main/layout-file.ts'
import { LAYOUT_SETTING } from '../src/shared.ts'

const views: LayoutView[] = [
  { id: 'threads.details', title: 'Thread details', fits: ['aside', 'pane'] },
  { id: 'ego.button', title: 'Ask Ego', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer' },
]

describe('reading a layout', () => {
  it('reads JSON under a head of comments, and nothing as no changes', () => {
    expect(parseLayout(`${layoutHead(views)}{ "place": { "threads.details": "aside" } }`, views)).toEqual({ layout: { place: { 'threads.details': 'aside' } } })
    expect(parseLayout('// just comments\n', views)).toEqual({ layout: {} })
  })

  it('says what is wrong: bad JSON, not a layout, an unknown view or place, a place a view does not fit', () => {
    expect(parseLayout('{ "place": ', views)).toMatchObject({ problem: expect.stringMatching(/^Not JSON/) })
    expect(parseLayout('{ "rail": [] }', views)).toMatchObject({ problem: expect.stringMatching(/^Not a layout/) })
    expect(parseLayout('{ "place": { "nope.view": "aside" } }', views)).toEqual({ problem: 'no view "nope.view"' })
    expect(parseLayout('{ "order": { "sidebar": [] } }', views)).toEqual({ problem: 'no place "sidebar"' })
    expect(parseLayout('{ "narrow": { "place": { "ego.button": "aside" } } }', views)).toEqual({ problem: `ego.button doesn't fit "aside" (only rail, drawer)` })
    // Not knowing the views yet, any id goes.
    expect(parseLayout('{ "place": { "nope.view": "aside" } }')).toEqual({ layout: { place: { 'nope.view': 'aside' } } })
  })

  it('lists the views and the places each fits at the head', () => {
    const head = layoutHead(views)
    expect(head).toContain('//   ego.button       rail, drawer; rail, on a phone drawer  (Ask Ego)')
    expect(head).toContain('//   threads.details  aside, pane; none  (Thread details)')
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
    await file.setViews(views)
  })
  afterEach(() => { file.stop(); rmSync(dir, { recursive: true, force: true }) })

  it('is written from the setting when there is none, readable, with the views at its head', () => {
    const text = readFileSync(join(dir, 'layout.json'), 'utf8')
    expect(text).toContain('//   threads.details')
    expect(text).toContain('{\n  "place": {\n    "ego.button": null\n  }\n}\n')
  })

  it('applies a save at once, keeps the last good layout through a mistake, and forgets the note once fixed', async () => {
    writeFileSync(file.path, '{ "place": { "threads.details": "aside" } }')
    await wait(() => layout() === '{"place":{"threads.details":"aside"}}')
    writeFileSync(file.path, '{ "place": { "threads.details": "asid')
    await wait(() => file.problem?.startsWith('Not JSON') ?? false)
    expect(layout()).toBe('{"place":{"threads.details":"aside"}}')
    writeFileSync(file.path, '{ "place": { "threads.detail": "aside" } }')
    await wait(() => file.problem === 'no view "threads.detail"')
    expect(layout()).toBe('{"place":{"threads.details":"aside"}}')
    writeFileSync(file.path, '{}')
    await wait(() => layout() === '{}')
    expect(file.problem).toBeUndefined()
  })

  it('writes changes made in the window back', async () => {
    await settings.set('app.layout', { place: { 'threads.details': 'pane' } })
    await wait(() => readFileSync(file.path, 'utf8').includes('"threads.details": "pane"'))
    expect(readFileSync(file.path, 'utf8')).toContain('// Views')
  })

  it('keeps what was typed when the views change, putting only the head anew', async () => {
    writeFileSync(file.path, '// mine\n{ "place": { "threads.details": "aside" } }  ')
    await wait(() => layout() === '{"place":{"threads.details":"aside"}}')
    await file.setViews([...views, { id: 'files.folder', title: 'Files', fits: ['space', 'aside', 'pane'] }])
    const text = readFileSync(file.path, 'utf8')
    expect(text).toContain('//   files.folder')
    expect(text.endsWith('{ "place": { "threads.details": "aside" } }  ')).toBe(true)
  })
})
