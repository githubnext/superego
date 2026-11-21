// How many Claude Agent turns run at once: the rest wait, oldest first, saying so, and a stopped one stops waiting.
import { expect, it } from 'vitest'
import { Parallel } from '../src/parallel.ts'

it('lets as many run as the limit says, the rest waiting their turn, oldest first', async () => {
  let limit = 2
  let changes = 0
  const parallel = new Parallel(() => limit, () => { changes++ })
  const started: string[] = []
  const run = (thread: string, signal = new AbortController().signal) => parallel.take(thread, signal).then((release) => { started.push(thread); return release })
  const a = await run('a')
  const b = await run('b')
  const c = run('c')
  const d = run('d')
  await Promise.resolve()
  expect(started).toEqual(['a', 'b'])
  expect(parallel.waitingFor('c')).toBe('Waiting: 2 Claude Agent threads are running')
  expect(parallel.waitingFor('a')).toBeUndefined()
  a()
  a() // Again: nothing.
  expect(await c).toBeTypeOf('function')
  expect(started).toEqual(['a', 'b', 'c'])
  expect(parallel.waitingFor('d')).toBe('Waiting: 2 Claude Agent threads are running')
  // Raising the limit starts what waits.
  limit = 3
  parallel.pump()
  await d
  expect(started).toEqual(['a', 'b', 'c', 'd'])
  expect(changes).toBeGreaterThan(0)
  b()
})

it('stops waiting when its turn is stopped, and says one thread is running in the singular', async () => {
  const parallel = new Parallel(() => 1, () => {})
  const first = await parallel.take('a', new AbortController().signal)
  const stop = new AbortController()
  const waiting = parallel.take('b', stop.signal)
  expect(parallel.waitingFor('b')).toBe('Waiting: 1 Claude Agent thread is running')
  stop.abort(new Error('Stopped'))
  await expect(waiting).rejects.toThrow('Stopped')
  expect(parallel.waitingFor('b')).toBeUndefined()
  // Its place isn't taken: the next one after the first gets it.
  first()
  const next = await parallel.take('c', new AbortController().signal)
  expect(next).toBeTypeOf('function')
})
