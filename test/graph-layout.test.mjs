import assert from 'node:assert/strict'
import test from 'node:test'

import { createSceneGraph, reachableZones } from '../server/scene-graph.mjs'
import { buildSceneFromGraph, layoutSceneGraph, sharedWall, splitArea } from '../server/graph-layout.mjs'
import { cellAt, edgeList, reachableCells, serializeTacticalMap, validateTacticalMap } from '../server/tactical-map.mjs'

function dungeonGraph() {
  return createSceneGraph({
    entranceZoneId: 'entry',
    goalZoneId: 'vault',
    zones: [
      { id: 'entry', kind: 'interior', label: 'Вход' },
      { id: 'hall', kind: 'interior', required: true, label: 'Зал' },
      { id: 'guard', kind: 'interior', keys: ['vault-key'], label: 'Караулка' },
      { id: 'vault', kind: 'interior', label: 'Сокровищница' },
    ],
    links: [
      { id: 'l1', from: 'entry', to: 'hall', kind: 'door' },
      { id: 'l2', from: 'hall', to: 'guard', kind: 'open' },
      { id: 'l3', from: 'hall', to: 'vault', kind: 'locked', keyId: 'vault-key' },
    ],
  })
}

test('разбиение даёт нужное число соизмеримых помещений', () => {
  let seed = 1
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000 }
  const leaves = splitArea({ minX: 0, minY: 0, maxX: 25, maxY: 25 }, 4, random)
  assert.equal(leaves.length, 4)
  const areas = leaves.map((leaf) => (leaf.maxX - leaf.minX) * (leaf.maxY - leaf.minY))
  assert.ok(Math.max(...areas) / Math.min(...areas) < 8, `помещения слишком разные: ${areas.join(', ')}`)
  for (const leaf of leaves) {
    assert.ok(leaf.maxX - leaf.minX >= 4 && leaf.maxY - leaf.minY >= 4, 'помещение меньше минимального')
  }
})

test('общая стена находится только у смежных прямоугольников', () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
  const b = { minX: 10, minY: 0, maxX: 20, maxY: 10 }
  const far = { minX: 14, minY: 14, maxX: 20, maxY: 20 }
  const wall = sharedWall(a, b)
  assert.ok(wall)
  assert.equal(wall.axis, 'x')
  assert.equal(wall.at, 10)
  assert.equal(sharedWall(a, far), null)
})

test('карта по графу детерминирована от seed', () => {
  const first = JSON.stringify(serializeTacticalMap(layoutSceneGraph(dungeonGraph(), { seed: 'same' }).map))
  const second = JSON.stringify(serializeTacticalMap(layoutSceneGraph(dungeonGraph(), { seed: 'same' }).map))
  assert.equal(first, second)
  assert.notEqual(first, JSON.stringify(serializeTacticalMap(layoutSceneGraph(dungeonGraph(), { seed: 'other' }).map)))
})

test('геометрия не теряет топологию: каждая зона графа достижима по клеткам', () => {
  const built = buildSceneFromGraph(dungeonGraph(), { seed: 'topology' })
  assert.deepEqual(built.errors, [], `замечания: ${built.errors.map((issue) => issue.code).join(', ')}`)
  assert.deepEqual(built.warnings, [], `предупреждения: ${built.warnings.join('; ')}`)

  const spawn = built.map.spawnPoints.find((point) => point.role === 'party')
  assert.ok(spawn)
  const reached = reachableCells(built.map, spawn.x, spawn.y)
  const zonesOnCells = new Set()
  for (const key of reached) {
    const [x, y] = key.split(',').map(Number)
    const zone = cellAt(built.map, x, y)?.zone
    if (zone) zonesOnCells.add(zone)
  }
  for (const zoneId of reachableZones(dungeonGraph()).zones) {
    assert.ok(zonesOnCells.has(zoneId), `зона ${zoneId} достижима на графе, но не по клеткам`)
  }
})

test('запертая связь становится запертой дверью с ключом', () => {
  const built = buildSceneFromGraph(dungeonGraph(), { seed: 'locks' })
  const locked = built.map.doors.find((door) => door.id === 'door-l3')
  assert.ok(locked, 'дверь запертой связи обязана существовать')
  assert.equal(locked.state, 'locked')
  assert.equal(locked.keyItemId, 'vault-key')
  assert.ok(locked.lockDc > 0, 'у запертой двери обязана быть сложность вскрытия')

  const plain = built.map.doors.find((door) => door.id === 'door-l1')
  assert.equal(plain?.state, 'closed')
  assert.equal(plain?.keyItemId, null)

  // Открытая связь двери не порождает — это просто проход.
  assert.equal(built.map.doors.some((door) => door.id === 'door-l2'), false)
})

test('карта по графу проходит структурную валидацию', () => {
  const built = layoutSceneGraph(dungeonGraph(), { seed: 'valid' })
  assert.deepEqual(validateTacticalMap(built.map).errors, [])
  assert.ok(edgeList(built.map).filter((edge) => edge.kind === 'wall').length > 20, 'стены обязаны быть на рёбрах')
})

test('порода вокруг помещений непроходима', () => {
  const built = layoutSceneGraph(dungeonGraph(), { seed: 'rock' })
  let rock = 0
  let rooms = 0
  for (let y = 0; y < built.map.height; y += 1) {
    for (let x = 0; x < built.map.width; x += 1) {
      const cell = cellAt(built.map, x, y)
      if (!cell) continue
      if (cell.passable) rooms += 1
      else rock += 1
    }
  }
  assert.ok(rock > 0, 'между помещениями обязана быть порода')
  assert.ok(rooms > 0 && rooms < built.map.width * built.map.height, 'карта не может быть сплошным полом')
})

test('негодный граф не строится, а возвращает замечания стадии 1', () => {
  const broken = createSceneGraph({
    entranceZoneId: 'a',
    goalZoneId: 'b',
    zones: [{ id: 'a' }, { id: 'b', keys: ['k'] }],
    links: [{ id: 'ab', from: 'a', to: 'b', kind: 'locked', keyId: 'k' }],
  })
  const built = buildSceneFromGraph(broken, { seed: 'broken' })
  assert.ok(built.errors.some((issue) => issue.code === 'KEY_BEHIND_ITS_OWN_DOOR'),
    `коды: ${built.errors.map((issue) => issue.code).join(', ')}`)
})

test('зоны, связанные на графе, оказываются смежными помещениями', () => {
  const built = layoutSceneGraph(dungeonGraph(), { seed: 'adjacency' })
  const graph = dungeonGraph()
  for (const link of graph.links) {
    const a = built.rooms.get(link.from)
    const b = built.rooms.get(link.to)
    assert.ok(a && b, `зона связи ${link.id} не размещена`)
    assert.ok(sharedWall(a, b), `зоны ${link.from} и ${link.to} связаны на графе, но не смежны на карте`)
  }
})

test('внешняя зона получает траву, внутренняя — материал темы', () => {
  const graph = createSceneGraph({
    entranceZoneId: 'yard',
    goalZoneId: 'room',
    zones: [{ id: 'yard', kind: 'exterior', label: 'Двор' }, { id: 'room', kind: 'interior', label: 'Комната' }],
    links: [{ id: 'in', from: 'yard', to: 'room', kind: 'door' }],
  })
  const built = layoutSceneGraph(graph, { seed: 'zones', material: 'marble' })
  const materials = new Map()
  for (let y = 0; y < built.map.height; y += 1) {
    for (let x = 0; x < built.map.width; x += 1) {
      const cell = cellAt(built.map, x, y)
      if (cell?.passable && cell.zone) materials.set(cell.zone, cell.material)
    }
  }
  assert.equal(materials.get('yard'), 'grass')
  assert.equal(materials.get('room'), 'marble')
})

test('на большой сцене граф из шести зон тоже не теряет связность', () => {
  const graph = createSceneGraph({
    entranceZoneId: 'z1',
    goalZoneId: 'z6',
    zones: [
      { id: 'z1' }, { id: 'z2', required: true }, { id: 'z3', keys: ['k'] },
      { id: 'z4' }, { id: 'z5' }, { id: 'z6' },
    ],
    links: [
      { id: 'a', from: 'z1', to: 'z2', kind: 'open' },
      { id: 'b', from: 'z2', to: 'z3', kind: 'door' },
      { id: 'c', from: 'z3', to: 'z4', kind: 'open' },
      { id: 'd', from: 'z4', to: 'z5', kind: 'door' },
      { id: 'e', from: 'z5', to: 'z6', kind: 'locked', keyId: 'k' },
    ],
  })
  const built = buildSceneFromGraph(graph, { seed: 'six', width: 34, height: 34 })
  assert.deepEqual(built.errors, [], `замечания: ${built.errors.map((issue) => issue.code).join(', ')}`)
  assert.deepEqual(built.warnings, [], `предупреждения: ${built.warnings.join('; ')}`)
})
