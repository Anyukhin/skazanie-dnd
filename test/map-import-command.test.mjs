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
  setCell,
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

test('этап 8: ведущий перестраивает карту текущей сцены по программе — отряд у входа, прежняя карта в журнале', () => {
  const state = sceneState({
    scene: {
      title: 'Скит Трёх Настилов', location: 'Дом на холме', location_id: 'loc-house', turn: 1, theme: 'деревня',
      map: sceneState().scene.map, cells: sceneState().scene.cells,
      map_source: { kind: 'map-library', id: 'tt-japanese-farmhouse', title: 'Japanese Farmhouse' },
      layout: 'Открытая местность; внизу: поляна и спальня.',
    },
  })
  const before = state.scene.map
  const command = {
    command_type: 'RebuildLocationMap', command_id: 'rebuild-1', actor_id: PARTY[0],
    text: 'В центре — общий навес, у ближайших домов на порогах лежат камни, к реке ведут три настила.',
  }
  const result = resolveCommand(command, state, options(AUTHORIZED))
  const event = result.events.find((entry) => entry.event_type === 'LocationMapImported')
  assert.ok(event, 'перестройка пишет то же событие, что импорт: один reducer')
  assert.equal(event.payload.source.format, 'scene-program-rebuild')
  assert.equal(event.payload.schema_version, 2)
  assert.equal(event.payload.map_requirements.focus, 'shelter')
  assert.deepEqual(event.payload.warnings, [], 'обязательное встало на карту')

  const after = applyGameEvent(state, event)
  assert.notDeepEqual(after.scene.map, before, 'карта новая')
  assert.equal(after.scene.map_requirements.focus, 'shelter', 'сцена получила программу')
  assert.equal(after.scene.map_source, undefined, 'атрибуция прежней готовой карты снята')
  assert.equal(after.scene.layout, undefined)
  const map = deserializeTacticalMap(after.scene.map)
  assert.ok(map.props.some((prop) => prop.assetId === 'market_awning'), 'навес на новой карте')
  for (const id of PARTY) {
    const position = after.mechanics.positions[id]
    assert.equal(cellAt(map, position.x, position.y)?.passable, true, `${id} стоит на проходимой клетке новой карты`)
  }
  // Replay того же журнала даёт ту же сцену; прежняя карта осталась в истории.
  const replayed = replayEvents(state, result.events)
  assert.deepEqual(deserializeTacticalMap(replayed.scene.map).props.map((prop) => prop.id), map.props.map((prop) => prop.id))
  assert.equal(replayed.scene.map.width, after.scene.map.width)
  assert.deepEqual(replayed.scene.map_requirements, after.scene.map_requirements)
  assert.ok(result.events.length >= 1 && state.scene.map === before, 'прежняя карта не тронута: она в состоянии до события')
})

test('этап 8: обновление пола сохраняет библиотечную планировку, этажи, позиции, NPC и туман', () => {
  const imported = resolveCommand(importCommand(), sceneState(), options(AUTHORIZED))
  const state = imported.events.reduce((current, event) => applyGameEvent(current, event), sceneState())
  state.scene.theme = 'монастырь'
  state.scene.map_source = { kind: 'map-library', id: 'tt-stave-temple', title: 'Stave Temple' }
  state.scene.layout = 'внизу: зал и святилище'
  const paintGrass = (serialized) => {
    const map = deserializeTacticalMap(serialized)
    map.theme = 'temple'
    const interiors = new Set(map.zones.filter((zone) => zone.kind === 'interior').map((zone) => zone.id))
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      if (cellAt(map, x, y)?.passable && interiors.has(cellAt(map, x, y)?.zone)) setCell(map, x, y, { material: 'grass' })
    }
    return serializeTacticalMap(map)
  }
  state.scene.map = paintGrass(state.scene.map)
  state.scene.cells = legacyCellsFromTacticalMap(deserializeTacticalMap(state.scene.map))
  state.locationMaps = Object.fromEntries(Object.entries(state.locationMaps).map(([key, record]) => {
    if (!record?.map) return [key, record]
    const map = paintGrass(record.map)
    return [key, { ...record, map, cells: legacyCellsFromTacticalMap(deserializeTacticalMap(map)) }]
  }))
  state.npc_world = {
    ...state.npc_world,
    placements: [{ npc_id: 'npc-keeper', location_id: 'loc-house', x: 4, y: 4, role: 'witness' }],
  }
  const beforeMap = deserializeTacticalMap(state.scene.map)
  const before = {
    map: serializeTacticalMap(beforeMap),
    players: state.players.map((player) => ({ id: player.id, x: player.x, y: player.y })),
    positions: structuredClone(state.mechanics.positions),
    enemies: structuredClone(state.enemies),
    entities: structuredClone(state.entities),
    npcWorld: structuredClone(state.npc_world),
    revealed: beforeMap.layers.revealed,
  }
  const result = resolveCommand({
    command_type: 'RebuildLocationMap', command_id: 'refresh-floors-1', actor_id: PARTY[0], preserve_layout: true,
  }, state, options(AUTHORIZED))
  const event = result.events.find((entry) => entry.event_type === 'LocationMapImported')
  assert.ok(event)
  assert.equal(event.payload.preserve_layout, true)
  assert.equal(event.payload.source.format, 'scene-floor-refresh')
  assert.deepEqual(event.payload.levels.map((level) => level.index), [0, 1])

  const after = result.events.reduce((current, event) => applyGameEvent(current, event), state)
  const afterMap = deserializeTacticalMap(after.scene.map)
  assert.deepEqual(afterMap.doors, beforeMap.doors)
  assert.deepEqual(afterMap.edges, beforeMap.edges)
  assert.deepEqual(afterMap.props, beforeMap.props)
  assert.deepEqual(afterMap.layers.revealed, before.revealed, 'туман войны не раскрывается заново')
  assert.deepEqual(after.players.map((player) => ({ id: player.id, x: player.x, y: player.y })), before.players)
  assert.deepEqual(after.mechanics.positions, before.positions)
  assert.deepEqual(after.enemies, before.enemies)
  assert.deepEqual(after.entities, before.entities)
  assert.deepEqual(after.scene.map_source, state.scene.map_source)
  assert.equal(after.scene.layout, state.scene.layout)
  assert.deepEqual(after.npc_world.placements.map((placement) => ({
    npc_id: placement.npc_id, location_id: placement.location_id, x: placement.x, y: placement.y,
  })), before.npcWorld.placements.map((placement) => ({
    npc_id: placement.npc_id, location_id: placement.location_id, x: placement.x, y: placement.y,
  })))
  assert.ok([...Array(afterMap.height * afterMap.width).keys()].some((index) => {
    const x = index % afterMap.width
    const y = Math.floor(index / afterMap.width)
    const cell = cellAt(afterMap, x, y)
    const zone = afterMap.zones.find((candidate) => candidate.id === cell?.zone)
    return cell?.passable && zone?.kind === 'interior' && cell.material === 'marble'
  }), 'внутренний пол обновлён')
  assert.deepEqual(replayEvents(state, result.events), after, 'обновление пола сходится на replay')
})

test('этап 8: перестройка — только ведущему, не в бою и не при открытом голосовании', () => {
  const command = { command_type: 'RebuildLocationMap', command_id: 'rebuild-2', actor_id: PARTY[0] }
  assert.throws(() => resolveCommand(command, sceneState(), options()), { code: 'MAP_IMPORT_FORBIDDEN' })
  const fighting = sceneState()
  fighting.mechanics.combat.active = true
  assert.throws(() => resolveCommand(command, fighting, options(AUTHORIZED)), { code: 'MAP_REBUILD_DURING_COMBAT' })
  const voting = sceneState({ agentInteraction: { id: 'vote-1', type: 'vote', status: 'open', options: [] } })
  assert.throws(() => resolveCommand(command, voting, options(AUTHORIZED)), { code: 'MAP_REBUILD_DECISION_OPEN' })
})
