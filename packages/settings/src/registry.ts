// The settings registry: sections of typed settings registered by whoever owns them, values kept in one store.
// Types can be computed (a model list that depends on which providers are signed in), so the registry resolves them
// whenever a snapshot is taken; `invalidate()` tells watchers that something they depend on changed.
//
// A `secret` setting's value isn't kept with the others: it's in a `SecretStore` (the machine's keychain, or an encrypted
// file), and what the registry tells anyone (`get`, a snapshot) is only whether it's set. Its value is read with
// `secret(key)`, by the extension that owns it, and changed only with `setSecret`.
import { RpcError, type DeclaredSection, type Json, type SectionInfo, type SettingInfo, type SettingsSnapshot, type SettingType } from '@superego/protocol'

/** A setting type that isn't `secret`: those whose values the registry keeps itself. */
export type PlainSettingType = Exclude<SettingType, { type: 'secret' }>
/** The `secret` setting type. */
export type SecretSettingType = Extract<SettingType, { type: 'secret' }>

export type SettingSpec = {
  key: string
  title: string
  description?: string
  /** Why it can't be changed right now, if it can't. */
  disabled?: () => string | undefined
  hidden?: () => boolean
  /** It records the user's consent: only the user changes it, never an agent (see `SettingInfo.consent`). */
  consent?: true
  /** Why a value of the right type is still refused, if it is: a hostname that isn't one. */
  validate?: (value: Json) => string | undefined
} & (
  | { type: PlainSettingType | (() => PlainSettingType); default: Json }
  /** A secret: always the user's to set (consent), its default not set. Its type is never computed. */
  | { type: SecretSettingType; default?: undefined }
)

export type SectionSpec = {
  id: string
  title: string
  description?: string
  order?: number
  settings: SettingSpec[]
  ui?: string
  /** Read-only state for the custom component, read with each snapshot. */
  data?: () => Json | Promise<Json>
  /**
   * Or the live value its custom component draws from (`<extension>.<key>`), instead of `data`: it reaches the
   * component as its `data`, kept current as the value changes, and isn't sent again with every snapshot.
   */
  value?: string
}

export interface SettingsStore {
  load(): Record<string, Json>
  save(values: Record<string, Json>): Promise<void>
}

/**
 * Where a machine keeps the values of its `secret` settings, apart from the rest. `has` is known without reading the
 * value (an index of the keys set), so a snapshot never touches the keychain.
 */
export interface SecretStore {
  has(key: string): boolean
  get(key: string): Promise<string | undefined>
  /** `undefined` clears it. */
  set(key: string, value: string | undefined): Promise<void>
  /** Where a key's value is kept, in words, for Settings to say beside it (`SettingInfo.note`). */
  about?(key: string): string | undefined
}

/** Secrets in memory: for tests, and a registry that keeps nothing. */
export class MemorySecretStore implements SecretStore {
  values = new Map<string, string>()
  has(key: string) { return this.values.has(key) }
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: string | undefined) { if (value === undefined) this.values.delete(key); else this.values.set(key, value) }
}

export class MemorySettingsStore implements SettingsStore {
  values: Record<string, Json>
  constructor(values: Record<string, Json> = {}) { this.values = values }
  load() { return { ...this.values } }
  async save(values: Record<string, Json>) { this.values = { ...values } }
}

/** A section as a window declares it (see DeclaredSection), as the registry takes it. Secrets are a machine's alone. */
export function declaredSpec(section: DeclaredSection): SectionSpec {
  return {
    ...section,
    settings: section.settings.map(({ key, title, description, default: initial, hidden, ...type }) => {
      if (type.type === 'secret') throw new RpcError('invalid_setting', `${title}: a secret is a machine's setting, not a window's`)
      return { key, title, default: initial, type: type as PlainSettingType, ...(description ? { description } : {}), ...(hidden ? { hidden: () => true } : {}) }
    }),
  }
}

const resolveType = (spec: SettingSpec): SettingType => typeof spec.type === 'function' ? spec.type() : spec.type
const isSecret = (spec: SettingSpec | undefined): spec is SettingSpec & { type: SecretSettingType } => typeof spec?.type === 'object' && spec.type.type === 'secret'

function check(spec: SettingSpec, value: Json): void {
  const type = resolveType(spec)
  const bad = (why: string) => new RpcError('invalid_setting', `${spec.title}: ${why}`)
  switch (type.type) {
    case 'boolean': if (typeof value !== 'boolean') throw bad('expected true or false'); return
    case 'string': if (typeof value !== 'string') throw bad('expected text'); return
    case 'secret': if (typeof value !== 'string' || !value.trim()) throw bad('expected the secret, as text'); return
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('expected a number')
      if (type.min !== undefined && value < type.min) throw bad(`at least ${type.min}`)
      if (type.max !== undefined && value > type.max) throw bad(`at most ${type.max}`)
      return
    case 'font':
      if (value !== null && (typeof value !== 'string' || !value.trim())) throw bad('expected a font family')
      return
    case 'color':
      if (typeof value !== 'string' || !value.trim()) throw bad('expected a colour')
      return
    case 'theme':
      if (typeof value !== 'string' || !value.trim()) throw bad('expected a theme\'s id')
      return
    case 'keymap':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('expected shortcuts by action id')
      for (const [id, keys] of Object.entries(value)) {
        if (keys !== null && (typeof keys !== 'string' || !/^([a-z]+\+)*(\+|[^+\s]+)$/i.test(keys))) throw bad(`${id}: ${JSON.stringify(keys)} is not a shortcut like mod+shift+k`)
      }
      return
    case 'layout':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('expected a layout')
      return
    case 'pins':
      if (!Array.isArray(value) || !value.every((pin) => pin !== null && typeof pin === 'object' && !Array.isArray(pin)
        && typeof pin.machine === 'string' && typeof pin.thread === 'string')) throw bad('expected threads, each { machine, thread }')
      return
    case 'models':
      if (!Array.isArray(value) || !value.every((model) => typeof model === 'string' && /^[^/]+\/./.test(model))) throw bad('expected models, each as provider/model')
      return
    case 'choice':
      if (value === null && type.nullable) return
      if (typeof value !== 'string' || !type.options.some((option) => option.value === value)) throw bad(`unknown choice ${JSON.stringify(value)}`)
  }
}

export class SettingsRegistry {
  #store: SettingsStore
  #secrets: SecretStore | undefined
  #secretListeners = new Set<(key: string) => void>()
  /** Secrets that couldn't be moved out of the settings into the store, with why (`SettingInfo.problem`). */
  #problems = new Map<string, string>()
  #values: Record<string, Json>
  #sections = new Map<string, SectionSpec>()
  #settings = new Map<string, SettingSpec>()
  #listeners = new Set<() => void>()
  #queued = false
  #closed = false
  #saving = new Set<Promise<void>>()

  /** `secrets`: where `secret` settings' values are kept; without it, none can be registered. */
  constructor(store: SettingsStore = new MemorySettingsStore(), secrets?: SecretStore) {
    this.#store = store
    this.#secrets = secrets
    this.#values = store.load()
  }

  /** Add a section; its keys must be new. Returns a function that removes it again. */
  register(section: SectionSpec): () => void {
    if (this.#sections.has(section.id)) throw new Error(`Settings section ${section.id} is already registered`)
    for (const setting of section.settings) {
      if (this.#settings.has(setting.key)) throw new Error(`Setting ${setting.key} is already registered`)
      if (isSecret(setting) && !this.#secrets) throw new Error(`Setting ${setting.key} is a secret, and there's no secret store here: secrets are a machine's settings`)
    }
    this.#sections.set(section.id, section)
    for (const setting of section.settings) {
      this.#settings.set(setting.key, setting)
      if (isSecret(setting)) this.#moveIntoStore(setting.key)
    }
    this.invalidate()
    return () => {
      if (this.#sections.get(section.id) !== section) return
      this.#sections.delete(section.id)
      for (const setting of section.settings) this.#settings.delete(setting.key)
      this.invalidate()
    }
  }

  /** Add a section, or replace the one with its id (and its keys): for sections a client declares on every start. */
  upsert(section: SectionSpec): () => void {
    const existing = this.#sections.get(section.id)
    if (existing) {
      this.#sections.delete(section.id)
      for (const setting of existing.settings) this.#settings.delete(setting.key)
    }
    return this.register(section)
  }

  /**
   * The stored value, or the default when none is stored. Unknown keys read as undefined. A secret reads as whether it's
   * set: its value only `secret(key)` reads.
   */
  get<T extends Json>(key: string): T {
    const spec = this.#settings.get(key)
    if (isSecret(spec)) return this.#secrets!.has(key) as T
    return (key in this.#values ? this.#values[key] : spec?.default) as T
  }

  /** The setting `key`, as registered. */
  spec(key: string): SettingSpec | undefined { return this.#settings.get(key) }

  /** Whether a value was chosen, rather than the default applying (a secret: whether it's set). */
  isSet(key: string) { return isSecret(this.#settings.get(key)) ? this.#secrets!.has(key) : key in this.#values }

  /** Whether `key` is a `secret` setting, as registered now. */
  isSecret(key: string) { return isSecret(this.#settings.get(key)) }

  /** A secret's value, by its key (registered or not: one whose extension isn't set up now still reads). */
  async secret(key: string): Promise<string | undefined> {
    if (!this.#secrets) return undefined
    return this.#secrets.get(key)
  }

  /**
   * Set a secret (`value`), or clear it (`null`). Setting one needs it registered (a `secret` setting); clearing works
   * for any key that has a value, so one whose extension is gone can still be cleared. Listeners hear the key.
   */
  async setSecret(key: string, value: string | null): Promise<void> {
    const spec = this.#settings.get(key)
    if (!this.#secrets) throw new RpcError('unknown_setting', `No secret ${key}: there's no secret store here`)
    if (value === null) {
      if (spec && !isSecret(spec)) throw new RpcError('invalid_setting', `${spec.title} isn't a secret: change it with settings.set`)
      if (!this.#secrets.has(key) && !(key in this.#values)) return
    } else {
      if (!spec) throw new RpcError('unknown_setting', `No secret ${key}`, { hint: 'Its extension declares it (a setting of type secret), once it is set up.' })
      if (!isSecret(spec)) throw new RpcError('invalid_setting', `${spec.title} isn't a secret: change it with settings.set`)
      const disabled = spec.disabled?.()
      if (disabled) throw new RpcError('setting_disabled', `${spec.title}: ${disabled}`)
      check(spec, value)
      // Its extension's word on it, which could quote it: never the secret itself, as errors are logged.
      const invalid = spec.validate?.(value)?.split(value).join('•••')
      if (invalid) throw new RpcError('invalid_setting', `${spec.title}: ${invalid}`)
    }
    if (this.#closed) throw new RpcError('closing', `Settings are closed: ${key} wasn't changed`)
    const saving = this.#secrets.set(key, value ?? undefined)
    this.#saving.add(saving)
    try { await saving } finally { this.#saving.delete(saving) }
    // Set (or cleared) here: what's left of it in the settings file from before it was a secret goes now.
    this.#problems.delete(key)
    if (key in this.#values) {
      const { [key]: _gone, ...rest } = this.#values
      this.#values = rest
      await this.#store.save(this.#values)
    }
    this.#secretChanged(key)
  }

  #secretChanged(key: string) {
    for (const listener of this.#secretListeners) {
      try { listener(key) } catch (error) { console.error(`A listener on the secret ${key} failed:`, error) }
    }
    this.invalidate()
  }

  /**
   * A value kept with the settings under a key that is a secret now (a `string` setting with `secret: true` before,
   * which only masked it): moved into the secret store, unless the store has one already, and out of the settings file.
   * Failing, it stays where it was, and says why.
   */
  #moveIntoStore(key: string) {
    if (!(key in this.#values)) return
    const value = this.#values[key]
    const move = (async () => {
      if (typeof value === 'string' && value.trim() && !this.#secrets!.has(key)) await this.#secrets!.set(key, value.trim())
      // The settings as they are now, less this one: others changed while it moved stay changed.
      const { [key]: _gone, ...rest } = this.#values
      this.#values = rest
      await this.#store.save(this.#values)
    })().then(() => {
      this.#problems.delete(key)
      console.log(`Settings: ${key} is a secret now: moved out of the settings into the secret store`)
      this.#secretChanged(key)
    }, (error: unknown) => {
      this.#problems.set(key, `Couldn't move it into the secret store (${error instanceof Error ? error.message : String(error)}), so it's still in the settings file in the clear: set it again here.`)
      console.error(`Settings: moving ${key} into the secret store failed; it stays in the settings for now:`, error)
      this.invalidate()
    })
    this.#saving.add(move)
    void move.finally(() => this.#saving.delete(move))
  }

  /** Hear each secret set or cleared, by its key. */
  onSecretChange(listener: (key: string) => void): () => void {
    this.#secretListeners.add(listener)
    return () => { this.#secretListeners.delete(listener) }
  }

  async set(key: string, value: Json): Promise<void> {
    const spec = this.#settings.get(key)
    if (!spec) throw new RpcError('unknown_setting', `No setting ${key}`)
    if (isSecret(spec)) throw new RpcError('secret', `${spec.title} is a secret: it's set with secrets.set, not settings.set`, { hint: `In Settings, or in your own terminal: superego secrets set ${key}` })
    const disabled = spec.disabled?.()
    if (disabled) throw new RpcError('setting_disabled', `${spec.title}: ${disabled}`)
    check(spec, value)
    const invalid = spec.validate?.(value)
    if (invalid) throw new RpcError('invalid_setting', `${spec.title}: ${invalid}`)
    if (this.#closed) throw new RpcError('closing', `Settings are closed: ${key} wasn't changed`)
    this.#values = { ...this.#values, [key]: value }
    const saving = this.#store.save(this.#values)
    this.#saving.add(saving)
    try { await saving } finally { this.#saving.delete(saving) }
    this.invalidate()
  }

  /** No more changes (a `set` from now on is refused); resolves once those being saved are. */
  async close(): Promise<void> {
    this.#closed = true
    await Promise.allSettled(this.#saving)
  }

  async snapshot(): Promise<SettingsSnapshot> {
    const sections: SectionInfo[] = []
    for (const section of this.#sections.values()) {
      const settings = section.settings.map((spec): SettingInfo => {
        const disabled = spec.disabled?.()
        return {
          ...resolveType(spec), key: spec.key, title: spec.title, default: isSecret(spec) ? false : spec.default,
          ...(spec.description ? { description: spec.description } : {}),
          ...(disabled ? { disabled } : {}),
          ...(spec.hidden?.() ? { hidden: true } : {}),
          ...(spec.consent || isSecret(spec) ? { consent: true as const } : {}),
          ...(isSecret(spec) && this.#secrets?.about?.(spec.key) ? { note: this.#secrets.about(spec.key)! } : {}),
          ...(this.#problems.has(spec.key) ? { problem: this.#problems.get(spec.key)! } : {}),
        }
      })
      const data = await section.data?.()
      sections.push({
        id: section.id, title: section.title, order: section.order ?? 100, settings,
        ...(section.description ? { description: section.description } : {}),
        ...(section.ui ? { ui: section.ui } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(section.value ? { value: section.value } : {}),
      })
    }
    sections.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    const values: Record<string, Json> = {}
    for (const key of this.#settings.keys()) values[key] = this.get(key)
    return { sections, values }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Something settings depend on changed (or a value did): tell watchers once, after the current tick. */
  invalidate(): void {
    if (this.#queued) return
    this.#queued = true
    queueMicrotask(() => {
      this.#queued = false
      for (const listener of this.#listeners) listener()
    })
  }
}
