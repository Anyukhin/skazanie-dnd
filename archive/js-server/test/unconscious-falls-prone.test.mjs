import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// Боевой плейтест 2026-10-03: герой на нуле хитов получал «без сознания», но
// не «сбит с ног». По правилам обеих редакций бессознательный падает, и
// поднятый лечением сначала встаёт за половину скорости.

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `prone-roll-${++id}`, now: () => '2026-10-03T12:00:00.000Z' })
}

const applyAll = (state, events) => events.reduce((current, event) => applyGameEvent(current, event), state)
const conditionsOf = (state, id) => (state.mechanics.conditions[id] ?? []).map((condition) => condition.id)

function fixture() {
  const cells = Array.from({ length: 15 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'PRONE-AT-ZERO',
    partyMemberIds: ['fallen'],
    players: [{ id: 'fallen', character: 'Кел', characterClass: 'fighter', level: 3, hp: 4, maxHp: 28, armor: 16, speed: 30, proficiency: 2, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, x: 2, y: 1, inventory: [] }],
    enemies: [{ id: 'foe', name: 'Враг', hp: 20, maxHp: 20, armor: 12, speed: 30, attackBonus: 4, damageDice: 6, damageBonus: 2, x: 3, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      positions: { fallen: { x: 2, y: 1 }, foe: { x: 3, y: 1 } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'fallen', total: 15 }, { actor_id: 'foe', total: 8 }],
        action_economy: { fallen: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

test('упавший на нуле герой и без сознания, и сбит с ног; replay даёт то же', () => {
  const initial = fixture()
  const hit = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'foe', target_id: 'fallen', amount: 6, damage_type: 'slashing' }, initial, { diceService: dice() })
  assert.deepEqual(hit.events.map((event) => event.event_type), ['DamageApplied', 'HitPointsReducedToZero', 'ConditionAdded'])
  const prone = hit.events[2]
  assert.equal(prone.payload.condition, 'prone')
  assert.equal(prone.payload.trigger, 'unconscious')
  const after = applyAll(initial, hit.events)
  assert.deepEqual(conditionsOf(after, 'fallen').sort(), ['prone', 'unconscious'])
  assert.deepEqual(replayEvents(initial, hit.events), after)
})

test('поднятый лечением остаётся лежать и встаёт за половину скорости', () => {
  const initial = fixture()
  const hit = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'foe', target_id: 'fallen', amount: 6, damage_type: 'slashing' }, initial, { diceService: dice() })
  const down = applyAll(initial, hit.events)
  const healed = applyAll(down, resolveCommand({ command_type: 'ApplyHealing', actor_id: 'fallen', target_id: 'fallen', amount: 5 }, down, { diceService: dice([5]) }).events)
  assert.ok(healed.players[0].hp > 0)
  assert.deepEqual(conditionsOf(healed, 'fallen'), ['prone'])
  const stood = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fallen', action_id: 'stand-up', server_authoritative: true }, healed, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const standing = applyAll(healed, stood.events)
  assert.deepEqual(conditionsOf(standing, 'fallen'), [])
  assert.equal(standing.mechanics.combat.action_economy.fallen.movement_spent, 15)
})

test('лежащего повторно не роняют, а старое падение без события позы остаётся как было', () => {
  const initial = fixture()
  initial.mechanics.conditions.fallen = [{ id: 'prone' }]
  const hit = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'foe', target_id: 'fallen', amount: 6, damage_type: 'slashing' }, initial, { diceService: dice() })
  assert.deepEqual(hit.events.map((event) => event.event_type), ['DamageApplied', 'HitPointsReducedToZero'])
  // Событие падения, записанное до правила, позы не меняет.
  const legacy = fixture()
  const legacyHit = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'foe', target_id: 'fallen', amount: 6, damage_type: 'slashing' }, legacy, { diceService: dice() })
  const replayed = replayEvents(legacy, legacyHit.events.filter((event) => event.event_type !== 'ConditionAdded'))
  assert.deepEqual(conditionsOf(replayed, 'fallen'), ['unconscious'])
})
