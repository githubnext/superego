// The settings registry: sections of typed settings registered by whoever owns them, values kept in one store.
// Types can be computed (a model list that depends on which providers are signed in), so the registry resolves them
// whenever a snapshot is taken; `invalidate()` tells watchers that something they depend on changed.
import { RpcError, type Json, type SectionInfo, type SettingInfo, type SettingsSnapshot, type SettingType } from '@mu/protocol'

export type SettingSpec = {
  key: string
  title: string
  description?: string
  default: Json
  type: SettingType | (() => SettingType)
  /** Why it can't be changed right now, if it can't. */
  disabled?: () => string | undefined
  hidden?: () => boolean
}

export type SectionSpec = {
  id: string
  title: string
  description?: string
  order?: number
  settings: SettingSpec[]
  ui?: string
  data?: () => Json | Promise<Json>
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

  /** The stored value, or the default when none is stored. Unknown keys read as undefined. */
  get<T extends Json>(key: string): T {
    const spec = this.#settings.get(key)
    return (key in this.#values ? this.#values[key] : spec?.default) as T
  }

  /** Whether a value was chosen, rather than the default applying. */
  isSet(key: string) { return key in this.#values }

  async set(key: string, value: Json): Promise<void> {
    const spec = this.#settings.get(key)
    if (!spec) throw new RpcError('unknown_setting', `No setting ${key}`)
    const disabled = spec.disabled?.()
    if (disabled) throw new RpcError('setting_disabled', `${spec.title}: ${disabled}`)
    check(spec, value)
    this.#values = { ...this.#values, [key]: value }
    await this.#store.save(this.#values)
    this.invalidate()
  }

  /** Forget a chosen value so the default applies again. */
  async reset(key: string): Promise<void> {
    if (!(key in this.#values)) return
    const { [key]: _removed, ...rest } = this.#values
    this.#values = rest
    await this.#store.save(this.#values)
    this.invalidate()
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
        }
      })
      const data = await section.data?.()
      sections.push({
        id: section.id, title: section.title, order: section.order ?? 100, settings,
        ...(section.description ? { description: section.description } : {}),
        ...(section.ui ? { ui: section.ui } : {}),
        ...(data !== undefined ? { data } : {}),
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
