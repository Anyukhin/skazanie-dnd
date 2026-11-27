import '../../../fixtures-env.mjs'
// Эталоны задачи Т3 (`sk-tactics`): `server/combat-lab-setup.mjs`.
//
//   node rust/crates/sk-tactics/fixtures/gen-t3.mjs
//
// Хранилище — временный каталог (`DND_STORAGE_DIR`): в нём лежат комнаты
// `rooms/<CODE>.json` (запасной путь `getRoom` и список `listRoomCodes`),
// те же комнаты эталон отдаёт Rust (`rooms`). Кампании-источники героев —
// `sources`; `loader` случая: `direct` — `loadCampaign` возвращает состояние,
// `wrapped` — `{ state }`, `throw` — бросает (запасной путь `getRoom`),
// `none` — без `loadCampaign`.
//
// Случаи:
// - `generate` — все арены × темы (и синонимы) × опасности × сиды × отряды;
// - `build` — состав из `generate` и случайные расстановки (стены, занятые
//   клетки, недостижимость), герои кампаний, большие фигуры;
// - `assess` — случайные ростеры;
// - рыхлые входы всех трёх функций;
// - `catalog` и `heroes` по комнатам.
//
// Выход: `ok` — SHA-256 строки `JSON.stringify` и сводка; `err` — `{ name,
// code, message }`. Файл пишется gzip (`t3.json.gz`).
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// `store.mjs` при импорте читает `.env` (`dotenv/config`): для эталона он не
// нужен, импорт подменяется пустым модулем.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const storage = mkdtempSync(join(tmpdir(), 'sk-t3-'))
process.env.DND_STORAGE_DIR = storage
const setup = await import('../../../../server/combat-lab-setup.mjs')
const { COMBAT_LAB_MAPS } = await import('../../../../server/combat-lab-maps.mjs')
const { loadDndsu2014Content } = await import('../../../../server/dndsu-2014-content.mjs')
const content = await loadDndsu2014Content()

let seed = 0x0007_3eed
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let value = seed
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const CLASSES = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard']
const MAP_IDS = COMBAT_LAB_MAPS.map((map) => map.id)
const MONSTER_IDS = content.monsters.map((record) => record.id)
const THEMES = ['generic', 'goblin', 'goblinoids', 'undead', 'beasts', 'beast', 'raiders', 'humanoids', 'cult', 'cultists', 'dragons', 'dragon', 'dungeon', ' Undead ', undefined, null]
const DIFFICULTIES = ['easy', 'medium', 'hard', 'deadly', undefined]

// --- кампании-источники ---------------------------------------------------

const sources = {}
const rooms = {}
async function trainingState(mapId, party, enemies) {
  return setup.buildCombatLabState({ mapId, party, enemies })
}
{
  const a = await trainingState('forest-clearing', [
    { source: 'class', classId: 'wizard', level: 5, x: 1, y: 4 },
    { source: 'class', classId: 'rogue', level: 7, x: 1, y: 5 },
    { source: 'class', classId: 'cleric', level: 3, x: 2, y: 4 },
  ], [{ monsterId: 'dnd_5e_2014:monster:orc', x: 7, y: 8 }])
  a.sessionCode = 'SRC-ALPHA'
  a.players[1].footprint = { version: 1, size: 2 }
  a.players[2].name = ''
  a.players[2].character = 'Персонаж без имени'
  sources['SRC-ALPHA'] = a
  rooms['SRC-ALPHA'] = a
}
{
  const b = await trainingState('open-courtyard', [
    { source: 'class', classId: 'paladin', level: 12, x: 0, y: 0 },
    { source: 'class', classId: 'bard', level: 1, x: 1, y: 0 },
  ], [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }])
  b.sessionCode = 'SRC-BETA'
  b.players[0].characterClass = 'unknown-class'
  b.players[0].role = 'Особый · страж'
  b.players[1].inventory.push({ name: 'Без id', quantity: 1, source_item_id: 'stale' })
  sources['SRC-BETA'] = b
  rooms['SRC-BETA'] = b
}
sources['SRC-2024'] = { ruleset_id: 'srd_5_2_1', players: [{ id: 'hero-1', level: 3, maxHp: 10, hp: 10, inventory: [] }] }
rooms['SRC-2024'] = sources['SRC-2024']
sources['SRC-SETUP'] = { ruleset_id: 'dnd_5e_2014', players: [{ id: 'new', level: 1, characterSetupRequired: true }, { id: 'ok', name: 'Готов', level: '4', maxHp: 'abc', inventory: [{ id: 'a' }, 'строка', 5] }, { id: 7, level: 99, maxHp: 0 }] }
rooms['SRC-SETUP'] = sources['SRC-SETUP']
sources['SRC-JUNK'] = { ruleset_id: 'dnd_5e_2014', players: [{ id: 'junk', level: -5, inventory: 7 }, { level: 2 }] }
sources['SRC-NULLHERO'] = { ruleset_id: 'dnd_5e_2014', players: [null, { id: 'x' }] }
sources['SRC-OBJPLAYERS'] = { ruleset_id: 'dnd_5e_2014', players: { id: 'x' } }
sources['SRC-WRAP'] = { state: sources['SRC-ALPHA'] }
// Только в комнатах: запасной путь `getRoom` и список кампаний.
rooms['ROOM-ONLY'] = { ruleset_id: 'dnd_5e_2014', players: [{ id: 'r1', name: 'Комнатный', characterClass: 'monk', level: 2, maxHp: 9, inventory: [] }, { id: 'r0', level: 0 }, { id: 'r2', characterClass: 'constructor', level: 3 }, { id: 'r3', characterClass: '__proto__', level: 3 }, { id: 'r4', characterClass: ['monk'], role: 5, level: 2 }] }
rooms['ROOM-STR'] = { ruleset_id: 'dnd_5e_2014', players: 'abc' }

mkdirSync(join(storage, 'rooms'), { recursive: true })
for (const [code, state] of Object.entries(rooms)) {
  writeFileSync(join(storage, 'rooms', `${code}.json`), JSON.stringify({ version: 1, state, updatedAt: '2026-10-20T00:00:00.000Z' }))
}

function loaderFor(kind) {
  if (kind === 'none') return null
  return async (campaignId) => {
    const state = sources[campaignId]
    if (kind === 'throw' || state === undefined) throw new Error(`нет кампании ${campaignId}`)
    return kind === 'wrapped' ? { state: structuredClone(state) } : structuredClone(state)
  }
}

// --- исполнение -----------------------------------------------------------

function errorOf(error) {
  return { name: String(error?.name ?? 'Error'), code: error?.code == null ? null : String(error.code), message: String(error?.message ?? error) }
}

function summaryOf(kind, value) {
  if (kind === 'build') return { players: value.players.map((p) => [p.id, p.x, p.y, p.hp]), enemies: value.enemies.map((e) => [e.id, e.stat_block_id, e.x, e.y]) }
  if (kind === 'generate') return { config: value.config, difficulty: value.assessment.difficulty, adjustedXp: value.assessment.adjustedXp, warnings: value.assessment.warnings }
  if (kind === 'assess') return { difficulty: value.difficulty, adjustedXp: value.adjustedXp, warnings: value.warnings }
  if (kind === 'heroes') return value
  if (kind === 'catalog') return { heroes: value.heroes, classes: value.classes, monsters: value.monsters.length }
  return null
}

const cases = []
const full = []
async function run(kind, input, { loader = 'direct', options = {}, keepFull = false } = {}) {
  const loadCampaign = loaderFor(loader)
  const wire = input === undefined ? '__undefined__' : JSON.parse(JSON.stringify(input))
  let outcome
  try {
    let value
    if (kind === 'build') value = await setup.buildCombatLabState(input, { loadCampaign })
    else if (kind === 'generate') value = await setup.generateCombatLabEncounter(input, { ...options, loadCampaign })
    else if (kind === 'assess') value = await setup.assessCombatLabEncounter(input, { ...options, loadCampaign })
    else if (kind === 'heroes') value = await setup.combatLabHeroes({ loadCampaign })
    else if (kind === 'catalog') value = await setup.combatLabCatalog({ loadCampaign })
    outcome = { ok: sha(value), summary: summaryOf(kind, value) }
    if (keepFull) full.push({ index: cases.length, value })
  } catch (error) {
    outcome = { err: errorOf(error) }
  }
  cases.push({ kind, input: wire, loader, ...(Object.keys(options).length ? { options } : {}), ...outcome })
  return outcome
}

function classEntry(withPosition, map) {
  const entry = { source: 'class', classId: pick(CLASSES) }
  if (chance(0.8)) entry.level = 1 + int(12)
  if (withPosition) { entry.x = int(map.width); entry.y = int(map.height) }
  return entry
}
const HERO_REFS = [
  ['SRC-ALPHA', 'hero-1'], ['SRC-ALPHA', 'hero-2'], ['SRC-ALPHA', 'hero-3'], ['SRC-BETA', 'hero-1'], ['SRC-BETA', 'hero-2'],
  ['src-alpha', 'hero-1'], ['SRC-SETUP', 'ok'], ['SRC-SETUP', '7'], ['ROOM-ONLY', 'r1'],
]
function heroEntry(withPosition, map) {
  const [campaignId, heroId] = pick(HERO_REFS)
  const entry = { source: 'hero', campaignId, heroId }
  if (chance(0.2)) entry.level = 1 + int(12)
  if (withPosition) { entry.x = int(map.width); entry.y = int(map.height) }
  return entry
}
function randomParty(map, withPosition) {
  const size = 1 + int(chance(0.7) ? 3 : 6)
  return Array.from({ length: size }, () => (chance(0.25) ? heroEntry(withPosition, map) : classEntry(withPosition, map)))
}

// 1. Генерация и сборка по сгенерированному составу.
for (const mapId of MAP_IDS) {
  const map = COMBAT_LAB_MAPS.find((entry) => entry.id === mapId)
  for (let round = 0; round < 22; round += 1) {
    const theme = pick(THEMES)
    const difficulty = pick(DIFFICULTIES)
    const seedValue = pick([round, `seed-${round}`, 4294967295, undefined, ` пробел ${round} `])
    const party = randomParty(map, chance(0.15))
    const request = chance(0.5)
      ? { config: { mapId, party }, ...(difficulty ? { difficulty } : {}), ...(seedValue !== undefined ? { seed: seedValue } : {}), ...(theme !== undefined ? { theme } : {}) }
      : { mapId, party, ...(difficulty ? { difficulty } : {}), ...(seedValue !== undefined ? { seed: seedValue } : {}), ...(theme !== undefined ? { theme } : {}) }
    const loader = pick(['direct', 'direct', 'wrapped', 'throw', 'none'])
    const generated = await run('generate', request, { loader })
    if (generated.ok) {
      const config = generated.summary.config
      await run('build', config, { loader, keepFull: full.length < 2 })
      await run('assess', { config, difficulty: difficulty ?? 'medium', seed: seedValue ?? 'combat-lab' }, { loader })
      // Случайная правка расстановки: стена, занятая клетка, другой монстр.
      const mutated = structuredClone(config)
      const target = chance(0.5) ? pick(mutated.enemies) : pick(mutated.party)
      target.x = int(map.width)
      target.y = int(map.height)
      if (chance(0.4)) mutated.enemies.push({ monsterId: pick(MONSTER_IDS), x: int(map.width), y: int(map.height) })
      await run('build', mutated, { loader })
    }
  }
}

// 2. Случайные расстановки напрямую.
for (let round = 0; round < 260; round += 1) {
  const mapId = pick(MAP_IDS)
  const map = COMBAT_LAB_MAPS.find((entry) => entry.id === mapId)
  const enemies = Array.from({ length: 1 + int(5) }, () => ({ monsterId: pick(MONSTER_IDS), x: int(map.width), y: int(map.height) }))
  await run('build', { mapId, party: randomParty(map, true), enemies }, { loader: pick(['direct', 'wrapped', 'none']) })
  await run('assess', { mapId, party: randomParty(map, chance(0.5)), enemies: enemies.map(({ monsterId }) => ({ monsterId })), difficulty: pick(['easy', 'medium', 'hard', 'deadly']), seed: round }, { loader: 'direct' })
}

// 3. Опции вызова поверх тела запроса.
for (const options of [{ difficulty: 'deadly' }, { seed: 'opt-seed' }, { theme: 'undead' }, { difficulty: 'trivial' }, { seed: -1 }, { theme: 5 }]) {
  await run('generate', { mapId: 'pillar-chamber', party: [{ source: 'class', classId: 'fighter', level: 5 }], difficulty: 'easy' }, { options })
  await run('assess', { mapId: 'pillar-chamber', party: [{ source: 'class', classId: 'fighter', level: 5 }], enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin' }] }, { options })
}

// 4. Рыхлые входы.
const goblin = { monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }
const fighter = { source: 'class', classId: 'fighter', level: 1, x: 0, y: 0 }
const junkBuild = [
  undefined, null, 5, 'строка', [], [fighter],
  { mapId: 'open-courtyard', state: {}, party: [fighter], enemies: [goblin] },
  { 0: 1, mapId: 'open-courtyard', party: [fighter], enemies: [goblin], zzz: 1 },
  { mapId: 'nowhere', party: [fighter], enemies: [goblin] },
  { mapId: 7, party: [fighter], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [], enemies: [goblin] },
  { mapId: 'open-courtyard', party: Array.from({ length: 7 }, (_, x) => ({ ...fighter, x })), enemies: [goblin] },
  { mapId: 'open-courtyard', party: [fighter], enemies: [] },
  { mapId: 'open-courtyard', party: [fighter], enemies: Array.from({ length: 13 }, () => goblin) },
  { mapId: 'open-courtyard', party: [fighter], enemies: 'goblin' },
  { mapId: 'open-courtyard', party: [null], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [[]], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, hp: 99 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, source: 'npc' }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-ALPHA', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, heroId: 'x' }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, classId: '' }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, classId: 'artificer' }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, classId: 5 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, classId: 'constructor' }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, classId: 'toString' }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, classId: '__proto__' }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, level: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, level: 13 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, level: 2.5 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, level: '3' }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, level: null }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, x: -1 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, x: 10 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, y: '0' }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ ...fighter, x: 3.0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [fighter], enemies: [{ ...goblin, monsterId: '' }] },
  { mapId: 'open-courtyard', party: [fighter], enemies: [{ ...goblin, monsterId: 'srd_5_2_1:goblin-minion' }] },
  { mapId: 'open-courtyard', party: [fighter], enemies: [{ ...goblin, hp: 1 }] },
  { mapId: 'open-courtyard', party: [fighter], enemies: [null] },
  { mapId: 'open-courtyard', party: [fighter], enemies: [{ ...goblin, x: 0, y: 0 }] },
  { mapId: 'open-courtyard', party: [fighter, { ...fighter }], enemies: [goblin] },
  { mapId: 'ruined-hall', party: [{ ...fighter, x: 5, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [fighter], enemies: [{ monsterId: 'dnd_5e_2014:monster:ogre', x: 9, y: 5 }] },
  { mapId: 'open-courtyard', party: [fighter], enemies: [{ monsterId: 'dnd_5e_2014:monster:ogre', x: 7, y: 4 }] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-ALPHA', heroId: 'hero-1', x: 0, y: 0 }, { source: 'hero', campaignId: 'src-alpha', heroId: 'hero-1', x: 1, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-ALPHA', heroId: 'nobody', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-ALPHA', heroId: 'hero-1', level: 1, x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-ALPHA', heroId: 'hero-1', level: 5, x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-ALPHA', heroId: 'hero-2', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-ALPHA', heroId: 'hero-2', x: 9, y: 5 }], enemies: [{ ...goblin, x: 0, y: 0 }] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-2024', heroId: 'hero-1', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-SETUP', heroId: 'new', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-SETUP', heroId: 'ok', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-SETUP', heroId: 7, x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-JUNK', heroId: 'junk', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-NULLHERO', heroId: 'x', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-OBJPLAYERS', heroId: 'x', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-MISSING', heroId: 'x', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SRC-WRAP', heroId: 'hero-1', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'ROOM-ONLY', heroId: 'r1', x: 0, y: 0 }], enemies: [goblin] },
  { mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'ROOM-STR', heroId: 'r1', x: 0, y: 0 }], enemies: [goblin] },
]
for (const input of junkBuild) {
  for (const loader of ['direct', 'none']) await run('build', input, { loader })
}
const junkRequests = [
  undefined, null, 5, [], {}, { config: 5 }, { config: [] }, { config: {}, extra: 1 },
  { config: { mapId: 'open-courtyard', party: [fighter], state: 1 } },
  { mapId: 'open-courtyard', party: [fighter], hp: 3 },
  { mapId: 5, party: [fighter] }, { mapId: 'nowhere', party: [fighter] }, { mapId: null, party: [fighter] },
  { party: [fighter], difficulty: 'trivial' }, { party: [fighter], difficulty: 3 }, { party: [fighter], difficulty: null },
  { party: [fighter], seed: -1 }, { party: [fighter], seed: 1.5 }, { party: [fighter], seed: 4294967296 }, { party: [fighter], seed: '   ' },
  { party: [fighter], seed: 'x'.repeat(121) }, { party: [fighter], seed: 'x'.repeat(120) }, { party: [fighter], seed: 'a\u0001b' }, { party: [fighter], seed: true }, { party: [fighter], seed: null },
  { party: [fighter], theme: 'unknown' }, { party: [fighter], theme: 7 }, { party: [fighter], theme: 'DRAGON' }, { party: [fighter], theme: 'constructor' }, { party: [fighter], theme: '' },
  { party: [{ source: 'class', classId: 'constructor' }] }, { party: [{ source: 'class', classId: 'toString', level: 2 }] }, { party: [{ source: 'class', classId: '__proto__' }] }, { party: [fighter], theme: '__proto__' },
  { party: [] }, { party: 'x' }, { party: Array.from({ length: 7 }, () => fighter) },
  { party: [null] }, { party: [{ source: 'hero', campaignId: 5, heroId: 'x' }] }, { party: [{ source: 'class', classId: 5 }] },
  { party: [{ source: 'class', classId: 'fighter', campaignId: 'X' }] }, { party: [{ source: 'class', classId: 'fighter', x: 1.5 }] },
  { party: [{ source: 'class', classId: 'fighter', x: 1 }] }, { party: [{ source: 'class', classId: 'fighter', x: 9, y: 5 }, { source: 'class', classId: 'fighter', x: 9, y: 5 }] },
  { party: [{ source: 'class', classId: 'fighter', x: 50, y: 50 }] }, { party: [{ source: 'class', classId: 'nope' }] },
  { party: [{ source: 'class', classId: 'fighter', level: 20 }] },
  { party: [fighter], enemies: Array.from({ length: 13 }, () => ({ monsterId: 'dnd_5e_2014:monster:goblin' })) },
  { party: [fighter], enemies: [{ monsterId: 5 }] }, { party: [fighter], enemies: [{ monsterId: 'x', x: 'a' }] }, { party: [fighter], enemies: [{ monsterId: 'nope' }] },
  { party: [fighter], enemies: null }, { party: [fighter], enemies: 'x' }, { party: [fighter], enemies: [null] },
  { party: [{ source: 'hero', campaignId: 'SRC-ALPHA', heroId: 'hero-1' }, { source: 'hero', campaignId: 'src-alpha', heroId: 'hero-1' }] },
  { party: [{ source: 'hero', campaignId: 'SRC-ALPHA', heroId: 'hero-2', level: 1 }] },
  { party: [{ source: 'hero', campaignId: 'SRC-ALPHA', heroId: 'hero-3', level: 3 }] },
  { party: [{ source: 'hero', campaignId: 'SRC-2024', heroId: 'hero-1' }] },
  { party: [{ source: 'hero', campaignId: 'SRC-SETUP', heroId: 'new' }] },
  { party: [{ source: 'hero', campaignId: 'SRC-SETUP', heroId: 'ok', level: 2 }] },
  { party: [{ source: 'hero', campaignId: 'SRC-SETUP', heroId: '7' }] },
  { party: [{ source: 'hero', campaignId: 'SRC-MISSING', heroId: 'x' }] },
  { party: [{ source: 'hero', campaignId: 'SRC-NULLHERO', heroId: 'x' }] },
  { party: [{ source: 'hero', campaignId: 'ROOM-ONLY', heroId: 'r1' }] },
  { party: [{ source: 'hero', campaignId: 'SRC-JUNK', heroId: 'junk' }] },
  { party: Array.from({ length: 6 }, () => ({ source: 'class', classId: 'wizard', level: 1 })), theme: 'dragons', difficulty: 'easy' },
  { party: [{ source: 'class', classId: 'fighter', level: 12 }], theme: 'dragons', difficulty: 'deadly', seed: 3 },
  { mapId: 'cavern-bridge', party: Array.from({ length: 6 }, () => ({ source: 'class', classId: 'fighter', level: 12 })), difficulty: 'deadly', seed: 9 },
]
for (const input of junkRequests) {
  for (const kind of ['generate', 'assess']) await run(kind, input, { loader: chance(0.5) ? 'direct' : 'none' })
}

// 5. Каталог и герои кампаний.
for (const loader of ['direct', 'wrapped', 'throw', 'none']) {
  await run('heroes', undefined, { loader })
  await run('catalog', undefined, { loader })
}

const fixture = { rooms, sources, cases, full }
const text = JSON.stringify(fixture)
writeFileSync(new URL('./t3.json.gz', import.meta.url), gzipSync(text, { level: 9 }))
rmSync(storage, { recursive: true, force: true })
const counts = {}
for (const entry of cases) counts[`${entry.kind}:${entry.ok ? 'ok' : entry.err.code ?? entry.err.name}`] = (counts[`${entry.kind}:${entry.ok ? 'ok' : entry.err.code ?? entry.err.name}`] ?? 0) + 1
console.log(cases.length, 'случаев', Math.round(text.length / 1024), 'КБ JSON')
console.log(counts)
