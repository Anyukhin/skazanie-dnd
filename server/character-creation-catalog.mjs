import { readFileSync } from 'node:fs'

import {
  DND_2014_RULESET_ID,
  LEGACY_DEFAULT_RULESET_ID,
  rulesetProfile,
} from './ruleset-config.mjs'

const currentPolicy = JSON.parse(readFileSync(
  new URL('../data/character-creation-policy-v1.json', import.meta.url),
  'utf8',
))
const classicPolicy = JSON.parse(readFileSync(
  new URL('../data/character-creation-dnd-5e-2014.json', import.meta.url),
  'utf8',
))

const policies = new Map([
  [LEGACY_DEFAULT_RULESET_ID, currentPolicy],
  [DND_2014_RULESET_ID, classicPolicy],
])

const ABILITY_IDS = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha'])

function policyFor(rulesetId) {
  const profile = rulesetProfile(rulesetId, { fallback: LEGACY_DEFAULT_RULESET_ID })
  const policy = policies.get(profile.id)
  if (!policy) throw new TypeError(`Нет каталога создания героя для ${profile.id}`)
  return policy
}

function publicChoiceGroup(policy, group) {
  const options = Array.isArray(group.options)
    ? group.options
    : Array.isArray(policy.choice_catalogs?.[group.catalog])
      ? policy.choice_catalogs[group.catalog]
      : []
  return { ...structuredClone(group), options: structuredClone(options) }
}

function publicSpeciesOption(policy, option) {
  return {
    ...structuredClone(option),
    choice_groups: (option.choice_groups ?? []).map((group) => publicChoiceGroup(policy, group)),
  }
}

function publicPolicy(policy) {
  return {
    ...structuredClone(policy),
    species_options: policy.species_options.map((option) => publicSpeciesOption(policy, option)),
  }
}

function assertPolicy(policy) {
  if (policy.schema_version !== 1 || policy.method !== 'standard_array'
    || !Array.isArray(policy.standard_array) || policy.standard_array.length !== 6
    || !Array.isArray(policy.origin_bonus_profiles) || !Array.isArray(policy.species_options)) {
    throw new TypeError(`Некорректный каталог создания героя ${policy.ruleset_id}`)
  }
  const speciesIds = policy.species_options.map((entry) => String(entry.id))
  const profileIds = new Set(policy.origin_bonus_profiles.map((entry) => String(entry.id)))
  if (new Set(speciesIds).size !== speciesIds.length) throw new TypeError(`Повтор species id в ${policy.ruleset_id}`)
  if (policy.bonus_source === 'species') {
    for (const species of policy.species_options) {
      if (!profileIds.has(String(species.bonus_profile_id))) {
        throw new TypeError(`Вид ${species.id} ссылается на неизвестный bonus profile`)
      }
    }
  }
}

for (const policy of policies.values()) assertPolicy(policy)

export function characterCreationPolicyFor(rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  return publicPolicy(policyFor(rulesetId))
}

export function speciesOptionFor(speciesOptionId, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const policy = policyFor(rulesetId)
  const option = policy.species_options.find((entry) => String(entry.id) === String(speciesOptionId ?? ''))
  return option ? publicSpeciesOption(policy, option) : null
}

export function originBonusProfileFor(profileId, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const profile = policyFor(rulesetId).origin_bonus_profiles.find((entry) => String(entry.id) === String(profileId ?? ''))
  return profile ? structuredClone(profile) : null
}

export function defaultSpeciesChoices(speciesOptionId, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const option = speciesOptionFor(speciesOptionId, rulesetId)
  if (!option) return null
  return Object.fromEntries((option.choice_groups ?? []).map((group) => [
    group.id,
    group.options.slice(0, Number(group.count ?? 0)).map((entry) => entry.id),
  ]))
}

export function resolveSpeciesChoices(speciesOptionId, choices = {}, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const option = speciesOptionFor(speciesOptionId, rulesetId)
  if (!option) return { ok: false, reason: 'Выбран неподдерживаемый вид персонажа' }
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return { ok: false, reason: 'speciesChoices должен быть объектом' }
  const groups = option.choice_groups ?? []
  const allowedGroups = new Set(groups.map((group) => String(group.id)))
  for (const key of Object.keys(choices)) if (!allowedGroups.has(key)) return { ok: false, reason: `Выбор ${key} не принадлежит этому виду` }
  const resolved = {}
  const selectedOptions = []
  for (const group of groups) {
    const selected = Array.isArray(choices[group.id]) ? choices[group.id].map(String) : []
    const expected = Math.max(0, Number(group.count ?? 0))
    if (selected.length !== expected || new Set(selected).size !== selected.length) {
      return { ok: false, reason: `${group.label}: нужно выбрать ${expected}` }
    }
    const byId = new Map((group.options ?? []).map((entry) => [String(entry.id), entry]))
    if (selected.some((id) => !byId.has(id))) return { ok: false, reason: `${group.label}: неизвестный вариант` }
    if (group.kind === 'language' && selected.some((id) => (option.languages ?? []).includes(id))) {
      return { ok: false, reason: `${group.label}: этот язык уже известен персонажу` }
    }
    resolved[group.id] = selected
    selectedOptions.push(...selected.map((id) => ({ group_id: group.id, kind: group.kind, ...structuredClone(byId.get(id)) })))
  }
  return { ok: true, choices: resolved, selected_options: selectedOptions }
}

export function speciesBenefitsFor(speciesOptionId, rulesetId = LEGACY_DEFAULT_RULESET_ID, choices = undefined) {
  const option = speciesOptionFor(speciesOptionId, rulesetId)
  if (!option) return null
  const profile = option.bonus_profile_id ? originBonusProfileFor(option.bonus_profile_id, rulesetId) : null
  const resolved = resolveSpeciesChoices(
    speciesOptionId,
    choices ?? defaultSpeciesChoices(speciesOptionId, rulesetId) ?? {},
    rulesetId,
  )
  if (!resolved.ok) return null
  const selectedLanguages = resolved.selected_options.filter((entry) => entry.kind === 'language').map((entry) => entry.id)
  const selectedSkills = resolved.selected_options.filter((entry) => entry.kind === 'skill').map((entry) => entry.id)
  const selectedTools = resolved.selected_options.filter((entry) => entry.kind === 'tool').map((entry) => entry.id)
  const selectedCantrips = resolved.selected_options.filter((entry) => entry.kind === 'cantrip').map((entry) => ({
    id: entry.id, minimum_level: 1, ability: 'int', uses: 'at-will', source: 'species-choice',
  }))
  const ancestry = resolved.selected_options.find((entry) => entry.kind === 'ancestry') ?? null
  const mechanics = structuredClone(option.mechanics ?? {})
  if (ancestry) {
    mechanics.damage_resistances = [...new Set([...(mechanics.damage_resistances ?? []), ancestry.damage_type])]
    mechanics.dragon_ancestry = {
      id: ancestry.id,
      label: ancestry.label,
      damage_type: ancestry.damage_type,
      shape: ancestry.shape,
      distance_feet: Number(ancestry.distance_feet),
      save_ability: 'dex',
    }
  }
  const innateSpells = [...(mechanics.innate_spells ?? []), ...selectedCantrips]
  return {
    ruleset_id: String(policyFor(rulesetId).ruleset_id),
    species_option_id: option.id,
    race_id: option.race_id ?? option.id,
    subrace_id: option.subrace_id ?? null,
    size: option.size ?? null,
    base_speed: Number(option.base_speed),
    choices: structuredClone(resolved.choices),
    languages: [...new Set([...(option.languages ?? []), ...selectedLanguages])],
    skill_proficiencies: [...new Set([...(mechanics.skill_proficiencies ?? []), ...selectedSkills])],
    tool_proficiencies: [...new Set([...(mechanics.tool_proficiencies ?? []), ...selectedTools])],
    innate_spells: innateSpells,
    mechanics,
    ability_bonus_profile_id: profile?.id ?? null,
    trait_summaries: [...(option.trait_summaries ?? [])],
    traits_supported: false,
    traits_mechanics_status: Object.keys(mechanics).length ? 'partial' : 'ruling-only',
    source_url: option.source_url ?? null,
  }
}

export function validateSpeciesOriginBonuses(speciesOptionId, profileId, originBonuses, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const policy = policyFor(rulesetId)
  if (policy.bonus_source !== 'species') return { ok: true, selectedAbilities: [] }
  const option = policy.species_options.find((entry) => String(entry.id) === String(speciesOptionId ?? ''))
  if (!option) return { ok: false, reason: 'Выбран неподдерживаемый вид персонажа' }
  if (String(option.bonus_profile_id) !== String(profileId ?? '')) {
    return { ok: false, reason: 'Профиль прибавок не принадлежит выбранному виду' }
  }
  const profile = policy.origin_bonus_profiles.find((entry) => String(entry.id) === String(profileId ?? ''))
  if (!profile) return { ok: false, reason: 'Неизвестный профиль прибавок вида' }
  const fixed = profile.fixed_bonuses ?? {}
  const excluded = new Set((profile.excluded_choices ?? []).map(String))
  const choiceAmount = Number(profile.choice_amount ?? 0)
  const selectedAbilities = []
  for (const ability of ABILITY_IDS) {
    const actual = Number(originBonuses?.[ability] ?? 0)
    const base = Number(fixed[ability] ?? 0)
    if (actual === base) continue
    if (choiceAmount > 0 && actual === base + choiceAmount && !excluded.has(ability)) {
      selectedAbilities.push(ability)
      continue
    }
    return { ok: false, reason: 'Прибавки не соответствуют выбранной расе или подрасе' }
  }
  if (selectedAbilities.length !== Number(profile.choice_count ?? 0)) {
    return { ok: false, reason: `Нужно выбрать ${Number(profile.choice_count ?? 0)} дополнительные характеристики вида` }
  }
  return { ok: true, selectedAbilities }
}

export function characterCreationOriginCatalogInfo() {
  return Object.fromEntries([...policies.entries()].map(([rulesetId, policy]) => [rulesetId, {
    ruleset_id: rulesetId,
    species_options: policy.species_options.length,
    bonus_profiles: policy.origin_bonus_profiles.length,
    bonus_source: policy.bonus_source,
  }]))
}
