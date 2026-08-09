import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import {
  applyGameEvent,
  movementStepCostFor,
  normalizeCampaignState,
  resolveCommand,
} from '../server/rules-engine.mjs'
import {
  legacyCellsFromTacticalMap,
  serializeTacticalMap,
  setCell,
  tacticalMapFromLegacyCells,
} from '../server/tactical-map.mjs'

const SPIDER_IDS = ['srd_5_2_1:giant-spider', 'srd_5_2_1:giant-wolf-spider']

function floorCells() {
  return Array.from({ length: 4 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
}

function dice() {
  return new DiceService({
    rng: new SequenceDiceRng([]),
    idFactory: () => 'unused-roll',
    now: () => '2026-08-09T00:00:00.000Z',
  })
}

function stateFor({ traits = [], effects = [], scene = { cells: floorCells() } } = {}) {
  return normalizeCampaignState({
    sessionCode: 'WEB-WALKER',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', hp: 20, maxHp: 20, armor: 12, speed: 30,
      abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      x: 0, y: 0,
    }],
    enemies: [{
      id: 'spider', hp: 11, maxHp: 11, armor: 13, speed: 10,
      abilities: { str: 12, dex: 16, con: 13, int: 3, wis: 12, cha: 4 },
      traits,
      action_profiles: [{
        id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 5,
        damage_expression: '1d4+3', damage_type: 'piercing', range_feet: 5,
      }],
      x: 3, y: 0, alive: true,
    }],
    scene,
    mechanics: {
      active_effects: effects,
      combat: {
        active: true,
        round: 1,
        active_index: 1,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'spider', total: 10 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          spider: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function webAt(x = 2) {
  return { id: 'web-area', spell_id: 'web', difficult_terrain: true, cells: [{ x, y: 0 }] }
}

function mudAt(x = 2) {
  return { id: 'mud-area', spell_id: 'earth-tremor', difficult_terrain: true, cells: [{ x, y: 0 }] }
}

test('оба паучьих профиля игнорируют только доплату чистой паутины', () => {
  const ordinary = stateFor({ effects: [webAt()] })
  assert.equal(movementStepCostFor(ordinary, 'spider').stepCost({ x: 2, y: 0 }), 10)

  for (const profileId of SPIDER_IDS) {
    const block = SRD_5_2_1_MONSTER_ALLOWLIST[profileId]
    assert.ok(block.traits.some((trait) => String(trait?.id ?? trait) === 'web-walker'))
    const walker = stateFor({ traits: block.traits, effects: [webAt()] })
    assert.equal(movementStepCostFor(walker, 'spider').stepCost({ x: 2, y: 0 }), 5, profileId)
  }
})

test('web-walker не игнорирует non-web, mixed и статическую труднопроходимость', () => {
  const traits = SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-spider'].traits
  assert.equal(movementStepCostFor(stateFor({ traits, effects: [mudAt()] }), 'spider').stepCost({ x: 2, y: 0 }), 10)
  assert.equal(movementStepCostFor(stateFor({ traits, effects: [webAt(), mudAt()] }), 'spider').stepCost({ x: 2, y: 0 }), 10)

  const map = tacticalMapFromLegacyCells(floorCells())
  setCell(map, 2, 0, { moveCost: 2, surface: 'rubble' })
  const scene = { cells: legacyCellsFromTacticalMap(map), map: serializeTacticalMap(map) }
  assert.equal(movementStepCostFor(stateFor({ traits, effects: [webAt()], scene }), 'spider').stepCost({ x: 2, y: 0 }), 10)
})

test('NPC plan и авторитетное исполнение одинаково оценивают pure web и mixed terrain', () => {
  const traits = SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-wolf-spider'].traits

  const pureWeb = stateFor({ traits, effects: [webAt()] })
  const purePlan = planNpcTurn(pureWeb, 'spider')
  const pureMove = purePlan.find((command) => command.command_type === 'MoveActor')
  assert.deepEqual(pureMove?.to, { x: 1, y: 0 }, 'два шага по чистой паутине укладываются в 10 футов')
  const pureResult = resolveCommand({ ...pureMove, command_id: 'pure-web-move', server_authoritative: true }, pureWeb, {
    diceService: dice(), context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true },
  })
  const pureMoved = pureResult.events.find((event) => event.event_type === 'ActorMoved')
  assert.equal(pureMoved.payload.movement_cost, 10)
  assert.deepEqual(pureResult.events.reduce(applyGameEvent, pureWeb).mechanics.positions.spider, { x: 1, y: 0 })

  const mixed = stateFor({ traits, effects: [webAt(), mudAt()] })
  const mixedPlan = planNpcTurn(mixed, 'spider')
  const mixedMove = mixedPlan.find((command) => command.command_type === 'MoveActor')
  assert.deepEqual(mixedMove?.to, { x: 2, y: 0 }, 'смешанная клетка оплачивается как difficult terrain')
  const mixedResult = resolveCommand({ ...mixedMove, command_id: 'mixed-move', server_authoritative: true }, mixed, {
    diceService: dice(), context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true },
  })
  assert.equal(mixedResult.events.find((event) => event.event_type === 'ActorMoved').payload.movement_cost, 10)
})
