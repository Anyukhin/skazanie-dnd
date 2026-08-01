import assert from 'node:assert/strict'
import test from 'node:test'

import { RulesValidationError, applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import {
  cellAt,
  createTacticalMap,
  deserializeTacticalMap,
  doorBlocksStep,
  doorsReachableFrom,
  edgeBetween,
  edgeNeighbor,
  legacyCellsFromTacticalMap,
  reachableCells,
  serializeTacticalMap,
  setCell,
  setDoor,
} from '../server/tactical-map.mjs'
import { buildThemedScene } from '../server/scene-themes.mjs'

/**
 * Достижимость **прямо сейчас**, с учётом состояния дверей. `reachableCells`
 * отвечает на другой вопрос — «дойдёт ли отряд, если двери открыть», — поэтому
 * сравнение двух чисел и показывает, запирают двери что-нибудь или нет.
 */
function reachableThroughDoorsNow(map, fromX, fromY) {
  const seen = new Set([`${fromX},${fromY}`])
  const queue = [{ x: fromX, y: fromY }]
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nextX = current.x + dx
      const nextY = current.y + dy
      const key = `${nextX},${nextY}`
      if (seen.has(key) || cellAt(map, nextX, nextY)?.passable !== true) continue
      if (doorBlocksStep(map, current.x, current.y, nextX, nextY)) continue
      seen.add(key)
      queue.push({ x: nextX, y: nextY })
    }
  }
  return seen
}

/**
 * Две комнаты, между ними перегородка с единственным проёмом. Герой стоит в
 * самом проёме, цель — клетка за дверью: пройти можно только сквозь неё, и
 * значит любое изменение проходимости видно сразу.
 *
 *   0 1 2 3 4 5 6
 * 0 # # # # # # #
 * 1 # . . H|. . #     H — герой в клетке (3,1), «|» — дверь на её восточном ребре
 * 2 # . . # . . #
 * 3 # # # # # # #
 */
function twoRooms(doorState = 'closed', lockDc = 0) {
  const map = createTacticalMap({ width: 7, height: 4, locationId: 'doors', seed: 'doors', sizeClass: 'arena' })
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const border = x === 0 || y === 0 || x === 6 || y === 3
      const partition = x === 3 && y === 2
      setCell(map, x, y, { passable: !border && !partition, material: 'stone', revealed: true })
    }
  }
  setDoor(map, { id: 'door-hall', x: 3, y: 1, dir: 'e', state: doorState, lockDc, blocksMove: false, blocksSight: false })
  return map
}

function fixture(doorState = 'closed', lockDc = 0, { strength = 16, combat = true } = {}) {
  const map = twoRooms(doorState, lockDc)
  const state = normalizeCampaignState({
    sessionCode: 'DOORS-1',
    players: [{ id: 'hero', character: 'Борен', hp: 12, maxHp: 12, armor: 14, speed: 30, x: 3, y: 1, abilities: { str: strength, dex: 10, con: 12, int: 10, wis: 10, cha: 10 } }],
    enemies: [],
    scene: { turn: 1, cells: legacyCellsFromTacticalMap(map), map: serializeTacticalMap(map) },
    mechanics: {
      combat: combat
        ? { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 18 }], action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement_spent: 0 } } }
        : { active: false },
      positions: { hero: { x: 3, y: 1 } },
    },
  })
  return state
}

/** Кости с заранее известным броском: проверка двери обязана быть предсказуемой. */
function dice(values) {
  const queue = [...values]
  const next = () => (queue.length ? queue.shift() : 10)
  return {
    roll: () => ({ total: next(), rolls: [] }),
    rollD20: ({ modifier = 0 } = {}) => {
      const die = next()
      return { die, rolls: [die], modifier, total: die + modifier }
    },
    rollCheck: ({ modifier = 0, difficulty = 10 } = {}) => {
      const die = next()
      const total = die + modifier
      return { die, rolls: [die], modifier, difficulty, total, success: total >= difficulty }
    },
    rollDamage: () => ({ total: next(), rolls: [] }),
  }
}

const move = (state, to) => resolveCommand(
  { command_type: 'MoveActor', actor_id: 'hero', to, server_authoritative: true },
  state,
  { diceService: dice([]), context: { serverAuthoritativeCombat: true } },
)

const operate = (state, intent, values = []) => resolveCommand(
  { command_type: 'OperateDoor', actor_id: 'hero', door_id: 'door-hall', intent, server_authoritative: true },
  state,
  { diceService: dice(values), context: { serverAuthoritativeCombat: true } },
)

const doorStateOf = (state) => deserializeTacticalMap(state.scene.map).doors.find((door) => door.id === 'door-hall')?.state

test('модель: полотно двери мешает шагу, стена вокруг него — нет', () => {
  assert.equal(doorBlocksStep(twoRooms('closed'), 3, 1, 4, 1), 'closed')
  assert.equal(doorBlocksStep(twoRooms('locked'), 3, 1, 4, 1), 'locked')
  assert.equal(doorBlocksStep(twoRooms('open'), 3, 1, 4, 1), null)
  assert.equal(doorBlocksStep(twoRooms('broken'), 3, 1, 4, 1), null)
  // Ребро без двери молчит, даже если это стена: проходимость считается по
  // клетке, и рёбра со стенами движению пока не мешают.
  assert.equal(doorBlocksStep(twoRooms('closed'), 1, 1, 1, 2), null)
})

test('модель: дверь достаётся с обеих сторон полотна и только вплотную', () => {
  const map = twoRooms('closed')
  assert.deepEqual(doorsReachableFrom(map, 3, 1).map((door) => door.id), ['door-hall'])
  assert.deepEqual(doorsReachableFrom(map, 4, 1).map((door) => door.id), ['door-hall'])
  assert.deepEqual(doorsReachableFrom(map, 2, 1), [])
})

test('закрытая дверь не пускает, открытая пускает', () => {
  assert.throws(() => move(fixture('closed'), { x: 4, y: 1 }),
    (error) => error instanceof RulesValidationError && error.code === 'PATH_BLOCKED')
  const open = move(fixture('open'), { x: 4, y: 1 })
  assert.ok(open.events.some((event) => event.event_type === 'ActorMoved'))
})

test('дверь открывается рукой и после этого пропускает отряд', () => {
  let state = fixture('closed')
  const opened = operate(state, 'open')
  const changed = opened.events.find((event) => event.event_type === 'DoorStateChanged')
  assert.ok(changed, 'событие смены состояния не пришло')
  assert.equal(changed.payload.state, 'open')
  assert.equal(changed.payload.previous_state, 'closed')
  state = opened.events.reduce(applyGameEvent, state)
  assert.equal(doorStateOf(state), 'open')
  // Свободное взаимодействие: действие остаётся на месте.
  assert.equal(state.mechanics.combat.action_economy.hero.action, true)
  assert.ok(move(state, { x: 4, y: 1 }).events.some((event) => event.event_type === 'ActorMoved'))
})

test('открытую дверь можно закрыть обратно', () => {
  let state = fixture('open')
  state = operate(state, 'close').events.reduce(applyGameEvent, state)
  assert.equal(doorStateOf(state), 'closed')
  assert.throws(() => move(state, { x: 4, y: 1 }),
    (error) => error instanceof RulesValidationError && error.code === 'PATH_BLOCKED')
})

test('запертую дверь рукой не открыть — только выломать', () => {
  const state = fixture('locked', 15)
  assert.throws(() => operate(state, 'open'),
    (error) => error instanceof RulesValidationError && error.code === 'DOOR_LOCKED')
})

test('удачный взлом ломает дверь, тратит действие и открывает путь', () => {
  let state = fixture('locked', 15)
  // Сила 16 даёт +3; бросок 18 — итог 21 против СЛ 15.
  const forced = operate(state, 'force', [18])
  const event = forced.events.find((item) => item.event_type === 'DoorForced')
  assert.equal(event.payload.success, true)
  assert.equal(event.payload.difficulty, 15)
  assert.ok(forced.events.some((item) => item.event_type === 'AbilityCheckResolved'))
  state = forced.events.reduce(applyGameEvent, state)
  assert.equal(doorStateOf(state), 'broken')
  assert.equal(state.mechanics.combat.action_economy.hero.action, false)
  assert.ok(move(state, { x: 4, y: 1 }).events.some((item) => item.event_type === 'ActorMoved'))
})

test('неудачный взлом тоже стоит хода, а дверь остаётся запертой', () => {
  let state = fixture('locked', 20)
  const forced = operate(state, 'force', [2])
  assert.equal(forced.events.find((item) => item.event_type === 'DoorForced').payload.success, false)
  state = forced.events.reduce(applyGameEvent, state)
  assert.equal(doorStateOf(state), 'locked')
  assert.equal(state.mechanics.combat.action_economy.hero.action, false)
  assert.throws(() => move(state, { x: 4, y: 1 }),
    (error) => error instanceof RulesValidationError && error.code === 'PATH_BLOCKED')
})

test('ломать нечего, если дверь уже открыта', () => {
  assert.throws(() => operate(fixture('open'), 'force'),
    (error) => error instanceof RulesValidationError && error.code === 'DOOR_ALREADY_OPEN')
})

test('до двери нужно дотянуться', () => {
  const state = fixture('closed')
  state.mechanics.positions.hero = { x: 1, y: 1 }
  state.players[0].x = 1
  assert.throws(() => operate(state, 'open'),
    (error) => error instanceof RulesValidationError && error.code === 'DOOR_OUT_OF_REACH')
})

test('двери нет на карте — команда отклоняется, а не молчит', () => {
  assert.throws(() => resolveCommand(
    { command_type: 'OperateDoor', actor_id: 'hero', door_id: 'нет-такой', intent: 'open', server_authoritative: true },
    fixture('closed'),
    { diceService: dice([]), context: { serverAuthoritativeCombat: true } },
  ), (error) => error instanceof RulesValidationError && error.code === 'DOOR_NOT_FOUND')
})

test('вне боя дверь открывается и действие не спрашивается', () => {
  let state = fixture('closed', 0, { combat: false })
  state = operate(state, 'open').events.reduce(applyGameEvent, state)
  assert.equal(doorStateOf(state), 'open')
})

test('дверь в собранной сцене стоит поперёк прохода и правда запирает часть карты', () => {
  // Прежде направление ребра угадывалось условием «восток проходим, а юг нет»,
  // и на вертикальном проходе полотно садилось на глухое ребро в породу: дверь
  // была видна, но отряд проходил мимо неё. Сторож меряет саму суть — сколько
  // клеток закрыто дверьми и сколько открывается, когда их отворяют.
  for (const [themeId, location] of [['crypt', 'Склеп Норвин'], ['building', 'Таверна «Три бочки»'], ['temple', 'Храм Утренней Звезды']]) {
    const built = buildThemedScene({ location, theme: themeId, themeId, seed: `gate:${themeId}`, locationId: themeId, width: 20, height: 20 })
    const map = built.map
    assert.ok(map.doors.length > 0, `${themeId}: дверей нет вовсе`)
    const spawn = map.spawnPoints.find((point) => point.role === 'party')
    assert.ok(spawn, `${themeId}: нет точки появления отряда`)
    for (const door of map.doors) {
      const neighbor = edgeNeighbor(door)
      assert.equal(cellAt(map, door.x, door.y)?.passable, true, `${themeId}/${door.id}: клетка-владелец ребра непроходима`)
      assert.equal(cellAt(map, neighbor.x, neighbor.y)?.passable, true, `${themeId}/${door.id}: дверь ведёт в глухую породу`)
    }
    const closed = reachableThroughDoorsNow(map, spawn.x, spawn.y)
    const opened = reachableCells(map, spawn.x, spawn.y)
    assert.ok(closed.size < opened.size, `${themeId}: двери ничего не перекрывают (${closed.size} из ${opened.size})`)
  }
})

test('состояние двери переживает повторное применение потока событий', () => {
  const start = fixture('locked', 15)
  const forced = operate(start, 'force', [18])
  const once = forced.events.reduce(applyGameEvent, start)
  const twice = forced.events.reduce(applyGameEvent, fixture('locked', 15))
  assert.equal(doorStateOf(once), 'broken')
  assert.equal(doorStateOf(twice), 'broken')
})

/**
 * Та же пара комнат, но дальняя ещё не раскрыта: ровно то состояние, в котором
 * игрок подходит к двери впервые.
 */
function unexploredFixture(doorState = 'closed') {
  const map = twoRooms(doorState)
  // `twoRooms` объявляет дверь с непреграждающим ребром — там проверяется
  // только полотно. Настоящая закрытая дверь держит и шаг, и взгляд, а именно
  // это и должно сняться при открытии.
  setDoor(map, { id: 'door-hall', x: 3, y: 1, dir: 'e', state: doorState, lockDc: 0, blocksMove: true, blocksSight: true })
  for (let y = 1; y <= 2; y += 1) {
    for (let x = 4; x <= 5; x += 1) setCell(map, x, y, { revealed: false })
  }
  return normalizeCampaignState({
    sessionCode: 'DOORS-FOG',
    players: [{ id: 'hero', character: 'Борен', hp: 12, maxHp: 12, armor: 14, speed: 30, x: 3, y: 1, abilities: { str: 16, dex: 10, con: 12, int: 10, wis: 10, cha: 10 } }],
    enemies: [],
    scene: { turn: 1, cells: legacyCellsFromTacticalMap(map), map: serializeTacticalMap(map) },
    mechanics: { combat: { active: false }, positions: { hero: { x: 3, y: 1 } } },
  })
}

test('открытая дверь снимает блокировку с ребра и раскрывает комнату за собой', () => {
  const before = unexploredFixture('closed')
  const beforeMap = deserializeTacticalMap(before.scene.map)
  assert.equal(edgeBetween(beforeMap, 3, 1, 4, 1)?.blocksSight, true)
  assert.equal(cellAt(beforeMap, 5, 1)?.revealed, false)

  const opened = operate(before, 'open')
  // Раскрытие едет отдельным событием: replay обязан воспроизвести и его.
  assert.deepEqual(opened.events.map((event) => event.event_type), ['DoorStateChanged', 'AreaRevealed'])

  const after = opened.events.reduce(applyGameEvent, before)
  const afterMap = deserializeTacticalMap(after.scene.map)
  const edge = edgeBetween(afterMap, 3, 1, 4, 1)
  assert.equal(edge?.blocksMove, false, 'открытая дверь обязана пропускать шаг')
  assert.equal(edge?.blocksSight, false, 'открытая дверь обязана пропускать взгляд')
  assert.equal(cellAt(afterMap, 5, 1)?.revealed, true, 'комната за дверью осталась в тумане')
  // Нераскрытая клетка непроходима (`isWalkableCell`), поэтому без раскрытия
  // распахнутая дверь не давала прохода — это и было «дверь никуда не ведёт».
  assert.ok(move(after, { x: 5, y: 1 }).events.some((event) => event.event_type === 'ActorMoved'))
})

test('закрытая обратно дверь снова держит взгляд, но уже увиденное не забывается', () => {
  const opened = operate(unexploredFixture('closed'), 'open')
  const afterOpen = opened.events.reduce(applyGameEvent, unexploredFixture('closed'))
  const closed = operate(afterOpen, 'close')
  const afterClose = closed.events.reduce(applyGameEvent, afterOpen)
  const map = deserializeTacticalMap(afterClose.scene.map)
  assert.equal(edgeBetween(map, 3, 1, 4, 1)?.blocksSight, true)
  assert.equal(cellAt(map, 5, 1)?.revealed, true, 'карта не должна забывать разведанное')
})
