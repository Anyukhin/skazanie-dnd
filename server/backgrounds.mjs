// @ts-check
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DND_2014_RULESET_ID, LEGACY_DEFAULT_RULESET_ID, rulesetProfile } from './ruleset-config.mjs'

/** @typedef {{ id: string, name: string, catalogId?: string }} NamedEntry */
/** @typedef {{ id: string, label: string, increases: number[] }} AbilityMode */
/**
 * @typedef {Record<string, any> & {
 *   id: string,
 *   name: string,
 *   abilityOptions?: string[],
 *   skillProficiencies: string[],
 *   toolProficiency?: NamedEntry,
 *   toolProficiencies?: NamedEntry[],
 *   toolChoice?: { group?: string, count?: number, options?: NamedEntry[] },
 *   languageChoiceCount?: number,
 *   originFeat?: NamedEntry,
 *   feature?: NamedEntry & { supported?: boolean },
 *   equipment?: Record<string, any>,
 * }} BackgroundEntry
 */
/** @typedef {{ policyId?: string, abilityChoiceModes?: AbilityMode[], languageOptions?: NamedEntry[], toolChoiceGroups?: Record<string, NamedEntry[]>, backgrounds: BackgroundEntry[] }} BackgroundCatalog */

/** @type {BackgroundCatalog} */
const currentCatalog = JSON.parse(readFileSync(fileURLToPath(new URL('../data/backgrounds-srd-5-2-1.json', import.meta.url)), 'utf8'))
/** @type {BackgroundCatalog} */
const classicCatalog = JSON.parse(readFileSync(fileURLToPath(new URL('../data/backgrounds-dnd-5e-2014.json', import.meta.url)), 'utf8'))

const catalogs = new Map([
  [LEGACY_DEFAULT_RULESET_ID, currentCatalog],
  [DND_2014_RULESET_ID, classicCatalog],
])
const ABILITY_IDS = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha'])

/** @param {unknown} rulesetId */
function catalogFor(rulesetId) {
  const profile = rulesetProfile(rulesetId, { fallback: LEGACY_DEFAULT_RULESET_ID })
  const catalog = catalogs.get(profile.id)
  if (!catalog) throw new TypeError(`Нет каталога предысторий для ${profile.id}`)
  return catalog
}

/** @param {BackgroundCatalog} catalog */
function abilityModesFor(catalog) {
  return (catalog.abilityChoiceModes ?? []).map((mode) => ({ ...mode, increases: [...mode.increases] }))
}

/** @param {BackgroundCatalog} catalog @param {BackgroundEntry} entry @returns {BackgroundEntry} */
function publicBackground(catalog, entry) {
  const group = String(entry.toolChoice?.group ?? '')
  const options = group ? catalog.toolChoiceGroups?.[group] ?? [] : []
  return /** @type {BackgroundEntry} */ (structuredClone({
    ...entry,
    toolProficiencies: entry.toolProficiencies ?? (entry.toolProficiency ? [entry.toolProficiency] : []),
    ...(entry.toolChoice ? { toolChoice: { ...entry.toolChoice, options } } : {}),
  }))
}

export const BACKGROUND_POLICY_ID = String(currentCatalog.policyId ?? 'skazanie.backgrounds')
export const BACKGROUND_ABILITY_MODES = Object.freeze(
  abilityModesFor(currentCatalog).map((mode) => Object.freeze({ ...mode, increases: Object.freeze([...mode.increases]) })),
)

export function backgroundCatalogFor(rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const catalog = catalogFor(rulesetId)
  return {
    policy_id: String(catalog.policyId ?? 'skazanie.backgrounds'),
    ability_modes: abilityModesFor(catalog),
    language_options: structuredClone(catalog.languageOptions ?? []),
    options: catalog.backgrounds.map((entry) => publicBackground(catalog, entry)),
    origin_feats_supported: false,
    background_features_supported: false,
  }
}

export function listBackgrounds(rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const catalog = catalogFor(rulesetId)
  return catalog.backgrounds.map((entry) => publicBackground(catalog, entry))
}

/** @param {unknown} id @param {unknown} [rulesetId] */
export function backgroundById(id, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const catalog = catalogFor(rulesetId)
  const entry = catalog.backgrounds.find((candidate) => String(candidate.id) === String(id ?? ''))
  return entry ? publicBackground(catalog, entry) : null
}

/**
 * @param {unknown} backgroundId
 * @param {{ mode?: string, abilities?: string[] }} choice
 * @param {unknown} [rulesetId]
 * @returns {{ ok: true, bonuses: Record<string, number>, mode: string } | { ok: false, reason: string }}
 */
export function resolveBackgroundAbilityChoice(backgroundId, choice = {}, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const catalog = catalogFor(rulesetId)
  const background = backgroundById(backgroundId, rulesetId)
  if (!background) return { ok: false, reason: 'Такой предыстории нет в каталоге' }
  const modes = abilityModesFor(catalog)
  const picked = (Array.isArray(choice.abilities) ? choice.abilities : []).map((value) => String(value).toLowerCase())
  if (!modes.length) {
    if (picked.length || (choice.mode && choice.mode !== 'none')) return { ok: false, reason: 'В редакции 2014 предыстория не повышает характеристики' }
    return { ok: true, bonuses: {}, mode: 'none' }
  }
  const allowed = new Set(background.abilityOptions ?? [])
  const mode = modes.find((entry) => entry.id === String(choice.mode ?? '')) ?? modes[0]
  const expected = mode.increases.length
  if (picked.length !== expected) return { ok: false, reason: `Для раскладки «${mode.label}» нужно выбрать ${expected} характеристики` }
  if (new Set(picked).size !== picked.length) return { ok: false, reason: 'Характеристики в раскладке не должны повторяться' }
  for (const ability of picked) {
    if (!ABILITY_IDS.includes(ability)) return { ok: false, reason: 'Неизвестная характеристика' }
    if (!allowed.has(ability)) return { ok: false, reason: 'Эта предыстория такую характеристику не повышает' }
  }
  /** @type {Record<string, number>} */
  const bonuses = {}
  picked.forEach((ability, index) => { bonuses[ability] = mode.increases[index] })
  return { ok: true, bonuses, mode: mode.id }
}

/** @param {unknown} backgroundId @param {unknown} [rulesetId] */
export function defaultBackgroundAbilityChoice(backgroundId, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const catalog = catalogFor(rulesetId)
  const background = backgroundById(backgroundId, rulesetId)
  if (!background) return null
  const modes = abilityModesFor(catalog)
  if (!modes.length) return { mode: 'none', abilities: [] }
  return { mode: modes[0].id, abilities: (background.abilityOptions ?? []).slice(0, modes[0].increases.length) }
}

/**
 * @param {unknown} backgroundId
 * @param {{ tools?: string[], languages?: string[] }} [choice]
 * @param {unknown} [rulesetId]
 * @returns {{ ok: true, tools: string[], languages: string[], selected_tool_entries: NamedEntry[], fixed_tool_proficiencies: NamedEntry[] } | { ok: false, reason: string }}
 */
export function resolveBackgroundChoices(backgroundId, choice = {}, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const catalog = catalogFor(rulesetId)
  const background = backgroundById(backgroundId, rulesetId)
  if (!background) return { ok: false, reason: 'Такой предыстории нет в каталоге' }
  const toolOptions = background.toolChoice?.options ?? []
  const toolCount = Number(background.toolChoice?.count ?? 0)
  const tools = (Array.isArray(choice.tools) ? choice.tools : []).map(String)
  const languages = (Array.isArray(choice.languages) ? choice.languages : []).map(String)
  const languageCount = Number(background.languageChoiceCount ?? 0)
  if (tools.length !== toolCount || new Set(tools).size !== tools.length) return { ok: false, reason: `Нужно выбрать ${toolCount} владений инструментами` }
  if (languages.length !== languageCount || new Set(languages).size !== languages.length) return { ok: false, reason: `Нужно выбрать ${languageCount} языков предыстории` }
  const allowedTools = new Set(toolOptions.map((entry) => String(entry.id)))
  const allowedLanguages = new Set((catalog.languageOptions ?? []).map((entry) => String(entry.id)))
  if (tools.some((id) => !allowedTools.has(id))) return { ok: false, reason: 'Предыстория не позволяет выбрать этот инструмент' }
  if (languages.some((id) => !allowedLanguages.has(id))) return { ok: false, reason: 'Неизвестный язык предыстории' }
  const selectedToolEntries = /** @type {NamedEntry[]} */ (tools.map((id) => toolOptions.find((entry) => String(entry.id) === id)).filter(Boolean))
  return {
    ok: true,
    tools,
    languages,
    selected_tool_entries: structuredClone(selectedToolEntries),
    fixed_tool_proficiencies: structuredClone(background.toolProficiencies ?? []),
  }
}

/** @param {unknown} backgroundId @param {unknown} [rulesetId] */
export function defaultBackgroundChoices(backgroundId, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const background = backgroundById(backgroundId, rulesetId)
  const catalog = catalogFor(rulesetId)
  if (!background) return null
  return {
    tools: (background.toolChoice?.options ?? []).slice(0, Number(background.toolChoice?.count ?? 0)).map((entry) => entry.id),
    languages: (catalog.languageOptions ?? []).slice(0, Number(background.languageChoiceCount ?? 0)).map((entry) => entry.id),
  }
}

/** @param {Record<string, any>} actor @param {unknown} [rulesetId] */
export function withBackgroundBenefits(actor, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const background = backgroundById(actor?.backgroundId, rulesetId)
  if (!background) {
    const { backgroundSkillProficiencies: _skills, backgroundBenefits: _benefits, ...rest } = actor ?? {}
    return rest
  }
  return {
    ...actor,
    backgroundSkillProficiencies: [...background.skillProficiencies],
    backgroundBenefits: backgroundBenefits(background.id, actor.backgroundAbilityChoice, actor.backgroundChoices, rulesetId),
  }
}

/** @param {unknown} backgroundId @param {{ mode?: string, abilities?: string[] } | null} [abilityChoice] @param {{ tools?: string[], languages?: string[] } | null} [choices] @param {unknown} [rulesetId] */
export function backgroundBenefits(backgroundId, abilityChoice, choices, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const catalog = catalogFor(rulesetId)
  const background = backgroundById(backgroundId, rulesetId)
  if (!background) return null
  const resolvedAbilities = resolveBackgroundAbilityChoice(backgroundId, abilityChoice ?? defaultBackgroundAbilityChoice(backgroundId, rulesetId) ?? {}, rulesetId)
  const resolvedChoices = resolveBackgroundChoices(backgroundId, choices ?? defaultBackgroundChoices(backgroundId, rulesetId) ?? {}, rulesetId)
  if (!resolvedAbilities.ok || !resolvedChoices.ok) return null
  const fixedTools = background.toolProficiencies ?? []
  const selectedTools = resolvedChoices.selected_tool_entries ?? []
  const toolIds = [...new Set([...fixedTools, ...selectedTools].map((entry) => String(entry.id)))]
  return {
    ruleset_id: rulesetProfile(rulesetId, { fallback: LEGACY_DEFAULT_RULESET_ID }).id,
    background_id: background.id,
    policy_id: String(catalog.policyId ?? 'skazanie.backgrounds'),
    ability_bonuses: resolvedAbilities.bonuses,
    ability_mode: resolvedAbilities.mode,
    skill_proficiencies: [...background.skillProficiencies],
    tool_proficiency: toolIds[0] ?? null,
    tool_proficiencies: toolIds,
    languages: [...resolvedChoices.languages],
    origin_feat: background.originFeat?.id ?? null,
    origin_feat_supported: false,
    background_feature: background.feature?.id ?? null,
    background_feature_supported: background.feature?.supported === true,
    equipment: structuredClone(background.equipment ?? null),
  }
}

export function backgroundCatalogInfo() {
  return Object.fromEntries([...catalogs.entries()].map(([rulesetId, catalog]) => [rulesetId, {
    ruleset_id: rulesetId,
    backgrounds: catalog.backgrounds.length,
    ability_modes: (catalog.abilityChoiceModes ?? []).length,
  }]))
}
