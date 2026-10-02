import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// Расхождения из ревью заклинаний 2 октября 2026 года, которым понадобилась
// новая механика движка: длящиеся области, заготовленные удары, счёт
// спасбросков, режимы заклинаний.
// Стенд: заклинатель (2,2) → противник (3,2) → союзник (2,3).

const context = (actorId = 'caster') => ({ serverAuthoritativeCombat: true, allowedActorIds: [actorId] })
const dice = (mode = 'high') => new DiceService({ rng: Array.isArray(mode) ? new SequenceDiceRng(mode) : { randint: (min, max) => (mode === 'low' ? min : max) } })
const SWORD = { id: 'blade', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', type: 'weapon', damage: '1d8', damage_type: 'slashing', equipped: true, quantity: 1 }

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
    has: (conditionId, actorId = 'enemy') => (live.mechanics.conditions[actorId] ?? []).some((condition) => condition.id === conditionId),
    condition: (conditionId, actorId = 'enemy') => (live.mechanics.conditions[actorId] ?? []).find((condition) => condition.id === conditionId),
    assertReplay: () => assert.deepEqual(
      JSON.parse(JSON.stringify(replayEvents(initial, JSON.parse(JSON.stringify(events))).mechanics)),
      JSON.parse(JSON.stringify(live.mechanics)),
    ),
  }
}
const away = (state) => { state.mechanics.positions.ally = { x: 2, y: 15 } }
const damageTo = (events, actor = 'enemy') => events.filter((event) => event.event_type === 'DamageApplied' && event.target_ids.includes(actor))

test('Паутина опутывает вошедшего, а вырвавшийся не рвёт всю паутину', () => {
  const web = session('web', { mode: 'low', patch: { to: { x: 8, y: 2 } }, mutate: (state) => { away(state); state.mechanics.positions.enemy = { x: 12, y: 2 } } })
  assert.equal(web.has('restrained'), false, 'вне паутины при сотворении')
  web.endTurn('caster')
  web.run({ command_type: 'MoveActor', to: { x: 9, y: 2 } }, 'enemy')
  assert.ok(web.has('restrained'), 'вошедший опутан')
  web.endTurn('enemy')
  web.endTurn('ally')
  web.endTurn('caster')
  const freed = web.run({ command_type: 'UseCombatAction', action_id: 'break-free' }, 'enemy', 'high')
  assert.equal(freed.find((event) => event.event_type === 'AbilityCheckResolved').payload.difficulty, 16)
  assert.equal(web.has('restrained'), false)
  assert.ok(web.state().mechanics.concentration.caster, 'паутина держится')
  assert.ok(web.state().mechanics.active_effects.some((effect) => effect.spell_id === 'web'))
  web.assertReplay()
})

test('Порыв ветра толкает начавшего ход в полосе, а не при сотворении', () => {
  const gust = session('gust-of-wind', { mode: 'low', patch: { to: { x: 9, y: 2 } }, mutate: (state) => { away(state); state.mechanics.positions.enemy = { x: 4, y: 2 } } })
  assert.equal(gust.cast.some((event) => event.event_type === 'ActorMoved'), false)
  const start = gust.endTurn('caster')
  const pushed = start.find((event) => event.event_type === 'ActorMoved' && event.payload.forced_movement === true)
  assert.deepEqual(pushed?.payload.to, { x: 7, y: 2 })
  gust.assertReplay()
})

test('Голод Хадара: без урона при сотворении, холод и слепота в начале хода, кислота в конце', () => {
  const hunger = session('hunger-of-hadar', { mode: 'low', patch: { to: { x: 9, y: 2 } }, mutate: (state) => { away(state); state.mechanics.positions.enemy = { x: 9, y: 2 } } })
  assert.equal(damageTo(hunger.cast).length, 0)
  const start = damageTo(hunger.endTurn('caster'))
  assert.deepEqual(start.map((event) => event.payload.damage_type), ['cold'])
  assert.ok(hunger.has('blinded'))
  const end = hunger.endTurn('enemy')
  assert.deepEqual(damageTo(end).map((event) => event.payload.damage_type), ['acid'])
  assert.equal(hunger.has('blinded'), false, 'слепота до конца хода')
  hunger.assertReplay()
})

test('Стихийное оружие, Покров духа и Ашардалонова поступь растут ступенями ячейки', () => {
  const weapon = session('elemental-weapon', { patch: { slot_level: 5 } })
  assert.ok(weapon.has('elemental-weapon-2', weapon.cast.find((event) => event.event_type === 'ConditionAdded').target_ids[0]))
  const shroud = session('spirit-shroud', { patch: { slot_level: 5 } })
  assert.ok(shroud.has('spirit-shroud-2', 'caster'))
  const stride = session('ashardalon-s-stride', { patch: { slot_level: 5 } })
  assert.ok(stride.has('ashardalon-s-stride-30', 'caster'))
  assert.ok(stride.has('disengaged', 'caster'))
  assert.ok(session('ashardalon-s-stride').has('ashardalon-s-stride-20', 'caster'), '3-й круг — +20 футов')
})

test('Покров духа добавляет кость к атаке заклинанием рядом', () => {
  const shroud = session('spirit-shroud', { mutate: (state) => { state.players[0].knownSpellIds.push('fire-bolt') } })
  shroud.endTurn('caster')
  shroud.endTurn('enemy')
  shroud.endTurn('ally')
  const { command } = spellRuntimeFixture('fire-bolt')
  const bolt = shroud.run({ ...command }, 'caster')
  const rider = damageTo(bolt).find((event) => event.payload.spell_id === 'spirit-shroud')
  assert.ok(rider, 'кость Покрова')
  assert.equal(rider.payload.spell_damage_rider, true)
})

function arrowSession(rolls, allyAt = { x: 9, y: 2 }) {
  const arrow = session('lightning-arrow', { mutate: (state) => {
    // Лук и колчан стенда: посох убирается за спину, лук берётся в руки.
    state.players[0].inventory = state.players[0].inventory.map((item) => ({ ...item, equipped: item.id === 'gear-2' }))
    state.mechanics.positions.enemy = { x: 8, y: 2 }
    state.mechanics.positions.ally = allyAt
  } })
  const shot = arrow.run({ command_type: 'MakeAttack', target_id: 'enemy', item_id: 'gear-2' }, 'caster', rolls)
  return { arrow, shot }
}

test('Молниевая стрела заменяет урон оружия, а промахом бьёт половиной', () => {
  const hit = arrowSession('high')
  const main = damageTo(hit.shot)[0]
  assert.equal(main.payload.damage_type, 'lightning')
  assert.ok(damageTo(hit.shot, 'ally').some((event) => event.payload.damage_type === 'lightning'), 'вспышка задевает соседа')
  assert.equal(damageTo(hit.shot).filter((event) => event.payload.spell_id === 'lightning-arrow').length, 0, 'урон стрелы — это сам выстрел, без добавки')
  assert.equal(hit.arrow.state().mechanics.concentration.caster, undefined, 'после выстрела заклинание кончается')

  // Сосед с «Несгибаемым» открыл бы окно реакции на проваленный спасбросок.
  const miss = arrowSession('low', { x: 2, y: 15 })
  const half = damageTo(miss.shot).find((event) => event.payload.spell_id === 'lightning-arrow')
  assert.equal(half?.payload.missed, true)
  assert.equal(half.payload.damage_type, 'lightning')
  assert.equal(half.payload.raw_amount, 2, '4к8 по единице → 4, половина — 2')
  miss.arrow.assertReplay()
})

test('Удар Зефира тратится и промахом, а скорость растёт в любом случае', () => {
  const zephyr = session('zephyr-strike', { mutate: (state) => { state.players[0].inventory = [SWORD] } })
  const swing = zephyr.run({ command_type: 'MakeAttack', target_id: 'enemy', item_id: 'blade' }, 'caster', 'low')
  assert.equal(swing.find((event) => event.event_type === 'AttackResolved').payload.mode, 'advantage')
  assert.equal(zephyr.state().mechanics.conditions.caster.some((condition) => String(condition.id).startsWith('next-weapon-hit:')), false)
  assert.ok(swing.some((event) => event.event_type === 'CombatActionUsed' && event.payload.movement_bonus === 30))
  assert.equal(damageTo(swing).length, 0)
})

test('Опутывающий удар: успешный спасбросок кончает заклинание', () => {
  const strike = session('ensnaring-strike', { mutate: (state) => { state.players[0].inventory = [SWORD] } })
  strike.run({ command_type: 'MakeAttack', target_id: 'enemy', item_id: 'blade' }, 'caster', [15, 5, 20])
  assert.equal(strike.state().mechanics.concentration.caster, undefined)
})

test('Невидимость спадает при атаке', () => {
  const invisible = session('invisibility', { patch: { target_id: 'caster', target_ids: ['caster'] } })
  assert.ok(invisible.has('invisible', 'caster'))
  for (const actor of ['caster', 'enemy', 'ally']) invisible.endTurn(actor)
  const swing = invisible.run({ command_type: 'MakeAttack', target_id: 'enemy', item_id: 'gear-0' }, 'caster')
  assert.equal(swing.find((event) => event.event_type === 'AttackResolved').payload.mode, 'advantage', 'сама атака — ещё из невидимости')
  assert.equal(invisible.has('invisible', 'caster'), false)
  invisible.assertReplay()
})

test('Водяная сфера: повторный спасбросок Силы в конце хода', () => {
  const sphere = session('watery-sphere', { mode: 'low' })
  assert.ok(sphere.has('restrained'))
  sphere.endTurn('caster')
  sphere.endTurn('enemy', 'high')
  assert.equal(sphere.has('restrained'), false)
})

test('Свобода перемещения не даёт заклинанию парализовать', () => {
  const { state, command } = spellRuntimeFixture('hold-person')
  state.mechanics.conditions.enemy = [{ id: 'freedom-of-movement', duration: 'rounds:600', source_actor: 'enemy' }]
  const events = resolveCommand({ ...command, server_authoritative: true }, state, { diceService: dice('low'), context: context() }).events
  assert.equal(events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'paralyzed'), false)
})

test('Поток негативной энергии лечит нежить временными хитами', () => {
  const flood = session('negative-energy-flood', { mutate: (state) => { state.enemies[0].creature_type = 'undead' } })
  assert.equal(damageTo(flood.cast).length, 0)
  assert.equal(flood.cast.some((event) => event.event_type === 'SpellSavingThrowResolved'), false)
  assert.equal(flood.state().mechanics.temporary_hp.enemy, 30, '5к12 по максимуму — 60, половина — 30')
})

test('Неудержимая пляска Отто: без начального спасброска, вырваться — действием', () => {
  const dance = session('otto-s-irresistible-dance')
  assert.ok(dance.has('dancing'), 'максимальная кость не спасает: спасброска нет')
  assert.equal(dance.cast.some((event) => event.event_type === 'ReactionWindowOpened'), false)
  dance.endTurn('caster')
  const plan = planNpcTurn(dance.state(), 'enemy')
  assert.equal(plan[0].action_id, 'steady-nerves')
  dance.run({ command_type: 'UseCombatAction', action_id: 'steady-nerves' }, 'enemy', 'high')
  assert.equal(dance.has('dancing'), false)
  dance.assertReplay()
})

test('Окаменение: три провала обращают в камень, «Высвободиться» не помогает', () => {
  const stone = session('flesh-to-stone', { mode: 'low' })
  assert.ok(stone.has('restrained'))
  stone.endTurn('caster')
  assert.throws(() => stone.run({ command_type: 'UseCombatAction', action_id: 'break-free' }, 'enemy', 'high'), (error) => error?.code === 'RESTRAINT_NOT_ESCAPABLE')
  for (let round = 0; round < 3; round += 1) {
    stone.endTurn('enemy', 'low')
    if (round < 2) {
      assert.equal(stone.condition('restrained').tally_failures, round + 1)
      stone.endTurn('ally')
      stone.endTurn('caster')
    }
  }
  assert.ok(stone.has('petrified'))
  assert.equal(stone.has('restrained'), false)
  stone.assertReplay()
})

test('Окаменение: три успеха кончают заклинание', () => {
  const stone = session('flesh-to-stone', { mode: 'low' })
  stone.endTurn('caster')
  for (let round = 0; round < 3; round += 1) {
    stone.endTurn('enemy', 'high')
    if (round < 2) {
      assert.ok(stone.has('restrained'), `успехов ${round + 1} — ещё держит`)
      stone.endTurn('ally')
      stone.endTurn('caster')
    }
  }
  assert.equal(stone.has('restrained'), false)
  assert.equal(stone.state().mechanics.concentration.caster, undefined)
})

test('Удар стального ветра — атака по каждой цели', () => {
  const strike = session('steel-wind-strike', { mode: 'low' })
  assert.ok(strike.cast.some((event) => event.event_type === 'AttackResolved'))
  assert.equal(damageTo(strike.cast).length, 0, 'промах — без урона')
})

test('Сотворение костра — длящаяся область, урон растёт с уровнем', () => {
  const fire = session('create-bonfire', { mode: 'low', patch: { to: { x: 3, y: 2 } } })
  const area = fire.state().mechanics.active_effects.find((effect) => effect.spell_id === 'create-bonfire')
  assert.equal(area.damage, '3d8', 'заклинатель 12-го уровня')
  assert.equal(area.trigger_on_turn_end, true)
  assert.ok(fire.state().mechanics.concentration.caster)
})

test('Кости земли: под открытым небом без урона, под потолком — урон и опутывание', () => {
  const open = session('bones-of-the-earth', { mode: 'low', patch: { to: { x: 3, y: 2 }, spell_option: 'open-sky' }, mutate: away })
  assert.equal(damageTo(open.cast).length, 0)
  assert.equal(open.has('restrained'), false)
  const roofed = session('bones-of-the-earth', { mode: 'low', patch: { to: { x: 3, y: 2 }, spell_option: 'under-ceiling' }, mutate: away })
  assert.equal(damageTo(roofed.cast).length, 1)
  assert.ok(roofed.has('restrained'))
})

test('Преобразование камня: режимы не смешиваются', () => {
  const mud = session('transmute-rock', { mode: 'low', patch: { to: { x: 3, y: 2 }, spell_option: 'rock-to-mud' }, mutate: away })
  assert.equal(damageTo(mud.cast).length, 0)
  assert.equal(mud.cast.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.ability, 'str')
  assert.ok(mud.state().mechanics.active_effects.some((effect) => effect.spell_id === 'transmute-rock' && effect.difficult_terrain))
  const fall = session('transmute-rock', { mode: 'low', patch: { to: { x: 3, y: 2 }, spell_option: 'ceiling-collapse' }, mutate: away })
  assert.equal(damageTo(fall.cast).length, 1)
  assert.equal(fall.has('restrained'), false)
  assert.equal((fall.state().mechanics.active_effects ?? []).some((effect) => effect.spell_id === 'transmute-rock'), false)
})

test('Прежняя редакция: Паутина и Пляска Отто ведут себя как раньше', () => {
  const legacy = (spellId) => {
    const { state, command } = spellRuntimeFixture(spellId)
    return { state: normalizeCampaignState({ ...structuredClone(state), ruleset_id: 'srd_5_2_1', ruleset_version: undefined, enabled_house_rules: [] }), command }
  }
  const dance = legacy('otto-s-irresistible-dance')
  const events = resolveCommand({ ...dance.command, server_authoritative: true }, dance.state, { diceService: dice('high'), context: context() }).events
  assert.equal(events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'dancing'), false, 'прежняя модель со спасброском')
})
