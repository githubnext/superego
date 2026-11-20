// @vitest-environment happy-dom
// Themes in the window drawn whole (superego/testing's mountUi): a theme picked for light and for dark is stored and
// applied to the root at once (code's colours, the terminal's, the accent unless the user chose one), a theme imported
// from a file is listed, chosen and removed, and one an extension brings is offered under its name.
import { afterEach, expect, it } from 'vitest'
import { defineUiExtension } from '../src/renderer/sdk-ui.ts'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const css = (variable: string) => document.documentElement.style.getPropertyValue(variable)
const picker = (appearance: 'light' | 'dark') => $(`[data-key="app.theme.${appearance}"] select`) as HTMLSelectElement | null
const pick = (appearance: 'light' | 'dark', id: string) => {
  const select = picker(appearance)!
  select.value = id
  select.dispatchEvent(new Event('change', { bubbles: true }))
}
const offered = (appearance: 'light' | 'dark') => [...picker(appearance)?.options ?? []].map((o) => `${(o.parentElement as HTMLOptGroupElement).label ?? ''}/${o.textContent}`)

let daemon: TestDaemon
let ui: TestWindow
const open = async (extensions: Parameters<typeof mountUi>[0]['extensions'] = []) => {
  daemon = await testDaemon({ model: 'echo' })
  ui = await mountUi({ window: true, machines: [daemon], extensions })
  $('.app__settings')!.click()
  await ui.until(() => Boolean(picker('light') && picker('dark')), 'the theme pickers')
}
afterEach(async () => { await ui.unmount(); await daemon.close() })

it('picks a light and a dark theme: stored, and applied to code, the terminal and the accent at once', async () => {
  await open()
  expect(picker('light')!.value).toBe('superego')
  expect(css('--superego-syntax-keyword')).toBe('')
  expect(offered('light')).toContain('/GitHub Light')
  expect(offered('light')).not.toContain('/GitHub Dark')

  pick('light', 'github-light')
  await ui.until(() => css('--superego-syntax-keyword') === 'light-dark(#cf222e, #c792ea)', 'the light theme’s keywords, the default dark’s')
  expect(css('--superego-terminal-bg')).toBe('light-dark(#ffffff, var(--superego-bg))')
  expect(css('--superego-accent-base')).toBe('light-dark(#0969da, color(display-p3 0.155 0.319 0.654))')

  pick('dark', 'tokyo-night')
  await ui.until(() => css('--superego-syntax-keyword') === 'light-dark(#cf222e, #bb9af7)', 'the dark theme’s keywords')
  expect(css('--superego-terminal-red')).toBe('light-dark(#cf222e, #f7768e)')
  expect(css('--superego-diff-removed-text')).toBe('light-dark(#82071e, #f7768e)')
  await ui.until(() => Boolean($('[data-key="app.accent"]')?.textContent?.includes('The theme’s, until you choose one.')), 'the accent noted as the theme’s')
  expect(await ui.dispatch('app.settings.set', { key: 'app.accent', value: '#ff3300' })).toBe(null)
  await ui.until(() => css('--superego-accent-base') === '#ff3300', 'the user’s accent over the themes’')
  await ui.until(() => !$('[data-key="app.accent"]')?.textContent?.includes('The theme’s'), 'no note on the accent')

  // Back to Superego's: nothing of a theme's left on the root.
  pick('light', 'superego')
  pick('dark', 'superego')
  await ui.until(() => css('--superego-syntax-keyword') === '' && css('--superego-terminal-bg') === '', 'the defaults again')
})

it('imports a theme from a file: listed, chosen for its appearance, and removed again', async () => {
  await open()
  const theme = { name: 'Paper Ink', type: 'light', colors: { 'editor.background': '#fbfaf5' }, tokenColors: [{ scope: 'keyword', settings: { foreground: '#7a3e9d' } }] }
  const input = $('.theme-tools input[type=file]') as HTMLInputElement
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([JSON.stringify(theme)], 'paper.json')] })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await ui.until(() => picker('light')!.value === 'paper-ink', 'the imported theme chosen')
  expect(offered('light')).toContain('Imported/Paper Ink')
  await ui.until(() => css('--superego-syntax-keyword') === 'light-dark(#7a3e9d, #c792ea)', 'its keywords applied')
  expect($$('.theme-tools .setting').map((row) => row.textContent)).toEqual(['Paper InkImported, lightRemove'])

  $$('.theme-tools button').find((b) => b.textContent === 'Remove')!.click()
  await ui.until(() => picker('light')!.value === 'superego' && !offered('light').includes('Imported/Paper Ink'), 'removed, and Superego’s chosen again')
  expect(css('--superego-syntax-keyword')).toBe('')

  // One that doesn't read says why.
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['hello'], 'notes.txt')] })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await ui.until(() => Boolean($('.theme-tools .setting__error')?.textContent?.startsWith('notes.txt: Not a theme this reads')), 'the error shown')
})

it('offers a theme an extension brings, under the extension’s name, and refuses one that doesn’t read', async () => {
  const brought = defineUiExtension({
    name: 'moonlit', title: 'Moonlit',
    setup(superego) {
      superego.theme({ id: 'moonlit.night', name: 'Moonlit Night', appearance: 'dark', syntax: { keyword: '#ff79c6' }, terminal: { bg: '#21222c' } })
      expect(() => superego.theme({ id: 'night', name: 'Night', appearance: 'dark' })).toThrow('must name its themes "moonlit.<name>"')
      expect(() => superego.theme({ id: 'moonlit.bad', name: 'Bad', appearance: 'dark', syntax: { keyword: 'pink' } })).toThrow('syntax.keyword: "pink" isn\'t a colour')
    },
  })
  await open([brought])
  expect(offered('dark')).toContain('Moonlit/Moonlit Night')
  expect(offered('light')).not.toContain('Moonlit/Moonlit Night')
  pick('dark', 'moonlit.night')
  await ui.until(() => css('--superego-syntax-keyword') === 'light-dark(#a626a4, #ff79c6)' && css('--superego-terminal-bg') === 'light-dark(var(--superego-bg), #21222c)', 'the extension’s theme applied')
})
