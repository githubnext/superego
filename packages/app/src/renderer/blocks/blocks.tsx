// Blocks (`@superego/protocol`'s blocks.ts) drawn with the window's own components and theme, for whoever drew them:
// an agent (agent-ui), whose presses answer it or message its thread, or an extension's data view, whose buttons run
// its own actions. `<Blocks>` checks them as they land, keeps the inputs' values (across new blocks too, by id), and
// hands what the user does to its host; given an `answer`, it shows that, locked. An html block is a page of its own
// in a sandboxed frame (see frame.html).
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  blockErrors, initialValues, keptValues, needsSubmit, optionValue, picksAnswer, showValue,
  type Block, type BlocksUse, type Button as BlockButton, type ChoiceOption, type Json, type ListItem, type Reply, type ThreadInfo, type Value,
} from '@superego/protocol'
import { ArrowRightIcon, Button, CheckIcon, Select, StatusGlyph, Switch, TextArea, TextField } from '@superego/ui'
import type { MachineEntry } from '../../shared/bridge.ts'
import { useImageSource } from '../images.tsx'
import { Markdown } from '../Markdown.tsx'
import { useRegistry } from '../registry.tsx'
import { ThreadRef } from '../thread-ref.tsx'
import frameUrl from './frame.html?url&no-inline'
import './blocks.css'

/**
 * Who drew the blocks, and so what pressing does: an agent's answer it or message its thread (`reply`; none: they're
 * only shown, as an answered ask_ui is); an extension's run its own actions (`run`, with the button's params and the
 * inputs' values by id).
 */
export type BlocksHost =
  | { by: 'agent'; reply?(reply: Reply): Promise<unknown> }
  | { by: 'extension'; extension: string; run(action: string, params: Json): Promise<unknown> }

export type BlocksProps = {
  machine: MachineEntry
  /** The thread they're of: an agent's, or a `thread` view's. A `window` view has none. */
  thread?: ThreadInfo | undefined
  blocks: Block[]
  host: BlocksHost
  /** The answer given (an agent's): the inputs show it, and nothing can be changed or pressed. */
  answer?: Reply | undefined
  /** The submit button's label, where an agent's inputs need one. */
  submitLabel?: string | undefined
}

/** What the check allows of blocks drawn for `host`, with or without a thread. */
const useOf = (host: BlocksHost, thread: boolean): BlocksUse => host.by === 'agent' ? { by: 'agent' } : { by: 'extension', extension: host.extension, thread }

type Form = {
  machine: MachineEntry
  thread: ThreadInfo | undefined
  values: Record<string, Value>
  set(id: string, value: Value): void
  /** An agent's: send a reply, the inputs' values with what `reply` says over them. */
  act(reply: Partial<Reply>): void
  /** A button pressed: an agent's replies with it; an extension's runs its action. */
  press(button: BlockButton): void
  /** The html blocks may answer or message (an agent's); an extension's are display only. */
  replies: boolean
  /** Nothing can be changed: answered, or only shown. */
  locked: boolean
  answered: boolean
  busy: boolean
  /** The button of the answer given, or of the last reply sent from here (an agent's). */
  done: string | undefined
  /** Picking an option of the (only) choice answers at once. */
  picks: boolean
  /** There's a submit button, so ⏎ in a text field presses it. */
  submits: boolean
}
const FormContext = createContext<Form | undefined>(undefined)
const useForm = () => useContext(FormContext)!

/**
 * The blocks, checked where they land: they come from a machine (another one, perhaps, or another version) that isn't
 * this window's to trust, so blocks that aren't what their host may draw aren't drawn at all, and say why instead.
 */
export function Blocks(props: BlocksProps) {
  const use = useOf(props.host, Boolean(props.thread))
  const errors = useMemo(() => blockErrors(props.blocks, use), [props.blocks, use.by, use.by === 'extension' && use.extension, use.by === 'extension' && use.thread])
  useEffect(() => { if (errors.length) console.error(`Blocks not drawn:\n${errors.join('\n')}`) }, [errors])
  if (errors.length) return <div className="blocks-error">This UI can’t be drawn: {errors[0]}</div>
  return <BlockForm {...props} />
}

function BlockForm({ machine, thread, blocks, host, answer, submitLabel = 'Submit' }: BlocksProps) {
  // The inputs' values, kept by id when new blocks come (a view redrawn, as its source changes).
  const [state, setState] = useState(() => ({ blocks, values: { ...initialValues(blocks), ...answer?.values } }))
  let values = state.values
  if (state.blocks !== blocks) {
    values = keptValues(blocks, state.values)
    setState({ blocks, values })
  }
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string>()
  const [error, setError] = useState<string>()
  const agent = host.by === 'agent'
  const locked = Boolean(answer) || (agent && !host.reply)
  const submits = agent && needsSubmit(blocks)
  const send = (work: () => Promise<unknown>, button: string | undefined) => {
    setBusy(true)
    setError(undefined)
    work()
      .then(() => { if (agent) setSent(button) })
      .catch((e: Error) => { console.error(e); setError(e.message) })
      .finally(() => setBusy(false))
  }
  const form: Form = {
    machine, thread, values, locked, answered: Boolean(answer), busy, done: agent ? answer?.button ?? sent : undefined,
    picks: agent && picksAnswer(blocks), submits: submits && !locked, replies: agent,
    set: (id, value) => setState((now) => ({ ...now, values: { ...now.values, [id]: value } })),
    act(reply) {
      if (locked || busy || host.by !== 'agent') return
      const full: Reply = { ...reply, values: { ...values, ...reply.values } }
      send(() => host.reply!(full), full.button)
    },
    press(button) {
      if (host.by === 'agent') return form.act({ button: button.id })
      if (busy) return
      // The check made sure there's an action, the extension's own, and that its params don't name an input.
      send(() => host.run(button.action!, { ...button.params, ...values }), button.id)
    },
  }
  return (
    <FormContext.Provider value={form}>
      <div className={`blocks ${locked ? 'is-locked' : ''}`}>
        <BlockList blocks={blocks} />
        {submits && (answer ? answer.button === 'submit' : !locked) && (
          <div className="blocks-actions">
            <Button variant="primary" disabled={busy || locked} aria-pressed={answer ? true : undefined} onClick={() => form.act({ button: 'submit' })}>
              {answer && <CheckIcon weight="bold" />}{submitLabel}
            </Button>
          </div>
        )}
        {answer?.text !== undefined && <div className="blocks-answer"><ArrowRightIcon /> {answer.text}</div>}
        {error && <div className="blocks-error">{error}</div>}
      </div>
    </FormContext.Provider>
  )
}

function BlockList({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((block, i) => <BlockView key={i} block={block} />)}</>
}

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.type) {
    case 'markdown': return <Markdown text={block.text} />
    case 'callout': return (
      <div className={`blocks-callout is-${block.tone ?? 'info'}`}>
        {block.title && <div className="blocks-callout__title">{block.title}</div>}
        <Markdown text={block.text} />
      </div>
    )
    case 'code': return (
      <figure className="blocks-code">
        {block.title && <figcaption>{block.title}</figcaption>}
        <pre><code data-language={block.language}>{block.code}</code></pre>
      </figure>
    )
    case 'table': return (
      <div className="blocks-table">
        <table>
          <thead><tr>{block.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, r) => <tr key={r}>{block.columns.map((_, c) => <td key={c}>{showCell(row[c])}</td>)}</tr>)}</tbody>
        </table>
      </div>
    )
    case 'image': return <BlockImage src={block.src} alt={block.alt} caption={block.caption} />
    case 'list': return <List items={block.items} />
    case 'kv': return (
      <dl className="blocks-kv">
        {block.items.map((item, i) => <div key={i}><dt>{item.label}</dt><dd>{showCell(item.value)}</dd></div>)}
      </dl>
    )
    case 'stack': return <div className="blocks-stack"><BlockList blocks={block.blocks} /></div>
    case 'row': return <div className="blocks-row"><BlockList blocks={block.blocks} /></div>
    case 'card': return (
      <section className="blocks-card">
        {block.title && <h4 className="blocks-card__title">{block.title}</h4>}
        <BlockList blocks={block.blocks} />
      </section>
    )
    case 'divider': return <hr className="blocks-divider" />
    case 'choice': return <Choice block={block} />
    case 'select': return <SelectInput block={block} />
    case 'switch': return <SwitchInput block={block} />
    case 'text': case 'textarea': case 'number': case 'slider': return <FieldInput block={block} />
    case 'buttons': return <Buttons block={block} />
    case 'open': return <Open block={block} />
    case 'html': return <HtmlFrame block={block} />
  }
}

const showCell = (value: Value | undefined) => value === null || value === undefined ? '' : typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)

function Field({ label, children, inline }: { label: string | undefined; children: ReactNode; inline?: boolean }) {
  return (
    <label className={`blocks-field ${inline ? 'is-inline' : ''}`}>
      {label && <span className="blocks-field__label">{label}</span>}
      {children}
    </label>
  )
}

function Choice({ block }: { block: Extract<Block, { type: 'choice' }> }) {
  const form = useForm()
  const value = form.values[block.id]
  const chosen = (option: ChoiceOption) => Array.isArray(value) ? value.includes(optionValue(option)) : value === optionValue(option)
  const [looking, setLooking] = useState<ChoiceOption>()
  const pick = (option: ChoiceOption) => {
    const v = optionValue(option)
    if (block.multiple) {
      const list = Array.isArray(value) ? value : []
      form.set(block.id, list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
    } else if (form.picks) form.act({ values: { [block.id]: v }, button: 'submit' })
    else form.set(block.id, v)
  }
  // Buttons for a few short options; a list where they say more.
  const style = block.style ?? (block.options.length <= 4 && block.options.every((o) => !o.description && !o.preview && o.label.length <= 24) ? 'buttons' : 'list')
  const preview = (looking ?? block.options.find(chosen))?.preview
  return (
    <div className="blocks-choice" role="group" aria-label={block.label ?? block.id}>
      {block.label && <div className="blocks-field__label">{block.label}</div>}
      {style === 'buttons' ? (
        <div className="blocks-choice__buttons" onMouseLeave={() => setLooking(undefined)}>
          {block.options.map((option, i) => (
            <Button key={i} variant={chosen(option) ? 'primary' : 'default'} aria-pressed={chosen(option)} disabled={form.locked && !chosen(option) || form.busy}
              title={option.description} onMouseEnter={() => setLooking(option)} onClick={() => pick(option)}>
              {option.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="blocks-choice__list" onMouseLeave={() => setLooking(undefined)}>
          {block.options.map((option, i) => (
            <button key={i} type="button" className={`blocks-option ${chosen(option) ? 'is-chosen' : ''}`} aria-pressed={chosen(option)}
              disabled={form.locked || form.busy} onMouseEnter={() => setLooking(option)} onFocus={() => setLooking(option)} onClick={() => pick(option)}>
              <span className={`blocks-option__mark ${block.multiple ? 'is-check' : ''}`}>{chosen(option) && <CheckIcon weight="bold" />}</span>
              <span className="blocks-option__body">
                <span className="blocks-option__label">{option.label}</span>
                {option.description && <span className="blocks-option__description">{option.description}</span>}
              </span>
              {form.picks && !form.locked && <ArrowRightIcon className="blocks-option__go" />}
            </button>
          ))}
        </div>
      )}
      {preview && !form.answered && <div className="blocks-preview"><BlockView block={preview} /></div>}
    </div>
  )
}

function SelectInput({ block }: { block: Extract<Block, { type: 'select' }> }) {
  const form = useForm()
  return (
    <Field label={block.label}>
      <Select options={block.options.map((o) => ({ value: optionValue(o), label: o.label }))} disabled={form.locked}
        value={(form.values[block.id] as string | null) ?? null} onChange={(v) => form.set(block.id, v)} />
    </Field>
  )
}

function SwitchInput({ block }: { block: Extract<Block, { type: 'switch' }> }) {
  const form = useForm()
  return (
    <div className="blocks-field is-inline">
      <Switch label={block.label} checked={form.values[block.id] === true} disabled={form.locked} onChange={(v) => form.set(block.id, v)} />
      <span className="blocks-field__label">{block.label}</span>
    </div>
  )
}

function FieldInput({ block }: { block: Extract<Block, { type: 'text' | 'textarea' | 'number' | 'slider' }> }) {
  const form = useForm()
  const value = form.values[block.id]
  if (form.answered && (block.type === 'text' || block.type === 'textarea')) {
    return <Field label={block.label}><div className="blocks-given">{showValue(block, value)}</div></Field>
  }
  switch (block.type) {
    case 'text': return (
      <Field label={block.label}>
        <TextField value={String(value ?? '')} placeholder={block.placeholder} disabled={form.locked} onChange={(e) => form.set(block.id, e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && form.submits) { e.preventDefault(); form.act({ button: 'submit' }) } }} />
      </Field>
    )
    case 'textarea': return (
      <Field label={block.label}>
        <TextArea rows={3} value={String(value ?? '')} placeholder={block.placeholder} disabled={form.locked} onChange={(e) => form.set(block.id, e.target.value)} />
      </Field>
    )
    case 'number': return (
      <Field label={block.label}>
        <TextField type="number" value={value === null || value === undefined ? '' : String(value)} min={block.min} max={block.max} step={block.step} disabled={form.locked}
          onChange={(e) => form.set(block.id, e.target.value === '' ? null : Number(e.target.value))} />
      </Field>
    )
    case 'slider': return (
      <Field label={block.label}>
        <span className="blocks-slider">
          <input type="range" min={block.min} max={block.max} step={block.step ?? 'any'} value={Number(value ?? block.min)} disabled={form.locked}
            onChange={(e) => form.set(block.id, Number(e.target.value))} />
          <output>{String(value ?? block.min)}</output>
        </span>
      </Field>
    )
  }
}

function Buttons({ block }: { block: Extract<Block, { type: 'buttons' }> }) {
  return <div className="blocks-actions">{block.buttons.map((button) => <Press key={button.id} button={button} />)}</div>
}

/** A button: pressed, an agent's answers with its id, an extension's runs its action. A row's are small. */
function Press({ button, small = false }: { button: BlockButton; small?: boolean }) {
  const form = useForm()
  const done = form.done === button.id
  const variant = button.style === 'primary' || done ? 'primary' : small ? 'ghost' : 'default'
  return (
    <Button variant={variant} className={`${small ? 'blocks-list__button' : ''} ${button.style === 'danger' ? 'is-danger' : ''}`}
      disabled={form.busy || form.locked && !done} aria-pressed={done || undefined} onClick={() => form.press(button)}>
      {done && form.locked && <CheckIcon weight="bold" />}{button.label}
    </Button>
  )
}

/** Rows: a status glyph, a title (a thread's links to it, with its own status), a little at the end, buttons, a line under. */
function List({ items }: { items: ListItem[] }) {
  const { machine } = useForm()
  return (
    <ul className="blocks-list">
      {items.map((item, i) => (
        <li key={i} className="blocks-list__item">
          <div className="blocks-list__line">
            {item.status && !item.thread && <StatusGlyph status={{ state: item.status }} />}
            {item.thread
              ? <ThreadRef machine={machine.id} id={item.thread} className="blocks-list__title">{item.title}</ThreadRef>
              : <span className="blocks-list__title">{item.title}</span>}
            {item.detail && <span className="blocks-list__detail">{item.detail}</span>}
            {item.buttons?.map((button) => <Press key={button.id} button={button} small />)}
          </div>
          {item.subtitle && <div className="blocks-list__subtitle">{item.subtitle}</div>}
        </li>
      ))}
    </ul>
  )
}

function Open({ block }: { block: Extract<Block, { type: 'open' }> }) {
  const { machine, thread } = useForm()
  const dispatch = useRegistry().router.dispatch
  const [error, setError] = useState<string>()
  // Any kind the thread offers, with that kind's params: whether it opens is the core's to say, when it's pressed.
  // Only blocks of a thread have pane links (the check refuses them elsewhere).
  const { kind, title, params } = block
  if (!thread) return null
  const open = () => dispatch('pane.open', { thread: thread.id, kind, ...(title ? { title } : {}), ...(params ? { params } : {}) }, { machine: machine.id, source: 'blocks' })
    .then(() => setError(undefined), (e: Error) => { console.error(e); setError(e.message) })
  return (
    <span className="blocks-open">
      <button type="button" className="blocks-open__link" onClick={() => void open()}>{block.label}<ArrowRightIcon /></button>
      {error && <span className="blocks-error">{error}</span>}
    </span>
  )
}

/**
 * An image by address (https, data:), or a file in the thread's folder, read from its machine as the window reads any
 * of a thread's images (so it shows on any client, and redraws when the file changes). Blocks of no thread have only
 * addresses (the check refuses paths there).
 */
function BlockImage({ src, alt, caption }: { src: string; alt?: string | undefined; caption?: string | undefined }) {
  const { machine, thread } = useForm()
  const image = useMemo(() => /^(data|https?):/.test(src) ? { name: src, url: src } : { name: src, path: src }, [src])
  const loaded = useImageSource(machine, thread?.id ?? '', image, true)
  return (
    <figure className="blocks-image">
      {loaded.src ? <img src={loaded.src} alt={alt ?? ''} /> : <div className="blocks-image__missing">{loaded.broken ? `Image ${loaded.problem ?? 'not found'}` : 'Loading…'}</div>}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  )
}

/** The window's theme as CSS variables, for a frame: every --superego-* the root has, kept current. */
function useThemeCss() {
  const read = () => {
    const style = getComputedStyle(document.documentElement)
    let css = ''
    for (const name of style) if (name.startsWith('--superego-')) css += `${name}:${style.getPropertyValue(name).trim()};`
    return css
  }
  const [css, setCss] = useState(read)
  useEffect(() => {
    // The accent, fonts and text size are set on the root's style; light and dark follow by themselves (light-dark()).
    const observer = new MutationObserver(() => setCss(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => observer.disconnect()
  }, [])
  return css
}

type FrameMessage = { superego: true; kind: 'ready' } | { superego: true; kind: 'resize'; height: number } | { superego: true; kind: 'reply'; value: Value } | { superego: true; kind: 'send'; text: string }

/**
 * A page of its own: sandboxed (scripts, nothing else), sized to its content. An agent's talks back through
 * `superego.reply`/`send`; an extension's is display only, and the frame is told so (it has neither).
 */
function HtmlFrame({ block }: { block: Extract<Block, { type: 'html' }> }) {
  const form = useForm()
  const frame = useRef<HTMLIFrameElement>(null)
  const css = useThemeCss()
  const [height, setHeight] = useState(block.height ?? 80)
  // The latest of what messages need, without listening again on every change.
  const latest = useRef({ form, css, html: block.html })
  latest.current = { form, css, html: block.html }
  const id = block.id ?? 'html'
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data as FrameMessage | undefined
      if (!frame.current || event.source !== frame.current.contentWindow || !data?.superego) return
      const { form, css, html } = latest.current
      if (data.kind === 'ready') frame.current.contentWindow!.postMessage({ superego: true, kind: 'render', html, css, replies: form.replies }, '*')
      else if (data.kind === 'resize' && !block.height && Number.isFinite(data.height)) setHeight(Math.min(Math.max(data.height, 20), 2000))
      else if (data.kind === 'reply' && form.replies) form.act({ values: { [id]: data.value }, button: id })
      else if (data.kind === 'send' && form.replies && data.text.trim()) form.act({ text: data.text })
    }
    addEventListener('message', receive)
    return () => removeEventListener('message', receive)
  }, [id, block.height])
  useEffect(() => { frame.current?.contentWindow?.postMessage({ superego: true, kind: 'theme', css }, '*') }, [css])
  // A new page is a new frame: written once, as it loads.
  return <iframe key={block.html} ref={frame} className="blocks-html" src={new URL(frameUrl, document.baseURI).href} sandbox="allow-scripts" title={block.id ?? 'html'} style={{ height }} />
}
