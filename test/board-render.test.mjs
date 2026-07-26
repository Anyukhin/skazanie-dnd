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
    translate() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() { ops.push({ op: 'fill', value: styles.fillStyle }) },
    stroke() { ops.push({ op: 'stroke', value: styles.strokeStyle }) },
    fillRect() { ops.push({ op: 'fillRect', value: styles.fillStyle }) },
    strokeRect() { ops.push({ op: 'strokeRect', value: styles.strokeStyle }) },
    clearRect() { ops.push({ op: 'clearRect' }) },
    setLineDash() {},
    drawImage() { ops.push({ op: 'drawImage' }) },
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
