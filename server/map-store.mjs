// @ts-check
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { deserializeTacticalMap, legacyCellsFromTacticalMap } from './tactical-map.mjs'

/**
 * Хранилище карт, адресуемое по содержимому
 * (`docs/tactical-map-plan.md`, раздел 11.2).
 *
 * Снимок состояния пишется каждые 25 событий и содержит состояние целиком.
 * Замер 2026-07-26: уже на карте 30×30 вклад карты в снимок — 174 КБ, то есть
 * около 3,5 МБ на кампанию. На 100×100 это десятки мегабайт. Ответ плана:
 * снимок хранит **ссылку** на карту, а сама карта лежит один раз и адресуется
 * хешем содержимого.
 *
 * Две карты с одинаковым содержимым — это один файл. Повторный вход в локацию,
 * возврат к прежней сцене и одинаковые карты у разных кампаний не порождают
 * копий.
 */

export const MAP_REF_MARKER = 'skazanie:map-ref-v1'

/**
 * @typedef {object} MapRef
 * @property {string} marker
 * @property {string} hash
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {unknown} value
 * @returns {value is MapRef}
 */
export function isMapRef(value) {
  return Boolean(value) && typeof value === 'object'
    && /** @type {Record<string, unknown>} */ (value).marker === MAP_REF_MARKER
    && typeof /** @type {Record<string, unknown>} */ (value).hash === 'string'
}

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Адрес карты — SHA-256 содержимого в нижнем регистре. */
const MAP_HASH = /^[0-9a-f]{64}$/u

/**
 * Файл карты есть, но его содержимое не то, на которое указывает адрес.
 *
 * Аудит PR #131, RCV-03: прежде `get` отдавал любой разобранный JSON, и
 * изменённая под прежним хешем карта проходила контрольную сумму снимка —
 * та считается по ссылке, а не по байтам карты. После перезапуска кампания
 * молча оказывалась в другом мире. Теперь такое чтение — отказ с кодом,
 * а `internalizeMaps` считает ссылку неразрешённой, и хранилище событий
 * идёт прежним безопасным путём: предыдущий снимок или replay.
 */
export class MapBlobIntegrityError extends Error {
  /**
   * @param {string} hash адрес из ссылки
   * @param {string} code `MAP_BLOB_HASH_MISMATCH` или `MAP_REF_INVALID`
   * @param {Record<string, unknown>} [details]
   */
  constructor(hash, code, details = {}) {
    super(code === 'MAP_REF_INVALID'
      ? 'Ссылка на карту не является хешем содержимого'
      : `Содержимое карты ${hash.slice(0, 12)}… не совпадает с её адресом`)
    // Та же форма, что у ошибок хранилища событий (`EventStoreError`):
    // имя класса, код и подробности полями самой ошибки.
    this.name = 'MapBlobIntegrityError'
    this.code = code
    this.hash = hash
    Object.assign(this, details)
  }
}

/**
 * @param {string} file
 * @param {string} contents
 */
function atomicWrite(file, contents) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)
  try {
    writeFileSync(temporary, contents)
    renameSync(temporary, file)
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* лучшее усилие */ }
    throw error
  }
}

export class MapStore {
  /**
   * @param {object} options
   * @param {string} options.rootDir каталог хранилища
   * @param {number} [options.cacheSize] сколько карт держать в памяти
   */
  constructor({ rootDir, cacheSize = 32 } = /** @type {any} */ ({})) {
    if (!rootDir) throw new Error('MapStore требует rootDir')
    this.rootDir = join(rootDir, 'maps')
    this.cacheSize = Math.max(1, cacheSize)
    // Кэш держит проверенный JSON-текст, а не объект: каждый `get` отдаёт
    // новую копию, и вызывающий, поправив её, не испортит то, что следующий
    // `get` вернёт под тем же хешем (аудит PR #131, RCV-03).
    /** @type {Map<string, string>} */
    this.cache = new Map()
    /** Хеши, чей файл оказался чужим содержимым: `put` перепишет его верным. */
    /** @type {Set<string>} */
    this.corrupt = new Set()
  }

  /**
   * @param {string} hash
   * @returns {string}
   */
  fileFor(hash) {
    // Два уровня по первым символам: тысячи файлов в одном каталоге замедляют
    // любую файловую систему.
    return join(this.rootDir, hash.slice(0, 2), `${hash}.json`)
  }

  /**
   * Кладёт карту и возвращает ссылку на неё. Повторная запись того же
   * содержимого файл не переписывает.
   *
   * @param {Record<string, any>} serializedMap
   * @returns {MapRef}
   */
  put(serializedMap) {
    const text = JSON.stringify(serializedMap)
    const hash = sha256(text)
    const file = this.fileFor(hash)
    // Файл, который `get` уже уличил в чужом содержимом, переписывается верным:
    // адрес задаёт содержимое, и это восстановление карты, а не её правка.
    // Иначе каждый следующий снимок ссылался бы на тот же испорченный файл.
    if (!existsSync(file) || this.corrupt.has(hash)) {
      atomicWrite(file, text)
      this.corrupt.delete(hash)
    }
    this._remember(hash, text)
    return {
      marker: MAP_REF_MARKER,
      hash,
      width: Number(serializedMap?.width) || 0,
      height: Number(serializedMap?.height) || 0,
    }
  }

  /**
   * Карта по адресу — всегда новая копия.
   *
   * Содержимое файла сверяется с адресом тем же digest, что и при записи
   * (аудит PR #131, RCV-03): от канонического JSON значения, а не от байтов
   * файла, поэтому перевод строки или отступы карту чужой не делают, а другая
   * клетка — делает. Кэш хранит только сверенный текст.
   *
   * @param {string} hash
   * @returns {Record<string, any>|null} null, если карты нет или файл не
   *   разбирается — вызывающий обязан пережить это, а не упасть: потеря файла
   *   карты не должна ронять кампанию
   * @throws {MapBlobIntegrityError} файл есть, но в нём не та карта
   *   (`MAP_BLOB_HASH_MISMATCH`), или адрес — не хеш (`MAP_REF_INVALID`)
   */
  get(hash) {
    if (typeof hash !== 'string' || !MAP_HASH.test(hash)) throw new MapBlobIntegrityError(String(hash), 'MAP_REF_INVALID')
    const cached = this.cache.get(hash)
    if (cached !== undefined) {
      this._remember(hash, cached)
      return JSON.parse(cached)
    }
    const file = this.fileFor(hash)
    if (!existsSync(file)) return null
    /** @type {Record<string, any>} */
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
    const text = JSON.stringify(parsed)
    const actual = sha256(text)
    if (actual !== hash) {
      this.corrupt.add(hash)
      throw new MapBlobIntegrityError(hash, 'MAP_BLOB_HASH_MISMATCH', { actual_hash: actual })
    }
    this._remember(hash, text)
    return parsed
  }

  /**
   * @param {string} hash
   * @param {string} value сверенный JSON-текст карты
   */
  _remember(hash, value) {
    this.cache.delete(hash)
    this.cache.set(hash, value)
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

/**
 * Клетки запомненной локации выносятся тем же хранилищем, что и карта.
 *
 * Записи `state.locationMaps` карту слоями не хранят вовсе: `sceneMapRecord`
 * (`server/adventure-director.mjs`) кладёт туда только `{version, cells}`.
 * Поэтому вынос по полю `map` их никогда не задевал, и в снимке оставалась
 * полная копия клеток каждой посещённой локации — замер 2026-08-02 на сцене
 * 30×30 дал 83,0 КБ при 9,3 КБ у самой карты. С этажами число таких записей
 * умножается на число этажей, поэтому вынос обязателен до L1.
 *
 * Ширина и высота считаются по охвату клеток, чтобы ссылка оставалась
 * самоописательной, как у карты.
 *
 * @param {MapStore} store
 * @param {unknown[]} cells
 * @returns {MapRef}
 */
function putCells(store, cells) {
  let width = 0
  let height = 0
  for (const cell of cells) {
    const x = Number(/** @type {any} */ (cell)?.x)
    const y = Number(/** @type {any} */ (cell)?.y)
    if (Number.isSafeInteger(x)) width = Math.max(width, x + 1)
    if (Number.isSafeInteger(y)) height = Math.max(height, y + 1)
  }
  return store.put({ cells, width, height })
}

/**
 * Карта по ссылке или `null`, если её не вернуть: файла нет, он не
 * разбирается или в нём не та карта. Подмену вызывающий узнаёт по списку
 * `corrupt`, но поступает с ней как с потерей — снимок с такой ссылкой
 * непригоден (аудит PR #131, RCV-03).
 *
 * @param {MapStore} store
 * @param {string} hash
 * @param {string[]} corrupt
 * @returns {Record<string, any>|null}
 */
function restoreBlob(store, hash, corrupt) {
  try {
    return store.get(hash)
  } catch (error) {
    if (!(error instanceof MapBlobIntegrityError)) throw error
    corrupt.push(hash)
    return null
  }
}

/**
 * @param {MapStore} store
 * @param {string} hash
 * @param {string[]} corrupt
 * @returns {unknown[]|null} null, если файла нет — вызывающий обязан пережить
 */
function getCells(store, hash, corrupt) {
  const body = restoreBlob(store, hash, corrupt)
  return Array.isArray(body?.cells) ? body.cells : null
}

/**
 * Заменяет карты в состоянии ссылками. Возвращает новое состояние; исходное не
 * трогается.
 *
 * Выносятся карта текущей сцены, карты локаций и запомненные клетки локаций
 * (`locationMaps[*].cells` — единственное, что там реально лежит сегодня).
 * Вместе с картой из снимка
 * убирается **производный массив клеток**: замер показал, что он стоит вдвое
 * дороже самой карты (83 КБ против 43 КБ на сцене 30×30), а хранить
 * производное значение незачем — оно восстанавливается из карты точно, и это
 * доказано круговым тестом преобразования.
 *
 * Снимок — кэш, а не источник истины: если файл карты потерян, снимок
 * становится непригоден, и хранилище переигрывает поток событий. Событие
 * `SceneAdvanced` несёт клетки, поэтому кампания не теряется.
 *
 * @param {Record<string, any>} state
 * @param {MapStore} store
 * @returns {Record<string, any>}
 */
export function externalizeMaps(state, store) {
  if (!state || typeof state !== 'object') return state
  let changed = false
  const next = { ...state }

  if (state.scene && typeof state.scene === 'object' && state.scene.map && !isMapRef(state.scene.map)) {
    const scene = { ...state.scene, map: store.put(state.scene.map) }
    delete scene.cells
    next.scene = scene
    changed = true
  }

  const locationMaps = state.locationMaps
  if (locationMaps && typeof locationMaps === 'object' && !Array.isArray(locationMaps)) {
    /** @type {Record<string, any>} */
    const replaced = {}
    let touched = false
    for (const [id, record] of Object.entries(locationMaps)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        replaced[id] = record
        continue
      }
      let entry = record
      if (entry.map && !isMapRef(entry.map)) entry = { ...entry, map: store.put(entry.map) }
      if (Array.isArray(entry.cells)) entry = { ...entry, cells: putCells(store, entry.cells) }
      if (entry !== record) touched = true
      replaced[id] = entry
    }
    if (touched) { next.locationMaps = replaced; changed = true }
  }

  return changed ? next : state
}

/**
 * Возвращает карты на место. Если файла нет, ссылка остаётся ссылкой: состояние
 * читаемо, а нормализация соберёт карту заново из производных клеток.
 *
 * Файл с чужим содержимым под адресом ссылки — тоже неразрешённая ссылка:
 * хеш попадает и в `missing` (по нему хранилище событий отвергает снимок), и
 * в `corrupt` — чтобы потерю можно было отличить от подмены.
 *
 * @param {Record<string, any>} state
 * @param {MapStore} store
 * @returns {{state: Record<string, any>, missing: string[], corrupt: string[]}}
 */
export function internalizeMaps(state, store) {
  /** @type {string[]} */
  const missing = []
  /** @type {string[]} */
  const corrupt = []
  if (!state || typeof state !== 'object') return { state, missing, corrupt }
  let changed = false
  const next = { ...state }

  if (state.scene && typeof state.scene === 'object' && isMapRef(state.scene.map)) {
    const restored = restoreBlob(store, state.scene.map.hash, corrupt)
    if (restored) {
      const scene = { ...state.scene, map: restored }
      // Производный массив клеток пересобирается из карты — ровно тем же
      // преобразованием, которым он строился до выноса.
      if (!Array.isArray(scene.cells)) {
        try {
          scene.cells = legacyCellsFromTacticalMap(deserializeTacticalMap(restored))
        } catch {
          scene.cells = []
        }
      }
      next.scene = scene
      changed = true
    } else missing.push(state.scene.map.hash)
  }

  const locationMaps = state.locationMaps
  if (locationMaps && typeof locationMaps === 'object' && !Array.isArray(locationMaps)) {
    /** @type {Record<string, any>} */
    const replaced = {}
    let touched = false
    for (const [id, record] of Object.entries(locationMaps)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        replaced[id] = record
        continue
      }
      let entry = record
      if (isMapRef(entry.map)) {
        const restored = restoreBlob(store, entry.map.hash, corrupt)
        if (restored) entry = { ...entry, map: restored }
        else missing.push(entry.map.hash)
      }
      if (isMapRef(entry.cells)) {
        const restored = getCells(store, entry.cells.hash, corrupt)
        if (restored) entry = { ...entry, cells: restored }
        else missing.push(entry.cells.hash)
      }
      if (entry !== record) touched = true
      replaced[id] = entry
    }
    if (touched) { next.locationMaps = replaced; changed = true }
  }

  return { state: changed ? next : state, missing, corrupt }
}
