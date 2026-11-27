import assert from 'node:assert/strict'
import test from 'node:test'

import { combatActionsFor } from '../server/combat-actions.mjs'
import { deriveMaximumHitPoints, deriveSpeed, deriveCharacterSheet } from '../server/character-lifecycle.mjs'
import { speciesBenefitsFor } from '../server/character-creation-catalog.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand, shortestTacticalPath } from '../server/rules-engine.mjs'

const RULESET_ID = 'dnd_5e_2014'

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `species-roll-${++id}`,
    now: () => '2026-08-31T00:00:00.000Z',
  })
}

const abilities = { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 }
const cells = Array.from({ length: 49 }, (_, index) => ({ x: index % 7, y: Math.floor(index / 7), type: 'floor', revealed: true }))

function combatState(speciesBenefits, overrides = {}) {
  return normalizeCampaignState({
    ruleset_id: RULESET_ID,
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Герой', characterClass: 'fighter', level: 1,
      hp: 20, maxHp: 20, armor: 16, speed: 30, proficiency: 2, abilities,
      speciesBenefits, inventory: [], x: 1, y: 3,
    }],
    enemies: [{ id: 'enemy', name: 'Цель', hp: 30, maxHp: 30, armor: 12, speed: 30, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, x: 3, y: 3, alive: true }],
    scene: { cells, turn: 1 },
    mechanics: {
      resources: {},
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'enemy', total: 10 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
      ...overrides,
    },
  })
}

test('пассивные особенности вида участвуют в ОЗ, скорости, навыках и сопротивлении', () => {
  const dwarf = speciesBenefitsFor('dwarf-hill', RULESET_ID, { 'artisan-tool': ['smiths_tools'] })
  const actor = {
    id: 'dwarf', characterClass: 'fighter', level: 3, abilities,
    hitPointIncreases: [6, 6], baseSpeed: 25, speciesBenefits: dwarf,
    speciesSkillProficiencies: dwarf.skill_proficiencies, classSkillProficiencies: ['athletics', 'perception'],
    inventory: [{ ...materializeCatalogItem('srd_5_2_1:chain-mail', { id: 'armor' }), equipped: true }],
  }
  assert.equal(deriveMaximumHitPoints(actor).value, 31, '10+CON+1, затем дважды 6+CON+1')
  assert.equal(deriveSpeed(actor).value, 25, 'тяжёлый доспех не снижает скорость дварфа')

  const halfOrc = speciesBenefitsFor('half-orc', RULESET_ID, {})
  const sheet = deriveCharacterSheet({ ...actor, speciesBenefits: halfOrc, speciesSkillProficiencies: halfOrc.skill_proficiencies })
  assert.equal(sheet.skills.intimidation.proficient, true)

  const tiefling = speciesBenefitsFor('tiefling', RULESET_ID, {})
  const state = combatState(tiefling)
  const result = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'hero', amount: 9, damage_type: 'fire' }, state, { diceService: dice([]) })
  assert.equal(result.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 4)
})

test('Везение полурослика перебрасывает натуральную 1 в основной d20-проверке', () => {
  const halfling = speciesBenefitsFor('halfling-lightfoot', RULESET_ID, {})
  const state = combatState(halfling)
  const result = resolveCommand({ command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'wis', difficulty: 12 }, state, { diceService: dice([1, 15]) })
  const roll = result.events.find((event) => event.event_type === 'AbilityCheckResolved').payload
  assert.equal(roll.halfling_luck, true)
  assert.equal(roll.kept, 15)
  assert.equal(roll.halfling_luck_original_natural, 1)

  const disadvantaged = resolveCommand({ command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'wis', difficulty: 12, disadvantage: true }, state, { diceService: dice([1, 18, 12]) })
  const disadvantagedRoll = disadvantaged.events.find((event) => event.event_type === 'AbilityCheckResolved').payload
  assert.deepEqual(disadvantagedRoll.dice, [12, 18])
  assert.equal(disadvantagedRoll.kept, 12, 'перебрасывается одна единица, а не вся пара помехи')
})

test('Храбрость полурослика даёт преимущество против магического испуга', () => {
  const halfling = speciesBenefitsFor('halfling-lightfoot', RULESET_ID, {})
  const state = combatState(halfling)
  Object.assign(state.enemies[0], {
    characterClass: 'wizard', level: 1, proficiency: 2,
    abilities: { str: 8, dex: 10, con: 10, int: 16, wis: 10, cha: 10 },
    knownSpellIds: ['cause-fear'], preparedSpellIds: ['cause-fear'],
  })
  state.mechanics.combat.active_index = 1
  state.mechanics.resources.enemy = { spell_slots_1: { current: 1, max: 1 } }
  const result = resolveCommand({
    command_type: 'CastSpell', command_id: 'species-bravery', actor_id: 'enemy', target_id: 'hero',
    spell_id: 'cause-fear', server_authoritative: true,
  }, state, { diceService: dice([3, 16]), context: { isNpcScheduler: true, serverAuthoritativeCombat: true } })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved')?.payload
    ?? result.events.find((event) => event.event_type === 'SavingThrowResolved')?.payload
  assert.equal(save.mode, 'advantage')
  assert.equal(save.species_save_advantage, 'frightened')
})

test('Непоколебимая стойкость срабатывает один раз до продолжительного отдыха', () => {
  const halfOrc = speciesBenefitsFor('half-orc', RULESET_ID, {})
  const state = combatState(halfOrc)
  const first = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'hero', amount: 30, damage_type: 'slashing' }, state, { diceService: dice([]) })
  const damage = first.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.hp_after, 1)
  assert.equal(damage.payload.relentless_endurance_triggered, true)
  const after = first.events.reduce(applyGameEvent, state)
  assert.ok(after.mechanics.conditions.hero.some((condition) => condition.id === 'species-trait-used:relentless-endurance'))
  const second = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'hero', amount: 2, damage_type: 'slashing' }, after, { diceService: dice([]) })
  assert.equal(second.events.find((event) => event.event_type === 'DamageApplied').payload.hp_after, 0)
})

test('Свирепые атаки добавляют одну кость оружия к рукопашному криту', () => {
  const halfOrc = speciesBenefitsFor('half-orc', RULESET_ID, {})
  const state = combatState(halfOrc)
  state.mechanics.positions.enemy = { x: 2, y: 3 }
  state.players[0].inventory = [{ ...materializeCatalogItem('srd_5_2_1:longsword', { id: 'sword' }), equipped: true }]
  const result = resolveCommand({
    command_type: 'MakeAttack', command_id: 'savage-critical', actor_id: 'hero', target_id: 'enemy',
    item_id: 'sword', server_authoritative: true,
  }, state, { diceService: dice([20, 3, 4, 5]), context: { serverAuthoritativeCombat: true } })
  const damage = result.events.find((event) => event.event_type === 'DamageApplied').payload
  assert.equal(damage.savage_attacks, true)
  assert.equal(damage.savage_attacks_damage, 5)
  assert.ok(result.events.some((event) => event.event_type === 'DieRolled' && event.payload.species_trait === 'savage-attacks'))
})

test('оружие дыхания использует выбранное наследие, область, спасбросок и ресурс', () => {
  const dragonborn = speciesBenefitsFor('dragonborn', RULESET_ID, { 'dragon-ancestry': ['red'] })
  const state = combatState(dragonborn, {
    resources: { hero: { species_breath_weapon: { current: 1, max: 1 } } },
  })
  state.enemies.push({ id: 'enemy-two', name: 'Вторая цель', hp: 30, maxHp: 30, armor: 12, abilities: { dex: 10 }, x: 3, y: 2, alive: true })
  assert.ok(combatActionsFor(state.players[0]).some((action) => action.id === 'breath-weapon'))
  const result = resolveCommand({
    command_type: 'UseCombatAction', command_id: 'dragon-breath', actor_id: 'hero', target_id: 'enemy',
    action_id: 'breath-weapon', server_authoritative: true,
  }, state, { diceService: dice([3, 4, 8, 15]), context: { serverAuthoritativeCombat: true } })
  const used = result.events.find((event) => event.event_type === 'SpeciesBreathUsed')
  assert.equal(used.payload.damage_type, 'fire')
  assert.equal(used.payload.shape, 'cone')
  assert.ok(used.payload.target_ids.includes('enemy'))
  assert.ok(result.events.some((event) => event.event_type === 'ResourceSpent' && event.payload.resource === 'species_breath_weapon'))
})

test('оружие дыхания выбирает тип спасброска по наследию драконорождённого', () => {
  const conAncestries = ['green', 'silver', 'white']
  const dexAncestries = ['black', 'blue', 'brass', 'bronze', 'copper', 'gold', 'red']
  for (const ancestry of conAncestries) {
    assert.equal(
      speciesBenefitsFor('dragonborn', RULESET_ID, { 'dragon-ancestry': [ancestry] })
        .mechanics.dragon_ancestry.save_ability,
      'con',
      `${ancestry}: дыхание должно требовать спасбросок Телосложения`,
    )
  }
  for (const ancestry of dexAncestries) {
    assert.equal(
      speciesBenefitsFor('dragonborn', RULESET_ID, { 'dragon-ancestry': [ancestry] })
        .mechanics.dragon_ancestry.save_ability,
      'dex',
      `${ancestry}: дыхание должно требовать спасбросок Ловкости`,
    )
  }
})

test('Проворство полурослика позволяет пройти сквозь большую цель, но не остановиться в ней', () => {
  const halfling = speciesBenefitsFor('halfling-lightfoot', RULESET_ID, {})
  const state = combatState(halfling)
  state.players[0].size = 'small'
  state.enemies[0].size = 'medium'
  state.enemies[0].x = 2
  state.enemies[0].y = 3
  state.mechanics.positions.enemy = { x: 2, y: 3 }
  const path = shortestTacticalPath(state, 'hero', { x: 3, y: 3 })
  assert.deepEqual(path, [{ x: 2, y: 3 }, { x: 3, y: 3 }])
  assert.equal(shortestTacticalPath(state, 'hero', { x: 2, y: 3 }), null)
})

test('эльфийский Транс завершает продолжительный отдых за четыре часа', () => {
  const elf = speciesBenefitsFor('elf-wood', RULESET_ID, {})
  const state = combatState(elf)
  state.mechanics.combat.active = false
  const start = resolveCommand({ command_type: 'StartRest', command_id: 'elf-rest-start', actor_id: 'hero', kind: 'long' }, state, { diceService: dice([]) })
  const startEvent = start.events.find((event) => event.event_type === 'RestStarted')
  assert.equal(startEvent.payload.minimum_duration_minutes, 240)
  let resting = start.events.reduce(applyGameEvent, state)
  const time = resolveCommand({ command_type: 'AdvanceTime', command_id: 'elf-rest-time', actor_id: 'hero', amount: 240, unit: 'minute' }, resting, { diceService: dice([]) })
  resting = time.events.reduce(applyGameEvent, resting)
  const complete = resolveCommand({ command_type: 'CompleteRest', command_id: 'elf-rest-complete', actor_id: 'hero', kind: 'long', rest_id: startEvent.payload.rest_id }, resting, { diceService: dice([]) })
  assert.ok(complete.events.some((event) => event.event_type === 'RestCompleted'))
})
