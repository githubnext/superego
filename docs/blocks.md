# Blocks

Blocks are UI as JSON, drawn by the window's own components. Agents draw them with `show_ui`, `ask_ui`, `open_ui` and
`update_ui` (the bundled `agent-ui` extension); a daemon half draws them in a data view (`superego.view`, see
[the window](../packages/cli/skill/window.md#data-only-views)). Same schema, checker and renderer for both; who drew
them decides what a button does.

## The blocks

`?` marks an optional field. Unknown fields are errors.

| Kind | Blocks |
|---|---|
| Display | `markdown {text}`, `callout {tone?: info\|warn\|success, title?, text}`, `code {code, language?, title?}`, `table {columns, rows}`, `image {src, alt?, caption?}`, `kv {items: [{label, value}]}` |
| Rows | `list {items: [{title, subtitle?, detail?, status?, thread?, buttons?}]}`: `status` is a thread's (`idle`, `working`, `done`, `blocked`, `error`); `thread` links a thread by its id |
| Layout | `stack {blocks}`, `row {blocks}` (side by side), `card {title?, blocks}`, `divider {}` |
| Inputs | `choice {options: [{label, value?, description?, preview?}], multiple?, style?: buttons\|list, default?}`, `select`, `switch`, `text`, `textarea`, `number`, `slider`; each has an `id` (its key in the answer) and a `label?` |
| Actions | `buttons {buttons: [{id, label, style?: primary\|danger, action?, params?}]}` |
| Links | `open {label, kind, params?, title?}`: opens a pane beside the thread |
| HTML | `html {html, height?, id?}`: a page of your own in a sandboxed frame |

- `image`'s `src`: a file in the thread's folder, a `data:` URL, or an `https:` URL (shown once the user clicks to load
  it).
- `html` has no network: inline everything. It gets theme variables (`--superego-text`, `--superego-accent`,
  `--superego-surface`, …) that follow light and dark.
- `'superego'` exports the types (`Block`, `ListItem`, `Button`, `Value`) and `blockErrors(blocks, use)`, the check.

## Who can do what

| | An agent's | An extension's view |
|---|---|---|
| Display, rows, layout | yes | yes |
| A button | answers the question (`ask_ui`), or sends your next message (`show_ui`, a pane). `action` is refused | runs `action`, one of that extension's own actions, on its machine, with `params` |
| Inputs | their values go with every press | their values go into the action's params, by input id |
| Without buttons | inputs get a submit button; a lone single choice answers when picked | inputs need a button |
| `html` | `superego.reply(value)` and `superego.send(text)` propose an answer or a message, which the user confirms under the frame | display only |
| `open` | a pane of its thread | `thread` views only |
| `image` by path | a file of the thread's | `thread` views only; `window` views take `https:` and `data:` |

An agent's button never runs an action: its label comes from the model, which may be following injected text. To get
something done, ask with a button and act with the agent's own tools.

## Live data

An extension's view is one value on its machine: a live value, or a method the window calls again as the thread moves
on and after a button ran. To change what's shown, publish new blocks. Inputs keep what the user typed across redraws,
by `id`. An agent's `update_ui` replaces a pane's blocks, resetting its inputs.

## Limits

The window checks blocks before drawing and refuses a set that fails, showing its first error in place.

| | Limit |
|---|---|
| a line of text (a label, a cell, a title) | 2,000 characters |
| Markdown, code, an `html` page, a textarea's default | 100,000 characters |
| a list's rows | 500 |
| a table's rows / columns | 1,000 / 50 |
| a `kv`'s pairs | 100 |
| buttons in a block or on a row | 20 |
| a button's `params` | 16 KB of JSON, 16 deep |
| nesting | 8 deep |
| an image's `src` | 2,000,000 characters |
