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
  /** `slider`: drawn as steps along a slider, in the options' order (a scale, like sizes), rather than a menu. */
  | { type: 'choice'; options: SettingOption[]; nullable?: boolean; nullLabel?: string; slider?: boolean }
  /** A font family installed where the client runs, or `null` for the default. The client lists the fonts. */
  | { type: 'font'; monospace?: boolean; nullLabel?: string }
  /** A CSS colour (`#2f5bd3`, `color(display-p3 …)`, `oklch(…)`): checked where it's shown, as the browser reads it. */
  | { type: 'color' }
  /** Shortcuts by action id, like `mod+shift+k`, or `null` for none: only what differs from the actions' own. */
  | { type: 'keymap' }
  /** Where the window's views go, by view id (see `app.layout`): only what differs from the views' own defaults. */
  | { type: 'layout' }

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

/**
 * A provider that rejected this machine's credentials (an invalid or expired key, a sign-in that couldn't be renewed),
 * as the machine's `auth.rejected` value lists them. Until its credentials change or someone retries, new turns for it
 * wait without asking it, and the threads it failed wait for sign-in; they go on by themselves once it's signed in.
 */
export type ProviderRejection = {
  provider: string
  /** The provider's name, as Settings → Providers shows it. */
  name: string
  /** What happened, in a few words: "Anthropic rejected the API key". */
  summary: string
  /** The provider's own error, as the first run it failed got it. */
  detail: string
  /** When it first rejected them, ms since the epoch. */
  since: number
  /** The threads waiting for sign-in. */
  threads: string[]
  /** Set while the waiting threads are being retried. */
  retrying?: boolean
}

/** The value naming the providers that rejected a machine's credentials: `ProviderRejection[]`, empty when none. */
export const AUTH_REJECTED = 'auth.rejected'

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
