// processes against a real daemon: the agent's tools, a report back when a build ends, archiving stopping a thread's
// processes, and processes outliving a daemon restart (still running, ended while it was away, or lost).
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { callTool, isRunning, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import { processesExtension } from '../src/daemon.ts'
import { LIST, type ProcessInfo } from '../src/shared.ts'

// A plain shell: the user's own startup files have no place in a test.
const processes = processesExtension({ shell: '/bin/sh', batching: { quietMs: 50, maxMs: 300 } })
const list = (daemon: TestDaemon, thread: string) => daemon.call<ProcessInfo[]>('processes.list', { thread })
/** Output as a test expects it: without what an interactive `sh` with no terminal says first. */
const plain = (text: string) => text.replace(/^.*no job control in this shell\n/gm, '')
const one = async (daemon: TestDaemon, thread: string) => (await list(daemon, thread))[0]!

describe.skipIf(process.platform === 'win32')('processes', () => {
  it('starts a build for the agent, and wakes the thread with how it ended', async () => {
    const daemon = await testDaemon({ extensions: [processes], model: [
      callTool('process_start', { command: 'echo building; echo "src/a.ts(1,2): error"; exit 3', name: 'build' }),
      say('Started it.'),
      say('It failed: a.ts.'),
    ] })
    const thread = await daemon.thread('Build it')
    const [started] = await daemon.toolCalls(thread)
    expect(started!.result).toMatchObject({ isError: false, text: expect.stringMatching(/^p_[0-9a-f]{8} build: (running|failed)/) })
    // The report comes as a message from processes, and the agent answers it.
    await daemon.until(async () => (await daemon.info(thread)).status.msg === 'It failed: a.ts.', 'the report answered', 10_000)
    const transcript = await daemon.transcript(thread)
    expect(transcript).toContain('From process [build](process:p_')
    expect(transcript).toContain('exited with 3 after')
    expect(transcript).toContain('src/a.ts(1,2): error')
    const build = await one(daemon, thread.id)
    expect(build).toMatchObject({ name: 'build', state: 'failed', exitCode: 3, owner: { thread: thread.id } })
    expect((await daemon.facts(thread)).processes).toEqual({ running: 0, starting: 0, failed: 1 })
    // Seen in the pane: no longer marked on the row.
    await daemon.dispatch('processes.seen', { id: build.id })
    await daemon.until(async () => (await daemon.facts(thread)).processes === undefined, 'the mark gone')
    await daemon.close()
  })

  it('waits for a server to be ready, keeps it running after the turn, and stops it as its thread is archived', async () => {
    const daemon = await testDaemon({ extensions: [processes], model: [
      callTool('process_start', { command: 'echo booting; sleep 0.2; echo "ready in 5ms"; sleep 30', name: 'dev', ready: 'ready in', wait: 10 }),
      callTool('process_logs', { id: 'dev', lines: 5 }),
      say('Up.'),
    ] })
    const thread = await daemon.thread('Serve it')
    const [started, logs] = await daemon.toolCalls(thread)
    expect(started!.result!.text).toMatch(/dev: running, pid \d+/)
    expect(plain(started!.result!.text)).toMatch(/ready:\nbooting\nready in 5ms/)
    expect(logs!.result!.text).toContain('ready in 5ms')
    const watched = await daemon.watch<ProcessInfo[]>(LIST, { scope: thread.id })
    const dev = await watched.until((l) => l[0]?.state === 'running')
    expect(isRunning(dev[0]!.pid!)).toBe(true)
    expect((await daemon.facts(thread)).processes).toEqual({ running: 1, starting: 0, failed: 0 })
    const { notes } = await daemon.dispatch<{ notes: Record<string, string> }>('thread.archive', { thread: thread.id })
    expect(notes.processes).toBe('stopped its process')
    expect(isRunning(dev[0]!.pid!)).toBe(false)
    const [stopped] = await daemon.call<ProcessInfo[]>('processes.list', { all: true })
    expect(stopped).toMatchObject({ state: 'exited', stopped: true })
    await daemon.close()
  })

  it('reads its output from a position, past a rotation, with its runs set apart', async () => {
    const daemon = await testDaemon({ extensions: [processes] })
    const thread = await daemon.thread()
    const started = await daemon.dispatch<ProcessInfo>('processes.start', { thread: thread.id, command: 'echo one', name: 'x' })
    await daemon.call('processes.wait', { id: started.id, for: 'exit', timeout: 10 })
    await daemon.dispatch('processes.restart', { id: started.id })
    const done = await daemon.call<{ outcome: string; process: ProcessInfo }>('processes.wait', { id: started.id, for: 'exit', timeout: 10 })
    expect(done).toMatchObject({ outcome: 'exited', process: { run: 2, state: 'exited', exitCode: 0 } })
    const all = await daemon.call<{ text: string; from: number; start: number }>('processes.read', { id: started.id, since: 0, plain: true })
    expect(plain(all.text)).toMatch(/^one\n── done in \d+s ──\n\n── run 2 · \d\d:\d\d ──\none\n── done in \d+s ──$/)
    const run = await daemon.call<{ text: string }>('processes.read', { id: started.id, lines: 5 })
    expect(plain(run.text)).toMatch(/^one\n── done in \d+s ──$/)
    await daemon.close()
  })

  it('takes its processes back after the daemon restarts: one still running, one that ended meanwhile, one gone', async () => {
    const daemon = await testDaemon({ extensions: [processes], model: [say('ok'), say('Noted the failure.')] })
    const thread = await daemon.thread('hi')
    const server = await daemon.dispatch<ProcessInfo>('processes.start', { thread: thread.id, command: 'echo up; sleep 30', name: 'server', notify: 'failure' })
    const build = await daemon.dispatch<ProcessInfo>('processes.start', { thread: thread.id, command: 'sleep 1; echo broke; exit 2', name: 'build' })
    const gone = await daemon.dispatch<ProcessInfo>('processes.start', { thread: thread.id, command: 'sleep 30', name: 'gone', keep: true, owner: { folder: thread.cwd } })
    const file = join(daemon.dataDir, 'extensions', 'processes', 'processes.json')
    await daemon.restart({
      model: [say('Noted the failure.')],
      async whileStopped() {
        // The build ends while no daemon runs; the third's pid is taken as gone (as after a reboot): its start time no
        // longer matches.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const data = JSON.parse(await readFile(file, 'utf8')) as { processes: { id: string; pidStart?: string; pid?: number }[] }
        const third = data.processes.find((p) => p.id === gone.id)!
        process.kill(-third.pid!, 'SIGKILL')
        third.pidStart = 'another process'
        await writeFile(file, JSON.stringify(data))
      },
    })
    await daemon.until(async () => (await list(daemon, thread.id)).every((p) => p.state !== 'starting'), 'adopted')
    const byName = async () => Object.fromEntries((await list(daemon, thread.id)).map((p) => [p.name, p]))
    // Still running: the same process.
    expect((await byName()).server).toMatchObject({ state: 'running', pid: server.pid })
    // Ended meanwhile: its exit file said how, and the thread hears of it.
    expect((await byName()).build).toMatchObject({ state: 'failed', exitCode: 2, whileAway: true })
    await daemon.until(async () => (await daemon.transcript(thread)).includes('while Superego was stopped'), 'the report', 10_000)
    // Gone, and `keep`: started again.
    await daemon.until(async () => (await byName()).gone?.run === 2, 'started again')
    expect((await byName()).gone).toMatchObject({ state: 'running' })
    await daemon.dispatch('processes.stop', { id: server.id })
    await daemon.dispatch('processes.stop', { id: gone.id })
    expect(isRunning(server.pid!)).toBe(false)
    await daemon.close()
  })

  it("refuses a second of the same name while it runs, and keeps it when asked to", async () => {
    const daemon = await testDaemon({ extensions: [processes] })
    const thread = await daemon.thread()
    const first = await daemon.dispatch<ProcessInfo>('processes.start', { thread: thread.id, command: 'sleep 30', name: 'w' })
    await expect(daemon.dispatch('processes.start', { thread: thread.id, command: 'sleep 30', name: 'w' })).rejects.toThrow(/running already/)
    expect(await daemon.dispatch<ProcessInfo>('processes.start', { thread: thread.id, command: 'sleep 30', name: 'w', ifRunning: 'keep' })).toMatchObject({ id: first.id, pid: first.pid })
    await daemon.dispatch('processes.stop', { thread: thread.id, name: 'w' })
    await daemon.dispatch('processes.remove', { id: first.id })
    expect(await list(daemon, thread.id)).toEqual([])
    await daemon.close()
  })
})
