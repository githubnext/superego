// @vitest-environment happy-dom
// An extension's styles (`superego.style`): a profile's reach only what that profile draws on its machine, so the same
// profile at two versions (on two machines), or two profiles with the same class names, each style only their own; an
// app extension's are the window's. Each goes at its extension's teardown.
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { defineApp } from '@superego/protocol'
import { Menu } from '@superego/ui'
import { Contained } from '../src/renderer/contained.tsx'
import { defineUiExtension } from '../src/renderer/extension-api.ts'
import { createRegistry, profileScope } from '../src/renderer/registry.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const app = defineApp({ name: 'superego', id: 'superego' })
const profile = { scope: 'user' as const, name: 'chief', dir: '/home/me/.superego/profiles/chief' }
// The same profile, on this computer and on another machine, each bringing its own rule for one class.
const board = (css: string) => defineUiExtension({ name: 'board', setup: (superego) => { superego.style(css) } })

let root: Root | undefined
let container: HTMLElement
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); document.head.innerHTML = '' })

async function draw(...children: ReturnType<typeof h>[]) {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(h('div', null, ...children)))
}
const colour = (selector: string) => getComputedStyle(container.querySelector(selector)!).color
const within = (scope: string, children: ReturnType<typeof h>) => h(Contained, { name: 'board', scope, children })
const scoped = (scope: string, id: string) => within(scope, h('span', { id, className: 'board' }, id))

it("applies a profile's styles to what that profile draws, and to no other scope's", async () => {
  const registry = createRegistry(app, [], () => {})
  const here = profileScope('local', profile)
  const there = profileScope('box', profile)
  registry.installProfile('local', profile, [board('.board { color: rgb(0, 128, 0); font-weight: 700; }')])
  registry.installProfile('box', profile, [board('.board { color: rgb(255, 0, 0); }')])
  await draw(
    scoped(here, 'here'),
    scoped(there, 'there'),
    // Another profile's drawn inside this one's (a pane of another thread, say): its own, not the outer one's.
    within(here, scoped(there, 'nested')),
    h('span', { id: 'window', className: 'board' }, 'the window'),
  )
  expect(colour('#here')).toBe('rgb(0, 128, 0)')
  expect(colour('#there')).toBe('rgb(255, 0, 0)')
  expect(colour('#nested')).toBe('rgb(255, 0, 0)')
  expect(getComputedStyle(container.querySelector('#here')!).fontWeight).toBe('700')
  expect(getComputedStyle(container.querySelector('#nested')!).fontWeight).not.toBe('700')
  expect(colour('#window')).not.toMatch(/rgb\((0, 128, 0|255, 0, 0)\)/)
})

it("marks what a profile's UI portals out (a menu) with its scope, so its styles reach there", async () => {
  const scope = profileScope('box', profile)
  await draw(within(scope, h(Menu.Root, { open: true }, h(Menu.Trigger, null, 'Open'), h(Menu.Popup, null, h(Menu.Item, null, 'An item')))))
  const layer = document.querySelector('.superego-layer')!
  expect(container.contains(layer)).toBe(false)
  expect(layer.closest('[data-profile-scope]')?.getAttribute('data-profile-scope')).toBe(encodeURIComponent(scope))
})

it("leaves an app extension's styles the window's, and takes each away at its teardown", async () => {
  const registry = createRegistry(app, [defineUiExtension({ name: 'git', setup: (superego) => { superego.style('.git-chip { color: rgb(0, 0, 255); }') } })], () => {})
  registry.installProfile('box', profile, [board('.board { color: rgb(255, 0, 0); }')])
  await draw(h('span', { id: 'chip', className: 'git-chip' }), scoped(profileScope('box', profile), 'there'))
  expect(colour('#chip')).toBe('rgb(0, 0, 255)')
  expect(colour('#there')).toBe('rgb(255, 0, 0)')
  expect(document.head.querySelectorAll('style')).toHaveLength(2)
  // Installed again (its files changed): the old styles go with the old UI.
  registry.installProfile('box', profile, [])
  expect(colour('#there')).not.toBe('rgb(255, 0, 0)')
  registry.teardown()
  expect(colour('#chip')).not.toBe('rgb(0, 0, 255)')
  expect(document.head.querySelectorAll('style')).toHaveLength(0)
})

it('takes a style away early with the function it returns, and refuses one after teardown', () => {
  let remove: (() => void) | undefined
  let late: (() => void) | undefined
  const registry = createRegistry(app, [], () => {})
  registry.installProfile('box', profile, [defineUiExtension({ name: 'board', setup: (superego) => { remove = superego.style('.board {}'); late = () => superego.style('.late {}') } })])
  expect(document.head.querySelectorAll('style')).toHaveLength(1)
  remove!()
  expect(document.head.querySelectorAll('style')).toHaveLength(0)
  registry.installProfile('box', profile, [])
  expect(late).toThrow(/torn down/)
  expect(document.head.querySelectorAll('style')).toHaveLength(0)
})
