import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// Эффекты D&D 2014, которые раньше оставляли метку-состояние без следствий:
// толчок, притягивание, случайный шаг, стабилизация, бросок волшебного камня.
// И добавочный урон Сглаза и Божественного благоволения со своим типом.
// Заклинатель стоит в (2,2), противник по умолчанию — в (3,2).

const context = (actorId = 'caster') => ({ serverAuthoritativeCombat: true, allowedActorIds: [actorId] })
const dice = (mode) => new DiceService({ rng: Array.isArray(mode) ? new SequenceDiceRng(mode) : { randint: (min, max) => (mode === 'low' ? min : max) } })

function cast(spellId, { mode = 'low', enemyAt, mutate, patch = {} } = {}) {
  const { state, command } = spellRuntimeFixture(spellId)
  if (enemyAt) state.mechanics.positions.enemy = enemyAt
  mutate?.(state)
  const result = resolveCommand({ ...command, ...patch, server_authoritative: true }, state, { diceService: dice(mode), context: context() })
  const after = result.events.reduce(applyGameEvent, state)
  assert.deepEqual(JSON.parse(JSON.stringify(replayEvents(state, JSON.parse(JSON.stringify(result.events))).mechanics.positions)),
    JSON.parse(JSON.stringify(after.mechanics.positions)), `${spellId}: replay`)
  return { events: result.events, after, state }
}
const moved = (events) => events.find((event) => event.event_type === 'ActorMoved' && event.payload.forced_movement === true)
const damaged = (events, id = 'enemy') => events.some((event) => event.event_type === 'DamageApplied' && event.target_ids.includes(id))

test('Шквал толкает существо среднего размера на 5 футов и не двигает большое', () => {
  const pushed = cast('gust')
  assert.deepEqual(moved(pushed.events).payload.to, { x: 4, y: 2 })
  assert.equal((pushed.after.mechanics.conditions.enemy ?? []).some((condition) => condition.id === 'pushed-5'), false, 'метки больше нет')
  assert.equal(moved(cast('gust', { mutate: (state) => { state.enemies[0].size = 'large' } }).events), undefined)
  assert.equal(moved(cast('gust', { mode: 'high' }).events), undefined, 'успешный спасбросок — без толчка')
})

test('Терновый кнут при попадании притягивает на 10 футов, при промахе — нет', () => {
  const hit = cast('thorn-whip', { mode: 'high', enemyAt: { x: 8, y: 2 } })
  assert.deepEqual(moved(hit.events).payload.to, { x: 6, y: 2 })
  assert.equal(moved(cast('thorn-whip', { mode: 'low', enemyAt: { x: 8, y: 2 } }).events), undefined)
  assert.equal(moved(cast('thorn-whip', { mode: 'high', enemyAt: { x: 8, y: 2 }, mutate: (state) => { state.enemies[0].size = 'huge' } }).events), undefined, 'огромное существо не тянется')
})

test('Лассо молнии тянет к себе и бьёт, только если цель оказалась рядом', () => {
  const close = cast('lightning-lure', { enemyAt: { x: 5, y: 2 } })
  assert.deepEqual(moved(close.events).payload.to, { x: 3, y: 2 })
  assert.equal(damaged(close.events), true)
  const far = cast('lightning-lure', { enemyAt: { x: 4, y: 5 } })
  assert.ok(moved(far.events), 'притягивание было')
  assert.equal(damaged(far.events), false, 'после притягивания цель дальше 5 футов — урона нет')
  const saved = cast('lightning-lure', { mode: 'high', enemyAt: { x: 5, y: 2 } })
  assert.equal(moved(saved.events), undefined)
  assert.equal(damaged(saved.events), false)
})

test('Нашествие сдвигает цель на 5 футов в сторону по к4, а в занятую клетку не сдвигает', () => {
  // Порядок костей: спасбросок, урон, направление.
  const steps = { 1: { x: 3, y: 1 }, 2: { x: 3, y: 3 }, 3: { x: 4, y: 2 } }
  for (const [roll, destination] of Object.entries(steps)) {
    const { events } = cast('infestation', { mode: [1, 1, 1, 1, Number(roll), Number(roll), Number(roll)] })
    assert.deepEqual(moved(events)?.payload.to, destination, `к4 = ${roll}`)
  }
  const blocked = cast('infestation', { mode: [1, 1, 1, 1, 4, 4, 4] })
  assert.equal(moved(blocked.events), undefined, 'запад занят заклинателем')
  assert.ok(blocked.events.some((event) => event.event_type === 'DieRolled' && event.payload.purpose === 'spell_random_move:infestation'))
})

test('Уход за умирающим стабилизирует, а на здорового и на нежить не действует', () => {
  const dying = (state, type) => {
    state.players[1].hp = 0
    if (type) state.players[1].creature_type = type
    state.mechanics.death.saving_throws.ally = { successes: 1, failures: 2, stable: false }
    state.mechanics.conditions.ally = [{ id: 'unconscious', duration: null }]
  }
  const saved = cast('spare-the-dying', { mutate: (state) => dying(state) })
  assert.deepEqual(saved.after.mechanics.death.saving_throws.ally, { successes: 0, failures: 0, stable: true })
  assert.equal((saved.after.mechanics.conditions.ally ?? []).some((condition) => condition.id === 'stabilized'), false)
  const healthy = (state) => {
    state.players[1].hp = 40
    state.mechanics.death.saving_throws.ally = { successes: 0, failures: 0, stable: false }
    state.mechanics.conditions.ally = []
  }
  for (const [label, mutate] of [['здоровый', healthy], ['нежить', (state) => dying(state, 'undead')]]) {
    const { state, command } = spellRuntimeFixture('spare-the-dying')
    mutate(state)
    const before = JSON.stringify(state)
    assert.throws(() => resolveCommand({ ...command, server_authoritative: true }, state, { diceService: dice('low'), context: context() }),
      (error) => ['STABILIZATION_NOT_REQUIRED', 'INVALID_SPELL_TARGET'].includes(error?.code), label)
    assert.equal(JSON.stringify(state), before, `${label}: отказ без изменений`)
  }
})

test('Волшебный камень — атака заклинанием 1к6 + модификатор без роста заговора', () => {
  const { events } = cast('magic-stone', { mode: 'high' })
  const attack = events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.hit, true)
  assert.equal(events.find((event) => event.event_type === 'DieRolled' && event.payload.purpose === 'spell_damage:magic-stone').payload.expression, '2d6+4', 'критическое попадание удваивает только кость')
  assert.equal(events.find((event) => event.event_type === 'DamageApplied').payload.damage_type, 'bludgeoning')
})

function weaponHit(spellId, defenses, rulesetId) {
  const { state, command } = spellRuntimeFixture(spellId)
  const base = rulesetId ? normalizeCampaignState({ ...structuredClone(state), ruleset_id: rulesetId, ruleset_version: undefined, enabled_house_rules: [] }) : state
  base.mechanics.defenses = { enemy: defenses }
  const prepared = resolveCommand({ ...command, server_authoritative: true }, base, { diceService: dice('high'), context: context() }).events.reduce(applyGameEvent, base)
  prepared.players[0].inventory = [...prepared.players[0].inventory.map((item) => ({ ...item, equipped: false })),
    { id: 'sword', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', type: 'weapon', damage: '1d8', damage_type: 'slashing', equipped: true, quantity: 1 }]
  return resolveCommand({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'enemy', item_id: 'sword', server_authoritative: true }, prepared,
    { diceService: dice([15, 5, 3, 3, 3, 3]), context: context() }).events.filter((event) => event.event_type === 'DamageApplied')
}

test('Сглаз и Божественное благоволение приходят своим типом урона', () => {
  const hexed = weaponHit('hex', { immunities: ['slashing'] })
  assert.deepEqual(hexed.map((event) => [event.payload.damage_type, event.payload.applied_amount]), [['slashing', 0], ['necrotic', 3]])
  const favored = weaponHit('divine-favor', { resistances: ['slashing'] })
  assert.deepEqual(favored.map((event) => [event.payload.damage_type, event.payload.applied_amount]), [['slashing', 4], ['radiant', 3]])
  assert.equal(favored[1].payload.spell_id, 'divine-favor')
})

test('Прежняя редакция складывает кость Сглаза с уроном оружия, как раньше', () => {
  const legacy = weaponHit('hex', {}, 'srd_5_2_1')
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].payload.damage_type, 'slashing')
})
