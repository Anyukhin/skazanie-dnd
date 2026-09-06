import {
  catalogSkillId,
  abilityScoreChoiceLevelsFor,
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
import {
  defaultStarterEquipmentChoices,
  completeBackgroundChoicesForHero,
  validateCompleteBackgroundChoices,
  resolveStarterEquipmentChoices,
  starterEquipmentCatalogFor,
  withStarterKit,
} from './starter-kit.mjs'
import {
  backgroundCatalogFor,
  backgroundById,
  defaultBackgroundChoices,
  resolveBackgroundAbilityChoice,
  resolveBackgroundChoices,
  resolveBackgroundCustomization,
  withBackgroundBenefits,
} from './backgrounds.mjs'
import {
  characterCreationPolicyFor,
  defaultSpeciesChoices,
  originBonusProfileFor,
  resolveSpeciesChoices,
  speciesBenefitsFor,
  speciesOptionFor,
  validateSpeciesOriginBonuses,
} from './character-creation-catalog.mjs'
import { DND_2014_RULESET_ID, LEGACY_DEFAULT_RULESET_ID } from './ruleset-config.mjs'
import { phbCreationCatalog, phbFirstLevelSpells, PHB_FIGHTING_STYLES, resolvePhbCreation } from './character-creation-phb.mjs'
import { classOptionFor } from './character-creation-class-options.mjs'
import { PHB_STARTING_WEALTH, startingPurchaseCatalog, resolveStartingPurchases } from './character-creation-wealth.mjs'

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
export const CHARACTER_LIFECYCLE_COMMAND_TYPES = new Set(['LevelUp', 'ImportCharacter', 'RollCharacterAbilities', 'RollCharacterWealth'])
export const CHARACTER_LIFECYCLE_EVENT_TYPES = new Set(['CharacterLeveledUp', 'CharacterImported'])

export const ABILITY_IDS = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha'])
export const SKILL_IDS = Object.freeze([
  'acrobatics', 'animal_handling', 'arcana', 'athletics', 'deception', 'history',
  'insight', 'intimidation', 'investigation', 'medicine', 'nature', 'perception',
  'performance', 'persuasion', 'religion', 'sleight_of_hand', 'stealth', 'survival',
])

const legacyCharacterCreationPolicy = characterCreationPolicyFor(LEGACY_DEFAULT_RULESET_ID)

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

export const MAX_CHARACTER_LEVEL = 12

export const DERIVED_CHARACTER_POLICY = Object.freeze({
  maximumLevel: MAX_CHARACTER_LEVEL,
  proficiency: '2 + floor((level - 1) / 4)',
  hitPoints: 'level 1 uses the maximum hit die; later levels use a recorded dN roll or the fixed average, then add CON with a minimum of 1 per level',
  armorClass: 'only equipped items resolved through a server-owned armor profile affect AC; otherwise the class unarmored rule applies',
  speed: 'base_speed minus server-owned equipped armor penalties; the browser-supplied speed field is ignored',
  imports: 'v1 excludes id, current/max HP, AC, proficiency, inventory, currency, resources, and all derived fields',
})

const MAX_LEVEL = MAX_CHARACTER_LEVEL
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
  'policyId', 'policyVersion', 'method', 'baseScores', 'originBonusProfileId', 'originBonuses', 'speciesOptionId', 'rollId',
])

export const POINT_BUY_COSTS = Object.freeze({ 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 })

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

function validateAbilityGeneration(source, abilities, {
  allowLegacyAbilityPolicy = false,
  rulesetId = LEGACY_DEFAULT_RULESET_ID,
  trustedAbilityRoll = null,
  additionalAbilityBonuses = {},
} = {}) {
  const characterCreationPolicy = characterCreationPolicyFor(rulesetId)
  if (!isRecord(source)) {
    if (allowLegacyAbilityPolicy) return null
    throw new CharacterLifecycleValidationError(
      'Импорт должен явно указывать versioned policy генерации характеристик',
      'IMPORT_ABILITY_POLICY_REQUIRED',
    )
  }
  exactKeys(source, ABILITY_GENERATION_FIELDS, 'character.abilityGeneration')
  const legacyClassicPolicy = allowLegacyAbilityPolicy
    && rulesetId === DND_2014_RULESET_ID
    && source.policyId === characterCreationPolicy.policy_id
    && Number(source.policyVersion) === 1
    && source.method === characterCreationPolicy.method
  if (!legacyClassicPolicy && (source.policyId !== characterCreationPolicy.policy_id
    || Number(source.policyVersion) !== characterCreationPolicy.policy_version
    || !(rulesetId === DND_2014_RULESET_ID ? ['standard_array', 'point_buy', 'rolled'] : [characterCreationPolicy.method]).includes(source.method))) {
    throw new CharacterLifecycleValidationError(
      'Импорт использует неподдерживаемую policy генерации характеристик',
      'IMPORT_ABILITY_POLICY_UNSUPPORTED',
    )
  }
  const baseScores = abilityScoreMap(source.baseScores, 'character.abilityGeneration.baseScores', { minimum: 1, maximum: 30 })
  const expectedArray = [...characterCreationPolicy.standard_array].sort((left, right) => left - right)
  const actualArray = Object.values(baseScores).sort((left, right) => left - right)
  if (source.method === 'point_buy') {
    const cost = Object.values(baseScores).reduce((sum, score) => sum + (POINT_BUY_COSTS[score] ?? Number.POSITIVE_INFINITY), 0)
    if (cost > 27) throw new CharacterLifecycleValidationError('Покупка характеристик: значения 8–15, бюджет не больше 27 очков', 'IMPORT_ABILITY_BUDGET_INVALID')
  } else if (source.method === 'rolled') {
    if (!source.rollId || Object.values(baseScores).some((score) => score < 3 || score > 18)) {
      throw new CharacterLifecycleValidationError('Для бросков характеристик нужен серверный результат 4к6', 'IMPORT_ABILITY_ROLL_REQUIRED')
    }
    if (!allowLegacyAbilityPolicy && (trustedAbilityRoll?.id !== source.rollId
      || JSON.stringify([...(trustedAbilityRoll?.scores ?? [])].sort((a, b) => a - b)) !== JSON.stringify(actualArray))) {
      throw new CharacterLifecycleValidationError('Распределение не совпадает с сохранёнными серверными бросками этого героя', 'IMPORT_ABILITY_ROLL_INVALID')
    }
  } else if (JSON.stringify(actualArray) !== JSON.stringify(expectedArray)) {
    throw new CharacterLifecycleValidationError(
      `Базовые характеристики должны быть распределением стандартного массива ${characterCreationPolicy.standard_array.join(', ')}`,
      'IMPORT_ABILITY_BUDGET_INVALID',
    )
  }
  const bonusProfile = originBonusProfileFor(source.originBonusProfileId, rulesetId)
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
  const speciesOption = speciesOptionFor(source.speciesOptionId, rulesetId)
  if (!speciesOption) {
    throw new CharacterLifecycleValidationError('Выбран неподдерживаемый вид персонажа', 'IMPORT_SPECIES_UNSUPPORTED')
  }
  const expectedScores = Object.fromEntries(ABILITY_IDS.map((ability) => [ability, Math.min(20, baseScores[ability] + originBonuses[ability] + Number(additionalAbilityBonuses[ability] ?? 0))]))
  if (ABILITY_IDS.some((ability) => abilities[ability] !== expectedScores[ability])) {
    throw new CharacterLifecycleValidationError(
      'Итоговые характеристики не совпадают с базовым массивом и явными бонусами происхождения',
      'IMPORT_ABILITY_BUDGET_INVALID',
    )
  }
  const speciesValidation = validateSpeciesOriginBonuses(
    speciesOption.id,
    bonusProfile.id,
    originBonuses,
    rulesetId,
  )
  if (!speciesValidation.ok) {
    throw new CharacterLifecycleValidationError(speciesValidation.reason, 'IMPORT_SPECIES_ABILITY_INVALID')
  }
  return {
    policyId: characterCreationPolicy.policy_id,
    policyVersion: legacyClassicPolicy ? 1 : characterCreationPolicy.policy_version,
    method: source.method,
    ...(source.method === 'rolled' ? { rollId: String(source.rollId) } : {}),
    baseScores,
    originBonusProfileId: bonusProfile.id,
    originBonuses,
    speciesOptionId: speciesOption.id,
  }
}

export function characterCreationCatalog(rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  const characterCreationPolicy = characterCreationPolicyFor(rulesetId)
  const backgrounds = backgroundCatalogFor(rulesetId)
  const classBuild = classBuildCatalogInfo()
  const classCombat = combatClassCatalogInfo()
  const starterEquipment = starterEquipmentCatalogFor(rulesetId, { complete: rulesetId === DND_2014_RULESET_ID })
  const starterByClass = new Map((starterEquipment?.classes ?? []).map((entry) => [entry.class_id, entry]))
  const skillsById = new Map(classBuild.skills.map((skill) => [skill.id, skill]))
  return {
    schema_version: 1,
    ruleset_id: characterCreationPolicy.ruleset_id,
    edition_family: characterCreationPolicy.edition_family,
    import_schema: CHARACTER_IMPORT_SCHEMA,
    import_schema_version: CHARACTER_IMPORT_SCHEMA_VERSION,
    ability_policy: clone(characterCreationPolicy),
    ability_methods: rulesetId === DND_2014_RULESET_ID ? ['standard_array', 'point_buy', 'rolled'] : ['standard_array'],
    point_buy: { budget: 27, costs: { ...POINT_BUY_COSTS } },
    ...(rulesetId === DND_2014_RULESET_ID ? { starting_wealth: { formulas: PHB_STARTING_WEALTH, items: startingPurchaseCatalog() } } : {}),
    ...(rulesetId === DND_2014_RULESET_ID ? { phb: { ...phbCreationCatalog(), skills: classBuild.skills.map((skill) => ({ id: skill.id, name: skill.name })) } } : {}),
    // Предыстории отдаются каталогом целиком: мастер показывает последствия
    // выбора до перехода дальше, а сервер всё равно пересчитывает их сам по
    // идентификатору — присланные клиентом бонусы недоверенные.
    backgrounds,
    starter_equipment: starterEquipment,
    classes: classCombat.classes.map((classOption) => {
      const actor = {
        characterClass: classOption.classKey,
        level: 1,
        abilities: Object.fromEntries(ABILITY_IDS.map((ability, index) => [ability, characterCreationPolicy.standard_array[index]])),
      }
      const skillRule = classSkillRuleFor(actor)
      const spellRules = spellSelectionRulesFor(actor)
      const availableSpells = spellRules ? (rulesetId === DND_2014_RULESET_ID
        ? phbFirstLevelSpells().filter((spell) => spell.classes.includes(classOption.classKey))
        : combatSpellsFor(actor).filter((spell) => spell.level <= 1)) : []
      const phbClass = rulesetId === DND_2014_RULESET_ID ? classOptionFor(classOption.classKey) : null
      return {
        id: classOption.classKey,
        label: classOption.label,
        source_url: classOption.sourceUrl,
        subclass_level: classOption.subclassLevel,
        subclasses: phbClass?.subclass_level === 1 ? phbClass.subclass_options.map((entry) => ({ id: entry.id, name: entry.label })) : classOption.subclassOptions,
        class_skills: skillRule ? {
          choice_count: skillRule.choiceCount,
          options: skillRule.skills.map((id) => clone(skillsById.get(id))).filter(Boolean),
        } : null,
        feature_choice_groups: featureChoiceGroupsFor(actor).map((group) => ({ ...group, options: phbClass && classOption.classKey === 'fighter' ? group.options.filter((entry) => PHB_FIGHTING_STYLES[entry.id]) : group.options })),
        starter_equipment: clone(starterByClass.get(classOption.classKey) ?? null),
        spell_selection: spellRules ? {
          ...spellRules,
          spellcastingAbility: phbClass?.spellcasting?.ability ?? availableSpells[0]?.spellcastingAbility ?? null,
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

/**
 * Презентация героя по номеру места в отряде: спрайт портретов и цвет фишки.
 *
 * Поле чисто оформительское — механики оно не касается ни на йоту, — но пустым
 * оставаться не имеет права: клиент красит им фишку на доске, аватар в списке
 * отряда и ленту инициативы, и герой без портрета выглядел пустым цветным
 * кружком. Спрайт лежит в `public/assets/party-portraits.png` сеткой 2×2,
 * позиции перечислены в том же порядке, что и в `src/data.ts`.
 *
 * Назначение детерминированное — по индексу места: два героя подряд не
 * получают одно лицо, а пересоздание того же слота даёт то же самое.
 */
export const PARTY_PORTRAIT_SHEET = '/assets/party-portraits.png'
export const PARTY_PORTRAIT_POSITIONS = ['0% 0%', '100% 0%', '0% 100%', '100% 100%']
export const PARTY_TOKEN_COLORS = ['#d79b5b', '#758f78', '#8b789e', '#9a745d']

/** Портрет и цвет для места героя под номером `index`. */
export function partyPresentationFor(index = 0) {
  const slot = Math.max(0, Math.trunc(Number(index) || 0))
  return {
    color: PARTY_TOKEN_COLORS[slot % PARTY_TOKEN_COLORS.length],
    portrait: PARTY_PORTRAIT_SHEET,
    portraitPosition: PARTY_PORTRAIT_POSITIONS[slot % PARTY_PORTRAIT_POSITIONS.length],
  }
}

export function createCharacterSlot({ id, index = 0 } = {}) {
  const slotId = cleanIdentifier(id ?? `hero-slot-${index + 1}`, 'character slot id')
  const baseScores = Object.fromEntries(ABILITY_IDS.map((ability, abilityIndex) => [
    ability,
    legacyCharacterCreationPolicy.standard_array[abilityIndex],
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
    ...partyPresentationFor(index),
    initials: String(index + 1),
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
  const speciesBonusPerLevel = Math.max(0, Number(actor?.speciesBenefits?.mechanics?.extra_hit_points_per_level) || 0)
  const creationBonus = Number(actor?.creationBenefits?.extra_hit_points_per_level ?? 0)
  const firstLevel = Math.max(1, hitDie + constitutionModifier + speciesBonusPerLevel + creationBonus)
  const laterLevels = perLevel.map((increase) => Math.max(1, increase + constitutionModifier + speciesBonusPerLevel + creationBonus))
  return {
    value: firstLevel + laterLevels.reduce((sum, entry) => sum + entry, 0),
    hitDie,
    constitutionModifier,
    levelOne: firstLevel,
    speciesBonusPerLevel,
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
  const equipped = equippedArmorEntries(actor, profiles)
  const unarmoredBase = actor?.creationBenefits?.unarmored_armor_class
    ? Number(actor.creationBenefits.unarmored_armor_class.base) + dexterityModifier
    : classKey === 'barbarian'
    ? 10 + dexterityModifier + abilityModifier(abilities.con)
    : classKey === 'monk' && !equipped.some((entry) => entry.profile.kind === 'shield')
      ? 10 + dexterityModifier + abilityModifier(abilities.wis)
      : 10 + dexterityModifier
  const bodyArmor = equipped.filter((entry) => entry.profile.kind === 'armor')
    .map((entry) => ({
      ...entry,
      base: integer(entry.profile.armorClassBase, `armor profile ${entry.catalogId}.armorClassBase`, { minimum: 1, maximum: 30 }),
      dexterityCap: entry.profile.dexterityCap == null ? null : integer(entry.profile.dexterityCap, `armor profile ${entry.catalogId}.dexterityCap`, { minimum: -5, maximum: 10 }),
    }))
    .sort((left, right) => right.base - left.base || left.catalogId.localeCompare(right.catalogId))[0] ?? null
  const shields = equipped.filter((entry) => entry.profile.kind === 'shield')
    .sort((left, right) => left.catalogId.localeCompare(right.catalogId)).slice(0, 1)
  const armorDexterity = !bodyArmor || bodyArmor.dexterityCap === 0 ? 0 : Math.min(dexterityModifier,
    actor?.creationBenefits?.feat?.id === 'medium-armor-master' && bodyArmor.dexterityCap === 2 ? 3 : bodyArmor.dexterityCap ?? dexterityModifier)
  const shieldBonus = shields.reduce((sum, entry) => sum + integer(entry.profile.armorClassBonus, `armor profile ${entry.catalogId}.armorClassBonus`, { minimum: 0, maximum: 10 }), 0)
  const itemEffectBonus = activeItemEffectTotals(actor).armor_class_bonus
  const defenseBonus = bodyArmor && normalizedSelectedFeatureIds(actor).includes('fighting-style-defense') ? 1 : 0
  return {
    value: (bodyArmor ? bodyArmor.base + armorDexterity : unarmoredBase) + shieldBonus + itemEffectBonus + defenseBonus,
    base: bodyArmor ? bodyArmor.base : unarmoredBase,
    dexterityModifier: bodyArmor ? armorDexterity : dexterityModifier,
    shieldBonus,
    item_effect_bonus: itemEffectBonus,
    fighting_style_bonus: defenseBonus,
    source: bodyArmor ? 'equipped_server_profile' : classKey === 'barbarian' || classKey === 'monk' ? 'class_unarmored_defense' : 'unarmored',
    armorCatalogId: bodyArmor?.catalogId ?? null,
    shieldCatalogIds: shields.map((entry) => entry.catalogId),
  }
}

export function deriveSpeed(actor, { armorProfiles } = {}) {
  const profiles = normalizedArmorProfiles(armorProfiles)
  const base = normalizedBaseSpeed(actor)
  const creationBonus = Number(actor?.creationBenefits?.speed_bonus ?? 0)
  const penalties = equippedArmorEntries(actor, profiles)
    .map((entry) => Math.max(0, Number(entry.profile.speedPenalty) || 0,
      actor?.creationBenefits && Number(actor?.abilities?.str) < Number(entry.profile.strengthRequirement ?? 0) ? 10 : 0))
  const penalty = actor?.speciesBenefits?.mechanics?.ignore_armor_speed_penalty === true
    ? 0
    : Math.max(0, ...penalties, 0)
  return { base, ...(creationBonus ? { creation_bonus: creationBonus } : {}), penalty, value: Math.max(0, base + creationBonus - penalty) }
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
  const savingThrowProficiencies = new Set([...savingThrowProficienciesFor(canonical), ...(canonical.creationBenefits?.saving_throw_proficiencies ?? [])])
  // Владения считаются один раз на весь лист, а не восемнадцать. Сравнение при
  // этом буквальное и таким и остаётся: написание приводит к канону каталога
  // сам нормализатор (`catalogSkillId`, `server/character-progression.mjs`), и
  // второй нормализации здесь быть не должно — именно она и разъехалась бы.
  //
  // Источников владения два, и лист обязан читать оба. Предыстория идёт мимо
  // классового выбора намеренно (`normalizedClassSkillProficiencies` фильтрует
  // по списку класса и режет по его квоте), и кость это уже учитывала:
  // `skillProficiencyForActor` (`server/rules-engine.mjs`) ИЛИ-ит
  // `backgroundSkillProficiencies` отдельной строкой. Лист же считал владение
  // только классовым — и герой предыстории получал в карточке броска +5, а в
  // собственном листе тот же навык без владения. Та же «лист против кости», что
  // и на написании навыка, только по второй оси.
  const classSkillProficiencies = new Set(normalizedClassSkillProficiencies(canonical))
  const backgroundSkillProficiencies = new Set(
    (Array.isArray(canonical.backgroundSkillProficiencies) ? canonical.backgroundSkillProficiencies : []).map(catalogSkillId),
  )
  const speciesSkillProficiencies = new Set(
    (Array.isArray(canonical.speciesSkillProficiencies) ? canonical.speciesSkillProficiencies : []).map(catalogSkillId),
  )
  const skills = Object.fromEntries(SKILL_IDS.map((id) => {
    const ability = skillAbility(id)
    const proficient = classSkillProficiencies.has(id) || backgroundSkillProficiencies.has(id) || speciesSkillProficiencies.has(id) || (canonical.creationSkillProficiencies ?? []).includes(id)
    const expertise = proficient && (canonical.creationBenefits?.expertise ?? []).includes(id)
    const modifier = abilityModifier(abilities[ability])
    return [id, {
      ability,
      modifier,
      proficient,
      expertise,
      proficiencyBonus: proficient ? proficiencyBonus * (expertise ? 2 : 1) : 0,
      total: modifier + (proficient ? proficiencyBonus * (expertise ? 2 : 1) : 0),
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
    passive_perception: 10 + skills.perception.total + Number(canonical.creationBenefits?.passive_skill_bonuses?.perception ?? 0),
    passive_investigation: 10 + skills.investigation.total + Number(canonical.creationBenefits?.passive_skill_bonuses?.investigation ?? 0),
    initiative: abilityModifier(abilities.dex) + Number(canonical.creationBenefits?.initiative_bonus ?? 0),
    skill_expertise: canonical.creationBenefits?.expertise ?? [],
    creation_benefits: clone(canonical.creationBenefits ?? null),
    armor_class: armorClass,
    speed,
    hit_points: hitPoints,
    species_traits: clone(canonical.speciesBenefits ?? null),
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

/**
 * Начальный уровень — настройка кампании, а не поле листа от клиента. Старые
 * комнаты его не знают и поэтому сохраняют исторический путь с первого уровня.
 */
export function characterCreationTargetLevel(state) {
  return integer(state?.character_start_level ?? state?.characterStartLevel, 'character_start_level', {
    minimum: 1,
    maximum: MAX_LEVEL,
    fallback: 1,
  })
}

function stagedCharacterSetupFor(state, actor) {
  return actor?.characterSetupRequired === true
    && actor?.characterSetupStage === 'leveling'
    && characterCreationTargetLevel(state) > normalizedLevel(actor?.level)
}

/**
 * Проверяет обязательные выборы на текущем уровне. В поэтапном создании нельзя
 * просто нажимать «дальше»: новый уровень открывается только после того, как
 * сервер увидел полный допустимый набор навыков, подкласса, классовых выборов
 * и заклинаний этого уровня.
 */
export function characterCreationChoicesComplete(actor) {
  const abilityChoices = actor?.abilityScoreIncreases && typeof actor.abilityScoreIncreases === 'object' && !Array.isArray(actor.abilityScoreIncreases)
    ? actor.abilityScoreIncreases
    : {}
  if (abilityScoreChoiceLevelsFor(actor).some((level) => level <= normalizedLevel(actor.level)
    && (!Array.isArray(abilityChoices[String(level)]) || ![1, 2].includes(abilityChoices[String(level)].length)))) return false

  const classRule = classSkillRuleFor(actor)
  if (classRule && normalizedClassSkillProficiencies(actor).length !== classRule.choiceCount) return false

  const classKey = characterClassKey(actor)
  const classInfo = combatClassCatalogInfo().classes.find((entry) => entry.classKey === classKey)
  if (classInfo && normalizedLevel(actor.level) >= Number(classInfo.subclassLevel ?? 1)
    && classInfo.subclasses > 0 && !normalizedCombatSubclassFor(actor)) return false

  const selectedFeatures = new Set(normalizedSelectedFeatureIds(actor))
  for (const group of featureChoiceGroupsFor(actor)) {
    const selected = group.options.filter((option) => selectedFeatures.has(option.id)).length
    if (selected !== group.choiceCount) return false
  }

  const spellRules = spellSelectionRulesFor(actor)
  if (!spellRules) return true
  const selected = normalizedSpellSelectionsFor(actor)
  const known = new Set(selected.knownSpellIds ?? [])
  const spells = new Map(combatSpellsFor(actor).map((spell) => [spell.id, spell]))
  const cantrips = [...known].filter((id) => spells.get(id)?.level === 0).length
  const leveled = [...known].filter((id) => (spells.get(id)?.level ?? 0) > 0).length
  if (cantrips !== spellRules.cantrips) return false
  if (spellRules.mode === 'known' && leveled !== spellRules.spellsKnown) return false
  if (spellRules.mode === 'spellbook' && leveled < spellRules.spellbookMinimum) return false
  return true
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
  const characterCreationLevelUp = stagedCharacterSetupFor(state, actor)
  if (actor.characterSetupRequired === true && !characterCreationLevelUp) {
    throw new CharacterLifecycleValidationError('Сначала импортируйте героя и начните его поэтапную подготовку', 'CHARACTER_SETUP_REQUIRED')
  }
  if (characterCreationLevelUp && nextLevel > characterCreationTargetLevel(state)) {
    throw new CharacterLifecycleValidationError('Герой уже достиг выбранного стартового уровня', 'CHARACTER_CREATION_LEVEL_REACHED')
  }
  if (characterCreationLevelUp && !characterCreationChoicesComplete(actor)) {
    throw new CharacterLifecycleValidationError(
      'Сначала завершите выборы текущего уровня персонажа',
      'CHARACTER_CREATION_CHOICES_REQUIRED',
    )
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
  if (!characterCreationLevelUp && experience < requiredExperience && !milestoneEarned) {
    throw new CharacterLifecycleValidationError(
      `Для уровня ${nextLevel} нужно ${requiredExperience} XP или заслуженная веха`,
      'LEVEL_UP_PROGRESSION_REQUIRED',
    )
  }
  const progressionSource = characterCreationLevelUp
    ? 'character_creation'
    : experience >= requiredExperience ? 'experience' : 'milestone'
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
    experience: characterCreationLevelUp ? requiredExperience : experience,
    experience_required: requiredExperience,
    progression_source: progressionSource,
    hit_die: hitDie,
    hit_point_roll: hitPointRoll,
    hit_point_policy: hitPointPolicy,
    max_hp_before: before.value,
    max_hp_after: after.value,
    source_rule_ids: Array.isArray(command.source_rule_ids) && command.source_rule_ids.length
      ? [...command.source_rule_ids]
      : ['srd_5_2_1:resources:spending'],
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
  const actor = actorFromState(state, actorId)
  assertActorAuthority(actorId, context)
  const rulesetId = String(state?.ruleset_id ?? LEGACY_DEFAULT_RULESET_ID)
  const parsed = parseCharacterImport(command.document, { rulesetId, validateCreationLanguages: true, trustedAbilityRoll: actor.characterCreationRolls?.abilities, trustedWealthRoll: actor.characterCreationRolls?.wealth })
  if (actor.characterSetupRequired === true && parsed.patch.level !== 1) {
    throw new CharacterLifecycleValidationError(
      'Новый герой должен начинать с первого уровня; последующие уровни проходят по одному в мастере подготовки',
      'IMPORT_LEVEL_MUST_START_AT_ONE',
    )
  }
  const starterCatalog = starterEquipmentCatalogFor(rulesetId)
  const speciesPolicy = characterCreationPolicyFor(rulesetId)
  return {
    command_type: 'ImportCharacter',
    actor_id: actorId,
    target_id: actorId,
    target_ids: [actorId],
    document: parsed.document,
    patch: parsed.patch,
    ...(parsed.creation ? { creation_result: parsed.creation } : {}),
    derived_sheet: parsed.sheet,
    ruleset_id: rulesetId,
    starter_equipment_policy_id: starterCatalog?.policy_id ?? null,
    starter_equipment_policy_version: starterCatalog?.policy_version ?? null,
    species_policy_version: speciesPolicy.policy_version,
    source_rule_ids: Array.isArray(command.source_rule_ids) && command.source_rule_ids.length
      ? [...command.source_rule_ids]
      : [`${rulesetId}:resources:spending`],
    visibility: 'party',
  }
}

export function validateCharacterAbilityRollCommand(command, state, context = {}) {
  const actorId = cleanIdentifier(command.actor_id, 'actor_id')
  const actor = actorFromState(state, actorId)
  assertActorAuthority(actorId, context)
  if (state.ruleset_id !== DND_2014_RULESET_ID || !actor.characterSetupRequired || state.mechanics?.combat?.active) {
    throw new CharacterLifecycleValidationError('Броски характеристик доступны только при создании героя D&D 2014', 'CHARACTER_ROLL_UNAVAILABLE')
  }
  if (command.command_type === 'RollCharacterWealth') {
    if (!PHB_STARTING_WEALTH[command.character_class]) throw new CharacterLifecycleValidationError('Выберите класс PHB 2014', 'CHARACTER_CLASS_UNSUPPORTED')
    if (actor.characterCreationRolls?.wealth) throw new CharacterLifecycleValidationError('Стартовое богатство уже определено', 'CHARACTER_WEALTH_ALREADY_ROLLED')
    return { command_type: 'RollCharacterWealth', actor_id: actorId, target_id: actorId, target_ids: [actorId], character_class: command.character_class, visibility: 'party' }
  }
  if (actor.characterCreationRolls?.abilities) throw new CharacterLifecycleValidationError('Броски уже сохранены: распределите имеющиеся значения', 'CHARACTER_ABILITIES_ALREADY_ROLLED')
  return { command_type: 'RollCharacterAbilities', actor_id: actorId, target_id: actorId, target_ids: [actorId], source_rule_ids: [`${DND_2014_RULESET_ID}:resources:spending`], visibility: 'party' }
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
      ruleset_id: command.ruleset_id ?? LEGACY_DEFAULT_RULESET_ID,
      starter_equipment_policy_id: command.starter_equipment_policy_id ?? null,
      starter_equipment_policy_version: command.starter_equipment_policy_version ?? null,
      species_policy_version: command.species_policy_version ?? null,
      patch: clone(command.patch),
      ...(command.creation_result ? { phb_creation_result: clone(command.creation_result) } : {}),
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
    const eventRulesetId = String(payload.ruleset_id ?? next.ruleset_id ?? LEGACY_DEFAULT_RULESET_ID)
    if (payload.ruleset_id && next.ruleset_id && eventRulesetId !== String(next.ruleset_id)) {
      throw new CharacterLifecycleValidationError('Событие героя принадлежит другой редакции', 'IMPORT_RULESET_MISMATCH')
    }
    const parsed = parseCharacterImport({
      schema: payload.schema,
      schema_version: payload.schema_version,
      character: payload.patch,
    }, { allowLegacyAbilityPolicy: true, rulesetId: eventRulesetId, recordedCreation: payload.phb_creation_result })
    const wasCharacterSlot = actor.characterSetupRequired === true
    let speciesBenefits = parsed.patch.abilityGeneration
      ? speciesBenefitsFor(
          parsed.patch.abilityGeneration.speciesOptionId,
          eventRulesetId,
          parsed.patch.speciesChoices,
        )
      : null
    const speciesPolicyVersion = Math.max(1, Number(payload.species_policy_version ?? parsed.patch.abilityGeneration?.policyVersion) || 1)
    if (speciesBenefits && eventRulesetId === DND_2014_RULESET_ID && speciesPolicyVersion < 2) {
      speciesBenefits = {
        ...speciesBenefits,
        choices: {},
        skill_proficiencies: [],
        tool_proficiencies: [],
        innate_spells: [],
        mechanics: {},
        traits_supported: false,
      }
    }
    let updated = withBackgroundBenefits({
      ...actor,
      ...parsed.patch,
      ...(parsed.creation ? { creationBenefits: parsed.creation.benefits, creationSkillProficiencies: parsed.creation.additionalSkills, creationSpellGrants: parsed.creation.benefits.spell_grants } : {}),
      id: actor.id,
      inventory: clone(actor.inventory ?? []),
      currency: clone(actor.currency ?? {}),
      speciesBenefits,
      speciesSkillProficiencies: speciesBenefits?.skill_proficiencies ?? [],
      speciesToolProficiencies: speciesBenefits?.tool_proficiencies ?? [],
      speciesLanguages: speciesBenefits?.languages ?? [],
      speciesSpellIds: (speciesBenefits?.innate_spells ?? []).map((entry) => entry.id),
    }, eventRulesetId)
    if (wasCharacterSlot && parsed.creation?.wealth) {
      const currency = parsed.creation.wealth.remaining_currency
      updated.inventory = clone(parsed.creation.wealth.inventory)
      updated.currency = { gold: currency.gold, silver: currency.silver, copper: currency.copper, platinum: 0 }
      updated.initials = updated.character.slice(0, 2).toLocaleUpperCase('ru')
    } else if (wasCharacterSlot) {
      updated = withStarterKit({
        ...updated,
        inventory: [],
        currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
      }, {
        rulesetId: eventRulesetId,
        starterPolicyVersion: payload.starter_equipment_policy_version ?? 1,
      })
      updated.initials = updated.character.slice(0, 2).toLocaleUpperCase('ru')
    }
    const sheet = deriveCharacterSheet(updated)
    updated.maxHp = sheet.hit_points.value
    updated.hp = wasCharacterSlot
      ? sheet.hit_points.value
      : Math.min(Math.max(0, Number(actor.hp) || sheet.hit_points.value), sheet.hit_points.value)
    const targetLevel = characterCreationTargetLevel(next)
    updated.characterSetupRequired = wasCharacterSlot && targetLevel > normalizedLevel(updated.level)
    if (updated.characterSetupRequired) updated.characterSetupStage = 'leveling'
    else delete updated.characterSetupStage
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
    experience: integer(payload.experience, 'event.experience', { minimum: 0, maximum: MAX_EXPERIENCE, fallback: actor.experience ?? 0 }),
    hitPointIncreases: [...normalizedHitPointIncreases(actor, { level: previousLevel, hitDie: hitDieFor(actor) }), roll],
  }
  const hitPoints = deriveMaximumHitPoints(updated, { level: levelAfter })
  updated.maxHp = hitPoints.value
  updated.hp = payload.progression_source === 'character_creation'
    ? hitPoints.value
    : Math.min(Math.max(0, Number(updated.hp) || 0), hitPoints.value)
  if (payload.progression_source === 'character_creation') {
    const targetLevel = characterCreationTargetLevel(next)
    if (actor.characterSetupStage !== 'leveling' || levelAfter > targetLevel) {
      throw new CharacterLifecycleValidationError('Событие поэтапного создания героя вышло за пределы стартового уровня', 'CHARACTER_CREATION_LEVEL_INVALID')
    }
    updated.characterSetupRequired = levelAfter < targetLevel || !characterCreationChoicesComplete(updated)
    if (updated.characterSetupRequired) updated.characterSetupStage = 'leveling'
    else delete updated.characterSetupStage
  }
  next.players[index] = updated
  return next
}

const IMPORT_TOP_LEVEL_V1 = Object.freeze(['schema', 'schema_version', 'character'])
const IMPORT_CHARACTER_V1 = Object.freeze([
  'phbCreation',
  'character', 'name', 'role', 'characterClass', 'subclass', 'species', 'background', 'alignment',
  'traits', 'ideals', 'bonds', 'flaws', 'backstory', 'notes', 'level', 'experience', 'abilities',
  'abilityGeneration', 'baseSpeed', 'hitPointIncreases', 'classSkillProficiencies', 'selectedFeatureIds', 'knownSpellIds', 'preparedSpellIds',
  // Предыстория: только идентификатор и раскладка прибавок. Сами бонусы,
  // навыки и черта выводятся сервером из каталога и полем импорта не являются.
  'backgroundId', 'backgroundAbilityChoice', 'backgroundChoices', 'speciesChoices', 'starterEquipmentChoices',
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
  const rulesetId = options.rulesetId ?? LEGACY_DEFAULT_RULESET_ID
  const creationPolicy = characterCreationPolicyFor(rulesetId)
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
  let phb = null
  try {
    if (source.phbCreation && rulesetId !== DND_2014_RULESET_ID) throw new Error('Создание PHB требует редакцию 2014')
    phb = options.allowLegacyAbilityPolicy && options.recordedCreation ? clone(options.recordedCreation) : resolvePhbCreation(source)
    if (phb && source.phbCreation.equipmentMode === 'wealth' && !options.recordedCreation) {
      const roll = options.trustedWealthRoll
      if (!roll || roll.id !== source.phbCreation.wealthRollId) throw new Error('Нужен сохранённый серверный бросок стартового богатства этого героя')
      const purchases = source.phbCreation.purchases
      if (!Array.isArray(purchases) || purchases.length > 250) throw new Error('Покупки должны быть списком до 250 позиций')
      const result = resolveStartingPurchases(classId, roll, purchases)
      if (!result.ok) throw new Error(result.reason)
      phb.wealth = result
      phb.value.equipmentMode = 'wealth'
      phb.value.wealthRollId = roll.id
      phb.value.purchases = purchases.map((item) => ({ id: item.id, quantity: item.quantity }))
    }
  } catch (error) { throw new CharacterLifecycleValidationError(error.message, 'IMPORT_PHB_CHOICES_INVALID') }
  const abilityGeneration = validateAbilityGeneration(source.abilityGeneration, abilities, { ...options, rulesetId, additionalAbilityBonuses: phb?.abilityBonuses })
  const baseSpeed = integer(source.baseSpeed, 'character.baseSpeed', { minimum: 5, maximum: 120 })
  let derivedSpecies = ''
  let resolvedSpeciesBenefits = null
  if (abilityGeneration) {
    const speciesOption = speciesOptionFor(abilityGeneration.speciesOptionId, rulesetId)
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
    const rawSpeciesChoices = source.speciesChoices
      ?? defaultSpeciesChoices(speciesOption.id, rulesetId)
      ?? {}
    if (!isRecord(rawSpeciesChoices)) {
      throw new CharacterLifecycleValidationError('speciesChoices должен быть объектом', 'IMPORT_SPECIES_CHOICE_INVALID')
    }
    const resolvedChoices = resolveSpeciesChoices(speciesOption.id, rawSpeciesChoices, rulesetId)
    if (!resolvedChoices.ok) {
      throw new CharacterLifecycleValidationError(resolvedChoices.reason, 'IMPORT_SPECIES_CHOICE_INVALID')
    }
    source.speciesChoices = resolvedChoices.choices
    resolvedSpeciesBenefits = speciesBenefitsFor(speciesOption.id, rulesetId, resolvedChoices.choices)
  }
  const provisional = {
    ...(phb ? { creationBenefits: phb.benefits } : {}),
    character,
    characterClass: classId,
    level,
    experience,
    abilities,
    ...(abilityGeneration ? { abilityGeneration } : {}),
    baseSpeed,
    ...(source.subclass == null ? {} : { subclass: optionalText(source.subclass, 'character.subclass', 160) }),
    // Написание приводится к канону каталога сразу на входе — по той же
    // причине, что и в подготовке героя: сверка с канонической формой идёт
    // буквальной, и дефисный лист чужого экспорта читался бы как недоступный
    // выбор, хотя это те же самые навыки.
    classSkillProficiencies: [...new Set(uniqueIdentifiers(source.classSkillProficiencies ?? [], 'character.classSkillProficiencies').map(catalogSkillId))],
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
  delete canonical.creationBenefits
  if (phb) canonical.phbCreation = phb.value
  if (phb) {
    const rules = spellSelectionRulesFor({ ...provisional, abilities })
    const selected = phbFirstLevelSpells().filter((spell) => provisional.knownSpellIds.includes(spell.id))
    if (rules && selected.filter((spell) => spell.level === 0).length !== rules.cantrips) {
      throw new CharacterLifecycleValidationError(`Выберите ${rules.cantrips} классовых заговоров`, 'IMPORT_PHB_SPELL_COUNT_INVALID')
    }
    const expected = rules?.mode === 'known' ? rules.spellsKnown : rules?.mode === 'spellbook' ? rules.spellbookMinimum : null
    if (expected != null && selected.filter((spell) => spell.level === 1).length !== expected) {
      throw new CharacterLifecycleValidationError(`Выберите ${expected} известных заклинаний первого круга`, 'IMPORT_PHB_SPELL_COUNT_INVALID')
    }
  }
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
  if (abilityGeneration) canonical.speciesChoices = clone(source.speciesChoices ?? {})
  // Предыстория: клиент присылает только её идентификатор и раскладку прибавок,
  // всё остальное сервер берёт из каталога. Прибавки ложатся поверх стандартного
  // массива уже здесь, поэтому в лист уходит итоговая характеристика, а не
  // «база плюс обещание».
  const backgroundId = optionalText(source.backgroundId, 'character.backgroundId', 60)
  if (backgroundId) {
    let customization = null
    try { customization = resolveBackgroundCustomization(source.backgroundChoices?.customization) } catch (error) {
      throw new CharacterLifecycleValidationError(error.message, 'IMPORT_BACKGROUND_CUSTOM_INVALID')
    }
    if (customization && rulesetId !== DND_2014_RULESET_ID) throw new CharacterLifecycleValidationError('Настройка предыстории доступна только для PHB 2014', 'IMPORT_BACKGROUND_CUSTOM_INVALID')
    const background = backgroundById(backgroundId, rulesetId, customization)
    if (!background) {
      throw new CharacterLifecycleValidationError('Такой предыстории нет в каталоге', 'IMPORT_BACKGROUND_UNKNOWN')
    }
    const resolved = resolveBackgroundAbilityChoice(backgroundId, source.backgroundAbilityChoice ?? {}, rulesetId)
    if (!resolved.ok) {
      throw new CharacterLifecycleValidationError(resolved.reason, 'IMPORT_BACKGROUND_ABILITY_INVALID')
    }
    // Сами числа уже проверены versioned-политикой генерации характеристик:
    // она требует, чтобы итог равнялся стандартному массиву плюс объявленные
    // бонусы происхождения. Здесь остаётся сверить, что объявленные бонусы —
    // это именно бонусы выбранной предыстории, а не чужая раскладка под тем же
    // профилем.
    const declared = canonical.abilityGeneration?.originBonuses ?? {}
    const mismatch = creationPolicy.bonus_source === 'background'
      && ABILITY_IDS.some((ability) => (declared[ability] ?? 0) !== (resolved.bonuses[ability] ?? 0))
    if (mismatch) {
      throw new CharacterLifecycleValidationError(
        'Бонусы происхождения не совпадают с прибавками выбранной предыстории',
        'IMPORT_BACKGROUND_ABILITY_INVALID',
      )
    }
    canonical.backgroundId = background.id
    canonical.background = background.name
    if (creationPolicy.bonus_source === 'background') {
      canonical.backgroundAbilityChoice = { mode: resolved.mode, abilities: Object.keys(resolved.bonuses) }
    }
    const rawBackgroundChoices = source.backgroundChoices ?? defaultBackgroundChoices(backgroundId, rulesetId) ?? { tools: [], languages: [] }
    if (!isRecord(rawBackgroundChoices)) {
      throw new CharacterLifecycleValidationError('backgroundChoices должен быть объектом', 'IMPORT_BACKGROUND_CHOICE_INVALID')
    }
    exactKeys(rawBackgroundChoices, ['tools', 'languages', 'replacementSkills', 'replacementTools', 'customization'], 'character.backgroundChoices')
    const backgroundChoices = {
      ...(customization ? { customization } : {}),
      tools: uniqueIdentifiers(rawBackgroundChoices.tools ?? [], 'character.backgroundChoices.tools', { maximum: 4 }),
      languages: uniqueIdentifiers(rawBackgroundChoices.languages ?? [], 'character.backgroundChoices.languages', { maximum: 4 }),
    }
    const resolvedChoices = resolveBackgroundChoices(backgroundId, backgroundChoices, rulesetId)
    if (!resolvedChoices.ok) {
      throw new CharacterLifecycleValidationError(resolvedChoices.reason, 'IMPORT_BACKGROUND_CHOICE_INVALID')
    }
    canonical.backgroundChoices = { tools: resolvedChoices.tools, languages: resolvedChoices.languages, ...(customization ? { customization } : {}) }
    if (rulesetId === DND_2014_RULESET_ID && options.validateCreationLanguages
      && resolvedChoices.languages.some((id) => resolvedSpeciesBenefits?.languages.includes(id))) {
      throw new CharacterLifecycleValidationError('Язык предыстории уже известен от расы: выберите другой язык', 'IMPORT_LANGUAGE_DUPLICATE')
    }
    if (own(rawBackgroundChoices, 'replacementSkills')) {
      const skills = [
        ...canonical.classSkillProficiencies,
        ...(resolvedSpeciesBenefits?.skill_proficiencies ?? []),
        ...(phb?.additionalSkills ?? []),
        ...background.skillProficiencies,
      ].map(catalogSkillId)
      const known = new Set(skills)
      const count = rulesetId === DND_2014_RULESET_ID ? skills.length - known.size : 0
      const replacements = uniqueIdentifiers(rawBackgroundChoices.replacementSkills, 'character.backgroundChoices.replacementSkills').map(catalogSkillId)
      const allowed = new Set(classBuildCatalogInfo().skills.map((skill) => catalogSkillId(skill.id)))
      if (replacements.length !== count || new Set(replacements).size !== count
        || replacements.some((id) => !allowed.has(id) || known.has(id))) {
        throw new CharacterLifecycleValidationError(`Выберите ${count} новых навыков взамен повторяющихся владений`, 'IMPORT_SKILL_REPLACEMENT_INVALID')
      }
      canonical.backgroundChoices.replacementSkills = replacements
    }
    if (phb) canonical.backgroundChoices.replacementTools = clone(rawBackgroundChoices.replacementTools ?? [])
    // Навыки и черта здесь намеренно НЕ сохраняются: патч обязан пройти
    // обратно через тот же контракт импорта — его перечитывает reducer при
    // применении и replay, — а производные поля в контракт не входят и
    // роняли бы событие как «неподдерживаемые». Они выводятся из
    // `backgroundId` в `withBackgroundBenefits` при сборке героя.
  }
  const rawStarterChoices = source.starterEquipmentChoices
    ?? defaultStarterEquipmentChoices(classId, rulesetId)
    ?? {}
  if (!isRecord(rawStarterChoices)) {
    throw new CharacterLifecycleValidationError('starterEquipmentChoices должен быть объектом', 'IMPORT_STARTER_EQUIPMENT_INVALID')
  }
  const resolvedStarter = resolveStarterEquipmentChoices(classId, rawStarterChoices, rulesetId, { complete: Boolean(phb) })
  if (!resolvedStarter.ok) {
    throw new CharacterLifecycleValidationError(resolvedStarter.reason, 'IMPORT_STARTER_EQUIPMENT_INVALID')
  }
  if (phb && classId === 'cleric' && !phb.wealth) {
    for (const item of resolvedStarter.selected_options.flatMap((option) => option.items ?? [])) {
      if (item.catalog_id === 'srd_5_2_1:chain-mail' && !phb.benefits.armor_proficiencies.includes('heavy')) {
        throw new CharacterLifecycleValidationError('Кольчуга жрецу доступна в стартовом наборе только при владении тяжёлыми доспехами', 'IMPORT_STARTER_PROFICIENCY_REQUIRED')
      }
      if (item.catalog_id === 'srd_5_2_1:warhammer' && !phb.benefits.weapon_proficiencies.some((id) => ['martial', 'warhammer'].includes(id))) {
        throw new CharacterLifecycleValidationError('Для выбора боевого молота в стартовом наборе нужно владение им', 'IMPORT_STARTER_PROFICIENCY_REQUIRED')
      }
    }
  }
  if (phb) {
    try {
      canonical.phbCreation.backgroundEquipmentChoices = completeBackgroundChoicesForHero({ ...canonical, phbCreation: phb.value })
      const backgroundEquipment = validateCompleteBackgroundChoices(canonical.backgroundId, canonical.phbCreation.backgroundEquipmentChoices)
      if (!backgroundEquipment.ok) throw new Error(backgroundEquipment.reason)
      phb.benefits.owned_assets = phb.wealth ? clone(phb.wealth.owned_assets ?? []) : backgroundEquipment.selected_options.flatMap((option) => option.owned_assets ?? [])
    } catch (error) { throw new CharacterLifecycleValidationError(error.message, 'IMPORT_BACKGROUND_EQUIPMENT_INVALID') }
  }
  if (rulesetId !== LEGACY_DEFAULT_RULESET_ID) canonical.starterEquipmentChoices = clone(resolvedStarter.choices)
  const enriched = {
    ...(phb ? { creationBenefits: phb.benefits, creationSkillProficiencies: phb.additionalSkills, creationSpellGrants: phb.benefits.spell_grants } : {}),
    ...canonical,
    speciesBenefits: resolvedSpeciesBenefits,
    speciesSkillProficiencies: resolvedSpeciesBenefits?.skill_proficiencies ?? [],
    speciesToolProficiencies: resolvedSpeciesBenefits?.tool_proficiencies ?? [],
    speciesLanguages: resolvedSpeciesBenefits?.languages ?? [],
    speciesSpellIds: (resolvedSpeciesBenefits?.innate_spells ?? []).map((entry) => entry.id),
  }
  return {
    document,
    creation: phb,
    patch: canonical,
    sheet: deriveCharacterSheet(withBackgroundBenefits(enriched, rulesetId)),
  }
}
