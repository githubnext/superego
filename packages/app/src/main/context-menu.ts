// The native menu on a right-click in the window's content: text fields, selected text, links and images. The chrome
// (rail, sidebar, title bar, buttons) has none: the preload cancels a right-click there (see preload.ts), as the app's
// own menus cancel theirs, and then Chromium never asks for one. What's shown follows from what Chromium says is under
// the pointer.
import { BrowserWindow, clipboard, Menu, shell, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'

export type MenuParams = Pick<ContextMenuParams, 'x' | 'y' | 'pageURL' | 'linkURL' | 'srcURL' | 'mediaType' | 'isEditable' | 'selectionText' | 'misspelledWord' | 'dictionarySuggestions'>
  & { editFlags: Pick<ContextMenuParams['editFlags'], 'canUndo' | 'canRedo' | 'canCut' | 'canCopy' | 'canPaste' | 'canSelectAll'> }

/** What the items do, so building them stays apart from Electron's objects. */
export type MenuActions = {
  open(url: string): void
  copyText(text: string): void
  copyImageAt(x: number, y: number): void
  save(url: string): void
  lookUp(): void
  replace(word: string): void
  learn(word: string): void
  inspect(x: number, y: number): void
}

const SEARCH = 'https://www.google.com/search?q='

/** The menu's items for a right-click, or none for nothing to offer. `dev` adds Inspect Element; `mac`, Look Up. */
export function contextMenuItems(params: MenuParams, { dev, mac, actions }: { dev: boolean; mac: boolean; actions: MenuActions }): MenuItemConstructorOptions[] {
  const selection = params.selectionText.trim()
  const groups: MenuItemConstructorOptions[][] = []

  if (params.isEditable && params.misspelledWord) {
    const guesses = params.dictionarySuggestions.slice(0, 5)
    groups.push([
      ...(guesses.length
        ? guesses.map((word) => ({ label: word, click: () => actions.replace(word) }))
        : [{ label: 'No Guesses Found', enabled: false }]),
      { label: 'Add to Dictionary', click: () => actions.learn(params.misspelledWord) },
    ])
  }
  if (selection) {
    groups.push([
      ...(mac ? [{ label: `Look Up “${short(selection)}”`, click: () => actions.lookUp() }] : []),
      { label: 'Search with Google', click: () => actions.open(SEARCH + encodeURIComponent(selection)) },
    ])
  }
  const link = webLink(params.linkURL, params.pageURL)
  if (link) groups.push([
    { label: 'Open Link', click: () => actions.open(link) },
    { label: 'Copy Link', click: () => actions.copyText(link) },
  ])
  if (params.mediaType === 'image' && params.srcURL) groups.push([
    { label: 'Copy Image', click: () => actions.copyImageAt(params.x, params.y) },
    { label: 'Save Image As…', click: () => actions.save(params.srcURL) },
  ])
  if (params.isEditable) {
    const can = params.editFlags
    groups.push(
      [{ role: 'undo', enabled: can.canUndo }, { role: 'redo', enabled: can.canRedo }],
      [{ role: 'cut', enabled: can.canCut }, { role: 'copy', enabled: can.canCopy }, { role: 'paste', enabled: can.canPaste }],
      [{ role: 'selectAll', enabled: can.canSelectAll }],
    )
  } else if (selection) {
    groups.push([{ role: 'copy' }])
  }
  if (dev) groups.push([{ label: 'Inspect Element', click: () => actions.inspect(params.x, params.y) }])
  return groups.flatMap((group, i) => i ? [{ type: 'separator' as const }, ...group] : group)
}

/** Gives `contents` the menu; once, where each window is made. */
export function attachContextMenu(contents: WebContents, { dev }: { dev: boolean }) {
  const actions: MenuActions = {
    open: (url) => void shell.openExternal(url),
    copyText: (text) => clipboard.writeText(text),
    copyImageAt: (x, y) => contents.copyImageAt(x, y),
    save: (url) => contents.downloadURL(url),
    lookUp: () => contents.showDefinitionForSelection(),
    replace: (word) => contents.replaceMisspelling(word),
    learn: (word) => void contents.session.addWordToSpellCheckerDictionary(word),
    inspect: (x, y) => contents.inspectElement(x, y),
  }
  contents.on('context-menu', (_event, params) => {
    const items = contextMenuItems(params, { dev, mac: process.platform === 'darwin', actions })
    if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined })
  })
}

/** A link to somewhere else on the web: not the app's own page (a link the app handles itself points there, at `#`). */
function webLink(url: string, page: string) {
  if (!/^(https?|mailto):/i.test(url)) return undefined
  return url.split('#')[0] === page.split('#')[0] ? undefined : url
}

function short(text: string) {
  const line = text.replace(/\s+/g, ' ')
  if (line.length <= 24) return line
  const cut = line.slice(0, 24)
  const space = cut.lastIndexOf(' ')
  return `${(space > 12 ? cut.slice(0, space) : cut).trimEnd()}…`
}
