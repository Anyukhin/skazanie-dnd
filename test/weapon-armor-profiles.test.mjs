import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { ITEM_CATALOG, materializeCatalogItem } from '../server/item-catalog.mjs'
import { RulesValidationError, normalizeCampaignState, replayEvents, resolveCommand, weaponAttackProfileFor } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `weapon-profile-${++id}`, now: () => '2026-08-09T12:00:00.000Z' })
}

function floor(width = 12, height = 4) {
  return Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true }))
}

function stateWith(inventory, { strength = 16, dexterity = 14, enemyX = 2 } = {}) {
  return normalizeCampaignState({
    sessionCode: 'WEAPON-PROFILE',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Герой', characterClass: 'fighter', level: 5,
      hp: 40, maxHp: 40, armor: 15, speed: 30, proficiency: 3,
      abilities: { str: strength, dex: dexterity, con: 14, int: 10, wis: 10, cha: 10 },
      inventory, x: 1, y: 1,
    }],
    enemies: [{ id: 'enemy', name: 'Манекен', hp: 80, maxHp: 80, armor: 12, speed: 30, abilities: { str: 10, dex: 10 }, x: enemyX, y: 1, alive: true }],
    scene: { turn: 1, cells: floor() },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'enemy', total: 5 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function weapon(catalogId, id = catalogId) {
  return { ...materializeCatalogItem(catalogId, { id }), equipped: true }
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (values) => ({ diceService: dice(values), context: { serverAuthoritativeCombat: true, isAdmin: true } })

test('каждое из 42 оружий каталога имеет server-authoritative профиль хотя бы одного режима', () => {
  const entries = Object.values(ITEM_CATALOG).filter((entry) => entry.type === 'weapon')
  assert.equal(entries.length, 42)
  for (const entry of entries) {
    assert.ok(entry.combat?.modes?.length, `${entry.catalog_id}: отсутствуют режимы`)
    const item = weapon(entry.catalog_id, `weapon:${entry.catalog_id}`)
    const state = stateWith([item])
    const profile = weaponAttackProfileFor(state, 'hero', item.id)
    assert.ok(profile, `${entry.catalog_id}: Rules Engine не принял оружие`)
    assert.match(profile.damage_expression, /^\d*d?\d+[+-]\d+$/u, `${entry.catalog_id}: куб урона не разобран`)
  }
})

test('все 14 доспехов несут серверные требования силы и помеху Скрытности', () => {
  const entries = Object.values(ITEM_CATALOG).filter((entry) => entry.type === 'armor')
  assert.equal(entries.length, 14)
  for (const entry of entries) {
    const profile = entry.equip?.armor
    assert.ok(profile, `${entry.catalog_id}: отсутствует armor profile`)
    if (profile.kind === 'shield') continue
    assert.equal(profile.strengthRequirement ?? null, entry.armor.strength ?? null, `${entry.catalog_id}: требование Силы потеряно`)
    assert.equal(profile.stealthDisadvantage, entry.armor.stealth_disadvantage, `${entry.catalog_id}: помеха Скрытности потеряна`)
  }
})

test('finesse, versatile, thrown и reach выбираются только из каталожного профиля', () => {
  const dagger = weapon('srd_5_2_1:dagger', 'dagger')
  const spear = weapon('srd_5_2_1:spear', 'spear')
  const glaive = weapon('srd_5_2_1:glaive', 'glaive')
  const state = stateWith([dagger, spear, glaive], { strength: 18, dexterity: 16, enemyX: 3 })

  const finesse = weaponAttackProfileFor(state, 'hero', dagger.id, { attackAbility: 'str' })
  assert.equal(finesse.ability, 'str')
  assert.equal(finesse.modifier, 7)
  const thrown = weaponAttackProfileFor(state, 'hero', dagger.id, { attackMode: 'thrown', attackAbility: 'dex' })
  assert.equal(thrown.kind, 'ranged')
  assert.equal(thrown.range_feet, 60)
  assert.equal(thrown.normal_range_feet, 20)
  const twoHanded = weaponAttackProfileFor(state, 'hero', spear.id, { attackMode: 'two-handed' })
  assert.match(twoHanded.damage_expression, /^1d8\+4$/u)
  const reach = weaponAttackProfileFor(state, 'hero', glaive.id)
  assert.equal(reach.normal_range_feet, 10)
  assert.equal(weaponAttackProfileFor(state, 'hero', glaive.id, { attackAbility: 'dex' }), null, 'клиент не выбирает Ловкость для не-finesse оружия')
})

test('метательная атака сохраняет mode/ability в событии и повторяется без расхождения', () => {
  const dagger = weapon('srd_5_2_1:dagger', 'dagger')
  const state = stateWith([dagger], { strength: 18, dexterity: 12, enemyX: 5 })
  const result = resolveCommand(authoritative({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'enemy', item_id: dagger.id,
    attack_mode: 'thrown', attack_ability: 'str', command_id: 'throw-dagger',
  }), state, options([10, 4]))
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.attack_mode, 'thrown')
  assert.equal(attack.payload.attack_ability, 'str')
  assert.equal(attack.payload.thrown, true)
  const replayed = replayEvents(state, result.events)
  assert.equal(replayed.enemies.find((enemy) => enemy.id === 'enemy').hp, 72)
  assert.equal(replayed.battleLog.at(-1).attackMode, 'thrown')
  assert.equal(replayed.battleLog.at(-1).attackAbility, 'str')
})

test('двуручный режим не обходит надетый щит', () => {
  const sword = weapon('srd_5_2_1:longsword', 'sword')
  const shield = { ...materializeCatalogItem('srd_5_2_1:shield', { id: 'shield' }), equipped: true }
  const state = stateWith([sword, shield])
  assert.throws(() => resolveCommand(authoritative({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'enemy', item_id: sword.id, attack_mode: 'two-handed',
  }), state, options([10, 4])), (error) => error instanceof RulesValidationError && error.code === 'TWO_HANDED_WITH_SHIELD')
})

test('атака по возможности игрока использует reach экипированного оружия, а не базовую атаку', () => {
  const glaive = weapon('srd_5_2_1:glaive', 'glaive')
  const state = stateWith([glaive], { enemyX: 3 })
  state.mechanics.combat.active_index = 1
  const moved = resolveCommand(authoritative({
    command_type: 'MoveActor', actor_id: 'enemy', to: { x: 4, y: 1 }, command_id: 'leave-glaive-reach',
  }), state, options())
  const afterMove = replayEvents(state, moved.events)
  assert.equal(afterMove.mechanics.combat.reaction_window?.actor_id, 'hero')
  const reaction = resolveCommand(authoritative({
    command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'opportunity-attack', command_id: 'glaive-reaction',
  }), afterMove, options([10, 4]))
  const attack = reaction.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.item_id, 'glaive')
  assert.equal(attack.payload.range_feet, 10)
})

test('тяжёлая броня серверно ограничивает скорость, а шумная броня даёт помеху Скрытности', () => {
  const chain = { ...materializeCatalogItem('srd_5_2_1:chain-mail', { id: 'chain' }), equipped: true }
  const state = stateWith([chain], { strength: 8 })
  assert.throws(() => resolveCommand(authoritative({
    command_type: 'MoveActor', actor_id: 'hero', to: { x: 6, y: 1 }, command_id: 'slow-armor',
  }), state, options()), (error) => error instanceof RulesValidationError && error.code === 'SPEED_EXCEEDED')
  const check = resolveCommand({ command_type: 'MakeAbilityCheck', actor_id: 'hero', skill: 'stealth', difficulty: 10 }, state, options([2, 19]))
  const event = check.events.find((candidate) => candidate.event_type === 'AbilityCheckResolved')
  assert.equal(event.payload.kept, 2)
  assert.equal(event.payload.armor_stealth_disadvantage, true)
})

test('каталожный профиль игнорирует подменённые кубы экземпляра', () => {
  const forged = {
    ...weapon('srd_5_2_1:longbow', 'longbow'),
    combat: { kind: 'melee', ability: 'str', damage: '99d99', damageType: 'force', normalRange: 5 },
  }
  const profile = weaponAttackProfileFor(stateWith([forged]), 'hero', forged.id)
  assert.equal(profile.kind, 'ranged')
  assert.equal(profile.damage_expression, '1d8+2')
  assert.equal(profile.range_feet, 600)
})
