import '../../../fixtures-env.mjs'
// Эталон server/level-generator.mjs для Rust:
//
//   node rust/crates/sk-world-time/fixtures/gen-level-generator.mjs [--corpus <каталог corpus-v1>]
//   node rust/crates/sk-world-time/fixtures/gen-level-generator.mjs --dump <label>
//
// Пишет `level-generator.json.gz`. Второй вид печатает полную сериализованную
// карту этажа случая — для отладки расхождения (в эталоне карта хранится
// хешем SHA-256 строки `JSON.stringify(serializeTacticalMap(map))`).
//
// Секции:
// - `labels` — `levelLabelFor` по смещениям и подсказкам, в том числе рыхлым;
// - `declared` — `normalizeDeclaredLevels` по заявкам с мусором;
// - `bases` — сериализованные карты исходных этажей (дедупликация по тексту);
// - `cases` — вызовы `generateLevelMap`: вход (карта — номер в `bases`) и
//   выход — хеш карты этажа, номер и подпись, прибытие, переход, предупреждения
//   и отказы, коды `auditTacticalMap` (инвариант играбельности),
//   `transitionReachableFrom`, контур `interiorOutline`.
//
// Источники исходных этажей: входы `test/level-generator.test.mjs` дословно;
// здания `generateBuildingScene` по сотням сидов, назначений, климатов и
// архитектур с объявленными этажами; поселения с двухэтажными домами
// (`buildThemedScene`); те же карты после круга через старые клетки (зон нет —
// контур по одной геометрии); сцены всех тем со случайным переходом; мусор
// предмета-перехода и номера этажа; настоящие вызовы движка правил
// (`UseLevelTransition` корпуса паритета), пойманные хуком загрузки модулей.
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

// Хук: `generateLevelMap` внутри `server/level-generator.mjs` переприсваивается
// обёрткой — импортёры (движок правил) видят её, исходники на диске не меняются.
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/server/level-generator.mjs')) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    return { ...result, source: `${source}\n;generateLevelMap = globalThis.__levelWrap(generateLevelMap)\n` }
  },
})
let recorder = null
globalThis.__levelWrap = (fn) => function recorded(options) {
  return recorder ? recorder(fn, options) : fn(options)
}

const { mulberry32, picker, writeFixture } = await import('../../sk-buildings/fixtures/common.mjs')
const t = await import('../../../../server/tactical-map.mjs')
const lg = await import('../../../../server/level-generator.mjs')
const bg = await import('../../../../server/building-generator.mjs')
const { buildThemedScene, SCENE_THEMES } = await import('../../../../server/scene-themes.mjs')
const { auditTacticalMap } = await import('../../../../server/map-quality.mjs')
const { levelSeed, stableLocationMapSeed } = await import('../../../../server/adventure-director.mjs')

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })
const { int, pick, chance } = picker(mulberry32(2026_10_16))

const FIXTURE = new URL('./level-generator.json.gz', import.meta.url)

// ---------------------------------------------------------------------------
// Случай generateLevelMap
// ---------------------------------------------------------------------------

const bases = []
const baseIndex = new Map()
const cases = []
const labels = new Set()
let disagreements = 0

function baseRef(map) {
  if (!map || typeof map !== 'object' || !Array.isArray(map.zones)) return null
  const text = JSON.stringify(t.serializeTacticalMap(map))
  if (!baseIndex.has(text)) {
    baseIndex.set(text, bases.length)
    bases.push(JSON.parse(text))
  }
  return baseIndex.get(text)
}

const restore = (index) => t.deserializeTacticalMap(structuredClone(bases[index]))

/** Прибытие для проверки контура: якорь предмета, как его видит генератор. */
function outlineAt(map, prop) {
  if (!map || !prop || typeof prop !== 'object') return null
  const x = Math.floor(Number(prop.x))
  const y = Math.floor(Number(prop.y))
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : null
}

function summarize(result, copy, at) {
  const map = result.map
  return {
    map: map ? hash(t.serializeTacticalMap(map)) : null,
    levelIndex: result.levelIndex,
    levelLabel: result.levelLabel,
    arrival: result.arrival,
    transitionPropId: result.transitionPropId,
    warnings: result.warnings,
    errors: result.errors,
    audit: map ? auditTacticalMap(map).problems.map((problem) => problem.code) : null,
    reach: map && result.arrival ? lg.transitionReachableFrom(map, result.arrival) : null,
    outline: copy ? hash([...lg.interiorOutline(copy, at)]) : null,
    outlineBare: copy ? lg.interiorOutline(copy).size : null,
  }
}

/**
 * Вызов на карте, прочитанной из сериализации (её получает Rust), и на живой
 * карте генератора; расхождение двух — повод остановиться.
 *
 * `options.baseMap` — живая карта, `null` или мусор; `extra` — `junkBase`
 * (вместо карты передаётся сам мусор).
 */
function runCase(fn, options) {
  const { baseMap, ...rest } = options
  const input = plain(rest) ?? {}
  if (Object.hasOwn(options, 'sourceProp') && options.sourceProp === undefined) delete input.sourceProp
  const base = baseRef(baseMap)
  const call = (map) => {
    const args = { ...input }
    if (map !== undefined) args.baseMap = map
    try {
      return { result: fn(args) }
    } catch (error) {
      return { error: errorOf(error) }
    }
  }
  const copy = base == null ? null : restore(base)
  const fresh = base == null ? null : restore(base)
  const expected = call(base == null ? (Object.hasOwn(options, 'baseMap') ? baseMap : undefined) : copy)
  const at = outlineAt(fresh, input.sourceProp)
  const summary = expected.error ? { error: expected.error } : summarize(expected.result, fresh, at)
  if (base != null && baseMap) {
    const live = call(baseMap)
    const liveSummary = live.error ? { error: live.error } : summarize(live.result, fresh, at)
    if (hash(liveSummary) !== hash(summary)) disagreements += 1
  }
  return { input, base, at, summary, map: expected.result?.map ?? null }
}

function addCase(label, options) {
  if (labels.has(label)) throw new Error(`повтор метки ${label}`)
  labels.add(label)
  const { input, base, at, summary } = runCase(lg.generateLevelMap, options)
  cases.push({ label, options: input, base, ...(Object.hasOwn(options, 'baseMap') && base == null ? { rawBase: plain(options.baseMap) ?? null } : {}), at, ...summary })
}

// --- --dump ----------------------------------------------------------------

const dumpAt = process.argv.indexOf('--dump')
if (dumpAt > 0) {
  const label = process.argv[dumpAt + 1]
  const fixture = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8'))
  const found = fixture.cases.find((entry) => entry.label === label)
  if (!found) throw new Error(`нет случая ${label}`)
  const args = { ...found.options }
  if (found.base != null) args.baseMap = t.deserializeTacticalMap(fixture.bases[found.base])
  else if (Object.hasOwn(found, 'rawBase')) args.baseMap = found.rawBase
  const result = lg.generateLevelMap(args)
  console.log(JSON.stringify(result.map ? t.serializeTacticalMap(result.map) : result))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Подписи и заявки
// ---------------------------------------------------------------------------

const OFFSETS = [0, 1, 2, 3, 4, -1, -2, -3, -4, -7, 10, 1.5, '2', '-1', ' -2 ', '', 'x', null, true, false, [], [3], { a: 1 }, 2 ** 53, -0]
const HINTS = ['', 'винный погреб', '  старый   склеп  ', 'спальни и кабинет хозяина', 'ßtraße', '𐐨ёлка', 'ёж', ' ', 5, null, ['погреб'],
  'очень длинная подсказка про подземные ходы, которые тянутся под всем городом и выходят к реке у старой мельницы']
const levelLabels = []
for (const offset of OFFSETS) {
  levelLabels.push({ offset, label: lg.levelLabelFor(offset) })
  for (const hint of HINTS) levelLabels.push({ offset, hint, label: lg.levelLabelFor(offset, hint) })
}

const DECLARED_INPUTS = [
  [null, 'второй этаж', { offset: 'вверх' }, { offset: 0, hint: 'сам этаж входа' }, { offset: 1.5 }, { offset: 1, hint: 'спальни' },
    { offset: 1, hint: 'повтор того же этажа' }, { offset: -9, hint: 'винный погреб' }, { offset: 2 }, { offset: -2 }],
  [{ offset: 1, hint: 'спальни и кабинет хозяина' }, { offset: -1, hint: 'винный погреб' }],
  [{ offset: '1' }, { offset: [2] }, { offset: true }, { offset: null }, { offset: -0 }],
  [[{ offset: 1 }], { offset: -1, hint: 7 }, { offset: -2, hint: '  погреб   с   бочками ' }],
  [{ offset: 5 }, { offset: 4 }, { offset: 3 }, { offset: -5 }],
  { offset: 1 }, 'levels', null, [], [{}],
]
for (let index = 0; index < 40; index += 1) {
  DECLARED_INPUTS.push(Array.from({ length: int(6) }, () => (chance(0.1) ? null : {
    offset: pick([1, 2, 3, -1, -2, -3, 0, 7, -8, 1.5, '2', 'x']),
    ...(chance(0.7) ? { hint: pick(HINTS) } : {}),
  })))
}
const declared = DECLARED_INPUTS.map((value) => ({ value, levels: lg.normalizeDeclaredLevels(value) }))

// ---------------------------------------------------------------------------
// Исходные этажи
// ---------------------------------------------------------------------------

const DECLARED = lg.normalizeDeclaredLevels([{ offset: 1, hint: 'спальни и кабинет хозяина' }, { offset: -1, hint: 'винный погреб' }])
const tavern = (seed) => bg.generateBuildingScene({ seed, locationId: 'loc-tavern', levels: DECLARED })
const transitions = (map) => map.props.filter((prop) => prop.transition)

/** Переходы карты — так, как их зовёт движок правил. */
function addTransitions(prefix, map, { locationId = 'loc', location = 'Место', theme = '', worldSeed = 'campaign-1', hints = true } = {}) {
  for (const prop of transitions(map)) {
    const toLevel = prop.transition.toLevel
    const seed = levelSeed(stableLocationMapSeed({ seed: worldSeed }, locationId, location), toLevel)
    addCase(`${prefix}:${prop.id}`, {
      locationId, level: toLevel, seed, baseMap: map, sourceProp: prop,
      hint: hints ? String(prop.transition.label ?? '') : '', theme,
    })
  }
}

// Тест — дословно.
{
  const base = tavern('постоялый двор')
  const up = transitions(base).find((prop) => prop.transition.toLevel === 1)
  const down = transitions(base).find((prop) => prop.transition.toLevel === -1)
  addCase('test/upper', { locationId: 'loc-tavern', level: 1, seed: 'seed@L1', baseMap: base, sourceProp: up, hint: 'спальни' })
  addCase('test/cellar', { locationId: 'loc-tavern', level: -1, seed: 'seed@L-1', baseMap: base, sourceProp: down, hint: 'винный погреб' })
  addCase('test/upper-nohint', { locationId: 'loc-tavern', level: 1, seed: 'seed@L1', baseMap: base, sourceProp: up })
  addCase('test/cellar-nohint', { locationId: 'loc-tavern', level: -1, seed: 'seed@L-1', baseMap: base, sourceProp: down })
  for (const level of [0, 4, -4, 'второй', 1.5]) addCase(`test/refuse-level-${level}`, { locationId: 'loc-tavern', level, seed: 'seed', baseMap: base, sourceProp: up })
  addCase('test/no-source', { locationId: 'loc-tavern', level: 1, seed: 'seed', baseMap: base })
  addCase('test/no-base', { locationId: 'loc-tavern', level: 1, seed: 'seed', sourceProp: up })
  addCase('test/outside', { locationId: 'loc-tavern', level: 1, seed: 'seed', baseMap: base, sourceProp: { assetId: 'stairs_up', x: base.width + 4.5, y: 2.5, footprint: [] } })
  const hatch = tavern('люк')
  const hatchDown = transitions(hatch).find((prop) => prop.transition.toLevel === -1)
  addCase('test/hatch', { locationId: 'loc-tavern', level: -1, seed: 'люк@L-1', baseMap: hatch, sourceProp: hatchDown, hint: 'подпол' })
  for (const seed of ['таверна', 'подворье', 'корчма', 'трактир у брода']) {
    const map = tavern(seed)
    for (const level of [1, -1]) {
      addCase(`test/seed-${seed}-${level}`, {
        locationId: 'loc-tavern', level, seed: `${seed}@L${level}`, baseMap: map,
        sourceProp: transitions(map).find((prop) => prop.transition.toLevel === level), hint: level > 0 ? 'спальни' : 'винный погреб',
      })
    }
  }
  const cave = buildThemedScene({ themeId: 'cave', seed: 'подземные ходы', width: 26, height: 26, locationId: 'loc-cave' }).map
  const floor = []
  for (let y = 0; y < cave.height; y += 1) for (let x = 0; x < cave.width; x += 1) if (t.cellAt(cave, x, y)?.passable) floor.push({ x, y })
  const spot = floor[Math.floor(floor.length / 2)]
  addCase('test/cave', {
    locationId: 'loc-cave', level: -1, seed: 'пещера@L-1', baseMap: cave, theme: 'cave',
    sourceProp: { assetId: 'stairs_down', x: spot.x + 0.5, y: spot.y + 0.5, footprint: [{ x: spot.x, y: spot.y }] }, hint: 'нижние ходы',
  })
  addCase('test/cave-corner', { locationId: 'loc-cave', level: -1, seed: 'пещера@L-1', baseMap: cave, theme: 'cave', sourceProp: { assetId: 'stairs_down', x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }] } })
  const forest = buildThemedScene({ themeId: 'forest', seed: 'опушка', width: 26, height: 26, locationId: 'loc-forest' }).map
  addCase('test/forest', { locationId: 'loc-forest', level: 1, seed: 'лес@L1', baseMap: forest, sourceProp: { assetId: 'stairs_up', x: 5.5, y: 5.5, footprint: [] } })
}

// Здания по сидам и замыслам.
const USES = ['dwelling', 'tavern', 'shop', 'manor']
const CLIMATES = ['temperate', 'arid', 'cold', 'wetland']
const ARCHITECTURES = ['wood', 'stone', 'sand', 'metal', 'marble', 'ice']
const LEVEL_SETS = [DECLARED, lg.normalizeDeclaredLevels([{ offset: 2 }, { offset: 1 }]), lg.normalizeDeclaredLevels([{ offset: -1 }, { offset: -2, hint: 'катакомбы' }]),
  lg.normalizeDeclaredLevels([{ offset: 3 }, { offset: -3, hint: 'бездна' }]), lg.normalizeDeclaredLevels([{ offset: 1 }])]
const buildingBases = []
for (let index = 0; index < 160; index += 1) {
  const options = {
    seed: `здание-${index}`,
    locationId: `loc-${index % 7}`,
    levels: LEVEL_SETS[index % LEVEL_SETS.length],
    ...(index % 3 === 0 ? {} : { design: { building_use: USES[index % 4], climate: CLIMATES[(index >> 2) % 4], architecture: ARCHITECTURES[index % 6] } }),
    ...(index % 5 === 0 ? { width: 24 + int(24), height: 22 + int(22) } : {}),
  }
  let map
  try {
    map = bg.generateBuildingScene(options)
  } catch {
    continue
  }
  buildingBases.push(map)
  addTransitions(`building/${index}`, map, { locationId: options.locationId, location: `Дом ${index}`, theme: index % 11 === 0 ? 'грот' : '' })
}

// Поселения: двухэтажный дом объявляет этаж сам.
const settlementBases = []
for (let index = 0; index < 40; index += 1) {
  const built = buildThemedScene({
    themeId: 'settlement', seed: `деревня-${index}`, width: 40 + int(20), height: 40 + int(20), locationId: `town-${index}`,
    ...(index % 4 === 1 ? { levels: [{ offset: -1, hint: 'погреб' }] } : {}),
  })
  if (!transitions(built.map).length) continue
  settlementBases.push(built.map)
  addTransitions(`settlement/${index}`, built.map, { locationId: `town-${index}`, location: `Деревня ${index}` })
}

// Круг через старые клетки: зон нет, контур — по одной геометрии.
for (const [index, map] of [...buildingBases.slice(0, 60), ...settlementBases.slice(0, 20)].entries()) {
  const legacy = t.tacticalMapFromLegacyCells(t.legacyCellsFromTacticalMap(map), { locationId: map.locationId, seed: map.seed })
  for (const prop of transitions(map)) {
    const anchor = legacy.props.find((candidate) => Math.floor(candidate.x) === Math.floor(prop.x) && Math.floor(candidate.y) === Math.floor(prop.y))
    const source = anchor ?? { assetId: prop.assetId, x: prop.x, y: prop.y, footprint: prop.footprint }
    addCase(`legacy/${index}:${prop.id}`, { locationId: map.locationId, level: prop.transition.toLevel, seed: `legacy-${index}@L${prop.transition.toLevel}`, baseMap: legacy, sourceProp: source, hint: prop.transition.label })
  }
}

// Сцены всех тем со случайным переходом.
const THEME_SIZES = [[26, 26], [30, 24], [20, 34], [40, 40]]
for (const theme of SCENE_THEMES) {
  for (let index = 0; index < 8; index += 1) {
    const [width, height] = pick(THEME_SIZES)
    let map
    try {
      map = buildThemedScene({ themeId: theme.id, seed: `${theme.id}-${index}`, width, height, locationId: `loc-${theme.id}` }).map
    } catch {
      continue
    }
    const floor = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (t.cellAt(map, x, y)?.passable) floor.push({ x, y })
    for (let probe = 0; probe < 4; probe += 1) {
      const spot = floor.length ? pick(floor) : { x: int(map.width), y: int(map.height) }
      const level = pick([1, -1, 2, -2, 3, -3])
      addCase(`theme/${theme.id}/${index}/${probe}`, {
        locationId: `loc-${theme.id}`, level, seed: `${theme.id}-${index}@L${level}`, baseMap: map,
        sourceProp: { assetId: pick(['stairs_up', 'stairs_down', 'trapdoor', 'ladder']), x: spot.x + 0.5, y: spot.y + 0.5, footprint: chance(0.7) ? [{ x: spot.x, y: spot.y }] : [] },
        theme: pick(['', theme.id, 'Пещера', 'cave', 'Старая штольня', 'каверна']),
        hint: pick(HINTS),
      })
    }
    addTransitions(`theme/${theme.id}/${index}`, map, { locationId: `loc-${theme.id}` })
  }
}

// Здания со случайными переходами и мусором предмета.
const JUNK_PROPS = [
  null, 'stairs', 5, [], {}, { x: 'x', y: 2 }, { x: 3.5 }, { x: -1.5, y: 2.5 }, { x: 2.5, y: 2.5, footprint: 'x' },
  { x: 2.5, y: 2.5, footprint: [{ x: 7, y: 7 }] }, { x: 'a', y: 'b', footprint: [{ x: '4', y: '5' }] }, { x: 2.5, y: 2.5, footprint: [{ x: 1.5, y: 2 }] },
  { x: 2.5, y: 2.5, footprint: [null] }, { footprint: [{ x: 3, y: 3 }, { x: 4, y: 3 }] }, { footprint: [5] }, { x: '3', y: '4', assetId: 'trapdoor' },
  { x: 1e21, y: 3 }, { x: 3, y: 3, assetId: ['trapdoor'] }, { x: 3, y: 3, assetId: null },
]
for (const [index, map] of buildingBases.slice(0, 50).entries()) {
  for (let probe = 0; probe < 4; probe += 1) {
    const x = int(map.width)
    const y = int(map.height)
    const level = pick([1, -1, 2, -3, 1, -1])
    addCase(`random/${index}/${probe}`, {
      locationId: map.locationId, level, seed: pick([`r-${index}-${probe}`, 7, null, ['a', 'b']]), baseMap: map,
      sourceProp: { assetId: pick(['stairs_up', 'trapdoor', 'stairs_down']), x: x + 0.5, y: y + 0.5, footprint: chance(0.5) ? [{ x, y }, { x: x + 1, y }] : [{ x: x + 1, y }] },
      hint: pick(HINTS), theme: pick(['', 'cave', 'дом']),
    })
  }
  if (index < 12) {
    for (const [junk, prop] of JUNK_PROPS.entries()) {
      addCase(`junk-prop/${index}/${junk}`, { locationId: map.locationId, level: index % 2 ? 1 : -1, seed: `j-${index}`, baseMap: map, sourceProp: prop })
    }
  }
}
// Мусор номера этажа, исходной карты и полей вызова.
{
  const map = buildingBases[0]
  const prop = transitions(map)[0]
  for (const [index, level] of [undefined, null, '1', ' -1 ', [1], true, 2 ** 53, -0, 'Infinity', 1e300].entries()) {
    addCase(`junk-level/${index}`, { locationId: 'loc', ...(level === undefined ? {} : { level }), seed: 'junk', baseMap: map, sourceProp: prop })
  }
  for (const [index, junk] of [null, 'map', 5, [], { zones: 'x' }].entries()) {
    addCase(`junk-base/${index}`, { locationId: 'loc', level: 1, seed: 'junk', baseMap: junk, sourceProp: prop })
  }
  addCase('junk-fields/defaults', { level: 1, baseMap: map, sourceProp: prop })
  addCase('junk-fields/hint-number', { locationId: 'loc', level: -1, seed: 'junk', baseMap: map, sourceProp: prop, hint: 5, theme: null })
  addCase('junk-fields/same-level', { locationId: 'loc', level: map.levelIndex, seed: 'junk', baseMap: map, sourceProp: prop })
}

// ---------------------------------------------------------------------------
// Настоящие вызовы движка правил: UseLevelTransition корпуса паритета
// ---------------------------------------------------------------------------

const corpusAt = process.argv.indexOf('--corpus')
const CORPUS = corpusAt > 0 ? process.argv[corpusAt + 1] : 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
let corpusCalls = 0
try {
  const { resolveCommand } = await import('../../../../server/rules-engine.mjs')
  const { DiceService, SequenceDiceRng } = await import('../../../../server/dice-service.mjs')
  const files = readdirSync(CORPUS).filter((name) => /^corpus-\d+\.jsonl$/u.test(name)).sort()
  for (const name of files) {
    const text = readFileSync(join(CORPUS, name), 'utf8')
    if (!text.includes('UseLevelTransition')) continue
    for (const [row, line] of text.split('\n').entries()) {
      if (!line.includes('"UseLevelTransition"')) continue
      const entry = JSON.parse(line)
      const state = JSON.parse(readFileSync(join(CORPUS, 'states', `${entry.state}.json`), 'utf8'))
      let call = 0
      recorder = (fn, options) => {
        call += 1
        recorder = null
        addCase(`corpus/${name}:${row}:${call}`, options)
        return fn(options)
      }
      try {
        resolveCommand(entry.command, state, { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: entry.context ?? {} })
      } catch {
        // Отказ команды — тоже исход; нужен только пойманный вызов генератора.
      }
      recorder = null
      corpusCalls += call
    }
  }
} catch (error) {
  console.error(`корпус недоступен: ${error.message}`)
}

console.log(`случаев: ${cases.length}, исходных карт: ${bases.length}, вызовов из корпуса: ${corpusCalls}, расхождений живой и прочитанной карты: ${disagreements}`)
writeFixture(FIXTURE, { labels: levelLabels, declared, bases, cases }, { gzip: true })
