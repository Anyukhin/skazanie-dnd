import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AuthoritativeExecutor } from '../server/authoritative-executor.mjs'
import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import {
  RulesEngine,
  applyGameEvent,
  normalizeCampaignState,
  resolveCommand,
} from '../server/rules-engine.mjs'

const ids = ['mage', 'primary', 'left', 'right', 'north', 'extra', 'far']
const positions = {
  mage: { x: 0, y: 0 },
  primary: { x: 29, y: 0 },
  left: { x: 23, y: 0 },
  right: { x: 35, y: 0 },
  north: { x: 29, y: 6 },
  extra: { x: 23, y: 6 },
  far: { x: 36, y: 0 },
}

function dice(seed = 'chain-roll') {
  let serial = 0
  return new DiceService({
    rng: new SequenceDiceRng(Array(500).fill(4)),
    idFactory: () => `${seed}-${++serial}`,
    now: () => '2026-09-24T12:00:00.000Z',
  })
}

function chainState({ wall = false, levelSevenSlot = false } = {}) {
  const cells = Array.from({ length: 40 * 8 }, (_, index) => {
    const x = index % 40
    const y = Math.floor(index / 40)
    return { x, y, type: wall && x === 32 && y === 0 ? 'wall' : 'floor', revealed: true }
  })
  const enemies = ids.slice(1).map((id) => ({
    id,
    name: id,
    creature_type: 'humanoid',
    hp: 120,
    maxHp: 120,
    armor: 10,
    speed: 30,
    abilities: { str: 10, dex: 8, con: 10, int: 8, wis: 8, cha: 8 },
    ...positions[id],
    alive: true,
  }))
  const actionEconomy = Object.fromEntries(ids.map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }]))
  return normalizeCampaignState({
    sessionCode: 'CHAIN-LIGHTNING-WAVE10-03',
    ruleset_id: 'dnd_5e_2014',
    partyMemberIds: ['mage'],
    players: [{
      id: 'mage', character: 'Искра', characterClass: 'sorcerer', level: 12,
      hp: 60, maxHp: 60, armor: 13, speed: 30, proficiency: 4,
      abilities: { str: 10, dex: 14, con: 14, int: 12, wis: 12, cha: 18 },
      inventory: [{ id: 'component-pouch', catalog_id: 'srd_5_2_1:component-pouch', quantity: 1 }], ...positions.mage,
    }],
    enemies,
    scene: { turn: 1, cells },
    mechanics: {
      resources: {
        mage: {
          spell_slots_6: { current: levelSevenSlot ? 0 : 1, max: 1 },
          spell_slots_7: { current: levelSevenSlot ? 1 : 0, max: 1 },
        },
      },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: ids.map((id, index) => ({ actor_id: id, total: 20 - index })),
        action_economy: actionEconomy,
      },
    },
  })
}

function cast(state, targetIds, extra = {}) {
  return resolveCommand({
    command_type: 'CastSpell',
    command_id: `chain-${targetIds.join('-')}-${extra.slot_level ?? 6}`,
    server_authoritative: true,
    actor_id: 'mage',
    spell_id: 'chain-lightning',
    target_id: targetIds[0],
    target_ids: targetIds,
    ...extra,
  }, state, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
}

test('chain lightning uses the first target as the 30-foot anchor and keeps upcast targets', () => {
  const result = cast(chainState(), ['primary', 'left', 'right', 'north'])
  const damaged = result.events
    .filter((event) => event.event_type === 'DamageApplied')
    .map((event) => event.target_ids[0])
  assert.deepEqual(damaged.sort(), ['left', 'north', 'primary', 'right'])
  assert.equal(result.rolls.find((roll) => roll.purpose.startsWith('spell_damage'))?.expression, '10d8')
  assert.equal(result.events.find((event) => event.event_type === 'ResourceSpent')?.payload.resource, 'spell_slots_6')
})

test('chain lightning keeps the source upcast rule while the current six-level catalog rejects unavailable higher slots', () => {
  const spell = canonicalCombatSpellFor('chain-lightning', { rulesetId: 'dnd_5e_2014' })
  assert.equal(spell.maxTargets + spell.upcastTargetsPerLevel, 5)
  assert.throws(() => cast(chainState(), ['primary', 'left', 'right', 'north', 'extra'], { slot_level: 7 }), (error) => error?.code === 'INVALID_SPELL_SLOT_LEVEL')
})

test('chain lightning accepts a living creature outside the enemy team', () => {
  const state = chainState()
  state.partyMemberIds.push('ally')
  state.players.push({ id: 'ally', character: 'Союзник', characterClass: 'wizard', level: 1, hp: 60, maxHp: 60, armor: 13, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 12, wis: 12, cha: 10 }, x: 25, y: 0, alive: true })
  state.mechanics.combat.action_economy.ally = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const result = cast(state, ['ally'])
  assert.ok(result.events.some((event) => event.target_ids?.includes('ally')), 'creature target should be accepted by the authoritative path')
})

test('secondary target may be beyond caster range when it is within 30 feet of primary', () => {
  const result = cast(chainState(), ['primary', 'right'])
  assert.deepEqual(result.events.filter((event) => event.event_type === 'DamageApplied').map((event) => event.target_ids[0]).sort(), ['primary', 'right'])
})

test('changing the primary makes the same target list fail the caster range check', () => {
  assert.throws(() => cast(chainState(), ['right', 'primary']), (error) => error?.code === 'TARGET_OUT_OF_RANGE')
})

test('invalid secondary distance is rejected before the spell slot is spent', () => {
  const state = chainState()
  assert.throws(() => cast(state, ['primary', 'far']), (error) => error?.code === 'SPELL_TARGETS_TOO_FAR_APART')
  assert.equal(state.mechanics.resources.mage.spell_slots_6.current, 1)
})

test('secondary line of effect starts at primary, including a wall beyond caster range', () => {
  assert.throws(() => cast(chainState({ wall: true }), ['primary', 'right']), (error) => error?.code === 'TRAJECTORY_BLOCKED')
})

test('chain lightning rejects repeated targets before target normalization', () => {
  assert.throws(() => cast(chainState(), ['primary', 'primary', 'left']), (error) => error?.code === 'INVALID_SPELL_TARGETS')
})

test('object ids remain unsupported and are rejected instead of being treated as creatures', () => {
  assert.throws(() => cast(chainState(), ['primary', 'scene-prop-1']), (error) => error?.code === 'TARGET_NOT_FOUND')
})

test('chain lightning commit is idempotent and its state survives event replay', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-chain-lightning-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const campaignId = 'CHAIN-LIGHTNING-IDEMPOTENCY'
  const initial = chainState()
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await store.initializeCampaign({ campaign_id: campaignId, initial_state: initial })
  const executor = new AuthoritativeExecutor({ eventStore: store, rulesEngine: new RulesEngine({ diceService: dice('commit') }) })
  const input = {
    campaignId,
    idempotencyKey: 'chain-lightning-once',
    actorIds: ['mage'],
    context: { serverAuthoritativeCombat: true, isAdmin: true },
    commands: [{
      command_type: 'CastSpell', command_id: 'chain-lightning-once', server_authoritative: true,
      actor_id: 'mage', spell_id: 'chain-lightning', target_id: 'primary', target_ids: ['primary', 'right'],
    }],
  }
  const first = await executor.executeCommands(input)
  const second = await executor.executeCommands(input)
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  const loaded = await store.load(campaignId)
  const replayed = await store.replay(campaignId, { use_snapshots: false })
  assert.deepEqual(replayed.state, loaded.state)
  assert.equal(loaded.state.enemies.find((enemy) => enemy.id === 'primary').hp, 80)
  assert.equal(loaded.state.enemies.find((enemy) => enemy.id === 'right').hp, 80)
})
