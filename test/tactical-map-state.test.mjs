import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { assembleEncounter } from '../server/encounter-assembler.mjs'
import { generateDynamicSceneMap } from '../server/dynamic-map.mjs'
import { publicSceneFor } from '../server/viewer-projection.mjs'
import { SIZE_CLASSES, cellAt, deserializeTacticalMap } from '../server/tactical-map.mjs'
import {
  GAME_STATE_PROJECTOR_VERSION,
  applyGameEvent,
  normalizeCampaignState,
} from '../server/rules-engine.mjs'

function room(width = 6, height = 5) {
  const cells = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1
      cells.push({
        x,
        y,
        type: border ? 'wall' : 'floor',
        revealed: !border,
        material: 'wood',
        variant: (x + y) % 6,
        pattern: 'small-room',
      })
    }
  }
  return cells
}

function baseState(cells = room(), overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'MAP-STATE',
    state_version: 0,
    engine_mode: 'enforce',
    activePlayerId: 'hero-a',
    partyMemberIds: ['hero-a'],
    players: [{ id: 'hero-a', character: 'Герой', hp: 10, maxHp: 10, inventory: [], x: 1, y: 1, level: 1 }],
    scene: { title: 'Комната', location: 'Таверна', mood: '', objective: '', turn: 1, cells },
    ...overrides,
  })
}

function event(type, payload) {
  return { event_type: type, payload, actor_id: '', target_ids: [], source_rule_ids: [] }
}

test('версия проектора состояния поднята: старые снимки переигрываются', () => {
  assert.ok(GAME_STATE_PROJECTOR_VERSION >= 4, 'переход на слои обязан отбросить снимки прежней формы')
})

test('состояние без scene.map получает карту, а клетки остаются прежними', () => {
  const cells = room()
  const state = baseState(cells)
  assert.ok(state.scene.map, 'карта обязана достроиться при нормализации')
  assert.equal(JSON.stringify(state.scene.cells), JSON.stringify(cells), 'клетки не должны измениться')

  const map = deserializeTacticalMap(state.scene.map)
  assert.equal(cellAt(map, 0, 0)?.passable, false)
  assert.equal(cellAt(map, 1, 1)?.passable, true)
  assert.equal(cellAt(map, 1, 1)?.material, 'wood')
  assert.equal(cellAt(map, 1, 1)?.revealed, true)
})

test('клетки без необязательных полей не обрастают новыми', () => {
  const minimal = [
    { x: 0, y: 0, type: 'floor', revealed: true },
    { x: 1, y: 0, type: 'wall', revealed: false },
  ]
  const state = baseState(minimal)
  assert.deepEqual(state.scene.cells, minimal)
  assert.equal('material' in state.scene.cells[0], false)
  assert.equal('edge_mask' in state.scene.cells[0], false)
})

test('AreaRevealed раскрывает клетку через карту, а не мимо неё', () => {
  const state = baseState()
  const before = state.scene.cells.find((cell) => cell.x === 0 && cell.y === 0)
  assert.equal(before.revealed, false)

  const next = applyGameEvent(state, event('AreaRevealed', { cells: [{ x: 0, y: 0 }] }))
  const after = next.scene.cells.find((cell) => cell.x === 0 && cell.y === 0)
  assert.equal(after.revealed, true)
  assert.equal(cellAt(deserializeTacticalMap(next.scene.map), 0, 0)?.revealed, true)
})

test('появление существа раскрывает клетку и не затирает декор', () => {
  const cells = room().map((cell) => (cell.x === 2 && cell.y === 2 ? { ...cell, feature: 'table' } : cell))
  const state = baseState(cells)
  const next = applyGameEvent(state, event('EntitySpawned', {
    entity: { id: 'wolf-1', kind: 'enemy', x: 2, y: 2 },
  }))
  const cell = next.scene.cells.find((entry) => entry.x === 2 && entry.y === 2)
  assert.equal(cell.feature, 'table', 'стол обязан пережить появление противника')
  assert.equal(cell.revealed, true)
  assert.equal(next.entities.length, 1)
  assert.equal(next.entities[0].kind, 'enemy')
})

test('появление предмета сохраняется в карте, существо — нет', () => {
  const state = baseState()
  const withChest = applyGameEvent(state, event('EntitySpawned', {
    entity: { id: 'chest-1', kind: 'chest', x: 2, y: 2 },
  }))
  const chestMap = deserializeTacticalMap(withChest.scene.map)
  assert.equal(chestMap.props.filter((prop) => prop.assetId === 'chest').length, 1)
  assert.equal(withChest.scene.cells.find((cell) => cell.x === 2 && cell.y === 2).feature, 'chest')

  const withWolf = applyGameEvent(state, event('EntitySpawned', {
    entity: { id: 'wolf-1', kind: 'enemy', x: 3, y: 2 },
  }))
  const wolfMap = deserializeTacticalMap(withWolf.scene.map)
  assert.deepEqual(wolfMap.props, [], 'существо не является предметом карты')
  assert.equal('feature' in withWolf.scene.cells.find((cell) => cell.x === 3 && cell.y === 2), false)
})

test('выбывший противник не оставляет в клетке ключа feature со значением undefined', () => {
  const state = baseState(undefined, {
    enemies: [{ id: 'wolf', name: 'Волк', hp: 1, maxHp: 5, alive: true, x: 3, y: 2 }],
  })
  const spawned = applyGameEvent(state, event('EntitySpawned', { entity: { id: 'wolf', kind: 'enemy', x: 3, y: 2 } }))
  const dropped = applyGameEvent(spawned, {
    ...event('ActorDropped', { }),
    event_type: 'ActorDropped',
    target_ids: ['wolf'],
  })
  for (const cell of dropped.scene.cells) {
    assert.equal(Object.hasOwn(cell, 'feature') && cell.feature === undefined, false,
      `клетка ${cell.x},${cell.y} несёт ключ feature без значения`)
  }
  assert.equal(JSON.parse(JSON.stringify(dropped)).scene.cells.length, dropped.scene.cells.length)
})

test('занятая существом клетка не выбирается под появление противника', () => {
  const party = [{ id: 'hero-a', level: 3, x: 1, y: 1 }]
  const plain = room(9, 7).map((cell) => ({ x: cell.x, y: cell.y, type: cell.type, revealed: cell.revealed }))
  const free = assembleEncounter({
    scene: { cells: plain }, party, difficulty: 'hard', theme: 'beasts', seed: 'occupancy-seed',
  })
  const chosen = free.enemies.map((enemy) => `${enemy.x},${enemy.y}`)
  assert.ok(chosen.length > 0, 'сборщик обязан кого-то расставить')

  // Помечаем занятыми все клетки, которые сборщик только что выбрал: следующий
  // расчёт обязан выбрать другие. Раньше эту роль случайно играла запись
  // сущности в cell.feature.
  const blocked = new Set(chosen)
  const occupiedCells = plain.map((cell) => (
    blocked.has(`${cell.x},${cell.y}`) ? { ...cell, occupied: true } : cell
  ))
  const after = assembleEncounter({
    scene: { cells: occupiedCells }, party, difficulty: 'hard', theme: 'beasts', seed: 'occupancy-seed',
  })
  for (const enemy of after.enemies) {
    assert.equal(blocked.has(`${enemy.x},${enemy.y}`), false, `клетка ${enemy.x},${enemy.y} занята существом`)
  }
})

test('сборщик встреч отвергает нелогичное значение занятости', () => {
  const cells = room(9, 7).map((cell) => ({ x: cell.x, y: cell.y, type: cell.type, revealed: cell.revealed }))
  cells[0].occupied = 'да'
  assert.throws(() => assembleEncounter({
    scene: { cells }, party: [{ id: 'hero-a', level: 3, x: 1, y: 1 }],
    difficulty: 'low', theme: 'beasts', seed: 'bad-occupancy',
  }), (error) => error.code === 'INVALID_SCENE_CELL_OCCUPANCY')
})

test('предел клеток поднят до 10 000 и действует одинаково во всех границах', () => {
  assert.equal(SIZE_CLASSES.arena.maxCells, 900)
  assert.equal(SIZE_CLASSES.area.maxCells, 3_600)
  assert.equal(SIZE_CLASSES.region.maxCells, 10_000)

  // Старый процедурный генератор намеренно остался на классе arena: его
  // планировки не рассчитаны на доску больше 30×30.
  const large = generateDynamicSceneMap({ seed: 'limit', width: 30, height: 30, layout: 'rooms', pattern: 'great-hall' })
  assert.equal(Math.max(...large.map((cell) => cell.x)) + 1, 30)
  assert.equal(Math.max(...large.map((cell) => cell.y)) + 1, 30)
  assert.ok(large.length <= SIZE_CLASSES.arena.maxCells)

  const dense = []
  for (let y = 0; y < 100; y += 1) for (let x = 0; x < 100; x += 1) dense.push({ x, y, type: 'floor', revealed: true })
  assert.equal(publicSceneFor({ cells: dense }).cells.length, 10_000, 'проекция не должна резать карту класса region')

  const tooMany = [...dense, { x: 0, y: 100, type: 'floor', revealed: true }]
  assert.throws(() => assembleEncounter({
    scene: { cells: tooMany }, party: [{ id: 'hero-a', level: 1, x: 1, y: 1 }],
    difficulty: 'easy', theme: 'beasts', seed: 'too-many',
  }), (error) => error.code === 'INVALID_SCENE_CELLS')
})

test('scene.cells присваивается ровно в одном месте движка', () => {
  const source = readFileSync(new URL('../server/rules-engine.mjs', import.meta.url), 'utf8')
  const assignments = [...source.matchAll(/state\.scene\.cells\s*=/gu)]
  assert.equal(assignments.length, 1, 'массив клеток — производная read-модель; писать в него можно только из syncSceneCells')
  const around = source.slice(Math.max(0, assignments[0].index - 400), assignments[0].index)
  assert.match(around, /function syncSceneCells/u, 'единственная запись обязана находиться внутри syncSceneCells')
})

test('изменённые снаружи клетки пересобирают карту, а не теряются молча', () => {
  const state = baseState()
  state.scene.cells = state.scene.cells.map((cell) => (
    cell.x === 2 && cell.y === 2 ? { ...cell, type: 'water' } : cell
  ))
  const normalized = normalizeCampaignState(state)
  assert.equal(normalized.scene.cells.find((cell) => cell.x === 2 && cell.y === 2).type, 'water')
  const map = deserializeTacticalMap(normalized.scene.map)
  assert.equal(cellAt(map, 2, 2)?.passable, false)
  assert.equal(cellAt(map, 2, 2)?.surface, 'water')
})

test('карта сцены переживает сериализацию состояния', () => {
  const state = baseState()
  const revived = normalizeCampaignState(JSON.parse(JSON.stringify(state)))
  assert.equal(JSON.stringify(revived.scene.cells), JSON.stringify(state.scene.cells))
  assert.equal(JSON.stringify(revived.scene.map), JSON.stringify(state.scene.map))
})
