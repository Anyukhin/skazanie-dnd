import { normalizedSpellSelectionsFor, spellSelectionRulesFor } from './combat-spells.mjs'
import { normalizedCombatSubclassFor } from './combat-actions.mjs'
import { normalizedClassSkillProficiencies, normalizedSelectedFeatureIds } from './character-progression.mjs'

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
    const classSkillProficiencies = uniqueIds(
      command.class_skill_proficiencies ?? command.classSkillProficiencies ?? [],
      'class_skill_proficiencies',
    )
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
    return {
      ...command,
      actor_id: actorId,
      target_id: actorId,
      target_ids: [actorId],
      subclass: canonicalSubclass,
      class_skill_proficiencies: canonicalSkills,
      selected_feature_ids: canonicalFeatures,
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
