import assert from 'node:assert/strict'
import test from 'node:test'

import { combatSpellFor } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `summon-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

const FAMILY = [
  { id: 'summon-undead', casterClass: 'wizard', level: 9, slot: 'spell_slots_3', damageType: 'necrotic' },
  { id: 'summon-fey', casterClass: 'druid', level: 9, slot: 'spell_slots_3', damageType: 'psychic' },
  { id: 'summon-shadowspawn', casterClass: 'warlock', level: 9, slot: 'pact_slots', damageType: 'cold' },
  { id: 'summon-aberration', casterClass: 'wizard', level: 9, slot: 'spell_slots_4', damageType: 'psychic' },
  { id: 'summon-construct', casterClass: 'wizard', level: 9, slot: 'spell_slots_4', damageType: 'bludgeoning' },
  { id: 'summon-elemental', casterClass: 'druid', level: 9, slot: 'spell_slots_4', damageType: 'bludgeoning' },
  { id: 'summon-celestial', casterClass: 'cleric', level: 11, slot: 'spell_slots_5', damageType: 'radiant' },
  { id: 'summon-draconic-spirit', casterClass: 'sorcerer', level: 11, slot: 'spell_slots_5', damageType: 'piercing' },
  { id: 'summon-fiend', casterClass: 'warlock', level: 12, slot: 'mystic_arcanum_6', damageType: 'slashing' },
]

function conjurerState(casterClass, level) {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'SUMMON-1',
    partyMemberIds: ['caster'],
    players: [{ id: 'caster', character: 'Зов', characterClass: casterClass, level, hp: 40, maxHp: 40, armor: 13, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 18, cha: 18 }, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'foe', name: 'Враг', creature_type: 'humanoid', hp: 60, maxHp: 60, armor: 12, speed: 30, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 6, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'foe', total: 8 }],
        action_economy: { caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

test('вся семья призывов духов объявлена серверным правилом и создаёт управляемое существо', () => {
  for (const entry of FAMILY) {
    const state = conjurerState(entry.casterClass, entry.level)
    const spell = combatSpellFor(state.players[0], entry.id)
    assert.equal(spell?.mechanicsSupport, 'partial', `${entry.id}: карточка обязана стать исполняемой`)
    assert.ok(spell.supportNote?.includes('серверное приближение'), `${entry.id}: ограничение обязано быть названо в карточке`)
    assert.equal(spell.kind, 'summon')

    const cast = resolveCommand(
      authoritative({ command_type: 'CastSpell', actor_id: 'caster', spell_id: entry.id, to: { x: 3, y: 1 } }),
      state,
      options(dice()),
    )
    const created = cast.events.find((event) => event.event_type === 'SummonedCreatureCreated')
    assert.ok(created, `${entry.id}: заклинание обязано создать существо`)
    assert.equal(created.payload.summon.faction, 'party')
    assert.equal(created.payload.summon.ownerId, 'caster')
    assert.equal(created.payload.summon.attack_profile.damage_type, entry.damageType, `${entry.id}: неверный тип урона духа`)
    assert.equal(created.payload.turn_rule, 'after-owner', `${entry.id}: дух обязан ходить сразу после владельца`)
    assert.equal(cast.events.find((event) => event.event_type === 'ResourceSpent')?.payload.resource, entry.slot, `${entry.id}: неверная ячейка`)
    assert.ok(cast.events.some((event) => event.event_type === 'ConcentrationStarted'), `${entry.id}: призыв держится концентрацией`)
  }
})

test('призванный дух встаёт в очередь инициативы и атакует бонусом заклинателя', () => {
  const state = conjurerState('wizard', 9)
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'summon-undead', to: { x: 5, y: 1 } }),
    state,
    options(dice()),
  )
  const summoned = replayEvents(state, cast.events)
  const created = cast.events.find((event) => event.event_type === 'SummonedCreatureCreated').payload.summon
  const order = summoned.mechanics.combat.initiative.map((entry) => String(entry.actor_id))
  assert.equal(order[order.indexOf('caster') + 1], created.id, 'дух обязан стоять сразу за владельцем')

  const index = summoned.mechanics.combat.initiative.findIndex((entry) => entry.actor_id === created.id)
  const spiritsTurn = { ...summoned, mechanics: { ...summoned.mechanics, combat: { ...summoned.mechanics.combat, active_index: index } } }
  const attack = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: created.id, target_id: 'foe' }),
    spiritsTurn,
    // Урон духа масштабируется кругом: на третьем это две кости.
    options(dice([15, 4, 4])),
  )
  const resolved = attack.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(resolved.payload.hit, true)
  assert.equal(attack.events.find((event) => event.event_type === 'DamageApplied').payload.damage_type, 'necrotic')
})

test('Духовное оружие появляется отдельной фишкой и бьёт бонусным действием', () => {
  const state = conjurerState('cleric', 5)
  const spell = combatSpellFor(state.players[0], 'spiritual-weapon')
  assert.equal(spell.mechanicsSupport, 'partial')
  assert.equal(spell.actionType, 'bonus_action', 'создание стоит бонусного действия, как в редакции')
  assert.equal(spell.concentration, false, 'концентрации оружие не требует')

  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'spiritual-weapon', to: { x: 5, y: 1 } }),
    state,
    options(dice()),
  )
  const weapon = cast.events.find((event) => event.event_type === 'SummonedCreatureCreated')?.payload.summon
  assert.ok(weapon, 'оружие обязано появиться отдельной фишкой')
  assert.equal(weapon.attack_profile.damage_expression, '1d8')
  assert.equal(weapon.attack_profile.damage_type, 'force')
  assert.equal(weapon.armor, 20, 'парящее оружие почти невозможно задеть')
  assert.equal(cast.events.some((event) => event.event_type === 'ConcentrationStarted'), false)

  const summoned = replayEvents(state, cast.events)
  assert.equal(summoned.mechanics.combat.action_economy.caster.bonus_action, false, 'бонусное действие потрачено')

  const index = summoned.mechanics.combat.initiative.findIndex((entry) => entry.actor_id === weapon.id)
  const weaponsTurn = { ...summoned, mechanics: { ...summoned.mechanics, combat: { ...summoned.mechanics.combat, active_index: index } } }
  const strike = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: weapon.id, target_id: 'foe' }),
    weaponsTurn,
    options(dice([16, 5])),
  )
  assert.equal(strike.events.find((event) => event.event_type === 'AttackResolved').payload.hit, true)
  assert.equal(strike.events.find((event) => event.event_type === 'DamageApplied').payload.damage_type, 'force')
})

test('дух исчезает вместе с концентрацией хозяина', () => {
  const state = conjurerState('wizard', 9)
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'summon-undead', to: { x: 5, y: 1 } }),
    state,
    options(dice()),
  )
  const summoned = replayEvents(state, cast.events)
  const created = cast.events.find((event) => event.event_type === 'SummonedCreatureCreated').payload.summon
  assert.ok(summoned.actors.some((actor) => String(actor.id) === created.id))

  const dropped = resolveCommand(
    authoritative({ command_type: 'EndConcentration', actor_id: 'caster', reason: 'voluntary' }),
    summoned,
    options(dice()),
  )
  const after = replayEvents(summoned, dropped.events)
  assert.equal(after.actors.some((actor) => String(actor.id) === created.id), false, 'без концентрации дух обязан исчезнуть')
})
