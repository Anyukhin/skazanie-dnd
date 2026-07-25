import { RULE_IDS, abilityModifier, findActor } from './rules-engine.mjs'

export const DIFFICULTY_CLASSES = Object.freeze({ easy: 10, medium: 15, hard: 20 })
export const DIFFICULTY_CATEGORIES = Object.freeze(Object.keys(DIFFICULTY_CLASSES))

function retrievedIds(retrievedRules, fallbacks = []) {
  const ids = Array.isArray(retrievedRules?.results)
    ? retrievedRules.results.map((result) => result.rule_id).filter(Boolean)
    : []
  return [...new Set([...ids.slice(0, 5), ...fallbacks])]
}

function attackProfile(actor) {
  const strength = abilityModifier(actor?.abilities?.str)
  const equipped = Array.isArray(actor?.inventory) ? actor.inventory.find((item) => item.equipped && item.type === 'weapon') : null
  const expression = /\b(\d{1,2}d\d{1,3}(?:\s*[+-]\s*\d{1,2})?)/i.exec(String(equipped?.properties ?? ''))?.[1]?.replace(/\s+/g, '')
  return {
    attack_modifier: strength + (Number(actor?.proficiency) || 0),
    damage_expression: expression || `1d6${strength > 0 ? `+${strength}` : strength < 0 ? strength : ''}`,
    damage_type: 'slashing',
  }
}

function abilityForApproach(approach) {
  return ({ strength: 'str', stealth: 'dex', arcana: 'int', perception: 'wis', persuasion: 'cha', intimidation: 'cha' })[approach] ?? 'wis'
}

function difficultyCategoryFromValue(value) {
  const difficulty = Number(value)
  if (!Number.isFinite(difficulty)) return null
  if (difficulty <= DIFFICULTY_CLASSES.easy) return 'easy'
  if (difficulty <= DIFFICULTY_CLASSES.medium) return 'medium'
  return 'hard'
}

export function difficultyCategoryFor(intent, state = {}) {
  const requested = String(intent?.difficulty_category ?? intent?.difficultyCategory ?? '').trim().toLowerCase()
  if (DIFFICULTY_CATEGORIES.includes(requested)) return requested
  const activeHazard = state.mechanics?.hazards?.[intent?.actor_id]?.[0]
  const hazardCategory = difficultyCategoryFromValue(activeHazard?.escapeDifficulty)
  if (hazardCategory) return hazardCategory
  return /(бурн|шторм|rough water|тон\w*|удуш|suffocat|drown)/iu.test(intent?.raw_message ?? '') ? 'hard' : 'medium'
}

export function difficultyClassFor(category) {
  return DIFFICULTY_CLASSES[DIFFICULTY_CATEGORIES.includes(category) ? category : 'medium']
}

export class Adjudicator {
  async createPlan({ intent, state, retrievedRules }) {
    const ruleIds = retrievedIds(retrievedRules)
    const base = {
      rule_ids: ruleIds,
      proposed_commands: [],
      roll_requests: [],
      ruling_required: false,
      ruling_draft: null,
      narration_constraints: ['Не добавлять механические последствия сверх подтверждённых событий'],
      confidence: Math.min(Number(intent?.confidence) || 0, Number(retrievedRules?.confidence ?? 1)),
    }
    if (intent?.requires_clarification) return { ...base, clarification_required: true, missing_information: intent.missing_information }
    const actor = findActor(state, intent?.actor_id)
    switch (intent?.intent) {
      case 'attack': {
        const targetId = intent.targets?.[0]
        return {
          ...base,
          rule_ids: retrievedIds(retrievedRules, [RULE_IDS.attack, RULE_IDS.damage]),
          proposed_commands: [{ command_type: 'MakeAttack', actor_id: intent.actor_id, target_id: targetId, ...attackProfile(actor), source_rule_ids: retrievedIds(retrievedRules, [RULE_IDS.attack, RULE_IDS.damage]) }],
          roll_requests: [{ expression: '1d20', purpose: 'attack', actor_id: intent.actor_id }],
          confidence: 0.82,
        }
      }
      case 'ability_check': {
        const difficulty_category = difficultyCategoryFor(intent, state)
        const difficulty = difficultyClassFor(difficulty_category)
        const ability = abilityForApproach(intent.approach)
        return {
          ...base,
          rule_ids: retrievedIds(retrievedRules, [RULE_IDS.abilityCheck]),
          proposed_commands: [{ command_type: 'MakeAbilityCheck', actor_id: intent.actor_id, ability, proficient: false, difficulty, difficulty_category, source_rule_ids: retrievedIds(retrievedRules, [RULE_IDS.abilityCheck]) }],
          roll_requests: [{ expression: '1d20', purpose: `ability_check:${ability}`, actor_id: intent.actor_id }],
          confidence: 0.74,
        }
      }
      case 'saving_throw': {
        const difficulty_category = difficultyCategoryFor(intent, state)
        return {
          ...base,
          rule_ids: retrievedIds(retrievedRules, [RULE_IDS.savingThrow]),
          proposed_commands: [{ command_type: 'MakeSavingThrow', actor_id: intent.actor_id, ability: abilityForApproach(intent.approach), difficulty: difficultyClassFor(difficulty_category), difficulty_category, source_rule_ids: retrievedIds(retrievedRules, [RULE_IDS.savingThrow]) }],
          roll_requests: [{ expression: '1d20', purpose: 'saving_throw', actor_id: intent.actor_id }],
          confidence: 0.72,
        }
      }
      case 'healing':
        // Свободный текст не доказывает источник лечения или расход ресурса.
        // До появления подтверждённого предмета/заклинания это остаётся ruling.
        break
      case 'end_turn':
        return { ...base, rule_ids: [RULE_IDS.turns], proposed_commands: [{ command_type: 'EndTurn', actor_id: intent.actor_id, source_rule_ids: [RULE_IDS.turns] }], confidence: 0.95 }
      case 'start_combat': {
        const participantIds = [...(state.players ?? []), ...(state.actors ?? [])].map((item) => String(item.id)).filter(Boolean)
        return { ...base, rule_ids: [RULE_IDS.initiative], proposed_commands: [{ command_type: 'StartCombat', actor_id: intent.actor_id, participant_ids: participantIds, source_rule_ids: [RULE_IDS.initiative] }], roll_requests: participantIds.map((actor_id) => ({ expression: '1d20', purpose: 'initiative', actor_id })), confidence: 0.8 }
      }
      case 'end_combat':
        return { ...base, rule_ids: [RULE_IDS.initiative, RULE_IDS.turns], proposed_commands: [{ command_type: 'EndCombat', actor_id: intent.actor_id, source_rule_ids: [RULE_IDS.initiative, RULE_IDS.turns] }], confidence: 0.9 }
      case 'rest':
      {
        const kind = /долг|продолж|long/iu.test(intent.raw_message) ? 'long' : 'short'
        const minutes = kind === 'long' ? 480 : 60
        return {
          ...base,
          rule_ids: [RULE_IDS.resource],
          proposed_commands: [
            { command_type: 'StartRest', actor_id: intent.actor_id, kind, source_rule_ids: [RULE_IDS.resource] },
            { command_type: 'AdvanceTime', amount: minutes, unit: 'minute', source_rule_ids: [RULE_IDS.resource] },
            { command_type: 'CompleteRest', actor_id: intent.actor_id, kind, source_rule_ids: [RULE_IDS.resource] },
          ],
          confidence: 0.9,
        }
      }
      default:
        break
    }
    return {
      ...base,
      ruling_required: true,
      ruling_draft: {
        question: intent?.raw_message ?? '',
        selected_interpretation: 'Разрешить как временное решение ведущего без автоматического изменения механического состояния.',
        rationale: retrievedRules?.confidence < 0.45 ? 'Низкая уверенность поиска правил.' : 'Механика ещё не формализована.',
        supporting_rule_ids: ruleIds,
        scope: 'single_event',
        approved_by_owner: false,
        world_change: false,
        overrides_rule_ids: [],
      },
      narration_constraints: [...base.narration_constraints, 'no-unconfirmed-world-changes'],
      confidence: Math.min(base.confidence, 0.5),
    }
  }
}
