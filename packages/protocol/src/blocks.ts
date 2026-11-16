// Blocks: UI as JSON, drawn by the window's own components. A list of blocks (text, tables, a list of rows, inputs,
// buttons, a sandboxed page of its own), checked strictly so whoever wrote them gets errors they can fix, and what the
// user's answer to them says. Agents draw them (agent-ui's tools); so do extensions' data views. One schema serves both:
// who drew the blocks (`BlocksUse`) decides what they may contain, chiefly that only an extension's buttons run
// actions (its own), and an agent's only answer. The window draws them (packages/app renderer/blocks); this half has
// no React, so a daemon half can check blocks and word answers too.
import { arr, bool, compile, int, lit, num, obj, oneOf, opt, str, union, type Schema } from '@earendil-works/pi-schema'
import type { Json } from './settings.ts'
import type { StatusState } from './status.ts'

export type Tone = 'info' | 'warn' | 'success'
export type Cell = string | number | boolean | null
/** JSON a block's answer, or a button's params, can hold. */
export type Value = Json
/** An option of a choice. `value` is what the answer holds (its label when unset); `preview` shows what it means. */
export type ChoiceOption = { value?: string; label: string; description?: string; preview?: Block }
export type SelectOption = { value?: string; label: string }
/**
 * A button: an agent's answers or messages (by its `id`); an extension's runs one of its own actions (`action`, as
 * `<extension>.<name>`) with `params` and the inputs' values merged in by id.
 */
export type Button = { id: string; label: string; style?: 'primary' | 'danger'; action?: string; params?: { [key: string]: Value } }
/** A row of a `list`: what it is, a line under it, a little at its end, how it stands, a thread it is, its buttons. */
export type ListItem = {
  title: string
  subtitle?: string
  /** At the row's end, small: "5m", "+3". */
  detail?: string
  /** A status glyph before it, as threads have. */
  status?: StatusState
  /** A thread on the same machine: the title links to it. */
  thread?: string
  buttons?: Button[]
}

/**
 * A block of UI as JSON, drawn by the window's own components: what an agent draws (`show_ui` and its kin) and what a
 * data view shows (`superego.view`). Checked strictly where it lands (`blockErrors`); who drew it decides what it may
 * hold (`BlocksUse`).
 */
export type Block =
  | { type: 'markdown'; text: string }
  | { type: 'callout'; tone?: Tone; title?: string; text: string }
  | { type: 'code'; code: string; language?: string; title?: string }
  | { type: 'table'; columns: string[]; rows: Cell[][] }
  | { type: 'image'; src: string; alt?: string; caption?: string }
  | { type: 'kv'; items: { label: string; value: string | number | boolean }[] }
  | { type: 'list'; items: ListItem[] }
  | { type: 'stack'; blocks: Block[] }
  | { type: 'row'; blocks: Block[] }
  | { type: 'card'; title?: string; blocks: Block[] }
  | { type: 'divider' }
  | { type: 'choice'; id: string; label?: string; options: ChoiceOption[]; multiple?: boolean; style?: 'buttons' | 'list'; default?: string | string[] }
  | { type: 'select'; id: string; label?: string; options: SelectOption[]; default?: string }
  | { type: 'switch'; id: string; label: string; default?: boolean }
  | { type: 'text'; id: string; label?: string; placeholder?: string; default?: string }
  | { type: 'textarea'; id: string; label?: string; placeholder?: string; default?: string }
  | { type: 'number'; id: string; label?: string; min?: number; max?: number; step?: number; default?: number }
  | { type: 'slider'; id: string; label?: string; min: number; max: number; step?: number; default?: number }
  | { type: 'buttons'; buttons: Button[] }
  /** A link to a pane of any kind the thread offers (as `pane_open`), with that kind's params. */
  | { type: 'open'; label: string; kind: string; title?: string; params?: { [key: string]: Value } }
  | { type: 'html'; id?: string; html: string; height?: number }

export type BlockType = Block['type']
export type InputBlock = Extract<Block, { type: 'choice' | 'select' | 'switch' | 'text' | 'textarea' | 'number' | 'slider' }>
export const INPUTS = ['choice', 'select', 'switch', 'text', 'textarea', 'number', 'slider'] as const
export const BLOCK_TYPES = [
  'markdown', 'callout', 'code', 'table', 'image', 'kv', 'list', 'stack', 'row', 'card', 'divider',
  ...INPUTS, 'buttons', 'open', 'html',
] as const satisfies readonly BlockType[]
export const LIST_STATUSES = ['idle', 'working', 'done', 'blocked', 'error'] as const satisfies readonly StatusState[]

/**
 * What the user did: the inputs' values by id, and which button sent them: its id, `submit` (the form's submit,
 * or picking from a choice that is the only input), or an html block's id (`superego.reply`). `text` is something
 * they wrote instead (the composer, or an html block's `superego.send`).
 */
export type Reply = { values: Record<string, Value>; button?: string; text?: string }

/**
 * Who drew the blocks, which decides what they may contain: an agent's buttons answer and never run an action; an
 * extension's view's run only its own (`<extension>.<name>`). A `thread` view has a thread (for `open`, and images
 * from its folder); a `window` view has none.
 */
export type BlocksUse = { by: 'agent' } | { by: 'extension'; extension: string; thread: boolean }

/**
 * How much blocks may hold, whoever drew them: they're sent whole to every window that shows them, and kept (an
 * agent's pane) in a thread's state. Past these, the blocks are refused, not trimmed.
 */
export const BLOCK_LIMITS = {
  /** A line: a label, a title, a cell, a row's fields. */
  text: 2000,
  /** Markdown, code, an html block's page, a textarea's default. */
  markdown: 100_000,
  /** A list's rows. */
  items: 500,
  /** A table's rows. */
  rows: 1000,
  /** A table's columns, and the cells in a row. */
  columns: 50,
  /** A kv block's pairs. */
  pairs: 100,
  /** Buttons in one block, or on one row. */
  buttons: 20,
  /** A button's (or an open link's) params, as JSON. */
  params: 16_000,
  /** How deep params nest. */
  paramsDepth: 16,
  /** How deep blocks nest (in stacks, rows, cards and options' previews). */
  depth: 8,
  /** An image's address: about 2 MB of a data: URL. */
  image: 2_000_000,
} as const

// ── The schema ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A block inside another (a card, a row, an option's preview): the same blocks, by reference. */
const inner = { $ref: '#/$defs/block' } as Schema<Block>
const children = arr(inner, { minItems: 1 })
const id = str({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_.-]+$', description: 'Key of this input in the answer' })
const text = str({ maxLength: BLOCK_LIMITS.text })
const label = str({ minLength: 1, maxLength: BLOCK_LIMITS.text })
const long = str({ maxLength: BLOCK_LIMITS.markdown })
/** Params: any JSON object; its size and depth are checked after (`paramsError`). */
const params = obj({}, { open: true }) as Schema<{ [key: string]: Value }>
const button = obj({ id, label, style: opt(oneOf(['primary', 'danger'])), action: opt(str({ minLength: 1, maxLength: 200 })), params: opt(params) })
const buttons = arr(button, { minItems: 1, maxItems: BLOCK_LIMITS.buttons })

const BLOCK = union([
  obj({ type: lit('markdown'), text: long }),
  obj({ type: lit('callout'), tone: opt(oneOf(['info', 'warn', 'success'])), title: opt(text), text: long }),
  obj({ type: lit('code'), code: long, language: opt(str({ maxLength: 64 })), title: opt(text) }),
  obj({
    type: lit('table'), columns: arr(text, { minItems: 1, maxItems: BLOCK_LIMITS.columns }),
    rows: arr(arr(union([text, num(), bool(), { type: 'null' } as Schema<null>]), { maxItems: BLOCK_LIMITS.columns }), { maxItems: BLOCK_LIMITS.rows }),
  }),
  obj({ type: lit('image'), src: str({ minLength: 1, maxLength: BLOCK_LIMITS.image }), alt: opt(text), caption: opt(text) }),
  obj({ type: lit('kv'), items: arr(obj({ label: text, value: union([text, num(), bool()]) }), { maxItems: BLOCK_LIMITS.pairs }) }),
  obj({
    type: lit('list'),
    items: arr(obj({
      title: label, subtitle: opt(text), detail: opt(text), status: opt(oneOf(LIST_STATUSES)),
      thread: opt(str({ minLength: 1, maxLength: 200 })), buttons: opt(buttons),
    }), { maxItems: BLOCK_LIMITS.items }),
  }),
  obj({ type: lit('stack'), blocks: children }),
  obj({ type: lit('row'), blocks: children }),
  obj({ type: lit('card'), title: opt(text), blocks: children }),
  obj({ type: lit('divider') }),
  obj({
    type: lit('choice'), id, label: opt(text), multiple: opt(bool()), style: opt(oneOf(['buttons', 'list'])),
    options: arr(obj({ value: opt(text), label, description: opt(text), preview: opt(inner) }), { minItems: 1 }),
    default: opt(union([text, arr(text)])),
  }),
  obj({ type: lit('select'), id, label: opt(text), options: arr(obj({ value: opt(text), label }), { minItems: 1 }), default: opt(text) }),
  obj({ type: lit('switch'), id, label, default: opt(bool()) }),
  obj({ type: lit('text'), id, label: opt(text), placeholder: opt(text), default: opt(text) }),
  obj({ type: lit('textarea'), id, label: opt(text), placeholder: opt(text), default: opt(long) }),
  obj({ type: lit('number'), id, label: opt(text), min: opt(num()), max: opt(num()), step: opt(num({ exclusiveMinimum: 0 })), default: opt(num()) }),
  obj({ type: lit('slider'), id, label: opt(text), min: num(), max: num(), step: opt(num({ exclusiveMinimum: 0 })), default: opt(num()) }),
  obj({ type: lit('buttons'), buttons }),
  obj({ type: lit('open'), label, kind: str({ minLength: 1, maxLength: 200 }), title: opt(text), params: opt(params) }),
  obj({ type: lit('html'), id: opt(id), html: str({ minLength: 1, maxLength: BLOCK_LIMITS.markdown }), height: opt(int({ minimum: 20, maximum: 2000 })) }),
])

/** Every block, strictly: unknown fields are errors, so a typo is caught where it is. */
export const BLOCKS_SCHEMA = { ...arr(inner, { minItems: 1 }), $defs: { block: BLOCK } } as Schema<Block[]>
const validator = compile(BLOCKS_SCHEMA)

/**
 * A light schema for a tool's `blocks` parameter: only each block's type. The full schema would cost every request
 * thousands of tokens (and not every provider takes recursive schemas); the tool checks with `checkBlocks` instead.
 */
export const blocksParameter = (description = 'The UI, top to bottom.') =>
  arr(obj({ type: oneOf(BLOCK_TYPES) }, { open: true }), { minItems: 1, description }) as unknown as Schema<Block[]>

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * Where blocks nest deeper than `BLOCK_LIMITS.depth`, if they do: looked for before the schema, on whatever was sent,
 * so a deep pile never reaches the (recursive) validator.
 */
function tooDeep(value: unknown, path = 'blocks', depth = 1): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const [i, block] of value.entries()) {
    if (!isObject(block)) continue
    const at = `${path}[${i}]`
    if (depth > BLOCK_LIMITS.depth) return `${at}: blocks nest more than ${BLOCK_LIMITS.depth} deep`
    const deeper = tooDeep(block.blocks, `${at}.blocks`, depth + 1)
      ?? (Array.isArray(block.options) ? block.options.map((o, j) => isObject(o) && o.preview !== undefined ? tooDeep([o.preview], `${at}.options[${j}].preview`, depth + 1) : undefined).find(Boolean) : undefined)
    if (deeper) return deeper
  }
  return undefined
}

/** What's wrong with params, if anything: JSON no deeper than `BLOCK_LIMITS.paramsDepth`, no bigger than `.params`. */
function paramsError(value: Value, path: string): string | undefined {
  const fits = (v: unknown, depth: number): boolean => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
    if (typeof v === 'number') return Number.isFinite(v)
    if (depth >= BLOCK_LIMITS.paramsDepth || typeof v !== 'object') return false
    return Object.values(v).every((x) => fits(x, depth + 1))
  }
  if (!fits(value, 0)) return `${path}: must be JSON no more than ${BLOCK_LIMITS.paramsDepth} deep`
  if (JSON.stringify(value).length > BLOCK_LIMITS.params) return `${path}: more than ${BLOCK_LIMITS.params} characters of JSON`
  return undefined
}

/** What's wrong with `blocks` drawn by `use`, as lines whoever wrote them can act on; none when they're fine. */
export function blockErrors(blocks: unknown, use: BlocksUse): string[] {
  const deep = tooDeep(blocks)
  if (deep) return [deep]
  const errors = validator.check(blocks) ? [] : validator.errors(blocks).map((e) => `blocks${e.path.replaceAll('/', '.').replace(/\.(\d+)/g, '[$1]')}: ${e.message}`)
  if (errors.length) return errors.slice(0, 12)
  // What a schema can't say: ids are unique, a slider has room, params are small; and what `use` may have.
  const all = blocks as Block[]
  const seen = new Set<string>()
  const unique = (key: string, path: string) => {
    if (seen.has(key)) errors.push(`${path}: "${key}" is used twice; ids must be unique`)
    seen.add(key)
  }
  const inputs = new Set(inputsOf(all).map((input) => input.id))
  everyBlock(all, (block, path) => {
    if ('id' in block && block.id) unique(block.id, `${path}.id`)
    if (block.type === 'slider' && block.min >= block.max) errors.push(`${path}.max: must be more than min`)
    if (block.type === 'open' && block.params) { const e = paramsError(block.params, `${path}.params`); if (e) errors.push(e) }
    if (use.by === 'extension' && !use.thread) {
      if (block.type === 'open') errors.push(`${path}: a window view has no thread to open a pane beside`)
      if (block.type === 'image' && !/^(https|data):/.test(block.src)) errors.push(`${path}.src: a window view's image must be an https: or data: address`)
    }
  })
  const pressable = buttonsOf(all)
  // An extension's view has nothing to submit to: inputs go with a button's action, so inputs with none go nowhere.
  if (use.by === 'extension' && inputs.size && !pressable.length) errors.push(`blocks: an extension's inputs need a button to send them (a buttons block, or a list row's)`)
  for (const { button, path } of pressable) {
    unique(button.id, `${path}.id`)
    if (use.by === 'agent') {
      if (button.action !== undefined || button.params !== undefined) errors.push(`${path}: an agent's buttons answer; they can't run actions (no action or params)`)
      continue
    }
    const { extension } = use
    if (button.action === undefined) errors.push(`${path}.action: an extension's buttons run one of its actions, "${extension}.<name>"`)
    else if (!button.action.startsWith(`${extension}.`) || button.action.length <= extension.length + 1 || /\s/.test(button.action)) {
      errors.push(`${path}.action: "${button.action}" isn't one of ${extension}'s actions`)
    }
    if (button.params) {
      const e = paramsError(button.params, `${path}.params`)
      if (e) errors.push(e)
      for (const key of Object.keys(button.params)) if (inputs.has(key)) errors.push(`${path}.params.${key}: "${key}" is an input's id too; inputs go into the params by id`)
    }
  }
  return errors
}

/** `blocks`, checked: throws an error listing what's wrong, for the model to fix and call again. */
export function checkBlocks(blocks: unknown, use: BlocksUse): Block[] {
  const errors = blockErrors(blocks, use)
  if (errors.length) throw new Error(`Invalid blocks:\n${errors.join('\n')}\n\nFix these and call again.`)
  return blocks as Block[]
}

/** Every block, depth first, with its path (`blocks[2].blocks[0]`); not into options' previews. */
export function walkBlocks(blocks: Block[], visit: (block: Block, path: string) => void, path = 'blocks') {
  for (const [i, block] of blocks.entries()) {
    visit(block, `${path}[${i}]`)
    if ('blocks' in block) walkBlocks(block.blocks, visit, `${path}[${i}].blocks`)
  }
}

/** Every block, options' previews too: everything that's drawn. */
function everyBlock(blocks: Block[], visit: (block: Block, path: string) => void, path = 'blocks') {
  walkBlocks(blocks, (block, at) => {
    visit(block, at)
    if (block.type === 'choice') for (const [j, option] of block.options.entries()) if (option.preview) everyBlock([option.preview], visit, `${at}.options[${j}].preview`)
  }, path)
}

/** Every button that's drawn, in `buttons` blocks and on a list's rows (with its row), and where it is. */
export function buttonsOf(blocks: Block[]): { button: Button; item?: ListItem; path: string }[] {
  const found: { button: Button; item?: ListItem; path: string }[] = []
  everyBlock(blocks, (block, path) => {
    if (block.type === 'buttons') for (const [i, button] of block.buttons.entries()) found.push({ button, path: `${path}.buttons[${i}]` })
    if (block.type === 'list') {
      for (const [r, item] of block.items.entries()) {
        for (const [i, button] of (item.buttons ?? []).entries()) found.push({ button, item, path: `${path}.items[${r}].buttons[${i}]` })
      }
    }
  })
  return found
}

/** The inputs among `blocks`, wherever they're laid out. */
export function inputsOf(blocks: Block[]): InputBlock[] {
  const inputs: InputBlock[] = []
  walkBlocks(blocks, (block) => { if ((INPUTS as readonly string[]).includes(block.type)) inputs.push(block as InputBlock) })
  return inputs
}

export const optionValue = (option: ChoiceOption | SelectOption) => option.value ?? option.label

/** What the inputs hold before the user touches them. */
export function initialValues(blocks: Block[]): Record<string, Value> {
  const values: Record<string, Value> = {}
  for (const input of inputsOf(blocks)) {
    switch (input.type) {
      case 'choice': values[input.id] = input.multiple ? [input.default ?? []].flat() : typeof input.default === 'string' ? input.default : null; break
      case 'select': values[input.id] = input.default ?? optionValue(input.options[0]!); break
      case 'switch': values[input.id] = input.default ?? false; break
      case 'text': case 'textarea': values[input.id] = input.default ?? ''; break
      case 'number': values[input.id] = input.default ?? null; break
      case 'slider': values[input.id] = input.default ?? input.min; break
    }
  }
  return values
}

/**
 * The inputs' values for new blocks, from what they held: what the user typed kept by input id, a new id at its
 * default, a gone one dropped. So a view redrawn with new blocks doesn't eat the user's typing.
 */
export function keptValues(blocks: Block[], before: Record<string, Value>): Record<string, Value> {
  const values = initialValues(blocks)
  for (const id of Object.keys(values)) if (id in before) values[id] = before[id]!
  return values
}

const hasButtons = (blocks: Block[]) => buttonsOf(blocks).length > 0

/** Whether picking an option answers at once: a single choice that is the only input, with no buttons to press. */
export function picksAnswer(blocks: Block[]): boolean {
  const inputs = inputsOf(blocks)
  return inputs.length === 1 && inputs[0]!.type === 'choice' && !inputs[0]!.multiple && !hasButtons(blocks)
}

/** Whether the blocks need a submit button: inputs to send, and neither buttons nor a choice that answers by itself. */
export function needsSubmit(blocks: Block[]): boolean {
  return inputsOf(blocks).length > 0 && !hasButtons(blocks) && !picksAnswer(blocks)
}

/** A value as a person reads it: an option's label rather than its value, yes/no, a list. */
export function showValue(input: InputBlock | undefined, value: Value | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length ? value.map((v) => showValue(input, v)).join(', ') : '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (input && (input.type === 'choice' || input.type === 'select')) {
    const option = (input.options as (ChoiceOption | SelectOption)[]).find((o) => optionValue(o) === value)
    if (option) return option.label
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/**
 * A reply as the message it sends to the thread: `→ Option B`, the button pressed with the inputs under it (a row's
 * button with its row, `→ Cancel: npm run build`, as rows repeat the same buttons), or what was written. For UI that
 * doesn't wait (show_ui, a pane): the agent reads it as the user's next message.
 */
export function describeReply(blocks: Block[], reply: Reply, { submit = 'Submit' }: { submit?: string } = {}): string {
  if (reply.text !== undefined) return reply.text
  const inputs = inputsOf(blocks)
  const frames: Extract<Block, { type: 'html' }>[] = []
  walkBlocks(blocks, (block) => { if (block.type === 'html') frames.push(block) })
  const frame = frames.find((f) => (f.id ?? 'html') === reply.button)
  if (frame) {
    const value = reply.values[frame.id ?? 'html']
    return `→ ${typeof value === 'string' ? value : JSON.stringify(value ?? null)}`
  }
  const shown = inputs.filter((input) => input.id in reply.values)
  if (reply.button === 'submit' && shown.length === 1 && shown[0]!.type === 'choice') return `→ ${showValue(shown[0], reply.values[shown[0]!.id])}`
  const pressed = buttonsOf(blocks).find(({ button }) => button.id === reply.button)
  const head = pressed ? (pressed.item ? `${pressed.button.label}: ${pressed.item.title}` : pressed.button.label) : reply.button === 'submit' || !reply.button ? submit : reply.button
  return [`→ ${head}`, ...shown.map((input) => `${input.label ?? input.id}: ${showValue(input, reply.values[input.id])}`)].join('\n')
}

/**
 * For an agent's instructions: the blocks, compactly, and when UI is worth it. Only what an agent may use: buttons'
 * `action` and `params`, an extension's, and the limits, which no model nears, are left to the checker's errors.
 */
export const BLOCKS_GUIDE = `Blocks (JSON objects, by "type"; "?" marks optional fields; checked strictly, unknown fields are errors):
- markdown {text} | callout {tone?: info|warn|success, title?, text} | code {code, language?, title?} | table {columns: string[], rows: cell[][]} | image {src: https or data: URL, or a file in the working folder; alt?, caption?} | kv {items: [{label, value}]}
- list {items: [{title, subtitle?, detail?, status?: idle|working|done|blocked|error, thread?, buttons?}]}: rows; thread links a thread by its id.
- stack {blocks} | row {blocks} (side by side) | card {title?, blocks} | divider {}
- inputs, each with a unique id (its key in the answer) and label?: choice {options: [{label, value?, description?, preview?: block}], multiple?, style?: buttons|list, default?} | select {options: [{label, value?}], default?} | switch {label, default?} | text {placeholder?, default?} | textarea {placeholder?, default?} | number {min?, max?, step?, default?} | slider {min, max, step?, default?}
- buttons {buttons: [{id, label, style?: primary|danger}]}: each sends {button: id} with every input's value. Without buttons, inputs get a submit button, and a lone single choice answers when picked.
- open {label, kind, params?, title?}: a link that opens a pane beside the thread: a kind your instructions list under panes, with the params it takes there ({ path } for an editor).
- html {html, height?, id?}: your own HTML/CSS/JS in a sandboxed frame (no network access to the app, no same-origin). Theme variables (--superego-text, --superego-muted, --superego-accent, --superego-border, --superego-surface, --superego-font, --superego-mono, --superego-radius) follow light/dark. Scripts get superego.reply(value) (answers, as values[id]) and superego.send(text) (a message), both only on a click or key press, and superego.resize(). For what blocks can't draw: charts, diagrams, custom widgets.`
