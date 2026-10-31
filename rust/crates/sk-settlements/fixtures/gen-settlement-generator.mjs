import '../../../fixtures-env.mjs'
// Эталон server/settlement-generator.mjs для Rust:
//
//   node rust/crates/sk-settlements/fixtures/gen-settlement-generator.mjs
//   node rust/crates/sk-settlements/fixtures/gen-settlement-generator.mjs --dump <label>
//
// Второй вид печатает полную сериализованную карту случая — для отладки
// расхождения (в эталоне карта хранится хешем).
//
// Источники случаев:
//
// - тест: входы `test/settlement-generator.test.mjs` дословно (все топологии,
//   вода, рынок, двор, ворота, изгибы, крылья, река и канал, дороги к дверям,
//   торговые ряды);
// - конвейер: `generateSceneGeometry` по корпусу мест (как у эталона
//   sk-tactical), рыночные сцены теста и `createSceneTransition` теста
//   `scene-entry-road` — вход `buildSettlementScene` пойман перехватчиком
//   (`capture.mjs`) вместе с хешем карты, которую вернул сервер;
// - случайные входы: топология, масштаб, плотность, климат, архитектура,
//   назначение, площадь, размеры, темы объектом и строкой, слова темы.
//
// Для каждого случая — хеш карты, назначения построек и коды замечаний
// `auditTacticalMap` (крейта `map-quality` в Rust ещё нет: совпадение карты
// байт в байт означает и совпадение аудита).
import { captured } from './capture.mjs'
import { errorOf, hash, mulberry32, picker, plain, writeFixture } from './common.mjs'

const t = await import('../../../../server/tactical-map.mjs')
const sg = await import('../../../../server/settlement-generator.mjs?real')
const { generateSceneGeometry, createSceneTransition } = await import('../../../../server/adventure-director.mjs')
const { auditTacticalMap } = await import('../../../../server/map-quality.mjs')
const { sceneMapRequirementsFor } = await import('../../../../server/scene-requirements.mjs')
const { readFileSync } = await import('node:fs')

const { int, pick, chance } = picker(mulberry32(2026_10_15))

const cases = []
const labels = new Set()
/** Случай: вход `buildSettlementScene` и его выход. */
function addCase(label, options, extra = {}) {
  if (labels.has(label)) throw new Error(`повтор метки ${label}`)
  labels.add(label)
  const input = plain(options) ?? {}
  let result
  try {
    const built = sg.buildSettlementScene(input)
    result = { mapHash: hash(t.serializeTacticalMap(built.map)), uses: built.uses, warnings: built.warnings, audit: auditTacticalMap(built.map).problems.map((problem) => problem.code) }
  } catch (error) {
    result = { error: errorOf(error) }
  }
  cases.push({ label, options: input, ...result, ...extra })
}

// --- тест ---------------------------------------------------------------------------

const theme = { id: 'settlement', label: 'Поселение', surfaceMaterial: 'grass', streetMaterial: 'earth', houseMaterial: 'wood' }
const topologies = ['organic', 'linear', 'crossroads', 'market', 'courtyard', 'harbor', 'river', 'terraced', 'gate']
for (const topology of topologies) addCase(`test/topology/${topology}`, { seed: `topology-${topology}`, width: 28, height: 28, locationId: topology, theme, design: { topology } })
addCase('test/same', { seed: 'same-settlement', width: 30, height: 30, locationId: 'same', theme, design: {} })
for (let index = 0; index < 12; index += 1) addCase(`test/varied/${index}`, { seed: `varied-${index}`, width: 28, height: 28, locationId: `varied-${index}`, theme, design: {} })
for (const topology of ['river', 'harbor']) addCase(`test/water/${topology}`, { seed: `water-${topology}`, width: 30, height: 30, locationId: topology, theme, design: { topology } })
for (const topology of ['market', 'courtyard', 'gate']) addCase(`test/own/${topology}`, { seed: `${topology}-topology`, width: 30, height: 30, locationId: topology, theme, design: { topology } })
for (let index = 0; index < 12; index += 1) {
  addCase(`test/streets/crossroads/${index}`, { seed: `streets-${index}`, width: 32, height: 30, theme, design: { topology: 'crossroads' } })
  addCase(`test/streets/organic/${index}`, { seed: `streets-${index}`, width: 32, height: 30, theme, design: { topology: 'organic' } })
}
for (let index = 0; index < 24; index += 1) {
  addCase(`test/wing/${index}`, { seed: `organic-wing-${index}`, width: 30, height: 30, locationId: 'organic', theme, design: { topology: 'organic', density: 'mixed' } })
  addCase(`test/dense-gate/${index}`, { seed: `dense-gate-${index}`, width: 30, height: 30, locationId: 'gate', theme, design: { topology: 'gate', density: 'dense' } })
}
for (const seed of ['bend-a', 'bend-b']) addCase(`test/bend/${seed}`, { seed, width: 44, height: 38, theme: 'деревня у реки', design: { topology: 'river', scale: 'village' } })
addCase('test/canal', { seed: 'canal', width: 48, height: 44, theme: 'город у реки', design: { topology: 'river', scale: 'town' } })
for (const topology of topologies) for (const scale of ['village', 'town']) for (const seed of ['a', 'b', 'c']) {
  addCase(`test/road/${topology}/${scale}/${seed}`, { seed: `road-${topology}-${scale}-${seed}`, width: 48, height: 44, locationId: topology, theme, design: { topology, scale, density: 'dense' } })
}
for (const scale of ['village', 'town', 'city']) for (const seed of ['a', 'b', 'c', 'd']) {
  addCase(`test/market/${scale}/${seed}`, { seed: `market-${scale}-${seed}`, width: 48, height: 44, theme, design: { topology: 'market', scale } })
}
// Замысел `null` — JS падает TypeError в обеих попытках.
addCase('error/design-null', { seed: 'null-design', theme, design: null })

// --- конвейер -------------------------------------------------------------------------

function pipeline(label, run) {
  const before = captured.settlement.length
  try {
    run()
  } catch (error) {
    console.log(`  конвейер отказал на ${label}: ${error.message}`)
  }
  const calls = captured.settlement.slice(before)
  calls.forEach((call, index) => addCase(`pipeline:${label}${calls.length > 1 ? `#${index}` : ''}`, call.options, { pipelineHash: call.mapHash, pipelineUses: call.uses }))
}
const scene = (label, input) => pipeline(label, () => generateSceneGeometry({ ...input, useLibrary: false }))

const locations = ['Таверна', 'Храм', 'Склеп', 'Подземелье', 'Пещера', 'Тёмный лес', 'Дорога', 'Кладбище', 'Деревня', 'Город', 'Замок', 'Мост через ущелье', 'Порт', 'Кузница', 'Рынок', 'Руины', 'Болото']
for (const location of locations) {
  scene(`${location}/fixture`, { location, seed: `fixture:${location}` })
  scene(`${location}/fixture-2`, { location, seed: `fixture-2:${location}`, entrySide: pick(['east', 'north', 'south']) })
}
const programCorpus = JSON.parse(readFileSync(new URL('../../../../test/fixtures/scene-programs/corpus.json', import.meta.url), 'utf8'))
for (const entry of programCorpus.scenes) {
  const program = sceneMapRequirementsFor([entry.location, entry.text], { npcs: entry.npcs })
  scene(`corpus/${entry.id}`, { location: entry.location, theme: entry.theme, settlementType: entry.settlementType ?? '', requirements: program?.items ?? [], program, seed: `corpus:${entry.id}` })
}
for (const [label, input] of [
  ['деревня', { location: 'Торжок', theme: 'деревня рынок', settlementType: 'village', map: { design: { topology: 'market' } } }],
  ['город', { location: 'Суконная площадь', theme: 'город рынок', settlementType: 'town', map: { design: { topology: 'market' } } }],
]) {
  for (const seed of ['s1', 's2', 's3']) scene(`market-scene/${label}/${seed}`, { ...input, seed: `market-scene:${label}:${seed}` })
}
const settlementPlaces = [
  ['Деревня', 'деревня', 'village'], ['Ольшанка', 'деревня', 'village'], ['Приречье', 'деревня у реки', 'village'], ['Рыбацкий посёлок', 'порт', 'village'],
  ['Город', 'город', 'town'], ['Столица', 'город', 'city'], ['Торговый город', 'рынок', 'town'], ['Портовый город', 'порт', 'town'],
  ['Хутор', 'хутор', ''], ['Застава', 'застава', ''], ['Оазис', 'пустынный оазис', 'village'], ['Северная деревня', 'снег', 'village'],
]
for (const [location, themeWords, settlementType] of settlementPlaces) {
  for (let index = 0; index < 6; index += 1) scene(`place/${location}/${index}`, { location, theme: themeWords, settlementType, seed: `${location}:${index}` })
}
// Вход по дороге (`test/scene-entry-road.test.mjs`).
const WORLD = {
  seed: 'entry-road',
  currentLocationId: 'brod',
  locations: [
    { id: 'brod', name: 'Старый Брод', kind: 'village', x: 500, y: 120, known: true, visited: true },
    { id: 'olsh', name: 'Ольшанка', kind: 'village', x: 500, y: 420, known: true },
    { id: 'east', name: 'Восточный хутор', kind: 'village', x: 820, y: 420, known: true },
  ],
}
const stateAt = (locationId, location) => ({
  sessionCode: 'ENTRY',
  worldMap: structuredClone({ ...WORLD, currentLocationId: locationId }),
  scene: { title: location, location, location_id: locationId, turn: 1 },
  adventure: { chapter: 1, history: [], visitedLocations: [location] },
})
for (const [from, fromName] of [['brod', 'Старый Брод'], ['east', 'Восточный хутор']]) {
  pipeline(`entry-road/${from}`, () => createSceneTransition({
    title: 'Ольшанка', location: 'Ольшанка', location_id: 'olsh', theme: 'деревня', objective: 'Найти старосту',
    arrival: 'Дорога выводит отряд к деревне.', objective_status: 'completed',
  }, stateAt(from, fromName)))
}
pipeline('entry-road/square', () => createSceneTransition({
  title: 'Ольшанка', location: 'Ольшанка', location_id: 'olsh', theme: 'деревня', objective: 'Найти старосту',
  arrival: 'В центре деревни — общий навес, под ним собираются жители.', objective_status: 'completed',
}, stateAt('brod', 'Старый Брод')))

// --- случайные входы ----------------------------------------------------------------------

const THEMES = [
  theme, {}, { id: 'settlement' }, { id: 'settlement', label: 'Портовый посёлок' }, { id: 'settlement', label: 'Деревня у реки' },
  { id: 'settlement', label: 'Торговый город' }, { id: 'settlement', label: 'Застава у ворот' }, { id: 'settlement', label: 'Пустынный оазис' },
  { id: 'settlement', label: 'Северная деревня, снег' }, { id: 'settlement', label: 'Металлическая станция' }, { id: 'settlement', label: 'Таверна у дороги' },
  { id: 'settlement', label: 'Лавка' }, { id: 'settlement', label: 'Болотные топи' }, { id: 'settlement', houseMaterial: 'stone', streetMaterial: 'stone' },
  { id: 'settlement', houseMaterial: 'marble', streetMaterial: 'marble' }, { id: 'settlement', houseMaterial: 'brick' }, { id: 7, label: 'Дворец' },
  'деревня у реки', 'порт', null, { id: null, label: 'лёд' },
]
const DESIGN_KEYS = {
  topology: [...topologies, 'spiral'],
  scale: ['village', 'town', 'city', '', 'metropolis'],
  density: ['sparse', 'mixed', 'dense', 'crowded'],
  climate: ['temperate', 'arid', 'cold', 'wetland', 'tropic'],
  architecture: ['wood', 'stone', 'sand', 'metal', 'marble', 'ice', 'brick'],
  building_use: ['dwelling', 'tavern', 'shop', 'manor', 'barn'],
  square: [true, false, 'yes'],
}
for (let index = 0; index < 600; index += 1) {
  const design = {}
  for (const [key, values] of Object.entries(DESIGN_KEYS)) if (chance(key === 'topology' || key === 'scale' ? 0.75 : 0.35)) design[key] = pick(values)
  const options = { seed: pick([`r${index}`, `поселение ${index}`, `${index}`]), theme: pick(THEMES), design }
  if (chance(0.9)) options.width = pick([20, 26, 28, 30, 32, 36, 40, 44, 48, 52, 56, 60, 64, 30.5])
  if (chance(0.9)) options.height = pick([20, 26, 28, 30, 34, 38, 44, 52, 60, 70])
  if (chance(0.4)) options.locationId = pick(['loc', `место-${index}`, '  с пробелами  '])
  addCase(`random/${index}`, options)
}

// --- запись ------------------------------------------------------------------------------

const dump = process.argv.indexOf('--dump')
if (dump > 0) {
  const label = process.argv[dump + 1]
  const found = cases.find((entry) => entry.label === label)
  if (!found) throw new Error(`нет случая ${label}`)
  console.log(JSON.stringify(t.serializeTacticalMap(sg.buildSettlementScene(found.options).map)))
} else {
  for (const entry of cases) {
    if (entry.pipelineHash && entry.pipelineHash !== entry.mapHash) throw new Error(`${entry.label}: карта конвейера не повторилась`)
  }
  console.log(`  конвейер: ${cases.filter((entry) => entry.label.startsWith('pipeline:')).length} вызовов, отказов ${cases.filter((entry) => entry.error).length}`)
  writeFixture(new URL('./settlement-generator.json', import.meta.url), { cases })
}
