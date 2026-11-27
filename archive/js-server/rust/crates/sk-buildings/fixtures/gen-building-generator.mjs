import '../../../fixtures-env.mjs'
// Эталон server/building-generator.mjs для Rust:
//
//   node rust/crates/sk-buildings/fixtures/gen-building-generator.mjs
//   node rust/crates/sk-buildings/fixtures/gen-building-generator.mjs --dump <label>
//
// Второй вид печатает полную сериализованную карту случая — для отладки
// расхождения (в эталоне карта хранится хешем).
//
// Источники случаев (`cases`):
//
// - тест: входы `test/building-generator.test.mjs` дословно (эталонная сцена,
//   плотность, вход внутрь, назначения, сто сидов, схемы, коридор, этажи,
//   пропорции, участок, обстановка четвертей, крепость Ареса, безопасная
//   комната);
// - конвейер: `generateSceneGeometry` по эталонным сценам `MAP_PREVIEW_PRESETS`
//   (размеры и сиды тестов пропорций и обстановки), корпусу программ сцен,
//   местам `test/map-quality.test.mjs` и `test/scene-themes.test.mjs`, местам
//   с текстом сцены (вход внутрь, сторона входа, этажи, форма корпуса), и
//   `createSceneTransition` в трактир — вход `buildBuildingScene` и
//   `buildAresFortressScene` пойман перехватчиком (`capture.mjs`) вместе с
//   хешем карты, которую вернул сервер;
// - случайные входы: назначение, климат, архитектура, плотность, форма,
//   схема, топология, маг, размеры (дробные, отрицательные, строкой), вход,
//   этажи, реквизит, темы и сиды — в том числе рыхлые значения JS.
//
// Для каждого случая — хеш карты, ступень отката и предупреждения сборки,
// коды замечаний `auditTacticalMap` (инвариант играбельности, AGENTS.md §5),
// `reachabilityIssues`, `tacticalFitnessWarnings`, четверти зала и
// обставленные клетки.
//
// Прочие секции: `ops` — программы `openDoorway`/`openWindow`/`edgesAround`/
// `ensureDeclaredTransitions` над построенными картами; `probes` —
// достижимость, пригодность и четверти на картах, где часть клеток стала
// стеной; `planRooms`;
// `transitions` — вызовы `ensureDeclaredTransitions` конвейером над картами
// поселений (вход — сериализованная карта, файл
// `fixtures/pipeline-transitions.json.gz`); `sorts` — `Array.prototype.sort`
// V8 с несогласованным сравнителем (перенос сортировки обязан повторять
// TimSort V8 шаг в шаг).
import { startRecording, stopRecording } from './capture.mjs'
import { errorOf, hash, mulberry32, picker, plain, writeFixture } from './common.mjs'

const t = await import('../../../../server/tactical-map.mjs')
const bg = await import('../../../../server/building-generator.mjs')
const { generateSceneGeometry, createSceneTransition } = await import('../../../../server/adventure-director.mjs')
const { auditTacticalMap, MAP_PREVIEW_PRESETS } = await import('../../../../server/map-quality.mjs')
const { sceneMapRequirementsFor, sceneRequirementsFromText } = await import('../../../../server/scene-requirements.mjs')
const { buildThemedScene, SCENE_THEMES } = await import('../../../../server/scene-themes.mjs')
const { readFileSync } = await import('node:fs')

const { int, pick, chance } = picker(mulberry32(2026_10_15))

const dumpAt = process.argv.indexOf('--dump')
if (dumpAt > 0) {
  // Быстрый путь: вход случая берётся из записанного эталона.
  const label = process.argv[dumpAt + 1]
  const fixture = JSON.parse(readFileSync(new URL('./building-generator.json', import.meta.url), 'utf8'))
  const found = fixture.cases.find((entry) => entry.label === label)
  if (!found) throw new Error(`нет случая ${label}`)
  const run = { build: bg.buildBuildingScene, generate: bg.generateBuildingScene, ares: bg.generateAresFortressScene, aresBuild: bg.buildAresFortressScene, safeRoom: bg.safeRoom }[found.fn]
  const built = run(found.options)
  console.log(JSON.stringify(t.serializeTacticalMap(built.map ?? built)))
  process.exit(0)
}

const serialize = (map) => t.serializeTacticalMap(map)
const mapHash = (map) => hash(serialize(map))

/** Разбор карты: всё, что Rust сверяет помимо самой карты. */
function analyze(map) {
  const quarters = bg.roomQuarters(map, 'hall')
  return {
    mapHash: mapHash(map),
    audit: auditTacticalMap(map).problems.map((problem) => problem.code),
    reach: bg.reachabilityIssues(map),
    fitness: bg.tacticalFitnessWarnings(map),
    quarters: hash(quarters),
    furnished: hash([...bg.furnishedCells(map)]),
  }
}

const FNS = {
  build: (options) => bg.buildBuildingScene(options),
  generate: (options) => ({ map: bg.generateBuildingScene(options) }),
  ares: (options) => ({ map: bg.generateAresFortressScene(options) }),
  aresBuild: (options) => bg.buildAresFortressScene(options),
  safeRoom: (options) => ({ map: bg.safeRoom(options) }),
}

const cases = []
const labels = new Set()
/** Случай: вызов `fn` с `options` и его выход. */
function addCase(label, fn, options, extra = {}) {
  if (labels.has(label)) throw new Error(`повтор метки ${label}`)
  labels.add(label)
  const input = options === null ? null : (plain(options) ?? {})
  let result
  try {
    const built = FNS[fn](input)
    result = { ...analyze(built.map), ...(built.fallback === undefined ? {} : { fallback: built.fallback, warnings: built.warnings }) }
  } catch (error) {
    result = { error: errorOf(error) }
  }
  cases.push({ label, fn, options: input, ...result, ...extra })
}

// --- тест ---------------------------------------------------------------------------

addCase('test/reference', 'generate', { seed: 'reference' })
for (const density of ['sparse', 'dense']) addCase(`test/density/${density}`, 'generate', { seed: 'density-building', width: 40, height: 36, design: { building_use: 'dwelling', density } })
for (const seed of ['same', 'other', 'theme-default', 'entry-contract']) addCase(`test/${seed}`, 'generate', { seed })
addCase('test/theme-shop', 'generate', { seed: 'theme-shop', theme: 'market-shop' })
addCase('test/entry-interior', 'generate', { seed: 'entry-contract', entry: 'interior' })
addCase('test/ladder', 'build', { seed: 'ladder' })
addCase('test/tiny', 'build', { seed: 'tiny', width: 16, height: 16 })
const DESIGNS = {
  dwelling: { building_use: 'dwelling', climate: 'cold', architecture: 'stone' },
  tavern: { building_use: 'tavern', climate: 'temperate', architecture: 'wood' },
  shop: { building_use: 'shop', climate: 'arid', architecture: 'sand' },
  manor: { building_use: 'manor', climate: 'wetland', architecture: 'marble' },
}
for (const [use, design] of Object.entries(DESIGNS)) addCase(`test/design-${use}`, 'generate', { seed: `design-${use}`, design })
for (const seed of ['layout-a', 'layout-b']) addCase(`test/${seed}`, 'generate', { seed, design: DESIGNS.tavern })
{
  const uses = ['dwelling', 'tavern', 'shop', 'manor']
  const climates = ['temperate', 'arid', 'cold', 'wetland']
  const architectures = ['wood', 'stone', 'sand', 'metal', 'marble', 'ice']
  for (let index = 0; index < 100; index += 1) {
    addCase(`test/design-${index}`, 'build', { seed: `design-${index}`, design: { building_use: uses[index % 4], climate: climates[index % 4], architecture: architectures[index % 6] } })
  }
}
for (let index = 0; index < 40; index += 1) addCase(`test/geometry-${index}`, 'generate', { seed: `geometry-${index}`, design: { building_use: 'dwelling' } })
addCase('test/design-levels', 'generate', { seed: 'design-levels', design: DESIGNS.tavern, levels: [{ offset: 1, label: 'Спальни' }, { offset: -1, label: 'Погреб' }] })
addCase('test/safe-room', 'safeRoom', { seed: 'fallback' })
addCase('test/ares-stable', 'ares', { seed: 'ares-stable', width: 17, height: 11 })
addCase('test/ares-connectivity', 'ares', { seed: 'ares-connectivity' })
addCase('test/ares-prologue', 'aresBuild', { seed: 'ares-prologue' })
addCase('test/ares-surface', 'ares', { seed: 'ares-surface' })
for (const use of ['dwelling', 'tavern', 'manor']) addCase(`test/corridor-${use}`, 'build', { seed: `corridor-${use}`, width: 44, height: 40, design: { building_use: use, scheme: 'corridor', shape: 'rect' } })
for (const use of ['tavern', 'shop', 'dwelling', 'manor']) {
  for (const size of [{ width: 22, height: 20 }, { width: 44, height: 40 }]) {
    for (let index = 0; index < 12; index += 1) addCase(`test/proportions-${use}-${size.width}-${index}`, 'build', { seed: `proportions-${use}-${index}`, ...size, design: { building_use: use } })
  }
  addCase(`test/proportions-${use}-corridor`, 'build', { seed: `proportions-${use}-corridor`, width: 44, height: 40, design: { building_use: use, scheme: 'corridor', shape: 'rect' } })
}
for (const seed of ['plot-a', 'plot-b', 'plot-c']) {
  addCase(`test/${seed}/small`, 'build', { seed, width: 26, height: 26, design: { building_use: 'tavern' } })
  addCase(`test/${seed}/large`, 'build', { seed, width: 44, height: 40, design: { building_use: 'tavern' } })
}
for (const seed of ['yard-a', 'yard-b', 'yard-c']) {
  addCase(`test/${seed}/tavern`, 'build', { seed, width: 36, height: 30, design: { building_use: 'tavern', climate: 'temperate' } })
  addCase(`test/${seed}/dwelling`, 'build', { seed, width: 36, height: 30, design: { building_use: 'dwelling', climate: 'temperate' } })
}
for (let index = 0; index < 20; index += 1) addCase(`test/furnished-${index}`, 'build', { seed: `furnished-${index}`, width: 36, height: 30, design: { building_use: 'tavern' } })
// Рыхлые входы, на которых JS откатывается (проверено на Node 24).
addCase('edge/width-nan', 'build', { seed: 'nan', width: 'abc' })
addCase('edge/height-nan', 'build', { seed: 'nan-h', height: 'x' })
addCase('edge/levels-null', 'build', { seed: 'levels-null', levels: null })
addCase('edge/levels-null-generate', 'generate', { seed: 'levels-null', levels: null })
addCase('edge/levels-far', 'build', { seed: 'levels-far', levels: [{ offset: 5 }] })
addCase('edge/levels-far-generate', 'generate', { seed: 'levels-far', levels: [{ offset: 5 }] })
addCase('edge/seed-null', 'build', { seed: null })
addCase('edge/seed-null-generate', 'generate', { seed: null, design: { building_use: 'mill' } })
addCase('edge/width-null', 'build', { width: null })
addCase('edge/negative', 'build', { width: -10, height: 100 })
addCase('edge/ares-width-nan', 'ares', { width: 'x' })
addCase('edge/ares-height-nan', 'ares', { height: 'x' })
addCase('edge/ares-both-nan', 'ares', { width: 'x', height: 'y' })
addCase('edge/default', 'build', {})
addCase('edge/default-generate', 'generate', {})
addCase('edge/design-string', 'build', { seed: 'design-string', design: 'manor' })
addCase('edge/design-array', 'build', { seed: 'design-array', design: ['manor'] })
addCase('edge/levels-object', 'build', { seed: 'levels-object', levels: { length: 0 } })
addCase('edge/levels-string', 'build', { seed: 'levels-string', levels: '' })
// Вход не объектом: `null` — TypeError чтения поля, прочее — как пустой объект.
for (const fn of Object.keys(FNS)) for (const [name, options] of [['null', null], ['number', 5], ['string', 'abc'], ['array', []]]) addCase(`edge/options-${name}/${fn}`, fn, options)

// Редкие ветки, найденные перебором входов: угол среза Г-образного корпуса по
// сиду, запасной раскрой креста и круга, обрывок комнаты в пять клеток,
// мебель, отрезающая пол, двор усадьбы.
const SEARCHED = {
  'corner-seed-L': [
    { seed: 't0-17', width: 16, height: 59, design: { building_use: 'dwelling', scheme: 'long-hall', topology: 'river' } },
    { seed: 't0-120', width: 44, height: 16, design: { building_use: 'dwelling', scheme: 'courtyard', topology: 'river' } },
    { seed: 't0-129', width: 34, height: 39, design: { building_use: 'barracks' } },
    { seed: 't1-138', width: 43, height: 30, design: { building_use: 'barracks', scheme: 'long-hall' } },
    { seed: 't1-173', width: 16, height: 41, design: { building_use: 'manor', shape: 'L', scheme: 'long-hall' } },
    { seed: 't1-174', width: 56, height: 43, design: { building_use: 'barracks', shape: 'L', scheme: 'long-hall' } },
    { seed: 't2-79', width: 36, height: 48, design: { building_use: 'barracks', shape: 'L' } },
    { seed: 't2-172', width: 17, height: 22, design: { building_use: 'barracks', shape: 'L', scheme: 'long-hall' } },
  ],
  'fallback-relax': [
    { seed: 't0-49', width: 16, height: 39, design: { building_use: 'manor', shape: 'cross', topology: 'river' } },
    { seed: 't0-118', width: 23, height: 32, design: { building_use: 'shop', shape: 'round', scheme: 'courtyard' } },
    { seed: 't0-152', width: 40, height: 20, design: { building_use: 'smithy', shape: 'round', scheme: 'courtyard' } },
    { seed: 't1-49', width: 16, height: 17, design: { building_use: 'mill', shape: 'cross', scheme: 'courtyard', topology: 'river' } },
    { seed: 't1-149', width: 48, height: 18, design: { building_use: 'manor', shape: 'round' } },
    { seed: 't1-172', width: 54, height: 17, design: { building_use: 'shop', shape: 'round', scheme: 'courtyard' } },
    { seed: 't2-22', width: 22, height: 36, design: { building_use: 'barracks', shape: 'round', scheme: 'courtyard' } },
    { seed: 't2-59', width: 16, height: 35, design: { building_use: 'dwelling', shape: 'round', scheme: 'long-hall', topology: 'courtyard' } },
  ],
  'fragment-5': [
    { seed: 't0-100', width: 22, height: 18, design: { building_use: 'mill', shape: 'cross' } },
    { seed: 't0-106', width: 16, height: 20, design: { building_use: 'shop', shape: 'cross', scheme: 'long-hall' } },
    { seed: 't1-42', width: 16, height: 24, design: { building_use: 'barracks', shape: 'cross', scheme: 'long-hall', topology: 'river' } },
    { seed: 't1-652', width: 24, height: 47, design: { building_use: 'dwelling', shape: 'cross', topology: 'river' } },
    { seed: 't2-188', width: 22, height: 17, design: { building_use: 'manor', shape: 'cross' } },
    { seed: 't2-272', width: 16, height: 21, design: { building_use: 'dwelling', shape: 'L' } },
  ],
  'reach-reject': [
    { seed: 's23211', width: 25, height: 36, design: { building_use: 'barracks', shape: 'round', scheme: 'courtyard', topology: 'river' } },
    { seed: 's161', width: 16, height: 60, design: { building_use: 'manor', topology: 'courtyard' } },
    { seed: 's181', width: 57, height: 55, design: { building_use: 'manor', shape: 'rect', topology: 'courtyard' } },
    { seed: 's277', width: 27, height: 21, design: { building_use: 'manor', scheme: 'wing', topology: 'courtyard' } },
    { seed: 's445', width: 37, height: 54, design: { building_use: 'manor', shape: 'L', scheme: 'courtyard' } },
    { seed: 't0-40', width: 55, height: 36, design: { building_use: 'manor', shape: 'L', scheme: 'long-hall', topology: 'courtyard' } },
    { seed: 't0-609', width: 56, height: 38, design: { building_use: 'manor', shape: 'L', scheme: 'courtyard' } },
    { seed: 't1-92', width: 20, height: 31, design: { building_use: 'manor', shape: 'rect', scheme: 'courtyard' } },
    { seed: 't1-764', width: 60, height: 36, design: { building_use: 'manor', shape: 'rect', scheme: 'courtyard', topology: 'courtyard' } },
    { seed: 't2-349', width: 41, height: 22, design: { building_use: 'manor', scheme: 'courtyard', topology: 'courtyard' } },
    { seed: 't2-865', width: 58, height: 20, design: { building_use: 'manor', shape: 'L', scheme: 'wing', topology: 'courtyard' } },
  ],
}
for (const [branch, list] of Object.entries(SEARCHED)) {
  list.forEach((options, index) => {
    addCase(`search/${branch}/${index}`, 'build', options)
    addCase(`search/${branch}/${index}/generate`, 'generate', options)
  })
}

// Сцены тестов #184: гарнитур и поворот карты, мебель у точки появления,
// хозяйская спальня усадьбы, фигурные корпуса с проверкой главной мебели.
addCase('184/orient-seats', 'generate', { seed: 'orient-seats', width: 30, height: 26, design: { building_use: 'tavern' } })
for (const seed of ['spawn-a', 'spawn-b', 'spawn-c', 'spawn-d', 'spawn-e', 'spawn-f']) addCase(`184/${seed}`, 'generate', { seed, width: 30, height: 26, design: { building_use: 'tavern' }, entry: 'interior' })
for (const use of ['manor', 'tavern', 'dwelling', 'barracks']) for (const shape of ['L', 'cross', 'round']) for (const seed of ['a', 'b', 'c']) {
  addCase(`184/${use}/${shape}/${seed}`, 'generate', { seed: `184-${use}-${shape}-${seed}`, width: 36, height: 30, design: { building_use: use, shape } })
}
// --- конвейер -------------------------------------------------------------------------

/** Вызовы `ensureDeclaredTransitions` конвейером: вход — карта поселения. */
const transitions = []
const captured = []
function record(name, fn, args) {
  if (name === 'ensureDeclaredTransitions') {
    const [map, levels, zoneId] = args
    const before = serialize(t.deserializeTacticalMap(plain(serialize(map))))
    const copy = t.deserializeTacticalMap(plain(before))
    let expected
    try {
      fn(copy, levels, zoneId)
      expected = { mapHash: mapHash(copy) }
    } catch (error) {
      expected = { error: errorOf(error) }
    }
    transitions.push({ before, levels: plain(levels) ?? null, zoneId, ...expected })
    return fn(...args)
  }
  const input = plain(args[0]) ?? {}
  const result = fn(...args)
  const map = result.map ?? result
  captured.push({ name, options: input, mapHash: mapHash(map), fallback: result.fallback, warnings: plain(result.warnings) })
  return result
}
const FN_OF = { buildBuildingScene: 'build', buildAresFortressScene: 'aresBuild', generateBuildingScene: 'generate', generateAresFortressScene: 'ares', safeRoom: 'safeRoom' }

function pipeline(label, run) {
  const before = captured.length
  startRecording(record)
  try {
    run()
  } catch (error) {
    console.log(`  конвейер отказал на ${label}: ${error.message}`)
  } finally {
    stopRecording()
  }
  const calls = captured.slice(before)
  calls.forEach((call, index) => addCase(`pipeline:${label}${calls.length > 1 ? `#${index}` : ''}`, FN_OF[call.name], call.options, {
    pipelineHash: call.mapHash, ...(call.fallback === undefined ? {} : { pipelineFallback: call.fallback }),
  }))
}
const scene = (label, input) => pipeline(label, () => generateSceneGeometry({ ...input, useLibrary: false }))

const PRESET_USE = { tavern: 'tavern', shop: 'shop', house: 'dwelling', manor: 'manor' }
for (const preset of MAP_PREVIEW_PRESETS.filter((entry) => PRESET_USE[entry.id])) {
  for (const size of [{ width: 16, height: 14 }, { width: 26, height: 26 }, { width: 36, height: 30 }, { width: 40, height: 32 }]) {
    for (const seed of ['s1', 's2', 's3']) scene(`preset/${preset.id}/${size.width}x${size.height}/${seed}`, { ...preset.input, map: size, seed: `${preset.id}:${seed}` })
  }
}
for (const preset of MAP_PREVIEW_PRESETS) scene(`preset/${preset.id}/default`, { ...preset.input, seed: `preview:${preset.id}` })
const programCorpus = JSON.parse(readFileSync(new URL('../../../../test/fixtures/scene-programs/corpus.json', import.meta.url), 'utf8'))
for (const entry of programCorpus.scenes) {
  const program = sceneMapRequirementsFor([entry.location, entry.text], { npcs: entry.npcs })
  scene(`corpus/${entry.id}`, { location: entry.location, theme: entry.theme, settlementType: entry.settlementType ?? '', requirements: program?.items ?? [], program, seed: `corpus:${entry.id}` })
}
for (const seed of ['q1', 'q2', 'q3', 'q4']) {
  for (const [location, theme] of [['Дом мельника', 'жилой дом'], ['Таверна «Рыжий рог»', 'таверна']]) scene(`quality/${location}/${seed}`, { location, theme, seed: `${location}:${seed}` })
  for (const shape of ['L', 'cross', 'round']) scene(`quality/shape/${shape}/${seed}`, { location: 'Усадьба Вельских', theme: 'усадьба', seed: `shape:${shape}:${seed}`, map: { width: 30, height: 28, design: { shape } } })
  for (const [location, theme] of [['Дом мельника', 'жилой дом'], ['Таверна «Рыжий рог»', 'таверна'], ['Усадьба Вельских', 'усадьба']]) scene(`quality/window/${location}/${seed}`, { location, theme, seed: `window:${seed}` })
  const requirements = sceneRequirementsFromText(['В зале очаг, четыре стола, у стойки две бочки и сундук хозяина.'])
  scene(`quality/promised/${seed}`, { location: 'Таверна «Рыжий рог»', theme: 'таверна', seed: `Таверна «Рыжий рог»:${seed}`, requirements })
}
scene('quality/tower', { location: 'Круглая башня мага', theme: 'усадьба', seed: 'tower', map: { width: 30, height: 28 } })
for (const [location, theme] of [['Кузница Борга', 'кузница'], ['Казарма городской стражи', 'казарма']]) scene(`quality/place/${location}`, { location, theme, seed: `fidelity:${location}` })
for (const theme of SCENE_THEMES) pipeline(`themes/${theme.id}`, () => buildThemedScene({ location: theme.label, seed: `build-${theme.id}`, width: 28, height: 28 }))
pipeline('themes/swing-tavern', () => buildThemedScene({ location: 'Таверна «Пустой кубок»', seed: 'swing-tavern', width: 28, height: 28 }))
pipeline('themes/swing-palace', () => buildThemedScene({ themeId: 'authored-palace', location: 'Военная галерея', seed: 'swing-palace', width: 28, height: 28 }))
pipeline('themes/min-size', () => buildThemedScene({ themeId: 'building', location: 'Хижина', seed: 'min-size', width: 16, height: 14 }))
for (const theme of SCENE_THEMES) pipeline(`themes/same/${theme.id}`, () => buildThemedScene({ location: theme.label, seed: 'same' }))
const PLACES = [
  ['Таверна «Сломанное колесо»', 'таверна'], ['Постоялый двор у тракта', 'постоялый двор'], ['Заброшенный караван-сарай', ''], ['Подворье у переправы', ''],
  ['Ночлежка на окраине', ''], ['Особняк наместника', 'усадьба'], ['Терем воеводы', ''], ['Хижина лесника', 'жилой дом'], ['Мельница у реки', 'мельница'],
  ['Водяная мельница', 'мельница'], ['Лавка травника', 'лавка'], ['Кузница', 'кузница'], ['Казарма', 'казарма'], ['Дом алхимика', 'дом мага'],
  ['Башня волшебника', 'усадьба'], ['Дом у реки', 'жилой дом'], ['Трактир «Три гуся»', 'трактир'], ['Королевская крепость', 'крепость'],
  ['Военная галерея', 'дворец'], ['Усадьба на болоте', 'усадьба'], ['Северный хутор', 'хутор'], ['Пустынный дом', 'жилой дом'],
]
const DESCRIPTIONS = ['', 'Отряд входит в зал, у стойки хозяин.', 'Герои стоят снаружи, у входа.', 'За столом сидит купец, у очага кот.', 'Во дворе колодец и телега.']
for (const [location, theme] of PLACES) {
  for (let index = 0; index < 5; index += 1) {
    const input = { location, theme, seed: `${location}:${index}`, description: DESCRIPTIONS[index] }
    if (index === 1) input.levels = [{ offset: 1, label: 'Второй этаж' }]
    if (index === 2) input.entrySide = pick(['east', 'north', 'south', 'west'])
    if (index === 3) input.map = { width: pick([22, 30, 36, 44, 52]), height: pick([20, 28, 32, 40, 48]), design: { shape: pick(['L', 'cross', 'round', 'rect']), scheme: pick(['wing', 'long-hall', 'courtyard', 'corridor']) } }
    if (index === 4) input.map = { design: { topology: pick(['courtyard', 'river']), climate: pick(['arid', 'cold', 'wetland', 'temperate']), architecture: pick(['stone', 'wood', 'marble', 'ice', 'metal', 'sand']) } }
    scene(`place/${location}/${index}`, input)
  }
}
// Двухэтажный трактир поселения: лестницу ставит `ensureDeclaredTransitions` на карте поселения.
for (let index = 0; index < 10; index += 1) {
  scene(`storeyed/${index}`, { location: pick(['Деревня Кленовка', 'Город Вельдбург', 'Ольшанка', 'Торговый город']), theme: pick(['деревня', 'город', 'рынок']), settlementType: pick(['village', 'town', 'city']), seed: `storeyed:${index}`, ...(index % 2 ? { levels: [{ offset: pick([1, -1]), label: pick(['Чердак', 'Погреб', '']) }] } : {}) })
}
// Вход по дороге в трактир (`createSceneTransition`).
const WORLD = {
  seed: 'entry-road',
  currentLocationId: 'brod',
  locations: [
    { id: 'brod', name: 'Старый Брод', kind: 'village', x: 500, y: 120, known: true, visited: true },
    { id: 'inn', name: 'Трактир «Три гуся»', kind: 'inn', x: 500, y: 420, known: true },
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
  for (const arrival of ['Дорога выводит отряд к трактиру.', 'Отряд входит в зал трактира.']) {
    pipeline(`transition/${from}/${arrival.slice(0, 12)}`, () => createSceneTransition({
      title: 'Трактир «Три гуся»', location: 'Трактир «Три гуся»', location_id: 'inn', theme: 'таверна', objective: 'Найти хозяина',
      arrival, objective_status: 'completed',
    }, stateAt(from, fromName)))
  }
}

// --- случайные входы ----------------------------------------------------------------------

const USES = ['dwelling', 'tavern', 'shop', 'manor', 'smithy', 'barracks', 'mill', 'barn', '']
const DESIGN_KEYS = {
  building_use: USES,
  climate: ['temperate', 'arid', 'cold', 'wetland', 'tropic'],
  architecture: ['wood', 'stone', 'sand', 'metal', 'marble', 'ice', 'brick'],
  density: ['sparse', 'mixed', 'dense', 'packed'],
  shape: ['rect', 'L', 'cross', 'round', 'oval', ''],
  scheme: ['wing', 'long-hall', 'courtyard', 'corridor', 'spiral'],
  topology: ['courtyard', 'river', 'organic', ''],
  arcane: [true, false, 'yes'],
}
const SIZES = [16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 52, 56, 60, 64, 14, 10, 30.5, 25.4, 17.5, -5, '30', null, [40]]
const THEMES = ['tavern', 'market-shop', 'manor', 'house', 'дом', 'усадьба', 'магазин', 'building', 'рынок', 'palace', '', null, 5]
function randomDesign() {
  if (chance(0.06)) return pick([null, 'manor', [], 7])
  const design = {}
  for (const [key, values] of Object.entries(DESIGN_KEYS)) if (chance(key === 'building_use' ? 0.85 : key === 'shape' || key === 'scheme' ? 0.3 : 0.35)) design[key] = pick(values)
  return design
}
function randomLevels() {
  if (chance(0.05)) return pick([null, 'x', {}, ''])
  return Array.from({ length: 1 + int(3) }, () => ({ offset: pick([1, -1, 2, -2, 3, -3, 0, 4, '1', null, 1.5, -1]), ...(chance(0.8) ? { label: pick(['Спальни', 'Погреб', '', 5, null, '  Чердак  ']) } : {}) }))
}
function randomOptions(index, { nanSize = false } = {}) {
  const options = { seed: pick([`r${index}`, `дом ${index}`, `${index}`, `  r${index}  `]) }
  if (chance(0.03)) options.seed = pick(['', null, index])
  if (chance(0.85)) options.width = nanSize && chance(0.1) ? 'abc' : pick(SIZES)
  if (chance(0.85)) options.height = pick(SIZES)
  if (chance(0.5)) options.theme = pick(THEMES)
  if (chance(0.88)) options.design = randomDesign()
  if (chance(0.3)) options.entry = pick(['interior', 'exterior', 'inside'])
  if (chance(0.12)) options.withProps = pick([false, true, 0, 1, ''])
  if (chance(0.25)) options.levels = randomLevels()
  if (chance(0.4)) options.locationId = pick(['loc', 'таверна-1', '  с пробелами  ', 5, ''])
  return options
}
for (let index = 0; index < 900; index += 1) addCase(`random/build/${index}`, 'build', randomOptions(index, { nanSize: true }))
for (let index = 0; index < 300; index += 1) addCase(`random/generate/${index}`, 'generate', randomOptions(1000 + index))
for (let index = 0; index < 40; index += 1) {
  const options = { seed: pick([`ares-${index}`, `${index}`, 'ares-fortress']) }
  if (chance(0.8)) options.width = pick([17, 30, 36, 40, 44, 48, 52, 60, 70, 40.4, 38.5, '44'])
  if (chance(0.8)) options.height = pick([11, 30, 36, 40, 44, 48, 52, 60, 70, 36.6, '40'])
  if (chance(0.3)) options.locationId = pick(['astohan-stormberg', 5, ''])
  if (chance(0.3)) options.theme = pick(['authored-palace', 'fortress', null])
  if (chance(0.2)) options.withProps = pick([false, 0])
  addCase(`random/ares/${index}`, pick(['ares', 'aresBuild']), options)
}
for (let index = 0; index < 12; index += 1) {
  addCase(`random/safe/${index}`, 'safeRoom', { seed: pick([`safe-${index}`, 'fallback', null, index]), ...(chance(0.5) ? { locationId: pick(['loc', 5]) } : {}), ...(chance(0.5) ? { theme: pick(['tavern', '', null]) } : {}) })
}

// --- операции над построенными картами ----------------------------------------------------

/** Программа операций над картой случая: рёбра, проёмы, окна, переходы. */
function randomOps(map) {
  const ops = []
  const count = 2 + int(8)
  for (let index = 0; index < count; index += 1) {
    const x = int(map.width + 2) - 1
    const y = int(map.height + 2) - 1
    const kind = pick(['door', 'window', 'edges', 'edges', 'transitions'])
    if (kind === 'door') ops.push({ op: 'openDoorway', x, y, id: pick(['probe-door', `door-${index}`, 'front-door', '']) })
    else if (kind === 'window') ops.push({ op: 'openWindow', x, y })
    else if (kind === 'edges') {
      const options = {}
      if (chance(0.4)) options.blocksMove = pick([false, true, 0, null])
      if (chance(0.4)) options.blocksSight = pick([false, true, 'no'])
      if (chance(0.4)) options.cover = pick(['none', 'half', 'three_quarters', null, 'bad'])
      ops.push({ op: 'edgesAround', x, y, kind: pick(['wall', 'window', 'rail', 'ledge', 'loophole', 'none', 'bad']), options })
    } else {
      ops.push({ op: 'ensureDeclaredTransitions', levels: chance(0.1) ? pick([null, 'x', []]) : Array.from({ length: 1 + int(3) }, () => ({ offset: pick([1, -1, 2, -2, 3, 0, 4, '2', null]), label: pick(['Чердак', '', 3, null]) })), zoneId: pick(['hall', 'kitchen', 'yard', 'store', 'nope']) })
    }
  }
  return ops
}
function runOps(map, ops) {
  const steps = []
  for (const op of ops) {
    try {
      if (op.op === 'openDoorway') bg.openDoorway(map, op.x, op.y, op.id)
      else if (op.op === 'openWindow') bg.openWindow(map, op.x, op.y)
      else if (op.op === 'edgesAround') bg.edgesAround(map, op.x, op.y, op.kind, op.options)
      else bg.ensureDeclaredTransitions(map, op.levels, op.zoneId)
      steps.push(mapHash(map))
    } catch (error) {
      steps.push({ error: errorOf(error) })
      break
    }
  }
  return steps
}
const opCases = []
for (const entry of cases.filter((item, index) => !item.error && index % 6 === 0)) {
  const map = FNS[entry.fn](entry.options).map
  const ops = randomOps(map)
  opCases.push({ label: entry.label, ops, steps: runOps(map, ops) })
}

// --- достижимость и пригодность на испорченных картах ---------------------------------------

/**
 * Карта случая, где часть клеток стала стеной (россыпь или сплошной столбец
 * поперёк карты), иногда без точки появления: зона, достижимая наполовину,
 * недостижимая целиком, пустая.
 */
const probeCases = []
for (const entry of cases.filter((item, index) => !item.error && index % 5 === 1)) {
  const map = FNS[entry.fn](entry.options).map
  const blocks = Array.from({ length: int(30) }, () => [int(map.width), int(map.height)])
  if (chance(0.5)) {
    const column = 1 + int(map.width - 2)
    for (let y = 0; y < map.height; y += 1) blocks.push([column, y])
  }
  const dropSpawn = chance(0.08)
  for (const [x, y] of blocks) t.setCell(map, x, y, { passable: false })
  if (dropSpawn) map.spawnPoints = []
  probeCases.push({
    label: entry.label, blocks, dropSpawn,
    reach: bg.reachabilityIssues(map), fitness: bg.tacticalFitnessWarnings(map),
    quarters: hash(bg.roomQuarters(map, 'hall')), furnished: hash([...bg.furnishedCells(map)]),
  })
}

// --- planRooms ---------------------------------------------------------------------------

const planCases = []
for (let index = 0; index < 120; index += 1) {
  const minX = int(20) - 2
  const minY = int(20) - 2
  const interior = { minX, minY, maxX: minX + int(30) - 3, maxY: minY + int(30) - 3 }
  planCases.push({ interior, plan: bg.planRooms(interior) })
}
planCases.push({ interior: { minX: 4, minY: 4, maxX: 20, maxY: 20 }, plan: bg.planRooms({ minX: 4, minY: 4, maxX: 20, maxY: 20 }) })

// --- сортировка V8 ----------------------------------------------------------------------

/**
 * Несогласованный сравнитель: знак — от хеша пары, значения могут быть
 * дробными. Так видно, повторяет ли перенос TimSort V8 шаг в шаг.
 */
function noisyCompare(salt) {
  return (left, right) => {
    const mixed = Math.imul((left * 7919 + right * 104729 + salt) | 0, 2654435761) >>> 0
    const kind = mixed % 5
    if (kind === 0) return 0
    if (kind === 1) return -((mixed >>> 8) % 1000) / 997
    if (kind === 2) return ((mixed >>> 8) % 1000) / 991
    return left - right + ((mixed >>> 4) % 3) - 1
  }
}
const sorts = []
for (let index = 0; index < 160; index += 1) {
  const length = index < 40 ? int(70) : index < 120 ? 60 + int(200) : 300 + int(1200)
  const items = Array.from({ length }, () => int(length * (chance(0.5) ? 1 : 0.2) + 1))
  const salt = int(1_000_000)
  const sorted = [...items].sort(noisyCompare(salt))
  sorts.push({ salt, items, sorted })
}

// --- запись ------------------------------------------------------------------------------

{
  for (const entry of cases) {
    if (entry.pipelineHash && entry.pipelineHash !== entry.mapHash) throw new Error(`${entry.label}: карта конвейера не повторилась`)
  }
  console.log(`  конвейер: ${cases.filter((entry) => entry.label.startsWith('pipeline:')).length} вызовов, отказов ${cases.filter((entry) => entry.error).length}, переходов ${transitions.length}`)
  writeFixture(new URL('./building-generator.json', import.meta.url), { cases, ops: opCases, probes: probeCases, planRooms: planCases, sorts })
  writeFixture(new URL('./pipeline-transitions.json.gz', import.meta.url), { transitions: transitions.slice(0, 80) }, { gzip: true })
}
