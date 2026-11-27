import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// «Призыв низших демонов» D&D 2014: демоны враждебны всем, включая
// заклинателя. Стенд: заклинатель (2,2, инициатива 20) → противник (3,2, 10)
// → союзник (2,3, 5).

const context = (actorId = 'caster') => ({ serverAuthoritativeCombat: true, allowedActorIds: [actorId] })
const dice = (mode = 'low') => new DiceService({ rng: { randint: (min, max) => (mode === 'low' ? min : max) } })

function summon({ mode = 'low', to = { x: 12, y: 12 }, mutate } = {}) {
  const { state, command } = spellRuntimeFixture('summon-lesser-demons')
  state.scene.cells = Array.from({ length: 400 }, (_, index) => ({ x: index % 20, y: Math.floor(index / 20), type: 'floor', revealed: true }))
  mutate?.(state)
  const initial = structuredClone(state)
  const result = resolveCommand({ ...command, to, server_authoritative: true }, state, { diceService: dice(mode), context: context() })
  const after = result.events.reduce(applyGameEvent, state)
  return { initial, events: result.events, state: after, demons: after.enemies.filter((enemy) => enemy.kind === 'summon') }
}
const turnOf = (state, actorId) => {
  const next = structuredClone(state)
  next.mechanics.combat.active_index = next.mechanics.combat.initiative.findIndex((entry) => entry.actor_id === actorId)
  return next
}

test('к6 решает состав: единица — двое демонов ПО 1, шестёрка — восьмеро ПО 1/4', () => {
  const few = summon({ mode: 'low' })
  assert.equal(few.demons.length, 2)
  assert.ok(few.demons.every((demon) => demon.name.startsWith('Пастный демон') && demon.maxHp === 33))
  const many = summon({ mode: 'high' })
  assert.equal(many.demons.length, 8)
  assert.ok(many.demons.every((demon) => demon.name.startsWith('Дретч')))
})

test('демоны встают к противникам, не подчиняются заклинателю и ходят в своей инициативе', () => {
  const { initial, events, state, demons } = summon({ mode: 'low' })
  assert.equal((state.actors ?? []).some((actor) => actor.kind === 'summon'), false)
  for (const demon of demons) {
    assert.equal(demon.faction, 'hostile')
    assert.equal(demon.hostile_to_all, true)
    assert.equal(demon.controllerId, undefined)
    assert.equal(demon.attack_profile.attack_modifier, 4, 'свой бонус атаки, а не заклинателя')
  }
  const initiativeRoll = events.find((event) => event.event_type === 'DieRolled' && event.payload.summon_initiative)
  assert.equal(initiativeRoll.payload.total, 1 + -1, 'к20 = 1, Ловкость 8 → −1')
  assert.deepEqual(state.mechanics.combat.initiative.map((entry) => entry.actor_id).slice(-2), demons.map((demon) => demon.id), 'бросок 0 — в хвосте очереди')
  assert.deepEqual(JSON.parse(JSON.stringify(replayEvents(initial, JSON.parse(JSON.stringify(events))))), JSON.parse(JSON.stringify(state)))

  const command = { command_type: 'MakeAttack', actor_id: 'caster', target_id: demons[0].id, server_authoritative: true }
  assert.throws(() => resolveCommand({ ...command, actor_id: demons[0].id, target_id: 'enemy' }, turnOf(state, demons[0].id), { diceService: dice(), context: context('caster') }),
    (error) => ['ACTOR_FORBIDDEN', 'OUT_OF_TURN', 'ACTOR_NOT_ALLOWED'].includes(error?.code) || /не может|недоступ|чуж/iu.test(error?.message ?? ''),
    'заклинатель не командует демоном')
})

test('демон бьёт ближайшего не-демона — хоть прежнего врага отряда', () => {
  const { state, demons } = summon({ mode: 'low', to: { x: 12, y: 2 }, mutate: (draft) => {
    draft.mechanics.positions.enemy = { x: 11, y: 2 }
  } })
  const demon = demons.find((candidate) => Math.abs(state.mechanics.positions[candidate.id].x - 11) <= 1 && Math.abs(state.mechanics.positions[candidate.id].y - 2) <= 1)
  const live = turnOf(state, demon.id)
  const plan = planNpcTurn(live, demon.id)
  const attack = plan.find((command) => command.command_type === 'MakeAttack')
  assert.equal(attack?.target_id, 'enemy')
  const result = resolveCommand({ ...attack, server_authoritative: true }, live, { diceService: dice('high'), context: { serverAuthoritativeCombat: true, isNpcScheduler: true, allowedActorIds: [demon.id] } })
  assert.ok(result.events.some((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('enemy')))
})

test('прочие противники тоже бьют демонов, а заклинатель может атаковать их', () => {
  const { state, demons } = summon({ mode: 'low', to: { x: 12, y: 12 }, mutate: (draft) => {
    draft.mechanics.positions.enemy = { x: 11, y: 11 }
  } })
  const live = turnOf(state, 'enemy')
  for (const id of ['caster', 'ally']) live.mechanics.positions[id] = { x: 0, y: 19 - (id === 'ally' ? 1 : 0) }
  const attack = planNpcTurn(live, 'enemy').find((command) => command.command_type === 'MakeAttack')
  assert.ok(demons.some((demon) => demon.id === attack?.target_id), 'ближайшая цель — демон')

  const near = turnOf(state, 'caster')
  near.mechanics.positions[demons[0].id] = { x: 3, y: 3 }
  // Следующий ход заклинателя: действие снова свободно.
  near.mechanics.combat.action_economy.caster = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const swing = resolveCommand({ command_type: 'MakeAttack', actor_id: 'caster', target_id: demons[0].id, item_id: 'gear-0', server_authoritative: true }, near, { diceService: dice('high'), context: context() })
  assert.ok(swing.events.some((event) => event.event_type === 'AttackResolved'))
})

test('конец концентрации уводит демонов из боя и очереди', () => {
  const { state, demons } = summon({ mode: 'low' })
  const ended = resolveCommand({ command_type: 'EndConcentration', actor_id: 'caster', server_authoritative: true }, state, { diceService: dice(), context: context() })
  const after = ended.events.reduce(applyGameEvent, state)
  assert.equal(after.enemies.some((enemy) => demons.some((demon) => demon.id === enemy.id)), false)
  assert.equal(after.mechanics.combat.initiative.some((entry) => demons.some((demon) => demon.id === entry.actor_id)), false)
  assert.equal(after.mechanics.combat.initiative[after.mechanics.combat.active_index].actor_id, 'caster', 'ход заклинателя не сдвинулся')
})

test('прежняя редакция сохраняет послушных демонов отряда', () => {
  const { state, command } = spellRuntimeFixture('summon-lesser-demons')
  const legacy = normalizeCampaignState({ ...structuredClone(state), ruleset_id: 'srd_5_2_1', ruleset_version: undefined, enabled_house_rules: [] })
  legacy.scene.cells = Array.from({ length: 400 }, (_, index) => ({ x: index % 20, y: Math.floor(index / 20), type: 'floor', revealed: true }))
  const events = resolveCommand({ ...command, to: { x: 12, y: 12 }, server_authoritative: true }, legacy, { diceService: dice(), context: context() }).events
  const created = events.filter((event) => event.event_type === 'SummonedCreatureCreated').map((event) => event.payload.summon)
  assert.ok(created.length > 0 && created.every((demon) => demon.faction === 'party'))
})
