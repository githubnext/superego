// The pane row's arithmetic (see panes.tsx): how wide each column is, in either layout, and which pane a stack shows.

/** A column's width (a share of the row) until it's dragged, unless its kind says otherwise. */
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
