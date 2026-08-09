import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { combatActionsFor } from '../server/combat-actions.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `sneak-roll-${++id}`,
    now: () => '2026-08-09T15:00:00.000Z',
  })
}

function floor(width = 8, height = 4) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function weapon(catalogId = 'srd_5_2_1:rapier', id = 'rogue-weapon') {
  return { ...materializeCatalogItem(catalogId, { id }), equipped: true }
}

function sneakState({
  level = 5,
  inventory = [weapon()],
  conditions = {},
  withAlly = true,
  activeIndex = 0,
  enemyDefenses = {},
} = {}) {
  return normalizeCampaignState({
    sessionCode: 'SNEAK-ATTACK',
    partyMemberIds: ['rogue', ...(withAlly ? ['ally'] : [])],
    players: [
      {
        id: 'rogue', character: 'Тень', characterClass: 'rogue', role: `Плут · ур. ${level}`, level,
        hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: level >= 9 ? 4 : level >= 5 ? 3 : 2,
        abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 12, cha: 10 },
        inventory, x: 1, y: 1,
      },
      ...(withAlly ? [{
        id: 'ally', character: 'Союзник', characterClass: 'fighter', level: 5,
        hp: 30, maxHp: 30, armor: 16, speed: 30, proficiency: 3,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        inventory: [], x: 2, y: 2,
      }] : []),
    ],
    enemies: [{
      id: 'enemy', name: 'Цель', hp: 300, maxHp: 300, armor: 12, speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      x: 2, y: 1, alive: true, ...enemyDefenses,
    }],
    scene: { turn: 1, cells: floor() },
    mechanics: {
      conditions,
      combat: {
        active: true, round: 1, active_index: activeIndex,
        initiative: [{ actor_id: 'rogue', total: 20 }, { actor_id: 'enemy', total: 10 }],
        action_economy: {
          rogue: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const command = (overrides = {}) => ({
  command_type: 'MakeAttack', command_id: 'sneak-attack-command',
  actor_id: 'rogue', target_id: 'enemy', item_id: 'rogue-weapon',
  attack_ability: 'dex', sneak_attack: true, server_authoritative: true,
  request_fingerprint: 'sneak-attack-request-fingerprint',
  ...overrides,
})

const options = (values, context = {}) => ({
  diceService: dice(values),
  context: { serverAuthoritativeCombat: true, isAdmin: true, ...context },
})

test('карточка Скрытой атаки больше не исполняет отдельную оружейную атаку', () => {
  const action = combatActionsFor({ characterClass: 'rogue', level: 5 }).find((candidate) => candidate.id === 'sneak-attack')
  assert.equal(action.mechanicsSupport, 'ruling-only')
  assert.equal(action.actionType, 'free')
  assert.equal(action.effect.kind, 'special')
  assert.equal(action.effect.rider, 'sneak_attack')
  assert.notEqual(action.effect.kind, 'weapon_attack')
})

test('успешная finesse-атака получает Скрытую атаку от преимущества и сохраняется replay', () => {
  const initial = sneakState({ withAlly: false, conditions: { rogue: [{ id: 'hidden', duration: 'until-used' }] } })
  const result = resolveCommand(command(), initial, options([7, 18, 4, 2, 3, 4]))
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  const sneak = result.events.find((event) => event.event_type === 'SneakAttackApplied')
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(attack.payload.hit, true)
  assert.equal(attack.payload.request_fingerprint, 'sneak-attack-request-fingerprint')
  assert.equal(attack.payload.sneak_attack_eligible_by, 'advantage')
  assert.equal(sneak.payload.expression, '3d6')
  assert.equal(sneak.payload.damage, 9)
  assert.equal(damage.payload.sneak_attack, true)
  assert.equal(damage.payload.raw_amount, 16)

  const replayed = replayEvents(initial, result.events)
  assert.equal(replayed.enemies[0].hp, 284)
  assert.equal(replayed.mechanics.combat.action_economy.rogue.sneak_attack_turn_key, 'combat:1:rogue')
  assert.equal(replayed.battleLog.find((entry) => entry.type === 'attack')?.sneakAttackDamage, 9)
})

test('дееспособный союзник в 5 футах от враждебной цели даёт альтернативную eligibility', () => {
  const result = resolveCommand(command(), sneakState(), options([15, 3, 1, 1, 1]))
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  const sneak = result.events.find((event) => event.event_type === 'SneakAttackApplied')
  assert.equal(attack.payload.sneak_attack_eligible_by, 'ally')
  assert.equal(attack.payload.sneak_attack_supporter_id, 'ally')
  assert.equal(sneak.payload.supporter_id, 'ally')
})

test('server-owned ranged weapon подходит без свойства finesse', () => {
  const state = sneakState({ inventory: [weapon('srd_5_2_1:longbow')] })
  state.mechanics.positions.enemy = { x: 3, y: 1 }
  state.mechanics.positions.ally = { x: 3, y: 2 }
  const result = resolveCommand(command(), state, options([15, 3, 1, 1, 1]))
  assert.equal(result.events.find((event) => event.event_type === 'SneakAttackApplied')?.payload.expression, '3d6')
})

test('недееспособный союзник рядом с целью не открывает Скрытую атаку', () => {
  const state = sneakState({ conditions: { ally: [{ id: 'unconscious' }] } })
  assert.throws(
    () => resolveCommand(command(), state, options([])),
    (error) => error instanceof RulesValidationError && error.code === 'SNEAK_ATTACK_POSITION_REQUIRED',
  )
})

test('помеха запрещает Скрытую атаку даже при одновременно существующем преимуществе', () => {
  const state = sneakState({
    withAlly: true,
    conditions: { rogue: [{ id: 'hidden' }, { id: 'disadvantage-next-attack' }] },
  })
  assert.throws(
    () => resolveCommand(command(), state, options([])),
    (error) => error instanceof RulesValidationError && error.code === 'SNEAK_ATTACK_DISADVANTAGE',
  )
})

test('Скрытая атака применяется не чаще одного раза в текущем ходу, но промах её не тратит', () => {
  const initial = sneakState({ activeIndex: 1 })
  const reactionContext = { reactionResolution: true }
  const missed = resolveCommand(command({ command_id: 'reaction-miss', reaction_attack: true }), initial, options([2], reactionContext))
  assert.equal(missed.events.some((event) => event.event_type === 'SneakAttackApplied'), false)
  const afterMiss = replayEvents(initial, missed.events)

  const hit = resolveCommand(command({ command_id: 'reaction-hit', reaction_attack: true }), afterMiss, options([15, 2, 1, 1, 1], reactionContext))
  const afterHit = replayEvents(afterMiss, hit.events)
  assert.equal(afterHit.mechanics.combat.action_economy.rogue.sneak_attack_turn_key, 'combat:1:enemy')
  assert.throws(
    () => resolveCommand(command({ command_id: 'reaction-second', reaction_attack: true }), afterHit, options([], reactionContext)),
    (error) => error instanceof RulesValidationError && error.code === 'SNEAK_ATTACK_SPENT',
  )
})

test('число костей Скрытой атаки на уровнях 1–12 равно ceil(level / 2)', () => {
  for (let level = 1; level <= 12; level += 1) {
    const count = Math.ceil(level / 2)
    const result = resolveCommand(command({ command_id: `sneak-level-${level}` }), sneakState({ level }), options([15, 1, ...Array(count).fill(1)]))
    const sneak = result.events.find((event) => event.event_type === 'SneakAttackApplied')
    assert.equal(sneak.payload.expression, `${count}d6`, `уровень ${level}`)
    assert.equal(sneak.payload.damage, count, `уровень ${level}`)
  }
})

test('критический удар удваивает только кости и передаёт общий урон через damage resolver', () => {
  const state = sneakState({ enemyDefenses: { damage_resistances: ['piercing'] } })
  const result = resolveCommand(command({ command_id: 'sneak-critical' }), state, options([20, 1, 1, 1, 1, 1, 1, 1, 1]))
  const sneak = result.events.find((event) => event.event_type === 'SneakAttackApplied')
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(sneak.payload.expression, '6d6')
  assert.equal(sneak.payload.critical, true)
  assert.equal(damage.payload.raw_amount, 11)
  assert.equal(damage.payload.resistant, true)
  assert.equal(damage.payload.applied_amount, 5)
})

test('класс и свойства оружия берутся с сервера, а подмена экземпляра не открывает rider', () => {
  const forgedLongsword = {
    ...weapon('srd_5_2_1:longsword'),
    combat: { kind: 'ranged', properties: ['finesse'], damage: '99d99', damageType: 'force', normalRange: 600 },
  }
  assert.throws(
    () => resolveCommand(command({ attack_ability: 'str' }), sneakState({ inventory: [forgedLongsword] }), options([])),
    (error) => error instanceof RulesValidationError && error.code === 'SNEAK_ATTACK_WEAPON_INELIGIBLE',
  )

  const fighterState = sneakState()
  fighterState.players[0] = { ...fighterState.players[0], characterClass: 'fighter', role: 'Воин' }
  assert.throws(
    () => resolveCommand(command(), fighterState, options([])),
    (error) => error instanceof RulesValidationError && error.code === 'SNEAK_ATTACK_CLASS_REQUIRED',
  )

  const handaxe = weapon('srd_5_2_1:handaxe')
  assert.throws(
    () => resolveCommand(command({ attack_mode: 'thrown', attack_ability: 'str' }), sneakState({ inventory: [handaxe] }), options([])),
    (error) => error instanceof RulesValidationError && error.code === 'SNEAK_ATTACK_WEAPON_INELIGIBLE',
    'брошенный handaxe остаётся melee weapon и не становится ranged weapon',
  )
})

test('повтор idempotency key не применяет события Скрытой атаки второй раз', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-sneak-attack-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const initial = sneakState()
  const result = resolveCommand(command({ command_id: 'sneak-idempotent' }), initial, options([15, 2, 1, 1, 1]))
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent })
  await store.initializeCampaign({ campaign_id: 'sneak-idempotent', initial_state: initial })
  const request = {
    campaign_id: 'sneak-idempotent', expected_state_version: 0,
    idempotency_key: 'same-sneak-attack', command_id: 'sneak-idempotent', events: result.events,
  }
  const first = await store.commit(request)
  const retry = await store.commit(request)
  assert.equal(retry.duplicate, true)
  assert.equal(retry.state_version, first.state_version)
  assert.equal(retry.state.enemies[0].hp, first.state.enemies[0].hp)
  assert.equal((await store.getEvents('sneak-idempotent')).filter((event) => event.event_type === 'SneakAttackApplied').length, 1)
})
