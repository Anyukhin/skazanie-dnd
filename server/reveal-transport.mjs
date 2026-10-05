// @ts-check
import { applyRevealDelta, revealDeltaEmpty, revealUpdateFor } from './reveal-delta.mjs'
import { deserializeTacticalMap, serializeTacticalMap } from './tactical-map.mjs'

/**
 * Транспорт дельт раскрытия (`docs/tactical-map-plan.md`, 11.2).
 *
 * `reveal-delta.mjs` считает дельту между двумя состояниями карты, но не знает
 * ни про клиента, ни про то, что у него закэшировано. Этот модуль — вторая
 * половина: он помнит **проекции** карт по их хешу и решает, что уходит в
 * обновление состояния.
 *
 * Три возможных ответа:
 *
 * - `full` — карта целиком: у клиента её нет, хеш чужой либо дельта не годится;
 * - `delta` — интервалы раскрытия поверх той карты, которая у клиента уже есть;
 * - `unchanged` — карта не менялась вовсе, отправлять нечего.
 *
 * **Сторож видимости.** Дельта уходит только тогда, когда её наложение даёт
 * ровно ту же карту, что и полная проекция. Это буквальная проверка, а не
 * рассуждение: результат наложения сериализуется и сравнивается с проекцией.
 * Поэтому игрок не может ни узнать через дельту лишнего (`AGENTS.md` §5), ни
 * получить расхождение с тем, что нарисовала бы полная проекция.
 *
 * Проверка нужна не для красоты: проекция обезличивает нераскрытые клетки, и
 * раскрытие меняет не только слой `revealed`. Материал, вариант тайла и
 * поверхность дельта несёт с версии v2, а вот рёбра, двери, предметы и
 * опасности — нет. Поэтому на карте, где вместе с туманом открывается стена или
 * предмет, дельты недостаточно, и там честнее отправить карту целиком, чем
 * нарисовать игроку пустое место вместо колодца.
 */

/** Сколько проекций карт держать. Одна карта 100×100 — около 30 КБ JSON. */
export const PROJECTED_MAP_CACHE_LIMIT = 24

/** @typedef {Record<string, any>} SerializedMap */
/** @typedef {import('./reveal-delta.mjs').RevealDelta} RevealDelta */
/**
 * @typedef {{kind: 'full', hash: string, map: SerializedMap}
 *   | {kind: 'delta', hash: string, delta: RevealDelta}
 *   | {kind: 'unchanged', hash: string}} SceneMapUpdate
 */

/**
 * Кэш адресуется содержимым, поэтому общий на процесс: одинаковая проекция —
 * одинаковая карта, из какой бы кампании она ни пришла.
 * @type {Map<string, SerializedMap>}
 */
const projectedMaps = new Map()

/**
 * @param {string} hash
 * @param {SerializedMap | null | undefined} map
 * @returns {void}
 */
export function rememberProjectedMap(hash, map) {
  if (!hash || !map) return
  projectedMaps.delete(hash)
  projectedMaps.set(hash, map)
  while (projectedMaps.size > PROJECTED_MAP_CACHE_LIMIT) {
    const oldest = projectedMaps.keys().next().value
    if (oldest === undefined) break
    projectedMaps.delete(oldest)
  }
}

/**
 * @param {string} [hash]
 * @returns {SerializedMap | null}
 */
export function projectedMapByHash(hash) {
  const cached = hash ? projectedMaps.get(hash) : undefined
  if (!cached) return null
  // Обращение освежает запись: вытесняться должна действительно давняя карта,
  // а не та, которой пользуется подключённый игрок.
  // Запись найдена только по непустому ключу (аудит PR #131, QA-02: приведение
  // для проверки типов, поведение то же).
  const key = /** @type {string} */ (hash)
  projectedMaps.delete(key)
  projectedMaps.set(key, cached)
  return cached
}

/** Очистка между тестами. @returns {void} */
export function forgetProjectedMaps() {
  projectedMaps.clear()
}

/**
 * Что отправить клиенту, у которого закэширована карта с хешем `clientHash`.
 *
 * @param {SerializedMap | null | undefined} map проекция текущей карты
 * @param {string} hash хеш этой проекции
 * @param {string} [clientHash] что закэшировано у клиента
 * @returns {SceneMapUpdate}
 */
export function sceneMapUpdateFor(map, hash, clientHash = '') {
  const serialized = /** @type {SerializedMap} */ (map ?? {})
  if (!map || !hash) return { kind: 'full', hash: String(hash ?? ''), map: serialized }
  rememberProjectedMap(hash, map)
  if (clientHash && clientHash === hash) return { kind: 'unchanged', hash }
  const cached = projectedMapByHash(clientHash)
  if (!cached) return { kind: 'full', hash, map: serialized }
  // Рассылка комнаты задаёт этот вопрос каждому соединению, а ответ зависит
  // только от пары «текущая проекция — карта клиента»: у игроков отряда она
  // обычно одна и та же. Проекция — общий объект из кэша проектора, карта
  // клиента — объект из кэша выше; обе не меняются на месте. Поэтому ответ
  // запоминается по этой паре, и сторож видимости (сравнение сериализаций)
  // проходит один раз на пару, а не на каждого зрителя.
  const checkKey = `${hash}\n${clientHash}`
  const remembered = deltaChecksFor(map).get(checkKey)
  if (remembered && remembered.clientMap === cached) return remembered.update
  const update = deltaOrFullUpdate(serialized, hash, clientHash, cached)
  rememberDeltaCheck(map, checkKey, cached, update)
  return update
}

/**
 * Ответы `sceneMapUpdateFor` по текущей проекции, её хешу и хешу клиента.
 * @type {WeakMap<SerializedMap, Map<string, {clientMap: SerializedMap, update: SceneMapUpdate}>>}
 */
const deltaChecks = new WeakMap()

/** Сколько разных карт клиентов помнить на одну проекцию. */
const DELTA_CHECKS_PER_MAP = 8

/**
 * @param {SerializedMap} map
 * @returns {Map<string, {clientMap: SerializedMap, update: SceneMapUpdate}>}
 */
function deltaChecksFor(map) {
  let checks = deltaChecks.get(map)
  if (!checks) {
    checks = new Map()
    deltaChecks.set(map, checks)
  }
  return checks
}

/**
 * @param {SerializedMap} map
 * @param {string} checkKey хеш проекции и хеш клиента
 * @param {SerializedMap} clientMap
 * @param {SceneMapUpdate} update
 * @returns {void}
 */
function rememberDeltaCheck(map, checkKey, clientMap, update) {
  const checks = deltaChecksFor(map)
  checks.delete(checkKey)
  checks.set(checkKey, { clientMap, update })
  while (checks.size > DELTA_CHECKS_PER_MAP) {
    const oldest = checks.keys().next().value
    if (oldest === undefined) break
    checks.delete(oldest)
  }
}

/**
 * Дельта от карты клиента либо карта целиком — со сторожем видимости.
 *
 * @param {SerializedMap} serialized проекция текущей карты
 * @param {string} hash хеш этой проекции
 * @param {string} clientHash что закэшировано у клиента
 * @param {SerializedMap} cached карта клиента
 * @returns {SceneMapUpdate}
 */
function deltaOrFullUpdate(serialized, hash, clientHash, cached) {
  try {
    // `revealUpdateFor` привязывает дельту к тому хешу, который получила как
    // текущий. Дельта считается от карты клиента, поэтому сюда идёт его хеш;
    // хеш результата уходит отдельным полем и клиент кэширует карту под ним.
    const update = revealUpdateFor({
      serializedMap: serialized,
      currentHash: clientHash,
      clientHash,
      clientMap: cached,
    })
    if (update.kind !== 'delta' || revealDeltaEmpty(update.delta)) return { kind: 'full', hash, map: serialized }
    const rebuilt = serializeTacticalMap(applyRevealDelta(deserializeTacticalMap(cached), update.delta))
    // Обе стороны собраны одним `serializeTacticalMap`, поэтому порядок ключей
    // совпадает и сравнение строк здесь законно.
    if (JSON.stringify(rebuilt) !== JSON.stringify(serialized)) return { kind: 'full', hash, map: serialized }
    return { kind: 'delta', hash, delta: update.delta }
  } catch {
    // Другой размер карты, испорченный кэш, чужая карта того же размера —
    // любое сомнение решается в пользу полной карты.
    return { kind: 'full', hash, map: serialized }
  }
}

/**
 * Готовит сцену к отправке. Возвращает и хеш: вызывающий обязан запомнить, что
 * теперь лежит у клиента.
 *
 * @param {Record<string, any> | null | undefined} scene публичная сцена
 * @param {string} [clientHash]
 * @returns {{scene: any, hash: string}}
 */
export function compactSceneFor(scene, clientHash = '') {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return { scene, hash: '' }
  const hash = String(scene.map_hash ?? '')
  if (!scene.map || !hash) return { scene, hash: '' }
  const update = sceneMapUpdateFor(scene.map, hash, clientHash)
  if (update.kind === 'full') return { scene, hash: update.hash }
  const { map: _map, ...rest } = scene
  return {
    scene: update.kind === 'delta' ? { ...rest, map_delta: update.delta } : { ...rest, map_unchanged: true },
    hash: update.hash,
  }
}

/**
 * То же для состояния кампании целиком. Состояние администратора приходит
 * непроецированным и без `map_hash` — его модуль не трогает.
 *
 * @param {Record<string, any> | null | undefined} state
 * @param {string} [clientHash]
 * @returns {{state: any, hash: string}}
 */
export function compactStateForTransport(state, clientHash = '') {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !state.scene) {
    return { state, hash: String(clientHash ?? '') }
  }
  const { scene, hash } = compactSceneFor(state.scene, clientHash)
  if (scene === state.scene) return { state, hash: hash || String(clientHash ?? '') }
  return { state: { ...state, scene }, hash }
}
