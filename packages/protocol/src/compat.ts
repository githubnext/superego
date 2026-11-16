// Names kept on the wire after they moved, for a client and daemon of different releases of one protocol generation.
// Each goes at its milestone, or with the generation, whichever comes first: a test fails once one is past it, so it's
// taken out rather than forgotten. Stored data has no such table: what an older release stored isn't read through.
//
// The skew policy they serve is in the guide (packages/cli/skill/guide.md), "Versions and compatibility".

/**
 * A name kept on the wire after it moved, by the side that keeps it: a daemon answering an older client by the old
 * name, or a window coping with an older daemon's shape. `until`: the milestone, a date (`YYYY-MM-DD`) after which
 * it's removed; and it goes with the next `PROTOCOL_VERSION` regardless.
 */
export type Alias = { side: 'daemon' | 'window'; since: string; until: string; note: string } & (
  | { kind: 'method'; old: string; now: string }
  | { kind: 'feature'; old: string; now: string }
  | { kind: 'shape'; where: string }
  /** An author's API kept under its old name: an extension written against it still sets up, with a warning. */
  | { kind: 'api'; old: string; now: string; where: string }
)

/** Generation 2 starts with none. */
export const ALIASES = {} as const satisfies Record<string, Alias>
