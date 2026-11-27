import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMBAT_LAB_MAPS,
  COMBAT_LAB_MAPS_VERSION,
  combatLabMapById,
  combatLabMapCatalog,
} from '../server/combat-lab-maps.mjs'
import {
  cellAt,
  deserializeTacticalMap,
  reachableCells,
  validateTacticalMap,
} from '../server/tactical-map.mjs'

test('библиотека арен содержит старые карты и три тематических расширения', () => {
  assert.equal(COMBAT_LAB_MAPS_VERSION, 'skazanie:combat-lab-maps-v1')
  assert.deepEqual(COMBAT_LAB_MAPS.map((map) => map.id), [
    'open-courtyard', 'ruined-hall', 'marsh-crossing', 'pillar-chamber',
    'forest-clearing', 'cavern-bridge', 'watchtower-terrace',
  ])
  assert.deepEqual(combatLabMapCatalog(), combatLabMapCatalog(), 'одинаковый seed должен давать одинаковый каталог')
})

test('каждая арена имеет фактический рельеф, препятствия и легальные точки появления', () => {
  for (const definition of COMBAT_LAB_MAPS) {
    const map = deserializeTacticalMap(definition.map)
    const report = validateTacticalMap(map)
    assert.equal(report.ok, true, `${definition.id}: ${JSON.stringify(report.errors)}`)
    assert.equal(map.width, definition.width)
    assert.equal(map.height, definition.height)
    assert.equal(definition.cells.length, definition.width * definition.height)
    for (const cell of definition.cells) {
      assert.equal(cell.passable, cellAt(map, cell.x, cell.y)?.passable, `${definition.id}: UI и сервер расходятся по проходимости ${cell.x},${cell.y}`)
    }
    assert.ok(definition.obstacle_count > 0, `${definition.id}: нужны препятствия`)
    assert.ok(definition.terrain_features.difficult_cells > 0 || definition.terrain_features.wall_edges > 0, `${definition.id}: нужен рельеф`)

    const points = definition.spawnPoints
    assert.ok(points.filter((point) => point.role === 'party').length >= 6, `${definition.id}: недостаточно мест для отряда`)
    assert.ok(points.filter((point) => point.role === 'enemy').length >= 12, `${definition.id}: недостаточно мест для врагов`)
    assert.equal(new Set(points.map((point) => `${point.role}:${point.x},${point.y}`)).size, points.length)
    assert.deepEqual(points, map.spawnPoints)

    const party = points.find((point) => point.role === 'party')
    const reachable = reachableCells(map, party.x, party.y)
    for (const point of points) {
      const cell = cellAt(map, point.x, point.y)
      assert.ok(cell?.passable, `${definition.id}: ${point.id} стоит на препятствии`)
      assert.ok(reachable.has(`${point.x},${point.y}`), `${definition.id}: ${point.id} недостижима`)
    }
  }
})

test('выбор карты возвращает копию, а не общий изменяемый снимок', () => {
  const first = combatLabMapById('forest-clearing')
  const second = combatLabMapById('forest-clearing')
  assert.deepEqual(first, second)
  first.cells[0].type = 'wall'
  first.map.layers.present = 'mutated'
  assert.equal(combatLabMapById('forest-clearing').cells[0].type, 'floor')
  assert.equal(combatLabMapById('missing-map'), null)
})
