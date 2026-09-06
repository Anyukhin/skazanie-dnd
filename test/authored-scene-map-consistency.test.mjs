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
  assert.ok(state.scene.cells.some((cell) => ['stone', 'marble'].includes(cell.material)), 'военная галерея должна быть каменной')
  assert.ok(state.scene.cells.some((cell) => ['table_small', 'candelabra', 'pillar'].includes(cell.feature)),
    'военная галерея должна иметь стол, свет и колонны')
  assert.equal(state.scene.cells.some((cell) => ['reliquary', 'statue', 'sarcophagus'].includes(cell.feature)), false,
    'военная галерея не должна становиться храмом или склепом')
  const map = deserializeTacticalMap(state.scene.map)
  assert.equal(map.props.some((prop) => ['wagon_wheel', 'tree_birch'].includes(prop.assetId) && cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'gallery'), false,
    'внутренняя галерея не должна превращаться в поселение с телегами и деревьями')
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
    assert.equal(first.scene.map.seed, `authored-scene:${template.id}@${template.version.replace(/\.0\.0$/u, '')}`)
    signatures.push(JSON.stringify(first.scene.cells))

    const materials = new Set(first.scene.cells.map((cell) => cell.material))
    if (template.id === 'astohan-plains') {
      assert.equal(first.scene.cells.some((cell) => cell.type === 'water'), false)
      assert.ok(materials.has('stone'))
    } else {
      assert.ok(first.scene.cells.some((cell) => cell.type === 'water'), `${template.id}: старт должен отражать воду/гавань`)
      if (template.id === 'unfading-star-belt') assert.ok(materials.has('sand'))
    }
  }
  assert.equal(new Set(signatures).size, 4, 'четыре authored старта не должны быть одной картой')
})

test('дворцовая партия и король получают посты вокруг стола', async () => {
  const state = await new CampaignBootstrapper().create({
    code: 'MAP-PLACEMENT', worldTemplateId: 'astohan-plains',
    players: [hero('hero-placement-a'), hero('hero-placement-b')],
  })
  const map = deserializeTacticalMap(state.scene.map)
  const table = map.props.find((prop) => prop.assetId === 'table_long' && cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'gallery')
  const ares = state.npc_world.placements.find((placement) => placement.npc_id === 'astohan-ares')
  assert.ok(table)
  assert.equal(ares?.anchor_prop_id, table.id)
  for (const player of state.players) {
    assert.equal(cellAt(map, player.x, player.y)?.zone, 'gallery')
    assert.ok(Math.min(...table.footprint.map((cell) => Math.abs(player.x - cell.x) + Math.abs(player.y - cell.y))) <= 3)
  }
})
