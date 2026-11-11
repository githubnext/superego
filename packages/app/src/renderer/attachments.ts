// Files with a message: read in the window to send (base64), and found again in a sent message to show. The daemon
// names each to the agent as an <attachment name type path /> text block, an image's followed by the image itself.
import type { Attachment } from '@mu/protocol'

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

type Block = { type: string; text?: string; data?: string; mimeType?: string }
export type Sent = { name: string; type: string; path: string; image?: string }

const TAG = /^<attachment name="([^"]*)" type="([^"]*)" path="([^"]*)"/
const unquote = (value: string) => value.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))

/** A skill the message named, sent with it whole by the daemon. */
const SKILL = /^<skill name="([^"]*)" location="([^"]*)">/

/** A sent message's own text, the files that went with it (an image's as a data URL), and the skills it named. */
export function splitMessage(blocks: Block[]): { text: string; files: Sent[]; skills: { name: string; path: string }[] } {
  const text: string[] = []
  const files: Sent[] = []
  const skills: { name: string; path: string }[] = []
  blocks.forEach((block, index) => {
    if (block.type !== 'text') return
    const skill = SKILL.exec(block.text ?? '')
    if (skill) return void skills.push({ name: unquote(skill[1]!), path: unquote(skill[2]!) })
    const tag = TAG.exec(block.text ?? '')
    if (!tag) return void text.push(block.text ?? '')
    const next = blocks[index + 1]
    files.push({
      name: unquote(tag[1]!), type: unquote(tag[2]!), path: unquote(tag[3]!),
      ...(next?.type === 'image' && next.data ? { image: `data:${next.mimeType};base64,${next.data}` } : {}),
    })
  })
  return { text: text.join(''), files, skills }
}
