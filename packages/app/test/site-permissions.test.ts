// Web pages' site permissions: what's asked for, asked once per site and permission, answered by the user alone, kept,
// and forgotten; and how the asks are said.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { asked, checkAsks, createSitePermissions, fileStore, originOf, type AnswerStore } from '../src/main/site-permissions.ts'
import { askText, permissionName, wants } from '../src/shared/site-permissions.ts'
import type { PermissionAsk, SitePermissions } from '../src/shared/bridge.ts'

const OKTA = 'https://okta.example.com'

function setUp(initial: SitePermissions = {}) {
  let saved = initial
  const store: AnswerStore = { load: () => saved, save: (answers) => { saved = answers } }
  const asking = new Map<string, PermissionAsk | undefined>()
  const changed = vi.fn()
  const sites = createSitePermissions<string>({ store, asking: (view, ask) => asking.set(view, ask), changed })
  return { sites, asking, changed, saved: () => saved }
}

describe('what a page is asked about', () => {
  it('the local network, the camera and microphone, and notifications; nothing else', () => {
    expect(asked('local-network-access')).toEqual(['loopback-network', 'local-network'])
    expect(asked('loopback-network')).toEqual(['loopback-network'])
    expect(asked('local-network')).toEqual(['local-network'])
    expect(asked('notifications')).toEqual(['notifications'])
    expect(asked('media', ['video'])).toEqual(['camera'])
    expect(asked('media', ['audio'])).toEqual(['microphone'])
    expect(asked('media', ['video', 'audio'])).toEqual(['camera', 'microphone'])
    expect(asked('media', ['unknown'])).toEqual(['camera', 'microphone'])
    for (const permission of ['geolocation', 'clipboard-read', 'midi', 'display-capture', 'openExternal']) expect(asked(permission)).toBeUndefined()
    // Only a check of the local network asks: a page checks it before it reaches for it, and is told no until asked.
    expect(checkAsks('loopback-network')).toBe(true)
    expect(checkAsks('notifications')).toBe(false)
  })

  it('is asked by a web page alone, as its origin', () => {
    expect(originOf('https://okta.example.com/signin?x=1')).toBe(OKTA)
    expect(originOf('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173')
    for (const url of ['data:text/html,hi', 'file:///etc/passwd', 'about:blank', '', undefined, 'not a url']) expect(originOf(url)).toBeUndefined()
  })
})

describe("a site's permissions", () => {
  it('asks the user, grants nothing until they allow it, and keeps the answer for the site', () => {
    const { sites, asking, changed, saved } = setUp()
    const done = vi.fn()
    sites.request('a', OKTA, ['notifications'], done)
    expect(done).not.toHaveBeenCalled()
    expect(asking.get('a')).toEqual({ origin: OKTA, kinds: ['notifications'] })
    expect(sites.check(OKTA, ['notifications'])).toBe(false)
    sites.answer('a', true)
    expect(done).toHaveBeenCalledWith(true)
    expect(asking.get('a')).toBeUndefined()
    expect(saved()).toEqual({ [OKTA]: { notifications: 'granted' } })
    expect(changed).toHaveBeenCalledOnce()
    // Asked again, it's answered at once; the check says so too.
    const again = vi.fn()
    sites.request('b', OKTA, ['notifications'], again)
    expect(again).toHaveBeenCalledWith(true)
    expect(asking.has('b')).toBe(false)
    expect(sites.check(OKTA, ['notifications'])).toBe(true)
    // Another site, another permission: asked anew.
    expect(sites.check('https://other.example', ['notifications'])).toBe(false)
    expect(sites.check(OKTA, ['camera'])).toBe(false)
  })

  it('refuses what the user refused, without asking again', () => {
    const { sites, asking } = setUp({ [OKTA]: { camera: 'denied', microphone: 'granted' } })
    const done = vi.fn()
    sites.request('a', OKTA, ['camera', 'microphone'], done)
    expect(done).toHaveBeenCalledWith(false)
    sites.request('a', OKTA, ['microphone'], done)
    expect(done).toHaveBeenLastCalledWith(true)
    expect(asking.size).toBe(0)
  })

  it('asks only for what is not answered yet, one ask at a time, and answers every page waiting on it', () => {
    const { sites, asking, saved } = setUp({ [OKTA]: { microphone: 'granted' } })
    const call = vi.fn(), notes = vi.fn(), other = vi.fn()
    sites.request('a', OKTA, ['camera', 'microphone'], call)
    sites.request('a', OKTA, ['notifications'], notes)
    sites.request('b', OKTA, ['camera'], other)
    expect(asking.get('a')).toEqual({ origin: OKTA, kinds: ['camera'] })
    expect(asking.get('b')).toEqual({ origin: OKTA, kinds: ['camera'] })
    sites.answer('a', false)
    expect(call).toHaveBeenCalledWith(false)
    expect(other).toHaveBeenCalledWith(false)
    expect(asking.get('a')).toEqual({ origin: OKTA, kinds: ['notifications'] })
    expect(asking.get('b')).toBeUndefined()
    sites.answer('a', true)
    expect(notes).toHaveBeenCalledWith(true)
    expect(saved()).toEqual({ [OKTA]: { microphone: 'granted', camera: 'denied', notifications: 'granted' } })
    // Nothing asked: an answer is nothing.
    sites.answer('a', true)
    expect(saved()[OKTA]).toEqual({ microphone: 'granted', camera: 'denied', notifications: 'granted' })
  })

  it('asks for the local network as a page checks it, once, and tells the page once it is allowed', () => {
    const { sites, asking } = setUp()
    const allowed = vi.fn()
    expect(sites.check(OKTA, ['loopback-network'], { view: 'a', allowed })).toBe(false)
    expect(sites.check(OKTA, ['loopback-network'], { view: 'a', allowed })).toBe(false)
    expect(asking.get('a')).toEqual({ origin: OKTA, kinds: ['loopback-network'] })
    sites.answer('a', true)
    expect(allowed).toHaveBeenCalledOnce()
    expect(sites.check(OKTA, ['loopback-network'], { view: 'a', allowed })).toBe(true)
    // Refused, the page isn't told anything new.
    const refused = vi.fn()
    sites.check(OKTA, ['local-network'], { view: 'a', allowed: refused })
    sites.answer('a', false)
    expect(refused).not.toHaveBeenCalled()
    expect(sites.check(OKTA, ['local-network'], { view: 'a', allowed: refused })).toBe(false)
    expect(asking.get('a')).toBeUndefined()
  })

  it("drops a page's asks, unanswered, as it goes; a check's stays for the next page, until the view goes", () => {
    const { sites, asking, saved } = setUp()
    const done = vi.fn()
    sites.request('a', OKTA, ['notifications'], done)
    sites.check(OKTA, ['loopback-network'], { view: 'a', allowed: () => {} })
    sites.drop('a', false)
    expect(done).toHaveBeenCalledWith(false)
    expect(asking.get('a')).toEqual({ origin: OKTA, kinds: ['loopback-network'] })
    sites.drop('a', true)
    expect(saved()).toEqual({})
    // Gone, it isn't told anything more.
    expect(asking.get('a')).toEqual({ origin: OKTA, kinds: ['loopback-network'] })
    sites.request('a', OKTA, ['notifications'], done)
    expect(asking.get('a')).toEqual({ origin: OKTA, kinds: ['notifications'] })
  })

  it('forgets a site: asked again', () => {
    const { sites, saved, changed } = setUp({ [OKTA]: { notifications: 'denied' }, 'https://keep.example': { camera: 'granted' } })
    sites.forget(OKTA)
    expect(saved()).toEqual({ 'https://keep.example': { camera: 'granted' } })
    expect(changed).toHaveBeenCalledOnce()
    const done = vi.fn()
    sites.request('a', OKTA, ['notifications'], done)
    expect(done).not.toHaveBeenCalled()
    sites.forget('https://never.example')
    expect(changed).toHaveBeenCalledOnce()
  })
})

describe('the answers on disk', () => {
  it('are kept between launches; a file that cannot be read is said, and starts empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sites-'))
    const path = join(dir, 'browser-sites.json')
    expect(fileStore(path).load()).toEqual({})
    fileStore(path).save({ [OKTA]: { notifications: 'granted' } })
    expect(fileStore(path).load()).toEqual({ [OKTA]: { notifications: 'granted' } })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ [OKTA]: { notifications: 'granted' } })
    writeFileSync(path, '{ not json')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = fileStore(path)
    expect(broken.load()).toEqual({})
    expect(broken.problem).toContain("couldn't be read")
    expect(logged).toHaveBeenCalledOnce()
    logged.mockRestore()
  })
})

describe('an ask, as the pane says it', () => {
  it('names the site and what it wants', () => {
    expect(askText({ origin: OKTA, kinds: ['loopback-network'] })).toBe('okta.example.com wants to reach apps on this Mac')
    expect(askText({ origin: 'http://127.0.0.1:5173', kinds: ['loopback-network', 'local-network'] }, 'this computer'))
      .toBe('127.0.0.1:5173 wants to reach apps on this computer and devices on your network')
    expect(wants(['camera', 'microphone'])).toBe('use the camera and microphone')
    expect(wants(['microphone'])).toBe('use the microphone')
    expect(wants(['notifications'])).toBe('show notifications')
    expect(permissionName('local-network')).toBe('Devices on your network')
  })
})
