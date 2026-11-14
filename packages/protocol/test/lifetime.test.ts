// One owned lifetime, as both halves of an extension use it: exhaustive, exception-safe disposal, a signal, and nothing
// registered or published after it ends.
import { expect, it, vi } from 'vitest'
import { Lifetime } from '../src/lifetime.ts'

it('runs every disposer, last first, whatever one throws; reports the failures; and a second dispose does nothing', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const life = new Lifetime('Extension x')
  const ran: string[] = []
  life.add(() => ran.push('first'))
  life.add(() => { throw new Error('broken') })
  life.add(() => ran.push('last'))
  const failures = life.dispose()
  expect(ran).toEqual(['last', 'first'])
  expect(failures).toHaveLength(1)
  expect(error).toHaveBeenCalledWith('Extension x: a cleanup failed', expect.any(Error))
  expect(life.dispose()).toEqual([])
  expect(ran).toEqual(['last', 'first'])
  error.mockRestore()
})

it('aborts its signal before the disposers run, and refuses what comes after', () => {
  const life = new Lifetime('Extension x')
  let abortedFirst = false
  life.add(() => { abortedFirst = life.signal.aborted })
  life.dispose()
  expect(abortedFirst).toBe(true)
  expect(() => life.add(() => {}, 'the method x.late')).toThrow("Extension x is torn down: it can't register the method x.late now")
})

it('makes guarded work a no-op once it ends, warning once', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const life = new Lifetime('Extension x')
  const seen: number[] = []
  const set = life.guard('a change to x.value', (n: number) => { seen.push(n) })
  set(1)
  life.dispose()
  set(2)
  set(3)
  expect(seen).toEqual([1])
  expect(warn).toHaveBeenCalledTimes(1)
  warn.mockRestore()
})

it('keeps a listener on its signal that throws apart: logged with whose it is, the others still told', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const uncaught = vi.fn()
  process.on('uncaughtException', uncaught)
  const life = new Lifetime('Extension x')
  const heard: string[] = []
  life.signal.addEventListener('abort', () => { throw new Error('listener broke') })
  life.signal.onabort = () => { throw new Error('onabort broke') }
  life.signal.addEventListener('abort', () => heard.push('after'))
  const gone = () => heard.push('removed')
  life.signal.addEventListener('abort', gone)
  life.signal.removeEventListener('abort', gone)
  life.dispose()
  expect(heard).toEqual(['after'])
  expect(error).toHaveBeenCalledWith('Extension x: a listener on its signal failed', expect.objectContaining({ message: 'listener broke' }))
  expect(error).toHaveBeenCalledWith('Extension x: a listener on its signal failed', expect.objectContaining({ message: 'onabort broke' }))
  return new Promise<void>((resolve) => setTimeout(() => {
    process.off('uncaughtException', uncaught)
    expect(uncaught).not.toHaveBeenCalled()
    error.mockRestore()
    resolve()
  }, 10))
})
