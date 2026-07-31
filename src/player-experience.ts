import type { GameEvent, ReputationTier, SceneNpcProjection, SceneNpcStance } from './types'

export const NEWBIE_GUIDE_DISMISSED_KEY = 'skazanie-newbie-guide-dismissed-v1'

/**
 * Публичное следствие уже публичной ступени славы.
 *
 * Сырой score остаётся на сервере. Клиенту достаточно именованной ступени,
 * чтобы честно объяснить применяемую сервером таблицу без восстановления
 * скрытого числа репутации.
 */
const REPUTATION_IMPACT: Record<ReputationTier, { pricePercent: number; socialDcShift: number }> = {
  reviled: { pricePercent: 10, socialDcShift: 3 },
  distrusted: { pricePercent: 5, socialDcShift: 2 },
  unknown: { pricePercent: 0, socialDcShift: 0 },
  respected: { pricePercent: -5, socialDcShift: -1 },
  honoured: { pricePercent: -10, socialDcShift: -2 },
}

export function reputationImpactForTier(tier: ReputationTier) {
  return REPUTATION_IMPACT[tier]
}

export function factionDisplayName(id: string) {
  const words = String(id || '')
    .replace(/^faction:/u, '')
    .replace(/[-_:]+/gu, ' ')
    .trim()
  return words ? words[0].toLocaleUpperCase('ru-RU') + words.slice(1) : 'Неизвестная фракция'
}

const KNOWN_NPC_STANCES = new Set<SceneNpcStance>(['neutral', 'friendly', 'wary', 'hostile', 'panicked'])

export function visibleNpcStance(value: string): SceneNpcStance {
  return KNOWN_NPC_STANCES.has(value as SceneNpcStance) ? value as SceneNpcStance : 'neutral'
}

export function sceneNpcsAt(
  sceneNpcs: readonly SceneNpcProjection[],
  locationId: string,
  bounds: { columns: number; rows: number },
  occupiedIds: ReadonlySet<string>,
) {
  return sceneNpcs.filter((npc) => (
    npc.location_id === locationId
    && Number.isSafeInteger(npc.x) && Number.isSafeInteger(npc.y)
    && npc.x >= 0 && npc.x < bounds.columns && npc.y >= 0 && npc.y < bounds.rows
    && !occupiedIds.has(npc.id)
  ))
}

export type LevelSnapshot = { id: string; level: number; character: string }
export type ConfirmedLevelUp = { playerId: string; character: string; level: number }

/**
 * Находит только подтверждённый рост: либо новый уровень уже появился в
 * server state, либо тот же уровень одновременно объявлен party-visible
 * `CharacterLeveledUp`. Начальная загрузка не считается переходом.
 */
export function confirmedLevelUps(
  previousLevels: Readonly<Record<string, number>>,
  players: readonly LevelSnapshot[],
  events: readonly GameEvent[],
): ConfirmedLevelUp[] {
  const eventLevels = new Map<string, number>()
  for (const event of events) {
    if (event.event_type !== 'CharacterLeveledUp' || !event.actor_id) continue
    const level = Number(event.payload?.level_after)
    if (Number.isSafeInteger(level) && level > 0) eventLevels.set(event.actor_id, level)
  }

  return players.flatMap((player) => {
    const previous = previousLevels[player.id]
    const transitionConfirmed = Number.isSafeInteger(previous) && player.level > previous
    const eventConfirmed = eventLevels.get(player.id) === player.level
    return transitionConfirmed || eventConfirmed
      ? [{ playerId: player.id, character: player.character, level: player.level }]
      : []
  })
}

export function levelUpSeenKey(sessionCode: string, playerId: string, level: number) {
  return `skazanie-level-up-seen-v1:${encodeURIComponent(sessionCode)}:${encodeURIComponent(playerId)}:${level}`
}
