// What's put in a thread's composer from elsewhere (a pane: an element picked in a Browser pane's page), to go with its
// next message: a chip each over the box, beside the files attached there, and their files sent with the message. Kept
// in the window by thread, as long as it's open (switching threads doesn't lose them), until they're sent or removed.
import { useSyncExternalStore, type ReactNode } from 'react'
import type { Attachment } from '@superego/protocol'

/**
 * Something for a thread's next message, as one chip in its composer: `icon` and `label` on it (no icon: the first image
 * of `files` as its thumbnail), and on hover that image larger and `detail`. Sent, its `files` go with the message as
 * attachments (a text file's words to the agent inline, an image as an image), in order.
 */
export type ComposerItem = {
  label: string
  icon?: ReactNode
  /** More of what it is, shown on hover: a few short lines, set as code. */
  detail?: string
  files: Attachment[]
}

/** An item as the composer holds it: with an id of its own. */
export type HeldItem = ComposerItem & { id: string }

type Where = { machine: string; thread: string }
const keyOf = ({ machine, thread }: Where) => `${machine}/${thread}`
const held = new Map<string, HeldItem[]>()
const listeners = new Set<() => void>()
/** The thread whose composer is to take the keyboard, for the composer to see as it changes. */
let focusAsked: { key: string; at: number } | undefined
const NONE: HeldItem[] = []
const changed = () => { for (const listener of listeners) listener() }

/**
 * Put `item` in the composer of `thread` on `machine`, after what's there, and give that composer the keyboard (once
 * it shows, if it doesn't yet).
 *
 * ```ts
 * addToComposer({ machine: machine.id, thread: thread.id }, { label: '<button.primary>', files: [shot] })
 * ```
 */
export function addToComposer(where: Where, item: ComposerItem) {
  const key = keyOf(where)
  held.set(key, [...held.get(key) ?? [], { ...item, id: crypto.randomUUID() }])
  focusAsked = { key, at: Date.now() }
  changed()
}

const inserted = new Map<string, string[]>()

/**
 * Put `text` in the draft of `thread` on `machine`, after what's typed, and give its composer the keyboard (once it
 * shows, if it doesn't yet): an identifier picked in Inspect mode, say.
 */
export function insertInComposer(where: Where, text: string) {
  const key = keyOf(where)
  inserted.set(key, [...inserted.get(key) ?? [], text])
  focusAsked = { key, at: Date.now() }
  changed()
}

/** What `insertInComposer` put in the thread's draft since it was last asked: the composer takes it into the draft. */
export function takeInserted(where: Where): string[] {
  const key = keyOf(where)
  const texts = inserted.get(key) ?? []
  inserted.delete(key)
  return texts
}

/** Set what a thread's composer holds: taken off as it's sent or removed, put back when sending failed. */
export function setComposerItems(where: Where, items: HeldItem[]) {
  const key = keyOf(where)
  if (items.length) held.set(key, items)
  else held.delete(key)
  changed()
}

/** What a thread's composer holds now. */
export const composerItems = (where: Where): HeldItem[] => held.get(keyOf(where)) ?? NONE

/** The thread's composer has taken the keyboard it was asked to: not again, as it's drawn anew. */
export function focusTaken(where: Where) {
  if (focusAsked?.key !== keyOf(where)) return
  focusAsked = undefined
  changed()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** What a thread's composer holds now, as it changes. */
export const useComposerItems = (where: Where) => useSyncExternalStore(subscribe, () => composerItems(where))

/** When the thread's composer was last asked to take the keyboard (by `addToComposer`), as it changes; 0 if never. */
export const useFocusAsked = (where: Where) => useSyncExternalStore(subscribe, () => focusAsked?.key === keyOf(where) ? focusAsked.at : 0)
