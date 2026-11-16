# Native libghostty for the terminal pane: investigation

2026-11-15. Ghostty at `7fa26e8b6` (main, 1.4.1-dev); libghostty-vt 1.0.1. Phase 1 only: nothing built.

## Verdict

**Native embedding in Electron is weeks of work, not days. It's macOS only, and it rests on an API Ghostty doesn't
offer to outside embedders.** Don't build it now. A smaller step gets most of the practical win: Ghostty's terminal
state in the daemon (**libghostty-vt as WebAssembly in Node**). I tried it, and it works.

## What libghostty is today

- **libghostty-vt** (`include/ghostty/vt/*.h`) is the library Ghostty offers embedders. It's released on its own
  (`vt-1.0.0`, `vt-1.0.1`) and MIT licensed, with documentation (lib.ghostty.org/vt) and an ABI promise (the snapshot
  format is versioned separately). It parses and keeps state: the terminal, its screen and scrollback, reflow on
  resize, key, mouse and focus encoding, selection, search, Kitty graphics, snapshots (encode and restore a whole
  terminal), a formatter (screen as plain text, HTML, or **VT sequences that recreate it on another terminal**), and a
  render state ("a copy of everything you need to draw one frame"). **It doesn't draw.** The embedder writes the
  renderer: Ghostling, Ghostty's example, uses its own. Prebuilt for each release at `release.files.ghostty.org`: an
  XCFramework, Windows zips, and `ghostty-vt-VERSION.wasm` (1.2 MB, no imports).
- **The full libghostty** (`include/ghostty.h`: `ghostty_app_new`, `ghostty_surface_new` with an `nsview`, Metal
  rendering) is what draws. Its header calls it "Ghostty's internal embedder API, a.k.a. libghostty-internal… the only
  consumer of this API is the macOS app… not designed for external use; external embedders should instead use
  libghostty-vt". It has no release, so we'd build it from source with Zig 0.17.1 (`brew` has it), Xcode and Metal
  shaders, pinned to a commit. Two things make it hard to use for us:
  - **A surface runs its own child.** `termio.Backend` has one kind, `exec`: Ghostty forks a PTY for `command` in
    `working_directory`, and nothing feeds it bytes from elsewhere. Our shells live in the daemon, on any machine, and
    outlive the window. To use the API unchanged, the surface's command would be a bridge (`superego terminal attach`)
    holding a second PTY and forwarding to the daemon's, like `ssh -t`. Otherwise we fork Ghostty to add a manual
    backend (`Termio.processOutput` exists).
  - **The embedder writes the view.** IME (`NSTextInputClient`), key translation, mouse, scroll, selection, clipboard,
    cursor shapes and drag and drop are all the host's. Ghostty's own `SurfaceView_AppKit.swift` and `Ghostty.Input.swift`
    are about 3,900 lines, and the app runtime's callbacks (actions, clipboard, wakeup and tick) are more.
- ghostty-web 0.4.0 (what we ship) is coder's build of libghostty-vt as WASM, plus a canvas renderer and xterm.js's
  API. Its latest pre-release (0.4.0-next.21, Oct 2026) still says "options changed after open() are not yet fully
  supported", so recreating the terminal on a theme change stays.

## Putting a native surface in an Electron pane

| Way | What it takes | Problems |
| --- | --- | --- |
| **A child NSView over the pane** (a Node addon in the main process, added to `getNativeWindowHandle()`'s view) | The full libghostty from source, the addon (ObjC++, built against Electron's headers, unpacked from `app.asar` like node-pty), the PTY bridge above, and the renderer reporting each terminal pane's rectangle, clip and visibility | **It covers every web overlay.** ⌘K, ⌘L, dialogs, menus, popovers and tooltips are DOM, and a native view sits above all of them. We'd have to hide or mask it whenever one opens. **Layout lags.** Scroll's sideways pane row, column drags and Stack's tab switches move it by IPC, a frame or more behind the page, and it must be clipped to the row. **Keys.** As first responder it takes the keys from the page: ⌘ keys, ⌃Tab and ⌃` would need forwarding into the window's router by hand, and the region focus ring kept in sync. **Tests.** `capturePage` and smoke's hidden windows don't see a Metal layer, so `look.sh` and smoke can't check it as they are. macOS only: Linux and Windows desktops stay on ghostty-web. |
| **Drawn offscreen, shown in the page** | libghostty drawing into an IOSurface, the page showing it | Chromium has no way to show an outside GPU texture in a page. Copying pixels into a canvas each frame is slower than ghostty-web drawing it there. |
| **libghostty-vt native + our own renderer** (stable API, prebuilt XCFramework) | A Metal/CoreText renderer of the render state, in an NSView | The same overlay, layout and key problems, plus writing a renderer: months. A WebGL renderer in the page instead is essentially ghostty-web again. |
| **A native shell** (AppKit + WKWebView; a spike, tagged `native-spike`) | The same NSView, in a window we own | The overlay problem stays, unless overlays become native too. |

Rough size for the first row, to match today's pane (theme, font, focus ring, keys, OSC 7501, replay, resize, both
layouts, overlays, IME, copy and paste, packaging, tests): **3–5 weeks, macOS only**. After that it's an ongoing cost:
it tracks an internal API that changes without notice, and the overlay and layout syncing never goes away.

## The smaller step: libghostty-vt in the daemon

Checked in plain Node 26 against the official `ghostty-vt-1.0.1.wasm` (no imports, no native build). I created a
terminal, wrote a 50-column line with SGR colour and an OSC 0 title, resized it from 40 to 20 columns (it reflowed),
and formatted it as plain text and as VT (`GHOSTTY_FORMATTER_FORMAT_VT` with extras). The VT output recreates the
screen: style, cursor position, tab stops and modes.

What the daemon would do with it: each PTY's output also goes into a headless terminal (resized on `terminal.resize`).
A window attaching is sent that terminal formatted as VT at its current size (without the palette extra, so the
window's theme stays), not up to 1 MB of raw output replayed at the size it was printed at. That gets:

- **No replay garbling** when windows differ in width, and attaching sends far fewer bytes.
- **Cheaper theme and font changes** in ghostty-web: recreating the terminal and reattaching costs a screen, not a
  replay.
- **No held-back typing.** The formatted screen asks no questions. The daemon's terminal can also answer a program's
  queries (DA, cursor position: `GHOSTTY_TERMINAL_OPT_WRITE_PTY`) while no window is attached.
- **What §9 already lists:** tab titles from OSC 0/2 (`TITLE_CHANGED`), the folder from OSC 7, and snapshots
  (`snapshot.h`) as a start on terminals that survive a daemon restart.
- It works on every machine, since remote daemons are plain Node, and costs nothing to package (one 1.2 MB file
  beside the bundle).

Size: **2–4 days** with tests: a small typed wrapper over the wasm exports (alloc, take opaque, write, resize, format,
title), the daemon half using it, and the existing tests and smoke step.

## Options

1. **libghostty-vt in the daemon** (2–4 days). Recommended next.
2. **Native NSView surfaces on macOS** (3–5 weeks, then upkeep). Wait until Ghostty publishes a surface/embedding API
   for outside embedders, or until the app moves to a native shell.
3. **Own renderer on libghostty-vt** (native or WebGL; months). Not worth it while ghostty-web draws well enough.
4. **Stay as is**, upgrading ghostty-web when a release fixes changing the theme in place.
