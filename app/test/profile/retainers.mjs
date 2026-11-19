// What keeps an object alive in a heap snapshot: the shortest path from the GC roots to each of the first few objects
// whose name contains `<text>` (detached ones only, with --detached), as DevTools' Retainers panel shows one.
//   node test/profile/retainers.mjs <file.heapsnapshot> <text> [--detached] [--exact] [--last] [--count 3]
// --exact: named `<text>` exactly; --last: the last made first (the newest, as a leak's are).
import { readFileSync } from 'node:fs'

const [file, text, ...rest] = process.argv.slice(2)
if (!file || !text) {
  console.error('usage: node retainers.mjs <file.heapsnapshot> <text> [--detached] [--exact] [--last] [--count 3]')
  process.exit(2)
}
const onlyDetached = rest.includes('--detached')
const count = Number(rest[rest.indexOf('--count') + 1]) || 3
const exact = rest.includes('--exact')
const last = rest.includes('--last')

const { snapshot: { meta }, nodes, edges, strings } = JSON.parse(readFileSync(file, 'utf8'))
const NF = meta.node_fields.length, EF = meta.edge_fields.length
const N_TYPE = meta.node_fields.indexOf('type'), N_NAME = meta.node_fields.indexOf('name'), N_EDGES = meta.node_fields.indexOf('edge_count')
const N_DETACHED = meta.node_fields.indexOf('detachedness'), N_SIZE = meta.node_fields.indexOf('self_size')
const E_TYPE = meta.edge_fields.indexOf('type'), E_NAME = meta.edge_fields.indexOf('name_or_index'), E_TO = meta.edge_fields.indexOf('to_node')
const nodeTypes = meta.node_types[N_TYPE], edgeTypes = meta.edge_types[E_TYPE]
const total = nodes.length / NF

const firstEdge = new Uint32Array(total + 1)
for (let i = 0, e = 0; i < total; i++) { firstEdge[i] = e; e += nodes[i * NF + N_EDGES] * EF }
firstEdge[total] = edges.length

// Breadth first from the root, through strong edges: each node's parent and the edge it came by.
const parent = new Int32Array(total).fill(-1)
const via = new Int32Array(total).fill(-1)
parent[0] = 0
const queue = new Uint32Array(total)
let head = 0, tail = 0
queue[tail++] = 0
while (head < tail) {
  const n = queue[head++]
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EF) {
    if (edgeTypes[edges[e + E_TYPE]] === 'weak') continue
    const to = edges[e + E_TO] / NF
    if (parent[to] !== -1) continue
    parent[to] = n
    via[to] = e
    queue[tail++] = to
  }
}

const describe = (n) => `${nodeTypes[nodes[n * NF + N_TYPE]]} ${strings[nodes[n * NF + N_NAME]].slice(0, 100)} @${n} (${nodes[n * NF + N_SIZE]} B)`
const edgeName = (e) => {
  const type = edgeTypes[edges[e + E_TYPE]]
  const name = edges[e + E_NAME]
  return type === 'element' || type === 'hidden' ? `[${name}]` : `.${strings[name]}`
}
let shown = 0
const N_ID = meta.node_fields.indexOf('id')
const order = Array.from({ length: total }, (_, n) => n)
if (last) order.sort((a, b) => nodes[b * NF + N_ID] - nodes[a * NF + N_ID])
for (const n of order) {
  if (shown >= count) break
  const name = strings[nodes[n * NF + N_NAME]]
  if (exact ? name !== text : !name.includes(text)) continue
  if (onlyDetached && nodes[n * NF + N_DETACHED] !== 2) continue
  shown++
  console.log(`\n${describe(n)}`)
  if (parent[n] === -1) { console.log('  unreachable from the roots (garbage, or only weakly held)'); continue }
  const path = []
  for (let at = n; at !== 0; at = parent[at]) path.push(`  ← ${edgeName(via[at])} of ${describe(parent[at])}`)
  console.log(path.slice(0, 40).join('\n'))
}
if (!shown) console.log(`nothing named like "${text}"${onlyDetached ? ' detached' : ''}`)
