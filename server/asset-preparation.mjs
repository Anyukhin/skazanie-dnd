/**
 * Режим подготовки ассетов — задача 5.1 плана `docs/experience-upgrade-plan.md`.
 *
 * Решение владельца: во время игры картинки не генерируются вовсе. Вечер стоит
 * около 50 ₽, и генерация изображений — заметная его часть; платить за неё
 * посреди хода, пока стол ждёт, незачем. Поэтому картинки готовятся заранее:
 * ведущий заходит в подготовку, видит, у кого портрета ещё нет, и запускает
 * генерацию до начала игры.
 *
 * Подготовка работает **независимо** от рантайм-флага: он выключает генерацию
 * в игровых путях, а не в подготовке. Иначе выключенный флаг закрывал бы и
 * единственный способ картинки получить.
 *
 * Здесь нет ни своего генератора, ни своего кеша: всё идёт через уже
 * существующий `NpcPortraitService` — тот же путь, тот же каталог, тот же
 * usage-леджер. Второго авторитетного места для портретов быть не должно.
 */

export const ASSET_PREPARATION_POLICY_ID = 'skazanie:asset-preparation-v1'

/**
 * Потолок одного запуска. Он не про безопасность, а про деньги: двадцать
 * портретов — это уже заметная сумма, и списывать её молча одним нажатием
 * нельзя.
 */
export const MAX_PREPARATION_BATCH = 20

const text = (value, maximum = 160) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/**
 * Предметы кампании без иллюстрации. Список **информационный**: собственного
 * серверного кеша у предметных картинок нет — их URL живёт на самой записи
 * предмета и проставляется редактором, поэтому «сгенерировать за игрока» здесь
 * значило бы завести второй авторитетный путь к инвентарю. Показать пробел
 * честнее, чем сделать вид, что его нет.
 *
 * @param {any} state
 * @returns {Array<{ id: string, name: string, owner_id: string }>}
 */
export function itemsWithoutIllustration(state) {
  const seen = new Set()
  const gaps = []
  for (const player of Array.isArray(state?.players) ? state.players : []) {
    for (const item of Array.isArray(player?.inventory) ? player.inventory : []) {
      const id = text(item?.id, 120)
      const image = text(item?.image, 400)
      if (!id || image || seen.has(id)) continue
      seen.add(id)
      gaps.push({ id, name: text(item?.name, 120) || id, owner_id: text(player?.id, 120) })
    }
  }
  return gaps.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * NPC кампании, у которых уже есть или ещё нет портрета в кеше.
 *
 * Значимость проверяется тем же правилом, что и в игре: второстепенному NPC
 * портрет не рисуется и в подготовке — иначе ведущий платил бы за картинки,
 * которых игрок всё равно не увидит.
 *
 * @param {{ service: any, campaignId: string, projectedState: any, significance: (state: any, profile: any) => boolean, profiles: any[] }} input
 */
export async function npcPortraitInventory({ service, campaignId, projectedState, significance, profiles }) {
  const entries = []
  for (const profile of profiles) {
    if (!significance(projectedState, profile)) continue
    const cached = await service.cached(campaignId, profile.id)
    entries.push({
      id: text(profile.id, 120),
      name: text(profile.name, 120) || text(profile.id, 120),
      role: text(profile.role, 120),
      has_portrait: Boolean(cached),
    })
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Что подготовка сделает с запрошенным списком. Разбор отделён от исполнения,
 * чтобы отказ по капу был проверяем без единого обращения к генератору.
 *
 * @param {unknown} requested
 * @param {Array<{ id: string, has_portrait: boolean }>} inventory
 * @param {{ regenerate?: boolean }} [options]
 */
export function planPreparation(requested, inventory, { regenerate = false } = {}) {
  const known = new Map(inventory.map((entry) => [entry.id, entry]))
  const ids = [...new Set((Array.isArray(requested) ? requested : []).map((value) => text(value, 120)).filter(Boolean))]
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length) {
    return { ok: false, code: 'UNKNOWN_ASSET', message: `Неизвестные NPC: ${unknown.slice(0, 5).join(', ')}`, ids: [] }
  }
  if (!ids.length) return { ok: false, code: 'NOTHING_REQUESTED', message: 'Не выбрано ни одной позиции', ids: [] }
  if (ids.length > MAX_PREPARATION_BATCH) {
    return {
      ok: false,
      code: 'BATCH_TOO_LARGE',
      message: `За один запуск готовится не больше ${MAX_PREPARATION_BATCH} позиций: генерация стоит денег, и списывать их молча нельзя`,
      ids: [],
    }
  }
  // Без явной перегенерации уже готовое пропускается: платить второй раз за ту
  // же картинку незачем.
  return { ok: true, code: null, message: '', ids: regenerate ? ids : ids.filter((id) => known.get(id)?.has_portrait !== true) }
}
