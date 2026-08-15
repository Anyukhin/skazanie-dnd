// @ts-check
import { encounterDifficultyLabel } from './encounter-assembler.mjs'
import { merchantIsAtLocation, publicMerchantFor } from './merchant-economy.mjs'
import { itemViewerCapabilities } from './item-catalog.mjs'
import { npcProfileForViewerAt, npcSocialForViewer } from './npc-social.mjs'
import { suggestedActionsFor } from './action-hints.mjs'
import { sceneNpcsForViewer } from './npc-positioning.mjs'
import { reputationTier } from './reputation-policy.mjs'
import { projectVisibleState } from './security.mjs'
import { hitPointDicePoolForActor } from './rules-engine.mjs'
import {
  MATERIALS,
  SIZE_CLASSES,
  SURFACES,
  deserializeTacticalMap,
  serializeTacticalMap,
  serializedTacticalMapHash,
} from './tactical-map.mjs'
import { beastForViewer, beastsForViewer } from './beast-taming.mjs'
import { captiveForViewer, captivesForViewer } from './captives.mjs'
import { lawForViewer, publicGuardEncounterFor } from './law-and-order.mjs'
import { publicTavernRoundFor, tavernForViewer } from './tavern-life.mjs'
import { OFFSCREEN_WORLD_SCHEMA_VERSION, offscreenWorldFeed } from './offscreen-world.mjs'
import { courierLetterForViewer, courierLettersForViewer } from './courier-letters.mjs'
import { weatherForViewer } from './weather.mjs'
import { WORLD_DEEDS_SCHEMA_VERSION, worldDeedsFeed } from './world-deeds.mjs'
import { worldMemoryForViewer } from './world-memory.mjs'

/**
 * Модуль принимает внутреннее состояние кампании — произвольные объекты из
 * event-sourced стейта, которым нельзя доверять по форме, — и сужает их до
 * того, что игроку разрешено видеть. Поэтому вход описан свободно (`Loose`),
 * а типизирован результат: контракт с браузером — это именно он.
 *
 * @typedef {Record<string, any>} Loose произвольный объект внутреннего состояния
 * @typedef {Loose & { enemies?: Loose[], merchants?: Loose[] }} LooseState состояние кампании; названы только поля, по которым модуль итерирует
 * @typedef {import('./dynamic-map.mjs').SceneCell} SceneCell
 * @typedef {import('./dynamic-map.mjs').SceneCellType} SceneCellType
 * @typedef {import('./dynamic-map.mjs').SceneCellMaterial} SceneCellMaterial
 * @typedef {import('./dynamic-map.mjs').SceneCellPattern} SceneCellPattern
 * @typedef {{ role: 'admin' | 'player', playerId: string, partyIds: string[], isPartyMember: boolean }} Viewer
 */

/**
 * @param {unknown} value
 * @param {number} [maximum]
 * @returns {string}
 */
function text(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function integer(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

/**
 * Enemy illustrations are public presentation data, but the state is still
 * untrusted at this boundary. Only repository-owned files may reach CSS/HTML.
 *
 * @param {unknown} value
 * @returns {string}
 */
function publicEnemyImage(value) {
  const candidate = text(value, 180)
  return /^\/assets\/enemies\/[a-z0-9][a-z0-9-]*\.png$/u.test(candidate) ? candidate : ''
}

/**
 * @param {Loose} [entry]
 * @returns {Loose}
 */
function publicHistoryEntry(entry = {}) {
  return {
    chapter: Math.max(1, integer(entry.chapter, 1)),
    title: text(entry.title, 120),
    location: text(entry.location, 180),
    objective: text(entry.objective, 500),
    outcome: text(entry.outcome, 500),
    ...(entry.status == null ? {} : { status: text(entry.status, 40) }),
  }
}

/** The browser receives narrative continuity, never arbitrary private buckets.
 * @param {Loose} [adventure]
 * @returns {Loose}
 */
export function publicAdventureFor(adventure = {}) {
  return {
    chapter: Math.max(1, integer(adventure.chapter, 1)),
    ...(adventure.currentHook == null ? {} : { currentHook: text(adventure.currentHook, 500) }),
    ...(adventure.lastTransition == null ? {} : { lastTransition: text(adventure.lastTransition, 1_000) }),
    unresolvedThreads: (Array.isArray(adventure.unresolvedThreads) ? adventure.unresolvedThreads : [])
      .map((entry) => text(entry, 500)).filter(Boolean).slice(-20),
    visitedLocations: (Array.isArray(adventure.visitedLocations) ? adventure.visitedLocations : [])
      .map((entry) => text(entry, 180)).filter(Boolean).slice(-50),
    history: (Array.isArray(adventure.history) ? adventure.history : [])
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map(publicHistoryEntry).slice(-20),
  }
}

/**
 * @param {Loose} [worldMap]
 * @returns {Loose}
 */
export function publicWorldMapFor(worldMap = {}) {
  const currentLocationId = text(worldMap.currentLocationId, 100)
  const visible = (Array.isArray(worldMap.locations) ? worldMap.locations : [])
    .filter((location) => location?.known !== false || location?.visited === true || text(location?.id, 100) === currentLocationId)
  // Предел в полсотни точек не имеет права выбросить текущую. По её id клиент
  // строит адрес иллюстрации локации (`scene.location_id` есть только у
  // ведущего) и ставит метку «вы здесь». За длинную кампанию известных мест
  // становится больше пятидесяти, точка стола молча уезжала за границу среза,
  // и игроки оставались с библиотечной подложкой вместо картинки.
  //
  // Цена перестановки: пятидесятая по счёту известная точка уходит из карты
  // игрока вместе с маршрутами, которые её касаются. Лимит есть лимит — кто-то
  // обязан уступить место, и текущая локация важнее любой из прочих.
  //
  // Пустой `currentLocationId` — обычное состояние кампании: поле необязательное.
  // Без проверки `findIndex` находил бы первую локацию с пустым id и поднимал
  // мусорную запись наверх, выбрасывая честную.
  const currentIndex = currentLocationId
    ? visible.findIndex((location) => text(location?.id, 100) === currentLocationId)
    : -1
  const locations = currentIndex >= 50
    ? [...visible.slice(0, 49), visible[currentIndex]]
    : visible.slice(0, 50)
  const locationIds = new Set(locations.map((location) => text(location?.id, 100)).filter(Boolean))
  const regionIds = new Set(locations.map((location) => text(location?.regionId, 100)).filter(Boolean))
  return {
    version: Math.max(1, integer(worldMap.version, 1)),
    name: text(worldMap.name, 160),
    width: Math.max(320, Math.min(2000, integer(worldMap.width, 1000))),
    height: Math.max(240, Math.min(1200, integer(worldMap.height, 640))),
    currentLocationId: locationIds.has(currentLocationId) ? currentLocationId : '',
    regions: (Array.isArray(worldMap.regions) ? worldMap.regions : [])
      .filter((region) => regionIds.has(text(region?.id, 100)))
      .slice(0, 12).map((region) => ({
      id: text(region?.id, 100), name: text(region?.name, 120), biome: text(region?.biome, 40),
      x: integer(region?.x, 0), y: integer(region?.y, 0), radius: integer(region?.radius, 180),
    })),
    locations: locations.map((location) => ({
      id: text(location?.id, 100), name: text(location?.name, 160), kind: text(location?.kind, 40),
      x: integer(location?.x, 0), y: integer(location?.y, 0), regionId: text(location?.regionId, 100),
      summary: text(location?.summary, 500), known: location?.known !== false, visited: location?.visited === true,
    })),
    routes: (Array.isArray(worldMap.routes) ? worldMap.routes : []).slice(0, 100)
      .filter((route) => route?.discovered !== false && locationIds.has(text(route?.from, 100)) && locationIds.has(text(route?.to, 100)))
      .map((route) => ({
        id: text(route?.id, 100), from: text(route?.from, 100), to: text(route?.to, 100), kind: text(route?.kind, 40),
        distance: Math.max(1, integer(route?.distance, 1)), danger: text(route?.danger, 40), discovered: route?.discovered !== false,
      })),
  }
}

const PUBLIC_CELL_TYPES = new Set(['wall', 'floor', 'water', 'door'])
const PUBLIC_CELL_MATERIALS = new Set(['stone', 'wood', 'earth', 'grass', 'sand', 'metal', 'marble', 'ice'])
const PUBLIC_CELL_PATTERNS = new Set(['small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural'])

/**
 * Сужает клетки до публичной формы. `feature`, материал и вариант тайла
 * отдаются **только** с раскрытой клетки — это часть модели видимости, а не
 * косметика; сторож — `test/viewer-projection.test.mjs`.
 *
 * Правила обязаны совпадать с `publicTacticalMapFor`: массив клеток и карта —
 * две проекции одного состояния, и если они расходятся, у видимости появляется
 * второй набор правил, а игрок видит через более щедрый из них.
 *
 * Остаточное ограничение, которое здесь **не** закрывается: `type` отдаётся
 * всегда, поэтому очертания стен нераскрытой части клиенту известны. Туман
 * скрывает обстановку, но не планировку. Сделать его настоящим — продуктовое
 * изменение, а не правка проекции.
 *
 * Цикл намеренно предвыделяет результат и назначает необязательные поля
 * напрямую: условные object spread создавали до шести временных объектов на
 * каждую из 10 000 клеток карты `region`.
 *
 * @param {unknown} value
 * @returns {SceneCell[]}
 */
function publicCellsFor(value) {
  const cells = Array.isArray(value) ? value : []
  const length = Math.min(cells.length, SIZE_CLASSES.region.maxCells)
  /** @type {SceneCell[]} */
  const output = new Array(length)
  for (let index = 0; index < length; index += 1) {
    const cell = cells[index] && typeof cells[index] === 'object' ? cells[index] : {}
    const revealed = cell.revealed === true
    const rawType = String(cell.type ?? '')
    /** @type {SceneCell} */
    const projected = {
      x: integer(cell.x),
      y: integer(cell.y),
      type: /** @type {SceneCellType} */ (PUBLIC_CELL_TYPES.has(rawType) ? rawType : 'floor'),
      revealed,
    }
    const material = String(cell.material ?? '')
    if (revealed && PUBLIC_CELL_MATERIALS.has(material)) {
      projected.material = /** @type {SceneCellMaterial} */ (material)
    }
    const pattern = String(cell.pattern ?? '')
    if (PUBLIC_CELL_PATTERNS.has(pattern)) projected.pattern = /** @type {SceneCellPattern} */ (pattern)
    const variant = Number(cell.variant)
    if (revealed && Number.isSafeInteger(variant)) projected.variant = Math.max(0, Math.min(5, variant))
    if (typeof cell.edge_mask === 'string' && /^[nesw]{0,4}$/.test(cell.edge_mask)) projected.edge_mask = cell.edge_mask
    if (revealed && cell.feature != null) projected.feature = text(cell.feature, 40)
    output[index] = projected
  }
  return output
}

/**
 * Карта, отфильтрованная по видимости. Нераскрытая клетка остаётся в сетке —
 * иначе форма карты рассыплется, — но теряет материал, вариант тайла и
 * поверхность: по текстуре пола читается планировка неисследованной части.
 * Предметы, рёбра между двумя нераскрытыми клетками и двери на таких рёбрах не
 * передаются вовсе.
 *
 * Хеш считается **от проекции**, а не от исходной карты: игроку уходит
 * обезличенная сетка, и кэшировать по хешу он может только её. Хеш исходной
 * карты совпал бы у двух игроков с разным раскрытием.
 *
 * @param {unknown} value сериализованная карта из `scene.map`
 * @returns {{map: Record<string, unknown>, hash: string} | null}
 */
export function publicTacticalMapWithHashFor(value) {
  if (!value || typeof value !== 'object') return null
  let map
  try {
    map = deserializeTacticalMap(value)
  } catch {
    return null
  }
  const revealedBits = map.layers.revealed
  const stoneCode = MATERIALS.indexOf('stone')
  const emptySurfaceCode = SURFACES.indexOf('none')
  /** @param {number} x @param {number} y */
  const revealedAt = (x, y) => {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false
    const index = y * map.width + x
    return (revealedBits[index >> 3] & (1 << (index & 7))) !== 0
  }
  const cellCount = map.width * map.height
  for (let index = 0; index < cellCount; index += 1) {
    if ((revealedBits[index >> 3] & (1 << (index & 7))) !== 0) continue
    map.layers.material[index] = stoneCode
    map.layers.variant[index] = 0
    map.layers.surface[index] = emptySurfaceCode
    delete map.hazards[String(index)]
  }
  map.props = map.props.filter((prop) => prop.footprint.some((cell) => revealedAt(cell.x, cell.y))
    || (prop.footprint.length === 0 && revealedAt(Math.floor(prop.x), Math.floor(prop.y))))
  // Игроку нужна только affordance-часть интерактивного предмета. Ключи
  // скрытой детали и награды остаются в авторитетной карте до подтверждённого
  // события осмотра/открытия; иначе Рассказчик увидит тайник вместе с картой.
  for (const prop of map.props) {
    if (!prop.interaction) continue
    prop.interaction = /** @type {any} */ ({
      kind: prop.interaction.kind,
      verbs: [...prop.interaction.verbs],
      pointOfInterest: prop.interaction.pointOfInterest === true,
    })
  }
  const visibleEdges = new Set()
  for (const [key, edge] of Object.entries(map.edges)) {
    const neighborX = edge.x + (edge.dir === 'e' ? 1 : 0)
    const neighborY = edge.y + (edge.dir === 's' ? 1 : 0)
    if (revealedAt(edge.x, edge.y) || revealedAt(neighborX, neighborY)) {
      visibleEdges.add(`${edge.x},${edge.y},${edge.dir}`)
    } else {
      delete map.edges[key]
    }
  }
  map.doors = map.doors.filter((door) => visibleEdges.has(`${door.x},${door.y},${door.dir}`))
  const projectedMap = serializeTacticalMap(map)
  const projectedProps = /** @type {Array<Record<string, any>>} */ (
    Array.isArray(projectedMap.props) ? projectedMap.props : []
  )
  const projectedPropById = new Map(projectedProps.map((prop) => [String(prop.id ?? ''), prop]))
  // Авторитетный serializer ради map budget хранит полную metadata только у
  // 2–4 POI, а обычным словарным объектам восстанавливает её из каталога.
  // Публичная карта материализует affordance для каждого видимого предмета,
  // но ни при каких условиях не переносит ключи детали и награды.
  for (const prop of map.props) {
    const projectedProp = projectedPropById.get(prop.id)
    if (!projectedProp || !prop.interaction) continue
    projectedProp.interactive = true
    projectedProp.interaction = {
      kind: prop.interaction.kind,
      verbs: [...prop.interaction.verbs],
      pointOfInterest: prop.interaction.pointOfInterest === true,
    }
  }
  return { map: projectedMap, hash: serializedTacticalMapHash(projectedMap) }
}

/**
 * @param {unknown} value сериализованная карта из `scene.map`
 * @returns {Record<string, unknown> | null}
 */
export function publicTacticalMapFor(value) {
  return publicTacticalMapWithHashFor(value)?.map ?? null
}

/**
 * Этажи, на которых партия уже побывала. Проекция строгая и намеренно узкая:
 * игрок видит номер и подпись, но не заявку архитектора (`scene.levels`
 * содержит его подсказки о содержимом ещё не построенных этажей) и не карты
 * неактивных этажей — те живут в `state.locationMaps` и в проекцию не входят
 * вовсе.
 *
 * @param {unknown} value
 * @returns {Array<{index: number, label: string}>}
 */
function publicKnownLevelsFor(value) {
  return (Array.isArray(value) ? value : [])
    .flatMap((entry) => {
      const index = Number(/** @type {any} */ (entry)?.index)
      if (!Number.isSafeInteger(index)) return []
      return [{ index, label: text(/** @type {any} */ (entry)?.label, 120) }]
    })
    .slice(0, 8)
}

/**
 * @param {Loose} [scene]
 * @param {unknown} [knownLevels] известные партии этажи текущей локации
 * @returns {Loose & { cells: SceneCell[] }}
 */
export function publicSceneFor(scene = {}, knownLevels = undefined) {
  const projected = publicTacticalMapWithHashFor(scene.map)
  const levels = publicKnownLevelsFor(knownLevels)
  const levelIndex = Number(scene.level?.index)
  return {
    title: text(scene.title, 120),
    location: text(scene.location, 180),
    mood: text(scene.mood, 500),
    objective: text(scene.objective, 500),
    turn: Math.max(0, integer(scene.turn, 0)),
    cells: publicCellsFor(scene.cells),
    ...(Number.isSafeInteger(levelIndex)
      ? { level: { index: levelIndex, label: text(scene.level?.label, 120) } }
      : {}),
    ...(levels.length ? { levels } : {}),
    ...(projected ? { map: projected.map, map_hash: projected.hash } : {}),
    ...(scene.theme == null ? {} : { theme: text(scene.theme, 120) }),
    ...(scene.danger == null ? {} : { danger: text(scene.danger, 40) }),
    ...(scene.scene_kind == null ? {} : { scene_kind: text(scene.scene_kind, 40) }),
    ...(scene.settlement_type == null ? {} : { settlement_type: text(scene.settlement_type, 40) }),
  }
}

/**
 * @param {LooseState | null | undefined} state
 * @param {string} enemyId
 * @param {string} [actorId]
 * @returns {Loose}
 */
function enemyKnowledgeFor(state, enemyId, actorId = '') {
  const registry = state?.mechanics?.enemy_knowledge
  const entry = registry?.party?.[enemyId] ?? registry?.[enemyId] ?? {}
  const knownBy = Array.isArray(entry?.known_by) ? entry.known_by.map(String) : null
  return knownBy && actorId && !knownBy.includes(String(actorId)) ? {} : entry
}

/**
 * @param {Loose} [enemy]
 * @returns {string}
 */
function enemyHealthStatus(enemy = {}) {
  if (enemy.hp == null && enemy.maxHp == null) return enemy.alive === false ? 'defeated' : text(enemy.healthStatus, 20) || 'unharmed'
  const hp = Math.max(0, integer(enemy.hp, 0))
  const maximum = Math.max(1, integer(enemy.maxHp ?? enemy.max_hp, 1))
  if (enemy.alive === false || hp <= 0) return 'defeated'
  const ratio = hp / maximum
  if (ratio >= 1) return 'unharmed'
  if (ratio > .5) return 'wounded'
  if (ratio > .25) return 'bloodied'
  return 'critical'
}

/**
 * @param {Loose | null | undefined} knowledge
 * @param {string} key
 * @returns {boolean}
 */
function exactEnemyFact(knowledge, key) {
  return knowledge?.[key] === 'exact' || knowledge?.[key] === true
}

/**
 * @param {LooseState | null | undefined} state
 * @param {string} enemyId
 * @param {string} [actorId]
 * @returns {boolean}
 */
function exactEnemyHealthKnown(state, enemyId, actorId = '') {
  const knowledge = enemyKnowledgeFor(state, enemyId, actorId)
  return knowledge?.health === 'exact' || exactEnemyFact(knowledge, 'hp') || knowledge?.exact_hp === true
}

/**
 * @param {Loose} [enemy]
 * @param {LooseState} [state]
 * @param {string} [actorId]
 * @returns {Loose}
 */
export function publicEnemyFor(enemy = {}, state = {}, actorId = '') {
  const id = text(enemy.id ?? enemy.actor_id, 120)
  const knowledge = enemyKnowledgeFor(state, id, actorId)
  const exactHealth = exactEnemyHealthKnown(state, id, actorId)
  const image = publicEnemyImage(enemy.image)
  const creatureType = text(enemy.creature_type, 80)
  return {
    id,
    name: text(enemy.name, 120),
    x: integer(enemy.x, 0),
    y: integer(enemy.y, 0),
    ...(image ? { image } : {}),
    ...(creatureType ? { creature_type: creatureType } : {}),
    alive: enemy.alive !== false && (enemy.hp == null || integer(enemy.hp, 0) > 0),
    healthStatus: enemyHealthStatus(enemy),
    healthKnown: exactHealth ? 'exact' : 'banded',
    ...(exactHealth ? {
      hp: Math.max(0, integer(enemy.hp, 0)),
      maxHp: Math.max(1, integer(enemy.maxHp ?? enemy.max_hp, 1)),
    } : {}),
    ...(exactEnemyFact(knowledge, 'armor_class') || exactEnemyFact(knowledge, 'armor') ? {
      armor: Math.max(0, integer(enemy.armor ?? enemy.armor_class, 10)),
    } : {}),
    ...(exactEnemyFact(knowledge, 'speed') ? { speed: Math.max(0, integer(enemy.speed, 0)) } : {}),
    ...(exactEnemyFact(knowledge, 'stat_block') && enemy.stat_block_id != null ? { stat_block_id: text(enemy.stat_block_id, 120) } : {}),
  }
}

/**
 * @param {Loose[]} initiative
 * @param {LooseState | null | undefined} state
 * @param {string} [actorId]
 * @returns {Loose[]}
 */
function publicInitiativeFor(initiative, state, actorId = '') {
  const enemyIds = new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  return (Array.isArray(initiative) ? initiative : []).map((entry) => {
    const entryId = text(entry?.actor_id, 120)
    if (!enemyIds.has(entryId)) return entry
    return {
      actor_id: entryId,
      ...(entry?.shared_with == null ? {} : { shared_with: text(entry.shared_with, 120) }),
    }
  })
}

/** События, где бросок принадлежит цели, а не действующему лицу. */
const TARGET_ROLL_EVENT_TYPES = new Set([
  'SavingThrowResolved', 'AbilityCheckResolved', 'SpellSavingThrowResolved', 'ConcentrationSavingThrowResolved',
])

/** Записи журнала, где бросок принадлежит цели, а не действующему лицу. */
const TARGET_ROLL_BATTLE_LOG_TYPES = new Set(['spell-save', 'concentration-save'])

/**
 * @param {Loose} entry
 * @param {LooseState | null | undefined} state
 * @param {string} [actorId]
 * @returns {any}
 */
function publicBattleEventFor(entry, state, actorId = '') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
  const result = { ...entry }
  const targetId = text(entry.targetId ?? entry.target_id, 120)
  const actingId = text(entry.actorId ?? entry.actor_id, 120)
  const enemyIds = new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  if (enemyIds.has(targetId) && !exactEnemyHealthKnown(state, targetId, actorId)) {
    delete result.hpBefore
    delete result.hpAfter
    delete result.maximumHpBefore
    delete result.maximumHpAfter
    if (result.roll && typeof result.roll === 'object') {
      result.roll = { ...result.roll }
      delete result.roll.difficulty
    }
  }
  // Спасбросок бросает цель, а не тот, кто записан действующим лицом: в записи
  // `spell-save` actorId — это заклинатель-герой. Поэтому проверки «враг
  // действует» мало, иначе модификатор характеристики врага виден игроку.
  const rollBelongsToTarget = TARGET_ROLL_BATTLE_LOG_TYPES.has(text(entry.type, 40))
  if (result.roll && typeof result.roll === 'object'
    && (enemyIds.has(actingId) || (rollBelongsToTarget && enemyIds.has(targetId)))) {
    result.roll = {
      total: integer(result.roll.total, 0),
      hit: result.roll.hit === true,
    }
    delete result.rollDice
  }
  return result
}

/**
 * @param {Loose} message
 * @returns {any}
 */
function publicCombatMessageFor(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message
  const isCombatMessage = String(message.id ?? '').startsWith('combat-') || String(message.author ?? '').toLocaleLowerCase('ru').includes('система боя')
  if (!isCombatMessage || typeof message.text !== 'string') return message
  return {
    ...message,
    text: message.text
      .replace(/\s+против КД\s+\d+\s+—/gu, ' —')
      .replace(/;\s*ОЗ\s+\d+\s*→\s*\d+/gu, '')
      .replace(/,\s*но Охрана от смерти срабатывает и оставляет 1 ОЗ/gu, ', но Охрана от смерти удерживает цель на ногах')
      .replace(/Максимум ОЗ ([^.]+?) снижается:\s*\d+\s*→\s*\d+/gu, 'Максимум ОЗ $1 снижается'),
  }
}

/**
 * @param {Loose} [encounter]
 * @returns {Loose | null}
 */
export function publicEncounterFor(encounter = {}) {
  if (!encounter || typeof encounter !== 'object' || Array.isArray(encounter)) return null
  return {
    id: text(encounter.id ?? encounter.encounter_id, 120),
    status: ['staged', 'active', 'ended'].includes(String(encounter.status)) ? String(encounter.status) : 'staged',
    difficulty: text(encounter.difficulty, 40),
    // Качественная оценка «на глаз» для стола. Числа бюджета остаются в
    // `threat` и в интерфейсе игрокам не показываются.
    difficulty_label: encounterDifficultyLabel(encounter.difficulty),
    theme: text(encounter.theme, 40),
    proposal_id: text(encounter.proposal_id, 120),
    enemy_ids: (Array.isArray(encounter.enemy_ids) ? encounter.enemy_ids : []).map((id) => text(id, 120)).filter(Boolean).slice(0, 12),
    threat: encounter.threat && typeof encounter.threat === 'object' ? {
      budget_xp: Math.max(0, integer(encounter.threat.budget_xp, 0)),
      spent_xp: Math.max(0, integer(encounter.threat.spent_xp, 0)),
      quantity: Math.max(0, integer(encounter.threat.quantity, 0)),
    } : undefined,
  }
}

/**
 * @param {Loose} window
 * @param {LooseState} [state]
 * @param {string} [actorId]
 * @returns {Loose | null}
 */
function publicReactionWindowFor(window, state = {}, actorId = '') {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return null
  const enemyIds = new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  const targetId = text(window.target_id, 120)
  const enemyTarget = enemyIds.has(targetId)
  const enemySource = enemyIds.has(text(window.source_actor_id, 120))
  // Поля ниже удаляются выборочно, поэтому тип объявлен свободным: игрок не
  // должен видеть СЛ по врагу и внутренние слагаемые вражеского броска.
  /** @type {Loose | null} */
  const triggerRoll = window.trigger_roll && typeof window.trigger_roll === 'object'
    ? {
      kept: integer(window.trigger_roll.kept, 0),
      modifier: integer(window.trigger_roll.modifier, 0),
      total: integer(window.trigger_roll.total, 0),
      difficulty: Math.max(0, integer(window.trigger_roll.difficulty, 0)),
      ability: text(window.trigger_roll.ability, 20),
      save_event_type: text(window.trigger_roll.save_event_type, 80),
    }
    : null
  if (triggerRoll && enemyTarget) delete triggerRoll.difficulty
  if (triggerRoll && enemySource) {
    delete triggerRoll.kept
    delete triggerRoll.modifier
  }
  const damage = window.damage && typeof window.damage === 'object' ? { ...window.damage } : null
  if (damage && enemyTarget && !exactEnemyHealthKnown(state, targetId, actorId)) {
    for (const key of ['hp', 'max_hp', 'hp_before', 'hp_after', 'maximum_hp_before', 'maximum_hp_after', 'temporary_hp_before', 'temporary_hp_after']) delete damage[key]
  }
  return {
    id: text(window.id, 160),
    trigger: text(window.trigger, 80),
    actor_id: text(window.actor_id, 120),
    source_actor_id: text(window.source_actor_id, 120),
    target_id: text(window.target_id, 120),
    action_ids: (Array.isArray(window.action_ids) ? window.action_ids : []).map((id) => text(id, 120)).filter(Boolean).slice(0, 20),
    action_options: (Array.isArray(window.action_options) ? window.action_options : []).slice(0, 20).map((option) => ({
      id: text(option?.id, 120),
      name: text(option?.name, 160),
      description: text(option?.description, 500),
      ...(option?.resource == null ? {} : { resource: text(option.resource, 120) }),
      ...(option?.cost == null ? {} : { cost: Math.max(0, integer(option.cost, 0)) }),
    })),
    ...(triggerRoll ? { trigger_roll: triggerRoll } : {}),
    ...(window.fighter_level == null ? {} : { fighter_level: Math.max(1, integer(window.fighter_level, 1)) }),
    ...(damage ? { damage } : {}),
    ...(window.pending_spell && typeof window.pending_spell === 'object' ? { pending_spell: { ...window.pending_spell } } : {}),
  }
}

/**
 * Автономный слой — рабочая память Ведущего, а не состояние отряда.
 *
 * До 2026-07-28 он уезжал игроку целиком: `hooks` — заготовленные повороты
 * сюжета, то есть прямые спойлеры; `npc_schedules` — где и когда будет NPC,
 * включая нераскрытые расписания; `director_history` и `director_outcomes` —
 * замысел и рассуждения Режиссёра; `witness_graph` — кто что видел.
 * Раскрытие любого из них обесценивает игру ещё до того, как она случилась.
 *
 * Наружу выходит ровно то, что отряд пережил сам: темп сцены, свои переходы и
 * привалы, слава у фракций. Граница проходит не по «интересности», а по
 * источнику: путь и отдых отряд прожил, а замысел Режиссёра — нет. Слава идёт
 * ступенями, не числом: тот же приём, что и с ОЗ врага, — отряд чувствует
 * отношение, а не читает счёт.
 *
 * @param {Loose | null | undefined} autonomy
 * @returns {Loose | undefined}
 */
function publicAutonomyFor(autonomy) {
  if (!autonomy || typeof autonomy !== 'object' || Array.isArray(autonomy)) return undefined
  const pacing = autonomy.pacing && typeof autonomy.pacing === 'object' && !Array.isArray(autonomy.pacing)
    ? autonomy.pacing
    : {}
  const reputations = autonomy.reputations && typeof autonomy.reputations === 'object' && !Array.isArray(autonomy.reputations)
    ? autonomy.reputations
    : {}
  return {
    schema_version: autonomy.schema_version,
    pacing: {
      beat: Math.max(0, integer(pacing.beat, 0)),
      phase: ['breather', 'development', 'escalation', 'climax'].includes(pacing.phase) ? pacing.phase : 'breather',
      tension: Math.max(0, Math.min(100, integer(pacing.tension, 0))),
    },
    travel_history: (Array.isArray(autonomy.travel_history) ? autonomy.travel_history : []).slice(-20),
    downtime_history: (Array.isArray(autonomy.downtime_history) ? autonomy.downtime_history : []).slice(-20),
    reputation_standing: Object.entries(reputations).slice(0, 100).map(([factionId, score]) => ({
      faction_id: text(factionId, 120),
      tier: reputationTier(score),
    })).filter((entry) => entry.faction_id),
  }
}

/**
 * Ключи состояния, для которых у проекции есть осознанное решение: либо своя
 * публичная форма, либо явное «отдаём как есть, здесь нечего скрывать».
 *
 * Сторож существует потому, что проекция собирается спредом с последующим
 * переопределением по доменам: новый ключ верхнего уровня проходит **сырым**,
 * и никто этого не замечает. Ровно так утёк `autonomy`. Появился новый ключ —
 * тест падает и требует решения, а не молчаливой утечки.
 */
export const PROJECTED_STATE_KEYS = Object.freeze([
  // Своя публичная форма.
  'scene', 'adventure', 'worldMap', 'worldMemory', 'social', 'merchants', 'scene_npcs',
  // Внутренний реестр точных HP и всех location posts наружу не копируется:
  // вместо него ниже собирается bounded `scene_npcs` только текущей сцены.
  'npc_world',
  // Летопись поступков отряда со свидетелями и сроком рождения молвы. Наружу не
  // копируется вовсе: игрок узнаёт слух в игре, из уст NPC, а не читая
  // состояние. Публичной формы у неё нет и не должно быть.
  'world_deeds',
  // Лента ходов мира «Пока вас не было…». Форма у ведущего и у стола одна и та
  // же, и это решение, а не упущение: ход мира — монтаж для всего стола, и
  // модуль по построению кладёт в него только party-видимые задания, фракции и
  // NPC (`server/offscreen-world.mjs`). Прятать от игрока то, что ему же
  // показывает карточка летописи, было бы враньём в обе стороны.
  //
  // «По построению» здесь значит три фильтра `visibleToParty` на входе в ход
  // мира — и ничего больше: второй формы у ленты нет, поэтому утечка была бы
  // сквозной и молчаливой. Фильтры закреплены поимённо в
  // `test/offscreen-world.test.mjs` («тайные нити ведущего в ход мира не
  // попадают»); эта строка держится на том тесте.
  'offscreen_world',
  // Почта отряда. Сырой она наружу не идёт: в записи письма лежит запечатанный
  // ответ — черновик модели и тон адресата, — и отдавать его до прихода письма
  // значило бы показать игроку ответ раньше, чем его написали. Наружу уезжает
  // публичная форма (`courierLettersForViewer`, `server/courier-letters.mjs`),
  // где ответ появляется только вместе со статусом «получен ответ».
  'courier_letters',
  // Реестр пленных: отряду он принадлежит целиком, кроме одного — того, чего
  // пленный ещё не сказал. `known_fact_ids` остаётся у ведущего, иначе допрос
  // перестал бы быть проверкой: игрок читал бы ответ прямо из состояния.
  'captives',
  // Реестр зверей: отряду он принадлежит целиком, кроме стат-блока и CR. Их
  // вырезает публичная форма (`beastsForViewer`, `server/beast-taming.mjs`) по
  // той же причине, по которой их вырезает запись пленного: подойти к волку —
  // не то же самое, что опознать его как строку бестиария.
  'beasts',
  // Реестр закона: ступень розыска, очки и список преступлений принадлежат
  // ведущему целиком. Игроку уезжает только то, что он и так видит в игре, —
  // стража, которая уже стоит перед ним, и приметы мира вокруг. Цифры розыска
  // в публичной форме нет и быть не должно: она превратила бы поиск выхода в
  // арифметику.
  'law',
  // Счёт заведения: открытый раунд, кружки и скандалы всех героев. Сырым он
  // наружу не идёт — вместо него собирается карточка под конкретного зрителя
  // (`tavernForViewer`, `server/tavern-life.mjs`), где нет ни чужого счёта, ни
  // характера соперника. Характера в состоянии нет и вовсе: честен сосед по
  // столу или шулер, выводится из сида кампании в момент вопроса, поэтому
  // утечь ему неоткуда даже при ошибке в проекции.
  'tavern',
  // Время суток и погода. Собственного ключа в состоянии нет: обе величины
  // выводятся из мировых минут и сида кампании (`server/weather.mjs`) и
  // существуют только в проекции. Решение осознанное и в обе стороны одинаковое:
  // небо над отрядом видно всем, и прятать его от игрока значило бы врать.
  'weather',
  'enemies', 'mechanics', 'battleLog', 'messages', 'autonomy',
  // Собственного ключа в состоянии нет: подсказки выводятся из уже собранной
  // комнаты и существуют только в проекции. Решение осознанное — скрытого в
  // них быть не может, потому что вход у них тот же, что уехал игроку.
  'suggested_actions',
  // Отдаются как есть: общий контекст отряда без скрытого.
  'sessionCode', 'campaign', 'partyName', 'partyMemberIds', 'partyDecisionPolicy',
  'campaignConcept', 'state_version', 'ruleset_id', 'ruleset_version',
  'enabled_rule_packs', 'enabled_house_rules', 'ruleset_locked_at', 'engine_mode',
  'players', 'entities', 'mapFeedback', 'rulings', 'activePlayerId', 'tacticalTurn',
  'isNarrating', 'pendingCheck', 'agentInteraction', 'lastDiceRoll',
  'actors', 'economyLog', 'state_projector_version', 'presence', 'turn_clock', 'locationMaps',
])

/**
 * @param {LooseState | null | undefined} state
 * @param {Loose | null | undefined} user
 * @param {string} actorId
 * @returns {Viewer}
 */
function viewerFor(state, user, actorId) {
  return {
    role: user?.role === 'admin' ? 'admin' : 'player',
    playerId: String(actorId ?? ''),
    partyIds: Array.isArray(state?.partyMemberIds) ? state.partyMemberIds.map(String) : [],
    isPartyMember: true,
  }
}

/**
 * @param {Loose[]} players
 * @returns {Loose[]}
 */
function playerItemsWithCapabilities(players) {
  return (Array.isArray(players) ? players : []).map((player) => ({
    ...player,
    inventory: (Array.isArray(player?.inventory) ? player.inventory : []).map((item) => {
      const capabilities = itemViewerCapabilities(item)
      return capabilities ? { ...item, capabilities } : item
    }),
  }))
}

/**
 * Produces a non-admin campaign projection shared by room, command and narration
 * responses. It is deliberately stricter than the internal event-sourced state.
 *
 * @param {LooseState | null | undefined} state
 * @param {Loose | null | undefined} user
 * @param {string} [actorId]
 * @returns {any}
 */
export function campaignStateForViewer(state, user, actorId = '') {
  if (!state || typeof state !== 'object') return state
  if (user?.role === 'admin') return {
    ...state,
    players: playerItemsWithCapabilities(state.players),
    // Летопись поступков уезжает ведущему уже лентой: свежие сверху, с русской
    // подписью вида и числом свидетелей. Сортировка и таблица подписей живут в
    // одном месте — на сервере, рядом с `DEED_KINDS`. Карточка админки раньше
    // держала свои копии обеих, и они расходились молча.
    //
    // Лента ограничена: карточка показывает дюжину, а состояние держит до двух
    // сотен поступков, и слать их целиком в каждом кадре комнаты незачем.
    ...(state.world_deeds ? { world_deeds: { schema_version: WORLD_DEEDS_SCHEMA_VERSION, deeds: worldDeedsFeed(state, { limit: 40 }) } } : {}),
    // Ходы мира уезжают лентой ровно так же: свежие сверху, с русской подписью
    // вида. Своей таблицы подписей карточка админки не держит.
    ...(state.offscreen_world
      ? { offscreen_world: { schema_version: OFFSCREEN_WORLD_SCHEMA_VERSION, steps: offscreenWorldFeed(state, { limit: 20 }) } }
      : {}),
    // Почта ведущему приезжает той же карточкой, что и столу, плюс тон, по
    // которому соберётся ответ: за столом ведущий видит письма своих игроков,
    // и вторая форма панели была бы вторым ответом на один вопрос. Сам текст
    // ответа не приезжает и ему — до прихода письма его нет ни у кого.
    courier_letters: courierLettersForViewer(state, { isAdmin: true }),
    // Розыск уезжает ведущему уже лентой по краям: ступень, подпись, очки и
    // срок затухания считаются на сервере рядом с политикой. Карточка админки
    // своей таблицы порогов не держит — две копии расходились бы молча.
    law: lawForViewer(state, { isAdmin: true }),
    // Звери ведущему приезжают той же карточкой, что и столу, плюс стат-блок и
    // CR: за столом он видит зверя глазами игрока, а в записи реестра — то, из
    // чего сложилась объявленная СЛ.
    beasts: beastsForViewer(state, { isAdmin: true }),
    // Заведение ведущий видит той же карточкой, что и игрок: за столом он сидит
    // своим героем, и вторая форма панели для него была бы вторым ответом на
    // один вопрос. Характер соперника не приезжает и сюда — его нет в состоянии
    // вовсе, он выводится из сида в момент вопроса.
    tavern: tavernForViewer(state, { playerId: String(actorId ?? '') }),
    // Небо у ведущего и у игрока одно и то же: время суток и погода выводятся
    // из минут кампании и сида, тайной ведущего они не являются.
    weather: weatherForViewer(state),
    mechanics: {
      ...(state.mechanics ?? {}),
      hit_point_dice: Object.fromEntries((state.players ?? []).map((/** @type {Loose} */ player) => [String(player.id), hitPointDicePoolForActor(state, player.id)])),
    },
  }
  // `locationMaps` содержит ещё одну полную копию каждой тактической карты, а
  // `scene` ниже всё равно пересобирается строгим whitelist-проектором.
  // Не копируем одни и те же 10 000 клеток рекурсивно, чтобы тут же заменить
  // результат их публичной формой.
  const {
    locationMaps: _privateLocationMaps,
    scene: _privateScene,
    ...projectableState
  } = state
  const visible = projectVisibleState(projectableState, viewerFor(state, user, actorId), { forNarrator: true }) ?? {}
  // `npc_world` — внутренний реестр точных HP, постов и инвентарей NPC. Он
  // обязан исчезнуть из публичной проекции целиком; сторож — проверка
  // `authoritative_state.npc_world === undefined` в
  // `test/npc-item-transfer-api.test.mjs`.
  // `levelEntities` — стэш жителей неактивных этажей: точные HP противников,
  // незакрытое столкновение и посты NPC другого яруса. Игроку он не
  // принадлежит и обязан исчезнуть целиком, как `locationMaps` и `npc_world`.
  // `world_deeds` — летопись поступков отряда со списком свидетелей и сроком
  // рождения слуха. Она принадлежит ведущему: игрок узнаёт о молве в игре, из
  // уст NPC, а не из собственной проекции состояния.
  // `law` — реестр закона: ступень розыска, очки и все преступления отряда.
  // Наружу он идёт только своей публичной формой (`lawForViewer` ниже), потому
  // что цифра ступени игроку не принадлежит: розыск он узнаёт по офицеру перед
  // собой и по тому, как на него смотрит улица.
  // `tavern` — счёт заведения: чужие кружки, чужие скандалы и открытый раунд
  // соседа по столу. Наружу он идёт только своей публичной формой
  // (`tavernForViewer` ниже), собранной под конкретного героя.
  // `courier_letters` — почта отряда с запечатанными ответами. Наружу она идёт
  // только своей публичной формой (`courierLettersForViewer` ниже): черновик
  // ответа и тон адресата лежат в записи письма с минуты отправки, и сырой
  // ключ показал бы игроку ответ раньше, чем письмо доехало.
  const {
    locationMaps: _locationMaps,
    npc_world: _npcWorld,
    levelEntities: _levelEntities,
    world_deeds: _worldDeeds,
    law: _law,
    tavern: _tavern,
    courier_letters: _courierLetters,
    ...publicState
  } = visible
  const currentLocationId = String(state.scene?.location_id ?? state.scene?.locationId ?? state.worldMap?.currentLocationId ?? '')
  const scene = publicSceneFor(state.scene, state.locationLevels?.[currentLocationId])
  const location = scene.location
  const merchants = (Array.isArray(visible.merchants) ? visible.merchants : [])
    .filter((/** @type {Loose} */ merchant) => merchant.available !== false && merchantIsAtLocation(merchant, state?.scene ?? location))
    .map(publicMerchantFor)
  const enemies = (Array.isArray(visible.enemies) ? visible.enemies : []).map((/** @type {Loose} */ enemy) => publicEnemyFor(enemy, state, actorId))
  const mechanics = visible.mechanics && typeof visible.mechanics === 'object'
    ? (() => {
      const { enemy_knowledge: _enemyKnowledge, ...publicMechanics } = visible.mechanics
      return {
      ...publicMechanics,
      ...(actorId ? { hit_point_dice: { [actorId]: hitPointDicePoolForActor(state, actorId) } } : { hit_point_dice: {} }),
      encounter: publicEncounterFor(visible.mechanics.encounter),
      ...(visible.mechanics.combat && typeof visible.mechanics.combat === 'object' ? {
        combat: {
          ...visible.mechanics.combat,
          initiative: publicInitiativeFor(visible.mechanics.combat.initiative, state, actorId),
          reaction_window: publicReactionWindowFor(visible.mechanics.combat.reaction_window, state, actorId),
        },
      } : {}),
    }})()
    : visible.mechanics
  const room = {
    ...publicState,
    players: playerItemsWithCapabilities(publicState.players),
    scene,
    adventure: publicAdventureFor(visible.adventure),
    worldMap: publicWorldMapFor(visible.worldMap ?? state.worldMap),
    worldMemory: worldMemoryForViewer(state.worldMemory, {
      playerId: String(actorId ?? ''),
      isAdmin: false,
      isPartyMember: true,
    }),
    social: npcSocialForViewer(state.social, {
      playerId: String(actorId ?? ''),
      isAdmin: false,
      isPartyMember: true,
      state,
    }),
    scene_npcs: sceneNpcsForViewer(state),
    captives: captivesForViewer(state, { isAdmin: false }),
    // Звери сцены и спутники отряда: кого можно уговорить, против какой СЛ и из
    // чего она сложилась. Карточку собирает сервер целиком — второй формулы
    // сложности у клиента не появляется.
    beasts: beastsForViewer(state, { isAdmin: false }),
    law: lawForViewer(state, { isAdmin: false }),
    // Жизнь таверны: с кем можно сыграть, какие ставки открыты, сколько стоит
    // кружка и чем грозит следующая. Карточку собирает сервер целиком —
    // клиенту нечего досчитывать, и характера соперника в ней нет.
    tavern: tavernForViewer(state, { playerId: String(actorId ?? '') }),
    // Ход мира едет столу той же лентой, что и ведущему: карточка «Пока вас не
    // было…» показывается всем, и вторая форма для неё была бы вторым ответом
    // на один вопрос.
    offscreen_world: { schema_version: OFFSCREEN_WORLD_SCHEMA_VERSION, steps: offscreenWorldFeed(state, { limit: 20 }) },
    // Почта отряда: кому уже написали, где сейчас курьер, сколько стоит письмо
    // каждому известному адресату. Карточку собирает сервер целиком — клиенту
    // нечего досчитывать, а запечатанного ответа в ней нет.
    courier_letters: courierLettersForViewer(state, { isAdmin: false }),
    // Время суток и погода — то, что герой видит, подняв голову. Строка
    // индикатора и подписи действующих помех приходят готовыми: своей таблицы
    // ни у клиента, ни у проекции нет.
    weather: weatherForViewer(state),
    merchants,
    enemies,
    mechanics,
    battleLog: (Array.isArray(visible.battleLog) ? visible.battleLog : []).map((/** @type {Loose} */ entry) => publicBattleEventFor(entry, state, actorId)),
    messages: (Array.isArray(visible.messages) ? visible.messages : []).map(publicCombatMessageFor),
    ...(publicAutonomyFor(state.autonomy) ? { autonomy: publicAutonomyFor(state.autonomy) } : {}),
  }
  // Подсказки строятся из **уже собранной** комнаты, а не из авторитетного
  // состояния. Порядок здесь и есть гарантия: раскрыть скрытое подсказка не
  // может по построению — чего нет в проекции, того нет и на её входе.
  return { ...room, suggested_actions: suggestedActionsFor(room) }
}

/**
 * @param {Loose} event
 * @param {Loose | null | undefined} user
 * @param {string} actorId
 * @param {LooseState} [state]
 * @returns {Loose | null}
 */
function eventForViewer(event, user, actorId, state = {}) {
  const visible = projectVisibleState(event, viewerFor(state, user, actorId), { forNarrator: true })
  if (!visible) return null
  const payload = visible.payload && typeof visible.payload === 'object' && !Array.isArray(visible.payload)
    ? { ...visible.payload }
    : {}
  if (visible.event_type === 'SceneAdvanced') {
    payload.scene = publicSceneFor(payload.scene)
    payload.adventure = publicAdventureFor(payload.adventure)
    payload.worldMap = publicWorldMapFor(payload.worldMap)
  }
  // Первое событие этажа несёт карту целиком, и она нераскрыта. Отдавать её
  // игроку как есть означало бы показать весь ярус сразу — карта проходит тот
  // же обезличивающий проектор, что и карта сцены.
  if (visible.event_type === 'MapLevelChanged' && payload.map) {
    const projectedLevel = publicTacticalMapWithHashFor(payload.map)
    if (projectedLevel) {
      payload.map = projectedLevel.map
      payload.map_hash = projectedLevel.hash
    } else delete payload.map
  }
  if (visible.event_type === 'MerchantCreated' && payload.merchant) {
    payload.merchant = publicMerchantFor(payload.merchant)
  }
  if (visible.event_type === 'EncounterCreated' && payload.encounter) {
    payload.encounter = {
      ...publicEncounterFor(payload.encounter),
      enemies: (Array.isArray(payload.encounter.enemies) ? payload.encounter.enemies : []).map((/** @type {Loose} */ enemy) => publicEnemyFor(enemy, state, actorId)),
    }
  }
  // Закон. Ступень розыска и реестр преступлений не принадлежат игроку ни в
  // проекции состояния, ни в канале событий: до ревью 2026-08-09 состояние
  // чистилось, а те же числа уезжали игроку событиями той же команды —
  // `GuardEncounterResolved` с `level`, `WantedCleared` с `level_before` и
  // полным списком `crime_ids`, `GuardEncounterStarted` со всей встречей.
  // Карточку встречи собирает та же функция, что и проекция состояния.
  if (visible.event_type === 'GuardEncounterStarted') {
    payload.encounter = publicGuardEncounterFor(payload.encounter)
  }
  if (visible.event_type === 'GuardEncounterResolved') delete payload.level
  if (visible.event_type === 'WantedCleared') {
    for (const key of ['level_before', 'crime_ids']) delete payload[key]
  }
  if (visible.event_type === 'WantedLevelRaised') delete payload.crime
  // Таверна. Запись раунда несёт только то, что лежит на столе: чужая кость,
  // ставка и число, которое надо перебить. Характер соперника в неё и не
  // пишется — но ветка стоит здесь по тому же правилу, что и у стражи: карточку
  // для канала событий собирает **та же** функция, что и для проекции
  // состояния, иначе два ответа на один вопрос разойдутся при первой правке.
  if (visible.event_type === 'TavernDiceRoundOpened' && payload.round) {
    const round = publicTavernRoundFor(payload.round)
    if (round) payload.round = round
    else delete payload.round
  }
  // Та же дыра с другой стороны стола: карточка заведения кассу соседа прячет
  // намеренно (`tavernForViewer` отдаёт только `max_stake_cp` — доступную
  // ставку, а не сумму в кармане), а расчёт раунда уезжал игроку с
  // `npc_purse_before_cp` и `npc_purse_after_cp` в party-канале. Точные суммы
  // читаются как бухгалтерия соседа и решают за игрока то, что он должен
  // решать сам: садиться ли с этим человеком за стол ещё раз. Доступная ставка
  // после расчёта приезжает проекцией состояния тем же числом, что и до него.
  //
  // Отмена раунда режется тем же списком и по той же причине: ставка сдавшегося
  // уезжает в кассу соседа, и событие несёт её обе суммы наравне с расчётом.
  //
  // Доля заведения (`house_cut_cp`) уходит с ними же: она появляется ровно на
  // потолке чужой кассы, то есть её число — это дословно «у соседа уже сто
  // золотых». Своя потеря игроку и так названа (`forfeited_cp`, `net_cp`).
  if (visible.event_type === 'TavernDiceRoundResolved' || visible.event_type === 'TavernDiceRoundCancelled') {
    for (const key of ['npc_purse_before_cp', 'npc_purse_after_cp', 'house_cut_cp']) delete payload[key]
  }
  // Почта. Отправленное письмо несёт запись целиком, а в записи с первой минуты
  // лежит запечатанный ответ: черновик модели, тон адресата и провайдер. Игроку
  // всё это принадлежать не может — иначе он прочёл бы ответ в тот же миг, когда
  // отдал письмо курьеру, и вся дуга ожидания исчезла бы вместе с ним.
  //
  // Режет та же функция, что и проекция состояния (`courierLetterForViewer`,
  // `server/courier-letters.mjs`): производитель события один, но два ответа на
  // один вопрос разошлись бы при первой же правке — так уже было у стражи и у
  // стола с костями.
  if (visible.event_type === 'CourierLetterSent' && payload.letter) {
    const letter = courierLetterForViewer(payload.letter)
    if (letter) payload.letter = letter
    else delete payload.letter
  }
  // Доставка объявляет тон, по которому соберётся ответ. Тон — это дословно
  // «как к вам относится адресат», а отношение игроку числом не показывают
  // нигде: он читает его по ответу, когда тот придёт.
  //
  // Порог тот же, что у публичной формы письма (`courierLetterForViewer`): у
  // ведущего тон есть всегда, у игрока — только вместе с ответом, потому что
  // скрывать после ответа уже нечего. До ревью здесь стояло безусловное
  // `delete`, и лента событий ведущего была беднее его же карточки состояния, а
  // у игрока пришедший ответ приезжал с тоном в проекции и без тона в событии:
  // один вопрос — два разных ответа.
  if (visible.event_type === 'CourierLetterDelivered' && user?.role !== 'admin') delete payload.tone
  if (visible.event_type === 'EncounterOutcomeRecorded') {
    delete payload.plan
    delete payload.prepared_reward
  }
  if (visible.event_type === 'EncounterCoinsRolled') {
    payload.rolls = (Array.isArray(payload.rolls) ? payload.rolls : []).map((/** @type {Loose} */ roll) => ({
      roll_id: text(roll?.roll_id, 160),
      expression: text(roll?.expression, 40),
      dice: (Array.isArray(roll?.dice) ? roll.dice : []).map((/** @type {unknown} */ value) => integer(value, 0)).slice(0, 12),
      total: integer(roll?.total, 0),
      amount_cp: integer(roll?.amount_cp, 0),
    }))
  }
  if (visible.event_type === 'NpcPlaced') delete payload.vitality
  if (visible.event_type === 'NpcHarmed') {
    for (const key of ['hp', 'max_hp', 'hp_before', 'hp_after', 'raw_amount']) delete payload[key]
  }
  // Профиль NPC. До ревью 2026-08-09 ветки здесь не было вовсе, и
  // `NpcSocialProfileUpserted` уезжал игроку сырым: `goals`, `beliefs`,
  // `known_fact_ids` и `social_dcs` — то есть и СЛ социальных проверок, которые
  // ниже в этой же функции прячутся даже у `AbilityCheckResolved`. Проекция
  // состояния при этом чистила тот же профиль честно, так что состояние и канал
  // событий расходились молча.
  //
  // Режет тот же белый список, что и проекция состояния
  // (`npcProfileForViewerAt`, `server/npc-social.mjs`). Место правки выбрано
  // тем, что производителей у события пять и живут они в четырёх модулях:
  // команда `UpsertNpcSocialProfile` (`server/npc-social.mjs`), увод заложника
  // ходом мира (`server/offscreen-world.mjs`), профиль нового пленного и его
  // переезд вместе с отрядом (`server/captives.mjs`, два места) и профиль
  // предводителя под парлеем (`server/rules-engine.mjs`). Санитайзер по месту
  // потребовал бы пяти одинаковых правок и промолчал бы у шестого; точный
  // список на сегодня — `grep -rn "NpcSocialProfileUpserted" server/`.
  //
  // Своей проверки видимости здесь нет и не нужно — но не потому, что «нет
  // живых производителей с закрытым NPC»: `projectVisibleState` выше уже
  // выбросил узел `payload.npc` целиком по его собственной `visibility`, и на
  // party-видимом событии о `gm_only`-NPC игрок получает `payload: {}`.
  // Поэтому `&& payload.npc` — не косметика, а единственный сторож ветки:
  // снять его значит уронить проекцию на пустом payload.
  if (visible.event_type === 'NpcSocialProfileUpserted' && payload.npc) {
    payload.npc = npcProfileForViewerAt(payload.npc, {
      playerId: String(actorId ?? ''),
      isAdmin: false,
      isPartyMember: true,
      state,
    })
  }
  // Пленный. Та же дыра и то же лечение: `CaptiveTaken` несёт целиком запись
  // реестра, а белый список отряда (`captiveForViewer`, `server/captives.mjs`
  // — та же функция, что стоит под проекцией состояния) вырезает из неё
  // `stat_block_id`, `xp` и `known_fact_ids`: стат-блок в обход опознания врага
  // (`publicEnemyFor` ниже отдаёт его только по факту `stat_block` в знании
  // отряда), XP как чистое метаигровое число и неразвязанные ниточки допроса.
  // До ревью 2026-08-09 всё это уезжало игроку событием, пока проекция
  // состояния честно молчала.
  if (visible.event_type === 'CaptiveTaken' && payload.captive) {
    const forViewer = captiveForViewer(payload.captive)
    if (forViewer) payload.captive = forViewer
    else delete payload.captive
  }
  // Зверь. Та же дыра и то же лечение третий раз: `BeastEncountered` несёт
  // целиком запись реестра, а `beastForViewer` (`server/beast-taming.mjs` — та
  // же функция, что стоит под проекцией состояния) вырезает `stat_block_id` и
  // `challenge_rating`. Причина ровно та же, что у пленного: опознание врага
  // закрыто знанием отряда, и подойти к волку — не то же самое, что узнать в
  // нём волка из бестиария с CR 1/4.
  if (visible.event_type === 'BeastEncountered' && payload.beast) {
    const forViewer = beastForViewer(payload.beast)
    if (forViewer) payload.beast = forViewer
    else delete payload.beast
  }
  const targetIds = (Array.isArray(visible.target_ids) ? visible.target_ids : []).map(String)
  if (['HitPointDieSpent', 'HitPointDiceRestored'].includes(String(visible.event_type))
    && String(visible.actor_id ?? '') !== String(actorId)
    && !targetIds.includes(String(actorId))) {
    for (const key of ['pool_before', 'pool_after', 'restored']) delete payload[key]
  }
  const enemyIds = new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  const enemyTargetId = targetIds.find((/** @type {string} */ id) => enemyIds.has(id)) ?? (enemyIds.has(String(payload.target_id ?? '')) ? String(payload.target_id) : '')
  const enemyActor = enemyIds.has(String(visible.actor_id ?? ''))
  if (enemyTargetId && !exactEnemyHealthKnown(state, enemyTargetId, actorId)) {
    for (const key of ['hp', 'max_hp', 'hp_before', 'hp_after', 'maximum_hp', 'maximum_hp_before', 'maximum_hp_after', 'temporary_hp_before', 'temporary_hp_after', 'armor_class']) delete payload[key]
  }
  // Игрок видит сам исход (сопротивление, иммунитет или отменённый крит), но
  // закрытый инвентарь противника не становится каталогом предметов через
  // публичную механику события. Полный provenance остаётся у администратора.
  if (enemyTargetId) {
    for (const key of ['item_resistance_sources', 'item_immunity_sources', 'critical_protection_sources']) delete payload[key]
  }
  if (visible.event_type === 'CombatStarted') {
    payload.initiative = publicInitiativeFor(payload.initiative, state, actorId)
  }
  if (enemyActor) {
    for (const key of [
      'modifier', 'kept', 'attack_bonus', 'damage_expression', 'damage_dice', 'action_id', 'dice', 'expression',
      'item_id', 'item_name', 'catalog_id', 'effect_id',
    ]) delete payload[key]
  }
  // Спасбросок и проверку бросает цель, а не тот, кто записан действующим лицом:
  // у SpellSavingThrowResolved actor_id — это заклинатель-герой. Формула
  // `1d20+4` называет модификатор так же прямо, как само поле modifier, поэтому
  // expression убирается вместе с ним. Итог и СЛ остаются: игрок обязан видеть,
  // устоял враг или нет.
  if (enemyTargetId && TARGET_ROLL_EVENT_TYPES.has(String(visible.event_type))) {
    for (const key of ['modifier', 'kept', 'dice', 'roll_id', 'expression']) delete payload[key]
  }
  if (visible.event_type === 'AbilityCheckResolved' && payload.social_check) {
    delete payload.difficulty
    payload.social_check = {
      check_id: String(payload.social_check.check_id ?? ''),
      npc_id: String(payload.social_check.npc_id ?? ''),
      skill: String(payload.social_check.skill ?? payload.skill ?? ''),
      difficulty_hidden: true,
    }
  }
  if (visible.event_type === 'ReactionWindowOpened') {
    return { ...visible, payload: publicReactionWindowFor(payload, state, actorId) }
  }
  return { ...visible, payload }
}

/**
 * @param {Loose[]} events
 * @param {Loose | null | undefined} user
 * @param {string} [actorId]
 * @param {LooseState} [state]
 * @returns {any}
 */
export function mechanicsForViewer(events, user, actorId = '', state = {}) {
  if (!Array.isArray(events) || user?.role === 'admin') return events
  return events.map((event) => eventForViewer(event, user, actorId, state)).filter(Boolean)
}

/**
 * @param {Loose} roll
 * @param {Loose | null | undefined} user
 * @returns {boolean}
 */
function rollVisibleFor(roll, user) {
  if (user?.role === 'admin') return true
  return !['gm_only', 'npc_private'].includes(String(roll?.visibility ?? 'public'))
}

/**
 * @param {Loose | null | undefined} explanation
 * @param {Loose | null | undefined} user
 * @param {string} [actorId]
 * @param {LooseState} [state]
 * @returns {any}
 */
export function turnExplanationForViewer(explanation, user, actorId = '', state = {}) {
  if (!explanation || typeof explanation !== 'object' || user?.role === 'admin') return explanation
  const enemyIds = new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  return {
    ...explanation,
    commands: (Array.isArray(explanation.commands) ? explanation.commands : []).map((command) => {
      if (!enemyIds.has(String(command?.actor_id ?? ''))) return command
      return {
        type: text(command?.type ?? command?.command_type, 80),
        actor_id: text(command?.actor_id, 120),
        ...(command?.target_id == null ? {} : { target_id: text(command.target_id, 120) }),
      }
    }),
    rolls: (Array.isArray(explanation.rolls) ? explanation.rolls : []).filter((roll) => rollVisibleFor(roll, user)).map((roll) => {
      if (!enemyIds.has(String(roll?.actor_id ?? roll?.actorId ?? ''))) return roll
      return {
        roll_id: text(roll?.roll_id ?? roll?.id, 160),
        purpose: text(roll?.purpose, 80),
        total: integer(roll?.total, 0),
        visibility: text(roll?.visibility, 40),
      }
    }),
    events: mechanicsForViewer(explanation.events, user, actorId, state),
  }
}

/**
 * @param {Loose} transition
 * @returns {any}
 */
export function sceneTransitionForViewer(transition) {
  if (!transition || typeof transition !== 'object' || Array.isArray(transition)) return transition
  return {
    scene: publicSceneFor(transition.scene),
    adventure: publicAdventureFor(transition.adventure),
    worldMap: publicWorldMapFor(transition.worldMap),
    transition: text(transition.transition, 2_000),
    arrival: text(transition.arrival, 2_000),
    entrance: {
      x: integer(transition.entrance?.x),
      y: integer(transition.entrance?.y),
    },
  }
}

/** Sanitizes every public surface of a command/narration result consistently.
 * @param {Loose | null | undefined} result
 * @param {Loose | null | undefined} user
 * @param {string} [actorId]
 * @returns {any}
 */
export function turnResultForViewer(result, user, actorId = '') {
  if (!result || typeof result !== 'object' || user?.role === 'admin') return result
  const visible = projectVisibleState(result, viewerFor(result.authoritative_state, user, actorId), { forNarrator: true }) ?? {}
  const { locationMaps: _locationMaps, ...publicResult } = visible
  const effects = visible.effects && typeof visible.effects === 'object' && !Array.isArray(visible.effects)
    ? { ...visible.effects }
    : visible.effects
  if (effects?.scene) effects.scene = sceneTransitionForViewer(effects.scene)
  const enemyIds = new Set((result.authoritative_state?.enemies ?? []).map((/** @type {Loose} */ enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  if (effects?.roll && !rollVisibleFor(effects.roll, user)) {
    delete effects.roll
  } else if (effects?.roll && enemyIds.has(String(effects.roll.actor_id ?? ''))) {
    effects.roll = {
      roll_id: text(effects.roll.roll_id, 160),
      actor_id: text(effects.roll.actor_id, 120),
      total: integer(effects.roll.total, 0),
      label: text(effects.roll.label, 120),
      ...(typeof effects.roll.success === 'boolean' ? { success: effects.roll.success } : {}),
    }
  }
  return {
    ...publicResult,
    effects,
    mechanics: mechanicsForViewer(result.mechanics, user, actorId, result.authoritative_state),
    ...(Array.isArray(result.rolls) ? {
      rolls: result.rolls.filter((roll) => rollVisibleFor(roll, user)),
    } : {}),
    ...(Array.isArray(visible.visible_state_changes) ? {
      visible_state_changes: mechanicsForViewer(visible.visible_state_changes, user, actorId, result.authoritative_state),
    } : {}),
    ...(result.authoritative_state ? { authoritative_state: campaignStateForViewer(result.authoritative_state, user, actorId) } : {}),
  }
}
