/**
 * How well `query` matches `text`: higher is better, 0 is no match. A prefix beats a word start beats a substring
 * beats initials: letters that each start a word or follow the previous one, like `gde` in "git diff extension".
 */
export function score(text: string, query: string): number {
  const t = text.toLowerCase()
  const q = query.toLowerCase().trim()
  if (!q) return 1
  if (t.startsWith(q)) return 4
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 3
  if (t.includes(q)) return 2
  return initials(t, q, 0, -2) ? 1 : 0
}

const wordStart = (text: string, at: number) => at === 0 || !/[a-z0-9]/.test(text[at - 1]!)

/** Whether `query` from `from` matches `text` past `previous`, each letter at a word start or right after the last. */
function initials(text: string, query: string, from: number, previous: number): boolean {
  if (from === query.length) return true
  for (let at = text.indexOf(query[from]!, previous + 1); at >= 0; at = text.indexOf(query[from]!, at + 1)) {
    if ((at === previous + 1 || wordStart(text, at)) && initials(text, query, from + 1, at)) return true
  }
  return false
}
