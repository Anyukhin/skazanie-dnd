import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `concentration-roll-${++id}`,
    now: () => '2026-07-18T20:00:00.000Z',
  })
}

function fixture({ casterClass = 'wizard', casterHp = 20, temporaryHp = 0, paladinConditions = [], immune = false } = {}) {
  return normalizeCampaignState({
    sessionCode: 'CONCENTRATION-SAVES',
    partyMemberIds: ['caster', 'paladin'],
    players: [
      { id: 'caster', character: 'Мира', characterClass: casterClass, level: 6, hp: casterHp, maxHp: 20, armor: 13, proficiency: 3, abilities: { str: 8, dex: 14, con: casterClass === 'fighter' ? 14 : 10, int: 16, wis: 12, cha: 10 }, x: 1, y: 2, inventory: [] },
      { id: 'paladin', character: 'Сиэль', characterClass: 'paladin', level: 6, hp: 38, maxHp: 38, armor: 18, proficiency: 3, abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 12, cha: 18 }, x: 1, y: 1, inventory: [] },
    ],
    enemies: [{ id: 'enemy', name: 'Культист', hp: 20, maxHp: 20, armor: 12, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, x: 2, y: 2, alive: true }],
    scene: { turn: 1, cells: [{ x: 1, y: 1, type: 'floor', revealed: true }, { x: 1, y: 2, type: 'floor', revealed: true }, { x: 2, y: 2, type: 'floor', revealed: true }] },
    mechanics: {
      positions: { caster: { x: 1, y: 2 }, paladin: { x: 1, y: 1 }, enemy: { x: 2, y: 2 } },
      conditions: { paladin: paladinConditions },
      concentration: { caster: { effect_id: 'spell:web' } },
      temporary_hp: { caster: temporaryHp },
      defenses: immune ? { caster: { immunities: ['fire'] } } : {},
    },
  })
}

const applyAll = (state, events) => events.reduce((current, event) => applyGameEvent(current, event), state)

test('урон автоматически вызывает save концентрации, а Аура защиты может сохранить эффект', () => {
  const state = fixture()
  const result = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'caster', amount: 8, damage_type: 'fire' }, state, { diceService: dice([6]) })
  const required = result.events.find((event) => event.event_type === 'ConcentrationCheckRequired')
  const save = result.events.find((event) => event.event_type === 'ConcentrationSavingThrowResolved')
  assert.deepEqual({ difficulty: required.payload.difficulty, damage: required.payload.damage }, { difficulty: 10, damage: 8 })
  assert.equal(save.payload.modifier, 4)
  assert.equal(save.payload.total, 10)
  assert.equal(save.payload.saved, true)
  assert.equal(save.payload.proficient, false)
  assert.equal(save.payload.aura_of_protection_source, 'paladin')
  assert.ok(save.source_rule_ids.includes('srd_5_2_1:spells:concentration'))
  assert.ok(save.source_rule_ids.includes('srd_5_2_1:classes:paladin-aura-of-protection'))
  const after = applyAll(state, result.events)
  assert.equal(after.mechanics.concentration.caster.effect_id, 'spell:web')
  assert.equal(after.battleLog.at(-1).type, 'concentration-save')
  assert.equal(after.battleLog.at(-1).auraBonus, 4)
  assert.deepEqual(replayEvents(state, result.events), after)
})

test('провал save автоматически завершает концентрацию и очищает связанный эффект', () => {
  const state = fixture({ paladinConditions: [{ id: 'incapacitated' }] })
  state.mechanics.active_effects = [{ effect_id: 'spell:web', spell_id: 'web' }]
  state.mechanics.conditions.enemy = [{ id: 'restrained', effect_id: 'spell:web', source_actor: 'caster' }]
  const result = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'caster', amount: 4, damage_type: 'slashing' }, state, { diceService: dice([9]) })
  const save = result.events.find((event) => event.event_type === 'ConcentrationSavingThrowResolved')
  assert.equal(save.payload.total, 9)
  assert.equal(save.payload.saved, false)
  assert.equal(save.payload.aura_of_protection_source, undefined)
  const ended = result.events.find((event) => event.event_type === 'ConcentrationEnded')
  assert.equal(ended.payload.reason, 'failed-saving-throw')
  const after = applyAll(state, result.events)
  assert.equal(after.mechanics.concentration.caster, undefined)
  assert.equal(after.mechanics.active_effects.length, 0)
  assert.equal(after.mechanics.conditions.enemy.length, 0)
  assert.deepEqual(after.battleLog.slice(-2).map((entry) => entry.type), ['concentration-save', 'concentration-end'])
})

test('временные HP не отменяют save концентрации, а иммунитет к урону отменяет', () => {
  const protectedState = fixture({ temporaryHp: 8 })
  const absorbed = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'caster', amount: 8, damage_type: 'fire' }, protectedState, { diceService: dice([6]) })
  assert.equal(absorbed.events[0].payload.applied_amount, 0)
  assert.equal(absorbed.events[0].payload.temporary_hp_absorbed, 8)
  assert.ok(absorbed.events.some((event) => event.event_type === 'ConcentrationSavingThrowResolved'))
  assert.equal(applyAll(protectedState, absorbed.events).players[0].hp, 20)

  const immuneState = fixture({ immune: true })
  const immune = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'caster', amount: 8, damage_type: 'fire' }, immuneState, { diceService: dice([]) })
  assert.equal(immune.events.some((event) => event.event_type === 'ConcentrationCheckRequired'), false)
  assert.equal(applyAll(immuneState, immune.events).mechanics.concentration.caster.effect_id, 'spell:web')
})

test('классовое владение спасброском Телосложения входит в save концентрации', () => {
  const state = fixture({ casterClass: 'fighter', paladinConditions: [{ id: 'incapacitated' }] })
  const result = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'caster', amount: 4, damage_type: 'slashing' }, state, { diceService: dice([5]) })
  const save = result.events.find((event) => event.event_type === 'ConcentrationSavingThrowResolved')
  assert.equal(save.payload.proficient, true)
  assert.equal(save.payload.modifier, 5)
  assert.equal(save.payload.total, 10)
  assert.equal(save.payload.saved, true)
})

test('0 HP прекращает концентрацию без спасброска', () => {
  const state = fixture({ casterHp: 5 })
  const result = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'caster', amount: 5, damage_type: 'slashing' }, state, { diceService: dice([]) })
  assert.equal(result.events.some((event) => event.event_type === 'ConcentrationSavingThrowResolved'), false)
  const ended = result.events.find((event) => event.event_type === 'ConcentrationEnded')
  assert.equal(ended.payload.reason, 'incapacitated')
  const after = applyAll(state, result.events)
  assert.equal(after.mechanics.concentration.caster, undefined)
  assert.equal(after.battleLog.at(-1).type, 'concentration-end')
})
