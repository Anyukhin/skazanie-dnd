import { normalizedSpellSelectionsFor, spellSelectionRulesFor } from './combat-spells.mjs'
import { normalizedCombatSubclassFor } from './combat-actions.mjs'
import { abilityScoreChoiceLevelsFor, catalogSkillId, normalizedClassSkillProficiencies, normalizedSelectedFeatureIds } from './character-progression.mjs'
import { resolveCharacterCreationFeat } from './character-creation-feats.mjs'
import { DND_2014_RULESET_ID } from './ruleset-config.mjs'

export const CHARACTER_BUILD_COMMAND_TYPES = new Set(['SetCharacterChoices', 'SetSpellSelections'])

export class CharacterBuildValidationError extends Error {
  constructor(message, code = 'CHARACTER_BUILD_INVALID') {
    super(message)
    this.name = 'CharacterBuildValidationError'
    this.code = code
  }
}

const clone = (value) => structuredClone(value)
const clean = (value, maximum = 120) => String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
const ABILITY_IDS = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha'])

function uniqueIds(value, field) {
  if (!Array.isArray(value)) {
    throw new CharacterBuildValidationError(`${field} должен быть массивом`, 'SPELL_SELECTION_INVALID')
  }
  if (value.length > 100) {
    throw new CharacterBuildValidationError(`${field} содержит слишком много значений`, 'SPELL_SELECTION_LIMIT_EXCEEDED')
  }
  const result = [...new Set(value.map((item) => clean(item)).filter(Boolean))]
  // Алфавит совпадает с cleanIdentifier в character-lifecycle.mjs: навыки
  // серверного каталога хранятся в snake_case.
  if (result.some((item) => !/^[a-z0-9][a-z0-9_-]{0,119}$/u.test(item))) {
    throw new CharacterBuildValidationError(`${field} содержит некорректный идентификатор`, 'SPELL_SELECTION_INVALID')
  }
  return result
}

function sameIds(left, right) {
  if (left.length !== right.length) return false
  const expected = new Set(right)
  return left.every((item) => expected.has(item))
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function levelFeatsFor(actor) {
  const source = actor?.levelFeats
  if (!isRecord(source)) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([level, entry]) => {
    const numericLevel = Number(level)
    if (!Number.isSafeInteger(numericLevel) || !isRecord(entry) || !String(entry.id ?? '').trim()) return []
    return [[String(numericLevel), {
      id: String(entry.id).trim().toLocaleLowerCase('en'),
      choices: isRecord(entry.choices) ? clone(entry.choices) : {},
      ...(isRecord(entry.benefits) ? { benefits: clone(entry.benefits) } : {}),
    }]]
  }))
}

function featContextFor(actor, levelFeats) {
  const existingFeats = []
  const existingFeatChoices = {}
  const initialFeat = actor?.creationBenefits?.feat
  const initialFeatId = String(initialFeat?.id ?? '').trim().toLocaleLowerCase('en')
  if (initialFeatId) {
    existingFeats.push(initialFeatId)
    const initialChoices = actor?.phbCreation?.feat?.choices
    if (isRecord(initialChoices)) existingFeatChoices[initialFeatId] = [clone(initialChoices)]
  }
  for (const entry of Object.values(levelFeats)) {
    existingFeats.push(entry.id)
    if (!Array.isArray(existingFeatChoices[entry.id])) existingFeatChoices[entry.id] = []
    existingFeatChoices[entry.id].push(clone(entry.choices))
  }
  const creationBenefits = isRecord(actor?.creationBenefits) ? actor.creationBenefits : {}
  return {
    abilities: clone(actor?.abilities ?? {}),
    proficiency: {
      armor: Array.isArray(creationBenefits.armor_proficiencies) ? creationBenefits.armor_proficiencies : [],
      weapons: Array.isArray(creationBenefits.weapon_proficiencies) ? creationBenefits.weapon_proficiencies : [],
    },
    skills: [
      ...(Array.isArray(actor?.classSkillProficiencies) ? actor.classSkillProficiencies : []),
      ...(Array.isArray(actor?.backgroundSkillProficiencies) ? actor.backgroundSkillProficiencies : []),
      ...(Array.isArray(actor?.speciesSkillProficiencies) ? actor.speciesSkillProficiencies : []),
      ...(Array.isArray(actor?.creationSkillProficiencies) ? actor.creationSkillProficiencies : []),
    ],
    tools: Array.isArray(creationBenefits.tool_proficiencies) ? creationBenefits.tool_proficiencies : [],
    languages: Array.isArray(creationBenefits.languages) ? creationBenefits.languages : [],
    canCastSpells: Boolean(spellSelectionRulesFor(actor)
      || (Array.isArray(creationBenefits.spell_grants) && creationBenefits.spell_grants.length)
      || (Array.isArray(actor?.creationSpellGrants) && actor.creationSpellGrants.length)),
    allowCappedAbilityIncrease: true,
    feats: existingFeats,
    existingFeatChoices,
  }
}

function addUnique(target, values) {
  const result = Array.isArray(target) ? [...target] : []
  for (const value of Array.isArray(values) ? values : []) if (!result.includes(value)) result.push(value)
  return result
}

function featSpellGrants(benefits) {
  const spellcasting = benefits?.spellcasting
  if (!isRecord(spellcasting)) return []
  const grants = []
  for (const id of Array.isArray(spellcasting.cantrips) ? spellcasting.cantrips : []) {
    grants.push({ id: String(id), ability: spellcasting.ability, uses: 'at-will', source: spellcasting.source ?? 'level-feat' })
  }
  if (spellcasting.first_level_spell) {
    grants.push({ id: String(spellcasting.first_level_spell), ability: spellcasting.ability, uses: 1, source: spellcasting.source ?? 'level-feat' })
  }
  return grants
}

function mergeBenefits(actor, benefits) {
  const base = isRecord(actor?.creationBenefits) ? clone(actor.creationBenefits) : {}
  const addition = isRecord(benefits) ? benefits : {}
  const arrayFields = ['armor_proficiencies', 'weapon_proficiencies', 'tool_proficiencies', 'language_proficiencies', 'saving_throw_proficiencies', 'expertise']
  for (const field of arrayFields) base[field] = addUnique(base[field], addition[field])
  base.languages = addUnique(base.languages, addition.language_proficiencies)
  base.language_labels = addUnique(base.language_labels, addition.language_proficiencies)
  base.tool_proficiency_labels = addUnique(base.tool_proficiency_labels, addition.tool_proficiencies)
  const passive = { ...(isRecord(base.passive_skill_bonuses) ? base.passive_skill_bonuses : {}) }
  for (const [key, value] of Object.entries(isRecord(addition.passive_skill_bonuses) ? addition.passive_skill_bonuses : {})) {
    passive[key] = Number(passive[key] ?? 0) + Number(value ?? 0)
  }
  if (Object.keys(passive).length) base.passive_skill_bonuses = passive
  for (const field of ['speed_bonus', 'initiative_bonus', 'hit_point_maximum_bonus_per_level']) {
    const amount = Number(addition[field] ?? 0)
    if (amount) base[field] = Number(base[field] ?? 0) + amount
  }
  const hitPointBonus = Number(addition.extra_hit_points_per_level ?? 0) + Number(addition.hit_point_maximum_bonus_per_level ?? 0)
  if (hitPointBonus) base.extra_hit_points_per_level = Number(base.extra_hit_points_per_level ?? 0) + hitPointBonus
  if (isRecord(addition.spellcasting)) base.level_feat_spellcasting = clone(addition.spellcasting)
  if (isRecord(addition.static)) base.level_feat_static = { ...(isRecord(base.level_feat_static) ? base.level_feat_static : {}), ...clone(addition.static) }
  if (addition.spellcasting?.source === 'ritual-caster') base.ritual_book = clone(addition.spellcasting)
  const grants = [...(Array.isArray(base.spell_grants) ? base.spell_grants : []), ...featSpellGrants(addition)]
  base.spell_grants = grants.filter((grant, index, list) => list.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(grant)) === index)
  return base
}

function mergeFeatSkillProficiencies(actor, benefits) {
  return addUnique(actor?.creationSkillProficiencies, benefits?.skill_proficiencies)
}

function mergeFeatSpellGrants(actor, benefits) {
  const grants = [...(Array.isArray(actor?.creationSpellGrants) ? actor.creationSpellGrants : []), ...featSpellGrants(benefits)]
  return grants.filter((grant, index, list) => list.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(grant)) === index)
}

function applyAbilityIncreases(actor, benefits) {
  const abilities = Object.fromEntries(['str', 'dex', 'con', 'int', 'wis', 'cha'].map((id) => [id, Math.max(1, Math.min(30, Number(actor?.abilities?.[id]) || 10))]))
  for (const [id, amount] of Object.entries(isRecord(benefits?.ability_increases) ? benefits.ability_increases : {})) {
    if (Object.hasOwn(abilities, id)) abilities[id] = Math.min(20, abilities[id] + Math.max(0, Number(amount) || 0))
  }
  return abilities
}

function abilityScoreChoicesFor(actor) {
  const source = actor?.abilityScoreIncreases
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([level, choices]) => {
    const numericLevel = Number(level)
    if (!Number.isSafeInteger(numericLevel) || !Array.isArray(choices)) return []
    return [[String(numericLevel), choices.map(String)]]
  }))
}

function normalizeAbilityScoreChoices(value) {
  if (!Array.isArray(value) || (value.length !== 1 && value.length !== 2)) {
    throw new CharacterBuildValidationError('Улучшение характеристик должно дать +2 одной или +1 двум характеристикам', 'ABILITY_SCORE_CHOICE_INVALID')
  }
  const choices = value.map((entry) => clean(entry, 12).toLowerCase())
  if (choices.some((entry) => !ABILITY_IDS.has(entry))) {
    throw new CharacterBuildValidationError('Выбрана неизвестная характеристика', 'ABILITY_SCORE_CHOICE_INVALID')
  }
  return choices
}

function abilityScoreChoiceFor(command, actor) {
  const rawLevel = command.ability_score_level ?? command.abilityScoreLevel
  const rawChoices = command.ability_score_increases ?? command.abilityScoreIncreases
  const existing = abilityScoreChoicesFor(actor)
  const levelFeats = levelFeatsFor(actor)
  if (rawLevel == null && rawChoices == null) return { level: null, choices: null, all: existing, abilities: clone(actor.abilities ?? {}) }
  const level = Number(rawLevel)
  if (!Number.isSafeInteger(level) || !abilityScoreChoiceLevelsFor(actor).includes(level) || level > Number(actor.level ?? 1)) {
    throw new CharacterBuildValidationError('Улучшение характеристик недоступно на этом уровне', 'ABILITY_SCORE_LEVEL_INVALID')
  }
  const choices = normalizeAbilityScoreChoices(rawChoices)
  if (levelFeats[String(level)]) {
    throw new CharacterBuildValidationError('На этом уровне уже выбрана черта вместо улучшения характеристик', 'ABILITY_SCORE_CHOICE_LOCKED')
  }
  const previous = existing[String(level)]
  if (previous && JSON.stringify(previous) !== JSON.stringify(choices)) {
    throw new CharacterBuildValidationError('Улучшение характеристик этого уровня уже выбрано', 'ABILITY_SCORE_CHOICE_LOCKED')
  }
  const all = { ...existing, [String(level)]: choices }
  const abilities = Object.fromEntries(['str', 'dex', 'con', 'int', 'wis', 'cha'].map((id) => [id, Math.max(1, Math.min(30, Number(actor.abilities?.[id]) || 10))]))
  if (!previous) {
    if (choices.length === 1) {
      const id = choices[0]
      if (abilities[id] > 18) throw new CharacterBuildValidationError('Характеристика уже достигла максимума 20', 'ABILITY_SCORE_MAX_REACHED')
      abilities[id] += 2
    } else {
      for (const id of choices) {
        if (abilities[id] >= 20) throw new CharacterBuildValidationError('Характеристика уже достигла максимума 20', 'ABILITY_SCORE_MAX_REACHED')
        abilities[id] += 1
      }
    }
  }
  return { level, choices, all, abilities }
}

function abilityScoreFeatFor(command, actor, rulesetId) {
  const rawLevel = command.ability_score_level ?? command.abilityScoreLevel
  const rawFeat = command.ability_score_feat ?? command.abilityScoreFeat
  const rawAsi = command.ability_score_increases ?? command.abilityScoreIncreases
  if (rawFeat == null) return null
  if (rulesetId !== DND_2014_RULESET_ID) {
    throw new CharacterBuildValidationError('Черты PHB 2014 доступны только в редакции D&D 5e 2014', 'ABILITY_SCORE_FEAT_UNAVAILABLE')
  }
  if (rawAsi != null) throw new CharacterBuildValidationError('Нельзя выбрать и улучшение характеристик, и черту на одном уровне', 'ABILITY_SCORE_CHOICE_CONFLICT')
  const level = Number(rawLevel)
  if (!Number.isSafeInteger(level) || !abilityScoreChoiceLevelsFor(actor).includes(level) || level > Number(actor.level ?? 1)) {
    throw new CharacterBuildValidationError('Черта вместо улучшения характеристик недоступна на этом уровне', 'ABILITY_SCORE_LEVEL_INVALID')
  }
  const key = String(level)
  const existingAsi = abilityScoreChoicesFor(actor)[key]
  const levelFeats = levelFeatsFor(actor)
  if (existingAsi || levelFeats[key]) {
    throw new CharacterBuildValidationError('Выбор этого уровня уже зафиксирован', 'ABILITY_SCORE_CHOICE_LOCKED')
  }
  if (!isRecord(rawFeat) || Array.isArray(rawFeat)) {
    throw new CharacterBuildValidationError('ability_score_feat должен быть объектом', 'ABILITY_SCORE_FEAT_INVALID')
  }
  const featId = clean(rawFeat.id, 80).toLocaleLowerCase('en')
  const choices = isRecord(rawFeat.choices) ? clone(rawFeat.choices) : {}
  const resolved = resolveCharacterCreationFeat(featId, choices, featContextFor(actor, levelFeats))
  if (!resolved.ok) throw new CharacterBuildValidationError(resolved.reason ?? 'Выбор черты недоступен', resolved.code ?? 'ABILITY_SCORE_FEAT_INVALID')
  const entry = { id: resolved.feat.id, choices: clone(resolved.choices), benefits: clone(resolved.benefits) }
  const all = { ...levelFeats, [key]: entry }
  const abilities = applyAbilityIncreases(actor, resolved.benefits)
  return {
    level,
    entry,
    all,
    abilities,
    creationBenefits: mergeBenefits(actor, resolved.benefits),
    creationSkillProficiencies: mergeFeatSkillProficiencies(actor, resolved.benefits),
    creationSpellGrants: mergeFeatSpellGrants(actor, resolved.benefits),
  }
}

export function validateCharacterBuildCommand(command, state, context = {}) {
  if (!CHARACTER_BUILD_COMMAND_TYPES.has(command.command_type)) return command
  const actorId = clean(command.actor_id)
  const actor = (state.players ?? []).find((candidate) => String(candidate.id) === actorId)
  if (!actor) throw new CharacterBuildValidationError('Герой не найден', 'ACTOR_NOT_FOUND')
  const allowed = new Set((context.allowedActorIds ?? []).map(String))
  if (context.isAdmin !== true && !allowed.has(actorId)) {
    throw new CharacterBuildValidationError('Изменять подготовку может только владелец героя', 'ACTOR_FORBIDDEN')
  }
  if (state.mechanics?.combat?.active) {
    throw new CharacterBuildValidationError('Нельзя менять развитие или подготовку героя во время боя', 'CHARACTER_BUILD_DURING_COMBAT')
  }

  if (command.command_type === 'SetCharacterChoices') {
    const subclass = clean(command.subclass, 160)
    // Написание навыка приводится к канону каталога сразу на входе: дальше
    // команда сверяется с `normalizedClassSkillProficiencies` буквально, и
    // дефисный `animal-handling` от старого клиента читался бы как выбор,
    // «недоступный для уровня героя», хотя это тот же самый навык.
    const classSkillProficiencies = [...new Set(uniqueIds(
      command.class_skill_proficiencies ?? command.classSkillProficiencies ?? [],
      'class_skill_proficiencies',
    ).map(catalogSkillId))]
    const selectedFeatureIds = uniqueIds(
      command.selected_feature_ids ?? command.selectedFeatureIds ?? [],
      'selected_feature_ids',
    )
    const candidate = {
      ...actor,
      subclass,
      classSkillProficiencies,
      selectedFeatureIds,
    }
    const canonicalSubclass = normalizedCombatSubclassFor(candidate) ?? ''
    const canonicalSkills = normalizedClassSkillProficiencies(candidate)
    const canonicalFeatures = normalizedSelectedFeatureIds(candidate)
    if ((subclass && canonicalSubclass !== subclass)
      || !sameIds(classSkillProficiencies, canonicalSkills)
      || !sameIds(selectedFeatureIds, canonicalFeatures)) {
      throw new CharacterBuildValidationError(
        'Выбор подкласса, навыков или классовых особенностей недоступен для уровня героя',
        'CHARACTER_CHOICE_NOT_ALLOWED',
      )
    }
    const featChoice = abilityScoreFeatFor(command, actor, state.ruleset_id)
    const abilityScores = featChoice ?? abilityScoreChoiceFor(command, actor)
    const safeCommand = { ...command }
    delete safeCommand.creation_benefits
    delete safeCommand.creation_skill_proficiencies
    delete safeCommand.creation_spell_grants
    delete safeCommand.level_feats
    if (!featChoice) delete safeCommand.ability_score_feat
    return {
      ...safeCommand,
      actor_id: actorId,
      target_id: actorId,
      target_ids: [actorId],
      subclass: canonicalSubclass,
      class_skill_proficiencies: canonicalSkills,
      selected_feature_ids: canonicalFeatures,
      ability_score_level: abilityScores.level,
      ability_score_increases: featChoice ? abilityScoreChoicesFor(actor) : abilityScores.all,
      abilities_after: abilityScores.abilities,
      ...(featChoice ? {
        ability_score_feat: featChoice.entry,
        level_feats: featChoice.all,
        creation_benefits: featChoice.creationBenefits,
        creation_skill_proficiencies: featChoice.creationSkillProficiencies,
        creation_spell_grants: featChoice.creationSpellGrants,
      } : { level_feats: levelFeatsFor(actor) }),
      visibility: 'party',
    }
  }

  const knownSpellIds = uniqueIds(command.known_spell_ids ?? command.knownSpellIds ?? [], 'known_spell_ids')
  const preparedSpellIds = uniqueIds(command.prepared_spell_ids ?? command.preparedSpellIds ?? [], 'prepared_spell_ids')
  const rules = spellSelectionRulesFor(actor)
  if (!rules && (knownSpellIds.length || preparedSpellIds.length)) {
    throw new CharacterBuildValidationError('У этого героя нет доступной системы заклинаний', 'SPELLCASTING_NOT_AVAILABLE')
  }
  const normalized = normalizedSpellSelectionsFor({
    ...actor,
    knownSpellIds,
    preparedSpellIds,
  })
  const canonicalKnown = normalized.knownSpellIds ?? []
  const canonicalPrepared = normalized.preparedSpellIds ?? []
  if (!sameIds(knownSpellIds, canonicalKnown) || !sameIds(preparedSpellIds, canonicalPrepared)) {
    throw new CharacterBuildValidationError(
      'Выбор содержит недоступное заклинание или превышает лимит класса и уровня',
      'SPELL_SELECTION_NOT_ALLOWED',
    )
  }
  return {
    ...command,
    actor_id: actorId,
    target_id: actorId,
    target_ids: [actorId],
    known_spell_ids: canonicalKnown,
    prepared_spell_ids: canonicalPrepared,
    visibility: 'party',
  }
}

export function characterBuildEvent(command) {
  if (command.command_type === 'SetCharacterChoices') {
    return {
      event_type: 'CharacterChoicesUpdated',
      payload: {
        schema_version: 2,
        subclass: command.subclass,
        class_skill_proficiencies: clone(command.class_skill_proficiencies),
        selected_feature_ids: clone(command.selected_feature_ids),
        ability_score_level: command.ability_score_level,
        ability_score_increases: clone(command.ability_score_increases),
        abilities_after: clone(command.abilities_after),
        ...(command.level_feats ? { level_feats: clone(command.level_feats) } : {}),
        ...(command.ability_score_feat ? { ability_score_feat: clone(command.ability_score_feat) } : {}),
        ...(command.creation_benefits ? { creation_benefits: clone(command.creation_benefits) } : {}),
        ...(command.creation_skill_proficiencies ? { creation_skill_proficiencies: clone(command.creation_skill_proficiencies) } : {}),
        ...(command.creation_spell_grants ? { creation_spell_grants: clone(command.creation_spell_grants) } : {}),
        request_fingerprint: clean(command.request_fingerprint, 128),
      },
      target_ids: [command.actor_id],
    }
  }
  if (command.command_type !== 'SetSpellSelections') return null
  return {
    event_type: 'SpellSelectionsUpdated',
    payload: {
      known_spell_ids: clone(command.known_spell_ids),
      prepared_spell_ids: clone(command.prepared_spell_ids),
      request_fingerprint: clean(command.request_fingerprint, 128),
    },
    target_ids: [command.actor_id],
  }
}
