// A window's record in the main process: what its page leaves behind as it loads again or the window closes, and how a
// call on the app's endpoint finds its answer.
import { describe, expect, it, vi } from 'vitest'
import { createRouter, defineAction, obj, RpcError, str } from '@superego/protocol'
import { MemorySettingsStore, SettingsRegistry } from '@superego/settings'

vi.mock('electron', () => ({}))
const { AppWindow } = await import('../src/main/app-windows.ts')
const { appMethods, callApp } = await import('../src/main/app-endpoint.ts')
type AppWindow = InstanceType<typeof AppWindow>
type AppActionContext = import('../src/main/app-endpoint.ts').AppActionContext

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

function setUp() {
  const settings = new SettingsRegistry(new MemorySettingsStore())
  settings.register({ id: 'test', title: 'Test', settings: [{ key: 'test.on', title: 'On', default: false, type: { type: 'boolean' } }] })
  const router = createRouter<AppActionContext>()
  const notifier = { notify: vi.fn(), refreshBadge: vi.fn() }
  const sent: { method: string; params: unknown }[] = []
  const browser = { webContents: { isDestroyed: () => false, send: (_channel: string, event: { method: string; params: unknown }) => sent.push(event) } }
  const window = new AppWindow('w1', browser as never, (window) => appMethods(window, {
    settings, router, notifier,
    service: { state: { phase: 'current', busy: false, deferred: false } },
    machines: {} as never, windows: {} as never, desktop: {} as never,
  }))
  return { settings, router, notifier, sent, window }
}

/** A channel held for the window, as ipc.ts holds it. */
const held = (window: AppWindow, id = 'c1') => {
  const channel = { abort: vi.fn() }
  window.channels.set(id, { channel: channel as never, reads: [], start: () => {} })
  return channel
}

describe('a page loading again in a window', () => {
  it('stops the last page\'s settings watches', async () => {
    const { settings, sent, window } = setUp()
    await window.methods['settings.watch']({})
    await settings.set('test.on', true)
    await tick()
    expect(sent.filter((event) => event.method === 'settings.changed')).toHaveLength(1)
    window.pageLoaded()
    expect(window.subs.size).toBe(0)
    await settings.set('test.on', false)
    await tick()
    expect(sent.filter((event) => event.method === 'settings.changed')).toHaveLength(1)
  })

  it('holds what to show until the new page listens, keeping what already waited', async () => {
    const { sent, window } = setUp()
    window.show({ settings: true })
    expect(await window.methods['app.ready']()).toEqual({ settings: true })
    window.show({ open: { machine: 'local', thread: 't1' } })
    expect(sent.map((event) => event.method)).toEqual(['app.select'])
    window.pageLoaded()
    window.show({ open: { machine: 'local', thread: 't2' } })
    expect(sent).toHaveLength(1)
    // A page loading before the last one listened keeps what waited for it.
    window.pageLoaded()
    expect(await window.methods['app.ready']()).toEqual({ open: { machine: 'local', thread: 't2' } })
  })

  it('forgets what the last page said, and aborts its channels', async () => {
    const { window } = setUp()
    await window.methods['app.boundKeys']({ keys: ['mod+k'] })
    await window.methods['app.shown']({ selection: { machine: 'local', thread: 't1' } })
    const channel = held(window)
    const page = window.page
    window.pageLoaded()
    expect(window.boundKeys.size).toBe(0)
    expect(window.shown).toBeUndefined()
    expect(channel.abort).toHaveBeenCalledWith('The page loaded again')
    expect(window.page).toBe(page + 1)
    window.pageLoaded('The window closed')
    expect(window.page).toBe(page + 2)
  })
})

describe('a call on the app\'s endpoint', () => {
  it('is the window\'s own method first, then one of the app\'s actions, else unknown', async () => {
    const { router, window } = setUp()
    const ran = vi.fn()
    router.register(defineAction({ id: 'service.get', title: 'Shadowed', runs: 'app', run: () => 'action' }))
    router.register(defineAction({
      id: 'test.echo', title: 'Echo', runs: 'app', params: obj({ text: str() }),
      run: ({ text }, context) => { ran(context.window); return text },
    }))
    expect(await callApp(router, window, 'service.get', {})).toEqual({ phase: 'current', busy: false, deferred: false })
    expect(await callApp(router, window, 'test.echo', { text: 'hi' })).toBe('hi')
    expect(ran).toHaveBeenCalledWith(window)
    expect(router.log().at(-1)).toMatchObject({ id: 'test.echo', source: 'window', ok: true })
    expect(() => callApp(router, window, 'nothing.here', {})).toThrow(RpcError)
    expect(() => callApp(router, window, 'toString', {})).toThrow(/Unknown method toString/)
  })
})
