// Selecting an element in a Browser pane's page, as DevTools' inspector does: the toolbar's button (or ⌘⇧C) puts the
// page in pick mode (picker.ts, run in the page), and the element clicked shows in a card at the pane's foot, with an
// image of it: its selector, its tag and text. From there it's added to the thread's composer, as a chip whose files
// tell the agent what it is and where (element.ts), or its selector copied.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { addToComposer, type WebViewHandle } from '@superego/app/ui'
import { Button, CheckIcon, CopyIcon, CursorClickIcon, IconButton, XIcon } from '@superego/ui'
import { cancelPick, pick, type Picked } from './picker.ts'
import { base64, elementFiles, HTML_LIMIT, whereOf } from './element.ts'

/** An element picked, and an image of it (a PNG's base64) where one could be taken. */
export type Selection = { picked: Picked; image?: string }

/** The accent as a colour the page can draw with: the app's token resolved, here. */
function accentIn(el: HTMLElement | null) {
  if (!el) return ''
  const probe = document.createElement('span')
  probe.style.color = 'var(--superego-accent)'
  el.append(probe)
  const colour = getComputedStyle(probe).color
  probe.remove()
  return colour
}

/** An image of the part of `found` that's in view. */
async function imageOf(view: WebViewHandle, { box, viewport }: Picked): Promise<string | undefined> {
  const x = Math.max(0, box.x), y = Math.max(0, box.y)
  const width = Math.min(viewport.width, box.x + box.width) - x, height = Math.min(viewport.height, box.y + box.height) - y
  if (width < 1 || height < 1) return undefined
  const png = await view.capture({ x, y, width, height })
  return png && base64(new Uint8Array(await png.arrayBuffer()))
}

/**
 * Pick mode for a pane's page (`view`): started, the page has the keyboard (for Esc and ↑↓) and the picker runs in
 * it until an element's clicked or it's cancelled; picked, the element and its image. `frame`: the pane, whose accent
 * the outline takes. `onError` says what failed, in the pane.
 */
export function usePicking(view: RefObject<WebViewHandle | null>, frame: RefObject<HTMLElement | null>, onError: (message: string) => void) {
  const [picking, setPicking] = useState(false)
  const [selection, setSelection] = useState<Selection>()
  // The picking under way, by its count: what an earlier one answers late (cancelled, its page gone) is dropped.
  const count = useRef(0)
  const failed = (error: Error) => {
    console.error('Selecting an element in the page:', error)
    onError(error.message)
  }
  const start = async () => {
    const handle = view.current
    if (!handle) return
    const id = ++count.current
    setPicking(true)
    setSelection(undefined)
    handle.focus()
    try {
      const found = await handle.run(pick, { accent: accentIn(frame.current), htmlLimit: HTML_LIMIT })
      if (id !== count.current) return
      setPicking(false)
      if (!found) return
      let image: string | undefined
      try { image = await imageOf(handle, found) } catch (error) { failed(error as Error) }
      if (id === count.current) setSelection({ picked: found, ...(image ? { image } : {}) })
    } catch (error) {
      if (id !== count.current) return
      setPicking(false)
      failed(error as Error)
    }
  }
  const cancel = () => {
    count.current++
    setPicking(false)
    view.current?.run(cancelPick).catch((error: Error) => console.error('Leaving pick mode in the page:', error))
  }
  // Picking as the pane goes: the page's layer goes with it.
  const latest = useRef({ picking, cancel })
  latest.current = { picking, cancel }
  useEffect(() => () => { if (latest.current.picking) latest.current.cancel() }, [])
  return { picking, selection, start, cancel, toggle: () => picking ? cancel() : void start(), dismiss: () => setSelection(undefined) }
}

/** The toolbar's Select element: pressed while picking; disabled, with why, where the page can't be reached. */
export function PickButton({ picking, disabled, why, keys, onClick }: { picking: boolean; disabled: boolean; why?: string | undefined; keys?: string | undefined; onClick(): void }) {
  const label = 'Select element'
  return (
    <IconButton label={disabled && why ? why : keys ? `${label} (${keys})` : label} aria-label={label} aria-pressed={picking} variant="ghost"
      className={`browser-pick ${picking ? 'is-on' : ''}`} disabled={disabled} onClick={onClick}>
      <CursorClickIcon size={14} aria-hidden />
    </IconButton>
  )
}

/**
 * The element picked, at the pane's foot: an image of it, its selector, its tag and text; Add to prompt puts it in the
 * thread's composer (and the card goes), Copy selector copies that.
 */
export function PickedCard({ selection: { picked, image }, address, where, onDone, onError }: {
  selection: Selection; address: string; where: { machine: string; thread: string }; onDone(): void; onError(message: string): void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => navigator.clipboard.writeText(picked.selector).then(() => setCopied(true), (error: Error) => {
    console.error('Copying the selector:', error)
    onError(`Couldn't copy the selector: ${error.message}`)
  })
  const add = () => {
    addToComposer(where, { label: `${picked.label} · ${whereOf(address)}`, icon: <CursorClickIcon size={13} aria-hidden />, detail: picked.selector, files: elementFiles(picked, address, image) })
    onDone()
  }
  return (
    <div className="browser-picked" role="group" aria-label="Selected element">
      {image && <img className="browser-picked__image" src={`data:image/png;base64,${image}`} alt="" />}
      <div className="browser-picked__text">
        <code className="browser-picked__selector" title={picked.selector}>{picked.selector}</code>
        <span className="browser-picked__about" title={picked.text ? `${picked.opening} ${picked.text}` : picked.opening}>
          <code>{picked.opening}</code>{picked.text && <> {picked.text}</>}
        </span>
      </div>
      <IconButton label={copied ? 'Copied' : 'Copy selector'} variant="ghost" onClick={() => void copy()}>
        {copied ? <CheckIcon size={14} aria-hidden /> : <CopyIcon size={14} aria-hidden />}
      </IconButton>
      <Button variant="primary" onClick={add}>Add to prompt</Button>
      <IconButton label="Dismiss" variant="ghost" onClick={onDone}><XIcon size={12} aria-hidden /></IconButton>
    </div>
  )
}
