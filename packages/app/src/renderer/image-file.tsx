// An image file open in the editor pane (or any FileEditor): the picture itself, fitted to the pane and centred, its size
// in pixels in the bar. Read as the thread's images are (image-cache.ts, whole), so it follows the file when it changes
// and shows on a phone or in a browser too; why it can't be read goes in the bar.
import { useEffect, useState, type ReactNode } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'
import { useImageSource } from './images.tsx'
import { imageType } from './markdown-html.ts'
import { filePath } from './short-path.ts'

/** Whether a file shows as an image rather than as text: a picture's, not SVG's (its source is text to edit). */
export const isImageFile = (path: string) => imageType(path).startsWith('image/') && !/\.svg$/i.test(path)

export function ImageFile({ machine, thread, path, actions }: { machine: MachineEntry; thread: ThreadInfo; path: string; actions?: ReactNode }) {
  const { src, broken, problem } = useImageSource(machine, thread.id, { name: path, path }, true, 'whole')
  const [size, setSize] = useState<{ width: number; height: number }>()
  const [failed, setFailed] = useState<string>()
  const error = broken ? `Can’t show it: ${problem ?? 'unreadable'}` : src && failed === src ? 'Can’t show it: not an image this can draw' : undefined
  useEffect(() => { if (error) console.error(`${path}: ${error}`) }, [path, error])
  return (
    <div className="image-file">
      <div className="pane-bar">
        <code title={path}>{filePath(thread.cwd, path)}</code>
        <span className={`pane-bar__note ${error ? 'is-error' : ''}`}>{error ?? (size && `${size.width} × ${size.height}`)}</span>
        {actions}
      </div>
      <div className="image-file__stage">
        {src && !error && (
          <img className="image-file__img" src={src} alt="" draggable={false} onError={() => setFailed(src)}
            onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
        )}
      </div>
    </div>
  )
}
