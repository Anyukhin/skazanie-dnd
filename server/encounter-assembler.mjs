import { createHash } from 'node:crypto'
import { combatBoundsContain, combatBoundsUseful, computeCombatBounds } from './combat-bounds.mjs'
import { SIZE_CLASSES } from './tactical-map.mjs'

export const ENCOUNTER_PROPOSAL_VERSION = 'skazanie:encounter-proposal-v1'

export const ENCOUNTER_ASSEMBLER_LIMITS = Object.freeze({
  maximum_party_size: 8,
  // Предел клеток един для всей системы и живёт в классах размеров карты
  // (`server/tactical-map.mjs`). Раньше число 500 было продублировано в четырёх
  // местах и расходилось бы при первом же изменении.
  maximum_scene_cells: SIZE_CLASSES.region.maxCells,
  maximum_creatures_per_character: 2,
  maximum_creatures: 12,
  minimum_spawn_distance_cells: 2,
  maximum_seed_length: 120,
  maximum_actor_id_length: 120,
  minimum_character_level: 1,
  maximum_character_level: 20,
  minimum_coordinate: -1_000,
  maximum_coordinate: 1_000,
})

export const SRD_5_2_1_SOURCE = deepFreeze({
  title: 'System Reference Document 5.2.1',
  version: '5.2.1',
  published: '2025-05-01',
  url: 'https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf',
  landing_url: 'https://www.dndbeyond.com/srd',
  sha256: '8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87',
  license: 'CC-BY-4.0',
  attribution: 'This work includes material from the System Reference Document 5.2.1 (\u201cSRD 5.2.1\u201d) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.',
  encounter_budget_page: 202,
})

export const DND_SU_BESTIARY_SOURCE = deepFreeze({
  title: 'DnD.su — Бестиарий D&D 5',
  url: 'https://dnd.su/bestiary/',
  checked_at: '2026-07-13',
  role: 'Russian names, compact stat-block cross-checks and gallery references',
})

// Each entry is a server-owned projection of one SRD 5.2.1 stat block onto the
// combat fields currently supported by the rules engine. damageDice is the
// number of sides in the primary attack's single damage die.
export const SRD_5_2_1_MONSTER_ALLOWLIST = deepFreeze({
  'srd_5_2_1:goblin-minion': {
    name: 'Гоблин-налётчик', hp: 7, armor: 12, speed: 30, abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 4, damageBonus: 2,
    challenge_rating: '1/8', xp: 25, source_page: 290, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/4-goblin/', image: '/assets/enemies/goblin.jpg',
    traits: [{ id: 'nimble-escape', name: 'Ловкое бегство' }],
    action_profiles: [
      { id: 'scimitar', name: 'Скимитар', kind: 'melee', attack_modifier: 4, damage_expression: '1d4+2', damage_type: 'slashing', range_feet: 5 },
      { id: 'shortbow', name: 'Короткий лук', kind: 'ranged', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 320, normal_range_feet: 80 },
    ],
  },
  'srd_5_2_1:goblin-warrior': {
    name: 'Гоблин-воин', hp: 10, armor: 15, speed: 30, abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1/4', xp: 50, source_page: 290, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/4-goblin/', image: '/assets/enemies/goblin.jpg',
    traits: [{ id: 'nimble-escape', name: 'Ловкое бегство' }],
    action_profiles: [
      { id: 'scimitar', name: 'Скимитар', kind: 'melee', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'slashing', range_feet: 5 },
      { id: 'shortbow', name: 'Короткий лук', kind: 'ranged', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 320, normal_range_feet: 80 },
    ],
  },
  'srd_5_2_1:skeleton': {
    name: 'Скелет', hp: 13, armor: 14, speed: 30, abilities: { str: 10, dex: 16, con: 15, int: 6, wis: 8, cha: 5 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 6, damageBonus: 3,
    challenge_rating: '1/4', xp: 50, source_page: 325, creature_type: 'undead',
    source_url: 'https://dnd.su/bestiary/24-skeleton/', image: '/assets/enemies/skeleton.jpg',
    traits: [{ id: 'undead-nature', name: 'Природа нежити' }],
    action_profiles: [
      { id: 'shortsword', name: 'Короткий меч', kind: 'melee', attack_modifier: 5, damage_expression: '1d6+3', damage_type: 'piercing', range_feet: 5 },
      { id: 'shortbow', name: 'Короткий лук', kind: 'ranged', attack_modifier: 5, damage_expression: '1d6+3', damage_type: 'piercing', range_feet: 320, normal_range_feet: 80 },
    ],
  },
  'srd_5_2_1:zombie': {
    name: 'Зомби', hp: 15, armor: 8, speed: 20, abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
    initiative_bonus: -2, attackBonus: 3, damageDice: 8, damageBonus: 1,
    challenge_rating: '1/4', xp: 50, source_page: 343, creature_type: 'undead',
    source_url: 'https://dnd.su/bestiary/9-zombie/', image: '/assets/enemies/zombie.jpg',
    traits: [{ id: 'undead-fortitude', name: 'Стойкость нежити' }, { id: 'undead-nature', name: 'Природа нежити' }],
    action_profiles: [
      { id: 'slam', name: 'Размашистый удар', kind: 'melee', attack_modifier: 3, damage_expression: '1d8+1', damage_type: 'bludgeoning', range_feet: 5 },
    ],
  },
  'srd_5_2_1:wolf': {
    name: 'Волк', hp: 11, armor: 12, speed: 40, abilities: { str: 14, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1/4', xp: 50, source_page: 364, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/2-wolf/', image: '/assets/enemies/wolf.jpg',
    traits: [{ id: 'pack-tactics', name: 'Тактика стаи' }],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 5, on_hit: { save_ability: 'str', save_dc: 11, condition: 'prone', duration: 'until-next-turn' } },
    ],
  },
  'srd_5_2_1:giant-rat': {
    name: 'Гигантская крыса', hp: 7, armor: 13, speed: 30, abilities: { str: 7, dex: 16, con: 11, int: 2, wis: 10, cha: 4 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 4, damageBonus: 3,
    challenge_rating: '1/8', xp: 25, source_page: 296, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/336-giant-rat/', image: '/assets/enemies/giant-rat.jpg',
    traits: [{ id: 'pack-tactics', name: 'Тактика стаи' }],
    action_profiles: [{ id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 5, damage_expression: '1d4+3', damage_type: 'piercing', range_feet: 5 }],
  },
  'srd_5_2_1:giant-wolf-spider': {
    name: 'Гигантский паук-волк', hp: 11, armor: 13, speed: 40, abilities: { str: 12, dex: 16, con: 13, int: 3, wis: 12, cha: 4 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 4, damageBonus: 3,
    challenge_rating: '1/4', xp: 50, source_page: 305, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/358-giant-wolf-spider/', image: '/assets/enemies/giant-wolf-spider.png',
    traits: [{ id: 'spider-climb', name: 'Паучье лазание' }, { id: 'web-walker', name: 'Хождение по паутине' }],
    action_profiles: [{ id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 5, damage_expression: '1d4+3', damage_type: 'piercing', range_feet: 5, on_hit: { save_ability: 'con', save_dc: 11, damage_expression: '2d4', damage_type: 'poison', half_on_save: true } }],
  },
  'srd_5_2_1:giant-spider': {
    name: 'Гигантский паук', hp: 26, armor: 14, speed: 30, abilities: { str: 14, dex: 16, con: 12, int: 2, wis: 11, cha: 4 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 8, damageBonus: 3,
    challenge_rating: '1', xp: 200, source_page: 305, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/3-giant-spider/', image: '/assets/enemies/giant-spider.jpg',
    traits: [{ id: 'spider-climb', name: 'Паучье лазание' }, { id: 'web-walker', name: 'Хождение по паутине' }],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 5, damage_expression: '1d8+3', damage_type: 'piercing', range_feet: 5, on_hit: { save_ability: 'con', save_dc: 11, damage_expression: '2d8', damage_type: 'poison', half_on_save: true } },
      { id: 'web', name: 'Паутина', kind: 'ranged', attack_modifier: 5, damage_amount: 0, damage_type: 'untyped', range_feet: 60, normal_range_feet: 30, on_hit: { condition: 'restrained', duration: 'until-next-turn' }, uses: 1, tactical_priority: 8 },
    ],
  },
  'srd_5_2_1:orc': {
    name: 'Орк', hp: 15, armor: 13, speed: 30, abilities: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 },
    initiative_bonus: 1, attackBonus: 5, damageDice: 12, damageBonus: 3,
    challenge_rating: '1/2', xp: 100, source_page: 315, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/20-orc/', image: '/assets/enemies/orc.jpg',
    traits: [{ id: 'aggressive', name: 'Агрессивный' }],
    action_profiles: [
      { id: 'greataxe', name: 'Секира', kind: 'melee', attack_modifier: 5, damage_expression: '1d12+3', damage_type: 'slashing', range_feet: 5 },
      { id: 'javelin', name: 'Метательное копьё', kind: 'ranged', attack_modifier: 5, damage_expression: '1d6+3', damage_type: 'piercing', range_feet: 120, normal_range_feet: 30 },
    ],
  },
  'srd_5_2_1:hobgoblin': {
    name: 'Хобгоблин', hp: 11, armor: 18, speed: 30, abilities: { str: 13, dex: 12, con: 12, int: 10, wis: 10, cha: 9 },
    initiative_bonus: 1, attackBonus: 3, damageDice: 8, damageBonus: 1,
    challenge_rating: '1/2', xp: 100, source_page: 295, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/27-hobgoblin/', image: '/assets/enemies/hobgoblin.jpg',
    traits: [{ id: 'martial-advantage', name: 'Воинское превосходство', damage_expression: '2d6' }],
    action_profiles: [
      { id: 'longsword', name: 'Длинный меч', kind: 'melee', attack_modifier: 3, damage_expression: '1d8+1', damage_type: 'slashing', range_feet: 5 },
      { id: 'longbow', name: 'Длинный лук', kind: 'ranged', attack_modifier: 3, damage_expression: '1d8+1', damage_type: 'piercing', range_feet: 600, normal_range_feet: 150 },
    ],
  },
  'srd_5_2_1:kobold': {
    name: 'Кобольд', hp: 5, armor: 12, speed: 30, abilities: { str: 7, dex: 15, con: 9, int: 8, wis: 7, cha: 8 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 4, damageBonus: 2,
    challenge_rating: '1/8', xp: 25, source_page: 299, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/210-kobold/', image: '/assets/enemies/kobold.jpg',
    traits: [{ id: 'pack-tactics', name: 'Тактика стаи' }],
    action_profiles: [
      { id: 'dagger', name: 'Кинжал', kind: 'melee', attack_modifier: 4, damage_expression: '1d4+2', damage_type: 'piercing', range_feet: 5 },
      { id: 'sling', name: 'Праща', kind: 'ranged', attack_modifier: 4, damage_expression: '1d4+2', damage_type: 'bludgeoning', range_feet: 120, normal_range_feet: 30 },
    ],
  },
  'srd_5_2_1:bugbear': {
    name: 'Багбир', hp: 27, armor: 16, speed: 30, abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 11, cha: 9 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 8, damageBonus: 2,
    challenge_rating: '1', xp: 200, source_page: 282, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/13-bugbear/', image: '/assets/enemies/bugbear.jpg',
    traits: [{ id: 'surprise-attack', name: 'Внезапная атака', damage_expression: '2d6' }],
    action_profiles: [
      { id: 'morningstar', name: 'Моргенштерн', kind: 'melee', attack_modifier: 4, damage_expression: '2d8+2', damage_type: 'piercing', range_feet: 5 },
      { id: 'javelin', name: 'Метательное копьё', kind: 'ranged', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 120, normal_range_feet: 30 },
    ],
  },
})

const THEMES = deepFreeze({
  goblinoids: ['srd_5_2_1:goblin-minion', 'srd_5_2_1:goblin-warrior', 'srd_5_2_1:hobgoblin', 'srd_5_2_1:kobold', 'srd_5_2_1:bugbear'],
  undead: ['srd_5_2_1:skeleton', 'srd_5_2_1:zombie'],
  beasts: ['srd_5_2_1:wolf', 'srd_5_2_1:giant-rat', 'srd_5_2_1:giant-wolf-spider', 'srd_5_2_1:giant-spider'],
  raiders: ['srd_5_2_1:orc', 'srd_5_2_1:goblin-warrior', 'srd_5_2_1:hobgoblin', 'srd_5_2_1:bugbear'],
  generic: Object.keys(SRD_5_2_1_MONSTER_ALLOWLIST),
})

export const ENCOUNTER_THEMES = Object.freeze(Object.keys(THEMES))
export const ENCOUNTER_DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard'])
const SRD_DIFFICULTY = Object.freeze({ easy: 'low', medium: 'moderate', hard: 'high' })

// SRD 5.2.1, printed page 202: XP Budget per Character.
const XP_BUDGET_PER_CHARACTER = deepFreeze({
  1: { low: 50, moderate: 75, high: 100 },
  2: { low: 100, moderate: 150, high: 200 },
  3: { low: 150, moderate: 225, high: 400 },
  4: { low: 250, moderate: 375, high: 500 },
  5: { low: 500, moderate: 750, high: 1_100 },
  6: { low: 600, moderate: 1_000, high: 1_400 },
  7: { low: 750, moderate: 1_300, high: 1_700 },
  8: { low: 1_000, moderate: 1_700, high: 2_100 },
  9: { low: 1_300, moderate: 2_000, high: 2_600 },
  10: { low: 1_600, moderate: 2_300, high: 3_100 },
  11: { low: 1_900, moderate: 2_900, high: 4_100 },
  12: { low: 2_200, moderate: 3_700, high: 4_700 },
  13: { low: 2_600, moderate: 4_200, high: 5_400 },
  14: { low: 2_900, moderate: 4_900, high: 6_200 },
  15: { low: 3_300, moderate: 5_400, high: 7_800 },
  16: { low: 3_800, moderate: 6_100, high: 9_800 },
  17: { low: 4_500, moderate: 7_200, high: 11_700 },
  18: { low: 5_000, moderate: 8_700, high: 14_200 },
  19: { low: 5_500, moderate: 10_700, high: 17_200 },
  20: { low: 6_400, moderate: 13_200, high: 22_000 },
})

const TOP_LEVEL_KEYS = new Set(['scene', 'party', 'difficulty', 'theme', 'seed'])
const SCENE_KEYS = new Set(['cells'])
// `occupied` появился в M0: раньше занятость клетки существом выражалась
// записью сущности в `feature`, а после разделения слоёв её нужно передавать
// явно, иначе двух противников можно поставить в одну клетку.
const CELL_KEYS = new Set(['x', 'y', 'type', 'revealed', 'feature', 'occupied'])
const PARTY_MEMBER_KEYS = new Set(['id', 'level', 'x', 'y'])
const CELL_TYPES = new Set(['wall', 'floor', 'water', 'door'])
// Shared server-owned map props are obstacles, not client-defined mechanics.
const CELL_FEATURES = new Set([
  'chest', 'altar', 'torch', 'rune', 'stairs', 'enemy', 'bed', 'table', 'chair', 'fireplace', 'bookshelf',
  'barrel', 'crate', 'rock', 'mushroom', 'bones', 'campfire', 'grave', 'pillar', 'statue', 'tree', 'bush', 'wagon', 'well', 'console',
])
const WALKABLE_TYPES = new Set(['floor', 'door'])

export class EncounterAssemblyError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'EncounterAssemblyError'
    this.code = code
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejectUnexpectedKeys(value, allowed, code) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new EncounterAssemblyError('Вход содержит поле, не разрешённое контрактом сборщика столкновения', code)
  }
}

function boundedText(value, maximum, code, label) {
  if (typeof value !== 'string') throw new EncounterAssemblyError(`${label} должен быть строкой`, code)
  const result = value.trim()
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new EncounterAssemblyError(`${label} не прошёл проверку границ`, code)
  }
  return result
}

function coordinate(value, code, label) {
  if (!Number.isSafeInteger(value)
    || value < ENCOUNTER_ASSEMBLER_LIMITS.minimum_coordinate
    || value > ENCOUNTER_ASSEMBLER_LIMITS.maximum_coordinate) {
    throw new EncounterAssemblyError(`${label} должен быть целым числом в разрешённых границах`, code)
  }
  return value
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function positionKey(value) {
  return `${value.x},${value.y}`
}

function validateScene(input) {
  if (!isPlainObject(input)) throw new EncounterAssemblyError('scene должен быть объектом', 'INVALID_SCENE')
  rejectUnexpectedKeys(input, SCENE_KEYS, 'UNEXPECTED_SCENE_FIELD')
  if (!Array.isArray(input.cells) || input.cells.length < 1 || input.cells.length > ENCOUNTER_ASSEMBLER_LIMITS.maximum_scene_cells) {
    throw new EncounterAssemblyError('scene.cells должен быть непустым ограниченным массивом', 'INVALID_SCENE_CELLS')
  }

  const seen = new Set()
  const cells = Array.from(input.cells, (entry) => {
    if (!isPlainObject(entry)) throw new EncounterAssemblyError('Клетка сцены должна быть объектом', 'INVALID_SCENE_CELL')
    rejectUnexpectedKeys(entry, CELL_KEYS, 'UNEXPECTED_SCENE_CELL_FIELD')
    const x = coordinate(entry.x, 'INVALID_SCENE_CELL_COORDINATE', 'cell.x')
    const y = coordinate(entry.y, 'INVALID_SCENE_CELL_COORDINATE', 'cell.y')
    if (typeof entry.type !== 'string' || !CELL_TYPES.has(entry.type)) {
      throw new EncounterAssemblyError('Неизвестный тип клетки', 'SCENE_CELL_TYPE_NOT_ALLOWED')
    }
    if (typeof entry.revealed !== 'boolean') {
      throw new EncounterAssemblyError('cell.revealed должен быть boolean', 'INVALID_SCENE_CELL_VISIBILITY')
    }
    if (entry.feature != null && (typeof entry.feature !== 'string' || !CELL_FEATURES.has(entry.feature))) {
      throw new EncounterAssemblyError('Неизвестный объект в клетке', 'SCENE_CELL_FEATURE_NOT_ALLOWED')
    }
    if (entry.occupied != null && typeof entry.occupied !== 'boolean') {
      throw new EncounterAssemblyError('cell.occupied должен быть boolean', 'INVALID_SCENE_CELL_OCCUPANCY')
    }
    const key = `${x},${y}`
    if (seen.has(key)) throw new EncounterAssemblyError('Координаты клеток не должны повторяться', 'DUPLICATE_SCENE_CELL')
    seen.add(key)
    return {
      x,
      y,
      type: entry.type,
      revealed: entry.revealed,
      ...(entry.feature == null ? {} : { feature: entry.feature }),
      ...(entry.occupied === true ? { occupied: true } : {}),
    }
  })
  cells.sort((left, right) => left.y - right.y || left.x - right.x)
  return cells
}

function validateParty(input, cells) {
  if (!Array.isArray(input) || input.length < 1 || input.length > ENCOUNTER_ASSEMBLER_LIMITS.maximum_party_size) {
    throw new EncounterAssemblyError('party должен быть непустым ограниченным массивом', 'INVALID_PARTY')
  }
  const cellsByPosition = new Map(cells.map((cell) => [positionKey(cell), cell]))
  const ids = new Set()
  const positions = new Set()
  const party = Array.from(input, (entry) => {
    if (!isPlainObject(entry)) throw new EncounterAssemblyError('Участник группы должен быть объектом', 'INVALID_PARTY_MEMBER')
    rejectUnexpectedKeys(entry, PARTY_MEMBER_KEYS, 'UNEXPECTED_PARTY_MEMBER_FIELD')
    const id = boundedText(entry.id, ENCOUNTER_ASSEMBLER_LIMITS.maximum_actor_id_length, 'INVALID_PARTY_MEMBER_ID', 'party.id')
    if (ids.has(id)) throw new EncounterAssemblyError('ID участников группы не должны повторяться', 'DUPLICATE_PARTY_MEMBER_ID')
    ids.add(id)
    if (!Number.isSafeInteger(entry.level)
      || entry.level < ENCOUNTER_ASSEMBLER_LIMITS.minimum_character_level
      || entry.level > ENCOUNTER_ASSEMBLER_LIMITS.maximum_character_level) {
      throw new EncounterAssemblyError('Уровень персонажа вне разрешённых границ', 'PARTY_LEVEL_OUT_OF_RANGE')
    }
    const x = coordinate(entry.x, 'INVALID_PARTY_MEMBER_COORDINATE', 'party.x')
    const y = coordinate(entry.y, 'INVALID_PARTY_MEMBER_COORDINATE', 'party.y')
    const key = `${x},${y}`
    const cell = cellsByPosition.get(key)
    if (!cell || !cell.revealed || !WALKABLE_TYPES.has(cell.type)) {
      throw new EncounterAssemblyError('Персонаж должен находиться на открытой проходимой клетке', 'PARTY_POSITION_NOT_WALKABLE')
    }
    if (positions.has(key)) throw new EncounterAssemblyError('Два персонажа не могут занимать одну клетку', 'DUPLICATE_PARTY_POSITION')
    positions.add(key)
    return { id, level: entry.level, x, y }
  })
  party.sort((left, right) => left.id.localeCompare(right.id))
  return party
}

function validateInput(input) {
  if (!isPlainObject(input)) throw new EncounterAssemblyError('Вход сборщика должен быть объектом', 'INVALID_ENCOUNTER_INPUT')
  rejectUnexpectedKeys(input, TOP_LEVEL_KEYS, 'UNEXPECTED_ENCOUNTER_FIELD')
  const cells = validateScene(input.scene)
  const party = validateParty(input.party, cells)
  if (typeof input.difficulty !== 'string' || !ENCOUNTER_DIFFICULTIES.includes(input.difficulty)) {
    throw new EncounterAssemblyError('Неизвестная сложность столкновения', 'ENCOUNTER_DIFFICULTY_NOT_ALLOWED')
  }
  if (typeof input.theme !== 'string' || !Object.hasOwn(THEMES, input.theme)) {
    throw new EncounterAssemblyError('Неизвестная тема столкновения', 'ENCOUNTER_THEME_NOT_ALLOWED')
  }
  const seed = boundedText(input.seed, ENCOUNTER_ASSEMBLER_LIMITS.maximum_seed_length, 'INVALID_ENCOUNTER_SEED', 'seed')
  return { cells, party, difficulty: input.difficulty, theme: input.theme, seed }
}

/**
 * Габарит сетки по списку клеток. Сборщик получает клетки, а не `TacticalMap`,
 * поэтому размер поля он выводит из них: подрайон боя считается от него.
 * Сетка со сдвинутым началом (отрицательные координаты) не поддерживается —
 * тогда подрайон не считается вовсе и расстановка остаётся прежней.
 */
function gridExtent(cells) {
  let width = 0
  let height = 0
  for (const cell of cells) {
    if (cell.x < 0 || cell.y < 0) return null
    width = Math.max(width, cell.x + 1)
    height = Math.max(height, cell.y + 1)
  }
  return width && height ? { width, height } : null
}

/**
 * Подрайон боя вокруг отряда (`docs/tactical-map-plan.md`, раздел 11.4).
 *
 * Противник обязан появиться внутри него. На карте 100×100 клетка «где-нибудь»
 * — это до двадцати ходов ходьбы: половина отряда несколько ходов идёт к
 * противнику, и боя не происходит. Запас вокруг отряда берётся общий, из
 * `server/combat-bounds.mjs`, чтобы расстановка и подрайон, который поставит
 * `CombatStarted`, считались по одному правилу.
 *
 * Это **не** невидимая стена: подрайон ограничивает только точку появления.
 * Уже начавшийся бой выпускает участников за границу и раздвигает её.
 *
 * `combat-bounds.mjs` читает у карты только размеры, поэтому габарита сетки ему
 * достаточно.
 *
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 *   null — карта слишком мала, чтобы подрайон что-то значил; расстановка идёт
 *   по всей сцене, как раньше
 */
function spawnBounds(cells, party) {
  const extent = gridExtent(cells)
  if (!extent || !combatBoundsUseful(extent)) return null
  return computeCombatBounds(extent, party)
}

function safePlacementCells(cells, party, bounds = null) {
  const occupied = new Set(party.map(positionKey))
  const walkable = new Map(cells
    .filter((cell) => cell.revealed && WALKABLE_TYPES.has(cell.type))
    .map((cell) => [positionKey(cell), cell]))
  const reachable = new Set()
  const queue = party.flatMap((member) => walkable.has(positionKey(member)) ? [walkable.get(positionKey(member))] : [])
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const key = positionKey(current)
    if (reachable.has(key)) continue
    reachable.add(key)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = walkable.get(`${current.x + dx},${current.y + dy}`)
      if (neighbor && !reachable.has(positionKey(neighbor))) queue.push(neighbor)
    }
  }
  return cells.filter((cell) => (
    combatBoundsContain(bounds, cell.x, cell.y)
    && cell.revealed
    && WALKABLE_TYPES.has(cell.type)
    && reachable.has(positionKey(cell))
    && cell.feature == null
    && cell.occupied !== true
    && !occupied.has(positionKey(cell))
    && party.every((member) => (
      Math.abs(member.x - cell.x) + Math.abs(member.y - cell.y)
      >= ENCOUNTER_ASSEMBLER_LIMITS.minimum_spawn_distance_cells
    ))
  ))
}

function seededTieBreak(left, right, seed) {
  const leftKey = digest(`${seed}\u0000${left.join('|')}`)
  const rightKey = digest(`${seed}\u0000${right.join('|')}`)
  return leftKey.localeCompare(rightKey) < 0 ? left : right
}

function spendBudget(catalogIds, budgetXp, quantityCap, seed) {
  let states = new Map([[0, []]])
  for (let count = 0; count < quantityCap; count += 1) {
    const next = new Map(states)
    for (const [spent, selection] of states) {
      if (selection.length !== count) continue
      for (const catalogId of catalogIds) {
        const nextSpent = spent + SRD_5_2_1_MONSTER_ALLOWLIST[catalogId].xp
        if (nextSpent > budgetXp) continue
        const candidate = [...selection, catalogId].sort()
        const current = next.get(nextSpent)
        if (!current || current.length > candidate.length) next.set(nextSpent, candidate)
        else if (current.length === candidate.length) next.set(nextSpent, seededTieBreak(current, candidate, seed))
      }
    }
    states = next
  }
  const spentXp = Math.max(...states.keys())
  return { spent_xp: spentXp, stat_block_ids: states.get(spentXp) ?? [] }
}

function deterministicOrder(values, seed, label) {
  return [...values].sort((left, right) => {
    const leftKey = `${left.x},${left.y}`
    const rightKey = `${right.x},${right.y}`
    const leftHash = digest(`${seed}\u0000${label}\u0000${leftKey}`)
    const rightHash = digest(`${seed}\u0000${label}\u0000${rightKey}`)
    return leftHash.localeCompare(rightHash) || leftKey.localeCompare(rightKey)
  })
}

function enemyFrom(statBlockId, position, proposalHash, index, ordinal) {
  const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
  const slug = statBlockId.split(':').at(-1)
  return {
    id: `encounter-${proposalHash.slice(0, 16)}-${slug}-${index + 1}`.slice(0, 120),
    name: `${block.name} ${ordinal}`,
    hp: block.hp,
    maxHp: block.hp,
    armor: block.armor,
    speed: block.speed,
    initiativeBonus: block.initiative_bonus,
    attackBonus: block.attackBonus,
    damageDice: block.damageDice,
    damageBonus: block.damageBonus,
    abilities: cloneCatalogValue(block.abilities ?? {}),
    creature_type: block.creature_type,
    image: block.image,
    source_url: block.source_url,
    traits: cloneCatalogValue(block.traits ?? []),
    action_profiles: cloneCatalogValue(block.action_profiles ?? []),
    attack_profile: cloneCatalogValue(block.action_profiles?.[0] ?? {}),
    x: position.x,
    y: position.y,
    alive: true,
    stat_block_id: statBlockId,
    provenance: {
      kind: 'server-owned-srd-primary-attack-projection',
      ruleset_id: 'srd_5_2_1',
      source_version: SRD_5_2_1_SOURCE.version,
      source_sha256: SRD_5_2_1_SOURCE.sha256,
      source_page: block.source_page,
      challenge_rating: block.challenge_rating,
      xp: block.xp,
      dndsu_url: block.source_url,
    },
  }
}

function cloneCatalogValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

export class EncounterAssembler {
  assemble(input) {
    const validated = validateInput(input)
    const canonical = JSON.stringify(validated)
    const proposalHash = digest(`${ENCOUNTER_PROPOSAL_VERSION}\u0000${canonical}`)
    // Подрайон боя выводится из уже проверенного входа, а не принимается извне:
    // иначе клетку появления можно было бы подсказать запросом.
    const bounds = spawnBounds(validated.cells, validated.party)
    const availableCells = safePlacementCells(validated.cells, validated.party, bounds)
    if (!availableCells.length) {
      throw new EncounterAssemblyError('Нет безопасных клеток для размещения противников', 'NO_SAFE_PLACEMENT_CELLS')
    }

    const budgetXp = validated.party.reduce((sum, member) => (
      sum + XP_BUDGET_PER_CHARACTER[member.level][SRD_DIFFICULTY[validated.difficulty]]
    ), 0)
    const quantityCap = Math.min(
      ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures,
      ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures_per_character * validated.party.length,
      availableCells.length,
    )
    const allocation = spendBudget(THEMES[validated.theme], budgetXp, quantityCap, proposalHash)
    if (!allocation.stat_block_ids.length) {
      throw new EncounterAssemblyError('Бюджет не позволяет собрать столкновение выбранной темы', 'BUDGET_CANNOT_FUND_ENCOUNTER')
    }

    const positions = deterministicOrder(availableCells, proposalHash, 'placement')
    const counts = new Map()
    const enemies = allocation.stat_block_ids.map((statBlockId, index) => {
      const ordinal = (counts.get(statBlockId) ?? 0) + 1
      counts.set(statBlockId, ordinal)
      return enemyFrom(statBlockId, positions[index], proposalHash, index, ordinal)
    })
    const spentXp = allocation.spent_xp
    const proposal = {
      proposal_id: `encounter-proposal-${proposalHash.slice(0, 24)}`,
      version: ENCOUNTER_PROPOSAL_VERSION,
      difficulty: validated.difficulty,
      theme: validated.theme,
      xp_budget: budgetXp,
      xp_spent: spentXp,
      threat: {
        budget_xp: budgetXp,
        spent_xp: spentXp,
        unspent_xp: budgetXp - spentXp,
        utilization_bps: Math.floor(spentXp * 10_000 / budgetXp),
        quantity: enemies.length,
        quantity_cap: quantityCap,
      },
      enemies,
      source: SRD_5_2_1_SOURCE,
    }
    return deepFreeze(proposal)
  }
}

export function assembleEncounter(input) {
  return new EncounterAssembler().assemble(input)
}
