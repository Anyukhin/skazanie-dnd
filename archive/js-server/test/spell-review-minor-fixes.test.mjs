import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { applyGameEvent, movementCostOfPath, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// Мелкие расхождения (MINOR) из ревью заклинаний 2 октября 2026 года.
// Стенд: заклинатель (2,2) → противник (3,2) → союзник (2,3).

const context = (actorId = 'caster') => ({ serverAuthoritativeCombat: true, allowedActorIds: [actorId] })
const dice = (mode = 'high') => new DiceService({ rng: { randint: (min, max) => (mode === 'low' ? min : max) } })

function session(spellId, { patch = {}, mutate, mode = 'high' } = {}) {
  const { state, command } = spellRuntimeFixture(spellId)
  state.scene.cells = Array.from({ length: 400 }, (_, index) => ({ x: index % 20, y: Math.floor(index / 20), type: 'floor', revealed: true }))
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
    endTurn: (actorId, rollMode) => run({ command_type: 'EndTurn' }, actorId, rollMode),
    state: () => live,
    assertReplay: () => assert.deepEqual(
      JSON.parse(JSON.stringify(replayEvents(initial, JSON.parse(JSON.stringify(events))).mechanics)),
      JSON.parse(JSON.stringify(live.mechanics)),
    ),
  }
}
const damageTo = (events, actor = 'enemy') => events.filter((event) => event.event_type === 'DamageApplied' && event.target_ids.includes(actor))
const away = (state) => { state.mechanics.positions.ally = { x: 2, y: 15 } }

test('Героизм 2014 не даёт временных хитов при сотворении', () => {
  const hero = session('heroism', { patch: { target_id: 'ally', target_ids: ['ally'] } })
  assert.equal(hero.cast.some((event) => event.event_type === 'TemporaryHitPointsGranted'), false)
})

test('Электрошок с преимуществом по цели в металлическом доспехе', () => {
  const attackMode = (armor) => session('shocking-grasp', { mode: 'low', mutate: (state) => {
    state.enemies[0].inventory = armor ? [{ id: 'mail', catalog_id: 'srd_5_2_1:chain-mail', name: 'Кольчуга', type: 'armor', equipped: true, quantity: 1 }] : []
  } }).cast.find((event) => event.event_type === 'AttackResolved').payload.mode
  assert.equal(attackMode(true), 'advantage')
  assert.equal(attackMode(false), 'normal')
})

test('Призыв заграждения бьёт типом выбранного оружия', () => {
  const barrage = session('conjure-barrage', { patch: { spell_option: 'piercing', to: { x: 6, y: 2 } }, mutate: away })
  assert.equal(damageTo(barrage.cast)[0]?.payload.damage_type, 'piercing')
})

test('Небесный огонь усиливает выбранную половину урона', () => {
  const expressions = (option) => session('flame-strike', { patch: { slot_level: 6, spell_option: option, to: { x: 3, y: 2 } }, mutate: away }).cast
    .filter((event) => event.event_type === 'DieRolled' && String(event.payload.purpose).startsWith('spell_damage:flame-strike'))
    .map((event) => event.payload.expression)
  assert.deepEqual(expressions('fire'), ['5d6', '4d6'])
  assert.deepEqual(expressions('radiant'), ['4d6', '5d6'])
})

test('Едкий шар по самому заклинателю жжёт в конце его следующего хода', () => {
  const sphere = session('vitriolic-sphere', { mode: 'low', patch: { to: { x: 2, y: 2 } }, mutate: away })
  assert.ok(sphere.state().mechanics.conditions.caster.some((condition) => condition.id === 'vitriolic-acid-covered'))
  const sameTurn = sphere.endTurn('caster')
  assert.equal(damageTo(sameTurn, 'caster').filter((event) => event.payload.recurring).length, 0, 'не в том же ходу')
  sphere.endTurn('enemy')
  sphere.endTurn('ally')
  const next = sphere.endTurn('caster')
  assert.equal(damageTo(next, 'caster').filter((event) => event.payload.recurring).length, 1)
  sphere.assertReplay()
})

test('Песчаная стена: фут движения сквозь неё стоит трёх', () => {
  const wall = session('wall-of-sand', { patch: { to: { x: 6, y: 2 } } })
  const effect = wall.state().mechanics.active_effects.find((candidate) => candidate.spell_id === 'wall-of-sand')
  assert.equal(effect.movement_cost_multiplier, 3)
  assert.equal(movementCostOfPath(wall.state(), 'enemy', [{ x: 4, y: 2 }, { x: 5, y: 2 }, { x: 6, y: 2 }]), 5 + 5 + 15)
})

test('Стихийное оружие: выбранная стихия приходит своим типом урона', () => {
  const weapon = session('elemental-weapon', { patch: { spell_option: 'cold', target_id: 'caster', target_ids: ['caster'] } })
  for (const actor of ['caster', 'enemy', 'ally']) weapon.endTurn(actor)
  const swing = weapon.run({ command_type: 'MakeAttack', target_id: 'enemy', item_id: 'gear-0' }, 'caster')
  assert.ok(damageTo(swing).some((event) => event.payload.damage_type === 'cold' && event.payload.spell_damage_rider === true))
})

test('Шквал не объявляет силовой урон', () => {
  assert.equal(session('gust').cast.find((event) => event.event_type === 'SpellCast').payload.damage_type, null)
  assert.equal(session('fire-bolt').cast.find((event) => event.event_type === 'SpellCast').payload.damage_type, 'fire')
})

test('Тексты карточек сходятся с правилом', () => {
  const card = (id) => canonicalCombatSpellFor(id, { rulesetId: 'dnd_5e_2014' })
  assert.match(card('eldritch-blast').description, /17-м/u)
  assert.doesNotMatch(card('elemental-weapon').description, /атаки и урона/u)
  assert.match(card('summon-construct').higherLevels, /5-го/u)
  assert.match(card('thunderclap').rangeText, /На себя/u)
})
