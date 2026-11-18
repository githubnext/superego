// Files with a message: read in the window to send (base64), and found again in a sent message to show. The daemon
// names each to the agent as an <attachment name type path /> text block, an image's followed by the image itself.
import type { Attachment } from '@superego/protocol'

/** What one file may weigh: the daemon's limit too. */
export const ATTACHMENT_LIMIT = 20 * 1024 * 1024

/** A picked, dropped or pasted file, ready to send. */
export function readAttachment(file: File): Promise<Attachment> {
  if (file.size > ATTACHMENT_LIMIT) return Promise.reject(new Error(`${file.name} is larger than ${ATTACHMENT_LIMIT / 1024 / 1024} MB`))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      // A pasted screenshot has no name of its own.
      const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${file.type.split('/')[1] ?? 'png'}`
      resolve({ name, mimeType: file.type || 'application/octet-stream', data: url.slice(url.indexOf(',') + 1) })
    }
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

type Block = { type: string; text?: string; data?: string; mimeType?: string; width?: number; height?: number }
/**
 * A file sent with a message; an image's `image` is the image block the model was given, by its index in the
 * message's content, its size when known, and its pixels only when its daemon sent them (one from before `image.read`).
 */
export type Sent = { name: string; type: string; path: string; image?: { block: number; mimeType: string; width?: number; height?: number; data?: string } }

const TAG = /^<attachment name="([^"]*)" type="([^"]*)" path="([^"]*)"/
const unquote = (value: string) => value.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))

/** A sent message's own text, and the files that went with it; `at`: the blocks' indexes in the message, when they're some of them. */
export function splitMessage(blocks: Block[], at?: readonly number[]): { text: string; files: Sent[] } {
  const text: string[] = []
  const files: Sent[] = []
  blocks.forEach((block, index) => {
    if (block.type !== 'text') return
    const tag = TAG.exec(block.text ?? '')
    if (!tag) return void text.push(block.text ?? '')
    const next = blocks[index + 1]
    files.push({
      name: unquote(tag[1]!), type: unquote(tag[2]!), path: unquote(tag[3]!),
      ...(next?.type === 'image' ? { image: {
        block: at?.[index + 1] ?? index + 1, mimeType: next.mimeType ?? '', ...(next.width && next.height ? { width: next.width, height: next.height } : {}), ...(next.data ? { data: next.data } : {}),
      } } : {}),
    })
  })
  return { text: text.join(''), files }
}
