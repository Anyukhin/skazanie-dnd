import { createHash } from 'node:crypto'
import { generateDynamicSceneMap } from './dynamic-map.mjs'
import { reconcileWorldMap, worldLocationById } from './world-map.mjs'
import { SIZE_CLASSES, legacyCellsFromTacticalMap, serializeTacticalMap, tacticalMapFromLegacyCells } from './tactical-map.mjs'
import { sceneInteractionCatalogEntry, sceneInteractionFallbackAssets } from './scene-interactions.mjs'
import { REFERENCE_SIZE } from './building-generator.mjs'
import { normalizeDeclaredLevels } from './level-generator.mjs'
import {
  buildThemedScene,
  isLiveTheme,
  resolveSceneTheme,
} from './scene-themes.mjs'

const WIDTH = 13
const HEIGHT = 9
const MAP_CELL_TYPES = new Set(['wall', 'floor', 'water', 'door'])
const MAP_MATERIALS = new Set(['stone', 'wood', 'earth', 'grass', 'sand', 'metal', 'marble', 'ice'])
const MAP_PATTERNS = new Set(['small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural'])

function clone(value) {
  return structuredClone(value)
}

function text(value, maxLength, fallback = '') {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim()
  return (normalized || fallback).slice(0, maxLength)
}

function integer(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

/**
 * Свежий тематический генератор иногда раскладывает только визуальные assets
 * (деревья, сталагмиты, дорожные знаки), которые не входят в словарь механики.
 * До сохранения новой сцены заменяем максимум два уже существующих предмета на
 * канонические aliases словаря. Число feature и обязательные лестницы не
 * меняются; remembered maps сюда не проходят.
 *
 * @param {ReturnType<typeof legacyCellsFromTacticalMap>} cells
 * @param {string|number} seed
 * @param {string[]} [themeAssets]
 */
function ensureSceneInteractionFeatures(cells, seed, themeAssets = []) {
  let supported = cells.filter((cell) => sceneInteractionCatalogEntry(cell.feature)).length
  if (supported >= 2) return cells
  const thematicAssets = [...new Set(themeAssets)].filter((assetId) => sceneInteractionCatalogEntry(assetId))
  const fallbackAssets = thematicAssets.length ? thematicAssets : sceneInteractionFallbackAssets()
  const replaceable = cells
    .filter((cell) => (
      typeof cell.feature === 'string'
      && cell.feature !== 'enemy'
      && !/stairs/iu.test(cell.feature)
      && !sceneInteractionCatalogEntry(cell.feature)
    ))
    .map((cell) => ({
      cell,
      score: createHash('sha256').update(`${seed}:poi-feature:${cell.x}:${cell.y}:${cell.feature}`).digest().readUInt32LE(0),
    }))
    .sort((left, right) => left.score - right.score || left.cell.y - right.cell.y || left.cell.x - right.cell.x)
  for (const candidate of replaceable) {
    const feature = fallbackAssets[(candidate.score + supported) % fallbackAssets.length]
    if (!feature) break
    candidate.cell.feature = feature
    supported += 1
    if (supported >= 2) break
  }
  return cells
}

function publicText(value, maximum, fallback = '') {
  return typeof value === 'string' ? text(value, maximum, fallback) : fallback
}

function publicTextList(value, maximum, limit) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string')
    .map((item) => text(item, maximum))
    .filter(Boolean))].slice(-limit)
}

function normalizedSceneCells(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.cells)
      ? value.cells
      : []
  const seen = new Set()
  return source.slice(0, SIZE_CLASSES.region.maxCells).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const x = Number(raw.x)
    const y = Number(raw.y)
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return []
    const position = `${x},${y}`
    if (seen.has(position)) return []
    seen.add(position)
    const cell = {
      x,
      y,
      type: MAP_CELL_TYPES.has(String(raw.type)) ? String(raw.type) : 'floor',
      revealed: raw.revealed === true,
    }
    if (typeof raw.feature === 'string' && raw.feature.trim()) cell.feature = raw.feature.trim().slice(0, 40)
    if (MAP_MATERIALS.has(String(raw.material))) cell.material = String(raw.material)
    if (Number.isSafeInteger(Number(raw.variant))) cell.variant = Math.max(0, Math.min(5, Number(raw.variant)))
    if (MAP_PATTERNS.has(String(raw.pattern))) cell.pattern = String(raw.pattern)
    if (typeof raw.edge_mask === 'string' && /^[nesw]{0,4}$/u.test(raw.edge_mask)) cell.edge_mask = raw.edge_mask
    return [cell]
  })
}

/**
 * Запись запомненной локации.
 *
 * Клетки лежали здесь с самого начала; сериализованная карта добавлена этапом
 * L3 и **необязательна**. Без неё запомненный этаж возвращается той же дорогой,
 * что и раньше: карта пересобирается из клеток, а вместе с ней теряются зоны,
 * рёбра и привязки лестниц к этажам. Для этажа входа это терпимо — привязку
 * восстанавливает заявка `scene.levels`. Для этажа выше или ниже терпимо уже
 * нет: у пересобранной карты `levelIndex` равен нулю, и заявка привязала бы
 * лестницу не туда. Поэтому этаж консервируется целиком.
 *
 * Поле уже умеют выносить `externalizeMaps`/`internalizeMaps`
 * (`server/map-store.mjs`) — в снимок попадает ссылка, а не тело карты.
 *
 * @param {unknown} value клетки, либо запись целиком
 * @param {unknown} [map] сериализованная карта; по умолчанию берётся из записи
 */
function sceneMapRecord(value, map = undefined) {
  const cells = normalizedSceneCells(value)
  if (!cells.length) return null
  const source = map === undefined
    ? (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {any} */ (value).map : undefined)
    : map
  return source && typeof source === 'object' && !Array.isArray(source)
    ? { version: 1, cells, map: source }
    : { version: 1, cells }
}

/**
 * Тактические карты хранятся отдельно от публичных узлов мировой карты.
 * Само состояние карты меняется только при применении событий; индекс делает
 * поиск локации независимым от главы, в которой она была посещена.
 */
export function normalizeLocationMaps(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).slice(0, 100).flatMap(([locationId, raw]) => {
    const id = text(locationId, 120)
    const record = sceneMapRecord(raw)
    return id && record ? [[id, record]] : []
  }))
}

export function sceneMapForLocation(locationMaps, locationId) {
  const id = text(locationId, 120)
  const record = id ? sceneMapRecord(locationMaps?.[id]) : null
  return record ? clone(record.cells) : null
}

/**
 * Сериализованная карта запомненного этажа, если она была законсервирована.
 * Сохранения, сделанные до L3, отдают `null` — там лежат только клетки.
 *
 * @param {Record<string, any>|null|undefined} locationMaps
 * @param {string} locationId ключ этажа (`levelKey`)
 * @returns {Record<string, any>|null}
 */
export function sceneTacticalMapForLocation(locationMaps, locationId) {
  const id = text(locationId, 120)
  const record = id ? locationMaps?.[id] : null
  // Клетки записи здесь намеренно не нормализуются: карта самодостаточна, а
  // разбор нескольких тысяч клеток ради выброшенного результата стоил бы дороже
  // самого перехода.
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const map = record.map
  return map && typeof map === 'object' && !Array.isArray(map) ? clone(map) : null
}

export function sceneLocationId(state = {}) {
  const direct = publicText(state.scene?.location_id ?? state.scene?.locationId, 120)
  if (direct) return direct
  const current = publicText(state.worldMap?.currentLocationId, 120)
  if (current) return current
  const expected = publicText(state.scene?.location, 120).toLocaleLowerCase('ru')
  if (!expected) return ''
  return publicText(
    (Array.isArray(state.worldMap?.locations) ? state.worldMap.locations : [])
      .find((location) => publicText(location?.name, 120).toLocaleLowerCase('ru') === expected)?.id,
    120,
  )
}

export function rememberSceneMap(state, locationId, cells, map = undefined) {
  const id = publicText(locationId, 120)
  const record = sceneMapRecord(cells, map)
  if (!id || !record) return state
  state.locationMaps = {
    ...normalizeLocationMaps(state.locationMaps),
    [id]: record,
  }
  return state
}

/**
 * Номер активного этажа. Сцена без поля `level` — это этаж входа, и такой
 * ответ обязателен: у всех сохранённых кампаний поля нет вовсе.
 *
 * @param {Record<string, any>} [state]
 * @returns {number}
 */
export function sceneLevelIndex(state = {}) {
  const index = Number(state?.scene?.level?.index)
  return Number.isSafeInteger(index) ? index : 0
}

export function rememberCurrentSceneMap(state) {
  const cells = state?.scene?.cells
  if (!Array.isArray(cells) || !cells.length) return state
  // Ключ обязан учитывать этаж: иначе второй этаж лёг бы поверх зала под тем же
  // идентификатором локации и стёр бы его.
  return rememberSceneMap(state, levelKey(sceneLocationId(state), sceneLevelIndex(state)), cells, state.scene.map)
}

/**
 * Тема сцены — здание с участком, храм, склеп, пещера, лес, дорога или
 * поселение — распознаётся по словам картографа и его же заявке на карту. Для
 * темы работает отдельный генератор со стенами на рёбрах и расстановкой по
 * якорям; неопознанная сцена получает безопасную тему по своей планировке.
 *
 * Порядок источников — от точного к общему:
 *
 * 1. Название локации и тема сцены. Это самые конкретные слова, и пишет их сам
 *    картограф: «древний склеп» он называет складом не по недосмотру.
 * 2. Узор и планировка из заявки. Часть значений называет тему однозначно.
 * 3. Ничего не опознано — структурированный тематический fallback, сохраняющий
 *    топологию заявки (`cavern`, `streets`, `open`, `rooms`).
 *
 * Проверка `live` стоит здесь, а не в опознании: `matchTheme` отвечает на
 * вопрос «что это за место», а не «чем это строить». Сейчас все заявленные
 * темы имеют самостоятельную геометрию.
 *
 * Прежде здесь стояли ворота: если картограф назвал `layout` или `pattern`, тема
 * не применялась вовсе — считалось, что это его осознанное решение. Ворота
 * оказались наглухо закрытыми. Промпт `map_architect` требует оба поля в каждом
 * ответе, и `fallbackPlan` ниже проставляет их сам, поэтому признак был истинен
 * всегда, а весь тематический конвейер в живой игре не работал ни разу. Замысел
 * «явная просьба сильнее догадки» сохранён, но выражен иначе: просьба теперь
 * ведёт к теме, а не мимо неё.
 */
function generateSceneGeometryFor({ theme, danger, location, sceneKind, settlementType = '', worldKind = '', seed, locationId, requestedMap, levels = [] }) {
  // Опознание живёт в одном месте — `server/scene-themes.mjs`. Название —
  // не единственный признак: вид точки карты мира, тип поселения и заявка
  // картографа весят не меньше, иначе деревня с «бродом» в имени становилась
  // дорогой и ничем не отличалась от дороги, в которую из неё уходили.
  const recognized = resolveSceneTheme({ location, theme, sceneKind, settlementType, worldKind, request: requestedMap })
  // Готовые комнатные/поселковые темы намеренно не заливают воду: их
  // генераторы строят мебель и зоны, а не русло. Для неизвестного водоёма
  // оставляем заявку процедурному генератору, который умеет сохранять
  // непроходимую поверхность `water`; authored-вариант с явным theme_id
  // остаётся за своей подготовленной геометрией.
  const explicitTheme = String(requestedMap.theme_id ?? requestedMap.themeId ?? '').trim()
  const waterChance = Number(requestedMap.water)
  const waterBody = /озер|река|водо[её]м|пруд|залив|отмел|переправ|берег/iu.test(`${location} ${theme}`)
  const waterScene = !explicitTheme && (waterBody || (Number.isFinite(waterChance) && waterChance >= 0.35))
  const matched = !waterScene && isLiveTheme(recognized) ? recognized : null
  if (matched) {
    const built = buildThemedScene({
      location,
      theme: text(theme, 60, matched.id),
      sceneKind,
      themeId: matched.id,
      seed,
      locationId,
      width: integer(requestedMap.width, REFERENCE_SIZE.width, 16, SIZE_CLASSES.area.maxWidth),
      height: integer(requestedMap.height, REFERENCE_SIZE.height, 16, SIZE_CLASSES.area.maxHeight),
      levels,
    })
    built.map.theme = matched.assetTheme ?? matched.id
    return { cells: legacyCellsFromTacticalMap(built.map), map: built.map }
  }
  // Сейчас сюда не попадает ни одна сцена: `fallbackThemeFor` всегда возвращает
  // тему, а `live` стоит у всех семи. Ветка остаётся предохранителем на случай
  // новой темы, которую отключат флагом, — тогда сцена уйдёт прежним
  // процедурным путём вместо того, чтобы собраться недоделанной геометрией.
  const cells = generateDynamicSceneMap({ ...requestedMap, seed, theme, danger })
  const map = tacticalMapFromLegacyCells(cells, { locationId, seed })
  map.theme = recognized.assetTheme ?? recognized.id
  return { cells, map }
}

/**
 * Тот же выбор генератора для тех, кто собирает сцену вне перехода Режиссёра —
 * прежде всего для первой сцены кампании. Пока эта развилка жила только внутри
 * перехода, стартовая сцена не могла получить тему ни при каких словах.
 *
 * @param {object} input
 * @returns {ReturnType<typeof generateDynamicSceneMap>}
 */
export function generateSceneGeometry({ theme = '', danger = 'средняя', location = '', sceneKind = '', settlementType = '', worldKind = '', seed = 'scene', locationId = '', map = {}, levels = [] } = {}) {
  const requestedMap = map && typeof map === 'object' && !Array.isArray(map) ? map : {}
  return generateSceneGeometryFor({
    theme, danger, location, sceneKind, settlementType, worldKind, seed, locationId, requestedMap, levels: normalizeDeclaredLevels(levels),
  })
}

/** Совместимое клеточное представление для старых потребителей и инструментов. */
export function generateSceneCells(input = {}) {
  const definition = resolveSceneTheme({ ...input, request: input.map ?? {} })
  return ensureSceneInteractionFeatures(generateSceneGeometry(input).cells, input.seed ?? 'scene', [...(definition.require ?? []), ...(definition.prefer ?? [])])
}

/**
 * Ключ этажа в `state.locationMaps` (`docs/multilevel-map-plan.md`, 3.1).
 *
 * Этаж входа сохраняет **прежний ключ без суффикса**, поэтому все сохранённые
 * кампании остаются валидными и никакой миграции не требуют: то, что лежало под
 * `locationId`, и есть этаж 0.
 *
 * Составной ключ обязан пережить `normalizeLocationMaps`, а та режет ключ до 120
 * символов. Поэтому под суффикс место отводится заранее: иначе у длинного
 * идентификатора локации срезался бы как раз номер этажа, и два разных этажа
 * схлопнулись бы в одну запись.
 *
 * @param {string} locationId
 * @param {number} [level]
 * @returns {string}
 */
export function levelKey(locationId, level = 0) {
  const index = Number(level)
  const safeLevel = Number.isSafeInteger(index) ? index : 0
  const base = publicText(locationId, 120)
  if (!base || safeLevel === 0) return base
  const suffix = `@L${safeLevel}`
  return `${base.slice(0, 120 - suffix.length)}${suffix}`
}

/**
 * Вид точки на карте мира, которая там **уже была**: по идентификатору, иначе
 * по имени. Пустая строка — место на карте новое, и о его виде карта ничего
 * не знает.
 *
 * @param {Record<string, any>|undefined} worldMap карта до сверки с новой сценой
 * @param {string} locationId
 * @param {string} location
 * @returns {string}
 */
export function knownWorldKind(worldMap, locationId, location) {
  const locations = Array.isArray(worldMap?.locations) ? worldMap.locations : []
  const wanted = text(location, 180).toLocaleLowerCase('ru')
  const node = worldLocationById(worldMap, locationId)
    ?? locations.find((candidate) => text(candidate?.name, 180).toLocaleLowerCase('ru') === wanted)
  return text(node?.kind, 40)
}

export function stableLocationMapSeed(worldMap, locationId, location) {
  const campaignSeed = publicText(worldMap?.seed, 120, 'campaign')
  const stableId = publicText(locationId, 120, publicText(location, 120, 'location'))
  return `location-map:v1:${campaignSeed}:${stableId}`
}

/**
 * Сид этажа. Выводится из сида локации, а не берётся заново: один и тот же
 * `(locationId, level)` обязан давать ту же карту при любом числе переходов
 * туда и обратно, иначе replay соберёт другой подвал.
 *
 * Суффикс совпадает по форме с `levelKey`, и это намеренно: читая сид в логе,
 * видно, какой именно этаж им собран. Этаж входа сохраняет прежний сид без
 * суффикса, поэтому карты уже сыгранных локаций не меняются.
 *
 * @param {string} baseSeed сид локации из `stableLocationMapSeed`
 * @param {number} [level]
 * @returns {string}
 */
export function levelSeed(baseSeed, level = 0) {
  const index = Number(level)
  const safeLevel = Number.isSafeInteger(index) ? index : 0
  const base = publicText(baseSeed, 180, 'location-map')
  return safeLevel === 0 ? base : `${base}@L${safeLevel}`
}

function publicHistoryEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = ['completed', 'unresolved', 'abandoned'].includes(value.status) ? value.status : null
  return {
    chapter: integer(value.chapter, 1, 1, 999),
    title: publicText(value.title, 80, 'Предыдущая сцена'),
    location: publicText(value.location, 120),
    ...(publicText(value.location_id ?? value.locationId, 120) ? { location_id: publicText(value.location_id ?? value.locationId, 120) } : {}),
    objective: publicText(value.objective, 160),
    outcome: publicText(value.outcome, 240),
    ...(status ? { status } : {}),
  }
}

/**
 * Produces the only adventure shape allowed inside public SceneAdvanced data.
 * Private/GM buckets remain server-side and are intentionally not copied into
 * the transition payload.
 */
export function publicAdventureMemory(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const currentHook = publicText(source.currentHook, 240)
  const lastTransition = publicText(source.lastTransition, 500)
  return {
    chapter: integer(source.chapter, 1, 1, 999),
    ...(currentHook ? { currentHook } : {}),
    ...(lastTransition ? { lastTransition } : {}),
    unresolvedThreads: publicTextList(source.unresolvedThreads, 240, 20),
    visitedLocations: publicTextList(source.visitedLocations, 120, 50),
    visitedLocationIds: publicTextList(source.visitedLocationIds, 120, 50),
    history: (Array.isArray(source.history) ? source.history : [])
      .map(publicHistoryEntry)
      .filter(Boolean)
      .slice(-20),
  }
}

function seededRandom(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function featurePool(theme) {
  if (/лес|болот|чащ|роща/iu.test(theme)) return ['torch', 'rune', 'altar', 'chest']
  if (/город|деревн|таверн|улиц/iu.test(theme)) return ['torch', 'chest', 'stairs', 'altar']
  if (/пещ|шахт|подзем|руин|храм/iu.test(theme)) return ['torch', 'rune', 'stairs', 'altar', 'chest']
  return ['torch', 'rune', 'chest', 'stairs']
}

/** Builds a playable, connected 13x9 map. Content choices come from the director;
 * topology is deterministic so retries cannot silently produce another location. */
function generateSceneMapLegacy({ seed, theme = '', danger = 'средняя' } = {}) {
  const random = seededRandom(`${seed}:${theme}:${danger}`)
  const cells = []
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const border = x === 0 || y === 0 || x === WIDTH - 1 || y === HEIGHT - 1
      const onSpine = y === 4 || x === 6
      const chamber = (x >= 2 && x <= 4 && y >= 2 && y <= 6) || (x >= 8 && x <= 10 && y >= 2 && y <= 6)
      const passable = !border && (onSpine || chamber || random() > 0.34)
      cells.push({ x, y, type: passable ? 'floor' : 'wall', revealed: passable && x <= 2 })
    }
  }

  const floor = cells.filter((cell) => cell.type === 'floor' && cell.x >= 4)
  const features = featurePool(theme)
  const count = danger === 'высокая' ? 6 : danger === 'низкая' ? 3 : 4
  for (let index = 0; index < count && floor.length; index += 1) {
    const chosen = floor.splice(Math.floor(random() * floor.length), 1)[0]
    chosen.feature = index === 0 ? 'stairs' : features[Math.floor(random() * features.length)]
  }
  return cells
}

export function createSceneTransition(input = {}, state = {}) {
  const previousScene = state.scene ?? {}
  const previousAdventure = publicAdventureMemory(state.adventure)
  const chapter = integer(previousAdventure.chapter, 1, 1, 999) + 1
  const title = text(input.title, 80, `Глава ${chapter}`)
  const requestedLocationId = publicText(input.location_id ?? input.locationId, 120)
  const requestedLocation = worldLocationById(state.worldMap, requestedLocationId)
  const location = requestedLocation?.name || text(input.location, 120, title)
  const mood = text(input.mood, 160, 'Неизведанное место, полное новых возможностей')
  const objective = text(input.objective, 160, 'Исследовать новую локацию и найти путь дальше')
  const transition = text(input.transition, 500, `Путь из «${text(previousScene.location || previousScene.title, 100, 'прежнего места')}» приводит героев в «${location}».`)
  const arrival = text(input.arrival, 500, `Перед героями открывается ${location}.`)
  const hook = text(input.hook, 240, objective)
  const theme = text(input.theme, 80, location)
  const danger = ['низкая', 'средняя', 'высокая'].includes(input.danger) ? input.danger : 'средняя'
  const completedObjective = text(input.completed_objective, 160, previousScene.objective)
  const objectiveStatus = ['completed', 'unresolved', 'abandoned'].includes(input.objective_status) ? input.objective_status : 'completed'
  const historyEntry = {
    chapter: Math.max(1, chapter - 1),
    title: text(previousScene.title, 80, 'Предыдущая сцена'),
    location: text(previousScene.location, 120),
    ...(publicText(previousScene.location_id ?? previousScene.locationId, 120) ? { location_id: publicText(previousScene.location_id ?? previousScene.locationId, 120) } : {}),
    objective: completedObjective,
    outcome: text(input.outcome, 240, completedObjective ? `Цель «${completedObjective}» завершена.` : 'Герои покинули эту локацию.'),
    status: objectiveStatus,
  }
  const history = [...(Array.isArray(previousAdventure.history) ? previousAdventure.history : []), historyEntry].slice(-20)
  const unresolvedThreads = [...(Array.isArray(previousAdventure.unresolvedThreads) ? previousAdventure.unresolvedThreads : [])]
  if (input.carry_unresolved || objectiveStatus === 'unresolved') {
    unresolvedThreads.push(text(previousAdventure.currentHook || previousScene.objective, 240))
  }

  const worldMap = reconcileWorldMap(state.worldMap, {
    seed: state.worldMap?.seed || state.sessionCode,
    campaignName: state.campaign,
    concept: state.campaignConcept,
    currentLocation: location,
    currentLocationId: requestedLocationId,
    previousLocation: previousScene.location || previousScene.title,
    previousLocationId: previousScene.location_id ?? previousScene.locationId ?? sceneLocationId(state),
    knownLocations: [...previousAdventure.visitedLocations, location],
    transition,
    scene: { objective, scene_kind: input.scene_kind, danger },
  })

  const locationId = worldMap.currentLocationId
  const knownKind = publicText(knownWorldKind(state.worldMap, locationId, location), 40)
  const rememberedMap = sceneMapForLocation(state.locationMaps, locationId)
    ?? (sceneLocationId(state) === locationId ? normalizedSceneCells(previousScene.cells) : null)
  const rememberedTacticalMap = sceneTacticalMapForLocation(state.locationMaps, locationId)
    ?? (sceneLocationId(state) === locationId && previousScene.map ? clone(previousScene.map) : null)
  const requestedMap = input.map && typeof input.map === 'object' && !Array.isArray(input.map) ? input.map : {}
  const declaredLevels = normalizeDeclaredLevels(input.levels)
  const resolvedTheme = resolveSceneTheme({
    location,
    theme,
    sceneKind: input.scene_kind,
    settlementType: publicText(input.settlement_type, 40),
    worldKind: knownKind,
    request: requestedMap,
  })
  const generated = rememberedMap ? null : generateSceneGeometryFor({
    theme,
    danger,
    location,
    sceneKind: input.scene_kind,
    settlementType: publicText(input.settlement_type, 40),
    // Карта мира знает, что это за место — деревня, пустошь, руины, — даже
    // когда название об этом молчит. Спрашивается карта **до** сверки:
    // место, которого на ней ещё не было, только что получило вид от этой же
    // сцены (а запасная карта и вовсе ставит «город» вслепую), и выводить из
    // него тему значило бы рисовать улицы по собственному предположению.
    worldKind: knownKind,
    seed: stableLocationMapSeed(worldMap, locationId, location),
    locationId,
    requestedMap,
    levels: declaredLevels,
  })
  const cells = rememberedMap ?? generated.cells
  const mapTheme = text(resolvedTheme?.assetTheme ?? resolvedTheme?.id, 60)
  const tacticalMap = rememberedTacticalMap ?? generated?.map ?? tacticalMapFromLegacyCells(cells, {
    locationId,
    seed: stableLocationMapSeed(worldMap, locationId, location),
  })
  if (!rememberedTacticalMap && mapTheme) tacticalMap.theme = mapTheme
  const serializedMap = rememberedTacticalMap ?? serializeTacticalMap(tacticalMap)
  const partySpawn = Array.isArray(tacticalMap.spawnPoints)
    ? tacticalMap.spawnPoints.find((point) => point?.role === 'party')
    : null
  const scene = {
    title,
    location,
    location_id: locationId,
    mood,
    objective,
    turn: Math.max(0, Number(previousScene.turn) || 0) + 1,
    // Объявленные архитектором этажи живут в самой сцене, а не отдельным
    // индексом состояния. Причина — replay: `SceneAdvanced` несёт объект сцены
    // целиком и применяется присваиванием `state.scene = payload.scene`, так что
    // заявка восстанавливается из потока событий без единой новой строки в
    // reducer. Отдельная карта `state.locationLevels` (раздел 3.3 плана) хранит
    // другое — этажи, на которых партия уже побывала, и пополняется механикой
    // перехода на этапе L3. Одноэтажная локация поля не получает вовсе, поэтому
    // сохранённые кампании и старые события читаются как раньше.
    ...(declaredLevels.length ? { levels: declaredLevels } : {}),
    cells,
    map: serializedMap,
  }

  return {
    scene,
    worldMap,
    adventure: {
      chapter,
      history,
      currentHook: hook,
      lastTransition: transition,
      unresolvedThreads: [...new Set(unresolvedThreads.filter(Boolean))].slice(-20),
      visitedLocations: [...new Set([...(Array.isArray(previousAdventure.visitedLocations) ? previousAdventure.visitedLocations : []), location])].slice(-50),
      visitedLocationIds: [...new Set([
        ...(Array.isArray(previousAdventure.visitedLocationIds) ? previousAdventure.visitedLocationIds : []),
        worldMap.currentLocationId,
      ].filter(Boolean))].slice(-50),
    },
    transition,
    arrival,
    // Старый переход без заявки сохраняет совместимую точку (1,4). Для
    // заявленной карты вход выводится из её размеров, чтобы широкий берег или
    // озеро не получили недостижимую старую координату.
    entrance: partySpawn
      ? { x: partySpawn.x, y: partySpawn.y }
      : { x: 1, y: Object.keys(requestedMap).length ? Math.floor((tacticalMap.height - 1) / 2) : 4 },
  }
}

export const generateSceneMap = generateDynamicSceneMap
