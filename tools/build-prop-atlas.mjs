#!/usr/bin/env node
// @ts-check
/**
 * Сборка растрового атласа предметов из листов штампов.
 *
 * Что делает: режет лист на предметы, снимает маджентовый фон, обрезает по
 * границам рисунка, уменьшает до разрешения, заданного футпринтом записи
 * реестра, и укладывает всё в один файл с манифестом координат.
 *
 * Почему одним атласом: предметов около сотни, и сотня отдельных картинок —
 * это сотня запросов на первую же карту.
 *
 * Чего не делает: не трогает ни модель карты, ни генератор, ни серверную
 * валидацию. Растр подключается заполнением поля `raster` записи реестра —
 * решение Р3 из `docs/tactical-map-plan.md`. Без атласа доска рисует вектор,
 * без вектора — плоскую заливку (Р6).
 *
 * Запуск:
 *   pnpm props:atlas --sheets <каталог с листами>
 *   pnpm props:atlas --check                 # только проверить, ничего не писать
 *   pnpm props:atlas --preview <файл.png>    # контрольный лист для осмотра
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { decodePng, encodePng } from './png-codec.mjs'
import { DEFAULT_SHEET_DIR, DRAWN_CELLS, PROP_STAMP_SHEETS } from './prop-stamp-sheets.mjs'
import { assetById } from '../server/asset-registry.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

export const ATLAS_VERSION = 'skazanie:prop-atlas-v1'

/** Куда кладётся собранный атлас. Путь внутри `public/assets` — он же `rightsId`. */
export const ATLAS_IMAGE_PATH = 'maps/props/prop-atlas.png'
export const ATLAS_MANIFEST_PATH = 'maps/props/prop-atlas.json'

/**
 * Пикселей на клетку 5×5 футов.
 *
 * Доска показывает клетку в 30–70 пикселях, на плотном экране с предельным
 * приближением — до ста двадцати. Замер веса атласа на всём наборе: 80 → 1.9 МБ,
 * 96 → 2.65 МБ, 112 → 3.5 МБ, 128 → 4.8 МБ. Взято 96: на обычном экране это
 * запас, на предельном приближении плотного экрана — растяжение в 1.3 раза,
 * которого у рисованного штампа не видно, а страница грузит вдвое меньше.
 * Пересобрать крупнее можно ключом `--cell`.
 */
export const DEFAULT_CELL_PIXELS = 96

/** Ширина атласа. Больше 2048 не берём: на слабых видеокартах это уже предел. */
const ATLAS_WIDTH = 2048

/** Поле вокруг спрайта: без него соседний спрайт подмешивается при сглаживании. */
const FRAME_PADDING = 2

/**
 * @typedef {import('./png-codec.mjs').PngImage} PngImage
 * @typedef {{x: number, y: number, w: number, h: number}} Box
 */

// --- фон -------------------------------------------------------------------

/**
 * Цвет фона — медиана по рамке кадра. Медиана, а не среднее: одиночный предмет,
 * задевший край, среднее сдвинет, а медиану нет.
 *
 * Чистую мадженту вернули не все листы: у части фон «почти маджента»
 * (`docs/prop-stamps-prompts.md`, замер первой генерации), поэтому цвет
 * измеряется по каждому листу отдельно, а не берётся константой.
 *
 * @param {PngImage} image
 * @returns {[number, number, number]}
 */
export function backgroundColorOf(image) {
  const { width, height, data } = image
  /** @type {number[][]} */
  const channels = [[], [], []]
  const take = (/** @type {number} */ x, /** @type {number} */ y) => {
    const at = (y * width + x) * 4
    channels[0].push(data[at])
    channels[1].push(data[at + 1])
    channels[2].push(data[at + 2])
  }
  for (let x = 0; x < width; x += 1) {
    take(x, 0)
    take(x, height - 1)
  }
  for (let y = 0; y < height; y += 1) {
    take(0, y)
    take(width - 1, y)
  }
  const median = (/** @type {number[]} */ values) => {
    values.sort((left, right) => left - right)
    return values[Math.floor(values.length / 2)]
  }
  return [median(channels[0]), median(channels[1]), median(channels[2])]
}

/**
 * Насколько пиксель «маджентовый»: красный и синий подняты, зелёный опущен.
 * У чистого фона мера равна 255, у любого землистого цвета набора — нулю.
 *
 * @param {number} red
 * @param {number} green
 * @param {number} blue
 */
function magentaness(red, green, blue) {
  return Math.min(red, blue) - green
}

/**
 * Снятие фона: пиксель у цвета фона становится прозрачным, далёкий — целым,
 * промежуточный получает частичную прозрачность и очищается от подмеса фона.
 *
 * Очистка обязательна. Край предмета сглажен, то есть смешан с маджентой; если
 * просто выставить альфу, по контуру останется сиреневая кайма, и на карте
 * каждый предмет окажется обведён фиолетовым. Смесь разбирается обратно:
 * `наблюдаемое = a * предмет + (1 - a) * фон`.
 *
 * Долю фона даёт **мера маджентовости**, а не расстояние до цвета фона.
 * Расстояние обманывает на светлых предметах: белая нить паутины, наполовину
 * смешанная с маджентой, отстоит от фона на треть шкалы, и по расстоянию ей
 * досталась бы почти полная непрозрачность — вместе с розовым цветом смеси.
 * По зелёному каналу та же нить честно даёт половину, и разбор смеси
 * возвращает белый. Первая версия инструмента считала расстоянием, и вся
 * паутина вышла розовой.
 *
 * Запаса на «почти фон» здесь намеренно нет: любой сдвиг завышает
 * непрозрачность края, и в нём остаётся розовый подмес. Цена — слегка
 * просвечивающие лиловые пятна у самих предметов (лепесток, кристалл); на
 * землистой палитре набора таких пикселей единицы, а кайма была бы у каждого
 * предмета.
 *
 * @param {PngImage} image
 * @param {{background?: [number, number, number]}} [options]
 * @returns {PngImage}
 */
export function keyOutBackground(image, options = {}) {
  const background = options.background ?? backgroundColorOf(image)
  const backgroundLevel = magentaness(background[0], background[1], background[2])
  const { width, height, data } = image
  const result = new Uint8Array(width * height * 4)
  // Фон не маджентовый — лист снят прозрачным или другого рода; тогда пиксели
  // не трогаются вовсе, лучше оставить как есть, чем выесть половину предмета.
  if (backgroundLevel <= 32) return { width, height, data: Uint8Array.from(data) }
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4
    const red = data[at]
    const green = data[at + 1]
    const blue = data[at + 2]
    let alpha = 1 - magentaness(red, green, blue) / backgroundLevel
    alpha = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha
    // Прозрачность исходника, если она есть, только уменьшает результат.
    alpha = Math.min(alpha, data[at + 3] / 255)
    if (alpha <= 0) continue
    const restore = (/** @type {number} */ value, /** @type {number} */ base) => {
      if (alpha >= 1) return value
      const clean = (value - (1 - alpha) * base) / alpha
      return clean < 0 ? 0 : clean > 255 ? 255 : Math.round(clean)
    }
    result[at] = restore(red, background[0])
    result[at + 1] = restore(green, background[1])
    result[at + 2] = restore(blue, background[2])
    result[at + 3] = Math.round(alpha * 255)
  }
  return { width, height, data: result }
}

// --- разбор листа ----------------------------------------------------------

/**
 * Связные области непрозрачных пикселей. Обход итеративный: рекурсия на
 * четырёх мегапикселях переполняет стек.
 *
 * @param {PngImage} image
 * @param {{threshold?: number, minArea?: number}} [options]
 * @returns {Array<{area: number, box: Box, centerX: number, centerY: number}>}
 */
export function findComponents(image, options = {}) {
  const threshold = options.threshold ?? 128
  const minArea = options.minArea ?? Math.max(64, Math.round(image.width * image.height * 0.00005))
  const { width, height, data } = image
  const seen = new Uint8Array(width * height)
  /** @type {Array<{area: number, box: Box, centerX: number, centerY: number}>} */
  const components = []
  const stack = new Int32Array(width * height)
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || data[start * 4 + 3] < threshold) continue
    let top = 0
    stack[top] = start
    top += 1
    seen[start] = 1
    let area = 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    let sumX = 0
    let sumY = 0
    while (top > 0) {
      top -= 1
      const index = stack[top]
      const x = index % width
      const y = (index - x) / width
      area += 1
      sumX += x
      sumY += y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      // Восемь соседей: тонкая перемычка в один пиксель по диагонали иначе
      // разрезает предмет надвое.
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const next = ny * width + nx
          if (seen[next] || data[next * 4 + 3] < threshold) continue
          seen[next] = 1
          stack[top] = next
          top += 1
        }
      }
    }
    if (area < minArea) continue
    components.push({ area, box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, centerX: sumX / area, centerY: sumY / area })
  }
  return components
}

/**
 * Границы предметов листа в порядке чтения.
 *
 * Области сводятся по ячейкам сетки, а не берутся поодиночке: предмет бывает
 * из нескольких кусков — стакан и две кости рядом, две бочки, три сталагмита.
 * Ячейку задаёт центр области, поэтому предмет, чуть вышедший за линию сетки,
 * остаётся при своей ячейке.
 *
 * @param {PngImage} keyed уже с прозрачным фоном
 * @param {{cols: number, rows: number}} grid
 * @param {{minArea?: number}} [options]
 * @returns {Box[]}
 */
export function sliceSheet(keyed, grid, options = {}) {
  const components = findComponents(keyed, options)
  const cellWidth = keyed.width / grid.cols
  const cellHeight = keyed.height / grid.rows
  /** @type {Map<number, Box>} */
  const byCell = new Map()
  for (const component of components) {
    const col = Math.min(grid.cols - 1, Math.floor(component.centerX / cellWidth))
    const row = Math.min(grid.rows - 1, Math.floor(component.centerY / cellHeight))
    const key = row * grid.cols + col
    const known = byCell.get(key)
    if (!known) {
      byCell.set(key, { ...component.box })
      continue
    }
    const right = Math.max(known.x + known.w, component.box.x + component.box.w)
    const bottom = Math.max(known.y + known.h, component.box.y + component.box.h)
    known.x = Math.min(known.x, component.box.x)
    known.y = Math.min(known.y, component.box.y)
    known.w = right - known.x
    known.h = bottom - known.y
  }
  return [...byCell.entries()].sort((left, right) => left[0] - right[0]).map(([, box]) => box)
}

/**
 * @param {PngImage} image
 * @param {Box} box
 * @returns {PngImage}
 */
export function cropImage(image, box) {
  const data = new Uint8Array(box.w * box.h * 4)
  for (let y = 0; y < box.h; y += 1) {
    const from = ((box.y + y) * image.width + box.x) * 4
    data.set(image.data.subarray(from, from + box.w * 4), y * box.w * 4)
  }
  return { width: box.w, height: box.h, data }
}

/**
 * Уменьшение усреднением по площади. Цвет усредняется с весом прозрачности:
 * иначе полностью прозрачные пиксели за контуром затянут край предмета в чёрный.
 *
 * @param {PngImage} image
 * @param {number} width
 * @param {number} height
 * @returns {PngImage}
 */
export function resampleImage(image, width, height) {
  const target = new Uint8Array(width * height * 4)
  const scaleX = image.width / width
  const scaleY = image.height / height
  for (let y = 0; y < height; y += 1) {
    const fromY = Math.floor(y * scaleY)
    const toY = Math.max(fromY + 1, Math.floor((y + 1) * scaleY))
    for (let x = 0; x < width; x += 1) {
      const fromX = Math.floor(x * scaleX)
      const toX = Math.max(fromX + 1, Math.floor((x + 1) * scaleX))
      let weight = 0
      let count = 0
      let red = 0
      let green = 0
      let blue = 0
      for (let sy = fromY; sy < toY && sy < image.height; sy += 1) {
        for (let sx = fromX; sx < toX && sx < image.width; sx += 1) {
          const at = (sy * image.width + sx) * 4
          const alpha = image.data[at + 3]
          red += image.data[at] * alpha
          green += image.data[at + 1] * alpha
          blue += image.data[at + 2] * alpha
          weight += alpha
          count += 1
        }
      }
      const at = (y * width + x) * 4
      if (!count) continue
      target[at + 3] = Math.round(weight / count)
      if (!weight) continue
      target[at] = Math.round(red / weight)
      target[at + 1] = Math.round(green / weight)
      target[at + 2] = Math.round(blue / weight)
    }
  }
  return { width, height, data: target }
}

/**
 * Разрешение спрайта в пикселях по длинной стороне. Предмет на две клетки
 * хранится вдвое крупнее предмета на одну — иначе на карте они окажутся
 * разной чёткости.
 *
 * @param {string} id
 * @param {number} cellPixels
 * @returns {number}
 */
export function longestSideFor(id, cellPixels) {
  const drawn = DRAWN_CELLS[/** @type {keyof typeof DRAWN_CELLS} */ (id)]
  const entry = assetById(id)
  const footprint = entry ? Math.max(entry.baseFootprint.w, entry.baseFootprint.h) : 1
  return Math.round(Math.max(1, drawn ?? footprint) * cellPixels)
}

// --- укладка ---------------------------------------------------------------

/**
 * Полочная укладка: спрайты сортируются по высоте и кладутся рядами. Плотнее
 * бывает, но на сотне спрайтов разница в несколько процентов не стоит
 * усложнения.
 *
 * @param {Array<{id: string, image: PngImage}>} sprites
 * @param {number} [atlasWidth]
 * @returns {{width: number, height: number, frames: Array<{id: string, box: Box, image: PngImage}>}}
 */
export function packSprites(sprites, atlasWidth = ATLAS_WIDTH) {
  const ordered = [...sprites].sort((left, right) => (
    right.image.height - left.image.height || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  ))
  /** @type {Array<{id: string, box: Box, image: PngImage}>} */
  const frames = []
  let shelfY = FRAME_PADDING
  let shelfHeight = 0
  let cursorX = FRAME_PADDING
  for (const sprite of ordered) {
    if (sprite.image.width + FRAME_PADDING * 2 > atlasWidth) {
      throw new Error(`Спрайт ${sprite.id} шире атласа: ${sprite.image.width} > ${atlasWidth}`)
    }
    if (cursorX + sprite.image.width + FRAME_PADDING > atlasWidth) {
      shelfY += shelfHeight + FRAME_PADDING
      shelfHeight = 0
      cursorX = FRAME_PADDING
    }
    frames.push({ id: sprite.id, box: { x: cursorX, y: shelfY, w: sprite.image.width, h: sprite.image.height }, image: sprite.image })
    cursorX += sprite.image.width + FRAME_PADDING
    shelfHeight = Math.max(shelfHeight, sprite.image.height)
  }
  const height = shelfY + shelfHeight + FRAME_PADDING
  return { width: atlasWidth, height, frames: frames.sort((left, right) => (left.id < right.id ? -1 : 1)) }
}

/**
 * @param {{width: number, height: number, frames: Array<{id: string, box: Box, image: PngImage}>}} packed
 * @returns {PngImage}
 */
export function paintAtlas(packed) {
  const data = new Uint8Array(packed.width * packed.height * 4)
  for (const frame of packed.frames) {
    for (let y = 0; y < frame.box.h; y += 1) {
      const from = y * frame.box.w * 4
      const to = ((frame.box.y + y) * packed.width + frame.box.x) * 4
      data.set(frame.image.data.subarray(from, from + frame.box.w * 4), to)
    }
  }
  return { width: packed.width, height: packed.height, data }
}

// --- сборка ----------------------------------------------------------------

/**
 * @param {{sheetDir?: string, cellPixels?: number, onWarning?: (message: string) => void}} [options]
 */
export function buildPropAtlas(options = {}) {
  const sheetDir = options.sheetDir ?? join(ROOT, DEFAULT_SHEET_DIR)
  const cellPixels = options.cellPixels ?? DEFAULT_CELL_PIXELS
  const warn = options.onWarning ?? (() => {})
  /** @type {Array<{id: string, image: PngImage}>} */
  const sprites = []
  /** @type {Record<string, string>} */
  const sources = {}
  const skipped = { sheets: /** @type {string[]} */ ([]), ids: /** @type {string[]} */ ([]) }

  for (const sheet of PROP_STAMP_SHEETS) {
    // У листа может быть свой каталог: проёмы приезжают из набора пола и стен.
    const file = sheet.dir ? join(ROOT, sheet.dir, sheet.file) : join(sheetDir, sheet.file)
    if (!existsSync(file)) {
      skipped.sheets.push(sheet.file)
      warn(`лист не найден, пропущен: ${sheet.file}`)
      continue
    }
    const known = sheet.ids.filter((id) => assetById(id))
    if (!known.length) {
      skipped.sheets.push(sheet.file)
      skipped.ids.push(...sheet.ids)
      warn(`ни одного идентификатора листа ${sheet.file} нет в реестре — лист пропущен`)
      continue
    }
    const raw = readFileSync(file)
    sources[sheet.file] = createHash('sha256').update(raw).digest('hex')
    const keyed = keyOutBackground(decodePng(raw))
    const boxes = sliceSheet(keyed, sheet.grid)
    if (boxes.length !== sheet.ids.length) {
      throw new Error(`Лист ${sheet.file}: предметов на картинке ${boxes.length}, в раскладке ${sheet.ids.length}. Раскладка и картинка разошлись.`)
    }
    for (let index = 0; index < boxes.length; index += 1) {
      const id = sheet.ids[index]
      if (!assetById(id)) {
        skipped.ids.push(id)
        continue
      }
      const cropped = cropImage(keyed, boxes[index])
      const longest = longestSideFor(id, cellPixels)
      const scale = Math.min(1, longest / Math.max(cropped.width, cropped.height))
      const width = Math.max(1, Math.round(cropped.width * scale))
      const height = Math.max(1, Math.round(cropped.height * scale))
      sprites.push({ id, image: scale < 1 ? resampleImage(cropped, width, height) : cropped })
    }
  }

  if (skipped.ids.length) warn(`нет записи в реестре, спрайт не собран: ${skipped.ids.join(', ')}`)

  const packed = packSprites(sprites)
  const image = paintAtlas(packed)
  /** @type {Record<string, {x: number, y: number, w: number, h: number}>} */
  const frames = {}
  for (const frame of packed.frames) frames[frame.id] = frame.box
  const manifest = {
    version: ATLAS_VERSION,
    image: ATLAS_IMAGE_PATH,
    cellPixels,
    width: image.width,
    height: image.height,
    frames,
    sources,
  }
  return { image, manifest, skipped }
}

/**
 * Контрольный лист: все спрайты в клетку на шахматном поле. Нужен ровно для
 * одного — посмотреть глазами, что нарезка не съела край и не оставила каймы.
 *
 * @param {PngImage} atlas
 * @param {{frames: Record<string, {x: number, y: number, w: number, h: number}>}} manifest
 * @returns {PngImage}
 */
export function previewSheet(atlas, manifest) {
  const ids = Object.keys(manifest.frames).sort()
  const columns = 10
  const cell = 160
  const rows = Math.ceil(ids.length / columns)
  const width = columns * cell
  const height = Math.max(1, rows * cell)
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      const dark = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0
      data[at] = data[at + 1] = data[at + 2] = dark ? 96 : 128
      data[at + 3] = 255
    }
  }
  ids.forEach((id, index) => {
    const frame = manifest.frames[id]
    const scale = Math.min(1, (cell - 16) / Math.max(frame.w, frame.h))
    const drawWidth = Math.max(1, Math.round(frame.w * scale))
    const drawHeight = Math.max(1, Math.round(frame.h * scale))
    const sprite = resampleImage(cropImage(atlas, frame), drawWidth, drawHeight)
    const left = (index % columns) * cell + Math.round((cell - drawWidth) / 2)
    const top = Math.floor(index / columns) * cell + Math.round((cell - drawHeight) / 2)
    for (let y = 0; y < drawHeight; y += 1) {
      for (let x = 0; x < drawWidth; x += 1) {
        const from = (y * drawWidth + x) * 4
        const alpha = sprite.data[from + 3] / 255
        if (!alpha) continue
        const to = ((top + y) * width + left + x) * 4
        for (let channel = 0; channel < 3; channel += 1) {
          data[to + channel] = Math.round(sprite.data[from + channel] * alpha + data[to + channel] * (1 - alpha))
        }
      }
    }
  })
  return { width, height, data }
}

// --- запуск ----------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {string} name
 * @returns {string|null}
 */
function option(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
}

if (process.argv[1] && process.argv[1].endsWith('build-prop-atlas.mjs')) {
  const argv = process.argv.slice(2)
  const sheetDir = option(argv, '--sheets') ?? join(ROOT, DEFAULT_SHEET_DIR)
  const cellPixels = Number(option(argv, '--cell') ?? DEFAULT_CELL_PIXELS)
  const check = argv.includes('--check')
  const preview = option(argv, '--preview')
  /** @type {string[]} */
  const warnings = []
  const { image, manifest, skipped } = buildPropAtlas({ sheetDir, cellPixels, onWarning: (message) => warnings.push(message) })
  const imageFile = join(ROOT, 'public/assets', ATLAS_IMAGE_PATH)
  const manifestFile = join(ROOT, 'public/assets', ATLAS_MANIFEST_PATH)
  const png = encodePng(image)
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`

  if (check) {
    const same = existsSync(manifestFile) && readFileSync(manifestFile, 'utf8').replace(/\r\n/gu, '\n') === manifestText
    process.stdout.write(`${JSON.stringify({ ok: same, frames: Object.keys(manifest.frames).length, warnings }, null, 2)}\n`)
    if (!same) process.exitCode = 1
  } else if (preview) {
    writeFileSync(preview, encodePng(previewSheet(image, manifest)))
    process.stdout.write(`${JSON.stringify({ ok: true, preview, frames: Object.keys(manifest.frames).length, warnings }, null, 2)}\n`)
  } else {
    mkdirSync(dirname(imageFile), { recursive: true })
    writeFileSync(imageFile, png)
    writeFileSync(manifestFile, manifestText)
    process.stdout.write(`${JSON.stringify({
      ok: true,
      image: `public/assets/${ATLAS_IMAGE_PATH}`,
      bytes: png.length,
      size: `${image.width}×${image.height}`,
      frames: Object.keys(manifest.frames).length,
      skipped,
      warnings,
      next: 'зарегистрировать хеши: node tools/register-asset-rights.mjs',
    }, null, 2)}\n`)
  }
}
