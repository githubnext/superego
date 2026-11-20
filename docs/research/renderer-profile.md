# The window's renderer: CPU and memory (November 2026)

The renderer of the main window ("Superego Helper (Renderer)") was using 43% CPU and 563 MB after 9 minutes on a real
machine. This note covers what that came from, what was fixed, and what's left.

## How it's measured

`app/test/profile.sh <dir> [idle|streaming|transcript|memory]` runs the built app in an isolated home with a scripted
replay model (`app/test/profile/turns.mjs`). The build is `out-profile/`, with the renderer's names kept. The window is
shown but transparent and passes clicks through, so it draws frames as a window in front does. The script writes
`report.md` and `report.json`, and with `PROFILE_KEEP_SNAPSHOTS=1` the heap snapshots too.
`app/test/profile/retainers.mjs` shows what holds on to something in a snapshot. Each phase records:

- the renderer's CPU, as Activity Monitor shows it (a share of one core), and its RSS, sampled every second;
- Chromium's own counts: layouts, style recalcs, task time;
- React's commits and the components rendered in each, counted through a DevTools hook;
- long tasks, DOM mutations, and the timers, frames and observers that ran, grouped by where they were set up;
- CPU profiles of some phases (the profiler's own CPU is counted in those phases).

The setup: about 30 threads in the sidebar, 4 working (a long `sleep`); 3 more printing a line every half second for
the streaming scenario; a long thread of 12 messages, each answered after 150 tool calls (1,800 in all), with outputs,
images and edits. The numbers below are from an M5 Max, measured on `6f3b243` (before) and with the fixes (after).

**A hidden window hides most of the cost.** The other tests run headless, with the window never shown. Chromium may
throttle such a window, so the profile turns that off (`disable-renderer-backgrounding`,
`disable-backgrounding-occluded-windows`). `PROFILE_BACKGROUNDING=1` leaves the throttling on, but that wasn't measured
here.

## Before and after

| Phase | Before: CPU % (p95) | After: CPU % (p95) | Notes |
| --- | ---: | ---: | --- |
| Idle, 4 threads working | 15.1 (17.5) | 3.0 (3.3) | Main thread busy 9.1% → 0.4%; layouts 120/s → 0 |
| Idle, with a terminal open | 20.7 (23.6) | 8.4 (13.1) | |
| 3 threads printing output, not shown | 17.1 | 3.4 | No React commits either way |
| Streaming an answer, shown | 33.6 (40.2) | 12.4 (17.6) | Components rendered: 2,634/s → 1,144/s |
| Streaming, another thread shown | 20.8 | 8.1–8.7 | |
| Long thread open, idle | 37.8 (45.8) | 4.0 | 9,295 → 1,202 DOM nodes |
| Long thread, scrolling | 98–114 | 15–21 | Frames: p95 139–705 ms → 9–12 ms |
| Streaming into the long thread | 60.5 (79.8) | 16.5 (21.9) | Components rendered: 106,984/s → 1,332/s |
| 12 min of switching threads, panes and turns | 32.9 (51.3) | 18.9 (37.2) | Long tasks: 38 (2.9 s) → 0 |

Display refresh rates differed between runs (60 and 120 Hz). The first "before" run, at 120 Hz with the long thread
as a single run of 1,800 tool calls, idled at 32%, idled at about 100% with that thread open, and took 100 s to open it.

### Memory over 12 minutes

Checkpoints were taken with the same unchanging thread shown, no panes open, after a GC. Each cycle switched threads,
opened and closed a pane, and ran a turn every other cycle.

| | Before: start → end | After: start → end |
| --- | --- | --- |
| JS heap | 16.5 → 27.8 MB, still growing | 16.2 → 18.8 MB, flat from minute 4 |
| Listeners on `document` | 49 → 137 (+44 mousedown, +44 mouseup) | 48 → 93 (+45 mouseup, since fixed: flat over a 3-minute rerun) |
| Detached DOM | 91: 45 terminal canvases and textareas | 1 |
| Renderer RSS | 312 → 837 MB | 271 → 708 MB |

**The heap returns to baseline now; RSS doesn't.** RSS rises about 380 MB in the first two minutes and then grows
slowly (about +55 MB over the next ten). The JS heap doesn't account for this. That growth is a follow-up.

## What it came from, and what was fixed

1. **The working spinner redrew the page every frame.** The spinner turned a `<circle>` inside its SVG. Chromium
   runs such an animation on the main thread, so every frame meant a style recalc, a layout and a repaint of the whole
   page, for as long as any thread worked. The cost grew with the page: with a long thread open, the window used a
   whole core while doing nothing. The fix turns the mark's HTML box instead, which the compositor animates on its own
   (`packages/ui/src/status.tsx`).

   About 3–5% is left, all on the compositor thread, which turns the spinners at the display's rate. That's accepted.

2. **Folded runs of steps drew every step anyway.** A closed `<details>` still held each step's row: thousands of DOM
   nodes and React components for a long thread, all rendered again on every streamed token. A folded run's steps are
   now drawn only once it's open (`transcript.tsx`). The same applies to a reported task.

   One side effect: ⌃O's list of links no longer has links inside folded runs.

3. **Each streamed token re-rendered the whole transcript.** This happened in three places:
   - `thread-body.tsx` worked out the entries again for every change to the watch. It now does so only when entries
     come or go.
   - The transcript's items were rebuilt as new objects each time. An item that draws the same as before is now the
     same item, and `Work`, `TurnEnd` and `Entry` are memoised.
   - Whether an extension's UI "speaks" a machine's version was parsed again for every tool call drawn. Now it's
     worked out once for each list of extensions a machine announces (`registry.tsx`).

   In the long thread, React's share of a streaming turn went from 14.5% to 2.9% of a core.

4. **The terminal (`ghostty-web` 0.4.0, patched in `patches/`):**
   - **Leak:** it never removed two listeners on `document`. One was an anonymous `mousedown`. The other was `mouseup`:
     `dispose()` sets `isOpen = false` before the cleanup that checks it. So every terminal closed was kept, with its
     canvas (about 7 MB at 2×). The patch removes both listeners.
   - **Redraws:** its render loop redrew at least the cursor every frame. Now it draws only when a row, the cursor, its
     blink, the selection, a hovered link or the scrollbar changed. An idle terminal went from about +21% CPU to about
     +3–5%. The loop itself still runs every frame; see the follow-ups.

   Both are worth sending upstream.

## Hot spots left

- **Streaming:** React work for every token (about 1.7% of a core) and Markdown parsing of the answer as it grows
  (`fromMarkdown`, about 0.6%).
- **The sidebar renders every row on any change to any thread.** All 30 rows re-render, with their menus, tooltips and
  hover cards (`MenuRoot`, `ContextMenuRoot`, `TooltipRoot`, `HoverCard`): about 780 component renders/s at 1.7 changes
  per second. That's cheap here (about 0.3% of a core), but it scales with threads × changes.

## Follow-ups (not done)

- **Sidebar rows that render only when their thread changes** (about a day). The shell's state is a single context:
  every `useProjects()` and `useSelection()` consumer re-renders on any change. The fix is to turn it into a store with
  selector hooks, keep unchanged `ThreadInfo` objects as the same objects when `threads.changed` arrives, and memoise
  `ThreadRow`.
- **A terminal render loop that sleeps** (half a day, upstream in `ghostty-web`). Request a frame only on writes,
  resizes, selection, scrolling and the blink timer, instead of a `requestAnimationFrame` loop for the terminal's whole
  life. That would remove the remaining ~3–5% for an open terminal.
- **RSS that rises without the heap** (investigation, half a day). Candidates: `ghostty-web`'s WASM memory (it grows
  and never shrinks), decoded images, Skia's caches. The next step is `memory-infra` traces in a tracing run.
- **Blink's `MediaQuery` objects held by the `StyleEngine` grew by about 5,600 in 12 minutes** (about 1 MB). The source
  is unidentified; it's probably stylesheets or `<source media>` added again as panes open.
- **Markdown re-parses the whole answer on every token** (about a day). Parsing only the tail would make streaming a
  long answer cost the same however far into it the agent is.
- **The ego button's "beckon" animates `box-shadow`, which runs on the main thread.** It's short-lived (first run
  only), but `opacity` or `transform` would let the compositor do it.

## Profiling the running app (November 2026, later)

`superego app profile [--seconds 10]` (⌘K in a dev build: "Profile the windows") profiles the live app's windows
through each page's debugger: a CPU profile, Chromium's counts, what the window showed (tabs, running animations,
images not drawn yet), each process's CPU named by the window or web view it draws, and a Perfetto trace
(`trace.json`, a protobuf trace despite its name: open it in ui.perfetto.dev). Written to `~/.superego/profiles/`.

The first live profile (the window at 38.6% of a core, 5 threads working, 8,100 DOM nodes, a Browser pane focused)
found two things the replay didn't:

1. **An image's loading shimmer moved its background**, which the compositor can't do: the whole page went through
   style, paint and compositing every frame (about 2 ms a frame, at 120 Hz: 30–50% of the main thread). Images far off
   the screen, waiting to be read, shimmered too, for as long as the thread was shown. The shimmer now moves by
   `transform`, and only on an image being read (`is-asked`). In `profile.sh transcript`, "an image loading, in view":
   16.2% → 4.2% (3.2% without it).
2. **A Browser pane's placing checked every frame for half a second after any change to the window's page**: with
   threads working, that's every frame, each a main frame of its own (5–17% of the main thread live). A change to the
   page is now checked once, in the next frame; only scrolling, resizing, transitions and animations check every
   frame until things settle. The replay's window is too small for this to show (`streaming`, "a printing thread
   shown, a browser pane beside": 4.1% → 3.8%).

`profile.mjs` now lists, for every phase, the endless animations that draw the page every frame.
