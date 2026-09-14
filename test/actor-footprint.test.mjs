import assert from 'node:assert/strict'
import test from 'node:test'

import {
  footprintCellsFor,
  footprintDistanceFeet,
  footprintMetadataForSize,
  footprintOverlap,
  footprintSizeFor,
} from '../server/actor-footprint.mjs'
import { assembleEncounter } from '../server/encounter-assembler.mjs'
import {
  attackForecast,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
  shortestTacticalPath,
  spellTargetsAt,
} from '../server/rules-engine.mjs'
import { DiceService } from '../server/dice-service.mjs'
import {
  createTacticalMap,
  serializeTacticalMap,
  setEdge,
} from '../server/tactical-map.mjs'

function floorMap(width = 8, height = 6, edge = null) {
  const map = createTacticalMap({ width, height, fill: { passable: true, revealed: true, material: 'stone' } })
  if (edge) setEdge(map, edge.x, edge.y, edge.toX, edge.toY, { kind: 'wall' })
  return map
}

function state({ largeAt = { x: 4, y: 1 }, heroAt = { x: 0, y: 1 }, edge = null, legacy = false, map: providedMap = null } = {}) {
  const map = providedMap ?? floorMap(8, 6, edge)
  return normalizeCampaignState({
    sessionCode: 'FOOTPRINT-TEST',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Герой', hp: 30, maxHp: 30, armor: 14, speed: 30, level: 5,
      abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], ...heroAt,
    }],
    enemies: [{
      id: 'ogre', name: 'Огр', hp: 59, maxHp: 59, armor: 11, speed: 30, level: 7,
      abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
      attack_profile: { id: 'greatclub', name: 'Палица', kind: 'melee', attack_modifier: 6, damage_expression: '2d8+4', damage_type: 'bludgeoning', range_feet: 5 },
      size: 'large', ...(legacy ? {} : { footprint: { version: 1, size: 2 } }),
      alive: true, ...largeAt,
    }],
    scene: { title: 'Площадь', location: 'Площадь', map: serializeTacticalMap(map) },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'ogre', total: 10 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

test('площадь — server-owned квадрат и legacy всегда остаётся одной клеткой', () => {
  assert.deepEqual(footprintMetadataForSize('large'), { version: 1, size: 2 })
  assert.deepEqual(footprintMetadataForSize('huge'), { version: 1, size: 3 })
  assert.deepEqual(footprintMetadataForSize('gargantuan'), { version: 1, size: 4 })
  assert.deepEqual(footprintCellsFor({ footprint: { version: 1, size: 2 } }, { x: 3, y: 2 }), [
    { x: 3, y: 2 }, { x: 4, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 3 },
  ])
  assert.equal(footprintSizeFor({ size: 'gargantuan' }), 1)
  assert.equal(footprintSizeFor({ footprint: { version: 1, size: 'gargantuan' } }), 1)
  assert.equal(footprintSizeFor({ footprint: { version: 9, size: 4 } }), 1)
  assert.equal(footprintSizeFor({ footprint: { version: 1, size: 99 } }), 1)
  assert.equal(footprintDistanceFeet({ footprint: { version: 1, size: 2 } }, [{ x: 3, y: 1 }], { x: 1, y: 1 }), 5)
  assert.equal(footprintOverlap({ footprint: { version: 1, size: 2 } }, [{ x: 2, y: 2 }], { x: 1, y: 1 }), true)
  assert.equal(footprintSizeFor(state({ legacy: true }).enemies[0]), 1)
  assert.equal('footprint' in state({ legacy: true }).enemies[0], false)
})

test('большое существо занимает 2×2: путь, дистанция и область читают всю площадь', () => {
  const current = state({ largeAt: { x: 2, y: 1 }, heroAt: { x: 0, y: 1 } })
  const path = shortestTacticalPath(current, 'hero', { x: 1, y: 1 })
  assert.deepEqual(path, [{ x: 1, y: 1 }])
  assert.equal(shortestTacticalPath(current, 'hero', { x: 2, y: 1 }), null)

  const largeAttacker = state({ largeAt: { x: 1, y: 1 }, heroAt: { x: 3, y: 1 } })
  const forecast = attackForecast(largeAttacker, 'ogre', 'hero')
  assert.equal(forecast.distance_feet, 5, 'дистанция берётся от ближайших клеток, а не от anchor')
  assert.equal(forecast.in_range, true)

  const targets = spellTargetsAt(current, { actor_id: 'hero', to: { x: 1, y: 1 } }, {
    target: 'point', kind: 'area-save', radius: 5, areaShape: 'sphere',
  })
  assert.deepEqual(targets.map((actor) => actor.id), ['hero', 'ogre'])
})

test('траектория атаки начинается и заканчивается исходными anchor актёров', () => {
  const initial = state({
    map: floorMap(20, 20),
    largeAt: { x: 12, y: 14 },
    heroAt: { x: 14, y: 15 },
  })
  const result = resolveCommand({
    command_type: 'MakeAttack', command_id: 'anchor-trajectory', actor_id: 'hero', target_id: 'ogre', server_authoritative: true,
  }, initial, { diceService: new DiceService(), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.ok(attack)
  assert.deepEqual(attack.payload.trajectory[0], { x: 14, y: 15 })
  assert.deepEqual(attack.payload.trajectory.at(-1), { x: 12, y: 14 })
})

test('внутреннее ребро 2×2 блокирует тело и переход проверяет каждый край', () => {
  const current = state({ largeAt: { x: 1, y: 1 }, heroAt: { x: 6, y: 4 }, edge: { x: 1, y: 1, toX: 2, toY: 1 } })
  assert.equal(shortestTacticalPath(current, 'ogre', { x: 2, y: 1 }), null)
})

test('старое событие ShapeChanged с текстовым size не меняет legacy-площадь', () => {
  const current = state({ legacy: true })
  const changed = applyGameEvent(current, {
    event_type: 'ShapeChanged',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: { form: { name: 'Старый облик', size: 'huge', hp: 12, armor: 12, speed: 20 } },
  })
  const hero = changed.players.find((actor) => actor.id === 'hero')
  assert.equal(footprintSizeFor(hero), 1)
  assert.equal(Object.hasOwn(hero, 'footprint'), false)
})

test('движение крупного врага сохраняет площадь после replay и перезапуска снимка', () => {
  const current = state({ largeAt: { x: 2, y: 1 }, heroAt: { x: 0, y: 5 } })
  current.mechanics.combat.active_index = 1
  const result = resolveCommand({
    command_type: 'MoveActor', command_id: 'large-move', actor_id: 'ogre', to: { x: 2, y: 3 }, server_authoritative: true,
  }, current, { diceService: new DiceService(), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  const next = replayEvents(current, result.events)
  assert.deepEqual(next.enemies.find((enemy) => enemy.id === 'ogre')?.footprint, { version: 1, size: 2 })
  assert.deepEqual(next.mechanics.positions.ogre, { x: 2, y: 3 })
  const restarted = normalizeCampaignState(JSON.parse(JSON.stringify(next)))
  assert.deepEqual(restarted.enemies.find((enemy) => enemy.id === 'ogre')?.footprint, { version: 1, size: 2 })
  assert.deepEqual(replayEvents(normalizeCampaignState(JSON.parse(JSON.stringify(current))), result.events), next)
})

test('новая встреча штампует footprint из server-owned размера без входного footprint клиента', () => {
  const cells = Array.from({ length: 12 * 12 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  const proposal = assembleEncounter({
    scene: { cells },
    party: [{ id: 'hero', level: 10, x: 0, y: 0 }],
    difficulty: 'hard',
    theme: 'raiders',
    seed: 'footprint-encounter',
  })
  assert.ok(proposal.enemies.length > 0)
  assert.ok(proposal.enemies.every((enemy) => enemy.footprint?.version === 1 && enemy.footprint.size >= 1 && enemy.footprint.size <= 4))
  const large = proposal.enemies.find((enemy) => enemy.footprint.size > 1)
  if (large) {
    const occupied = new Set(proposal.enemies.flatMap((enemy) => footprintCellsFor(enemy, enemy).map(({ x, y }) => `${x},${y}`)))
    assert.equal(occupied.size, proposal.enemies.reduce((total, enemy) => total + enemy.footprint.size ** 2, 0))
  }
})
