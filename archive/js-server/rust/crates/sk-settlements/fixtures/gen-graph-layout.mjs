import '../../../fixtures-env.mjs'
// Эталон server/graph-layout.mjs для Rust:
//
//   node rust/crates/sk-settlements/fixtures/gen-graph-layout.mjs
//   node rust/crates/sk-settlements/fixtures/gen-graph-layout.mjs --dump <label>
//
// Второй вид печатает полную сериализованную карту случая — для отладки
// расхождения (в эталоне карта хранится хешем).
//
// Источники случаев:
//
// - конвейер: `generateSceneGeometry` по корпусу мест и сидов (тот же, что у
//   эталона sk-tactical), склеп теста `graph-layout-crypt` и встречи в
//   склепе — вход `buildSceneFromGraph` пойман перехватчиком (`capture.mjs`)
//   вместе с хешем карты, которую вернул сервер; для склепа теста — ещё и
//   итог `auditTacticalMap` готовой сцены;
// - темы: `sceneGraphForTheme` храма, склепа и подземелья по сидам, размерам
//   и материалам;
// - случайные графы: зоны снаружи и внутри, ключи, все виды связей, петли,
//   повторы id, висячие связи, вход без зоны, негодный материал;
// - функции по отдельности: `splitArea`, `sharedWall`, `assignZonesToLeaves`,
//   `planChambers` на ГПСЧ mulberry32.
import { captured } from './capture.mjs'
import { errorOf, hash, mulberry32, picker, plain, writeFixture } from './common.mjs'

const t = await import('../../../../server/tactical-map.mjs')
const sg = await import('../../../../server/scene-graph.mjs')
const gl = await import('../../../../server/graph-layout.mjs?real')
const { generateSceneGeometry } = await import('../../../../server/adventure-director.mjs')
const { SCENE_THEMES, sceneGraphForTheme } = await import('../../../../server/scene-themes.mjs')
const { auditTacticalMap } = await import('../../../../server/map-quality.mjs')

const { int, pick, chance } = picker(mulberry32(2026_10_15))

const rectJson = (rect) => ({ minX: rect.minX, minY: rect.minY, maxX: rect.maxX, maxY: rect.maxY })
const roomsJson = (rooms) => [...rooms].map(([zone, rect]) => [zone, rectJson(rect)])

/** Выход раскладки и сборки по графу; карта — хешем. */
function layoutCase(graph, options) {
  let layout
  let build
  try {
    const built = gl.layoutSceneGraph(graph, options)
    layout = { mapHash: hash(t.serializeTacticalMap(built.map)), rooms: roomsJson(built.rooms), warnings: built.warnings }
  } catch (error) {
    layout = { error: errorOf(error) }
  }
  try {
    const built = gl.buildSceneFromGraph(graph, options)
    build = { mapHash: hash(t.serializeTacticalMap(built.map)), warnings: built.warnings, errors: plain(built.errors) }
  } catch (error) {
    build = { error: errorOf(error) }
  }
  return { layout, build }
}

const cases = []
const labels = new Set()
function addCase(label, graph, options, extra = {}) {
  if (labels.has(label)) throw new Error(`повтор метки ${label}`)
  labels.add(label)
  const input = { graph: plain(graph), options: plain(options) }
  cases.push({ label, ...input, ...layoutCase(input.graph, input.options), ...extra })
}

// --- конвейер ---------------------------------------------------------------

/** Сцена конвейера; пойманные вызовы — случаи с хешем карты сервера. */
function pipeline(label, input, extra = () => ({})) {
  const before = captured.graphLayout.length
  let scene
  try {
    scene = generateSceneGeometry({ ...input, useLibrary: false })
  } catch (error) {
    console.log(`  конвейер отказал на ${label}: ${error.message}`)
    return
  }
  const calls = captured.graphLayout.slice(before)
  calls.forEach((call, index) => {
    addCase(`pipeline:${label}${calls.length > 1 ? `#${index}` : ''}`, call.graph, call.options, { pipelineHash: call.mapHash, ...extra(scene.map) })
  })
}

const locations = ['Таверна', 'Храм', 'Склеп', 'Подземелье', 'Пещера', 'Тёмный лес', 'Дорога', 'Кладбище', 'Деревня', 'Город', 'Замок', 'Мост через ущелье', 'Порт', 'Кузница', 'Рынок', 'Руины', 'Болото']
for (const location of locations) {
  pipeline(`${location}/fixture`, { location, seed: `fixture:${location}` })
  pipeline(`${location}/fixture-2`, { location, seed: `fixture-2:${location}`, entrySide: pick(['east', 'north', 'south']) })
}
const { readFileSync } = await import('node:fs')
const { sceneMapRequirementsFor } = await import('../../../../server/scene-requirements.mjs')
const programCorpus = JSON.parse(readFileSync(new URL('../../../../test/fixtures/scene-programs/corpus.json', import.meta.url), 'utf8'))
for (const scene of programCorpus.scenes) {
  const program = sceneMapRequirementsFor([scene.location, scene.text], { npcs: scene.npcs })
  pipeline(`corpus/${scene.id}`, { location: scene.location, theme: scene.theme, settlementType: scene.settlementType ?? '', requirements: program?.items ?? [], program, seed: `corpus:${scene.id}` })
}
// Подземные места по сидам и размерам: храм, склеп, подземелье с разными словами.
const underground = [
  ['Храм', 'храм'], ['Заброшенный храм', 'храм'], ['Святилище', 'храм'], ['Фамильный склеп', 'склеп'], ['Склеп', 'склеп'],
  ['Катакомбы', 'склеп'], ['Подземелье', 'подземелье'], ['Тюрьма', 'подземелье'], ['Логово с сокровищами', 'подземелье'], ['Темница замка', 'подземелье'],
]
const sizes = [{}, { width: 26, height: 26 }, { width: 30, height: 30 }, { width: 36, height: 30 }, { width: 40, height: 32 }, { width: 44, height: 40 }, { width: 20, height: 18 }, { width: 60, height: 60 }]
for (const [location, theme] of underground) {
  for (let index = 0; index < 12; index += 1) {
    const map = pick(sizes)
    pipeline(`${location}/${index}`, { location, theme, seed: `${location}:${index}`, map })
  }
}
// Склеп теста `graph-layout-crypt`: готовая сцена проходит аудит карты.
for (const [width, height] of [[26, 26], [36, 30], [40, 32]]) {
  for (const seed of ['s1', 's2', 's3', 's4']) {
    pipeline(`crypt-test/${width}x${height}/${seed}`, { location: 'Фамильный склеп', theme: 'склеп', seed: `crypt:${seed}`, map: { width, height } },
      (map) => ({ audit: auditTacticalMap(map).problems }))
  }
}
for (const seed of ['same', 'other', 's1', 's2', 's3', 's4']) {
  pipeline(`crypt-test/default/${seed}`, { location: 'Фамильный склеп', theme: 'склеп', seed: `crypt:${seed}`, map: {} }, (map) => ({ audit: auditTacticalMap(map).problems }))
}
for (const seed of ['enc:1', 'enc:2', 'enc:3', 'enc:4']) pipeline(`crypt-encounter/${seed}`, { location: 'Фамильный склеп', theme: 'склеп', seed })

// --- темы --------------------------------------------------------------------

const graphThemes = SCENE_THEMES.filter((theme) => theme.kind === 'graph' && theme.id !== 'cave')
const CRYPT = SCENE_THEMES.find((theme) => theme.id === 'crypt')
// Случаи теста `graph-layout-crypt` по именам: Rust проверяет их свойства.
for (const seed of ['t1', 't2', 't3', 't4', 't5', 't6']) {
  addCase(`crypt-topology/${seed}`, sceneGraphForTheme(CRYPT, seed), { seed, width: 26, height: 26, theme: 'crypt', material: 'stone' })
  addCase(`crypt-rooms/${seed}`, sceneGraphForTheme(CRYPT, seed), { seed, width: 26, height: 26, theme: 'crypt' })
}
addCase('crypt-small', sceneGraphForTheme(CRYPT, 'small'), { seed: 'small', width: 16, height: 16, theme: 'crypt' })
addCase('crypt-tiny', sceneGraphForTheme(CRYPT, 'small'), { seed: 'tiny', width: 12, height: 12, theme: 'crypt' })
const materials = ['stone', 'marble', 'wood', 'earth', 'sand', 'metal', 'ice', 'grass']
for (const theme of graphThemes) {
  for (let index = 0; index < 60; index += 1) {
    const graph = sceneGraphForTheme(theme, `theme:${index}`)
    const width = pick([12, 14, 16, 18, 20, 22, 26, 26, 30, 34, 40, 48, 60, 26.5, 25.4])
    const height = chance(0.6) ? width : pick([12, 16, 20, 26, 30, 36, 44, 60])
    const options = { seed: `${theme.id}:${index}`, width, height, theme: theme.id, material: chance(0.7) ? theme.material : pick(materials), locationId: chance(0.3) ? `loc-${index}` : '' }
    addCase(`theme/${theme.id}/${index}`, graph, options)
  }
}

// --- случайные графы ----------------------------------------------------------

const ZONE_LABELS = ['', 'Вход', 'Зал', 'Галерея', 'Тайник', 'Погребальная', 'галерея предков', 'Камеры', 'Склад', '  Притвор  ']
const LINK_KINDS = ['open', 'door', 'locked', 'secret', 'oneway', 'door', 'open', 'locked', 'weird']
const KEYS = ['k1', 'k2', 'goal-key']

function randomRecipe() {
  const count = 1 + int(8)
  const ids = Array.from({ length: count }, (_, index) => pick([`z${index}`, `zone-${index}`, `к${index}`, `room ${index}`]))
  if (count > 2 && chance(0.05)) ids[count - 1] = ids[1]
  const zones = ids.map((id, index) => ({
    id,
    kind: chance(0.15) ? 'exterior' : 'interior',
    required: chance(0.4),
    label: pick(ZONE_LABELS),
    keys: chance(0.25) ? [pick(KEYS)] : index > 0 && chance(0.1) ? [pick(KEYS), pick(KEYS)] : [],
  }))
  const links = []
  for (let index = 1; index < count; index += 1) {
    const kind = pick(LINK_KINDS)
    links.push({
      ...(chance(0.9) ? { id: `l${index}` } : {}),
      from: ids[chance(0.7) ? index - 1 : int(index)],
      to: ids[index],
      kind,
      keyId: kind === 'locked' ? (chance(0.85) ? pick(KEYS) : null) : (chance(0.05) ? 'k1' : null),
      ...(chance(0.1) ? { bidirectional: false } : {}),
    })
  }
  if (chance(0.3) && count > 2) links.push({ id: 'loop', from: ids[int(count)], to: ids[int(count)], kind: pick(LINK_KINDS), keyId: chance(0.3) ? pick(KEYS) : null })
  if (chance(0.05)) links.push({ id: 'dangling', from: ids[0], to: 'nowhere', kind: 'door' })
  let entranceZoneId = ids[0]
  if (chance(0.04)) {
    entranceZoneId = 'ghost'
    links.push({ id: 'from-ghost', from: 'ghost', to: ids[0], kind: pick(['door', 'open']) })
  }
  const goalZoneId = chance(0.8) ? ids[count - 1] : chance(0.5) ? '' : 'nowhere'
  return { entranceZoneId, goalZoneId, zones, links }
}

function randomOptions(index) {
  const options = {}
  if (chance(0.95)) options.seed = pick([`r${index}`, `случай ${index}`, `${index}`])
  if (chance(0.9)) options.width = pick([8, 12, 14, 16, 20, 24, 26, 30, 34, 40, 50, 60, 70, 25.5, 12.5, 33.49])
  if (chance(0.9)) options.height = chance(0.5) && options.width ? options.width : pick([8, 12, 16, 22, 26, 30, 40, 60, 64])
  if (chance(0.9)) options.theme = pick(['crypt', 'crypt', 'crypt', 'dungeon', 'temple', '', 'cave', 'Склеп'])
  if (chance(0.85)) options.material = chance(0.97) ? pick(materials) : 'lava'
  if (chance(0.3)) options.locationId = `  место ${index}  `
  return options
}

for (let index = 0; index < 700; index += 1) {
  const graph = sg.createSceneGraph(randomRecipe())
  addCase(`random/${index}`, graph, randomOptions(index))
}
// Вход без зоны, на который ссылаются связи, в склепе: JS падает TypeError
// на обходном ходе.
addCase('ghost-entrance/crypt', sg.createSceneGraph({
  entranceZoneId: 'ghost',
  goalZoneId: 'c',
  zones: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  links: [{ id: 'g', from: 'ghost', to: 'a', kind: 'door' }, { id: 'ab', from: 'a', to: 'b', kind: 'door' }, { id: 'bc', from: 'b', to: 'c', kind: 'door' }],
}), { seed: 'ghost', width: 30, height: 30, theme: 'crypt' })
// Граф теста `graph-layout`: подземелье с караулкой и сокровищницей.
const dungeonRecipe = {
  entranceZoneId: 'entry',
  goalZoneId: 'vault',
  zones: [
    { id: 'entry', kind: 'interior', label: 'Вход' },
    { id: 'hall', kind: 'interior', required: true, label: 'Зал' },
    { id: 'guard', kind: 'interior', keys: ['vault-key'], label: 'Караулка' },
    { id: 'vault', kind: 'interior', label: 'Сокровищница' },
  ],
  links: [
    { id: 'l1', from: 'entry', to: 'hall', kind: 'door' },
    { id: 'l2', from: 'hall', to: 'guard', kind: 'open' },
    { id: 'l3', from: 'hall', to: 'vault', kind: 'locked', keyId: 'vault-key' },
  ],
}
for (const seed of ['same', 'other', 'topology', 'locks', 'valid', 'rock', 'adjacency']) addCase(`dungeon-test/${seed}`, sg.createSceneGraph(dungeonRecipe), { seed })
for (const theme of ['crypt', 'temple']) for (const seed of ['a', 'b', 'c']) addCase(`dungeon-test/${theme}/${seed}`, sg.createSceneGraph(dungeonRecipe), { seed, theme })

// --- функции по отдельности ------------------------------------------------------

const split = []
for (let index = 0; index < 500; index += 1) {
  const minX = int(6) - 1
  const minY = int(6) - 1
  const area = { minX, minY, maxX: minX + 3 + int(70), maxY: minY + 3 + int(70) }
  const count = int(13)
  const minimum = chance(0.4) ? undefined : 2 + int(6)
  const randomSeed = int(2 ** 31)
  const leaves = gl.splitArea(area, count, mulberry32(randomSeed), minimum)
  split.push({ area, count, ...(minimum === undefined ? {} : { minimum }), randomSeed, leaves: leaves.map(rectJson) })
}


// `compactArea` (#184): корпус храма посреди карты, прочие темы — вся карта.
const compact = []
for (let index = 0; index < 400; index += 1) {
  const theme = pick(['temple', 'temple', 'dungeon', 'crypt', 'cave', '', 'temple'])
  const zoneCount = int(9)
  const width = 6 + int(60)
  const height = 6 + int(60)
  compact.push({ theme, zoneCount, width, height, area: rectJson(gl.compactArea(theme, zoneCount, width, height)) })
}
const walls = []
for (let index = 0; index < 500; index += 1) {
  const a = { minX: int(20), minY: int(20) }
  a.maxX = a.minX + int(12)
  a.maxY = a.minY + int(12)
  let b
  if (chance(0.5)) {
    // Смежный по стене: справа, слева, снизу или сверху со сдвигом.
    const width = int(12)
    const height = int(12)
    const shift = int(10) - 5
    b = pick([
      { minX: a.maxX, minY: a.minY + shift, maxX: a.maxX + width, maxY: a.minY + shift + height },
      { minX: a.minX - width, minY: a.minY + shift, maxX: a.minX, maxY: a.minY + shift + height },
      { minX: a.minX + shift, minY: a.maxY, maxX: a.minX + shift + width, maxY: a.maxY + height },
      { minX: a.minX + shift, minY: a.minY - height, maxX: a.minX + shift + width, maxY: a.minY },
    ])
  } else {
    b = { minX: int(30), minY: int(30) }
    b.maxX = b.minX + int(12)
    b.maxY = b.minY + int(12)
  }
  walls.push({ a, b, wall: gl.sharedWall(a, b) })
}

const assign = []
for (let index = 0; index < 300; index += 1) {
  const graph = sg.createSceneGraph(randomRecipe())
  const size = 12 + int(40)
  const leaves = gl.splitArea({ minX: 0, minY: 0, maxX: size - 1, maxY: 12 + int(40) - 1 }, Math.max(0, graph.zones.length + int(4) - 2), mulberry32(int(2 ** 31)))
  assign.push({ graph: plain(graph), leaves: leaves.map(rectJson), rooms: roomsJson(gl.assignZonesToLeaves(graph, leaves)) })
}

const chambers = []
for (let index = 0; index < 300; index += 1) {
  const graph = chance(0.5) ? sceneGraphForTheme(pick(graphThemes), `chambers:${index}`) : sg.createSceneGraph(randomRecipe())
  const width = 10 + int(40)
  const height = 10 + int(40)
  const randomSeed = int(2 ** 31)
  let result
  try {
    const plan = gl.planChambers(graph, width, height, mulberry32(randomSeed))
    result = plan
      ? {
        plan: {
          rooms: roomsJson(plan.rooms),
          passages: plan.passages.map((passage) => ({
            link: passage.link.id, kind: passage.link.kind, keyId: passage.link.keyId ?? null,
            cells: passage.cells.map((cell) => [cell.x, cell.y]), mouths: passage.mouths.map((mouth) => [mouth.x, mouth.y, mouth.door]),
          })),
        },
      }
      : { plan: null }
  } catch (error) {
    result = { error: errorOf(error) }
  }
  // Ходы — хешем, первые случаи — целиком для отладки.
  const summary = result.plan ? { rooms: result.plan.rooms, passages: result.plan.passages.length, passagesHash: hash(result.plan.passages) } : result
  chambers.push({ graph: plain(graph), width, height, randomSeed, ...(index < 15 && result.plan ? { full: result.plan } : {}), ...summary })
}

// --- запись ------------------------------------------------------------------------

const dump = process.argv.indexOf('--dump')
if (dump > 0) {
  const label = process.argv[dump + 1]
  const found = cases.find((entry) => entry.label === label)
  if (!found) throw new Error(`нет случая ${label}`)
  console.log(JSON.stringify(t.serializeTacticalMap(gl.layoutSceneGraph(found.graph, found.options).map)))
} else {
  for (const entry of cases) {
    if (entry.pipelineHash && entry.pipelineHash !== entry.build.mapHash) throw new Error(`${entry.label}: карта конвейера не повторилась`)
    if (entry.layout.mapHash && entry.build.mapHash && entry.layout.mapHash !== entry.build.mapHash) throw new Error(`${entry.label}: раскладка и сборка разошлись`)
  }
  const pipelineCount = cases.filter((entry) => entry.label.startsWith('pipeline:')).length
  console.log(`  конвейер: ${pipelineCount} вызовов, склепов ${cases.filter((entry) => entry.label.startsWith('pipeline:') && entry.options.theme === 'crypt').length}`)
  writeFixture(new URL('./graph-layout.json', import.meta.url), { cases, split, compact, walls, assign, chambers })
}
