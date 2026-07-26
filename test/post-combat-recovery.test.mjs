import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { lootOwnerId, partyOrderIds } from '../server/autonomous-orchestrator.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `recovery-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const applyAll = (state, events) => events.reduce(applyGameEvent, state)

/**
 * The battle is won and the party is out of combat, but one hero is still at 0
 * hit points and stable.  This is the state the autonomous loop reaches after a
 * hard fight, and the order of what happens next is the whole point: a long
 * rest is worth nothing until that hero is conscious again.
 */
function afterVictory() {
  return normalizeCampaignState({
    sessionCode: 'RECOVERY-1',
    partyMemberIds: ['warden', 'fallen'],
    players: [
      { id: 'warden', character: 'Страж', characterClass: 'fighter', level: 5, hp: 18, maxHp: 40, armor: 17, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1 },
      { id: 'fallen', character: 'Павший', characterClass: 'rogue', level: 5, hp: 0, maxHp: 30, armor: 15, speed: 30, proficiency: 3, abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 10, cha: 12 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [],
    scene: { turn: 1, cells: Array.from({ length: 20 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5), type: 'floor', revealed: true })) },
    mechanics: {
      conditions: { fallen: [{ id: 'unconscious' }] },
      death: { saving_throws: { fallen: { successes: 3, failures: 0, stable: true } }, heroes: {}, campaign_status: 'active' },
      world_time: { elapsed_minutes: 0 },
      combat: { active: false, round: 0, initiative: [], active_index: -1, action_economy: {}, reaction_window: null },
    },
  })
}

test('длительный отдых недоступен герою с 0 ОЗ — правило ruleset остаётся в силе', () => {
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'StartRest', actor_id: 'fallen', kind: 'long' }), afterVictory(), options(dice())),
    (error) => error.code === 'REST_ACTOR_INCAPACITATED',
  )
})

test('четыре часа поднимают стабильного героя до 1 ОЗ, и отдых становится доступен', () => {
  const state = afterVictory()
  // 1к4 часа — не больше четырёх, поэтому 240 минут гарантированно закрывают срок.
  const advanced = resolveCommand(authoritative({ command_type: 'AdvanceTime', amount: 240, unit: 'minute' }), state, options(dice([4])))
  const scheduled = advanced.events.find((event) => event.event_type === 'StableRecoveryScheduled')
  assert.equal(scheduled.payload.recovery_hours, 4)
  const healed = advanced.events.find((event) => event.event_type === 'HealingApplied' && event.target_ids.includes('fallen'))
  assert.equal(healed.payload.reason, 'stable-recovery-after-1d4-hours')
  assert.equal(healed.payload.hp_after, 1)

  const awake = applyAll(state, advanced.events)
  assert.equal(awake.players.find((hero) => hero.id === 'fallen').hp, 1)
  assert.deepEqual(replayEvents(state, advanced.events), awake)

  const rest = resolveCommand(authoritative({ command_type: 'StartRest', actor_id: 'fallen', kind: 'long' }), awake, options(dice()))
  assert.ok(rest.events.some((event) => event.event_type === 'RestStarted'))
})

test('добыча после победы достаётся живому герою, а не первому в списке', () => {
  const state = afterVictory()
  assert.deepEqual(partyOrderIds(state), ['warden', 'fallen'])
  assert.equal(lootOwnerId(state), 'warden', 'без погибших добычу берёт первый по списку')

  const wardenFell = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, death: { ...state.mechanics.death, heroes: { warden: { status: 'dead' } } } },
  })
  assert.equal(lootOwnerId(wardenFell), 'fallen', 'погибший не может быть автором команды выдачи предмета')

  const everyoneFell = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, death: { ...state.mechanics.death, heroes: { warden: { status: 'dead' }, fallen: { status: 'dead' } } } },
  })
  assert.equal(lootOwnerId(everyoneFell), 'warden', 'если живых нет, выбор остаётся детерминированным')
})

test('короткого ожидания не хватает: срок только уменьшается, отдых по-прежнему закрыт', () => {
  const state = afterVictory()
  const advanced = resolveCommand(authoritative({ command_type: 'AdvanceTime', amount: 60, unit: 'minute' }), state, options(dice([3])))
  const progressed = advanced.events.find((event) => event.event_type === 'StableRecoveryProgressed')
  assert.equal(progressed.payload.recovery_minutes_before, 180)
  assert.equal(progressed.payload.recovery_minutes_remaining, 120)
  const waiting = applyAll(state, advanced.events)
  assert.equal(waiting.players.find((hero) => hero.id === 'fallen').hp, 0)
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'StartRest', actor_id: 'fallen', kind: 'long' }), waiting, options(dice())),
    (error) => error.code === 'REST_ACTOR_INCAPACITATED',
  )
})
