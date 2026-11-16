import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { contextMenuItems, type MenuActions, type MenuParams } from '../src/main/context-menu.ts'

const PAGE = 'file:///app/renderer/index.html'
const none = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false }
const params = (over: Partial<MenuParams> = {}): MenuParams => ({
  x: 10, y: 20, pageURL: PAGE, linkURL: '', srcURL: '', mediaType: 'none', isEditable: false, selectionText: '',
  misspelledWord: '', dictionarySuggestions: [], editFlags: none, ...over,
})
const actions = (): MenuActions => ({
  open: vi.fn(), copyText: vi.fn(), copyImageAt: vi.fn(), save: vi.fn(), lookUp: vi.fn(), replace: vi.fn(), learn: vi.fn(), inspect: vi.fn(),
})
const names = (items: MenuItemConstructorOptions[]) => items.map((item) => item.type === 'separator' ? '—' : item.label ?? item.role)
const build = (over: Partial<MenuParams>, env: { dev?: boolean; mac?: boolean; actions?: MenuActions } = {}) =>
  contextMenuItems(params(over), { dev: env.dev ?? false, mac: env.mac ?? true, actions: env.actions ?? actions() })
const click = (items: MenuItemConstructorOptions[], label: string) =>
  (items.find((item) => item.label === label)!.click as () => void)()

describe('the native context menu', () => {
  it('has nothing to offer with nothing under the pointer', () => {
    expect(build({})).toEqual([])
  })

  it('edits a field, each item as the field allows', () => {
    const items = build({ isEditable: true, editFlags: { ...none, canPaste: true, canSelectAll: true } })
    expect(names(items)).toEqual(['undo', 'redo', '—', 'cut', 'copy', 'paste', '—', 'selectAll'])
    expect(items.filter((item) => item.role).map((item) => item.enabled)).toEqual([false, false, false, false, true, true])
  })

  it('offers guesses for a misspelled word, and to learn it', () => {
    const a = actions()
    const items = build({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'] }, { actions: a })
    expect(names(items).slice(0, 4)).toEqual(['the', 'tech', 'Add to Dictionary', '—'])
    click(items, 'the')
    click(items, 'Add to Dictionary')
    expect(a.replace).toHaveBeenCalledWith('the')
    expect(a.learn).toHaveBeenCalledWith('teh')
    expect(names(build({ isEditable: true, misspelledWord: 'qzx' })).slice(0, 2)).toEqual(['No Guesses Found', 'Add to Dictionary'])
  })

  it('copies, looks up and searches for selected text', () => {
    const a = actions()
    const items = build({ selectionText: '  a rather long passage of selected text\n' }, { actions: a })
    expect(names(items)).toEqual(['Look Up “a rather long passage…”', 'Search with Google', '—', 'copy'])
    click(items, 'Search with Google')
    expect(a.open).toHaveBeenCalledWith('https://www.google.com/search?q=a%20rather%20long%20passage%20of%20selected%20text')
    expect(names(build({ selectionText: 'word' }, { mac: false }))).toEqual(['Search with Google', '—', 'copy'])
  })

  it('opens and copies a link to the web, not one the app handles itself', () => {
    const a = actions()
    const items = build({ linkURL: 'https://example.com/a' }, { actions: a })
    expect(names(items)).toEqual(['Open Link', 'Copy Link'])
    click(items, 'Open Link')
    click(items, 'Copy Link')
    expect(a.open).toHaveBeenCalledWith('https://example.com/a')
    expect(a.copyText).toHaveBeenCalledWith('https://example.com/a')
    expect(build({ linkURL: `${PAGE}#`, pageURL: `${PAGE}#/thread` })).toEqual([])
    expect(build({ linkURL: 'javascript:void 0' })).toEqual([])
  })

  it('copies and saves an image', () => {
    const a = actions()
    const items = build({ mediaType: 'image', srcURL: 'data:image/png;base64,AA' }, { actions: a })
    expect(names(items)).toEqual(['Copy Image', 'Save Image As…'])
    click(items, 'Copy Image')
    click(items, 'Save Image As…')
    expect(a.copyImageAt).toHaveBeenCalledWith(10, 20)
    expect(a.save).toHaveBeenCalledWith('data:image/png;base64,AA')
  })

  it('inspects the element in a dev build only', () => {
    expect(names(build({}, { dev: true }))).toEqual(['Inspect Element'])
    expect(names(build({ selectionText: 'x' }, { dev: true })).slice(-2)).toEqual(['—', 'Inspect Element'])
  })
})
