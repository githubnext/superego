// The pane row's arithmetic (see panes.tsx): how wide each column is, in either layout, and which pane a stack shows.

/** A column's width (a share of the room) until it's dragged, unless its kind says otherwise. */
export const DEFAULT_SHARE = 0.5
/** Wide, the room after each column (the last too): its handle, to drag it wider or narrower. */
export const GAP = 8
/** No column narrower than this, however many: the row scrolls instead (stacked, it's shared out). */
export const MIN_COLUMN = 380
/** Scrolled, room past the last column's handle: so the handle is never at the window's edge, and can be dragged out. */
export const END = 20
/** The last column's handle dragged within this of where it takes what the others leave: it does again. */
export const SNAP = 12

/** The room `columns` columns share in a row `rowWidth` wide: the row less the gap after each. */
export const roomFor = (rowWidth: number, columns: number) => Math.max(0, rowWidth - GAP * columns)

/**
 * How wide a column is, as the thread keeps it (`pane.resize`): factors of the window's width, so it's the same
 * proportion in any window. A pane's `lastWidth` is its own while it's the last one.
 */
export type SavedWidth = { width?: number | undefined; lastWidth?: number | undefined }

/**
 * Each column's share of the room `room` (what the layouts take), from the widths the thread keeps (`saved`: the
 * thread's, then each pane's), factors of the window's width `windowWidth`. One not kept takes its default
 * (`defaults`, else DEFAULT_SHARE), but the last (at `last`), which takes the room the others leave until its own is kept. What doesn't
 * fit is the layout's to clamp: what's kept stays as it is.
 */
export function columnShares(saved: SavedWidth[], defaults: (number | undefined)[], last: number, windowWidth: number, room: number): (number | undefined)[] {
  const share = (factor: number | undefined) => factor === undefined ? undefined : factor * windowWidth / Math.max(1, room)
  return saved.map((column, i) => i === last ? share(column.lastWidth) : share(column.width) ?? defaults[i] ?? DEFAULT_SHARE)
}

/** A column `width` px wide, as the factor of the window's width the thread keeps: rounded, so what's kept and what's shown agree. */
export const windowFactor = (width: number, windowWidth: number) => Math.min(1, Math.max(0.0001, Math.round((width / Math.max(1, windowWidth)) * 10_000) / 10_000))

/**
 * Scrolled: each column its share of the room, no narrower than MIN_COLUMN nor wider than the room. The last one's
 * share undefined (not dragged), it takes the room the others leave. The row may be wider than the room: it scrolls.
 */
export function scrollWidths(room: number, shares: (number | undefined)[]): number[] {
  const fit = (width: number) => Math.min(room, Math.max(MIN_COLUMN, width))
  const widths = shares.map((share) => fit(Math.round((share ?? 0) * room)))
  const last = shares.length - 1
  if (last >= 0 && shares[last] === undefined) widths[last] = fit(room - widths.slice(0, last).reduce((sum, w) => sum + w, 0))
  return widths
}

/**
 * Scrolled with the thread kept in view (the first column, standing still while the rest scroll beside it): the thread
 * its share of the room, leaving its panes at least MIN_COLUMN (else half); each pane its share, no wider than what's in
 * view beside the thread (the room it leaves, and the room after every pane but one), the last what the others leave.
 */
export function keptWidths(room: number, shares: (number | undefined)[]): number[] {
  if (shares.length < 2) return scrollWidths(room, shares)
  const least = Math.min(MIN_COLUMN, Math.floor(room / 2))
  const thread = Math.min(room - least, Math.max(least, Math.round((shares[0] ?? DEFAULT_SHARE) * room)))
  const beside = room - thread + GAP * (shares.length - 2)
  const fit = (width: number) => Math.min(beside, Math.max(MIN_COLUMN, width))
  const panes = shares.slice(1).map((share) => fit(Math.round((share ?? 0) * room)))
  const last = panes.length - 1
  if (shares.at(-1) === undefined) panes[last] = fit(room - thread - panes.slice(0, last).reduce((sum, w) => sum + w, 0))
  return [thread, ...panes]
}

/**
 * The last column's share once its handle is dragged to `width`, the others `used` wide: none (it takes what they
 * leave) near that, else its own, wider (the row scrolls) or narrower.
 */
export function endShare(width: number, room: number, used: number): number | undefined {
  const left = Math.min(room, Math.max(MIN_COLUMN, room - used))
  return Math.abs(width - left) <= SNAP ? undefined : Math.min(1, Math.max(0.15, width / Math.max(1, room)))
}

/**
 * Stacked: the thread its share of the room, the panes' column the rest; together never more than the room. Neither
 * is narrower than MIN_COLUMN while there's room for both, else than half.
 */
export function stackWidths(room: number, threadShare: number | undefined): [thread: number, stack: number] {
  const least = Math.min(MIN_COLUMN, Math.floor(room / 2))
  const thread = Math.min(room - least, Math.max(least, Math.round((threadShare ?? DEFAULT_SHARE) * room)))
  return [thread, room - thread]
}

/** The pane a stack shows: the one last brought to its front, while it's open; else the focused one; else the last. */
export function frontOf(panes: string[], brought: string | undefined, focused: string | undefined): string | undefined {
  if (brought && panes.includes(brought)) return brought
  if (focused && panes.includes(focused)) return focused
  return panes.at(-1)
}

/** `ids` with `id` moved to `to` (clamped to the ends). */
export function moved(ids: string[], id: string, to: number): string[] {
  const rest = ids.filter((other) => other !== id)
  if (rest.length === ids.length) return ids
  const at = Math.max(0, Math.min(rest.length, to))
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/**
 * The panes in the order asked for (a move on its way to the thread), while that's the same panes; else as the thread
 * has them. A pane opening or closing meanwhile, the thread's order is taken again.
 */
export function arranged<T extends { id: string }>(panes: T[], asked: string[] | undefined): T[] {
  if (!asked || asked.length !== panes.length) return panes
  const byId = new Map(panes.map((pane) => [pane.id, pane]))
  const out = asked.flatMap((id) => byId.get(id) ?? [])
  return out.length === panes.length ? out : panes
}

/**
 * Where a tab being dragged lands among the tabs in the strip (`slots`, left to right, it among them at `from`), moved
 * `by` from its place: past each whose middle its leading edge has passed (its right edge going right, its left going left).
 */
export function dropIndex(slots: { left: number; width: number }[], from: number, by: number): number {
  const self = slots[from]!
  const left = self.left + by
  const right = left + self.width
  let to = from
  slots.forEach((slot, i) => {
    const middle = slot.left + slot.width / 2
    if (i > from && right > middle) to = Math.max(to, i)
    if (i < from && left < middle) to = Math.min(to, i)
  })
  return to
}

/** How far the tab at `i` slides aside while the one at `from` is over `to`, the dragged one `size` wide (and its gap). */
export function slideOf(i: number, from: number, to: number, size: number): number {
  if (from < to && i > from && i <= to) return -size
  if (to < from && i >= to && i < from) return size
  return 0
}

/**
 * The place among all the panes (`ids`) for `id`, dropped at `to` among those the strip shows (`shown`, it among them):
 * before the one shown that's there now, else after the last one shown. The rest (in the title bar's ···) keep theirs.
 */
export function placeAmong(ids: string[], shown: string[], id: string, to: number): number {
  const others = ids.filter((other) => other !== id)
  const shownOthers = shown.filter((other) => other !== id)
  const before = shownOthers[to]
  if (before !== undefined) return others.indexOf(before)
  const last = shownOthers.at(-1)
  return last === undefined ? ids.indexOf(id) : others.indexOf(last) + 1
}
