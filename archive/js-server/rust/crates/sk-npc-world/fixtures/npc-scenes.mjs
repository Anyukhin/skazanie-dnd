// Входы эталонов sk-npc-world: случайные карты, NPC, миры NPC с мусором старых
// сохранений и чтение корпуса паритета (`tmp/corpus-v1`).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { chooser, PROTOTYPE_KEYS, setOwn } from './common.mjs'

export const DEFAULT_CORPUS = 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

/** Каталог корпуса: аргумент, `SK_NPC_CORPUS`, либо известный путь; `null` — корпуса нет. */
export function corpusDir(argument) {
  const dir = argument ?? process.env.SK_NPC_CORPUS ?? DEFAULT_CORPUS
  return dir && existsSync(join(dir, 'states')) ? dir : null
}

/** Записи корпуса по порядку файлов (`state` — хеш состояния «до»). */
export function* corpusRecords(dir) {
  for (const file of readdirSync(dir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        yield { file, ...JSON.parse(line) }
      } catch { /* битая строка корпуса */ }
    }
  }
}

export function corpusState(dir, hash) {
  try {
    return JSON.parse(readFileSync(join(dir, 'states', `${hash}.json`), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Команда записи корпуса с постоянным `command_id`: без него движок берёт
 * случайный UUID, и события (а с ними эталон) менялись бы от прогона к прогону.
 */
export function corpusCommand(entry) {
  const command = entry.command && typeof entry.command === 'object' ? entry.command : {}
  return { ...command, command_id: command.command_id ?? `corpus:${entry.file}:${entry.state.slice(0, 12)}` }
}

/** Кости по записи корпуса: те же результаты в том же порядке. */
export function replayDice(dice) {
  const queue = Array.isArray(dice) ? dice.slice() : []
  const next = (method) => {
    const entry = queue.shift()
    if (!entry) throw new Error(`корпус: бросков не хватило (${method})`)
    return entry.result
  }
  return {
    roll: () => next('roll'),
    rollD20: () => next('rollD20'),
    rollCheck: () => next('rollCheck'),
  }
}

export const ROLES = [
  'трактирщица', 'стражник', 'жрец храма', 'кузнец', 'ветеран', 'писарь', 'фермер', 'торговец', 'король', 'житель',
  'лекарь', 'травница', 'конюх', 'часовой', 'рыцарь', 'охотник', 'бармен', 'архивариус', 'innkeeper', 'guard captain',
  'herbalist', 'artisan', 'messenger', 'настоятель', 'монах', 'служитель храма', 'горожанин', '',
]
export const ASSETS = [
  'bar_counter', 'table_long', 'table_round', 'table_small', 'table_royal', 'altar', 'shrine', 'candle', 'fireplace',
  'campfire', 'forge', 'anvil', 'workbench', 'signpost', 'hitching_post', 'gate', 'door', 'well', 'cart', 'hay',
  'stall', 'counter', 'bookshelf', 'shelf', 'barrel', 'crate', 'chest', 'bed',
]
export const NAMES = ['Марта', 'Бор', 'Терен', 'Ивара', 'Отец Рем', 'Лира', 'Ада', 'Стефан', 'Мира', 'Гарм', 'Кай', 'Олег', 'Ян', 'Рута']
export const IDS = ['marta', 'bor', 'teren', 'ivara', 'rem', 'npc:vela', 'npc-1', 'npc-2', 'smith', 'astohan-ares', 'astohan-eldrin', 'astohan-sargat', '7', '12']
export const ODD_IDS = [...PROTOTYPE_KEYS.filter((key) => ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'].includes(key)), 'undefined', 'null', ' marta ', '']

/** Случайная тактическая карта через API `tactical-map.mjs`. */
export function randomMap(t, random, { width, height, locationId, seed }) {
  const { int, pick, chance } = chooser(random)
  const map = t.createTacticalMap({ width, height, locationId, seed })
  const zones = []
  if (chance(0.6)) {
    t.addZone(map, { id: 'hall', kind: 'interior', material: 'wood' })
    zones.push('hall')
  }
  if (chance(0.5)) {
    t.addZone(map, { id: 'yard', kind: 'exterior', material: 'earth' })
    zones.push('yard')
  }
  const platform = chance(0.25)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (chance(0.04)) continue
      const raised = platform && x >= Math.floor(width / 2) && y >= Math.floor(height / 2)
      t.setCell(map, x, y, {
        passable: chance(0.88),
        revealed: chance(0.93),
        material: raised ? 'wood' : pick(['stone', 'wood', 'earth', 'grass']),
        elevation: raised ? 2 : (chance(0.05) ? 1 : 0),
        ...(zones.length && chance(0.8) ? { zone: raised && zones.includes('yard') ? 'yard' : pick(zones) } : {}),
      })
    }
  }
  for (let index = int(0, 6); index > 0; index -= 1) {
    const x = int(0, width - 2)
    const y = int(0, height - 1)
    try {
      t.setEdge(map, x, y, x + 1, y, { kind: pick(['wall', 'wall', 'window', 'rail']), blocksMove: chance(0.8) })
    } catch { /* клетки нет */ }
  }
  for (let index = int(0, 2); index > 0; index -= 1) {
    const x = int(0, width - 1)
    const y = int(0, height - 2)
    try {
      t.setDoor(map, { id: `door-${index}`, x, y, dir: 's', state: pick(['open', 'closed', 'locked', 'broken']) })
    } catch { /* клетки нет */ }
  }
  const props = int(0, 8)
  for (let index = 0; index < props; index += 1) {
    const x = int(0, width - 1)
    const y = int(0, height - 1)
    const footprint = chance(0.2) ? [] : chance(0.2) && x + 1 < width ? [{ x, y }, { x: x + 1, y }] : [{ x, y }]
    try {
      t.addProp(map, { id: `${pick(['p', 'prop-', 'bar-', 'altar-'])}${index}`, assetId: pick(ASSETS), x: chance(0.1) ? x + 0.5 : x, y, footprint, blocksMove: chance(0.7) })
    } catch { /* предмет не встал */ }
  }
  return t.serializeTacticalMap(map)
}

/** Случайный социальный NPC; изредка — мусор старого сохранения. */
export function randomNpc(random, { location, locationId, index }) {
  const { int, pick, chance } = chooser(random)
  if (chance(0.03)) return pick([null, 5, 'npc', [], { name: 'Без id' }])
  const id = chance(0.08) ? pick(ODD_IDS) : chance(0.1) ? `${pick(IDS)}` : `${pick(IDS)}-${index}`
  const npc = {
    id: chance(0.04) ? int(1, 9) : id,
    name: chance(0.04) ? '' : `${pick(NAMES)}${chance(0.3) ? ` ${index}` : ''}`,
    role: pick(ROLES),
    location: chance(0.82) ? location : pick(['Дорога', 'Другая деревня', location.toUpperCase(), ` ${location} `]),
    visibility: pick(['party', 'party', 'public', 'gm_only', undefined]),
    available: chance(0.9) ? true : pick([false, undefined, 'no']),
  }
  if (chance(0.25)) npc.location_id = chance(0.7) ? locationId : pick(['road', 'other', locationId.toUpperCase()])
  if (chance(0.05)) npc.locationId = locationId
  if (chance(0.5)) {
    npc.tags = [
      ...(chance(0.5) ? [`faction:${pick(['guild', 'watch', 'temple', 'thieves'])}`] : []),
      ...(chance(0.3) ? [`faction:${pick(['guild', 'watch'])}`] : []),
      ...(chance(0.15) ? [`post:${pick(['hall', 'yard', 'nowhere'])}`] : []),
      ...(chance(0.1) ? [`anchor:${pick(['p0', 'p1', 'bar-2', 'none'])}`] : []),
      ...(chance(0.15) ? [pick(['hunter', 'guard', 'veteran', 'priest', null, 7, ['x']])] : []),
    ]
  }
  if (npc.visibility === 'gm_only' && chance(0.5)) npc.reveal_on_presence = chance(0.7) ? true : 'yes'
  if (chance(0.3)) npc.public_summary = `Живёт здесь давно; ${pick(['торгует', 'сторожит', 'молчит'])}.`
  if (chance(0.04)) npc.post_assets = [pick(ASSETS), pick(ASSETS)]
  if (chance(0.03)) npc.post_terrain = 'platform'
  if (npc.visibility === undefined) delete npc.visibility
  if (npc.available === undefined) delete npc.available
  return npc
}

const STANCE_VALUES = ['neutral', 'guarded', 'frightened', 'hostile', 'fleeing', 'dead', 'weird', ['hostile'], null]

export function mechanicsProfile(id, { hp = 4, size = 'medium', status = 'partial' } = {}) {
  return {
    profile_id: `profile:${id}`,
    status,
    level: 1,
    challenge_rating: '1',
    xp: 25,
    encounter_difficulty: 'easy',
    hp,
    armor: 10,
    speed: 30,
    initiative_bonus: 0,
    proficiency_bonus: 2,
    size,
    creature_type: 'humanoid',
    abilities: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 },
    skills: {},
    saving_throws: {},
    traits: [],
    action_profiles: [{
      id: 'strike', name: 'Удар', kind: 'melee', attack_modifier: 2,
      damage_expression: '1d4', damage_type: 'bludgeoning', range_feet: 5,
    }],
    features: [{ id: 'feature', name: 'Черта', status: 'partial', description: 'Описание.' }],
    tactics: ['Держится рядом.'],
  }
}

/** Мир NPC с правдоподобными записями и мусором старых сохранений. */
export function randomNpcWorld(random, { npcs, locationId, width, height, authored = [] }) {
  const { int, pick, chance } = chooser(random)
  const ids = npcs.filter((npc) => npc && typeof npc === 'object' && !Array.isArray(npc) && npc.id != null).map((npc) => String(npc.id))
  const world = { schema_version: pick([1, 3, 3, undefined]), placements: [], vitals: {}, stances: {}, inventories: {}, profiles: {} }
  for (const id of ids) {
    if (!chance(0.6)) continue
    world.placements.push({
      npc_id: chance(0.05) ? ` ${id} ` : id,
      location_id: chance(0.85) ? locationId : pick(['road', 'other']),
      x: chance(0.04) ? pick(['3', 2.5, null]) : int(-1, width),
      y: int(0, height - 1),
      ...(chance(0.08) ? { footprint: pick([{ version: 1, size: 2 }, { version: 1, size: 3 }, { version: 2, size: 2 }, { size: 2 }, 'large']) } : {}),
      anchor_prop_id: chance(0.5) ? pick(['', 'p0', 'p1']) : undefined,
      placement_reason: pick(['', 'test', 'role-suitable-post', undefined]),
      policy_id: 'x',
    })
    if (chance(0.05)) world.placements.push({ ...world.placements.at(-1), x: int(0, width - 1) })
  }
  if (chance(0.15)) world.placements.push(pick([{ npc_id: '', location_id: locationId, x: 1, y: 1 }, { npc_id: 'ghost', location_id: '', x: 1, y: 1 }, 'junk', 5, []]))
  for (const id of ids) {
    if (chance(0.45)) {
      setOwn(world.vitals, id, {
        hp: pick([0, 1, 2, 3, 4, 7, 11, 18, 600, -5, '5', null, undefined]),
        max_hp: pick([4, 7, 11, 18, 0, 9999, 'x', undefined]),
        alive: pick([true, false, undefined, undefined, 'yes']),
      })
    }
    if (chance(0.35)) setOwn(world.stances, id, { stance: pick(STANCE_VALUES), reason: pick(['harmed', '', undefined]), source_event_id: pick(['e1', undefined]), propagation_depth: pick([0, 1, 2, -1, '1']) })
    if (chance(0.12)) {
      const items = Array.from({ length: int(1, 3) }, (_, index) => ({
        id: `item-${id}-${index % 2}`,
        name: pick(['Слеза', 'Ключ', 'Монета', 'Кинжал']),
        type: pick(['other', 'weapon', 'treasure']),
        quantity: pick([1, 2, 5, '3', 0]),
        ...(chance(0.3) ? { item_instance_id: `inst-${id}-${index}` } : {}),
      }))
      if (chance(0.2)) items.push(null, 'junk')
      setOwn(world.inventories, id, items)
    }
  }
  for (const [id, mechanics] of authored) if (chance(0.8)) setOwn(world.profiles, id, mechanics)
  if (chance(0.3) && ids.length) setOwn(world.profiles, pick(ids), chance(0.6) ? mechanicsProfile('generic', { hp: pick([4, 9, 30]), size: pick(['medium', 'large', 'huge']), status: pick(['partial', 'ruling-only', 'verified']) }) : pick([{}, { hp: 'x' }, 'junk']))
  if (chance(0.1)) setOwn(world.vitals, pick(['constructor', '__proto__', 'toString']), { hp: 2, max_hp: 4 })
  if (chance(0.08)) setOwn(world.stances, pick(['constructor', '__proto__']), { stance: 'hostile' })
  if (chance(0.05)) world.vitals = pick([[{ hp: 1 }], 'ab', 5])
  if (chance(0.04)) world.placements = 'junk'
  return world
}
