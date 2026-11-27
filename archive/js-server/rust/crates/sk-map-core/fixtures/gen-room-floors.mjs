import '../../../fixtures-env.mjs'
// Эталон server/room-floors.mjs для Rust:
//
//   node rust/crates/sk-map-core/fixtures/gen-room-floors.mjs
//
// - `roomFloorFor` — подписи и id зон всех правил, назначения и материалы
//   построек полным перебором;
// - `buildingWallStyleFor` — перебор назначения, материала и города;
// - `applyRoomFloors` — случайные планировки (до и после тонких стен) со
//   случайными параметрами: кладка, запасной пол (в том числе незнакомый
//   материал — отказ `setCell`), предикат зон (эталон хранит его ответ по
//   каждой зоне). Вызовы изнутри генераторов — в `generator-calls.json`.
import * as t from '../../../../server/tactical-map.mjs'
import { ROOM_FLOORS_VERSION, applyRoomFloors, buildingWallStyleFor, roomFloorFor } from '../../../../server/room-floors.mjs'
import { thinWalls } from '../../../../server/thin-walls.mjs'
import { attempt, encode, hash, mulberry32, writeFixture } from './common.mjs'
import { randomLayout } from './layouts.mjs'

const random = mulberry32(2026_10_25)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p

const USES = ['', 'tavern', 'manor', 'barracks', 'temple', 'crypt', 'dungeon', 'shop', 'smithy', 'workshop']
const ARCHITECTURES = ['wood', 'stone', 'marble', 'ice', 'earth']
const ZONES = [
  ['hall', 'Общий зал'], ['hall', 'Горница'], ['hall', 'Зал'], ['kitchen', 'Кухня'], ['store', 'Кладовая'], ['store', ''],
  ['zone-3', 'Камеры'], ['cells', ''], ['cellar', 'Погреб'], ['cellar', 'Подвал'], ['bedroom', 'Спальня'], ['salon', 'Салон'],
  ['study', 'Кабинет'], ['library', 'Библиотека'], ['nave', 'Неф'], ['altar', 'Алтарная'], ['crypt-1', 'Погребальная'],
  ['ballroom', 'Бальный зал'], ['smithy', 'Кузня'], ['forge', ''], ['workshop', 'Мастерская'], ['zone-1', 'Столярная'],
  ['stable', 'Конюшня'], ['barn', 'Сеновал'], ['armory', 'Оружейная'], ['barracks', 'Казарма'], ['guard', 'Караульная'],
  ['building-3', 'Дом'], ['building-4-back', 'Жильё'], ['x', 'Приёмная'], ['y', 'Гостиная'], ['chapel', 'Часовня'],
  ['zone-9', 'Святилище'], ['prisoncell', ''], ['excellent', ''], ['CELLS', 'КАМЕРА'], ['z', 'Темница'], ['w', 'Резиденция'],
  ['v', 'Постоялый двор'], ['u', 'Питейная'], ['s', 'Молельня'], ['r', 'Амбар'], ['q', 'Сарай'], ['p', 'Хлев'], ['o', 'Скотный двор'],
  ['n', 'Красильня'], ['m', 'Гончарная'], ['living-room', ''], ['storehouse', ''], ['', ''], ['empty', 'Пустая'],
]
const floorFor = []
for (const [id, label] of ZONES) {
  for (const use of USES) {
    for (const architecture of [...ARCHITECTURES, undefined]) {
      const zone = label === '' && chance(0.5) ? { id } : { id, label }
      const context = {}
      if (use !== '' || chance(0.5)) context.use = use
      if (architecture !== undefined) context.architecture = architecture
      floorFor.push({ zone, context, result: roomFloorFor(zone, context) })
    }
  }
}
floorFor.push({ zone: { id: 'kitchen', label: 'Кухня' }, context: null, result: roomFloorFor({ id: 'kitchen', label: 'Кухня' }) })

const wallStyle = []
for (const use of USES) {
  for (const architecture of [...ARCHITECTURES, undefined]) {
    for (const urban of [true, false, undefined]) {
      const context = { use }
      if (architecture !== undefined) context.architecture = architecture
      if (urban !== undefined) context.urban = urban
      wallStyle.push({ context, result: buildingWallStyleFor(context) })
    }
  }
}

const apply = []
for (let index = 0; index < 200; index += 1) {
  const layout = randomLayout(t, random, `room-floors:${index}`)
  if (chance(0.6)) thinWalls(layout)
  // Иногда у зоны уже есть рисунок и кладка — так карта приходит после чтения.
  for (const zone of layout.zones) {
    if (chance(0.1)) zone.floor = pick(t.FLOOR_STYLES)
    if (chance(0.1)) zone.wall = pick(t.WALL_STYLES)
  }
  const before = JSON.parse(JSON.stringify(t.serializeTacticalMap(layout)))
  const map = t.deserializeTacticalMap(before)
  const options = {}
  if (chance(0.7)) options.use = pick(USES)
  if (chance(0.7)) options.architecture = pick(ARCHITECTURES)
  if (chance(0.4)) options.wall = pick([...t.WALL_STYLES, 'glass', '', null])
  if (chance(0.3)) options.defaultFloor = pick([{ material: 'marble', floor: 'mosaic' }, { material: 'wood', floor: null }, { material: 'stone', floor: 'lava' }, { material: 'gold', floor: 'parquet' }, null])
  let zones = null
  if (chance(0.3)) {
    const prefix = pick(['b0', 'b1', 'hall', 'walls', 'x'])
    zones = map.zones.map((zone) => zone.id.startsWith(prefix))
    options.zones = (zone) => zone.id.startsWith(prefix)
  }
  const outcome = attempt(() => applyRoomFloors(map, Object.keys(options).length || chance(0.5) ? options : undefined))
  const { zones: _predicate, ...plain } = options
  const after = t.serializeTacticalMap(map)
  apply.push({ before, options: plain, zones, outcome, after: index < 16 ? after : hash(after) })
}

writeFixture(new URL('./room-floors.json', import.meta.url), {
  version: ROOM_FLOORS_VERSION,
  floorFor: floorFor.map((entry) => ({ ...entry, result: encode(entry.result) })),
  wallStyle: wallStyle.map((entry) => ({ ...entry, result: encode(entry.result) })),
  apply,
})
