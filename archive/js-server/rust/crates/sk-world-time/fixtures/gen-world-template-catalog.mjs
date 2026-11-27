import '../../../fixtures-env.mjs'
import { startCapture } from './hook.mjs'
// Эталон server/world-template-catalog.mjs для Rust:
//
//   node rust/crates/sk-world-time/fixtures/gen-world-template-catalog.mjs
//
// Источники входов:
//
// - тесты `test/world-template-catalog.test.mjs` и
//   `test/campaign-world-template.test.mjs`, исполненные в этом же процессе:
//   каждый верхний вызов экспорта перехватывается хуком;
// - экспорты на всех шаблонах, мусорных id и переопределениях названий;
// - мутации каталога: внутренняя `loadCatalog` (хук экспортирует её и даёт
//   подменить текст каталога) на `data/campaign-worlds-v1.json` с одной-двумя
//   правками — удалить поле, подменить значение, продублировать или убрать
//   запись. Случай хранит только правки; Rust применяет их к тому же файлу.
//
// Крупный результат — SHA-256 строки `JSON.stringify`.
import { readFileSync } from 'node:fs'
import { run } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fixtureWriter, mulberry32, chooser, PROTOTYPE_KEYS } from './common.mjs'

const c = await import('../../../../server/world-template-catalog.mjs')

const writer = fixtureWriter('world-template-catalog')
const random = mulberry32(2026_10_18)
const { int, pick, chance } = chooser(random)

const FNS = {
  listWorldTemplates: (...args) => c.listWorldTemplates(...args),
  getWorldTemplate: (...args) => c.getWorldTemplate(...args),
  worldTemplateOpening: (...args) => c.worldTemplateOpening(...args),
  worldTemplateConcept: (...args) => c.worldTemplateConcept(...args),
}

// ---------------------------------------------------------------------------
// 1. Тесты в этом же процессе
// ---------------------------------------------------------------------------

const captured = []
const testFile = (name) => fileURLToPath(new URL(`../../../../test/${name}`, import.meta.url))
const stop = startCapture((module, name, args) => {
  if (module !== 'server/world-template-catalog.mjs' || !FNS[name]) return
  try {
    // Шаблон целиком в аргументе читается только по id (`templateFor`): хранится `{ id }`.
    const [first, ...rest] = JSON.parse(JSON.stringify(args))
    const slim = first && typeof first === 'object' && !Array.isArray(first) && 'id' in first ? { id: first.id } : first
    captured.push([name, args.length ? [slim, ...rest] : []])
  } catch { /* вход не сериализуется */ }
})
let passed = 0
let failed = 0
for await (const event of run({ files: ['world-template-catalog.test.mjs', 'campaign-world-template.test.mjs'].map(testFile), isolation: 'none' })) {
  if (event.type === 'test:pass') passed += 1
  if (event.type === 'test:fail') {
    failed += 1
    console.log('упал тест:', event.data?.name)
  }
}
stop()
console.log(`тесты: прошло ${passed}, упало ${failed}`)
for (const [name, args] of captured) writer.call(name, FNS[name], args, { limit: 200 })
const afterTests = writer.cases.length

// ---------------------------------------------------------------------------
// 2. Экспорты на шаблонах и мусоре
// ---------------------------------------------------------------------------

const IDS = c.listWorldTemplates().map((template) => template.id)
const ODD = [...PROTOTYPE_KEYS.filter((key) => ['constructor', '__proto__', 'toString'].includes(key)), '', '  ', 'missing', 5, null, undefined, true]
const idVariants = [...IDS, ...IDS.map((id) => `  ${id} `), ...IDS.map((id) => ({ id })), { id: 5 }, { name: IDS[0] }, [IDS[0]], ...ODD]
writer.call('listWorldTemplates', FNS.listWorldTemplates, [], { limit: 200 })
const OVERRIDES = [
  undefined, {}, { campaignName: 'Хроники Севера' }, { campaign: 'Свой стол' }, { campaignName: 'Новая кампания' },
  { partyName: 'Вольные' }, { party: '  Братство   кольца ' }, { partyName: 'Новый отряд', campaignName: '' },
  { campaignName: 5 }, { partyName: 'Я'.repeat(161) }, { campaignName: 'Я'.repeat(160) }, { campaignName: null, campaign: 'Резерв' },
  { campaignName: '   ' }, { campaign: ['массив'] }, 'строка',
]
for (const id of idVariants) {
  writer.call('getWorldTemplate', FNS.getWorldTemplate, [id], { limit: 200 })
  writer.call('worldTemplateConcept', FNS.worldTemplateConcept, [id], { limit: 200 })
  for (const overrides of OVERRIDES.filter((_, index) => index < 2 || IDS.includes(id) || chance(0.1))) {
    writer.call('worldTemplateOpening', FNS.worldTemplateOpening, overrides === undefined ? [id] : [id, overrides], { limit: 200 })
  }
}
const afterExports = writer.cases.length

// ---------------------------------------------------------------------------
// 3. Мутации каталога
// ---------------------------------------------------------------------------

const DATA_TEXT = readFileSync(new URL('../../../../data/campaign-worlds-v1.json', import.meta.url), 'utf8')
const DATA = JSON.parse(DATA_TEXT)

function loadMutated(mutations) {
  const payload = JSON.parse(DATA_TEXT)
  for (const mutation of mutations) applyMutation(payload, mutation)
  globalThis.__worldCatalogText = JSON.stringify(payload)
  try {
    return c.loadCatalog()
  } finally {
    globalThis.__worldCatalogText = undefined
  }
}

/** Правка — `{ path, op, value? }`; `op`: set, delete, remove (из массива), dup (повтор записи), clear (пустой массив). */
function applyMutation(root, { path, op, value }) {
  let parent = root
  for (const key of path.slice(0, -1)) {
    if (parent == null || typeof parent !== 'object') return
    parent = parent[key]
  }
  if (parent == null || typeof parent !== 'object') return
  const last = path.at(-1)
  if (op === 'set') parent[last] = structuredClone(value)
  else if (op === 'delete') {
    if (Array.isArray(parent)) parent.splice(Number(last), 1)
    else delete parent[last]
  } else if (op === 'dup' && Array.isArray(parent[last]) && parent[last].length) parent[last].push(structuredClone(parent[last][0]))
  else if (op === 'clear' && Array.isArray(parent[last])) parent[last] = []
  else if (op === 'remove' && Array.isArray(parent[last]) && parent[last].length) parent[last].splice(parent[last].length - 1, 1)
}

/** Все узлы дерева с путями: объекты, массивы и листья. */
const NODES = []
;(function walk(value, path) {
  NODES.push({ path, value })
  if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, [...path, index]))
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) walk(entry, [...path, key])
})(DATA, [])

const LEAF_VALUES = [
  null, '', '   ', 0, -1, 1, 2.5, 1_000, 999_999, 3_000, '12', 'abc', 'Bad Id', 'низкая', 'высокая', 'party', 'gm_only', 'public',
  true, false, [], {}, ['x'], 'Я'.repeat(361), 'Я'.repeat(2_001), '\r\n  текст  \r', '1.2.3', '1.2', 'village', 'road',
  '/assets/maps/world/skazanie/nope-v1.webp', '/assets/maps/city/skazanie/nope-v1.webp', '/assets/maps/world/skazanie/ashen-garden-v2.webp',
  'investigation', 'offered', 'npc', 'office', 'transfer', 'impossible', { min: 5, max: 3 }, { min: '9', max: '10' }, [1, 2], [0], 'ｆｕｌｌ',
]
function mutationFor(node) {
  const { path, value } = node
  if (!path.length) return null
  const roll = random()
  if (Array.isArray(value)) {
    if (roll < 0.3) return { path, op: 'dup' }
    if (roll < 0.55) return { path, op: 'remove' }
    if (roll < 0.65) return { path, op: 'clear' }
  }
  if (roll < 0.25) return { path, op: 'delete' }
  if (typeof value === 'number' && chance(0.5)) return { path, op: 'set', value: pick([value + 1_000, value - 1_000, String(value), -value, value + 0.5]) }
  if (typeof value === 'string' && chance(0.3)) return { path, op: 'set', value: pick([`${value} `, value.toUpperCase(), value.slice(0, 1), value + value]) }
  // Значение соседнего узла того же вида — правдоподобная, но чужая ссылка.
  if (chance(0.2)) {
    const sibling = pick(NODES.filter((other) => other.path.at(-1) === path.at(-1) && typeof other.value !== 'object'))
    if (sibling) return { path, op: 'set', value: sibling.value }
  }
  return { path, op: 'set', value: pick(LEAF_VALUES) }
}

const MUTATIONS = Number(process.env.SK_MUTATIONS ?? 1_500)
let errors = 0
const messages = new Set()
for (let index = 0; index < MUTATIONS; index += 1) {
  const count = chance(0.85) ? 1 : 2
  const mutations = []
  for (let step = 0; step < count; step += 1) {
    // Листья — чаще: на них живут почти все проверки.
    const node = pick(NODES)
    const mutation = mutationFor(node)
    if (mutation) mutations.push(mutation)
  }
  if (!mutations.length) continue
  const added = writer.call('loadCatalog', loadMutated, [mutations], { limit: 200 })
  const last = writer.cases.at(-1)
  if (added && last.error) {
    errors += 1
    messages.add(last.error.message.replace(/\[\d+\]/gu, '[]'))
  }
}
// Границы размеров: ширина и высота карты и городского плана сдвигают пределы
// координат, и случайная правка до них почти не дотягивается.
for (const [templateIndex, template] of DATA.templates.entries()) {
  const map = ['templates', templateIndex, 'world_map']
  const start = template.world_map.locations.findIndex((location) => location.city_overview || location.cityOverview)
  const overviewKey = template.world_map.locations[start]?.city_overview ? 'city_overview' : 'cityOverview'
  const overview = [...map, 'locations', start, overviewKey]
  const cases = [
    ...[320, 400, 900, 960, 999, 1_001, 2_000, 2_001].map((value) => [{ path: [...map, 'width'], op: 'set', value }]),
    ...[240, 300, 600, 641, 1_200].map((value) => [{ path: [...map, 'height'], op: 'set', value }]),
    ...[44, 45, 955, 956].map((value) => [{ path: [...map, 'locations', int(0, 11), 'x'], op: 'set', value }]),
    ...[44, 45, 595, 596].map((value) => [{ path: [...map, 'regions', int(0, 4), 'y'], op: 'set', value }]),
    ...[320, 500, 700, 1_000].map((value) => [{ path: [...overview, 'width'], op: 'set', value }]),
    ...[240, 400, 500].map((value) => [{ path: [...overview, 'height'], op: 'set', value }]),
    ...[19, 20, 300, 900].map((value) => [{ path: [...overview, 'districts', int(0, 5), 'bounds', 'x'], op: 'set', value }]),
    ...[79, 80, 400, 800].map((value) => [{ path: [...overview, 'districts', int(0, 5), 'bounds', 'width'], op: 'set', value }]),
    ...[24, 25, 600, 975].map((value) => [{ path: [...overview, 'places', int(0, 9), 'x'], op: 'set', value }]),
  ]
  for (const mutations of cases) writer.call('loadCatalog', loadMutated, [mutations], { limit: 200 })
}
// Корень каталога и его версия.
for (const mutations of [[{ path: ['schema_version'], op: 'set', value: 2 }], [{ path: ['schema_version'], op: 'set', value: '1' }], [{ path: ['templates'], op: 'remove' }], [{ path: ['templates'], op: 'dup' }], [{ path: ['templates', 1, 'id'], op: 'set', value: IDS[0] }], []]) {
  writer.call('loadCatalog', loadMutated, [mutations], { limit: 200 })
}

writer.write(new URL('./world-template-catalog.json', import.meta.url))
console.log(`тесты ${afterTests}, экспорты ${afterExports - afterTests}, мутации ${writer.cases.length - afterExports} (отказов ${errors}, разных сообщений ${messages.size})`)
