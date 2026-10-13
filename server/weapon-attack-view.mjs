// @ts-check
import { weaponAttackSummary } from './rules-engine.mjs'

/**
 * Сводка удара надетым оружием для куклы героя во вкладке «Вещи».
 *
 * Числа считает Rules Engine (`weaponAttackSummary`) по доверенному
 * состоянию — тем же путём, что и настоящая атака. Сводка ложится только на
 * вещи своего героя — как сводка заклинателя у портрета: инвентарь соседа по
 * столу проекция показывает, а его модификатор удара — нет. Ведущему (зритель
 * без героя) сводка идёт по всем. Клиент число не выводит сам: без сводки
 * кукла показывает только кость урона.
 *
 * @typedef {Record<string, any>} Loose
 * @param {Loose | null | undefined} projected проекция `campaignStateForViewer` для этого зрителя
 * @param {Loose | null | undefined} trustedState доверенное состояние кампании
 * @param {string | null | undefined} [viewerActorId] герой зрителя; пусто — ведущий
 * @returns {Loose | null | undefined}
 */
export function withWeaponAttackSummaries(projected, trustedState, viewerActorId = '') {
  const viewer = String(viewerActorId ?? '')
  if (!projected || !Array.isArray(projected.players) || !trustedState) return projected
  let changed = false
  const players = projected.players.map((/** @type {Loose} */ player) => {
    if (!Array.isArray(player?.inventory) || (viewer && String(player?.id ?? '') !== viewer)) return player
    let touched = false
    const inventory = player.inventory.map((/** @type {Loose} */ item) => {
      if (!item?.equipped || !item?.combat) return item
      const summary = weaponAttackSummary(trustedState, String(player.id), String(item.id))
      if (!summary) return item
      touched = true
      return { ...item, attack_summary: summary }
    })
    if (!touched) return player
    changed = true
    return { ...player, inventory }
  })
  return changed ? { ...projected, players } : projected
}
