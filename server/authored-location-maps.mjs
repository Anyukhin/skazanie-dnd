// @ts-check
/**
 * Реестр заранее собранных tactical maps для известных локаций.
 *
 * Карты не зависят от кода стола: сериализованная геометрия лежит в
 * versioned-данных, а отсутствие файла/конкретного места оставляет прежний
 * процедурный путь. Картинки в этот контракт не входят — frontend получает их
 * по server-owned marker `tilesetId`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  deserializeTacticalMap,
  serializeTacticalMap,
  validateTacticalMap,
} from './tactical-map.mjs'

export const AUTHORED_LOCATION_MAP_CATALOG_VERSION = 1
export const AUTHORED_LOCATION_MAP_MARKER = /^authored-(?:location|tactical):([a-z0-9]+(?:-[a-z0-9]+)*):v([1-9][0-9]*)$/u
export const AUTHORED_LOCATION_MAP_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/u

export const AUTHORED_LOCATION_MAP_CATALOG_FILE = fileURLToPath(new URL('../data/authored-location-maps-v1.json', import.meta.url))

/** @typedef {import('./tactical-map.mjs').TacticalMap} TacticalMap */

/** @typedef {{ locationId: string, map: Record<string, unknown> }} AuthoredLocationMapRecord */

/**
 * @param {unknown} value
 * @param {string} path
 */
function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} должен быть объектом`)
  return /** @type {Record<string, any>} */ (value)
}

/** @param {unknown} value @param {string} path */
function locationId(value, path) {
  const result = String(value ?? '').trim()
  if (!AUTHORED_LOCATION_MAP_ID.test(result)) throw new Error(`${path} имеет неверный идентификатор`)
  return result
}

/**
 * Нормализует полный каталог. Принимаются и прямые map-записи, и обёртки
 * `{location_id, map}` — это упрощает экспорт `tmp/authored-maps/*.json`.
 *
 * @param {unknown} value
 * @param {{ requireComplete?: boolean }} [options]
 * @returns {Map<string, Record<string, unknown>>}
 */
export function normalizeAuthoredLocationMapCatalog(value, { requireComplete = false } = {}) {
  const root = record(value, 'catalog')
  if (root.schema_version !== AUTHORED_LOCATION_MAP_CATALOG_VERSION) {
    throw new Error(`catalog.schema_version должен быть ${AUTHORED_LOCATION_MAP_CATALOG_VERSION}`)
  }
  if (!Array.isArray(root.maps)) throw new Error('catalog.maps должен быть массивом')
  const maps = new Map()
  for (const [index, rawEntry] of root.maps.entries()) {
    const entry = record(rawEntry, `catalog.maps[${index}]`)
    const rawMap = entry.map && typeof entry.map === 'object' && !Array.isArray(entry.map) ? entry.map : entry
    const map = deserializeTacticalMap(rawMap)
    const id = locationId(entry.location_id ?? entry.locationId ?? map.locationId, `catalog.maps[${index}].location_id`)
    if (map.locationId !== id) throw new Error(`catalog.maps[${index}] locationId не совпадает с location_id`)
    if (maps.has(id)) throw new Error(`catalog.maps содержит повторяющийся id «${id}»`)
    const marker = AUTHORED_LOCATION_MAP_MARKER.exec(map.tilesetId)
    if (!marker || marker[1] !== id) throw new Error(`catalog.maps[${index}] имеет неверный authored tilesetId`)
    const report = validateTacticalMap(map)
    if (!report.ok) throw new Error(`catalog.maps[${index}] невалидна: ${report.errors.map((error) => error.code).join(', ')}`)
    maps.set(id, serializeTacticalMap(map))
  }
  if (requireComplete && maps.size !== 56) throw new Error(`catalog.maps должен содержать 56 карт, получено ${maps.size}`)
  return maps
}

/** @returns {Map<string, Record<string, unknown>>} */
function loadCatalog() {
  if (!existsSync(AUTHORED_LOCATION_MAP_CATALOG_FILE)) return new Map()
  let payload
  try {
    payload = JSON.parse(readFileSync(AUTHORED_LOCATION_MAP_CATALOG_FILE, 'utf8'))
  } catch (error) {
    throw new Error(`Не удалось загрузить каталог authored-карт: ${error instanceof Error ? error.message : String(error)}`)
  }
  return normalizeAuthoredLocationMapCatalog(payload)
}

const AUTHORED_LOCATION_MAPS = loadCatalog()

/** @param {unknown} value */
function normalizedId(value) {
  const id = String(value ?? '').trim()
  return AUTHORED_LOCATION_MAP_ID.test(id) ? id : ''
}

/**
 * Возвращает новую mutable-копию карты. Игровое состояние не должно мутировать
 * объект, разделяемый всеми вызовами и столами.
 *
 * @param {unknown} value
 * @returns {TacticalMap|null}
 */
export function authoredLocationMapFor(value) {
  const id = normalizedId(value)
  const raw = id ? AUTHORED_LOCATION_MAPS.get(id) : null
  return raw ? deserializeTacticalMap(raw) : null
}

/** @param {unknown} value */
export function hasAuthoredLocationMap(value) {
  const id = normalizedId(value)
  return Boolean(id && AUTHORED_LOCATION_MAPS.has(id))
}

/** @returns {string[]} */
export function authoredLocationMapIds() {
  return [...AUTHORED_LOCATION_MAPS.keys()].sort()
}

/** @returns {number} */
export function authoredLocationMapCount() {
  return AUTHORED_LOCATION_MAPS.size
}

/**
 * Короткий публичный descriptor для Scene Architect. `themeId` — это уже
 * server-owned тема native generator-а, а не произвольная строка модели.
 *
 * @param {unknown} value
 * @returns {{ locationId: string, themeId: string, tilesetId: string, seed: string, width: number, height: number }|null}
 */
export function authoredLocationMapMetaFor(value) {
  const map = authoredLocationMapFor(value)
  if (!map) return null
  return {
    locationId: map.locationId,
    themeId: map.theme,
    tilesetId: map.tilesetId,
    seed: map.seed,
    width: map.width,
    height: map.height,
  }
}

/** @returns {Map<string, Record<string, unknown>>} */
export function authoredLocationMapCatalogSnapshot() {
  return new Map([...AUTHORED_LOCATION_MAPS.entries()].map(([id, map]) => [id, structuredClone(map)]))
}
