import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { combatSpellFor } from '../server/combat-spells.mjs'
import { enemyLoadoutFor } from '../server/enemy-loadouts.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { enemyFrom2014 } from '../server/combat-lab-monsters.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
  weaponAttackProfileFor,
} from '../server/rules-engine.mjs'

const MONSTERS_2014 = JSON.parse(readFileSync(new URL('../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters

const CELLS = Array.from({ length: 12 }, (_, index) => ({
  x: index,
  y: 0,
  type: 'floor',
  revealed: true,
}))

function dice(values = []) {
  let sequence = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `shillelagh-wave10-${++sequence}`,
    now: () => '2026-09-24T12:00:00.000Z',
  })
}

function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

function weapon(catalogId, id, equipped = false) {
  return materializeCatalogItem(catalogId, { id, quantity: 1, equipped })
}

function field({
  characterClass = 'druid',
  knownSpellIds = ['shillelagh'],
  preparedSpellIds = [],
  creationSpellGrants = undefined,
  clubEquipped = true,
  includeStaff = true,
  worldSecondRemainder = 0,
} = {}) {
  return normalizeCampaignState({
    sessionCode: 'WAVE10-SHILLELAGH-07',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    partyMemberIds: ['caster', 'ally'],
    players: [
      {
        id: 'caster',
        character: 'Мира',
        characterClass,
        level: 5,
        hp: 24,
        maxHp: 24,
        armor: 14,
        proficiency: 3,
        abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 18, cha: 10 },
        ...(knownSpellIds ? { knownSpellIds } : {}),
        ...(preparedSpellIds ? { preparedSpellIds } : {}),
        ...(creationSpellGrants ? { creationSpellGrants } : {}),
        inventory: [
          weapon('srd_5_2_1:club', 'club-instance', clubEquipped),
          ...(includeStaff ? [weapon('srd_5_2_1:quarterstaff', 'staff-instance', false)] : []),
          materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'component-pouch' }),
        ],
        x: 0,
        y: 0,
      },
      {
        id: 'ally',
        character: 'Союзник',
        characterClass: 'fighter',
        level: 5,
        hp: 20,
        maxHp: 20,
        armor: 14,
        proficiency: 3,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        inventory: [],
        x: 1,
        y: 0,
      },
    ],
    enemies: [{
      id: 'foe',
      name: 'Враг',
      hp: 40,
      maxHp: 40,
      armor: 10,
      alive: true,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      x: 1,
      y: 0,
    }],
    scene: { turn: 1, cells: CELLS },
    mechanics: {
      world_time: { amount: 0, unit: 'minute', elapsed_minutes: 0, ...(worldSecondRemainder ? { second_remainder: worldSecondRemainder } : {}) },
      combat: {
        active: false,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'caster', total: 18 }, { actor_id: 'foe', total: 10 }],
        action_economy: {},
      },
    },
  })
}

const context = { allowedActorIds: ['caster'], serverAuthoritativeCombat: true }

function cast(state, commandId = 'cast-1', itemId = 'club-instance') {
  return resolveCommand({
    command_type: 'CastSpell',
    command_id: commandId,
    actor_id: 'caster',
    target_id: 'caster',
    target_ids: ['caster'],
    item_id: itemId,
    spell_id: 'shillelagh',
    server_authoritative: true,
  }, state, { diceService: dice(), context })
}

function combatState(state) {
  return {
    ...state,
    mechanics: {
      ...state.mechanics,
      combat: {
        ...state.mechanics.combat,
        active: true,
        active_index: 0,
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true },
        },
      },
    },
  }
}

test('ordinary druid cast binds one item instance, uses Wisdom/d8, marks magical weapon, and replays', () => {
  const initial = field()
  const spell = combatSpellFor(initial.players[0], 'shillelagh', { rulesetId: initial.ruleset_id })
  assert.equal(spell?.spellcastingAbility, 'wis')

  const firstCast = cast(initial)
  const castEvent = firstCast.events.find((event) => event.event_type === 'SpellCast')
  const added = firstCast.events.find((event) => event.event_type === 'ConditionAdded')
  assert.equal(castEvent.payload.action_type, 'bonus_action')
  assert.equal(castEvent.payload.item_instance_id, 'club-instance')
  assert.equal(castEvent.payload.spellcasting_ability, 'wis')
  assert.equal(castEvent.payload.magical_weapon, true)
  assert.equal(added.payload.source_item_id, 'club-instance')
  assert.equal(added.payload.duration, 'seconds:60')
  assert.equal(added.payload.started_at_seconds, 0)
  assert.equal(added.payload.expires_at_seconds, 60)
  assert.equal(added.payload.timing_version, 2)

  const enchanted = applyAll(initial, firstCast.events)
  const profile = weaponAttackProfileFor(enchanted, 'caster', 'club-instance')
  assert.equal(profile.ability, 'wis')
  assert.equal(profile.damage_expression, '1d8+4')
  assert.equal(profile.damage_type, 'bludgeoning')
  assert.equal(profile.magical, true)
  assert.ok(profile.properties.includes('magical'))

  const instanceState = field()
  instanceState.players[0].inventory[0].item_instance_id = 'club-instance-key'
  const instanceEnchanted = applyAll(instanceState, cast(instanceState, 'cast-instance-key').events)
  assert.equal(instanceEnchanted.mechanics.conditions.caster[0].source_item_id, 'club-instance-key')
  assert.equal(weaponAttackProfileFor(instanceEnchanted, 'caster', 'club-instance').ability, 'wis')

  const armed = combatState(enchanted)
  const attack = resolveCommand({
    command_type: 'MakeAttack',
    command_id: 'shillelagh-attack',
    actor_id: 'caster',
    target_id: 'foe',
    item_id: 'club-instance',
    server_authoritative: true,
  }, armed, { diceService: dice([18, 5]), context })
  const resolved = attack.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(resolved.payload.item_id, 'club-instance')
  assert.equal(resolved.payload.attack_ability, 'wis')
  assert.equal(resolved.payload.damage_expression, '1d8+4')
  assert.equal(resolved.payload.damage_type, 'bludgeoning')
  assert.equal(resolved.payload.magical, true)
  assert.ok(resolved.payload.weapon_properties.includes('magical'))
  assert.equal(attack.events.find((event) => event.event_type === 'DamageApplied')?.payload.magical, true)
  const strengthProfile = weaponAttackProfileFor(armed, 'caster', 'club-instance', { attackAbility: 'str' })
  assert.equal(strengthProfile.ability, 'str')
  assert.equal(strengthProfile.damage_expression, '1d8')
  assert.equal(weaponAttackProfileFor(armed, 'caster', 'club-instance', { attackAbility: 'cha' }), null)
  assert.deepEqual(replayEvents(armed, attack.events), applyAll(armed, attack.events))
})

test('magical Shillelagh bypasses conditional nonmagical weapon resistance and immunity', () => {
  const resistant = field()
  resistant.enemies[0].damage_resistances = [{ types: ['bludgeoning'], condition: 'nonmagical-attacks', qualifier: 'nonmagical' }]
  const ordinary = resolveCommand({
    command_type: 'MakeAttack', command_id: 'ordinary-resisted-club', actor_id: 'caster', target_id: 'foe',
    item_id: 'club-instance', server_authoritative: true,
  }, combatState(resistant), { diceService: dice([18, 4]), context })
  const ordinaryDamage = ordinary.events.find((event) => event.event_type === 'DamageApplied')?.payload
  assert.equal(ordinaryDamage.raw_amount, 4)
  assert.equal(ordinaryDamage.resistant, true)
  assert.equal(ordinaryDamage.applied_amount, 2)

  const enchanted = applyAll(resistant, cast(resistant, 'cast-magical-resistance').events)
  const magical = resolveCommand({
    command_type: 'MakeAttack', command_id: 'magical-bypasses-resistance', actor_id: 'caster', target_id: 'foe',
    item_id: 'club-instance', server_authoritative: true,
  }, combatState(enchanted), { diceService: dice([18, 8]), context })
  const magicalDamage = magical.events.find((event) => event.event_type === 'DamageApplied')?.payload
  assert.equal(magicalDamage.raw_amount, 12)
  assert.equal(magicalDamage.resistant, false)
  assert.equal(magicalDamage.applied_amount, 12)
  assert.equal(magicalDamage.magical, true)

  const immune = field()
  immune.enemies[0].damage_immunities = [{ types: ['bludgeoning'], condition: 'nonmagical-attacks' }]
  const ordinaryImmune = resolveCommand({
    command_type: 'MakeAttack', command_id: 'ordinary-immune-club', actor_id: 'caster', target_id: 'foe',
    item_id: 'club-instance', server_authoritative: true,
  }, combatState(immune), { diceService: dice([18, 4]), context })
  assert.equal(ordinaryImmune.events.find((event) => event.event_type === 'DamageApplied')?.payload.immune, true)
  const enchantedImmune = applyAll(immune, cast(immune, 'cast-magical-immunity').events)
  const magicalImmune = resolveCommand({
    command_type: 'MakeAttack', command_id: 'magical-bypasses-immunity', actor_id: 'caster', target_id: 'foe',
    item_id: 'club-instance', server_authoritative: true,
  }, combatState(enchantedImmune), { diceService: dice([18, 8]), context })
  const magicalImmuneDamage = magicalImmune.events.find((event) => event.event_type === 'DamageApplied')?.payload
  assert.equal(magicalImmuneDamage.immune, false)
  assert.equal(magicalImmuneDamage.applied_amount, 12)

  const existingMagical = field()
  existingMagical.enemies[0].damage_resistances = [{ types: ['bludgeoning'], condition: 'nonmagical-attacks' }]
  const catalogWeapon = weapon('srd_5_2_1:club', 'existing-magical-club', true)
  catalogWeapon.catalog_id = 'custom:existing-magical-club'
  catalogWeapon.combat = { ...catalogWeapon.combat, properties: [...(catalogWeapon.combat?.properties ?? []), 'magical'] }
  existingMagical.players[0].inventory = [catalogWeapon]
  const existingMagicalAttack = resolveCommand({
    command_type: 'MakeAttack', command_id: 'existing-magical-bypasses-resistance', actor_id: 'caster', target_id: 'foe',
    item_id: 'existing-magical-club', server_authoritative: true,
  }, combatState(existingMagical), { diceService: dice([18, 4]), context })
  const existingMagicalDamage = existingMagicalAttack.events.find((event) => event.event_type === 'DamageApplied')?.payload
  assert.equal(existingMagicalDamage.magical, true)
  assert.equal(existingMagicalDamage.resistant, false)
})

test('a real D&D 2014 stat block keeps its conditional defense through encounter normalization', () => {
  const source = MONSTERS_2014.find((candidate) => candidate.id.endsWith(':fire-elemental'))
  const normalizedEnemy = enemyFrom2014(source, { x: 1, y: 0 })
  assert.deepEqual(normalizedEnemy.damage_resistances, [{
    types: ['bludgeoning', 'piercing', 'slashing'],
    condition: 'nonmagical-attacks',
  }])

  const ordinaryState = field()
  ordinaryState.enemies[0] = { ...ordinaryState.enemies[0], ...normalizedEnemy, id: 'foe', x: 1, y: 0 }
  const ordinaryAttack = resolveCommand({
    command_type: 'MakeAttack', command_id: 'catalog-ordinary-club', actor_id: 'caster', target_id: 'foe',
    item_id: 'club-instance', server_authoritative: true,
  }, combatState(ordinaryState), { diceService: dice([18, 4]), context })
  const ordinaryDamage = ordinaryAttack.events.find((event) => event.event_type === 'DamageApplied')?.payload
  assert.equal(ordinaryDamage.resistant, true)
  assert.equal(ordinaryDamage.applied_amount, 2)

  const magicalState = applyAll(ordinaryState, cast(ordinaryState, 'catalog-shillelagh').events)
  const magicalAttack = resolveCommand({
    command_type: 'MakeAttack', command_id: 'catalog-magical-club', actor_id: 'caster', target_id: 'foe',
    item_id: 'club-instance', server_authoritative: true,
  }, combatState(magicalState), { diceService: dice([18, 8]), context })
  const magicalDamage = magicalAttack.events.find((event) => event.event_type === 'DamageApplied')?.payload
  assert.equal(magicalDamage.resistant, false)
  assert.equal(magicalDamage.magical, true)
  assert.equal(magicalDamage.applied_amount, 12)
})

test('the effect is bound to one instance: swap, release and transfer cannot carry it', () => {
  const initial = field()
  const enchanted = applyAll(initial, cast(initial).events)
  const equipStaff = resolveCommand({
    command_type: 'EquipItem',
    command_id: 'equip-staff-over-club',
    actor_id: 'caster',
    item_id: 'staff-instance',
    equipped: true,
  }, enchanted, { diceService: dice(), context })
  assert.ok(equipStaff.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.trigger === 'weapon-swapped'))
  const afterEquipStaff = applyAll(enchanted, equipStaff.events)
  assert.equal(afterEquipStaff.mechanics.conditions.caster?.some((condition) => condition.id === 'shillelagh'), false)

  const swapped = resolveCommand({
    command_type: 'ChangeWeapon',
    command_id: 'swap-to-staff',
    actor_id: 'caster',
    item_id: 'staff-instance',
    server_authoritative: true,
  }, combatState(enchanted), { diceService: dice(), context })
  const afterSwap = applyAll(combatState(enchanted), swapped.events)
  assert.equal(afterSwap.mechanics.conditions.caster?.some((condition) => condition.id === 'shillelagh'), false)

  const recastState = applyAll(initial, cast(initial, 'cast-before-release').events)
  const release = resolveCommand({
    command_type: 'EquipItem',
    command_id: 'release-club',
    actor_id: 'caster',
    item_id: 'club-instance',
    equipped: false,
  }, recastState, { diceService: dice(), context })
  assert.ok(release.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.trigger === 'weapon-released'))
  const afterRelease = applyAll(recastState, release.events)
  assert.equal(afterRelease.mechanics.conditions.caster?.some((condition) => condition.id === 'shillelagh'), false)

  const transferred = resolveCommand({
    command_type: 'TransferItem',
    command_id: 'transfer-club',
    actor_id: 'caster',
    recipient_id: 'ally',
    item_id: 'club-instance',
    quantity: 1,
  }, afterRelease, { diceService: dice(), context })
  const afterTransfer = applyAll(afterRelease, transferred.events)
  const incoming = afterTransfer.players.find((actor) => actor.id === 'ally').inventory[0]
  assert.ok(incoming)
  assert.equal(afterTransfer.mechanics.conditions.caster?.some((condition) => condition.id === 'shillelagh'), false)
  assert.equal(weaponAttackProfileFor(afterTransfer, 'ally', incoming.id).ability, 'str')
  assert.equal(weaponAttackProfileFor(afterTransfer, 'ally', incoming.id).damage_expression, '1d4+3')
})

test('recasting replaces the previous item effect and seconds expiry survives minute boundaries', () => {
  const initial = field({ worldSecondRemainder: 59 })
  const first = applyAll(initial, cast(initial, 'cast-refresh-1').events)
  const secondCast = cast(first, 'cast-refresh-2')
  assert.ok(secondCast.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.trigger === 'recast'))
  const refreshed = applyAll(first, secondCast.events)
  const conditions = refreshed.mechanics.conditions.caster.filter((condition) => condition.id === 'shillelagh')
  assert.equal(conditions.length, 1)
  assert.equal(conditions[0].effect_id, 'shillelagh:cast-refresh-2')
  assert.equal(conditions[0].duration, 'seconds:60')
  assert.equal(conditions[0].started_at_seconds, 59)
  assert.equal(conditions[0].expires_at_seconds, 119)

  const after118 = applyGameEvent(refreshed, {
    event_type: 'TimeAdvanced',
    actor_id: null,
    target_ids: [],
    payload: { clock_version: 2, elapsed_seconds: 59 },
  })
  assert.equal(after118.mechanics.world_time.second_remainder, 58)
  assert.equal(after118.mechanics.conditions.caster.some((condition) => condition.id === 'shillelagh'), true)
  const after119 = applyGameEvent(after118, {
    event_type: 'TimeAdvanced',
    actor_id: null,
    target_ids: [],
    payload: { clock_version: 2, elapsed_seconds: 1 },
  })
  assert.equal(after119.mechanics.world_time.elapsed_minutes, 1)
  assert.equal(after119.mechanics.world_time.second_remainder, 59)
  assert.equal(after119.mechanics.conditions.caster.some((condition) => condition.id === 'shillelagh'), false)
})

test('Magic Initiate druid grant supplies Wisdom to a non-druid caster; unavailable and unheld paths refuse', () => {
  const grants = [{ id: 'shillelagh', ability: 'wis', uses: 'at-will', source: 'magic-initiate', class_key: 'druid' }]
  const initiate = field({ characterClass: 'fighter', knownSpellIds: [], creationSpellGrants: grants })
  const spell = combatSpellFor(initiate.players[0], 'shillelagh', { rulesetId: initiate.ruleset_id })
  assert.equal(spell?.spellcastingAbility, 'wis')
  const castResult = cast(initiate, 'magic-initiate-cast')
  assert.equal(castResult.events.find((event) => event.event_type === 'ConditionAdded')?.payload.spellcasting_ability, 'wis')

  const unavailable = field({ characterClass: 'fighter', knownSpellIds: [] })
  assert.throws(
    () => cast(unavailable, 'unavailable-shillelagh'),
    (error) => error instanceof RulesValidationError && error.code === 'SPELL_NOT_AVAILABLE',
  )

  const unheld = field({ clubEquipped: false })
  assert.throws(
    () => cast(unheld, 'unheld-shillelagh'),
    (error) => error instanceof RulesValidationError && error.code === 'SHILLELAGH_WEAPON_NOT_HELD',
  )

  const wrongWeapon = field({ includeStaff: false })
  wrongWeapon.players[0].inventory = [
    weapon('srd_5_2_1:greatclub', 'greatclub-instance', true),
    materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'component-pouch' }),
  ]
  assert.throws(
    () => cast(wrongWeapon, 'wrong-shillelagh', 'greatclub-instance'),
    (error) => error instanceof RulesValidationError && error.code === 'SHILLELAGH_WEAPON_REQUIRED',
  )
})

test('conditional nonmagical defense covers unarmed, monk, and catalog-backed NPC attacks', () => {
  const unarmed = field()
  unarmed.players[0].inventory = []
  // Безоружный удар героя — дробящий урон (раньше движок по умолчанию писал рубящий).
  unarmed.enemies[0].damage_resistances = [{ types: ['bludgeoning'], condition: 'nonmagical-attacks' }]
  const unarmedAttack = resolveCommand({
    command_type: 'MakeAttack', command_id: 'unarmed-defense', actor_id: 'caster', target_id: 'foe', server_authoritative: true,
  }, combatState(unarmed), { diceService: dice([18]), context })
  assert.equal(unarmedAttack.events.find((event) => event.event_type === 'DamageApplied')?.payload.resistant, true)

  const monk = field({ characterClass: 'monk', knownSpellIds: [] })
  monk.players[0].inventory = []
  monk.players[0].abilities = { ...monk.players[0].abilities, str: 12, dex: 16 }
  monk.enemies[0].damage_resistances = [{ types: ['bludgeoning'], condition: 'nonmagical-attacks' }]
  const monkCombat = combatState(monk)
  monkCombat.mechanics.combat.action_economy.caster.attacks_used = 1
  const monkAttack = resolveCommand({
    command_type: 'UseCombatAction', command_id: 'monk-defense', actor_id: 'caster', target_id: 'foe',
    action_id: 'martial-arts-strike', server_authoritative: true,
  }, monkCombat, { diceService: dice([18, 4]), context })
  assert.equal(monkAttack.events.find((event) => event.event_type === 'DamageApplied')?.payload.resistant, true)

  const source = MONSTERS_2014.find((candidate) => candidate.id.endsWith(':hobgoblin'))
  let npc = field()
  npc.players[0].damage_resistances = [{ types: ['slashing'], condition: 'nonmagical-attacks' }]
  const foe = enemyFrom2014(source, { x: 1, y: 0 })
  foe.id = 'foe'
  foe.loadout = enemyLoadoutFor({ statBlockId: source.id, block: foe, ownerId: foe.id, seed: 'shillelagh-defense' })
  npc.enemies = [foe]
  npc.mechanics.combat.initiative = [{ actor_id: 'foe', total: 20 }, { actor_id: 'caster', total: 10 }]
  npc.mechanics.combat.active_index = 0
  npc = normalizeCampaignState(npc)
  const npcAttack = resolveCommand({
    command_type: 'MakeAttack', command_id: 'npc-defense', actor_id: 'foe', target_id: 'caster',
    action_id: 'longsword', server_authoritative: true,
  }, combatState(npc), { diceService: dice([18, 4]), context: { serverAuthoritativeCombat: true, isNpcScheduler: true } })
  const npcDamage = npcAttack.events.find((event) => event.event_type === 'DamageApplied')?.payload
  assert.equal(npcDamage.resistant, true)
  assert.ok(npcAttack.events.find((event) => event.event_type === 'AttackResolved')?.payload.weapon_properties.includes('versatile-1d10'))

  const magicalSource = MONSTERS_2014.find((candidate) => candidate.id.endsWith(':couatl'))
  let magicalNpc = field()
  magicalNpc.players[0].damage_resistances = [{ types: ['piercing'], condition: 'nonmagical-attacks' }]
  const magicalFoe = enemyFrom2014(magicalSource, { x: 1, y: 0 })
  magicalFoe.id = 'foe'
  magicalNpc.enemies = [magicalFoe]
  magicalNpc.mechanics.combat.initiative = [{ actor_id: 'foe', total: 20 }, { actor_id: 'caster', total: 10 }]
  magicalNpc.mechanics.combat.active_index = 0
  magicalNpc = normalizeCampaignState(magicalNpc)
  const magicalNpcAttack = resolveCommand({
    command_type: 'MakeAttack', command_id: 'npc-magical-trait', actor_id: 'foe', target_id: 'caster',
    action_id: 'bite', server_authoritative: true,
  }, combatState(magicalNpc), { diceService: dice([18, 4, 4, 4, 4, 4, 4]), context: { serverAuthoritativeCombat: true, isNpcScheduler: true } })
  const magicalNpcDamage = magicalNpcAttack.events.find((event) => event.event_type === 'DamageApplied')?.payload
  assert.equal(magicalNpcAttack.events.find((event) => event.event_type === 'AttackResolved')?.payload.magical, true)
  assert.equal(magicalNpcDamage.resistant, false)
})

test('magic-weapon condition makes the selected weapon magical for conditional defense', () => {
  const state = field()
  state.mechanics.conditions.caster = [{ id: 'magic-weapon' }]
  state.enemies[0].damage_resistances = [{ types: ['bludgeoning'], condition: 'nonmagical-attacks' }]
  const result = resolveCommand({
    command_type: 'MakeAttack', command_id: 'magic-weapon-defense', actor_id: 'caster', target_id: 'foe',
    item_id: 'club-instance', server_authoritative: true,
  }, combatState(state), { diceService: dice([18, 4]), context })
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')?.payload
  assert.equal(damage.magical, true)
  assert.equal(damage.resistant, false)
})

test('weapon cantrip primary damage keeps the weapon source for Booming Blade and Green-Flame Blade', () => {
  for (const [index, spellId] of ['booming-blade', 'green-flame-blade'].entries()) {
    const state = field({
      knownSpellIds: [],
      creationSpellGrants: [{ id: spellId, ability: 'wis', uses: 'at-will', source: 'magic-initiate', class_key: 'wizard' }],
    })
    state.enemies[0].damage_resistances = [{ types: ['bludgeoning'], condition: 'nonmagical-attacks' }]
    const result = resolveCommand({
      command_type: 'CastSpell', command_id: `weapon-cantrip-${index}`, actor_id: 'caster', target_id: 'foe',
      spell_id: spellId, server_authoritative: true,
    }, combatState(state), { diceService: dice([18, 4, 4, 4]), context })
    const attack = result.events.find((event) => event.event_type === 'AttackResolved')?.payload
    const damage = result.events.find((event) => event.event_type === 'DamageApplied' && event.payload.damage_type === 'bludgeoning')?.payload
    assert.equal(attack.magical, false)
    assert.ok(damage)
    assert.equal(damage.resistant, true)
    assert.equal(damage.applied_amount, Math.floor(damage.raw_amount / 2))
  }
})

test('HTTP and UI preserve the selected held Shillelagh instance', () => {
  const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
  const index = source('server/index.mjs')
  const session = source('src/useGameSession.ts')
  const map = source('src/DungeonMap.tsx')
  assert.match(index, /input\?\.item_id != null \|\| input\?\.itemId != null/u)
  assert.match(index, /item_id: String\(input\.item_id \?\? input\.itemId\)/u)
  assert.match(session, /itemId\?: string/u)
  assert.match(session, /target\.itemId \? \{ item_id: target\.itemId \}/u)
  assert.match(map, /selectedSpellItemId/u)
  assert.match(map, /selectedSpell\.id === 'shillelagh'/u)
  assert.match(map, /selectedSpellItemOption/u)
})
