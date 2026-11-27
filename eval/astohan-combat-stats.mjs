// Классификация результатов журнала только для отчёта стенда.
const VICTORIES = new Set(['enemies_defeated', 'fled'])

export function combatJournalStats(events, heroIds) {
  const heroes = new Set(heroIds)
  const outcomes = new Map()
  const result = { combats: 0, combatWins: 0, combatRounds: 0, heroDowns: 0, heroDeaths: 0 }
  for (const event of events) {
    switch (event.event_type) {
      case 'CombatStarted':
        result.combats += 1
        break
      case 'CombatEnded': {
        const reason = event.payload?.reason || 'unknown'
        result.combatRounds += Number(event.payload?.round) || 0
        if (VICTORIES.has(reason)) result.combatWins += 1
        outcomes.set(reason, (outcomes.get(reason) ?? 0) + 1)
        break
      }
      case 'HitPointsReducedToZero':
        if (event.target_ids?.some((id) => heroes.has(id))) result.heroDowns += 1
        break
      case 'HeroDied':
        if (event.target_ids?.some((id) => heroes.has(id))) result.heroDeaths += 1
        break
    }
  }
  return { ...result, combatOutcomes: Object.fromEntries(outcomes) }
}
