// @ts-check
import { createHash } from 'node:crypto'

import { authoredLocationMapFor } from './authored-location-maps.mjs'
import { buildAresFortressScene, buildBuildingScene } from './building-generator.mjs'
import { buildSceneFromGraph } from './graph-layout.mjs'
import { buildSettlementScene } from './settlement-generator.mjs'
import { addSceneLink, addSceneZone, createSceneGraph } from './scene-graph.mjs'
import { ensurePropAccess, placeProps } from './prop-placement.mjs'
import {
  SIZE_CLASSES,
  addSpawnPoint,
  addZone,
  cellAt,
  createTacticalMap,
  edgeList,
  edgeNeighbor,
  floorVariantAt,
  setCell,
  setEdge,
} from './tactical-map.mjs'

/**
 * Каталог тем сцены — этап M6 (`docs/tactical-map-plan.md`, раздел 12).
 *
 * Тема = набор материалов, набор предметов и правила расстановки. Геометрия
 * берётся одним из трёх способов, и выбор способа — часть темы:
 *
 * - `building` — здание с участком, отдельный генератор планировки;
 * - `graph` — сначала граф зон с проверкой ключей, затем подходящая теме
 *   геометрия. Храм и склеп получают помещения, пещера — органическую полость;
 * - `open` — открытая местность без помещений: лес и дорога;
 * - `settlement` — поселение с семейством улиц, неодинаковыми зданиями и
 *   местными ориентирами: площадью, воротами, причалами или переправой.
 *
 * Опознание темы идёт по названию локации и по виду сцены. Это единственное
 * место, где такое опознание живёт: раньше оно было размазано регулярками по
 * `dynamic-map.mjs`.
 */

/**
 * `live` — отдаётся ли тема живой игре. Сейчас готовы все семь; флаг остаётся
 * явным предохранителем для будущих тем, которые ещё хуже структурированного
 * fallback.
 *
 * Обычные здания и поселения используют версионированные генераторы;
 * сохранённые карты не проходят через эту фабрику повторно.
 */
export const SCENE_THEMES = Object.freeze([
  {
    id: 'building',
    label: 'Здание с участком',
    kind: 'building',
    live: true,
    material: 'wood',
    // `\b` в JavaScript опирается на латиницу и с кириллицей не работает.
    // Караван-сарай, подворье и ночлежка — те же постоялые дворы: здание с
    // двором, ровно то, что строит генератор. «Караван» без дефисной части не
    // берём: торговый караван в пути — это не постройка.
    match: /таверн|трактир|постоял|корчм|харчевн|гостиниц|караван-сара|подворь|ночлежк|особняк|терем|(?<![а-яё])дом(?![а-яё])|(?<![а-яё])изб[аеуы](?![а-яё])|хижин|усадьб|поместь|лавк/iu,
  },
  {
    id: 'temple',
    label: 'Храм',
    kind: 'graph',
    live: true,
    material: 'marble',
    match: /храм|святилищ|капищ|алтар|собор|монастыр/iu,
    zones: ['Притвор', 'Неф', 'Алтарная', 'Ризница'],
    density: 14,
    require: ['altar', 'pillar', 'statue', 'brazier'],
    prefer: ['pillar', 'statue', 'brazier', 'prayer_bench', 'reliquary', 'mosaic', 'temple_banner'],
  },
  {
    id: 'crypt',
    label: 'Склеп',
    kind: 'graph',
    live: true,
    material: 'stone',
    match: /склеп|крипт|гробниц|усыпальниц|катакомб|мавзоле/iu,
    zones: ['Вход', 'Галерея', 'Погребальная', 'Тайник'],
    density: 16,
    require: ['sarcophagus', 'grave', 'urn', 'brazier'],
    prefer: ['grave', 'urn', 'crypt_niche', 'bone_pile', 'cobweb', 'statue'],
    locked: true,
  },
  {
    id: 'cave',
    label: 'Пещера',
    kind: 'graph',
    live: true,
    material: 'earth',
    match: /пещер|грот|каверн|штольн|шахт|подземель|нора/iu,
    zones: ['Устье', 'Штрек', 'Зал', 'Тупик'],
    density: 18,
    require: ['stalagmite', 'cave_pool', 'rubble_heap'],
    prefer: ['stalagmite', 'rubble_heap', 'mushroom_cluster', 'bone_pile', 'ore_vein', 'cobweb'],
  },
  {
    id: 'forest',
    label: 'Лес',
    kind: 'open',
    live: true,
    material: 'grass',
    match: /лес|чащ|рощ|бор|дубрав|пущ|тайг/iu,
    // Каменная кромка забирает край участка: плотность выше, чтобы чаща
    // осталась чащей (v3 открытой местности).
    density: 22,
    require: ['tree_oak', 'tree_spruce', 'tree_birch', 'fallen_log', 'campfire'],
    prefer: ['tree_oak', 'tree_spruce', 'tree_birch', 'tree_pine', 'tree_dead', 'tree_stump', 'bush', 'shrub', 'boulder', 'fern', 'campfire'],
  },
  {
    id: 'road',
    label: 'Дорога',
    kind: 'open',
    live: true,
    // Обочины — луг, а не голая земля: с материалом `earth` вся карта сливалась
    // в одну коричневую плоскость, и сама дорога на ней не читалась. Полосу
    // утоптанной земли рисует layoutOpenTerrain поверх травы.
    material: 'grass',
    match: /дорог|тракт|путь|перекрёст|перекрест|мост|брод|перевал/iu,
    density: 12,
    require: ['milestone', 'tree_birch', 'cart', 'roadside_shrine'],
    prefer: ['tree_birch', 'tree_dead', 'bush', 'boulder', 'fern', 'path_stone', 'milestone'],
    road: true,
  },
  {
    id: 'settlement',
    label: 'Поселение',
    kind: 'settlement',
    live: true,
    material: 'earth',
    match: /деревн|поселен|село|посад|хутор|город|слобод|рынок|площад/iu,
    density: 14,
    require: ['market_stall', 'well', 'cart', 'village_fence'],
    // Одноклеточный `campfire` сохраняется и в legacy-клетках под известным
    // движку feature. `hitching_post` намеренно не здесь: старый контракт
    // encounter-cell такого идентификатора не знает.
    prefer: ['market_stall', 'village_fence', 'cart', 'haystack', 'woodpile', 'tree_birch', 'campfire'],
    road: true,
  },
])

/**
 * Небольшие варианты карт стартовых authored-миров. Они не становятся общими
 * эвристическими темами: их можно выбрать только явным `scene.map.theme_id`.
 * Так «порт» и «оазис» не разъезжаются с обычным городом, а дворец не
 * превращается в храм из-за слова `capital` на глобальной карте.
 */
/** @type {ReadonlyArray<Record<string, any>>} */
const AUTHORED_SCENE_THEMES = Object.freeze([
  {
    id: 'authored-harbor', label: 'Каменная гавань', kind: 'settlement', live: true,
    assetTheme: 'settlement', surfaceMaterial: 'stone', streetMaterial: 'earth', houseMaterial: 'stone', waterBand: 'right',
    density: 14, require: ['market_stall', 'well', 'cart', 'village_fence'],
    prefer: ['market_stall', 'cart', 'lamp_post', 'woodpile', 'campfire'],
  },
  {
    id: 'authored-oasis', label: 'Оазисная площадь', kind: 'settlement', live: true,
    assetTheme: 'settlement', surfaceMaterial: 'sand', streetMaterial: 'earth', houseMaterial: 'sand', waterBand: 'top',
    density: 14, require: ['market_stall', 'well', 'cart', 'village_fence'],
    prefer: ['market_stall', 'well', 'water_trough', 'cart', 'campfire'],
  },
  {
    id: 'authored-caldera-port', label: 'Пепельная гавань', kind: 'settlement', live: true,
    assetTheme: 'settlement', surfaceMaterial: 'stone', streetMaterial: 'earth', houseMaterial: 'stone', waterBand: 'left',
    density: 14, require: ['market_stall', 'well', 'cart', 'village_fence'],
    prefer: ['market_stall', 'cart', 'campfire', 'woodpile', 'lamp_post'],
  },
  {
    id: 'authored-palace', label: 'Военная галерея', kind: 'fortress', live: true, material: 'stone', assetTheme: 'building',
    zones: ['Большой внутренний двор', 'Военная галерея', 'Казарма', 'Конюшня', 'Военный склад', 'Мастерская'],
  },
])

/** @type {ReadonlyArray<Record<string, any>>} */
const ALL_SCENE_THEMES = Object.freeze([...SCENE_THEMES, ...AUTHORED_SCENE_THEMES])

/** Старые и короткие имена authored-крепости сходятся в один генератор. */
/** @type {Readonly<Record<string, string>>} */
const SCENE_THEME_ALIASES = Object.freeze({
  'ares-fortress': 'authored-palace',
  'authored-ares-fortress': 'authored-palace',
})

/** Идентификаторы тем, которые можно закрепить в авторском шаблоне карты. */
export const SCENE_THEME_IDS = new Set([...ALL_SCENE_THEMES.map((theme) => theme.id), ...Object.keys(SCENE_THEME_ALIASES)])

/** Тема по умолчанию, когда ничто не опознано. */
export const FALLBACK_THEME = SCENE_THEMES[0]

/**
 * @param {string|number} seed
 * @returns {() => number}
 */
function randomFor(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/**
 * Опознаёт тему сцены. Дикая местность никогда не становится зданием, даже если
 * в названии есть «дом»: «Дом у дороги» в лесу — это всё-таки лес.
 *
 * @param {object} input
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.sceneKind]
 * @returns {typeof SCENE_THEMES[number]}
 */
export function themeFor(input = {}) {
  const matched = matchTheme(input)
  if (matched) return matched
  // Для прямого вызова без карты дикая местность всё равно безопасно
  // показывается лесом. Живой выбор генератора получает `null` от matchTheme и
  // успевает учесть layout/pattern до такого fallback.
  if (String(input.sceneKind) === 'wilderness') {
    return SCENE_THEMES.find((candidate) => candidate.id === 'forest') ?? FALLBACK_THEME
  }
  return FALLBACK_THEME
}

/**
 * То же опознание, но без подстановки темы по умолчанию: `null` означает «не
 * узнал». Вызывающий после этого выбирает структурированный fallback по виду
 * сцены и заявленной планировке.
 *
 * @param {object} input
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.sceneKind]
 * @returns {typeof SCENE_THEMES[number]|null}
 */
export function matchTheme({ location = '', theme = '', sceneKind = '' } = {}) {
  const haystack = `${location} ${theme}`
  const wilderness = String(sceneKind) === 'wilderness'
  for (const candidate of SCENE_THEMES) {
    if (wilderness && candidate.kind === 'building') continue
    if (candidate.match.test(haystack)) return candidate
  }
  return null
}

/**
 * Узор и планировка из заявки картографа — тоже его слова, а не догадка по
 * названию. Часть значений называет тему однозначно: `crypt` — это склеп, а не
 * «что-то каменное». Остальные (`keep`, `great-hall`, `courtyard`, `bridge`,
 * `radial`, `ruins`, `natural`) своей темы не имеют и достаются безопасному
 * тематическому fallback по планировке.
 *
 * Сознательно не сопоставляется `small-room`: комната бывает в любом здании, и
 * по одному этому слову нельзя ставить дом с двором, оградой и деревьями.
 *
 * @param {{layout?: string, pattern?: string, theme_id?: string, themeId?: string}} [request]
 * @returns {Record<string, any>|null}
 */
export function themeFromMapRequest({ pattern = '', layout = '' } = {}) {
  /** @type {Record<string, string>} */
  const byPattern = {
    crypt: 'crypt',
    'cave-cluster': 'cave',
    village: 'settlement',
    bridge: 'road',
  }
  /** @type {Record<string, string>} */
  const byLayout = { cavern: 'cave', streets: 'settlement', winding: 'road' }
  const id = byPattern[String(pattern).toLocaleLowerCase('en')]
    ?? byLayout[String(layout).toLocaleLowerCase('en')]
    ?? ''
  return id ? SCENE_THEMES.find((candidate) => candidate.id === id) ?? null : null
}

/**
 * Безопасная тема для неопознанной локации. Это последний выбор геометрии, а
 * не попытка угадать художественный смысл: он сохраняет заявленную топологию
 * и всегда отдаёт структурированную, связную карту.
 *
 * @param {object} [input]
 * @param {string} [input.sceneKind]
 * @param {{layout?: string, pattern?: string, material?: string, theme_id?: string, themeId?: string}} [input.request]
 * @returns {Record<string, any>}
 */
export function fallbackThemeFor({ sceneKind = '', request = {} } = {}) {
  const requested = themeFromMapRequest(request)
  if (requested) return requested

  const kind = String(sceneKind).toLocaleLowerCase('en')
  const layout = String(request?.layout ?? '').toLocaleLowerCase('en')
  const pattern = String(request?.pattern ?? '').toLocaleLowerCase('en')
  const material = String(request?.material ?? '').toLocaleLowerCase('en')
  let id = ''
  if (kind === 'settlement') id = 'settlement'
  else if (kind === 'road') id = 'road'
  else if (kind === 'wilderness') id = layout === 'winding' || pattern === 'bridge' ? 'road' : 'forest'
  else if (kind === 'dungeon') id = layout === 'cavern' ? 'cave' : 'crypt'
  else if (layout === 'open' || pattern === 'natural') id = 'forest'
  else if (layout === 'rooms' || layout === 'ruins' || layout === 'radial'
    || ['small-room', 'great-hall', 'keep', 'courtyard'].includes(pattern)) {
    const masonry = ['stone', 'marble', 'earth'].includes(material)
      || ['keep', 'great-hall'].includes(pattern)
      || ['ruins', 'radial'].includes(layout)
    id = masonry ? 'crypt' : 'building'
  }
  else id = 'road'
  return SCENE_THEMES.find((candidate) => candidate.id === id) ?? FALLBACK_THEME
}

/**
 * Готова ли тема к живой игре. Отдельная функция, а не чтение поля на месте:
 * вызывающему не нужно знать, чем именно выражена готовность.
 *
 * @param {typeof SCENE_THEMES[number]|null} theme
 * @returns {boolean}
 */
export function isLiveTheme(theme) {
  return Boolean(theme?.live)
}

/** Темы, которые называют постройку или подземелье, а не открытую местность. */
const STRUCTURE_THEMES = new Set(['building', 'temple', 'crypt', 'cave'])

/** Виды точек карты мира, которые означают поселение. */
const SETTLEMENT_WORLD_KINDS = new Set(['capital', 'city', 'town', 'village', 'port'])

/**
 * Тема по виду точки карты мира, когда название сцены о местности молчит.
 * @type {Record<string, string>}
 */
const WORLD_KIND_THEMES = {
  wilds: 'forest',
  dungeon: 'cave',
  ruin: 'crypt',
  fortress: 'building',
}

/**
 * @param {string} id
 * @returns {Record<string, any>}
 */
function themeById(id) {
  const canonicalId = SCENE_THEME_ALIASES[id] ?? id
  return ALL_SCENE_THEMES.find((candidate) => candidate.id === canonicalId) ?? FALLBACK_THEME
}

/**
 * Выбор темы для живой сцены — по всем признакам, а не только по словам в
 * названии.
 *
 * Одного названия мало: деревня «Тихий Брод» опознавалась как дорога по слову
 * «брод», и поселение с колодцем, кузницей и архивом рисовалось полем с полосой
 * утоптанной земли — ровно таким же, как дорога, в которую отряд потом уходил.
 * Игрок нажимал «покинуть локацию» и видел ту же пустую карту, что и до того.
 *
 * Порядок признаков:
 *
 * 1. Название, в котором есть постройка или подземелье (таверна, храм, склеп,
 *    пещера), — самый точный признак: таверна в городе остаётся зданием.
 * 2. Признак поселения — вид сцены `settlement`, тип поселения, вид точки карты
 *    мира (столица, город, городок, деревня, порт), заявка картографа
 *    (`streets`/`village`). Он перекрывает «дорогу» и молчащее название, но не
 *    лес и не рощу: «Роща у Эствуда» — это роща, а не улица. Явный вид сцены
 *    «дикая местность», «дорога» или «подземелье» снимает признак поселения,
 *    взятый с карты мира: карта знает о месте, а сцена — о том, где отряд стоит.
 * 3. Название открытой местности (лес, дорога, поселение) — как и раньше.
 * 4. Вид точки карты мира: пустошь — лес, подземелье — пещера, руины и
 *    крепость — каменные палаты.
 * 5. Заявка картографа, затем безопасный fallback по топологии.
 *
 * @param {object} [input]
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.sceneKind]
 * @param {string} [input.settlementType]
 * @param {string} [input.worldKind]
 * @param {{layout?: string, pattern?: string, material?: string, theme_id?: string, themeId?: string}} [input.request]
 * @returns {Record<string, any>}
 */
export function resolveSceneTheme({ location = '', theme = '', sceneKind = '', settlementType = '', worldKind = '', request = {} } = {}) {
  const kind = String(sceneKind ?? '').toLocaleLowerCase('en')
  const explicitThemeId = String(request?.theme_id ?? request?.themeId ?? '').trim()
  const explicitCanonicalId = SCENE_THEME_ALIASES[explicitThemeId] ?? explicitThemeId
  const explicitTheme = explicitThemeId
    ? ALL_SCENE_THEMES.find((candidate) => candidate.id === explicitCanonicalId) ?? null
    : null
  // Авторский шаблон может знать больше, чем эвристика по названию и виду
  // точки мира: «военная галерея» находится в столице, но это всё ещё зал,
  // а не улица. Явная тема сильнее worldKind и сохраняет тот же генератор,
  // который используется для обычных переходов.
  if (explicitTheme) return explicitTheme
  const byName = matchTheme({ location, theme, sceneKind: kind })
  if (byName && STRUCTURE_THEMES.has(byName.id)) return byName
  const explicitlyNotSettlement = kind === 'wilderness' || kind === 'road' || kind === 'dungeon'
  const requestedLayout = String(request?.layout ?? '').toLocaleLowerCase('en')
  const requestedPattern = String(request?.pattern ?? '').toLocaleLowerCase('en')
  const sceneText = `${location} ${theme}`.toLocaleLowerCase('ru')
  const outdoorStructure = /(?:^|[\s«])двор(?:\s|$|ом(?:\s|$)|е(?:\s|$)|у(?:\s|$)|а(?:\s|$))|площад|улиц|пристан|гаван|порт|набережн|рынок|сад|переул|внешн|за ворот|перед ворот/iu.test(sceneText)
  const interiorStructure = /галере|дворец|замок|крепост|цитадел|трон|кабинет|поко[ия]|военн(?:ая|ый).*(?:зал|галере)|архив|библиотек|зал/iu.test(sceneText)
  const interiorLayout = requestedLayout === 'rooms'
    || ['small-room', 'great-hall', 'keep', 'crypt', 'temple'].includes(requestedPattern)
  if (outdoorStructure && (worldKind === 'fortress' || /крепост|замок|цитадел/iu.test(sceneText))) return themeById('settlement')
  // Название внутренней части места сильнее вида узла карты мира. Слова
  // «двор», «пристань» и «улица» явно оставляют сцену снаружи: «двор замка»
  // не должен внезапно стать комнатой только из-за слова «замок».
  if (!explicitlyNotSettlement && kind !== 'settlement' && !outdoorStructure && (interiorStructure || interiorLayout)) {
    if (/крепост|замок|цитадел/iu.test(sceneText)) return themeById('building')
    if (/храм|святилищ|алтар|собор|монастыр/iu.test(sceneText) || requestedPattern === 'temple') return themeById('temple')
    return themeById('building')
  }
  const settlementSignal = kind === 'settlement'
    || Boolean(String(settlementType ?? '').trim())
    || requestedLayout === 'streets'
    || requestedPattern === 'village'
    || (!explicitlyNotSettlement && SETTLEMENT_WORLD_KINDS.has(String(worldKind ?? '').toLocaleLowerCase('en')))
  if (settlementSignal && (!byName || byName.id === 'road')) return themeById('settlement')
  if (byName) return byName
  const byWorld = WORLD_KIND_THEMES[String(worldKind ?? '').toLocaleLowerCase('en')] ?? ''
  // Вид сцены, объявленный явно, спорит с картой мира — и выигрывает: подземелье
  // посреди пустоши остаётся подземельем. Карта мира дорисовывает только то,
  // чему сцена не противоречит.
  const worldThemeFits = !kind || kind === 'other' || kind === 'settlement'
    || (kind === 'wilderness' && byWorld === 'forest')
    || (kind === 'dungeon' && (byWorld === 'cave' || byWorld === 'crypt'))
  if (byWorld && worldThemeFits) return themeById(byWorld)
  return themeFromMapRequest(request ?? {}) ?? fallbackThemeFor({ sceneKind: kind, request: request ?? {} })
}

/**
 * Граф зон под тему: цепочка помещений, последнее — цель. У склепа последняя
 * дверь заперта, а ключ лежит в предыдущей зоне — проверку порядка ключей
 * делает стадия 1.
 *
 * @param {Record<string, any>} theme
 * @param {string} seed
 * @returns {import('./scene-graph.mjs').SceneGraph}
 */
export function sceneGraphForTheme(theme, seed) {
  const random = randomFor(`${theme.id}:${seed}`)
  const labels = theme.zones ?? ['Вход', 'Зал', 'Дальняя']
  const count = Math.max(3, Math.min(labels.length, 3 + Math.floor(random() * (labels.length - 2))))
  const graph = createSceneGraph({ entranceZoneId: 'zone-0', goalZoneId: `zone-${count - 1}` })
  for (let index = 0; index < count; index += 1) {
    addSceneZone(graph, {
      id: `zone-${index}`,
      kind: 'interior',
      required: index < count - 1,
      label: labels[index] ?? `Помещение ${index + 1}`,
      keys: theme.locked && index === count - 2 ? ['goal-key'] : [],
    })
  }
  for (let index = 1; index < count; index += 1) {
    const lockLast = theme.locked && index === count - 1
    addSceneLink(graph, {
      id: `link-${index}`,
      from: `zone-${index - 1}`,
      to: `zone-${index}`,
      kind: lockLast ? 'locked' : (random() < 0.5 ? 'door' : 'open'),
      keyId: lockLast ? 'goal-key' : null,
    })
  }
  return graph
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Заменяет часть глухих стен узкими проёмами — решёткой или бойницей.
 *
 * Меняется **только вид ребра**: `blocksMove` у стены, бойницы и решётки один
 * и тот же, поэтому проходимость сцены остаётся ровно прежней и связность,
 * проверенная сборкой, сломаться не может. Разница в другом — сквозь проём
 * видно (`blocksSight` снимается) и укрытие слабее сплошной кладки: три
 * четверти у бойницы, половина у решётки.
 *
 * Выбор идёт по отсортированному списку рёбер с постоянным шагом, поэтому тот
 * же seed даёт ту же карту — как и вся остальная сборка темы.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{kind: 'loophole' | 'grate', stride: number, limit: number}} options
 * @returns {number} сколько стен заменено
 */
function pierceWalls(map, { kind, stride, limit }) {
  const walls = edgeList(map).filter((edge) => edge.kind === 'wall')
  let pierced = 0
  for (let index = Math.floor(stride / 2); index < walls.length && pierced < limit; index += stride) {
    const wall = walls[index]
    const neighbor = edgeNeighbor(wall)
    setEdge(map, wall.x, wall.y, neighbor.x, neighbor.y, { kind })
    pierced += 1
  }
  return pierced
}

/**
 * Ставит стены на границе пола и непроходимой породы. Клеточная форма нужна
 * старому представлению сцены, рёбра — структурированной карте; оба вида
 * описывают одну и ту же границу.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 */
function outlineImpassableCells(map) {
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const own = cellAt(map, x, y)
      if (!own || own.passable) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (cellAt(map, x + dx, y + dy)?.passable) {
          setEdge(map, x, y, x + dx, y + dy, {
            kind: 'wall',
            blocksMove: true,
            blocksSight: true,
            cover: 'three_quarters',
          })
        }
      }
    }
  }
}

/**
 * Органическая геометрия пещеры. Граф зон остаётся стадией 1, но вместо
 * двоичного разбиения на прямоугольные комнаты его узлы становятся неровными
 * залами, соединёнными вырубленным извилистым ходом.
 *
 * Полость строится только добавлением пересекающихся дисков. Поэтому она
 * связна по построению, а не благодаря ремонту после случайной генерации.
 *
 * @param {Record<string, any>} theme
 * @param {{seed?: string, width?: number, height?: number, locationId?: string}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function layoutOrganicCave(theme, {
  seed = 'cave', width = 26, height = 26, locationId = '',
} = {}) {
  const safeWidth = Math.max(16, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(16, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`cave:${theme.id}:${seed}`)
  const graph = sceneGraphForTheme(theme, String(seed))
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { id: 'theme-cave-organic', version: '1' },
    theme: theme.id,
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })

  for (let index = 0; index < graph.zones.length; index += 1) {
    const zone = graph.zones[index]
    addZone(map, {
      id: zone.id,
      kind: 'interior',
      material: theme.material,
      lightLevel: index === 0 ? 'dim' : index === graph.zones.length - 1 ? 'dark' : 'dim',
      // У породы нет настила, и разворачивать её фактуру нечему.
      floorDirection: 'horizontal',
      label: zone.label,
    })
  }

  // Порода существует на всей сетке; игровая форма задаётся вырубленным полом.
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      setCell(map, x, y, {
        passable: false,
        material: theme.material,
        variant: floorVariantAt(seed, x, y),
        revealed: true,
      })
    }
  }

  /** @type {Set<string>} */
  const floor = new Set()
  /**
   * Неровность радиуса считается внутри фиксированного обхода, поэтому не
   * нарушает детерминизм. Ядро радиусом `radius - 0.45` остаётся сплошным.
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   */
  const carveDisc = (cx, cy, radius) => {
    const reach = Math.ceil(radius + 0.5)
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        const x = Math.round(cx + dx)
        const y = Math.round(cy + dy)
        const raggedRadius = radius + random() * 0.9 - 0.45
        if (x < 0 || y < 1 || x >= safeWidth || y >= safeHeight - 1) continue
        if (Math.hypot(dx, dy) <= raggedRadius) floor.add(`${x},${y}`)
      }
    }
  }

  const count = graph.zones.length
  const verticalRoom = Math.max(2, Math.min(5, Math.floor(safeHeight * 0.2)))
  /** @type {Array<{x: number, y: number}>} */
  const centers = []
  for (let index = 0; index < count; index += 1) {
    const progress = count <= 1 ? 0 : index / (count - 1)
    const x = Math.round(2 + progress * (safeWidth - 5))
    const wave = Math.sin(progress * Math.PI * 2 + random() * 0.8) * verticalRoom
    const y = clamp(Math.round(safeHeight / 2 + wave + (random() - 0.5) * 3), 3, safeHeight - 4)
    centers.push({ x, y })
    const chamberRadius = clamp(Math.min(safeWidth, safeHeight) * (0.115 + random() * 0.035), 2.5, 5)
    carveDisc(x, y, chamberRadius)
    // Боковая ниша ломает круглую симметрию зала, но пересекается с ним.
    const side = random() < 0.5 ? -1 : 1
    carveDisc(x + side * Math.max(1, Math.floor(chamberRadius * 0.65)), y + (random() < 0.5 ? -1 : 1), chamberRadius * 0.62)
  }

  // Последовательные узлы графа соединяются одной гарантированной полостью.
  for (let index = 1; index < centers.length; index += 1) {
    const target = centers[index]
    let x = centers[index - 1].x
    let y = centers[index - 1].y
    let guard = safeWidth * safeHeight
    while ((x !== target.x || y !== target.y) && guard > 0) {
      carveDisc(x, y, 1.45 + random() * 0.65)
      const dx = target.x - x
      const dy = target.y - y
      const horizontalChance = Math.abs(dx) / Math.max(1, Math.abs(dx) + Math.abs(dy))
      if (dx && (!dy || random() < horizontalChance)) x += Math.sign(dx)
      else if (dy) y += Math.sign(dy)
      guard -= 1
    }
    carveDisc(target.x, target.y, 1.8)
  }

  // Устье до края карты — настоящий вход, а не точка появления внутри скалы.
  const entranceY = centers[0]?.y ?? Math.floor(safeHeight / 2)
  for (let x = 0; x <= (centers[0]?.x ?? 2); x += 1) carveDisc(x, entranceY, 1.35)

  for (const key of floor) {
    const [x, y] = key.split(',').map(Number)
    let zoneIndex = 0
    let nearest = Number.POSITIVE_INFINITY
    for (let index = 0; index < centers.length; index += 1) {
      const distance = Math.abs(centers[index].x - x) + Math.abs(centers[index].y - y)
      if (distance < nearest) {
        nearest = distance
        zoneIndex = index
      }
    }
    setCell(map, x, y, {
      passable: true,
      material: theme.material,
      zone: graph.zones[zoneIndex]?.id ?? graph.zones[0].id,
      variant: floorVariantAt(seed, x, y),
      revealed: true,
    })
  }

  outlineImpassableCells(map)
  addSpawnPoint(map, { id: 'party-entrance', x: 1, y: entranceY, role: 'party' })
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: graph.zones.map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }
  return map
}

/**
 * Открытая местность: помещений нет, есть проходимая площадка с опушкой по
 * краю. У дороги и поселения через карту идёт полоса утоптанной земли.
 *
 * @param {Record<string, any>} theme
 * @param {{seed?: string, width?: number, height?: number, locationId?: string}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
/** Наибольший перепад между проходимыми соседями, в футах: шаг без лазания. */
export const OPEN_TERRAIN_MAX_STEP_FEET = 3

/**
 * Рельеф открытой местности: два-три холма с пологими склонами. Высоты — в
 * футах, как у правил: вершина 10–15 футов даёт возвышенность (от 5 футов),
 * а соседние проходимые клетки различаются не больше чем на
 * `OPEN_TERRAIN_MAX_STEP_FEET`, поэтому ни один шаг не требует лазания —
 * механики лазания и падения в правилах нет. Вход ровный, дорога сглажена,
 * вода лежит ниже берегов. Скалы кромки поднимаются над соседями: это только
 * вид, клетки непроходимы.
 *
 * @param {Record<string, any>} theme
 * @param {string|number} seed
 * @param {Map<string, {x: number, y: number, patch: Record<string, any>}>} terrainCells
 * @param {{width: number, height: number, entranceY: number, onRoadAt: (x: number, y: number) => boolean}} layout
 */
export function applyOpenTerrainRelief(theme, seed, terrainCells, { width, height, entranceY, onRoadAt }) {
  const random = randomFor(`open-relief:${theme.id}:${seed}`)
  const hills = []
  const count = 2 + Math.floor(random() * 2)
  for (let index = 0; index < count; index += 1) {
    hills.push({
      x: Math.floor(width * (0.25 + random() * 0.6)),
      y: Math.floor(height * (0.15 + random() * 0.7)),
      radius: 3.5 + random() * 3.5,
      peak: 10 + Math.floor(random() * 6),
    })
  }
  /** @type {Map<string, number>} */
  const level = new Map()
  for (const cell of terrainCells.values()) {
    let feet = 0
    for (const hill of hills) {
      const distance = Math.hypot(cell.x - hill.x, cell.y - hill.y) / hill.radius
      // Плато с округлым краем: вершина ровная, склон — косинус.
      if (distance < 1.6) feet = Math.max(feet, hill.peak * (distance < 0.55 ? 1 : 0.5 + 0.5 * Math.cos((distance - 0.55) / 1.05 * Math.PI)))
    }
    if (cell.patch.surface === 'water') feet = -2
    if (onRoadAt(cell.x, cell.y)) feet *= 0.45
    if (cell.x <= 5 && Math.abs(cell.y - entranceY) <= 2) feet = 0
    level.set(`${cell.x},${cell.y}`, Math.round(feet))
  }
  // Склоны без уступов: проходимые соседи сводятся к перепаду не больше шага.
  // Понижаются только высокие клетки, поэтому вход и вода остаются на месте.
  const passable = (cell) => cell.patch.passable !== false && cell.patch.surface !== 'water'
  for (let pass = 0; pass < 40; pass += 1) {
    let changed = false
    for (const cell of terrainCells.values()) {
      if (!passable(cell) && cell.patch.surface !== 'water') continue
      const own = level.get(`${cell.x},${cell.y}`) ?? 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighbor = terrainCells.get(`${cell.x + dx},${cell.y + dy}`)
        if (!neighbor || !passable(neighbor) && neighbor.patch.surface !== 'water') continue
        const other = level.get(`${neighbor.x},${neighbor.y}`) ?? 0
        if (own - other > OPEN_TERRAIN_MAX_STEP_FEET) {
          level.set(`${cell.x},${cell.y}`, other + OPEN_TERRAIN_MAX_STEP_FEET)
          changed = true
          break
        }
      }
    }
    if (!changed) break
  }
  // Скала кромки — выше самого высокого проходимого соседа: край читается
  // утёсом, а не бордюром.
  for (const cell of terrainCells.values()) {
    if (passable(cell) || cell.patch.surface === 'water') continue
    let top = level.get(`${cell.x},${cell.y}`) ?? 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) top = Math.max(top, level.get(`${cell.x + dx},${cell.y + dy}`) ?? 0)
    level.set(`${cell.x},${cell.y}`, top + 1 + Math.floor(random() * 2))
  }
  for (const cell of terrainCells.values()) {
    const feet = level.get(`${cell.x},${cell.y}`) ?? 0
    if (feet) cell.patch = { ...cell.patch, elevation: feet }
  }
}

/**
 * Версия генератора открытой местности. 3 — петляющая река с каменистыми
 * берегами, скалистая кромка участка, пруд в лесу и холмы (высоты в футах). Сохранённые карты не
 * перегенерируются: их версия остаётся прежней.
 */
export const OPEN_TERRAIN_GENERATOR_VERSION = '3'

export function layoutOpenTerrain(theme, { seed = 'open', width = 26, height = 26, locationId = '' } = {}) {
  const safeWidth = Math.max(12, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(12, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`open:${theme.id}:${seed}`)
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { id: `theme-${theme.id}`, version: OPEN_TERRAIN_GENERATOR_VERSION },
    theme: theme.id,
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })
  addZone(map, {
    id: 'field',
    kind: 'exterior',
    material: theme.material,
    lightLevel: 'bright',
    floorDirection: 'horizontal',
    label: theme.label,
  })

  const roadY = Math.floor(safeHeight / 2)
  const phase = random() * Math.PI * 2
  const bend = 1 + Math.floor(random() * Math.max(1, safeHeight * 0.09))
  const shift = Math.round((random() - 0.5) * safeHeight * 0.14)
  const forkX = Math.floor(safeWidth * (0.3 + random() * 0.4))
  const fork = theme.road && random() < 0.45
  /** @param {number} x */
  const trailY = (x) => clamp(roadY + shift + Math.round(Math.sin(x / Math.max(1, safeWidth - 1) * Math.PI * 2 + phase) * bend), 3, safeHeight - 4)
  /** @type {Map<string, {x: number, y: number, patch: Partial<import('./tactical-map.mjs').TacticalCell>}>} */
  const terrainCells = new Map()
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      // Дорога вьётся, а не идёт по линейке: прямая полоса читается как шов.
      const onRoad = theme.road && (Math.abs(y - trailY(x)) <= 1 || fork && Math.abs(x - forkX) <= 1 && y <= trailY(x))
      const left = 1 + Math.floor((1 + Math.sin(y * 0.29 + phase)) * 1.2)
      const right = safeWidth - 2 - Math.floor((1 + Math.cos(y * 0.23 + phase)) * 1.2)
      const top = 1 + Math.floor((1 + Math.cos(x * 0.25 + phase)) * 1.2)
      const bottom = safeHeight - 2 - Math.floor((1 + Math.sin(x * 0.31 + phase)) * 1.2)
      const present = onRoad || x >= left && x <= right && y >= top && y <= bottom
      if (!present) continue
      terrainCells.set(`${x},${y}`, { x, y, patch: {
        passable: true,
        material: onRoad ? 'earth' : theme.material,
        surface: onRoad ? 'none' : theme.surface ?? 'none',
        moveCost: !onRoad && theme.surface === 'mud' ? 2 : 1,
        zone: 'field',
        variant: floorVariantAt(seed, x, y),
        revealed: true,
      } })
    }
  }
  // У опушки неровный силуэт, но вход всегда связан с широкой центральной
  // областью. Это граница участка, а не каменная стена посреди леса.
  const entranceY = trailY(0)
  for (let x = theme.road ? 0 : 1; x <= Math.min(5, safeWidth - 2); x += 1) {
    for (let y = entranceY - 1; y <= entranceY + 1; y += 1) {
      terrainCells.set(`${x},${y}`, { x, y, patch: { passable: true, material: theme.road ? 'earth' : theme.material,
        surface: 'none', moveCost: 1, zone: 'field', revealed: true } })
    }
  }
  // Скалистая кромка по контуру участка: край карты читается грядой камня, а
  // не обрывом плиток в пустоту. Дорогу и вход кромка не перекрывает.
  /** @param {number} x @param {number} y */
  const onRoadAt = (x, y) => theme.road && (Math.abs(y - trailY(x)) <= 1 || fork && Math.abs(x - forkX) <= 1 && y <= trailY(x))
  /** @param {number} x @param {number} y */
  const nearEntrance = (x, y) => x <= 5 && Math.abs(y - entranceY) <= 2
  const rimNoise = randomFor(`open-rim:${theme.id}:${seed}`)
  /** @param {number} x @param {number} y */
  const isEdge = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !terrainCells.has(`${x + dx},${y + dy}`))
  const edgeCells = [...terrainCells.values()].filter((cell) => isEdge(cell.x, cell.y))
  /** @param {{x: number, y: number, patch: Record<string, any>}} cell */
  const toRock = (cell) => { cell.patch = { ...cell.patch, passable: false, surface: 'none', moveCost: 1 } }
  for (const cell of edgeCells) {
    if (onRoadAt(cell.x, cell.y) || nearEntrance(cell.x, cell.y)) continue
    toRock(cell)
  }
  // Второй, неровный слой кромки — гряда, а не ровный бордюр. В лесу он
  // редкий: опушку держат деревья, и чаща не должна редеть.
  for (const cell of terrainCells.values()) {
    if (!cell.patch.passable || onRoadAt(cell.x, cell.y) || nearEntrance(cell.x, cell.y)) continue
    const besideRim = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => edgeCells.some((edge) => edge.x === cell.x + dx && edge.y === cell.y + dy && !edge.patch.passable))
    if (besideRim && rimNoise() < (theme.id === 'forest' ? 0.08 : 0.32)) toRock(cell)
  }
  if (theme.river) {
    addZone(map, { id: 'water', kind: 'exterior', material: theme.material, lightLevel: 'bright', label: 'Река' })
    addZone(map, { id: 'crossing', kind: 'exterior', material: theme.bridgeMaterial, lightLevel: 'bright', label: 'Мост' })
    // Река петляет: русло смещается по синусоиде и местами разливается шире.
    const riverX = Math.floor(safeWidth * (0.45 + random() * 0.15))
    const meander = 1 + Math.floor(random() * 2)
    const riverPhase = random() * Math.PI * 2
    /** @param {number} y */
    const riverCenter = (y) => riverX + Math.round(Math.sin(y * 0.33 + riverPhase) * meander)
    /** @param {number} y */
    const riverHalf = (y) => Math.sin(y * 0.71 + riverPhase * 2) > 0.72 ? 2 : 1
    for (const cell of terrainCells.values()) {
      if (Math.abs(cell.x - riverCenter(cell.y)) > riverHalf(cell.y)) continue
      const bridge = Math.abs(cell.y - trailY(cell.x)) <= 1
      cell.patch = { ...cell.patch, passable: bridge, surface: bridge ? 'none' : 'water',
        material: bridge ? theme.bridgeMaterial : theme.material, zone: bridge ? 'crossing' : 'water', moveCost: 1 }
    }
    // Каменистые берега: часть клеток у воды — валуны, но не у моста.
    const bankNoise = randomFor(`open-bank:${theme.id}:${seed}`)
    for (const cell of terrainCells.values()) {
      if (!cell.patch.passable || cell.patch.zone === 'crossing' || onRoadAt(cell.x, cell.y) || nearEntrance(cell.x, cell.y)) continue
      const nearWater = [[1, 0], [-1, 0]].some(([dx]) => terrainCells.get(`${cell.x + dx},${cell.y}`)?.patch.surface === 'water')
      const nearBridge = [[0, 1], [0, -1], [0, 2], [0, -2]].some(([, dy]) => terrainCells.get(`${cell.x},${cell.y + dy}`)?.patch.zone === 'crossing')
      if (nearWater && !nearBridge && bankNoise() < 0.38) toRock(cell)
    }
  } else if (theme.id === 'forest' && random() < 0.55) {
    // Пруд на поляне в стороне от тропы и входа: неровное пятно воды.
    addZone(map, { id: 'water', kind: 'exterior', material: theme.material, lightLevel: 'bright', label: 'Пруд' })
    const pondX = Math.floor(safeWidth * (0.55 + random() * 0.25))
    const pondY = trailY(pondX) + (random() < 0.5 ? -1 : 1) * Math.floor(safeHeight * 0.25)
    const radius = 2 + random() * 1.4
    for (const cell of terrainCells.values()) {
      if (!cell.patch.passable || onRoadAt(cell.x, cell.y) || nearEntrance(cell.x, cell.y)) continue
      const angle = Math.atan2(cell.y - pondY, cell.x - pondX)
      const reach = radius * (1 + Math.sin(angle * 3 + pondX) * 0.22)
      if (Math.hypot(cell.x - pondX, cell.y - pondY) <= reach) {
        cell.patch = { ...cell.patch, passable: false, surface: 'water', zone: 'water', moveCost: 1 }
      }
    }
  }
  // Пересечение двух неровных контуров иногда оставляет отдельную угловую
  // клетку. В карту попадает только связный участок с входом, включая воду.
  const queue = [{ x: 1, y: entranceY }]
  const connected = new Set([`1,${entranceY}`])
  for (let index = 0; index < queue.length; index += 1) {
    const point = queue[index]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: point.x + dx, y: point.y + dy }
      const key = `${next.x},${next.y}`
      if (!terrainCells.has(key) || connected.has(key)) continue
      connected.add(key)
      queue.push(next)
    }
  }
  applyOpenTerrainRelief(theme, seed, terrainCells, { width: safeWidth, height: safeHeight, entranceY, onRoadAt })
  // Скалы и вода не должны отрезать часть поляны от входа: недостижимые
  // проходимые клетки становятся камнем, а не ловушкой для отряда.
  const walkable = new Set([`1,${entranceY}`])
  const walkQueue = [{ x: 1, y: entranceY }]
  for (let index = 0; index < walkQueue.length; index += 1) {
    const point = walkQueue[index]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${point.x + dx},${point.y + dy}`
      if (walkable.has(key) || !connected.has(key) || !terrainCells.get(key)?.patch.passable) continue
      walkable.add(key)
      walkQueue.push({ x: point.x + dx, y: point.y + dy })
    }
  }
  for (const point of queue) {
    const cell = terrainCells.get(`${point.x},${point.y}`)
    if (!cell) continue
    if (cell.patch.passable && !walkable.has(`${point.x},${point.y}`)) toRock(cell)
    setCell(map, cell.x, cell.y, cell.patch)
  }
  map.spawnPoints.push({ id: 'party-entrance', x: 1, y: entranceY, role: 'party' })
  map.overlays = { compass: true, scaleBar: true, roomLabels: [{ zoneId: 'field', label: theme.label }] }
  return map
}

/**
 * Узкий фасад для старых вызывающих мест. Формат карты остаётся единым, а
 * геометрия и идентификаторы принадлежат новому генератору поселений.
 *
 * @param {Record<string, any>} theme
 * @param {{seed?: string, width?: number, height?: number, locationId?: string, design?: Record<string, any>}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function layoutSettlement(theme, { seed = 'settlement', width = 26, height = 26, locationId = '', design = {} } = {}) {
  return buildSettlementScene({ seed, width, height, locationId, theme, design }).map
}

/**
 * Собирает сцену по теме. Единая точка входа: вызывающему не нужно знать, каким
 * способом строится геометрия.
 *
 * @param {object} options
 * @param {string} [options.location]
 * @param {string} [options.theme]
 * @param {string} [options.sceneKind]
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @param {string} [options.themeId] уже опознанная тема; сильнее названия
 * @param {Record<string, any>} [options.design] пространственный замысел выбранного места
 * @param {'interior'|'exterior'} [options.entry] сторона входа в сцену здания
 * @param {Array<{offset?: number, label?: string}>} [options.levels] объявленные этажи локации
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, theme: string, warnings: string[]}}
 */
export function buildThemedScene({
  location = '', theme = '', sceneKind = '', seed = 'scene', width = 26, height = 26, locationId = '', themeId = '', design = {},
  levels = [], entry = 'exterior',
} = {}) {
  // Тему могли опознать не по названию, а по узору из заявки картографа. Тогда
  // повторное опознание здесь её потеряет: `themeFor` читает только слова.
  const chosen = themeId ? themeById(themeId) : null
  const definition = /** @type {any} */ (chosen ?? themeFor({ location, theme, sceneKind }))

  // Известное authored-место сильнее эвристики темы и слов Архитектора. Карта
  // уже собрана офлайн и приходит новой копией на каждый стол, поэтому
  // повторный вход не меняет ни контур, ни двери, ни реквизит.
  const authored = authoredLocationMapFor(locationId)
  if (authored) return { map: authored, theme: authored.theme || definition.id, warnings: [] }

  if (definition.kind === 'fortress') {
    const built = buildAresFortressScene({ seed, width, height, locationId, theme: definition.id })
    return { map: built.map, theme: definition.id, warnings: built.warnings }
  }

  if (definition.kind === 'building') {
    // Объявленные этажи нужны только теме здания: лестницу на этаже входа
    // ставит один `building-generator`, остальные темы крючков не расставляют
    // вовсе, и привязывать им нечего.
    const built = buildBuildingScene({ seed, width, height, locationId, theme: definition.id, levels, design, entry })
    return { map: built.map, theme: definition.id, warnings: built.warnings }
  }

  if (definition.kind === 'graph') {
    if (definition.id === 'cave') {
      const map = layoutOrganicCave(definition, { seed, width, height, locationId })
      placeProps(map, {
        seed: `${seed}:props`,
        maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
        zones: map.zones.map((zone) => ({
          zoneId: zone.id,
          theme: definition.id,
          density: definition.density ?? 12,
          require: definition.require,
          prefer: definition.prefer,
        })),
      })
      return { map, theme: definition.id, warnings: [] }
    }
    const graph = sceneGraphForTheme(definition, seed)
    const built = buildSceneFromGraph(graph, {
      seed, width, height, locationId, theme: definition.id, material: definition.material,
    })
    // Каменная тема получает узкие проёмы в кладке: склеп перегорожен
    // решётками, храм смотрит наружу щелями под сводом. Это те же стены —
    // пройти сквозь них нельзя, но видно и укрытие слабее.
    if (definition.id === 'crypt') pierceWalls(built.map, { kind: 'grate', stride: 13, limit: 3 })
    if (definition.id === 'temple') pierceWalls(built.map, { kind: 'loophole', stride: 11, limit: 4 })
    const map = placeProps(built.map, {
      seed: `${seed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (built.map.sizeClass)].maxProps,
      zones: built.map.zones
        .filter((zone) => zone.label)
        .map((zone, index) => {
          const plan = Array.isArray(definition.propPlans) && definition.propPlans.length
            ? (definition.propPlans[index % definition.propPlans.length] ?? {})
            : {}
          return {
            ...plan,
            zoneId: zone.id,
            theme: plan.theme ?? definition.assetTheme ?? definition.id,
            density: plan.density ?? definition.density ?? 12,
            require: plan.require ?? definition.require,
            prefer: plan.prefer ?? definition.prefer,
          }
        }),
    })
    return {
      map,
      theme: definition.id,
      warnings: [...built.warnings, ...built.errors.map((issue) => issue.code)],
    }
  }

  if (definition.kind === 'settlement') {
    const built = buildSettlementScene({ seed, width, height, locationId, theme: definition, design })
    const map = built.map
    placeProps(map, {
      seed: `${seed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
      zones: [{
        zoneId: 'common',
        theme: definition.assetTheme ?? definition.id,
        density: definition.density ?? 10,
        require: definition.require,
        prefer: definition.prefer,
      }, ...map.zones.filter((zone) => zone.kind === 'interior').map((zone) => ({
        zoneId: zone.id,
        theme: 'interior',
        density: 8,
        require: [design.building_use === 'shop' ? 'crate' : 'table_small'],
        prefer: design.building_use === 'shop' ? ['crate', 'barrel', 'shelf_wall']
          : design.building_use === 'tavern' ? ['table_small', 'chair', 'barrel']
            : ['table_small', 'chair', 'bed', 'fireplace'],
      }))],
    })
    ensurePropAccess(map)
    return { map, theme: definition.id, warnings: built.warnings }
  }

  const arid = design.climate === 'arid'
  const cold = design.climate === 'cold'
  const wetland = design.climate === 'wetland'
  const terrain = {
    ...definition,
    river: design.topology === 'river',
    road: definition.road || design.topology === 'river',
    bridgeMaterial: ['stone', 'marble', 'metal'].includes(design.architecture) ? design.architecture : 'wood',
    material: arid ? 'sand' : cold ? 'ice' : wetland ? 'earth' : definition.material,
    surface: cold ? 'ice' : wetland ? 'mud' : 'none',
    label: definition.id === 'forest'
      ? arid ? 'Сухое редколесье' : cold ? 'Заснеженный лес' : wetland ? 'Заболоченная чаща' : definition.label
      : definition.label,
    ...(arid ? { require: ['tree_dead', 'boulder'], prefer: ['tree_dead', 'tree_stump', 'boulder', 'bush', 'woodpile'] }
      : cold ? { require: ['tree_pine', 'tree_spruce', 'fallen_log'], prefer: ['tree_pine', 'tree_spruce', 'tree_dead', 'boulder'] }
        : wetland ? { require: ['tree_dead', 'fallen_log', 'bush'], prefer: ['tree_dead', 'bush', 'fern', 'fallen_log'] } : {}),
  }
  const map = layoutOpenTerrain(terrain, { seed, width, height, locationId })
  placeProps(map, {
    seed: `${seed}:props`,
    maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
    zones: [{
      zoneId: 'field',
      theme: definition.id,
      density: design.density === 'sparse' ? 9 : design.density === 'dense' ? 20 : definition.density ?? 14,
      require: terrain.require,
      prefer: terrain.prefer,
    }],
  })
  return { map, theme: definition.id, warnings: [] }
}
