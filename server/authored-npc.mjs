import { canonicalCombatSpellFor } from './combat-spells.mjs'
import { legendaryProfileFor } from './legendary-actions.mjs'

export const AUTHORED_NPC_MECHANICS_STATUSES = Object.freeze(['verified', 'partial', 'ruling-only'])

const STATUS = new Set(AUTHORED_NPC_MECHANICS_STATUSES)
const ABILITIES = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha'])
const ABILITY_SET = new Set(ABILITIES)
const SKILLS = new Set([
  'acrobatics', 'animal_handling', 'arcana', 'athletics', 'deception', 'history',
  'insight', 'intimidation', 'investigation', 'medicine', 'nature', 'perception',
  'performance', 'persuasion', 'religion', 'sleight_of_hand', 'stealth', 'survival',
])
const CREATURE_TYPES = new Set([
  'aberration', 'beast', 'celestial', 'construct', 'dragon', 'elemental', 'fey',
  'fiend', 'giant', 'humanoid', 'monstrosity', 'ooze', 'plant', 'undead',
])
const SIZES = new Set(['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'])
const DAMAGE_TYPES = new Set([
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
])
const CONDITIONS = new Set([
  'blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled',
  'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone',
  'restrained', 'stunned', 'unconscious',
])
const ACTION_KINDS = new Set(['melee', 'ranged'])
const ENCOUNTER_DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'deadly'])
const EXECUTABLE_TRAITS = new Set([
  'aggressive', 'bloodied-frenzy', 'charge', 'keep-distance', 'martial-advantage',
  'multiattack', 'nimble-escape', 'pack-tactics', 'relentless-pursuit',
])
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,119}$/u
const DICE = /^\d{1,2}d\d{1,3}(?:[+-]\d{1,3})?$/u

export class AuthoredNpcValidationError extends Error {
  constructor(message, code = 'AUTHORED_NPC_INVALID') {
    super(message)
    this.name = 'AuthoredNpcValidationError'
    this.code = code
  }
}

const clone = (value) => structuredClone(value)
const clean = (value, maximum = 240) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthoredNpcValidationError(`${path} должен быть объектом`)
  }
  return value
}

function exactFields(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new AuthoredNpcValidationError(`${path} содержит неизвестные поля: ${unknown.join(', ')}`)
}

function identifier(value, path) {
  const result = clean(value, 120)
  if (!IDENTIFIER.test(result)) throw new AuthoredNpcValidationError(`${path} должен быть безопасным ASCII-идентификатором`)
  return result
}

function integer(value, path, minimum, maximum) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new AuthoredNpcValidationError(`${path} должен быть целым числом от ${minimum} до ${maximum}`)
  }
  return result
}

function enumValue(value, values, path) {
  const result = clean(value, 80)
  if (!values.has(result)) throw new AuthoredNpcValidationError(`${path} имеет недопустимое значение «${result}»`)
  return result
}

function uniqueEnums(value, values, path) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new AuthoredNpcValidationError(`${path} должен быть массивом`)
  return [...new Set(value.map((entry, index) => enumValue(entry, values, `${path}[${index}]`)))].slice(0, 20)
}

function assertUniqueIds(entries, path) {
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new AuthoredNpcValidationError(`${path} содержит повторяющийся id «${entry.id}»`)
    seen.add(entry.id)
  }
}

function bonusMap(value, allowed, path, { requireAll = false } = {}) {
  const source = record(value, path)
  exactFields(source, allowed, path)
  if (requireAll) {
    const missing = [...allowed].filter((key) => source[key] == null)
    if (missing.length) throw new AuthoredNpcValidationError(`${path} не содержит: ${missing.join(', ')}`)
  }
  return Object.fromEntries(Object.entries(source).map(([key, bonus]) => [key, integer(bonus, `${path}.${key}`, requireAll ? 1 : -20, requireAll ? 30 : 20)]))
}

function normalizeTrait(value, path) {
  const source = record(value, path)
  exactFields(source, new Set(['id', 'name', 'attacks', 'action_id', 'action_counts']), path)
  const traitId = identifier(source.id, `${path}.id`)
  if (!EXECUTABLE_TRAITS.has(traitId)) throw new AuthoredNpcValidationError(`${path}.id не исполняется планировщиком NPC`)
  const actionCounts = source.action_counts == null ? null : record(source.action_counts, `${path}.action_counts`)
  return {
    id: traitId,
    name: clean(source.name, 160) || traitId,
    ...(source.attacks == null ? {} : { attacks: integer(source.attacks, `${path}.attacks`, 1, 6) }),
    ...(source.action_id == null ? {} : { action_id: identifier(source.action_id, `${path}.action_id`) }),
    ...(actionCounts ? {
      action_counts: Object.fromEntries(Object.entries(actionCounts).map(([actionId, count]) => [
        identifier(actionId, `${path}.action_counts key`), integer(count, `${path}.action_counts.${actionId}`, 1, 6),
      ])),
    } : {}),
  }
}

function normalizeAction(value, path) {
  const source = record(value, path)
  exactFields(source, new Set([
    'id', 'name', 'kind', 'attack_modifier', 'damage_expression', 'damage_type',
    'range_feet', 'normal_range_feet', 'tactical_priority',
  ]), path)
  const damageExpression = clean(source.damage_expression, 40)
  if (!DICE.test(damageExpression)) throw new AuthoredNpcValidationError(`${path}.damage_expression имеет неподдерживаемую формулу`)
  const range = integer(source.range_feet, `${path}.range_feet`, 5, 600)
  const normalRange = source.normal_range_feet == null ? null : integer(source.normal_range_feet, `${path}.normal_range_feet`, 5, 600)
  if (normalRange != null && normalRange > range) throw new AuthoredNpcValidationError(`${path}.normal_range_feet больше предельной дальности`)
  return {
    id: identifier(source.id, `${path}.id`),
    name: clean(source.name, 160) || identifier(source.id, `${path}.id`),
    kind: enumValue(source.kind, ACTION_KINDS, `${path}.kind`),
    attack_modifier: integer(source.attack_modifier, `${path}.attack_modifier`, -10, 20),
    damage_expression: damageExpression,
    damage_type: enumValue(source.damage_type, DAMAGE_TYPES, `${path}.damage_type`),
    range_feet: range,
    ...(normalRange == null ? {} : { normal_range_feet: normalRange }),
    ...(source.tactical_priority == null ? {} : { tactical_priority: integer(source.tactical_priority, `${path}.tactical_priority`, 0, 20) }),
  }
}

function normalizeFeature(value, path) {
  const source = record(value, path)
  exactFields(source, new Set(['id', 'name', 'status', 'description']), path)
  const description = clean(source.description, 600)
  if (!description) throw new AuthoredNpcValidationError(`${path}.description должен быть непустым`)
  return {
    id: identifier(source.id, `${path}.id`),
    name: clean(source.name, 160) || identifier(source.id, `${path}.id`),
    status: enumValue(source.status, STATUS, `${path}.status`),
    description,
  }
}

function normalizeSpellcasting(value, path) {
  if (value == null) return null
  const source = record(value, path)
  exactFields(source, new Set(['ability', 'save_dc', 'attack_bonus', 'spells']), path)
  const rawSpells = Array.isArray(source.spells) ? source.spells : []
  if (!rawSpells.length || rawSpells.length > 20) throw new AuthoredNpcValidationError(`${path}.spells должен содержать от 1 до 20 записей`)
  const seen = new Set()
  const spells = rawSpells.map((raw, index) => {
    const spellPath = `${path}.spells[${index}]`
    const spell = record(raw, spellPath)
    exactFields(spell, new Set(['id', 'uses']), spellPath)
    const spellId = identifier(spell.id, `${spellPath}.id`)
    if (seen.has(spellId)) throw new AuthoredNpcValidationError(`${path}.spells содержит повтор «${spellId}»`)
    seen.add(spellId)
    const catalog = canonicalCombatSpellFor(spellId)
    if (!catalog || ['heuristic', 'ruling-only'].includes(String(catalog.mechanicsSupport))) {
      throw new AuthoredNpcValidationError(`${spellPath}.id не имеет исполнимой серверной механики`)
    }
    return { id: spellId, uses: spell.uses === 'at-will' ? 'at-will' : integer(spell.uses, `${spellPath}.uses`, 1, 9) }
  })
  return {
    ability: enumValue(source.ability, ABILITY_SET, `${path}.ability`),
    save_dc: integer(source.save_dc, `${path}.save_dc`, 5, 30),
    attack_bonus: integer(source.attack_bonus, `${path}.attack_bonus`, -10, 20),
    spells,
  }
}

function normalizeLegendary(value, path) {
  if (value == null) return null
  const source = record(value, path)
  exactFields(source, new Set(['uses', 'resistance', 'actions']), path)
  const rawActions = Array.isArray(source.actions) ? source.actions : []
  if (!rawActions.length || rawActions.length > 6) throw new AuthoredNpcValidationError(`${path}.actions должен содержать от 1 до 6 записей`)
  const actions = rawActions.map((raw, index) => {
    const actionPath = `${path}.actions[${index}]`
    const action = record(raw, actionPath)
    exactFields(action, new Set([
      'id', 'name', 'cost', 'kind', 'attack_modifier', 'damage_expression',
      'damage_type', 'range_feet', 'save_ability', 'save_dc', 'half_on_save',
      'condition', 'radius_feet',
    ]), actionPath)
    const kind = enumValue(action.kind, new Set(['attack', 'save']), `${actionPath}.kind`)
    const damageExpression = action.damage_expression == null ? null : clean(action.damage_expression, 40)
    if (damageExpression && !DICE.test(damageExpression)) throw new AuthoredNpcValidationError(`${actionPath}.damage_expression имеет неподдерживаемую формулу`)
    return {
      id: identifier(action.id, `${actionPath}.id`),
      name: clean(action.name, 160) || identifier(action.id, `${actionPath}.id`),
      cost: integer(action.cost, `${actionPath}.cost`, 1, 5),
      kind,
      ...(kind === 'attack' ? { attack_modifier: integer(action.attack_modifier, `${actionPath}.attack_modifier`, -10, 20) } : {}),
      ...(damageExpression ? { damage_expression: damageExpression } : {}),
      damage_type: enumValue(action.damage_type, DAMAGE_TYPES, `${actionPath}.damage_type`),
      range_feet: integer(action.range_feet, `${actionPath}.range_feet`, 5, 600),
      ...(kind === 'save' ? {
        save_ability: enumValue(action.save_ability, ABILITY_SET, `${actionPath}.save_ability`),
        save_dc: integer(action.save_dc, `${actionPath}.save_dc`, 5, 30),
        half_on_save: action.half_on_save === true,
        radius_feet: integer(action.radius_feet, `${actionPath}.radius_feet`, 0, 120),
        ...(action.condition == null ? {} : { condition: enumValue(action.condition, CONDITIONS, `${actionPath}.condition`) }),
      } : {}),
    }
  })
  assertUniqueIds(actions, `${path}.actions`)
  const legendary = {
    uses: integer(source.uses, `${path}.uses`, 1, 5),
    resistance: integer(source.resistance ?? 0, `${path}.resistance`, 0, 5),
    actions,
  }
  if (legendaryProfileFor({ legendary })?.actions.length !== actions.length) {
    throw new AuthoredNpcValidationError(`${path} не исполняется модулем легендарных действий`)
  }
  return legendary
}

export function normalizeAuthoredNpcMechanics(value, path = 'npc.mechanics') {
  const source = record(value, path)
  exactFields(source, new Set([
    'profile_id', 'status', 'level', 'challenge_rating', 'xp', 'encounter_difficulty', 'hp', 'armor', 'speed',
    'initiative_bonus', 'proficiency_bonus', 'size', 'creature_type', 'abilities',
    'skills', 'saving_throws', 'damage_vulnerabilities', 'damage_resistances',
    'damage_immunities', 'condition_immunities', 'traits', 'action_profiles',
    'spellcasting', 'legendary', 'features', 'tactics',
  ]), path)
  const challengeRating = clean(source.challenge_rating, 20)
  if (!/^\d{1,2}(?:\/\d{1,2})?$/u.test(challengeRating)) throw new AuthoredNpcValidationError(`${path}.challenge_rating имеет неверный формат`)
  const rawTraits = source.traits == null ? [] : source.traits
  const rawActions = Array.isArray(source.action_profiles) ? source.action_profiles : []
  const rawFeatures = Array.isArray(source.features) ? source.features : []
  const rawTactics = Array.isArray(source.tactics) ? source.tactics : []
  if (!Array.isArray(rawTraits) || rawTraits.length > 12) throw new AuthoredNpcValidationError(`${path}.traits должен быть массивом до 12 записей`)
  if (!rawActions.length || rawActions.length > 12) throw new AuthoredNpcValidationError(`${path}.action_profiles должен содержать от 1 до 12 записей`)
  if (!rawFeatures.length || rawFeatures.length > 12) throw new AuthoredNpcValidationError(`${path}.features должен содержать от 1 до 12 записей`)
  if (!rawTactics.length || rawTactics.length > 8) throw new AuthoredNpcValidationError(`${path}.tactics должен содержать от 1 до 8 строк`)
  const tactics = rawTactics.map((entry, index) => {
    const result = clean(entry, 320)
    if (!result) throw new AuthoredNpcValidationError(`${path}.tactics[${index}] должен быть непустым`)
    return result
  })
  const traits = rawTraits.map((entry, index) => normalizeTrait(entry, `${path}.traits[${index}]`))
  const actions = rawActions.map((entry, index) => normalizeAction(entry, `${path}.action_profiles[${index}]`))
  const features = rawFeatures.map((entry, index) => normalizeFeature(entry, `${path}.features[${index}]`))
  assertUniqueIds(traits, `${path}.traits`)
  assertUniqueIds(actions, `${path}.action_profiles`)
  assertUniqueIds(features, `${path}.features`)
  const actionIds = new Set(actions.map((entry) => entry.id))
  for (const trait of traits) {
    if (trait.action_id && !actionIds.has(trait.action_id)) throw new AuthoredNpcValidationError(`${path}.traits ссылается на неизвестное действие «${trait.action_id}»`)
    for (const actionId of Object.keys(trait.action_counts ?? {})) {
      if (!actionIds.has(actionId)) throw new AuthoredNpcValidationError(`${path}.traits ссылается на неизвестное действие «${actionId}»`)
    }
  }
  return {
    profile_id: identifier(source.profile_id, `${path}.profile_id`),
    status: enumValue(source.status, STATUS, `${path}.status`),
    level: integer(source.level, `${path}.level`, 1, 20),
    challenge_rating: challengeRating,
    xp: integer(source.xp, `${path}.xp`, 0, 100_000),
    encounter_difficulty: enumValue(source.encounter_difficulty, ENCOUNTER_DIFFICULTIES, `${path}.encounter_difficulty`),
    hp: integer(source.hp, `${path}.hp`, 1, 500),
    armor: integer(source.armor, `${path}.armor`, 5, 30),
    speed: integer(source.speed, `${path}.speed`, 0, 120),
    initiative_bonus: integer(source.initiative_bonus, `${path}.initiative_bonus`, -10, 20),
    proficiency_bonus: integer(source.proficiency_bonus, `${path}.proficiency_bonus`, 2, 9),
    size: enumValue(source.size, SIZES, `${path}.size`),
    creature_type: enumValue(source.creature_type, CREATURE_TYPES, `${path}.creature_type`),
    abilities: bonusMap(source.abilities, ABILITY_SET, `${path}.abilities`, { requireAll: true }),
    skills: bonusMap(source.skills, SKILLS, `${path}.skills`),
    saving_throws: bonusMap(source.saving_throws, ABILITY_SET, `${path}.saving_throws`),
    damage_vulnerabilities: uniqueEnums(source.damage_vulnerabilities, DAMAGE_TYPES, `${path}.damage_vulnerabilities`),
    damage_resistances: uniqueEnums(source.damage_resistances, DAMAGE_TYPES, `${path}.damage_resistances`),
    damage_immunities: uniqueEnums(source.damage_immunities, DAMAGE_TYPES, `${path}.damage_immunities`),
    condition_immunities: uniqueEnums(source.condition_immunities, CONDITIONS, `${path}.condition_immunities`),
    traits,
    action_profiles: actions,
    ...(source.spellcasting == null ? {} : { spellcasting: normalizeSpellcasting(source.spellcasting, `${path}.spellcasting`) }),
    ...(source.legendary == null ? {} : { legendary: normalizeLegendary(source.legendary, `${path}.legendary`) }),
    features,
    tactics,
  }
}

export function safeAuthoredNpcMechanics(value) {
  try {
    return value == null ? null : clone(normalizeAuthoredNpcMechanics(value))
  } catch {
    return null
  }
}

export function authoredNpcCombatant({ npc, mechanics: rawMechanics, position } = {}) {
  const mechanics = normalizeAuthoredNpcMechanics(rawMechanics)
  const npcId = identifier(npc?.id, 'npc.id')
  const name = clean(npc?.name, 160)
  if (!name) throw new AuthoredNpcValidationError('npc.name должен быть непустым')
  const x = integer(position?.x, 'position.x', 0, 10_000)
  const y = integer(position?.y, 'position.y', 0, 10_000)
  const primary = mechanics.action_profiles[0]
  const die = Number(/d(\d+)/u.exec(primary.damage_expression)?.[1]) || 6
  const flat = Number(/[+-](\d+)$/u.exec(primary.damage_expression)?.[1]) || 0
  return {
    id: npcId,
    name,
    hp: mechanics.hp,
    maxHp: mechanics.hp,
    armor: mechanics.armor,
    speed: mechanics.speed,
    level: mechanics.level,
    initiativeBonus: mechanics.initiative_bonus,
    proficiency: mechanics.proficiency_bonus,
    attackBonus: primary.attack_modifier,
    damageDice: die,
    damageBonus: flat,
    abilities: clone(mechanics.abilities),
    skillModifiers: clone(mechanics.skills),
    savingThrowModifiers: clone(mechanics.saving_throws),
    creature_type: mechanics.creature_type,
    size: mechanics.size,
    damage_vulnerabilities: clone(mechanics.damage_vulnerabilities),
    damage_resistances: clone(mechanics.damage_resistances),
    damage_immunities: clone(mechanics.damage_immunities),
    condition_immunities: clone(mechanics.condition_immunities),
    traits: clone(mechanics.traits),
    action_profiles: clone(mechanics.action_profiles),
    attack_profile: clone(primary),
    ...(mechanics.spellcasting ? { spellcasting: clone(mechanics.spellcasting) } : {}),
    ...(mechanics.legendary ? { legendary: clone(mechanics.legendary) } : {}),
    authored_features: clone(mechanics.features),
    authored_tactics: clone(mechanics.tactics),
    x,
    y,
    alive: true,
    stat_block_id: mechanics.profile_id,
    loadout: [],
    origin: { kind: 'authored-npc', npc_id: npcId, profile_id: mechanics.profile_id },
    provenance: {
      kind: 'server-owned-authored-npc-profile',
      ruleset_id: 'authored',
      source_version: '1.0.0',
      challenge_rating: mechanics.challenge_rating,
      xp: mechanics.xp,
    },
  }
}
