import type { BattleEvent, GameEvent, ReputationTier, SceneNpcProjection, SceneNpcStance } from './types'

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

export function battleEventParticipantIds(event: BattleEvent): string[] {
  return [...new Set([
    event.actorId,
    event.targetId,
    ...(event.participantIds ?? []),
  ].filter((id): id is string => Boolean(id)))]
}

export type DamageHistoryEntry = {
  id: string
  actorId?: string
  amount: number
  damageType?: string
  round?: number
  sceneTurn?: number
}

/** Только уже записанный party-visible урон; текущие ОЗ или скрытые параметры не выводятся. */
export function recentDamageForTarget(
  battleLog: readonly BattleEvent[],
  targetId: string,
  limit = 4,
): DamageHistoryEntry[] {
  return battleLog
    .filter((event) => event.targetId === targetId && Number(event.damage) > 0)
    .slice(-Math.max(0, limit))
    .reverse()
    .map((event) => ({
      id: event.id,
      ...(event.actorId ? { actorId: event.actorId } : {}),
      amount: Number(event.damage),
      ...(event.damageType ? { damageType: event.damageType } : {}),
      ...(event.round != null ? { round: event.round } : {}),
      ...(event.sceneTurn != null ? { sceneTurn: event.sceneTurn } : {}),
    }))
}

const NPC_SUMMARY_TYPES = new Set<BattleEvent['type']>([
  'attack', 'area-attack', 'spell', 'spell-save', 'spell-damage',
  'healing', 'action', 'reaction', 'move', 'summon', 'summon-end',
])

/**
 * Возвращает последний непрерывный блок действий врагов после действия партии.
 * Источник — синхронизируемый battleLog, поэтому сводку видят не только в
 * браузере, который отправил команду и получил эфемерный `npc_turns`.
 */
export function latestNpcTurnEvents(battleLog: readonly BattleEvent[], limit = 6): BattleEvent[] {
  const collected: BattleEvent[] = []
  let foundEnemy = false
  for (let index = battleLog.length - 1; index >= 0; index -= 1) {
    const event = battleLog[index]
    if (event.actorKind === 'player' || event.actorKind === 'summon') break
    if (event.type === 'combat-start' || event.type === 'combat-end' || event.type === 'encounter-ended') break
    if (event.actorKind !== 'enemy' || !NPC_SUMMARY_TYPES.has(event.type)) continue
    foundEnemy = true
    collected.push(event)
    if (collected.length >= Math.max(0, limit)) break
  }
  return foundEnemy ? collected.reverse() : []
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
