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
 * @param {unknown} value
 * @returns {string}
 */
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
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
    /** @type {Map<string, unknown>} */
    this.cache = new Map()
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
    const hash = digest(serializedMap)
    const file = this.fileFor(hash)
    if (!existsSync(file)) atomicWrite(file, JSON.stringify(serializedMap))
    this._remember(hash, serializedMap)
    return {
      marker: MAP_REF_MARKER,
      hash,
      width: Number(serializedMap?.width) || 0,
      height: Number(serializedMap?.height) || 0,
    }
  }

  /**
   * @param {string} hash
   * @returns {Record<string, any>|null} null, если карты нет — вызывающий обязан
   *   пережить это, а не упасть: потеря файла карты не должна ронять кампанию
   */
  get(hash) {
    if (this.cache.has(hash)) {
      const value = this.cache.get(hash)
      this.cache.delete(hash)
      this.cache.set(hash, value)
      return /** @type {Record<string, any>} */ (value)
    }
    const file = this.fileFor(hash)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      this._remember(hash, parsed)
      return parsed
    } catch {
      return null
    }
  }

  /**
   * @param {string} hash
   * @param {unknown} value
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
 * Заменяет карты в состоянии ссылками. Возвращает новое состояние; исходное не
 * трогается.
 *
 * Выносятся карта текущей сцены и карты локаций. Вместе с картой из снимка
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
      if (record && typeof record === 'object' && record.map && !isMapRef(record.map)) {
        replaced[id] = { ...record, map: store.put(record.map) }
        touched = true
      } else {
        replaced[id] = record
      }
    }
    if (touched) { next.locationMaps = replaced; changed = true }
  }

  return changed ? next : state
}

/**
 * Возвращает карты на место. Если файла нет, ссылка остаётся ссылкой: состояние
 * читаемо, а нормализация соберёт карту заново из производных клеток.
 *
 * @param {Record<string, any>} state
 * @param {MapStore} store
 * @returns {{state: Record<string, any>, missing: string[]}}
 */
export function internalizeMaps(state, store) {
  /** @type {string[]} */
  const missing = []
  if (!state || typeof state !== 'object') return { state, missing }
  let changed = false
  const next = { ...state }

  if (state.scene && typeof state.scene === 'object' && isMapRef(state.scene.map)) {
    const restored = store.get(state.scene.map.hash)
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
      if (record && typeof record === 'object' && isMapRef(record.map)) {
        const restored = store.get(record.map.hash)
        if (restored) { replaced[id] = { ...record, map: restored }; touched = true }
        else { replaced[id] = record; missing.push(record.map.hash) }
      } else {
        replaced[id] = record
      }
    }
    if (touched) { next.locationMaps = replaced; changed = true }
  }

  return { state: changed ? next : state, missing }
}
