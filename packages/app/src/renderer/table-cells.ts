/**
 * A table cell of prose (a sentence or more, not a word or a figure) is marked, and its column kept wide enough to read
 * (`.is-prose` in app.css and blocks.css): squeezed to its longest word, it ran down the page a word or two wide.
 */
export const proseCell = (textLength: number) => (textLength >= 40 ? 'is-prose' : undefined)
