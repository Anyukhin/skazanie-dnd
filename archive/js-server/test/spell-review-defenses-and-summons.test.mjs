import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// Ошибки исполнения из ревью заклинаний 2 октября 2026 года: КД, предел
// урона, ауры, СЛ высвобождения и неуязвимые фишки призыва.
// Стенд: заклинатель (2,2) → противник (3,2) → союзник (2,3).

const context = (actorId = 'caster') => ({ serverAuthoritativeCombat: true, allowedActorIds: [actorId] })
const dice = (mode = 'high') => new DiceService({ rng: { randint: (min, max) => (mode === 'low' ? min : max) } })

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
  const cast = run({ ...command, ...patch }, 'caster')
  return {
    cast,
    run,
    endTurn: (actorId) => run({ command_type: 'EndTurn' }, actorId),
    state: () => live,
    has: (conditionId, actorId = 'enemy') => (live.mechanics.conditions[actorId] ?? []).some((condition) => condition.id === conditionId),
    assertReplay: () => assert.deepEqual(
      JSON.parse(JSON.stringify(replayEvents(initial, JSON.parse(JSON.stringify(events))).mechanics)),
      JSON.parse(JSON.stringify(live.mechanics)),
    ),
  }
}

const SHIELD = { id: 'shield', catalog_id: 'srd_5_2_1:shield', name: 'Щит', type: 'armor', equipped: true, quantity: 1 }

test('Доспехи мага складываются со щитом', () => {
  const armored = session('mage-armor', { patch: { target_id: 'caster', target_ids: ['caster'] }, mutate: (state) => {
    state.players[0].abilities.dex = 14
    state.players[0].armor = 12
  } })
  assert.ok(armored.has('mage-armor', 'caster'))
  armored.endTurn('caster')
  // Щит берётся после сотворения: материальному компоненту нужна свободная рука.
  armored.state().players[0].inventory = [...(armored.state().players[0].inventory ?? []), SHIELD]
  const attack = armored.run({ command_type: 'MakeAttack', target_id: 'caster' }, 'enemy', 'low')
  assert.equal(attack.find((event) => event.event_type === 'AttackResolved').payload.armor_class, 17, '13 + Лов 2 + щит 2')
})

test('Поражение не опускает цель ниже 1 ОЗ', () => {
  const harm = session('harm', { mode: 'low', mutate: (state) => { state.enemies[0].hp = 10 } })
  const damage = harm.cast.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.hp_after, 1)
  assert.equal(damage.payload.applied_amount, 9)
  assert.equal(harm.state().enemies[0].alive, true)
  harm.assertReplay()
})

test('Облачение огня жжёт соседа в конце его хода без спасброска и не жжёт заклинателя', () => {
  const flame = session('investiture-of-flame')
  const area = flame.state().mechanics.active_effects.find((effect) => effect.spell_id === 'investiture-of-flame')
  assert.equal(area.save_ability, null)
  assert.deepEqual(area.unaffected_actor_ids, ['caster'])
  flame.endTurn('caster')
  const enemyEnd = flame.endTurn('enemy')
  assert.equal(enemyEnd.filter((event) => event.event_type === 'SpellSavingThrowResolved').length, 0)
  const burn = enemyEnd.find((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('enemy'))
  assert.equal(burn?.payload.damage_type, 'fire')
  assert.equal(burn.payload.raw_amount, 10)
  flame.assertReplay()
})

test('Облачение огня даёт невосприимчивость к огню и сопротивление холоду', () => {
  const damageOf = (spellId) => {
    const { state, command } = spellRuntimeFixture(spellId)
    state.mechanics.conditions.enemy = [{ id: 'investiture-of-flame', duration: 'concentration', source_actor: 'enemy' }]
    return resolveCommand({ ...command, server_authoritative: true }, state, { diceService: dice('high'), context: context() })
      .events.find((event) => event.event_type === 'DamageApplied').payload
  }
  const fire = damageOf('fire-bolt')
  assert.equal(fire.immune, true)
  assert.equal(fire.applied_amount, 0)
  assert.equal(damageOf('ray-of-frost').resistant, true)
})

test('Аура очищения даёт преимущество только против состояний', () => {
  const aura = session('aura-of-purity', { patch: { target_id: 'ally', target_ids: ['ally'] } })
  assert.ok(aura.has('aura-of-purity', 'ally'))
  // Свой следующий каст оборвал бы концентрацию на ауре, поэтому эффект
  // переносится на противника, и по нему бьют заклинания со спасброском.
  const saveOf = (spellId) => {
    const { state, command } = spellRuntimeFixture(spellId)
    state.mechanics.conditions.enemy = [{ ...aura.state().mechanics.conditions.ally.find((condition) => condition.id === 'aura-of-purity'), source_actor: 'ally' }]
    const result = resolveCommand({ ...command, server_authoritative: true }, state, { diceService: dice('high'), context: context('caster') })
    return result.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('enemy'))?.payload
  }
  assert.equal(saveOf('hold-person').mode, 'advantage', 'паралич — в списке ауры')
  assert.notEqual(saveOf('sacred-flame').mode, 'advantage', 'спасбросок только от урона — без преимущества')
})

test('Земляная хватка Максимилиана держит против СЛ заклинания', () => {
  const grasp = session('maximilian-s-earthen-grasp', { mode: 'low' })
  assert.ok(grasp.has('restrained'))
  assert.equal(grasp.state().mechanics.conditions.enemy.find((condition) => condition.id === 'restrained').escape_dc, 16)
  grasp.endTurn('caster')
  const attempt = grasp.run({ command_type: 'UseCombatAction', action_id: 'break-free' }, 'enemy', 'high')
  assert.equal(attempt.find((event) => event.event_type === 'AbilityCheckResolved').payload.difficulty, 16)
  grasp.assertReplay()
})

test('Сковывающий лёд Раймы обездвиживает и разбивается действием без проверки', () => {
  const ice = session('rime-s-binding-ice', { mode: 'low', patch: { to: { x: 4, y: 2 } } })
  assert.ok(ice.has('rime-encased'))
  assert.equal(ice.has('restrained'), false, 'не опутывание: атаки по цели без преимущества')
  ice.endTurn('caster')
  assert.throws(() => ice.run({ command_type: 'MoveActor', to: { x: 4, y: 2 } }, 'enemy'), /rime-encased|скорость/iu)
  const freed = ice.run({ command_type: 'UseCombatAction', action_id: 'break-free' }, 'enemy', 'low')
  assert.equal(freed.some((event) => event.event_type === 'AbilityCheckResolved'), false)
  assert.equal(ice.has('rime-encased'), false)
  ice.assertReplay()
})

for (const [spellId, to] of [['spiritual-weapon', { x: 4, y: 3 }], ['mordenkainen-s-faithful-hound', { x: 4, y: 3 }]]) {
  test(`${spellId}: фишку нельзя атаковать и ранить, противник её не выбирает целью`, () => {
    const summoned = session(spellId, { patch: { to } })
    const token = summoned.state().actors.find((actor) => actor.sourceSpellId === spellId)
    assert.equal(token.untargetable, true)
    const state = structuredClone(summoned.state())
    state.mechanics.positions.enemy = { x: 5, y: 3 }
    state.mechanics.combat.active_index = state.mechanics.combat.initiative.findIndex((entry) => entry.actor_id === 'enemy')
    assert.throws(() => resolveCommand({ command_type: 'MakeAttack', actor_id: 'enemy', target_id: token.id, server_authoritative: true }, state,
      { diceService: dice(), context: context('enemy') }), (error) => error?.code === 'INVALID_ATTACK_TARGET')
    const plan = planNpcTurn(state, 'enemy')
    assert.equal(JSON.stringify(plan).includes(token.id), false)
  })
}

test('Прежняя редакция: Поражение и лёд Раймы не меняются', () => {
  const legacyOf = (spellId) => {
    const { state, command } = spellRuntimeFixture(spellId)
    return { state: normalizeCampaignState({ ...structuredClone(state), ruleset_id: 'srd_5_2_1', ruleset_version: undefined, enabled_house_rules: [] }), command }
  }
  const harm = legacyOf('harm')
  harm.state.enemies[0].hp = 10
  const harmEvents = resolveCommand({ ...harm.command, server_authoritative: true }, harm.state, { diceService: dice('low'), context: context() }).events
  assert.equal(harmEvents.find((event) => event.event_type === 'DamageApplied').payload.hp_after, 0)
  const ice = legacyOf('rime-s-binding-ice')
  const iceEvents = resolveCommand({ ...ice.command, to: { x: 4, y: 2 }, server_authoritative: true }, ice.state, { diceService: dice('low'), context: context() }).events
  assert.ok(iceEvents.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'restrained'))
})
