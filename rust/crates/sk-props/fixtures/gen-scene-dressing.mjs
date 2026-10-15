import '../../../fixtures-env.mjs'
// Эталон `server/scene-dressing.mjs` → `fixtures/scene-dressing.json`.
//
// - `math`: `Math.atan2` и `Math.sin(Math.atan2(dy, dx) * 3 + x)` на всей
//   области неровного края пятна (`roughenGround`) — побитно;
// - `named`: `vignettesNamedBy` по всем наборам и множеству текстов;
// - `maps`: поля, дворы, улицы и синтетические карты (`synthetic-maps.mjs`);
// - `cases`: `placeVignettes`, `roughenGround`, `markLowFurniture`,
//   `placeRuins`, `placeRuinsField` над ними, над нарисованными картами
//   `data/authored-location-maps-v1.json` и над выходом прежних случаев
//   (`from`) — хеш карты после, ответ и отказ;
// - `scenarios`: карты переносимых проверок `test/scene-dressing.test.mjs`.
//
// Запуск: node rust/crates/sk-props/fixtures/gen-scene-dressing.mjs
import { readFileSync } from 'node:fs'

import * as sd from '../../../../server/scene-dressing.mjs'
import * as t from '../../../../server/tactical-map.mjs'
import { decodeJs, encodeJs, mulberry32, restore, runOn, writeFixture } from './common.mjs'
import { picker, syntheticMap } from './synthetic-maps.mjs'

const random = mulberry32(0xd2e5_5ed)
const { pick, int, chance } = picker(random)

// --- математика ------------------------------------------------------------------

const bits = (value) => {
  const buffer = Buffer.alloc(8)
  buffer.writeDoubleLE(value)
  return buffer.readBigUInt64LE().toString(16).padStart(16, '0')
}
const atan2 = []
let sinBits = ''
for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
  atan2.push([dx, dy, bits(Math.atan2(dy, dx))])
  for (let x = 0; x <= 120; x += 1) sinBits += bits(Math.sin(Math.atan2(dy, dx) * 3 + x))
}

// Порт fdlibm проверяется и вне области: случайные аргументы до ±2¹⁹·π/2.
const sinRandom = []
const atan2Random = []
for (let index = 0; index < 3000; index += 1) {
  const x = index < 1000 ? (random() - 0.5) * 400 : index < 2000 ? (random() - 0.5) * 8 : (random() - 0.5) * 1.6e6
  sinRandom.push([bits(x), bits(Math.sin(x))])
  const y = (random() - 0.5) * (index < 1500 ? 10 : 1e6)
  const w = (random() - 0.5) * (index % 3 === 0 ? 1e-3 : 20)
  atan2Random.push([bits(y), bits(w), bits(Math.atan2(y, w))])
}

// --- слова виньеток ----------------------------------------------------------------

const SETS = Object.keys(sd.VIGNETTES)
const WORDS = ['кострище', 'Костёр догорел', 'КОСТЕР', 'у костра', 'ночлег', 'ночёвка', 'ночевка', 'следы стоянки', 'следы чужого привала', 'следы старого привала', 'брошенная стоянка', 'брошенный лагерь',
  'телега', 'повозка', 'обоз', 'фургон', 'караван', 'опрокинута', 'засада', 'могила', 'надгробие', 'похороны', 'погост', 'памятный камень', 'зверь', 'волк', 'волчьи следы', 'медведь', 'берлога', 'логово', 'хищник', 'чудище', 'чудовище', 'тварь', 'твари', 'тварей',
  'бурелом', 'поваленные деревья', 'упавшее дерево', 'упавший ствол', 'ветровал', 'искатели', 'авантюрист', 'пропавшие', 'погибшие', 'сгинул', 'останки', 'скелет', 'экспедиция', 'контрабанда', 'тайник', 'схрон', 'награбленное', 'разбойники', 'бандиты', 'краденое',
  'грибы', 'плесень', 'сырость', 'разграблен', 'разорено', 'разорён', 'мародёры', 'мародеры', 'грабители', 'осквернён', 'осквернено', 'вскрыт', 'обряд', 'ритуал', 'культ', 'жертвоприношение', 'некромант', 'сектанты', 'призыв', 'колдовской', 'чернокнижник',
  'поминки', 'память', 'предки', 'родовой', 'драка', 'потасовка', 'поножовщина', 'дебош', 'буянить', 'разгром', 'погром', 'скандал', 'мордобой', 'дрова', 'лесорубы', 'плотник', 'пилорама',
  'тихая поляна', 'обломки стен', 'Ёлки', 'ЁЖ', '', '   ', 'campfire', 'Кострище, а вокруг волчьи следы']
const named = []
for (const set of [...SETS, 'unknown', '']) {
  for (const word of WORDS) named.push([set, word, sd.vignettesNamedBy(set, word)])
  for (let index = 0; index < 30; index += 1) {
    const text = Array.from({ length: int(1, 4) }, () => pick(WORDS)).join(pick([' ', ', ', '. ', ' и ']))
    named.push([set, text, sd.vignettesNamedBy(set, text)])
  }
}

// --- карты --------------------------------------------------------------------------

/** Поле теста: трава, дорога по строке, пруд в углу, вход слева. */
function field(width = 24, height = 18, { roadRow = 9, pond = true, column = false } = {}) {
  const map = t.createTacticalMap({ width, height, seed: 'dressing', theme: 'forest' })
  t.addZone(map, { id: 'field', kind: 'exterior', material: 'grass', lightLevel: 'bright', label: 'Поляна' })
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const road = column ? x === roadRow : y === roadRow
      const water = pond && x >= width - 5 && y <= 3
      t.setCell(map, x, y, { passable: !water, revealed: true, zone: 'field', material: road ? 'earth' : 'grass', surface: water ? 'water' : 'none' })
    }
  }
  t.addSpawnPoint(map, { id: 'party', role: 'party', x: 1, y: Math.min(roadRow, height - 1) })
  return map
}

/** Деревня: улица, площадь, дворы (`common`), дом со стенами и дверью. */
function village(width = 34, height = 28) {
  const map = t.createTacticalMap({ width, height, seed: 'village', theme: 'settlement' })
  t.addZone(map, { id: 'common', kind: 'exterior', material: 'grass', label: 'Дворы' })
  t.addZone(map, { id: 'street', kind: 'exterior', material: 'earth', label: 'Улица' })
  t.addZone(map, { id: 'square', kind: 'exterior', material: 'stone', label: 'Площадь' })
  t.addZone(map, { id: 'house', kind: 'interior', material: 'wood', label: 'Дом' })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const street = y === 12 || y === 13
    const square = x >= 14 && x <= 19 && y >= 8 && y <= 17
    const house = x >= 3 && x <= 9 && y >= 2 && y <= 7
    const zone = house ? 'house' : square ? 'square' : street ? 'street' : 'common'
    t.setCell(map, x, y, { passable: true, revealed: true, zone, material: zone === 'street' ? 'earth' : zone === 'square' ? 'stone' : zone === 'house' ? 'wood' : (chance(0.1) ? 'earth' : 'grass'), surface: chance(0.02) ? 'mud' : 'none' })
  }
  for (let x = 3; x <= 9; x += 1) {
    t.setEdge(map, x, 1, x, 2, { kind: 'wall' })
    if (x !== 6) t.setEdge(map, x, 7, x, 8, { kind: 'wall' })
  }
  for (let y = 2; y <= 7; y += 1) {
    t.setEdge(map, 2, y, 3, y, { kind: y === 4 ? 'window' : 'wall' })
    t.setEdge(map, 9, y, 10, y, { kind: 'wall' })
  }
  t.setDoor(map, { id: 'house-door', x: 6, y: 7, dir: 's', state: pick(['closed', 'open']) })
  t.addSpawnPoint(map, { id: 'party', role: 'party', x: 1, y: 12 })
  t.addSpawnPoint(map, { id: 'npc', role: 'neutral', x: 16, y: 10 })
  t.addProp(map, { id: 'well', assetId: 'well', x: 17, y: 13, footprint: [{ x: 16, y: 12 }, { x: 17, y: 12 }, { x: 16, y: 13 }, { x: 17, y: 13 }], blocksMove: true })
  t.addProp(map, { id: 'stairs', assetId: 'stairs_down', x: 5, y: 3.5, footprint: [{ x: 4, y: 3 }, { x: 5, y: 3 }], transition: { toLevel: -1, label: 'Погреб' } })
  t.addProp(map, { id: 'bench-1', assetId: 'prayer_bench', x: 6, y: 5.5, footprint: [{ x: 5, y: 5 }, { x: 6, y: 5 }] })
  t.addProp(map, { id: 'cushion', assetId: 'kneeling_cushions', x: 8.5, y: 3.5, footprint: [{ x: 8, y: 3 }] })
  t.addProp(map, { id: 'crate', assetId: 'crate', x: 4.5, y: 6.5, footprint: [{ x: 4, y: 6 }], blocksMove: true })
  t.addProp(map, { id: 'fern-old', assetId: 'fern', x: 25.5, y: 20.5, footprint: [] })
  return map
}

const maps = []
const cases = []
const outputs = []
const authored = JSON.parse(readFileSync(new URL('../../../../data/authored-location-maps-v1.json', import.meta.url), 'utf8')).maps

const ops = {
  placeVignettes: (args) => (map) => sd.placeVignettes(map, args[0]),
  roughenGround: (args) => (map) => sd.roughenGround(map, args[0]),
  markLowFurniture: (args) => (map) => sd.markLowFurniture(map, args[0]),
  placeRuins: (args) => (map) => sd.placeRuins(map, args[0]),
  placeRuinsField: (args) => (map) => sd.placeRuinsField(map, args[0]),
}

function call(input, op, args) {
  const map = input.map !== undefined ? restore(maps[input.map]) : input.authored !== undefined ? t.deserializeTacticalMap(authored[input.authored]) : restore(outputs[input.from])
  cases.push({ input, op, args: encodeJs(args), ...runOn(map, ops[op](decodeJs(encodeJs(args)))) })
  outputs.push(t.serializeTacticalMap(map))
  return cases.length - 1
}

function addMap(map) {
  maps.push(t.serializeTacticalMap(map))
  return maps.length - 1
}

const KINDS = ['undergrowth', 'rubble', 'snow', 'sand', 'mud']
const SHAPES = [null, null, 'house', 'tower', 'wall', 'castle']
const LOW = ['prayer_bench', 'kneeling_cushions', 'bench', 'crate', 'rug', 'chair', 'fern']

function textFor() {
  return chance(0.5) ? '' : Array.from({ length: int(1, 3) }, () => pick(WORDS)).join(' ')
}

function dress(index, zoneIds) {
  const input = { map: index }
  const zones = () => (chance(0.3) ? null : chance(0.1) ? [] : Array.from({ length: int(1, 2) }, () => pick([...zoneIds, 'nowhere'])))
  for (let round = 0; round < 3; round += 1) {
    const vignette = { seed: chance(0.9) ? `v-${index}-${round}` : int(0, 99), set: pick([...SETS, 'unknown']), zones: zones(), text: textFor() }
    if (chance(0.6)) vignette.limit = pick([0, 1, 2, 3, -1])
    if (chance(0.3)) vignette.hugWalls = chance(0.5)
    const placed = call(input, 'placeVignettes', [vignette])
    const rough = { seed: `r-${index}-${round}`, kind: pick(KINDS), zones: zones() }
    if (chance(0.7)) rough.patches = pick([0, 1, 2, 3, 5])
    const roughened = call({ from: placed }, 'roughenGround', [rough])
    call({ from: roughened }, 'markLowFurniture', [Array.from({ length: int(0, 3) }, () => pick(LOW))])
    const ruins = { seed: `ruin-${index}-${round}` }
    if (chance(0.8)) ruins.zone = pick(zoneIds)
    if (chance(0.7)) ruins.shape = pick(SHAPES)
    if (chance(0.3)) ruins.index = int(1, 4)
    call(input, 'placeRuins', [ruins])
    const ruinsField = { seed: `field-${index}-${round}` }
    if (chance(0.8)) ruinsField.zone = pick(zoneIds)
    if (chance(0.5)) ruinsField.asked = chance(0.5)
    if (chance(0.5)) ruinsField.chance = pick([0, 0.25, 0.4, 0.9, 1])
    call({ from: roughened }, 'placeRuinsField', [ruinsField])
  }
}

// Поля разных размеров: дорога строкой и столбцом, с прудом и без.
for (let index = 0; index < 40; index += 1) {
  const width = int(8, index < 30 ? 40 : 60)
  const height = int(8, index < 30 ? 32 : 50)
  const map = field(width, height, { roadRow: int(1, Math.min(width, height) - 2), pond: chance(0.6), column: chance(0.3) })
  dress(addMap(map), ['field'])
}
for (let index = 0; index < 10; index += 1) dress(addMap(village(int(24, 44), int(20, 38))), ['common', 'street', 'square', 'house'])
for (let index = 0; index < 60; index += 1) {
  const map = syntheticMap(1000 + index, random)
  dress(addMap(map), map.zones.map((zone) => zone.id))
}

// Нарисованные карты: обстановка по теме места.
const SET_BY_THEME = { forest: 'wild', road: 'wild', cave: 'cave', crypt: 'crypt', building: 'tavern', settlement: 'settlement', temple: 'crypt' }
authored.forEach((raw, index) => {
  const input = { authored: index }
  const zoneIds = (raw.zones ?? []).map((zone) => zone.id)
  call(input, 'placeVignettes', [{ seed: `authored-${index}`, set: SET_BY_THEME[raw.theme] ?? 'wild', zones: null, limit: 2, text: 'кострище, телега, грибы, обряд, драка, дрова, могила' }])
  call(input, 'roughenGround', [{ seed: `authored-${index}`, kind: pick(KINDS), zones: zoneIds.slice(0, 3), patches: 3 }])
  call(input, 'markLowFurniture', [['prayer_bench', 'kneeling_cushions', 'bench']])
  call(input, 'placeRuinsField', [{ seed: `authored-${index}`, zone: zoneIds[0] ?? 'field', asked: true, chance: 0.9 }])
  call(input, 'placeRuins', [{ seed: `authored-ruin-${index}`, zone: zoneIds[0] ?? 'field' }])
})

// --- сценарии переносимых тестов --------------------------------------------------------

const scenarios = {
  field: addMap(field()),
  wide: addMap(field(30, 22)),
  large: addMap(field(48, 40)),
}
for (const shape of ['house', 'tower', 'wall']) call({ map: scenarios.wide }, 'placeRuins', [{ seed: `ruins-${shape}`, shape }])
call({ map: scenarios.large }, 'placeRuinsField', [{ seed: 'field-1', asked: true }])
call({ map: scenarios.field }, 'placeRuinsField', [{ seed: 'field-2', asked: false, chance: 0 }])
call({ map: scenarios.field }, 'placeVignettes', [{ seed: 'v1', set: 'wild', zones: ['field'], limit: 2 }])
call({ map: scenarios.field }, 'placeVignettes', [{ seed: 'v1', set: 'wild', zones: ['field'], limit: 0, text: 'У обочины опрокинута телега, рядом кострище' }])
call({ map: scenarios.field }, 'roughenGround', [{ seed: 'r1', kind: 'undergrowth', zones: ['field'], patches: 3 }])
call({ map: scenarios.field }, 'roughenGround', [{ seed: 'r2', kind: 'rubble', zones: ['field'], patches: 2 }])
call({ map: scenarios.field }, 'roughenGround', [{ seed: 'r3', kind: 'mud', zones: ['field'], patches: 2 }])

writeFixture(new URL('./scene-dressing.json', import.meta.url), {
  sets: SETS,
  atan2,
  sin: { dx: [-3, 3], dy: [-3, 3], x: [0, 120], bits: sinBits },
  sinRandom,
  atan2Random,
  named,
  scenarios,
  maps,
  cases,
})
const byOp = cases.reduce((total, entry) => ({ ...total, [entry.op]: (total[entry.op] ?? 0) + 1 }), {})
console.log(byOp, 'с отказом', cases.filter((entry) => entry.error).length, 'ответов с местом', cases.filter((entry) => Array.isArray(entry.result) ? entry.result.length : entry.result).length)
