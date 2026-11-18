// mcp-servers, UI half: Settings → MCP servers (settings.tsx), and in threads:
// - MCP calls as rows (`mcp__*`): the plug, Called / Calling / Failed (or "Interrupted: may have run"), the server and
//   tool with the first short argument; open, the arguments (folded), then the result, its images inline (read from
//   the machine as they're shown, a thumbnail; whole in the lightbox)
// - tool_search's row: what it looked for, and the tools it loaded
// - a chip in the header (`mcp-servers.chip`): the plug and how many servers the thread has (in the warning's colour
//   when one wants a look: none but some left out, say), opening to each with its state, and why any were left out;
//   the same list in thread details (⌘I)
// - a notice over the composer when one of its servers needs the user to sign in or set a key
// It draws only what the daemon half says (the thread's facts, the live value `mcp-servers.servers`), so a
// machine without the extension shows none of it.
import { useState } from 'react'
import {
  defineUiExtension, factsOf, ImageFrame, Lightbox, Output, useLocalState, useValue,
  type MachineEntry, type SlotProps, type ToolRowCall, type ViewProps,
} from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { Button, CaretRightIcon, Glyph, IconButton, MagnifyingGlassIcon, PlugIcon, Popover, XIcon } from '@superego/ui'
import './styles.css'
import { DOT, firstShortString, needs, stateText } from './describe.ts'
import { ServersSection, SignInDialog } from './settings.tsx'
import { about, LEFT_OUT, SECTION, SERVERS_VALUE, splitToolName, TOOL_PREFIX, type CallDetails, type SectionData, type ServerInfo, type ThreadServers } from './shared.ts'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.settings(SECTION, ServersSection)
    superego.tool(`${TOOL_PREFIX}*`, {
      icon: PlugIcon, verbs: ['Called', 'Calling', 'Failed'], weight: 2,
      verb: (c) => c.state === 'error' && (c.result?.details as CallDetails | undefined)?.interrupted ? <span className="mcp-call__interrupted">Interrupted: may have run</span> : undefined,
      subject: (c) => <CallSubject call={c} />,
      body: (c) => <CallBody call={c} />,
      phrase: (k) => k === 1 ? 'called an MCP tool' : `called ${k} MCP tools`,
    })
    superego.tool('tool_search', {
      icon: MagnifyingGlassIcon, verbs: ['Looked for tools', 'Looking for tools', 'Couldn’t look for tools'],
      subject: (c) => typeof c.call.arguments.query === 'string' ? `“${c.call.arguments.query}”` : null,
      meta: (c) => { const n = loadedBy(c)?.length; return n === undefined ? undefined : n ? `${n} loaded` : 'none found' },
      body: (c) => { const loaded = loadedBy(c); return loaded?.length ? <SearchBody call={c} loaded={loaded} /> : undefined },
      phrase: (k) => k === 1 ? 'looked for tools' : `looked for tools ${k}×`,
    })
    superego.view('mcp-servers.chip', { title: 'MCP servers', icon: PlugIcon, context: 'thread', fits: ['header'], default: 'header', component: Chip, menuItem: MenuItem })
    superego.slot('details.section', Details)
    superego.slot('composer.above', SignInNotice, { order: 50 })
  },
})

/** What a thread says of its servers, if it has any (or would have). */
export const serversOf = (thread: ThreadInfo) => factsOf<ThreadServers>(thread, about)

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A call's server and tool by their own names and titles: from its result when it has one, else from its name. */
export function callNames(c: Pick<ToolRowCall, 'call' | 'result' | 'live' | 'thread'>) {
  const details = (c.result?.details ?? c.live?.details) as CallDetails | undefined
  const named = splitToolName(c.call.name) ?? { server: c.call.name, tool: '' }
  const server = details?.server ?? named.server
  const known = serversOf(c.thread)?.servers.find((s) => s.name === server)
  return { server: details?.serverTitle ?? known?.title ?? server, tool: details?.title ?? details?.tool ?? named.tool }
}

/** "Linear · create_issue", and what it's about. */
function CallSubject({ call }: { call: ToolRowCall }) {
  const { server, tool } = callNames(call)
  const about = firstShortString(call.call.arguments)
  return (
    <span className="row__arg mcp-call__subject" title={`${server} · ${tool}${about ? ` · ${about}` : ''}`}>
      {server} · {tool}{about && <span className="mcp-call__about"> {about}</span>}
    </span>
  )
}

/** Open: its arguments (folded), then its result, with its images, and the files it saved. */
function CallBody({ call: { machine, thread, call, result, live, state } }: { call: ToolRowCall }) {
  const [open, setOpen] = useState<number>()
  const args = Object.keys(call.arguments).length ? JSON.stringify(call.arguments, null, 2) : undefined
  const text = result ? result.text : live?.output
  const files = (result?.details as CallDetails | undefined)?.files
  return (
    <div className="mcp-call">
      {args && (
        <details className="mcp-call__args">
          <summary><CaretRightIcon className="mcp-call__caret" size={10} aria-hidden /> Arguments</summary>
          <Output text={args} />
        </details>
      )}
      {text ? <Output text={text} className={state === 'error' ? 'is-error' : ''} /> : null}
      {result?.images?.map((image, index) => (
        <ImageFrame key={index} machine={machine} thread={thread.id} image={image} className="image-frame--inline mcp-call__image" cropTall onOpen={() => setOpen(index)} />
      ))}
      {open !== undefined && result?.images && <Lightbox machine={machine} thread={thread.id} images={result.images} start={open} onClose={() => setOpen(undefined)} />}
      {files?.length ? <div className="mcp-call__files">Saved: {files.map((file) => <code key={file}>{file}</code>)}</div> : null}
    </div>
  )
}

/** The tools a search loaded, by its result. */
const loadedBy = (c: ToolRowCall) => (c.result?.details as { loaded?: string[] } | undefined)?.loaded

function SearchBody({ call, loaded }: { call: ToolRowCall; loaded: string[] }) {
  return (
    <ul className="mcp-call__loaded">
      {loaded.map((name) => {
        const { server, tool } = name.startsWith(TOOL_PREFIX) ? callNames({ ...call, call: { ...call.call, name }, result: undefined }) : { server: undefined, tool: name }
        return <li key={name}>{server ? `${server} · ` : ''}<code>{tool}</code></li>
      })}
    </ul>
  )
}

// ── On the thread ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The servers and why any were left out, as a list: the chip's popover, and thread details. */
export function ServerList({ servers }: { servers: ThreadServers }) {
  return (
    <ul className="mcp-list">
      {servers.servers.map((s) => (
        <li key={s.id} className="mcp-list__item">
          <Glyph shape={DOT[s.state]} />
          <span className="mcp-list__name" title={s.from === 'profile' ? "The profile's own" : undefined}>{s.title ?? s.name}</span>
          <span className="mcp-list__state">{stateText({ state: s.state, tools: s.tools, ...(s.deferred ? { deferred: s.deferred } : {}), config: {} })}</span>
          {s.error && <span className="mcp-list__error">{s.error}</span>}
        </li>
      ))}
      {servers.left?.map((l) => (
        <li key={`left:${l.name}`} className="mcp-list__item is-left">
          <Glyph shape="offline" />
          <span className="mcp-list__name">{l.name}</span>
          <span className="mcp-list__state">Left out: {LEFT_OUT[l.why]}</span>
        </li>
      ))}
    </ul>
  )
}

/** Whether any of a thread's servers wants a look: one failed or needing sign-in, or one left out. */
const troubled = (servers: ThreadServers) => Boolean(servers.left?.length) || servers.servers.some((s) => s.state === 'failed' || s.state === 'needs-sign-in')

/**
 * How many servers the thread has, in words ("3 servers"); with none, how many it would have had, left out (a profile
 * naming servers this machine hasn't, or has off), rather than "0 servers". The chip's row in the ··· menu, and what
 * it's called.
 */
export function chipLabel(servers: ThreadServers) {
  const count = servers.servers.length
  const left = servers.left?.length ?? 0
  if (!count && left) return `${left} left out`
  return count === 1 ? '1 server' : `${count} servers`
}

/** What the chip shows beside the plug: the count alone (of those left out, with none). */
export function chipCount(servers: ThreadServers) {
  return String(servers.servers.length || servers.left?.length || 0)
}

/** The chip's tooltip: what it counts, and why any were left out. */
export function chipTooltip(servers: ThreadServers) {
  const left = servers.left ?? []
  return [`MCP servers: ${chipLabel(servers)}`, ...left.map((l) => `${l.name} left out: ${LEFT_OUT[l.why]}`)].join('\n')
}

/** The chip's row in the title bar's ··· menu, when there's no room for it. */
export function MenuItem({ thread }: ViewProps<'thread'>) {
  const servers = serversOf(thread)
  return <>MCP: {servers ? chipLabel(servers) : 'none'}</>
}

/** In the header: the plug and how many servers ("3"), opening to its servers. */
export function Chip({ thread }: ViewProps<'thread'>) {
  const servers = serversOf(thread)
  if (!servers) return null
  return (
    <Popover tooltip={<span className="mcp-chip__tooltip">{chipTooltip(servers)}</span>} trigger={
      <button type="button" className={`mcp-chip ${troubled(servers) ? 'is-troubled' : ''}`} aria-label={`MCP servers: ${chipLabel(servers)}`}>
        <PlugIcon size={12} aria-hidden /> {chipCount(servers)}
      </button>
    }>
      <div className="mcp-chip__popup">
        <div className="mcp-chip__title">MCP servers</div>
        <ServerList servers={servers} />
      </div>
    </Popover>
  )
}

/** In thread details: the same list. */
export function Details({ thread }: SlotProps['details.section']) {
  const servers = serversOf(thread)
  if (!servers) return null
  return <><h5>MCP servers</h5><ServerList servers={servers} /></>
}

/**
 * Over the composer: a server of this thread that needs the user (to sign in, or a key set), with the way to do it.
 * Dismissed, it stays away until that server needs it again another time.
 */
function SignInNotice({ machine, thread }: SlotProps['composer.above']) {
  const data = useValue<SectionData>(machine, SERVERS_VALUE)
  const [dismissed, setDismissed] = useLocalState<string[]>('mcp-servers.dismissed', [], { shared: true })
  const [open, setOpen] = useState<ServerInfo>()
  const ids = new Set(serversOf(thread)?.servers.filter((s) => s.state === 'needs-sign-in').map((s) => s.id) ?? [])
  if (!ids.size || thread.archived) return null
  const all = [...data?.servers ?? [], ...data?.profiles ?? []]
  const waiting = all.filter((s) => ids.has(s.id) && needs(s))
  const key = (s: ServerInfo) => `${machine.id}/${s.id}/${s.error ?? ''}`
  const shown = waiting.filter((s) => !dismissed.includes(key(s)))
  return (
    <>
      {shown.map((server) => <NoticeFor key={server.id} machine={machine} server={server} onOpen={() => setOpen(server)}
        // Only those still waiting are kept dismissed: the list doesn't grow.
        onDismiss={() => setDismissed((list) => [...list.filter((k) => all.some((s) => key(s) === k)), key(server)])} />)}
      {open && <SignInDialog machine={machine.id} server={open} onClose={() => setOpen(undefined)} />}
    </>
  )
}

export function NoticeFor({ server, onOpen, onDismiss }: { machine: MachineEntry; server: ServerInfo; onOpen(): void; onDismiss(): void }) {
  const how = needs(server)
  const name = server.config.title ?? server.name
  return (
    <div className="service-notice mcp-notice" role="status" aria-live="polite">
      <div className="mcp-notice__head">
        <div className="service-notice__label">{how === 'sign-in' ? `${name} needs you to sign in.` : `${name} needs ${server.secrets.length > 1 ? 'its secrets' : 'its key'} set.`}</div>
        <IconButton label="Dismiss" className="mcp-notice__dismiss" onClick={onDismiss}><XIcon size={12} aria-hidden /></IconButton>
      </div>
      <div className="service-notice__note">Until then its tools fail, and this thread goes on without them.</div>
      <div className="service-notice__actions">
        <Button variant="primary" onClick={onOpen}>{how === 'sign-in' ? 'Sign in' : 'Set key'}</Button>
      </div>
    </div>
  )
}
