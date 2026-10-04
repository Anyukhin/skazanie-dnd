/**
 * Черновик мастера создания героя в хранилище браузера.
 *
 * До 2026-10-04 черновик жил только в памяти компонента: закрыл окно или
 * обновил страницу — и всё, что набрал за двадцать минут, пропало (OB-01,
 * исследование PR #136, U02). Здесь он сохраняется на этом устройстве.
 *
 * Это удобство, а не источник истины: всё, что игрок отправит, сервер
 * проверяет заново, а броски характеристик и стартового золота живут на
 * сервере (`characterCreationRolls`). Поэтому черновик никогда не подменяет
 * серверный бросок, а устаревший или чужой черновик просто не предлагается.
 *
 * Ключ различает аккаунт, кампанию, место героя и редакцию: два игрока за
 * одним компьютером и два стола одного игрока не видят чужих черновиков.
 */

export const CHARACTER_DRAFT_VERSION = 1
/** Две недели: старше — каталог и правила могли уйти вперёд, лучше начать заново. */
export const CHARACTER_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const PREFIX = 'skazanie-character-draft'

/**
 * @param {{ accountId?: unknown, sessionCode?: unknown, playerId?: unknown, rulesetId?: unknown }} owner
 * @returns {string} пустая строка, если владельца не назвать однозначно
 */
export function characterDraftKey({ accountId, sessionCode, playerId, rulesetId } = {}) {
  const parts = [accountId, sessionCode, playerId].map((value) => String(value ?? '').trim())
  if (parts.some((part) => !part)) return ''
  return [PREFIX, `v${CHARACTER_DRAFT_VERSION}`, ...parts, String(rulesetId ?? '').trim() || 'default'].join(':')
}

/** Хранилище может отсутствовать или бросать (приватный режим, запрет сайта). */
function storageOf(storage) {
  if (storage) return storage
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * @param {string} key
 * @param {{ draft: object, step: string, furthestStep: string }} snapshot
 * @param {{ storage?: Storage | null, now?: number }} [options]
 * @returns {boolean} записалось ли
 */
export function saveCharacterDraft(key, snapshot, { storage, now = Date.now() } = {}) {
  const target = storageOf(storage)
  if (!key || !target || !snapshot?.draft) return false
  try {
    target.setItem(key, JSON.stringify({
      version: CHARACTER_DRAFT_VERSION,
      saved_at: now,
      step: String(snapshot.step ?? ''),
      furthest_step: String(snapshot.furthestStep ?? ''),
      draft: snapshot.draft,
    }))
    return true
  } catch {
    return false
  }
}

/**
 * Сохранённый черновик или `null`. Не тот формат, просрочен, класса больше нет
 * в каталоге — `null`, и запись стирается: предлагать её бессмысленно.
 *
 * @param {string} key
 * @param {{ storage?: Storage | null, now?: number, knownClassIds?: string[], knownSteps?: string[] }} [options]
 * @returns {{ draft: Record<string, unknown>, step: string, furthestStep: string, savedAt: number } | null}
 */
export function loadCharacterDraft(key, { storage, now = Date.now(), knownClassIds = [], knownSteps = [] } = {}) {
  const target = storageOf(storage)
  if (!key || !target) return null
  let raw = null
  try {
    raw = target.getItem(key)
  } catch {
    return null
  }
  if (!raw) return null
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  const savedAt = Number(parsed?.saved_at)
  const draft = parsed?.draft
  const valid = parsed?.version === CHARACTER_DRAFT_VERSION
    && Number.isFinite(savedAt) && savedAt <= now && now - savedAt <= CHARACTER_DRAFT_MAX_AGE_MS
    && draft && typeof draft === 'object' && !Array.isArray(draft)
    && (!knownClassIds.length || knownClassIds.includes(String(draft.classId ?? '')))
  if (!valid) {
    clearCharacterDraft(key, { storage: target })
    return null
  }
  const step = knownSteps.includes(String(parsed.step)) || !knownSteps.length ? String(parsed.step ?? '') : ''
  const furthestStep = knownSteps.includes(String(parsed.furthest_step)) || !knownSteps.length ? String(parsed.furthest_step ?? '') : ''
  return { draft, step, furthestStep, savedAt }
}

/**
 * @param {string} key
 * @param {{ storage?: Storage | null }} [options]
 */
export function clearCharacterDraft(key, { storage } = {}) {
  const target = storageOf(storage)
  if (!key || !target) return
  try {
    target.removeItem(key)
  } catch {
    // Стереть не вышло — черновик истечёт по сроку.
  }
}
