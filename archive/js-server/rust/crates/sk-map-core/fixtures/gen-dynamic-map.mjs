import '../../../fixtures-env.mjs'
// Эталон server/dynamic-map.mjs для Rust:
//
//   node rust/crates/sk-map-core/fixtures/gen-dynamic-map.mjs
//
// - `generateDynamicSceneMap` на сотнях спецификаций: все планировки и
//   узоры, размеры от 7 до 30 и мимо пределов, масштабы, опасность, тема и
//   материал (в том числе незнакомые и не-строки), открытость, вода, бюджет
//   предметов; выход — SHA-256 строки `JSON.stringify` клеток (у первых —
//   целиком, для отладки) и сводка;
// - `Math.sin` на всех входах генератора (`x / (w − 1) · 2π`, `w` от 7 до 30)
//   — битами: Rust сверяет свою `f64::sin`, от неё зависят дорога моста и
//   тропа луга;
// - случаи `test/map-elevation.test.mjs`, `test/scene-points-of-interest.test.mjs`
//   и `test/tactical-map-contract.test.mjs`.
import { generateDynamicSceneMap } from '../../../../server/dynamic-map.mjs'
import { encode, errorOf, hash, mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(2026_10_55)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p

const LAYOUTS = ['rooms', 'cavern', 'radial', 'ruins', 'winding', 'open', 'streets', 'other', 5, null]
const PATTERNS = ['small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural', 'unknown', null]
const THEMES = ['', 'таверна', 'Дом мельника', 'пещера', 'шахта', 'склеп', 'древний склеп', 'Лес', 'болото', 'город', 'деревня', 'рынок', 'храм', 'дворец', 'космическая станция', 'кибер', 'дорога', 'мост через ущелье', 'пустыня', 'руины', 'ледник', 'снежная пустошь', 'сад', 'земляной вал', 'лаборатория', 'каюта', 'деревянный форт', null, 7, ['лес', 'луг']]
const MATERIALS = ['stone', 'wood', 'earth', 'grass', 'sand', 'metal', 'marble', 'ice', 'gold', '', null]
const DANGERS = ['средняя', 'высокая', 'низкая', 'никакая', null]

function randomSpec() {
  const spec = {}
  if (chance(0.92)) spec.seed = pick([`seed-${int(10_000)}`, int(1000), 'arena', '', `карта-${int(50)}`])
  if (chance(0.85)) spec.theme = pick(THEMES)
  if (chance(0.6)) spec.danger = pick(DANGERS)
  if (chance(0.7)) spec.width = pick([7 + int(24), 7 + int(24), 3, 31, 40, '12', 12.5, null, 'x'])
  if (chance(0.7)) spec.height = pick([7 + int(24), 7 + int(24), 2, 35, '9', null])
  if (chance(0.3)) spec.scale = pick(['room', 'stronghold', 'region', 'site', '', 0, 1])
  if (chance(0.9)) spec.layout = pick(LAYOUTS)
  if (chance(0.9)) spec.pattern = pick(PATTERNS)
  if (chance(0.5)) spec.material = pick(MATERIALS)
  if (chance(0.4)) spec.openness = pick([0.1, 0.35, 0.6, 0.85, 1, 0, '0.7', null, 'x'])
  if (chance(0.4)) spec.water = pick([0, 0.04, 0.1, 0.3, 0.5, -1, '0.2', null])
  if (chance(0.5)) spec.featureCount = pick([0, 2, 3, 6, 8, 12, 20, '5', 4.5, null])
  return spec
}

const specs = []
// Все планировки на всех узорах, по одному сиду.
for (const layout of ['rooms', 'cavern', 'radial', 'ruins', 'winding', 'open', 'streets']) {
  for (const pattern of ['small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural']) {
    specs.push({ seed: `grid:${layout}:${pattern}`, theme: pick(THEMES.filter((theme) => typeof theme === 'string')), layout, pattern, danger: pick(DANGERS), featureCount: 2 + int(11) })
  }
}
// Случаи тестов JS.
specs.push({ seed: 'elev-1', theme: 'руины', layout: 'open', width: 15, height: 11 })
specs.push({ seed: 'elev-2', theme: 'руины', layout: 'open', width: 15, height: 11 })
for (const danger of ['низкая', 'средняя', 'высокая']) specs.push({ seed: 'elev-1', theme: 'руины', layout: 'open', width: 15, height: 11, danger })
for (const seed of ['poi:crypt:one', 'poi:crypt:two', 'poi:crypt:three']) specs.push({ seed, theme: 'древний склеп', danger: 'средняя', layout: 'cavern', pattern: 'crypt', material: 'earth', featureCount: 8 })
specs.push({ seed: 'poi:small-budget', theme: 'дорога', layout: 'winding', pattern: 'bridge', material: 'earth', featureCount: 3 })
for (const shape of [
  { seed: 'shape-cavern', layout: 'cavern', pattern: 'cave-cluster', theme: 'пещера' },
  { seed: 'shape-radial', layout: 'radial', pattern: 'courtyard', theme: 'храм' },
  { seed: 'shape-ruins', layout: 'ruins', pattern: 'keep', theme: 'руины' },
  { seed: 'shape-bridge', layout: 'open', pattern: 'bridge', theme: 'мост через ущелье' },
  { seed: 'shape-village', layout: 'streets', pattern: 'village', theme: 'деревня' },
  { seed: 'shape-room', layout: 'rooms', pattern: 'small-room', theme: 'таверна' },
  { seed: 'shape-hall', layout: 'rooms', pattern: 'great-hall', theme: 'дворец' },
  { seed: 'shape-crypt', layout: 'winding', pattern: 'crypt', theme: 'склеп' },
  { seed: 'limit', width: 30, height: 30, layout: 'rooms', pattern: 'great-hall' },
]) specs.push({ danger: 'средняя', water: 0.08, featureCount: 8, ...shape })
// Размеры от 7 до 30 по каждой оси на мосту и тропе луга — там синус.
for (let width = 7; width <= 30; width += 1) {
  specs.push({ seed: `bridge:${width}`, layout: pick(['open', 'rooms']), pattern: 'bridge', width, height: 7 + int(24), theme: 'мост' })
  specs.push({ seed: `meadow:${width}`, layout: 'winding', pattern: 'natural', material: 'grass', width, height: 7 + int(24), theme: 'луг' })
}
for (let index = 0; index < 420; index += 1) specs.push(randomSpec())

const cases = specs.map((spec, index) => {
  try {
    const cells = generateDynamicSceneMap(spec)
    const features = cells.filter((cell) => cell.feature).map((cell) => `${cell.x},${cell.y}:${cell.feature}`)
    const raised = cells.filter((cell) => cell.elevation).length
    return { spec, cells: index < 12 ? cells : hash(cells), count: cells.length, features, raised }
  } catch (error) {
    return { spec, error: errorOf(error) }
  }
})
cases.push({ spec: encode(undefined), cells: hash(generateDynamicSceneMap()), count: generateDynamicSceneMap().length })
for (const spec of [5, 'x', [], true]) cases.push({ spec, cells: hash(generateDynamicSceneMap(spec)), count: generateDynamicSceneMap(spec).length })
try {
  generateDynamicSceneMap(null)
} catch (error) {
  cases.push({ spec: null, error: errorOf(error) })
}

// Синус на всех входах генератора: дорога моста и тропа луга.
const sines = []
const bits = (value) => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}
for (let width = 7; width <= 30; width += 1) {
  for (let x = 0; x < width; x += 1) {
    const angle = (x / Math.max(1, width - 1)) * Math.PI * 2
    sines.push([width, x, bits(angle), bits(Math.sin(angle))])
  }
}

// И на случайных углах до 2¹⁹·π/2 — `math_sin` открыт другим модулям.
const randomSines = []
for (let index = 0; index < 400; index += 1) {
  const scale = pick([1e-9, 0.5, 1, 4, 10, 100, 1e4, 8e5])
  const angle = (random() * 2 - 1) * scale
  randomSines.push([bits(angle), bits(Math.sin(angle))])
}

writeFixture(new URL('./dynamic-map.json', import.meta.url), { cases, sines, randomSines })
