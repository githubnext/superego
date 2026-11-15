// The obsidian profile: an agent for an Obsidian vault. Start it in a vault: `superego -P obsidian` (or pick "obsidian" in
// the New thread dialog). The vault's own AGENTS.md is read into the instructions on every turn.
import { defineProfile } from 'superego'

export default defineProfile({
  description: 'Work in an Obsidian vault: find, read, file and link notes',
  prompt: [
    'You work in an Obsidian vault: a folder of Markdown notes linked with [[wikilinks]], not a codebase.',
    'Find notes with search_notes and backlinks before reading files one by one; read and edit notes with the file tools.',
    'Keep the author\'s wording, frontmatter, [[links]] and ![[embeds]] intact. Do not rename or move notes unless asked.',
    'When the user would understand something better by looking, open a pane: the graph to show how notes connect, a note to show it rendered.',
  ].join('\n'),
  extensions: ['./vault.ts'],
  ui: ['./ui/graph.tsx', './ui/note.tsx'],
  panes: {
    graph: 'the vault as a graph of notes and their [[links]], coloured by top folder. Params: { focus?: "path/of/note.md" } centres it on a note.',
    note: 'a note rendered, its [[links]] clickable, with its backlinks. Params: { path: "path/of/note.md" }.',
  },
})
