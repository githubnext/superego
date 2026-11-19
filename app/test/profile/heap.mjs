// What a V8 heap snapshot holds, summed by kind (`<type> <name>`: "object HTMLDivElement", "closure render"), and its
// detached DOM; and what grew between two.

/** A snapshot's summary: its total size, its objects by kind (count and self size), and its detached DOM nodes. */
export function summarize(snapshot) {
  const { meta } = snapshot.snapshot
  const fields = meta.node_fields
  const width = fields.length
  const TYPE = fields.indexOf('type'), NAME = fields.indexOf('name'), SIZE = fields.indexOf('self_size'), DETACHED = fields.indexOf('detachedness')
  const types = meta.node_types[TYPE]
  const { nodes, strings } = snapshot
  const kinds = new Map()
  let total = 0, detached = 0, detachedSize = 0
  const detachedKinds = new Map()
  for (let i = 0; i < nodes.length; i += width) {
    const type = types[nodes[i + TYPE]]
    const size = nodes[i + SIZE]
    total += size
    // Strings and code by type alone; the rest by what they are.
    const name = ['string', 'concatenated string', 'sliced string', 'code', 'number', 'hidden', 'array'].includes(type) ? '' : strings[nodes[i + NAME]].slice(0, 80)
    const key = `${type} ${name}`.trim()
    const kind = kinds.get(key) ?? kinds.set(key, { count: 0, size: 0 }).get(key)
    kind.count++
    kind.size += size
    const isDetached = DETACHED >= 0 ? nodes[i + DETACHED] === 2 : name.startsWith('Detached ')
    if (isDetached) {
      detached++
      detachedSize += size
      detachedKinds.set(name, (detachedKinds.get(name) ?? 0) + 1)
    }
  }
  return {
    totalMB: mb(total),
    nodes: nodes.length / width,
    detached: { count: detached, sizeMB: mb(detachedSize), kinds: [...detachedKinds].sort((a, b) => b[1] - a[1]).slice(0, 15) },
    kinds: Object.fromEntries([...kinds].sort((a, b) => b[1].size - a[1].size)),
  }
}

/** What grew most from `a` to `b` (summaries), by count and by size. */
export function growth(a, b, n = 25) {
  const rows = Object.entries(b.kinds).map(([key, k]) => {
    const was = a.kinds[key] ?? { count: 0, size: 0 }
    return { kind: key, count: k.count - was.count, sizeKB: Math.round((k.size - was.size) / 1024), countNow: k.count }
  })
  return {
    byCount: rows.filter((r) => r.count > 0).sort((x, y) => y.count - x.count).slice(0, n),
    bySize: rows.filter((r) => r.sizeKB > 0).sort((x, y) => y.sizeKB - x.sizeKB).slice(0, n),
  }
}

/** The summary kept in the report: the biggest kinds only. */
export const brief = (summary, n = 30) => ({ ...summary, kinds: Object.fromEntries(Object.entries(summary.kinds).slice(0, n).map(([k, v]) => [k, { count: v.count, sizeKB: Math.round(v.size / 1024) }])) })

const mb = (bytes) => Math.round(bytes / 1048576 * 10) / 10
