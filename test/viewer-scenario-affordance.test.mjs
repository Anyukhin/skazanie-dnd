import assert from 'node:assert/strict'
import test from 'node:test'

import { addProp, createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'
import { publicTacticalMapFor } from '../server/viewer-projection.mjs'

test('сюжетное действие предмета не протекает в свободную кампанию и кэш учитывает сценарий', () => {
  const map = createTacticalMap({
    width: 3,
    height: 2,
    locationId: 'astohan-ash-watch',
    seed: 'projection-scenario-gate',
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  const propId = 'astohan-ash-watch:burnt-journal'
  addProp(map, { id: propId, assetId: 'paper_scatter', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] })
  const serialized = serializeTacticalMap(map)

  const free = publicTacticalMapFor(serialized)
  assert.equal(free.props.find((prop) => prop.id === propId)?.interactive, undefined)
  assert.equal(free.props.find((prop) => prop.id === propId)?.interaction, undefined)

  const scenario = publicTacticalMapFor(serialized, 'astohan-dragon-hunt')
  const storyProp = scenario.props.find((prop) => prop.id === propId)
  assert.equal(storyProp?.interactive, true)
  assert.deepEqual(storyProp?.interaction?.verbs, ['inspect'])

  const freeAgain = publicTacticalMapFor(serialized)
  assert.equal(freeAgain.props.find((prop) => prop.id === propId)?.interactive, undefined)
})
