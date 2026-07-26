// @ts-check

/**
 * Стадия 1 генератора сцены — граф зон (`docs/tactical-map-plan.md`, раздел 8).
 *
 * Из рецепта сцены строится граф: зоны, связи, двери, где лежат ключи, где вход
 * и цель. **Проверка достижимости и порядка получения ключей делается здесь**,
 * до всякой геометрии. Запертая дверь, ключ от которой лежит за ней же,
 * отсекается на графе, а не поиском по готовой карте.
 *
 * Модуль намеренно ничего не знает ни о клетках, ни о рёбрах, ни о карте: он
 * работает с топологией. Тот же граф используется для проверки достижимости
 * обязательных точек мира (`docs/world-map-plan.md`, раздел 8 — «написать один
 * раз и переиспользовать, а не дважды»).
 */

export const SCENE_GRAPH_VERSION = 'skazanie:scene-graph-v1'

/** Как связаны две зоны. */
export const LINK_KINDS = Object.freeze(['open', 'door', 'locked', 'secret', 'oneway'])

export class SceneGraphError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'SceneGraphError'
    this.code = code
  }
}

/**
 * @typedef {object} SceneZone
 * @property {string} id
 * @property {string} kind 'interior' | 'exterior'
 * @property {boolean} required обязана ли зона быть достижимой
 * @property {string[]} keys идентификаторы ключей, лежащих в этой зоне
 * @property {string} label
 */

/**
 * @typedef {object} SceneLink
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {string} kind значение из LINK_KINDS
 * @property {string|null} keyId для `locked` — чем открывается
 * @property {boolean} bidirectional
 */

/**
 * @typedef {object} SceneGraph
 * @property {string} version
 * @property {SceneZone[]} zones
 * @property {SceneLink[]} links
 * @property {string} entranceZoneId откуда входит отряд
 * @property {string} goalZoneId где цель сцены
 */

/**
 * @typedef {object} GraphIssue
 * @property {string} code
 * @property {string} message
 * @property {string} [at]
 */

/**
 * @param {unknown} value
 * @param {number} maximum
 * @returns {string}
 */
function text(value, maximum = 120) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

/**
 * @param {object} [input]
 * @returns {SceneGraph}
 */
export function createSceneGraph(input = {}) {
  const raw = /** @type {Record<string, any>} */ (input)
  /** @type {SceneGraph} */
  const graph = {
    version: SCENE_GRAPH_VERSION,
    zones: [],
    links: [],
    entranceZoneId: text(raw.entranceZoneId),
    goalZoneId: text(raw.goalZoneId),
  }
  for (const zone of Array.isArray(raw.zones) ? raw.zones : []) addSceneZone(graph, zone)
  for (const link of Array.isArray(raw.links) ? raw.links : []) addSceneLink(graph, link)
  return graph
}

/**
 * @param {SceneGraph} graph
 * @param {object} zone
 * @returns {SceneZone}
 */
export function addSceneZone(graph, zone) {
  const raw = /** @type {Record<string, any>} */ (zone ?? {})
  const id = text(raw.id)
  if (!id) throw new SceneGraphError('У зоны должен быть идентификатор', 'ZONE_ID_REQUIRED')
  /** @type {SceneZone} */
  const record = {
    id,
    kind: raw.kind === 'exterior' ? 'exterior' : 'interior',
    required: raw.required === true,
    keys: [...new Set((Array.isArray(raw.keys) ? raw.keys : []).map((key) => text(key)).filter(Boolean))],
    label: text(raw.label),
  }
  graph.zones.push(record)
  return record
}

/**
 * @param {SceneGraph} graph
 * @param {object} link
 * @returns {SceneLink}
 */
export function addSceneLink(graph, link) {
  const raw = /** @type {Record<string, any>} */ (link ?? {})
  const kind = LINK_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'open'
  const id = text(raw.id) || `${text(raw.from)}->${text(raw.to)}`
  /** @type {SceneLink} */
  const record = {
    id,
    from: text(raw.from),
    to: text(raw.to),
    kind,
    keyId: raw.keyId == null ? null : text(raw.keyId),
    // Односторонний проход по построению не двусторонний; всё остальное — да,
    // если явно не сказано иначе.
    bidirectional: kind === 'oneway' ? false : raw.bidirectional !== false,
  }
  if (!record.from || !record.to) throw new SceneGraphError('У связи должны быть обе стороны', 'LINK_ENDS_REQUIRED')
  graph.links.push(record)
  return record
}

/**
 * Проходима ли связь при имеющемся наборе ключей.
 *
 * @param {SceneLink} link
 * @param {Set<string>} keys
 * @returns {boolean}
 */
function linkPassable(link, keys) {
  if (link.kind === 'locked') return link.keyId != null && keys.has(link.keyId)
  // Секретный проход не запирает путь: он лишь не виден, пока не найден.
  // Отдельная механика поиска — не задача графа.
  return true
}

/**
 * Достижимость с учётом ключей: набор ключей растёт по мере продвижения, и
 * каждый новый ключ может открыть дверь, за которой лежит следующий. Обход
 * повторяется, пока набор растёт.
 *
 * @param {SceneGraph} graph
 * @param {string} [fromZoneId] по умолчанию — вход
 * @returns {{zones: Set<string>, keys: Set<string>, rounds: number}}
 */
export function reachableZones(graph, fromZoneId) {
  const start = text(fromZoneId) || graph.entranceZoneId
  /** @type {Set<string>} */
  const zones = new Set()
  /** @type {Set<string>} */
  const keys = new Set()
  const byId = new Map(graph.zones.map((zone) => [zone.id, zone]))
  if (!byId.has(start)) return { zones, keys, rounds: 0 }

  let rounds = 0
  let grew = true
  while (grew) {
    grew = false
    rounds += 1
    const queue = [start]
    zones.add(start)
    for (const key of byId.get(start)?.keys ?? []) {
      if (!keys.has(key)) { keys.add(key); grew = true }
    }
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]
      for (const link of graph.links) {
        let next = null
        if (link.from === current) next = link.to
        else if (link.bidirectional && link.to === current) next = link.from
        if (!next || !byId.has(next) || zones.has(next)) continue
        if (!linkPassable(link, keys)) continue
        zones.add(next)
        queue.push(next)
        grew = true
        for (const key of byId.get(next)?.keys ?? []) {
          if (!keys.has(key)) { keys.add(key); grew = true }
        }
      }
    }
    // Защита от бесконечного цикла: больше зон, чем есть, набрать нельзя.
    if (rounds > graph.zones.length + 2) break
  }
  return { zones, keys, rounds }
}

/**
 * Проверка графа. Возвращает список замечаний, а не бросает: при отказе план
 * (раздел 10) требует ослабить требования и повторить, а не останавливать игру.
 *
 * @param {SceneGraph} graph
 * @returns {{ok: boolean, errors: GraphIssue[]}}
 */
export function validateSceneGraph(graph) {
  /** @type {GraphIssue[]} */
  const errors = []
  /** @param {string} code @param {string} message @param {string} [at] */
  const fail = (code, message, at) => errors.push(at ? { code, message, at } : { code, message })

  const byId = new Map()
  for (const zone of graph.zones) {
    if (byId.has(zone.id)) fail('ZONE_ID_NOT_UNIQUE', `Зона ${zone.id} объявлена дважды`, zone.id)
    byId.set(zone.id, zone)
  }
  for (const link of graph.links) {
    if (!byId.has(link.from)) fail('LINK_END_MISSING', `Связь ${link.id} начинается в несуществующей зоне ${link.from}`, link.id)
    if (!byId.has(link.to)) fail('LINK_END_MISSING', `Связь ${link.id} ведёт в несуществующую зону ${link.to}`, link.id)
    if (link.kind === 'locked' && !link.keyId) {
      fail('LOCKED_LINK_WITHOUT_KEY', `Запертая связь ${link.id} не указывает, чем открывается`, link.id)
    }
  }
  if (!byId.has(graph.entranceZoneId)) fail('ENTRANCE_ZONE_MISSING', 'Зона входа не объявлена', graph.entranceZoneId)
  if (graph.goalZoneId && !byId.has(graph.goalZoneId)) fail('GOAL_ZONE_MISSING', 'Зона цели не объявлена', graph.goalZoneId)

  // Все объявленные ключи обязаны где-то лежать, иначе запертая дверь не
  // откроется никогда.
  const placedKeys = new Set(graph.zones.flatMap((zone) => zone.keys))
  for (const link of graph.links) {
    if (link.kind === 'locked' && link.keyId && !placedKeys.has(link.keyId)) {
      fail('KEY_NEVER_PLACED', `Ключ ${link.keyId} от связи ${link.id} нигде не лежит`, link.id)
    }
  }

  const reached = reachableZones(graph)
  if (graph.goalZoneId && byId.has(graph.goalZoneId) && !reached.zones.has(graph.goalZoneId)) {
    fail('GOAL_UNREACHABLE', 'От входа нет пути к цели с учётом дверей и ключей', graph.goalZoneId)
  }
  for (const zone of graph.zones) {
    if (zone.required && !reached.zones.has(zone.id)) {
      fail('REQUIRED_ZONE_UNREACHABLE', `Обязательная зона ${zone.id} недостижима`, zone.id)
    }
  }

  // Ключ за собственной дверью. Проверяется отдельно от общей достижимости:
  // цель может быть достижима в обход, а ключ всё равно заперт сам за собой, и
  // это тупик для игрока, который пойдёт по запертой ветке.
  for (const link of graph.links) {
    if (link.kind !== 'locked' || !link.keyId) continue
    if (reached.keys.has(link.keyId)) continue
    const keyId = link.keyId
    const holders = graph.zones.filter((zone) => zone.keys.includes(keyId)).map((zone) => zone.id)
    if (!holders.length) continue
    const withoutThisDoor = { ...graph, links: graph.links.filter((entry) => entry.id !== link.id) }
    const beyond = reachableZones(/** @type {SceneGraph} */ (withoutThisDoor))
    const onlyBehind = holders.every((holder) => !beyond.zones.has(holder))
    fail(
      onlyBehind ? 'KEY_BEHIND_ITS_OWN_DOOR' : 'KEY_UNREACHABLE',
      onlyBehind
        ? `Ключ ${keyId} лежит за дверью ${link.id}, которую сам и открывает`
        : `Ключ ${keyId} от двери ${link.id} недостижим`,
      link.id,
    )
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Порядок, в котором зоны становятся доступны. Нужен расстановке: ключ обязан
 * лежать не дальше той волны, на которой он ещё пригодится, а цель — в
 * последней.
 *
 * @param {SceneGraph} graph
 * @returns {Array<{wave: number, zones: string[], keysGained: string[]}>}
 */
export function progressionWaves(graph) {
  const byId = new Map(graph.zones.map((zone) => [zone.id, zone]))
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Set<string>} */
  const keys = new Set()
  /** @type {Array<{wave: number, zones: string[], keysGained: string[]}>} */
  const waves = []
  if (!byId.has(graph.entranceZoneId)) return waves

  let frontier = [graph.entranceZoneId]
  let wave = 0
  while (frontier.length) {
    const gained = []
    for (const id of frontier) {
      seen.add(id)
      for (const key of byId.get(id)?.keys ?? []) {
        if (!keys.has(key)) { keys.add(key); gained.push(key) }
      }
    }
    waves.push({ wave, zones: [...frontier], keysGained: gained })
    /** @type {Set<string>} */
    const next = new Set()
    for (const id of seen) {
      for (const link of graph.links) {
        let candidate = null
        if (link.from === id) candidate = link.to
        else if (link.bidirectional && link.to === id) candidate = link.from
        if (!candidate || seen.has(candidate) || !byId.has(candidate)) continue
        if (!linkPassable(link, keys)) continue
        next.add(candidate)
      }
    }
    frontier = [...next]
    wave += 1
    if (wave > graph.zones.length + 2) break
  }
  return waves
}
