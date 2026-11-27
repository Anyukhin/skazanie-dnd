import assert from 'node:assert/strict'
import test from 'node:test'
import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { applyAll } from './kit/engine.mjs'
import { fixedDice } from './kit/dice.mjs'

const context = actorId => ({ serverAuthoritativeCombat: true, allowedActorIds: [actorId] })
function session({ mutate = () => {}, castSpell = true } = {}) {
  const { state, command } = spellRuntimeFixture('guardian-of-faith')
  state.mechanics.positions.enemy = { x: 7, y: 2 }
  mutate(state)
  let live = state
  const events = []
  const run = (raw, actorId = 'caster', die = 20) => {
    const result = resolveCommand({ server_authoritative: true, ...raw, actor_id: actorId }, live, { diceService: fixedDice(die, { prefix: raw.command_id }), context: context(actorId) })
    events.push(...result.events)
    live = applyAll(live, result.events)
    return result.events
  }
  const cast = castSpell ? run({ ...command, to: { x: 4, y: 2 }, command_id: 'guardian:cast' }, 'caster') : []
  return {
    run, cast, state: () => live, events, initial: state,
    assertReplay: () => assert.deepEqual(
      JSON.parse(JSON.stringify(replayEvents(state, JSON.parse(JSON.stringify(events))).mechanics)),
      JSON.parse(JSON.stringify(live.mechanics)),
    ),
  }
}

test('guardian-of-faith triggers on hostile entry, halves Dex save and expires at 60 damage', () => {
  const s = session()
  assert.equal(s.cast.some(e => e.event_type === 'DamageApplied'), false)
  const created = s.cast.find(e => e.event_type === 'SpellAreaCreated')
  assert.equal(created.payload.effect.expires_round, 4801)
  s.run({ command_type: 'EndTurn', command_id: 'guardian:end-caster-0' }, 'caster')
  const first = s.run({ command_type: 'MoveActor', command_id: 'guardian:move-1', to: { x: 5, y: 2 } }, 'enemy')
  const hit = first.find(e => e.event_type === 'DamageApplied')
  assert.ok(hit)
  assert.equal(hit.payload.damage_type, 'radiant')
  assert.equal(hit.payload.raw_amount, 10)
  const effect = s.state().mechanics.active_effects.find(e => e.spell_id === 'guardian-of-faith')
  assert.equal(effect.damage_dealt, 10)
  const second = s.run({ command_type: 'EndTurn', command_id: 'guardian:end-enemy' }, 'enemy')
  assert.equal(second.some(e => e.event_type === 'DamageApplied'), false, 'одно срабатывание за ход')
  s.run({ command_type: 'EndTurn', command_id: 'guardian:end-ally' }, 'ally')
  s.run({ command_type: 'EndTurn', command_id: 'guardian:end-caster' }, 'caster')
  s.run({ command_type: 'MoveActor', command_id: 'guardian:move-out', to: { x: 7, y: 2 } }, 'enemy')
  const third = s.run({ command_type: 'MoveActor', command_id: 'guardian:move-2', to: { x: 5, y: 2 } }, 'enemy')
  assert.ok(third.some(e => e.event_type === 'DamageApplied'))
  const after = s.state().mechanics.active_effects.find(e => e.spell_id === 'guardian-of-faith')
  assert.equal(after.damage_dealt, 20)
  const replayed = replayEvents(s.initial, JSON.parse(JSON.stringify(s.events)))
  assert.deepEqual(JSON.parse(JSON.stringify(replayed.mechanics)), JSON.parse(JSON.stringify(s.state().mechanics)))
})

test('guardian-of-faith removes itself after six successful saves and three failed saves', () => {
  const runSequence = (saveRoll, count) => {
    const s = session()
    s.run({ command_type: 'EndTurn', command_id: 'guardian:sequence-start' }, 'caster')
    for (let index = 0; index < count; index += 1) {
      if (index > 0) s.run({ command_type: 'MoveActor', command_id: 'guardian:leave:' + index, to: { x: 7, y: 2 } }, 'enemy')
      s.run({ command_type: 'MoveActor', command_id: 'guardian:enter:' + index, to: { x: 5, y: 2 } }, 'enemy', saveRoll)
      if (index < count - 1) {
        s.run({ command_type: 'EndTurn', command_id: 'guardian:end-enemy:' + index }, 'enemy')
        s.run({ command_type: 'EndTurn', command_id: 'guardian:end-ally:' + index }, 'ally')
        s.run({ command_type: 'EndTurn', command_id: 'guardian:end-caster:' + index }, 'caster')
      }
    }
    return s
  }
  const saves = runSequence(20, 6)
  assert.equal(saves.state().mechanics.active_effects.some(e => e.spell_id === 'guardian-of-faith'), false)
  const failures = runSequence(1, 3)
  assert.equal(failures.state().mechanics.active_effects.some(e => e.spell_id === 'guardian-of-faith'), false)
  const damage = failures.events.filter(e => e.event_type === 'DamageApplied' && e.payload.spell_id === 'guardian-of-faith')
  assert.equal(damage.reduce((sum, event) => sum + event.payload.applied_amount, 0), 60)
  saves.assertReplay()
  failures.assertReplay()
})

test('guardian-of-faith expires when combat rounds reach its eight-hour deadline', () => {
  const s = session()
  s.state().mechanics.combat.round = 4801
  s.run({ command_type: 'EndTurn', command_id: 'guardian:expire' }, 'caster')
  assert.equal(s.state().mechanics.active_effects.some(e => e.spell_id === 'guardian-of-faith'), false)
})

test('guardian-of-faith rejects an unsafe target point', () => {
  const { state, command } = spellRuntimeFixture('guardian-of-faith')
  assert.throws(() => resolveCommand({ ...command, to: { x: 99, y: 99 }, server_authoritative: true }, state, { diceService: fixedDice(20), context: context('caster') }))
})

test('Страж веры расходует остаток после защиты цели и снимает только свой эффект', () => {
  const effect = session().cast.find(e => e.event_type === 'SpellAreaCreated').payload.effect
  for (const [defense, previous, temporary, applied] of [
    ['resistances', 59, 0, 1],
    ['vulnerabilities', 45, 0, 15],
    ['resistances', 59, 2, 0],
  ]) {
    const s = session({ castSpell: false, mutate(state) {
      state.mechanics.defenses.enemy = { [defense]: ['radiant'] }
      state.mechanics.temporary_hp.enemy = temporary
      state.mechanics.active_effects = [
        { ...effect, damage_dealt: previous },
        { ...effect, effect_id: 'other-guardian', center: { x: 15, y: 2 } },
      ]
    } })
    s.run({ command_type: 'EndTurn', command_id: 'guardian:limit-start' }, 'caster')
    const hit = s.run({ command_type: 'MoveActor', command_id: 'guardian:limit-enter', to: { x: 5, y: 2 } }, 'enemy', 1)
      .find(e => e.event_type === 'DamageApplied')
    assert.equal(hit.payload.applied_amount, applied, defense)
    assert.equal(hit.payload.temporary_hp_absorbed, temporary ? 1 : 0)
    assert.equal(previous + hit.payload.applied_amount + hit.payload.temporary_hp_absorbed, 60)
    assert.deepEqual(s.state().mechanics.active_effects.map(e => e.effect_id), ['other-guardian'])
    s.assertReplay()
  }
})
