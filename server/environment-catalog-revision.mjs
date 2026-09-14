// @ts-check
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Старый каталог, который уже входит в сохранённые карты и сайт. */
export const LEGACY_CATALOG_REVISION = 'pr79'
/** @type {RegExp} */
export const SAFE_CATALOG_REVISION = /^[a-z0-9][a-z0-9_-]{0,95}$/u
export const ENVIRONMENT_MANIFEST_PATH = fileURLToPath(new URL('../public/assets/models/environment/manifest.json', import.meta.url))
export const ENVIRONMENT_DIST_MANIFEST_PATH = fileURLToPath(new URL('../dist/assets/models/environment/manifest.json', import.meta.url))

/** @param {unknown} value @returns {value is string} */
export function isSafeCatalogRevision(value) {
  return typeof value === 'string' && SAFE_CATALOG_REVISION.test(value)
}

/** @typedef {{signature: string, revision: string}} RevisionCacheEntry */
/** @type {Map<string, RevisionCacheEntry>} */
const revisionCache = new Map()

/**
 * Читает активный выпуск каталога. В checkout главным остаётся manifest из
 * `public`, а в production-образе его собранная копия лежит в `dist/assets`.
 * Если найденный manifest отсутствует или в нём нет release, живёт старый
 * каталог `pr79`. Статистика кэширует чтение до следующего изменения файла.
 *
 * @param {string} [manifestPath]
 * @param {string} [fallbackManifestPath] запасной путь собранного manifest в dist/assets для Docker
 * @returns {string}
 */
export function currentEnvironmentCatalogRevision(
  manifestPath = ENVIRONMENT_MANIFEST_PATH,
  fallbackManifestPath = manifestPath === ENVIRONMENT_MANIFEST_PATH ? ENVIRONMENT_DIST_MANIFEST_PATH : '',
) {
  for (const path of [manifestPath, fallbackManifestPath].filter((value, index, paths) => value && paths.indexOf(value) === index)) {
    let stats
    try { stats = statSync(path) } catch { continue }
    const signature = `${stats.size}:${stats.mtimeMs}`
    const cached = revisionCache.get(path)
    if (cached?.signature === signature) return cached.revision

    let manifest = null
    try { manifest = JSON.parse(readFileSync(path, 'utf8')) } catch { /* Повреждённый manifest оставляет прежний каталог. */ }
    const candidate = manifest?.release?.id
    const revision = isSafeCatalogRevision(candidate) ? candidate : LEGACY_CATALOG_REVISION
    revisionCache.set(path, { signature, revision })
    return revision
  }
  return LEGACY_CATALOG_REVISION
}
