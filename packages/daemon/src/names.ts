// Names made from what a thread is about: its title, and the branch and folder a worktree of its own gets.

/**
 * A thread's title from its first message: the first sentence, up to 72 characters, cut at a word with an ellipsis
 * when longer. The rest of the message stays in the transcript.
 */
export function titleOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const sentence = flat.match(/^.+?[.?!](?=\s|$)/)?.[0] ?? flat
  if (sentence.length <= 72) return sentence
  // A long sentence's first clause, when it says enough on its own: "Add a --dry-run flag to the import command".
  const clause = sentence.match(/^(.{24,72}?)[:;—]\s/)?.[1]
  if (clause) return clause
  const cut = sentence.slice(0, 72)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 72).replace(/[,;:]$/, '')}…`
}

/** A branch- and folder-friendly name for a thread: "Fix the login flow" → "fix-the-login-flow". */
export function slugOf(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'thread'
}
