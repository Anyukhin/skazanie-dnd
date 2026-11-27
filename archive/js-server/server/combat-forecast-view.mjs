// @ts-check
import { attackForecast } from './rules-engine.mjs'

/**
 * Прогноз удара для конкретного зрителя: шанс попасть, крит, укрытие, дальность.
 *
 * Числа считает `attackForecast` по доверенному состоянию, а здесь решается,
 * что из них этому зрителю можно показать. Жил в `server/index.mjs` до
 * 2026-10-04 и там был непроверяем: импорт `index.mjs` поднимает HTTP-слушателя.
 *
 * Правило раскрытия одно — то же, что у карточки врага в проекции. КД цели
 * открыта ровно тогда, когда `publicEnemyFor` отдал этому зрителю поле `armor`.
 * Пока КД закрыта, закрыты и всё, что из неё выводится: процент попадания при
 * известном бонусе атаки однозначно восстанавливает КД (65% против 40% — это
 * КД 13 против 18). Знание точных хитов КД не открывает: это разные факты
 * `enemy_knowledge` (исследование U01, PR #136).
 *
 * Шанс крита от КД обычно не зависит — натуральная 20 попадает всегда, — и
 * остаётся. Исключение — гарантированный крит при попадании по обездвиженной
 * цели в упор: там шанс крита равен шансу попасть и прячется вместе с ним.
 */

/**
 * @typedef {Record<string, any>} Loose
 * @typedef {{ actor_id: string, targets: Record<string, Loose[]> }} CombatForecast
 */

/**
 * Скрыть из одного варианта удара всё, что выдаёт закрытую КД.
 *
 * @param {Loose} shot
 * @returns {Loose}
 */
function withoutHiddenArmor(shot) {
  return {
    ...shot,
    armor_class: null,
    hit_chance: null,
    critical_chance: shot.critical_on_hit ? null : shot.critical_chance,
    armor_known: false,
  }
}

/**
 * @param {Loose | null | undefined} projected проекция `campaignStateForViewer` для этого зрителя
 * @param {Loose | null | undefined} trustedState доверенное состояние кампании
 * @param {string | null | undefined} viewerActorId герой зрителя
 * @returns {Loose | null | undefined}
 */
export function withCombatForecast(projected, trustedState, viewerActorId) {
  if (!projected || !trustedState?.mechanics?.combat?.active) return projected
  const combat = trustedState.mechanics.combat
  const attackerId = String(combat.initiative?.[combat.active_index ?? 0]?.actor_id ?? '')
  if (!attackerId) return projected
  // Прогноз нужен только тому, кто сейчас ходит: чужой ход игрок не планирует.
  const controls = String(viewerActorId ?? '') === attackerId
    || (projected.players ?? []).some((/** @type {Loose} */ player) => String(player.id) === attackerId)
  if (!controls) return projected
  const attacker = (trustedState.players ?? []).concat(trustedState.actors ?? [])
    .find((/** @type {Loose} */ actor) => String(actor.id) === attackerId)
  if (!attacker) return projected
  const options = [
    ...(attacker.inventory ?? [])
      .filter((/** @type {Loose} */ item) => item?.equipped && item?.combat?.kind)
      .map((/** @type {Loose} */ item) => ({ itemId: String(item.id), label: String(item.name ?? 'Оружие') })),
    { itemId: null, label: 'Базовая атака' },
  ].slice(0, 6)
  /** @type {Record<string, Loose[]>} */
  const forecast = {}
  for (const enemy of trustedState.enemies ?? []) {
    if (!enemy || enemy.alive === false || Number(enemy.hp) <= 0) continue
    const enemyId = String(enemy.id)
    const visible = (projected.enemies ?? []).find((/** @type {Loose} */ candidate) => String(candidate.id) === enemyId)
    if (!visible) continue
    // Источник истины — уже собранная карточка врага для этого зрителя.
    const armorKnown = Object.hasOwn(visible, 'armor')
    /** @type {Loose[]} */
    const entries = []
    for (const option of options) {
      const shot = /** @type {Loose | null} */ (attackForecast(trustedState, attackerId, enemyId, { itemId: option.itemId }))
      if (!shot) continue
      const entry = { ...shot, label: option.label, item_id: option.itemId, armor_known: true }
      entries.push(armorKnown ? entry : withoutHiddenArmor(entry))
    }
    if (entries.length) forecast[enemyId] = entries
  }
  return Object.keys(forecast).length
    ? { ...projected, combatForecast: /** @type {CombatForecast} */ ({ actor_id: attackerId, targets: forecast }) }
    : projected
}
