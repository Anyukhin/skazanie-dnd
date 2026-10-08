import assert from 'node:assert/strict'
import test from 'node:test'

import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { footprintCellsFor } from '../server/actor-footprint.mjs'
import { GRAPH_LAYOUT, buildSceneFromGraph, layoutSceneGraph } from '../server/graph-layout.mjs'
import { auditTacticalMap } from '../server/map-quality.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { SCENE_THEMES, sceneGraphForTheme } from '../server/scene-themes.mjs'
import { cellAt, edgeBetween, legacyCellsFromTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'
import { dice } from './kit/index.mjs'

/**
 * Склеп графовой раскладки, версия 2 (`docs/maps-dnd-standards-plan.md`,
 * задача 5): камеры 225–625 фт² в скальном массиве и ходы в клетку между
 * ними вместо зала 180×150 футов с рядами колонн.
 */

const CRYPT = SCENE_THEMES.find((theme) => theme.id === 'crypt')
const SIZES = [[26, 26], [36, 30], [40, 32]]
const SEEDS = ['s1', 's2', 's3', 's4']

/** @param {{width?: number, height?: number}} size @param {string} seed */
function crypt(size, seed) {
  return generateSceneGeometry({ location: 'Фамильный склеп', theme: 'склеп', seed: `crypt:${seed}`, map: size, useLibrary: false }).map
}

/** Проходимые клетки по зонам; ходы — под пустой зоной. @param {any} map */
function cellsByZone(map) {
  /** @type {Map<string, Array<{x: number, y: number}>>} */
  const zones = new Map()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.passable) continue
    zones.set(cell.zone, [...(zones.get(cell.zone) ?? []), { x, y }])
  }
  return zones
}

test('склеп — камеры 225–625 фт² в скале, ходы в клетку, проходимо не больше 40% карты', () => {
  for (const [width, height] of SIZES) {
    for (const seed of SEEDS) {
      const map = crypt({ width, height }, seed)
      const label = `${width}×${height}/${seed}`
      assert.equal(map.generator.id, GRAPH_LAYOUT.id)
      assert.equal(map.generator.version, '2', `${label}: склеп собран прежней версией`)
      // Решение владельца: карта не меньше 16×16 клеток, лишнее — порода.
      assert.ok(map.width >= 16 && map.height >= 16, `${label}: карта ${map.width}×${map.height}`)
      const zones = cellsByZone(map)
      const passable = [...zones.values()].reduce((sum, cells) => sum + cells.length, 0)
      assert.ok(passable <= map.width * map.height * 0.4, `${label}: проходимо ${passable} из ${map.width * map.height}`)

      const chambers = map.zones.filter((/** @type {any} */ zone) => zone.label)
      assert.ok(chambers.length >= 3, `${label}: камер ${chambers.length}`)
      for (const zone of chambers) {
        const cells = zones.get(zone.id) ?? []
        const feet = cells.length * 25
        assert.ok(feet >= 225 && feet <= 625, `${label}: ${zone.label} — ${feet} фт²`)
        const xs = cells.map((cell) => cell.x)
        const ys = cells.map((cell) => cell.y)
        // Камера — 3–6 клеток по стороне; петля (`addShortcutLoops`) отдаёт ей
        // ещё до двух клеток лаза сквозь стену к соседней камере.
        const sides = [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1]
        assert.ok(sides.every((side) => side >= 3 && side <= 8), `${label}: ${zone.label} ${sides.join('×')} клеток`)
      }

      // Ход — клетки без зоны; квадрата 2×2 из них нет: ход не шире клетки
      // и не сливается с соседним ходом.
      const passage = new Set((zones.get('') ?? []).map((cell) => `${cell.x},${cell.y}`))
      assert.ok(passage.size > 0, `${label}: камеры без ходов`)
      for (const key of passage) {
        const [x, y] = key.split(',').map(Number)
        const square = [[1, 0], [0, 1], [1, 1]].every(([dx, dy]) => passage.has(`${x + dx},${y + dy}`))
        assert.ok(!square, `${label}: ход шире клетки у ${key}`)
      }
      assert.deepEqual(auditTacticalMap(map).problems, [], `${label}: проверка карты`)
    }
  }
})

test('склеп детерминирован по сиду, а у колонн больше нет зала', () => {
  const first = JSON.stringify(serializeTacticalMap(crypt({}, 'same')))
  assert.equal(JSON.stringify(serializeTacticalMap(crypt({}, 'same'))), first)
  assert.notEqual(JSON.stringify(serializeTacticalMap(crypt({}, 'other'))), first)
  // Колоннада ставится залам от ста клеток; камер такого размера нет.
  for (const seed of SEEDS) {
    const map = crypt({ width: 36, height: 30 }, seed)
    assert.equal(map.props.filter((/** @type {any} */ prop) => prop.assetId === 'pillar').length, 0, `${seed}: колонны в склепе`)
  }
})

test('камеры не теряют топологию графа, а цель склепа открывается только ключом', () => {
  for (const seed of ['t1', 't2', 't3', 't4', 't5', 't6']) {
    const graph = sceneGraphForTheme(/** @type {any} */ (CRYPT), seed)
    const built = buildSceneFromGraph(graph, { seed, width: 26, height: 26, theme: 'crypt', material: 'stone' })
    assert.deepEqual(built.errors, [], `${seed}: ${built.errors.map((issue) => issue.code).join(', ')}`)
    assert.deepEqual(built.warnings, [], `${seed}: ${built.warnings.join('; ')}`)
    // Ходы, а не общие стены: камеры склепа не соприкасаются.
    const rooms = [...layoutSceneGraph(graph, { seed, width: 26, height: 26, theme: 'crypt' }).rooms.values()]
    for (const [index, a] of rooms.entries()) {
      for (const b of rooms.slice(index + 1)) {
        const apart = a.maxX < b.minX - 1 || b.maxX < a.minX - 1 || a.maxY < b.minY - 1 || b.maxY < a.minY - 1
        assert.ok(apart, `${seed}: камеры ${JSON.stringify(a)} и ${JSON.stringify(b)} без породы между ними`)
      }
    }
  }
  for (const seed of SEEDS) {
    const map = crypt({}, seed)
    const goal = map.zones.filter((/** @type {any} */ zone) => zone.label).at(-1).id
    const spawn = map.spawnPoints.find((/** @type {any} */ point) => point.role === 'party')
    const locked = new Set(map.doors.filter((/** @type {any} */ door) => door.state === 'locked').map((/** @type {any} */ door) => door.id))
    assert.ok(locked.size >= 1, `${seed}: цель склепа не заперта`)
    assert.equal(new Set(map.doors.filter((/** @type {any} */ door) => locked.has(door.id)).map((/** @type {any} */ door) => door.keyItemId)).size, 1, `${seed}: замки под разные ключи`)
    /** @param {boolean} withKey */
    const reached = (withKey) => {
      const seen = new Set([`${spawn.x},${spawn.y}`])
      const queue = [{ x: spawn.x, y: spawn.y }]
      for (let index = 0; index < queue.length; index += 1) {
        const { x, y } = queue[index]
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const key = `${x + dx},${y + dy}`
          if (seen.has(key) || !cellAt(map, x + dx, y + dy)?.passable) continue
          const edge = edgeBetween(map, x, y, x + dx, y + dy)
          if (edge?.kind === 'door' ? !withKey && locked.has(edge.doorId) : edge?.blocksMove) continue
          seen.add(key)
          queue.push({ x: x + dx, y: y + dy })
        }
      }
      return [...seen].some((key) => cellAt(map, ...(/** @type {[number, number]} */ (key.split(',').map(Number))))?.zone === goal)
    }
    assert.equal(reached(false), false, `${seed}: в тайник склепа можно пройти без ключа`)
    assert.equal(reached(true), true, `${seed}: тайник склепа недостижим и с ключом`)
  }
})

test('тесная карта склепа строится камерами, а негде разместить — прежним разбиением', () => {
  const graph = sceneGraphForTheme(/** @type {any} */ (CRYPT), 'small')
  const small = buildSceneFromGraph(graph, { seed: 'small', width: 16, height: 16, theme: 'crypt' })
  assert.deepEqual(small.errors, [])
  const floor = [...cellsByZone(small.map).values()].reduce((sum, cells) => sum + cells.length, 0)
  assert.ok(floor <= 16 * 16 * 0.4, `16×16: проходимо ${floor} клеток — склеп собран залами, а не камерами`)
  // Карта 12×12 камер с ходами не вмещает — склеп всё равно собирается.
  const tiny = buildSceneFromGraph(graph, { seed: 'tiny', width: 12, height: 12, theme: 'crypt' })
  assert.deepEqual(tiny.errors, [], tiny.errors.map((issue) => issue.code).join(', '))
})

test('сборщик встречи ставит врагов в склепе, а крупное тело — туда, откуда оно дойдёт до отряда', () => {
  let placed = 0
  let large = 0
  for (const seed of ['enc:1', 'enc:2', 'enc:3', 'enc:4']) {
    const map = generateSceneGeometry({ location: 'Фамильный склеп', theme: 'склеп', seed, useLibrary: false }).map
    const spawn = map.spawnPoints.find((/** @type {any} */ point) => point.role === 'party')
    const entrance = cellAt(map, spawn.x, spawn.y)?.zone
    const blocked = new Set(map.props.filter((/** @type {any} */ prop) => prop.blocksMove)
      .flatMap((/** @type {any} */ prop) => prop.footprint.map((/** @type {any} */ cell) => `${cell.x},${cell.y}`)))
    /** @type {Array<{x: number, y: number, distance: number}>} */
    const spots = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.passable && cell.zone === entrance && !blocked.has(`${x},${y}`)) spots.push({ x, y, distance: Math.abs(x - spawn.x) + Math.abs(y - spawn.y) })
    }
    spots.sort((left, right) => left.distance - right.distance || left.y - right.y || left.x - right.x)
    const heroes = spots.slice(0, 4).map((spot, index) => ({ id: `hero-${index + 1}`, hp: 20, maxHp: 20, level: 3, x: spot.x, y: spot.y }))
    const state = normalizeCampaignState({
      sessionCode: 'CRYPT-ENCOUNTER', ruleset_id: 'dnd_5e_2014', players: heroes, partyMemberIds: heroes.map((hero) => hero.id), enemies: [],
      scene: { cells: legacyCellsFromTacticalMap(map), map: serializeTacticalMap(map) },
    })
    const heroCells = new Set(heroes.map((hero) => `${hero.x},${hero.y}`))
    /** Тело стороной `side` целиком на свободном полу и не поперёк стены. @param {number} side @param {{x: number, y: number}} anchor */
    const fits = (side, anchor) => {
      const body = footprintCellsFor({ footprint: { version: 1, size: side } }, anchor)
      const inside = new Set(body.map((cell) => `${cell.x},${cell.y}`))
      return body.every((cell) => cellAt(map, cell.x, cell.y)?.passable && !blocked.has(`${cell.x},${cell.y}`) && !heroCells.has(`${cell.x},${cell.y}`))
        && body.every((cell) => [[1, 0], [0, 1]].every(([dx, dy]) => !inside.has(`${cell.x + dx},${cell.y + dy}`)
          || !edgeBetween(map, cell.x, cell.y, cell.x + dx, cell.y + dy)?.blocksMove))
    }
    for (const theme of ['crypt', 'undead', 'beasts']) {
      for (const difficulty of ['easy', 'medium', 'hard']) {
        const result = resolveCommand({ command_type: 'CreateEncounter', command_id: `${seed}-${theme}-${difficulty}`, actor_id: 'hero-1', difficulty, theme, seed: `${seed}:${theme}:${difficulty}` },
          state, { diceService: dice(), context: { isAdmin: true } })
        const created = result.events.find((/** @type {any} */ event) => event.event_type === 'EncounterCreated')?.payload?.encounter
        assert.ok(created?.enemies?.length, `${seed}/${theme}/${difficulty}: встреча без врагов`)
        placed += created.enemies.length
        for (const enemy of created.enemies) {
          const side = enemy.footprint?.size ?? 1
          assert.ok(fits(side, enemy), `${seed}/${theme}/${difficulty}: ${enemy.name} стоит не на свободном полу (${enemy.x},${enemy.y})`)
          if (side < 2) continue
          large += 1
          // Карман: тело шагами по четырём сторонам обязано дойти до героя.
          const seen = new Set([`${enemy.x},${enemy.y}`])
          const queue = [{ x: enemy.x, y: enemy.y }]
          let reaches = false
          for (let index = 0; index < queue.length && !reaches; index += 1) {
            const current = queue[index]
            const body = footprintCellsFor({ footprint: { version: 1, size: side } }, current)
            reaches = body.some((cell) => heroes.some((hero) => Math.max(Math.abs(hero.x - cell.x), Math.abs(hero.y - cell.y)) <= 1))
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const next = { x: current.x + dx, y: current.y + dy }
              if (seen.has(`${next.x},${next.y}`) || !fits(side, next)) continue
              if (body.some((cell) => edgeBetween(map, cell.x, cell.y, cell.x + dx, cell.y + dy)?.blocksMove)) continue
              seen.add(`${next.x},${next.y}`)
              queue.push(next)
            }
          }
          assert.ok(reaches, `${seed}/${theme}/${difficulty}: ${enemy.name} площадью ${side} в кармане (${enemy.x},${enemy.y})`)
        }
      }
    }
  }
  assert.ok(placed > 0)
  assert.ok(large > 0, 'в склепе ни разу не встало крупное существо — проверка кармана ничего не проверила')
})
