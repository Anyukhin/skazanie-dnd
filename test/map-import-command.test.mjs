import assert from 'node:assert/strict'
import test from 'node:test'

import { levelKey } from '../server/adventure-director.mjs'
import { generateBuildingScene } from '../server/building-generator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'
import {
  cellAt,
  deserializeTacticalMap,
  legacyCellsFromTacticalMap,
  serializeTacticalMap,
} from '../server/tactical-map.mjs'
import { mechanicsForViewer } from '../server/viewer-projection.mjs'
import { HOUSE_SLAB } from './talespire-fixtures.mjs'

/**
 * Команда `ImportLocationMap`: ведущий заменяет карту локации картой из
 * TaleSpire. Проверяются права, отказы, применение к текущей сцене,
 * replay, подготовка дальней локации и проекция для игрока.
 */

const PARTY = Object.freeze(['hero-a', 'hero-b'])
const AUTHORIZED = Object.freeze({ mapImportAuthorized: true })

function options(context = {}) {
  return {
    diceService: new DiceService({ rng: new SequenceDiceRng([]), idFactory: () => 'unused-roll', now: () => '2026-10-01T00:00:00.000Z' }),
    context,
  }
}

function freeCells(map, count) {
  const cells = []
  for (let y = 0; y < map.height && cells.length < count; y += 1) {
    for (let x = 0; x < map.width && cells.length < count; x += 1) {
      if (cellAt(map, x, y)?.passable && !map.props.some((prop) => prop.footprint.some((spot) => spot.x === x && spot.y === y))) cells.push({ x, y })
    }
  }
  return cells
}

/** Таверна текущей сцены с волком вне боя и сундуком на полу. */
function sceneState(extra = {}) {
  const map = generateBuildingScene({ seed: 'прежний дом', locationId: 'loc-house' })
  const [first, second, wolf, chest] = freeCells(map, 4)
  const state = normalizeCampaignState({
    sessionCode: 'IMPORT',
    state_version: 0,
    engine_mode: 'enforce',
    activePlayerId: PARTY[0],
    partyMemberIds: [...PARTY],
    players: PARTY.map((id, index) => ({ id, character: `Герой ${index + 1}`, hp: 10, maxHp: 10, level: 1, inventory: [], ...[first, second][index] })),
    enemies: [{ id: 'wolf', name: 'Волк', hp: 7, maxHp: 7, alive: true, ...wolf }],
    entities: [{ id: 'chest-1', kind: 'item', name: 'Сундук', ...chest }],
    worldMap: {
      seed: 'import-seed',
      currentLocationId: 'loc-house',
      locations: [
        { id: 'loc-house', name: 'Дом на холме', kind: 'landmark' },
        { id: 'loc-far', name: 'Дальний форт', kind: 'fortress' },
      ],
    },
    scene: {
      title: 'Дом на холме',
      location: 'Дом на холме',
      location_id: 'loc-house',
      turn: 1,
      map: serializeTacticalMap(map),
      cells: legacyCellsFromTacticalMap(map),
    },
    ...extra,
  })
  state.mechanics.positions.wolf = { ...wolf }
  return state
}

function importCommand(overrides = {}) {
  return { command_type: 'ImportLocationMap', command_id: 'import-1', slab: HOUSE_SLAB, ...overrides }
}

test('импорт карты — право ведущего: без полномочия маршрута команда отклоняется', () => {
  const state = sceneState()
  assert.throws(() => resolveCommand(importCommand(), state, options()), (error) => error.code === 'MAP_IMPORT_FORBIDDEN')
  // Флаги игрока, администратора и Режиссёра полномочием на подмену карты не являются.
  assert.throws(() => resolveCommand(importCommand(), state, options({ isAdmin: true, isDirector: true })), (error) => error.code === 'MAP_IMPORT_FORBIDDEN')
})

test('отказы: бой в текущей сцене, неизвестная локация, пустой и битый слэб', () => {
  const combat = sceneState()
  combat.mechanics.combat.active = true
  assert.throws(() => resolveCommand(importCommand(), combat, options(AUTHORIZED)), (error) => error.code === 'MAP_IMPORT_DURING_COMBAT')
  const state = sceneState()
  assert.throws(() => resolveCommand(importCommand({ location_id: 'loc-nowhere' }), state, options(AUTHORIZED)), (error) => error.code === 'MAP_IMPORT_LOCATION_UNKNOWN')
  assert.throws(() => resolveCommand(importCommand({ slab: '' }), state, options(AUTHORIZED)), (error) => error.code === 'SLAB_EMPTY')
  assert.throws(() => resolveCommand(importCommand({ slab: 'не слэб' }), state, options(AUTHORIZED)), (error) => error.code === 'SLAB_NOT_BASE64')
})

test('импорт в текущую сцену: карта сменилась, отряд у входа, жители переехали, replay совпадает', () => {
  const state = sceneState({
    locationMaps: { 'loc-house@L2': { version: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] } },
    levelEntities: { 'loc-house@L2': { enemies: [{ id: 'ghost', name: 'Призрак' }], entities: [], summons: [], positions: {} } },
  })
  const result = resolveCommand(importCommand(), state, options(AUTHORIZED))
  const imported = result.events.find((event) => event.event_type === 'LocationMapImported')
  assert.ok(imported)
  assert.equal(imported.visibility, 'party')
  assert.equal(imported.payload.applied_to_scene, true)
  assert.deepEqual(imported.payload.levels.map((level) => level.index), [0, 1])
  assert.deepEqual(imported.payload.party_positions.map((entry) => entry.actor_id), [...PARTY])

  const after = result.events.reduce((current, event) => applyGameEvent(current, event), state)
  const map = deserializeTacticalMap(after.scene.map)
  assert.equal(map.generator.id, 'talespire-slab')
  assert.equal(after.scene.level.index, 0)
  for (const player of after.players) assert.equal(cellAt(map, player.x, player.y)?.passable, true, `${player.id} стоит на полу новой карты`)
  const wolf = after.mechanics.positions.wolf
  assert.equal(cellAt(map, wolf.x, wolf.y)?.passable, true, 'волк переехал на свободную клетку')
  const chest = after.entities.find((entity) => entity.id === 'chest-1')
  assert.equal(cellAt(map, chest.x, chest.y)?.passable, true, 'сундук переехал на пол')

  // Прежние этажи и их жители принадлежали старой геометрии.
  assert.deepEqual(Object.keys(after.locationMaps).sort(), [levelKey('loc-house', 0), levelKey('loc-house', 1)].sort())
  assert.equal(after.levelEntities?.['loc-house@L2'], undefined)

  const replayed = replayEvents(state, result.events)
  assert.deepEqual(replayed.scene.map, after.scene.map)
  assert.deepEqual(replayed.mechanics.positions, after.mechanics.positions)
  assert.deepEqual(replayed.locationMaps, after.locationMaps)
})

test('по импортированной лестнице поднимаются на второй этаж из памяти локации', () => {
  const state = sceneState()
  const result = resolveCommand(importCommand(), state, options(AUTHORIZED))
  const after = result.events.reduce((current, event) => applyGameEvent(current, event), state)
  const map = deserializeTacticalMap(after.scene.map)
  const stairs = map.props.find((prop) => prop.transition?.toLevel === 1)
  assert.ok(stairs)
  const anchor = stairs.footprint[0]
  after.players = after.players.map((player) => (player.id === PARTY[0] ? { ...player, ...anchor } : player))
  after.mechanics.positions[PARTY[0]] = { ...anchor }
  const climb = resolveCommand({ command_type: 'UseLevelTransition', command_id: 'climb', actor_id: PARTY[0], prop_id: stairs.id }, normalizeCampaignState(after), options())
  const changed = climb.events.find((event) => event.event_type === 'MapLevelChanged')
  assert.ok(changed)
  assert.equal(changed.payload.to_level, 1)
  assert.equal(changed.payload.map, undefined, 'этаж уже лежит в памяти локации — генерировать его не нужно')
  const upstairs = applyGameEvent(normalizeCampaignState(after), changed)
  assert.equal(deserializeTacticalMap(upstairs.scene.map).generator.id, 'talespire-slab')
})

test('подготовка дальней локации: сцена не меняется, событие скрыто от игроков', () => {
  const state = sceneState()
  const result = resolveCommand(importCommand({ location_id: 'loc-far' }), state, options(AUTHORIZED))
  assert.deepEqual(result.events.map((event) => event.event_type), ['LocationMapImported'])
  const [event] = result.events
  assert.equal(event.visibility, 'gm_only')
  assert.equal(event.payload.applied_to_scene, false)
  assert.equal(event.payload.location_name, 'Дальний форт')
  const after = applyGameEvent(state, event)
  assert.deepEqual(after.scene.map, state.scene.map)
  assert.deepEqual(after.mechanics.positions, state.mechanics.positions)
  assert.ok(after.locationMaps['loc-far'] && after.locationMaps['loc-far@L1'])
  const player = { id: 'player-user', role: 'player' }
  assert.deepEqual(mechanicsForViewer(result.events, player, PARTY[0], after), [], 'игрок не узнаёт о подготовке ведущего')
})

test('игрок видит факт импорта текущей сцены, но не карты этажей и не план переселения', () => {
  const state = sceneState()
  const result = resolveCommand(importCommand(), state, options(AUTHORIZED))
  const after = result.events.reduce((current, event) => applyGameEvent(current, event), state)
  const visible = mechanicsForViewer(result.events, { id: 'player-user', role: 'player' }, PARTY[0], after)
    .find((event) => event.event_type === 'LocationMapImported')
  assert.ok(visible)
  assert.deepEqual(visible.payload.levels, [{ index: 0, label: 'Первый этаж' }, { index: 1, label: 'Второй этаж' }])
  for (const key of ['relocations', 'party_positions', 'warnings', 'stats', 'source']) assert.equal(visible.payload[key], undefined, key)
})
