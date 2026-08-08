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
 * существующие `NpcPortraitService` и `LocationIllustrationService` — тот же
 * путь к модели, те же каталоги, тот же usage-леджер. Второго авторитетного
 * места для картинок быть не должно.
 */

export const ASSET_PREPARATION_POLICY_ID = 'skazanie:asset-preparation-v1'

/**
 * Потолок одного запуска — **общий на все виды картинок**. Он не про
 * безопасность, а про деньги: двадцать генераций — это уже заметная сумма, и
 * списывать её молча одним нажатием нельзя. Раздельные потолки по видам
 * означали бы, что счёт вечера растёт вдвое быстрее при тех же цифрах на
 * экране.
 */
export const MAX_PREPARATION_BATCH = 20

/**
 * Виды подготовки. Таблица одна на разбор запроса и на ответ, чтобы добавление
 * третьего вида не превращалось в третью копию проверок капа и неизвестных id.
 */
const PREPARATION_GROUPS = Object.freeze([
  { requestKey: 'npc_ids', inventoryKey: 'npcs', readyKey: 'has_portrait', label: 'NPC' },
  { requestKey: 'location_ids', inventoryKey: 'locations', readyKey: 'has_illustration', label: 'локации' },
])

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

const EMPTY_SELECTION = Object.freeze({ npc_ids: [], location_ids: [] })

/**
 * Что подготовка сделает с запрошенным списком. Разбор отделён от исполнения,
 * чтобы отказ по капу был проверяем без единого обращения к генератору.
 *
 * @param {unknown} requested `{ npc_ids, location_ids }` из тела запроса
 * @param {{ npcs?: Array<{ id: string, has_portrait?: boolean }>, locations?: Array<{ id: string, has_illustration?: boolean }> }} inventories
 * @param {{ regenerate?: boolean }} [options]
 * @returns {{ ok: boolean, code: string | null, message: string, npc_ids: string[], location_ids: string[] }}
 */
export function planPreparation(requested, inventories, { regenerate = false } = {}) {
  const body = requested && typeof requested === 'object' && !Array.isArray(requested) ? requested : {}
  const refuse = (code, message) => ({ ok: false, code, message, ...EMPTY_SELECTION })
  /** @type {Record<string, string[]>} */
  const asked = {}
  /** @type {Record<string, string[]>} */
  const selected = {}
  let total = 0

  for (const group of PREPARATION_GROUPS) {
    const inventory = Array.isArray(inventories?.[group.inventoryKey]) ? inventories[group.inventoryKey] : []
    const known = new Map(inventory.map((entry) => [entry.id, entry]))
    const ids = [...new Set((Array.isArray(body[group.requestKey]) ? body[group.requestKey] : [])
      .map((value) => text(value, 120)).filter(Boolean))]
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length) return refuse('UNKNOWN_ASSET', `Неизвестные ${group.label}: ${unknown.slice(0, 5).join(', ')}`)
    asked[group.requestKey] = ids
    total += ids.length
    // Без явной перегенерации уже готовое пропускается: платить второй раз за
    // ту же картинку незачем.
    selected[group.requestKey] = regenerate ? ids : ids.filter((id) => known.get(id)?.[group.readyKey] !== true)
  }

  if (!total) return refuse('NOTHING_REQUESTED', 'Не выбрано ни одной позиции')
  if (total > MAX_PREPARATION_BATCH) {
    return refuse(
      'BATCH_TOO_LARGE',
      `За один запуск готовится не больше ${MAX_PREPARATION_BATCH} позиций: генерация стоит денег, и списывать их молча нельзя`,
    )
  }
  return {
    ok: true,
    code: null,
    message: '',
    npc_ids: selected.npc_ids,
    location_ids: selected.location_ids,
  }
}
