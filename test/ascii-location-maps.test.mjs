// Сборщик нарисованных карт (`tools/build-ascii-location-maps.mjs`): высота
// символа легенды, кромки обрывов, трудная местность. И рельеф с укрытиями
// авторских карт Асстохана в собранном каталоге.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TERRAIN_COVER } from '../server/rules/tactical-geometry.mjs'
import { cellAt, deserializeTacticalMap, edgeBetween, reachableCells } from '../server/tactical-map.mjs'
import { STEP_FEET, asciiMapToLayout } from '../tools/build-ascii-location-maps.mjs'
import { buildAuthoredLocationMap } from '../tools/build-authored-location-maps.mjs'

/** Маленький рисунок: луг, площадка на 5 фт, утёс на 10 фт, хижина. */
function drawing({ legend = {}, rows } = {}) {
  const picture = rows ?? [
    '@.....',
    '..1122',
    '..1122',
    '.,,.E.',
  ]
  return {
    location_id: 'fixture-heights',
    name: 'Проба высот',
    theme: 'road',
    default_material: 'grass',
    zones: [
      { id: 'meadow', label: 'Луг', kind: 'exterior', material: 'grass' },
      // Объявленная зона обязана быть на рисунке.
      ...(picture.some((row) => row.includes('h')) ? [{ id: 'hut', label: 'Хижина', kind: 'interior', material: 'wood' }] : []),
    ],
    legend: {
      ' ': { void: true },
      '.': { zone: 'meadow' },
      '1': { zone: 'meadow', elevation: 5 },
      '2': { zone: 'meadow', elevation: 10 },
      ',': { zone: 'meadow', moveCost: 2 },
      ...legend,
    },
    rows: picture,
    props: [],
  }
}

const build = (source) => buildAuthoredLocationMap(asciiMapToLayout(source))

test('символ с elevation даёт клетку с этой высотой, без поля — уровень земли', () => {
  const map = build(drawing())
  assert.equal(cellAt(map, 0, 1)?.elevation, 0, 'луг без поля — на земле')
  assert.equal(cellAt(map, 2, 1)?.elevation, 5)
  assert.equal(cellAt(map, 5, 2)?.elevation, 10)
  assert.equal(cellAt(map, 1, 3)?.moveCost, 2, 'moveCost легенды — трудная местность')
  assert.equal(cellAt(map, 0, 3)?.moveCost, 1)
})

test('точка появления берёт высоту соседа, чью зону она получила', () => {
  const map = build(drawing({ rows: ['......', '..1122', '..12E2', '.@....'] }))
  const enemy = map.spawnPoints.find((point) => point.role === 'enemy')
  assert.deepEqual([enemy.x, enemy.y], [4, 2])
  assert.equal(cellAt(map, 4, 2)?.elevation, 10)
})

test('шаг в 5 фт — склон без ребра, перепад больше — кромка обрыва', () => {
  const map = build(drawing())
  assert.equal(edgeBetween(map, 1, 1, 2, 1), null, '0 → 5: ступень')
  assert.equal(edgeBetween(map, 3, 1, 4, 1), null, '5 → 10: ступень')
  const cliff = edgeBetween(map, 4, 2, 4, 3)
  assert.equal(cliff?.kind, 'ledge', '10 → 0: обрыв')
  assert.equal(cliff.blocksMove, true, 'обрыв не проходят шагом — лазания движок не знает')
  assert.equal(cliff.blocksSight, false, 'с обрыва видно и стреляют')
  // На площадку 10 фт поднимаются ступенями, а не через обрыв.
  const reached = reachableCells(map, 0, 0)
  assert.ok(reached.has('5,1') && reached.has('5,2'))
  assert.equal(STEP_FEET, 5)
})

test('высота легенды — целые футы, кратные 5; дверь над обрывом — ошибка рисунка', () => {
  for (const elevation of [7, 2.5, 130, '10']) {
    assert.throws(() => build(drawing({ legend: { '2': { zone: 'meadow', elevation } } })), /высота символа «2»/u, String(elevation))
  }
  const hut = { rows: ['@.....', '...hh.', '22Dhh.', '.E....'], legend: { 'h': { zone: 'hut' } } }
  assert.throws(() => build(drawing(hut)), /над обрывом/u)
  // Та же дверь с площадки на 5 фт — ступень, рисунок собирается.
  const step = build(drawing({ ...hut, rows: ['@.....', '...hh.', '11Dhh.', '.E....'] }))
  assert.equal(step.doors.length, 1)
})

// --- каталог: Асстохан -------------------------------------------------------------

const CATALOG = JSON.parse(readFileSync(new URL('../data/authored-location-maps-v1.json', import.meta.url), 'utf8'))
const mapById = (id) => deserializeTacticalMap(structuredClone(CATALOG.maps.find((map) => map.locationId === id)))

/** Свободные клетки: проходимые, не вода, без непроходимого предмета. */
function survey(map) {
  const blocked = new Set()
  const ruleCover = new Set()
  for (const prop of map.props) {
    for (const cell of prop.footprint) {
      if (prop.blocksMove) blocked.add(`${cell.x},${cell.y}`)
      if (TERRAIN_COVER[prop.assetId]) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) ruleCover.add(`${cell.x + dx},${cell.y + dy}`)
    }
  }
  const free = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.passable && cell.surface !== 'water' && !blocked.has(`${x},${y}`)) free.push({ x, y, cell })
  }
  const party = map.spawnPoints.find((point) => point.role === 'party')
  const reached = reachableCells(map, party.x, party.y, { blockedCells: blocked, throughDoors: true })
  return { free, blocked, ruleCover, reached }
}

for (const [id, minimumLevels] of [['astohan-vulkanis-brazier', 3], ['astohan-forgotten-cliffs', 4], ['astohan-obsidian-pass', 3]]) {
  test(`${id}: рельеф в несколько уровней, на каждую площадку — подъём без лазания`, () => {
    const map = mapById(id)
    const { free, reached } = survey(map)
    const levels = new Set(free.map(({ cell }) => cell.elevation))
    assert.ok(levels.size >= minimumLevels && levels.size <= 4, `${id}: уровней ${[...levels].join('/')}`)
    // Соседи с перепадом больше шага разделены кромкой, иначе движок пустил
    // бы на утёс шагом.
    for (const { x, y, cell } of free) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const next = cellAt(map, x + dx, y + dy)
        if (!next?.passable || Math.abs(next.elevation - cell.elevation) <= STEP_FEET) continue
        assert.equal(edgeBetween(map, x, y, x + dx, y + dy)?.blocksMove, true, `${id}: обрыв без кромки у ${x},${y}`)
      }
    }
    // Каждая площадка над землёй — связная область одной высоты — досягаема
    // от входа хотя бы одной клеткой. Отдельные клетки, запертые мебелью,
    // ловит аудит map-quality (UNREACHABLE_FLOOR), а не эта проверка.
    const raised = new Map()
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.passable && cell.elevation > 0) raised.set(`${x},${y}`, { x, y, cell })
    }
    assert.ok(raised.size >= 20, `${id}: площадок почти нет`)
    const unreached = []
    for (const [start, entry] of raised) {
      const plateau = [entry]
      raised.delete(start)
      for (let index = 0; index < plateau.length; index += 1) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const key = `${plateau[index].x + dx},${plateau[index].y + dy}`
          const next = raised.get(key)
          if (next && next.cell.elevation === entry.cell.elevation) { plateau.push(next); raised.delete(key) }
        }
      }
      if (!plateau.some(({ x, y }) => reached.has(`${x},${y}`))) unreached.push(`${entry.x},${entry.y} (${entry.cell.elevation} фт, ${plateau.length} кл.)`)
    }
    assert.deepEqual(unreached, [], `${id}: площадка без подъёма`)
  })
}

for (const id of ['astohan-cursed-woods', 'astohan-wild-forest']) {
  test(`${id}: бурелом 10–20% и укрытие рядом у четверти клеток, тропы чистые`, () => {
    const map = mapById(id)
    const { free, ruleCover } = survey(map)
    const difficult = free.filter(({ cell }) => cell.moveCost > 1).length / free.length
    assert.ok(difficult >= 0.1 && difficult <= 0.2, `${id}: трудной местности ${Math.round(difficult * 100)}%`)
    // Укрытие считается так же, как прогноз удара в Rules Engine: предмет из
    // TERRAIN_COVER в клетке рядом.
    const covered = free.filter(({ x, y }) => ruleCover.has(`${x},${y}`)).length / free.length
    assert.ok(covered >= 0.25, `${id}: укрытие рядом у ${Math.round(covered * 100)}%`)
    const trails = map.zones.filter((zone) => /trail|road|loop|path|pass|ford/u.test(zone.id)).map((zone) => zone.id)
    assert.ok(trails.length >= 3)
    const overgrown = free.filter(({ cell }) => trails.includes(cell.zone) && cell.moveCost > 1)
    assert.deepEqual(overgrown.map(({ x, y }) => `${x},${y}`), [], `${id}: бурелом на тропе`)
    for (const spawn of map.spawnPoints) assert.equal(cellAt(map, spawn.x, spawn.y)?.moveCost, 1, `${id}: точка ${spawn.role} в буреломе`)
  })
}
