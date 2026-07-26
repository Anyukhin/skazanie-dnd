import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `beam-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

function field({ casterClass = 'wizard', level = 12, inventory = [], foeAt = { x: 2, y: 1 }, foeHp = 90 } = {}) {
  const cells = Array.from({ length: 60 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'BEAM-1',
    partyMemberIds: ['caster'],
    players: [{ id: 'caster', character: 'Аль', characterClass: casterClass, level, hp: 30, maxHp: 60, armor: 14, speed: 30, proficiency: 4, abilities: { str: 16, dex: 14, con: 14, int: 18, wis: 16, cha: 18 }, inventory, x: 1, y: 1 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: foeHp, maxHp: foeHp, armor: 10, speed: 30, abilities: { str: 14, dex: 8, con: 14, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { caster: { spell_slots_2: { current: 3, max: 3 }, spell_slots_3: { current: 3, max: 3 }, spell_slots_4: { current: 3, max: 3 } } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const cast = (state, spellId, values, extra = {}) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'caster', spell_id: spellId, target_id: 'brute', ...extra }),
  state,
  options(dice(values)),
)
const hits = (result) => result.events.filter((event) => event.event_type === 'DamageApplied').map((event) => event.payload)

test('Огненные лучи бьют тремя отдельными атаками', () => {
  // На каждый луч: к20 попадания и 2к6 урона. Класс доспеха 10 — попадают все.
  const result = cast(field(), 'scorching-ray', [15, 4, 4, 16, 3, 3, 17, 2, 2])
  const damage = hits(result)
  assert.equal(damage.length, 3, 'три луча — три попадания')
  assert.deepEqual(damage.map((entry) => entry.raw_amount), [8, 6, 4])
  assert.equal(damage.every((entry) => entry.damage_type === 'fire'), true)
})

test('ячейка выше второй добавляет по лучу', () => {
  const state = field()
  const result = cast(state, 'scorching-ray', [15, 4, 4, 16, 4, 4, 17, 4, 4, 18, 4, 4, 19, 4, 4], { slot_level: 4 })
  assert.equal(hits(result).length, 5, 'ячейка 4-го уровня даёт пять лучей')

  // Пять лучей — одно применение: ячейка тратится ровно одна.
  const spent = result.events.filter((event) => event.event_type === 'ResourceSpent')
  assert.equal(spent.length, 1, 'дополнительные лучи не платят своей ячейкой')
  assert.equal(spent[0].payload.resource, 'spell_slots_4')
  assert.equal(replayEvents(state, result.events).mechanics.resources.caster.spell_slots_4.current, 2)
})

test('Вампирское касание лечит заклинателя на половину нанесённого', () => {
  const result = cast(field({ foeAt: { x: 2, y: 1 } }), 'vampiric-touch', [15, 4, 4, 4])
  const damage = hits(result)[0]
  assert.equal(damage.raw_amount, 12)
  assert.equal(damage.damage_type, 'necrotic')
  const healing = result.events.find((event) => event.event_type === 'HealingApplied')
  assert.ok(healing, 'заклинатель обязан получить лечение')
  assert.equal(healing.payload.applied_amount, 6, 'половина от нанесённого')
  assert.equal(healing.payload.hp_after, 36)
})

test('поглощение считается от полученного урона, а не от броска', () => {
  const resistant = field({ foeAt: { x: 2, y: 1 } })
  resistant.mechanics.defenses = { brute: { resistances: ['necrotic'] } }
  const result = cast(normalizeCampaignState(resistant), 'vampiric-touch', [15, 4, 4, 4])
  assert.equal(hits(result)[0].applied_amount, 6, 'сопротивление режет урон вдвое')
  assert.equal(result.events.find((event) => event.event_type === 'HealingApplied').payload.applied_amount, 3, 'лечение идёт от отнятого, а не от 12')
})

test('Клеймящая кара добавляет урон следующему удару оружием', () => {
  const state = field({ casterClass: 'paladin', level: 9, inventory: [SWORD] })
  const prepared = replayEvents(state, cast(state, 'branding-smite', [], { target_id: 'caster' }).events)
  assert.ok(prepared.mechanics.conditions.caster.some((condition) => String(condition.id).startsWith('next-weapon-hit:')))

  const strike = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'brute', item_id: 'sword' }),
    prepared,
    options(dice([17, 5, 4, 4])),
  )
  const smite = strike.events.find((event) => event.event_type === 'DamageApplied' && event.payload.next_weapon_hit)
  assert.ok(smite, 'кара обязана добавить свой урон')
  assert.equal(smite.payload.damage_type, 'radiant')
  assert.equal(smite.payload.raw_amount, 8)
  assert.ok(strike.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'branded'))
})

test('Ослепляющая кара требует спасброска Телосложения и слепит при провале', () => {
  const state = field({ casterClass: 'paladin', level: 9, inventory: [SWORD] })
  const prepared = replayEvents(state, cast(state, 'blinding-smite', [], { target_id: 'caster' }).events)
  const strike = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'brute', item_id: 'sword' }),
    prepared,
    options(dice([17, 5, 4, 4, 4, 2])),
  )
  const save = strike.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.ability, 'con')
  assert.equal(save.payload.saved, false)
  assert.ok(strike.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'blinded'))
})

test('Шипы делают землю труднопроходимой и колют без спасброска', () => {
  const result = cast(field({ casterClass: 'druid' }), 'spike-growth', [], { to: { x: 5, y: 1 }, target_id: undefined })
  const effect = result.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(effect.difficult_terrain, true)
  assert.equal(effect.damage, '2d4')
  assert.equal(effect.save_ability, null, 'у шипов спасброска нет')
  assert.equal(hits(result).length, 0, 'при появлении зарослей никто урона не получает')
})

test('Чёрные щупальца опутывают и бьют повторно в начале хода', () => {
  // Заклинатель стоит в (1,1) и в куб со стороной 20 футов вокруг (8,1) не
  // попадает: щупальца не разбирают своих и чужих, и это правильно.
  const result = cast(field({ foeAt: { x: 8, y: 1 } }), 'evard-s-black-tentacles', [3, 3, 3, 2], { to: { x: 8, y: 1 }, target_id: undefined })
  assert.equal(hits(result)[0].raw_amount, 9)
  const restrained = result.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'restrained')
  assert.ok(restrained, 'провал спасброска опутывает')
  assert.equal(restrained.payload.recurring_damage, '3d6')
})
