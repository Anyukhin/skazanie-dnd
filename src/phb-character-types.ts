export type PhbAbilityId = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'

export type PhbChoiceRecord = Record<string, unknown>

export interface PhbCatalogEntry {
  id: string
  label?: string
  name?: string
  english_name?: string
  [key: string]: unknown
}

export interface PhbSpellCatalogEntry extends PhbCatalogEntry {
  level: number
  classes?: string[]
  ritual?: boolean
}

export interface PhbFeatCatalogEntry extends PhbCatalogEntry {
  summary?: string
  description?: string[]
  source?: string
  mechanics_status?: string
  prerequisites?: Array<Record<string, unknown>>
  choice_schema?: Record<string, PhbChoiceSchema>
}

export interface PhbChoiceSchema {
  type?: string
  kind?: string
  count?: number
  options?: unknown[]
  [key: string]: unknown
}

export interface PhbClassCatalogEntry extends PhbCatalogEntry {
  skill_choice?: { count?: number; choice_count?: number; options?: unknown[] }
  tool_choice?: { id?: string; kind?: string; count?: number; options?: unknown[]; option_kinds?: Record<string, unknown[]> }
  choices?: Array<{ id?: string; count?: number; kind?: string; options?: unknown[]; [key: string]: unknown }>
  subclass_level?: number
  subclass_label?: string
  subclass_options?: PhbSubclassCatalogEntry[]
  subclasses?: PhbSubclassCatalogEntry[]
  armor_proficiencies?: string[]
  weapon_proficiencies?: string[]
  tool_proficiencies?: string[]
  spellcasting?: Record<string, unknown> | null
  features?: PhbCatalogEntry[]
}

export interface PhbSubclassCatalogEntry extends PhbCatalogEntry {
  aliases?: string[]
  choices?: Record<string, { count?: number; kind?: string; options?: unknown[] }>
  features?: PhbCatalogEntry[]
}

export interface PhbCharacterOptionsCatalog {
  classes: PhbClassCatalogEntry[]
  feats: PhbFeatCatalogEntry[]
  tools: PhbCatalogEntry[]
  languages: PhbCatalogEntry[]
  spells: PhbSpellCatalogEntry[]
  skills: PhbCatalogEntry[]
}

export interface PhbFeatSelection {
  id: string
  choices: PhbChoiceRecord
}

export interface PhbCharacterOptionsValue {
  schema_version: 1
  classChoices: PhbChoiceRecord
  feat?: PhbFeatSelection
}

export interface PhbCharacterOptionsProps {
  catalog: PhbCharacterOptionsCatalog
  classId: string
  /** Значение label из старого мастера; canonical id берётся из каталога при выборе. */
  subclass?: string
  abilities: Partial<Record<PhbAbilityId, number>>
  knownSkillIds: string[]
  knownToolIds: string[]
  variantHuman: boolean
  featOnly?: boolean
  featContext?: Record<string, unknown>
  value: PhbCharacterOptionsValue
  onChange: (value: PhbCharacterOptionsValue) => void
}
