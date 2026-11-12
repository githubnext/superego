// node app/native/smoke.ts — real compiled daemon, Node client, hidden system WebKit.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { connectSocket } from '../../packages/daemon/src/server.ts'
import { PROTOCOL_VERSION, type ThreadInfo } from '../../packages/protocol/src/index.ts'

const home = await mkdtemp(join(tmpdir(), 'superego-native-'))
const bundle = resolve('app/dist/Superego Native.app/Contents/MacOS')
const env = { ...process.env, SUPEREGO_HOME: home, SUPEREGO_CWD: home, SUPEREGO_AGENTS: join(home, 'agents'), SUPEREGO_MODEL: 'faux', SUPEREGO_HEADLESS: '1', SUPEREGO_NATIVE_SNAPSHOT: join(home, 'webkit.png') }
const runShell = () => new Promise<void>((ok, fail) => {
  const p = spawn(join(bundle, 'SuperegoNative'), [], { env, stdio: 'inherit' })
  p.once('error', fail); p.once('exit', code => code === 0 ? ok() : fail(Error(`Shell exit ${code}`)))
})
let daemon: ReturnType<typeof spawn> | undefined
let connection: Awaited<ReturnType<typeof connectSocket>> | undefined
async function start() {
  daemon = spawn(join(bundle, 'superego-daemon'), [], { env, stdio: 'inherit' })
  for (let i=0;i<200;i++) {
    try { connection = await connectSocket(join(home, 'superego.sock')); break } catch { await sleep(50) }
  }
  assert(connection, 'daemon socket')
  await connection.peer.call('hello', { client: 'native-smoke', version: PROTOCOL_VERSION })
  return connection.peer
}
async function stop() {
  connection?.socket.destroy()
  connection = undefined
  if (daemon && daemon.exitCode === null) {
    const process = daemon
    await new Promise<void>(resolve => {
      process.once('exit', () => resolve())
      process.kill('SIGTERM')
    })
  }
  daemon = undefined
}
try {
  await mkdir(join(home, 'profiles/default'), { recursive: true })
  await writeFile(join(home, 'profiles/default/profile.ts'), `import { defineProfile } from 'superego'; export default defineProfile({prompt:'NATIVE_PROFILE_IMPORTED'})`)
  let peer = await start()
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: home, title: 'Native socket smoke', prompt: 'socket hello' })
  const done = async (id: string) => {
    for (let i=0;i<200;i++) {
      const t = (await peer.call<ThreadInfo[]>('thread.list', {})).find(t => t.id === id)
      if (t?.status.state === 'done') return
      if (t?.status.state === 'error') throw Error(JSON.stringify(t))
      await sleep(50)
    }
    throw Error('thread timeout')
  }
  await done(thread.id)
  assert.match(JSON.stringify(await peer.call('thread.watch', {id:thread.id})), /NATIVE_PROFILE_IMPORTED/)
  await stop()
  peer = await start()
  assert((await peer.call<ThreadInfo[]>('thread.list', {})).some(t => t.id === thread.id), 'SQLite persisted')
  const replay = join(home, 'replay.jsonl')
  await writeFile(replay, [
    {message:{content:[{type:'toolCall',id:'native-bash',name:'bash',arguments:{command:'printf native-child > native-child.txt'}}],stopReason:'toolUse'}},
    {message:{content:[{type:'text',text:'tool finished'}],stopReason:'stop'}},
  ].map(x => JSON.stringify(x)).join('\n'))
  // Replay is registered at boot, so restart with it as the default model.
  await stop()
  env.SUPEREGO_MODEL = `replay:${replay}`
  peer = await start()
  const tool = await peer.call<ThreadInfo>('thread.create', { cwd:home, prompt:'run tool' })
  await done(tool.id)
  assert.equal(await readFile(join(home,'native-child.txt'),'utf8'), 'native-child')
  console.log('PASS: profile SDK, socket faux chat, SQLite restart, real bash child')
  await stop()
  env.SUPEREGO_MODEL = 'faux'
  await runShell()
  const endpoint = JSON.parse(await readFile(join(home, 'native-endpoint.json'), 'utf8'))
  process.kill(endpoint.pid, 0) // The shell quit; its detached daemon must still be alive.
  connection = await connectSocket(join(home, 'superego.sock'))
  peer = connection.peer
  await peer.call('hello', { client:'native-smoke', version:PROTOCOL_VERSION })
  assert.match(JSON.stringify(await peer.call('thread.watch', {id:thread.id})), /echo: Native WebKit message/)
  console.log(`PASS: profile SDK, socket chat, WebKit UI chat + stream, SQLite restart, real bash child. Artifacts: ${home}`)
} finally {
  await stop()
  // Also clean up a daemon launched by the native shell, including on a failed UI check.
  try {
    const { pid } = JSON.parse(await readFile(join(home, 'native-endpoint.json'), 'utf8'))
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
  // Keep isolated logs and snapshot for inspection; never read the user's daemon.
  await rm(join(home, 'superego.sock'), { force:true })
}
