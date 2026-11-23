# An iOS look for the phone

What iOS 26 (Liquid Glass) does, and where it goes in Superego's phone UI: the web build in Safari or on the home
screen. The look is the narrow layout's (`.app.is-narrow`, media.ts's `NARROW`, `(max-width: 599px)`), whatever the
pointer: the desktop app's window never gets that narrow, so the Mac is untouched; what's only for a finger (menu rows
a finger high, shortcut hints hidden) also asks for `(pointer: coarse)` or `:root[data-finger]`. The aim is iOS's
layouts, structure and conventions, not its pixels, in the same spirit as the macOS look (77eb0686 and after).

Sources: Apple's Human Interface Guidelines (Toolbars, Tab bars, Sheets, Lists and tables, Segmented controls, Menus,
Context menus, Search fields, Buttons, Typography, Color, Materials, Layout; fetched as JSON from
developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json), UIKit's documented values, and how
Messages, Mail, Notes, Settings, Files and the ChatGPT and Claude apps lay out on iOS 26. Sizes are points (CSS px).

Screenshots: `app/test/look.sh <dir> phone-look` (app/test/phone-look.mjs): the web build in a window made an
iPhone 16 Pro / 17's (402×874 at 3×, a finger, safe areas 62 top and 34 bottom), paired by Web access.

## The screen

| iOS | Measure | Superego |
| --- | --- | --- |
| Safe areas | iPhone 16 Pro / 17: 62 top (status bar, Dynamic Island), 34 bottom (home indicator); 0 at the sides upright | `env(safe-area-inset-*)`, already used; the bar runs up under the status bar, the composer sits above the home indicator, on the keyboard when it's up (viewport.ts) |
| Hit targets | at least 44×44 (HIG, Buttons); button sizes 28, 32, 44, 52, 64 | bar buttons 44, rows 44 and up, the composer's + and send |
| System font | SF Pro, Dynamic Type | `--superego-font` (system-ui reaches SF on iOS) |
| Text styles (Large, the default) | Large Title 34/41 bold; Title 1 28/34; Title 2 22/28; Title 3 20/25; Headline 17/22 semibold; Body 17/22; Callout 16/21; Subhead 15/20; Footnote 13/18; Caption 1 12/16; Caption 2 11/13 | body and rows 17, the bar's title 17 semibold, section headers 13, details 15; all times the Text size setting (`--superego-text-size`) |
| Press states | rows light up (a grey fill) while pressed, no hover; glass buttons swell and brighten | `:active` fills, nothing on `:hover` under a finger |

## Colours (UIKit's dynamic system colours, light / dark)

| Role | Light | Dark | Superego |
| --- | --- | --- | --- |
| systemBackground | #FFFFFF | #000000 | `--superego-bg` (the theme's; Superego's dark stays a near black, #1d1d1f) |
| secondarySystemBackground | #F2F2F7 | #1C1C1E | `--superego-chrome` |
| systemGroupedBackground | #F2F2F7 | #000000 | the ground of grouped lists (Settings, the thread's menu): the chrome in light, the sheet in dark |
| secondarySystemGroupedBackground | #FFFFFF | #1C1C1E | a group's card: `--superego-raised` |
| separator | rgba(60,60,67,.29) | rgba(84,84,88,.6) | `--superego-line` (opaque, one colour over anything) |
| label / secondaryLabel / tertiaryLabel | #000 / rgba(60,60,67,.6) / rgba(60,60,67,.3) | #FFF / rgba(235,235,245,.6) / rgba(235,235,245,.3) | `--superego-text` / `--superego-muted` / `--superego-faint` |
| tertiarySystemFill (segmented track, search field) | rgba(118,118,128,.12) | rgba(118,118,128,.24) | `--superego-fill`, a step stronger |
| tint (systemBlue, iOS 26) | #0088FF | #0091FF | the accent, as chosen (the theme's or Superego's blue) |
| systemRed / Orange / Green (iOS 26) | #FF383C / #FF8D28 / #34C759 | #FF4245 / #FF9230 / #30D158 | the status tokens (already 2025's since the macOS look) |

Superego keeps its themes: the phone draws iOS's roles from the theme's tokens rather than fixing iOS's values, so a
theme still colours the phone.

## Patterns

### Navigation bar → the thread's bar

- iOS 26: the bar has no background or hairline of its own. Content scrolls under it; a *scroll edge effect* (a soft
  blur and fade into the background) keeps the bar's items legible. Bar buttons are glass: 44pt circles for an icon,
  capsules for words, grouped into one capsule when several sit together. Leading: back or a sidebar/close button;
  centre: the title (Headline, 17 semibold; or a large title, 34 bold, collapsing to it as the content scrolls);
  trailing: the screen's main actions (compose, more ···). A title can be a menu: a chevron after it, tapped for a
  pull-down menu of what you can do with the thing (Files, Notes' folder title).
- Superego: the bar was a solid strip with a hairline, plain icon buttons. Now: no strip; the transcript scrolls
  under the status bar and the bar, faded and blurred at the top edge; ☰ (the drawer) and the compose button as glass
  circles; the thread's title centred, 17 semibold, a chevron after it, opening the thread's menu. A large title isn't
  used: a thread's title is long and the bar is where it's tapped for the menu (ChatGPT and Claude keep theirs
  inline too).

### Segmented control → the thread and its panes

- iOS: a segmented control switches closely related views of one thing (Calendar's Event / Reminder). iOS 26: a
  capsule track (tertiary fill), the chosen segment a raised capsule; 32–36 high; segments share the width. It sits
  under the bar's title as part of the bar (a bar's bottom accessory), on the same glass.
- Superego: Thread / Changes / Terminal is exactly that: views of one thread. Was a full-width rounded-rect strip on a
  separate band under the bar. Now: a capsule segmented control in the bar, on its glass, under the title; with more
  tabs than fit, it scrolls sideways.

### Sidebar → the drawer

- iOS: an iPhone has no sidebar; a list is the root of a navigation stack (Mail's mailboxes, Notes' folders). Chat
  apps (ChatGPT, Claude) slide the conversation list in from the leading edge over the chat, which is what Superego's
  drawer already does, with a swipe from the edge.
- Lists: rows at least 44 high, Body text (17); a selected row in a navigation list stays lit; separators inset from
  the leading edge (16, or aligned with the text past an icon). Grouped lists put sections on a grey ground with
  headers in Footnote (13), secondary colour.
- Superego: the drawer keeps its place (ChatGPT's pattern) but reads as an iOS list: the ground systemGrouped-ish,
  rows of two lines as Mail's and Messages' (the title alone on the first, the row's whole width, in Body size, cut
  short; under it in Subheadline (15), secondary, the time or what it waits on, a pin, badges, where it is; the status
  before the title, on its line), the selected thread a rounded fill, project names as section headers; its foot
  (other spaces, Settings) as glass circle buttons.

### Sheets → the thread's menu, New thread, Settings, every phone dialog

- iOS: a sheet slides up over the screen. Detents: medium (about half) and large (full height less the status bar).
  A resizable sheet has a grabber (36×5, 5 below the top edge) and drags down to close. iOS 26: at a partial height
  the sheet floats, inset from the screen's edges with corners concentric with the display's (≈ 55 on a 16 Pro, a few
  points less inset); at full height it reaches the edges with large rounded top corners, the screen behind stepping
  back (scaled down, its corners rounded, dimmed). Its own bar: the title centred; iOS 26 puts a glass ✕ at the
  leading edge (cancel) and the confirming action at the trailing edge, prominent (tinted): Calendar's New Event,
  Reminders, Mail's compose. HIG: Cancel leading, Done trailing; "swipe to dismiss".
- Superego:
  - The thread's menu (a Base UI Drawer from the foot, already swipe-to-close): now a floating sheet inset from the
    edges, glass, a grabber, the thread's title in its header and its rows in inset groups (rounded cards, 44+ rows,
    separators inset past the icon).
  - New thread, Settings and every other dialog filled the screen with a header strip and a footer of buttons. Now a
    large-detent sheet: a gap above it under the status bar, rounded top corners, the app behind stepping back; its
    bar ✕ · title · action, the action (Start) at the trailing edge, prominent; no footer. Still as tall as what's
    visible: it ends at the keyboard (viewport.ts).

### Inset-grouped lists → Settings

- iOS Settings: a list of sections pushing into pages; each page grouped: sections as rounded cards inset 16–20 from
  the screen's edges on the grouped ground, rows 44+ with a label at the leading edge and its control (switch, value,
  chevron) at the trailing, separators inset from the leading edge, the section's header above it (Footnote,
  secondary) and its explanation below it.
- Superego: Settings had its tabs across the top in a scroller and plain rows under headings. Now: Settings opens to
  a list (General, Appearance, Hotkeys; Machines, each machine) as an inset group with chevrons; a row pushes its page,
  with ‹ Settings at the bar's leading edge to go back. Each page's sections are inset-grouped cards.

### Menus and context menus

- iOS 26: menus and context menus are glass, rows 44 high at Body size, the icon at the trailing edge, groups set
  apart by a thicker gap; a long press opens a context menu (with a preview).
- Superego: menus opened from the phone (a thread's ··· in the drawer, pickers) get rows a finger high and Body
  size; they stay where they open (Base UI positions them), so they read as iOS's pull-down menus.

### Search field

- iOS 26: search sits in a capsule field (36 high, tertiary fill, a magnifier) in the bar, or at the foot of the
  screen within thumb's reach.
- iOS hides a list's search field under its large title until the list is pulled down, and shows it again at the top.
  While in use, a clear button (×) at its end once typed in, and Cancel beside it; nothing found, "No Results for
  '…'" in the middle of the list.
- Superego: the drawer has the field under its "Threads" title, shown all the time rather than pulled down for: the
  pull would have to start the list scrolled past the field, fight the drawer's own swipes and the keyboard's sliding
  of the page, and isn't found by anyone who doesn't know it's there; the list can spare the field's 36 points. Typed in, the list is the threads that match, as ⌘L finds them (one search: thread-search.ts, a thread's
  project and title, best first), the archived after the rest; Cancel and × as iOS's. Focused, the keyboard comes up
  without moving it; the drawer ends at the keyboard and puts its foot away (viewport.ts).

### Toolbars and tab bars

- iOS 26: the tab bar floats as a glass capsule at the foot, inset from the edges (≈ 62 high); a toolbar's items
  float as glass buttons at the foot. Chat apps don't use a tab bar: the composer owns the foot.
- Superego: no tab bar (one app, one list); the foot is the composer's.

### Composer → the thread's composer

- Messages (iOS 26): a glass ⊕ circle at the leading edge (attachments, apps), then the field, a capsule (≈ 36 high
  on one line, growing into a rounded rect), the send button (an accent circle with ↑) inside it at the trailing
  edge, shown once there's something to send; above the home indicator, on the keyboard when it's up. ChatGPT and
  Claude follow the same: + beside or in the field, send inside it.
- Superego: the composer was one glass box with send inside and "Attach" under it in a footer. Now: a glass + circle
  at the leading edge (Attach), the field a capsule with send inside, the footer only while there's something to
  show in it (Queue, Stop while the agent works).

### Swipe actions

- iOS: swiping a list row reveals actions at its trailing edge (Archive, Delete; a full swipe takes the first);
  leading-edge swipes for the positive one (Mark as read, Pin).
- iOS 26: the actions are rounded buttons in the gap the row leaves, sharing it; swiped most of the way across, the
  outermost stretches over the others and is done on release. One row open at a time; a tap elsewhere or a scroll
  closes it.
- Superego: the drawer's rows swipe under a finger (threads' swipe.tsx): right for Pin (or Unpin, orange), left for
  More (grey, the thread's sheet, for that row's thread) and Archive (red, the full swipe's). The row takes a touch only
  once it's gone a few points more sideways than down (`touch-action: pan-y`); its own sideways swipe wins over the
  drawer's swipe-to-close (`data-base-ui-swipe-ignore`), which still works from the heading and the gaps, with a tap
  on the scrim. Archive isn't undoable but as anywhere else (the thread is under Archived, to unarchive).

### Keyboard shortcuts

- iOS without a hardware keyboard shows none.
- Superego: New thread's checkboxes (an extension's "In a worktree of its own") are switches on rows of their own.
- Superego: hints like Ctrl+1 and ⌘⏎ (New thread's fields, Start) are hidden while a finger works the phone
  (`:root[data-finger]`); a keyboard brings them back.
