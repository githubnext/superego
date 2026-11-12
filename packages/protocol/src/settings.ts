// Settings as data: sections of typed settings that any part of Superego (core, bundled modules, extensions) registers, and a
// generic UI renders. Machine settings live in that machine's daemon; app settings in the app. Both speak the same
// `settings.*` methods.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type SettingOption = { value: string; label: string; description?: string; group?: string }

export type SettingType =
  | { type: 'boolean' }
  | { type: 'string'; placeholder?: string; secret?: boolean }
  | { type: 'number'; min?: number; max?: number; step?: number }
  /** One of `options`; `null` is allowed when `nullable`, shown as `nullLabel`. */
  | { type: 'choice'; options: SettingOption[]; nullable?: boolean; nullLabel?: string }
  /** A font family installed where the client runs, or `null` for the default. The client lists the fonts. */
  | { type: 'font'; monospace?: boolean; nullLabel?: string }
  /** A CSS colour (`#2f5bd3`, `color(display-p3 …)`, `oklch(…)`): checked where it's shown, as the browser reads it. */
  | { type: 'color' }
  /** Shortcuts by action id, like `mod+shift+k`, or `null` for none: only what differs from the actions' own. */
  | { type: 'keymap' }

/** A setting as clients see it: its type, with options resolved for the current state. */
export type SettingInfo = SettingType & {
  key: string
  title: string
  description?: string
  default: Json
  /** Shown but not editable, with why. */
  disabled?: string
  hidden?: boolean
}

export type SectionInfo = {
  id: string
  title: string
  description?: string
  order: number
  settings: SettingInfo[]
  /** A custom component the client draws below the settings, by id (e.g. "providers"). */
  ui?: string
  /** Read-only state for the custom component. */
  data?: Json
}

export type SettingsSnapshot = { sections: SectionInfo[]; values: Record<string, Json> }

/** A section declared as plain data, as a client sends it: no computed types, no custom component data. */
export type DeclaredSection = {
  id: string
  title: string
  description?: string
  order?: number
  settings: (SettingType & { key: string; title: string; description?: string; default: Json })[]
}

export type ProviderAuthInfo = {
  id: string
  name: string
  /** How the provider is authenticated now, if at all: `source` is e.g. an env var or "stored credential". */
  auth?: { type: 'api_key' | 'oauth'; source?: string }
  /** Whether Superego stores its credential, and so can sign out. */
  stored: boolean
  apiKey: boolean
  /** The label of its OAuth sign-in, when it has one. */
  oauth?: string
  models: number
}

/** What a sign-in flow asks the user, mirroring pi-ai's AuthPrompt. */
export type AuthPrompt =
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: { id: string; label: string; description?: string }[] }

/** What a sign-in flow tells the user, mirroring pi-ai's AuthEvent. */
export type AuthEvent =
  | { type: 'info'; message: string; links?: { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string }
  | { type: 'progress'; message: string }
  | { type: 'prompt'; id: string; prompt: AuthPrompt }
  /** A prompt no longer needs an answer, e.g. the browser callback arrived before a pasted code. */
  | { type: 'prompt_closed'; id: string }
  | { type: 'done' }
  | { type: 'failed'; message: string }
