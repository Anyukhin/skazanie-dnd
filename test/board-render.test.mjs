import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  addProp, addZone, canonicalEdge, cellAt as serverCellAt, createTacticalMap, edgeBetween as serverEdgeBetween,
  serializeTacticalMap, setCell, setDoor, setEdge,
} from '../server/tactical-map.mjs'

// Клиентский TypeScript проверяется тем же приёмом, что и `tactical-ui`:
// компиляция во временный каталог и импорт. Дополнительно нужны типы DOM —
// отрисовка работает с 2D-контекстом — и дописывание расширений: tsc оставляет
// спецификаторы без `.js`, а Node ESM их не разрешает.
const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-board-render-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/board-render.ts', '../src/tactical-map-client.ts']
  .map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(buildDir)) {
  if (!name.endsWith('.js')) continue
  const source = readFileSync(join(buildDir, name), 'utf8').replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3')
  writeFileSync(join(buildDir, name.replace(/\.js$/, '.mjs')), source)
  rmSync(join(buildDir, name))
}
const render = await import(pathToFileURL(join(buildDir, 'board-render.mjs')).href)
const client = await import(pathToFileURL(join(buildDir, 'tactical-map-client.mjs')).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

/** Поддельный 2D-контекст: записывает присвоения стилей и вызовы по порядку. */
function recordingContext() {
  const ops = []
  const styles = { fillStyle: '', strokeStyle: '' }
  const context = {
    ops,
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save() { ops.push({ op: 'save' }) },
    restore() { ops.push({ op: 'restore' }) },
    translate(x, y) { ops.push({ op: 'translate', x, y }) },
    rotate(angle) { ops.push({ op: 'rotate', angle }) },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() { ops.push({ op: 'fill', value: styles.fillStyle }) },
    stroke() { ops.push({ op: 'stroke', value: styles.strokeStyle }) },
    fillRect() { ops.push({ op: 'fillRect', value: styles.fillStyle }) },
    strokeRect() { ops.push({ op: 'strokeRect', value: styles.strokeStyle }) },
    fillText(text, x, y) { ops.push({ op: 'fillText', text, x, y, value: styles.fillStyle }) },
    clearRect() { ops.push({ op: 'clearRect' }) },
    setLineDash() {},
    drawImage(...args) { ops.push({ op: 'drawImage', args }) },
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  }
  for (const name of ['fillStyle', 'strokeStyle']) {
    Object.defineProperty(context, name, {
      get: () => styles[name],
      set: (value) => { styles[name] = value; ops.push({ op: 'set', prop: name, value }) },
    })
  }
  return context
}

/** Первое место, где заданный цвет попал в контекст. */
function firstUse(context, color) {
  const index = context.ops.findIndex((item) => item.value === color)
  assert.notEqual(index, -1, `цвет ${color} не попал в контекст`)
  return index
}

function decoded(map) {
  const decodedMap = client.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
  assert.ok(decodedMap, 'карта должна декодироваться')
  return decodedMap
}

function sampleMap() {
  const map = createTacticalMap({ width: 5, height: 4, locationId: 'loc-1', seed: 'seed-1', theme: 'keep' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'dim', label: 'Зал' })
  addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', lightLevel: 'bright', label: 'Двор' })
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      // Клетка 4,3 не существует вовсе: непрямоугольный контур обязан дожить до клиента.
      if (x === 4 && y === 3) continue
      setCell(map, x, y, {
        passable: !(x === 2 && y === 1),
        material: x % 2 ? 'wood' : 'stone',
        variant: (x * 3 + y) % 6,
        revealed: !(x === 0 && y === 3),
        zone: y < 2 ? 'hall' : 'yard',
      })
    }
  }
  setCell(map, 3, 2, { surface: 'water', passable: false, elevation: -3 })
  setCell(map, 1, 0, { elevation: 2, hazardId: 'hazard-fire' })
  setEdge(map, 1, 1, 2, 1, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
  setEdge(map, 0, 0, 0, 1, { kind: 'window', blocksMove: false, blocksSight: false, cover: 'half' })
  setDoor(map, { id: 'door-a', x: 2, y: 2, dir: 'e', state: 'locked', lockDc: 15 })
  addProp(map, { id: 'prop-table', assetId: 'table', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  return map
}

test('декодер читает слои сервера в ту же логическую клетку', () => {
  const map = sampleMap()
  const serialized = serializeTacticalMap(map)
  assert.equal(typeof serialized.layers.moveCost, 'number', 'однородный слой сжимается в число')
  assert.equal(typeof serialized.layers.material, 'string', 'разнородный слой остаётся base64')

  const clientMap = decoded(map)
  assert.equal(clientMap.width, map.width)
  assert.equal(clientMap.height, map.height)
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      assert.deepEqual(client.cellAt(clientMap, x, y), serverCellAt(map, x, y), `клетка ${x},${y}`)
    }
  }
  assert.equal(client.cellAt(clientMap, 4, 3), null, 'несуществующая клетка отличается от непроходимой')
  assert.equal(client.cellAt(clientMap, 2, 1).passable, false)
  assert.equal(client.cellAt(clientMap, 3, 2).elevation, -3, 'знаковая высота')
  assert.equal(client.cellAt(clientMap, 1, 0).elevation, 2)
  assert.equal(client.cellAt(clientMap, 1, 0).hazardId, 'hazard-fire')
  assert.equal(client.cellAt(clientMap, 0, 0).zone, 'hall', 'зона хранится со сдвигом на единицу')
  assert.equal(client.cellAt(clientMap, 0, 2).zone, 'yard')
  assert.equal(client.cellAt(clientMap, 3, 2).surface, 'water')
  assert.equal(client.cellAt(clientMap, 0, 3).revealed, false)

  assert.equal(clientMap.doors.length, 1)
  assert.deepEqual(clientMap.doors[0], { id: 'door-a', x: 2, y: 2, dir: 'e', state: 'locked', lockDc: 15, keyItemId: null })
  assert.equal(clientMap.props.length, 1)
  assert.deepEqual(clientMap.props[0], {
    id: 'prop-table', assetId: 'table', x: 1.5, y: 1.5, rotation: 0, scale: 1,
    footprint: [{ x: 1, y: 1 }], zOrder: 0, blocksMove: false, blocksSight: false,
    cover: 'none', destructible: false, hp: 0, interactive: false, state: '',
  }, 'поля по умолчанию восстанавливаются при чтении')
  assert.deepEqual(clientMap.zones.map((zone) => zone.id), ['hall', 'yard'])
})

test('канонизация ребра на клиенте совпадает с серверной', () => {
  const pairs = [[1, 1, 2, 1], [2, 1, 1, 1], [1, 1, 1, 2], [1, 2, 1, 1], [0, 0, 0, 1], [3, 3, 4, 3]]
  for (const [ax, ay, bx, by] of pairs) {
    assert.deepEqual(client.canonicalEdge(ax, ay, bx, by), canonicalEdge(ax, ay, bx, by), `${ax},${ay} → ${bx},${by}`)
  }
  assert.equal(client.canonicalEdge(0, 0, 2, 2), null, 'несоседние клетки ребра не образуют')

  const map = sampleMap()
  const clientMap = decoded(map)
  for (const [ax, ay, bx, by] of [[1, 1, 2, 1], [2, 1, 1, 1], [0, 1, 0, 0], [2, 2, 3, 2]]) {
    assert.deepEqual(
      client.edgeBetween(clientMap, ax, ay, bx, by),
      serverEdgeBetween(map, ax, ay, bx, by),
      `ребро ${ax},${ay} → ${bx},${by}`,
    )
  }
  assert.deepEqual(
    client.edgeList(clientMap).map((edge) => `${edge.x},${edge.y},${edge.dir},${edge.kind}`),
    ['0,0,s,window', '1,1,e,wall', '2,2,e,door'],
  )
})

test('слои рисуются снизу вверх: пол раньше стен, стены раньше предметов, сетка раньше тумана', () => {
  const map = createTacticalMap({ width: 4, height: 4, fill: { passable: true, revealed: true, material: 'stone' } })
  setCell(map, 3, 3, { revealed: false })
  setEdge(map, 1, 1, 2, 1, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
  addProp(map, { id: 'prop-barrel', assetId: 'barrel', x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }] })
  const clientMap = decoded(map)

  const palette = { ...render.DEFAULT_BOARD_PALETTE, wall: '#ff0000', prop: '#ff00ff', gridLine: '#00ff00', fog: '#0000ff' }
  const scene = { map: clientMap, palette, cellSize: 32 }
  const context = recordingContext()
  render.drawTerrainTile(context, scene, { tileX: 0, tileY: 0 })

  const zone = render.boardFillColor({ kind: 'zone' }, palette, false)
  const floor = render.boardFillColor({ kind: 'floor', cell: client.cellAt(clientMap, 0, 0) }, palette, false)
  const wall = render.boardFillColor({ kind: 'wall', cell: client.cellAt(clientMap, 1, 1) }, palette, false)

  assert.ok(firstUse(context, zone) < firstUse(context, floor), 'фон зоны раньше пола')
  assert.ok(firstUse(context, floor) < firstUse(context, wall), 'пол раньше стен')
  assert.ok(firstUse(context, wall) < firstUse(context, '#ff00ff'), 'стены раньше предметов')
  assert.ok(firstUse(context, '#ff00ff') < firstUse(context, '#00ff00'), 'предметы раньше сетки')
  assert.ok(firstUse(context, '#00ff00') < firstUse(context, '#0000ff'), 'сетка раньше тумана')
})

test('в окно на 10×10 клеток попадает не больше девяти тайлов карты 30×30', () => {
  const map = createTacticalMap({ width: 30, height: 30, fill: { passable: true, revealed: true } })
  const clientMap = decoded(map)
  const tiles = render.visibleTiles(clientMap, { x: 0, y: 0, width: 10, height: 10 })
  assert.ok(tiles.length <= 9, `тайлов ${tiles.length}`)
  const centered = render.visibleTiles(clientMap, { x: 10, y: 10, width: 10, height: 10 })
  assert.ok(centered.length <= 9, `тайлов ${centered.length}`)
  assert.ok(render.visibleTiles(clientMap, { x: 0, y: 0, width: 30, height: 30 }).length <= 9)
})

test('кэш тайлов перерисовывает только то, что изменилось', () => {
  const map = createTacticalMap({ width: 32, height: 32, fill: { passable: true, revealed: true, material: 'stone' } })
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 16 }
  const tiles = render.visibleTiles(scene.map, { x: 0, y: 0, width: 32, height: 32 })
  assert.equal(tiles.length, 4)
  const cache = render.createTileCache()
  const createSurface = () => ({ canvas: {}, context: recordingContext() })

  const first = render.syncTileCache(cache, scene, tiles, createSurface)
  assert.equal(first.drawn.length, 4, 'первый кадр рисует все видимые тайлы')

  const second = render.syncTileCache(cache, scene, tiles, createSurface)
  assert.equal(second.drawn.length, 0, 'кадр без изменений не перерисовывает ни одного тайла')
  assert.equal(second.reused.length, 4)

  // Раскрытие меняется в одной клетке тайла 1,1.
  setCell(map, 20, 20, { revealed: false })
  const changed = { ...scene, map: decoded(map) }
  assert.equal(changed.map.terrainHash, scene.map.terrainHash, 'раскрытие не входит в отпечаток местности')
  const third = render.syncTileCache(cache, changed, tiles, createSurface)
  assert.equal(third.drawn.length, 1, 'перерисовывается ровно один тайл')
  assert.equal(third.reused.length, 3)
})

test('кэш тайлов не растёт без границ', () => {
  const map = createTacticalMap({ width: 100, height: 100, fill: { passable: true, revealed: true } })
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 8 }
  const cache = render.createTileCache(4)
  const createSurface = () => ({ canvas: {}, context: recordingContext() })
  for (let tileY = 0; tileY < 7; tileY += 1) {
    render.syncTileCache(cache, scene, [{ tileX: 0, tileY }], createSurface)
  }
  assert.ok(cache.entries.size <= 4, `в кэше ${cache.entries.size} тайлов`)
})

test('при максимальном отдалении предметы остаются видимыми меткой', () => {
  const map = createTacticalMap({ width: 4, height: 4, fill: { passable: true, revealed: true } })
  addProp(map, { id: 'prop-crate', assetId: 'crate', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  const clientMap = decoded(map)
  const tile = { tileX: 0, tileY: 0 }

  assert.equal(render.PROP_MIN_CELL_PIXELS, 12)
  assert.equal(render.propsInTile(clientMap, tile, render.PROP_MIN_CELL_PIXELS - 1).length, 1)
  assert.equal(render.propsInTile(clientMap, tile, render.PROP_MIN_CELL_PIXELS).length, 1)

  const palette = { ...render.DEFAULT_BOARD_PALETTE, prop: '#ff00ff' }
  const context = recordingContext()
  render.drawProps(context, { map: clientMap, palette, cellSize: 8 }, tile)
  assert.ok(context.ops.length > 0, 'на общем плане предмет обязан оставаться меткой, а не исчезать')
})

/** Атлас-пустышка: важны только кадры и размеры, картинка в тестах не рисуется. */
function stubAtlas(frames) {
  return { texture: { image: {}, width: 512, height: 512 }, frames, key: 'stub-atlas' }
}

test('штамп из атласа заменяет вектор и сохраняет пропорцию рисунка', () => {
  const map = createTacticalMap({ width: 4, height: 4, fill: { passable: true, revealed: true } })
  addProp(map, { id: 'prop-crate', assetId: 'crate', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  const clientMap = decoded(map)
  const tile = { tileX: 0, tileY: 0 }
  const palette = render.DEFAULT_BOARD_PALETTE
  const cellSize = 48

  const context = recordingContext()
  const atlas = stubAtlas({ crate: { x: 10, y: 20, w: 96, h: 48 } })
  render.drawProps(context, { map: clientMap, palette, cellSize, propAtlas: atlas }, tile)
  const stamp = context.ops.find((item) => item.op === 'drawImage')
  assert.ok(stamp, 'при наличии кадра предмет обязан рисоваться штампом')
  const [, sx, sy, sw, sh, , , dw, dh] = stamp.args
  assert.deepEqual([sx, sy, sw, sh], [10, 20, 96, 48], 'окно берётся из кадра атласа')
  assert.ok(Math.abs(dw / dh - 2) < 1e-6, `пропорция рисунка поехала: ${dw}×${dh}`)
  // Габарит клетки 1×1 — растянуть кадр 2:1 на квадрат нельзя.
  const box = cellSize * render.PROP_FOOTPRINT_FILL
  assert.ok(dw <= box + 1e-6 && dh <= box + 1e-6, `штамп вышел за габарит: ${dw}×${dh} при ${box}`)
})

test('без атласа и без своего кадра предмет остаётся векторным', () => {
  const map = createTacticalMap({ width: 4, height: 4, fill: { passable: true, revealed: true } })
  addProp(map, { id: 'prop-crate', assetId: 'crate', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  const clientMap = decoded(map)
  const tile = { tileX: 0, tileY: 0 }
  const palette = render.DEFAULT_BOARD_PALETTE

  // Играбельность без арта — блокирующее требование (решение Р6 плана).
  const withoutAtlas = recordingContext()
  render.drawProps(withoutAtlas, { map: clientMap, palette, cellSize: 48 }, tile)
  assert.equal(withoutAtlas.ops.some((item) => item.op === 'drawImage'), false)
  assert.ok(withoutAtlas.ops.length > 2, 'без атласа предмет обязан быть нарисован вектором')

  // Атлас есть, но кадра этого предмета в нём нет: темы подключаются по одной.
  const foreign = recordingContext()
  render.drawProps(foreign, { map: clientMap, palette, cellSize: 48, propAtlas: stubAtlas({ barrel: { x: 0, y: 0, w: 8, h: 8 } }) }, tile)
  assert.equal(foreign.ops.some((item) => item.op === 'drawImage'), false)
  assert.ok(foreign.ops.length > 2)
})

test('на общем плане штамп уступает силуэту, а ключ тайла помнит про атлас', () => {
  const map = createTacticalMap({ width: 4, height: 4, fill: { passable: true, revealed: true } })
  addProp(map, { id: 'prop-crate', assetId: 'crate', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  const clientMap = decoded(map)
  const tile = { tileX: 0, tileY: 0 }
  const palette = render.DEFAULT_BOARD_PALETTE
  const atlas = stubAtlas({ crate: { x: 0, y: 0, w: 96, h: 96 } })

  const small = recordingContext()
  render.drawProps(small, { map: clientMap, palette, cellSize: render.PROP_FULL_DETAIL_CELL_PIXELS - 1, propAtlas: atlas }, tile)
  assert.equal(small.ops.some((item) => item.op === 'drawImage'), false,
    'на мелкой клетке штамп не нужен: там всё равно несколько пикселей')

  // Подгрузка атласа обязана обесценить кэш тайла, иначе местность останется
  // нарисованной вектором до первого изменения карты.
  const withoutAtlas = render.tileKey({ map: clientMap, palette, cellSize: 48 }, tile)
  const withAtlas = render.tileKey({ map: clientMap, palette, cellSize: 48, propAtlas: atlas }, tile)
  assert.notEqual(withoutAtlas, withAtlas)
})

/** Тайлсет-пустышка: плитка на восемь клеток, картинка в тестах не рисуется. */
function stubTerrain(floors = ['wood'], surfaces = [], walls = ['stone']) {
  const texture = { image: {}, width: 512, height: 512 }
  const asMap = (keys) => new Map(keys.map((key) => [key, texture]))
  return { cellsPerTile: 8, floors: asMap(floors), surfaces: asMap(surfaces), walls: asMap(walls), key: 'stub-terrain' }
}

test('фактура пола раскладывается по карте непрерывно, а не повторяется в каждой клетке', () => {
  const map = createTacticalMap({ width: 12, height: 4, fill: { passable: true, revealed: true, material: 'wood' } })
  const clientMap = decoded(map)
  const context = recordingContext()
  const scene = { map: clientMap, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 40, terrain: stubTerrain() }
  render.drawFloorTiles(context, scene, { tileX: 0, tileY: 0 })

  const stamps = context.ops.filter((item) => item.op === 'drawImage')
  assert.equal(stamps.length, 48, 'каждая клетка обязана получить свой кусок фактуры')
  // Клетка (0,0) и клетка (1,0) берут соседние окна, а (8,0) — снова первое:
  // плитка на восемь клеток, значит через восемь клеток рисунок повторяется.
  const window = (index) => stamps[index].args.slice(1, 5)
  assert.deepEqual(window(0), [0, 0, 64, 64])
  assert.deepEqual(window(1), [64, 0, 64, 64])
  assert.deepEqual(window(8), window(0))
})

test('направление настила берётся из зоны и поворачивает только вертикальную зону', () => {
  const map = createTacticalMap({ width: 2, height: 1 })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', floorDirection: 'horizontal' })
  addZone(map, { id: 'store', kind: 'interior', material: 'wood', floorDirection: 'vertical' })
  setCell(map, 0, 0, { passable: true, revealed: true, material: 'wood', zone: 'hall' })
  setCell(map, 1, 0, { passable: true, revealed: true, material: 'wood', zone: 'store' })
  const context = recordingContext()
  render.drawFloorTiles(context, {
    map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 40, terrain: stubTerrain(),
  }, { tileX: 0, tileY: 0 })
  const turns = context.ops.filter((item) => item.op === 'rotate').map((item) => item.angle)
  assert.equal(turns.length, 1, 'горизонтальная зона не должна поворачиваться вместе с вертикальной')
  assert.ok(Math.abs(turns[0] - Math.PI / 2) < 1e-9, 'вертикальный настил не повернулся на четверть оборота')
})

test('уровень света заметно различает зоны и не рисуется под туманом', () => {
  const map = createTacticalMap({ width: 3, height: 1 })
  addZone(map, { id: 'sun', kind: 'exterior', material: 'grass', lightLevel: 'bright' })
  addZone(map, { id: 'crypt', kind: 'interior', material: 'stone', lightLevel: 'dark' })
  setCell(map, 0, 0, { passable: true, revealed: true, zone: 'sun' })
  setCell(map, 1, 0, { passable: true, revealed: true, zone: 'crypt' })
  setCell(map, 2, 0, { passable: true, revealed: false, zone: 'crypt' })
  const context = recordingContext()
  render.drawZoneLighting(context, {
    map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 40,
  }, { tileX: 0, tileY: 0 })
  const fills = context.ops.filter((item) => item.op === 'fillRect')
  assert.equal(fills.length, 2, 'скрытая тёмная клетка не должна выдавать свою зону световой заливкой')
  assert.ok(fills.some((item) => item.value === render.zoneLightTreatment('bright')), 'солнечная зона не подсвечена')
  assert.ok(fills.some((item) => item.value === render.zoneLightTreatment('dark')), 'тёмная зона не затемнена')
  assert.notEqual(render.zoneLightTreatment('bright'), render.zoneLightTreatment('dark'))
})

test('стена берёт фактуру кладки, а не пола', () => {
  assert.equal(render.wallTextureKeyFor('wood'), 'wood')
  assert.equal(render.wallTextureKeyFor('marble'), 'plaster')
  assert.equal(render.wallTextureKeyFor('grass'), 'cave', 'земля и трава — это порода, а не постройка')

  const map = createTacticalMap({ width: 2, height: 1, fill: { passable: true, revealed: true, material: 'stone' } })
  setCell(map, 1, 0, { passable: false })
  const clientMap = decoded(map)
  const keys = render.terrainKeysFor(clientMap)
  assert.deepEqual(keys.floors, ['stone'])
  assert.deepEqual(keys.walls, ['stone'], 'непроходимой клетке нужна фактура кладки')
})

test('карте запрашиваются только те фактуры, которые на ней есть', () => {
  const map = createTacticalMap({ width: 4, height: 4, fill: { passable: true, revealed: true, material: 'grass' } })
  setCell(map, 1, 1, { material: 'wood' })
  setCell(map, 2, 2, { surface: 'water' })
  const keys = render.terrainKeysFor(decoded(map))
  assert.deepEqual(keys.floors, ['grass', 'wood'])
  assert.deepEqual(keys.surfaces, ['water'])
  assert.equal(keys.floors.includes('marble'), false, 'мрамор на этой карте не нужен и грузиться не должен')
})

test('дверь, окно, ограда, бойница и решётка рисуются своими штампами и имеют fallback', () => {
  const map = createTacticalMap({ width: 4, height: 4, fill: { passable: true, revealed: true } })
  setEdge(map, 1, 1, 2, 1, { kind: 'door', doorId: 'door-1' })
  setDoor(map, { id: 'door-1', x: 1, y: 1, dir: 'e', state: 'locked' })
  setEdge(map, 2, 2, 2, 3, { kind: 'window' })
  setEdge(map, 0, 0, 0, 1, { kind: 'rail' })
  setEdge(map, 0, 2, 1, 2, { kind: 'loophole' })
  setEdge(map, 2, 0, 3, 0, { kind: 'grate' })
  const clientMap = decoded(map)
  const tile = { tileX: 0, tileY: 0 }
  const palette = render.DEFAULT_BOARD_PALETTE
  const frames = {
    door_iron: { x: 0, y: 0, w: 96, h: 36 },
    window_glazed: { x: 96, y: 0, w: 96, h: 40 },
    rail_fence: { x: 192, y: 0, w: 96, h: 35 },
    arrow_slit: { x: 288, y: 0, w: 96, h: 37 },
    portcullis_gate: { x: 384, y: 0, w: 96, h: 36 },
  }

  const withStamps = recordingContext()
  render.drawEdgeSegments(withStamps, { map: clientMap, palette, cellSize: 48, propAtlas: stubAtlas(frames) }, tile)
  const drawn = withStamps.ops.filter((item) => item.op === 'drawImage').map((item) => item.args.slice(1, 5))
  assert.equal(drawn.length, 5, 'каждый из пяти видов проёма обязан взять свой штамп')
  // Запертая дверь показывается окованной: состояние обязано читаться с карты.
  assert.ok(drawn.some((window) => window[0] === 0 && window[2] === 96), 'запертая дверь взяла не тот кадр')
  assert.ok(drawn.some((window) => window[0] === 288), 'бойница не взяла arrow_slit')
  assert.ok(drawn.some((window) => window[0] === 384), 'решётка не взяла portcullis_gate')

  const withoutStamps = recordingContext()
  render.drawEdgeSegments(withoutStamps, { map: clientMap, palette, cellSize: 48 }, tile)
  assert.equal(withoutStamps.ops.some((item) => item.op === 'drawImage'), false)
  assert.ok(withoutStamps.ops.length > 3, 'без атласа дверь и окно обязаны рисоваться заливками')
})

test('без арта каждая клетка получает непрозрачный цвет, а пол, стена и дверь различаются', () => {
  const map = createTacticalMap({ width: 6, height: 6, fill: { passable: true, revealed: true } })
  for (let index = 0; index < 6; index += 1) {
    setCell(map, index, 0, { material: ['stone', 'wood', 'earth', 'grass', 'sand', 'marble'][index], variant: index })
  }
  setCell(map, 0, 1, { surface: 'water', passable: false })
  const clientMap = decoded(map)
  const palette = render.DEFAULT_BOARD_PALETTE

  const seen = new Set()
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 6; x += 1) {
      const cell = client.cellAt(clientMap, x, y)
      const color = render.boardFillColor({ kind: 'floor', cell }, palette, false)
      assert.match(color, /^#[0-9a-f]{6}$/, `клетка ${x},${y} получила ${color}`)
      seen.add(color)
    }
  }
  assert.ok(seen.size > 1, 'разные материалы дают разные цвета')
  // Непроходимая клетка без поверхности читается глуше проходимой того же материала.
  assert.notEqual(
    render.boardFillColor({ kind: 'floor', cell: client.cellAt(clientMap, 0, 1) }, palette, false),
    render.boardFillColor({ kind: 'floor', cell: client.cellAt(clientMap, 0, 2) }, palette, false),
  )

  const floor = render.boardFillColor({ kind: 'floor', cell: client.cellAt(clientMap, 0, 2) }, palette, false)
  const wall = render.boardFillColor({ kind: 'wall' }, palette, false)
  const door = render.boardFillColor({ kind: 'door', state: 'closed' }, palette, false)
  const window = render.boardFillColor({ kind: 'window' }, palette, false)
  assert.notEqual(wall, floor, 'стена отличается от пола')
  assert.notEqual(door, wall, 'дверь отличается от стены')
  assert.notEqual(door, floor, 'дверь отличается от пола')
  assert.notEqual(window, door, 'окно отличается от двери')
  for (const color of [wall, door, window]) assert.match(color, /^#[0-9a-f]{6}$/)

  // Состояния двери различимы: запертая и выбитая не сливаются с закрытой.
  const states = ['open', 'closed', 'locked', 'broken'].map((state) => render.boardFillColor({ kind: 'door', state }, palette, false))
  assert.equal(new Set(states).size >= 3, true)
})

test('палитра темы не отменяет собственных тонов листвы', () => {
  // Тема задаёт пол, стены и сетку; тон листвы из них не выводится — цвет
  // земли и цвет кроны лежат в одном оливковом диапазоне, и выведенная крона
  // тонула в газоне. Поэтому листва обязана пережить чтение темы как есть.
  const themed = render.boardPaletteFrom((name) => ({
    '--map-floor': '#c9b48a',
    '--map-floor-alt': '#d2bd93',
    '--map-wall': '#2f2a24',
    '--map-grid-line': 'rgba(0,0,0,.2)',
  }[name] ?? ''))
  assert.equal(themed.floor, '#c9b48a', 'тема задаёт пол')
  assert.equal(themed.foliage, render.DEFAULT_BOARD_PALETTE.foliage, 'тон кроны потерян')
  assert.equal(themed.foliageLight, render.DEFAULT_BOARD_PALETTE.foliageLight, 'тон просвета потерян')

  // И без единой переменной темы палитра всё равно полная.
  const bare = render.boardPaletteFrom(() => '')
  for (const key of Object.keys(render.DEFAULT_BOARD_PALETTE)) {
    assert.ok(bare[key], `в палитре без темы нет поля ${key}`)
  }
})

test('доска без поля map собирается из старых клеток', () => {
  const cells = []
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      cells.push({ x, y, type: x === 1 && y === 1 ? 'wall' : 'floor', revealed: true, material: 'stone', variant: 0 })
    }
  }
  cells.push({ x: 3, y: 1, type: 'door', revealed: true })
  const map = client.sceneTacticalMap({ cells })
  assert.ok(map)
  assert.equal(client.cellAt(map, 1, 1).passable, false)
  assert.equal(client.cellAt(map, 0, 0).passable, true)
  assert.equal(client.edgeBetween(map, 1, 1, 1, 0).kind, 'wall', 'клетка-стена даёт рёбра к проходимым соседям')
  assert.equal(map.doors.length, 1)
  assert.ok(map.terrainHash)
  assert.equal(client.sceneTacticalMap({ cells: [] }), null)
})

test('печатные оверлеи не рисуют координаты, но сохраняют компас, масштаб и раскрытые подписи комнат', () => {
  const map = createTacticalMap({ width: 28, height: 4 })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'dim', label: 'Общий зал' })
  addZone(map, { id: 'secret', kind: 'interior', material: 'stone', lightLevel: 'dark', label: 'Тайник' })
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 28; x += 1) setCell(map, x, y, { passable: true, revealed: true, zone: 'hall' })
  }
  setCell(map, 27, 3, { zone: 'secret', revealed: false })
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: [
      { zoneId: 'hall', label: 'Общий зал' },
      { zoneId: 'secret', label: 'Тайник' },
    ],
  }
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32 }
  assert.deepEqual(
    render.revealedRoomLabelPlacements(scene.map).map((entry) => entry.label),
    ['Общий зал'],
    'подпись скрытой зоны не должна выходить сквозь туман',
  )

  const context = recordingContext()
  render.drawMapDecorations(context, scene)
  const labels = context.ops.filter((item) => item.op === 'fillText').map((item) => item.text)
  for (const expected of ['Общий зал', 'С', '20 футов']) {
    assert.ok(labels.includes(expected), `на печатной карте нет «${expected}»`)
  }
  for (const hidden of ['A', 'Z', 'AA', '1']) {
    assert.equal(labels.includes(hidden), false, `шахматная координата «${hidden}» не должна рисоваться`)
  }
  assert.equal(labels.includes('Тайник'), false, 'туман не скрывает подпись тайной комнаты')
})

test('предмет на шве тайлов не остаётся половиной после смены раскрытия', () => {
  const map = createTacticalMap({ width: 32, height: 32, fill: { passable: true, revealed: true, material: 'wood' } })
  // Стойка 4×1 стоит якорем в тайле 0,0 и заходит рисунком в тайл 1,0.
  addProp(map, {
    id: 'counter', assetId: 'bar_counter', x: 15.5, y: 8.5, rotation: 0, scale: 1,
    footprint: [{ x: 14, y: 8 }, { x: 15, y: 8 }, { x: 16, y: 8 }, { x: 17, y: 8 }], zOrder: 0,
  })
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32 }
  const left = { tileX: 0, tileY: 0 }
  const right = { tileX: 1, tileY: 0 }

  assert.ok(render.propsInTile(scene.map, left, scene.cellSize).some((prop) => prop.id === 'counter'))
  assert.ok(render.propsInTile(scene.map, right, scene.cellSize).some((prop) => prop.id === 'counter'),
    'рисунок стойки обязан заходить в соседний тайл')

  const before = { left: render.tileKey(scene, left), right: render.tileKey(scene, right) }
  // Якорная клетка предмета лежит в левом тайле: именно она решает видимость.
  setCell(map, 15, 8, { revealed: false })
  const after = { map: decoded(map), palette: scene.palette, cellSize: scene.cellSize }

  assert.notEqual(render.tileKey(after, left), before.left, 'левый тайл обязан перерисоваться')
  assert.notEqual(render.tileKey(after, right), before.right,
    'правый тайл рисует ту же стойку и обязан перерисоваться вместе с ней')
})

test('запас отпечатка не делает соседние тайлы зависимыми без нужды', () => {
  const map = createTacticalMap({ width: 64, height: 64, fill: { passable: true, revealed: true } })
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 16 }
  const far = { tileX: 3, tileY: 3 }
  const before = render.tileKey(scene, far)
  // Клетка далеко за пределами запаса: 48 - 4 = 44, меняем 20,20.
  setCell(map, 20, 20, { revealed: false })
  const after = { ...scene, map: decoded(map) }
  assert.equal(render.tileKey(after, far), before, 'далёкий тайл не должен зависеть от чужого раскрытия')
})
