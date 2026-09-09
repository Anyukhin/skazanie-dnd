import { getRoom, listRoomCodes } from './store.mjs'
import { loadDndsu2014Content } from './dndsu-2014-content.mjs'
import { normalizeCampaignState } from './rules-engine.mjs'
import { deserializeTacticalMap, reachableCells, cellAt, legacyCellsFromTacticalMap, serializeTacticalMap, tacticalMapFromLegacyCells } from './tactical-map.mjs'
import { starterEquipmentCatalogFor, withStarterKit } from './starter-kit.mjs'
import { enemyFrom2014, monsterCatalogEntry } from './combat-lab-monsters.mjs'
import { COMBAT_LAB_MAPS } from './combat-lab-maps.mjs'
import {
  COMBAT_LAB_ENCOUNTER_DIFFICULTIES,
  COMBAT_LAB_RULES_SOURCE_2014,
  assessEncounterRoster,
  challengeRatingValue,
  selectEncounterRoster,
} from './combat-lab-encounter-math.mjs'

export const COMBAT_LAB_RULESET = Object.freeze({
  id: 'dnd_5e_2014',
  version: '2014.1.0',
  enabled_rule_packs: ['dnd_5e_2014'],
})

export const COMBAT_LAB_LIMITS = Object.freeze({ party: 6, enemies: 12 })

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha']
const CLASS_NAMES = Object.freeze({
  barbarian: 'Варвар', bard: 'Бард', cleric: 'Жрец', druid: 'Друид', fighter: 'Воин', monk: 'Монах',
  paladin: 'Паладин', ranger: 'Следопыт', rogue: 'Плут', sorcerer: 'Чародей', warlock: 'Колдун', wizard: 'Волшебник',
})
const CLASS_PRIMARY = Object.freeze({
  barbarian: 'str', bard: 'cha', cleric: 'wis', druid: 'wis', fighter: 'str', monk: 'dex',
  paladin: 'str', ranger: 'dex', rogue: 'dex', sorcerer: 'cha', warlock: 'cha', wizard: 'int',
})
const CLASS_HIT_DICE = Object.freeze({
  barbarian: 12, bard: 8, cleric: 8, druid: 8, fighter: 10, monk: 8,
  paladin: 10, ranger: 10, rogue: 8, sorcerer: 6, warlock: 8, wizard: 6,
})
const CLASS_WEAPONS = Object.freeze({
  barbarian: { dice: 12, bonus: 3, type: 'slashing', armor: 15 },
  bard: { dice: 8, bonus: 2, type: 'slashing', armor: 14 },
  cleric: { dice: 8, bonus: 2, type: 'bludgeoning', armor: 16 },
  druid: { dice: 6, bonus: 2, type: 'bludgeoning', armor: 14 },
  fighter: { dice: 8, bonus: 3, type: 'slashing', armor: 18 },
  monk: { dice: 6, bonus: 3, type: 'bludgeoning', armor: 16 },
  paladin: { dice: 8, bonus: 3, type: 'slashing', armor: 18 },
  ranger: { dice: 8, bonus: 3, type: 'piercing', armor: 16 },
  rogue: { dice: 8, bonus: 3, type: 'piercing', armor: 14 },
  sorcerer: { dice: 6, bonus: 1, type: 'fire', armor: 12 },
  warlock: { dice: 10, bonus: 2, type: 'force', armor: 13 },
  wizard: { dice: 6, bonus: 1, type: 'fire', armor: 12 },
})
const CLASS_SPELLS = Object.freeze({
  bard: [{ level: 1, ids: ['vicious-mockery', 'healing-word'] }, { level: 3, ids: ['dissonant-whispers', 'shatter'] }],
  cleric: [{ level: 1, ids: ['sacred-flame', 'bless', 'healing-word'] }, { level: 3, ids: ['spiritual-weapon', 'cure-wounds'] }, { level: 5, ids: ['spirit-guardians'] }],
  druid: [{ level: 1, ids: ['produce-flame', 'entangle', 'healing-word'] }, { level: 3, ids: ['moonbeam'] }, { level: 5, ids: ['call-lightning'] }],
  paladin: [{ level: 2, ids: ['bless', 'cure-wounds', 'shield-of-faith'] }],
  ranger: [{ level: 2, ids: ['hunters-mark', 'cure-wounds'] }],
  sorcerer: [{ level: 1, ids: ['fire-bolt', 'magic-missile', 'shield'] }, { level: 3, ids: ['scorching-ray'] }, { level: 5, ids: ['fireball', 'counterspell'] }],
  warlock: [{ level: 1, ids: ['eldritch-blast', 'hex'] }, { level: 3, ids: ['misty-step'] }, { level: 5, ids: ['counterspell'] }],
  wizard: [{ level: 1, ids: ['fire-bolt', 'magic-missile', 'shield'] }, { level: 3, ids: ['scorching-ray'] }, { level: 5, ids: ['fireball', 'counterspell'] }],
})

class CombatLabSetupError extends Error {
  constructor(message, code = 'INVALID_COMBAT_LAB_CONFIG') {
    super(message)
    this.name = 'CombatLabSetupError'
    this.code = code
    this.status = 400
  }
}

function clone(value) {
  return structuredClone(value)
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CombatLabSetupError(`${label} должен быть объектом`)
}

function assertAllowedFields(value, fields, label) {
  const allowed = new Set(fields)
  for (const key of Object.keys(value)) if (!allowed.has(key)) {
    throw new CombatLabSetupError(`Поле ${label}.${key} запрещено`, 'UNEXPECTED_COMBAT_LAB_FIELD')
  }
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CombatLabSetupError(`${label} должен быть целым числом ${min}..${max}`, 'INVALID_COMBAT_LAB_VALUE')
  }
  return value
}

function classCatalog() {
  const catalog = starterEquipmentCatalogFor(COMBAT_LAB_RULESET.id)
  return (catalog?.classes ?? []).map((entry) => ({
    id: String(entry.class_id),
    name: CLASS_NAMES[entry.class_id] || String(entry.class_id),
  })).sort((left, right) => Number(left.id !== 'fighter') - Number(right.id !== 'fighter') || left.id.localeCompare(right.id))
}

let contentPromise
async function content() {
  contentPromise ??= loadDndsu2014Content()
  return contentPromise
}

function mapCells(map) {
  return legacyCellsFromTacticalMap(map).map((raw) => {
    const cell = cellAt(map, raw.x, raw.y)
    return {
      x: raw.x,
      y: raw.y,
      type: raw.type,
      ...(cell?.moveCost > 1 ? { difficult: true } : {}),
    }
  })
}

const MAPS = COMBAT_LAB_MAPS

const MAP_BY_ID = new Map(MAPS.map((map) => [map.id, map]))

export const COMBAT_LAB_ENCOUNTER_THEMES = Object.freeze([
  'generic', 'goblinoids', 'undead', 'beasts', 'raiders', 'cultists', 'dragons', 'dungeon',
])

const COMBAT_LAB_ENCOUNTER_THEME_NAMES = Object.freeze({
  generic: 'Любые существа',
  goblinoids: 'Гоблиноиды',
  undead: 'Нежить',
  beasts: 'Звери',
  raiders: 'Разбойники и воины',
  cultists: 'Культ и магия',
  dragons: 'Драконы',
  dungeon: 'Подземелье',
})

const COMBAT_LAB_ENCOUNTER_DIFFICULTY_NAMES = Object.freeze({
  trivial: 'ниже лёгкой', easy: 'лёгкой', medium: 'средней', hard: 'тяжёлой', deadly: 'смертельной',
})

const ENCOUNTER_THEME_ALIASES = Object.freeze({
  generic: 'generic',
  goblin: 'goblinoids',
  goblinoids: 'goblinoids',
  undead: 'undead',
  beasts: 'beasts',
  beast: 'beasts',
  raiders: 'raiders',
  humanoids: 'raiders',
  cult: 'cultists',
  cultists: 'cultists',
  dragons: 'dragons',
  dragon: 'dragons',
  dungeon: 'dungeon',
})

function standardAbilities(classId) {
  const abilities = { str: 13, dex: 12, con: 14, int: 10, wis: 10, cha: 8 }
  abilities[CLASS_PRIMARY[classId] || 'str'] = 16
  if (CLASS_PRIMARY[classId] === 'str') abilities.con = 15
  if (CLASS_PRIMARY[classId] === 'dex') abilities.con = 14
  if (['wis', 'int', 'cha'].includes(CLASS_PRIMARY[classId])) abilities.dex = 14
  if (classId === 'paladin') { abilities.cha = 14; abilities.con = 14 }
  if (['monk', 'ranger'].includes(classId)) abilities.wis = 14
  return abilities
}

function abilityModifier(score) {
  return Math.floor((Number(score) - 10) / 2)
}

function classSpells(classId, level, abilities) {
  const tiers = CLASS_SPELLS[classId] ?? []
  const known = tiers.filter((tier) => tier.level <= level).flatMap((tier) => tier.ids)
  if (!known.length) return { known: [], prepared: [] }
  const preparedClass = ['cleric', 'druid', 'paladin', 'wizard'].includes(classId)
  const capacity = preparedClass
    ? Math.max(1, level + abilityModifier(abilities[CLASS_PRIMARY[classId]]))
    : known.length
  return { known, prepared: known.slice(0, capacity) }
}

function trainingHero(classId, level, position, index) {
  if (!CLASS_NAMES[classId]) throw new CombatLabSetupError(`Класс ${classId} не входит в профиль 2014`, 'UNKNOWN_COMBAT_LAB_CLASS')
  const abilities = standardAbilities(classId)
  const hitDie = CLASS_HIT_DICE[classId]
  const con = abilityModifier(abilities.con)
  const maxHp = Math.max(1, hitDie + con + (level - 1) * (Math.floor(hitDie / 2) + 1 + con))
  const weapon = CLASS_WEAPONS[classId]
  const spells = classSpells(classId, level, abilities)
  const base = {
    id: `hero-${index + 1}`,
    name: `${CLASS_NAMES[classId]} ${index + 1}`,
    character: `${CLASS_NAMES[classId]} ${index + 1}`,
    characterClass: classId,
    image: `/assets/ui/class-icons/${classId}.webp`,
    role: `${CLASS_NAMES[classId]} · ур. ${level}`,
    species: 'Человек',
    background: 'Солдат',
    level,
    hp: maxHp,
    maxHp,
    armor: weapon.armor,
    speed: 30,
    proficiency: 2 + Math.floor((level - 1) / 4),
    abilities,
    inventory: [],
    online: true,
    attackBonus: abilityModifier(abilities[CLASS_PRIMARY[classId]]) + 2 + Math.floor((level - 1) / 4),
    damageDice: weapon.dice,
    damageBonus: weapon.bonus,
    damageType: weapon.type,
    attackRange: 5,
    knownSpellIds: spells.known,
    preparedSpellIds: spells.prepared,
    x: position.x,
    y: position.y,
  }
  return withStarterKit(base, { rulesetId: COMBAT_LAB_RULESET.id })
}

function heroFromCampaign(source, state, entry, position, arenaId) {
  if (String(state?.ruleset_id) !== COMBAT_LAB_RULESET.id) {
    throw new CombatLabSetupError('Копировать можно только героя из кампании D&D 2014', 'SOURCE_RULESET_UNSUPPORTED')
  }
  const original = (state.players ?? []).find((candidate) => String(candidate.id) === String(entry.heroId))
  if (!original) throw new CombatLabSetupError(`Герой ${entry.heroId} не найден в кампании ${source}`, 'HERO_NOT_FOUND')
  if (original.characterSetupRequired) throw new CombatLabSetupError('Сначала завершите создание героя в его кампании', 'HERO_SETUP_REQUIRED')
  const sourceLevel = Math.max(1, Math.min(12, Number(original.level) || 1))
  if (entry.level != null && entry.level !== sourceLevel) {
    throw new CombatLabSetupError('Изменение уровня копии героя пока не поддержано; используйте training-класс', 'HERO_LEVEL_OVERRIDE_UNSUPPORTED')
  }
  const copy = clone(original)
  const sourceHeroId = String(copy.id)
  copy.id = arenaId
  copy.inventory = (copy.inventory ?? []).map((item, index) => ({
    ...item,
    id: `${arenaId}-item-${index + 1}`.slice(0, 120),
    source_item_id: item.id,
  }))
  copy.source_campaign_id = source
  copy.source_hero_id = sourceHeroId
  copy.x = position.x
  copy.y = position.y
  copy.hp = Math.max(1, Number(copy.maxHp) || 1)
  copy.maxHp = Math.max(1, Number(copy.maxHp) || 1)
  copy.alive = true
  copy.online = true
  return copy
}

function validateMapPlacement(map, entry, label, occupied) {
  const x = integer(entry.x, `${label}.x`, 0, map.width - 1)
  const y = integer(entry.y, `${label}.y`, 0, map.height - 1)
  const cell = cellAt(map, x, y)
  if (!cell?.passable) throw new CombatLabSetupError(`${label} стоит на стене`, 'PLACEMENT_BLOCKED')
  const key = `${x},${y}`
  if (occupied.has(key)) throw new CombatLabSetupError(`${label} занимает уже занятую клетку`, 'PLACEMENT_OCCUPIED')
  occupied.add(key)
  return { x, y }
}

function validateConfig(config) {
  assertObject(config, 'config')
  assertAllowedFields(config, ['mapId', 'party', 'enemies'], 'config')
  const map = MAP_BY_ID.get(String(config.mapId || ''))
  if (!map) throw new CombatLabSetupError('Неизвестная карта боевого стенда', 'UNKNOWN_COMBAT_LAB_MAP')
  if (!Array.isArray(config.party) || config.party.length < 1 || config.party.length > COMBAT_LAB_LIMITS.party) {
    throw new CombatLabSetupError(`В отряде должно быть 1..${COMBAT_LAB_LIMITS.party} участников`, 'PARTY_LIMIT_EXCEEDED')
  }
  if (!Array.isArray(config.enemies) || config.enemies.length < 1 || config.enemies.length > COMBAT_LAB_LIMITS.enemies) {
    throw new CombatLabSetupError(`У противников должно быть 1..${COMBAT_LAB_LIMITS.enemies} участников`, 'ENEMY_LIMIT_EXCEEDED')
  }
  for (const [index, entry] of config.party.entries()) {
    assertObject(entry, `config.party[${index}]`)
    assertAllowedFields(entry, ['source', 'campaignId', 'heroId', 'classId', 'level', 'x', 'y'], `config.party[${index}]`)
    if (!['hero', 'class'].includes(entry.source)) throw new CombatLabSetupError('source должен быть hero или class', 'INVALID_COMBAT_LAB_SOURCE')
    if (entry.source === 'hero' && (!entry.campaignId || !entry.heroId)) throw new CombatLabSetupError('Для source=hero нужны campaignId и heroId', 'HERO_SOURCE_REQUIRED')
    if (entry.source === 'class' && (!entry.classId || entry.campaignId || entry.heroId)) throw new CombatLabSetupError('Для source=class нужен только classId', 'CLASS_SOURCE_INVALID')
    if (entry.level != null) integer(entry.level, `config.party[${index}].level`, 1, 12)
    integer(entry.x, `config.party[${index}].x`, 0, map.width - 1)
    integer(entry.y, `config.party[${index}].y`, 0, map.height - 1)
  }
  for (const [index, entry] of config.enemies.entries()) {
    assertObject(entry, `config.enemies[${index}]`)
    assertAllowedFields(entry, ['monsterId', 'x', 'y'], `config.enemies[${index}]`)
    if (!entry.monsterId) throw new CombatLabSetupError('Для противника нужен monsterId', 'MONSTER_ID_REQUIRED')
    integer(entry.x, `config.enemies[${index}].x`, 0, map.width - 1)
    integer(entry.y, `config.enemies[${index}].y`, 0, map.height - 1)
  }
  return map
}

export async function combatLabCatalog({ loadCampaign = null } = {}) {
  const [loadedContent, heroes] = await Promise.all([content(), combatLabHeroes({ loadCampaign })])
  return {
    heroes,
    classes: classCatalog(),
    monsters: loadedContent.monsters.map(monsterCatalogEntry),
    maps: MAPS.map(clone),
    encounterThemes: COMBAT_LAB_ENCOUNTER_THEMES.map((id) => ({ id, name: COMBAT_LAB_ENCOUNTER_THEME_NAMES[id] })),
    limits: clone(COMBAT_LAB_LIMITS),
  }
}

export async function combatLabHeroes({ loadCampaign = null } = {}) {
  const result = []
  for (const campaignId of listRoomCodes()) {
    const state = await loadSourceCampaign(campaignId, loadCampaign)
    if (String(state?.ruleset_id || '') !== COMBAT_LAB_RULESET.id) continue
    for (const hero of state?.players ?? []) {
      if (hero.characterSetupRequired) continue
      const id = String(hero.id ?? '')
      if (!id) continue
      result.push({
        id,
        campaignId: String(campaignId).toUpperCase(),
        name: String(hero.name || hero.character || id),
        className: CLASS_NAMES[hero.characterClass] || String(hero.role || 'Герой').split('·')[0].trim(),
        level: Math.max(1, Math.min(12, Number(hero.level) || 1)),
      })
    }
  }
  return result.sort((left, right) => `${left.campaignId}:${left.id}`.localeCompare(`${right.campaignId}:${right.id}`))
}

async function loadSourceCampaign(campaignId, loadCampaign) {
  try {
    const loaded = loadCampaign ? await loadCampaign(campaignId) : getRoom(campaignId).state
    return loaded?.state ?? loaded
  } catch {
    return getRoom(campaignId).state
  }
}

function normalizeEncounterSeed(value) {
  if (value == null) return 'combat-lab'
  if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) return String(value)
  if (typeof value !== 'string') throw new CombatLabSetupError('seed должен быть строкой или целым числом 0..4294967295', 'INVALID_COMBAT_LAB_SEED')
  const seed = value.trim()
  if (!seed || seed.length > 120 || /[\u0000-\u001f\u007f]/u.test(seed)) {
    throw new CombatLabSetupError('seed не прошёл проверку границ', 'INVALID_COMBAT_LAB_SEED')
  }
  return seed
}

function normalizeEncounterTheme(value) {
  if (value != null && typeof value !== 'string') throw new CombatLabSetupError('Тема автоматической стычки должна быть строкой', 'UNKNOWN_COMBAT_LAB_THEME')
  const raw = String(value ?? 'generic').trim().toLowerCase()
  const theme = ENCOUNTER_THEME_ALIASES[raw]
  if (!theme) throw new CombatLabSetupError('Неизвестная тема автоматической стычки', 'UNKNOWN_COMBAT_LAB_THEME')
  return theme
}

function normalizeEncounterRequest(input, options = {}) {
  assertObject(input, 'request')
  const wrapped = Object.hasOwn(input, 'config')
  if (wrapped) {
    assertAllowedFields(input, ['config', 'difficulty', 'seed', 'theme'], 'request')
    assertObject(input.config, 'request.config')
    assertAllowedFields(input.config, ['mapId', 'party', 'enemies'], 'config')
  } else {
    assertAllowedFields(input, ['mapId', 'party', 'enemies', 'difficulty', 'seed', 'theme'], 'request')
  }
  const config = wrapped ? input.config : input
  const difficultyProvided = options.difficulty != null || input.difficulty != null
  const difficulty = options.difficulty ?? input.difficulty ?? 'medium'
  if (typeof difficulty !== 'string' || !COMBAT_LAB_ENCOUNTER_DIFFICULTIES.includes(difficulty)) {
    throw new CombatLabSetupError('difficulty должен быть easy, medium, hard или deadly', 'INVALID_COMBAT_LAB_DIFFICULTY')
  }
  if (config.mapId != null && typeof config.mapId !== 'string') throw new CombatLabSetupError('mapId должен быть строкой', 'UNKNOWN_COMBAT_LAB_MAP')
  const mapId = String(config.mapId ?? 'open-courtyard')
  if (!MAP_BY_ID.has(mapId)) throw new CombatLabSetupError('Неизвестная карта боевого стенда', 'UNKNOWN_COMBAT_LAB_MAP')
  return {
    config,
    mapId,
    difficulty,
    difficultyProvided,
    seed: normalizeEncounterSeed(options.seed ?? input.seed),
    theme: normalizeEncounterTheme(options.theme ?? input.theme),
  }
}

function normalizeEncounterParty(party) {
  if (!Array.isArray(party) || party.length < 1 || party.length > COMBAT_LAB_LIMITS.party) {
    throw new CombatLabSetupError(`В отряде должно быть 1..${COMBAT_LAB_LIMITS.party} участников`, 'PARTY_LIMIT_EXCEEDED')
  }
  return party.map((entry, index) => {
    assertObject(entry, `config.party[${index}]`)
    assertAllowedFields(entry, ['source', 'campaignId', 'heroId', 'classId', 'level', 'x', 'y'], `config.party[${index}]`)
    if (!['hero', 'class'].includes(entry.source)) throw new CombatLabSetupError('source должен быть hero или class', 'INVALID_COMBAT_LAB_SOURCE')
    if (entry.source === 'hero' && (typeof entry.campaignId !== 'string' || typeof entry.heroId !== 'string' || !entry.campaignId || !entry.heroId)) throw new CombatLabSetupError('Для source=hero нужны campaignId и heroId', 'HERO_SOURCE_REQUIRED')
    if (entry.source === 'class' && (typeof entry.classId !== 'string' || !entry.classId || entry.campaignId || entry.heroId)) throw new CombatLabSetupError('Для source=class нужен только classId', 'CLASS_SOURCE_INVALID')
    if (entry.level != null) integer(entry.level, `config.party[${index}].level`, 1, 12)
    for (const coordinateName of ['x', 'y']) if (entry[coordinateName] != null && !Number.isSafeInteger(entry[coordinateName])) {
      throw new CombatLabSetupError(`config.party[${index}].${coordinateName} должен быть целым числом`, 'INVALID_COMBAT_LAB_VALUE')
    }
    return { ...entry }
  })
}

function normalizeEncounterEnemies(enemies) {
  if (enemies == null) return []
  if (!Array.isArray(enemies) || enemies.length > COMBAT_LAB_LIMITS.enemies) {
    throw new CombatLabSetupError(`У противников должно быть 0..${COMBAT_LAB_LIMITS.enemies} участников`, 'ENEMY_LIMIT_EXCEEDED')
  }
  return enemies.map((entry, index) => {
    assertObject(entry, `config.enemies[${index}]`)
    assertAllowedFields(entry, ['monsterId', 'x', 'y'], `config.enemies[${index}]`)
    if (typeof entry.monsterId !== 'string' || !entry.monsterId) throw new CombatLabSetupError('Для противника нужен monsterId', 'MONSTER_ID_REQUIRED')
    for (const coordinateName of ['x', 'y']) if (entry[coordinateName] != null && !Number.isSafeInteger(entry[coordinateName])) {
      throw new CombatLabSetupError(`config.enemies[${index}].${coordinateName} должен быть целым числом`, 'INVALID_COMBAT_LAB_VALUE')
    }
    return { ...entry, monsterId: String(entry.monsterId) }
  })
}

async function resolveEncounterParty(party, { loadCampaign = null } = {}) {
  const entries = normalizeEncounterParty(party)
  const canonical = []
  const levels = []
  const warnings = []
  const usedSourceHeroes = new Set()
  for (const entry of entries) {
    if (entry.source === 'class') {
      if (!CLASS_NAMES[String(entry.classId)]) throw new CombatLabSetupError(`Класс ${entry.classId} не входит в профиль 2014`, 'UNKNOWN_COMBAT_LAB_CLASS')
      const level = entry.level ?? 1
      canonical.push({ ...entry, classId: String(entry.classId), level })
      levels.push(level)
      continue
    }
    const source = String(entry.campaignId).toUpperCase()
    const heroId = String(entry.heroId)
    const sourceKey = `${source}:${heroId}`
    if (usedSourceHeroes.has(sourceKey)) throw new CombatLabSetupError('Один герой не может быть добавлен дважды', 'DUPLICATE_HERO_SOURCE')
    usedSourceHeroes.add(sourceKey)
    const state = await loadSourceCampaign(source, loadCampaign)
    if (String(state?.ruleset_id) !== COMBAT_LAB_RULESET.id) {
      throw new CombatLabSetupError('Копировать можно только героя из кампании D&D 2014', 'SOURCE_RULESET_UNSUPPORTED')
    }
    const original = (state.players ?? []).find((candidate) => String(candidate.id) === heroId)
    if (!original) throw new CombatLabSetupError(`Герой ${heroId} не найден в кампании ${source}`, 'HERO_NOT_FOUND')
    if (original.characterSetupRequired) throw new CombatLabSetupError('Сначала завершите создание героя в его кампании', 'HERO_SETUP_REQUIRED')
    const level = Math.max(1, Math.min(12, Number(original.level) || 1))
    if (entry.level != null && entry.level !== level) {
      warnings.push(`Уровень героя «${String(original.name || original.character || heroId)}» взят из кампании: ${level}.`)
    }
    canonical.push({ ...entry, campaignId: source, heroId, level })
    levels.push(level)
  }
  return { entries: canonical, levels, warnings }
}

function recordsForEnemyEntries(entries, loadedContent) {
  const byId = new Map(loadedContent.monsters.map((record) => [String(record.id), record]))
  return entries.map((entry) => {
    const record = byId.get(String(entry.monsterId))
    if (!record) throw new CombatLabSetupError(`Монстр ${entry.monsterId} отсутствует в каталоге D&D 2014`, 'UNKNOWN_COMBAT_LAB_MONSTER')
    return record
  })
}

function themeMatches(record, theme) {
  if (theme === 'generic') return true
  const id = String(record.id).split(':').at(-1)
  const type = String(record.creature_type ?? '')
  const subtypes = Array.isArray(record.subtypes) ? record.subtypes.map(String) : []
  if (theme === 'goblinoids') return subtypes.includes('goblinoid') || /goblin|bugbear|hobgoblin|kobold/u.test(id)
  if (theme === 'undead') return type === 'undead'
  if (theme === 'beasts') return type === 'beast'
  if (theme === 'raiders') return ['bandit', 'bandit-captain', 'guard', 'orc', 'veteran', 'gnoll'].includes(id)
  if (theme === 'cultists') return ['cultist', 'cult-fanatic', 'acolyte', 'mage'].includes(id)
  if (theme === 'dragons') return type === 'dragon'
  if (theme === 'dungeon') return ['ooze', 'undead', 'monstrosity', 'elemental'].includes(type) || id === 'giant-spider'
  return false
}

function themedMonsterRecords(records, theme) {
  const selected = records.filter((record) => themeMatches(record, theme))
  if (!selected.length) throw new CombatLabSetupError(`В теме «${theme}» нет доступных существ`, 'NO_COMBAT_LAB_THEME_MONSTERS')
  return selected
}

function monsterBreakdown(records) {
  const grouped = new Map()
  for (const record of records) {
    const id = String(record.id)
    const previous = grouped.get(id)
    grouped.set(id, {
      id,
      name: String(record.name_ru),
      cr: String(record.challenge_rating),
      xp: Number(record.xp),
      count: (previous?.count ?? 0) + 1,
    })
  }
  return [...grouped.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function rosterCaveatWarnings(records, partyLevels) {
  if (!records.length) return []
  const challengeRatings = records.map((record) => challengeRatingValue(record.challenge_rating)).filter((value) => Number.isFinite(value))
  const averagePartyLevel = partyLevels.reduce((sum, level) => sum + Number(level), 0) / partyLevels.length
  const warnings = []
  const highestChallengeRating = Math.max(...challengeRatings, 0)
  if (highestChallengeRating > averagePartyLevel) {
    warnings.push(`Существо с ПО ${highestChallengeRating} выше среднего уровня отряда (${averagePartyLevel.toFixed(1)}); одиночный удар может резко изменить бой.`)
  }
  const lowestChallengeRating = Math.min(...challengeRatings, highestChallengeRating)
  if (highestChallengeRating >= 1 && lowestChallengeRating > 0 && highestChallengeRating / lowestChallengeRating >= 4) {
    warnings.push('В ростере есть существа с сильно разным ПО: множитель посчитан по всем, но слабых существ по правилам можно не учитывать, если они не влияют на бой.')
  }
  return warnings
}

function assessmentForRecords(records, partyLevels, request, warnings = [], selection = null) {
  const base = assessEncounterRoster({ records, partyLevels, difficulty: request.difficulty, seed: request.seed })
  const resultWarnings = [...warnings, ...rosterCaveatWarnings(records, partyLevels)]
  if (!records.length) resultWarnings.push('В стычке пока нет противников; добавьте существ или сгенерируйте состав.')
  else if (request.difficultyProvided && !base.matched) resultWarnings.push(`Фактическая опасность «${COMBAT_LAB_ENCOUNTER_DIFFICULTY_NAMES[base.difficulty]}» не совпадает с запросом «${COMBAT_LAB_ENCOUNTER_DIFFICULTY_NAMES[request.difficulty]}».`)
  const result = {
    ...base,
    theme: request.theme,
    monsterBreakdown: monsterBreakdown(records),
    warnings: resultWarnings,
    source: clone(COMBAT_LAB_RULES_SOURCE_2014),
    rulesetId: COMBAT_LAB_RULESET.id,
    rulesetVersion: COMBAT_LAB_RULESET.version,
  }
  if (selection) {
    result.selection = {
      generated: true,
      targetAdjustedXp: selection.target_adjusted_xp,
      candidateCount: selection.candidate_count,
      maximumCreatures: selection.maximum_creatures,
    }
  }
  return result
}

export async function assessCombatLabEncounter(input = {}, options = {}) {
  const request = normalizeEncounterRequest(input, options)
  const resolvedParty = await resolveEncounterParty(request.config.party, options)
  const loadedContent = await content()
  const enemyEntries = normalizeEncounterEnemies(request.config.enemies)
  const records = recordsForEnemyEntries(enemyEntries, loadedContent)
  return assessmentForRecords(records, resolvedParty.levels, request, resolvedParty.warnings)
}

function passableMapCells(map) {
  return legacyCellsFromTacticalMap(map).filter((entry) => cellAt(map, entry.x, entry.y)?.passable)
}

function authoredSpawnCells(map, role) {
  return (map.spawnPoints ?? [])
    .filter((point) => point.role === role && cellAt(map, point.x, point.y)?.passable)
    .map((point) => ({ x: point.x, y: point.y }))
}

function positionPartyForGeneratedEncounter(map, entries) {
  const occupied = new Set()
  const candidates = [...authoredSpawnCells(map, 'party'), ...passableMapCells(map)]
  return entries.map((entry, index) => {
    const hasX = entry.x != null
    const hasY = entry.y != null
    if (hasX !== hasY) throw new CombatLabSetupError(`config.party[${index}] требует обе координаты`, 'INVALID_COMBAT_LAB_VALUE')
    const position = hasX && hasY
      ? validateMapPlacement(map, entry, `config.party[${index}]`, occupied)
      : (() => {
        const next = candidates.find((candidate) => !occupied.has(`${candidate.x},${candidate.y}`))
        if (!next) throw new CombatLabSetupError('На карте нет свободной клетки для героя', 'NO_COMBAT_LAB_PLACEMENT')
        return validateMapPlacement(map, next, `config.party[${index}]`, occupied)
      })()
    return { ...entry, ...position }
  })
}

function enemyPositionsForGeneratedEncounter(map, party, count, seed) {
  const occupied = new Set(party.map((entry) => `${entry.x},${entry.y}`))
  const reachable = reachableCells(map, party[0].x, party[0].y)
  if (party.some((entry) => !reachable.has(`${entry.x},${entry.y}`))) {
    throw new CombatLabSetupError('Герои должны находиться в одной достижимой области карты', 'PLACEMENT_UNREACHABLE')
  }
  const authored = authoredSpawnCells(map, 'enemy')
  const candidates = [...authored, ...passableMapCells(map)]
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.x === entry.x && candidate.y === entry.y) === index)
    .filter((entry) => reachable.has(`${entry.x},${entry.y}`) && !occupied.has(`${entry.x},${entry.y}`))
    .sort((left, right) => {
      const leftDistance = Math.min(...party.map((member) => Math.abs(left.x - member.x) + Math.abs(left.y - member.y)))
      const rightDistance = Math.min(...party.map((member) => Math.abs(right.x - member.x) + Math.abs(right.y - member.y)))
      return rightDistance - leftDistance || `${seed}:${right.x},${right.y}`.localeCompare(`${seed}:${left.x},${left.y}`)
    })
  if (candidates.length < count) throw new CombatLabSetupError('На карте нет достаточного числа достижимых клеток для противников', 'NO_COMBAT_LAB_PLACEMENT')
  return candidates.slice(0, count)
}

export async function generateCombatLabEncounter(input = {}, options = {}) {
  const request = normalizeEncounterRequest(input, options)
  const resolvedParty = await resolveEncounterParty(request.config.party, options)
  const mapDefinitionValue = MAP_BY_ID.get(request.mapId)
  const map = deserializeTacticalMap(mapDefinitionValue.map)
  const party = positionPartyForGeneratedEncounter(map, resolvedParty.entries)
  const loadedContent = await content()
  const candidates = themedMonsterRecords(loadedContent.monsters, request.theme)
  let selection
  try {
    selection = selectEncounterRoster({
      records: candidates,
      partyLevels: resolvedParty.levels,
      difficulty: request.difficulty,
      seed: request.seed,
      maximumCreatures: COMBAT_LAB_LIMITS.enemies,
    })
  } catch (error) {
    throw new CombatLabSetupError('В выбранной теме нет противников для этого уровня и опасности. Выберите другую тему или измените опасность.', 'NO_COMBAT_LAB_ROSTER')
  }
  const positions = enemyPositionsForGeneratedEncounter(map, party, selection.records.length, request.seed)
  const enemies = selection.records.map((record, index) => ({
    monsterId: String(record.id),
    x: positions[index].x,
    y: positions[index].y,
  }))
  const config = { mapId: request.mapId, party, enemies }
  const assessment = assessmentForRecords(selection.records, resolvedParty.levels, request, resolvedParty.warnings, {
    target_adjusted_xp: selection.target_adjusted_xp,
    candidate_count: candidates.length,
    maximum_creatures: Math.min(COMBAT_LAB_LIMITS.enemies, resolvedParty.levels.length * 2),
  })
  return { config, assessment }
}

export async function buildCombatLabState(config, { loadCampaign = null } = {}) {
  const mapDefinitionValue = validateConfig(config)
  const map = mapDefinitionValue.map ? deserializeTacticalMap(mapDefinitionValue.map) : null
  const mapValue = map ?? tacticalMapFromLegacyCells(mapDefinitionValue.cells, { locationId: `combat-lab:${mapDefinitionValue.id}` })
  const occupied = new Set()
  const party = []
  const usedSourceHeroes = new Set()
  for (const [index, entry] of config.party.entries()) {
    const position = validateMapPlacement(mapValue, entry, `config.party[${index}]`, occupied)
    let hero
    if (entry.source === 'class') hero = trainingHero(String(entry.classId), entry.level ?? 1, position, index)
    else {
      const source = String(entry.campaignId).toUpperCase()
      const sourceKey = `${source}:${entry.heroId}`
      if (usedSourceHeroes.has(sourceKey)) throw new CombatLabSetupError('Один герой не может быть добавлен дважды', 'DUPLICATE_HERO_SOURCE')
      usedSourceHeroes.add(sourceKey)
      const loaded = await loadSourceCampaign(source, loadCampaign)
      hero = heroFromCampaign(source, loaded, entry, position, `hero-${index + 1}`)
    }
    party.push(hero)
  }
  const loadedContent = await content()
  const byMonsterId = new Map(loadedContent.monsters.map((record) => [record.id, record]))
  const enemies = config.enemies.map((entry, index) => {
    const position = validateMapPlacement(mapValue, entry, `config.enemies[${index}]`, occupied)
    const record = byMonsterId.get(String(entry.monsterId))
    if (!record) throw new CombatLabSetupError(`Монстр ${entry.monsterId} отсутствует в каталоге D&D 2014`, 'UNKNOWN_COMBAT_LAB_MONSTER')
    return enemyFrom2014(record, position, index)
  })
  const start = party[0]
  const reachable = reachableCells(mapValue, start.x, start.y)
  for (const actor of [...party, ...enemies]) if (!reachable.has(`${actor.x},${actor.y}`)) {
    throw new CombatLabSetupError(`Клетка ${actor.x},${actor.y} недостижима от первого героя`, 'PLACEMENT_UNREACHABLE')
  }
  const cells = mapCells(mapValue).map((cell) => ({
    ...cell,
    revealed: true,
    ...(cell.difficult ? { moveCost: 2 } : {}),
  }))
  return normalizeCampaignState({
    sessionCode: 'COMBAT-LAB',
    campaign: 'Боевой стенд · настраиваемая арена',
    partyName: 'Тестовый отряд',
    partyMemberIds: party.map((actor) => actor.id),
    activePlayerId: party[0].id,
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: party,
    enemies,
    scene: {
      title: mapDefinitionValue.name,
      location: `combat-lab:${mapDefinitionValue.id}`,
      mood: 'Тестовый бой',
      objective: 'Проверить боевые правила D&D 5e 2014',
      turn: 1,
      cells,
      map: serializeTacticalMap(mapValue),
    },
    adventure: { chapter: 1, history: [], visitedLocations: [`combat-lab:${mapDefinitionValue.id}`] },
    ruleset_id: COMBAT_LAB_RULESET.id,
    ruleset_version: COMBAT_LAB_RULESET.version,
    enabled_rule_packs: [...COMBAT_LAB_RULESET.enabled_rule_packs],
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    engine_mode: 'enforce',
  })
}

export { CombatLabSetupError }
