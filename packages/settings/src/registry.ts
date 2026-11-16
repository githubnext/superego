// The settings registry: sections of typed settings registered by whoever owns them, values kept in one store.
// Types can be computed (a model list that depends on which providers are signed in), so the registry resolves them
// whenever a snapshot is taken; `invalidate()` tells watchers that something they depend on changed.
import { RpcError, type DeclaredSection, type Json, type SectionInfo, type SettingInfo, type SettingsSnapshot, type SettingType } from '@superego/protocol'

export type SettingSpec = {
  key: string
  title: string
  description?: string
  default: Json
  type: SettingType | (() => SettingType)
  /** Why it can't be changed right now, if it can't. */
  disabled?: () => string | undefined
  hidden?: () => boolean
  /** It records the user's consent: only the user changes it, never an agent (see `SettingInfo.consent`). */
  consent?: true
}

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

export class MemorySettingsStore implements SettingsStore {
  values: Record<string, Json>
  constructor(values: Record<string, Json> = {}) { this.values = values }
  load() { return { ...this.values } }
  async save(values: Record<string, Json>) { this.values = { ...values } }
}

/** A section as a window declares it (see DeclaredSection), as the registry takes it. */
export function declaredSpec(section: DeclaredSection): SectionSpec {
  return {
    ...section,
    settings: section.settings.map(({ key, title, description, default: initial, hidden, ...type }) => ({
      key, title, default: initial, type: type as SettingType, ...(description ? { description } : {}), ...(hidden ? { hidden: () => true } : {}),
    })),
  }
}

const resolveType = (spec: SettingSpec): SettingType => typeof spec.type === 'function' ? spec.type() : spec.type

function check(spec: SettingSpec, value: Json): void {
  const type = resolveType(spec)
  const bad = (why: string) => new RpcError('invalid_setting', `${spec.title}: ${why}`)
  switch (type.type) {
    case 'boolean': if (typeof value !== 'boolean') throw bad('expected true or false'); return
    case 'string': if (typeof value !== 'string') throw bad('expected text'); return
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
    case 'keymap':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('expected shortcuts by action id')
      for (const [id, keys] of Object.entries(value)) {
        if (keys !== null && (typeof keys !== 'string' || !/^([a-z]+\+)*(\+|[^+\s]+)$/i.test(keys))) throw bad(`${id}: ${JSON.stringify(keys)} is not a shortcut like mod+shift+k`)
      }
      return
    case 'layout':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('expected a layout')
      return
    case 'choice':
      if (value === null && type.nullable) return
      if (typeof value !== 'string' || !type.options.some((option) => option.value === value)) throw bad(`unknown choice ${JSON.stringify(value)}`)
  }
}

export class SettingsRegistry {
  #store: SettingsStore
  #values: Record<string, Json>
  #sections = new Map<string, SectionSpec>()
  #settings = new Map<string, SettingSpec>()
  #listeners = new Set<() => void>()
  #queued = false
  #closed = false
  #saving = new Set<Promise<void>>()

  constructor(store: SettingsStore = new MemorySettingsStore()) {
    this.#store = store
    this.#values = store.load()
  }

  /** Add a section; its keys must be new. Returns a function that removes it again. */
  register(section: SectionSpec): () => void {
    if (this.#sections.has(section.id)) throw new Error(`Settings section ${section.id} is already registered`)
    for (const setting of section.settings) if (this.#settings.has(setting.key)) throw new Error(`Setting ${setting.key} is already registered`)
    this.#sections.set(section.id, section)
    for (const setting of section.settings) this.#settings.set(setting.key, setting)
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

  /** The stored value, or the default when none is stored. Unknown keys read as undefined. */
  get<T extends Json>(key: string): T {
    const spec = this.#settings.get(key)
    return (key in this.#values ? this.#values[key] : spec?.default) as T
  }

  /** The setting `key`, as registered. */
  spec(key: string): SettingSpec | undefined { return this.#settings.get(key) }

  /** Whether a value was chosen, rather than the default applying. */
  isSet(key: string) { return key in this.#values }

  async set(key: string, value: Json): Promise<void> {
    const spec = this.#settings.get(key)
    if (!spec) throw new RpcError('unknown_setting', `No setting ${key}`)
    const disabled = spec.disabled?.()
    if (disabled) throw new RpcError('setting_disabled', `${spec.title}: ${disabled}`)
    check(spec, value)
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
          ...resolveType(spec), key: spec.key, title: spec.title, default: spec.default,
          ...(spec.description ? { description: spec.description } : {}),
          ...(disabled ? { disabled } : {}),
          ...(spec.hidden?.() ? { hidden: true } : {}),
          ...(spec.consent ? { consent: true as const } : {}),
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
