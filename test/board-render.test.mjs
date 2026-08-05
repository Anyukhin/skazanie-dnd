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
const sources = ['../src/board-render.ts', '../src/board-lighting.ts', '../src/board-ambient.ts', '../src/tactical-map-client.ts']
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
const lighting = await import(pathToFileURL(join(buildDir, 'board-lighting.mjs')).href)
const ambient = await import(pathToFileURL(join(buildDir, 'board-ambient.mjs')).href)
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
    beginPath() { ops.push({ op: 'beginPath' }) },
    closePath() {},
    moveTo(x, y) { ops.push({ op: 'moveTo', x, y }) },
    lineTo(x, y) { ops.push({ op: 'lineTo', x, y }) },
    arc(x, y, radius) { ops.push({ op: 'arc', x, y, radius }) },
    fill() { ops.push({ op: 'fill', value: styles.fillStyle, alpha: context.globalAlpha }) },
    stroke() { ops.push({ op: 'stroke', value: styles.strokeStyle, alpha: context.globalAlpha }) },
    fillRect(x, y, width, height) { ops.push({ op: 'fillRect', value: styles.fillStyle, alpha: context.globalAlpha, x, y, width, height }) },
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

test('труднопроходимая клетка и опасность получают разные читаемые слои canvas', () => {
  const map = sampleMap()
  setCell(map, 1, 0, { moveCost: 2 })
  const clientMap = decoded(map)
  const context = recordingContext()
  const scene = { map: clientMap, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32 }

  render.drawCellFeatures(context, scene, { tileX: 0, tileY: 0 })

  const fire = render.hazardPresentation('hazard-fire')
  assert.equal(fire.kind, 'fire')
  assert.equal(fire.label, 'Огонь')
  assert.ok(context.ops.some((item) => item.op === 'fillRect' && item.value === 'rgba(80,64,44,.16)'),
    'трудная местность не получила подложку штриховки')
  assert.ok(context.ops.some((item) => item.op === 'stroke' && item.value === 'rgba(235,211,157,.38)'),
    'диагональная штриховка не нарисована')
  assert.ok(context.ops.some((item) => item.op === 'fillRect' && item.value === fire.fill),
    'опасность не получила заливку своего типа')
  assert.ok(context.ops.some((item) => item.op === 'strokeRect' && item.value === fire.stroke),
    'опасность не получила контур')
  assert.ok(context.ops.some((item) => item.op === 'fillText' && item.text === 'ОГОНЬ'),
    'крупная клетка опасности не подписана')
})

test('палитра опасностей различает типы и имеет безопасный общий вариант', () => {
  const fire = render.hazardPresentation('hazard-fire')
  const cold = render.hazardPresentation('ice-field')
  const unknown = render.hazardPresentation('falling-rocks')
  assert.notEqual(fire.fill, cold.fill)
  assert.equal(cold.kind, 'cold')
  assert.equal(unknown.kind, 'physical')
  assert.equal(unknown.label, 'Опасность')
})

test('единая точка эффектов сохраняет порядок и изолирует состояние рендереров', () => {
  const context = recordingContext()
  const calls = []
  render.drawBoardEffects(context, {
    map: decoded(sampleMap()),
    palette: render.DEFAULT_BOARD_PALETTE,
    cellSize: 24,
  }, [
    () => calls.push('area'),
    () => calls.push('animation'),
  ])
  assert.deepEqual(calls, ['area', 'animation'])
  assert.equal(context.ops.filter((item) => item.op === 'save').length, 2)
  assert.equal(context.ops.filter((item) => item.op === 'restore').length, 2)
})

test('активная трудная область штрихуется динамическим слоем и не раскрывает туман', () => {
  const map = decoded(sampleMap())
  const context = recordingContext()
  const scene = { map, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32 }

  render.drawDifficultTerrainEffects(context, scene, [
    { center: { x: 1, y: 0 }, radiusFeet: 0 },
    { cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }] },
  ])

  const fills = context.ops.filter((item) => item.op === 'fillRect' && item.value === 'rgba(103,73,44,.22)')
  assert.equal(fills.length, 3)
  assert.ok(context.ops.some((item) => item.op === 'strokeRect' && item.value === 'rgba(244,205,132,.62)'))

  setCell(map, 0, 1, { revealed: false })
  const hiddenContext = recordingContext()
  render.drawDifficultTerrainEffects(hiddenContext, scene, [{ cells: [{ x: 0, y: 1 }] }])
  assert.equal(hiddenContext.ops.some((item) => item.op === 'fillRect'), false)
})

test('длящаяся область показывает собственный контур, владельца и концентрацию', () => {
  const map = decoded(sampleMap())
  const context = recordingContext()
  const scene = { map, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32 }

  render.drawLingeringSpellEffects(context, scene, [{
    id: 'spell:web:hero',
    spellId: 'web',
    center: { x: 1, y: 1 },
    radiusFeet: 5,
    sourceActor: 'hero',
    ownerLabel: 'Ада',
    concentration: true,
    difficultTerrain: true,
  }])

  assert.ok(context.ops.some((item) => item.op === 'fillRect' && item.value === 'rgba(122,106,142,.16)'),
    'паутина не получила собственную спокойную палитру')
  assert.ok(context.ops.some((item) => item.op === 'stroke' && item.value === 'rgba(203,184,221,.78)'),
    'внешний контур области не нарисован')
  assert.ok(context.ops.some((item) => item.op === 'fillText' && item.text === 'ПАУТИНА · К'),
    'концентрация не отмечена рядом с названием зоны')
  assert.ok(context.ops.some((item) => item.op === 'fillText' && item.text === 'Источник: Ада'),
    'владелец эффекта не показан')
  assert.ok(context.ops.some((item) => item.op === 'fillRect' && item.value === 'rgba(103,73,44,.22)'),
    'трудная местность внутри области должна сохранить штриховку')
})

test('геометрия длящейся области берётся из areaCells и ограничивается картой', () => {
  const map = decoded(sampleMap())
  const cells = render.boardAreaEffectCells({
    center: { x: 0, y: 0 },
    radiusFeet: 5,
    areaShape: 'sphere',
  }, map)
  assert.deepEqual(cells, [
    { x: 0, y: 0 }, { x: 1, y: 0 },
    { x: 0, y: 1 }, { x: 1, y: 1 },
  ])
  assert.deepEqual(
    render.boardAreaEffectCells({ cells: [{ x: 3, y: 2 }] }, map),
    [{ x: 3, y: 2 }],
    'явные клетки стены/линии важнее восстановленной геометрии',
  )
})

test('ступень высоты подписана прямо на раскрытой клетке', () => {
  const map = sampleMap()
  setCell(map, 4, 0, { elevation: 5, revealed: true })
  const context = recordingContext()
  render.drawCellFeatures(context, {
    map: decoded(map),
    palette: render.DEFAULT_BOARD_PALETTE,
    cellSize: 32,
  }, { tileX: 0, tileY: 0 })
  assert.ok(context.ops.some((item) => item.op === 'fillText' && item.text === '+5 фт'))
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

test('факел и лестницы остаются художественными штампами на общем плане', () => {
  const map = createTacticalMap({ width: 4, height: 2, fill: { passable: true, revealed: true } })
  for (const [index, assetId] of ['torch_wall', 'stairs_up', 'stairs_down', 'crate'].entries()) {
    addProp(map, {
      id: `prop-${assetId}`,
      assetId,
      x: index + 0.5,
      y: 0.5,
      footprint: [{ x: index, y: 0 }],
    })
  }
  const frames = {
    torch_wall: { x: 10, y: 0, w: 40, h: 80 },
    stairs_up: { x: 60, y: 0, w: 96, h: 48 },
    stairs_down: { x: 160, y: 0, w: 96, h: 48 },
    crate: { x: 260, y: 0, w: 96, h: 96 },
  }
  const context = recordingContext()
  render.drawProps(context, {
    map: decoded(map),
    palette: render.DEFAULT_BOARD_PALETTE,
    cellSize: render.PROP_MIN_CELL_PIXELS - 1,
    propAtlas: stubAtlas(frames),
  }, { tileX: 0, tileY: 0 })

  const sourceX = context.ops
    .filter((item) => item.op === 'drawImage')
    .map((item) => item.args[1])
  assert.deepEqual(sourceX.sort((left, right) => left - right), [10, 60, 160],
    'факел и лестницы должны брать готовый арт, а обычный предмет на таком масштабе — дешёвую метку')
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
  // Дерево берёт вдвое больше пикселей исходника на клетку: доски становятся
  // мельче, соседние окна остаются сшитыми, а повтор наступает через 4 клетки.
  const window = (index) => stamps[index].args.slice(1, 5)
  assert.deepEqual(window(0), [0, 0, 128, 128])
  assert.deepEqual(window(1), [128, 0, 128, 128])
  assert.deepEqual(window(4), window(0))
})

test('масштаб уменьшается у досок и каменной кладки, но не у природных фактур', () => {
  assert.equal(render.WOOD_TEXTURE_REPEAT_SCALE, 2)
  assert.equal(render.terrainCellsPerTileFor('wood', 8), 4)
  // Кладка: булыжник пола и блоки стен были размером с полклетки рядом с фишкой.
  for (const material of ['stone', 'marble', 'metal']) {
    assert.equal(render.terrainCellsPerTileFor(material, 8), 4, `${material} обязан стать мельче клетки`)
  }
  // У земли, травы, песка и льда нет заметного модуля — уменьшение дало бы шум.
  for (const material of ['earth', 'grass', 'sand', 'ice']) {
    assert.equal(render.terrainCellsPerTileFor(material, 8), 8, `${material} не должен менять масштаб`)
  }

  const map = createTacticalMap({ width: 2, height: 1, fill: { passable: true, revealed: true, material: 'wood' } })
  setEdge(map, 0, 0, 1, 0, { kind: 'wall' })
  const context = recordingContext()
  render.drawEdgeSegments(context, {
    map: decoded(map),
    palette: render.DEFAULT_BOARD_PALETTE,
    cellSize: 48,
    terrain: stubTerrain(['wood'], [], ['wood']),
  }, { tileX: 0, tileY: 0 })
  const timber = context.ops.find((item) => item.op === 'drawImage')
  assert.ok(timber, 'деревянная стена должна получить растровую фактуру')
  assert.equal(timber.args[4], 128, 'на клетку стены должно приходиться вдвое больше исходника')
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

test('свет запекается в тайл: тьма по сетке, тень у стены и тёплый ореол у огня', () => {
  const map = createTacticalMap({ width: 16, height: 16, locationId: 'loc', seed: 'light', theme: 'crypt' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'stone', lightLevel: 'dim', label: 'Палата' })
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) setCell(map, x, y, { passable: true, revealed: true, material: 'stone', zone: 'hall' })
  }
  setCell(map, 15, 15, { revealed: false })
  setEdge(map, 4, 4, 5, 4, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
  addProp(map, { id: 'torch', assetId: 'torch_wall', x: 2.5, y: 2.5, footprint: [{ x: 2, y: 2 }] })

  const palette = { ...render.DEFAULT_BOARD_PALETTE, lightShadow: '#111827', lightWarm: '#ffa500' }
  const scene = { map: decoded(map), palette, cellSize: 32 }
  const context = recordingContext()
  render.drawLightShading(context, scene, { tileX: 0, tileY: 0 })

  const shadows = context.ops.filter((item) => item.op === 'fillRect' && item.value === '#111827')
  const halo = context.ops.filter((item) => item.op === 'fill' && item.value === '#ffa500')
  // 256 клеток тайла минус нераскрытая, плюс две полосы тени у единственной стены.
  assert.equal(shadows.length, 255 + 2, `заливок тьмы ${shadows.length}`)
  assert.equal(halo.length, 3, 'ореол факела рисуется тремя кольцами')
  assert.equal(context.globalAlpha, 1, 'прозрачность обязана вернуться к единице')

  // Освещённость обязана доходить до рисования: у факела темнее не становится.
  const grid = lighting.computeLightGrid(scene.map)
  const atTorch = render.lightShadowAlpha(grid[2 * 16 + 2])
  const far = render.lightShadowAlpha(grid[14 * 16 + 14])
  assert.ok(atTorch < far, `у факела альфа тьмы ${atTorch} обязана быть меньше дальней ${far}`)
})

test('тайл со светом рисуется целиком и в отсутствие арта', () => {
  const map = createTacticalMap({ width: 16, height: 16, fill: { passable: true, revealed: true, material: 'wood' } })
  addProp(map, { id: 'fire', assetId: 'campfire', x: 8.5, y: 8.5, footprint: [{ x: 8, y: 8 }] })
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 24 }
  const context = recordingContext()
  assert.doesNotThrow(() => render.drawTerrainTile(context, scene, { tileX: 0, tileY: 0 }))
  assert.ok(context.ops.some((item) => item.op === 'fill' && item.value === render.DEFAULT_BOARD_PALETTE.lightWarm),
    'тёплый ореол костра обязан попасть в тайл')
})

test('ключ тайла меняется от источника света и этажа, но не от панорамы', () => {
  const map = createTacticalMap({ width: 32, height: 32, fill: { passable: true, revealed: true }, theme: 'crypt' })
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 16 }
  const tile = { tileX: 0, tileY: 0 }
  const before = render.tileKey(scene, tile)

  // Панорама и зум окна: тайл тот же, ключ обязан совпасть до символа.
  const near = render.visibleTiles(scene.map, { x: 0, y: 0, width: 16, height: 16 })
  const shifted = render.visibleTiles(scene.map, { x: 8, y: 4, width: 16, height: 16 })
  assert.ok(near.some((item) => item.tileX === 0 && item.tileY === 0))
  assert.ok(shifted.some((item) => item.tileX === 0 && item.tileY === 0))
  assert.equal(render.tileKey(scene, tile), before, 'панорама ключ тайла не трогает')

  addProp(map, { id: 'torch', assetId: 'torch_wall', x: 3.5, y: 3.5, footprint: [{ x: 3, y: 3 }] })
  const lit = { ...scene, map: decoded(map) }
  assert.notEqual(render.tileKey(lit, tile), before, 'новый факел обязан обесценить тайл')

  // Этаж в отпечаток местности не входит, а амбиент подвала другой.
  const cellar = createTacticalMap({ width: 32, height: 32, fill: { passable: true, revealed: true }, theme: 'crypt', levelIndex: -1 })
  const cellarScene = { ...scene, map: decoded(cellar) }
  assert.equal(cellarScene.map.terrainHash, scene.map.terrainHash, 'этажи различаются только номером')
  assert.notEqual(render.tileKey(cellarScene, tile), before, 'у подвала обязан быть свой ключ тайла')
})

/** Ровное поле одного материала: вход для проверок декалей и вариантов. */
function plainMap({ width = 64, height = 64, material = 'stone', theme = 'dungeon' } = {}) {
  return createTacticalMap({
    width, height, locationId: 'loc-decal', seed: 'decal-seed', theme,
    fill: { passable: true, revealed: true, material },
  })
}

test('процедурные декали детерминированы: два вызова дают тот же рисунок', () => {
  const scene = {
    map: decoded(plainMap({ width: 16, height: 16 })),
    palette: render.DEFAULT_BOARD_PALETTE,
    cellSize: 32,
  }
  const first = recordingContext()
  const second = recordingContext()
  render.drawDecals(first, scene, { tileX: 0, tileY: 0 })
  render.drawDecals(second, scene, { tileX: 0, tileY: 0 })
  assert.deepEqual(second.ops, first.ops, 'декаль обязана быть функцией от клетки, а не от вызова')
  assert.ok(first.ops.some((item) => item.op === 'stroke'), 'на каменном полу 16×16 обязана быть хотя бы одна трещина')

  // Тот же тайл на карте с другим сидом рисуется иначе: иначе «шум» не шум.
  const other = recordingContext()
  const otherMap = createTacticalMap({
    width: 16, height: 16, locationId: 'loc-decal', seed: 'другой-сид', theme: 'dungeon',
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  render.drawDecals(other, { ...scene, map: decoded(otherMap) }, { tileX: 0, tileY: 0 })
  assert.notDeepEqual(other.ops, first.ops, 'сид карты обязан менять раскладку декалей')
})

test('плотность декалей держится в диапазоне «одна на 15–25 клеток»', () => {
  const map = decoded(plainMap())
  const scene = { map, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 24 }
  let decals = 0
  for (let tileY = 0; tileY < 4; tileY += 1) {
    for (let tileX = 0; tileX < 4; tileX += 1) {
      const context = recordingContext()
      render.drawDecals(context, scene, { tileX, tileY })
      // Поверхности на карте нет, поэтому штриховка ряби не рисуется вовсе и
      // каждый штрих — это декаль.
      decals += context.ops.filter((item) => item.op === 'stroke').length
    }
  }
  const cells = map.width * map.height
  console.log(`  декалей: ${decals} на ${cells} клеток — одна на ${(cells / decals).toFixed(1)}`)
  assert.ok(decals * 25 >= cells, `декалей ${decals} на ${cells} клеток — реже одной на 25`)
  assert.ok(decals * 15 <= cells, `декалей ${decals} на ${cells} клеток — чаще одной на 15`)

  // Нераскрытая клетка декали не получает: туман полупрозрачный, и рисунок под
  // ним выдал бы покрытие неразведанного пола.
  const hidden = plainMap({ width: 16, height: 16 })
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) setCell(hidden, x, y, { revealed: false })
  const dark = recordingContext()
  render.drawDecals(dark, { ...scene, map: decoded(hidden) }, { tileX: 0, tileY: 0 })
  assert.equal(dark.ops.some((item) => item.op === 'stroke'), false)
})

test('вид декали следует материалу и теме', () => {
  const stone = decoded(plainMap({ width: 4, height: 4, material: 'stone' }))
  const cave = decoded(plainMap({ width: 4, height: 4, material: 'stone', theme: 'cave' }))
  const kinds = (map) => {
    const seen = new Set()
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const cell = client.cellAt(map, x, y)
        const kind = render.floorDecalKindFor(map, cell, render.decalNoiseAt(map.seed, x, y))
        if (kind) seen.add(kind)
      }
    }
    return seen
  }
  assert.deepEqual([...kinds(stone)], ['crack'], 'на камне подземелья бывают только трещины')
  assert.ok(kinds(cave).has('moss'), 'в пещере пол обязан зарастать мхом')

  const wooden = decoded(plainMap({ width: 8, height: 8, material: 'wood' }))
  const wood = kinds(wooden)
  assert.ok(wood.has('straw') || wood.has('stain'), 'на досках бывают солома и пятна')
  assert.equal(wood.has('crack'), false, 'доски не трескаются каменной трещиной')

  // Трава, песок и металл декалей не получают: там декаль читается мусором.
  for (const material of ['grass', 'sand', 'metal', 'ice']) {
    assert.equal(kinds(decoded(plainMap({ width: 4, height: 4, material }))).size, 0, material)
  }

  // Под водой декалей нет — там рисуется своя рябь.
  const flooded = plainMap({ width: 4, height: 4 })
  setCell(flooded, 1, 1, { surface: 'water' })
  const map = decoded(flooded)
  assert.equal(render.floorDecalKindFor(map, client.cellAt(map, 1, 1), 0), null)
})

test('вариант тайла меняет тон пола и поверх растровой фактуры', () => {
  const map = createTacticalMap({ width: 8, height: 1 })
  for (let x = 0; x < 8; x += 1) {
    setCell(map, x, 0, { passable: true, revealed: true, material: 'wood', variant: x % 6 })
  }
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 40, terrain: stubTerrain() }
  const context = recordingContext()
  render.drawFloorTiles(context, scene, { tileX: 0, tileY: 0 })

  // Накладка варианта — единственный полупрозрачный слой этого прохода: у
  // заливки пола прозрачность единичная.
  const tints = context.ops.filter((item) => item.op === 'fillRect' && item.alpha < 1)
  assert.ok(tints.length >= 4, `накладок варианта ${tints.length}: фактура закрыла весь разброс тонов`)
  const tones = new Set(tints.map((item) => `${item.value}:${item.alpha.toFixed(3)}`))
  assert.ok(tones.size > 1, 'все клетки получили один и тот же тон — вариант не дошёл до рисования')

  // Без фактур разброс живёт в самой заливке, как и раньше.
  const flat = new Set(Array.from({ length: 6 }, (_, variant) => render.boardFillColor(
    { kind: 'floor', cell: { ...client.cellAt(scene.map, 0, 0), variant } },
    render.DEFAULT_BOARD_PALETTE,
    false,
  )))
  assert.ok(flat.size > 1, 'на плоской заливке вариант обязан различать клетки')
})

test('стык материалов размывается шахматным дизерингом, а однородный пол — нет', () => {
  const map = createTacticalMap({ width: 8, height: 4 })
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      setCell(map, x, y, { passable: true, revealed: true, material: x < 4 ? 'wood' : 'stone' })
    }
  }
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32 }
  const context = recordingContext()
  render.drawFloorTiles(context, scene, { tileX: 0, tileY: 0 })

  const dither = context.ops.filter((item) => item.op === 'fillRect' && item.alpha > 0 && item.alpha < 1 && item.width !== item.height)
  assert.ok(dither.length > 0, 'на стыке дерева и камня обязана появиться полоса смешения')
  // Полоса лежит вплотную к шву: клетки 3 и 4 по горизонтали.
  const seam = 4 * scene.cellSize
  assert.ok(dither.every((item) => Math.abs(item.x + item.width - seam) < 1 || Math.abs(item.x - seam) < 1),
    'полоса смешения обязана лежать у самого стыка')
  // Шахматность: полосу получает только клетка чётной суммы координат, поэтому
  // вдоль шва стороны чередуются и ни один ряд не мажется с обеих сторон сразу.
  const rows = new Map()
  for (const item of dither) {
    const row = Math.round(item.y / scene.cellSize)
    const side = Math.abs(item.x - seam) < 1 ? 'right' : 'left'
    assert.equal(rows.has(row), false, `ряд ${row} получил смешение с обеих сторон — шахматность потеряна`)
    rows.set(row, side)
  }
  assert.deepEqual([...rows.entries()].sort(), [[0, 'right'], [1, 'left'], [2, 'right'], [3, 'left']])

  const plain = recordingContext()
  render.drawFloorTiles(plain, {
    map: decoded(plainMap({ width: 8, height: 4, material: 'wood' })),
    palette: render.DEFAULT_BOARD_PALETTE,
    cellSize: 32,
  }, { tileX: 0, tileY: 0 })
  assert.equal(plain.ops.some((item) => item.op === 'fillRect' && item.width !== item.height), false,
    'вдали от стыка материалов полос смешения быть не должно')
})

test('стена не даёт полу перетечь через себя дизерингом', () => {
  const map = createTacticalMap({ width: 4, height: 2 })
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      setCell(map, x, y, { passable: true, revealed: true, material: x < 2 ? 'wood' : 'stone' })
    }
  }
  setEdge(map, 1, 0, 2, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
  setEdge(map, 1, 1, 2, 1, { kind: 'wall', blocksMove: true, blocksSight: true })
  const context = recordingContext()
  render.drawFloorTiles(context, {
    map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32,
  }, { tileX: 0, tileY: 0 })
  assert.equal(context.ops.some((item) => item.op === 'fillRect' && item.width !== item.height), false,
    'за стеной другое помещение, а не продолжение пола')
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

test('подписи зон появляются на дальнем плане и только у раскрытых зон', () => {
  const map = createTacticalMap({ width: 12, height: 6 })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'dim', label: 'Общий зал' })
  addZone(map, { id: 'cellar', kind: 'interior', material: 'stone', lightLevel: 'dark', label: 'Погреб' })
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 12; x += 1) {
      setCell(map, x, y, { passable: true, revealed: true, zone: x < 6 ? 'hall' : 'cellar' })
    }
  }
  // Погреб разведан с порога: раскрыто меньше половины его клеток.
  for (let y = 0; y < 6; y += 1) {
    for (let x = 7; x < 12; x += 1) setCell(map, x, y, { revealed: false })
  }
  const clientMap = decoded(map)
  assert.deepEqual(
    render.revealedZoneLabelPlacements(clientMap).map((entry) => entry.label),
    ['Общий зал'],
    'подпись зоны не должна выходить сквозь туман раньше половины разведки',
  )
  const placement = render.revealedZoneLabelPlacements(clientMap)[0]
  assert.ok(Math.abs(placement.x - 3) < 1e-9 && Math.abs(placement.y - 3) < 1e-9,
    `центр масс раскрытой зоны поехал: ${placement.x},${placement.y}`)

  const far = recordingContext()
  render.drawMapDecorations(far, { map: clientMap, palette: render.DEFAULT_BOARD_PALETTE, cellSize: render.ZONE_LABEL_MAX_CELL_PIXELS - 1 })
  assert.ok(far.ops.some((item) => item.op === 'fillText' && item.text === 'Общий зал'), 'на дальнем плане подпись обязана быть')

  const near = recordingContext()
  render.drawMapDecorations(near, { map: clientMap, palette: render.DEFAULT_BOARD_PALETTE, cellSize: render.ZONE_LABEL_MAX_CELL_PIXELS })
  assert.equal(near.ops.some((item) => item.op === 'fillText'), false,
    'при крупном зуме подпись обязана уйти: помещение читается своей обстановкой')
})

test('печатная подпись комнаты отменяет подпись той же зоны', () => {
  const map = createTacticalMap({ width: 6, height: 4 })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'dim', label: 'Общий зал' })
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 6; x += 1) setCell(map, x, y, { passable: true, revealed: true, zone: 'hall' })
  }
  map.overlays = { compass: false, scaleBar: false, roomLabels: [{ zoneId: 'hall', label: 'Общий зал' }] }
  const clientMap = decoded(map)
  assert.deepEqual(render.revealedZoneLabelPlacements(clientMap), [],
    'два названия одного помещения друг на друге — это не читаемость')

  const context = recordingContext()
  render.drawMapDecorations(context, { map: clientMap, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 12 })
  assert.equal(context.ops.filter((item) => item.op === 'fillText' && item.text === 'Общий зал').length, 1)
})

// --- живой слой доски: огонь, вода, дверь (этап L7) -----------------------

/** Сцена с огнём и водой: два источника в раскрытой части и лужа рядом. */
function ambientScene({ revealed = true } = {}) {
  const map = createTacticalMap({
    width: 24, height: 12, locationId: 'loc-fire', seed: 'ambient', theme: 'crypt',
    fill: { passable: true, revealed, material: 'stone' },
  })
  setCell(map, 5, 5, { surface: 'water' })
  setCell(map, 6, 5, { surface: 'water' })
  addProp(map, { id: 'torch-a', assetId: 'torch_wall', x: 2.5, y: 2.5, footprint: [{ x: 2, y: 2 }] })
  addProp(map, { id: 'torch-b', assetId: 'campfire', x: 8.5, y: 3.5, footprint: [{ x: 8, y: 3 }] })
  addProp(map, { id: 'crate', assetId: 'crate', x: 1.5, y: 8.5, footprint: [{ x: 1, y: 8 }] })
  return { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32 }
}

test('фазы мерцания детерминированы идентификатором предмета и различаются между огнями', () => {
  assert.equal(ambient.ambientPhase('torch-a'), ambient.ambientPhase('torch-a'), 'фаза обязана быть функцией id')
  assert.notEqual(ambient.ambientPhase('torch-a'), ambient.ambientPhase('torch-b'),
    'два факела в одной комнате обязаны мерцать вразнобой')
  for (const id of ['torch-a', 'campfire-17', '']) {
    const phase = ambient.ambientPhase(id)
    assert.ok(phase >= 0 && phase < 1, `фаза ${phase} вне [0, 1)`)
  }

  // Колебание — чистая функция времени и фазы, размах в пределах единицы:
  // свеча, а не стробоскоп.
  let extreme = 0
  for (let timeMs = 0; timeMs < 8_000; timeMs += 37) {
    const value = ambient.fireFlicker(timeMs, 0.25)
    assert.equal(value, ambient.fireFlicker(timeMs, 0.25))
    extreme = Math.max(extreme, Math.abs(value))
  }
  assert.ok(extreme <= 1.0001, `размах ${extreme} вышел за единицу`)
  assert.ok(extreme > 0.5, 'колебание обязано быть заметным глазу')
  assert.ok(ambient.FIRE_FLICKER_AMPLITUDE <= 0.1, 'размах радиуса ореола обязан остаться малым')
  assert.ok(ambient.FIRE_FLICKER_PERIOD_MS >= 1_500, 'частота мерцания обязана остаться низкой')
})

test('живой слой рисует только видимый огонь и видимую воду', () => {
  const scene = ambientScene()
  const context = recordingContext()
  ambient.drawAmbientEffects(context, scene, { timeMs: 1_000 })
  assert.ok(context.ops.some((item) => item.op === 'fill' && item.value === scene.palette.lightWarm),
    'ореол огня не нарисован')
  assert.ok(context.ops.some((item) => item.op === 'stroke'), 'блик воды не нарисован')
  assert.equal(context.globalAlpha, 1, 'прозрачность обязана вернуться к единице')

  // Окно просмотра режет обе стороны: огонь и вода за краем экрана не стоят
  // ни одной команды рисования.
  const narrow = recordingContext()
  ambient.drawAmbientEffects(narrow, scene, { timeMs: 1_000, view: { x: 18, y: 8, width: 4, height: 3 } })
  assert.deepEqual(narrow.ops, [], 'за пределами окна живой слой не рисует ничего')
  assert.equal(ambient.hasAmbientMotion(scene.map, { x: 18, y: 8, width: 4, height: 3 }), false,
    'без движения в окне цикл обязан иметь право заснуть')
  assert.equal(ambient.hasAmbientMotion(scene.map), true)

  // Нераскрытая карта не выдаёт ни очага, ни лужи: слой эффектов лежит поверх
  // тумана, и мерцание сквозь него читалось бы разведкой.
  const hidden = ambientScene({ revealed: false })
  const dark = recordingContext()
  ambient.drawAmbientEffects(dark, hidden, { timeMs: 1_000 })
  assert.deepEqual(dark.ops, [])
  assert.equal(ambient.hasAmbientMotion(hidden.map), false)
})

test('пустая сцена не даёт ни одной команды, и цикл засыпает', () => {
  const map = createTacticalMap({ width: 8, height: 8, fill: { passable: true, revealed: true } })
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32 }
  const context = recordingContext()
  ambient.drawAmbientEffects(context, scene, { timeMs: 500 })
  assert.deepEqual(context.ops, [], 'без огня, воды и дверей рисовать нечего')
  assert.equal(ambient.ambientFrameWanted(scene.map, { timeMs: 500 }), false)
  assert.equal(ambient.hasAmbientMotion(null), false, 'карты нет — движения нет')
})

test('prefers-reduced-motion выключает и мерцание, и блики, и створку', () => {
  const scene = ambientScene()
  const context = recordingContext()
  ambient.drawAmbientEffects(context, scene, {
    timeMs: 1_000,
    reducedMotion: true,
    doorSwings: [{ doorId: 'door-a', state: 'open', startedAt: 990 }],
  })
  assert.deepEqual(context.ops, [], 'просили не двигать картинку — не двигаем ничего')
  assert.equal(ambient.hasAmbientMotion(scene.map, undefined, true), false)
  assert.equal(ambient.ambientFrameWanted(scene.map, { timeMs: 1_000, reducedMotion: true }), false,
    'при reduced-motion цикл не должен заводиться вовсе')
})

test('створка двери поворачивается 150 мс и после этого цикл не нужен', () => {
  const map = createTacticalMap({ width: 8, height: 8, fill: { passable: true, revealed: true } })
  setEdge(map, 2, 2, 3, 2, { kind: 'door', doorId: 'door-a' })
  setDoor(map, { id: 'door-a', x: 2, y: 2, dir: 'e', state: 'open' })
  const scene = { map: decoded(map), palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32 }
  const swing = { doorId: 'door-a', state: 'open', startedAt: 1_000 }

  const middle = recordingContext()
  ambient.drawAmbientEffects(middle, scene, { timeMs: 1_075, doorSwings: [swing] })
  const leaf = middle.ops.filter((item) => item.op === 'fillRect' && item.value === scene.palette.door)
  assert.equal(leaf.length, 1, 'створка обязана быть нарисована ровно одним полотном')
  const turns = middle.ops.filter((item) => item.op === 'rotate').map((item) => item.angle)
  assert.equal(turns.length, 1)
  assert.ok(turns[0] > 0 && turns[0] < Math.PI / 2, `угол ${turns[0]} вне четверти оборота`)
  assert.ok(ambient.ambientFrameWanted(scene.map, { timeMs: 1_075, doorSwings: [swing] }))

  // Открытие идёт от косяка, закрытие — к нему.
  const started = recordingContext()
  ambient.drawAmbientEffects(started, scene, { timeMs: 1_000, doorSwings: [swing] })
  assert.equal(started.ops.filter((item) => item.op === 'rotate')[0].angle, 0, 'открытие начинается от косяка')
  const closing = recordingContext()
  ambient.drawAmbientEffects(closing, scene, {
    timeMs: 1_000, doorSwings: [{ doorId: 'door-a', state: 'closed', startedAt: 1_000 }],
  })
  assert.ok(Math.abs(closing.ops.filter((item) => item.op === 'rotate')[0].angle - Math.PI / 2) < 1e-9,
    'закрытие начинается с раскрытого положения')

  // Через 150 мс анимация кончилась: дальше дверь дорисовывает тайловый кэш.
  const done = recordingContext()
  ambient.drawAmbientEffects(done, scene, { timeMs: 1_000 + ambient.DOOR_SWING_MS, doorSwings: [swing] })
  assert.deepEqual(done.ops, [])
  assert.equal(ambient.ambientFrameWanted(scene.map, { timeMs: 1_150, doorSwings: [swing] }), false,
    'догоревшая створка не должна держать цикл живым')
})

test('кадр живого слоя воспроизводим: одно и то же время даёт тот же рисунок', () => {
  const scene = ambientScene()
  const first = recordingContext()
  const second = recordingContext()
  ambient.drawAmbientEffects(first, scene, { timeMs: 4_321 })
  ambient.drawAmbientEffects(second, scene, { timeMs: 4_321 })
  assert.deepEqual(second.ops, first.ops)

  const later = recordingContext()
  ambient.drawAmbientEffects(later, scene, { timeMs: 4_321 + ambient.FIRE_FLICKER_PERIOD_MS / 4 })
  assert.notDeepEqual(later.ops, first.ops, 'через четверть периода картинка обязана измениться')
})
