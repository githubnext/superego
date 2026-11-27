// run against a real daemon with Processes: a folder's .superego/run.json defined as its `run` process (idle until ⌃R),
// started and restarted by run.restart, its definition kept in step with the file, the agent pointed at it, stopped as
// the folder's last thread is archived, and started again after a restart of the machine if it was running.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { callTool, isRunning, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import { processesExtension } from '@superego/processes/daemon'
import type { ProcessInfo } from '@superego/processes/shared'
import { commandLine, findConfig, parseConfig } from '../src/config.ts'
import run from '../src/daemon.ts'

const processes = processesExtension({ shell: '/bin/sh', batching: { quietMs: 50, maxMs: 300 } })
const TICKER = "echo booting; sleep 0.3; printf '\\033[32mSTATUS:\\033[0mREADY\\n'; while true; do sleep 0.2; done"

let daemon: TestDaemon | undefined
const folders: string[] = []
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })))
})

async function folderWith(config: unknown): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'run-test-'))
  folders.push(folder)
  if (config !== undefined) {
    await mkdir(join(folder, '.superego'), { recursive: true })
    await writeFile(join(folder, '.superego', 'run.json'), typeof config === 'string' ? config : JSON.stringify(config))
  }
  return folder
}
const runOf = async (d: TestDaemon, folder: string) => (await d.call<ProcessInfo[]>('processes.list', { folder })).find((p) => p.name === 'run')

describe('config', () => {
  it('reads commands as arrays or strings, with ready, grace and env', () => {
    expect(parseConfig('{"command":["just","run"],"ready":"STATUS:READY","grace":2}')).toEqual({ command: 'just run', ready: 'STATUS:READY', grace: 2000, env: {} })
    expect(parseConfig('{"command":"npm run dev -- --port 3000","env":{"PORT":3000,"X":"y"}}'))
      .toEqual({ command: 'npm run dev -- --port 3000', ready: undefined, grace: 5000, env: { PORT: '3000', X: 'y' } })
    expect(commandLine(['echo', "it's", 'a b', '--x=1'])).toBe(`echo 'it'\\''s' 'a b' --x=1`)
  })

  it('says what is wrong', () => {
    expect(() => parseConfig('{')).toThrow(/isn't JSON/)
    expect(() => parseConfig('[]')).toThrow(/object/)
    expect(() => parseConfig('{"command":[]}')).toThrow(/command/)
    expect(() => parseConfig('{"command":"x","grace":"soon"}')).toThrow(/grace/)
    expect(() => parseConfig('{"command":"x","env":{"A":{}}}')).toThrow(/env.A/)
  })

  it('finds the nearest config up to the repository root', async () => {
    const root = await folderWith({ command: 'echo hi' })
    const deep = join(root, 'a', 'b')
    await mkdir(deep, { recursive: true })
    expect((await findConfig(deep))?.dir).toBe(root)
    await mkdir(join(root, 'a', '.git'))
    expect(await findConfig(deep)).toBeUndefined()
    await writeFile(join(root, '.superego', 'run.json'), '{"command": 3}')
    await expect(findConfig(root)).rejects.toThrow(/run.json "command"/)
  })
})

describe.skipIf(process.platform === 'win32')('run', () => {
  it("defines the folder's dev command, starts it with run.restart, and keeps it in step with the file", async () => {
    const folder = await folderWith({ command: TICKER, ready: 'STATUS:READY' })
    daemon = await testDaemon({ extensions: [processes, run], model: [callTool('process_logs', { id: 'run', lines: 5 }), say('Read it.')] })
    const thread = await daemon.thread(undefined, { cwd: folder })
    await daemon.until(async () => (await runOf(daemon!, folder))?.state === 'idle', 'defined, idle')
    expect(await runOf(daemon, folder)).toMatchObject({ owner: { folder }, command: TICKER, ready: 'STATUS:READY', keep: true, notify: 'failure', by: { extension: 'run' } })
    // Its thread lists it as its own.
    expect((await daemon.call<ProcessInfo[]>('processes.list', { thread: thread.id })).map((p) => p.name)).toEqual(['run'])

    const started = await daemon.dispatch<ProcessInfo>('run.restart', { thread: thread.id })
    expect(started.state).toBe('starting')
    await daemon.until(async () => (await runOf(daemon!, folder))?.state === 'running', 'ready')
    // The agent reads it by its name.
    await daemon.send(thread, 'What does the dev server say?')
    const [logs] = await daemon.toolCalls(thread)
    expect(logs!.result!.text).toContain('STATUS:READY')
    expect(await daemon.transcript(thread)).toContain("This folder's dev command is the process named `run`")

    // A restart starts it once more; the file changed, its next run runs the new command.
    await writeFile(join(folder, '.superego', 'run.json'), JSON.stringify({ command: 'echo changed; sleep 30' }))
    await daemon.until(async () => (await runOf(daemon!, folder))?.command === 'echo changed; sleep 30', 'the new command defined')
    const again = await daemon.dispatch<ProcessInfo>('run.restart', { thread: thread.id })
    expect(again).toMatchObject({ run: 2, state: 'running' })
    await daemon.dispatch('run.stop', { thread: thread.id })
    expect((await runOf(daemon, folder))?.state).toBe('exited')
  })

  it('says how to add a config where there is none', async () => {
    const folder = await folderWith(undefined)
    daemon = await testDaemon({ extensions: [processes, run] })
    const thread = await daemon.thread(undefined, { cwd: folder })
    await expect(daemon.dispatch('run.restart', { thread: thread.id })).rejects.toThrow(/No run config for .*Add \.superego\/run\.json/)
    expect(await runOf(daemon, folder)).toBeUndefined()
  })

  it("stops as the folder's last thread is archived, and comes back after a restart of the machine if it was running", async () => {
    const folder = await folderWith({ command: 'echo up; sleep 30' })
    daemon = await testDaemon({ extensions: [processes, run] })
    const first = await daemon.thread(undefined, { cwd: folder })
    const second = await daemon.thread(undefined, { cwd: folder })
    const up = await daemon.dispatch<ProcessInfo>('run.restart', { thread: first.id })
    await daemon.dispatch('thread.archive', { thread: first.id })
    expect(isRunning(up.pid!)).toBe(true)

    // The machine restarted: its pid is someone else's now. Taken back as gone, and, `keep`, started again.
    const file = join(daemon.dataDir, 'extensions', 'processes', 'processes.json')
    await daemon.restart({
      async whileStopped() {
        process.kill(-up.pid!, 'SIGKILL')
        const data = JSON.parse(await readFile(file, 'utf8')) as { processes: { pidStart?: string }[] }
        data.processes[0]!.pidStart = 'another process'
        await writeFile(file, JSON.stringify(data))
      },
    })
    await daemon.until(async () => (await runOf(daemon!, folder))?.run === 2, 'started again')
    const back = (await runOf(daemon, folder))!
    expect(back.state).toBe('running')

    const { notes } = await daemon.dispatch<{ notes: Record<string, string> }>('thread.archive', { thread: second.id })
    expect(notes.processes).toBe('stopped its process')
    expect(isRunning(back.pid!)).toBe(false)
  })
})
