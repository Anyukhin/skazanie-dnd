import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildBuildingScene, generateBuildingScene } from '../server/building-generator.mjs'
import { campaignStateForViewer, publicSceneFor } from '../server/viewer-projection.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { normalizeDeclaredLevels } from '../server/level-generator.mjs'
import { MapStore } from '../server/map-store.mjs'
import { applyGameEvent, movementStepCostFor, normalizeCampaignState, resolveCommand, shortestTacticalPath } from '../server/rules-engine.mjs'
import {
  SIZE_CLASSES,
  addProp,
  addZone,
  cellAt,
  createTacticalMap,
  deserializeTacticalMap,
  legacyCellsFromTacticalMap,
  reachableCells,
  serializeTacticalMap,
  setCell,
  setEdge,
} from '../server/tactical-map.mjs'

/**
 * Пороговые тесты на масштаб — раздел 13 `docs/tactical-map-plan.md`.
 *
 * Каждая проверка обязана падать при регрессе и не мигать на загруженной
 * машине. Поэтому:
 *
 * - время меряется медианой из девяти прогонов, а первый прогон отбрасывается
 *   как прогрев;
 * - подготовка данных вынесена за пределы замеряемой функции;
 * - рядом с временным порогом стоит **детерминированный счётчик**, который
 *   ловит регресс независимо от загрузки машины: время — только страховка от
 *   константного замедления;
 * - фактическое число печатается всегда, чтобы деградация была видна до того,
 *   как упрётся в порог.
 */

const RUNS = 9

/**
 * @param {string} label
 * @param {() => unknown} run
 * @returns {number} медиана времени в миллисекундах
 */
function measure(label, run) {
  run()
  const samples = []
  for (let index = 0; index < RUNS; index += 1) {
    const started = process.hrtime.bigint()
    run()
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  samples.sort((left, right) => left - right)
  const median = samples[Math.floor(samples.length / 2)]
  console.log(`  ${label}: медиана ${median.toFixed(2)} мс (мин ${samples[0].toFixed(2)}, макс ${samples[samples.length - 1].toFixed(2)})`)
  return median
}

/**
 * Общий раннер GitHub делит ядро с соседями, и та же медиана там плавает в
 * два-четыре раза между прогонами: на PR #15 взвешенный поиск дал 35,64 мс, на
 * следующем прогоне того же кода — 52,81 мс при пороге 40. Красный гейт по
 * такому измерению не значит регресса и, что хуже, прячет настоящие падения —
 * ровно так вся вторая волна прошла мимо проверок.
 *
 * Поэтому wall-clock ведёт себя по-разному в двух средах:
 *
 * - на машине разработчика порог строгий, как и был;
 * - на общем раннере порог умножается на `SHARED_RUNNER_TOLERANCE`, то есть
 *   ловит только грубое замедление в разы, а не шум планировщика.
 *
 * Детерминированные проверки рядом — байты, счётчики просмотренных клеток,
 * связность — остаются строгими **везде**: именно они ловят регресс алгоритма.
 * Фактическая медиана печатается всегда, а на раннере ещё и помечается, когда
 * она вышла за строгий порог.
 */
const SHARED_RUNNER = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
const SHARED_RUNNER_TOLERANCE = 4

/**
 * @param {number} median фактическая медиана, мс
 * @param {number} budget строгий порог плана, мс
 * @param {string} label текст для сообщения об ошибке
 */
function assertWallClock(median, budget, label) {
  if (!SHARED_RUNNER) {
    assert.ok(median <= budget, `${label} ${median.toFixed(2)} мс, порог — ${budget} мс`)
    return
  }
  if (median > budget) {
    console.log(`  [ci] ${label} ${median.toFixed(2)} мс выше строгого порога ${budget} мс — проверить локально`)
  }
  const ceiling = budget * SHARED_RUNNER_TOLERANCE
  assert.ok(median <= ceiling,
    `${label} ${median.toFixed(2)} мс — это больше ${SHARED_RUNNER_TOLERANCE}× порога ${budget} мс. `
    + 'Такое замедление шумом раннера не объясняется.')
}

function kilobytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)) / 1024
}

/**
 * Правдоподобная карта класса `region`: комнаты по сетке, вода у края,
 * разные материалы, предметы. Худший случай для поиска пути — **открытая**
 * карта: змейка из коридоров короче по числу просмотренных клеток.
 */
function regionMap({ width = 100, height = 100, revealed = true, props = 200 } = {}) {
  const map = createTacticalMap({ width, height, sizeClass: 'region', seed: 'budget' })
  addZone(map, { id: 'inside', kind: 'interior', material: 'wood' })
  addZone(map, { id: 'outside', kind: 'exterior', material: 'grass' })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const building = x > 8 && x < width - 8 && y > 8 && y < height - 8
      const wall = building && (x % 14 === 0 || y % 14 === 0) && !(x % 28 === 0 || y % 28 === 0)
      setCell(map, x, y, {
        passable: !wall,
        material: building ? ['stone', 'wood', 'earth'][(x * 7 + y * 3) % 3] : 'grass',
        variant: (x * 5 + y * 11) % 6,
        revealed,
        zone: building ? 'inside' : 'outside',
        surface: !building && x < 4 ? 'water' : 'none',
      })
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const own = cellAt(map, x, y)
      if (!own || own.passable) continue
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (cellAt(map, x + dx, y + dy)?.passable) {
          setEdge(map, x, y, x + dx, y + dy, { kind: 'wall', cover: 'three_quarters' })
        }
      }
    }
  }
  for (let index = 0; index < props; index += 1) {
    addProp(map, {
      id: `p${index}`,
      assetId: 'barrel',
      x: (index % (width - 10)) + 5.5,
      y: Math.floor(index / (width - 10)) + 20.5,
      rotation: index % 360,
      footprint: [],
    })
  }
  return map
}

test('размер сериализованной карты 100×100 не больше 100 КБ', () => {
  const map = regionMap()
  const size = kilobytes(serializeTacticalMap(map))
  console.log(`  карта 100×100: ${size.toFixed(1)} КБ при ${map.props.length} предметах`)
  assert.ok(size <= 100, `сериализованная карта ${size.toFixed(1)} КБ, порог плана — 100 КБ`)
})

test('поиск пути через всю карту укладывается в 25 мс', () => {
  const map = regionMap()
  let reached = 0
  const median = measure('поиск пути 100×100', () => {
    reached = reachableCells(map, 1, 1).size
  })
  console.log(`  достижимых клеток: ${reached}`)
  // Счётчик важнее времени: он ловит регресс независимо от загрузки машины.
  assert.ok(reached > 7_000, `обход прошёл всего ${reached} клеток — карта перестала быть связной`)
  assertWallClock(median, 25, 'поиск пути')
})

test('взвешенный поиск пути через всю карту укладывается в 40 мс', () => {
  // `MoveActor` считает маршрут взвешенно на **каждом** ходу — и героя, и NPC.
  // Невзвешенный BFS выше этот путь уже не покрывает: у него нет ни очереди с
  // приоритетом, ни предиката стоимости, который зовётся на каждом кандидате.
  const map = regionMap()
  const state = normalizeCampaignState({
    sessionCode: 'BUDGET-PATH',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, inventory: [], x: 5, y: 5, level: 1 }],
    scene: { title: 'Сцена', location: 'Поле', cells: legacyCellsFromTacticalMap(map) },
    // Худший случай для предиката: несколько длящихся областей, каждую из
    // которых он перебирает на каждом кандидате.
    mechanics: {
      active_effects: Array.from({ length: 4 }, (_, index) => ({
        id: `web-${index}`,
        difficult_terrain: true,
        cells: Array.from({ length: 25 }, (_, cell) => ({ x: 20 + index * 5 + cell % 5, y: 30 + Math.floor(cell / 5) })),
      })),
    },
  })

  let inspected = 0
  let path = null
  const median = measure('взвешенный поиск 100×100', () => {
    const { stepCost, map: decoded } = movementStepCostFor(state, 'hero')
    inspected = 0
    path = shortestTacticalPath(state, 'hero', { x: 94, y: 94 }, {
      tacticalMap: decoded,
      stepCost: (step, pathMap) => {
        inspected += 1
        return stepCost(step, pathMap)
      },
    })
  })

  console.log(`  просмотрено кандидатов: ${inspected}, длина маршрута: ${path?.length ?? 0}`)
  // Счётчик важнее времени: он ловит регресс независимо от загрузки машины.
  assert.ok(path?.length > 0, 'маршрут через открытую карту обязан находиться')
  assert.ok(inspected > 5_000, `просмотрено всего ${inspected} кандидатов — карта перестала быть связной`)
  assert.ok(inspected <= 60_000, `просмотрено ${inspected} кандидатов: поиск перестал отсекать дорогие ветки`)
  assertWallClock(median, 40, 'взвешенный поиск')
})

test('проекция видимости на игрока укладывается в 10 мс', () => {
  // Худший случай для проекции карты — полностью нераскрытая карта: цикл
  // обезличивания идёт именно по нераскрытым клеткам.
  const hidden = serializeTacticalMap(regionMap({ revealed: false }))
  const half = regionMap({ revealed: false })
  for (let y = 0; y < 50; y += 1) for (let x = 0; x < 100; x += 1) setCell(half, x, y, { revealed: true })
  const halfSerialized = serializeTacticalMap(half)
  const cells = legacyCellsFromTacticalMap(half)

  const hiddenMedian = measure('проекция, карта не раскрыта', () => publicSceneFor({ cells: [], map: hidden }))
  const halfMedian = measure('проекция, раскрыта половина', () => publicSceneFor({ cells, map: halfSerialized }))

  assertWallClock(hiddenMedian, 10, 'проекция нераскрытой карты')
  assertWallClock(halfMedian, 10, 'проекция полураскрытой карты')
})

test('дельта раскрытия за ход не больше 4 КБ', () => {
  // Событие AreaRevealed несёт список клеток. Считаем полезную нагрузку при
  // максимуме, который допускает команда раскрытия.
  const revealed = []
  for (let index = 0; index < 100; index += 1) revealed.push({ x: index % 10, y: Math.floor(index / 10) })
  const payload = { cells: revealed }
  const size = kilobytes(payload)
  console.log(`  дельта раскрытия на ${revealed.length} клеток: ${size.toFixed(2)} КБ`)
  assert.ok(size <= 4, `дельта ${size.toFixed(2)} КБ, порог плана — 4 КБ`)
})

/**
 * Снимок, каким его пишет `FileEventStore` на диск. Мерить состояние в памяти
 * бессмысленно: карта выносится **при записи снимка**, и в оперативном
 * состоянии она обязана остаться целой.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, any>} state
 * @param {boolean} withMapStore
 * @returns {Promise<Record<string, any>>} разобранный файл снимка
 */
async function writtenSnapshot(t, state, withMapStore) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-budget-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new FileEventStore({
    rootDir: root,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    ...(withMapStore ? { mapStore: new MapStore({ rootDir: join(root, 'engine') }) } : {}),
  })
  await store.initializeCampaign({ campaignId: 'budget', initialState: state })
  const file = readdirSync(root, { recursive: true })
    .map(String)
    .find((name) => name.includes('snapshots') && name.endsWith('.json'))
  assert.ok(file, 'снимок обязан быть записан')
  return JSON.parse(readFileSync(join(root, file), 'utf8'))
}

test('прирост снимка от карты укладывается в порог плана', async (t) => {
  const map = buildBuildingScene({ seed: 'snapshot', width: 30, height: 30 }).map
  const state = normalizeCampaignState({
    sessionCode: 'BUDGET',
    players: [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, inventory: [], x: 1, y: 1, level: 1 }],
    partyMemberIds: ['hero'],
    scene: { title: 'Сцена', location: 'Дом', cells: legacyCellsFromTacticalMap(map) },
  })

  const snapshot = await writtenSnapshot(t, state, true)
  const stored = snapshot.state
  const full = kilobytes(stored)
  const withoutMap = kilobytes({
    ...stored,
    scene: { ...stored.scene, map: undefined, cells: undefined },
    locationMaps: {},
  })
  const growth = full - withoutMap
  console.log(`  снимок 30×30: всего ${full.toFixed(1)} КБ, вклад карты ${growth.toFixed(2)} КБ`)

  // Порог плана (раздел 13 `docs/tactical-map-plan.md`) — 5 КБ. До выноса он не
  // выполнялся: в снимке лежали карта, производные клетки и полная копия клеток
  // каждой запомненной локации, что давало 174,7 КБ на сцене 30×30. Теперь в
  // снимке остаются только ссылки, и порог включён буквально.
  assert.ok(growth <= 5, `вклад карты в снимок ${growth.toFixed(2)} КБ, порог плана — 5 КБ`)
  // Храповик по фактическому замеру 2026-08-02 (0,30 КБ) с запасом втрое:
  // ссылка — это маркер, хеш, ширина и высота, и расти ей неоткуда. Возврат
  // тела карты в снимок будет пойман здесь, а не через год на диске игрока.
  assert.ok(growth <= 1, `вклад карты в снимок ${growth.toFixed(2)} КБ — вырос против замеренных 0,30 КБ`)
})

test('вынос карт уменьшает записанный снимок на порядок', async (t) => {
  const map = buildBuildingScene({ seed: 'snapshot', width: 30, height: 30 }).map
  const state = normalizeCampaignState({
    sessionCode: 'BUDGET-STORE',
    players: [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, inventory: [], x: 1, y: 1, level: 1 }],
    partyMemberIds: ['hero'],
    scene: { title: 'Сцена', location: 'Дом', cells: legacyCellsFromTacticalMap(map) },
  })

  const plain = kilobytes(await writtenSnapshot(t, state, false))
  const externalized = kilobytes(await writtenSnapshot(t, state, true))
  console.log(`  снимок целиком: ${plain.toFixed(1)} КБ → ${externalized.toFixed(1)} КБ с MapStore`)

  // Детерминированное отношение важнее абсолютных чисел: оно не зависит ни от
  // машины, ни от того, сколько ещё полей появится в состоянии кампании.
  assert.ok(externalized * 10 < plain,
    `снимок ${externalized.toFixed(1)} КБ против ${plain.toFixed(1)} КБ — вынос дал меньше порядка`)
})

test('проекция состояния игроку не разваливается на карте класса region', () => {
  const map = regionMap({ props: 50 })
  const state = normalizeCampaignState({
    sessionCode: 'BUDGET-VIEW',
    players: [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, inventory: [], x: 1, y: 1, level: 1 }],
    partyMemberIds: ['hero'],
    scene: { title: 'Сцена', location: 'Поле', cells: legacyCellsFromTacticalMap(map) },
  })
  const viewer = { role: 'player', heroIds: ['hero'] }
  let projected = null
  const median = measure('проекция состояния целиком', () => {
    projected = campaignStateForViewer(state, viewer)
  })
  assert.ok(projected?.scene, 'проекция обязана вернуть сцену')
  console.log(`  клеток в проекции: ${projected.scene.cells.length}`)
  assertWallClock(median, 60, 'проекция состояния')
})

/**
 * Таверна с объявленными этажами и отрядом у лестницы — вход для замеров
 * перехода (`docs/multilevel-map-plan.md`, раздел 8).
 */
function tavernAtStairs() {
  const declared = normalizeDeclaredLevels([
    { offset: 1, hint: 'спальни и кабинет хозяина' },
    { offset: -1, hint: 'винный погреб' },
  ])
  const map = generateBuildingScene({ seed: 'бюджет-этажей', locationId: 'loc-tavern', levels: declared })
  const stairs = map.props.find((prop) => Number(prop.transition?.toLevel) === 1)
  assert.ok(stairs, 'у таверны с объявленным вторым этажом обязана быть лестница-переход')
  const anchor = stairs.footprint[0]
  const spot = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]
    .map(([dx, dy]) => ({ x: anchor.x + dx, y: anchor.y + dy }))
    .find((candidate) => cellAt(map, candidate.x, candidate.y)?.passable)
  assert.ok(spot, 'рядом с лестницей обязана быть проходимая клетка')
  return {
    stairs,
    state: normalizeCampaignState({
      sessionCode: 'BUDGET-LEVELS',
      partyMemberIds: ['hero'],
      players: [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, level: 1, inventory: [], ...spot }],
      worldMap: { seed: 'budget-levels', currentLocationId: 'loc-tavern', locations: [{ id: 'loc-tavern', name: 'Постоялый двор' }] },
      scene: {
        title: 'Постоялый двор',
        location: 'Постоялый двор',
        location_id: 'loc-tavern',
        levels: declared,
        map: serializeTacticalMap(map),
        cells: legacyCellsFromTacticalMap(map),
      },
    }),
  }
}

test('переход между этажами укладывается в пороги плана', () => {
  const dice = new DiceService({ rng: new SequenceDiceRng([]), idFactory: () => 'unused', now: () => '2026-08-02T00:00:00.000Z' })
  const { state, stairs } = tavernAtStairs()
  const command = { command_type: 'UseLevelTransition', actor_id: 'hero', prop_id: stairs.id }

  // Первый переход строит этаж прямо в resolve — это самый дорогой путь.
  const generation = measure('переход с генерацией этажа', () => (
    resolveCommand({ ...command, command_id: 'climb' }, state, { diceService: dice })
  ))
  const first = resolveCommand({ ...command, command_id: 'climb' }, state, { diceService: dice })
  assert.ok(first.events[0].payload.map, 'первая генерация обязана нести карту в событии')

  // Второй — находит запомненный этаж и ничего не строит.
  const upstairs = applyGameEvent(state, first.events[0])
  const back = deserializeTacticalMap(upstairs.scene.map).props.find((prop) => Number(prop.transition?.toLevel) === 0)
  assert.ok(back, 'на построенном этаже обязан быть обратный переход')
  const descentCommand = { command_type: 'UseLevelTransition', actor_id: 'hero', prop_id: back.id, command_id: 'descend' }
  const remembered = measure('переход по запомненному этажу', () => (
    resolveCommand(descentCommand, upstairs, { diceService: dice })
  ))
  const descent = resolveCommand(descentCommand, upstairs, { diceService: dice })
  assert.equal(Object.hasOwn(descent.events[0].payload, 'map'), false, 'повторный переход карту в событии не несёт')

  const size = kilobytes(descent.events[0].payload)
  console.log(`  событие повторного перехода: ${size.toFixed(2)} КБ`)
  assert.ok(size <= 2, `событие повторного перехода ${size.toFixed(2)} КБ, порог плана — 2 КБ`)
  assertWallClock(generation, 150, 'переход с генерацией этажа')
  assertWallClock(remembered, 15, 'переход по запомненному этажу')
})

test('бюджеты классов размеров согласованы между собой', () => {
  // Раздел 11.3: класс задаёт пределы, и они обязаны расти монотонно.
  const order = ['arena', 'area', 'region']
  for (let index = 1; index < order.length; index += 1) {
    const smaller = SIZE_CLASSES[order[index - 1]]
    const bigger = SIZE_CLASSES[order[index]]
    assert.ok(bigger.maxCells > smaller.maxCells, `${order[index]} обязан вмещать больше клеток`)
    assert.ok(bigger.maxProps > smaller.maxProps, `${order[index]} обязан вмещать больше предметов`)
    assert.ok(bigger.maxWallEdges > smaller.maxWallEdges, `${order[index]} обязан вмещать больше стен`)
  }
  assert.equal(SIZE_CLASSES.region.maxCells, 10_000, 'целевой предел плана — 10 000 клеток')
})
