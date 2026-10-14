// Эталон `server/scene-requirements.mjs` для sk-scene-base.
// Запуск из корня репозитория: node rust/crates/sk-scene-base/fixtures/gen-scene-requirements.mjs
import { writeFileSync } from 'node:fs'

import {
  SCENE_REQUIREMENTS_VERSION,
  LANDMARK_ROLES,
  SCENE_REQUIREMENT_KINDS,
  SCENE_STRUCTURE_KINDS,
  anchorCountsFor,
  anchorCoverage,
  missingStructureFor,
  normalizeLandmarks,
  normalizeScenePosts,
  normalizeSceneRequirements,
  requiredProgramKinds,
  requirementAssets,
  requirementLabel,
  requirementMention,
  requirementTerrain,
  requirementsCoverage,
  sceneMapRequirementsFor,
  sceneRequirementsFromText,
  structurePresent,
  textAgainstMap,
} from '../../../../server/scene-requirements.mjs'
import { jsonOf, sentences, shuffled, rng } from './corpus.mjs'

const corpus = sentences()

// Словоформы объектов словаря и похожие слова, которые объектами не являются.
const WORDS = [
  'навес', 'навеса', 'навесами', 'навесу', 'навеселе', 'навесной',
  'настил', 'настила', 'настилы', 'настилов', 'помост', 'помостами', 'мостки', 'мостков', 'мостик', 'мост',
  'камни у порога', 'камень на пороге', 'камнем перед порогом', 'камня под порогами', 'порожные камни', 'пороге два старых камня', 'порог и камни', 'порогу камней',
  'ящик', 'ящика', 'ящики', 'ящиков', 'ящичек', 'ящиками',
  'сундук', 'сундуки', 'сундучок', 'ларец', 'ларцы', 'ларцов', 'шкатулка', 'шкатулками', 'ларь',
  'костёр', 'костер', 'костры', 'костров', 'кострище', 'костровище', 'костюм', 'кострома',
  'очаг', 'очагами', 'камин', 'камины', 'каминный', 'каминов',
  'колодец', 'колодца', 'колодцы', 'колодцев', 'колода', 'колодезный',
  'статуя', 'статуи', 'статуй', 'статуэтка', 'изваяние', 'изваяния', 'идол', 'идолы', 'идолище',
  'алтарь', 'алтаря', 'алтарём', 'алтари', 'жертвенник', 'жертвенника',
  'часовня', 'часовни', 'часовенка', 'божница',
  'телега', 'телеги', 'телегой', 'повозка', 'повозки', 'фургон', 'фургоны', 'фургончик',
  'прилавок', 'прилавки', 'прилавков', 'торговая палатка', 'торговые лотки', 'торговых лотков',
  'стог', 'стога', 'стогов', 'скирда', 'скирды',
  'поилка', 'поилки', 'корыто', 'корыта', 'корытом', 'корытце',
  'забор', 'заборы', 'заборщик', 'изгородь', 'изгороди', 'плетень', 'плетня', 'частокол', 'частоколом',
  'бочка', 'бочки', 'бочек', 'бочонок', 'бочонки', 'бочка-два',
  'указатель', 'указатели', 'указателей', 'указка',
  'верстовой столб', 'верстовые камни', 'верстового камня',
  'фонарь', 'фонари', 'фонарей', 'фонарём', 'фонарик',
  'могила', 'могилы', 'могил', 'могилой', 'надгробие', 'надгробия', 'могильщик',
  'стол', 'столы', 'столов', 'столица', 'столб', 'столом', 'подстолье', 'стола',
  'скамья', 'скамьи', 'скамей', 'скамьёй', 'скамейка',
  'жаровня', 'жаровни', 'жаровен',
  'котёл', 'котел', 'котлы', 'котлов', 'котлован', 'кот',
  'дуб', 'дубы', 'дубов', 'дубина', 'дубрава',
  'доска объявлений', 'доски указов', 'доской приказов', 'доска вестей', 'доска',
  'кузница', 'кузницы', 'кузнечный горн', 'кузнечная', 'наковальня', 'наковальни', 'кузнец',
  'причал', 'причала', 'причалу', 'пирс', 'пирсы', 'пристань', 'пристани', 'кнехт', 'швартовая тумба', 'причалил',
  'лодка', 'лодки', 'баркас', 'шлюпка', 'ялик', 'челн', 'челнок', 'плоскодонка',
  'маяк', 'башня', 'таверна', 'храм', 'дверь', 'река',
  'NAVES', 'Навес', 'КОЛОДЕЦ', 'КоСтЁр',
]

const PREFIXES = [
  '', 'Три ', 'две старые ', 'пять дощатых ', 'пару ', '20 ', '7 ', '0 ', '07 ', 'Один ', 'шесть ', 'восемь ',
  'без ', 'нет ', 'нет ни одного ', 'лишённый ', 'без старого ', 'ни ', 'даже без ',
  'в двух шагах от ', 'их было три. ', 'три, ', 'три — ', 'constructor ', 'tostring ', '__proto__ ',
  'у ', 'под ', 'за ', 'и ', '😀 ', 'три 😀 ', 'старых трёх ', 'трёх больших старых ', 'оба ', 'четырёх ',
  'двенадцать ', '3-й ', 'а-', 'ещё ', ' три ', '«', 'тридцать ',
]

// Сетка «приставка × словоформа»: ответ — пары [вид, количество].
const pairs = (items) => jsonOf(items.map((item) => [item.id, item.count]))
const fromTextGrid = { words: WORDS, prefixes: PREFIXES, outputs: WORDS.map((word) => PREFIXES.map((prefix) => pairs(sceneRequirementsFromText(`${prefix}${word}`)))) }
const fromText = []
for (const sentence of corpus) fromText.push({ input: sentence, output: jsonOf(sceneRequirementsFromText(sentence)) })
// Несколько описаний сразу, мусор в массиве, предел в 8000 единиц и 12 видов.
const next = rng(31)
const pool = shuffled(corpus, 7)
for (let index = 0; index < 120; index += 1) {
  const texts = Array.from({ length: 1 + Math.floor(next() * 5) }, () => pool[Math.floor(next() * pool.length)])
  if (index % 7 === 0) texts.push(null, 42, '   ', { text: 'колодец' })
  fromText.push({ input: texts, output: jsonOf(sceneRequirementsFromText(texts)) })
}
const everything = WORDS.join(', ')
fromText.push({ input: everything, output: jsonOf(sceneRequirementsFromText(everything)) })
const long = `${'а'.repeat(7990)} колодец навес`
fromText.push({ input: long, output: jsonOf(sceneRequirementsFromText(long)) })
const longEmoji = `${'😀'.repeat(3999)}а колодец`
fromText.push({ input: longEmoji, output: jsonOf(sceneRequirementsFromText(longEmoji)) })
const emojiBefore = `${'😀'.repeat(40)} три навеса`
fromText.push({ input: emojiBefore, output: jsonOf(sceneRequirementsFromText(emojiBefore)) })
for (const input of [null, 42, '', '   ', [], ['', null], { a: 1 }, 'ｃｏｎｓｔｒｕｃｔｏｒ навес', 'Ⅲ навеса', 'ТРИ\tНАСТИЛА\n\nи КОЛОДЕЦ']) {
  fromText.push({ input, output: jsonOf(sceneRequirementsFromText(input)) })
}

const NPCS = [
  { name: 'Илва', role: 'староста скита', summary: 'Держит раскрытую копию соглашения о проходе.' },
  { name: 'Терен', role: 'хранитель записей', summary: 'Стоит у запертого ящика для документов.' },
  { name: 'Вейра', role: 'мастер настилов', summary: 'Пахнет смолой и мокрым деревом.' },
  { name: 'Гость', role: 'странник', summary: 'Молча слушает.' },
  { name: 'Тор', role: 'кузнец', summary: '' },
  { name: '  Мира   Светлая ', role: 'жрица', summary: null },
  { name: 'Орм', role: 'торговец', summary: 'Раскладывает товар.' },
  { name: 'Бран', role: 'глава деревни', summary: 'Ждёт у колодца.' },
  { name: 'Ада', role: 'летописец', summary: { text: 'x' } },
  { name: '', role: 'кузнец', summary: '' },
  { name: null, role: 'староста' },
  { name: 'Ульф', role: 'вождь', summary: 'Сидит без навеса.' },
  { name: 'Сив', role: 'лавочница', summary: 'У прилавка с рыбой.' },
  { name: 'Кай', role: 'послушник', summary: 'Молится у алтаря.' },
  { name: 'Дорн', role: 'архивариус', summary: 'Перебирает свитки.' },
  { name: 'ИЛВА', role: 'староста', summary: '' },
  'Просто строка',
  null,
  { name: 'Х'.repeat(130), role: 'кузнец' },
  { name: 'Лейф', role: 'старейшина', summary: 'Стоит у костра.' },
]

const LANDMARKS = [
  [{ kind: 'mooring', role: 'focus' }, { kind: 'rowboat', role: 'dressing' }],
  [{ kind: 'rowboat', role: 'clue' }],
  [{ kind: 'well', role: 'npc_post', npc: 'илва' }, { kind: 'crate', role: 'npc_post', npc: 'Терен', count: 3 }],
  [{ id: 'altar', role: 'focus', count: '2' }, { kind: 'ufo', role: 'focus' }, { kind: 'altar', role: 'clue' }],
  [{ kind: 'statue', role: 'boss', count: 9 }, { kind: 'chest', count: 2.5 }, { kind: 'grave', count: -1 }, { kind: 'lantern', count: 0 }],
  [{ kind: 'table', role: 'clue' }, { kind: 'bench', role: 'clue' }, { kind: 'cart', role: 'entry' }, { kind: 'fence', role: 'dressing' }, { kind: 'forge', role: 'npc_post', npc: 'Тор' }, { kind: 'well', role: 'clue' }, { kind: 'oak', role: 'clue' }],
  [null, 'well', 42, { kind: null, id: 'well' }, { kind: '', id: 'well' }],
  'не массив',
  null,
  [{ kind: 'shelter', role: 'npc_post', npc: 'Чужак' }, { kind: 'platform', role: 'npc_post', npc: 'Вейра', count: 4 }],
  [{ kind: 'hearth', role: 'npc_post', npc: '   ' }, { kind: 'well', role: 'focus', npc: 'Илва' }],
]

const mapRequirements = []
// Жители и якоря хранятся в эталоне один раз; случай ссылается на них номерами.
const sceneTexts = [
  'В центре скита — общий навес, к воде спускаются три настила.',
  'Площадь с колодцем.',
  'У колодца стоит телега',
  'Пустая дорога в поле.',
  ['Пустая дорога в поле.', null, 42],
  'Утро у пристани.',
  'Деревня Кленовка встречает вас тишиной. Под общим навесом у колодца стоит ящик с документами.',
  ['Таверна «Кабанья голова»', 'Шумный вечер', 'Найти старосту', 'У стойки два стола и три скамьи, в углу камин.'],
  '',
  'Двенадцать фонарей, пять бочек, семь ящиков, сундук, костёр, очаг, колодец, статуя, алтарь, часовня, телега, прилавок, стог, поилка.',
]
const npcIndices = NPCS.map((_, index) => index)
for (const [index, texts] of sceneTexts.entries()) {
  for (const npcCount of [-1, 2, 6, 10]) {
    const npcs = npcCount < 0 ? null : shuffled(npcIndices, index * 13 + npcCount).slice(0, npcCount)
    for (const landmarks of [-1, ...LANDMARKS.keys()]) {
      const options = {}
      if (npcs) options.npcs = npcs.map((npc) => NPCS[npc])
      if (landmarks >= 0) options.landmarks = LANDMARKS[landmarks]
      mapRequirements.push({ texts, npcs, landmarks, output: jsonOf(sceneMapRequirementsFor(texts, options)) })
    }
  }
}
for (const sentence of shuffled(corpus, 3).slice(0, 150)) {
  const npcs = shuffled(npcIndices, sentence.length).slice(0, 5)
  const landmarks = sentence.length % LANDMARKS.length
  const options = { npcs: npcs.map((npc) => NPCS[npc]), landmarks: LANDMARKS[landmarks] }
  mapRequirements.push({ texts: sentence, npcs, landmarks, output: jsonOf(sceneMapRequirementsFor(sentence, options)) })
}
const mapRequirementsOdd = [
  { texts: 'Площадь с колодцем.', options: { npcs: 'не массив', landmarks: null } },
  { texts: 'Площадь с колодцем.', options: { npcs: null, landmarks: 'не массив' } },
].map((entry) => ({ ...entry, output: jsonOf(sceneMapRequirementsFor(entry.texts, entry.options)) }))

const landmarks = [...LANDMARKS, undefined, [], [{ kind: 'well' }, { kind: 'well', role: 'focus' }]].map((input) => ({ input: input ?? null, output: jsonOf(normalizeLandmarks(input)) }))

const PROGRAMS = [
  null, 42, 'x', [], [{ id: 'well' }],
  { focus: 'well' }, { focus: 'ufo' }, { focus: 7 },
  { focus: 'shelter', posts: [{ npc: 'Илва', id: 'shelter' }, { npc: 'Терен', id: 'crate' }, { npc: 'Терен', id: 'chest' }, { npc: '', id: 'well' }, { npc: 'Х', id: 'ufo' }], clues: ['rowboat', 'ufo', 'shelter', null, 5] },
  { version: 'scene-requirements/v1', items: [{ id: 'well', count: 1 }] },
  { posts: 'не массив', clues: 'не массив' },
  { posts: Array.from({ length: 15 }, (_, index) => ({ npc: `Житель ${index}`, id: 'well' })) },
  { posts: [{ npc: '  Двойной   пробел  ', id: 'altar' }, { npc: 'Двойной пробел', id: 'altar' }, null, 'строка', { npc: 'x'.repeat(150), id: 'oak' }] },
]
const required = PROGRAMS.map((input) => ({ input, output: jsonOf(requiredProgramKinds(input)) }))
const posts = PROGRAMS.map((input) => ({ input, output: jsonOf(normalizeScenePosts(input)) }))

const REQUIREMENT_INPUTS = [
  null, 42, 'x', [], { items: 'нет' },
  [{ id: 'well', count: 0 }, { id: 'well', count: 3 }, { id: 'ufo' }, 'x'],
  { items: [{ id: 'crate', count: '4' }, { id: 'altar', count: 2.5 }, { id: 'oak', count: 99 }, { id: 'table', count: -2 }, { id: 'bench', count: null }, { id: 'well', count: true }] },
  { items: SCENE_REQUIREMENT_KINDS.map((kind, index) => ({ id: kind.id, count: index })) },
  [{ id: 'grave', count: 1e300 }, { id: 'fence', count: 9007199254740993 }, { id: 'lantern', count: '0x3' }],
]
const normalizeRequirements = REQUIREMENT_INPUTS.map((input) => ({ input, output: jsonOf(normalizeSceneRequirements(input)) }))

const mentions = []
const MENTION_TEXTS = [
  'Герои подходят к старому колодцу.', 'Здесь нет колодца.', 'Без навеса площадь пуста.', 'У КОСТРА греются путники.',
  'Навеселе бредёт стражник.', 'Причал пуст, лодки нет.', 'Баркас Тома не вернулся.', 'Три настила уходят к воде.',
  '', null, 42, 'Над алтарём висит фонарь.', 'Стол, скамьи и сундук.',
]
const mentionIds = [...SCENE_REQUIREMENT_KINDS.map((entry) => entry.id), 'ufo', 'lighthouse']
for (const text of [...MENTION_TEXTS, ...shuffled(corpus, 11).slice(0, 60)]) {
  mentions.push({ text, outputs: mentionIds.map((id) => requirementMention(text, id)) })
}

const PROPS = [
  {}, null, { crate: 1, chest: 1 }, { crate: '2', crate_stack: 1, chest: 'x' }, { market_awning: 3, well: 1, tree_oak: 2.5 },
  { barrel: 1, barrel_stack: 1, keg: 1, campfire: 0, fireplace: -1, hearth_fire: 2 },
  Object.fromEntries(SCENE_REQUIREMENT_KINDS.flatMap((kind) => kind.assets).map((id, index) => [id, index % 4])),
  { mooring_post: 1, rowboat: 1, punt: 1, path_stone: 2, ledge_step: 1, notice_board: true, forge: 1e308, anvil: 1e308 },
]
const TERRAIN = [undefined, null, {}, { platform: 3 }, { platform: '2' }, { platform: 'x' }, { platform: -1 }]
const anchorCounts = []
for (const props of PROPS) {
  for (const terrain of TERRAIN) {
    anchorCounts.push({ props, terrain: terrain ?? null, terrainMissing: terrain === undefined, output: jsonOf(terrain === undefined ? anchorCountsFor(props) : anchorCountsFor(props, terrain)) })
  }
}

const REQUIREMENT_LISTS = [
  [{ id: 'shelter', count: 1 }, { id: 'crate', count: 2 }],
  [{ id: 'platform', count: 3 }, { id: 'well', count: 1 }, { id: 'barrels', count: 2 }],
  normalizeSceneRequirements({ items: SCENE_REQUIREMENT_KINDS.map((kind, index) => ({ id: kind.id, count: 1 + (index % 6) })) }),
  [{ id: 'ufo', count: 1 }],
  [],
]
const coverage = []
const anchorCoverageCases = []
for (const requirements of REQUIREMENT_LISTS) {
  for (const props of PROPS) {
    for (const terrain of TERRAIN) {
      const output = terrain === undefined ? requirementsCoverage(requirements, props) : requirementsCoverage(requirements, props, terrain)
      coverage.push({ requirements, props, terrain: terrain ?? null, terrainMissing: terrain === undefined, output: jsonOf(output) })
    }
    const anchors = anchorCountsFor(props, { platform: 2 })
    anchorCoverageCases.push({ requirements, anchors, output: jsonOf(anchorCoverage(requirements, anchors)) })
  }
  for (const anchors of [null, {}, { well: '1', platform: 3, shelter: 'x', crate: 2 }]) {
    anchorCoverageCases.push({ requirements, anchors, output: jsonOf(anchorCoverage(requirements, anchors)) })
  }
}
// NaN в количестве («constructor» перед объектом).
const nanRequirements = sceneRequirementsFromText('constructor навес и constructor ящик')
coverage.push({ requirements: jsonOf(nanRequirements), props: { market_awning: 9, crate: 9 }, terrain: null, terrainMissing: true, output: jsonOf(requirementsCoverage(nanRequirements, { market_awning: 9, crate: 9 })) })

const FACTS = {
  road: { theme: 'road', zones: [{ kind: 'exterior', label: 'Дорога' }, { kind: 'exterior', label: 'Река' }, { kind: 'exterior', label: 'Мост' }], doors: 0, props: [], water: true },
  tower: { theme: 'building', zones: [{ kind: 'exterior', label: 'Участок' }, { kind: 'interior', label: 'Парадный зал' }], doors: 3, props: [], water: false },
  lighthouse: { theme: 'building', zones: [{ kind: 'interior', label: 'Основание маяка' }], doors: '1', props: ['rowboat'] },
  tavern: { theme: 'building', zones: [{ kind: 'interior', label: 'Общий зал' }, { kind: 'interior', label: 'Кухня' }], doors: 2, props: ['barrel', 'ship_wheel'] },
  temple: { theme: 'temple', zones: [{ kind: 'interior', label: 'Неф' }], doors: 1, props: [] },
  chapel: { theme: 'settlement', zones: [{ kind: 'interior', label: 'Часовня' }, { kind: 'exterior', label: 'Ручей' }], doors: 1, props: [null, { id: 'boat' }, 7] },
  empty: {},
  junk: { zones: 'нет', props: 'нет', doors: 'много', water: 'да' },
  harbor: { theme: 'harbor', zones: [{ kind: 'exterior', label: 'Причал' }, { kind: 'exterior', label: 'Набережная' }], doors: 0, props: ['raft', 'mooring_post'], water: true },
  nulls: { theme: null, zones: [null, { kind: 'interior', label: null }, { kind: 'interior', label: '   ' }, { label: 42 }], doors: null, props: [{}, 'boathouse'] },
}
const LOCATIONS = ['', 'Старый маяк', 'Северная пристань', 'Таверна «Кабанья голова»', 'Башня мага', 'Храм Зари', 'Деревня Кленовка', 'Постоялый двор у реки', '«Старая башня»', 'Маячная улица', 'Трактир', 'Корчма у моста']
// Сетка «вид × факты карты × имя места».
const structureIds = [...SCENE_STRUCTURE_KINDS.map((entry) => entry.id), 'ufo']
const structurePresentGrid = {
  ids: structureIds,
  locations: LOCATIONS,
  outputs: structureIds.map((kind) => Object.fromEntries(Object.entries(FACTS).map(([factsId, facts]) => [factsId, LOCATIONS.map((location) => structurePresent(kind, facts, { location }))]))),
}

const ARRIVALS = [
  'Над обрывом высится башня маяка. Тяжёлая дверь приоткрыта. Через реку перекинут мост. Вдали белеет ещё один маяк.',
  'Путь приводит героев в «Старую башню». Моста здесь нет.',
  'Перед героями открывается Старый маяк.',
  'Отряд переходит мост и покидает таверну.',
  'Герои входят в таверну на берегу.',
  'Герои прибывают к храму! Двери нет, а лодки не видно… Река шумит.',
  'Вы оказываетесь у корчмы. Её дверь распахнута? Внутри — святилище.',
  'Дорога петляет между холмами. За рекой виднеется башня.',
  'Отряд заходит в часовню. На горизонте маяк.',
  'Перед отрядом трактир «Под мостом». Лодка у причала.',
  'Вы покидаете храм и выходите к реке.',
  'Без двери дом пуст. Нет башни, нет и маяка.',
  '   Герои   входят\n\nв   храм.   ',
  'Встречает вас харчевня, постоялый двор и собор.',
  '',
  null,
  42,
  'Вошли в Старый маяк, и маяк скрипит.',
  'Челн ждёт у берега, а речка бурлит.',
  'Открываете дверь маяка.',
]
const textAgainstMapCases = []
for (const value of [...ARRIVALS, ...shuffled(corpus, 5).slice(0, 40)]) {
  const outputs = []
  for (const [factsId, facts] of Object.entries(FACTS)) {
    for (const location of ['', 'Старый маяк', 'Таверна «Кабанья голова»']) {
      for (const journey of [false, true]) outputs.push([factsId, location, journey, jsonOf(textAgainstMap(value, facts, { location, journey }))])
    }
  }
  textAgainstMapCases.push({ value, outputs })
}

const missingStructure = []
for (const location of [...LOCATIONS, 'Маяк', 'маяки побережья', 'Башенный двор', 'Святилище', 'Собор', '«Старый маяк»', 'Дом у маяка']) {
  for (const [factsId, facts] of Object.entries(FACTS)) {
    missingStructure.push({ location, facts: factsId, output: missingStructureFor(location, facts) })
  }
}

const ids = [...SCENE_REQUIREMENT_KINDS.map((kind) => kind.id), ...SCENE_STRUCTURE_KINDS.map((kind) => kind.id), 'ufo', '']
const fixture = {
  version: SCENE_REQUIREMENTS_VERSION,
  landmarkRoles: LANDMARK_ROLES,
  kinds: SCENE_REQUIREMENT_KINDS.map((kind) => ({ id: kind.id, label: kind.label, source: kind.pattern.source, assets: kind.assets, terrain: kind.terrain ?? null, fromText: kind.fromText !== false })),
  structures: SCENE_STRUCTURE_KINDS.map((kind) => ({ id: kind.id, label: kind.label, source: kind.pattern.source, building: kind.building, journey: kind.journey })),
  lookups: ids.map((id) => ({ id, label: requirementLabel(id), assets: requirementAssets(id), terrain: requirementTerrain(id) })),
  facts: FACTS,
  fromTextGrid,
  fromText,
  npcs: NPCS,
  landmarkSets: LANDMARKS,
  mapRequirements,
  mapRequirementsOdd,
  mentionIds,
  landmarks,
  required,
  posts,
  normalizeRequirements,
  mentions,
  anchorCounts,
  anchorCoverage: anchorCoverageCases,
  coverage,
  structurePresent: structurePresentGrid,
  textAgainstMap: textAgainstMapCases,
  missingStructure,
}
writeFileSync(new URL('./scene-requirements.json', import.meta.url), `${JSON.stringify(fixture)}\n`)
const total = WORDS.length * PREFIXES.length + fromText.length + mapRequirements.length + mapRequirementsOdd.length + landmarks.length + required.length + posts.length + normalizeRequirements.length
  + mentions.length * mentionIds.length + anchorCounts.length + anchorCoverageCases.length + coverage.length + structureIds.length * Object.keys(FACTS).length * LOCATIONS.length + textAgainstMapCases.length * 60 + missingStructure.length
console.log(`scene-requirements: ${total} случаев`)
