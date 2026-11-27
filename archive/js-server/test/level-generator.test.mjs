import assert from 'node:assert/strict'
import test from 'node:test'

import { createSceneTransition, levelSeed, stableLocationMapSeed } from '../server/adventure-director.mjs'
import { generateBuildingScene } from '../server/building-generator.mjs'
import {
  generateLevelMap,
  interiorOutline,
  levelLabelFor,
  normalizeDeclaredLevels,
  transitionReachableFrom,
} from '../server/level-generator.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { buildThemedScene } from '../server/scene-themes.mjs'
import {
  cellAt,
  reachableCells,
  serializeTacticalMap,
  tacticalMapHash,
  validateTacticalMap,
} from '../server/tactical-map.mjs'

const DECLARED = Object.freeze([{ offset: 1, hint: 'спальни и кабинет хозяина' }, { offset: -1, hint: 'винный погреб' }])

function tavern(seed = 'постоялый двор') {
  return generateBuildingScene({ seed, locationId: 'loc-tavern', levels: normalizeDeclaredLevels(DECLARED) })
}

/** @param {import('../server/tactical-map.mjs').TacticalMap} map @param {number} toLevel */
function transitionTo(map, toLevel) {
  const prop = map.props.find((candidate) => candidate.transition?.toLevel === toLevel)
  assert.ok(prop, `на карте нет перехода на этаж ${toLevel}`)
  return prop
}

function presentCells(map) {
  const cells = new Set()
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)) cells.add(`${x},${y}`)
  }
  return cells
}

// --- заявка архитектора ---------------------------------------------------

test('заявка на этажи чистится: мусор отбрасывается, диапазон зажимается, повторы схлопываются', () => {
  const levels = normalizeDeclaredLevels([
    null,
    'второй этаж',
    { offset: 'вверх' },
    { offset: 0, hint: 'сам этаж входа' },
    { offset: 1.5 },
    { offset: 1, hint: 'спальни' },
    { offset: 1, hint: 'повтор того же этажа' },
    { offset: -9, hint: 'винный погреб' },
    { offset: 2 },
    { offset: -2 },
  ])
  assert.deepEqual(levels.map((level) => level.offset), [1, -3, 2],
    'дробное, нулевое и нечисловое смещение — мусор; −9 зажимается до −3; повтор отбрасывается')
  assert.equal(levels.length, 3, 'дополнительных этажей не больше трёх')
  assert.equal(levels[0].label, 'Второй этаж', 'наверху подпись порядковая, а не пересказ подсказки')
  assert.equal(levels[1].label, 'Винный погреб', 'внизу подписью становятся слова архитектора')
})

test('отсутствие поля levels полностью сохраняет прежнее поведение заявки', async () => {
  const state = { scene: { title: 'Тракт', location: 'Тракт', objective: 'Дойти до города', turn: 3, cells: [] } }
  const architect = new SceneArchitectAgent({
    llmClient: { async completeJson() { return { title: 'Постоялый двор', location: 'Постоялый двор', theme: 'таверна' } } },
  })
  const planned = await architect.plan({ action: 'Идём в таверну', state, decision: 'Идём в таверну', destinationHint: 'таверна' })
  assert.equal(Object.hasOwn(planned.sceneArgs, 'levels'), false, 'одноэтажная локация не получает поля вовсе')
  const transition = createSceneTransition(planned.sceneArgs, state)
  assert.equal(Object.hasOwn(transition.scene, 'levels'), false)
})

test('битые этажи в ответе модели отбрасываются, а годные доезжают до сцены', async () => {
  const state = { scene: { title: 'Тракт', location: 'Тракт', objective: 'Дойти до города', turn: 3, cells: [] } }
  const architect = new SceneArchitectAgent({
    llmClient: {
      async completeJson() {
        return {
          title: 'Постоялый двор', location: 'Постоялый двор', theme: 'таверна',
          levels: [{ offset: 0 }, { offset: 'вниз' }, { offset: 1, hint: 'спальни' }, { offset: -1, hint: 'винный погреб' }],
        }
      },
    },
  })
  const planned = await architect.plan({ action: 'Идём в таверну', state, decision: 'Идём в таверну', destinationHint: 'таверна' })
  assert.deepEqual(planned.sceneArgs.levels.map((level) => level.offset), [1, -1])
  const transition = createSceneTransition(planned.sceneArgs, state)
  assert.deepEqual(transition.scene.levels.map((level) => level.label), ['Второй этаж', 'Винный погреб'],
    'объявленные этажи переживают сборку сцены: событие SceneAdvanced несёт объект сцены целиком')
})

test('сид этажа выводится из сида локации, а этаж входа сохраняет прежний сид', () => {
  const base = stableLocationMapSeed({ seed: 'campaign-1' }, 'loc-tavern', 'Постоялый двор')
  assert.equal(levelSeed(base, 0), base, 'этаж входа собирается тем же сидом, что и раньше')
  assert.notEqual(levelSeed(base, 1), levelSeed(base, -1))
  assert.equal(levelSeed(base, 2), levelSeed(base, 2))
  assert.equal(levelLabelFor(0), 'Первый этаж')
})

// --- этаж входа -----------------------------------------------------------

test('без объявленных этажей лестница на этаже входа остаётся декором', () => {
  const map = generateBuildingScene({ seed: 'постоялый двор', locationId: 'loc-tavern' })
  assert.equal(validateTacticalMap(map).ok, true)
  assert.deepEqual(map.props.filter((prop) => prop.transition), [],
    'одноэтажная локация не получает ни одного перехода')
})

test('объявленные этажи превращают лестницу зала в переход в обе стороны', () => {
  const map = tavern()
  assert.equal(validateTacticalMap(map).ok, true)
  const up = transitionTo(map, 1)
  const down = transitionTo(map, -1)
  assert.equal(up.transition.label, 'Второй этаж')
  assert.equal(down.transition.label, 'Винный погреб')
  assert.equal(up.interactive, true)
  for (const prop of [up, down]) {
    assert.ok(['stairs_up', 'stairs_down', 'trapdoor'].includes(prop.assetId),
      `переход обязан висеть на лестнице или люке, а не на ${prop.assetId}`)
  }
})

// --- верхний этаж ---------------------------------------------------------

test('верхний этаж наследует контур здания: вне контура клеток нет', () => {
  const base = tavern()
  const built = generateLevelMap({
    locationId: 'loc-tavern', level: 1, seed: 'seed@L1', baseMap: base, sourceProp: transitionTo(base, 1), hint: 'спальни',
  })
  assert.deepEqual(built.errors, [])
  assert.equal(validateTacticalMap(built.map).ok, true)
  assert.equal(built.map.levelIndex, 1)
  assert.equal(built.map.levelLabel, 'Второй этаж')
  assert.deepEqual(presentCells(built.map), interiorOutline(base),
    'контур второго этажа обязан совпасть с interior-контуром первого')
  assert.equal(built.map.width, base.width)
  assert.equal(built.map.height, base.height)
  // Двор существует на первом этаже и не существует на втором — это и есть
  // «пустота» из плана, выраженная слоем present.
  const spawn = base.spawnPoints.find((point) => point.role === 'party')
  assert.ok(cellAt(base, spawn.x, spawn.y), 'двор на первом этаже есть')
  assert.equal(cellAt(built.map, spawn.x, spawn.y), null, 'над двором на втором этаже клетки нет')
})

test('парная лестница стоит в координатах исходной и ведёт обратно', () => {
  const base = tavern()
  const source = transitionTo(base, 1)
  const built = generateLevelMap({
    locationId: 'loc-tavern', level: 1, seed: 'seed@L1', baseMap: base, sourceProp: source, hint: 'спальни',
  })
  const paired = transitionTo(built.map, 0)
  assert.deepEqual(paired.footprint, [{ x: Math.floor(source.x), y: Math.floor(source.y) }])
  assert.equal(paired.assetId, 'stairs_down', 'сверху вниз ведёт лестница вниз')
  assert.equal(paired.transition.label, 'Первый этаж')
  assert.equal(cellAt(built.map, paired.footprint[0].x, paired.footprint[0].y).passable, true,
    'точка прибытия обязана быть проходимой')
})

// --- подвал ---------------------------------------------------------------

test('подвал не вылезает из-под здания и получает парный подъём', () => {
  const base = tavern()
  const source = transitionTo(base, -1)
  const built = generateLevelMap({
    locationId: 'loc-tavern', level: -1, seed: 'seed@L-1', baseMap: base, sourceProp: source, hint: 'винный погреб',
  })
  assert.deepEqual(built.errors, [])
  assert.equal(validateTacticalMap(built.map).ok, true)
  assert.equal(built.map.levelIndex, -1)
  assert.equal(built.map.levelLabel, 'Винный погреб')
  const outline = interiorOutline(base)
  const cellar = presentCells(built.map)
  assert.ok(cellar.size < outline.size, 'контур подвала строго меньше контура этажа выше')
  for (const key of cellar) assert.ok(outline.has(key), `клетка подвала ${key} вылезла за контур здания`)
  const paired = transitionTo(built.map, 0)
  assert.deepEqual(paired.footprint, [{ x: Math.floor(source.x), y: Math.floor(source.y) }])
  assert.ok(['stairs_up', 'trapdoor'].includes(paired.assetId), 'снизу вверх ведёт лестница вверх или тот же люк')
  assert.equal(cellAt(built.map, built.arrival.x, built.arrival.y).passable, true)
})

test('спуск по люку возвращает наверх тем же люком', () => {
  const base = tavern('люк')
  const source = transitionTo(base, -1)
  if (source.assetId !== 'trapdoor') return // сид поставил лестницу — проверять нечего
  const built = generateLevelMap({
    locationId: 'loc-tavern', level: -1, seed: 'люк@L-1', baseMap: base, sourceProp: source, hint: 'подпол',
  })
  assert.equal(transitionTo(built.map, 0).assetId, 'trapdoor')
})

// --- инварианты и детерминизм --------------------------------------------

test('переход достижим по walkable-клеткам от точки прибытия на каждом собранном этаже', () => {
  const base = tavern()
  for (const level of [1, -1]) {
    const built = generateLevelMap({
      locationId: 'loc-tavern',
      level,
      seed: `seed@L${level}`,
      baseMap: base,
      sourceProp: transitionTo(base, level),
      hint: level > 0 ? 'спальни' : 'винный погреб',
    })
    assert.deepEqual(built.errors, [])
    assert.equal(transitionReachableFrom(built.map, built.arrival), true)
    // Независимая проверка тем же обходом, что и в scene-graph: переход обязан
    // попасть в множество достижимого, а не просто существовать.
    const reached = reachableCells(built.map, built.arrival.x, built.arrival.y)
    const paired = transitionTo(built.map, 0)
    assert.ok(reached.has(`${paired.footprint[0].x},${paired.footprint[0].y}`))
    assert.ok(reached.size > 1, 'этаж не должен схлопываться в одну клетку у лестницы')
  }
})

test('один и тот же (locationId, level, seed) даёт байт в байт одну карту', () => {
  const base = tavern()
  for (const level of [1, -1]) {
    const options = {
      locationId: 'loc-tavern',
      level,
      seed: `seed@L${level}`,
      baseMap: base,
      sourceProp: transitionTo(base, level),
      hint: level > 0 ? 'спальни' : 'винный погреб',
    }
    const first = generateLevelMap(options).map
    const second = generateLevelMap(options).map
    assert.deepEqual(serializeTacticalMap(first), serializeTacticalMap(second))
    assert.equal(tacticalMapHash(first), tacticalMapHash(second))
  }
  // Разные этажи одной локации обязаны отличаться: общий сид не должен
  // «схлопнуть» подвал и спальни в одну карту.
  const up = generateLevelMap({
    locationId: 'loc-tavern', level: 1, seed: 'seed@L1', baseMap: base, sourceProp: transitionTo(base, 1),
  }).map
  const down = generateLevelMap({
    locationId: 'loc-tavern', level: -1, seed: 'seed@L-1', baseMap: base, sourceProp: transitionTo(base, -1),
  }).map
  assert.notEqual(tacticalMapHash(up), tacticalMapHash(down))
})

// --- пещеры ---------------------------------------------------------------

test('пещерный ярус собирается связным, а прибытие в породу отклоняется', () => {
  const cave = buildThemedScene({ themeId: 'cave', seed: 'подземные ходы', width: 26, height: 26, locationId: 'loc-cave' }).map
  const floor = []
  for (let y = 0; y < cave.height; y += 1) {
    for (let x = 0; x < cave.width; x += 1) if (cellAt(cave, x, y)?.passable) floor.push({ x, y })
  }
  const spot = floor[Math.floor(floor.length / 2)]
  const built = generateLevelMap({
    locationId: 'loc-cave',
    level: -1,
    seed: 'пещера@L-1',
    baseMap: cave,
    theme: 'cave',
    sourceProp: { assetId: 'stairs_down', x: spot.x + 0.5, y: spot.y + 0.5, footprint: [{ x: spot.x, y: spot.y }] },
    hint: 'нижние ходы',
  })
  assert.deepEqual(built.errors, [])
  assert.equal(validateTacticalMap(built.map).ok, true)
  assert.equal(built.map.levelIndex, -1)
  assert.equal(transitionReachableFrom(built.map, built.arrival), true)

  // Угол сетки не вырубается ни одним сидом: полость туда не доходит.
  const refused = generateLevelMap({
    locationId: 'loc-cave',
    level: -1,
    seed: 'пещера@L-1',
    baseMap: cave,
    theme: 'cave',
    sourceProp: { assetId: 'stairs_down', x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }] },
  })
  assert.equal(refused.map, null)
  assert.equal(refused.errors[0].code, 'LEVEL_ARRIVAL_UNREACHABLE')
})

// --- отказы ---------------------------------------------------------------

test('подниматься некуда там, где нет interior-зон', () => {
  const forest = buildThemedScene({ themeId: 'forest', seed: 'опушка', width: 26, height: 26, locationId: 'loc-forest' }).map
  const refused = generateLevelMap({
    locationId: 'loc-forest',
    level: 1,
    seed: 'лес@L1',
    baseMap: forest,
    sourceProp: { assetId: 'stairs_up', x: 5.5, y: 5.5, footprint: [] },
  })
  assert.equal(refused.map, null)
  assert.equal(refused.errors[0].code, 'LEVEL_OUTLINE_MISSING')
})

test('генератор отказывает на невозможном этаже и на переходе без координат', () => {
  const base = tavern()
  const source = transitionTo(base, 1)
  for (const level of [0, 4, -4, 'второй', 1.5]) {
    const refused = generateLevelMap({ locationId: 'loc-tavern', level, seed: 'seed', baseMap: base, sourceProp: source })
    assert.equal(refused.map, null, `этаж ${String(level)} не должен собираться`)
    assert.equal(refused.errors[0].code, 'LEVEL_INDEX_NOT_ALLOWED')
  }
  assert.equal(generateLevelMap({ locationId: 'loc-tavern', level: 1, seed: 'seed', baseMap: base }).errors[0].code,
    'LEVEL_SOURCE_PROP_MISSING')
  assert.equal(generateLevelMap({ locationId: 'loc-tavern', level: 1, seed: 'seed', sourceProp: source }).errors[0].code,
    'LEVEL_BASE_MAP_MISSING')
  assert.equal(generateLevelMap({
    locationId: 'loc-tavern', level: 1, seed: 'seed', baseMap: base,
    sourceProp: { assetId: 'stairs_up', x: base.width + 4.5, y: 2.5, footprint: [] },
  }).errors[0].code, 'LEVEL_SOURCE_PROP_MISSING')
})

test('этажи разных сидов остаются валидными картами', () => {
  for (const seed of ['таверна', 'подворье', 'корчма', 'трактир у брода']) {
    const base = tavern(seed)
    assert.equal(validateTacticalMap(base).ok, true, `этаж входа ${seed}`)
    for (const level of [1, -1]) {
      const built = generateLevelMap({
        locationId: 'loc-tavern', level, seed: `${seed}@L${level}`, baseMap: base, sourceProp: transitionTo(base, level),
        hint: level > 0 ? 'спальни' : 'винный погреб',
      })
      assert.deepEqual(built.errors, [], `${seed}, этаж ${level}`)
      assert.equal(validateTacticalMap(built.map).ok, true, `${seed}, этаж ${level}`)
      assert.equal(built.map.props.some((prop) => prop.transition), true, `${seed}, этаж ${level}: перехода нет`)
    }
  }
})
