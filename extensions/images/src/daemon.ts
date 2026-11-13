// images, daemon half: a `show_images` tool for the agent to show the user images (a screenshot it took, a chart it
// drew) in the thread itself: one, a few side by side, or many one at a time. Each file is checked to be an image and
// copied among the files the thread keeps (`threads.attachments`), so every client, a browser or phone over the web
// too, reads it there with `file.read`, and it stays what was shown even when the original changes or goes. The model
// gets a line back, not the pixels.
import { copyFile, mkdir, open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { arr, obj, oneOf, opt, str } from '@earendil-works/pi-schema'
import { defineDaemonExtension } from '@superego/daemon'
import { sniff } from './image.ts'
import { about, LAYOUTS, TOOL, layoutFor, type Layout, type ShowDetails, type Shown } from './shared.ts'

/** How big one image may be, and how many one call shows. */
export const MAX_BYTES = 10 * 1024 * 1024
export const MAX_IMAGES = 24

const PROMPT = `When you have an image for the user to see (a screenshot you took, a chart or diagram you rendered, an image you made or found), show it in the thread with ${TOOL} rather than only naming its path. Several related images go in one call, captioned where it helps.`

type Asked = { path?: string; url?: string; caption?: string; alt?: string }

/** One asked-for image, checked: kept as a copy among the thread's files, or a web address as it is. */
export async function check(asked: Asked, cwd: string): Promise<{ shown: Shown; file?: { from: string; ext: string } } | { error: string }> {
  const extra = { ...(asked.caption?.trim() ? { caption: asked.caption.trim() } : {}), ...(asked.alt?.trim() ? { alt: asked.alt.trim() } : {}) }
  if (asked.url !== undefined && asked.path !== undefined) return { error: 'give a path or a url, not both' }
  if (asked.url !== undefined) {
    const url = URL.canParse(asked.url) ? new URL(asked.url) : undefined
    if (url?.protocol === 'file:') return { error: `${asked.url}: give a file as its path, not a file:// address` }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return { error: `${asked.url} is not a web address (http or https)` }
    return { shown: { name: asked.url, url: url.href, ...extra } }
  }
  if (!asked.path?.trim()) return { error: 'each image needs a path or a url' }
  const name = asked.path.trim()
  const file = resolve(cwd, name.replace(/^~(?=\/|$)/, homedir()))
  const info = await stat(file).catch(() => undefined)
  if (!info) return { error: `${name}: no such file` }
  if (!info.isFile()) return { error: `${name} is not a file` }
  if (info.size > MAX_BYTES) return { error: `${name} is ${(info.size / 1024 / 1024).toFixed(1)} MB; images up to ${MAX_BYTES / 1024 / 1024} MB are shown` }
  // The header is enough to tell what it is and how big.
  const handle = await open(file)
  const head = new Uint8Array(64 * 1024)
  const { bytesRead } = await handle.read(head, 0, head.length, 0).finally(() => handle.close())
  const kind = sniff(head.subarray(0, bytesRead))
  if (!kind) return { error: `${name} is not an image (PNG, JPEG, GIF, WebP or SVG)` }
  const { mimeType, width, height, ext } = kind
  return { shown: { name, mimeType, ...(width && height ? { width, height } : {}), ...extra }, file: { from: file, ext } }
}

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    superego.agent(defineExtension({
      name: 'images',
      tools: [defineTool({
        name: TOOL,
        description: 'Show images to the user, inline in this conversation: screenshots, charts, diagrams, photos. Each is a file on '
          + 'this machine (path: relative to the working folder, or absolute) or a web address (url), with an optional caption '
          + `and alt text. PNG, JPEG, GIF, WebP or SVG, up to ${MAX_BYTES / 1024 / 1024} MB each. Layout: "single", "grid", or "carousel" `
          + '(one at a time); left out, one image shows alone, two to four in a grid, more as a carousel. The user can click one to '
          + 'zoom. You get a confirmation back, not the images.',
        parameters: obj({
          images: arr(obj({
            path: opt(str({ description: 'A file on this machine: relative to the working folder, or absolute.' })),
            url: opt(str({ description: 'An http(s) address, instead of a path.' })),
            caption: opt(str()),
            alt: opt(str({ description: 'What it shows, for those who can’t see it.' })),
          }), { minItems: 1, maxItems: MAX_IMAGES }),
          layout: opt(oneOf(LAYOUTS)),
          title: opt(str()),
        }),
        replay: 'safe',
        async execute({ images, layout, title }, api) {
          const thread = superego.threads.of(api.conversationId) ?? String(api.conversationId)
          const cwd = api.env?.cwd ?? (await superego.threads.get(thread).catch(() => undefined))?.cwd ?? homedir()
          const checked = await Promise.all(images.map((image) => check(image, cwd)))
          const errors = checked.flatMap((c) => 'error' in c ? [c.error] : [])
          if (errors.length) throw new Error(errors.length === 1 ? `Couldn’t show it: ${errors[0]}` : `Couldn’t show ${errors.length} of ${images.length}:\n- ${errors.join('\n- ')}`)
          // Kept under the thread's files, one copy per image of this call: shown as it was, wherever it came from.
          const dir = join(superego.threads.attachments(thread), 'shown')
          await mkdir(dir, { recursive: true })
          const call = api.callId.replace(/[^\w.-]+/g, '_')
          const shown = await Promise.all(checked.map(async (c, index): Promise<Shown> => {
            if ('error' in c) throw new Error(c.error)
            if (!c.file) return c.shown
            const stem = basename(c.file.from).replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60)
            const path = join(dir, `${call}-${index + 1}-${stem}.${c.file.ext}`)
            await copyFile(c.file.from, path)
            return { ...c.shown, path }
          }))
          const details: ShowDetails = { ...(title?.trim() ? { title: title.trim() } : {}), layout: (layout ?? layoutFor(shown.length)) as Layout, images: shown }
          return { output: [{ type: 'text', text: shown.length === 1 ? 'Showed 1 image.' : `Showed ${shown.length} images.` }], details }
        },
      })],
      sections: [section('images', () => PROMPT)],
    }))
  },
})
