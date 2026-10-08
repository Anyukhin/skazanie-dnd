#!/usr/bin/env node
/**
 * Замер масштаба 3D-моделей: соразмерны ли предметы и фигурки друг другу.
 *
 * Предметы берутся с настоящих карт — пресеты `pnpm maps:preview` по
 * нескольким сидам и авторские карты (`data/authored-location-maps-v1.json`),
 * — и для каждого считается та же высота, что строит 3D-доска: габарит модели
 * из каталога окружения или пакета стиля, вписанный в след
 * (`propModelFit`), умноженный на `prop.scale`. Фигурки — высота профиля из
 * `public/assets/models/manifest.json` и множитель площади существа.
 *
 * Мерило — рост фигурки человека: средняя высота автоподбираемых гуманоидов
 * манифеста считается за 5,75 фт. Ожидаемая высота предмета — его настоящая
 * высота из `REFERENCE_FEET` в том же масштабе. Отклонение больше чем в
 * `TOLERANCE` раз — замечание.
 *
 *   node tools/model-scale-audit.mjs            # таблица и замечания
 *   node tools/model-scale-audit.mjs --json     # то же в JSON
 *   node tools/model-scale-audit.mjs --all      # все виды, не только замечания
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { compileClientModules, repositoryRoot as root } from '../test/kit/client-ts.mjs'
import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { MAP_PREVIEW_PRESETS } from '../server/map-quality.mjs'
import { deserializeTacticalMap } from '../server/tactical-map.mjs'

const args = new Set(process.argv.slice(2))
const SEEDS = ['scale-a', 'scale-b', 'scale-c']
/** Рост человека, которому равна фигурка героя. */
const HUMAN_FEET = 5.75
/** Во сколько раз высота может отличаться от ожидаемой без замечания. */
const TOLERANCE = 1.45

/**
 * Настоящая высота вида в футах (D&D и средневековый быт). Для высоких
 * природных и архитектурных видов (`capped`) доска сознательно ужимает высоту,
 * чтобы не закрывать поле: у них проверяется только нижняя граница.
 */
const REFERENCE_FEET = Object.freeze({
  // Посуда и мелочь на столах.
  mug: .45, plate: .1, bowl_stew: .3, bottle: 1, jug: 1, bread_loaf: .4, cheese_wheel: .4, candle: 1,
  dice_cup: .3, coin_pile: .25, cutting_board: .1, pot: .9, lute: 1, coin_pouch: .5, single_book: .4,
  // Бытовые вещи на полу.
  // Чаша для подношений стоит на подставке, кости — грудой.
  broom: 4.5, sack: 2.5, basket: 1.5, bucket: 1.2, offering_bowl: 2, urn: 2, bone_pile: 1.5,
  firewood_stack: 2, cauldron: 2, keg: 2, crate: 2, chest: 2, barrel: 3,
  barrel_stack: 5, crate_stack: 4, strongbox: 1.6, rain_barrel: 3.5, water_barrel: 3.5,
  // Мебель.
  table_round: 2.5, table_long: 2.5, table_royal: 2.6, table_small: 2.5, bar_counter: 3.5,
  bench: 1.5, prayer_bench: 3, stool: 2, chair: 3.2, royal_throne: 6, night_table: 2,
  bed: 2.5, bunk_bed: 5.5, washbasin: 3, cupboard: 6, wardrobe: 6.5, bookshelf: 6.5,
  bar_shelf: 6, fireplace: 5, hearth_fire: 2.5, bookcase_tall: 7.5, display_shelf: 7, coat_rack: 6,
  standing_mirror: 6.5, tool_rack: 6, armchair: 3.8, dresser: 3.5, double_bed: 3,
  anvil: 3, butcher_block: 3, prep_table: 3, offering_table: 3.5, map_table: 3, writing_desk: 2.5,
  // Свет и знаки.
  candelabra: 5, brazier: 3.5, campfire: 1.5, banner: 7, temple_banner: 8, sign_board: 7,
  // Храм и склеп.
  altar: 3.5, sarcophagus: 3, grave: 3, reliquary: 4, crypt_niche: 6, statue: 8, book_lectern: 4.5, temple_lectern: 4.5,
  training_dummy: 6, camp_dummy: 6,
  // Улица.
  lamp_post: 10, signpost: 7, hitching_post: 3.5, milestone: 3, roadside_shrine: 6,
  water_trough: 2, wagon_wheel: 4, village_fence: 4, well: 8, haystack: 6, cart: 5, market_stall: 9,
  // Природа.
  // Трава и цветы — пучки высокой травы и куртины, грибы — с крупными трутовиками.
  tree_stump: 1.5, bush: 3, shrub: 2, grass_tuft: 1.2, flowers: 1.2, fern: 1.5, mushroom_cluster: 1,
  rock_small: .7, boulder: 3, rubble_heap: 2, fallen_log: 2, woodpile: 2.5,
})
const CAPPED_FEET = Object.freeze({ tree_oak: 40, tree_birch: 35, tree_pine: 45, tree_spruce: 45, tree_dead: 30, pillar: 14, stalagmite: 6 })

/** Рост существа по категории размера D&D, футы (середина диапазона книги). */
const CREATURE_FEET = Object.freeze({ tiny: 1.5, small: 3.5, medium: 5.75, large: 11, huge: 22, gargantuan: 40 })
const SIZE_CELLS = Object.freeze({ tiny: 1, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 })
/**
 * Рост своего профиля, футы: гуманоид — человек, гоблин — маленький, зверь
 * (волк) — в холке, дракон — большой, по голове.
 */
const PROFILE_FEET = Object.freeze({ warrior: 5.75, mage: 5.75, rogue: 5.75, skeleton: 5.75, goblin: 3.5, beast: 3, dragon: 11 })
/** Доска сжимает верх шкалы размеров: огромное и громадное — не ниже этой доли книги. */
const LARGE_SIZE_FLOOR = .35

const { modules: [render, catalogModule, style, props3d, actorModels] } = await compileClientModules(['src/board-render.ts', 'src/prop-model-catalog.ts', 'src/board3d-style.ts', 'src/board3d-props.ts', 'src/actor-models.ts'])
// Виды без GLB доска строит процедурно: их высота меряется по собранной группе.
const procedural = props3d.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, null)
/** @param {any} prop */
function proceduralHeight(prop) {
  const group = procedural.create(prop)
  if (group.userData.modelKind === 'unknown') return null
  group.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(group)
  return box.isEmpty() ? null : box.max.y - Math.max(0, box.min.y)
}
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))

// Каталог доски: выпуск окружения плюс пакет стиля, который подменяет свои виды.
const environment = catalogModule.validatePropModelCatalog(readJson('public/assets/models/environment/manifest.json'))
const stylePack = style.validateGraphicsStylePack(readJson('public/assets/styles/stylized/manifest.json'))
const actorManifest = readJson('public/assets/models/manifest.json')

/** Карты корпуса: пресеты по сидам и все авторские. */
function corpusMaps() {
  const maps = []
  for (const preset of MAP_PREVIEW_PRESETS) {
    for (const seed of SEEDS) {
      const geometry = generateSceneGeometry({ ...preset.input, seed: `${preset.id}:${seed}` })
      const map = geometry.map?.layers ? geometry.map : geometry.map ? deserializeTacticalMap(geometry.map) : null
      if (map) maps.push({ source: preset.id, map })
    }
  }
  for (const raw of readJson('data/authored-location-maps-v1.json').maps) maps.push({ source: raw.locationId, map: deserializeTacticalMap(raw) })
  return maps
}

/** Рост фигурки человека в клетках: среднее автоподбираемых гуманоидов. */
function humanCells() {
  const heights = actorManifest.models
    .filter((entry) => entry.auto !== false && ['warrior', 'mage', 'rogue'].includes(entry.profile) && Number(entry.height) > 0)
    .map((entry) => Number(entry.height))
  return heights.reduce((sum, value) => sum + value, 0) / heights.length
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const round = (value, digits = 2) => Number(value.toFixed(digits))

const human = humanCells()
const feetToCells = human / HUMAN_FEET
const toFeet = (cells) => cells / feetToCells

/** @type {Map<string, {heights: number[], scales: number[], keys: Map<string, number[]>, sources: Set<string>, missing: number}>} */
const byAsset = new Map()
const maps = corpusMaps()
const assetIds = new Set(maps.flatMap(({ map }) => map.props.map((prop) => render.resolvePropAssetId(prop.assetId))))
const catalog = render.withStyleAssets(environment, stylePack, assetIds)

// У части записей каталога габарит не записан: доска меряет такой GLB при
// загрузке. Замер делает то же — грузит файл и берёт bbox после поворота yaw.
// GLTFLoader ждёт `self` браузера; текстуры в Node не грузятся, геометрии хватает.
globalThis.self ??= globalThis
const loader = new GLTFLoader()
/** @type {Map<string, [number, number, number]>} */
const measured = new Map()
for (const entry of catalog.models) {
  if (entry.size || !entry.assetIds.some((id) => assetIds.has(id)) || !entry.url.endsWith('.glb')) continue
  const data = readFileSync(join(root, 'public', entry.url))
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject))
  const holder = new THREE.Group()
  gltf.scene.rotation.y = entry.yaw * Math.PI / 180
  holder.add(gltf.scene)
  holder.updateMatrixWorld(true)
  const size = new THREE.Box3().setFromObject(holder).getSize(new THREE.Vector3())
  measured.set(entry.key, [size.x, size.y, size.z])
}

for (const { source, map } of maps) {
  for (const prop of map.props) {
    if (prop.transition) continue
    const canonical = render.resolvePropAssetId(prop.assetId)
    const record = byAsset.get(canonical) ?? { heights: [], scales: [], keys: new Map(), sources: new Set(), missing: 0 }
    byAsset.set(canonical, record)
    record.sources.add(source)
    const entry = catalogModule.propModelFor(catalog, canonical, prop.id)
    const layout = render.propVisualLayout(prop)
    const size = entry ? entry.size ?? measured.get(entry.key) : undefined
    const fit = entry && size ? catalogModule.propModelFit(canonical, entry, layout.width, layout.depth, render.PROP_FOOTPRINT_FILL, size) : null
    const raised = fit === null || !size ? null : catalogModule.propModelFloorFit(canonical, fit, size, layout.scale, layout.width, layout.depth)
    const modelKey = raised !== null ? entry.key : 'procedural'
    const cells = raised !== null && size ? size[1] * raised * layout.scale : proceduralHeight(prop)
    if (cells === null || cells < .01) { record.missing += 1; continue }
    record.heights.push(cells)
    record.scales.push(layout.scale)
    const list = record.keys.get(modelKey) ?? []
    list.push(cells)
    record.keys.set(modelKey, list)
  }
}

const rows = []
for (const [assetId, record] of [...byAsset].sort(([a], [b]) => a.localeCompare(b))) {
  if (!record.heights.length) {
    rows.push({ assetId, count: record.missing, note: 'плоская наклейка или вид без модели' })
    continue
  }
  const feet = record.heights.map(toFeet)
  const reference = REFERENCE_FEET[assetId] ?? CAPPED_FEET[assetId] ?? null
  const capped = assetId in CAPPED_FEET
  const ratio = reference ? median(feet) / reference : null
  const variants = [...record.keys].map(([key, list]) => ({ key, feet: round(toFeet(median(list)), 1), count: list.length }))
  const spread = Math.max(...variants.map((v) => v.feet)) / Math.max(.01, Math.min(...variants.map((v) => v.feet)))
  const problems = []
  if (ratio !== null && (ratio > TOLERANCE && !capped)) problems.push(`выше нормы в ${round(ratio, 1)} раза`)
  if (ratio !== null && ratio < 1 / TOLERANCE && !(capped && ratio >= .3)) problems.push(`ниже нормы в ${round(1 / ratio, 1)} раза`)
  if (variants.length > 1 && spread > 2) problems.push(`варианты расходятся в ${round(spread, 1)} раза`)
  rows.push({
    assetId, count: record.heights.length, reference, capped,
    feet: { min: round(Math.min(...feet), 1), median: round(median(feet), 1), max: round(Math.max(...feet), 1) },
    ratio: ratio === null ? null : round(ratio), scale: round(median(record.scales)), variants, problems, sources: [...record.sources].slice(0, 4),
  })
}

// Фигурка своего профиля на одной клетке: тот же расчёт, что у доски.
const actors = actorManifest.models.map((entry) => {
  const cells = actorModels.figureHeightFor(Number(entry.height) || 1.25, entry.profile, 1)
  const feet = toFeet(cells)
  const ratio = feet / PROFILE_FEET[entry.profile]
  const problems = []
  // Запись без GLB — запасная: процедурная фигурка получает рост той записи,
  // чья модель не загрузилась, а не свой.
  if (entry.url && ratio > TOLERANCE) problems.push(`выше своего профиля в ${round(ratio, 1)} раза`)
  if (entry.url && ratio < 1 / TOLERANCE) problems.push(`ниже своего профиля в ${round(1 / ratio, 1)} раза`)
  return { key: entry.key, profile: entry.profile, auto: entry.auto !== false, fallback: !entry.url, cells: round(cells), feet: round(feet, 1), ratio: round(ratio), problems }
})
// Гуманоид каждой категории размера: площадь и `appearance.stature`, как на доске.
const sizeScale = Object.entries(SIZE_CELLS).map(([size, cells]) => {
  const figure = actorModels.figureHeightFor(human, 'warrior', cells, size)
  const ratio = toFeet(figure) / CREATURE_FEET[size]
  const problems = []
  if (ratio > TOLERANCE) problems.push('выше книги')
  if (ratio < (cells > 2 ? LARGE_SIZE_FLOOR : 1 / TOLERANCE)) problems.push('ниже книги')
  return { size, cells, figureFeet: round(toFeet(figure), 1), bookFeet: CREATURE_FEET[size], ratio: round(ratio), problems }
})

const report = { humanCells: round(human), feetPerCellOfFigure: round(1 / feetToCells, 2), maps: maps.length, props: rows, actors, sizeScale }
if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`Фигурка человека: ${round(human)} клетки = ${HUMAN_FEET} фт; карт в корпусе: ${maps.length}\n`)
  const flagged = rows.filter((row) => args.has('--all') || row.problems?.length)
  for (const row of flagged) {
    if (!row.feet) { console.log(`${row.assetId.padEnd(18)} ×${row.count} ${row.note}`); continue }
    const variants = row.variants.map((v) => `${v.key} ${v.feet}фт×${v.count}`).join(', ')
    console.log(`${row.assetId.padEnd(18)} ×${String(row.count).padEnd(4)} ${String(row.feet.median).padStart(5)} фт (${row.feet.min}–${row.feet.max}) норма ${row.reference ?? '—'}${row.capped ? '↓' : ''} · ${row.problems.join('; ') || 'ок'} · ${variants}`)
  }
  console.log('\nФигурки:')
  for (const actor of actors.filter((entry) => args.has('--all') || entry.problems.length)) {
    console.log(`  ${actor.key.padEnd(24)} ${actor.profile.padEnd(9)} ${actor.cells} кл = ${actor.feet} фт · ${actor.problems.join('; ') || 'ок'}${actor.auto ? '' : ' (только по выбору)'}`)
  }
  console.log('\nКатегории размера (гуманоид: площадь и stature):')
  for (const entry of sizeScale) console.log(`  ${entry.size.padEnd(11)} ${entry.cells}×${entry.cells}: ${entry.figureFeet} фт против ${entry.bookFeet} фт по книге (×${entry.ratio})${entry.problems.length ? ` · ${entry.problems.join('; ')}` : ''}`)
  const total = rows.filter((row) => row.problems?.length).length + actors.filter((entry) => entry.problems.length).length
    + sizeScale.filter((entry) => entry.problems.length).length
  console.log(`\nЗамечаний: ${total}`)
}
