// What both halves agree on: what it is, the tool's name, its layouts, and what a call keeps of each image it showed.
import type { ExtensionAbout } from '@superego/protocol'

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'images', version: '1.0.0', api: '^1', title: 'Images', description: 'Show images and screenshots in the thread.' } satisfies ExtensionAbout

export const TOOL = 'show_images'

export const LAYOUTS = ['single', 'grid', 'carousel'] as const
export type Layout = (typeof LAYOUTS)[number]

/** One image as shown: a file kept on the thread's machine (`path`, read with `file.read`), or a web address (`url`). */
export type Shown = {
  /** Where it came from, as the agent named it: a path or an address. */
  name: string
  path?: string
  url?: string
  mimeType?: string
  /** Its size in pixels, when known, so a placeholder takes its place before it loads. */
  width?: number
  height?: number
  caption?: string
  alt?: string
}

export type ShowDetails = { title?: string; layout: Layout; images: Shown[] }

/** One image alone; two to four side by side; more, one at a time. */
export const layoutFor = (count: number): Layout => count <= 1 ? 'single' : count <= 4 ? 'grid' : 'carousel'
