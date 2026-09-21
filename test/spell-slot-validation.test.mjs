import assert from 'node:assert/strict'
import test from 'node:test'

import { combatSpellFor, fixedSpellSlotLevelFor } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `slot-audit-${++id}`, now: () => '2026-09-19T12:00:00.000Z' })
}

function state({ characterClass = 'wizard', level = 5, known = ['magic-missile'], resources = {} } = {}) {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true }))
  const actor = {
    id: 'caster', character: 'Заклинатель', characterClass, level,
    hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
    abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 16 },
    knownSpellIds: known, preparedSpellIds: known, inventory: [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'component-pouch', quantity: 1 })], x: 1, y: 1,
  }
  return normalizeCampaignState({
    sessionCode: 'SPELL-SLOT-VALIDATION', partyMemberIds: ['caster'], ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [actor],
    enemies: [
      { id: 'target', name: 'Цель', creature_type: 'humanoid', hp: 100, maxHp: 100, armor: 12, speed: 30, attackBonus: 0, damageDice: 4, damageBonus: 0, abilities: { str: 10, dex: 10, con: 10, int: 8, wis: 8, cha: 8 }, x: 2, y: 1, alive: true },
      { id: 'target-two', name: 'Вторая цель', creature_type: 'humanoid', hp: 100, maxHp: 100, armor: 12, speed: 30, attackBonus: 0, damageDice: 4, damageBonus: 0, abilities: { str: 10, dex: 10, con: 10, int: 8, wis: 8, cha: 8 }, x: 3, y: 1, alive: true },
    ],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { caster: resources },
      combat: { active: true, round: 1, initiative: [{ actor_id: 'caster', total: 18 }, { actor_id: 'target', total: 10 }, { actor_id: 'target-two', total: 9 }], active_index: 0,
        action_economy: { caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }, target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }, 'target-two': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } },
    },
  })
}

function cast(current, extra = {}) {
  return resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'magic-missile', target_id: 'target', server_authoritative: true, ...extra }, current, {
    diceService: dice([3]), context: { serverAuthoritativeCombat: true },
  })
}

function applyAll(current, events) {
  return events.reduce((next, event) => applyGameEvent(next, event), current)
}

test('явный неверный круг отклоняется до расхода, а исчерпанный явный слот не откатывается на старший', () => {
  const initial = state({ resources: {
    spell_slots_1: { current: 0, max: 1 },
    spell_slots_2: { current: 1, max: 1 },
  } })
  const before = structuredClone(initial)
  assert.throws(() => cast(initial, { command_id: 'invalid-9', slot_level: 9 }), (error) => error.code === 'INVALID_SPELL_SLOT_LEVEL')
  assert.throws(() => cast(initial, { command_id: 'invalid-lower', slot_level: 0 }), (error) => error.code === 'INVALID_SPELL_SLOT_LEVEL')
  assert.throws(() => cast(initial, { command_id: 'invalid-fraction', slot_level: 1.5 }), (error) => error.code === 'INVALID_SPELL_SLOT_LEVEL')
  assert.deepEqual(initial, before)

  assert.throws(() => cast(initial, { command_id: 'exhausted-1', slot_level: 1 }), (error) => error.code === 'INSUFFICIENT_RESOURCE')
  assert.deepEqual(initial, before)

  const auto = cast(initial, { command_id: 'auto-fallback' })
  assert.equal(auto.events.find((event) => event.event_type === 'SpellCast')?.payload.slot_level, 2)
  assert.equal(auto.events.find((event) => event.event_type === 'ResourceSpent')?.payload.resource, 'spell_slots_2')
})

test('валидный normal upcast выбирает только запрошенный ресурс', () => {
  const initial = state({ resources: {
    spell_slots_1: { current: 1, max: 1 },
    spell_slots_2: { current: 1, max: 1 },
  } })
  const result = cast(initial, { command_id: 'valid-2', slot_level: 2 })
  assert.equal(result.events.find((event) => event.event_type === 'SpellCast')?.payload.slot_level, 2)
  assert.equal(result.events.find((event) => event.event_type === 'ResourceSpent')?.payload.resource, 'spell_slots_2')
})

test('pact slot использует круг WARLOCK_PACT, а Mystic Arcanum всегда шестой', () => {
  const warlock = state({ characterClass: 'warlock', level: 5, known: ['hex'], resources: { pact_slots: { current: 1, max: 1 } } })
  const pactSpell = combatSpellFor(warlock.players[0], 'hex')
  assert.equal(pactSpell?.slotResource, 'pact_slots')
  assert.equal(pactSpell?.slotLevel, 3)
  const projected = campaignStateForViewer(warlock, { role: 'player', heroIds: ['caster'] }, 'caster')
  assert.equal(projected.players.find((player) => player.id === 'caster')?.combatSpells?.find((spell) => spell.id === 'hex')?.slotLevel, 3)
  const hold = state({ characterClass: 'warlock', level: 5, known: ['hold-person'], resources: { pact_slots: { current: 1, max: 1 } } })
  const holdResult = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'hold-person', target_ids: ['target', 'target-two'], server_authoritative: true }, hold, {
    diceService: dice([20, 20]), context: { serverAuthoritativeCombat: true },
  })
  assert.equal(holdResult.events.find((event) => event.event_type === 'SpellCast')?.payload.slot_level, 3)
  assert.equal(holdResult.events.filter((event) => event.event_type === 'SpellSavingThrowResolved').length, 2)
  assert.equal(fixedSpellSlotLevelFor(warlock.players[0], pactSpell), 3)
  assert.throws(() => resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'hex', target_id: 'target', slot_level: 2, server_authoritative: true }, warlock, { diceService: dice(), context: { serverAuthoritativeCombat: true } }), (error) => error.code === 'INVALID_SPELL_SLOT_LEVEL')
  const pactCast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'hex', target_id: 'target', server_authoritative: true }, warlock, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  assert.equal(pactCast.events.find((event) => event.event_type === 'SpellCast')?.payload.slot_level, 3)

  const arcanum = state({ characterClass: 'warlock', level: 12, known: ['summon-fiend'], resources: { mystic_arcanum_6: { current: 1, max: 1 } } })
  arcanum.players[0].inventory.push(materializeCatalogItem('srd_5_2_1:material-summon-fiend-600gp', { id: 'summon-fiend-600gp', quantity: 1 }))
  const arcanumSpell = combatSpellFor(arcanum.players[0], 'summon-fiend')
  assert.equal(arcanumSpell?.slotResource, 'mystic_arcanum_6')
  assert.equal(arcanumSpell?.slotLevel, 6)
  assert.equal(fixedSpellSlotLevelFor(arcanum.players[0], arcanumSpell), 6)
  assert.throws(() => resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'summon-fiend', to: { x: 4, y: 1 }, slot_level: 5, server_authoritative: true }, arcanum, { diceService: dice(), context: { serverAuthoritativeCombat: true } }), (error) => error.code === 'INVALID_SPELL_SLOT_LEVEL')
  const arcanumCast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'summon-fiend', to: { x: 4, y: 1 }, server_authoritative: true }, arcanum, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  assert.equal(arcanumCast.events.find((event) => event.event_type === 'SpellCast')?.payload.slot_level, 6)
  assert.equal(arcanumCast.events.find((event) => event.event_type === 'ResourceSpent')?.payload.resource, 'mystic_arcanum_6')
})

test('innate cast level is fixed and does not accept arbitrary upcast', () => {
  const initial = state({ known: ['fireball'], resources: { species_spell_fireball: { current: 1, max: 1 } } })
  initial.players[0].speciesBenefits = { innate_spells: [{ id: 'fireball', uses: 1, cast_level: 3, minimum_level: 1 }] }
  const spell = combatSpellFor(initial.players[0], 'fireball')
  assert.equal(spell?.slotResource, 'species_spell_fireball')
  assert.equal(fixedSpellSlotLevelFor(initial.players[0], spell), 3)
  assert.throws(() => resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'fireball', to: { x: 4, y: 1 }, slot_level: 4, server_authoritative: true }, initial, { diceService: dice([5]), context: { serverAuthoritativeCombat: true } }), (error) => error.code === 'INVALID_SPELL_SLOT_LEVEL')
  const innateCast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'fireball', to: { x: 4, y: 1 }, server_authoritative: true }, initial, { diceService: dice(Array.from({ length: 20 }, () => 5)), context: { serverAuthoritativeCombat: true } })
  assert.equal(innateCast.events.find((event) => event.event_type === 'SpellCast')?.payload.slot_level, 3)
  assert.equal(innateCast.events.find((event) => event.event_type === 'ResourceSpent')?.payload.resource, 'species_spell_fireball')

  const fallback = state({ known: ['fireball'], resources: { species_spell_fireball: { current: 0, max: 1 }, spell_slots_3: { current: 1, max: 1 } } })
  fallback.players[0].speciesBenefits = { innate_spells: [{ id: 'fireball', uses: 1, cast_level: 3, minimum_level: 1 }] }
  const fallbackSpell = combatSpellFor(fallback.players[0], 'fireball')
  assert.equal(fallbackSpell?.fallbackSlotResource, 'spell_slots_3')
  const fallbackCast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'fireball', to: { x: 4, y: 1 }, server_authoritative: true }, fallback, { diceService: dice(Array.from({ length: 20 }, () => 5)), context: { serverAuthoritativeCombat: true } })
  assert.equal(fallbackCast.events.find((event) => event.event_type === 'SpellCast')?.payload.slot_level, 3)
  assert.equal(fallbackCast.events.find((event) => event.event_type === 'ResourceSpent')?.payload.resource, 'spell_slots_3')
})
