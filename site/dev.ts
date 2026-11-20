// The site while you work on it: builds, serves site/dist at http://localhost:4321 (PORT), and builds again when the
// docs, the changelog or the site's own files change, reloading open pages. Each build runs in a process of its own,
// so a change to build.ts takes effect too; a failed build is printed and shown in the page that reloads.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(SITE, '..')
const OUT = join(SITE, 'dist')
const PORT = Number(process.env.PORT ?? 4321)
const WATCH = ['site', 'docs', 'packages/cli/skill', 'packages/ui/src/styles.css', 'CHANGELOG.md', 'app/resources/icon.png']

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

let failure = ''
function build() {
  const run = spawnSync(process.execPath, [join(SITE, 'build.ts')], { env: { ...process.env, SITE_DEV: '1' }, encoding: 'utf8' })
  failure = run.status === 0 ? '' : run.stderr || run.stdout || `exited with ${run.status}`
  if (failure) console.error(failure)
  else process.stdout.write(run.stdout)
}

const clients = new Set<ServerResponse>()
let timer: NodeJS.Timeout | undefined
function changed(path: string) {
  if (path.includes('/dist/') || path.startsWith('site/dist') || path.includes('node_modules')) return
  clearTimeout(timer)
  timer = setTimeout(() => {
    build()
    for (const client of clients) client.write('data: reload\n\n')
  }, 80)
}

for (const path of WATCH) {
  const full = join(ROOT, path)
  watch(full, { recursive: statSync(full).isDirectory() }, (_event, file) => changed(file ? join(path, file) : path))
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/__reload') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (failure) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<pre style="white-space:pre-wrap;font:13px ui-monospace,monospace;padding:24px">${failure.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre><script>new EventSource('/__reload').onmessage = () => location.reload()</script>`)
    return
  }
  let file = join(OUT, normalize(decodeURIComponent(url.pathname)))
  if (!file.startsWith(OUT)) file = join(OUT, '404')
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found')
    return
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(readFileSync(file))
}).listen(PORT, '127.0.0.1', () => {
  build()
  console.log(`Site at http://localhost:${PORT}`)
})
