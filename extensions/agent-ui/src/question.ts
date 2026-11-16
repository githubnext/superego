// A question as the card shows it: the context the agent gave (Markdown), then the question itself, which heads the
// options. The question is the last paragraph, unless that's a list or code: then it's all context.

export type Parts = { context: string; ask: string }

export function partsOf(question: string): Parts {
  const paragraphs = question.trim().split(/\n[ \t]*\n/)
  const last = paragraphs.at(-1)!.trim()
  if (/^([-*+•]\s|\d+[.)]\s|```|>|\|)/.test(last)) return { context: question.trim(), ask: '' }
  return { context: paragraphs.slice(0, -1).join('\n\n').trim(), ask: last }
}

/** What's typed, as an answer: a number picks that option; anything else is the answer itself. */
export function answerOf(typed: string, options: { label: string }[]): string {
  const picked = /^\s*(\d+)\s*$/.exec(typed)
  const option = picked ? options[Number(picked[1]) - 1] : undefined
  return option ? option.label : typed
}

type Key = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
/** What a key in the composer does to the options: pick one, move the highlight (`undefined`: back to the box), or nothing. */
export type KeyMove = { pick: number } | { active: number | undefined } | undefined

/**
 * ⌃1–⌃9 pick that option (by the key's place, as ⌃ may change what it types). With nothing typed, ↑/↓ move a highlight
 * through the options above the box (↑ from the box to the nearest, ↓ past the last back to it), ⏎ picks it, esc drops it.
 */
export function keyMove(event: Key, text: string, active: number | undefined, count: number): KeyMove {
  if (!count) return undefined
  if (event.ctrlKey && !event.altKey && !event.metaKey && /^Digit[1-9]$/.test(event.code)) {
    const index = Number(event.code.slice(5)) - 1
    return index < count ? { pick: index } : undefined
  }
  if (text.trim() || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return undefined
  if (event.key === 'ArrowUp') return { active: active === undefined ? count - 1 : Math.max(active - 1, 0) }
  if (event.key === 'ArrowDown' && active !== undefined) return { active: active + 1 < count ? active + 1 : undefined }
  if (event.key === 'Enter' && active !== undefined) return { pick: active }
  if (event.key === 'Escape' && active !== undefined) return { active: undefined }
  return undefined
}
