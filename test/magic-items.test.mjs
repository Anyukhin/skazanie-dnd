import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { MAGIC_ITEM_DEFINITIONS } from '../server/loot-tables.mjs'
import {
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `magic-roll-${++id}`,
    now: () => '2026-07-31T00:00:00.000Z',
  })
}

function item(catalogId, ownerId = 'hero', overrides = {}) {
  const definition = MAGIC_ITEM_DEFINITIONS[catalogId]
  assert.ok(definition, `нет магического предмета ${catalogId}`)
  return {
    ...structuredClone(definition),
    id: `item:${catalogId}`,
    quantity: 1,
    equipped: definition.activation.includes('equipped'),
    ...(definition.requires_attunement ? { attuned_to: ownerId } : {}),
    ...overrides,
  }
}

function combatState({ heroInventory = [], enemyInventory = [], heroHp = 20, enemyHp = 40, active = 'hero' } = {}) {
  return normalizeCampaignState({
    players: [{
      id: 'hero',
      character: 'Бран',
      role: 'Воин · ур. 4',
      level: 4,
      hp: heroHp,
      maxHp: 20,
      armor: 10,
      abilities: { str: 16, dex: 16, con: 14, int: 10, wis: 10, cha: 10 },
      inventory: heroInventory,
    }],
    enemies: [{
      id: 'enemy',
      name: 'Налётчик',
      hp: enemyHp,
      maxHp: 40,
      armor: 12,
      proficiency: 2,
      abilities: { str: 14, dex: 12, con: 12 },
      attack_profile: { id: 'blade', name: 'Клинок', kind: 'melee', attack_modifier: 4, damage_expression: '1d8+2', damage_type: 'slashing', range_feet: 5 },
      inventory: enemyInventory,
    }],
    mechanics: {
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: active }, { actor_id: active === 'hero' ? 'enemy' : 'hero' }],
        active_index: 0,
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true },
        },
      },
    },
  })
}

function magicEffects(result) {
  return result.events.filter((event) => event.event_type === 'MagicItemEffectApplied')
}

test('каталог содержит пятнадцать различных магических предметов с серверными эффектами', () => {
  assert.equal(Object.keys(MAGIC_ITEM_DEFINITIONS).length, 15)
  for (const definition of Object.values(MAGIC_ITEM_DEFINITIONS)) {
    assert.ok(definition.catalog_id)
    assert.ok(definition.name)
    assert.ok(definition.rarity !== 'обычный')
    assert.ok(Object.keys(definition.effects).length > 0)
  }
})

test('меч +1 меняет серверный бросок атаки и урон, а эффект живёт в событиях', () => {
  const sword = item('srd_5_2_1:weapon-plus-1-longsword')
  const state = combatState({ heroInventory: [sword] })
  const result = resolveCommand({
    command_type: 'MakeAttack',
    actor_id: 'hero',
    target_id: 'enemy',
    item_id: sword.id,
    server_authoritative: true,
  }, state, { diceService: dice([10, 4]), context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] } })
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(attack.payload.total, 16)
  assert.equal(damage.payload.raw_amount, 8)
  assert.deepEqual(magicEffects(result).map((event) => event.payload.effect).sort(), ['attack_bonus', 'weapon_damage_bonus'])
  assert.deepEqual(replayEvents(state, result.events), result.events.reduce((current, event) => applyGameEvent(current, event), state))
})

test('Язык пламени наносит отдельный огненный компонент с собственной костью', () => {
  const sword = item('srd_5_2_1:flame-tongue-longsword')
  const state = combatState({ heroInventory: [sword] })
  const result = resolveCommand({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'enemy', item_id: sword.id, server_authoritative: true,
  }, state, { diceService: dice([12, 4, 3, 5]), context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] } })
  const damage = result.events.filter((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.length, 2)
  assert.deepEqual(damage.map((event) => event.payload.damage_type), ['slashing', 'fire'])
  assert.equal(damage[1].payload.raw_amount, 8)
  assert.equal(magicEffects(result).some((event) => event.payload.effect === 'weapon_damage_dice'), true)
})

test('предупреждающее оружие даёт настоящее преимущество инициативы', () => {
  const warning = item('srd_5_2_1:weapon-of-warning-longsword')
  const state = normalizeCampaignState({
    ...combatState({ heroInventory: [warning] }),
    mechanics: { combat: { active: false } },
  })
  const result = resolveCommand({
    command_type: 'StartCombat', actor_id: 'hero', server_authoritative: true,
  }, state, { diceService: dice([2, 17, 10]), context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] } })
  const started = result.events.find((event) => event.event_type === 'CombatStarted')
  const hero = started.payload.initiative.find((entry) => entry.actor_id === 'hero')
  assert.deepEqual(hero.dice, [2, 17])
  assert.equal(hero.roll, 17)
  assert.equal(magicEffects(result)[0].payload.effect, 'initiative_advantage')
})

test('плащ и кольцо защиты складываются в КД и спасброске с прозрачными событиями', () => {
  const cloak = item('srd_5_2_1:cloak-of-protection')
  const ring = item('srd_5_2_1:ring-of-protection')
  const state = combatState({ heroInventory: [cloak, ring], active: 'enemy' })
  const attack = resolveCommand({
    command_type: 'MakeAttack', actor_id: 'enemy', target_id: 'hero', server_authoritative: true,
  }, state, { diceService: dice([12, 4]), context: { serverAuthoritativeCombat: true } })
  assert.equal(attack.events.find((event) => event.event_type === 'AttackResolved').payload.armor_class, 12)
  assert.equal(magicEffects(attack).filter((event) => event.payload.effect === 'armor_class_bonus').length, 2)

  const saveState = normalizeCampaignState({ ...state, mechanics: { ...state.mechanics, combat: { active: false } } })
  const save = resolveCommand({
    command_type: 'MakeSavingThrow', actor_id: 'hero', ability: 'con', difficulty: 10,
  }, saveState, { diceService: dice([5]), context: { allowedActorIds: ['hero'] } })
  const resolved = save.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(resolved.payload.total, 9)
  assert.equal(resolved.payload.magic_item_bonus, 2)
})

test('камень удачи, эльфийские сапоги, рукавицы и обруч меняют проверки характеристик', () => {
  const inventory = [
    item('srd_5_2_1:stone-of-good-luck'),
    item('srd_5_2_1:boots-of-elvenkind'),
    item('srd_5_2_1:gauntlets-of-ogre-power'),
    item('srd_5_2_1:headband-of-intellect'),
  ]
  const state = normalizeCampaignState({ ...combatState({ heroInventory: inventory }), mechanics: { combat: { active: false } } })
  const stealth = resolveCommand({
    command_type: 'MakeAbilityCheck', actor_id: 'hero', skill: 'stealth', difficulty: 15,
  }, state, { diceService: dice([3, 15]), context: { allowedActorIds: ['hero'] } })
  assert.equal(stealth.events.find((event) => event.event_type === 'AbilityCheckResolved').payload.total, 21)
  assert.deepEqual(new Set(magicEffects(stealth).map((event) => event.payload.effect)), new Set(['ability_check_bonus', 'stealth_advantage']))

  const strength = resolveCommand({
    command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'str', difficulty: 15,
  }, state, { diceService: dice([10]), context: { allowedActorIds: ['hero'] } })
  assert.equal(strength.events.find((event) => event.event_type === 'AbilityCheckResolved').payload.total, 15)
  assert.equal(magicEffects(strength).some((event) => event.payload.effect === 'strength_score'), true)

  const intellect = resolveCommand({
    command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'int', difficulty: 15,
  }, state, { diceService: dice([10]), context: { allowedActorIds: ['hero'] } })
  assert.equal(intellect.events.find((event) => event.event_type === 'AbilityCheckResolved').payload.total, 15)
  assert.equal(magicEffects(intellect).some((event) => event.payload.effect === 'intelligence_score'), true)
})

test('амулет здоровья меняет спасбросок Телосложения', () => {
  const amulet = item('srd_5_2_1:amulet-of-health')
  const state = normalizeCampaignState({ ...combatState({ heroInventory: [amulet] }), mechanics: { combat: { active: false } } })
  const result = resolveCommand({
    command_type: 'MakeSavingThrow', actor_id: 'hero', ability: 'con', difficulty: 14,
  }, state, { diceService: dice([10]), context: { allowedActorIds: ['hero'] } })
  assert.equal(result.events.find((event) => event.event_type === 'SavingThrowResolved').payload.total, 14)
  assert.equal(magicEffects(result).some((event) => event.payload.effect === 'constitution_score'), true)
})

test('периапт удваивает лечение костью хитов, расход сохраняется после replay', () => {
  const periapt = item('srd_5_2_1:periapt-of-wound-closure')
  const state = normalizeCampaignState({
    ...combatState({ heroInventory: [periapt], heroHp: 4 }),
    mechanics: {
      resting: { hero: { kind: 'short' } },
      resources: { hero: { hit_dice: { current: 4, max: 4, sides: 10 } } },
      combat: { active: false },
    },
  })
  const result = resolveCommand({
    command_type: 'CompleteRest', actor_id: 'hero', kind: 'short', hit_dice: 1,
  }, state, { diceService: dice([5]), context: { allowedActorIds: ['hero'] } })
  const rolled = result.events.find((event) => event.event_type === 'HitDiceRolled')
  assert.equal(rolled.payload.rolled_healing, 7)
  assert.equal(rolled.payload.requested_healing, 14)
  const replayed = replayEvents(state, result.events)
  assert.equal(replayed.players[0].hp, 18)
  assert.deepEqual(replayed.mechanics.resources.hero.hit_dice, { current: 3, max: 4, sides: 10 })
  assert.equal(magicEffects(result).some((event) => event.payload.effect === 'hit_die_healing_multiplier'), true)
})

test('жестокий меч добавляет критический урон, а адамантиновый доспех отменяет крит', () => {
  const vicious = item('srd_5_2_1:vicious-longsword')
  const attackState = combatState({ heroInventory: [vicious] })
  const viciousResult = resolveCommand({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'enemy', item_id: vicious.id, server_authoritative: true,
  }, attackState, { diceService: dice([20, 4, 5, 2, 3]), context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] } })
  assert.equal(viciousResult.events.find((event) => event.event_type === 'DamageApplied').payload.raw_amount, 17)
  assert.equal(magicEffects(viciousResult).some((event) => event.payload.effect === 'critical_damage_dice'), true)

  const adamantine = item('srd_5_2_1:adamantine-half-plate')
  const defenseState = combatState({ heroInventory: [adamantine], active: 'enemy' })
  const defended = resolveCommand({
    command_type: 'MakeAttack', actor_id: 'enemy', target_id: 'hero', server_authoritative: true,
  }, defenseState, { diceService: dice([20, 4]), context: { serverAuthoritativeCombat: true } })
  const attack = defended.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.critical, false)
  assert.equal(attack.payload.critical_prevented_by_magic_item, true)
  assert.equal(magicEffects(defended).some((event) => event.payload.effect === 'critical_hit_immunity'), true)
})

test('брошь даёт сопротивление силовому урону, наручи добавляют урон из лука', () => {
  const brooch = item('srd_5_2_1:brooch-of-shielding')
  const safeState = normalizeCampaignState({ ...combatState({ heroInventory: [brooch] }), mechanics: { combat: { active: false } } })
  const force = resolveCommand({
    command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'hero', amount: 9, damage_type: 'force',
  }, safeState, { diceService: dice([]), context: { isAdmin: true } })
  const forceDamage = force.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(forceDamage.payload.applied_amount, 4)
  assert.equal(forceDamage.payload.magic_item_resistance, true)
  assert.equal(magicEffects(force).some((event) => event.payload.effect === 'damage_resistance'), true)

  const bow = {
    id: 'bow',
    catalog_id: 'srd_5_2_1:longbow',
    name: 'Длинный лук',
    type: 'weapon',
    quantity: 1,
    equipped: true,
    combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150, longRange: 600 },
  }
  const bracers = item('srd_5_2_1:bracers-of-archery')
  const rangedState = combatState({ heroInventory: [bow, bracers] })
  const ranged = resolveCommand({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'enemy', item_id: 'bow', server_authoritative: true,
  }, rangedState, { diceService: dice([10, 4]), context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] } })
  assert.equal(ranged.events.find((event) => event.event_type === 'DamageApplied').payload.raw_amount, 9)
  assert.equal(magicEffects(ranged).some((event) => event.payload.effect === 'ranged_weapon_damage_bonus'), true)
})
