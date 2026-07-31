import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBuildingScene } from '../server/building-generator.mjs'
import { campaignStateForViewer, publicSceneFor } from '../server/viewer-projection.mjs'
import { movementStepCostFor, normalizeCampaignState, shortestTacticalPath } from '../server/rules-engine.mjs'
import {
  SIZE_CLASSES,
  addProp,
  addZone,
  cellAt,
  createTacticalMap,
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

test('прирост снимка от карты замерен и зафиксирован храповиком', () => {
  const map = buildBuildingScene({ seed: 'snapshot', width: 30, height: 30 }).map
  const state = normalizeCampaignState({
    sessionCode: 'BUDGET',
    players: [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, inventory: [], x: 1, y: 1, level: 1 }],
    partyMemberIds: ['hero'],
    scene: { title: 'Сцена', location: 'Дом', cells: legacyCellsFromTacticalMap(map) },
  })
  const full = kilobytes(state)
  const withoutMap = kilobytes({ ...state, scene: { ...state.scene, map: undefined, cells: undefined }, locationMaps: {} })
  const growth = full - withoutMap
  console.log(`  снимок 30×30: всего ${full.toFixed(1)} КБ, вклад карты ${growth.toFixed(1)} КБ`)

  // Порог плана — 5 КБ, и он достижим только после выноса карты из снимка
  // (этап больших карт). Сейчас в снимке лежат и карта, и производные клетки,
  // и копия клеток в locationMaps. Храповик держит сегодняшнее число, чтобы
  // рост был замечен до того, как за него возьмутся.
  assert.ok(growth <= 220, `вклад карты в снимок ${growth.toFixed(1)} КБ — вырос против замеренного`)
  assert.ok(growth > 5, 'если вклад уже меньше 5 КБ, карта вынесена из снимка и порог плана пора включать буквально')
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
