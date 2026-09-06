import { getRoom, listRoomCodes } from './store.mjs'
import { loadDndsu2014Content } from './dndsu-2014-content.mjs'
import { normalizeCampaignState } from './rules-engine.mjs'
import { deserializeTacticalMap, reachableCells, cellAt, legacyCellsFromTacticalMap, serializeTacticalMap, setCell, tacticalMapFromLegacyCells } from './tactical-map.mjs'
import { starterEquipmentCatalogFor, withStarterKit } from './starter-kit.mjs'
import { enemyFrom2014, monsterCatalogEntry } from './combat-lab-monsters.mjs'

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

function mapDefinition(id, name, width, height, build) {
  const cells = Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
  const map = tacticalMapFromLegacyCells(cells, { locationId: `combat-lab:${id}`, theme: id })
  build(map, width, height)
  return Object.freeze({
    id,
    name,
    width,
    height,
    theme: map.theme,
    cells: mapCells(map),
    map: serializeTacticalMap(map),
  })
}

const MAPS = Object.freeze([
  mapDefinition('open-courtyard', 'Открытый двор', 10, 6, (map) => {
    for (let x = 3; x <= 6; x += 1) setCell(map, x, 2, { moveCost: 2 })
  }),
  mapDefinition('ruined-hall', 'Разрушенный зал', 12, 7, (map, width, height) => {
    for (let y = 0; y < height; y += 1) if (y !== Math.floor(height / 2)) setCell(map, 5, y, { passable: false, revealed: true })
    for (let x = 2; x <= 9; x += 1) if (x !== 5 && x !== 8) setCell(map, x, 4, { moveCost: 2 })
  }),
  mapDefinition('marsh-crossing', 'Болотная переправа', 11, 8, (map, width, height) => {
    for (let x = 2; x <= width - 3; x += 1) for (let y = 2; y <= height - 3; y += 1) setCell(map, x, y, { moveCost: 2 })
    for (let y = 0; y < height; y += 1) setCell(map, Math.floor(width / 2), y, { moveCost: 1 })
  }),
  mapDefinition('pillar-chamber', 'Зал колонн', 14, 8, (map) => {
    for (const [x, y] of [[3, 2], [3, 5], [6, 2], [6, 5], [9, 2], [9, 5], [11, 3], [11, 4]]) {
      setCell(map, x, y, { passable: false, revealed: true })
    }
    for (let x = 1; x <= 12; x += 1) setCell(map, x, 3, { moveCost: 2 })
  }),
])

const MAP_BY_ID = new Map(MAPS.map((map) => [map.id, map]))

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
