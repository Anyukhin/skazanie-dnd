// Дикий облик друида (PHB 2014). Аудит боя 2026-10-13: «Дикая форма» вешала
// метку без последствий — ни хитов зверя, ни его атаки.
import assert from 'node:assert/strict'
import test from 'node:test'

import { combatActionsFor } from '../server/combat-actions.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'

function battle(subclass) {
  const cells = Array.from({ length: 60 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'WILD-SHAPE', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', partyMemberIds: ['druid'],
    players: [{ id: 'druid', character: 'Ива', characterClass: 'druid', subclass, level: 7, hp: 40, maxHp: 50, armor: 14, speed: 30, proficiency: 3,
      abilities: { str: 10, dex: 14, con: 14, int: 12, wis: 18, cha: 10 }, knownSpellIds: ['produce-flame'], preparedSpellIds: [],
      inventory: [{ id: 'staff', catalog_id: 'srd_5_2_1:quarterstaff', type: 'weapon', quantity: 1, equipped: true }], x: 0, y: 2 }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 300, maxHp: 300, armor: 10, speed: 30, abilities: { str: 18, dex: 8, con: 16 }, x: 2, y: 2, alive: true }],
    scene: { title: 'Поляна', location: 'Поляна', turn: 1, cells },
    mechanics: {
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'druid', total: 15 }, { actor_id: 'ogre', total: 5 }],
        action_economy: { druid: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } },
      resources: { druid: { wild_shape: { current: 2, max: 2 }, spell_slots_1: { current: 4, max: 4 }, spell_slots_2: { current: 3, max: 3 } } },
    },
  })
}
const act = (state, input, diceService = fixedDice(15)) => {
  const result = resolveCommand({ command_id: `w-${input.command_type}-${input.action_id ?? input.spell_id ?? ''}-${Math.random().toString(36).slice(2, 7)}`, actor_id: 'druid', ...input }, state,
    { diceService, context: { serverAuthoritativeCombat: true, allowedActorIds: ['druid'] } })
  return { result, state: result.events.reduce(applyGameEvent, state) }
}
const shape = { command_type: 'UseCombatAction', action_id: 'wild-shape' }

test('Круг луны 7-го уровня: бонусным действием — гигантский кабан (ПО 2), его хиты и атака', () => {
  const state = battle('Круг луны')
  assert.equal(combatActionsFor(state.players[0]).find((entry) => entry.id === 'wild-shape').actionType, 'bonus_action')
  const shaped = act(state, shape)
  const change = shaped.result.events.find((event) => event.event_type === 'ShapeChanged')
  assert.equal(change.payload.form.id, 'giant-boar')
  const boar = shaped.state.players[0]
  assert.equal(boar.hp, 42)
  assert.equal(shaped.state.mechanics.combat.action_economy.druid.bonus_action, false)
  assert.notEqual(shaped.state.mechanics.combat.action_economy.druid.action, false, 'действие осталось на атаку')
  assert.equal(shaped.state.mechanics.resources.druid.wild_shape.current, 1)
  assert.deepEqual(replayEvents(state, shaped.result.events).players[0].hp, 42)
  // Атака — клыками кабана, даже если клиент прислал посох.
  const gore = act(shaped.state, { command_type: 'MakeAttack', target_id: 'ogre', item_id: 'staff', server_authoritative: true })
  const attack = gore.result.events.find((event) => event.event_type === 'AttackResolved')
  assert.ok(attack, 'атака состоялась')
  assert.notEqual(attack.payload.action_name ?? attack.payload.item_name ?? '', 'Боевой посох')
  assert.throws(() => act(shaped.state, { command_type: 'CastSpell', spell_id: 'produce-flame', target_id: 'ogre' }), { code: 'WILD_SHAPE_NO_SPELLS' })
})

test('нулевые хиты зверя возвращают друида, лишний урон переходит на него; повторное нажатие — возврат', () => {
  const shaped = act(battle('Круг луны'), shape).state
  const crushed = act(shaped, { command_type: 'ApplyDamage', target_id: 'druid', amount: 50, damage_type: 'bludgeoning', ruling_id: 'test-wild-shape' }, fixedDice(10))
  assert.ok(crushed.result.events.some((event) => event.event_type === 'ShapeReverted'))
  assert.equal(crushed.state.players[0].hp, 40 - 8, '42 хита кабана, 8 лишних — на друида')
  // Возврат — бонусным действием, уже следующим ходом.
  shaped.mechanics.combat.action_economy.druid.bonus_action = true
  const again = act(normalizeCampaignState(shaped), shape)
  assert.ok(again.result.events.some((event) => event.event_type === 'ShapeReverted' && event.payload.reason === 'dismissed'))
  assert.equal(again.state.players[0].hp, 40)
  assert.equal(again.state.mechanics.resources.druid.wild_shape.current, 1, 'возврат облик не тратит')
})

test('целебный облик Круга луны: младшая ячейка — 1к8 хитов зверю за круг', () => {
  const shaped = act(battle('Круг луны'), shape).state
  shaped.mechanics.combat.action_economy.druid.bonus_action = true
  shaped.players[0].hp = 20
  const healed = act(normalizeCampaignState(shaped), { command_type: 'UseCombatAction', action_id: 'druid-krug-luny-boevoy-dikiy-oblik' }, fixedDice(5))
  assert.ok(healed.result.events.some((event) => event.event_type === 'ResourceSpent' && event.payload.resource === 'spell_slots_1'))
  assert.equal(healed.result.events.find((event) => event.event_type === 'HealingApplied').payload.applied_amount, 5)
})

test('Круг земли 7-го уровня: действием — волк (ПО ½)', () => {
  const state = battle('Круг земли')
  assert.equal(combatActionsFor(state.players[0]).find((entry) => entry.id === 'wild-shape').actionType, 'action')
  const shaped = act(state, shape)
  assert.equal(shaped.result.events.find((event) => event.event_type === 'ShapeChanged').payload.form.id, 'wolf')
  assert.equal(shaped.state.mechanics.combat.action_economy.druid.action, false)
})

test('автотактика: друид Круга луны оборачивается бонусным действием, Круга земли — нет', async () => {
  const { planHeroCombatCommand } = await import('../server/party-tactics.mjs')
  assert.equal(planHeroCombatCommand(battle('Круг луны'), 'druid').command.action_id, 'wild-shape')
  assert.notEqual(planHeroCombatCommand(battle('Круг земли'), 'druid').command.action_id, 'wild-shape')
  // Уже в облике — второй раз не оборачивается.
  const shaped = act(battle('Круг луны'), shape).state
  assert.notEqual(planHeroCombatCommand(shaped, 'druid').command.action_id, 'wild-shape')
})

test('плитка Дикого облика несёт доступных зверей; выбранный form_id исполняется', () => {
  const state = battle('Круг луны')
  const forms = combatActionsFor(state.players[0]).find((entry) => entry.id === 'wild-shape').forms
  assert.ok(forms.some((form) => form.id === 'giant-boar') && forms.some((form) => form.id === 'wolf'))
  assert.ok(forms.every((form) => form.challenge_rating <= 2))
  const wolf = act(state, { ...shape, form_id: 'wolf' })
  assert.equal(wolf.result.events.find((event) => event.event_type === 'ShapeChanged').payload.form.id, 'wolf')
  const landForms = combatActionsFor(battle('Круг земли').players[0]).find((entry) => entry.id === 'wild-shape').forms
  assert.ok(landForms.every((form) => form.challenge_rating <= 0.5), 'Круг земли 7-го уровня — ПО ½')
})
