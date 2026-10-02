import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

// Длящиеся области D&D 2014. Большинство зон срабатывает, «когда существо
// впервые за ход входит в область или начинает в ней ход», и при появлении
// ничего не делает. Ход меняется настоящим `EndTurn`.
// Очередь стенда: заклинатель (20) → противник (10) → союзник (5).

const context = (actorId) => ({ serverAuthoritativeCombat: true, allowedActorIds: [actorId] })
const dice = (mode = 'low') => new DiceService({ rng: { randint: (min, max) => (mode === 'low' ? min : max) } })
const RESULT_EVENTS = ['DamageApplied', 'HealingApplied', 'SpellSavingThrowResolved']

function session(spellId, { patch = {}, mutate } = {}) {
  const { state, command } = spellRuntimeFixture(spellId)
  mutate?.(state)
  const initial = structuredClone(state)
  let live = state
  const events = []
  const run = (raw, actorId) => {
    const result = resolveCommand({ server_authoritative: true, ...raw, actor_id: actorId }, live, { diceService: dice(), context: context(actorId) })
    events.push(...result.events)
    live = result.events.reduce(applyGameEvent, live)
    return result.events
  }
  const cast = run({ ...command, ...patch }, 'caster')
  return {
    cast,
    run,
    events,
    endTurn: (actorId) => run({ command_type: 'EndTurn' }, actorId),
    move: (actorId, to) => run({ command_type: 'MoveActor', to }, actorId),
    state: () => live,
    hits: (list, actorId = 'enemy') => list.filter((event) => RESULT_EVENTS.includes(event.event_type) && event.target_ids?.includes(actorId) && event.event_type !== 'SpellSavingThrowResolved'),
    assertReplay: () => assert.deepEqual(
      JSON.parse(JSON.stringify(replayEvents(initial, JSON.parse(JSON.stringify(events))).mechanics)),
      JSON.parse(JSON.stringify(live.mechanics)),
    ),
  }
}

const far = (actor, x, y) => (state) => { state.mechanics.positions[actor] = { x, y } }

test('Духовные стражи: без урона при сотворении, раз в ход у цели, союзники не затронуты', () => {
  const guardians = session('spirit-guardians')
  assert.equal(guardians.cast.filter((event) => RESULT_EVENTS.includes(event.event_type)).length, 0, 'при появлении никто не страдает')
  const enemyStart = guardians.endTurn('caster')
  assert.equal(guardians.hits(enemyStart).length, 1, 'начало хода цели в ауре')
  assert.equal(guardians.hits(guardians.move('enemy', { x: 6, y: 2 })).length, 0)
  assert.equal(guardians.hits(guardians.move('enemy', { x: 5, y: 2 })).length, 0, 'повторный вход в тот же ход не бьёт')
  const allyStart = guardians.endTurn('enemy')
  assert.equal(guardians.hits(allyStart, 'ally').length, 0, 'союзник внутри ауры не затронут')
  guardians.endTurn('ally')
  assert.equal(guardians.hits(guardians.endTurn('caster')).length, 1, 'следующий ход — снова урон')
  const effect = guardians.state().mechanics.active_effects.find((candidate) => candidate.spell_id === 'spirit-guardians')
  assert.ok(effect.unaffected_actor_ids.includes('ally') && effect.unaffected_actor_ids.includes('caster'))
  assert.ok(!effect.unaffected_actor_ids.includes('enemy'))
  guardians.assertReplay()
})

test('Отметка срабатывания служебная и игроку не видна', () => {
  const guardians = session('spirit-guardians')
  guardians.endTurn('caster')
  const marks = guardians.events.filter((event) => event.event_type === 'SpellAreaTriggered')
  assert.equal(marks.length, 1)
  assert.equal(marks[0].visibility, 'gm_only')
  const user = { role: 'player', heroIds: ['caster'] }
  const visible = mechanicsForViewer(guardians.events, user, 'caster', guardians.state())
  assert.equal(visible.some((event) => event.event_type === 'SpellAreaTriggered'), false)
  const room = campaignStateForViewer(guardians.state(), user, 'caster')
  assert.equal(JSON.stringify(room).includes('triggered_turns'), false)
  assert.equal(JSON.stringify(room).includes('unaffected_actor_ids'), false)
})

test('Лунный луч, Облако кинжалов, Облако смерти, Стена клинков и Водоворот бьют в начале хода, а не при появлении', () => {
  for (const spellId of ['moonbeam', 'cloud-of-daggers', 'cloudkill', 'blade-barrier', 'maelstrom']) {
    const zone = session(spellId, { patch: { to: { x: 9, y: 2 } }, mutate: far('enemy', 9, 2) })
    assert.equal(zone.cast.filter((event) => RESULT_EVENTS.includes(event.event_type)).length, 0, `${spellId}: без эффекта при появлении`)
    assert.equal(zone.hits(zone.endTurn('caster')).length, 1, `${spellId}: урон в начале хода цели`)
    assert.equal(zone.hits(zone.endTurn('enemy')).length, 0, `${spellId}: конец хода не бьёт второй раз`)
    zone.assertReplay()
  }
})

test('Вход в Лунный луч на своём ходу и начало следующего хода — два разных хода', () => {
  const beam = session('moonbeam', { patch: { to: { x: 6, y: 2 } } })
  beam.endTurn('caster')
  assert.equal(beam.hits(beam.move('enemy', { x: 6, y: 2 })).length, 1, 'первый вход за ход')
  assert.equal(beam.hits(beam.move('enemy', { x: 7, y: 2 })).length, 0)
  assert.equal(beam.hits(beam.move('enemy', { x: 6, y: 2 })).length, 0, 'второй вход в тот же ход')
  beam.endTurn('enemy')
  beam.endTurn('ally')
  assert.equal(beam.hits(beam.endTurn('caster')).length, 1, 'начало следующего хода внутри')
  beam.assertReplay()
})

test('Исцеляющий дух лечит союзника в начале хода один раз', () => {
  const spirit = session('healing-spirit', { patch: { to: { x: 2, y: 3 } }, mutate: (state) => { state.players[1].hp = 10 } })
  assert.equal(spirit.hits(spirit.cast, 'ally').length, 0, 'без лечения при появлении')
  spirit.endTurn('caster')
  assert.equal(spirit.hits(spirit.endTurn('enemy'), 'ally').length, 1)
  spirit.move('ally', { x: 2, y: 5 })
  assert.equal(spirit.hits(spirit.move('ally', { x: 2, y: 3 }), 'ally').length, 0, 'повторный вход в тот же ход')
  assert.equal(spirit.hits(spirit.endTurn('ally'), 'ally').length, 0, 'конец хода не лечит')
  spirit.assertReplay()
})

test('Эвардовы щупальца: опутывание в начале хода, затем урон опутанному без спасброска', () => {
  const tentacles = session('evard-s-black-tentacles', { patch: { to: { x: 7, y: 2 } }, mutate: far('enemy', 7, 2) })
  assert.equal(tentacles.cast.filter((event) => RESULT_EVENTS.includes(event.event_type)).length, 0)
  const first = tentacles.endTurn('caster')
  assert.equal(first.filter((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('enemy')).length, 1)
  assert.ok(tentacles.state().mechanics.conditions.enemy.some((condition) => condition.id === 'restrained' && condition.duration === 'concentration'))
  tentacles.endTurn('enemy')
  tentacles.endTurn('ally')
  const held = tentacles.endTurn('caster')
  assert.equal(held.filter((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('enemy')).length, 0, 'опутанный не спасается заново')
  assert.equal(tentacles.hits(held).length, 1, 'но получает урон')
  tentacles.assertReplay()
})

test('Пылающий шар жжёт заканчивающего ход в 5 футах и не при появлении', () => {
  const near = session('flaming-sphere', { patch: { to: { x: 8, y: 3 } }, mutate: far('enemy', 7, 2) })
  assert.equal(near.cast.filter((event) => RESULT_EVENTS.includes(event.event_type)).length, 0)
  assert.equal(near.hits(near.endTurn('caster')).length, 0, 'начало хода не жжёт')
  assert.equal(near.hits(near.endTurn('enemy')).length, 1, 'конец хода рядом с шаром')
  const distant = session('flaming-sphere', { patch: { to: { x: 9, y: 2 } }, mutate: far('enemy', 7, 2) })
  distant.endTurn('caster')
  assert.equal(distant.hits(distant.endTurn('enemy')).length, 0, '10 футов от шара — уже вне')
})

test('Болезненное сияние повышает истощение при каждом срабатывании', () => {
  const radiance = session('sickening-radiance', { patch: { to: { x: 9, y: 2 } }, mutate: far('enemy', 9, 2) })
  radiance.endTurn('caster')
  assert.ok(radiance.state().mechanics.conditions.enemy.some((condition) => condition.id === 'exhaustion:1'))
  radiance.endTurn('enemy')
  radiance.endTurn('ally')
  radiance.endTurn('caster')
  assert.ok(radiance.state().mechanics.conditions.enemy.some((condition) => condition.id === 'exhaustion:2'))
  assert.equal(radiance.state().mechanics.conditions.enemy.some((condition) => condition.id === 'exhaustion:1'), false)
  radiance.assertReplay()
})

test('Терновая стена бьёт и в конце хода внутри', () => {
  const thorns = session('wall-of-thorns', { patch: { to: { x: 3, y: 2 } } })
  const inside = (thorns.state().mechanics.active_effects ?? []).find((effect) => effect.spell_id === 'wall-of-thorns')
  assert.equal(inside.trigger_on_turn_end, true)
  assert.equal(inside.once_per_turn, true)
})

test('Завеса стрел не стреляет по своей стороне', () => {
  const cordon = session('cordon-of-arrows', { patch: { to: { x: 3, y: 2 } }, mutate: (state) => { far('enemy', 12, 2)(state); far('ally', 12, 5)(state) } })
  cordon.endTurn('caster')
  assert.equal(cordon.hits(cordon.move('enemy', { x: 8, y: 2 })).length, 1)
  cordon.endTurn('enemy')
  const allyEntry = cordon.move('ally', { x: 8, y: 5 })
  assert.equal(allyEntry.filter((event) => event.target_ids?.includes('ally')
    && ['SpellSavingThrowResolved', 'DamageApplied', 'ReactionWindowOpened'].includes(event.event_type)).length, 0, 'союзник не проверяется вовсе')
  cordon.assertReplay()
})

test('Слово сияния задевает только выбранных существ', () => {
  const word = session('word-of-radiance', { patch: { target_id: 'enemy', target_ids: ['enemy'] } })
  assert.equal(word.hits(word.cast).length, 1)
  assert.equal(word.hits(word.cast, 'ally').length, 0)
})

test('Прежняя редакция сохраняет свою модель области', () => {
  const { state, command } = spellRuntimeFixture('spirit-guardians')
  const legacy = normalizeCampaignState({ ...structuredClone(state), ruleset_id: 'srd_5_2_1', ruleset_version: undefined, enabled_house_rules: [] })
  // Максимальные кубики: спасброски успешны, окно «Несгибаемости» не открывается.
  const cast = resolveCommand({ ...command, server_authoritative: true }, legacy, { diceService: dice('high'), context: context('caster') })
  assert.ok(cast.events.some((event) => event.event_type === 'DamageApplied'), 'прежняя модель бьёт при появлении')
  const area = cast.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(area.trigger_on_turn_end, true)
  assert.equal(area.once_per_turn, undefined)
  assert.equal(area.unaffected_actor_ids, undefined)
})
