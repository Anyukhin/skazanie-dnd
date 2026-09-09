import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { listWorldTemplates } from '../server/world-template-catalog.mjs'
import { cellAt, deserializeTacticalMap } from '../server/tactical-map.mjs'

const hero = (id) => ({
  id, character: 'Аудитор', name: 'Игрок', role: 'Воин · ур. 1',
  species: 'Человек', background: 'Странник', maxHp: 12,
})

test('стартовая карта Асстохана соответствует военной галерее Ареса', async () => {
  const state = await new CampaignBootstrapper().create({
    code: 'MAP-ASTOHAN',
    worldTemplateId: 'astohan-plains',
    players: [{
      id: 'hero-map-audit',
      character: 'Аудитор',
      name: 'Игрок',
      role: 'Воин · ур. 1',
      species: 'Человек',
      background: 'Странник',
      maxHp: 12,
    }],
  })

  assert.equal(state.scene.location, 'Штормберг')
  assert.equal(state.scene.location_id, 'astohan-stormberg')
  const map = deserializeTacticalMap(state.scene.map)
  assert.deepEqual([map.width, map.height], [24, 18])
  assert.equal(map.seed, 'authored-tactical:astohan-stormberg:v1')
  assert.equal(map.tilesetId, 'authored-tactical:astohan-stormberg:v1')
  assert.equal(map.generator.id, 'authored-tactical-scene')
  assert.deepEqual(map.zones.map((zone) => zone.id), ['gallery', 'war-room', 'archive', 'vestibule'])
  const table = map.props.find((prop) => prop.id === 'war-table')
  assert.ok(table)
  assert.equal(table.assetId, 'table_royal')
  assert.equal(table.footprint.length, 10)
  assert.ok(table.footprint.every(({ x, y }) => cellAt(map, x, y)?.zone === 'gallery'))
  assert.ok(map.props.some((prop) => prop.id === 'throne' && prop.assetId === 'royal_throne'))
  assert.ok(map.props.some((prop) => prop.id === 'gallery-pillar-0' && prop.assetId === 'pillar'))
  assert.ok(map.props.some((prop) => prop.id === 'gallery-light-0' && prop.assetId === 'candelabra'))
  assert.deepEqual(
    map.doors.map((door) => door.id).sort(),
    ['ares-east-archive', 'ares-gallery-entrance-east', 'ares-gallery-entrance-west', 'ares-west-study'],
  )
  for (const door of map.doors) {
    const neighbor = door.dir === 'e' ? { x: door.x + 1, y: door.y } : { x: door.x, y: door.y + 1 }
    assert.equal(cellAt(map, door.x, door.y)?.passable, true, `${door.id}: дверь должна стоять на полу`)
    assert.equal(cellAt(map, neighbor.x, neighbor.y)?.passable, true, `${door.id}: дверь должна соединять пол`)
  }
})

test('четыре authored старта стабильны между столами и различаются по географии', async () => {
  const signatures = []
  for (const [index, template] of listWorldTemplates().entries()) {
    const make = (suffix) => new CampaignBootstrapper().create({
      code: `FIXED-MAP-${index + 1}-${suffix}`,
      worldTemplateId: template.id,
      players: [hero(`hero-fixed-${index + 1}-${suffix}`)],
    })
    const first = await make('A')
    const second = await make('B')
    assert.deepEqual(first.scene.cells, second.scene.cells, `${template.id}: геометрия зависит от стола`)
    const map = deserializeTacticalMap(first.scene.map)
    assert.equal(map.locationId, first.scene.location_id)
    assert.equal(map.seed, `authored-tactical:${map.locationId}:v1`)
    assert.equal(map.tilesetId, `authored-tactical:${map.locationId}:v1`)
    assert.equal(map.generator.id, 'authored-tactical-scene')
    assert.ok(map.width <= 30 && map.height <= 24)
    const partySpawns = map.spawnPoints.filter((point) => point.role === 'party')
    assert.ok(partySpawns.length)
    for (const spawn of partySpawns) assert.equal(cellAt(map, spawn.x, spawn.y)?.passable, true, `${template.id}: party spawn must be playable`)
    const signature = structuredClone(first.scene.map)
    signature.locationId = ''
    signature.seed = ''
    signature.tilesetId = ''
    signature.generator = { id: '', version: '' }
    signatures.push(JSON.stringify(signature))
  }
  assert.equal(new Set(signatures).size, 4, 'четыре authored старта не должны быть одной картой')
})

test('дворцовая партия и король получают посты вокруг стола', async () => {
  const state = await new CampaignBootstrapper().create({
    code: 'MAP-PLACEMENT', worldTemplateId: 'astohan-plains',
    players: [hero('hero-placement-a'), hero('hero-placement-b')],
  })
  const map = deserializeTacticalMap(state.scene.map)
  const table = map.props.find((prop) => prop.id === 'war-table' && cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'gallery')
  const ares = state.npc_world.placements.find((placement) => placement.npc_id === 'astohan-ares')
  assert.ok(table)
  assert.equal(ares?.anchor_prop_id, table.id)
  for (const player of state.players) {
    assert.equal(cellAt(map, player.x, player.y)?.zone, 'gallery')
    assert.ok(Math.min(...table.footprint.map((cell) => Math.abs(player.x - cell.x) + Math.abs(player.y - cell.y))) <= 3)
  }
})
