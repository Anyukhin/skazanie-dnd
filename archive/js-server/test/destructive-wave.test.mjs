import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { classBenefitsFor, classOptionFor } from '../server/character-creation-class-options.mjs'
import { combatSpellFor } from '../server/combat-spells.mjs'
import { getWorldTemplate } from '../server/world-template-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const cells = Array.from({ length: 144 }, (_, index) => ({
  x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true,
}))

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => 'destructive-wave-' + (++id),
    now: () => '2026-09-22T12:00:00.000Z',
  })
}

function tempestDomainBenefits() {
  const result = classBenefitsFor('cleric', { skills: ['history', 'religion'], subclass: 'tempest' })
  assert.equal(result.ok, true)
  const byLevel = Object.fromEntries(Object.entries(result.domain_spell_ids_by_level)
    .map(([level, ids]) => [level, ids.map((id) => id.replaceAll('_', '-'))]))
  return {
    class: { class_key: 'cleric', subclass: { id: 'tempest' } },
    domain_spells: byLevel['1'],
    domain_spells_by_level: byLevel,
  }
}

function field({ foeHp = 100, foe = {}, caster = {}, ally = {}, defenses = {} } = {}) {
  const creationBenefits = tempestDomainBenefits()
  return normalizeCampaignState({
    sessionCode: 'DESTRUCTIVE-WAVE-CANDIDATE',
    ruleset_id: 'srd_5_2_1',
    partyMemberIds: ['caster', 'ally'],
    players: [
      {
        id: 'caster', character: 'Буревестник', characterClass: 'cleric', subclass: 'tempest', level: 9,
        hp: 60, maxHp: 60, armor: 16, speed: 30, proficiency: 4,
        abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 18, cha: 12 },
        inventory: [], x: 1, y: 1, creationBenefits, ...caster,
      },
      {
        id: 'ally', character: 'Союзник', characterClass: 'wizard', level: 5,
        hp: 40, maxHp: 40, armor: 13, speed: 30, proficiency: 3,
        abilities: { str: 8, dex: 14, con: 10, int: 16, wis: 10, cha: 10 },
        inventory: [], x: 2, y: 1, knownSpellIds: [], preparedSpellIds: [], ...ally,
      },
    ],
    enemies: [{
      id: 'foe', name: 'Цель', creature_type: 'humanoid', hp: foeHp, maxHp: 100,
      armor: 13, speed: 30, abilities: { str: 12, dex: 10, con: 10, int: 10, wis: 8, cha: 8 },
      x: 3, y: 1, alive: true, ...foe,
    }],
    scene: { turn: 1, cells },
    mechanics: {
      resources: {
        caster: { spell_slots_5: { current: 1, max: 1 } },
        ally: { spell_slots_1: { current: 1, max: 1 } },
      },
      defenses,
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'ally', total: 12 }, { actor_id: 'foe', total: 8 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ally: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function npcField() {
  const base = field()
  return normalizeCampaignState({
    ...base,
    scene: { ...base.scene, location: 'market', location_id: 'market' },
    social: { npcs: [{ id: 'villager', name: 'Житель', role: 'житель', location: 'market', visibility: 'party', available: true }] },
    npc_world: {
      schema_version: 3,
      placements: [{ npc_id: 'villager', location_id: 'market', x: 4, y: 1, placement_reason: 'destructive-wave-test' }],
      vitals: { villager: { hp: 100, max_hp: 100, alive: true } },
      stances: {}, inventories: {}, profiles: {},
    },
    mechanics: { ...base.mechanics, defenses: { villager: { resistances: ['thunder'] } } },
  })
}

function cast(state, values, targetIds = ['foe'], option = 'radiant', commandId = 'wave') {
  return resolveCommand({
    command_type: 'CastSpell',
    command_id: commandId,
    actor_id: 'caster',
    spell_id: 'destructive-wave',
    spell_option: option,
    target_ids: targetIds,
    server_authoritative: true,
  }, state, { diceService: dice(values), context: { serverAuthoritativeCombat: true } })
}

const applyAll = (state, events) => events.reduce(applyGameEvent, state)

test('Tempest domain gives a legal fifth-circle source at cleric level 9; paladin 12 grant is rejected', () => {
  const option = classOptionFor('cleric').subclass_options.find((entry) => entry.id === 'tempest')
  assert.deepEqual(option.domain_spells[9], ['destructive_wave', 'insect_plague'])
  const legal = field().players[0]
  const spell = combatSpellFor(legal, 'destructive-wave')
  assert.equal(spell?.slotResource, 'spell_slots_5')
  assert.equal(spell?.prepared, true)
  assert.equal(combatSpellFor({
    characterClass: 'paladin', level: 12, abilities: { cha: 18 },
    creationBenefits: { domain_spells: ['destructive-wave'] },
  }, 'destructive-wave'), null)
})

test('domain entries unlock at their class level and obey the spell-slot ceiling', () => {
  const benefits = tempestDomainBenefits()
  const levelEight = field().players[0]
  levelEight.level = 8
  levelEight.creationBenefits = benefits
  assert.equal(combatSpellFor(levelEight, 'destructive-wave'), null)
  const levelNine = field().players[0]
  levelNine.level = 9
  levelNine.creationBenefits = benefits
  assert.equal(combatSpellFor(levelNine, 'destructive-wave')?.level, 5)
  const multiclass = { ...levelNine, level: 13, characterClass: 'wizard', creationBenefits: benefits }
  assert.equal(combatSpellFor(multiclass, 'destructive-wave'), null)
})

test('selected creatures share one Constitution save and two typed damage components', () => {
  const initial = field()
  const result = cast(initial, [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 1], ['foe'], 'radiant', 'wave-selected')
  const saves = result.events.filter((event) => event.event_type === 'SpellSavingThrowResolved')
  const damage = result.events.filter((event) => event.event_type === 'DamageApplied')
  const castEvent = result.events.find((event) => event.event_type === 'SpellCast')
  assert.deepEqual(castEvent?.payload?.to, { x: 1, y: 1 })
  assert.equal(castEvent?.payload?.radius_feet, 30)
  assert.equal(castEvent?.payload?.area_shape, 'sphere')
  assert.deepEqual(castEvent?.target_ids, ['foe'])
  assert.equal(saves.length, 1)
  assert.equal(saves[0].payload.ability, 'con')
  assert.equal(saves[0].payload.saved, false)
  assert.deepEqual(damage.map((event) => [event.payload.damage_type, event.payload.raw_amount]), [['thunder', 15], ['radiant', 20]])
  assert.equal(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'prone' && event.target_ids.includes('foe')), true)
  assert.equal(result.events.some((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('ally')), false)
  assert.equal(result.events.some((event) => event.event_type === 'ConcentrationStarted'), false)
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent' && event.payload.resource === 'spell_slots_5').length, 1)
})

test('the caster may select themself because the source says chosen creatures', () => {
  const result = cast(field(), [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 1], ['caster'], 'radiant', 'wave-self')
  assert.deepEqual(result.events.find((event) => event.event_type === 'SpellCast')?.target_ids, ['caster'])
  assert.equal(result.events.filter((event) => event.event_type === 'SpellSavingThrowResolved').length, 1)
  assert.equal(result.events.filter((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('caster')).length, 2)
})

test('a dying player character remains a legal explicit damage target', () => {
  const initial = field({ ally: { hp: 0 } })
  const result = cast(initial, [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 1], ['ally'], 'radiant', 'wave-dying')
  assert.deepEqual(result.events.find((event) => event.event_type === 'SpellCast')?.target_ids, ['ally'])
  assert.equal(result.events.filter((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('ally')).length, 1)
  assert.equal(result.events.filter((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('ally')).length, 2)
})

test('successful save halves both components and does not knock the target prone', () => {
  const result = cast(field(), [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 20], ['foe'], 'necrotic', 'wave-save')
  assert.equal(result.events.find((event) => event.event_type === 'SpellSavingThrowResolved')?.payload.saved, true)
  assert.deepEqual(result.events.filter((event) => event.event_type === 'DamageApplied').map((event) => event.payload.raw_amount), [7, 10])
  assert.equal(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'prone'), false)
})

test('damage immunity and prone immunity are applied independently', () => {
  const result = cast(field({
    foe: { condition_immunities: ['prone'] },
    defenses: { foe: { immunities: ['thunder'] } },
  }), [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 1], ['foe'], 'radiant', 'wave-immunity')
  const damage = result.events.filter((event) => event.event_type === 'DamageApplied')
  assert.deepEqual(damage.map((event) => [event.payload.damage_type, event.payload.applied_amount]), [['thunder', 0], ['radiant', 20]])
  assert.equal(result.events.some((event) => event.event_type === 'ConditionImmunityResolved' && event.payload.condition === 'prone'), true)
  assert.equal(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'prone'), false)
})

test('mixed damage kills once, and replay keeps the same zero-hit consequence', () => {
  const initial = field({ foeHp: 25 })
  const result = cast(initial, [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 1], ['foe'], 'radiant', 'wave-lethal')
  const zero = result.events.filter((event) => event.event_type === 'HitPointsReducedToZero')
  assert.equal(zero.length, 1)
  const final = replayEvents(initial, result.events)
  assert.equal(final.enemies.find((enemy) => enemy.id === 'foe').hp, 0)
  assert.deepEqual(replayEvents(initial, result.events), final)
})

test('one Absorb Elements reaction window covers the mixed spell once', () => {
  const initial = field({
    ally: { knownSpellIds: ['absorb-elements'], preparedSpellIds: ['absorb-elements'] },
  })
  const first = cast(initial, [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 1], ['ally'], 'radiant', 'wave-reaction')
  const waiting = applyAll(initial, first.events)
  assert.equal(waiting.mechanics.combat.reaction_window?.trigger, 'spell-area-damage')
  assert.ok(waiting.mechanics.combat.reaction_window.action_ids.includes('cast:absorb-elements'))
  const declined = resolveCommand({
    command_type: 'UseCombatAction', command_id: 'wave-reaction-decline', actor_id: 'ally',
    action_id: 'decline-reaction', server_authoritative: true,
  }, waiting, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const final = applyAll(waiting, declined.events)
  assert.equal(declined.events.filter((event) => event.event_type === 'ReactionWindowOpened').length, 0)
  assert.equal(declined.events.filter((event) => event.event_type === 'DamageApplied').length, 2)
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.equal(final.mechanics.combat.action_economy.ally.reaction, true)
})

test('invalid selected targets are rejected before the spell slot is spent', () => {
  const initial = field()
  assert.throws(() => cast(initial, [], ['missing'], 'radiant', 'wave-missing'), /не найдена/iu)
  assert.equal(initial.mechanics.resources.caster.spell_slots_5.current, 1)
  assert.throws(() => cast(initial, [], ['foe', 'foe'], 'radiant', 'wave-duplicate'), /каждую цель/iu)
  assert.equal(initial.mechanics.resources.caster.spell_slots_5.current, 1)
  initial.enemies.push({ id: 'far', name: 'Дальняя цель', creature_type: 'humanoid', hp: 100, maxHp: 100, armor: 13, speed: 30, abilities: { str: 12, dex: 10, con: 10, int: 10, wis: 8, cha: 8 }, x: 8, y: 1, alive: true })
  assert.throws(() => cast(initial, [], ['far'], 'radiant', 'wave-outside'), /вне области/iu)
  assert.equal(initial.mechanics.resources.caster.spell_slots_5.current, 1)
})

test('supported NPC path preserves mixed typed damage and per-type resistance', () => {
  const result = cast(npcField(), [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 1], ['villager'], 'radiant', 'wave-npc')
  const harm = result.events.find((event) => event.event_type === 'NpcHarmed')
  assert.ok(harm)
  assert.equal(harm.payload.damage_type, 'mixed')
  assert.equal(harm.payload.applied_amount, 27)
  assert.deepEqual(harm.payload.damage_components.map(({ damage_type, raw_amount, applied_amount }) => ({ damage_type, raw_amount, applied_amount })), [
    { damage_type: 'thunder', raw_amount: 15, applied_amount: 7 },
    { damage_type: 'radiant', raw_amount: 20, applied_amount: 20 },
  ])
})

test('NPC mixed damage consumes temporary hit points once across both components', () => {
  const initial = npcField()
  initial.mechanics.temporary_hp.villager = 10
  const result = cast(initial, [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 1], ['villager'], 'radiant', 'wave-npc-temp')
  const harm = result.events.find((event) => event.event_type === 'NpcHarmed')
  assert.ok(harm)
  assert.deepEqual(harm.payload.damage_components.map(({ damage_type, raw_amount, applied_amount }) => ({ damage_type, raw_amount, applied_amount })), [
    { damage_type: 'thunder', raw_amount: 15, applied_amount: 0 },
    { damage_type: 'radiant', raw_amount: 20, applied_amount: 17 },
  ])
  assert.equal(harm.payload.applied_amount, 17)
})

test('провал спасброска NPC оставляет его ничком до явного подъёма', () => {
  const initial = npcField()
  const result = cast(initial, [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 1], ['villager'], 'radiant', 'wave-npc-prone')
  const condition = result.events.find((event) => event.event_type === 'ConditionAdded'
    && event.payload.condition === 'prone' && event.target_ids.includes('villager'))
  assert.ok(condition)
  assert.equal(condition.payload.duration, 'until-removed')
  assert.equal(replayEvents(initial, result.events).mechanics.conditions.villager.some((entry) => entry.id === 'prone'), true)
})

test('успех спасброска и иммунитет NPC не позволяют сбить его с ног', () => {
  const saved = cast(npcField(), [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 20], ['villager'], 'radiant', 'wave-npc-saved')
  const addsProne = (result) => result.events.some((event) => event.event_type === 'ConditionAdded'
    && event.payload.condition === 'prone' && event.target_ids.includes('villager'))
  assert.equal(addsProne(saved), false)
  const immuneState = npcField()
  const profile = structuredClone(getWorldTemplate('astohan-plains').opening.npcs[0].mechanics)
  profile.condition_immunities = ['prone']
  immuneState.npc_world.profiles.villager = profile
  immuneState.npc_world.vitals.villager = { hp: profile.hp, max_hp: profile.hp, alive: true }
  assert.equal(addsProne(cast(immuneState, [1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 1], ['villager'], 'radiant', 'wave-npc-immune')), false)
})
