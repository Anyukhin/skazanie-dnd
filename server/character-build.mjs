import { normalizedSpellSelectionsFor, spellSelectionRulesFor } from './combat-spells.mjs'
import { normalizedCombatSubclassFor } from './combat-actions.mjs'
import { abilityScoreChoiceLevelsFor, catalogSkillId, normalizedClassSkillProficiencies, normalizedSelectedFeatureIds } from './character-progression.mjs'

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
  if (rawLevel == null && rawChoices == null) return { level: null, choices: null, all: existing, abilities: clone(actor.abilities ?? {}) }
  const level = Number(rawLevel)
  if (!Number.isSafeInteger(level) || !abilityScoreChoiceLevelsFor(actor).includes(level) || level > Number(actor.level ?? 1)) {
    throw new CharacterBuildValidationError('Улучшение характеристик недоступно на этом уровне', 'ABILITY_SCORE_LEVEL_INVALID')
  }
  const choices = normalizeAbilityScoreChoices(rawChoices)
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
    const abilityScores = abilityScoreChoiceFor(command, actor)
    return {
      ...command,
      actor_id: actorId,
      target_id: actorId,
      target_ids: [actorId],
      subclass: canonicalSubclass,
      class_skill_proficiencies: canonicalSkills,
      selected_feature_ids: canonicalFeatures,
      ability_score_level: abilityScores.level,
      ability_score_increases: abilityScores.all,
      abilities_after: abilityScores.abilities,
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
        subclass: command.subclass,
        class_skill_proficiencies: clone(command.class_skill_proficiencies),
        selected_feature_ids: clone(command.selected_feature_ids),
        ability_score_level: command.ability_score_level,
        ability_score_increases: clone(command.ability_score_increases),
        abilities_after: clone(command.abilities_after),
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
