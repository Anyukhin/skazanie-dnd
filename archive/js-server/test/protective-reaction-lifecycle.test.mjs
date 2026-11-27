import assert from 'node:assert/strict'
import test from 'node:test'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

test('решение о Щите сохраняется через Resistance на спасброске концентрации', () => {
  let rollId = 0
  const options = (values) => ({ diceService: new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `shield-resistance-${++rollId}` }), context: { serverAuthoritativeCombat: true } })
  const initial = fixture({ hp: 30, maxHp: 30 })
  initial.mechanics.concentration = { mage: { effect_id: 'web:mage' }, enemy: { effect_id: 'resistance:enemy' } }
  initial.mechanics.conditions.mage = [{ id: 'resistance-d4', effect_id: 'resistance:enemy', source_actor: 'enemy', duration: 'concentration' }]
  initial.mechanics.active_effects = [{ id: 'web:mage', effect_id: 'web:mage', source_actor: 'mage', spell_id: 'web', concentration: true }]
  const attack = resolveCommand(authoritative({ command_type: 'MakeAttack', command_id: 'shield-resistance-hit', actor_id: 'enemy', target_id: 'mage' }), initial, options([11]))
  const first = replayEvents(initial, attack.events)
  assert.ok(first.mechanics.combat.reaction_window?.action_ids.includes('cast:shield'))
  const declined = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: 'shield-resistance-decline', actor_id: 'mage', action_id: 'decline-reaction' }), first, options([6]))
  const second = replayEvents(first, declined.events)
  assert.equal(second.mechanics.combat.reaction_window?.trigger, 'saving-throw-bonus-choice')
  const accepted = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: 'shield-resistance-bonus', actor_id: 'mage', action_id: 'use-resistance' }), second, options([1, 12]))
  const final = replayEvents(second, accepted.events)
  assert.equal(final.mechanics.combat.reaction_window?.trigger ?? null, null, 'отказ от Щита уже принят и не спрашивается повторно')
  assert.equal(final.players[0].hp, 14)
  assert.equal(accepted.events.filter((event) => event.event_type === 'DamageApplied').length, 1)
})

const authoritative = (value) => ({ ...value, server_authoritative: true })

test('Щит не отменяет натуральный критический удар даже при высокой КД', () => {
  let rollId = 0
  const options = { diceService: new DiceService({ rng: new SequenceDiceRng([20, 6, 6]), idFactory: () => `critical-shield-${++rollId}` }), context: { serverAuthoritativeCombat: true } }
  const initial = fixture({ hp: 30, maxHp: 30 })
  initial.players[0].armor = 25
  const attack = resolveCommand(authoritative({ command_type: 'MakeAttack', command_id: 'critical-shield', actor_id: 'enemy', target_id: 'mage' }), initial, options)
  const rolled = attack.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(rolled?.payload.critical, true)
  let final = replayEvents(initial, attack.events)
  if (final.mechanics.combat.reaction_window?.action_ids.includes('cast:shield')) {
    const shield = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: 'critical-shield-choice', actor_id: 'mage', action_id: 'cast:shield' }), final, options)
    final = replayEvents(final, shield.events)
  }
  assert.equal(final.players[0].hp, 8, 'натуральные20 сохраняют 2к6+10 урона: +5КД не превращает крит в промах')
})

test('уже потраченная реакция не создаёт новое окно защиты', () => {
  let rollId = 0
  const initial = fixture({ hp: 30, maxHp: 30 })
  initial.mechanics.combat.action_economy.mage.reaction = false
  const attack = resolveCommand(authoritative({ command_type: 'MakeAttack', command_id: 'spent-defense', actor_id: 'enemy', target_id: 'mage' }), initial, {
    diceService: new DiceService({ rng: new SequenceDiceRng([11, 6]), idFactory: () => `spent-defense-${++rollId}` }),
    context: { serverAuthoritativeCombat: true },
  })
  assert.equal(attack.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
  const final = replayEvents(initial, attack.events)
  assert.equal(final.players[0].hp, 14)
  assert.equal(final.mechanics.resources.mage.spell_slots_1.current, initial.mechanics.resources.mage.spell_slots_1.current)
})

test('ослеплённый плут без особого зрения не использует Невероятное уклонение', () => {
  let rollId = 0
  const initial = fixture({ characterClass: 'rogue', hp: 30, maxHp: 30, spells: [], damageBonus: 0 })
  initial.mechanics.conditions.mage = [{ id: 'blinded' }]
  const attack = resolveCommand(authoritative({ command_type: 'MakeAttack', command_id: 'blind-defense', actor_id: 'enemy', target_id: 'mage' }), initial, {
    diceService: new DiceService({ rng: new SequenceDiceRng([11, 10, 6]), idFactory: () => `blind-defense-${++rollId}` }),
    context: { serverAuthoritativeCombat: true },
  })
  assert.equal(attack.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
  assert.equal(replayEvents(initial, attack.events).players[0].hp, 24)
})

function fixture({ characterClass = 'wizard', hp = 1, maxHp = 5, spells = ['shield'], damageBonus = 10, damageType = 'slashing' } = {}) {
  return normalizeCampaignState({
    sessionCode: 'SHIELD-LETHAL', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Маг', characterClass, level: 5, hp, maxHp, armor: 10,
      speed: 30, proficiency: 3, abilities: { str: 10, dex: 10, con: 10, int: 16, wis: 10, cha: 10 },
      knownSpellIds: spells, preparedSpellIds: spells, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'enemy', name: 'Враг', hp: 30, maxHp: 30, armor: 12, speed: 30, attackBonus: 0,
      damageDice: 6, damageBonus,
      attack_profile: { name: 'Удар', attack_modifier: 0, damage_expression: damageBonus ? `1d6+${damageBonus}` : '1d6', damage_type: damageType, range_feet: 5 },
      abilities: { str: 10, dex: 10, con: 10 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells: Array.from({ length: 12 }, (_, index) => ({ x: index % 4, y: Math.floor(index / 4), type: 'floor', revealed: true })) },
    mechanics: { combat: { active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'mage', total: 10 }],
      action_economy: { enemy: { action: true, reaction: true, movement: true }, mage: { action: true, reaction: true, movement: true } },
    } },
  })
}

for (const accept of [true, false]) test(`защитная реакция до массивного урона: ${accept ? 'Щит отменяет попадание' : 'отказ сохраняет смертельный исход'}`, () => {
  let rollId = 0
  const diceService = new DiceService({ rng: new SequenceDiceRng([11, 6]), idFactory: () => `shield-lethal-${accept}-${++rollId}` })
  const options = { diceService, context: { serverAuthoritativeCombat: true } }
  const initial = fixture()
  const attack = resolveCommand(authoritative({ command_type: 'MakeAttack', command_id: 'lethal-hit', actor_id: 'enemy', target_id: 'mage' }), initial, options)
  assert.ok(attack.events.some((event) => event.event_type === 'ReactionWindowOpened' && event.payload.action_ids.includes('cast:shield')))
  assert.equal(attack.events.some((event) => ['DamageApplied', 'HeroDied', 'CampaignFailed'].includes(event.event_type)), false,
    'защита ещё может отменить удар: окончательный урон и смерть не фиксируются')
  const waiting = replayEvents(initial, attack.events)
  assert.equal(waiting.players[0].hp, 1)
  const choice = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: 'shield-choice', actor_id: 'mage',
    action_id: accept ? 'cast:shield' : 'decline-reaction' }), waiting, options)
  const final = replayEvents(waiting, choice.events)
  assert.equal(final.players[0].hp, accept ? 1 : 0)
  assert.equal(choice.events.filter((event) => event.event_type === 'HeroDied').length, accept ? 0 : 1)
  assert.equal(final.mechanics.death.heroes.mage?.status === 'dead', !accept)
  assert.equal(final.mechanics.resources.mage.spell_slots_1.current,
    initial.mechanics.resources.mage.spell_slots_1.current - (accept ? 1 : 0))
})

test('отказ от Щита после обычной атаки не открывает повторное старое окно', () => {
  const diceService = new DiceService({ rng: new SequenceDiceRng([11, 2]), idFactory: (() => {
    let rollId = 0
    return () => `attack-shield-decline-${++rollId}`
  })() })
  const options = { diceService, context: { serverAuthoritativeCombat: true } }
  const initial = fixture({ hp: 20, maxHp: 20, damageBonus: 0 })
  const attack = resolveCommand(authoritative({ command_type: 'MakeAttack', command_id: 'nonlethal-hit', actor_id: 'enemy', target_id: 'mage' }), initial, options)
  const waiting = replayEvents(initial, attack.events)
  const decline = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: 'decline-nonlethal-hit', actor_id: 'mage',
    action_id: 'decline-reaction' }), waiting, options)
  const final = replayEvents(waiting, decline.events)
  assert.equal(decline.events.filter((event) => event.event_type === 'DamageApplied').length, 1)
  assert.equal(decline.events.filter((event) => event.event_type === 'ReactionWindowOpened').length, 0)
  assert.equal(final.players[0].hp, 18)
})

for (const [actionId, characterClass, spells, damageType] of [
  ['cast:absorb-elements', 'wizard', ['absorb-elements'], 'fire'],
  ['uncanny-dodge', 'rogue', [], 'slashing'],
]) test(`${actionId} спасает от падения до 0 при атаке, не восстанавливая уже списанные ОЗ`, () => {
  let rollId = 0
  const diceService = new DiceService({ rng: new SequenceDiceRng([11, 6]), idFactory: () => `protective-${actionId}-${++rollId}` })
  const options = { diceService, context: { serverAuthoritativeCombat: true } }
  const initial = fixture({ characterClass, spells, damageType, damageBonus: 0, hp: 4, maxHp: 20 })
  const attack = resolveCommand(authoritative({ command_type: 'MakeAttack', command_id: 'protected-hit', actor_id: 'enemy', target_id: 'mage' }), initial, options)
  assert.ok(attack.events.some((event) => event.event_type === 'ReactionWindowOpened' && event.payload.action_ids.includes(actionId)))
  assert.equal(attack.events.some((event) => ['DamageApplied', 'HitPointsReducedToZero', 'HeroDied'].includes(event.event_type)), false)
  const waiting = replayEvents(initial, attack.events)
  assert.equal(waiting.players[0].hp, 4)
  const choice = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: 'protected-choice', actor_id: 'mage', action_id: actionId }), waiting, options)
  const final = replayEvents(waiting, choice.events)
  assert.equal(final.players[0].hp, 1, '6 урона сокращается до 3 до применения к 4 ОЗ')
  assert.equal(final.mechanics.combat.action_economy.mage.reaction, false)
  assert.equal(final.mechanics.death.heroes.mage?.status === 'dead', false)
  assert.equal(choice.events.filter((event) => event.event_type === 'DamageApplied').length, 1)
})

test('Щит останавливает смертельную Волшебную стрелу без фиктивного броска атаки', () => {
  let rollId = 0
  const diceService = new DiceService({ rng: new SequenceDiceRng([4]), idFactory: () => `missile-shield-${++rollId}` })
  const options = { diceService, context: { serverAuthoritativeCombat: true } }
  const initial = fixture()
  Object.assign(initial.enemies[0], { characterClass: 'wizard', level: 5, proficiency: 3,
    knownSpellIds: ['magic-missile'], preparedSpellIds: ['magic-missile'] })
  initial.mechanics.resources.enemy = { spell_slots_1: { current: 1, max: 1 } }
  const cast = resolveCommand(authoritative({ command_type: 'CastSpell', command_id: 'lethal-missiles', actor_id: 'enemy',
    spell_id: 'magic-missile', target_id: 'mage' }), initial, options)
  const reaction = cast.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.equal(reaction?.payload.trigger, 'magic-missile-shield-choice')
  assert.ok(reaction?.payload.action_ids.includes('cast:shield'))
  assert.equal(reaction?.payload.damage, undefined)
  assert.equal(reaction?.payload.pending_dice_transcript?.length, 1, 'урон стрелы бросается до окна и воспроизводится по транскрипту')
  assert.equal(cast.events.some((event) => ['AttackResolved', 'DamageApplied', 'HeroDied'].includes(event.event_type)), false)
  const waiting = replayEvents(initial, cast.events)
  const shield = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: 'shield-missiles', actor_id: 'mage',
    action_id: 'cast:shield' }), waiting, options)
  const final = replayEvents(waiting, shield.events)
  assert.equal(final.players[0].hp, 1)
  assert.equal(final.mechanics.death.heroes.mage?.status === 'dead', false)
  assert.equal(shield.events.some((event) => event.event_type === 'AttackResolved'), false)
  assert.equal(shield.events.filter((event) => event.event_type === 'DamageApplied').length, 1)
  const blocked = shield.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(blocked?.payload.blocked_by_shield, true)
  assert.equal(blocked?.payload.raw_amount, 15, 'записанный бросок сохраняется, хотя Щит применяет 0 урона')
  assert.equal(blocked?.payload.applied_amount, 0)
  assert.equal(shield.events.filter((event) => event.event_type === 'ReactionWindowOpened').length, 0)
  assert.equal(final.mechanics.resources.enemy.spell_slots_1.current, 0)
  assert.equal(final.mechanics.resources.mage.spell_slots_1.current, initial.mechanics.resources.mage.spell_slots_1.current - 1)
})

test('отказ от Щита перед Волшебной стрелой продолжает тот же бросок и фиксирует единственный урон', () => {
  let rollId = 0
  const diceService = new DiceService({ rng: new SequenceDiceRng([4]), idFactory: () => `missile-decline-${++rollId}` })
  const options = { diceService, context: { serverAuthoritativeCombat: true } }
  const initial = fixture()
  Object.assign(initial.enemies[0], { characterClass: 'wizard', level: 5, proficiency: 3,
    knownSpellIds: ['magic-missile'], preparedSpellIds: ['magic-missile'] })
  initial.mechanics.resources.enemy = { spell_slots_1: { current: 1, max: 1 } }
  const cast = resolveCommand(authoritative({ command_type: 'CastSpell', command_id: 'declined-missiles', actor_id: 'enemy',
    spell_id: 'magic-missile', target_id: 'mage' }), initial, options)
  const waiting = replayEvents(initial, cast.events)
  const decline = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: 'decline-missiles', actor_id: 'mage',
    action_id: 'decline-reaction' }), waiting, options)
  const final = replayEvents(waiting, decline.events)
  assert.equal(final.players[0].hp, 0)
  assert.equal(decline.events.filter((event) => event.event_type === 'DamageApplied').length, 1)
  assert.equal(decline.events.filter((event) => event.event_type === 'HitPointsReducedToZero').length, 1)
  assert.equal(decline.events.some((event) => event.event_type === 'AttackResolved'), false)
  assert.equal(decline.events.filter((event) => event.event_type === 'ReactionWindowOpened').length, 0)
  assert.equal(final.mechanics.resources.enemy.spell_slots_1.current, 0)
  assert.equal(final.mechanics.resources.mage.spell_slots_1.current, initial.mechanics.resources.mage.spell_slots_1.current)
})

test('Щит открывается до урона обычной spell attack и не создаёт второго окна после отказа', () => {
  const diceService = new DiceService({ rng: new SequenceDiceRng([8, 6, 6, 6]), idFactory: (() => {
    let rollId = 0
    return () => `spell-attack-shield-${++rollId}`
  })() })
  const options = { diceService, context: { serverAuthoritativeCombat: true } }
  const initial = fixture({ hp: 20, maxHp: 20, spells: ['shield'], damageBonus: 0 })
  Object.assign(initial.enemies[0], { characterClass: 'wizard', level: 5, proficiency: 3,
    abilities: { ...initial.enemies[0].abilities, int: 16 },
    knownSpellIds: ['fire-bolt'], preparedSpellIds: ['fire-bolt'] })
  const cast = resolveCommand(authoritative({ command_type: 'CastSpell', command_id: 'spell-attack-shield', actor_id: 'enemy',
    spell_id: 'fire-bolt', target_id: 'mage', target_ids: ['mage'] }), initial, options)
  const reaction = cast.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.equal(reaction?.payload.trigger, 'attack-shield-choice')
  assert.equal(cast.events.some((event) => ['AttackResolved', 'DamageApplied', 'HeroDied'].includes(event.event_type)), false)
  const waiting = replayEvents(initial, cast.events)
  const decline = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: 'decline-spell-attack-shield', actor_id: 'mage',
    action_id: 'decline-reaction' }), waiting, options)
  const final = replayEvents(waiting, decline.events)
  assert.equal(decline.events.filter((event) => event.event_type === 'AttackResolved').length, 1)
  assert.equal(decline.events.filter((event) => event.event_type === 'DamageApplied').length, 1)
  assert.equal(decline.events.filter((event) => event.event_type === 'ReactionWindowOpened').length, 0)
  assert.ok(final.players[0].hp < initial.players[0].hp)
})

for (const [actionId, characterClass, spells] of [
  ['cast:absorb-elements', 'wizard', ['absorb-elements']],
  ['uncanny-dodge', 'rogue', []],
]) test(`${actionId} применяется до урона spell attack`, () => {
  const diceService = new DiceService({ rng: new SequenceDiceRng([8, 3, 3]), idFactory: (() => {
    let rollId = 0
    return () => `spell-attack-${actionId}-${++rollId}`
  })() })
  const options = { diceService, context: { serverAuthoritativeCombat: true } }
  const initial = fixture({ hp: 4, maxHp: 20, characterClass, spells, damageBonus: 0, damageType: 'fire' })
  Object.assign(initial.enemies[0], { characterClass: 'wizard', level: 5, proficiency: 3,
    abilities: { ...initial.enemies[0].abilities, int: 16 },
    knownSpellIds: ['fire-bolt'], preparedSpellIds: ['fire-bolt'] })
  const cast = resolveCommand(authoritative({ command_type: 'CastSpell', command_id: `spell-attack-${actionId}`, actor_id: 'enemy',
    spell_id: 'fire-bolt', target_id: 'mage', target_ids: ['mage'] }), initial, options)
  const reaction = cast.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.ok(reaction?.payload.action_ids.includes(actionId))
  const waiting = replayEvents(initial, cast.events)
  const choice = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: `spell-attack-choice-${actionId}`,
    actor_id: 'mage', action_id: actionId }), waiting, options)
  const final = replayEvents(waiting, choice.events)
  assert.equal(final.players[0].hp, 1)
  assert.equal(choice.events.filter((event) => event.event_type === 'DamageApplied').length, 1)
  assert.equal(choice.events.find((event) => event.event_type === 'DamageApplied')?.payload.applied_amount, 3)
  assert.equal(final.mechanics.combat.action_economy.mage.reaction, false)
})
