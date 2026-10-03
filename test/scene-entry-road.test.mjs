import assert from 'node:assert/strict'
import test from 'node:test'

import { createSceneTransition, entrySideToward } from '../server/adventure-director.mjs'
import { cellAt, deserializeTacticalMap, edgeNeighbor } from '../server/tactical-map.mjs'

/**
 * Вход по дороге и дома к площади (план карт, «чего не сделали»). Отряд
 * входит на карту с той стороны, откуда пришёл по карте мира, а деревня с
 * центром сцены под открытым небом получает площадь, к которой обращены дома.
 */

const WORLD = Object.freeze({
  seed: 'entry-road',
  currentLocationId: 'brod',
  locations: [
    { id: 'brod', name: 'Старый Брод', kind: 'village', x: 500, y: 120, known: true, visited: true },
    { id: 'olsh', name: 'Ольшанка', kind: 'village', x: 500, y: 420, known: true },
    { id: 'east', name: 'Восточный хутор', kind: 'village', x: 820, y: 420, known: true },
  ],
})

function stateAt(locationId, location) {
  return {
    sessionCode: 'ENTRY',
    worldMap: structuredClone({ ...WORLD, currentLocationId: locationId }),
    scene: { title: location, location, location_id: locationId, turn: 1 },
    adventure: { chapter: 1, history: [], visitedLocations: [location] },
  }
}

function partyEdge(map) {
  const party = map.spawnPoints.find((point) => point.role === 'party')
  return party.x <= 1 ? 'west' : party.x >= map.width - 2 ? 'east' : party.y <= 1 ? 'north' : party.y >= map.height - 2 ? 'south' : 'inside'
}

test('сторона входа — к прежнему месту на карте мира', () => {
  assert.equal(entrySideToward(WORLD, 'olsh', 'brod'), 'north', 'Брод севернее Ольшанки')
  assert.equal(entrySideToward(WORLD, 'brod', 'olsh'), 'south')
  assert.equal(entrySideToward(WORLD, 'olsh', 'east'), 'east')
  assert.equal(entrySideToward(WORLD, 'east', 'olsh'), 'west')
  assert.equal(entrySideToward(WORLD, 'olsh', 'nowhere'), '', 'прежнего места нет — вход по умолчанию')
})

test('отряд входит в деревню с той стороны, откуда пришёл по дороге', () => {
  for (const [from, fromName, expected] of [['brod', 'Старый Брод', 'north'], ['east', 'Восточный хутор', 'east']]) {
    const transition = createSceneTransition({
      title: 'Ольшанка', location: 'Ольшанка', location_id: 'olsh', theme: 'деревня', objective: 'Найти старосту',
      arrival: 'Дорога выводит отряд к деревне.', objective_status: 'completed',
    }, stateAt(from, fromName))
    const map = deserializeTacticalMap(transition.scene.map)
    assert.equal(partyEdge(map), expected, `из «${fromName}» вход — ${expected}`)
    const party = map.spawnPoints.find((point) => point.role === 'party')
    assert.equal(cellAt(map, party.x, party.y)?.zone, 'street', 'вход — на дороге, а не в поле')
  }
})

test('центр сцены под открытым небом даёт деревне площадь, и дома у неё смотрят на неё дверью', () => {
  const transition = createSceneTransition({
    title: 'Ольшанка', location: 'Ольшанка', location_id: 'olsh', theme: 'деревня', objective: 'Найти старосту',
    arrival: 'В центре деревни — общий навес, под ним собираются жители.', objective_status: 'completed',
  }, stateAt('brod', 'Старый Брод'))
  const map = deserializeTacticalMap(transition.scene.map)
  assert.ok(map.zones.some((zone) => zone.id === 'square'), 'у деревни есть площадь')
  const awning = map.props.find((prop) => prop.assetId === 'market_awning')
  assert.ok(awning && awning.footprint.every((cell) => cellAt(map, cell.x, cell.y)?.zone === 'square'), 'навес стоит на площади')
  const facing = map.doors.filter((door) => /^building-\d+-door$/u.test(door.id)).filter((door) => {
    const outside = [{ x: door.x, y: door.y }, edgeNeighbor(door)].find((point) => !String(cellAt(map, point.x, point.y)?.zone ?? '').startsWith('building-'))
    return outside && [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => cellAt(map, outside.x + dx, outside.y + dy)?.zone === 'square')
  })
  assert.ok(facing.length >= 2, `дверью к площади — хотя бы два дома, а не ни одного (${facing.length})`)
})

test('первая сцена: вход со стороны ближайшего места, связанного дорогой', async () => {
  const { openingEntrySide } = await import('../server/adventure-director.mjs')
  const world = {
    ...structuredClone(WORLD),
    currentLocationId: 'olsh',
    routes: [
      { id: 'r-east', from: 'olsh', to: 'east', kind: 'path', distance: 2, discovered: true },
      { id: 'r-brod', from: 'brod', to: 'olsh', kind: 'road', distance: 6, discovered: true },
    ],
  }
  assert.equal(openingEntrySide(world, 'olsh'), 'north', 'дорога — раньше тропы, даже если тропа короче')
  assert.equal(openingEntrySide({ ...world, routes: [world.routes[0]] }, 'olsh'), 'east', 'есть только тропа — по тропе')
  assert.equal(openingEntrySide({ ...world, routes: [] }, 'olsh'), '', 'дорог нет — вход по умолчанию')
})

test('при возвращении с другой стороны знакомая карта не поворачивается, а вход — на её краю с той стороны', async () => {
  const { rememberCurrentSceneMap } = await import('../server/adventure-director.mjs')
  const input = {
    title: 'Ольшанка', location: 'Ольшанка', location_id: 'olsh', theme: 'деревня', objective: 'Найти старосту',
    arrival: 'Дорога выводит отряд к деревне.', objective_status: 'completed',
  }
  const first = createSceneTransition(input, stateAt('brod', 'Старый Брод'))
  const firstMap = deserializeTacticalMap(first.scene.map)
  assert.equal(partyEdge(firstMap), 'north')
  // Отряд ушёл из Ольшанки на восточный хутор и вернулся оттуда.
  const visited = rememberCurrentSceneMap({ ...stateAt('olsh', 'Ольшанка'), worldMap: first.worldMap, scene: first.scene, adventure: first.adventure })
  const away = { ...visited, worldMap: { ...visited.worldMap, currentLocationId: 'east' }, scene: { title: 'Восточный хутор', location: 'Восточный хутор', location_id: 'east', turn: 3 } }
  const back = createSceneTransition({ ...input, objective_status: 'unresolved' }, away)
  assert.deepEqual(back.scene.map, first.scene.map, 'карта та же, что в первый раз')
  const map = deserializeTacticalMap(back.scene.map)
  assert.ok(back.entrance.x >= map.width - 2, `вход у восточного края: ${back.entrance.x},${back.entrance.y} на ${map.width}×${map.height}`)
  assert.equal(cellAt(map, back.entrance.x, back.entrance.y)?.passable, true)
})
