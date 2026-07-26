import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { listAssets } from '../server/asset-registry.mjs'
import { addProp, createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

/**
 * Библиотека рисунков предметов (`docs/tactical-map-plan.md`, этап M2).
 * Клиентский TypeScript проверяется тем же приёмом, что и в
 * `test/board-render.test.mjs`: компиляция во временный каталог и импорт.
 */
const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-prop-library-'))
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

/**
 * Поддельный контекст, который держит матрицу переноса и поворота и потому
 * знает, какую площадь холста накрыл рисунок. Без матрицы поворот и футпринт
 * проверить нельзя: `translate` и `rotate` сами по себе ничего не рисуют.
 */
function tracingContext() {
  const ops = []
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  let matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const stack = []
  const styles = { fillStyle: '', strokeStyle: '' }

  const point = (x, y) => ({
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  })
  const cover = (x, y) => {
    const at = point(x, y)
    if (at.x < box.minX) box.minX = at.x
    if (at.x > box.maxX) box.maxX = at.x
    if (at.y < box.minY) box.minY = at.y
    if (at.y > box.maxY) box.maxY = at.y
  }

  const context = {
    ops,
    box,
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save() { stack.push({ ...matrix }) },
    restore() { matrix = stack.pop() ?? matrix },
    translate(tx, ty) {
      matrix = { ...matrix, e: matrix.e + matrix.a * tx + matrix.c * ty, f: matrix.f + matrix.b * tx + matrix.d * ty }
    },
    rotate(angle) {
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      matrix = {
        a: matrix.a * cos + matrix.c * sin,
        b: matrix.b * cos + matrix.d * sin,
        c: matrix.a * -sin + matrix.c * cos,
        d: matrix.b * -sin + matrix.d * cos,
        e: matrix.e,
        f: matrix.f,
      }
    },
    beginPath() {},
    closePath() {},
    moveTo(x, y) { cover(x, y) },
    lineTo(x, y) { cover(x, y) },
    arc(x, y, radius) {
      cover(x - radius, y - radius)
      cover(x + radius, y + radius)
    },
    fill() { ops.push({ op: 'fill', value: styles.fillStyle }) },
    stroke() { ops.push({ op: 'stroke', value: styles.strokeStyle }) },
    fillRect(x, y, width, height) {
      cover(x, y)
      cover(x + width, y + height)
      ops.push({ op: 'fillRect', value: styles.fillStyle, x, y, width, height })
    },
    strokeRect(x, y, width, height) {
      cover(x, y)
      cover(x + width, y + height)
      ops.push({ op: 'strokeRect', value: styles.strokeStyle })
    },
    clearRect() {},
    setLineDash() {},
    drawImage() {},
  }
  for (const name of ['fillStyle', 'strokeStyle']) {
    Object.defineProperty(context, name, {
      get: () => styles[name],
      set: (value) => { styles[name] = value },
    })
  }
  return context
}

const drawOps = (context) => context.ops.length
const coveredArea = (context) => {
  const { minX, minY, maxX, maxY } = context.box
  if (!Number.isFinite(minX)) return 0
  return (maxX - minX) * (maxY - minY)
}

function decoded(map) {
  const clientMap = client.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
  assert.ok(clientMap, 'карта должна декодироваться')
  return clientMap
}

/** Пустая площадка со одним предметом: остальное для рисунка не важно. */
function mapWithProp(prop) {
  const map = createTacticalMap({ width: 12, height: 12, fill: { passable: true, revealed: true, material: 'wood' } })
  addProp(map, { id: 'prop-1', ...prop })
  return decoded(map)
}

function drawSingleProp(prop, cellSize = 48) {
  const context = tracingContext()
  const scene = { map: mapWithProp(prop), palette: render.DEFAULT_BOARD_PALETTE, cellSize }
  render.drawProps(context, scene, { tileX: 0, tileY: 0 })
  return context
}

/** Клетки прямоугольного футпринта от левого верхнего угла. */
function footprint(x, y, width, height) {
  const cells = []
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) cells.push({ x: x + dx, y: y + dy })
  }
  return cells
}

test('каждый идентификатор реестра ассетов имеет собственный рисунок', () => {
  const assets = listAssets()
  assert.ok(assets.length >= 60, `в реестре ${assets.length} записей`)
  const missing = assets.filter((asset) => !render.hasPropDrawing(asset.id)).map((asset) => asset.id)
  assert.deepEqual(missing, [], 'записи реестра без собственного рисунка')
  for (const asset of assets) {
    assert.notEqual(
      render.propDrawingFor(asset.id), render.DEFAULT_PROP_DRAWING,
      `${asset.id} падает в запасной рисунок`,
    )
  }
  // Запасной рисунок при этом остаётся: незнакомый предмет обязан быть виден.
  assert.equal(render.propDrawingFor('нет-такого-ассета'), render.DEFAULT_PROP_DRAWING)
  assert.equal(render.hasPropDrawing('нет-такого-ассета'), false)

  // Запись в библиотеке — ещё не рисунок: каждый ассет обязан что-то вывести
  // на своём футпринте и остаться в разумных пределах вокруг своих клеток.
  for (const asset of assets) {
    const cells = asset.baseFootprint.w ? footprint(2, 2, asset.baseFootprint.w, asset.baseFootprint.h) : []
    const context = drawSingleProp({ assetId: asset.id, x: 2.5, y: 2.5, footprint: cells })
    assert.ok(drawOps(context) > 0, `${asset.id} не нарисовал ни одного пятна`)
    const area = coveredArea(context)
    assert.ok(Number.isFinite(area) && area > 0, `${asset.id} дал вырожденный габарит`)
    const reach = Math.max(asset.baseFootprint.w, asset.baseFootprint.h, 3) * 48 * 2
    assert.ok(context.box.maxX - context.box.minX < reach, `${asset.id} вылез за свой футпринт по ширине`)
    assert.ok(context.box.maxY - context.box.minY < reach, `${asset.id} вылез за свой футпринт по высоте`)
  }
})

test('старые значения feature продолжают рисоваться по таблице соответствия', () => {
  // Список повторяет объединение `MapCell['feature']` в `src/types.ts` без
  // 'enemy': сущности в карту не входят и предметом не становятся.
  const legacy = [
    'chest', 'altar', 'torch', 'rune', 'stairs', 'table', 'chair', 'bed', 'bookshelf',
    'fireplace', 'barrel', 'crate', 'tree', 'bush', 'rock', 'mushroom', 'bones', 'grave',
    'pillar', 'statue', 'campfire', 'wagon', 'well', 'console',
  ]
  for (const feature of legacy) {
    assert.ok(render.LEGACY_PROP_ASSETS[feature], `в таблице нет значения ${feature}`)
    assert.ok(render.hasPropDrawing(feature), `старое значение ${feature} потеряло рисунок`)
  }
  assert.equal(Object.keys(render.LEGACY_PROP_ASSETS).length, legacy.length, 'таблица не обросла лишним')
  assert.equal(render.resolvePropAssetId('table'), 'table_round')
  assert.equal(render.resolvePropAssetId('tree'), 'tree_oak')
  assert.equal(render.resolvePropAssetId('table_round'), 'table_round', 'нынешний идентификатор остаётся собой')

  // Старая карта доходит до отрисовки целиком: предмет попадает в контекст.
  const context = drawSingleProp({ assetId: 'table', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  assert.ok(drawOps(context) > 0, 'предмет со старым feature ничего не нарисовал')
})

test('крупный предмет занимает свой футпринт, а не одну клетку', () => {
  const table = drawSingleProp({ assetId: 'table_round', x: 1.5, y: 1.5, footprint: footprint(1, 1, 2, 2) })
  const chair = drawSingleProp({ assetId: 'chair', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  const ratio = coveredArea(table) / coveredArea(chair)
  assert.ok(ratio > 2.5, `стол 2×2 накрыл всего в ${ratio.toFixed(2)} раза больше стула 1×1`)

  // Стойка 4×1: рисунок вытянут поперёк карты и вдоль своего футпринта.
  const counter = drawSingleProp({ assetId: 'bar_counter', x: 1.5, y: 1.5, footprint: footprint(1, 1, 4, 1) })
  const wide = counter.box.maxX - counter.box.minX
  const tall = counter.box.maxY - counter.box.minY
  assert.ok(wide > tall * 2, `стойка 4×1 вышла ${wide.toFixed(1)}×${tall.toFixed(1)}`)

  // Та же стойка, повёрнутая на 90°: занимаемые клетки уже развёрнуты, и
  // рисунок обязан развернуться вместе с ними, а не лечь поперёк себя.
  const turned = drawSingleProp({ assetId: 'bar_counter', x: 1.5, y: 1.5, rotation: 90, footprint: footprint(1, 1, 1, 4) })
  assert.ok(
    turned.box.maxY - turned.box.minY > (turned.box.maxX - turned.box.minX) * 2,
    'повёрнутая стойка не встала вдоль своего футпринта',
  )

  // Предмет на шве тайлов рисуется в обоих: иначе стойку срезало бы ровно по
  // границе кэша, а склеить половины уже нечем.
  const seamMap = createTacticalMap({ width: 32, height: 32, fill: { passable: true, revealed: true } })
  addProp(seamMap, { id: 'prop-counter', assetId: 'bar_counter', x: 14.5, y: 5.5, footprint: footprint(14, 5, 4, 1) })
  const seam = decoded(seamMap)
  assert.equal(render.propsInTile(seam, { tileX: 0, tileY: 0 }, 48).length, 1, 'стойка пропала из левого тайла')
  assert.equal(render.propsInTile(seam, { tileX: 1, tileY: 0 }, 48).length, 1, 'стойка пропала из правого тайла')
  assert.equal(render.propsInTile(seam, { tileX: 0, tileY: 1 }, 48).length, 0, 'стойка попала в чужой тайл')

  // Мелкая утварь с пустым футпринтом рисуется мельче клетки.
  const mug = drawSingleProp({ assetId: 'mug', x: 1.5, y: 1.5, footprint: [], zOrder: 1 })
  assert.ok(coveredArea(mug) < coveredArea(chair), 'кружка нарисована не мельче стула')
  // Ковёр с тем же пустым футпринтом — наоборот, на несколько клеток.
  const rug = drawSingleProp({ assetId: 'rug', x: 2, y: 2, footprint: [] })
  assert.ok(coveredArea(rug) > coveredArea(chair) * 3, 'ковёр нарисован не крупнее стула')
})

test('три уровня детализации: полный рисунок, силуэт и метка', () => {
  assert.equal(render.PROP_MIN_CELL_PIXELS, 12)
  assert.ok(render.PROP_FULL_DETAIL_CELL_PIXELS > render.PROP_MIN_CELL_PIXELS)
  assert.equal(render.propDetailLevel(render.PROP_FULL_DETAIL_CELL_PIXELS), 'full')
  assert.equal(render.propDetailLevel(render.PROP_FULL_DETAIL_CELL_PIXELS - 1), 'simple')
  assert.equal(render.propDetailLevel(render.PROP_MIN_CELL_PIXELS), 'simple')
  assert.equal(render.propDetailLevel(render.PROP_MIN_CELL_PIXELS - 1), 'mark')

  const prop = { assetId: 'table_round', x: 1.5, y: 1.5, footprint: footprint(1, 1, 2, 2) }
  const full = drawSingleProp(prop, 48)
  const simple = drawSingleProp(prop, render.PROP_FULL_DETAIL_CELL_PIXELS - 1)
  const mark = drawSingleProp(prop, render.PROP_MIN_CELL_PIXELS - 1)

  assert.ok(drawOps(full) > drawOps(simple), `полный рисунок ${drawOps(full)} вызовов, силуэт ${drawOps(simple)}`)
  assert.equal(drawOps(simple), 1, 'силуэт — ровно одна заливка')
  assert.equal(drawOps(mark), 1, 'метка — ровно одна заливка')
  assert.ok(coveredArea(mark) > 0, 'при максимальном отдалении предмет не должен исчезать')

  // Силуэт всё же занимает место предмета, а не схлопывается в точку.
  assert.ok(coveredArea(simple) > 0)
})

test('поворот и масштаб дают разную картинку', () => {
  const base = { assetId: 'tree_pine', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] }
  const geometry = (context) => JSON.stringify({
    ops: context.ops.map((item) => [item.op, item.value]),
    box: [context.box.minX, context.box.minY, context.box.maxX, context.box.maxY],
  })

  const straight = drawSingleProp({ ...base, rotation: 0 })
  const turned = drawSingleProp({ ...base, rotation: 37 })
  assert.notEqual(geometry(straight), geometry(turned), 'поворот не изменил ни одного вызова')

  const small = drawSingleProp({ ...base, scale: 0.8 })
  const large = drawSingleProp({ ...base, scale: 1.4 })
  assert.ok(coveredArea(large) > coveredArea(small) * 1.5, 'масштаб не изменил размер рисунка')

  // Разные породы одного семейства тоже расходятся: библиотека не штампует.
  const pine = drawSingleProp({ assetId: 'tree_pine', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  const birch = drawSingleProp({ assetId: 'tree_birch', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  assert.notEqual(geometry(pine), geometry(birch), 'сосна и берёза нарисованы одинаково')
})

test('декали рисуются плоско, без объёма', () => {
  const decals = listAssets().filter((asset) => asset.kind === 'decal')
  assert.ok(decals.length >= 10, `декалей в реестре ${decals.length}`)
  for (const asset of decals) {
    const drawing = render.propDrawingFor(asset.id)
    assert.equal(drawing.flat, true, `декаль ${asset.id} рисуется как объёмный предмет`)
  }
  // Прозрачность возвращается после предмета: следующий предмет не бледнеет.
  const context = drawSingleProp({ assetId: 'rug', x: 2, y: 2, footprint: [] })
  assert.equal(context.globalAlpha, 1)
})
