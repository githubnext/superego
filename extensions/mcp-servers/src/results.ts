// What an MCP tool's result becomes for the model: text and images as they are, other content said in a line, blobs
// saved in the thread's files, the text cut at 50 KB (the whole of it saved beside the thread); and what the model is
// told of a call that may or may not have run.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/** Text over this many bytes, or lines, is cut (its head kept). */
export const MAX_BYTES = 50 * 1024
export const MAX_LINES = 2000

const extensionOf = (mimeType: string | undefined) => {
  const sub = mimeType?.split('/')[1]?.split(/[;+]/)[0]
  return sub && /^[a-z0-9.-]{1,16}$/i.test(sub) ? `.${sub.replace('plain', 'txt').replace('jpeg', 'jpg')}` : '.bin'
}
const safe = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'file'

/**
 * A result's content for the model. `files`: the thread's folder for files (`threads.attachments`), where blobs are
 * saved, and the call's id to name them by.
 */
export async function contentOf(result: CallToolResult, files: { dir: string; call: string }): Promise<{ content: Content[]; saved: string[] }> {
  const content: Content[] = []
  const saved: string[] = []
  const save = async (base: string, data: Buffer | string) => {
    await mkdir(files.dir, { recursive: true })
    const path = join(files.dir, `mcp-${safe(files.call)}-${saved.length + 1}-${safe(base)}`)
    await writeFile(path, data)
    saved.push(path)
    return path
  }
  for (const item of result.content ?? []) {
    switch (item.type) {
      case 'text': content.push({ type: 'text', text: item.text }); break
      case 'image': content.push({ type: 'image', data: item.data, mimeType: item.mimeType }); break
      case 'audio': content.push({ type: 'text', text: `[Audio (${item.mimeType}) left out: it can't be shown here.]` }); break
      case 'resource_link': {
        const about = [item.name && item.name !== item.uri ? item.name : '', item.mimeType ?? '', item.description ?? ''].filter(Boolean).join(', ')
        content.push({ type: 'text', text: `[Resource: ${item.uri}${about ? ` (${about})` : ''}]` })
        break
      }
      case 'resource': {
        const resource = item.resource
        if ('text' in resource && typeof resource.text === 'string') content.push({ type: 'text', text: `${resource.uri}:\n${resource.text}` })
        else if ('blob' in resource && typeof resource.blob === 'string') {
          const name = resource.uri.split(/[/?#]/).filter(Boolean).pop() ?? 'resource'
          const path = await save(/\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}${extensionOf(resource.mimeType)}`, Buffer.from(resource.blob, 'base64'))
          content.push({ type: 'text', text: `[${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ''} saved to ${path}]` })
        }
        break
      }
    }
  }
  // Only structured output, and nothing to read: the model gets that as text.
  if (!content.length && result.structuredContent) content.push({ type: 'text', text: JSON.stringify(result.structuredContent, null, 2) })
  return { content: await capped(content, save), saved }
}

/** Text over the limits cut to them, its head kept, the whole saved and named by path. */
async function capped(content: Content[], save: (name: string, data: string) => Promise<string>): Promise<Content[]> {
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  const lines = text.split('\n')
  if (Buffer.byteLength(text) <= MAX_BYTES && lines.length <= MAX_LINES) return content
  const path = await save('output.txt', text)
  let head = lines.slice(0, MAX_LINES).join('\n')
  if (Buffer.byteLength(head) > MAX_BYTES) head = Buffer.from(head).subarray(0, MAX_BYTES).toString('utf8').replace(/\uFFFD$/, '')
  const cut = head.split('\n').length
  return [
    { type: 'text', text: `${head}\n\n[Cut at ${cut} of ${lines.length} lines (${Math.round(Buffer.byteLength(text) / 1024)} KB). The whole output is in ${path}.]` },
    ...content.filter((c) => c.type === 'image'),
  ]
}

/**
 * What the model is told of a call that may or may not have run, `how` it went: cut off before it answered (its session
 * stopped, restarted or crashed), or running when Superego stopped (never sent again). So it checks before calling again.
 */
export function mayHaveRun(server: string, tool: string, how: string, ownSession: boolean): string {
  return `${server}.${tool} ${how}\nIt may or may not have taken effect on the server. `
    + `Check (for example, list or read what it would have changed) before calling it again.`
    + (ownSession ? ` ${server} ran for this thread only, so its session (anything it kept, such as an open page) is gone too.` : '')
}
