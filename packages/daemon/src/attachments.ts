// What's sent with a message: each file kept in its thread's folder on this machine (attachments/<thread>/) and named
// to the agent by its path, a small text file inline too, an image also given to the model as an image.
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { obj, RpcError, str, type Attachment } from '@superego/protocol'
import { quote } from './agents-md.ts'
import { UPLOAD_LIMIT } from './connection.ts'
import type { MessageBlock } from './extension.ts'

/** An attachment as an action's params take it: inline, base64 (uploads are inline again by then, see connection.ts). */
export const ATTACHMENT = obj({ name: str({ minLength: 1 }), mimeType: str(), data: str() })
/** What one attachment may weigh: what an upload may. */
const ATTACHMENT_LIMIT = UPLOAD_LIMIT
/** How small a text file is to be shown to the model whole. */
const INLINE_LIMIT = 100 * 1024
/** Images the models take as images. */
const IMAGE = /^image\/(png|jpeg|gif|webp)$/
const isText = (mimeType: string, name: string) =>
  /^text\/|json|xml|javascript|typescript|yaml|toml|csv|markdown|x-sh/.test(mimeType)
    || /\.(md|markdown|txt|ts|tsx|js|jsx|mjs|json|css|html|py|rs|go|rb|swift|kt|java|c|h|cpp|yml|yaml|toml|csv|log|sh|sql|ini|env)$/i.test(name)

/** Where a thread's files are kept on this machine: its attachments, and the images it showed. */
export const attachmentsDir = (dataDir: string, thread: string) => join(dataDir, 'attachments', thread)

/** A message's content with its attachments, each saved in `dir` (a thread's `attachmentsDir`): the text alone without any. */
export async function contentOf(dir: string, text: string, attachments: Attachment[]): Promise<string | MessageBlock[]> {
  if (!attachments.length) return text
  await mkdir(dir, { recursive: true })
  const blocks: MessageBlock[] = []
  if (text.trim()) blocks.push({ type: 'text', text })
  for (const attachment of attachments) {
    const bytes = Buffer.from(attachment.data, 'base64')
    if (bytes.length > ATTACHMENT_LIMIT) throw new RpcError('too_large', `${attachment.name} is larger than ${ATTACHMENT_LIMIT / 1024 / 1024} MB`)
    const name = basename(attachment.name.replace(/\\/g, '/')).replace(/^\.+/, '') || 'attachment'
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    let path = join(dir, name)
    for (let n = 2; await stat(path).then(() => true, () => false); n++) path = join(dir, `${stem}-${n}${ext}`)
    await writeFile(path, bytes)
    const tag = `<attachment name="${quote(name)}" type="${quote(attachment.mimeType)}" path="${quote(path)}"`
    if (IMAGE.test(attachment.mimeType)) {
      blocks.push({ type: 'text', text: `${tag} />` }, { type: 'image', data: attachment.data, mimeType: attachment.mimeType })
    } else if (bytes.length <= INLINE_LIMIT && isText(attachment.mimeType, name)) {
      blocks.push({ type: 'text', text: `${tag}>\n${bytes.toString('utf8')}\n</attachment>` })
    } else blocks.push({ type: 'text', text: `${tag} />` })
  }
  return blocks
}
