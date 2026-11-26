// terminal's daemon half against a real daemon, over its socket: a pane's shell started by attaching, typed to, read
// back, resized, attached again with its scrollback, reporting status (OSC 7501), stopped as its pane closes, its
// thread is archived, or it exits; and a program in it resumed as the daemon starts again (OSC 7577).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Channels, type Pane, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { testDaemon, type TestDaemon } from '@superego/sdk/testing'
import { terminalExtension } from '../src/daemon.ts'
import { Framing, IO, RESIZE, RUN } from '../src/shared.ts'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** A daemon with terminals of a plain `bash` (none of the machine's startup files); its `until` waits up to 10s for what a shell does. */
async function open() {
  const daemon = await testDaemon({ extensions: [terminalExtension({ shell: () => ({ file: '/bin/bash', args: ['--norc', '--noprofile'] }) })] })
  until = (check, what) => daemon.until(check, what, 10_000)
  return daemon
}
let until: TestDaemon['until']

/** A window's end of a terminal: what it was replayed, what came after, and typing. */
async function attach(peer: RpcPeer, thread: string, pane: string, size = { cols: 80, rows: 24 }) {
  const channel = await Channels.of(peer).open(IO, { thread, pane, ...size })
  const decoder = new TextDecoder()
  const framing = new Framing()
  const seen = { replayed: '', live: '' }
  channel.onData((bytes) => {
    const { replayed, live } = framing.split(bytes)
    seen.replayed += decoder.decode(replayed)
    seen.live += decoder.decode(live)
  })
  return {
    seen, channel,
    type: (text: string) => channel.write(new TextEncoder().encode(text)),
    // Timed out, it says what the shell did print.
    waitFor: (text: string) => until(() => seen.live.includes(text), JSON.stringify(text)).catch((error: Error) => {
      throw new Error(`${error.message}; the terminal showed ${JSON.stringify(seen.replayed + seen.live)}`)
    }),
    /** Waits for `text` in what it was replayed too: said as the shell started, before the window attached. */
    shows: (text: string) => until(() => (seen.replayed + seen.live).includes(text), JSON.stringify(text)).catch((error: Error) => {
      throw new Error(`${error.message}; the terminal showed ${JSON.stringify(seen.replayed + seen.live)}`)
    }),
  }
}

async function terminalPane(peer: RpcPeer, cwd: string, params?: unknown) {
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd })
  const pane = await peer.call<Pane>('pane.open', { thread: thread.id, kind: 'terminal', ...(params ? { params } : {}) })
  return { thread: thread.id, pane: pane.id }
}

it('starts a shell in the thread\'s folder as a window attaches, and passes typing and output both ways', async () => {
  const daemon = await open()
  const { peer } = daemon
  expect(daemon.extensions.map((e) => e.name)).toContain('terminal')
  const dir = daemon.dataDir
  const { thread, pane } = await terminalPane(peer, dir)
  const term = await attach(peer, thread, pane)
  await term.type('echo "hi-$((40+2))"; pwd; echo "$TERM $ELECTRON_RUN_AS_NODE."\n')
  await term.waitFor('hi-42')
  await term.waitFor(dir.replace(/^\/private/, ''))
  await term.waitFor('xterm-256color .')
  // Resized: the shell sees its new size.
  await peer.call(RESIZE, { thread, pane, cols: 100, rows: 30 })
  await term.type('stty size\n')
  await term.waitFor('30 100')
  await daemon.close()
})

it('keeps the shell while no window is attached, and replays what it printed to the next one', async () => {
  const daemon = await open()
  const first = await daemon.connect()
  const { thread, pane } = await terminalPane(first.peer, daemon.dataDir)
  const term = await attach(first.peer, thread, pane)
  await term.type('echo "pid=$$"; echo "before-$((1+1))"\n')
  await term.waitFor('before-2')
  const pid = Number(/pid=(\d+)/.exec(term.seen.live)![1])
  // The window goes (a reload): the shell stays, and keeps going.
  first.close()
  // Another client attaches: it's replayed the scrollback, then sees what's new, from the same shell.
  const again = await attach(daemon.peer, thread, pane)
  await until(() => again.seen.replayed.includes('before-2'), 'the scrollback')
  await again.type('echo "still=$$"; echo "after-$((2+1))"\n')
  await again.waitFor('after-3')
  expect(again.seen.live).toContain(`still=${pid}`)
  expect(again.seen.replayed).not.toContain('after-3')
  await daemon.close()
  await until(() => !alive(pid), 'the shell to stop with the daemon')
})

it('stops the shell when its pane closes or its thread is archived', async () => {
  const daemon = await open()
  const { peer } = daemon
  const pidOf = async (thread: string, pane: string) => {
    const term = await attach(peer, thread, pane)
    await term.type('echo "pid=$$"\n')
    await until(() => /pid=\d+/.test(term.seen.live), 'its pid')
    return Number(/pid=(\d+)/.exec(term.seen.live)![1])
  }
  const closing = await terminalPane(peer, daemon.dataDir)
  const one = await pidOf(closing.thread, closing.pane)
  await peer.call('pane.close', { thread: closing.thread, pane: closing.pane })
  await until(() => !alive(one), 'the shell to stop as its pane closed')
  await expect(Channels.of(peer).open(IO, { thread: closing.thread, pane: closing.pane })).rejects.toThrow(/No terminal pane/)

  const archiving = await terminalPane(peer, daemon.dataDir)
  const two = await pidOf(archiving.thread, archiving.pane)
  const other = await peer.call<Pane>('pane.open', { thread: archiving.thread, kind: 'terminal', params: { n: 2 } })
  const three = await pidOf(archiving.thread, other.id)
  expect(three).not.toBe(two)
  await peer.call('thread.archive', { thread: archiving.thread })
  await until(() => !alive(two) && !alive(three), 'both shells to stop as the thread was archived')
  await daemon.close()
})

it('closes the pane when its shell exits cleanly, and starts it again on a key otherwise', async () => {
  const daemon = await open()
  const { peer } = daemon
  const { thread, pane } = await terminalPane(peer, daemon.dataDir)
  const term = await attach(peer, thread, pane)
  await term.type('exit 3\n')
  await term.waitFor('Exited with 3')
  await term.type('x')
  await term.type('echo "back-$((5+5))"\n')
  await term.waitFor('back-10')
  await term.type('exit\n')
  const panes = async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread)!.panes ?? []
  await until(async () => (await panes()).length === 0, 'the pane to close')
  await daemon.close()
})

it("reports what a program in it says (OSC 7501), and a blocked one blocks its thread", async () => {
  const daemon = await open()
  const { peer } = daemon
  const { thread, pane } = await terminalPane(peer, daemon.dataDir)
  expect((await daemon.watch('terminal.status', { scope: thread })).value).toEqual({})
  const term = await attach(peer, thread, pane)
  const msg = Buffer.from('Allow rm?').toString('base64')
  await term.type(`printf '\\033]7501;state=blocked:kind=permission:app=demo:msg=${msg}\\007'\n`)
  const status = async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread)!.status
  await until(async () => (await status()).state === 'blocked', 'the thread to be blocked')
  expect(await status()).toMatchObject({ state: 'blocked', kind: 'permission', msg: 'Allow rm?' })
  await term.type(`printf '\\033]7501;state=clear\\033\\\\'\n`)
  await until(async () => (await status()).state !== 'blocked', 'the thread to be unblocked')
  await daemon.close()
})

it("runs a program a window asks for in a pane of its own, in the user's shell, closing it as the program exits cleanly", async () => {
  const daemon = await open()
  const { peer } = daemon
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: daemon.dataDir })
  const pane = await peer.call<Pane>('action.run', { id: RUN, params: { thread: thread.id, command: ['/bin/echo', "it's", 'run-$((1+1))'] } })
  expect(pane).toMatchObject({ kind: 'terminal', title: 'echo', params: { n: 1 } })
  const term = await attach(peer, thread.id, pane.id)
  // Its words as given: quoted, not read by the shell.
  await term.waitFor("it's run-$((1+1))")
  await until(async () => !(await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)!.panes?.length, 'the pane to close')
  // A window's only: not the command line's, nor an outside agent's.
  expect((await peer.call<{ id: string }[]>('action.list', { exposure: 'cli' })).map((a) => a.id)).not.toContain(RUN)
  // A terminal pane opened otherwise is a shell, whatever its params say.
  const shell = await peer.call<Pane>('pane.open', { thread: thread.id, kind: 'terminal', params: { run: ['/bin/echo', 'nope'], command: ['/bin/echo', 'nope'] } })
  const plain = await attach(peer, thread.id, shell.id)
  await plain.type('echo "shell-$((2+2))"\n')
  await plain.waitFor('shell-4')
  await daemon.close()
})

/** What the daemon keeps to resume, by `<thread>/<pane>`. */
const kept = (daemon: TestDaemon): Record<string, { argv: string[]; cwd?: string; first?: boolean }> => {
  const file = join(daemon.dataDir, 'extensions', 'terminal', 'resume.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

/**
 * A program that reports how to resume it (OSC 7577, as the spec's resume-wrap does: its own path, its arguments, and
 * where it is), unless there's a `quiet` beside it, says what it was given, and stays.
 */
function holder(daemon: TestDaemon) {
  const dir = join(daemon.dataDir, 'bin')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'hold')
  writeFileSync(file, `#!/bin/sh
printf 'holding'; printf ' [%s]' "$@"; printf ' in %s\\n' "$PWD"
if [ -n "$OSC7577_TOKEN" ] && [ ! -e "$(dirname "$0")/quiet" ]; then
  args=$(for a in "$0" "$@"; do printf '%s' "$a" | base64 | tr -d '\\n'; echo; done | paste -sd, -)
  body=$(printf 'pid=%s:time=%s:argv=%s:cwd=%s' "$$" "$(date +%s)" "$args" "$(printf '%s' "$PWD" | base64 | tr -d '\\n')")
  mac=$(printf '%s:%s' "$body" "$OSC7577_TOKEN" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64)
  printf '\\033]7577;%s:mac=%s\\033\\\\' "$body" "$mac"
fi
exec sleep 600
`)
  chmodSync(file, 0o755)
  return { file, quiet: (on: boolean) => on ? writeFileSync(join(dir, 'quiet'), '') : rmSync(join(dir, 'quiet'), { force: true }) }
}

it("gives each shell a token of its own (OSC 7577), never the daemon's", async () => {
  const before = process.env.OSC7577_TOKEN
  process.env.OSC7577_TOKEN = 'the-daemons-own-token-not-to-pass-on'
  try {
    const daemon = await open()
    const tokens = []
    for (const n of [1, 2]) {
      const { thread, pane } = await terminalPane(daemon.peer, daemon.dataDir, n > 1 ? { n } : undefined)
      const term = await attach(daemon.peer, thread, pane)
      await term.type('echo "token=$OSC7577_TOKEN."\n')
      await until(() => /token=[A-Za-z0-9_-]{32}\./.test(term.seen.live), 'its token')
      tokens.push(/token=([A-Za-z0-9_-]{32})\./.exec(term.seen.live)![1])
    }
    expect(tokens[0]).not.toBe(tokens[1])
    expect(tokens).not.toContain('the-daemons-own-token-not-to-pass-on')
    await daemon.close()
  } finally {
    if (before === undefined) delete process.env.OSC7577_TOKEN
    else process.env.OSC7577_TOKEN = before
  }
})

it('resumes what a program said would bring it back as the daemon starts again, its words as given, once', async () => {
  const daemon = await open()
  const hold = holder(daemon)
  const work = join(daemon.dataDir, 'work dir')
  mkdirSync(work, { recursive: true })
  const { thread, pane } = await terminalPane(daemon.peer, daemon.dataDir)
  const key = `${thread}/${pane}`
  const term = await attach(daemon.peer, thread, pane)
  await term.type(`cd '${work}' && '${hold.file}' 'a b' '$(echo nope)' '' "it's"\n`)
  await term.waitFor(`holding [a b] [$(echo nope)] [] [it's] in ${work}`)
  await until(() => Boolean(kept(daemon)[key]), 'what resumes it to be kept')
  expect(kept(daemon)[key]).toEqual({ argv: [hold.file, 'a b', '$(echo nope)', '', "it's"], cwd: work, uid: process.getuid!() })
  expect(statSync(join(daemon.dataDir, 'extensions', 'terminal', 'resume.json')).mode & 0o777).toBe(0o600)

  // Stopping keeps it; it's brought back as the pane is attached to again, in the shell (back at its prompt after).
  await daemon.restart()
  expect(kept(daemon)[key]).toBeDefined()
  const again = await attach(daemon.peer, thread, pane)
  await again.shows(`Resuming ${hold.file} 'a b' '$(echo nope)' '' 'it\\'s'`)
  await again.shows(`holding [a b] [$(echo nope)] [] [it's] in ${work}`)
  // It said so again as it started, so it's kept again.
  await until(() => Boolean(kept(daemon)[key]), 'it to be kept again')
  await again.type('\x03')
  await again.type('echo "prompt-$((3+3))"; pwd\n')
  await again.waitFor('prompt-6')

  // Once: one that doesn't say so again isn't brought back after the next start.
  hold.quiet(true)
  await daemon.restart()
  const third = await attach(daemon.peer, thread, pane)
  await third.shows(`holding [a b]`)
  await until(() => !kept(daemon)[key], 'it to be forgotten')
  await daemon.restart()
  const fourth = await attach(daemon.peer, thread, pane)
  await fourth.type('echo "plain-$((4+4))"\n')
  await fourth.waitFor('plain-8')
  expect(fourth.seen.replayed + fourth.seen.live).not.toContain('Resuming')
  await daemon.close()
})

it("doesn't resume one whose folder is gone, and forgets what a closed pane, an archived thread or an exited shell had", async () => {
  const daemon = await open()
  const hold = holder(daemon)
  const report = async (pane: { thread: string; pane: string }, where = daemon.dataDir) => {
    const term = await attach(daemon.peer, pane.thread, pane.pane)
    await term.type(`cd '${where}' && '${hold.file}' x &\n`)
    await term.waitFor('holding [x]')
    await until(() => Boolean(kept(daemon)[`${pane.thread}/${pane.pane}`]), 'what resumes it to be kept')
    return term
  }
  const gone = join(daemon.dataDir, 'gone')
  mkdirSync(gone)
  const moved = await terminalPane(daemon.peer, daemon.dataDir)
  await report(moved, gone)
  await daemon.restart({ whileStopped: () => rmSync(gone, { recursive: true }) })
  const term = await attach(daemon.peer, moved.thread, moved.pane)
  await term.shows(`Not resuming ${hold.file} x: ${gone} is gone`)
  await term.type('echo "shell-$((1+1))"\n')
  await term.waitFor('shell-2')
  expect(kept(daemon)[`${moved.thread}/${moved.pane}`]).toBeUndefined()

  const closing = await terminalPane(daemon.peer, daemon.dataDir)
  await report(closing)
  await daemon.peer.call('pane.close', { thread: closing.thread, pane: closing.pane })
  expect(kept(daemon)[`${closing.thread}/${closing.pane}`]).toBeUndefined()

  // Archived after the daemon started again, before the pane was attached to.
  const archiving = await terminalPane(daemon.peer, daemon.dataDir)
  await report(archiving)
  await daemon.restart()
  expect(kept(daemon)[`${archiving.thread}/${archiving.pane}`]).toBeDefined()
  await daemon.peer.call('thread.archive', { thread: archiving.thread })
  expect(kept(daemon)[`${archiving.thread}/${archiving.pane}`]).toBeUndefined()

  const exiting = await terminalPane(daemon.peer, daemon.dataDir)
  const shell = await report(exiting)
  // Its program ended with it (not left behind, as a shell exiting leaves what it ran in the background).
  await shell.type('kill %1; exit 3\n')
  await shell.waitFor('Exited with 3')
  expect(kept(daemon)[`${exiting.thread}/${exiting.pane}`]).toBeUndefined()
  await daemon.close()
})

it('resumes a program a window ran as the first process again', async () => {
  const daemon = await open()
  const hold = holder(daemon)
  const thread = await daemon.peer.call<ThreadInfo>('thread.start', { cwd: daemon.dataDir })
  const pane = await daemon.peer.call<Pane>('action.run', { id: RUN, params: { thread: thread.id, command: [hold.file, 'first one'] } })
  const term = await attach(daemon.peer, thread.id, pane.id)
  await term.waitFor('holding [first one]')
  await until(() => Boolean(kept(daemon)[`${thread.id}/${pane.id}`]), 'what resumes it to be kept')
  expect(kept(daemon)[`${thread.id}/${pane.id}`]).toMatchObject({ argv: [hold.file, 'first one'], first: true })
  await daemon.restart()
  const again = await attach(daemon.peer, thread.id, pane.id)
  await again.shows('holding [first one]')
  await daemon.close()
})
