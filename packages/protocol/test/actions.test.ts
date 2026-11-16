import { describe, expect, it } from 'vitest'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { createRouter, defineAction } from '../src/index.ts'

describe('Router', () => {
  const router = createRouter<{ who: string }>({ logSize: 3 })
  const seen: unknown[] = []
  router.register(defineAction({
    id: 'thread.rename', title: 'Rename', runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ thread: str(), title: str({ minLength: 1 }), times: opt(int()) }),
    run: (params, context: { who: string }) => { seen.push([params, context.who]); return 'ok' },
  }))

  it('validates, coerces and runs, with the context', async () => {
    expect(await router.dispatch('thread.rename', { thread: '2', title: 'x', times: '3' }, { who: 'test' })).toBe('ok')
    expect(seen.at(-1)).toEqual([{ thread: '2', title: 'x', times: 3 }, 'test'])
  })

  it('refuses bad params, unknown actions and the wrong exposure, and logs every attempt', async () => {
    await expect(router.dispatch('thread.rename', { thread: '2', title: '' }, { who: 't' })).rejects.toMatchObject({ kind: 'invalid_params' })
    await expect(router.dispatch('nope.nope', {}, { who: 't' })).rejects.toMatchObject({ kind: 'unknown_action' })
    await expect(router.dispatch('thread.rename', { thread: '2', title: 'y' }, { who: 't' }, { exposure: 'outside' })).rejects.toMatchObject({ kind: 'not_exposed' })
    const log = router.log()
    expect(log).toHaveLength(3)
    expect(log.map((e) => [e.id, e.ok])).toEqual([['thread.rename', false], ['nope.nope', false], ['thread.rename', false]])
  })

  it('lists actions as data, by exposure, and refuses duplicate or badly named ids', () => {
    expect(router.list('cli').map((a) => a.id)).toEqual(['thread.rename'])
    expect(router.list('outside')).toEqual([])
    expect('run' in router.list()[0]!).toBe(false)
    expect(() => router.register(defineAction({ id: 'thread.rename', title: 'x', runs: 'window', run: () => {} }))).toThrow(/already/)
    expect(() => router.register(defineAction({ id: 'Bad', title: 'x', runs: 'window', run: () => {} }))).toThrow(/dotted/)
  })
})
