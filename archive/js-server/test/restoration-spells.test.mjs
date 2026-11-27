import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `restore-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

/** Жрец рядом с союзником, на котором висят разом паралич и отравление. */
function afflictedParty(conditions = [{ id: 'paralyzed' }, { id: 'poisoned' }]) {
  const cells = Array.from({ length: 30 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'RESTORE-1',
    partyMemberIds: ['cleric', 'ally'],
    players: [
      { id: 'cleric', character: 'Мира', characterClass: 'cleric', level: 5, hp: 30, maxHp: 30, armor: 16, speed: 30, proficiency: 3, abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 18, cha: 12 }, inventory: [], x: 1, y: 1 },
      { id: 'ally', character: 'Бранн', characterClass: 'fighter', level: 5, hp: 30, maxHp: 40, armor: 17, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [{ id: 'foe', name: 'Враг', hp: 40, maxHp: 40, armor: 12, speed: 30, abilities: {}, x: 6, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions: { ally: conditions },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'cleric', total: 20 }, { actor_id: 'ally', total: 15 }, { actor_id: 'foe', total: 8 }],
        action_economy: { cleric: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const cast = (state, spellId, extra = {}) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: spellId, target_id: 'ally', target_ids: ['ally'], ...extra }),
  state,
  options(dice()),
)

test('Малое восстановление снимает ровно то состояние, которое выбрал заклинатель', () => {
  const state = afflictedParty()
  const cured = cast(state, 'lesser-restoration', { spell_option: 'paralyzed' })
  const removed = cured.events.filter((event) => event.event_type === 'ConditionRemoved').map((event) => event.payload.condition)
  assert.deepEqual(removed, ['paralyzed'], 'снимается только выбранное состояние')

  const after = replayEvents(state, cured.events)
  const left = (after.mechanics.conditions.ally ?? []).map((condition) => condition.id)
  assert.deepEqual(left, ['poisoned'], 'отравление остаётся, его лечат отдельно')
})

test('Малое восстановление требует выбора и не накладывает отравление вместо лечения', () => {
  const state = afflictedParty()
  assert.throws(
    () => cast(state, 'lesser-restoration'),
    (error) => error.code === 'SPELL_OPTION_REQUIRED',
  )
  const cured = cast(state, 'lesser-restoration', { spell_option: 'poisoned' })
  assert.equal(cured.events.some((event) => event.event_type === 'ConditionAdded'), false, 'автогенерация накладывала отравление — исправлено')
})

test('снятие того, чего нет, не создаёт события', () => {
  const healthy = afflictedParty([])
  const cured = cast(healthy, 'lesser-restoration', { spell_option: 'blinded' })
  assert.equal(cured.events.some((event) => event.event_type === 'ConditionRemoved'), false)
  assert.ok(cured.events.some((event) => event.event_type === 'SpellCast'))
})

test('Защита от яда снимает отравление и даёт сопротивление урону ядом', () => {
  const state = afflictedParty([{ id: 'poisoned' }])
  const warded = cast(state, 'protection-from-poison')
  assert.ok(warded.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'poisoned'))
  assert.ok(warded.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'protected-from-poison'))

  const protectedState = replayEvents(state, warded.events)
  const hit = resolveCommand(
    authoritative({ command_type: 'ApplyDamage', actor_id: 'cleric', target_id: 'ally', amount: 10, damage_type: 'poison' }),
    protectedState,
    options(dice()),
  )
  const payload = hit.events.find((event) => event.event_type === 'DamageApplied').payload
  assert.equal(payload.resistant, true)
  assert.equal(payload.applied_amount, 5, 'сопротивление обязано делить урон ядом пополам')

  const fire = resolveCommand(
    authoritative({ command_type: 'ApplyDamage', actor_id: 'cleric', target_id: 'ally', amount: 10, damage_type: 'fire' }),
    protectedState,
    options(dice()),
  )
  assert.equal(fire.events.find((event) => event.event_type === 'DamageApplied').payload.resistant, false, 'сопротивление только к яду')
})

test('исход восстановления воспроизводится replay-ем', () => {
  const state = afflictedParty()
  const cured = cast(state, 'lesser-restoration', { spell_option: 'paralyzed' })
  const applied = cured.events.reduce((current, event) => replayEvents(current, [event]), state)
  assert.deepEqual(replayEvents(state, cured.events), applied)
})
