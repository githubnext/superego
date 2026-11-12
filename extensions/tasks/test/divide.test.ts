import { expect, it } from 'vitest'
import type { WorkBlock } from '@superego/app/ui'
import { divide } from '../src/divide.ts'

const call = (id: string, name: string, args: Record<string, unknown> = {}): WorkBlock => ({ type: 'toolCall', id, name, arguments: args })
const start = (id: string, title: string) => call(id, 'task_start', { title })
const finish = (id: string, task_id: string, status: string, outcome: string) => call(id, 'task_finish', { task_id, status, outcome })
const think = (thinking: string): WorkBlock => ({ type: 'thinking', thinking })
const run = (blocks: WorkBlock[], active = false, failed: string[] = []) =>
  divide({ blocks, active, result: (id) => failed.includes(id) ? { text: 'no', isError: true } : { text: 'ok', isError: false } })

it('leaves runs without tasks to the core', () => {
  expect(run([call('r', 'read'), call('b', 'bash')])).toBeUndefined()
})

it('folds work under the task it was done for, without the reporting calls', () => {
  expect(run([
    think('plan'), start('s1', 'Reading up on billing'), call('r', 'read'), finish('f1', 's1', 'success', 'Found it'),
    call('b', 'bash'),
  ])).toEqual([
    { title: 'Reading up on billing', status: 'success', outcome: 'Found it', blocks: [think('plan'), call('r', 'read')] },
    { blocks: [call('b', 'bash')] },
  ])
})

it('runs while its run does, and is cut off when it ends or the next starts unfinished', () => {
  expect(run([start('s1', 'One'), call('r', 'read')], true)).toMatchObject([{ title: 'One', status: 'running' }])
  expect(run([start('s1', 'One'), call('r', 'read')], false)).toMatchObject([{ title: 'One', status: 'interrupted' }])
  expect(run([start('s1', 'One'), start('s2', 'Two')], true)).toMatchObject([{ title: 'One', status: 'interrupted' }, { title: 'Two', status: 'running' }])
})

it('shows failed reporting calls as the steps they were', () => {
  expect(run([start('s1', 'One'), call('r', 'read'), finish('f1', 'nope', 'bogus', 'x')], true, [])).toMatchObject([
    { title: 'One', status: 'running', blocks: [call('r', 'read'), finish('f1', 'nope', 'bogus', 'x')] },
  ])
  expect(run([start('s1', 'One')], false, ['s1'])).toEqual([{ blocks: [start('s1', 'One')] }])
})

it('ends a task started in an earlier run by its outcome', () => {
  expect(run([call('r', 'read'), finish('f1', 'old', 'failure', 'Could not reproduce')])).toEqual([
    { blocks: [call('r', 'read')] },
    { title: 'Could not reproduce', status: 'failure', blocks: [] },
  ])
})
