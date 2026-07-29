const QUEST_CLOCK_LABELS = new Map([
  ['scene objective', 'Цель сцены'],
])

/** @param {string | null | undefined} label */
export function localizedQuestClockLabel(label) {
  const clean = String(label ?? '').trim()
  if (!clean) return 'Часы задачи'
  return QUEST_CLOCK_LABELS.get(clean.toLocaleLowerCase('en')) ?? clean
}

/**
 * @param {{ heroCount: number, membershipCount: number, requestedRoom?: string | null }} input
 */
export function shouldAutoOpenCampaignModal(input) {
  return input.heroCount === 0
    && input.membershipCount === 0
    && !String(input.requestedRoom ?? '').trim()
}

/**
 * @param {{ x: number, y: number, dir: 'e' | 's' }} door
 * @param {{ x: number, y: number }} actor
 */
export function doorDirectionFromActor(door, actor) {
  const neighbor = door.dir === 'e'
    ? { x: door.x + 1, y: door.y }
    : { x: door.x, y: door.y + 1 }
  const target = actor.x === door.x && actor.y === door.y
    ? neighbor
    : { x: door.x, y: door.y }
  const dx = target.x - actor.x
  const dy = target.y - actor.y
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'восток' : 'запад'
  return dy > 0 ? 'юг' : 'север'
}

/** @param {{ x: number, y: number, dir: 'e' | 's' }} door */
export function doorOverlayCells(door) {
  return door.dir === 'e'
    ? [{ x: door.x, y: door.y }, { x: door.x + 1, y: door.y }]
    : [{ x: door.x, y: door.y }, { x: door.x, y: door.y + 1 }]
}

/**
 * Выбирает уже рассчитанный сервером прогноз для пары «цель + оружие».
 * Без цели возвращать сведения об атаке нельзя: у них нет самостоятельного
 * клиентского смысла вне конкретного противника.
 *
 * @template T
 * @param {Record<string, T[]> | null | undefined} targets
 * @param {string | null | undefined} targetId
 * @param {string | null | undefined} itemId
 * @returns {T | null}
 */
export function selectedAttackForecast(targets, targetId, itemId) {
  if (!targetId) return null
  const entries = targets?.[targetId] ?? []
  if (!entries.length) return null
  return entries.find((entry) => /** @type {{ item_id?: string | null }} */ (entry).item_id === (itemId ?? null))
    ?? entries[0]
    ?? null
}
