import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileEventStore } from '../../../../server/event-store.mjs'
import { MapStore } from '../../../../server/map-store.mjs'
import { applyGameEvent, normalizeCampaignState } from '../../../../server/rules-engine.mjs'
import {
  addProp,
  createTacticalMap,
  legacyCellsFromTacticalMap,
  serializeTacticalMap,
  setCell,
  setDoor,
} from '../../../../server/tactical-map.mjs'
import { campaignStateForViewer } from '../../../../server/viewer-projection.mjs'

const root = mkdtempSync(join(tmpdir(), 'skazanie-map-isolation-'))

try {
  const mapStore = new MapStore({ rootDir: root, cacheSize: 8 })
  const makeEventStore = () => new FileEventStore({
    rootDir: root,
    mapStore,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotEvery: 1,
  })
  const eventStore = makeEventStore()

  const map = createTacticalMap({
    width: 4,
    height: 2,
    locationId: 'same-location',
    seed: 'same-seed',
    fill: { passable: true, revealed: false, material: 'stone' },
  })
  setCell(map, 0, 0, { revealed: true })
  setDoor(map, { id: 'door-shared', x: 0, y: 0, dir: 'e', state: 'closed', lockDc: 10 })
  addProp(map, {
    id: 'prop-shared',
    assetId: 'chest',
    x: 2.5,
    y: 0.5,
    footprint: [{ x: 2, y: 0 }],
    interactive: true,
  })
  const serializedMap = serializeTacticalMap(map)
  const cells = legacyCellsFromTacticalMap(map)
  const initialState = {
    partyName: 'Проверка изоляции',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', name: 'Герой', level: 1, hp: 10, maxHp: 10, x: 0, y: 0 }],
    scene: {
      title: 'Одинаковая карта',
      location: 'Одинаковая карта',
      location_id: 'same-location',
      turn: 1,
      map: serializedMap,
      cells,
    },
  }

  const alpha = await eventStore.initializeCampaign({ campaignId: 'alpha', initialState })
  const beta = await eventStore.initializeCampaign({ campaignId: 'beta', initialState })
  assert.deepEqual(alpha.state.scene.map, beta.state.scene.map)
  const snapshotState = (campaignId, file = '0000000000000000.json') => JSON.parse(readFileSync(
    join(eventStore._layout(campaignId).snapshots, file),
    'utf8',
  )).state
  assert.equal(snapshotState('alpha').scene.map.hash, snapshotState('beta').scene.map.hash)

  // Холодная загрузка новым FileEventStore проходит через internalizeMaps.
  const coldSeedStore = makeEventStore()
  const initialAlpha = await coldSeedStore.load('alpha')
  const initialBeta = await coldSeedStore.load('beta')
  assert.deepEqual(initialAlpha.state.scene.map, initialBeta.state.scene.map)
  const seedMapHash = snapshotState('alpha').scene.map.hash
  const cachedSeedMap = mapStore.get(seedMapHash)
  assert.notStrictEqual(initialAlpha.state.scene.map, initialBeta.state.scene.map)
  assert.notStrictEqual(initialAlpha.state.scene.map, cachedSeedMap)
  assert.notStrictEqual(initialBeta.state.scene.map, cachedSeedMap)
  assert.equal(campaignStateForViewer(initialAlpha.state, { role: 'player' }, 'hero').scene.map.props.length, 0)
  assert.equal(campaignStateForViewer(initialBeta.state, { role: 'player' }, 'hero').scene.map.props.length, 0)

  // Реальный путь reducer: в alpha раскрываются клетка, дверь и prop.
  // До commit beta указывает на ту же карту, адресуемую по содержимому.
  await eventStore.commit({
    campaignId: 'alpha',
    expectedStateVersion: 0,
    idempotencyKey: 'alpha-map-change',
    events: [
      { event_type: 'AreaRevealed', payload: { cells: [{ x: 1, y: 0 }, { x: 2, y: 0 }] } },
      { event_type: 'DoorStateChanged', payload: { door_id: 'door-shared', state: 'open' } },
      { event_type: 'SceneObjectStateChanged', payload: { prop_id: 'prop-shared', state: 'open', success: true } },
    ],
    forceSnapshot: true,
  })

  // Ещё одна холодная загрузка после commit проверяет новые снимки.
  const coldAfterCommitStore = makeEventStore()
  const changedAlpha = await coldAfterCommitStore.load('alpha')
  const unchangedBeta = await coldAfterCommitStore.load('beta')
  const cachedAlphaMap = mapStore.get(snapshotState('alpha', '0000000000000003.json').scene.map.hash)
  const cachedBetaMap = mapStore.get(snapshotState('beta').scene.map.hash)
  assert.notStrictEqual(changedAlpha.state.scene.map, unchangedBeta.state.scene.map)
  assert.notStrictEqual(changedAlpha.state.scene.map, cachedAlphaMap)
  assert.notStrictEqual(unchangedBeta.state.scene.map, cachedBetaMap)
  assert.equal(changedAlpha.state.scene.map.doors[0].state, 'open')
  assert.equal(changedAlpha.state.scene.map.props[0].state, 'open')
  assert.equal(unchangedBeta.state.scene.map.doors[0].state, 'closed')
  assert.equal(unchangedBeta.state.scene.map.props[0].state ?? '', '')
  assert.equal(unchangedBeta.state.scene.cells.find((cell) => cell.x === 2 && cell.y === 0).revealed, false)

  const alphaPublic = campaignStateForViewer(changedAlpha.state, { role: 'player' }, 'hero')
  const betaPublic = campaignStateForViewer(unchangedBeta.state, { role: 'player' }, 'hero')
  assert.equal(alphaPublic.scene.map.props.some((prop) => prop.id === 'prop-shared'), true)
  assert.equal(betaPublic.scene.map.props.some((prop) => prop.id === 'prop-shared'), false)
  assert.equal(alphaPublic.scene.map.doors.find((door) => door.id === 'door-shared').state, 'open')
  assert.equal(betaPublic.scene.map.doors.find((door) => door.id === 'door-shared').state, 'closed')

  console.log(JSON.stringify({
    ok: true,
    sameInitialMap: true,
    alphaDoor: changedAlpha.state.scene.map.doors[0].state,
    betaDoor: unchangedBeta.state.scene.map.doors[0].state,
    alphaPropVisible: alphaPublic.scene.map.props.some((prop) => prop.id === 'prop-shared'),
    betaPropVisible: betaPublic.scene.map.props.some((prop) => prop.id === 'prop-shared'),
  }))
} finally {
  rmSync(root, { recursive: true, force: true })
}
