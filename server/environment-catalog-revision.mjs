// @ts-check
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Старый каталог, который уже входит в сохранённые карты и сайт. */
export const LEGACY_CATALOG_REVISION = 'pr79'
/** @type {RegExp} */
export const SAFE_CATALOG_REVISION = /^[a-z0-9][a-z0-9_-]{0,95}$/u
export const ENVIRONMENT_MANIFEST_PATH = fileURLToPath(new URL('../public/assets/models/environment/manifest.json', import.meta.url))

/** @param {unknown} value @returns {value is string} */
export function isSafeCatalogRevision(value) {
  return typeof value === 'string' && SAFE_CATALOG_REVISION.test(value)
}

/** @typedef {{signature: string, revision: string}} RevisionCacheEntry */
/** @type {Map<string, RevisionCacheEntry>} */
const revisionCache = new Map()

/**
 * Читает активный выпуск каталога. Путь остаётся единственным источником
 * текущей версии: если манифеста ещё нет или в нём нет release, живёт старый
 * каталог `pr79`. Статистика кэширует чтение до следующего изменения файла.
 *
 * @param {string} [manifestPath]
 * @returns {string}
 */
export function currentEnvironmentCatalogRevision(manifestPath = ENVIRONMENT_MANIFEST_PATH) {
  let signature = 'missing'
  try {
    const stats = statSync(manifestPath)
    signature = `${stats.size}:${stats.mtimeMs}`
    const cached = revisionCache.get(manifestPath)
    if (cached?.signature === signature) return cached.revision

    let manifest = null
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { /* fallback below */ }
    const candidate = manifest?.release?.id
    const revision = isSafeCatalogRevision(candidate) ? candidate : LEGACY_CATALOG_REVISION
    revisionCache.set(manifestPath, { signature, revision })
    return revision
  } catch {
    const cached = revisionCache.get(manifestPath)
    if (cached?.signature === signature) return cached.revision
    revisionCache.set(manifestPath, { signature, revision: LEGACY_CATALOG_REVISION })
    return LEGACY_CATALOG_REVISION
  }
}
