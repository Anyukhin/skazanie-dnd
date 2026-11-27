import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `mix-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

/** Заклинатель в (1,1), громила в (9,1) — на одной линии и в пределах любой дальности. */
function field({ casterClass = 'wizard', level = 12, enemyY = 1, defenses = {} } = {}) {
  const cells = Array.from({ length: 60 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'MIX-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: casterClass, level, hp: 60, maxHp: 60, armor: 13, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 18, cha: 12 }, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 120, maxHp: 120, armor: 13, speed: 30, abilities: { str: 16, dex: 8, con: 14, int: 8, wis: 8, cha: 8 }, x: 9, y: enemyY, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      defenses,
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const hits = (result) => result.events.filter((event) => event.event_type === 'DamageApplied').map((event) => event.payload)

test('Огненный удар бьёт двумя типами и двумя отдельными событиями', () => {
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'flame-strike', to: { x: 9, y: 1 } }),
    field({ casterClass: 'cleric' }),
    options(dice([4, 4, 4, 4, 3, 3, 3, 3, 2])),
  )
  const damage = hits(cast)
  assert.equal(damage.length, 2, 'огонь и свет приходят раздельно, а не одной суммой')
  assert.deepEqual(damage.map((entry) => entry.damage_type), ['fire', 'radiant'])
  assert.deepEqual(damage.map((entry) => entry.raw_amount), [16, 12])
  // Вторая порция считается от уже уменьшенных хитов, а не от исходных.
  assert.equal(damage[0].hp_after, 104)
  assert.equal(damage[1].hp_after, 92)
})

test('сопротивление огню не защищает от лучистой половины Огненного удара', () => {
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'flame-strike', to: { x: 9, y: 1 } }),
    field({ casterClass: 'cleric', defenses: { brute: { resistances: ['fire'] } } }),
    options(dice([4, 4, 4, 4, 3, 3, 3, 3, 2])),
  )
  const damage = hits(cast)
  assert.equal(damage[0].applied_amount,8, 'огненная половина уполовинена сопротивлением')
  assert.equal(damage[1].applied_amount,12, 'лучистая половина проходит полностью')
})

test('успешный спасбросок уполовинивает обе части урона', () => {
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'flame-strike', to: { x: 9, y: 1 } }),
    field({ casterClass: 'cleric' }),
    options(dice([4, 4, 4, 4, 3, 3, 3, 3, 20])),
  )
  const damage = hits(cast)
  assert.equal(cast.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.saved, true)
  assert.deepEqual(damage.map((entry) => entry.raw_amount), [8, 6])
})

test('Ледяной шторм бьёт дроблением и холодом и оставляет труднопроходимый лёд', () => {
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'ice-storm', to: { x: 9, y: 1 } }),
    field(),
    options(dice([4, 4, 3, 3, 3, 3, 2])),
  )
  const damage = hits(cast)
  assert.deepEqual(damage.map((entry) => entry.damage_type), ['bludgeoning', 'cold'])
  assert.deepEqual(damage.map((entry) => entry.raw_amount), [8, 12])
  const area = cast.events.find((event) => event.event_type === 'SpellAreaCreated')
  assert.equal(area.payload.effect.difficult_terrain, true)
  assert.equal(area.payload.effect.damage, null, 'лёд сам по себе урона не наносит')
})

test('Солнечный луч бьёт из заклинателя и ослепляет провалившего спасбросок', () => {
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'sunbeam', to: { x: 9, y: 1 } }),
    field({ casterClass: 'cleric' }),
    options(dice([4, 4, 4, 4, 4, 4, 2])),
  )
  assert.equal(hits(cast)[0].raw_amount, 24)
  assert.equal(hits(cast)[0].damage_type, 'radiant')
  const blinded = cast.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'blinded')
  assert.ok(blinded, 'провал спасброска Телосложения ослепляет')

  const aside = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'sunbeam', to: { x: 9, y: 1 } }),
    field({ casterClass: 'cleric', enemyY: 3 }),
    options(dice([4, 4, 4, 4, 4, 4, 2])),
  )
  assert.equal(hits(aside).length, 0, 'стоящий в стороне под луч не попадает')
})

test('Ледяная стена бьёт при появлении и берёт плату за прорыв', () => {
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'wall-of-ice', to: { x: 9, y: 1 } }),
    field(),
    options(dice([...Array.from({ length: 10 }, () => 4), 2])),
  )
  assert.equal(hits(cast)[0].raw_amount, 40)
  assert.equal(hits(cast)[0].damage_type, 'cold')
  const effect = cast.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(effect.difficult_terrain, true)
  assert.equal(effect.trigger_on_enter, true)
  assert.equal(effect.damage, '5d6')
  assert.equal(effect.cells.every((cell) => cell.x === 9), true, 'стена встаёт поперёк направления заклинателя')
})

test('Стена шипов колет при появлении и режет проходящих', () => {
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'wall-of-thorns', to: { x: 9, y: 1 } }),
    field({ casterClass: 'druid' }),
    options(dice([...Array.from({ length: 7 }, () => 4), 2])),
  )
  assert.equal(hits(cast)[0].damage_type, 'piercing')
  assert.equal(hits(cast)[0].raw_amount, 28)
  const effect = cast.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(effect.damage_type, 'slashing')
  assert.equal(effect.difficult_terrain, true)
})

test('Синаптический разряд требует спасброска Интеллекта', () => {
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'synaptic-static', to: { x: 9, y: 1 } }),
    field(),
    options(dice([...Array.from({ length: 8 }, () => 4), 2])),
  )
  const save = cast.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.ability, 'int')
  assert.equal(hits(cast)[0].raw_amount, 32)
  assert.equal(hits(cast)[0].damage_type, 'psychic')
})
