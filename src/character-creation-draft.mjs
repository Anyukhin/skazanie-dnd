/**
 * Чистые правила мастера создания героя: черновик между открытиями мастера и
 * бюджет стартовых покупок.
 *
 * Отдельный `.mjs` рядом с `CharacterCreationWizard.tsx` — по той же причине,
 * по какой рядом с `LootPanel.tsx` лежит `loot-panel-rules.mjs`: корпус
 * запускает тесты обычным `node --test`, а то, что живёт внутри `.tsx`, до
 * теста доезжает только регулярочным обходом исходника, который не отличает
 * сохранённый черновик от потерянного.
 *
 * Своих правил игры здесь нет. Хранилище — удобство одной вкладки браузера,
 * а не источник истины: восстановленный черновик проходит те же `validateStep`
 * и серверный импорт героя, что и набранный заново, и серверный отказ
 * `PURCHASES_OVER_BUDGET` остаётся последней защитой бюджета.
 */

/**
 * Версия записи черновика. Поменялась форма `CreationDraft` несовместимо —
 * поднимается версия, и старая запись молча не читается: лучше начать мастер
 * заново, чем подставить игроку полуразобранный выбор.
 */
export const CREATION_DRAFT_VERSION = 1

const DRAFT_KEY_PREFIX = 'skazanie-hero-draft-v1'

/**
 * Ключ черновика: кампания, аккаунт, место героя и редакция правил.
 *
 * Плейтест 2026-10-04, OB-01: черновик не должен переходить ни к другому
 * герою, ни в другую кампанию — `hero-slot-1` есть в каждой кампании, поэтому
 * одного идентификатора места мало. Аккаунт в ключе — на случай общего
 * браузера, редакция — потому что каталог классов и заклинаний у редакций
 * разный. Без кампании или места ключа нет, и черновик не сохраняется вовсе.
 *
 * @param {{ campaignCode?: string | null, accountName?: string | null, playerId?: string | null, rulesetId?: string | null }} parts
 * @returns {string | null}
 */
export function creationDraftKey({ campaignCode, accountName, playerId, rulesetId } = {}) {
  const campaign = String(campaignCode ?? '').trim()
  const player = String(playerId ?? '').trim()
  if (!campaign || !player) return null
  const parts = [campaign, String(accountName ?? '').trim(), player, String(rulesetId ?? '').trim() || 'default']
  return `${DRAFT_KEY_PREFIX}:${parts.map((part) => encodeURIComponent(part)).join(':')}`
}

/**
 * Хранилище вкладки. Выбран `sessionStorage`, а не `localStorage`: черновик
 * переживает закрытие мастера и перезагрузку страницы, но не копится годами в
 * браузере и не встречает следующего человека за общим компьютером. Доступ к
 * хранилищу может бросить исключение (приватный режим, запрет сайта) — тогда
 * мастер работает как прежде, без черновика.
 *
 * @returns {Storage | null}
 */
export function sessionDraftStorage() {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * Прочитать черновик. Любая порча — чужая версия, не объект, битый JSON,
 * исключение хранилища — даёт `null`, а не ошибку: мастер тогда просто
 * открывается с первого шага.
 *
 * @param {Pick<Storage, 'getItem'> | null | undefined} storage
 * @param {string | null | undefined} key
 * @returns {{ draft: Record<string, unknown>, step: string | null, furthestStep: string | null } | null}
 */
export function readCreationDraft(storage, key) {
  if (!storage || !key) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || parsed.version !== CREATION_DRAFT_VERSION) return null
    const draft = parsed.draft
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null
    return {
      draft,
      step: typeof parsed.step === 'string' ? parsed.step : null,
      furthestStep: typeof parsed.furthestStep === 'string' ? parsed.furthestStep : null,
    }
  } catch {
    return null
  }
}

/**
 * Записать черновик. Возвращает, удалось ли: переполненное или закрытое
 * хранилище не должно ронять мастер посреди выбора.
 *
 * @param {Pick<Storage, 'setItem'> | null | undefined} storage
 * @param {string | null | undefined} key
 * @param {{ draft: unknown, step?: string | null, furthestStep?: string | null }} payload
 * @returns {boolean}
 */
export function writeCreationDraft(storage, key, { draft, step = null, furthestStep = null }) {
  if (!storage || !key) return false
  try {
    storage.setItem(key, JSON.stringify({ version: CREATION_DRAFT_VERSION, draft, step, furthestStep }))
    return true
  } catch {
    return false
  }
}

/**
 * Стереть черновик — после успешного создания героя или когда черновик снова
 * совпал с нетронутым мастером.
 *
 * @param {Pick<Storage, 'removeItem'> | null | undefined} storage
 * @param {string | null | undefined} key
 */
export function clearCreationDraft(storage, key) {
  if (!storage || !key) return
  try {
    storage.removeItem(key)
  } catch {
    /* Закрытое хранилище ничего и не держит. */
  }
}

/**
 * Наложить сохранённый черновик на свежий. Берутся только поля, которые
 * свежий черновик знает, и только той же формы: массив — массивом, объект —
 * объектом, строка — строкой. Необязательные поля без значения по умолчанию
 * перечисляются отдельно вместе с ожидаемым типом. Всё остальное остаётся
 * значением по умолчанию: подменённая или устаревшая запись не должна уронить
 * мастер на `undefined.str`.
 *
 * @template {Record<string, unknown>} T
 * @param {T} base
 * @param {Record<string, unknown> | null | undefined} stored
 * @param {Record<string, 'boolean' | 'string' | 'number'>} [optional]
 * @returns {T}
 */
export function mergeCreationDraft(base, stored, optional = {}) {
  /** @type {Record<string, unknown>} */
  const merged = { ...base }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return /** @type {T} */ (merged)
  for (const [key, value] of Object.entries(stored)) {
    if (value === null || value === undefined) continue
    if (!Object.hasOwn(base, key)) {
      if (optional[key] && typeof value === optional[key]) merged[key] = value
      continue
    }
    const fallback = base[key]
    if (fallback === null || fallback === undefined) continue
    if (Array.isArray(fallback) !== Array.isArray(value) || typeof fallback !== typeof value) continue
    merged[key] = value
  }
  return /** @type {T} */ (merged)
}

/**
 * Медь в подпись золотом: 8500 → «85 зм», 150 → «1.5 зм». Округление до сотых
 * убирает хвосты двоичной дроби вроде «0.30000000000000004 зм».
 *
 * @param {number} copper
 * @returns {string}
 */
export function goldLabel(copper) {
  const value = Number(copper) || 0
  return `${Number((value / 100).toFixed(2))} зм`
}

/**
 * Бюджет стартовых покупок в медных монетах.
 *
 * Плейтест 2026-10-04, стартовое богатство: при остатке 85 зм кираса за 400 зм
 * ложилась в корзину, и мастер писал «осталось -315 зм», будто покупка
 * состоялась. Здесь считается всё, что нужно, чтобы этого не случалось:
 * потрачено, остаток и точное превышение. Цена берётся из каталога мастера по
 * идентификатору, неизвестный предмет стоит ноль — его и так отвергнет сервер.
 * Пока бюджета нет (богатство ещё не брошено), остаток и превышение неизвестны.
 *
 * @param {{ budgetGp?: number | null, purchases?: ReadonlyArray<{ id: string, quantity: number }>, items?: ReadonlyArray<{ id: string, price_cp: number }> }} input
 * @returns {{ spentCp: number, budgetCp: number | null, remainingCp: number | null, overBudgetCp: number }}
 */
export function startingPurchaseBudget({ budgetGp = null, purchases = [], items = [] } = {}) {
  const priceById = new Map(items.map((item) => [String(item.id), Math.max(0, Number(item.price_cp) || 0)]))
  const spentCp = purchases.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0) * (priceById.get(String(item.id)) ?? 0), 0)
  const budget = budgetGp == null ? NaN : Number(budgetGp)
  const budgetCp = Number.isFinite(budget) ? Math.round(budget * 100) : null
  const remainingCp = budgetCp == null ? null : budgetCp - spentCp
  return { spentCp, budgetCp, remainingCp, overBudgetCp: remainingCp != null && remainingCp < 0 ? -remainingCp : 0 }
}

/**
 * Сколько не хватает на очередную покупку: ноль — покупка укладывается в
 * остаток. Пока бюджета нет, нехватку измерить нечем, и кнопка её не выдумывает.
 *
 * @param {{ remainingCp: number | null, priceCp?: number, quantity?: number }} input
 * @returns {number}
 */
export function purchaseShortfallCp({ remainingCp, priceCp = 0, quantity = 1 }) {
  if (remainingCp == null) return 0
  const cost = Math.max(0, Number(priceCp) || 0) * Math.max(0, Number(quantity) || 0)
  return Math.max(0, cost - remainingCp)
}
