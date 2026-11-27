/** Окно по умолчанию: десять минут, как у входа и дорогих запросов. */
export const RATE_WINDOW_MS = 10 * 60 * 1000

/**
 * Скользящее окно запросов по ключу — для пределов частоты входа и дорогих
 * запросов (`server/index.mjs`).
 *
 * Раньше ключ, раз попав в карту, жил в ней до перезапуска процесса: каждый
 * адрес входа и каждый пользователь оставляли запись навсегда. Теперь ключ без
 * отметок внутри окна удаляется — такой ключ ничем не отличается от
 * отсутствующего, поэтому пределы прежние. Полная уборка идёт не чаще раза в
 * окно либо когда карта переросла `pruneAboveSize`; ключи с живыми отметками
 * она не трогает никогда, так что размер ограничен числом ключей, активных
 * за последнее окно.
 */
export class SlidingWindowCounter {
  /**
   * @param {{ windowMs?: number, pruneAboveSize?: number, now?: () => number }} [options]
   */
  constructor({ windowMs = RATE_WINDOW_MS, pruneAboveSize = 1_000, now = () => Date.now() } = {}) {
    this.windowMs = windowMs
    this.pruneAboveSize = pruneAboveSize
    this.now = now
    /** @type {Map<string, number[]>} */
    this.entries = new Map()
    this.prunedAt = now()
    // Порог уборки по размеру. Если все ключи живые, уборка их не сократит —
    // порог отодвигается, чтобы не обходить карту на каждом запросе.
    this.sizePruneAt = pruneAboveSize
    // Самое широкое окно, с которым звали `hit`: уборка не должна выбросить
    // отметку, ещё живую для вызова с более широким окном.
    this.widestWindowMs = windowMs
  }

  /**
   * Отмечает запрос и сообщает, превышен ли предел.
   * @param {string} key
   * @param {number} limit
   * @param {number} [windowMs]
   * @returns {boolean}
   */
  hit(key, limit, windowMs = this.windowMs) {
    const now = this.now()
    if (windowMs > this.widestWindowMs) this.widestWindowMs = windowMs
    this.prune(now)
    const recent = (this.entries.get(key) || []).filter((time) => now - time < windowMs)
    recent.push(now)
    this.entries.set(key, recent)
    return recent.length > limit
  }

  /**
   * Удаляет ключи, у которых не осталось ни одной отметки внутри окна.
   * @param {number} [now]
   */
  prune(now = this.now()) {
    if (this.entries.size <= this.sizePruneAt && now - this.prunedAt < this.widestWindowMs) return
    this.prunedAt = now
    for (const [key, times] of this.entries) {
      if (!times.some((time) => now - time < this.widestWindowMs)) this.entries.delete(key)
    }
    this.sizePruneAt = Math.max(this.pruneAboveSize, this.entries.size * 2)
  }

  /** Число ключей в памяти. */
  get size() {
    return this.entries.size
  }
}
