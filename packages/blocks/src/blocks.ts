// @superego/blocks: UI an agent writes as JSON. A list of blocks (text, tables, inputs, buttons, a sandboxed page of its
// own), checked strictly so a model gets errors it can fix, and what the user's answer to them says. The renderer is
// `@superego/blocks/ui`; this half has no React, so a daemon half can check blocks and word answers too.
import { arr, bool, compile, int, lit, num, obj, oneOf, opt, str, union, type Schema } from '@earendil-works/pi-schema'

export type Tone = 'info' | 'warn' | 'success'
export type Cell = string | number | boolean | null
/** An option of a choice. `value` is what the answer holds (its label when unset); `preview` shows what it means. */
export type ChoiceOption = { value?: string; label: string; description?: string; preview?: Block }
export type SelectOption = { value?: string; label: string }
export type ActionButton = { id: string; label: string; style?: 'primary' | 'danger' }
/** Where an `open` block takes the user: a file (`path`, `line`), the changes, a web page (`url`), an HTML file (`path`). */
export type PaneKind = 'editor' | 'diff' | 'preview' | 'artifact'

export type Block =
  | { type: 'markdown'; text: string }
  | { type: 'callout'; tone?: Tone; title?: string; text: string }
  | { type: 'code'; code: string; language?: string; title?: string }
  | { type: 'table'; columns: string[]; rows: Cell[][] }
  | { type: 'image'; src: string; alt?: string; caption?: string }
  | { type: 'kv'; items: { label: string; value: string | number | boolean }[] }
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
  | { type: 'buttons'; buttons: ActionButton[] }
  | { type: 'open'; label: string; kind: PaneKind; path?: string; url?: string; line?: number }
  | { type: 'html'; id?: string; html: string; height?: number }

export type BlockType = Block['type']
export type InputBlock = Extract<Block, { type: 'choice' | 'select' | 'switch' | 'text' | 'textarea' | 'number' | 'slider' }>
export const INPUTS = ['choice', 'select', 'switch', 'text', 'textarea', 'number', 'slider'] as const
export const BLOCK_TYPES = [
  'markdown', 'callout', 'code', 'table', 'image', 'kv', 'stack', 'row', 'card', 'divider',
  ...INPUTS, 'buttons', 'open', 'html',
] as const satisfies readonly BlockType[]

/** JSON a block's answer can hold. */
export type Value = string | number | boolean | null | Value[] | { [key: string]: Value }

/**
 * What the user did: the inputs' values by id, and which button sent them: its id, `submit` (the form's submit,
 * or picking from a choice that is the only input), or an html block's id (`superego.reply`). `text` is something
 * they wrote instead (the composer, or an html block's `superego.send`).
 */
export type Reply = { values: Record<string, Value>; button?: string; text?: string }

// ── The schema ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A block inside another (a card, a row, an option's preview): the same blocks, by reference. */
const inner = { $ref: '#/$defs/block' } as Schema<Block>
const children = arr(inner, { minItems: 1 })
const id = str({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_.-]+$', description: 'Key of this input in the answer' })
const label = str({ minLength: 1 })

const BLOCK = union([
  obj({ type: lit('markdown'), text: str() }),
  obj({ type: lit('callout'), tone: opt(oneOf(['info', 'warn', 'success'])), title: opt(str()), text: str() }),
  obj({ type: lit('code'), code: str(), language: opt(str()), title: opt(str()) }),
  obj({ type: lit('table'), columns: arr(str(), { minItems: 1 }), rows: arr(arr(union([str(), num(), bool(), { type: 'null' } as Schema<null>]))) }),
  obj({ type: lit('image'), src: str({ minLength: 1 }), alt: opt(str()), caption: opt(str()) }),
  obj({ type: lit('kv'), items: arr(obj({ label: str(), value: union([str(), num(), bool()]) })) }),
  obj({ type: lit('stack'), blocks: children }),
  obj({ type: lit('row'), blocks: children }),
  obj({ type: lit('card'), title: opt(str()), blocks: children }),
  obj({ type: lit('divider') }),
  obj({
    type: lit('choice'), id, label: opt(str()), multiple: opt(bool()), style: opt(oneOf(['buttons', 'list'])),
    options: arr(obj({ value: opt(str()), label, description: opt(str()), preview: opt(inner) }), { minItems: 1 }),
    default: opt(union([str(), arr(str())])),
  }),
  obj({ type: lit('select'), id, label: opt(str()), options: arr(obj({ value: opt(str()), label }), { minItems: 1 }), default: opt(str()) }),
  obj({ type: lit('switch'), id, label, default: opt(bool()) }),
  obj({ type: lit('text'), id, label: opt(str()), placeholder: opt(str()), default: opt(str()) }),
  obj({ type: lit('textarea'), id, label: opt(str()), placeholder: opt(str()), default: opt(str()) }),
  obj({ type: lit('number'), id, label: opt(str()), min: opt(num()), max: opt(num()), step: opt(num({ exclusiveMinimum: 0 })), default: opt(num()) }),
  obj({ type: lit('slider'), id, label: opt(str()), min: num(), max: num(), step: opt(num({ exclusiveMinimum: 0 })), default: opt(num()) }),
  obj({ type: lit('buttons'), buttons: arr(obj({ id, label, style: opt(oneOf(['primary', 'danger'])) }), { minItems: 1 }) }),
  obj({ type: lit('open'), label, kind: oneOf(['editor', 'diff', 'preview', 'artifact']), path: opt(str({ minLength: 1 })), url: opt(str({ pattern: '^https?://' })), line: opt(int({ minimum: 1 })) }),
  obj({ type: lit('html'), id: opt(id), html: str({ minLength: 1 }), height: opt(int({ minimum: 20, maximum: 2000 })) }),
])

/** Every block, strictly: unknown fields are errors, so a model's typo is caught where it is. */
export const BLOCKS_SCHEMA = { ...arr(inner, { minItems: 1 }), $defs: { block: BLOCK } } as Schema<Block[]>
const validator = compile(BLOCKS_SCHEMA)

/**
 * A light schema for a tool's `blocks` parameter: only each block's type. The full schema would cost every request
 * thousands of tokens (and not every provider takes recursive schemas); the tool checks with `checkBlocks` instead.
 */
export const blocksParameter = (description = 'The UI, top to bottom.') =>
  arr(obj({ type: oneOf(BLOCK_TYPES) }, { open: true }), { minItems: 1, description }) as unknown as Schema<Block[]>

/** What's wrong with `blocks`, as lines a model can act on; none when they're fine. */
export function blockErrors(blocks: unknown): string[] {
  const errors = validator.check(blocks) ? [] : validator.errors(blocks).map((e) => `blocks${e.path.replaceAll('/', '.').replace(/\.(\d+)/g, '[$1]')}: ${e.message}`)
  if (errors.length) return errors.slice(0, 12)
  // What a schema can't say: ids are unique, and an open block names what it opens.
  const seen = new Set<string>()
  walk(blocks as Block[], (block, path) => {
    const key = 'id' in block ? block.id : undefined
    if (key) {
      if (seen.has(key)) errors.push(`${path}.id: "${key}" is used twice; ids must be unique`)
      seen.add(key)
    }
    if (block.type === 'buttons') for (const [i, b] of block.buttons.entries()) {
      if (seen.has(b.id)) errors.push(`${path}.buttons[${i}].id: "${b.id}" is used twice; ids must be unique`)
      seen.add(b.id)
    }
    if (block.type === 'open') {
      if ((block.kind === 'editor' || block.kind === 'artifact') && !block.path) errors.push(`${path}.path: missing (a ${block.kind} pane opens a file)`)
      if (block.kind === 'preview' && !block.url) errors.push(`${path}.url: missing (a preview pane opens a web page)`)
    }
    if (block.type === 'slider' && block.min >= block.max) errors.push(`${path}.max: must be more than min`)
  })
  return errors
}

/** `blocks`, checked: throws an error listing what's wrong, for the model to fix and call again. */
export function checkBlocks(blocks: unknown): Block[] {
  const errors = blockErrors(blocks)
  if (errors.length) throw new Error(`Invalid blocks:\n${errors.join('\n')}\n\nFix these and call again.`)
  return blocks as Block[]
}

/** Every block, depth first, with its path (`blocks[2].blocks[0]`); not into options' previews. */
export function walk(blocks: Block[], visit: (block: Block, path: string) => void, path = 'blocks') {
  for (const [i, block] of blocks.entries()) {
    visit(block, `${path}[${i}]`)
    if ('blocks' in block) walk(block.blocks, visit, `${path}[${i}].blocks`)
  }
}

/** The inputs among `blocks`, wherever they're laid out. */
export function inputsOf(blocks: Block[]): InputBlock[] {
  const inputs: InputBlock[] = []
  walk(blocks, (block) => { if ((INPUTS as readonly string[]).includes(block.type)) inputs.push(block as InputBlock) })
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

const hasButtons = (blocks: Block[]) => {
  let found = false
  walk(blocks, (block) => { found ||= block.type === 'buttons' })
  return found
}

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
 * A reply as the message it sends to the thread: `→ Option B`, the button pressed with the inputs under it, or what
 * was written. For UI that doesn't wait (show_ui, a pane): the agent reads it as the user's next message.
 */
export function describeReply(blocks: Block[], reply: Reply, { submit = 'Submit' }: { submit?: string } = {}): string {
  if (reply.text !== undefined) return reply.text
  const inputs = inputsOf(blocks)
  const buttons: ActionButton[] = []
  const frames: Extract<Block, { type: 'html' }>[] = []
  walk(blocks, (block) => { if (block.type === 'buttons') buttons.push(...block.buttons); if (block.type === 'html') frames.push(block) })
  const frame = frames.find((f) => (f.id ?? 'html') === reply.button)
  if (frame) {
    const value = reply.values[frame.id ?? 'html']
    return `→ ${typeof value === 'string' ? value : JSON.stringify(value ?? null)}`
  }
  const shown = inputs.filter((input) => input.id in reply.values)
  if (reply.button === 'submit' && shown.length === 1 && shown[0]!.type === 'choice') return `→ ${showValue(shown[0], reply.values[shown[0]!.id])}`
  const head = buttons.find((b) => b.id === reply.button)?.label ?? (reply.button === 'submit' || !reply.button ? submit : reply.button)
  return [`→ ${head}`, ...shown.map((input) => `${input.label ?? input.id}: ${showValue(input, reply.values[input.id])}`)].join('\n')
}

/** For tool descriptions: the blocks, compactly, and when UI is worth it. */
export const BLOCKS_GUIDE = `Blocks (JSON objects, by "type"; "?" marks optional fields; checked strictly, unknown fields are errors):
- markdown {text} | callout {tone?: info|warn|success, title?, text} | code {code, language?, title?} | table {columns: string[], rows: cell[][]} | image {src: https or data: URL, or a file in the working folder; alt?, caption?} | kv {items: [{label, value}]}
- stack {blocks} | row {blocks} (side by side) | card {title?, blocks} | divider {}
- inputs, each with a unique id (its key in the answer) and label?: choice {options: [{label, value?, description?, preview?: block}], multiple?, style?: buttons|list, default?} | select {options: [{label, value?}], default?} | switch {label, default?} | text {placeholder?, default?} | textarea {placeholder?, default?} | number {min?, max?, step?, default?} | slider {min, max, step?, default?}
- buttons {buttons: [{id, label, style?: primary|danger}]}: each sends {button: id} with every input's value. Without buttons, inputs get a submit button, and a lone single choice answers when picked.
- open {label, kind: editor|diff|preview|artifact, path?, url?, line?}: a link that opens a pane.
- html {html, height?, id?}: your own HTML/CSS/JS in a sandboxed frame (no network access to the app, no same-origin). Theme variables (--superego-text, --superego-muted, --superego-accent, --superego-border, --superego-surface, --superego-font, --superego-mono, --superego-radius) follow light/dark. Scripts get superego.reply(value) (answers, as values[id]) and superego.send(text) (a message), both only on a click or key press, and superego.resize(). For what blocks can't draw: charts, diagrams, custom widgets.`
