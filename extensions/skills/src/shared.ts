// What both halves agree on: what the extension is, the read the composer completes names from, and how a skill sent
// with a message is tagged (the daemon half writes the tag, the UI half finds it to show the skill's chip).
import type { ExtensionAbout } from '@superego/protocol'

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'skills', title: 'Skills', description: 'Know the shared skills, use them when they fit, and send one by naming it.' } satisfies ExtensionAbout

/** The skills a message can name on a machine, for completing `$name` as it's typed. */
export const LIST = 'skills.list'

/** A skill as the composer offers it. */
export type SkillInfo = { name: string; description: string }

/** A skill a message named, sent with it whole: the block opens with this tag. */
export const SENT = /^<skill name="([^"]*)" location="([^"]*)">/

export const quote = (value: string) => value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)
export const unquote = (value: string) => value.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
