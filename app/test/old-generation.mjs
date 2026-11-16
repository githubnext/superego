// A daemon of another protocol generation, for smoke.sh: on `socket`, named in `pidFile`, it refuses every client as
// one would, and goes on SIGTERM. `node test/old-generation.mjs <socket> <pidFile>`.
import { rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

const [socket, pidFile] = process.argv.slice(2)
rmSync(socket, { force: true })
const server = createServer((conn) => {
  let buffer = ''
  conn.setEncoding('utf8')
  conn.on('error', () => {})
  conn.on('data', (chunk) => {
    buffer += chunk
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      let request
      try { request = JSON.parse(line) } catch { continue }
      if (request.id === undefined) continue
      conn.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
        code: -32000, message: 'This computer runs Superego protocol generation 1, and this client speaks generation 2.',
        data: { kind: 'version_mismatch', hint: 'Update Superego on this computer.' },
      } }) + '\n')
    }
  })
})
server.listen(socket, () => writeFileSync(pidFile, String(process.pid)))
process.on('SIGTERM', () => { rmSync(socket, { force: true }); process.exit(0) })
