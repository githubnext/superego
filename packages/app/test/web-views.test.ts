// A web view's rules, apart from Electron: where its page may go itself, what opens outside the app, where a file it
// saves goes, and a browser's own keys in it.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ protocol: {}, app: {}, ipcMain: {}, session: {}, shell: {}, WebContentsView: class {} }))
const { browserKey, mayNavigate, opensOutside, savePath } = await import('../src/main/web-views.ts')

describe('a web view', () => {
  it('goes to web pages itself, and an artifact to its own files too', () => {
    expect(mayNavigate('browser', 'http://workbox:5173/')).toBe(true)
    expect(mayNavigate('browser', 'HTTPS://example.com/')).toBe(true)
    expect(mayNavigate('browser', 'about:blank')).toBe(true)
    expect(mayNavigate('browser', 'superego-artifact://local/t/page.html')).toBe(false)
    expect(mayNavigate('artifact', 'superego-artifact://local/t/page.html')).toBe(true)
    for (const url of ['file:///etc/passwd', 'mailto:me@example.com', 'javascript:alert(1)', 'chrome://gpu']) expect(mayNavigate('browser', url)).toBe(false)
  })

  it('sends the user to the browser or the mail app, and nowhere else', () => {
    expect(opensOutside('https://example.com/')).toBe(true)
    expect(opensOutside('mailto:me@example.com')).toBe(true)
    expect(opensOutside('file:///Applications/Calculator.app')).toBe(false)
    expect(opensOutside('superego-artifact://local/t/x.html')).toBe(false)
  })

  it('saves a file under its own name, numbered when that is taken, never outside the folder', () => {
    const taken = new Set(['/dl/report.pdf', '/dl/report (1).pdf'])
    expect(savePath('/dl', 'notes.txt', (p) => taken.has(p))).toBe('/dl/notes.txt')
    expect(savePath('/dl', 'report.pdf', (p) => taken.has(p))).toBe('/dl/report (2).pdf')
    expect(savePath('/dl', '../../etc/x', () => false)).toBe('/dl/.._.._etc_x')
    expect(savePath('/dl', '', () => false)).toBe('/dl/download')
  })

  it("takes a browser's keys: reload, back and forward", () => {
    const key = (key: string, mods: Partial<Record<'meta' | 'control' | 'alt' | 'shift', boolean>> = {}) =>
      ({ type: 'keyDown', key, meta: false, control: false, alt: false, shift: false, ...mods })
    expect(browserKey(key('r', { meta: true }), true)).toBe('reload')
    expect(browserKey(key('[', { meta: true }), true)).toBe('back')
    expect(browserKey(key(']', { meta: true }), true)).toBe('forward')
    expect(browserKey(key('r', { control: true }), false)).toBe('reload')
    expect(browserKey(key('r', { control: true }), true)).toBeUndefined()
    expect(browserKey(key('r', { meta: true, shift: true }), true)).toBeUndefined()
    expect(browserKey(key('r'), true)).toBeUndefined()
    expect(browserKey({ ...key('r', { meta: true }), type: 'keyUp' }, true)).toBeUndefined()
  })
})
