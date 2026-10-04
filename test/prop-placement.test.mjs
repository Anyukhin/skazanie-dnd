import assert from 'node:assert/strict'
import test from 'node:test'

import { generateAresFortressScene, generateBuildingScene } from '../server/building-generator.mjs'
import { ensurePropAccess, placeProps } from '../server/prop-placement.mjs'
import {
  addProp,
  addSpawnPoint,
  addZone,
  cellAt,
  createTacticalMap,
  edgeNeighbor,
  edgeBetween,
  serializeTacticalMap,
  setCell,
  setEdge,
  setDoor,
  validateTacticalMap,
  reachableCells,
} from '../server/tactical-map.mjs'

/** Комната с внешним двором: слева здание, справа трава за стеной. */
function tavernWithYard({ width = 16, height = 12 } = {}) {
  const map = createTacticalMap({ width, height, seed: 'tavern' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', label: 'Общий зал' })
  addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', label: 'Участок' })
  const wallColumn = Math.floor(width / 2)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1
      const inside = x < wallColumn
      setCell(map, x, y, {
        passable: !border && x !== wallColumn,
        material: inside ? 'wood' : 'grass',
        zone: inside ? 'hall' : 'yard',
        revealed: true,
        variant: (x + y) % 6,
      })
    }
  }
  // Стены по рёбрам: внешний контур и перегородка здания.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const own = cellAt(map, x, y)
      if (!own || own.passable) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighbor = cellAt(map, x + dx, y + dy)
        if (neighbor?.passable) setEdge(map, x, y, x + dx, y + dy, { kind: 'wall', cover: 'three_quarters' })
      }
    }
  }
  return map
}

/** Та же карта с настоящим проходом между залом и двором. */
function tavernWithDoor() {
  const map = tavernWithYard()
  const wallColumn = Math.floor(map.width / 2)
  const y = Math.floor(map.height / 2)
  setCell(map, wallColumn, y, { passable: true, material: 'wood', zone: 'hall', revealed: true })
  setEdge(map, wallColumn - 1, y, wallColumn, y, { kind: 'none', blocksMove: false, blocksSight: false, cover: 'none' })
  setDoor(map, { id: 'yard-door', x: wallColumn, y, dir: 'e', state: 'closed' })
  return map
}

/** Минимальный межзонный проход, в котором мебель может запереть зал. */
function gateWithFurnishedHall({ blockedCells = 1 } = {}) {
  const map = createTacticalMap({ width: 10, height: 7, seed: 'prop-access-gate' })
  addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', label: 'Подход' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'stone', label: 'Зал' })
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      setCell(map, x, y, {
        passable: false,
        material: x < 4 ? 'grass' : 'stone',
        zone: x < 4 ? 'yard' : 'hall',
        revealed: true,
      })
    }
  }
  for (let x = 1; x <= 8; x += 1) {
    setCell(map, x, 3, { passable: true, material: x < 4 ? 'grass' : 'stone', zone: x < 4 ? 'yard' : 'hall', revealed: true })
  }
  addSpawnPoint(map, { id: 'party', x: 1, y: 3, role: 'party' })
  setDoor(map, { id: 'hall-gate', x: 4, y: 3, dir: 'e', state: 'open' })
  for (let index = 0; index < blockedCells; index += 1) {
    const x = 5 + index
    addProp(map, {
      id: `hall-table-${index}`,
      assetId: 'table_round',
      x: x + 0.5,
      y: 3.5,
      footprint: [{ x, y: 3 }],
      blocksMove: true,
      blocksSight: true,
    })
    addProp(map, {
      id: `hall-mug-${index}`,
      assetId: 'mug',
      x: x + 0.5,
      y: 3.5,
      footprint: [],
      mount: { kind: 'surface', propId: `hall-table-${index}` },
    })
  }
  // Предмет вне геометрии прохода остаётся частью карты: repair не должен
  // превращаться в глобальную чистку blocking-пропов.
  addProp(map, {
    id: 'outside-decoration',
    assetId: 'boulder',
    x: 0.5,
    y: 0.5,
    footprint: [{ x: 0, y: 0 }],
    blocksMove: true,
  })
  return map
}

const PLAN = [
  { zoneId: 'hall', theme: 'interior', density: 18, require: ['table_round', 'chair', 'bar_counter', 'fireplace'] },
  { zoneId: 'yard', theme: 'yard', density: 10, require: ['tree_oak', 'bush'] },
]

function place(seed = 'seed-1') {
  return placeProps(tavernWithYard(), { seed, zones: PLAN, maxProps: 250 })
}

test('расстановка детерминирована от seed', () => {
  const first = JSON.stringify(serializeTacticalMap(place('same')))
  const second = JSON.stringify(serializeTacticalMap(place('same')))
  assert.equal(first, second)
  assert.notEqual(first, JSON.stringify(serializeTacticalMap(place('other'))))
})

test('расставленная карта проходит структурную валидацию', () => {
  const report = validateTacticalMap(place())
  assert.deepEqual(report.errors, [])
})

test('футпринты не пересекаются и не лезут в стены', () => {
  const map = place()
  const seen = new Set()
  for (const prop of map.props) {
    for (const cell of prop.footprint) {
      const key = `${cell.x},${cell.y}`
      assert.equal(seen.has(key), false, `клетка ${key} занята дважды`)
      seen.add(key)
      assert.equal(cellAt(map, cell.x, cell.y)?.passable, true, `предмет ${prop.id} стоит в стене`)
    }
  }
})

test('деревья и кусты не появляются в интерьере', () => {
  const map = place()
  for (const prop of map.props) {
    if (!prop.assetId.startsWith('tree_') && prop.assetId !== 'bush' && prop.assetId !== 'shrub') continue
    const cell = cellAt(map, Math.floor(prop.x), Math.floor(prop.y))
    assert.equal(cell?.zone, 'yard', `${prop.assetId} оказался в зоне ${cell?.zone}`)
    assert.equal(cell?.material, 'grass')
  }
})

test('мебель зала не выходит во двор', () => {
  const map = place()
  for (const prop of map.props) {
    if (!['bar_counter', 'fireplace', 'table_round', 'chair'].includes(prop.assetId)) continue
    assert.equal(cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone, 'hall',
      `${prop.assetId} оказался вне зала`)
  }
})

test('стулья стоят рядом со столом и повёрнуты к нему', () => {
  const map = place()
  const tables = map.props.filter((prop) => prop.assetId.startsWith('table_') || prop.assetId === 'bar_counter')
  const chairs = map.props.filter((prop) => prop.assetId === 'chair' || prop.assetId === 'stool')
  assert.ok(tables.length > 0, 'на сцене обязан быть стол')
  assert.ok(chairs.length > 0, 'на сцене обязан быть стул')

  for (const chair of chairs) {
    const distance = Math.min(...tables.map((table) => Math.max(
      Math.abs(Math.floor(table.x) - Math.floor(chair.x)),
      Math.abs(Math.floor(table.y) - Math.floor(chair.y)),
    )))
    assert.ok(distance <= 2, `стул ${chair.id} стоит в ${distance} клетках от ближайшего стола`)

    // Поворот обязан указывать в сторону стола: 0 — на юг, 90 — на запад,
    // 180 — на север, 270 — на восток.
    const table = tables.reduce((best, candidate) => {
      const measure = (prop) => Math.max(Math.abs(prop.x - chair.x), Math.abs(prop.y - chair.y))
      return measure(candidate) < measure(best) ? candidate : best
    })
    const dx = Math.floor(table.x) - Math.floor(chair.x)
    const dy = Math.floor(table.y) - Math.floor(chair.y)
    const expected = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 270 : 90) : (dy >= 0 ? 0 : 180)
    assert.equal(chair.rotation, expected, `стул ${chair.id} повёрнут не к столу`)
  }
})

test('предметы с якорем у стены стоят у стены и смотрят внутрь помещения', () => {
  const map = place()
  const anchored = map.props.filter((prop) => ['barrel', 'crate', 'bar_counter', 'fireplace', 'bookshelf'].includes(prop.assetId))
  assert.ok(anchored.length > 0)
  for (const prop of anchored) {
    const x = Math.floor(prop.x)
    const y = Math.floor(prop.y)
    const sides = [[0, -1, 180], [1, 0, 270], [0, 1, 0], [-1, 0, 90]]
    const walls = sides.filter(([dx, dy]) => {
      const neighbor = cellAt(map, x + dx, y + dy)
      return !neighbor || !neighbor.passable
    })
    assert.ok(walls.length > 0, `${prop.id} стоит не у стены`)
    assert.ok(walls.some(([, , facing]) => facing === prop.rotation),
      `${prop.id} повёрнут на ${prop.rotation}°, но стена не с той стороны`)
  }
})

test('одинаковые деревья отличаются поворотом или масштабом', () => {
  const map = place()
  const trees = map.props.filter((prop) => prop.assetId.startsWith('tree_'))
  if (trees.length < 2) return
  const signatures = new Set(trees.map((tree) => `${tree.rotation}:${tree.scale}`))
  assert.ok(signatures.size > 1, 'все деревья нарисованы одинаково — карта будет выглядеть штампованной')
})

test('плотность задаётся зоной, а не общим счётчиком', () => {
  const dense = placeProps(tavernWithYard(), {
    seed: 'density',
    zones: [{ zoneId: 'hall', theme: 'interior', density: 30 }, { zoneId: 'yard', theme: 'yard', density: 2 }],
  })
  const inHall = dense.props.filter((prop) => cellAt(dense, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'hall').length
  const inYard = dense.props.filter((prop) => cellAt(dense, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'yard').length
  assert.ok(inHall > inYard * 2, `в зале ${inHall}, во дворе ${inYard} — плотность зон не различается`)
})

test('широкие одинаковые предметы не смыкаются следами', () => {
  // Площадь 12×12 и шесть прилавков 2×2: запрет «одинаковое вплотную» мерил
  // опорные клетки, и прилавки вставали сплошным рядом.
  const map = createTacticalMap({ width: 12, height: 12, seed: 'stalls' })
  addZone(map, { id: 'square', kind: 'exterior', material: 'stone', label: 'Площадь' })
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < 12; x += 1) setCell(map, x, y, { passable: true, revealed: true, material: 'stone', zone: 'square' })
  addProp(map, { id: 'stall-old', assetId: 'market_stall', x: 6, y: 6, footprint: [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }], blocksMove: true })
  placeProps(map, { seed: 'stalls', zones: [{ zoneId: 'square', theme: 'settlement', density: 40, require: Array(6).fill('market_stall'), caps: { market_stall: 6 } }] })
  const stalls = map.props.filter((prop) => prop.assetId === 'market_stall')
  assert.ok(stalls.length >= 2, `прилавков ${stalls.length}`)
  for (const [index, left] of stalls.entries()) for (const right of stalls.slice(index + 1)) {
    const touching = left.footprint.some((a) => right.footprint.some((b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1))
    assert.equal(touching, false, `${left.id} вплотную к ${right.id}`)
  }
})

test('бюджет предметов соблюдается', () => {
  const map = placeProps(tavernWithYard(), { seed: 'budget', zones: PLAN, maxProps: 5 })
  assert.ok(map.props.length <= 5, `расставлено ${map.props.length} предметов при бюджете 5`)
})

test('мелкая утварь ничего не занимает и лежит поверх', () => {
  const map = place()
  for (const prop of map.props) {
    if (!['mug', 'plate', 'bottle', 'candle', 'jug', 'bowl_stew'].includes(prop.assetId)) continue
    assert.deepEqual(prop.footprint, [])
    assert.equal(prop.zOrder, 1, 'утварь обязана рисоваться поверх мебели')
  }
})

test('назначение галереи собирает столовую группу, а не случайный каталог', () => {
  const map = placeProps(tavernWithYard(), {
    seed: 'gallery-purpose',
    zones: [{ zoneId: 'hall', theme: 'interior', purpose: 'gallery', density: 55 }],
  })
  const hall = map.props.filter((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'hall')
  const assets = new Set(hall.map((prop) => prop.assetId))
  assert.ok(assets.has('table_long') || assets.has('table_small'), 'галерея должна получить стол для карт')
  assert.equal(hall.filter((prop) => prop.assetId === 'chandelier').length, 1, 'в галерее должна быть одна люстра')
  assert.ok(hall.filter((prop) => prop.assetId === 'table_long').length <= 2, 'в галерее не должно быть лишних длинных столов')
  assert.ok(hall.some((prop) => ['chair', 'bench'].includes(prop.assetId)), 'у стола должны быть места')
  assert.equal(hall.some((prop) => ['crate_stack', 'barrel_stack', 'haystack'].includes(prop.assetId)), false,
    'галерея не должна заполняться складскими группами')
})

test('назначения кухни и склада выбирают рабочие группы комнаты', () => {
  for (const [purpose, expected] of [
    ['kitchen', ['kitchen_stove', 'prep_table', 'pantry_shelf']],
    ['store', ['crate_stack', 'barrel_stack']],
  ]) {
    const map = placeProps(tavernWithYard({ width: 20, height: 14 }), {
      seed: `${purpose}-purpose`,
      zones: [{ zoneId: 'hall', theme: 'interior', purpose, density: 45 }],
    })
    const assets = new Set(map.props.map((prop) => prop.assetId))
    for (const assetId of expected) assert.ok(assets.has(assetId), `${purpose}: нет ${assetId}`)
  }
})

test('назначение казармы ставит несколько коек в ряд', () => {
  const map = placeProps(tavernWithYard({ width: 20, height: 14 }), {
    seed: 'barracks-purpose',
    zones: [{ zoneId: 'hall', theme: 'interior', purpose: 'barracks', density: 45 }],
  })
  const beds = map.props.filter((prop) => ['bed', 'bunk_bed'].includes(prop.assetId))
  assert.ok(beds.length >= 4, `в казарме только ${beds.length} койки`)
  const rows = new Map()
  for (const bed of beds) {
    const row = Math.floor(bed.y)
    rows.set(row, (rows.get(row) ?? 0) + 1)
  }
  assert.ok(Math.max(...rows.values()) >= 2, 'койки не образуют ряда')
  assert.ok(map.props.some((prop) => prop.assetId === 'night_table'), 'у рядов коек должны быть тумбочки')
  assert.ok(map.props.some((prop) => prop.assetId === 'chest'), 'у рядов коек должны быть сундуки')
  assert.equal(map.props.some((prop) => ['table_long', 'bench', 'chair'].includes(prop.assetId)), false,
    'казарма не должна заполняться случайной столовой мебелью')
})

test('назначение конюшни выбирает сено и кормушки в дворовой зоне', () => {
  const map = placeProps(tavernWithYard({ width: 20, height: 14 }), {
    seed: 'stable-purpose',
    zones: [{ zoneId: 'yard', theme: 'yard', purpose: 'stable', density: 32 }],
  })
  const assets = new Set(map.props.map((prop) => prop.assetId))
  assert.ok(assets.has('haystack'), 'конюшня должна получить сено')
  assert.ok(assets.has('water_trough'), 'конюшня должна получить кормушку')
  assert.ok(assets.has('hitching_post'), 'конюшня должна получить коновязь')
  assert.equal(map.props.filter((prop) => prop.assetId === 'haystack').length, 1, 'в конюшне нужен один стог')
  assert.equal(map.props.filter((prop) => prop.assetId === 'water_trough').length, 1, 'в конюшне нужна одна кормушка')
  assert.ok(map.props.filter((prop) => prop.assetId === 'cart').length <= 2, 'телег в конюшне должно быть не больше двух')
})

test('назначение внешнего пояса оставляет растительность и камни', () => {
  const map = placeProps(tavernWithYard({ width: 20, height: 14 }), {
    seed: 'exterior-purpose',
    zones: [{ zoneId: 'yard', theme: 'yard', purpose: 'exterior', density: 32 }],
  })
  assert.equal(map.props.some((prop) => ['cart', 'woodpile'].includes(prop.assetId)), false,
    'внешний пояс не должен превращаться в склад телег и поленьев')
})

test('проход к двери остаётся свободным от мебельных футпринтов', () => {
  const map = placeProps(tavernWithDoor(), {
    seed: 'door-clearance',
    zones: [
      { zoneId: 'hall', theme: 'interior', purpose: 'gallery', density: 70 },
      { zoneId: 'yard', theme: 'yard', purpose: 'courtyard', density: 35 },
    ],
  })
  const occupied = new Set(map.props.flatMap((prop) => prop.blocksMove ? prop.footprint.map((cell) => `${cell.x},${cell.y}`) : []))
  for (const door of map.doors) {
    const other = edgeNeighbor(door)
    for (const cell of [{ x: door.x, y: door.y }, other]) {
      assert.equal(occupied.has(`${cell.x},${cell.y}`), false, `мебель на пороге ${door.id}`)
    }
  }
  // Вторая проверка учитывает стены/дверные рёбра и предметы, блокирующие
  // проход (`blocksMove`), — один
  // проход до двери должен существовать как для реального тактического шага.
  const blocked = occupied
  const reached = new Set()
  const spawn = { x: 1, y: Math.floor(map.height / 2) }
  const queue = [spawn]
  reached.add(`${spawn.x},${spawn.y}`)
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: current.x + dx, y: current.y + dy }
      const key = `${next.x},${next.y}`
      if (reached.has(key) || blocked.has(key) || cellAt(map, next.x, next.y)?.passable !== true) continue
      const edge = edgeBetween(map, current.x, current.y, next.x, next.y)
      if (edge && edge.kind !== 'door' && edge.blocksMove) continue
      reached.add(key)
      queue.push(next)
    }
  }
  const door = map.doors[0]
  assert.ok(reached.has(`${door.x},${door.y}`), 'до порога нельзя пройти')
})

test('post-prop repair открывает межзонный проход и снимает опоры удалённой мебели', () => {
  const map = gateWithFurnishedHall()
  const before = new Set(map.props.map((prop) => prop.id))
  ensurePropAccess(map)

  assert.equal(map.props.some((prop) => prop.id === 'hall-table-0'), false, 'перегородивший проход стол не снят')
  assert.equal(map.props.some((prop) => prop.id === 'hall-mug-0'), false, 'утварь сохранилась после удаления своей поверхности')
  assert.equal(map.props.some((prop) => prop.id === 'outside-decoration'), true, 'repair удалил посторонний проп')
  assert.equal(map.props.length, before.size - 2, 'repair должен снять только стол и его опору')

  const spawn = map.spawnPoints.find((point) => point.role === 'party')
  const reached = reachableCells(map, spawn.x, spawn.y, {
    throughDoors: true,
    blockedCells: new Set(map.props.flatMap((prop) => prop.blocksMove ? prop.footprint.map((cell) => `${cell.x},${cell.y}`) : [])),
  })
  assert.equal(reached.has('6,3'), true, 'изолированный зал не стал доступен после repair')
  assert.equal(reached.has('4,3'), true, 'порог ворот потерян после repair')
})

test('post-prop repair детерминированно проходит несколько мебельных клеток', () => {
  const first = gateWithFurnishedHall({ blockedCells: 2 })
  const second = gateWithFurnishedHall({ blockedCells: 2 })
  ensurePropAccess(first)
  ensurePropAccess(second)
  assert.deepEqual(first.props, second.props)
  assert.equal(first.props.some((prop) => prop.id === 'hall-table-0'), false)
  assert.equal(first.props.some((prop) => prop.id === 'hall-table-1'), false)
  assert.equal(first.props.some((prop) => prop.id === 'outside-decoration'), true)
})

test('required предметы общего building не теряются из-за companions', () => {
  for (const seed of ['s0', 's6', 's10', '39', '200']) {
    const map = generateBuildingScene({ seed })
    const assets = new Set(map.props
      .filter((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'hall')
      .map((prop) => prop.assetId))
    assert.equal(assets.has('stairs_up'), true, `${seed}: в зале пропала лестница`)
    assert.equal(assets.has('chandelier'), true, `${seed}: в зале пропала люстра`)
  }
})

test('required сундук склада переживает bounded packing repair', () => {
  for (const seed of ['s6', 's10', 's189', '39', '200']) {
    const map = generateAresFortressScene({ seed })
    const assets = new Set(map.props
      .filter((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'storehouse')
      .map((prop) => prop.assetId))
    assert.equal(assets.has('crate_stack'), true, `${seed}: пропал штабель ящиков`)
    assert.equal(assets.has('barrel_stack'), true, `${seed}: пропал штабель бочек`)
    assert.equal(assets.has('chest'), true, `${seed}: пропал обязательный сундук`)
  }
})

test('деревья и кусты под открытым небом держат радиус пуассоновского диска', async () => {
  const { generateSceneGeometry } = await import('../server/adventure-director.mjs')
  const radius = { tree_oak: 2.3, tree_pine: 2.3, tree_birch: 1.8, tree_dead: 1.8, bush: 1.2, shrub: 1.2, rock_small: 1.2, boulder: 1.5, tree_stump: 1.2 }
  for (const seed of ['a', 'b']) {
    const { map } = generateSceneGeometry({ location: 'Тёмный лес', theme: 'лес', seed: `poisson:${seed}`, useLibrary: false })
    const nature = map.props.filter((prop) => radius[prop.assetId])
    assert.ok(nature.length >= 40, `${seed}: лес поредел до ${nature.length}`)
    for (let i = 0; i < nature.length; i += 1) for (let j = i + 1; j < nature.length; j += 1) {
      const [a, b] = [nature[i], nature[j]]
      const reach = Math.max(radius[a.assetId], radius[b.assetId])
      const distance = Math.hypot(Math.floor(a.x) - Math.floor(b.x), Math.floor(a.y) - Math.floor(b.y))
      assert.ok(distance >= reach, `${seed}: ${a.assetId} и ${b.assetId} в ${distance.toFixed(2)} клетках`)
    }
  }
})
