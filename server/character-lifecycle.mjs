import { readFileSync } from 'node:fs'

import {
  classBuildCatalogInfo,
  classSkillRuleFor,
  characterClassKey,
  featureChoiceGroupsFor,
  normalizedClassSkillProficiencies,
  normalizedSelectedFeatureIds,
  skillAbility,
} from './character-progression.mjs'
import {
  combatClassCatalogInfo,
  combatResourceMaximumsFor,
  combatResourceRecoveryFor,
  normalizedCombatSubclassFor,
} from './combat-actions.mjs'
import {
  combatSpellsFor,
  normalizedSpellSelectionsFor,
  spellSelectionRulesFor,
  spellSlotMaximumsFor,
} from './combat-spells.mjs'
import { ITEM_ARMOR_PROFILES } from './item-catalog.mjs'
import { activeItemEffectTotals } from './item-lifecycle.mjs'
import { withStarterKit } from './starter-kit.mjs'

/**
 * Standalone character domain contract.
 *
 * This module deliberately does not import the Rules Engine.  An adapter can
 * validate `LevelUp`, persist `CharacterLeveledUp`, and pass the event through
 * `applyCharacterLifecycleEvent` without giving a browser authority over HP,
 * AC, speed, proficiency, or class resources.
 */
export const CHARACTER_LIFECYCLE_SCHEMA_VERSION = 1
export const CHARACTER_IMPORT_SCHEMA = 'skazanie.character'
export const CHARACTER_IMPORT_SCHEMA_VERSION = 1
export const CHARACTER_LIFECYCLE_COMMAND_TYPES = new Set(['LevelUp', 'ImportCharacter'])
export const CHARACTER_LIFECYCLE_EVENT_TYPES = new Set(['CharacterLeveledUp', 'CharacterImported'])

export const ABILITY_IDS = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha'])
export const SKILL_IDS = Object.freeze([
  'acrobatics', 'animal_handling', 'arcana', 'athletics', 'deception', 'history',
  'insight', 'intimidation', 'investigation', 'medicine', 'nature', 'perception',
  'performance', 'persuasion', 'religion', 'sleight_of_hand', 'stealth', 'survival',
])

const characterCreationPolicy = JSON.parse(readFileSync(
  new URL('../data/character-creation-policy-v1.json', import.meta.url),
  'utf8',
))
const originBonusProfiles = new Map(characterCreationPolicy.origin_bonus_profiles.map((profile) => [profile.id, profile]))
const speciesOptions = new Map(characterCreationPolicy.species_options.map((option) => [option.id, option]))

/** Official 2014/SRD experience thresholds, intentionally capped to the
 * level-12 range that the bundled class catalog can execute. */
export const EXPERIENCE_THRESHOLDS = Object.freeze({
  1: 0,
  2: 300,
  3: 900,
  4: 2_700,
  5: 6_500,
  6: 14_000,
  7: 23_000,
  8: 34_000,
  9: 48_000,
  10: 64_000,
  11: 85_000,
  12: 100_000,
})

export const DERIVED_CHARACTER_POLICY = Object.freeze({
  maximumLevel: 12,
  proficiency: '2 + floor((level - 1) / 4)',
  hitPoints: 'level 1 uses the maximum hit die; later levels use a recorded dN roll or the fixed average, then add CON with a minimum of 1 per level',
  armorClass: 'only equipped items resolved through a server-owned armor profile affect AC; otherwise the class unarmored rule applies',
  speed: 'base_speed minus server-owned equipped armor penalties; the browser-supplied speed field is ignored',
  imports: 'v1 excludes id, current/max HP, AC, proficiency, inventory, currency, resources, and all derived fields',
})

const MAX_LEVEL = 12
const MAX_EXPERIENCE = 2_000_000_000
const DEFAULT_BASE_SPEED = 30
const DEFAULT_ARMOR_PROFILES = ITEM_ARMOR_PROFILES
const HIT_DICE = Object.freeze({
  barbarian: 12,
  bard: 8,
  cleric: 8,
  druid: 8,
  fighter: 10,
  monk: 8,
  paladin: 10,
  ranger: 10,
  rogue: 8,
  sorcerer: 6,
  warlock: 8,
  wizard: 6,
})
const SAVING_THROW_PROFICIENCIES = Object.freeze({
  barbarian: ['str', 'con'],
  bard: ['dex', 'cha'],
  cleric: ['wis', 'cha'],
  druid: ['int', 'wis'],
  fighter: ['str', 'con'],
  monk: ['str', 'dex'],
  paladin: ['wis', 'cha'],
  ranger: ['str', 'dex'],
  rogue: ['dex', 'int'],
  sorcerer: ['con', 'cha'],
  warlock: ['wis', 'cha'],
  wizard: ['int', 'wis'],
})

const clone = (value) => structuredClone(value)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)

export class CharacterLifecycleValidationError extends Error {
  constructor(message, code = 'CHARACTER_LIFECYCLE_INVALID') {
    super(message)
    this.name = 'CharacterLifecycleValidationError'
    this.code = code
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value, maximum = 160, fallback = '') {
  return String(value ?? fallback).normalize('NFKC').trim().slice(0, maximum)
}

function cleanIdentifier(value, field) {
  const result = cleanText(value, 120)
  // Серверный каталог навыков хранит snake_case (`sleight_of_hand`,
  // `animal_handling`), поэтому подчёркивание — часть допустимого алфавита.
  // Без него импорт листа падал на любом герое, взявшем такой навык.
  if (!result || !/^[a-z0-9][a-z0-9_-]{0,119}$/u.test(result)) {
    throw new CharacterLifecycleValidationError(`${field} должен быть непустым идентификатором`, 'INVALID_IDENTIFIER')
  }
  return result
}

function integer(value, field, { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const candidate = value == null && fallback !== undefined ? fallback : value
  const result = Number(candidate)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new CharacterLifecycleValidationError(`${field} должен быть целым числом от ${minimum} до ${maximum}`, 'INVALID_CHARACTER_VALUE')
  }
  return result
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((entry) => right.includes(entry))
}

function exactKeys(record, allowed, label) {
  if (!isRecord(record)) throw new CharacterLifecycleValidationError(`${label} должен быть объектом`, 'IMPORT_INVALID_SHAPE')
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key))
  if (unexpected.length) {
    throw new CharacterLifecycleValidationError(`${label} содержит неподдерживаемые поля: ${unexpected.join(', ')}`, 'IMPORT_UNKNOWN_FIELD')
  }
}

function uniqueIdentifiers(value, field, { maximum = 100 } = {}) {
  if (!Array.isArray(value)) throw new CharacterLifecycleValidationError(`${field} должен быть массивом`, 'IMPORT_INVALID_FIELD')
  if (value.length > maximum) throw new CharacterLifecycleValidationError(`${field} превышает лимит ${maximum}`, 'IMPORT_LIMIT_EXCEEDED')
  const result = value.map((entry) => cleanIdentifier(entry, field))
  if (new Set(result).size !== result.length) throw new CharacterLifecycleValidationError(`${field} содержит повторяющиеся значения`, 'IMPORT_DUPLICATE_VALUE')
  return result
}

function normalizedLevel(value) {
  return integer(value, 'level', { minimum: 1, maximum: MAX_LEVEL, fallback: 1 })
}

export function abilityModifier(score) {
  return Math.floor((integer(score, 'ability score', { minimum: 1, maximum: 30, fallback: 10 }) - 10) / 2)
}

export function proficiencyBonusForLevel(level) {
  return 2 + Math.floor((normalizedLevel(level) - 1) / 4)
}

export function experienceForLevel(level) {
  return EXPERIENCE_THRESHOLDS[normalizedLevel(level)]
}

export function levelForExperience(experience) {
  const xp = integer(experience, 'experience', { minimum: 0, maximum: MAX_EXPERIENCE, fallback: 0 })
  return [...Object.keys(EXPERIENCE_THRESHOLDS)].map(Number).sort((left, right) => right - left)
    .find((level) => xp >= EXPERIENCE_THRESHOLDS[level]) ?? 1
}

export function hitDieFor(actor) {
  return HIT_DICE[characterClassKey(actor)] ?? 8
}

export function savingThrowProficienciesFor(actor) {
  return [...(SAVING_THROW_PROFICIENCIES[characterClassKey(actor)] ?? [])]
}

export function normalizedAbilityScores(input) {
  if (input != null && !isRecord(input)) throw new CharacterLifecycleValidationError('abilities должен быть объектом', 'INVALID_ABILITIES')
  if (input != null) exactKeys(input, ABILITY_IDS, 'abilities')
  return Object.fromEntries(ABILITY_IDS.map((ability) => [ability, integer(input?.[ability], `abilities.${ability}`, {
    minimum: 1, maximum: 30, fallback: 10,
  })]))
}

const ABILITY_GENERATION_FIELDS = Object.freeze([
  'policyId', 'policyVersion', 'method', 'baseScores', 'originBonusProfileId', 'originBonuses', 'speciesOptionId',
])

function abilityScoreMap(input, field, { minimum, maximum }) {
  if (!isRecord(input)) {
    throw new CharacterLifecycleValidationError(`${field} должен быть объектом`, 'IMPORT_ABILITY_BUDGET_INVALID')
  }
  exactKeys(input, ABILITY_IDS, field)
  return Object.fromEntries(ABILITY_IDS.map((ability) => [ability, integer(input[ability], `${field}.${ability}`, {
    minimum,
    maximum,
  })]))
}

function validateAbilityGeneration(source, abilities, { allowLegacyAbilityPolicy = false } = {}) {
  if (!isRecord(source)) {
    if (allowLegacyAbilityPolicy) return null
    throw new CharacterLifecycleValidationError(
      'Импорт должен явно указывать versioned policy генерации характеристик',
      'IMPORT_ABILITY_POLICY_REQUIRED',
    )
  }
  exactKeys(source, ABILITY_GENERATION_FIELDS, 'character.abilityGeneration')
  if (source.policyId !== characterCreationPolicy.policy_id
    || Number(source.policyVersion) !== characterCreationPolicy.policy_version
    || source.method !== characterCreationPolicy.method) {
    throw new CharacterLifecycleValidationError(
      'Импорт использует неподдерживаемую policy генерации характеристик',
      'IMPORT_ABILITY_POLICY_UNSUPPORTED',
    )
  }
  const baseScores = abilityScoreMap(source.baseScores, 'character.abilityGeneration.baseScores', { minimum: 1, maximum: 30 })
  const expectedArray = [...characterCreationPolicy.standard_array].sort((left, right) => left - right)
  const actualArray = Object.values(baseScores).sort((left, right) => left - right)
  if (JSON.stringify(actualArray) !== JSON.stringify(expectedArray)) {
    throw new CharacterLifecycleValidationError(
      `Базовые характеристики должны быть распределением стандартного массива ${characterCreationPolicy.standard_array.join(', ')}`,
      'IMPORT_ABILITY_BUDGET_INVALID',
    )
  }
  const bonusProfile = originBonusProfiles.get(String(source.originBonusProfileId ?? ''))
  if (!bonusProfile) {
    throw new CharacterLifecycleValidationError(
      'Неизвестный профиль бонусов происхождения',
      'IMPORT_ABILITY_POLICY_UNSUPPORTED',
    )
  }
  const originBonuses = abilityScoreMap(source.originBonuses, 'character.abilityGeneration.originBonuses', { minimum: 0, maximum: 10 })
  const expectedBonuses = [...bonusProfile.bonuses].sort((left, right) => left - right)
  const actualBonuses = Object.values(originBonuses).filter((value) => value !== 0).sort((left, right) => left - right)
  if (JSON.stringify(actualBonuses) !== JSON.stringify(expectedBonuses)) {
    throw new CharacterLifecycleValidationError(
      'Бонусы происхождения не соответствуют выбранному серверному профилю',
      'IMPORT_ABILITY_BUDGET_INVALID',
    )
  }
  const speciesOption = speciesOptions.get(String(source.speciesOptionId ?? ''))
  if (!speciesOption) {
    throw new CharacterLifecycleValidationError('Выбран неподдерживаемый вид персонажа', 'IMPORT_SPECIES_UNSUPPORTED')
  }
  const expectedScores = Object.fromEntries(ABILITY_IDS.map((ability) => [ability, baseScores[ability] + originBonuses[ability]]))
  if (ABILITY_IDS.some((ability) => abilities[ability] !== expectedScores[ability])) {
    throw new CharacterLifecycleValidationError(
      'Итоговые характеристики не совпадают с базовым массивом и явными бонусами происхождения',
      'IMPORT_ABILITY_BUDGET_INVALID',
    )
  }
  return {
    policyId: characterCreationPolicy.policy_id,
    policyVersion: characterCreationPolicy.policy_version,
    method: characterCreationPolicy.method,
    baseScores,
    originBonusProfileId: bonusProfile.id,
    originBonuses,
    speciesOptionId: speciesOption.id,
  }
}

export function characterCreationCatalog() {
  const classBuild = classBuildCatalogInfo()
  const classCombat = combatClassCatalogInfo()
  const skillsById = new Map(classBuild.skills.map((skill) => [skill.id, skill]))
  return {
    schema_version: 1,
    import_schema: CHARACTER_IMPORT_SCHEMA,
    import_schema_version: CHARACTER_IMPORT_SCHEMA_VERSION,
    ability_policy: clone(characterCreationPolicy),
    classes: classCombat.classes.map((classOption) => {
      const actor = {
        characterClass: classOption.classKey,
        level: 1,
        abilities: Object.fromEntries(ABILITY_IDS.map((ability, index) => [ability, characterCreationPolicy.standard_array[index]])),
      }
      const skillRule = classSkillRuleFor(actor)
      const spellRules = spellSelectionRulesFor(actor)
      const availableSpells = spellRules ? combatSpellsFor(actor).filter((spell) => spell.level <= 1) : []
      return {
        id: classOption.classKey,
        label: classOption.label,
        source_url: classOption.sourceUrl,
        subclass_level: classOption.subclassLevel,
        subclasses: classOption.subclassOptions,
        class_skills: skillRule ? {
          choice_count: skillRule.choiceCount,
          options: skillRule.skills.map((id) => clone(skillsById.get(id))).filter(Boolean),
        } : null,
        feature_choice_groups: featureChoiceGroupsFor(actor),
        spell_selection: spellRules ? {
          ...spellRules,
          spellcastingAbility: availableSpells[0]?.spellcastingAbility ?? null,
          spells: availableSpells
            .map((spell) => ({
              id: spell.id,
              name: spell.name,
              level: spell.level,
              description: spell.description,
              casting_time: spell.castingTime,
              range_text: spell.rangeText,
              mechanics_support: spell.mechanicsSupport,
            })),
        } : null,
      }
    }),
  }
}

export function createCharacterSlot({ id, index = 0 } = {}) {
  const slotId = cleanIdentifier(id ?? `hero-slot-${index + 1}`, 'character slot id')
  const baseScores = Object.fromEntries(ABILITY_IDS.map((ability, abilityIndex) => [
    ability,
    characterCreationPolicy.standard_array[abilityIndex],
  ]))
  return {
    id: slotId,
    name: 'Ожидает игрока',
    character: `Место героя ${index + 1}`,
    role: 'Герой ещё не создан · ур. 1',
    characterClass: 'fighter',
    level: 1,
    experience: 0,
    abilities: baseScores,
    baseSpeed: 30,
    classSkillProficiencies: [],
    selectedFeatureIds: [],
    knownSpellIds: [],
    preparedSpellIds: [],
    hitPointIncreases: [],
    species: 'Не выбран',
    background: 'Не выбрано',
    alignment: 'Не определено',
    traits: '',
    ideals: '',
    bonds: '',
    flaws: '',
    backstory: '',
    features: '',
    notes: '',
    inventory: [],
    currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
    color: ['#d79b5b', '#758f78', '#8b789e', '#9a745d'][index % 4],
    initials: String(index + 1),
    portrait: '/assets/party-portraits.png',
    portraitPosition: ['0% 0%', '100% 0%', '0% 100%', '100% 100%'][index % 4],
    online: false,
    characterSetupRequired: true,
  }
}

function normalizedBaseSpeed(actor) {
  return integer(actor?.baseSpeed ?? actor?.base_speed, 'base_speed', {
    minimum: 5, maximum: 120, fallback: DEFAULT_BASE_SPEED,
  })
}

function fixedHitPointIncrease(hitDie) {
  return Math.floor(hitDie / 2) + 1
}

export function normalizedHitPointIncreases(actor, { level = normalizedLevel(actor?.level), hitDie = hitDieFor(actor) } = {}) {
  const raw = actor?.hitPointIncreases ?? actor?.hit_point_increases ?? []
  if (!Array.isArray(raw)) throw new CharacterLifecycleValidationError('hit_point_increases должен быть массивом', 'INVALID_HIT_POINT_HISTORY')
  if (raw.length > Math.max(0, level - 1)) {
    throw new CharacterLifecycleValidationError('hit_point_increases содержит больше уровней, чем герой уже получил', 'INVALID_HIT_POINT_HISTORY')
  }
  return raw.map((entry, index) => integer(entry, `hit_point_increases.${index}`, { minimum: 1, maximum: hitDie }))
}

export function deriveMaximumHitPoints(actor, { level = normalizedLevel(actor?.level), abilities = normalizedAbilityScores(actor?.abilities) } = {}) {
  const hitDie = hitDieFor(actor)
  const constitutionModifier = abilityModifier(abilities.con)
  const increases = normalizedHitPointIncreases(actor, { level, hitDie })
  const perLevel = Array.from({ length: Math.max(0, level - 1) }, (_, index) => increases[index] ?? fixedHitPointIncrease(hitDie))
  const firstLevel = Math.max(1, hitDie + constitutionModifier)
  const laterLevels = perLevel.map((increase) => Math.max(1, increase + constitutionModifier))
  return {
    value: firstLevel + laterLevels.reduce((sum, entry) => sum + entry, 0),
    hitDie,
    constitutionModifier,
    levelOne: firstLevel,
    increases: perLevel,
    policy: increases.length === level - 1 ? 'recorded_rolls' : 'fixed_average_for_missing_levels',
  }
}

function normalizedArmorProfiles(input) {
  if (input == null) return DEFAULT_ARMOR_PROFILES
  if (!isRecord(input)) throw new CharacterLifecycleValidationError('armorProfiles должен быть объектом', 'INVALID_ARMOR_PROFILES')
  return input
}

function equippedArmorEntries(actor, armorProfiles) {
  const items = Array.isArray(actor?.inventory) ? actor.inventory : []
  return items.flatMap((item) => {
    if (!isRecord(item) || item.equipped !== true) return []
    const catalogId = cleanText(item.catalog_id ?? item.catalogId, 120)
    const profile = catalogId ? armorProfiles[catalogId] : null
    if (!isRecord(profile)) return []
    return [{ catalogId, profile }]
  })
}

export function deriveArmorClass(actor, { abilities = normalizedAbilityScores(actor?.abilities), armorProfiles } = {}) {
  const profiles = normalizedArmorProfiles(armorProfiles)
  const classKey = characterClassKey(actor)
  const dexterityModifier = abilityModifier(abilities.dex)
  const unarmoredBase = classKey === 'barbarian'
    ? 10 + dexterityModifier + abilityModifier(abilities.con)
    : classKey === 'monk'
      ? 10 + dexterityModifier + abilityModifier(abilities.wis)
      : 10 + dexterityModifier
  const equipped = equippedArmorEntries(actor, profiles)
  const bodyArmor = equipped.filter((entry) => entry.profile.kind === 'armor')
    .map((entry) => ({
      ...entry,
      base: integer(entry.profile.armorClassBase, `armor profile ${entry.catalogId}.armorClassBase`, { minimum: 1, maximum: 30 }),
      dexterityCap: entry.profile.dexterityCap == null ? null : integer(entry.profile.dexterityCap, `armor profile ${entry.catalogId}.dexterityCap`, { minimum: -5, maximum: 10 }),
    }))
    .sort((left, right) => right.base - left.base || left.catalogId.localeCompare(right.catalogId))[0] ?? null
  const shields = equipped.filter((entry) => entry.profile.kind === 'shield')
    .sort((left, right) => left.catalogId.localeCompare(right.catalogId)).slice(0, 1)
  const armorDexterity = bodyArmor ? Math.min(dexterityModifier, bodyArmor.dexterityCap ?? dexterityModifier) : 0
  const shieldBonus = shields.reduce((sum, entry) => sum + integer(entry.profile.armorClassBonus, `armor profile ${entry.catalogId}.armorClassBonus`, { minimum: 0, maximum: 10 }), 0)
  const itemEffectBonus = activeItemEffectTotals(actor).armor_class_bonus
  return {
    value: (bodyArmor ? bodyArmor.base + armorDexterity : unarmoredBase) + shieldBonus + itemEffectBonus,
    base: bodyArmor ? bodyArmor.base : unarmoredBase,
    dexterityModifier: bodyArmor ? armorDexterity : dexterityModifier,
    shieldBonus,
    item_effect_bonus: itemEffectBonus,
    source: bodyArmor ? 'equipped_server_profile' : classKey === 'barbarian' || classKey === 'monk' ? 'class_unarmored_defense' : 'unarmored',
    armorCatalogId: bodyArmor?.catalogId ?? null,
    shieldCatalogIds: shields.map((entry) => entry.catalogId),
  }
}

export function deriveSpeed(actor, { armorProfiles } = {}) {
  const profiles = normalizedArmorProfiles(armorProfiles)
  const base = normalizedBaseSpeed(actor)
  const penalties = equippedArmorEntries(actor, profiles)
    .map((entry) => Math.max(0, Number(entry.profile.speedPenalty) || 0))
  const penalty = Math.max(0, ...penalties, 0)
  return { base, penalty, value: Math.max(0, base - penalty) }
}

function canonicalCharacterChoices(actor) {
  const candidate = { ...actor }
  const subclass = normalizedCombatSubclassFor(candidate)
  if (own(candidate, 'subclass')) candidate.subclass = subclass ?? undefined
  if (own(candidate, 'classSkillProficiencies')) candidate.classSkillProficiencies = normalizedClassSkillProficiencies(candidate)
  if (own(candidate, 'selectedFeatureIds')) candidate.selectedFeatureIds = normalizedSelectedFeatureIds(candidate)
  const spells = normalizedSpellSelectionsFor(candidate)
  if (own(candidate, 'knownSpellIds')) candidate.knownSpellIds = spells.knownSpellIds ?? []
  if (own(candidate, 'preparedSpellIds')) candidate.preparedSpellIds = spells.preparedSpellIds ?? []
  return candidate
}

export function deriveCharacterSheet(actor, options = {}) {
  const characterClass = characterClassKey(actor)
  if (!characterClass) throw new CharacterLifecycleValidationError('Для листа героя требуется поддерживаемый класс', 'CHARACTER_CLASS_UNSUPPORTED')
  const level = normalizedLevel(actor?.level)
  const experience = integer(actor?.experience, 'experience', { minimum: 0, maximum: MAX_EXPERIENCE, fallback: 0 })
  const abilities = normalizedAbilityScores(actor?.abilities)
  const proficiencyBonus = proficiencyBonusForLevel(level)
  const canonical = canonicalCharacterChoices({ ...actor, characterClass, level, abilities })
  const itemEffects = activeItemEffectTotals(canonical)
  const savingThrowProficiencies = new Set(savingThrowProficienciesFor(canonical))
  const skills = Object.fromEntries(SKILL_IDS.map((id) => {
    const ability = skillAbility(id)
    const proficient = normalizedClassSkillProficiencies(canonical).includes(id)
    const modifier = abilityModifier(abilities[ability])
    return [id, {
      ability,
      modifier,
      proficient,
      proficiencyBonus: proficient ? proficiencyBonus : 0,
      total: modifier + (proficient ? proficiencyBonus : 0),
    }]
  }))
  const savingThrows = Object.fromEntries(ABILITY_IDS.map((ability) => {
    const proficient = savingThrowProficiencies.has(ability)
    const modifier = abilityModifier(abilities[ability])
    return [ability, {
      modifier,
      proficient,
      proficiencyBonus: proficient ? proficiencyBonus : 0,
      item_effect_bonus: itemEffects.saving_throw_bonus,
      total: modifier + (proficient ? proficiencyBonus : 0) + itemEffects.saving_throw_bonus,
    }]
  }))
  const hitPoints = deriveMaximumHitPoints(canonical, { level, abilities })
  const armorClass = deriveArmorClass(canonical, { abilities, armorProfiles: options.armorProfiles })
  const speed = deriveSpeed(canonical, { armorProfiles: options.armorProfiles })
  return {
    schema_version: CHARACTER_LIFECYCLE_SCHEMA_VERSION,
    actor_id: cleanText(canonical.id, 120) || null,
    character_class: characterClass,
    level,
    experience,
    experience_for_next_level: level < MAX_LEVEL ? experienceForLevel(level + 1) : null,
    abilities: Object.fromEntries(ABILITY_IDS.map((ability) => [ability, {
      score: abilities[ability], modifier: abilityModifier(abilities[ability]),
    }])),
    proficiency_bonus: proficiencyBonus,
    saving_throw_proficiencies: [...savingThrowProficiencies],
    saving_throws: savingThrows,
    skills,
    passive_perception: 10 + skills.perception.total,
    armor_class: armorClass,
    speed,
    hit_points: hitPoints,
    class_resources: classResourcePlan(canonical),
  }
}

/** Returns canonical supported build fields plus a derived read model. */
export function normalizeCharacterSheet(actor, options = {}) {
  const sheet = deriveCharacterSheet(actor, options)
  const abilities = Object.fromEntries(ABILITY_IDS.map((ability) => [ability, sheet.abilities[ability].score]))
  const canonical = canonicalCharacterChoices({
    ...clone(actor ?? {}),
    characterClass: sheet.character_class,
    level: sheet.level,
    experience: sheet.experience,
    abilities,
    baseSpeed: sheet.speed.base,
    hitPointIncreases: normalizedHitPointIncreases(actor, { level: sheet.level, hitDie: sheet.hit_points.hitDie }),
  })
  return {
    actor: canonical,
    sheet,
  }
}

/**
 * All resource maxima come from the existing class/action and spell catalogs.
 * The returned recovery map is the only policy a rest integration should use.
 */
export function classResourcePlan(actor) {
  const maximums = {
    ...spellSlotMaximumsFor(actor),
    ...combatResourceMaximumsFor(actor),
  }
  const recovery = {
    ...Object.fromEntries(Object.keys(spellSlotMaximumsFor(actor)).map((resource) => [resource,
      resource === 'pact_slots' ? 'short_or_long' : 'long'])),
    ...combatResourceRecoveryFor(actor),
  }
  const byRest = {
    short: Object.keys(maximums).filter((resource) => recovery[resource] === 'short_or_long'),
    long: Object.keys(maximums).filter((resource) => ['long', 'short_or_long'].includes(recovery[resource])),
  }
  return { maximums, recovery, by_rest: byRest }
}

export function resourcesAfterRest(actor, resources, kind) {
  if (!['short', 'long'].includes(kind)) throw new CharacterLifecycleValidationError('kind отдыха должен быть short или long', 'INVALID_REST_KIND')
  const plan = classResourcePlan(actor)
  const source = isRecord(resources) ? resources : {}
  return Object.fromEntries(Object.entries(plan.maximums).map(([resource, maximum]) => {
    const current = Math.max(0, Math.min(maximum, Number(source[resource]?.current ?? maximum) || 0))
    const restored = kind === 'long' || plan.recovery[resource] === 'short_or_long'
    return [resource, { current: restored ? maximum : current, max: maximum, recovery: plan.recovery[resource] }]
  }))
}

function actorFromState(state, actorId) {
  const actor = (state?.players ?? []).find((candidate) => String(candidate?.id) === actorId)
  if (!actor) throw new CharacterLifecycleValidationError('Герой не найден в кампании', 'ACTOR_NOT_FOUND')
  return actor
}

function assertActorAuthority(actorId, context) {
  const allowed = new Set((context?.allowedActorIds ?? []).map(String))
  if (context?.isAdmin !== true && !allowed.has(actorId)) {
    throw new CharacterLifecycleValidationError('Повысить уровень может только владелец героя', 'ACTOR_FORBIDDEN')
  }
}

export function validateLevelUpCommand(command, state, context = {}) {
  if (!isRecord(command) || command.command_type !== 'LevelUp') {
    throw new CharacterLifecycleValidationError('Нужна команда LevelUp', 'INVALID_LEVEL_UP_COMMAND')
  }
  if (state?.mechanics?.combat?.active) {
    throw new CharacterLifecycleValidationError('Нельзя повышать уровень во время боя', 'LEVEL_UP_DURING_COMBAT')
  }
  const actorId = cleanIdentifier(command.actor_id ?? command.actorId, 'actor_id')
  const actor = actorFromState(state, actorId)
  assertActorAuthority(actorId, context)
  const currentLevel = normalizedLevel(actor.level)
  if (currentLevel >= MAX_LEVEL) throw new CharacterLifecycleValidationError('Достигнут максимальный поддерживаемый уровень', 'LEVEL_CAP_REACHED')
  const nextLevel = currentLevel + 1
  const expectedLevel = command.expected_level ?? command.expectedLevel
  if (expectedLevel != null && integer(expectedLevel, 'expected_level', { minimum: 1, maximum: MAX_LEVEL }) !== currentLevel) {
    throw new CharacterLifecycleValidationError('Лист героя изменился: expected_level не совпадает', 'LEVEL_UP_CONFLICT')
  }
  if (command.next_level != null && integer(command.next_level, 'next_level', { minimum: 1, maximum: MAX_LEVEL }) !== nextLevel) {
    throw new CharacterLifecycleValidationError('За одну команду можно повысить ровно один уровень', 'LEVEL_UP_STEP_INVALID')
  }
  const experience = integer(actor.experience, 'experience', { minimum: 0, maximum: MAX_EXPERIENCE, fallback: 0 })
  const requiredExperience = experienceForLevel(nextLevel)
  /**
   * Уровень заслуживают двумя путями, и ворота обязаны знать оба.
   *
   * До 2026-07-28 здесь стоял только опыт. Кампания на вехах опыта не
   * начисляет вовсе (`MilestoneAwarded` вместо `ExperienceAwarded`), поэтому
   * её герои не могли повыситься **никогда**: реестр вех считал заслуженный
   * уровень, а ворота отвечали «нужно 300 XP». Счётчик без ворот — обещание,
   * которое движок не может исполнить.
   *
   * Порог вех списывается reducer'ом на `CharacterLeveledUp`, поэтому один
   * заслуженный уровень нельзя потратить дважды.
   */
  const milestoneEarned = state?.mechanics?.progression?.level_up_available === true
  if (experience < requiredExperience && !milestoneEarned) {
    throw new CharacterLifecycleValidationError(
      `Для уровня ${nextLevel} нужно ${requiredExperience} XP или заслуженная веха`,
      'LEVEL_UP_PROGRESSION_REQUIRED',
    )
  }
  const progressionSource = experience >= requiredExperience ? 'experience' : 'milestone'
  const hitDie = hitDieFor(actor)
  const rawRoll = command.hit_point_roll ?? command.hitPointRoll
  const hitPointRoll = rawRoll == null
    ? fixedHitPointIncrease(hitDie)
    : integer(rawRoll, 'hit_point_roll', { minimum: 1, maximum: hitDie })
  const hitPointPolicy = rawRoll == null ? 'fixed_average' : 'server_roll'
  const before = deriveMaximumHitPoints(actor, { level: currentLevel })
  const afterActor = {
    ...clone(actor),
    level: nextLevel,
    hitPointIncreases: [...normalizedHitPointIncreases(actor, { level: currentLevel, hitDie }), hitPointRoll],
  }
  const after = deriveMaximumHitPoints(afterActor, { level: nextLevel })
  return {
    command_type: 'LevelUp',
    actor_id: actorId,
    target_id: actorId,
    target_ids: [actorId],
    expected_level: currentLevel,
    level_before: currentLevel,
    level_after: nextLevel,
    experience,
    experience_required: requiredExperience,
    progression_source: progressionSource,
    hit_die: hitDie,
    hit_point_roll: hitPointRoll,
    hit_point_policy: hitPointPolicy,
    max_hp_before: before.value,
    max_hp_after: after.value,
    source_rule_ids: ['srd_5_2_1:resources:spending'],
    visibility: 'party',
  }
}

export function levelUpEvent(command) {
  if (command?.command_type !== 'LevelUp' || !command.actor_id) {
    throw new CharacterLifecycleValidationError('Нужна валидированная команда LevelUp', 'INVALID_LEVEL_UP_COMMAND')
  }
  return {
    event_type: 'CharacterLeveledUp',
    actor_id: command.actor_id,
    target_ids: [command.actor_id],
    source_rule_ids: [...(command.source_rule_ids ?? ['srd_5_2_1:resources:spending'])],
    visibility: command.visibility ?? 'party',
    payload: {
      schema_version: CHARACTER_LIFECYCLE_SCHEMA_VERSION,
      level_before: command.level_before,
      level_after: command.level_after,
      experience: command.experience,
      experience_required: command.experience_required,
      // Чем именно заслужен уровень — видно в событии, а не выводится задним
      // числом: опыт мог накопиться уже после повышения по вехе.
      progression_source: command.progression_source ?? 'experience',
      hit_die: command.hit_die,
      hit_point_roll: command.hit_point_roll,
      hit_point_policy: command.hit_point_policy,
      max_hp_before: command.max_hp_before,
      max_hp_after: command.max_hp_after,
    },
  }
}

export function validateCharacterImportCommand(command, state, context = {}) {
  if (!isRecord(command) || command.command_type !== 'ImportCharacter') {
    throw new CharacterLifecycleValidationError('Нужна команда ImportCharacter', 'INVALID_CHARACTER_IMPORT_COMMAND')
  }
  if (state?.mechanics?.combat?.active) {
    throw new CharacterLifecycleValidationError('Нельзя импортировать лист во время боя', 'IMPORT_DURING_COMBAT')
  }
  const actorId = cleanIdentifier(command.actor_id ?? command.actorId, 'actor_id')
  actorFromState(state, actorId)
  assertActorAuthority(actorId, context)
  const parsed = parseCharacterImport(command.document)
  return {
    command_type: 'ImportCharacter',
    actor_id: actorId,
    target_id: actorId,
    target_ids: [actorId],
    document: parsed.document,
    patch: parsed.patch,
    derived_sheet: parsed.sheet,
    source_rule_ids: ['srd_5_2_1:resources:spending'],
    visibility: 'party',
  }
}

export function characterImportEvent(command) {
  if (command?.command_type !== 'ImportCharacter' || !command.actor_id || !isRecord(command.patch)) {
    throw new CharacterLifecycleValidationError('Нужна валидированная команда ImportCharacter', 'INVALID_CHARACTER_IMPORT_COMMAND')
  }
  return {
    event_type: 'CharacterImported',
    actor_id: command.actor_id,
    target_ids: [command.actor_id],
    source_rule_ids: [...(command.source_rule_ids ?? ['srd_5_2_1:resources:spending'])],
    visibility: command.visibility ?? 'party',
    payload: {
      schema: CHARACTER_IMPORT_SCHEMA,
      schema_version: CHARACTER_IMPORT_SCHEMA_VERSION,
      patch: clone(command.patch),
    },
  }
}

export function resolveLevelUp(command, state, context = {}) {
  const validated = validateLevelUpCommand(command, state, context)
  const event = levelUpEvent(validated)
  const stateAfter = applyCharacterLifecycleEvent(state, event)
  const actor = actorFromState(stateAfter, validated.actor_id)
  return { command: validated, event, state: stateAfter, sheet: deriveCharacterSheet(actor) }
}

export function isCharacterLifecycleEvent(event) {
  return CHARACTER_LIFECYCLE_EVENT_TYPES.has(String(event?.event_type ?? ''))
}

/** Pure reducer helper. The surrounding Event Store owns state_version. */
export function applyCharacterLifecycleEvent(state, event) {
  if (!isCharacterLifecycleEvent(event)) return clone(state)
  const next = clone(state ?? {})
  const actorId = String(event.target_ids?.[0] ?? event.actor_id ?? '')
  const index = (next.players ?? []).findIndex((candidate) => String(candidate?.id) === actorId)
  if (index < 0) throw new CharacterLifecycleValidationError('Событие LevelUp ссылается на отсутствующего героя', 'ACTOR_NOT_FOUND')
  const actor = next.players[index]
  const payload = event.payload ?? {}
  if (event.event_type === 'CharacterImported') {
    const parsed = parseCharacterImport({
      schema: payload.schema,
      schema_version: payload.schema_version,
      character: payload.patch,
    }, { allowLegacyAbilityPolicy: true })
    const wasCharacterSlot = actor.characterSetupRequired === true
    let updated = { ...actor, ...parsed.patch, id: actor.id, inventory: clone(actor.inventory ?? []), currency: clone(actor.currency ?? {}) }
    if (wasCharacterSlot) {
      updated = withStarterKit({
        ...updated,
        inventory: [],
        currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
      })
      updated.initials = updated.character.slice(0, 2).toLocaleUpperCase('ru')
    }
    const sheet = deriveCharacterSheet(updated)
    updated.maxHp = sheet.hit_points.value
    updated.hp = wasCharacterSlot
      ? sheet.hit_points.value
      : Math.min(Math.max(0, Number(actor.hp) || sheet.hit_points.value), sheet.hit_points.value)
    updated.characterSetupRequired = false
    next.players[index] = updated
    return next
  }
  const previousLevel = normalizedLevel(actor.level)
  const levelAfter = integer(payload.level_after, 'event.level_after', { minimum: 1, maximum: MAX_LEVEL })
  if (levelAfter !== previousLevel + 1) {
    throw new CharacterLifecycleValidationError('Событие LevelUp должно повышать уровень ровно на один', 'LEVEL_UP_STEP_INVALID')
  }
  const roll = integer(payload.hit_point_roll, 'event.hit_point_roll', { minimum: 1, maximum: hitDieFor(actor) })
  const updated = {
    ...actor,
    level: levelAfter,
    hitPointIncreases: [...normalizedHitPointIncreases(actor, { level: previousLevel, hitDie: hitDieFor(actor) }), roll],
  }
  const hitPoints = deriveMaximumHitPoints(updated, { level: levelAfter })
  updated.maxHp = hitPoints.value
  updated.hp = Math.min(Math.max(0, Number(updated.hp) || 0), hitPoints.value)
  next.players[index] = updated
  return next
}

const IMPORT_TOP_LEVEL_V1 = Object.freeze(['schema', 'schema_version', 'character'])
const IMPORT_CHARACTER_V1 = Object.freeze([
  'character', 'name', 'role', 'characterClass', 'subclass', 'species', 'background', 'alignment',
  'traits', 'ideals', 'bonds', 'flaws', 'backstory', 'notes', 'level', 'experience', 'abilities',
  'abilityGeneration', 'baseSpeed', 'hitPointIncreases', 'classSkillProficiencies', 'selectedFeatureIds', 'knownSpellIds', 'preparedSpellIds',
])
const IMPORT_V0_ALIASES = Object.freeze({
  character_class: 'characterClass',
  ability_generation: 'abilityGeneration',
  base_speed: 'baseSpeed',
  hit_point_increases: 'hitPointIncreases',
  class_skill_proficiencies: 'classSkillProficiencies',
  selected_feature_ids: 'selectedFeatureIds',
  known_spell_ids: 'knownSpellIds',
  prepared_spell_ids: 'preparedSpellIds',
})

function migrateV0Character(source) {
  if (!isRecord(source)) throw new CharacterLifecycleValidationError('character v0 должен быть объектом', 'IMPORT_INVALID_SHAPE')
  const migrated = {}
  for (const [key, value] of Object.entries(source)) {
    const destination = IMPORT_V0_ALIASES[key] ?? key
    if (!IMPORT_CHARACTER_V1.includes(destination)) {
      throw new CharacterLifecycleValidationError(`character v0 содержит неподдерживаемое поле: ${key}`, 'IMPORT_UNKNOWN_FIELD')
    }
    if (own(migrated, destination) && JSON.stringify(migrated[destination]) !== JSON.stringify(value)) {
      throw new CharacterLifecycleValidationError(`character v0 содержит конфликтующие ${key} и ${destination}`, 'IMPORT_MIGRATION_CONFLICT')
    }
    migrated[destination] = value
  }
  return migrated
}

/**
 * Strictly migrates only the explicitly documented v0 aliases.  Any unknown
 * field or ambiguous alias is rejected instead of silently becoming game data.
 */
export function migrateCharacterImport(raw) {
  if (!isRecord(raw)) throw new CharacterLifecycleValidationError('Импорт должен быть JSON-объектом', 'IMPORT_INVALID_SHAPE')
  exactKeys(raw, IMPORT_TOP_LEVEL_V1, 'import')
  if (raw.schema !== CHARACTER_IMPORT_SCHEMA) {
    throw new CharacterLifecycleValidationError(`schema должен быть ${CHARACTER_IMPORT_SCHEMA}`, 'IMPORT_SCHEMA_UNSUPPORTED')
  }
  const version = integer(raw.schema_version, 'schema_version', { minimum: 0, maximum: CHARACTER_IMPORT_SCHEMA_VERSION })
  if (version === CHARACTER_IMPORT_SCHEMA_VERSION) {
    exactKeys(raw.character, IMPORT_CHARACTER_V1, 'character')
    return { schema: CHARACTER_IMPORT_SCHEMA, schema_version: CHARACTER_IMPORT_SCHEMA_VERSION, character: clone(raw.character) }
  }
  if (version === 0) {
    return {
      schema: CHARACTER_IMPORT_SCHEMA,
      schema_version: CHARACTER_IMPORT_SCHEMA_VERSION,
      character: migrateV0Character(raw.character),
    }
  }
  throw new CharacterLifecycleValidationError(`Неподдерживаемая версия импорта ${version}`, 'IMPORT_SCHEMA_UNSUPPORTED')
}

function optionalText(value, field, maximum) {
  if (value == null) return undefined
  if (typeof value !== 'string') throw new CharacterLifecycleValidationError(`${field} должен быть строкой`, 'IMPORT_INVALID_FIELD')
  return cleanText(value, maximum)
}

/**
 * Parses a v1 document into a safe character patch.  Deliberately absent from
 * the result: id, HP, AC, proficiency, speed, inventory, money and resources.
 */
export function parseCharacterImport(raw, options = {}) {
  const document = migrateCharacterImport(raw)
  const source = document.character
  exactKeys(source, IMPORT_CHARACTER_V1, 'character')
  const character = optionalText(source.character, 'character.character', 120)
  if (!character) throw new CharacterLifecycleValidationError('character.character обязателен', 'IMPORT_REQUIRED_FIELD')
  const classId = cleanIdentifier(source.characterClass, 'character.characterClass')
  if (!characterClassKey({ characterClass: classId })) {
    throw new CharacterLifecycleValidationError('Импорт ссылается на неподдерживаемый класс', 'CHARACTER_CLASS_UNSUPPORTED')
  }
  const experience = integer(source.experience, 'character.experience', { minimum: 0, maximum: MAX_EXPERIENCE })
  const level = normalizedLevel(source.level)
  if (level !== levelForExperience(experience)) {
    throw new CharacterLifecycleValidationError('Уровень должен соответствовать порогу XP текущего ruleset', 'IMPORT_LEVEL_EXPERIENCE_MISMATCH')
  }
  const abilities = normalizedAbilityScores(source.abilities)
  const abilityGeneration = validateAbilityGeneration(source.abilityGeneration, abilities, options)
  const baseSpeed = integer(source.baseSpeed, 'character.baseSpeed', { minimum: 5, maximum: 120 })
  let derivedSpecies = ''
  if (abilityGeneration) {
    const speciesOption = speciesOptions.get(abilityGeneration.speciesOptionId)
    const requestedSpecies = optionalText(source.species, 'character.species', 120)
    // Источник истины — `speciesOptionId`. Метку выводит сервер, поэтому клиенту не нужно
    // её дублировать и она может меняться в policy без ломки контракта. Присланную метку
    // всё ещё сверяем: так воспроизводятся события, записанные до этой правки.
    if (requestedSpecies && speciesOption.id !== 'custom' && requestedSpecies !== speciesOption.label) {
      throw new CharacterLifecycleValidationError(
        'Вид персонажа не соответствует выбранному серверному варианту',
        'IMPORT_SPECIES_UNSUPPORTED',
      )
    }
    if (speciesOption.id === 'custom' && !requestedSpecies) {
      throw new CharacterLifecycleValidationError(
        'Авторский вид требует явного названия в character.species',
        'IMPORT_SPECIES_UNSUPPORTED',
      )
    }
    derivedSpecies = requestedSpecies || speciesOption.label
    if (baseSpeed !== speciesOption.base_speed) {
      throw new CharacterLifecycleValidationError(
        'Базовая скорость не соответствует выбранному серверному виду',
        'IMPORT_SPECIES_SPEED_INVALID',
      )
    }
  }
  const provisional = {
    character,
    characterClass: classId,
    level,
    experience,
    abilities,
    ...(abilityGeneration ? { abilityGeneration } : {}),
    baseSpeed,
    ...(source.subclass == null ? {} : { subclass: optionalText(source.subclass, 'character.subclass', 160) }),
    classSkillProficiencies: uniqueIdentifiers(source.classSkillProficiencies ?? [], 'character.classSkillProficiencies'),
    selectedFeatureIds: uniqueIdentifiers(source.selectedFeatureIds ?? [], 'character.selectedFeatureIds'),
    knownSpellIds: uniqueIdentifiers(source.knownSpellIds ?? [], 'character.knownSpellIds'),
    preparedSpellIds: uniqueIdentifiers(source.preparedSpellIds ?? [], 'character.preparedSpellIds'),
  }
  const hitDie = hitDieFor(provisional)
  const rawHitPointIncreases = source.hitPointIncreases ?? []
  if (!Array.isArray(rawHitPointIncreases)) {
    throw new CharacterLifecycleValidationError('character.hitPointIncreases должен быть массивом', 'IMPORT_INVALID_FIELD')
  }
  provisional.hitPointIncreases = rawHitPointIncreases.map((entry, index) => integer(entry, `character.hitPointIncreases.${index}`, {
    minimum: 1, maximum: hitDie,
  }))
  if (provisional.hitPointIncreases.length > level - 1) {
    throw new CharacterLifecycleValidationError('character.hitPointIncreases длиннее истории уровней', 'IMPORT_INVALID_FIELD')
  }
  const canonical = canonicalCharacterChoices(provisional)
  const requestedSubclass = provisional.subclass ?? ''
  if ((requestedSubclass && canonical.subclass !== requestedSubclass)
    || !sameStringSet(provisional.classSkillProficiencies, canonical.classSkillProficiencies ?? [])
    || !sameStringSet(provisional.selectedFeatureIds, canonical.selectedFeatureIds ?? [])
    || !sameStringSet(provisional.knownSpellIds, canonical.knownSpellIds ?? [])
    || !sameStringSet(provisional.preparedSpellIds, canonical.preparedSpellIds ?? [])) {
    throw new CharacterLifecycleValidationError('Импорт содержит недоступный выбор класса, особенности или заклинания', 'IMPORT_CHARACTER_CHOICE_INVALID')
  }
  for (const [field, maximum] of [['name', 120], ['role', 160], ['species', 120], ['background', 160], ['alignment', 120], ['traits', 2_000], ['ideals', 2_000], ['bonds', 2_000], ['flaws', 2_000], ['backstory', 8_000], ['notes', 8_000]]) {
    const value = optionalText(source[field], `character.${field}`, maximum)
    if (value !== undefined) canonical[field] = value
  }
  if (derivedSpecies) canonical.species = derivedSpecies
  return {
    document,
    patch: canonical,
    sheet: deriveCharacterSheet(canonical),
  }
}
