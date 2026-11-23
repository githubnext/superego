# Blocks

Blocks are UI as JSON, drawn by the window's own components. Agents draw them with `show_ui`, `ask_ui`, `open_ui` and
`update_ui` (the bundled `agent-ui` extension); an extension's daemon half draws them in a data-only view
(`superego.view`, see [the window](../packages/cli/skill/window.md#data-only-views)). The schema, its checker and its
renderer are the same for both. What differs is who drew them, which decides what pressing a button does.

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

An `image`'s `src` is a file in the thread's folder, a `data:` URL, or an `https:` URL, which shows only once the user
clicks to load it. An `html` page has no network: everything it needs is inline. It gets theme variables
(`--superego-text`, `--superego-accent`, `--superego-surface`, …) that follow light and dark.

`'superego'` exports the types (`Block`, `ListItem`, `Button`, `Value`) and `blockErrors(blocks, use)`, the check, for
tests.

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

An agent never gets a button that runs an action: its label is the model's, and the model may be following injected
text. An agent that wants something done asks with a button and does it with its own tools.

## Live data

An extension's view is one value on its machine: a live value it sets, or a method the window calls again as the
thread moves on and after a button ran. Nothing inside blocks binds to anything: to change what's shown, publish new
blocks. What the user typed in an input is kept across redraws by its `id`.

An agent's `update_ui` replaces a pane's blocks, with its inputs starting over.

## Limits

Every window checks blocks before drawing them, and refuses a set that fails whole, showing its first error in place.

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
