// Attachments sent ahead as uploads, each on its own channel, so a large file can't hold up the calls behind it. A
// client keeps passing inline base64 (`data`); before the call goes out, larger files go up and the call names them by
// upload. Needs the daemon's `uploads` feature. No Node imports: a browser's WebSocket client can use it too.
import { attachmentsIn, CHUNK, Channels, fromBase64, withAttachments, type Attachment, type AttachmentRef, type RpcPeer } from '@superego/protocol'

const large = (attachment: AttachmentRef): attachment is Attachment => 'data' in attachment && attachment.data.length > CHUNK

/** Whether a call carries an attachment worth uploading first. */
export function carriesFiles(method: string, params: unknown): boolean {
  return attachmentsIn(method, params)?.some(large) ?? false
}

/** Send one file up; its upload id names it in a message on this connection. */
export async function upload(peer: RpcPeer, file: { name: string; mimeType: string; bytes: Uint8Array }): Promise<string> {
  const channel = await Channels.of(peer).open('upload', { name: file.name, mimeType: file.mimeType, size: file.bytes.length })
  await channel.write(file.bytes)
  channel.end()
  // The daemon ends its half once it holds the whole file.
  await channel.ended
  return channel.id
}

/** `params` with its larger inline attachments uploaded and named by upload instead; the daemon must offer `uploads`. */
export async function uploadAttachments<T>(peer: RpcPeer, method: string, params: T): Promise<T> {
  const attachments = attachmentsIn(method, params)
  if (!attachments?.some(large)) return params
  return withAttachments(method, params, await Promise.all(attachments.map(async (attachment): Promise<AttachmentRef> => {
    if (!large(attachment)) return attachment
    const id = await upload(peer, { name: attachment.name, mimeType: attachment.mimeType, bytes: fromBase64(attachment.data) })
    return { name: attachment.name, mimeType: attachment.mimeType, upload: id }
  })))
}
