import { applySerializedRevealDelta } from './tactical-map-client'
import type { Scene, SerializedTacticalMap } from './types'

/**
 * Кэш тактических карт по хешу — клиентская половина транспорта дельт
 * (`docs/tactical-map-plan.md`, 11.2; сервер — `server/reveal-transport.mjs`).
 *
 * Сервер шлёт сцену в одном из трёх видов:
 *
 * - `map` + `map_hash` — карта целиком, её нужно запомнить;
 * - `map_delta` + `map_hash` — интервалы раскрытия поверх карты `baseHash`;
 * - `map_unchanged` + `map_hash` — карта не менялась, она уже есть.
 *
 * Разбор возвращает `null`, если нужной карты в кэше нет. Это не ошибка, а
 * штатный случай: обновление могло не дойти. Тогда вызывающий обязан запросить
 * карту целиком — рисовать расхождение нельзя.
 */

/**
 * Хватает и на цепочку дельт, и на возврат к карте, пропущенной очередью.
 * Поднято с 8 до 12 вместе с этажами (`docs/multilevel-map-plan.md`, 6.3):
 * беготня по трём этажам туда-сюда держит в работе втрое больше карт, и на
 * прежнем лимите возврат на первый этаж выбивал бы её из кэша — сервер слал бы
 * карту целиком вместо дельты.
 */
const CACHE_LIMIT = 12

const maps = new Map<string, SerializedTacticalMap>()
let latestHash = ''

export function rememberSceneMap(hash: string, map: SerializedTacticalMap | undefined) {
  if (!hash || !map) return
  maps.delete(hash)
  maps.set(hash, map)
  latestHash = hash
  while (maps.size > CACHE_LIMIT) {
    const oldest = maps.keys().next().value
    if (oldest === undefined) break
    maps.delete(oldest)
  }
}

export function sceneMapByHash(hash: string): SerializedTacticalMap | null {
  const cached = hash ? maps.get(hash) : undefined
  if (!cached) return null
  maps.delete(hash)
  maps.set(hash, cached)
  return cached
}

/** Хеш самой свежей карты — им клиент сообщает серверу, что у него есть. */
export function latestSceneMapHash() {
  return latestHash
}

/** Смена кампании: прежние карты к новой сцене отношения не имеют. */
export function forgetSceneMaps() {
  maps.clear()
  latestHash = ''
}

/**
 * Достраивает сцену до полной карты. `null` — карты собрать не из чего и нужен
 * полный запрос.
 */
export function resolveSceneMap<T extends Scene>(scene: T | null | undefined): T | null {
  if (!scene || typeof scene !== 'object') return scene ?? null
  const hash = String(scene.map_hash ?? '')
  if (scene.map) {
    rememberSceneMap(hash, scene.map)
    return scene
  }
  if (scene.map_delta) {
    const base = sceneMapByHash(String(scene.map_delta.baseHash ?? ''))
    if (!base) return null
    const map = applySerializedRevealDelta(base, scene.map_delta)
    if (!map) return null
    rememberSceneMap(hash, map)
    const { map_delta: _delta, ...rest } = scene
    return { ...rest, map } as T
  }
  if (scene.map_unchanged) {
    const map = sceneMapByHash(hash)
    if (!map) return null
    // Обновление ничего не сказало о карте, но хеш остаётся самым свежим.
    rememberSceneMap(hash, map)
    const { map_unchanged: _unchanged, ...rest } = scene
    return { ...rest, map } as T
  }
  // Сцена без карты вовсе — старая проекция или сцена по клеткам. Доска
  // отработает по `cells`, и запрашивать нечего.
  return scene
}
