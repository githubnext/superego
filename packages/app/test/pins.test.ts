// Pins (renderer/pins.ts): pinning, unpinning, moving a pin, and a thread no longer listed (archived) leaving them.
import { expect, it } from 'vitest'
import type { Status, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../src/shared/bridge.ts'
import { isPinned, pinAt, pinsOf, stillListed, unpin } from '../src/renderer/pins.ts'

const a = { machine: 'local', thread: 'a' }
const b = { machine: 'local', thread: 'b' }
const c = { machine: 'box', thread: 'a' }

it('pins last, moves a pin, and unpins', () => {
  const pins = pinAt(pinAt(pinAt([], a), b), c)
  expect(pins).toEqual([a, b, c])
  expect(isPinned(pins, { machine: 'box', thread: 'a' })).toBe(true)
  expect(isPinned(pins, { machine: 'box', thread: 'b' })).toBe(false)
  // Pinned again: kept once, where it was, unless moved.
  expect(pinAt(pins, b)).toEqual([a, c, b])
  expect(pinAt(pins, c, 0)).toEqual([c, a, b])
  expect(pinAt(pins, a, 99)).toEqual([b, c, a])
  expect(unpin(pins, b)).toEqual([a, c])
  expect(unpin(pins, { machine: 'box', thread: 'b' })).toEqual(pins)
  expect(pinsOf(undefined)).toEqual([])
})

it('lets go of the pins of threads no longer listed, only where the list is known', () => {
  const machine = (id: string, state: MachineEntry['state'] = 'connected'): MachineEntry => ({ id, label: id, state })
  const thread = (id: string): ThreadInfo => ({ id, title: id, cwd: '/x', createdAt: 0, activeAt: 0, project: { root: '/x', name: 'x' }, status: { state: 'idle' as Status['state'] } })
  const pins = [a, b, c]
  // b archived: no longer in its machine's list.
  expect(stillListed(pins, [machine('local'), machine('box')], { local: [thread('a')], box: [thread('a')] })).toEqual([a, c])
  // The box off, or its threads not heard yet: its pins stay.
  expect(stillListed(pins, [machine('local'), machine('box', 'disconnected')], { local: [thread('a'), thread('b')], box: [] })).toEqual(pins)
  expect(stillListed(pins, [machine('local'), machine('box')], { local: [thread('a'), thread('b')] })).toEqual(pins)
})
