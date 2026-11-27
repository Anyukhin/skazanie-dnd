import assert from 'node:assert/strict'
import test from 'node:test'
import { combatJournalStats } from '../eval/astohan-combat-stats.mjs'

test('опустевшая карта после поражения не превращает бой в победу и не стирает падения', () => {
  const event = (event_type, target_ids = [], payload = {}) => ({ event_type, target_ids, payload })
  const result = combatJournalStats([
    event('CombatStarted'),
    event('HitPointsReducedToZero', ['fighter']),
    event('HealingApplied', ['fighter']),
    event('HitPointsReducedToZero', ['fighter']),
    event('HitPointsReducedToZero', ['enemy']),
    event('HeroDied', ['fighter']),
    event('CombatEnded', [], { reason: 'party_incapacitated', round: 5 }),
    event('CombatStarted'),
    event('CombatEnded', [], { reason: 'enemies_defeated', round: 3 }),
    event('CombatStarted'),
    event('CombatEnded', [], { reason: 'fled', round: 2 }),
  ], ['fighter'])
  assert.deepEqual(result, {
    combats: 3, combatWins: 2, combatRounds: 10, heroDowns: 2, heroDeaths: 1,
    combatOutcomes: { party_incapacitated: 1, enemies_defeated: 1, fled: 1 },
  })
})
