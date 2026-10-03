import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// Сроки «до хода заклинателя» в редакции 2014. Ход меняется настоящим
// `EndTurn`, а не подменой `active_index`: именно смена хода через
// `TurnStarted` раньше снимала эффект с цели до того, как он срабатывал.
// Очередь стенда: заклинатель (20) → противник (10) → союзник (5).

const context = (actorId) => ({ serverAuthoritativeCombat: true, allowedActorIds: [actorId] })
const dice = (mode) => new DiceService({ rng: { randint: (min, max) => (mode === 'low' ? min : max) } })

function session(spellId, { patch = {}, mutate, mode = 'high' } = {}) {
  const { state, command } = spellRuntimeFixture(spellId)
  mutate?.(state)
  const initial = structuredClone(state)
  let live = state
  const events = []
  const run = (raw, actorId, rollMode = mode) => {
    const result = resolveCommand({ server_authoritative: true, ...raw, actor_id: actorId }, live, { diceService: dice(rollMode), context: context(actorId) })
    events.push(...result.events)
    live = result.events.reduce(applyGameEvent, live)
    return result.events
  }
  run({ ...command, ...patch }, 'caster')
  return {
    run,
    endTurn: (actorId) => run({ command_type: 'EndTurn' }, actorId),
    state: () => live,
    conditions: (actorId = 'enemy') => (live.mechanics.conditions[actorId] ?? []).map((condition) => `${condition.id}|${condition.duration}`),
    has: (conditionId, actorId = 'enemy') => (live.mechanics.conditions[actorId] ?? []).some((condition) => condition.id === conditionId),
    assertReplay: () => assert.deepEqual(
      JSON.parse(JSON.stringify(replayEvents(initial, JSON.parse(JSON.stringify(events))).mechanics.conditions)),
      JSON.parse(JSON.stringify(live.mechanics.conditions)),
    ),
  }
}

test('Злая насмешка: помеха доживает до атаки цели и снимается в конце её хода', () => {
  const attacked = session('vicious-mockery', { mode: 'low' })
  assert.deepEqual(attacked.conditions(), ['disadvantage-next-attack|until-own-turn-end'])
  attacked.endTurn('caster')
  assert.ok(attacked.has('disadvantage-next-attack'), 'начало хода цели не снимает помеху')
  const attack = attacked.run({ command_type: 'MakeAttack', target_id: 'caster' }, 'enemy')
  assert.equal(attack.find((event) => event.event_type === 'AttackResolved').payload.mode, 'disadvantage')
  assert.equal(attacked.has('disadvantage-next-attack'), false, 'помеха расходуется атакой')
  attacked.assertReplay()

  const idle = session('vicious-mockery', { mode: 'low' })
  idle.endTurn('caster')
  idle.endTurn('enemy')
  assert.equal(idle.has('disadvantage-next-attack'), false, 'без атаки помеха гаснет в конце хода цели')
  idle.assertReplay()
})

test('Обморожение держит помеху до конца следующего хода цели', () => {
  const frost = session('frostbite', { mode: 'low' })
  frost.endTurn('caster')
  assert.ok(frost.has('disadvantage-next-weapon-attack'))
  frost.endTurn('enemy')
  assert.equal(frost.has('disadvantage-next-weapon-attack'), false)
  frost.assertReplay()
})

test('Луч холода ограничивает движение цели и снимается в начале хода заклинателя', () => {
  const frost = session('ray-of-frost')
  frost.endTurn('caster')
  assert.throws(() => frost.run({ command_type: 'MoveActor', to: { x: 9, y: 2 } }, 'enemy'), (error) => error?.code === 'SPEED_EXCEEDED')
  frost.run({ command_type: 'MoveActor', to: { x: 7, y: 2 } }, 'enemy')
  frost.endTurn('enemy')
  assert.ok(frost.has('speed-reduced-10'), 'эффект живёт до хода заклинателя, а не до хода цели')
  frost.endTurn('ally')
  assert.equal(frost.has('speed-reduced-10'), false)
  frost.assertReplay()
})

test('Леденящее прикосновение и копьё Раулотима действуют весь ход цели', () => {
  for (const [spellId, conditionId, mode] of [['chill-touch', 'healing-blocked', 'high'], ['raulothim-s-psychic-lance', 'incapacitated', 'low']]) {
    const cast = session(spellId, { mode })
    assert.deepEqual(cast.conditions(), [`${conditionId}|until-source-next-turn`], spellId)
    cast.endTurn('caster')
    assert.ok(cast.has(conditionId), `${spellId}: эффект есть в ход цели`)
    cast.endTurn('enemy')
    cast.endTurn('ally')
    assert.equal(cast.has(conditionId), false, `${spellId}: снят в начале хода заклинателя`)
    cast.assertReplay()
  }
})

test('Недееспособная после копья Раулотима цель пропускает ход', () => {
  const lance = session('raulothim-s-psychic-lance', { mode: 'low' })
  lance.endTurn('caster')
  assert.deepEqual(planNpcTurn(lance.state(), 'enemy'), [{ command_type: 'EndTurn', actor_id: 'enemy' }])
})

test('Расщепление разума и Направляющий снаряд держатся до конца следующего хода заклинателя', () => {
  for (const [spellId, conditionId, mode] of [['mind-sliver', 'next-save-minus-d4', 'low'], ['guiding-bolt', 'guiding-bolt-advantage', 'high']]) {
    const cast = session(spellId, { mode })
    cast.endTurn('caster')
    cast.endTurn('enemy')
    cast.endTurn('ally')
    assert.ok(cast.has(conditionId), `${spellId}: эффект доживает до хода заклинателя`)
    cast.endTurn('caster')
    assert.equal(cast.has(conditionId), false, `${spellId}: снят в конце следующего хода заклинателя`)
    cast.assertReplay()
  }
})

test('Преимущество Направляющего снаряда получает союзник, ходящий после цели', () => {
  const bolt = session('guiding-bolt', {
    mutate: (state) => {
      state.players[1].inventory = [{ id: 'ally-sword', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', type: 'weapon', damage: '1d8', damage_type: 'slashing', equipped: true, quantity: 1 }]
    },
  })
  bolt.endTurn('caster')
  bolt.endTurn('enemy')
  const attack = bolt.run({ command_type: 'MakeAttack', target_id: 'enemy' }, 'ally')
  assert.equal(attack.find((event) => event.event_type === 'AttackResolved').payload.mode, 'advantage')
  assert.equal(bolt.has('guiding-bolt-advantage'), false)
  bolt.assertReplay()
})

test('Громовой клинок срабатывает, когда цель двигается в свой ход', () => {
  const blade = session('booming-blade')
  assert.deepEqual(blade.conditions(), ['booming-blade-move:3d8|until-source-next-turn'])
  blade.endTurn('caster')
  const moved = blade.run({ command_type: 'MoveActor', to: { x: 4, y: 2 } }, 'enemy')
  const damage = moved.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage?.payload.damage_type, 'thunder')
  assert.equal(blade.has('booming-blade-move:3d8'), false)
  blade.assertReplay()
})

test('Солнечный луч ослепляет до хода заклинателя, а концентрация на повторный луч остаётся', () => {
  const beam = session('sunbeam', { mode: 'low', patch: { to: { x: 6, y: 2 } } })
  assert.ok(beam.conditions().includes('blinded|until-source-next-turn'))
  beam.endTurn('caster')
  beam.endTurn('enemy')
  assert.ok(beam.has('blinded'))
  beam.endTurn('ally')
  assert.equal(beam.has('blinded'), false)
  assert.ok(beam.state().mechanics.concentration.caster, 'концентрация не обрывается вместе с ослеплением')
  beam.assertReplay()
})

test('«Сбит с ног» от Дрожи земли и Приказа не проходит сам: встать стоит половину скорости', () => {
  const tremor = session('earth-tremor', { mode: 'low' })
  if (tremor.state().mechanics.combat.reaction_window) tremor.run({ command_type: 'UseCombatAction', action_id: 'decline-reaction' }, tremor.state().mechanics.combat.reaction_window.actor_id)
  assert.ok(tremor.conditions().includes('prone|until-removed'))
  tremor.endTurn('caster')
  assert.ok(tremor.has('prone'), 'начало хода не поднимает существо')
  tremor.run({ command_type: 'UseCombatAction', action_id: 'stand-up' }, 'enemy')
  assert.equal(tremor.has('prone'), false)
  assert.equal(tremor.state().mechanics.combat.action_economy.enemy.movement_spent, 15)
  tremor.assertReplay()

  const grovel = session('command', { mode: 'low', patch: { spell_option: 'grovel' } })
  grovel.endTurn('caster')
  grovel.endTurn('enemy')
  assert.deepEqual(grovel.conditions(), ['prone|null'])
  grovel.endTurn('ally')
  grovel.endTurn('caster')
  assert.ok(grovel.has('prone'), 'приказ «Падай» оставляет цель лежать до её собственного подъёма')
  grovel.assertReplay()
})

test('Противник под управлением сервера встаёт, если хватает скорости', () => {
  const { state } = spellRuntimeFixture('fire-bolt')
  state.mechanics.conditions.enemy = [{ id: 'prone', duration: null, source_actor: 'caster' }]
  state.mechanics.combat.active_index = 1
  assert.deepEqual(planNpcTurn(state, 'enemy'), [{ command_type: 'UseCombatAction', actor_id: 'enemy', action_id: 'stand-up' }])
  const stood = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'enemy', action_id: 'stand-up', server_authoritative: true }, state, { diceService: dice('high'), context: context('enemy') })
  const after = stood.events.reduce(applyGameEvent, state)
  assert.notEqual(planNpcTurn(after, 'enemy')[0].action_id, 'stand-up', 'после подъёма план продолжается обычным ходом')

  state.mechanics.combat.action_economy.enemy.movement_spent = 30
  assert.notEqual(planNpcTurn(state, 'enemy')[0].action_id, 'stand-up', 'без половины скорости существо действует лёжа')
})

test('2024: преимущество Направляющего снаряда переживает ход цели', () => {
  // Боевой плейтест 2026-10-03: в редакции 2024 условие получало `rounds:1` и
  // сгорало в начале хода цели, поэтому воин, ходивший после неё, бил без
  // преимущества. Текст карточки тот же, что в 2014: «до конца вашего
  // следующего хода».
  const { state, command } = spellRuntimeFixture('guiding-bolt')
  state.players[1].inventory = [{ id: 'ally-sword', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', type: 'weapon', damage: '1d8', damage_type: 'slashing', equipped: true, quantity: 1 }]
  let live = normalizeCampaignState({ ...structuredClone(state), ruleset_id: 'srd_5_2_1', ruleset_version: undefined, enabled_house_rules: [] })
  const run = (raw, actorId) => {
    const result = resolveCommand({ server_authoritative: true, ...raw, actor_id: actorId }, live, { diceService: dice('high'), context: context(actorId) })
    live = result.events.reduce(applyGameEvent, live)
    return result.events
  }
  const cast = run(command, 'caster')
  assert.equal(cast.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'guiding-bolt-advantage')?.payload.duration, 'source-turns:2')
  run({ command_type: 'EndTurn' }, 'caster')
  run({ command_type: 'EndTurn' }, 'enemy')
  const attack = run({ command_type: 'MakeAttack', target_id: 'enemy' }, 'ally')
  assert.equal(attack.find((event) => event.event_type === 'AttackResolved').payload.mode, 'advantage')
})

test('Прежняя редакция и сохранённые события не меняются', () => {
  const { state, command } = spellRuntimeFixture('vicious-mockery')
  const legacy = normalizeCampaignState({ ...structuredClone(state), ruleset_id: 'srd_5_2_1', ruleset_version: undefined, enabled_house_rules: [] })
  const legacyCast = resolveCommand({ ...command, server_authoritative: true }, legacy, { diceService: dice('low'), context: context('caster') })
  assert.equal(legacyCast.events.find((event) => event.event_type === 'ConditionAdded').payload.duration, 'rounds:1')

  // Старое событие с прежним сроком переигрывается по прежним правилам:
  // редьюсер не менялся, менялся только срок в новых событиях.
  const oldEvent = { event_id: 'old', event_type: 'ConditionAdded', actor_id: 'caster', target_ids: ['enemy'], payload: { condition: 'disadvantage-next-attack', duration: 'rounds:1', source_actor: 'caster' } }
  const withOld = applyGameEvent(state, oldEvent)
  const turnStart = { event_id: 'turn', event_type: 'TurnStarted', actor_id: 'caster', target_ids: ['enemy'], payload: { round: 1, active_index: 1 } }
  assert.equal(applyGameEvent(withOld, turnStart).mechanics.conditions.enemy.some((condition) => condition.id === 'disadvantage-next-attack'), false)
})
