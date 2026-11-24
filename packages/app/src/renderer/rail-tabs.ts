// ⌘1–⌘9: the rail's tabs, in its order. First the rail's own buttons that say what pressing them does (a view's
// `action`: Ego's opens its thread, shown alone), then the sidebars. A number goes where clicking goes and stays there:
// pressed again, its tab stays in front (⌘/ shows and hides the sidebar). Settings has ⌘, and no number.

/** How many tabs have a number. */
export const RAIL_TABS = 9

/** The action that shows the rail's `n`th tab (from 1), bound to ⌘`n` unless the user changed it. */
export const tabAction = (n: number) => `app.tab${n}`

export type RailTab = { id: string; open(): void }

/**
 * The tabs the numbers go to: the rail's views whose `action` is offered now (a button that draws nothing has nothing
 * to offer), then every sidebar; the first nine.
 */
export function railTabs<V extends { id: string; action?: string }>(rail: V[], sidebars: V[], how: {
  offered(action: string): boolean
  run(action: string): void
  show(sidebar: V): void
}): RailTab[] {
  return [
    ...rail.flatMap((view) => view.action && how.offered(view.action) ? [{ id: view.id, open: () => how.run(view.action!) }] : []),
    ...sidebars.map((view) => ({ id: view.id, open: () => how.show(view) })),
  ].slice(0, RAIL_TABS)
}
