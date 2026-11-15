// A server's tools as the agent gets them: named `mcp__<server>__<tool>`, their schemas made into what pi-durable and
// the providers take, deferred (found with `tool_search`) when there are many, and each call run by the runtime.
import { createHash } from 'node:crypto'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Json } from '@superego/protocol'
import { DEFAULTS, TOOL_PREFIX, type ServerConfig } from './shared.ts'

/** The providers' limit on a tool's name. */
const MAX_NAME = 64

/**
 * A tool's name for the model: `mcp__<server>__<tool>`, characters outside `[A-Za-z0-9_-]` as `_`, and a name over 64
 * cut, with six hex characters of its hash added so two long names stay apart.
 */
export function toolName(server: string, tool: string): string {
  const name = `${TOOL_PREFIX}${server}__${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`
  if (name.length <= MAX_NAME) return name
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 6)
  return `${name.slice(0, MAX_NAME - 7)}_${hash}`
}

type JsonObject = Record<string, unknown>
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A tool's input schema as pi-durable takes it, or why it won't go: the root an object, `$schema` dropped, local `$ref`s
 * into `$defs` (or `definitions`) inlined a few levels deep. One still referring after that is refused.
 */
export function normalizeSchema(schema: unknown): { schema: JsonObject } | { problem: string } {
  if (!isObject(schema)) return { problem: 'its input schema is not an object' }
  if (schema.type !== undefined && schema.type !== 'object') return { problem: `its input schema is a ${JSON.stringify(schema.type)}, not an object` }
  const defs = { ...(isObject(schema.definitions) ? schema.definitions : {}), ...(isObject(schema.$defs) ? schema.$defs : {}) }
  let unresolved: string | undefined
  const inline = (value: unknown, depth: number): unknown => {
    if (Array.isArray(value)) return value.map((item) => inline(item, depth))
    if (!isObject(value)) return value
    if (typeof value.$ref === 'string') {
      const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(value.$ref)
      const target = match ? defs[decodeURIComponent(match[1]!).replace(/~1/g, '/').replace(/~0/g, '~')] : undefined
      if (!target || depth >= 4) { unresolved ??= value.$ref; return {} }
      const { $ref: _ref, ...rest } = value
      return inline({ ...target as JsonObject, ...rest }, depth + 1)
    }
    const out: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === '$schema' || key === '$defs' || key === 'definitions' || key === '$id') continue
      out[key] = inline(item, depth)
    }
    return out
  }
  const result = inline(schema, 0) as JsonObject
  if (unresolved) return { problem: `its input schema refers to ${unresolved}, which can't be inlined` }
  return { schema: { ...result, type: 'object', ...(isObject(result.properties) ? {} : { properties: {} }) } }
}

/** A tool of a server, as offered: its name for the model, and the server's own. */
export type OfferedTool = {
  name: string
  /** The server's own name for it. */
  tool: string
  title?: string
  description: string
  parameters: JsonObject
  outputSchema?: JsonObject
  annotations?: { [key: string]: Json }
}

/** Schemas over this many characters (about 5k tokens) make `tools: 'auto'` defer the server's tools. */
const DEFER_CHARACTERS = 20_000
/** And more tools than this. */
const DEFER_TOOLS = 15

/** A server's tools, ready to offer: those whose schemas won't go are skipped, and said why. */
export function offerTools(server: string, tools: readonly Tool[], config: ServerConfig) {
  const offered: OfferedTool[] = []
  const skipped: { tool: string; why: string }[] = []
  const names = new Set<string>()
  for (const tool of tools) {
    const normal = normalizeSchema(tool.inputSchema)
    if ('problem' in normal) { skipped.push({ tool: tool.name, why: normal.problem }); continue }
    const name = toolName(server, tool.name)
    if (names.has(name)) { skipped.push({ tool: tool.name, why: `its name is ${name} here, as another tool's is` }); continue }
    names.add(name)
    const output = tool.outputSchema ? normalizeSchema(tool.outputSchema) : undefined
    const title = tool.title ?? tool.annotations?.title
    offered.push({
      name, tool: tool.name, description: tool.description?.trim() || title || tool.name, parameters: normal.schema,
      ...(title ? { title } : {}),
      ...(output && 'schema' in output ? { outputSchema: output.schema } : {}),
      ...(tool.annotations ? { annotations: JSON.parse(JSON.stringify(tool.annotations)) as { [key: string]: Json } } : {}),
    })
  }
  const mode = config.tools ?? DEFAULTS.tools
  const size = offered.reduce((sum, tool) => sum + JSON.stringify(tool.parameters).length + tool.description.length, 0)
  const deferred = mode === 'search' || (mode === 'auto' && (offered.length > DEFER_TOOLS || size > DEFER_CHARACTERS))
  return { offered, skipped, deferred }
}
