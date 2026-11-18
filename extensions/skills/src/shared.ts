// What both halves agree on: what the extension is, the read the composer completes names from, and how a skill sent
// with a message is tagged (the daemon half writes the tag, the UI half finds it to show the skill's chip).
import type { ExtensionAbout } from '@superego/protocol'

export const about = { name: 'skills', version: '2.0.0', api: '^4', title: 'Skills', description: 'Know the shared skills, use them when they fit, and send one by naming it.' } satisfies ExtensionAbout

/** The skills a message can name on a machine, for completing `$name` as it's typed. */
export const LIST = 'skills.list'

/** The skills on a machine to browse: a data view, and the method that feeds it. */
export const VIEW = 'skills.view'

/** A skill as the composer offers it. */
export type SkillInfo = { name: string; description: string }

/** A skill a message named, sent with it whole: the block opens with this tag. */
export const SENT = /^<skill name="([^"]*)" location="([^"]*)">/

/** A value put in a tag (a skill's name, path or description), with what would end it escaped; `unquote` reads it back. */
export const quote = (value: string) => value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)
export const unquote = (value: string) => value.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
