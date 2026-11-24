// The diagrams of docs/interface.md: wireframes of the window, drawn here and written next to this file as SVG. Each is a
// display (the window), tiles in it (its places), one marked (the accent: what the picture is about), and dashed ones
// for what may be there. Light and dark follow the reader's. Run `node docs/interface/draw.ts` after changing one.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const STYLE = `<style>
  .display { fill: #eeeeee; stroke: #c9c9c9; }
  .tile { fill: #f7f7f7; stroke: #1b1b1b; vector-effect: non-scaling-stroke; }
  .soft { fill: #f7f7f7; stroke: #9a9a9a; vector-effect: non-scaling-stroke; }
  .focus { stroke: #007aff; stroke-width: 2; }
  .fill { fill: #dbe9fb; }
  .empty { fill: none; stroke: #9a9a9a; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
  .line { stroke: #b5b5b5; stroke-width: 2; stroke-linecap: round; }
  .bubble { fill: #dbe9fb; stroke: none; }
  .arrow { stroke: #1b1b1b; fill: none; vector-effect: non-scaling-stroke; }
  text { fill: #1b1b1b; font: 7px ui-monospace, "SF Mono", Menlo, monospace; text-anchor: middle; dominant-baseline: central; }
  text.small { font-size: 5.5px; fill: #6b6b6b; }
  text.mark { fill: #007aff; }
  text.big { font-size: 10px; font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    .display { fill: #222222; stroke: #333333; }
    .tile, .soft { fill: #1b1b1b; stroke: #d8d8d8; }
    .soft { stroke: #6b6b6b; }
    .focus { stroke: #4ea1ff; }
    .fill, .bubble { fill: #1d3350; }
    .empty { stroke: #6b6b6b; }
    .line { stroke: #4a4a4a; }
    .arrow { stroke: #d8d8d8; }
    text { fill: #f7f7f7; }
    text.small { fill: #9a9a9a; }
    text.mark { fill: #4ea1ff; }
  }
</style>`

type Box = { x: number; y: number; w: number; h: number }
const r = (b: Box, cls = 'tile', rx = 2) => `<rect class="${cls}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${rx}" />`
const t = (x: number, y: number, s: string, cls = '') => `<text${cls ? ` class="${cls}"` : ''} x="${x}" y="${y}">${s}</text>`
const mid = (b: Box, s: string, cls = '') => t(b.x + b.w / 2, b.y + b.h / 2, s, cls)
/** Lines of text, as short grey bars, from `y` down. */
const lines = (x: number, y: number, widths: number[], gap = 6) => widths.map((w, i) => `<line class="line" x1="${x}" y1="${y + i * gap}" x2="${x + w}" y2="${y + i * gap}" />`).join('')
const svg = (w: number, h: number, label: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">\n${STYLE}\n<rect class="display" x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="4" />\n${body}\n</svg>\n`
const write = (name: string, content: string) => writeFileSync(join(here, `${name}.svg`), content)

// ── The wide window: title bar, rail, sidebar, main, beside ──────────────────────────────────────────────────────────
const W = 240, H = 150
const bar: Box = { x: 6, y: 6, w: 228, h: 11 }
const rail: Box = { x: 6, y: 21, w: 13, h: 123 }
const side: Box = { x: 23, y: 21, w: 50, h: 123 }
const main: Box = { x: 77, y: 21, w: 157, h: 123 }
/** Rail buttons, top down. */
const railButton = (i: number): Box => ({ x: 8.5, y: 25 + i * 11, w: 8, h: 8 })
const buttons = (n: number, on = -1) => Array.from({ length: n }, (_, i) => r(railButton(i), i === on ? 'tile focus' : 'soft', 1.5)).join('')

/** The window as it is: where each place is. */
function anatomy() {
  const beside: Box = { x: 190, y: 21, w: 44, h: 123 }
  const thread: Box = { ...main, w: 109 }
  return svg(W, H, 'The window: a title bar across the top; down the left a rail and a sidebar; the main area; a column beside it', [
    r(bar), t(42, bar.y + bar.h / 2, 'title bar'),
    r(rail), buttons(4),
    r(side), mid(side, 'sidebar'),
    r(thread), mid(thread, 'main area'), t(thread.x + thread.w / 2, thread.y + thread.h / 2 + 10, 'a thread, or a surface', 'small'),
    r(beside), mid(beside, 'beside'),
    `<text class="small" x="12.5" y="110" transform="rotate(-90 12.5 110)">rail</text>`,
  ].join(''))
}

/** One place marked in the window, the rest quiet. */
function place(which: 'space' | 'rail' | 'titlebar' | 'header' | 'beside' | 'pane') {
  const beside: Box = { x: 190, y: 21, w: 44, h: 123 }
  const withPane = which === 'pane'
  const thread: Box = withPane ? { ...main, w: 92 } : { ...main, w: which === 'beside' ? 109 : 157 }
  const pane: Box = { x: 173, y: 21, w: 61, h: 123 }
  const parts = [
    r(bar, 'soft'),
    r(rail, which === 'rail' || which === 'space' ? 'tile' : 'soft'),
    buttons(4, which === 'space' ? 1 : which === 'rail' ? 0 : -1),
    r(side, which === 'space' ? 'tile focus' : 'soft'),
    r(thread, 'soft'),
    lines(thread.x + 10, thread.y + 50, [50, 70, 40, 60]),
  ]
  if (which === 'titlebar') parts.push(r({ x: 26, y: 8, w: 22, h: 7 }, 'tile focus', 1.5))
  if (which === 'header') parts.push(r({ x: 120, y: 8, w: 16, h: 7 }, 'tile focus', 1.5), r({ x: 139, y: 8, w: 12, h: 7 }, 'soft', 1.5), t(97, 11.5, 'thread title', 'small'))
  if (which === 'beside') parts.push(r(beside, 'tile focus'))
  if (which === 'pane') parts.push(r(pane, 'tile focus'), r({ x: pane.x, y: pane.y, w: pane.w, h: 9 }, 'tile focus'), t(pane.x + pane.w / 2, pane.y + 4.5, 'pane', 'small'))
  const labels: Record<typeof which, [number, number]> = {
    space: [side.x + side.w / 2, side.y + side.h / 2], rail: [44, 29.5], titlebar: [48, 32], header: [128, 32],
    beside: [beside.x + beside.w / 2, beside.y + beside.h / 2], pane: [pane.x + pane.w / 2, pane.y + pane.h / 2],
  }
  parts.push(t(...labels[which], which, 'mark big'))
  return svg(W, H, `The window with its ${which} marked`, parts.join(''))
}

/** The main area holding a thread, its panes in columns beside it. */
function threadAndPanes() {
  const thread: Box = { x: 77, y: 21, w: 70, h: 123 }
  const p1: Box = { x: 151, y: 21, w: 40, h: 123 }
  const p2: Box = { x: 195, y: 21, w: 39, h: 123 }
  return svg(W, H, 'A thread in the main area, two panes in columns beside it', [
    r(bar, 'soft'), r(rail, 'soft'), buttons(4), r(side, 'soft'), lines(28, 30, [36, 30, 38, 26, 34], 8),
    r(thread, 'tile focus'), t(thread.x + thread.w / 2, thread.y + 8, 'thread', 'mark'),
    `<rect class="bubble" x="${thread.x + 30}" y="${thread.y + 20}" width="34" height="9" rx="3" />`,
    lines(thread.x + 6, thread.y + 40, [55, 48, 58, 30]),
    r({ x: thread.x + 5, y: thread.y + thread.h - 15, w: thread.w - 10, h: 10 }, 'tile', 4), t(thread.x + thread.w / 2, thread.y + thread.h - 10, 'composer', 'small'),
    r(p1), r({ ...p1, h: 9 }), t(p1.x + p1.w / 2, p1.y + 4.5, 'diff', 'small'), lines(p1.x + 5, p1.y + 18, [28, 22, 30, 18, 26]),
    r(p2), r({ ...p2, h: 9 }), t(p2.x + p2.w / 2, p2.y + 4.5, 'file', 'small'), lines(p2.x + 5, p2.y + 18, [24, 28, 16, 26]),
  ].join(''))
}

// ── Views, panes, surfaces: small windows (160 × 100) ────────────────────────────────────────────────────────────────
const w = 160, h = 100
const sBar: Box = { x: 5, y: 5, w: 150, h: 7 }
const sRail: Box = { x: 5, y: 15, w: 9, h: 80 }
const sSide: Box = { x: 17, y: 15, w: 34, h: 80 }
const sMain: Box = { x: 54, y: 15, w: 101, h: 80 }
const sButton = (i: number): Box => ({ x: 6.5, y: 18 + i * 8, w: 6, h: 6 })
const sButtons = (n: number, on = -1) => Array.from({ length: n }, (_, i) => r(sButton(i), i === on ? 'tile focus' : 'soft', 1)).join('')
const chrome = (on = -1, sideCls = 'soft') => [r(sBar, 'soft'), r(sRail, 'soft'), sButtons(4, on), r(sSide, sideCls)].join('')

/** A view: one of it, where the layout puts it (here a space: the sidebar). */
function kindView() {
  return svg(w, h, 'A view: one of it, placed by the layout, here in the sidebar', [
    chrome(1, 'tile focus'), lines(21, 24, [22, 26, 18, 24, 20, 25], 7), t(sSide.x + sSide.w / 2, 88, 'a view', 'mark'),
    r(sMain, 'soft'), lines(sMain.x + 8, sMain.y + 12, [60, 70, 45, 66]),
  ].join(''))
}

/** A pane: opened in a thread, with params; as many as you like, each the thread's. */
function kindPane() {
  const thread: Box = { x: 54, y: 15, w: 50, h: 80 }
  const a: Box = { x: 107, y: 15, w: 23, h: 80 }
  const b: Box = { x: 132, y: 15, w: 23, h: 80 }
  return svg(w, h, "Panes: opened in a thread with params, many of them, each the thread's", [
    chrome(), lines(21, 24, [22, 26, 18], 7), r(thread, 'soft'), t(thread.x + thread.w / 2, thread.y + 7, 'thread', 'small'), lines(thread.x + 5, thread.y + 18, [36, 30, 40, 24]),
    r(a, 'tile focus'), mid(a, 'pane', 'mark'), r(b, 'tile focus'), mid(b, 'pane', 'mark'),
  ].join(''))
}

/** A surface: in the main area itself, with params; its own thread docked beside it. */
function kindSurface() {
  const body: Box = { x: 54, y: 15, w: 70, h: 80 }
  const dock: Box = { x: 127, y: 15, w: 28, h: 80 }
  return svg(w, h, 'A surface: the main area itself, opened with params, its own thread docked beside it', [
    chrome(2), lines(21, 24, [22, 26, 18, 24], 7),
    r(body, 'tile focus'), lines(body.x + 8, body.y + 12, [40, 52, 30, 46]), mid({ ...body, y: body.y + 20 }, 'a surface', 'mark'),
    r(dock), t(dock.x + dock.w / 2, dock.y + 7, 'thread', 'small'), `<rect class="bubble" x="${dock.x + 8}" y="${dock.y + 16}" width="16" height="6" rx="2" />`, lines(dock.x + 4, dock.y + 30, [18, 14, 20]),
  ].join(''))
}

/** Its thread docked: a column beside it. */
function docked() {
  const body: Box = { x: 54, y: 15, w: 66, h: 80 }
  const dock: Box = { x: 123, y: 15, w: 32, h: 80 }
  return svg(w, h, 'A surface with its thread docked: a column beside it', [
    chrome(2), lines(21, 24, [22, 26, 18], 7), r(body), lines(body.x + 8, body.y + 12, [40, 50, 30, 46, 36]),
    r(dock, 'tile focus'), t(dock.x + dock.w / 2, dock.y + 7, 'docked', 'mark'), `<rect class="bubble" x="${dock.x + 10}" y="${dock.y + 16}" width="18" height="6" rx="2" />`, lines(dock.x + 4, dock.y + 30, [20, 16, 22]),
    r({ x: dock.x + 3, y: dock.y + dock.h - 10, w: dock.w - 6, h: 7 }, 'tile', 3),
  ].join(''))
}

/** Its thread floating: a card over its right side. */
function floating() {
  const body: Box = { x: 54, y: 15, w: 101, h: 80 }
  const card: Box = { x: 118, y: 21, w: 32, h: 68 }
  return svg(w, h, 'A surface with its thread floating: a card over its right side', [
    chrome(3), lines(21, 24, [22, 26, 18], 7), r(body),
    r({ x: 62, y: 26, w: 18, h: 10 }, 'soft', 1.5), r({ x: 90, y: 50, w: 20, h: 12 }, 'soft', 1.5), `<line class="arrow" x1="80" y1="31" x2="90" y2="56" />`,
    `<rect class="empty" x="${card.x - 4}" y="${body.y + 2}" width="${body.x + body.w - card.x + 2}" height="${body.h - 4}" rx="2" />`,
    r(card, 'tile focus'), t(card.x + card.w / 2, card.y + 7, 'floating', 'mark'), `<rect class="bubble" x="${card.x + 10}" y="${card.y + 16}" width="18" height="6" rx="2" />`, lines(card.x + 4, card.y + 30, [20, 16]),
    t(card.x - 22, 92, 'inset.right', 'small'),
  ].join(''))
}

/** Notes, put together: its space, its surface, the docked thread. */
function notes() {
  const body: Box = { x: 77, y: 21, w: 105, h: 123 }
  const dock: Box = { x: 186, y: 21, w: 48, h: 123 }
  const row = (i: number, on = false) => r({ x: 26, y: 30 + i * 11, w: 44, h: 8 }, on ? 'tile focus' : 'soft', 1.5)
  return svg(W, H, "Notes: its list is a space in the sidebar, the note it opens a surface in the main area, a thread docked beside it", [
    r(bar, 'soft'), t(110, 11.5, 'Workbench', 'small'),
    r(rail, 'soft'), r(railButton(0), 'soft', 1.5), r(railButton(1), 'soft', 1.5), r(railButton(2), 'tile focus', 1.5),
    r(side, 'tile focus'), row(0, true), row(1), row(2), row(3), t(side.x + side.w / 2, 122, 'space', 'mark'), t(side.x + side.w / 2, 130, 'notes.list', 'small'),
    r(body, 'tile focus'), t(body.x + 30, body.y + 12, '# Workbench'), lines(body.x + 10, body.y + 26, [80, 70, 85, 50]), lines(body.x + 10, body.y + 58, [60, 72, 40]),
    t(body.x + body.w / 2, 122, 'surface', 'mark'), t(body.x + body.w / 2, 130, 'notes.page {name}', 'small'),
    r(dock), t(dock.x + dock.w / 2, dock.y + 8, 'thread', 'small'), `<rect class="bubble" x="${dock.x + 14}" y="${dock.y + 18}" width="30" height="9" rx="3" />`,
    lines(dock.x + 5, dock.y + 38, [36, 30, 38]), r({ x: dock.x + 4, y: dock.y + dock.h - 14, w: dock.w - 8, h: 9 }, 'tile', 4),
    t(dock.x + dock.w / 2, 122, 'docked', 'small'),
  ].join(''))
}

/** Going somewhere: the main area shows a thread, a surface, another of its kind; back goes back. */
function step(label: string, what: 'thread' | 'surface') {
  const body: Box = { x: 54, y: 15, w: 101, h: 80 }
  return svg(w, h, `The main area shows ${label}`, [
    chrome(what === 'surface' ? 2 : 1), lines(21, 24, [22, 26, 18], 7),
    r(body, 'tile focus'), mid(body, label, 'mark'),
    what === 'thread' ? `<rect class="bubble" x="${body.x + 60}" y="${body.y + 10}" width="32" height="8" rx="3" />` : lines(body.x + 10, body.y + 14, [40, 30]),
  ].join(''))
}

// ── On a phone ───────────────────────────────────────────────────────────────────────────────────────────────────────
const pw = 70, ph = 120
const phone = (label: string, body: string) => svg(pw, ph, label, body)
function phoneDrawer() {
  return phone('On a phone, the open space is a drawer over the thread', [
    r({ x: 5, y: 5, w: 60, h: 9 }, 'soft'), lines(10, 30, [40, 34, 44, 30], 8),
    r({ x: 5, y: 17, w: 42, h: 98 }, 'tile focus'), t(26, 66, 'drawer', 'mark'), lines(10, 28, [28, 24, 30], 8),
    r({ x: 8, y: 102, w: 8, h: 8 }, 'soft', 1.5), r({ x: 19, y: 102, w: 8, h: 8 }, 'soft', 1.5),
  ].join(''))
}
function phoneSheet() {
  return phone("On a phone, a thread's title opens its sheet: the header, panes and beside", [
    r({ x: 5, y: 5, w: 60, h: 9 }, 'soft'), lines(10, 24, [40, 34, 44], 8),
    r({ x: 5, y: 58, w: 60, h: 57 }, 'tile focus', 4), t(35, 86, 'sheet', 'mark'), lines(12, 70, [30, 24], 6),
  ].join(''))
}
function phoneSurface() {
  return phone('On a phone, a surface fills the screen; its thread opens as the thread', [
    r({ x: 5, y: 5, w: 60, h: 9 }, 'soft'), r({ x: 52, y: 7, w: 10, h: 5 }, 'tile', 1.5),
    r({ x: 5, y: 17, w: 60, h: 98 }, 'tile focus'), t(35, 66, 'surface', 'mark'), lines(12, 30, [40, 30, 44], 8),
  ].join(''))
}

write('anatomy', anatomy())
for (const which of ['space', 'rail', 'titlebar', 'header', 'beside', 'pane'] as const) write(`place-${which}`, place(which))
write('thread-and-panes', threadAndPanes())
write('kind-view', kindView())
write('kind-pane', kindPane())
write('kind-surface', kindSurface())
write('docked', docked())
write('floating', floating())
write('notes', notes())
write('step-thread', step('a thread', 'thread'))
write('step-note-a', step('note:a', 'surface'))
write('step-note-b', step('note:b', 'surface'))
write('phone-drawer', phoneDrawer())
write('phone-sheet', phoneSheet())
write('phone-surface', phoneSurface())
