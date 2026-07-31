import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { ITEM_CATALOG, itemViewerCapabilities, materializeCatalogItem } from '../server/item-catalog.mjs'
import {
  activeItemEffectTotals,
  activeItemMechanicEffects,
  applyItemLifecycleEventToPlayers,
  validateItemLifecycleCommand,
  weaponDamageRidersForItem,
} from '../server/item-lifecycle.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'

const id = (value) => `srd_5_2_1:${value}`

function dice(values = []) {
  let sequence = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `magic-items-wave2-roll-${++sequence}`,
    now: () => '2026-07-31T12:00:00.000Z',
  })
}

function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

function combatState({ heroInventory = [], enemyInventory = [], combat = true, enemyArmor = 12 } = {}) {
  return normalizeCampaignState({
    sessionCode: 'MAGIC-ITEMS-WAVE2',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Испытатель',
      characterClass: 'fighter',
      level: 5,
      hp: 40,
      maxHp: 40,
      armor: 16,
      proficiency: 3,
      abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 10 },
      x: 0,
      y: 0,
      inventory: heroInventory,
    }],
    enemies: [{
      id: 'foe',
      name: 'Манекен',
      hp: 100,
      maxHp: 100,
      armor: enemyArmor,
      alive: true,
      abilities: { str: 12, dex: 12, con: 12, int: 8, wis: 10, cha: 8 },
      x: 1,
      y: 0,
      inventory: enemyInventory,
    }],
    scene: {
      turn: 1,
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
      ],
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, foe: { x: 1, y: 0 } },
      combat: combat ? {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'foe', total: 8 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      } : { active: false },
    },
  })
}

const heroContext = { allowedActorIds: ['hero'], serverAuthoritativeCombat: true }

function attack(state, itemId, values) {
  return resolveCommand({
    command_type: 'MakeAttack',
    command_id: `attack-${itemId}`,
    actor_id: 'hero',
    target_id: 'foe',
    item_id: itemId,
    server_authoritative: true,
  }, state, { diceService: dice(values), context: heroContext })
}

test('единый catalog содержит шесть новых закрытых от экономики magic-item профилей', () => {
  const expected = {
    'cloak-of-protection': [40_000, 0, 'cloak', true],
    'brooch-of-shielding': [40_000, 0, 'brooch', true],
    'adamantine-chain-mail': [47_500, 55, 'body', false],
    'weapon-of-warning-longsword': [41_500, 3, 'main_hand', true],
    'vicious-longsword': [401_500, 3, 'main_hand', false],
    'flame-tongue-longsword': [401_500, 3, 'main_hand', true],
  }
  assert.equal(Object.keys(ITEM_CATALOG).length, 107)
  for (const [key, [price, weight, slot, attunement]] of Object.entries(expected)) {
    const entry = ITEM_CATALOG[id(key)]
    assert.ok(entry, key)
    assert.equal(entry.price_cp, price, key)
    assert.equal(entry.weight, weight, key)
    assert.equal(entry.lifecycle.equip_slot, slot, key)
    assert.equal(entry.attunement.required, attunement, key)
    // Огненный язык — единственный из шести, кто закрыт и от случайной находки:
    // активация бонусным действием требует объяснения игроку, поэтому он
    // остаётся наградой за сюжет.
    assert.deepEqual(entry.availability, {
      shop: false,
      loot: false,
      magic_loot: key !== 'flame-tongue-longsword',
      crafting: false,
    }, key)
    assert.equal(entry.mechanics_status, 'partial', key)
    assert.ok(Object.isFrozen(entry), key)
    const instance = materializeCatalogItem(id(key), {
      id: `instance-${key}`,
      passive_effects: [{ schema_version: 1, effect_id: 'forged', group: 'forged', armor_class_bonus: 99 }],
    })
    assert.deepEqual(instance.passive_effects, entry.passive_effects, `${key}: forged effect ignored`)
  }
  const flame = materializeCatalogItem(id('flame-tongue-longsword'), { id: 'flame', activated: true })
  assert.equal(flame.activated, true)
  assert.deepEqual(itemViewerCapabilities(flame).activation, {
    schema_version: 1,
    action_type: 'bonus_action',
    requires_equipped: true,
    requires_attunement: true,
  })
})

test('Плащ защиты складывается с Кольцом защиты, но не с копией того же плаща', () => {
  const ring = { ...materializeCatalogItem(id('ring-of-protection'), { id: 'ring' }), equipped: true, attuned_to: 'hero' }
  const cloak = { ...materializeCatalogItem(id('cloak-of-protection'), { id: 'cloak' }), equipped: true, attuned_to: 'hero' }
  const duplicate = { ...materializeCatalogItem(id('cloak-of-protection'), { id: 'cloak-copy' }), equipped: true, attuned_to: 'hero' }
  const hero = combatState({ heroInventory: [ring, cloak, duplicate] }).players[0]
  assert.deepEqual(activeItemEffectTotals(hero), {
    armor_class_bonus: 2,
    saving_throw_bonus: 2,
    active_groups: [id('cloak-of-protection'), id('ring-of-protection')],
  })
  const save = resolveCommand({
    command_type: 'MakeSavingThrow', command_id: 'cloak-save', actor_id: 'hero', target_id: 'hero', ability: 'dex', difficulty: 30,
  }, combatState({ heroInventory: [ring, cloak, duplicate], combat: false }), { diceService: dice([10]), context: heroContext })
  const resolved = save.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(resolved.payload.item_saving_throw_bonus, 2)
  assert.equal(resolved.payload.total, 14)
})

test('Брошь даёт force resistance и перехватывает canonical Magic Missile до DamageApplied', () => {
  const brooch = { ...materializeCatalogItem(id('brooch-of-shielding'), { id: 'brooch' }), equipped: true, attuned_to: 'foe' }
  const wand = { ...materializeCatalogItem(id('wand-of-magic-missiles'), { id: 'wand', charges: { current: 7 } }), equipped: true }
  const state = combatState({ heroInventory: [wand], enemyInventory: [brooch] })

  const force = resolveCommand({
    command_type: 'ApplyDamage', command_id: 'force-damage', actor_id: 'hero', target_id: 'foe', amount: 9, damage_type: 'force',
  }, state, { diceService: dice(), context: { ...heroContext, isAdmin: true } })
  const forceDamage = force.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(forceDamage.payload.raw_amount, 9)
  assert.equal(forceDamage.payload.applied_amount, 4)
  assert.equal(forceDamage.payload.resistant, true)
  assert.equal(forceDamage.payload.item_resistance_sources[0].catalog_id, id('brooch-of-shielding'))

  const missile = resolveCommand({
    command_type: 'UseItem',
    command_id: 'brooch-missile',
    actor_id: 'hero',
    target_id: 'foe',
    item_id: 'wand',
    charges_to_spend: 1,
    server_authoritative: true,
  }, state, { diceService: dice([3]), context: heroContext })
  const immunity = missile.events.find((event) => event.event_type === 'SpellImmunityResolved')
  assert.ok(immunity)
  assert.equal(immunity.event_schema_version, 1)
  assert.equal(immunity.payload.spell_id, 'magic-missile')
  assert.equal(immunity.payload.prevented_raw_amount, 12)
  assert.equal(immunity.payload.item_immunity_sources[0].item_id, 'brooch')
  assert.equal(missile.events.some((event) => event.event_type === 'DamageApplied'), false)
  assert.equal(missile.events.some((event) => event.event_type === 'HitPointsReducedToZero'), false)
  assert.equal(applyAll(state, missile.events).enemies[0].hp, 100)
  assert.deepEqual(replayEvents(state, missile.events), applyAll(state, missile.events))

  const unprotected = combatState({ heroInventory: [wand], enemyInventory: [{ ...brooch, equipped: false }] })
  const normal = resolveCommand({
    command_type: 'UseItem', command_id: 'normal-missile', actor_id: 'hero', target_id: 'foe', item_id: 'wand', charges_to_spend: 1, server_authoritative: true,
  }, unprotected, { diceService: dice([3]), context: heroContext })
  assert.ok(normal.events.some((event) => event.event_type === 'DamageApplied'))
  assert.equal(normal.events.some((event) => event.event_type === 'SpellImmunityResolved'), false)
})

test('надетая адамантиновая кольчуга отменяет critical до удвоения базовых и rider dice', () => {
  const sword = { ...materializeCatalogItem(id('vicious-longsword'), { id: 'vicious' }), equipped: true }
  const armor = { ...materializeCatalogItem(id('adamantine-chain-mail'), { id: 'adamantine' }), equipped: true }
  const protectedState = combatState({ heroInventory: [sword], enemyInventory: [armor] })
  const protectedHit = attack(protectedState, 'vicious', [20, 8, 6, 5])
  const protectedAttack = protectedHit.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(protectedAttack.payload.hit, true)
  assert.equal(protectedAttack.payload.critical, false)
  assert.equal(protectedAttack.payload.natural_critical, true)
  assert.equal(protectedAttack.payload.critical_prevented, true)
  assert.equal(protectedAttack.payload.critical_protection_sources[0].item_id, 'adamantine')
  const protectedRolls = protectedHit.events.filter((event) => event.event_type === 'DieRolled')
  assert.ok(protectedRolls.some((event) => event.payload.expression === '1d8+3'))
  assert.ok(protectedRolls.some((event) => event.payload.item_damage_rider && event.payload.expression === '2d6'))

  const exposedState = combatState({ heroInventory: [sword], enemyInventory: [{ ...armor, equipped: false }] })
  const criticalHit = attack(exposedState, 'vicious', [20, 8, 7, 6, 5, 4, 3])
  const criticalAttack = criticalHit.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(criticalAttack.payload.critical, true)
  const criticalRolls = criticalHit.events.filter((event) => event.event_type === 'DieRolled')
  assert.ok(criticalRolls.some((event) => event.payload.expression === '2d8+3'))
  assert.ok(criticalRolls.some((event) => event.payload.item_damage_rider && event.payload.expression === '4d6'))
})

test('Меч предупреждения бросает обе d20 инициативы и сохраняет server provenance', () => {
  const warning = { ...materializeCatalogItem(id('weapon-of-warning-longsword'), { id: 'warning' }), equipped: false, attuned_to: 'hero' }
  const state = combatState({ heroInventory: [warning], combat: false })
  const result = resolveCommand({
    command_type: 'StartCombat', command_id: 'warning-initiative', actor_id: 'hero', server_authoritative: true,
  }, state, { diceService: dice([3, 18, 10]), context: heroContext })
  const started = result.events.find((event) => event.event_type === 'CombatStarted')
  const hero = started.payload.initiative.find((entry) => entry.actor_id === 'hero')
  assert.deepEqual(hero.dice, [3, 18])
  assert.equal(hero.roll, 18)
  assert.equal(hero.total, 20)
  assert.equal(hero.mode, 'advantage')
  assert.equal(hero.advantage_sources[0].catalog_id, id('weapon-of-warning-longsword'))
  assert.deepEqual(replayEvents(state, result.events), applyAll(state, result.events))

  const dormant = combatState({ heroInventory: [{ ...warning, attuned_to: null }], combat: false })
  const normal = resolveCommand({ command_type: 'StartCombat', command_id: 'normal-initiative', actor_id: 'hero', server_authoritative: true }, dormant, { diceService: dice([3, 10]), context: heroContext })
  const normalHero = normal.events.find((event) => event.event_type === 'CombatStarted').payload.initiative.find((entry) => entry.actor_id === 'hero')
  assert.deepEqual(normalHero.dice, [3])
  assert.equal(normalHero.mode, undefined)
})

test('Vicious rider срабатывает на каждом попадании и дублированный stamp-group не умножает урон', () => {
  const base = materializeCatalogItem(id('vicious-longsword'), { id: 'vicious' })
  const vicious = {
    ...base,
    equipped: true,
    passive_effects: [...base.passive_effects, structuredClone(base.passive_effects[0])],
  }
  assert.equal(weaponDamageRidersForItem({ id: 'hero', inventory: [vicious] }, 'vicious').length, 1)
  const state = combatState({ heroInventory: [vicious] })
  const hit = attack(state, 'vicious', [15, 5, 6, 4])
  const riderRolls = hit.events.filter((event) => event.event_type === 'DieRolled' && event.payload.item_damage_rider)
  const riderDamage = hit.events.filter((event) => event.event_type === 'DamageApplied' && event.payload.item_damage_rider)
  assert.equal(riderRolls.length, 1)
  assert.equal(riderRolls[0].payload.expression, '2d6')
  assert.equal(riderDamage.length, 1)
  assert.equal(riderDamage[0].payload.damage_type, 'slashing')
  assert.equal(riderDamage[0].payload.raw_amount, 10)
  assert.equal(riderDamage[0].payload.catalog_id, id('vicious-longsword'))
  assert.deepEqual(replayEvents(state, hit.events), applyAll(state, hit.events))

  const missed = attack(state, 'vicious', [2])
  assert.equal(missed.events.some((event) => event.payload?.item_damage_rider), false)
})

test('Flame Tongue activation is versioned, spends the combat Bonus Action and gates fire rider', () => {
  const flame = { ...materializeCatalogItem(id('flame-tongue-longsword'), { id: 'flame' }), equipped: true, attuned_to: 'hero' }
  const initial = combatState({ heroInventory: [flame] })
  const activationCommand = {
    command_type: 'ActivateItem', command_id: 'ignite-flame', actor_id: 'hero', item_id: 'flame', activated: true, request_fingerprint: 'ignite-fingerprint', server_authoritative: true,
  }
  const activated = resolveCommand(activationCommand, initial, { diceService: dice(), context: heroContext })
  assert.equal(activated.events.length, 1)
  const event = activated.events[0]
  assert.equal(event.event_type, 'MagicItemActivationChanged')
  assert.equal(event.event_schema_version, 1)
  assert.deepEqual(event.payload, {
    schema_version: 1,
    owner_id: 'hero',
    item_id: 'flame',
    activation_id: 'srd_5_2_1:flame-tongue-longsword:flame',
    activated_before: false,
    activated: true,
    combat_action: 'bonus_action',
    request_fingerprint: 'ignite-fingerprint',
  })
  const afterActivation = applyAll(initial, activated.events)
  assert.equal(afterActivation.players[0].inventory[0].activated, true)
  assert.equal(afterActivation.mechanics.combat.action_economy.hero.bonus_action, false)
  assert.deepEqual(replayEvents(initial, activated.events), afterActivation)

  const strike = attack(afterActivation, 'flame', [15, 5, 6, 4])
  const fireRoll = strike.events.find((candidate) => candidate.event_type === 'DieRolled' && candidate.payload.item_damage_rider)
  const fireDamage = strike.events.find((candidate) => candidate.event_type === 'DamageApplied' && candidate.payload.item_damage_rider)
  assert.equal(fireRoll.payload.expression, '2d6')
  assert.equal(fireDamage.payload.damage_type, 'fire')
  assert.equal(fireDamage.payload.raw_amount, 10)

  assert.throws(() => resolveCommand({ ...activationCommand, command_id: 'repeat-ignite' }, afterActivation, { diceService: dice(), context: heroContext }), (error) => error instanceof RulesValidationError && error.code === 'ITEM_ACTIVATION_UNCHANGED')
  assert.throws(() => resolveCommand({ ...activationCommand, command_id: 'extinguish-same-turn', activated: false }, afterActivation, { diceService: dice(), context: heroContext }), (error) => error instanceof RulesValidationError && error.code === 'BONUS_ACTION_SPENT')

  const peaceful = combatState({ heroInventory: [{ ...flame, activated: true }], combat: false })
  const extinguished = resolveCommand({ ...activationCommand, command_id: 'extinguish-peacefully', activated: false }, peaceful, { diceService: dice(), context: heroContext })
  assert.equal(applyAll(peaceful, extinguished.events).players[0].inventory[0].activated, false)

  const ordinary = { ...materializeCatalogItem(id('longsword'), { id: 'ordinary' }), equipped: false }
  const replaced = combatState({ heroInventory: [{ ...flame, activated: true }, ordinary], combat: false })
  const replacement = resolveCommand({
    command_type: 'EquipItem', command_id: 'replace-burning-flame', actor_id: 'hero', item_id: 'ordinary', equipped: true,
  }, replaced, { diceService: dice(), context: heroContext })
  const afterReplacement = applyAll(replaced, replacement.events)
  assert.equal(afterReplacement.players[0].inventory.find((item) => item.id === 'flame').equipped, false)
  assert.equal(afterReplacement.players[0].inventory.find((item) => item.id === 'flame').activated, false)

  const inactiveStrike = attack(initial, 'flame', [15, 5])
  assert.equal(inactiveStrike.events.some((candidate) => candidate.payload?.item_damage_rider), false)
})

test('activation permission, equip, attunement, unknown fields and payload-only reducer fail closed', () => {
  const flame = materializeCatalogItem(id('flame-tongue-longsword'), { id: 'flame' })
  const initial = combatState({ heroInventory: [flame], combat: false })
  const command = { command_type: 'ActivateItem', actor_id: 'hero', item_id: 'flame', activated: true }
  assert.throws(() => validateItemLifecycleCommand(command, initial, { allowedActorIds: ['other'] }), (error) => error.code === 'ACTOR_FORBIDDEN')
  assert.throws(() => validateItemLifecycleCommand(command, initial, { allowedActorIds: ['hero'] }), (error) => error.code === 'ITEM_NOT_EQUIPPED')
  const equipped = combatState({ heroInventory: [{ ...flame, equipped: true }], combat: false })
  assert.throws(() => validateItemLifecycleCommand(command, equipped, { allowedActorIds: ['hero'] }), (error) => error.code === 'ITEM_NOT_ATTUNED')
  const ready = combatState({ heroInventory: [{ ...flame, equipped: true, attuned_to: 'hero' }], combat: false })
  assert.throws(() => validateItemLifecycleCommand({ ...command, passive_effects: [{ damage: '999d999' }] }, ready, { allowedActorIds: ['hero'] }), (error) => error.code === 'ITEM_COMMAND_UNKNOWN_FIELD')
  assert.equal(activeItemMechanicEffects({ id: 'hero', inventory: [{ id: 'forged', catalog_id: 'unknown:item', quantity: 1, equipped: true, passive_effects: [{ schema_version: 1, effect_id: 'forged', group: 'forged', damage_resistances: ['force'] }] }] }).length, 0)

  const forgedKnownCatalog = {
    id: 'forged-known',
    catalog_id: id('longsword'),
    type: 'weapon',
    quantity: 1,
    equipped: true,
    passive_effects: [{
      schema_version: 1,
      effect_id: 'forged-known-effect',
      group: 'forged-known-group',
      requires_equipped: true,
      armor_class_bonus: 99,
      damage_resistances: ['force'],
      weapon_damage_rider: { expression: '20d12', damage_type: 'force', critical_doubles: true },
    }],
  }
  assert.equal(activeItemMechanicEffects({ id: 'hero', inventory: [forgedKnownCatalog] }).length, 0)

  const alteredCanonical = materializeCatalogItem(id('cloak-of-protection'), { id: 'altered-cloak' })
  alteredCanonical.equipped = true
  alteredCanonical.attuned_to = 'hero'
  alteredCanonical.passive_effects[0].armor_class_bonus = 99
  alteredCanonical.passive_effects[0].damage_resistances = ['force']
  assert.equal(activeItemMechanicEffects({ id: 'hero', inventory: [alteredCanonical] }).length, 0)

  const replayOnly = applyItemLifecycleEventToPlayers([{ id: 'hero', inventory: [{ id: 'flame', catalog_id: 'catalog-that-no-longer-exists', activated: false }] }], {
    event_type: 'MagicItemActivationChanged',
    event_schema_version: 1,
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: { schema_version: 1, owner_id: 'hero', item_id: 'flame', activated: true },
  })
  assert.equal(replayOnly[0].inventory[0].activated, true)
})

test('nonlethal melee choice caps the whole magic-item damage packet at 1 HP', () => {
  const sword = { ...materializeCatalogItem(id('vicious-longsword'), { id: 'vicious' }), equipped: true }
  for (const [enemyHp, commandId] of [[8, 'rider-finishes'], [3, 'base-finishes']]) {
    const initial = combatState({ heroInventory: [sword] })
    initial.enemies[0].hp = enemyHp
    initial.enemies[0].maxHp = enemyHp
    const result = resolveCommand({
      command_type: 'MakeAttack',
      command_id: commandId,
      actor_id: 'hero',
      target_id: 'foe',
      item_id: 'vicious',
      knock_out: true,
      server_authoritative: true,
    }, initial, { diceService: dice([15, 3, 2, 2]), context: heroContext })
    const after = applyAll(initial, result.events)
    assert.equal(after.enemies[0].hp, 1, commandId)
    assert.equal(result.events.filter((event) => event.event_type === 'CreatureKnockedOut').length, 1, commandId)
    assert.equal(result.events.some((event) => event.event_type === 'HitPointsReducedToZero'), false, commandId)
    assert.deepEqual(replayEvents(initial, result.events), after, commandId)
  }
})
