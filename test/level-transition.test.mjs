import assert from 'node:assert/strict'
import test from 'node:test'

import { levelKey } from '../server/adventure-director.mjs'
import { generateBuildingScene } from '../server/building-generator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeDeclaredLevels } from '../server/level-generator.mjs'
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
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

/**
 * Механика перехода между этажами (`docs/multilevel-map-plan.md`, раздел 4).
 *
 * Сцена собирается настоящим генератором таверны с объявленными этажами:
 * подменять карту заглушкой здесь нельзя — половина проверок как раз про то,
 * что привязка лестницы к этажу переживает дорогу до состояния и обратно.
 */

const DECLARED = Object.freeze([
  { offset: 1, hint: 'спальни и кабинет хозяина' },
  { offset: -1, hint: 'винный погреб' },
])

const PARTY = Object.freeze(['hero-a', 'hero-b'])

function dice() {
  return new DiceService({
    rng: new SequenceDiceRng([]),
    idFactory: () => 'unused-roll',
    now: () => '2026-08-02T00:00:00.000Z',
  })
}

function options(context = {}) {
  return { diceService: dice(), context }
}

function tavernMap() {
  return generateBuildingScene({
    seed: 'постоялый двор',
    locationId: 'loc-tavern',
    levels: normalizeDeclaredLevels(DECLARED),
  })
}

/** @param {import('../server/tactical-map.mjs').TacticalMap} map @param {number} toLevel */
function transitionTo(map, toLevel) {
  const prop = map.props.find((candidate) => Number(candidate.transition?.toLevel) === toLevel)
  assert.ok(prop, `на карте нет перехода на этаж ${toLevel}`)
  return prop
}

/**
 * Состояние таверны с объявленными этажами. `withMap` = false воспроизводит
 * живую дорогу сцены: до состояния доезжают только старые клетки, а карта
 * пересобирается из них — вместе с потерей привязки лестницы.
 */
function tavernState({ withMap = true, extra = {} } = {}) {
  const map = tavernMap()
  const stairs = transitionTo(map, 1)
  const anchor = stairs.footprint[0]
  const spots = []
  for (let radius = 1; spots.length < PARTY.length && radius <= 4; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const cell = cellAt(map, anchor.x + dx, anchor.y + dy)
        if (cell?.passable) spots.push({ x: anchor.x + dx, y: anchor.y + dy })
      }
    }
  }
  assert.ok(spots.length >= PARTY.length, 'рядом с лестницей должно быть место для отряда')
  const cells = legacyCellsFromTacticalMap(map)
  return normalizeCampaignState({
    sessionCode: 'LEVELS',
    state_version: 0,
    engine_mode: 'enforce',
    activePlayerId: PARTY[0],
    partyMemberIds: [...PARTY],
    players: PARTY.map((id, index) => ({
      id,
      character: `Герой ${index + 1}`,
      hp: 10,
      maxHp: 10,
      level: 1,
      inventory: [],
      ...spots[index],
    })),
    worldMap: {
      seed: 'levels-seed',
      currentLocationId: 'loc-tavern',
      locations: [{ id: 'loc-tavern', name: 'Постоялый двор', kind: 'settlement' }],
    },
    scene: {
      title: 'Постоялый двор',
      location: 'Постоялый двор',
      location_id: 'loc-tavern',
      objective: 'Найти хозяина',
      turn: 1,
      levels: normalizeDeclaredLevels(DECLARED),
      ...(withMap ? { map: serializeTacticalMap(map) } : {}),
      cells,
    },
    ...extra,
  })
}

function climb(state, { actorId = PARTY[0], propId = null, level = 1 } = {}) {
  const map = deserializeTacticalMap(state.scene.map)
  const prop = propId ? { id: propId } : transitionTo(map, level)
  return resolveCommand({
    command_type: 'UseLevelTransition',
    command_id: `climb-${level}-${actorId}`,
    actor_id: actorId,
    prop_id: prop.id,
  }, state, options())
}

function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

// --- валидация ------------------------------------------------------------

test('переход требует тактической карты', () => {
  const state = normalizeCampaignState({
    sessionCode: 'LEVELS-EMPTY',
    partyMemberIds: [PARTY[0]],
    players: [{ id: PARTY[0], character: 'Герой', hp: 10, maxHp: 10, inventory: [] }],
    scene: { title: 'Пустота', location: 'Пустота', cells: [] },
  })
  assert.throws(
    () => resolveCommand({ command_type: 'UseLevelTransition', actor_id: PARTY[0], prop_id: 'prop-1' }, state, options()),
    (error) => error.code === 'TACTICAL_MAP_REQUIRED',
  )
})

test('предмет без перехода не ведёт на другой этаж', () => {
  const state = tavernState()
  const map = deserializeTacticalMap(state.scene.map)
  const plain = map.props.find((prop) => !prop.transition)
  assert.ok(plain, 'в таверне должна быть обычная мебель')
  assert.throws(
    () => resolveCommand({ command_type: 'UseLevelTransition', actor_id: PARTY[0], prop_id: plain.id }, state, options()),
    (error) => error.code === 'TRANSITION_NOT_FOUND',
  )
})

test('в бою между этажами не ходят', () => {
  const state = tavernState()
  state.mechanics.combat.active = true
  assert.throws(() => climb(state), (error) => error.code === 'LEVEL_TRANSITION_IN_COMBAT')
})

test('до лестницы нужно дойти', () => {
  const state = tavernState()
  const map = deserializeTacticalMap(state.scene.map)
  const anchor = transitionTo(map, 1).footprint[0]
  const far = legacyCellsFromTacticalMap(map)
    .filter((cell) => cell.type === 'floor')
    .find((cell) => Math.max(Math.abs(cell.x - anchor.x), Math.abs(cell.y - anchor.y)) > 3)
  assert.ok(far, 'в таверне должна быть клетка вдали от лестницы')
  state.players = state.players.map((player) => (player.id === PARTY[0] ? { ...player, ...far } : player))
  state.mechanics.positions[PARTY[0]] = { x: far.x, y: far.y }
  assert.throws(() => climb(state), (error) => error.code === 'TRANSITION_TOO_FAR')
})

test('партию между этажами водит только её персонаж', () => {
  const state = tavernState()
  const map = deserializeTacticalMap(state.scene.map)
  const anchor = transitionTo(map, 1).footprint[0]
  state.enemies = [{ id: 'wolf', name: 'Волк', hp: 7, maxHp: 7, alive: true, x: anchor.x, y: anchor.y }]
  const normalized = normalizeCampaignState(state)
  assert.throws(
    () => climb(normalized, { actorId: 'wolf' }),
    (error) => error.code === 'PARTY_MEMBER_REQUIRED',
  )
})

// --- полный цикл ----------------------------------------------------------

test('подъём, спуск и повторный подъём: карта едет один раз, этаж возвращается прежним', () => {
  const initial = tavernState()
  const events = []

  // Подъём: этажа ещё нет, он строится в resolve и едет в событии целиком.
  const up = climb(initial)
  assert.equal(up.events.length, 1)
  const upEvent = up.events[0]
  assert.equal(upEvent.event_type, 'MapLevelChanged')
  assert.equal(upEvent.payload.from_level, 0)
  assert.equal(upEvent.payload.to_level, 1)
  assert.equal(upEvent.payload.level_label, 'Второй этаж')
  assert.ok(upEvent.payload.map, 'первая генерация этажа обязана нести карту')
  assert.deepEqual(upEvent.payload.party_positions.map((entry) => entry.actor_id), [...PARTY])
  events.push(upEvent)
  const upstairs = applyGameEvent(initial, upEvent)

  assert.deepEqual(upstairs.scene.level, { index: 1, label: 'Второй этаж' })
  assert.equal(deserializeTacticalMap(upstairs.scene.map).levelIndex, 1)
  assert.deepEqual(upstairs.locationLevels['loc-tavern'].map((entry) => entry.index), [0, 1])
  assert.ok(upstairs.locationMaps[levelKey('loc-tavern', 0)], 'зал обязан остаться в памяти локаций')
  assert.ok(upstairs.locationMaps[levelKey('loc-tavern', 1)], 'второй этаж запоминается под своим ключом')
  for (const position of upEvent.payload.party_positions) {
    assert.deepEqual(upstairs.mechanics.positions[position.actor_id], { x: position.x, y: position.y })
  }
  const hallRevealed = upstairs.locationMaps[levelKey('loc-tavern', 0)].cells.filter((cell) => cell.revealed).length
  const upstairsRevealed = deserializeTacticalMap(upstairs.scene.map)
  assert.equal(
    legacyCellsFromTacticalMap(upstairsRevealed).filter((cell) => cell.revealed).length,
    PARTY.length,
    'на новом этаже раскрыты только клетки прибытия',
  )

  // Спуск обратно: зал уже запомнен, поэтому карта в событии не нужна.
  const down = climb(upstairs, { actorId: PARTY[0], level: 0 })
  const downEvent = down.events[0]
  assert.equal(downEvent.payload.from_level, 1)
  assert.equal(downEvent.payload.to_level, 0)
  assert.equal(Object.hasOwn(downEvent.payload, 'map'), false, 'повторный переход карту не несёт')
  assert.ok(Buffer.byteLength(JSON.stringify(downEvent.payload), 'utf8') <= 2_048)
  events.push(downEvent)
  const hall = applyGameEvent(upstairs, downEvent)

  assert.deepEqual(hall.scene.level, { index: 0, label: 'Первый этаж' })
  assert.equal(deserializeTacticalMap(hall.scene.map).levelIndex, 0)
  assert.ok(
    legacyCellsFromTacticalMap(deserializeTacticalMap(hall.scene.map)).filter((cell) => cell.revealed).length >= hallRevealed,
    'раскрытие зала не должно потеряться за время отлучки',
  )
  assert.ok(transitionTo(deserializeTacticalMap(hall.scene.map), 1), 'лестница зала остаётся переходом')

  // Второй подъём: этаж посещён, карта снова не едет, а его раскрытие цело.
  const again = climb(hall)
  const againEvent = again.events[0]
  assert.equal(Object.hasOwn(againEvent.payload, 'map'), false, 'посещённый этаж карту не несёт')
  events.push(againEvent)
  const upstairsAgain = applyGameEvent(hall, againEvent)
  assert.equal(deserializeTacticalMap(upstairsAgain.scene.map).levelIndex, 1)
  assert.equal(
    legacyCellsFromTacticalMap(deserializeTacticalMap(upstairsAgain.scene.map)).filter((cell) => cell.revealed).length,
    PARTY.length,
    'раскрытие второго этажа сохранилось между визитами',
  )

  // Replay того же потока обязан дать то же состояние.
  const replayed = replayEvents(initial, events)
  assert.deepEqual(replayed, upstairsAgain)
})

test('жители этажа возвращаются из стэша, а не пропадают', () => {
  const initial = tavernState()
  const withGuest = normalizeCampaignState({
    ...initial,
    enemies: [{ id: 'rat', name: 'Крыса', hp: 3, maxHp: 3, alive: true, x: 2, y: 2 }],
    entities: [{ id: 'barrel-stack', kind: 'barrel', x: 3, y: 3 }],
  })
  const up = climb(withGuest)
  const upstairs = applyGameEvent(withGuest, up.events[0])
  assert.deepEqual(upstairs.enemies, [], 'жители зала не поднимаются вслед за партией')
  assert.deepEqual(upstairs.entities, [])
  assert.ok(upstairs.levelEntities[levelKey('loc-tavern', 0)], 'зал получил стэш жителей')

  const down = climb(upstairs, { level: 0 })
  const hall = applyGameEvent(upstairs, down.events[0])
  assert.deepEqual(hall.enemies.map((enemy) => enemy.id), ['rat'])
  assert.deepEqual(hall.entities.map((entity) => entity.id), ['barrel-stack'])
  assert.deepEqual(hall.mechanics.positions.rat, { x: 2, y: 2 })
  assert.equal(hall.levelEntities?.[levelKey('loc-tavern', 0)], undefined, 'возвращённый стэш не остаётся в состоянии')
})

// --- мина этапа L2 --------------------------------------------------------

test('привязка лестницы восстанавливается после круга через старые клетки', () => {
  const state = tavernState({ withMap: false })
  const rebuilt = deserializeTacticalMap(state.scene.map)
  assert.equal(
    rebuilt.props.some((prop) => prop.transition),
    false,
    'круг через старые клетки обязан терять transition — иначе тест ничего не проверяет',
  )
  const stairs = rebuilt.props.find((prop) => prop.assetId === 'stairs_up')
  assert.ok(stairs, 'сама лестница круг переживает')

  const result = resolveCommand({
    command_type: 'UseLevelTransition',
    actor_id: PARTY[0],
    prop_id: stairs.id,
  }, state, options())
  assert.equal(result.events[0].payload.to_level, 1)

  const next = applyGameEvent(state, result.events[0])
  const hallRecord = next.locationMaps[levelKey('loc-tavern', 0)]
  const hall = deserializeTacticalMap(hallRecord.map)
  assert.equal(
    hall.props.some((prop) => Number(prop.transition?.toLevel) === 1),
    true,
    'починка обязана попасть и в законсервированный зал, иначе replay разойдётся',
  )
  assert.deepEqual(replayEvents(state, result.events), next)
})

// --- уход из локации ------------------------------------------------------

test('уход из локации с верхнего этажа консервирует этаж и возвращает партию на этаж входа', () => {
  const initial = tavernState()
  const upstairs = applyGameEvent(initial, climb(initial).events[0])
  assert.equal(upstairs.scene.level.index, 1)

  const advance = resolveCommand({
    command_type: 'AdvanceScene',
    command_id: 'leave-tavern',
    scene_args: { title: 'Тракт', location: 'Тракт', objective: 'Дойти до города' },
  }, upstairs, options({ isAdmin: true }))
  const road = applyAll(upstairs, advance.events)

  assert.equal(road.scene.level, undefined, 'в новой локации этажа нет')
  assert.ok(road.locationMaps[levelKey('loc-tavern', 1)], 'второй этаж таверны законсервирован')
  assert.ok(road.locationMaps[levelKey('loc-tavern', 0)], 'зал таверны остался в памяти')

  const back = resolveCommand({
    command_type: 'AdvanceScene',
    command_id: 'return-tavern',
    scene_args: { title: 'Постоялый двор', location: 'Постоялый двор', location_id: 'loc-tavern', objective: 'Вернуться' },
  }, road, options({ isAdmin: true }))
  const tavern = applyAll(road, back.events)
  assert.equal(tavern.scene.level, undefined, 'возврат в локацию приводит на этаж входа')
  assert.equal(tavern.scene.location_id, 'loc-tavern')
})

// --- проекция -------------------------------------------------------------

test('игрок видит этаж и список известных этажей, но не стэш и не чужие карты', () => {
  const initial = tavernState()
  const upstairs = applyGameEvent(initial, climb(initial).events[0])
  const projected = campaignStateForViewer(upstairs, { role: 'player', heroIds: [PARTY[0]] }, PARTY[0])

  assert.deepEqual(projected.scene.level, { index: 1, label: 'Второй этаж' })
  assert.deepEqual(projected.scene.levels.map((entry) => entry.index), [0, 1])
  assert.equal(projected.levelEntities, undefined, 'стэш жителей игроку не принадлежит')
  assert.equal(projected.locationMaps, undefined, 'карты неактивных этажей игроку не проецируются')
  assert.equal(Object.hasOwn(projected.scene, 'levels_declared'), false)
})
