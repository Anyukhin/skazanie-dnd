import '../../../fixtures-env.mjs'
// Эталон server/action-hints.mjs для Rust (`sk-tactical`, модуль `action_hints`):
//
//   node rust/crates/sk-tactical/fixtures/gen-action-hints.mjs
//
// Комнаты — настоящие проекции игроку (`campaignStateForViewer`):
//
// - каждая комната, которую видела функция в тестах JS, где подсказки —
//   предмет проверки: `action-hints`, `beast-taming`, `blessings-ui-contract`,
//   `courier-letters-ui-contract`, `lockpicking`, `tavern-life`,
//   `tavern-ui-contract` и соседние тесты с проекцией (пленные, добыча,
//   закон, карманы, сценарий). Файлы запускаются с перехватчиком
//   `action-hints-recorder.mjs`;
// - проекции кампании «Асстоханские равнины»: поход по местам сценария, для
//   каждого героя и ведущего;
// - правки этих комнат случайными заплатками (`patch`: путь и значение) —
//   имена с пробелами и эмодзи, длинные роли, расстояния, состояния таверны,
//   почты, зверей, двора, добычи, кошелька и краденого, ключи прототипа;
// - не-объекты и бой.
//
// Комната сведена к полям, которые читает модуль (`reduceHintsRoom`), и
// хранится один раз (`rooms`); случай ссылается на неё индексом.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hintsOutcome, hintsRecord } from './action-hints-recorder.mjs'

const root = new URL('../../../../', import.meta.url)
const H = await import(new URL('server/action-hints.mjs', root).href)
const { sceneInteractionAssetIds } = await import(new URL('server/scene-interactions.mjs', root).href)

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(2026_10_15)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p

const UNDEFINED = '\u0000undefined'
const encode = (value) => (value === undefined ? UNDEFINED : value)
const decode = (value) => (value === UNDEFINED ? undefined : value)

// --- 1. записи из тестов JS ----------------------------------------------------

const TEST_FILES = [
  'action-hints', 'beast-taming', 'blessings-ui-contract', 'blessings', 'courier-letters-ui-contract', 'courier-letters', 'lockpicking',
  'tavern-life', 'tavern-ui-contract', 'pickpocket', 'loot-containers', 'captives', 'law-and-order', 'parley', 'npc-positioning',
  'authored-world-npcs', 'scenario-progression', 'scenario-attention', 'quest-consequences', 'item-origin', 'npc-item-transfer',
]
const records = []
const recordFile = join(tmpdir(), `skazanie-action-hints-${process.pid}.jsonl`)
const recorder = fileURLToPath(new URL('./action-hints-recorder.mjs', import.meta.url))
for (const name of TEST_FILES) {
  if (existsSync(recordFile)) rmSync(recordFile)
  const file = fileURLToPath(new URL(`test/${name}.test.mjs`, root))
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(recorder).href, file], { cwd: fileURLToPath(root), env: { ...process.env, HINTS_RECORD_FILE: recordFile, ROUTERAI_API_KEY: '' }, encoding: 'utf8', maxBuffer: 1 << 28 })
  const lines = existsSync(recordFile) ? readFileSync(recordFile, 'utf8').split('\n').filter(Boolean) : []
  const failed = /ℹ fail [1-9]/u.test(run.stdout ?? '')
  console.log(`  ${name}: ${lines.length} записей${failed ? ' (в прогоне есть упавшие тесты)' : ''}`)
  for (const line of lines) records.push({ source: name, ...JSON.parse(line) })
}
if (existsSync(recordFile)) rmSync(recordFile)

// --- 2. поход по кампании «Асстоханские равнины» -------------------------------

{
  const S = await import(new URL('server/campaign-scenario.mjs', root).href)
  const { CampaignBootstrapper } = await import(new URL('server/campaign-bootstrap.mjs', root).href)
  const { normalizeCampaignState, resolveCommands } = await import(new URL('server/rules-engine.mjs', root).href)
  const { SceneArchitectAgent } = await import(new URL('server/scene-architect.mjs', root).href)
  const { campaignStateForViewer } = await import(new URL('server/viewer-projection.mjs', root).href)
  const { fixedDice } = await import(new URL('test/kit/dice.mjs', root).href)
  const HERO = { role: 'Воин · ур. 3', species: 'Человек', background: 'Странник', level: 3, hp: 30, maxHp: 30, armor: 16, speed: 30 }
  const heroes = [
    { id: 'walk-hero', character: 'Ирма', name: 'Игрок', ...HERO, currency: { gold: 5 } },
    { id: 'walk-rogue', character: 'Тень', name: 'Второй', ...HERO, currency: { copper: 3 } },
  ]
  let state = normalizeCampaignState(await new CampaignBootstrapper().create({ code: 'HINTS-WALK', worldTemplateId: 'astohan-plains', players: heroes }))
  let step = 0
  const apply = (command) => {
    step += 1
    try {
      const result = resolveCommands([{ command_id: `walk-${step}`, ...command }], state, { diceService: fixedDice(10), context: { isAdmin: true } })
      state = normalizeCampaignState(result.state)
      return true
    } catch {
      return false
    }
  }
  const project = (label) => {
    for (const [viewer, actor] of [[{ role: 'player', heroIds: ['walk-hero'] }, 'walk-hero'], [{ role: 'player', heroIds: ['walk-rogue'] }, 'walk-rogue'], [{ role: 'admin' }, 'walk-hero']]) {
      const room = campaignStateForViewer(state, viewer, actor)
      records.push({ source: `walk:${label}`, ...hintsRecord(room, actor) })
      records.push({ source: `walk:${label}:nobody`, ...hintsRecord(room, '') })
    }
  }
  project('start')
  for (const location of ['astohan-redstone', 'astohan-mittlayd', 'astohan-ash-watch', 'astohan-lomar-tower', 'astohan-quiet-watch-camp', 'astohan-wild-forest', 'astohan-stormberg', 'astohan-smugglers-cave']) {
    for (let hop = 0; hop < 8 && S.scenarioLocationId(state) !== location; hop += 1) {
      const { sceneArgs } = await new SceneArchitectAgent().plan({ state, decision: `Идём в ${location}`, destinationLocationId: location })
      if (!apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })) break
      project(`${location}:${hop}`)
    }
  }
  console.log(`  поход: ${records.filter((record) => record.source.startsWith('walk:')).length} записей`)
}

// --- комнаты и случаи ------------------------------------------------------------

const rooms = []
const roomIndex = new Map()
function addRoom(room) {
  const key = JSON.stringify(room ?? null)
  if (!roomIndex.has(key)) {
    rooms.push(room ?? null)
    roomIndex.set(key, rooms.length - 1)
  }
  return roomIndex.get(key)
}

const cases = []
const caseKeys = new Set()
function addCase(entry) {
  const key = JSON.stringify(entry)
  if (caseKeys.has(key)) return
  caseKeys.add(key)
  cases.push(entry)
}

for (const record of records) {
  addCase({ source: record.source, room: addRoom(record.room), actor: encode(record.actor), out: record.out })
}
const recordedRooms = rooms.length

// --- 3. заплатки ---------------------------------------------------------------

/** Записать значение по пути; недостающие и не-контейнеры — новые `{}` / `[]`. */
function setPath(target, path, value) {
  let current = target
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    const nextKey = path[index + 1]
    const fresh = () => (typeof nextKey === 'number' ? [] : {})
    let child = Array.isArray(current) ? current[key] : current[key]
    if (!child || typeof child !== 'object' || (typeof nextKey === 'number') !== Array.isArray(child)) {
      child = fresh()
      if (Array.isArray(current) && key === current.length) current.push(child)
      else current[key] = child
    }
    current = child
  }
  const last = path.at(-1)
  if (value === undefined) {
    if (Array.isArray(current)) current.splice(last, 1)
    else delete current[last]
  } else if (Array.isArray(current) && last === current.length) current.push(value)
  else current[last] = value
}

const ASSETS = [...sceneInteractionAssetIds(), 'rug', 'bench', 'broom', 'cobweb', 'нет-такого', '', 'chest', 'altar', 'grave', 'urn', 'crate', 'barrel', 'bone_pile', 'shrine']
const VERBS = ['inspect', 'open', 'take', 'use', 'topple', 'ignite', 'pray', 'левитировать', 5, null]
const NAMES = ['Бром', 'Марта', '  Старый   Хельм  ', '', '   ', 'Зевака', '😀 Весельчак', 'Ё'.repeat(70), 'a\tb\nc', null, 7, 'Ирма', 'Безымянный']
const ROLES = ['трактирщик', '', 'служитель храма и хранитель старых карт и служанка', 'хозяйка постоялого двора, вдова мельника и сплетница',
  'стражник у ворот — и не только по долгу службы', 'перевозчик через реку Митглайд; знает все броды, но', 'очень-очень-длинное-слово-без-пробелов-до-самого-конца-строки',
  'кузнец и оружейник, а ещё — бывший наёмник', 'писарь', null, 12, 'торговец, но', 'торговец пряностями из дальних южных стран а']
const IDS = ['a', 'b', 'brom', 'npc-1', 'Ω', 'z', '10', '2', 'hero', 'walk-hero', '', 'constructor']
const ACTORS = ['hero', 'walk-hero', 'walk-rogue', 'mate', 'scout', '', 'stranger', '__proto__', 'constructor', 5, null, undefined]

const coordinate = () => pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 2.5, -1, '3', null, undefined, 'x', [4]])
const position = () => {
  const value = {}
  const x = coordinate()
  const y = coordinate()
  if (x !== undefined) value.x = x
  if (y !== undefined) value.y = y
  return value
}
const randomProp = () => {
  const prop = { id: pick(['p1', 'p2', 'chest-1', 'b-crate', 'Ω', '', 5, null]), assetId: pick(ASSETS) }
  if (chance(0.85)) prop.interactive = pick([true, true, true, false, 'true'])
  if (chance(0.8)) {
    prop.interaction = {}
    if (chance(0.6)) prop.interaction.verbs = Array.from({ length: int(4) }, () => pick(VERBS))
    if (chance(0.3)) prop.interaction.pointOfInterest = pick([true, false, 'true'])
  }
  if (chance(0.5)) Object.assign(prop, { x: int(9) + 0.5, y: int(7) + 0.5 })
  if (chance(0.5)) prop.footprint = Array.from({ length: int(3) }, () => ({ x: int(9), y: int(7) }))
  return prop
}
const randomNpc = () => {
  const npc = { id: pick(IDS), name: pick(NAMES) }
  if (chance(0.7)) npc.role = pick(ROLES)
  if (chance(0.5)) npc.alive = pick([true, false, null, 'false'])
  if (chance(0.3)) npc.stance = pick(['hostile', 'neutral', 'friendly'])
  if (chance(0.7)) Object.assign(npc, position())
  return npc
}
const randomContainer = () => {
  const entry = { id: pick(['loot-1', 'loot-2', 'c', '']), name: pick(['Тело: Разбойник', 'Схрон', '  Тело:  Волк ', 'Пленный: Орк: вожак', 'Брошенное', '', null]) }
  entry.kind = pick(['corpse', 'captive', 'abandoned', 'cache', 'dropped', 'unknown', null, 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', undefined])
  if (entry.kind === undefined) delete entry.kind
  if (chance(0.3)) entry.status = pick(['emptied', 'open', 'sealed'])
  entry.item_count = pick([0, 1, 2, '3', null, -1, 'много'])
  if (chance(0.7)) entry.can_inspect = pick([true, false, 'true'])
  return entry
}
const randomTavern = () => pick([
  () => null,
  () => 'таверна',
  () => ({ drink_price_cp: pick([4, 0, '6', null, 2.5]), opponents: pick([[], [{ name: pick(NAMES) }], 'x', [null]]) }),
  () => ({ ejected: true, drink_price_cp: 4 }),
  () => ({ round: { npc_name: pick(NAMES), stake_cp: pick([10, 0, '15', null]), npc_total: pick([9, 12, '7', null, 2.5]) }, ejected: pick([true, false, undefined]) }),
  () => ({ round: true }),
])()
const randomBlessings = () => ({
  available: pick([true, false, undefined]),
  blessed: pick([true, false, undefined]),
  ...(chance(0.7) ? { priests: pick([[{ name: pick(NAMES) }], [], 'x', [{}]]) } : {}),
  prayer_dc: pick([12, 15, 0, '13', null, undefined]),
  donation_cp: pick([25, 0, '30', null, undefined]),
})
const randomLetters = () => ({
  letters: pick([[], [{ status: 'in_transit', addressee_name: pick(NAMES), place_name: pick(['Мельница', '', '   ', null, 'Очень длинное название места у дальнего края карты']) }], [{ status: 'delivered' }], 'x', [null]]),
  addressees: pick([[], [{ name: pick(NAMES), fee_cp: pick([110, 0, '40', null]) }], [{ name: 'Гость', unreachable: true }, { name: 'Мельник', fee_cp: 60 }], [5], [null], 'x']),
})
const randomBeasts = (actor) => ({
  candidates: Array.from({ length: int(3) }, () => {
    const beast = { id: pick(['wolf', 'boar', '']), name: pick(['Волк', '', null, 'Кабан']), stage: pick(['wary', 'calmed', undefined]), difficulty: pick([12, 15, '14', null]) }
    if (chance(0.3)) beast.blocked_reason = pick(['Зверь в бою', ''])
    if (chance(0.8)) {
      const key = typeof actor === 'string' ? actor : String(actor ?? '')
      beast.reach_by_hero = pick([{ [key]: { out_of_reach: pick([true, false]) } }, {}, { other: { out_of_reach: false } }, [{ out_of_reach: false }], 'x', { [key]: 5 }])
    }
    return beast
  }),
})
const randomCourt = () => ({
  purse_available: pick([true, false, 'true']),
  armory_available: pick([true, false]),
  armory_items: pick([['Длинный меч +1', 'Плащ защиты'], [], ['  ', 'ЩИТ'], [5, 'Кольцо'], 'x']),
})
const randomPlayer = (actor) => {
  const player = { id: actor, ...position() }
  if (chance(0.7)) player.currency = pick([{ copper: 50 }, { copper: 3 }, { gold: 1 }, { silver: 1 }, {}, null, { copper: '20' }, { platinum: 2 }])
  if (chance(0.6)) player.inventory = pick([[{ origin: 'stolen' }], [{ origin: 'bought' }], [], [{}], 'x', [{ origin: ['stolen'] }]])
  return player
}

const PATCHES = [
  (actor) => [['scene', 'objective'], pick(['', 'Найти писаря', '   ', 'Продолжить путь из Айрская башня к «Дормар»', 'Продолжить путь из Дормар к «Дормар»', 'Ц'.repeat(120), 5, null, undefined])],
  () => [['scene', 'location'], pick(['Айрская башня', 'Дормар', '', null, undefined])],
  () => [['scene', 'map', 'doors'], pick([[], [{ id: 'd', state: 'locked' }], [{ state: 'closed' }], [{}], 'x', [null], undefined])],
  () => [['scene', 'map', 'props'], Array.from({ length: int(6) }, randomProp)],
  () => [['scene', 'map', 'props', 0], randomProp()],
  () => [['scene_npcs'], Array.from({ length: int(5) }, randomNpc)],
  () => [['scene_npcs', 0], randomNpc()],
  () => [['mechanics', 'combat', 'active'], pick([true, false, 'true', undefined])],
  (actor) => [['mechanics', 'positions', typeof actor === 'string' ? actor : 'hero'], position()],
  (actor) => [['players'], [randomPlayer(actor), ...(chance(0.4) ? [randomPlayer('mate')] : [])]],
  () => [['loot_containers', 'containers'], Array.from({ length: int(4) }, randomContainer)],
  () => [['social', 'conversations'], Array.from({ length: int(3) }, () => (chance(0.9) ? { npc_id: pick(IDS) } : {}))],
  () => [['merchants'], pick([[], [{ id: 'm' }], 'x', undefined])],
  () => [['tavern'], randomTavern()],
  () => [['blessings'], chance(0.85) ? randomBlessings() : pick([null, undefined])],
  () => [['courier_letters'], chance(0.85) ? randomLetters() : pick([null, undefined])],
  (actor) => [['beasts'], randomBeasts(actor)],
  () => [['scenario_court'], chance(0.85) ? randomCourt() : null],
  () => [['lockpicking'], pick([{ proficient: true }, { proficient: false }, null, undefined])],
]

const baseRooms = Array.from({ length: recordedRooms }, (_, index) => index).filter((index) => rooms[index] && typeof rooms[index] === 'object' && !Array.isArray(rooms[index]))
const empty = addRoom({ scene: { objective: '', map: { props: [], doors: [] } }, scene_npcs: [], mechanics: { combat: { active: false } } })
baseRooms.push(empty, empty, empty)
for (let index = 0; index < 1800; index += 1) {
  const base = pick(baseRooms)
  const actor = pick(ACTORS)
  const patch = []
  const count = 1 + int(5)
  for (let step = 0; step < count; step += 1) {
    const [path, value] = pick(PATCHES)(actor)
    patch.push([path, encode(value)])
  }
  const room = JSON.parse(JSON.stringify(rooms[base]))
  for (const [path, value] of patch) setPath(room, path, decode(value))
  addCase({ source: 'patch', room: base, patch, actor: encode(actor), out: hintsOutcome(JSON.parse(JSON.stringify(room)), actor) })
}

// Изнанка целиком: случайные заплатки редко сходятся в связную сцену (герой с
// кошельком, собеседник рядом, разговор с ним, торговец и краденое), поэтому
// такие сцены собираются отдельно.
for (let index = 0; index < 400; index += 1) {
  const actor = pick(['hero', 'hero', 'hero', 'mate', '', undefined])
  const npcIds = ['brom', 'marta', 'npc-1', 'Ω', '']
  const npcs = Array.from({ length: 1 + int(4) }, () => ({ ...randomNpc(), id: pick(npcIds), ...(chance(0.8) ? { x: int(9), y: int(5) } : {}) }))
  const hero = { id: 'hero', x: int(9), y: int(5), currency: pick([{ copper: 50 }, { copper: 9 }, { copper: 10 }, { silver: 1 }, { gold: 2 }, {}, { copper: '15' }]) }
  if (chance(0.5)) hero.inventory = pick([[{ origin: 'stolen' }], [{ origin: 'loot' }, { origin: 'stolen' }], [], [{}]])
  const room = {
    scene: { objective: pick(['', 'Найти скупщика']), map: { props: [], doors: chance(0.3) ? [{ id: 'd', state: 'closed' }] : [] } },
    scene_npcs: npcs,
    mechanics: { combat: { active: chance(0.05) }, ...(chance(0.4) ? { positions: { hero: { x: int(9), y: int(5) } } } : {}) },
    players: [hero, ...(chance(0.4) ? [{ id: 'mate', x: 0, y: 0, currency: { copper: 100 }, inventory: [{ origin: 'stolen' }] }] : [])],
    social: { conversations: Array.from({ length: int(4) }, () => (chance(0.9) ? { npc_id: pick(npcIds) } : {})) },
    merchants: chance(0.6) ? [{ id: 'brom' }] : [],
  }
  addCase({ source: 'underworld', room: addRoom(room), actor: encode(actor), out: hintsOutcome(JSON.parse(JSON.stringify(room)), actor) })
}

// --- 4. не-объекты, бой, читатель ----------------------------------------------

for (const room of [null, 'комната', 5, true, [], [1, 2], {}, { mechanics: { combat: { active: true } }, scene: { objective: 'Выжить' } }, { mechanics: { combat: { active: 'yes' } }, scene: { objective: 'Выжить' } }]) {
  for (const actor of [undefined, 'hero']) addCase({ source: 'edge', room: addRoom(room), actor: encode(actor), out: hintsOutcome(room, actor) })
}

const constants = { MAX_ACTION_HINTS: H.MAX_ACTION_HINTS, MAX_PROP_HINTS: H.MAX_PROP_HINTS, MAX_LOOT_HINTS: H.MAX_LOOT_HINTS, THEFT_HINT_REACH_FEET: H.THEFT_HINT_REACH_FEET }
const sections = { constants, rooms, cases }
const lines = Object.entries(sections).map(([key, value]) => (Array.isArray(value)
  ? `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`
  : `${JSON.stringify(key)}: ${JSON.stringify(value)}`))
writeFileSync(new URL('./action-hints.json', import.meta.url), `{\n${lines.join(',\n')}\n}\n`)
const errors = cases.filter((entry) => entry.out.error).length
const nonEmpty = cases.filter((entry) => entry.out.result?.length).length
console.log(`action-hints.json: rooms ${rooms.length} (из записей ${recordedRooms}), cases ${cases.length} (с подсказками ${nonEmpty}, отказов ${errors})`)
