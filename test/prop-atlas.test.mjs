import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { decodePng, encodeIndexedPng, encodePng, PngError } from '../tools/png-codec.mjs'
import { makeSeamless, seamScore, TERRAIN_SOURCES } from '../tools/build-terrain-tiles.mjs'
import {
  backgroundColorOf, cropImage, findComponents, keyOutBackground, longestSideFor,
  packSprites, resampleImage, sliceSheet,
} from '../tools/build-prop-atlas.mjs'
import { DRAWN_CELLS, PROP_STAMP_SHEETS } from '../tools/prop-stamp-sheets.mjs'
import { assetById, readPropAtlas } from '../server/asset-registry.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/** Пустое изображение заданного цвета. */
function filled(width, height, color) {
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) data.set(color, index * 4)
  return { width, height, data }
}

function paintRect(image, box, color) {
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) image.data.set(color, (y * image.width + x) * 4)
  }
}

const MAGENTA = [255, 0, 255, 255]

test('палитровый PNG читается обратно и весит заметно меньше полного', () => {
  // Фактура пола: плавный градиент с зерном — то, ради чего палитра и заведена.
  const side = 96
  const data = new Uint8Array(side * side * 4)
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const at = (y * side + x) * 4
      const grain = ((x * 7 + y * 13) % 5) - 2
      data[at] = 120 + Math.round(x / 3) + grain
      data[at + 1] = 90 + Math.round(y / 4) + grain
      data[at + 2] = 60 + grain
      data[at + 3] = 255
    }
  }
  const image = { width: side, height: side, data }
  const indexed = encodeIndexedPng(image, { colors: 128 })
  const back = decodePng(indexed)
  assert.equal(back.width, side)
  let worst = 0
  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      worst = Math.max(worst, Math.abs(data[index + channel] - back.data[index + channel]))
    }
    assert.equal(back.data[index + 3], 255)
  }
  assert.ok(worst <= 8, `палитра исказила цвет на ${worst} — это уже видно глазом`)
  assert.equal(indexed[25], 3, 'запись обязана быть палитровой (тип цвета 3)')
})

test('готовые фактуры лежат палитровыми, а не полноцветными', () => {
  // Ради этого палитра и заводилась: те же шестнадцать фактур в полном цвете
  // весят около восьми мегабайт против нынешних трёх с половиной.
  for (const source of TERRAIN_SOURCES) {
    const png = readFileSync(`${ROOT}public/assets/maps/terrain/${source.file}`)
    assert.equal(png[25], 3, `${source.file} записан не палитровым PNG`)
  }
})

test('палитровая запись отказывается от прозрачности вслух', () => {
  const data = new Uint8Array(4 * 4)
  data[3] = 128
  assert.throws(() => encodeIndexedPng({ width: 2, height: 2, data }), (error) => {
    assert.equal(error.code, 'PNG_INDEXED_NEEDS_OPAQUE')
    return true
  })
})

test('сшивка краёв делает плитку бесшовной', () => {
  // Наклонный градиент: края расходятся заведомо и сильно.
  const side = 64
  const data = new Uint8Array(side * side * 4)
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const at = (y * side + x) * 4
      data[at] = Math.round((x / side) * 200)
      data[at + 1] = Math.round((y / side) * 200)
      data[at + 2] = 40
      data[at + 3] = 255
    }
  }
  const source = { width: side, height: side, data }
  // Градиент идёт по одному каналу, поэтому среднее по трём каналам — треть
  // его размаха: около шестидесяти пяти единиц.
  const before = seamScore(source)
  assert.ok(before.x > 50 && before.y > 50, `исходник обязан быть заведомо не бесшовным, а вышло ${before.x}/${before.y}`)

  const stitched = makeSeamless(source, 16)
  assert.equal(stitched.width, side - 16)
  assert.equal(stitched.height, side - 16)
  const after = seamScore(stitched)
  // Порог — шаг градиента между соседними пикселями, около трёх единиц.
  assert.ok(after.x < 6 && after.y < 6, `после сшивки края всё ещё расходятся: ${after.x.toFixed(1)}/${after.y.toFixed(1)}`)
})

test('PNG переживает запись и чтение без потерь', () => {
  const width = 37
  const height = 19
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = (index * 7) % 256
    data[index * 4 + 1] = (index * 13) % 256
    data[index * 4 + 2] = (index * 29) % 256
    data[index * 4 + 3] = (index * 3) % 256
  }
  const back = decodePng(encodePng({ width, height, data }))
  assert.equal(back.width, width)
  assert.equal(back.height, height)
  assert.deepEqual([...back.data], [...data])
})

test('чужой формат отвергается внятной ошибкой, а не половиной картинки', () => {
  assert.throws(() => decodePng(Buffer.from('это не картинка')), (error) => {
    assert.ok(error instanceof PngError)
    assert.equal(error.code, 'PNG_NOT_A_PNG')
    return true
  })
})

test('фон снимается вместе с каймой: светлый предмет не розовеет', () => {
  const sheet = filled(8, 4, MAGENTA)
  // Белый предмет и его сглаженный край — половина белого, половина фона.
  paintRect(sheet, { x: 1, y: 1, w: 2, h: 2 }, [255, 255, 255, 255])
  paintRect(sheet, { x: 3, y: 1, w: 1, h: 2 }, [255, 128, 255, 255])
  const keyed = keyOutBackground(sheet)

  const at = (x, y) => [...keyed.data.slice((y * keyed.width + x) * 4, (y * keyed.width + x) * 4 + 4)]
  assert.deepEqual(at(0, 0), [0, 0, 0, 0], 'фон обязан стать полностью прозрачным')
  assert.deepEqual(at(1, 1), [255, 255, 255, 255], 'сам предмет не трогается')
  const edge = at(3, 1)
  assert.ok(edge[3] > 100 && edge[3] < 160, `край получил прозрачность ${edge[3]}, ожидалась половина`)
  assert.ok(edge[0] > 240 && edge[1] > 240 && edge[2] > 240,
    `край остался розовым: ${edge.slice(0, 3).join(',')} — разбор смеси не сработал`)
})

test('цвет фона берётся по рамке кадра, а не угадывается', () => {
  const sheet = filled(6, 6, [250, 5, 250, 255])
  paintRect(sheet, { x: 2, y: 2, w: 2, h: 2 }, [60, 40, 20, 255])
  assert.deepEqual(backgroundColorOf(sheet), [250, 5, 250])
})

test('предмет из нескольких кусков остаётся одним предметом', () => {
  // Стакан и две кости рядом, две бочки, три сталагмита — на листах такое есть.
  const sheet = filled(40, 20, MAGENTA)
  paintRect(sheet, { x: 2, y: 2, w: 8, h: 8 }, [90, 60, 30, 255])
  paintRect(sheet, { x: 12, y: 4, w: 4, h: 4 }, [90, 60, 30, 255])
  paintRect(sheet, { x: 24, y: 3, w: 6, h: 6 }, [90, 60, 30, 255])
  const keyed = keyOutBackground(sheet)

  assert.equal(findComponents(keyed, { minArea: 4 }).length, 3, 'кусков на листе три')
  const boxes = sliceSheet(keyed, { cols: 2, rows: 1 }, { minArea: 4 })
  assert.equal(boxes.length, 2, 'ячеек сетки — две, значит и предметов два')
  assert.deepEqual(boxes[0], { x: 2, y: 2, w: 14, h: 8 }, 'левый предмет собран из двух кусков целиком')
  assert.deepEqual(boxes[1], { x: 24, y: 3, w: 6, h: 6 })
})

test('пустая ячейка предметом не считается', () => {
  const sheet = filled(40, 20, MAGENTA)
  paintRect(sheet, { x: 2, y: 2, w: 8, h: 8 }, [90, 60, 30, 255])
  const boxes = sliceSheet(keyOutBackground(sheet), { cols: 2, rows: 1 }, { minArea: 4 })
  assert.equal(boxes.length, 1)
})

test('уменьшение усредняет цвет с весом прозрачности', () => {
  const sprite = filled(2, 2, [0, 0, 0, 0])
  sprite.data.set([200, 100, 50, 255], 0)
  const small = resampleImage(sprite, 1, 1)
  assert.deepEqual([...small.data.slice(0, 3)], [200, 100, 50],
    'прозрачные пиксели не имеют права затягивать цвет предмета в чёрный')
  assert.equal(small.data[3], 64, 'прозрачность усредняется по площади')
})

test('разрешение спрайта задаётся футпринтом, а рисунок крупнее футпринта объявлен отдельно', () => {
  assert.equal(longestSideFor('barrel', 96), 96, 'бочка занимает клетку')
  assert.equal(longestSideFor('table_round', 96), 192, 'круглый стол 2×2 хранится вдвое крупнее')
  // Ковёр не занимает ни клетки, но рисуется на три — иначе его пришлось бы
  // растягивать из спрайта на одну клетку.
  assert.equal(assetById('rug').baseFootprint.w, 0)
  assert.equal(longestSideFor('rug', 96), 96 * DRAWN_CELLS.rug)
})

test('укладка не роняет спрайты друг на друга', () => {
  const sprites = [
    { id: 'a', image: filled(300, 200, [1, 1, 1, 255]) },
    { id: 'b', image: filled(100, 400, [2, 2, 2, 255]) },
    { id: 'c', image: filled(50, 50, [3, 3, 3, 255]) },
  ]
  const packed = packSprites(sprites, 512)
  assert.equal(packed.frames.length, 3)
  for (const frame of packed.frames) {
    assert.ok(frame.box.x >= 0 && frame.box.y >= 0)
    assert.ok(frame.box.x + frame.box.w <= packed.width, `${frame.id} вылез за ширину атласа`)
    assert.ok(frame.box.y + frame.box.h <= packed.height, `${frame.id} вылез за высоту атласа`)
  }
  for (const left of packed.frames) {
    for (const right of packed.frames) {
      if (left.id >= right.id) continue
      const apart = left.box.x + left.box.w <= right.box.x || right.box.x + right.box.w <= left.box.x
        || left.box.y + left.box.h <= right.box.y || right.box.y + right.box.h <= left.box.y
      assert.ok(apart, `${left.id} и ${right.id} перекрылись`)
    }
  }
})

test('вырезка берёт ровно указанное окно', () => {
  const sheet = filled(4, 4, [10, 20, 30, 255])
  paintRect(sheet, { x: 1, y: 1, w: 2, h: 2 }, [200, 210, 220, 255])
  const piece = cropImage(sheet, { x: 1, y: 1, w: 2, h: 2 })
  assert.equal(piece.width, 2)
  assert.deepEqual([...piece.data.slice(0, 4)], [200, 210, 220, 255])
})

test('раскладка листов не расходится с реестром и сама с собой', () => {
  const seen = new Set()
  for (const sheet of PROP_STAMP_SHEETS) {
    assert.ok(sheet.ids.length <= sheet.grid.cols * sheet.grid.rows,
      `${sheet.file}: предметов больше, чем ячеек сетки`)
    for (const id of sheet.ids) {
      assert.equal(seen.has(id), false, `${id} объявлен на двух листах`)
      seen.add(id)
    }
  }
  // Обратное неверно: листы 14–22 нарисованы раньше, чем под них заведены
  // записи реестра, и это осознанное состояние — см. tools/prop-stamp-sheets.mjs.
  for (const record of Object.keys(readPropAtlas().frames)) {
    assert.ok(seen.has(record), `кадр ${record} собран неизвестно из какого листа`)
  }
})

test('тайлсет местности на месте, объявлен в манифесте и в правах', () => {
  const manifest = JSON.parse(readFileSync(`${ROOT}public/assets/maps/terrain/terrain-tiles.json`, 'utf8'))
  assert.ok(manifest.cellsPerTile >= 1, 'манифест не говорит, сколько клеток в плитке')
  const rights = JSON.parse(readFileSync(`${ROOT}data/asset-rights.json`, 'utf8'))
  const declared = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))

  for (const source of TERRAIN_SOURCES) {
    const path = manifest[source.slot]?.[source.key]
    assert.ok(path, `в манифесте нет фактуры ${source.slot}.${source.key}`)
    const bytes = readFileSync(`${ROOT}public/assets/${path}`)
    const tuple = declared.get(path)
    assert.ok(tuple, `${path} не объявлен в data/asset-rights.json`)
    assert.equal(bytes.length, tuple[2], `${path}: размер разошёлся с реестром прав`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), tuple[1], `${path}: хеш разошёлся с реестром прав`)

    // Плитка обязана остаться бесшовной: расхождение краёв не больше разницы
    // соседних пикселей внутри самой фактуры, иначе на карте пойдёт решётка.
    const tile = decodePng(bytes)
    const seam = seamScore(tile)
    let neighbours = 0
    for (let row = 0; row < tile.height; row += 1) {
      const left = (row * tile.width) * 4
      const right = left + 4
      neighbours += (Math.abs(tile.data[left] - tile.data[right])
        + Math.abs(tile.data[left + 1] - tile.data[right + 1])
        + Math.abs(tile.data[left + 2] - tile.data[right + 2])) / 3
    }
    const grain = neighbours / tile.height
    assert.ok(seam.x <= grain + 3, `${path}: шов ${seam.x.toFixed(1)} против зерна ${grain.toFixed(1)}`)
  }
})

test('собранный атлас совпадает со своим манифестом и с реестром прав', () => {
  const atlas = readPropAtlas()
  const png = readFileSync(`${ROOT}public/assets/${atlas.image}`)
  const header = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  const manifest = JSON.parse(readFileSync(`${ROOT}public/assets/maps/props/prop-atlas.json`, 'utf8'))
  assert.equal(manifest.width, header.width, 'манифест обещает не ту ширину, что у картинки')
  assert.equal(manifest.height, header.height)

  for (const [id, frame] of Object.entries(atlas.frames)) {
    assert.ok(frame.w > 0 && frame.h > 0, `${id}: пустой кадр`)
    assert.ok(frame.x + frame.w <= header.width && frame.y + frame.h <= header.height,
      `${id}: кадр выходит за границы атласа`)
  }

  const rights = JSON.parse(readFileSync(`${ROOT}data/asset-rights.json`, 'utf8'))
  const declared = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))
  for (const path of [atlas.image, 'maps/props/prop-atlas.json']) {
    const tuple = declared.get(path)
    assert.ok(tuple, `${path} не объявлен в data/asset-rights.json`)
    const bytes = readFileSync(`${ROOT}public/assets/${path}`)
    assert.equal(bytes.length, tuple[2], `${path}: размер разошёлся с реестром прав`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), tuple[1], `${path}: хеш разошёлся с реестром прав`)
  }
})
