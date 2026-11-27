import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// Расхождения описания и исполнения из ревью заклинаний 2 октября 2026 года,
// которые закрываются данными профиля и таблицей эффектов состояний.
// Стенд: заклинатель (2,2) → противник (3,2) → союзник (2,3).

const context = (actorId = 'caster') => ({ serverAuthoritativeCombat: true, allowedActorIds: [actorId] })
const dice = (mode = 'high') => new DiceService({ rng: { randint: (min, max) => (mode === 'low' ? min : max) } })
const SWORD = { id: 'blade', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', type: 'weapon', damage: '1d8', damage_type: 'slashing', equipped: true, quantity: 1 }
const BOW = { id: 'bow', catalog_id: 'srd_5_2_1:longbow', name: 'Длинный лук', type: 'weapon', damage: '1d8', damage_type: 'piercing', equipped: true, quantity: 1 }

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
    endTurn: (actorId) => run({ command_type: 'EndTurn' }, actorId),
    state: () => live,
    has: (conditionId, actorId = 'enemy') => (live.mechanics.conditions[actorId] ?? []).some((condition) => condition.id === conditionId),
    assertReplay: () => assert.deepEqual(
      JSON.parse(JSON.stringify(replayEvents(initial, JSON.parse(JSON.stringify(events))).mechanics)),
      JSON.parse(JSON.stringify(live.mechanics)),
    ),
  }
}

/** Цель с эффектом-состоянием, которую бьёт заклинание из стенда. */
function withCondition(spellId, conditions, { actor = 'enemy', patch = {}, mode = 'high', mutate } = {}) {
  const { state, command } = spellRuntimeFixture(spellId)
  state.mechanics.conditions[actor] = conditions.map((id) => (typeof id === 'string' ? { id, duration: 'concentration', source_actor: 'ally' } : id))
  mutate?.(state)
  return resolveCommand({ ...command, ...patch, server_authoritative: true }, state, { diceService: dice(mode), context: context() }).events
}
const saveOf = (events, actor = 'enemy') => events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes(actor))?.payload

test('Замедление: −2 к спасброскам Ловкости и одна атака за ход', () => {
  const save = saveOf(withCondition('fireball', ['slowed'], { patch: { to: { x: 3, y: 2 } } }))
  assert.equal(save.condition_save_bonus, -2)
  assert.equal(save.modifier, -1 - 2)

  const { state } = spellRuntimeFixture('fire-bolt')
  state.players[0].characterClass = 'fighter'
  state.players[0].inventory = [SWORD]
  state.mechanics.conditions.caster = [{ id: 'slowed', duration: 'concentration', source_actor: 'enemy' }]
  const attack = (live) => resolveCommand({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'enemy', item_id: 'blade', server_authoritative: true }, live, { diceService: dice('high'), context: context() })
  const first = attack(state).events.reduce(applyGameEvent, state)
  assert.throws(() => attack(first), (error) => error?.code === 'SLOWED_SINGLE_ATTACK')
})

test('Замедленный противник с мультиатакой завершает ход после одного удара', () => {
  const { state } = spellRuntimeFixture('fire-bolt')
  state.enemies[0].traits = [{ id: 'multiattack', attacks: 2 }]
  state.mechanics.conditions.enemy = [{ id: 'slowed', duration: 'concentration', source_actor: 'caster' }]
  state.mechanics.combat.active_index = 1
  state.mechanics.combat.action_economy.enemy = { ...state.mechanics.combat.action_economy.enemy, action: false, attacks_used: 1 }
  assert.deepEqual(planNpcTurn(state, 'enemy'), [{ command_type: 'EndTurn', actor_id: 'enemy' }])
})

test('Маяк надежды даёт преимущество на спасброски Мудрости', () => {
  assert.equal(saveOf(withCondition('hold-person', ['beacon-of-hope'])).mode, 'advantage')
  assert.notEqual(saveOf(withCondition('sacred-flame', ['beacon-of-hope'])).mode, 'advantage', 'Ловкость — без преимущества')
})

test('Гипнотический узор снимает любой урон, а не только урон союзников заклинателя', () => {
  const pattern = session('hypnotic-pattern', { mode: 'low', patch: { to: { x: 6, y: 2 } }, mutate: (state) => {
    state.mechanics.positions.enemy = { x: 6, y: 2 }
    state.mechanics.positions.ally = { x: 2, y: 12 }
  } })
  assert.ok(pattern.has('incapacitated'))
  // Урон наносит сам противник себе подобным — сторона заклинателя ни при чём.
  const hurt = pattern.run({ command_type: 'ApplyDamage', target_id: 'enemy', amount: 3, damage_type: 'fire' }, 'enemy')
  assert.ok(hurt.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'charmed'))
  assert.equal(pattern.has('incapacitated'), false)
  // Снимается эффект с этого существа; концентрация кончается только потому,
  // что других зачарованных не осталось.
  assert.equal(hurt.find((event) => event.event_type === 'ConcentrationEnded')?.payload.reason, 'effect-finished')
  pattern.assertReplay()
})

test('Корона безумия повторяет спасбросок в конце хода цели', () => {
  const crown = session('crown-of-madness', { mode: 'low' })
  assert.ok(crown.has('charmed'))
  crown.endTurn('caster')
  const ended = crown.run({ command_type: 'EndTurn' }, 'enemy', 'high')
  assert.ok(ended.some((event) => event.event_type === 'SpellSavingThrowResolved' || event.event_type === 'SavingThrowResolved'))
  assert.equal(crown.has('charmed'), false)
  crown.assertReplay()
})

test('Увядание и цветение задевает только выбранных', () => {
  const wither = session('wither-and-bloom', { mode: 'low', patch: { to: { x: 3, y: 3 }, target_id: 'enemy', target_ids: ['enemy'] } })
  const hit = (actor) => wither.cast.some((event) => event.event_type === 'DamageApplied' && event.target_ids.includes(actor))
  assert.equal(hit('enemy'), true)
  assert.equal(hit('ally'), false)
})

test('Метель покрывает радиус 40 футов', () => {
  const storm = session('sleet-storm', { patch: { to: { x: 10, y: 10 } } })
  assert.equal(storm.state().mechanics.active_effects.find((effect) => effect.spell_id === 'sleet-storm').radius_feet, 40)
})

test('Ледяная стена: прорыв — спасбросок Телосложения раз за ход', () => {
  const wall = session('wall-of-ice', { patch: { to: { x: 8, y: 2 } }, mutate: (state) => { state.mechanics.positions.enemy = { x: 12, y: 2 } } })
  const effect = wall.state().mechanics.active_effects.find((candidate) => candidate.spell_id === 'wall-of-ice')
  assert.equal(effect.save_ability, 'con')
  assert.equal(effect.once_per_turn, true)
})

test('Приливная волна — полоса 30×10 футов, а не куб', () => {
  const wave = session('tidal-wave', { mode: 'low', patch: { to: { x: 6, y: 2 } }, mutate: (state) => {
    state.mechanics.positions.enemy = { x: 7, y: 2 }
    state.mechanics.positions.ally = { x: 8, y: 2 }
  } })
  const hit = (actor) => wave.cast.some((event) => event.event_type === 'DamageApplied' && event.target_ids.includes(actor))
  assert.equal(hit('enemy'), true, 'второй ряд волны')
  assert.equal(hit('ally'), false, 'третий ряд — уже за 10 футами ширины')
})

test('Стена ветров бьёт только при появлении', () => {
  const wall = session('wind-wall', { mode: 'low', patch: { to: { x: 6, y: 2 } }, mutate: (state) => { state.mechanics.positions.enemy = { x: 8, y: 2 } } })
  wall.endTurn('caster')
  const entered = wall.run({ command_type: 'MoveActor', to: { x: 6, y: 2 } }, 'enemy')
  assert.equal(entered.some((event) => event.event_type === 'DamageApplied'), false)
})

test('Защитный ветер мешает только дальнобойным атакам оружием', () => {
  const ward = session('warding-wind')
  ward.endTurn('caster')
  const swing = (item) => {
    const state = structuredClone(ward.state())
    state.enemies[0].inventory = [item]
    if (item === BOW) state.mechanics.positions.enemy = { x: 7, y: 2 }
    return resolveCommand({ command_type: 'MakeAttack', actor_id: 'enemy', target_id: 'caster', item_id: item.id, server_authoritative: true }, state,
      { diceService: dice('high'), context: context('enemy') }).events.find((event) => event.event_type === 'AttackResolved').payload.mode
  }
  assert.equal(swing(SWORD), 'normal')
  assert.equal(swing(BOW), 'disadvantage')
})

test('Тень Моила: сопротивление излучению', () => {
  const damage = withCondition('sacred-flame', ['shadow-of-moil'], { mode: 'low' }).find((event) => event.event_type === 'DamageApplied').payload
  assert.equal(damage.resistant, true)
})

test('Леденящее прикосновение: нежить атакует заклинателя с помехой', () => {
  const touch = session('chill-touch', { mutate: (state) => { state.enemies[0].creature_type = 'undead' } })
  assert.ok(touch.has('chill-touch-undead'))
  touch.endTurn('caster')
  const attack = (target) => {
    const state = structuredClone(touch.state())
    return resolveCommand({ command_type: 'MakeAttack', actor_id: 'enemy', target_id: target, server_authoritative: true }, state,
      { diceService: dice('high'), context: context('enemy') }).events.find((event) => event.event_type === 'AttackResolved').payload.mode
  }
  assert.equal(attack('caster'), 'disadvantage')
  assert.equal(attack('ally'), 'normal', 'по другим существам помехи нет')
  assert.equal(session('chill-touch').has('chill-touch-undead'), false, 'живое существо помехи не получает')
})

test('Увеличение на союзника ложится без спасброска, противник спасается', () => {
  const ally = session('enlarge-reduce', { patch: { target_id: 'ally', target_ids: ['ally'], spell_option: 'enlarge' } })
  assert.ok(ally.has('enlarged', 'ally'))
  assert.equal(saveOf(ally.cast, 'ally').willing_target, true)
  const foe = session('enlarge-reduce', { patch: { spell_option: 'reduce' } })
  assert.equal(foe.has('reduced'), false, 'максимальная кость — противник устоял')
})

test('Дух феи бьёт колющим уроном', () => {
  const fey = session('summon-fey', { patch: { to: { x: 6, y: 6 } } })
  const spirit = fey.state().actors.find((actor) => actor.sourceSpellId === 'summon-fey')
  assert.equal(spirit.attack_profile.damage_type, 'piercing')
})
