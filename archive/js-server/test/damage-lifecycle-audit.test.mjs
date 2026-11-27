import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `damage-lifecycle-${++id}`, now: () => '2026-09-19T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService, context = {}) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true, ...context } })

const SWORD = {
  id: 'sword', name: 'Меч', type: 'weapon', quantity: 1, equipped: true,
  combat: { kind: 'melee', ability: 'str', damage: '1d4', damageType: 'slashing', normalRange: 5 },
}

function field({ casterClass = 'wizard', casterHp = 30, targetHp = 1, targetMaxHp = 5 } = {}) {
  const cells = Array.from({ length: 48 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'DAMAGE-LIFECYCLE-AUDIT',
    partyMemberIds: ['caster', 'target'],
    players: [
      { id: 'caster', character: 'Заклинатель', characterClass: casterClass, level: 9, hp: casterHp, maxHp: 30, armor: 13, speed: 30, proficiency: 4, abilities: { int: 18, wis: 18, con: 14, dex: 14, cha: 14 }, inventory: [], x: 1, y: 1, knownSpellIds: ['fireball', 'life-transference'], preparedSpellIds: ['fireball', 'life-transference'] },
      { id: 'target', character: 'Цель', characterClass: 'fighter', level: 5, hp: targetHp, maxHp: targetMaxHp, armor: 12, speed: 30, proficiency: 3, abilities: { str: 16, dex: 10, con: 10, int: 8, wis: 8, cha: 8 }, inventory: [], x: 6, y: 1 },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { caster: { spell_slots_3: { current: 2, max: 2 } } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function retaliationField() {
  const initial = field({ casterHp: 1, targetHp: 30, targetMaxHp: 30 })
  return normalizeCampaignState({
    ...initial,
    players: [{ ...initial.players[0], maxHp: 5, inventory: [SWORD] }, initial.players[1]],
    enemies: [{
      id: 'shield-bearer', name: 'Носитель щита', hp: 30, maxHp: 30, armor: 10, speed: 30, proficiency: 3,
      abilities: { str: 14, dex: 12, con: 14, int: 8, wis: 8, cha: 8 }, x: 2, y: 1, alive: true,
    }],
    mechanics: {
      ...initial.mechanics,
      conditions: { ...initial.mechanics.conditions, 'shield-bearer': [{ id: 'fire-shield-warm' }] },
      combat: {
        ...initial.mechanics.combat,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }, { actor_id: 'shield-bearer', total: 5 }],
        action_economy: {
          ...initial.mechanics.combat.action_economy,
          'shield-bearer': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function legendaryField() {
  const initial = field({ casterHp: 1, targetHp: 30, targetMaxHp: 30 })
  return normalizeCampaignState({
    ...initial,
    players: [{ ...initial.players[0], maxHp: 5 }, initial.players[1]],
    enemies: [{
      id: 'boss', name: 'Босс', hp: 120, maxHp: 120, armor: 18, speed: 30, proficiency: 4,
      abilities: { str: 20, dex: 14, con: 18, int: 16, wis: 15, cha: 19 }, x: 2, y: 1, alive: true,
      legendary: {
        uses: 3,
        actions: [{ id: 'tail', name: 'Удар хвостом', cost: 1, kind: 'attack', attack_modifier: 10, damage_expression: '2d8+30', damage_type: 'bludgeoning', range_feet: 15 }],
      },
    }],
    mechanics: {
      ...initial.mechanics,
      combat: {
        ...initial.mechanics.combat,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }, { actor_id: 'boss', total: 5 }],
        action_economy: {
          ...initial.mechanics.combat.action_economy,
          boss: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

test('прямой Fireball проводит полный lifecycle massive damage до HeroDied', () => {
  const initial = field()
  const result = resolveCommand(authoritative({
    command_type: 'CastSpell', command_id: 'fireball-lethal-lifecycle', actor_id: 'caster', spell_id: 'fireball', to: { x: 6, y: 1 },
  }), initial, options(dice([1, ...Array(8).fill(6)])))
  assert.ok(result.events.some((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('target')))
  assert.equal(result.events.filter((event) => event.event_type === 'HeroDied' && event.target_ids.includes('target')).length, 1)
  const after = replayEvents(initial, result.events)
  assert.equal(after.mechanics.death.heroes.target.status, 'dead')
})

test('площадной Fireball всё ещё выбирает героя на 0 HP до его окончательной смерти', () => {
  const initial = field({ targetHp: 0 })
  const result = resolveCommand(authoritative({
    command_type: 'CastSpell', command_id: 'fireball-dying-target', actor_id: 'caster', spell_id: 'fireball', to: { x: 6, y: 1 },
  }), initial, options(dice([1, ...Array(8).fill(6)])))
  assert.ok(result.events.some((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('target')))
  assert.equal(result.events.filter((event) => event.event_type === 'HeroDied' && event.target_ids.includes('target')).length, 1)
  assert.equal(replayEvents(initial, result.events).mechanics.death.heroes.target.status, 'dead')
})

test('self-inflicted Life Transference also uses the shared zero-HP lifecycle', () => {
  const initial = field({ casterClass: 'cleric', casterHp: 1, targetHp: 20, targetMaxHp: 20 })
  const result = resolveCommand(authoritative({
    command_type: 'CastSpell', command_id: 'life-transference-lethal-lifecycle', actor_id: 'caster', spell_id: 'life-transference', target_id: 'target',
  }), initial, options(dice([8, 8, 8, 8])))
  assert.ok(result.events.some((event) => event.event_type === 'DamageApplied' && event.payload.self_inflicted === true))
  assert.equal(result.events.filter((event) => event.event_type === 'HeroDied' && event.target_ids.includes('caster')).length, 1)
  assert.equal(replayEvents(initial, result.events).mechanics.death.heroes.caster.status, 'dead')
})

test('retaliation damage uses the shared massive-damage lifecycle', () => {
  const initial = retaliationField()
  const result = resolveCommand(authoritative({
    command_type: 'MakeAttack', command_id: 'fire-shield-massive-lifecycle', actor_id: 'caster', target_id: 'shield-bearer', item_id: 'sword',
  }), initial, options(dice([19, 1, 4, 4])))
  assert.ok(result.events.some((event) => event.event_type === 'DamageApplied' && event.payload.retaliation === true))
  assert.equal(result.events.filter((event) => event.event_type === 'HeroDied' && event.target_ids.includes('caster')).length, 1)
  assert.equal(result.events.some((event) => event.event_type === 'HitPointsReducedToZero' && event.target_ids.includes('caster')), false)
  assert.equal(replayEvents(initial, result.events).mechanics.death.heroes.caster.status, 'dead')
})

test('legendary attack damage uses the shared massive-damage lifecycle', () => {
  const initial = legendaryField()
  const result = resolveCommand(authoritative({
    command_type: 'UseLegendaryAction', command_id: 'legendary-massive-lifecycle', actor_id: 'boss', legendary_action_id: 'tail', target_id: 'caster',
  }), initial, options(dice([19, 1, 1]), { isNpcScheduler: true }))
  assert.ok(result.events.some((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('caster')))
  assert.equal(result.events.filter((event) => event.event_type === 'HeroDied' && event.target_ids.includes('caster')).length, 1)
  assert.equal(replayEvents(initial, result.events).mechanics.death.heroes.caster.status, 'dead')
})
