#!/usr/bin/env node
// @ts-check
/**
 * Небольшой мост между авторитетной тактической картой и ImageGen.
 *
 * У модели нет права придумывать коллизии карты. Перед генерацией ей можно
 * передать PNG-референс: каждая существующая клетка занимает ровно один
 * квадрат, вода и пол различаются цветом, а стены и проёмы лежат на рёбрах.
 * Референс намеренно не содержит подписей и текста. По умолчанию он также не
 * содержит реквизита: мебель и прочие props рисуются игровым рендерером и
 * должны исчезать после разрушения. Для ручной QA-проверки можно включить
 * геометрические контуры props отдельным флагом.
 *
 * Вторая часть инструмента принимает PNG или WebP от генератора, уменьшает его
 * до production-размера и пишет WebP через установленный ffmpeg/libwebp. Если
 * ffmpeg отсутствует, тот же результат сохраняется как PNG. Исходник никогда
 * не изменяется и не удаляется.
 *
 * Примеры:
 *   node tools/tactical-map-imagegen.mjs blueprint \
 *     --scene-json tmp/imagegen/astohan-stormberg.json \
 *     --out tmp/imagegen/astohan-stormberg-floor-reference.png
 *   node tools/tactical-map-imagegen.mjs blueprint --include-props \
 *     --scene-json tmp/imagegen/astohan-stormberg.json \
 *     --out tmp/imagegen/astohan-stormberg-qa.png
 *   node tools/tactical-map-imagegen.mjs production \
 *     --input tmp/imagegen/astohan-stormberg-source.webp \
 *     --out tmp/imagegen/astohan-stormberg.webp
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'

import { isPng, isWebp } from '../server/image-generation.mjs'
import {
  cellAt,
  deserializeTacticalMap,
  edgeBetween,
  edgeList,
  tacticalMapFromLegacyCells,
} from '../server/tactical-map.mjs'
import { decodePng, encodePng } from './png-codec.mjs'
import { resampleImage } from './build-prop-atlas.mjs'

export const BLUEPRINT_VERSION = 'skazanie:tactical-map-blueprint-v1'
export const DEFAULT_CELL_SIZE = 32
// Запасной размер только для вызова API без карты. CLI для tactical map всегда
// выводит размер из `map.width × map.height × cellSize`.
export const PRODUCTION_WIDTH = 1536
export const PRODUCTION_HEIGHT = 1024
export const PRODUCTION_DEFAULT_WEBP_QUALITY = 88

/** @typedef {import('../server/tactical-map.mjs').TacticalMap} TacticalMap */
/** @typedef {import('./png-codec.mjs').PngImage} PngImage */

/** @typedef {{x: number, y: number, cellSize: number, mapWidth: number, mapHeight: number, offsetX: number, offsetY: number}} BlueprintLayout */

class TacticalMapImagegenError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'TacticalMapImagegenError'
    this.code = code
  }
}

export { TacticalMapImagegenError }

// --- вход карты -----------------------------------------------------------

/**
 * Принимает сериализованную TacticalMap, объект сцены с полем map либо старую
 * сцену с разреженным `cells`. Это позволяет использовать один CLI до и после
 * миграции сохранений на rich tactical map.
 *
 * @param {unknown} value
 * @returns {TacticalMap}
 */
export function resolveTacticalMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TacticalMapImagegenError('Вход карты должен быть JSON-объектом', 'MAP_INPUT_INVALID')
  }
  const raw = /** @type {Record<string, any>} */ (value)
  if (raw.map && typeof raw.map === 'object' && !Array.isArray(raw.map)) return resolveTacticalMap(raw.map)
  if (Array.isArray(raw.cells)) {
    return tacticalMapFromLegacyCells(raw.cells, {
      locationId: raw.location_id ?? raw.locationId ?? raw.location ?? raw.title ?? '',
      seed: raw.seed ?? '',
      tilesetId: raw.tilesetId ?? '',
    })
  }
  try {
    return deserializeTacticalMap(value)
  } catch (error) {
    throw new TacticalMapImagegenError(
      error instanceof Error ? error.message : String(error),
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'MAP_INPUT_INVALID',
    )
  }
}

/** @param {number} value */
function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/**
 * Стабильный маленький хеш для оттенка клетки и QA-контуров. Это не источник
 * случайности игры: координаты и seed сохраняются в самой карте.
 * @param {string|number} value
 */
function hash32(value) {
  const text = String(value)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** @param {number[]} color @param {number} amount */
function shade(color, amount) {
  return color.map((channel) => clampByte(channel + amount))
}

/** @param {number[]} color */
function colorKey(color) {
  return color.map((channel) => clampByte(channel))
}

const MATERIAL_COLORS = Object.freeze({
  stone: [89, 98, 107],
  wood: [123, 87, 57],
  earth: [112, 88, 61],
  grass: [66, 102, 67],
  sand: [174, 145, 83],
  marble: [151, 157, 157],
  metal: [75, 88, 101],
  ice: [113, 164, 181],
})

const SURFACE_COLORS = Object.freeze({
  water: [38, 105, 139],
  ice: [115, 183, 198],
  oil: [46, 43, 62],
  mud: [100, 76, 53],
  rubble: [116, 105, 93],
})

const EDGE_COLORS = Object.freeze({
  wall: [235, 219, 176],
  door: [242, 148, 65],
  window: [115, 203, 223],
  rail: [227, 186, 95],
  ledge: [189, 154, 105],
  loophole: [214, 185, 112],
  grate: [147, 182, 193],
})

/** @param {Uint8Array} data @param {number} width @param {number} x @param {number} y @param {number[]} color @param {number} alpha */
function blendPixel(data, width, x, y, color, alpha = 255) {
  if (x < 0 || y < 0) return
  const height = data.length / 4 / width
  if (x >= width || y >= height) return
  const at = (y * width + x) * 4
  const weight = Math.max(0, Math.min(255, alpha)) / 255
  data[at] = clampByte(data[at] * (1 - weight) + color[0] * weight)
  data[at + 1] = clampByte(data[at + 1] * (1 - weight) + color[1] * weight)
  data[at + 2] = clampByte(data[at + 2] * (1 - weight) + color[2] * weight)
  data[at + 3] = 255
}

/** @param {Uint8Array} data @param {number} width @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number[]} color @param {number} alpha */
function fillRect(data, width, x0, y0, x1, y1, color, alpha = 255) {
  const left = Math.max(0, Math.floor(Math.min(x0, x1)))
  const right = Math.min(width - 1, Math.ceil(Math.max(x0, x1)) - 1)
  const height = data.length / 4 / width
  const top = Math.max(0, Math.floor(Math.min(y0, y1)))
  const bottom = Math.min(height - 1, Math.ceil(Math.max(y0, y1)) - 1)
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) blendPixel(data, width, x, y, color, alpha)
  }
}

/** @param {Uint8Array} data @param {number} width @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number[]} color @param {number} thickness @param {number} [alpha] */
function drawLine(data, width, x0, y0, x1, y1, color, thickness, alpha = 255) {
  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.max(1, Math.hypot(dx, dy))
  const steps = Math.ceil(length * 1.5)
  const radius = Math.max(0, thickness / 2)
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps
    const x = x0 + dx * ratio
    const y = y0 + dy * ratio
    for (let oy = -radius; oy <= radius; oy += 1) {
      for (let ox = -radius; ox <= radius; ox += 1) {
        if (ox * ox + oy * oy <= radius * radius + 1) blendPixel(data, width, Math.round(x + ox), Math.round(y + oy), color, alpha)
      }
    }
  }
}

/** @param {Uint8Array} data @param {number} width @param {number} centerX @param {number} centerY @param {number} radius @param {number[]} color @param {number} thickness @param {number} [alpha] */
function drawRing(data, width, centerX, centerY, radius, color, thickness, alpha = 255) {
  const circumference = Math.max(12, Math.ceil(Math.PI * 2 * radius))
  for (let index = 0; index < circumference; index += 1) {
    const angle = index / circumference * Math.PI * 2
    for (let offset = -thickness / 2; offset <= thickness / 2; offset += 1) {
      blendPixel(data, width, Math.round(centerX + Math.cos(angle) * (radius + offset)), Math.round(centerY + Math.sin(angle) * (radius + offset)), color, alpha)
    }
  }
}

/**
 * Контур предмета для QA-референса. Это намеренно не рендер ассета: он лишь
 * показывает, где лежит footprint, чтобы глазами сравнить карту и JSON.
 * @param {Uint8Array} data
 * @param {number} width
 * @param {TacticalMap['props'][number]} prop
 * @param {BlueprintLayout} layout
 */
function drawPropOutline(data, width, prop, layout) {
  const footprint = prop.footprint.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
  const minX = Math.min(...footprint.map((cell) => cell.x))
  const maxX = Math.max(...footprint.map((cell) => cell.x)) + 1
  const minY = Math.min(...footprint.map((cell) => cell.y))
  const maxY = Math.max(...footprint.map((cell) => cell.y)) + 1
  const seed = hash32(prop.assetId)
  const color = [108 + (seed & 0x3f), 201 - (seed & 0x3f), 155 + ((seed >>> 8) & 0x3f)]
  const left = layout.offsetX + minX * layout.cellSize + layout.cellSize * 0.16
  const top = layout.offsetY + minY * layout.cellSize + layout.cellSize * 0.16
  const right = layout.offsetX + maxX * layout.cellSize - layout.cellSize * 0.16
  const bottom = layout.offsetY + maxY * layout.cellSize - layout.cellSize * 0.16
  fillRect(data, width, left, top, right, bottom, color, 35)
  drawLine(data, width, left, top, right, top, color, Math.max(2, layout.cellSize / 12), 210)
  drawLine(data, width, right, top, right, bottom, color, Math.max(2, layout.cellSize / 12), 210)
  drawLine(data, width, right, bottom, left, bottom, color, Math.max(2, layout.cellSize / 12), 210)
  drawLine(data, width, left, bottom, left, top, color, Math.max(2, layout.cellSize / 12), 210)
}

/** @param {string} kind */
function edgeColor(kind) {
  return EDGE_COLORS[/** @type {keyof typeof EDGE_COLORS} */ (kind)] ?? EDGE_COLORS.wall
}

/** @param {TacticalMap} map @param {number} x @param {number} y @param {'e'|'s'} dir @param {BlueprintLayout} layout */
function edgeCoordinates(map, x, y, dir, layout) {
  void map
  if (dir === 'e') {
    const atX = layout.offsetX + (x + 1) * layout.cellSize
    const atY = layout.offsetY + y * layout.cellSize
    return [atX, atY, atX, atY + layout.cellSize]
  }
  const atX = layout.offsetX + x * layout.cellSize
  const atY = layout.offsetY + (y + 1) * layout.cellSize
  return [atX, atY, atX + layout.cellSize, atY]
}

/**
 * Рисует детерминированный blueprint. Координаты не округляются внутри карты:
 * только общий origin и целый размер клетки выбираются для целевого холста.
 * @param {unknown} input сериализованная карта или scene
 * @param {{width?: number, height?: number, cellSize?: number, includeProps?: boolean, grid?: boolean}} [options]
 * @returns {{image: PngImage, map: TacticalMap, layout: BlueprintLayout, version: string, includeProps: boolean}}
 */
export function renderTacticalMapBlueprint(input, options = {}) {
  const map = resolveTacticalMap(input)
  const requestedCellSize = Number.isSafeInteger(options.cellSize) && options.cellSize > 0 ? options.cellSize : DEFAULT_CELL_SIZE
  const width = Number.isSafeInteger(options.width) && options.width > 0 ? options.width : map.width * requestedCellSize
  const height = Number.isSafeInteger(options.height) && options.height > 0 ? options.height : map.height * requestedCellSize
  // A tactical reference is a cell raster, not a framed illustration: no
  // letterbox, no outer margin, and one native square per map coordinate.
  const cellSize = Math.max(1, Math.floor(Math.min(width / map.width, height / map.height)))
  const mapWidth = cellSize * map.width
  const mapHeight = cellSize * map.height
  const layout = {
    x: 0,
    y: 0,
    cellSize,
    mapWidth,
    mapHeight,
    offsetX: Math.floor((width - mapWidth) / 2),
    offsetY: Math.floor((height - mapHeight) / 2),
  }
  const data = new Uint8Array(width * height * 4)
  const background = [16, 22, 30]
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4
    data[at] = background[0]
    data[at + 1] = background[1]
    data[at + 2] = background[2]
    data[at + 3] = 255
  }

  const atPixel = (x, y) => [layout.offsetX + x * cellSize, layout.offsetY + y * cellSize]
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell) continue
      const surface = SURFACE_COLORS[/** @type {keyof typeof SURFACE_COLORS} */ (cell.surface)]
      const material = MATERIAL_COLORS[/** @type {keyof typeof MATERIAL_COLORS} */ (cell.material)] ?? MATERIAL_COLORS.stone
      const base = surface ?? (cell.passable ? material : [39, 45, 52])
      const variant = ((Number(cell.variant) || 0) % 4) * 3 - 4
      const color = colorKey(shade(base, variant))
      const [left, top] = atPixel(x, y)
      fillRect(data, width, left, top, left + cellSize, top + cellSize, color)
      // Вода получает спокойные диагональные волны, прочий пол — редкие
      // минеральные штрихи. Все они остаются внутри клетки и не сдвигают её.
      if (cell.surface === 'water' || cell.surface === 'ice') {
        const wave = cell.surface === 'ice' ? [205, 239, 242] : [131, 205, 220]
        for (let offset = Math.floor(cellSize * 0.22); offset < cellSize; offset += Math.max(5, Math.floor(cellSize * 0.32))) {
          drawLine(data, width, left + Math.floor(cellSize * 0.15), top + offset, left + Math.floor(cellSize * 0.85), top + offset, wave, Math.max(1, cellSize / 20), 100)
        }
      }
    }
  }

  // Сетка отключена по умолчанию: ImageGen получает чистый план. Включается
  // только для QA, когда нужно глазами проверить каждую клетку.
  if (options.grid === true) {
    const gridColor = [208, 222, 229]
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const cell = cellAt(map, x, y)
        if (!cell) continue
        const [left, top] = atPixel(x, y)
        drawLine(data, width, left, top, left + cellSize, top, gridColor, Math.max(1, cellSize / 28), 65)
        drawLine(data, width, left, top, left, top + cellSize, gridColor, Math.max(1, cellSize / 28), 65)
      }
    }
  }

  // У неровного контура отсутствующая соседняя клетка остаётся видимой даже
  // в чистом floor-only референсе. Это граница формы, а не декоративная рамка.
  const contour = [224, 214, 173]
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!cellAt(map, x, y)) continue
      const [left, top] = atPixel(x, y)
      if (!cellAt(map, x + 1, y)) drawLine(data, width, left + cellSize, top, left + cellSize, top + cellSize, contour, Math.max(2, cellSize / 10), 220)
      if (!cellAt(map, x, y + 1)) drawLine(data, width, left, top + cellSize, left + cellSize, top + cellSize, contour, Math.max(2, cellSize / 10), 220)
      if (!cellAt(map, x - 1, y)) drawLine(data, width, left, top, left, top + cellSize, contour, Math.max(2, cellSize / 10), 220)
      if (!cellAt(map, x, y - 1)) drawLine(data, width, left, top, left + cellSize, top, contour, Math.max(2, cellSize / 10), 220)
    }
  }

  for (const edge of edgeList(map)) {
    const [x0, y0, x1, y1] = edgeCoordinates(map, edge.x, edge.y, edge.dir, layout)
    const thickness = edge.kind === 'wall' ? Math.max(3, cellSize / 8) : Math.max(2, cellSize / 12)
    drawLine(data, width, x0, y0, x1, y1, edgeColor(edge.kind), thickness, 235)
  }

  if (options.includeProps === true) {
    for (const prop of map.props) drawPropOutline(data, width, prop, layout)
  }

  return {
    image: { width, height, data },
    map,
    layout,
    version: BLUEPRINT_VERSION,
    includeProps: options.includeProps === true,
  }
}

/** @param {unknown} input @param {string} filePath @param {Parameters<typeof renderTacticalMapBlueprint>[1]} [options] */
export function writeTacticalMapBlueprint(input, filePath, options = {}) {
  const built = renderTacticalMapBlueprint(input, options)
  const target = resolve(filePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, encodePng(built.image))
  return { ...built, filePath: target, bytes: readFileSync(target).length }
}

// --- production output ----------------------------------------------------

/** @param {Buffer} bytes */
function isSupportedImage(bytes) {
  return isPng(bytes) || isWebp(bytes)
}

/** @param {string|undefined} runtime */
function ffmpegStatus(runtime) {
  const executable = runtime || process.env.FFMPEG_PATH || 'ffmpeg'
  const result = spawnSync(executable, ['-hide_banner', '-version'], {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  })
  return { executable, available: !result.error && result.status === 0 }
}

/** @param {string|undefined} runtime @param {string[]} args @param {Buffer} input */
function runFfmpeg(runtime, args, input) {
  const status = ffmpegStatus(runtime)
  if (!status.available) throw new TacticalMapImagegenError('Для WebP нужен установленный ffmpeg с libwebp', 'WEBP_RUNTIME_UNAVAILABLE')
  const result = spawnSync(status.executable, args, {
    input,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length === 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : ''
    throw new TacticalMapImagegenError(`ffmpeg не обработал изображение${detail ? `: ${detail.slice(0, 240)}` : ''}`, 'IMAGE_CONVERSION_FAILED')
  }
  return Buffer.from(result.stdout)
}

/** @param {Buffer} bytes @param {string|undefined} runtime */
function decodeSourcePng(bytes, runtime) {
  if (isPng(bytes)) return bytes
  if (!isWebp(bytes)) throw new TacticalMapImagegenError('Источник должен быть PNG или WebP', 'IMAGE_FORMAT_UNSUPPORTED')
  return runFfmpeg(runtime, [
    // Как и PNG, WebP в stdin распознаётся image2pipe; отдельного demuxer
    // `webp` у ffmpeg нет.
    '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ], bytes)
}

/** @param {PngImage} image @param {string|undefined} runtime @param {number} quality */
function encodeProductionWebp(image, runtime, quality) {
  const png = encodePng(image)
  return runFfmpeg(runtime, [
    // ffmpeg 8 не принимает `-f png` для pipe-входа: PNG — image2 demuxer.
    '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0',
    '-frames:v', '1', '-c:v', 'libwebp', '-q:v', String(Math.max(1, Math.min(100, Math.round(quality)))),
    '-f', 'webp', 'pipe:1',
  ], png)
}

/**
 * Приводит ответ ImageGen к рабочему размеру 1536×1024. Входной буфер не
 * меняется. `format=auto` выбирает WebP при наличии ffmpeg и PNG иначе.
 * `strictAspect` позволяет QA явно запретить растяжение ответа модели.
 *
 * @param {Buffer} bytes
 * @param {{width?: number, height?: number, format?: 'auto'|'webp'|'png', quality?: number, ffmpegPath?: string, strictAspect?: boolean}} [options]
 * @returns {{bytes: Buffer, width: number, height: number, format: 'webp'|'png', sourceFormat: 'webp'|'png', sourceWidth: number, sourceHeight: number, ffmpeg: string|null, aspectChanged: boolean}}
 */
export function normalizeGeneratedImage(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes) || !isSupportedImage(bytes)) {
    throw new TacticalMapImagegenError('Источник должен быть PNG или WebP', 'IMAGE_FORMAT_UNSUPPORTED')
  }
  const runtime = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg'
  const sourceFormat = isWebp(bytes) ? 'webp' : 'png'
  const sourcePng = decodeSourcePng(bytes, runtime)
  const source = decodePng(sourcePng)
  const width = Number.isSafeInteger(options.width) && options.width > 0 ? options.width : PRODUCTION_WIDTH
  const height = Number.isSafeInteger(options.height) && options.height > 0 ? options.height : PRODUCTION_HEIGHT
  const aspectChanged = Math.abs(source.width / source.height - width / height) > 0.01
  if (options.strictAspect === true && aspectChanged) {
    throw new TacticalMapImagegenError(`Пропорции источника ${source.width}×${source.height} не совпадают с ${width}×${height}`, 'IMAGE_ASPECT_MISMATCH')
  }
  const image = source.width === width && source.height === height ? source : resampleImage(source, width, height)
  const requested = options.format ?? 'auto'
  const canWebp = ffmpegStatus(runtime).available
  const format = requested === 'auto' ? (canWebp ? 'webp' : 'png') : requested
  if (format === 'webp' && !canWebp) throw new TacticalMapImagegenError('Запрошен WebP, но ffmpeg/libwebp недоступен', 'WEBP_RUNTIME_UNAVAILABLE')
  const output = format === 'webp' ? encodeProductionWebp(image, runtime, options.quality ?? PRODUCTION_DEFAULT_WEBP_QUALITY) : encodePng(image)
  return {
    bytes: output,
    width,
    height,
    format,
    sourceFormat,
    sourceWidth: source.width,
    sourceHeight: source.height,
    ffmpeg: canWebp ? runtime : null,
    aspectChanged,
  }
}

/**
 * Читает источник по пути и пишет новый production-файл. При `format=auto`
 * расширение `.webp` автоматически меняется на `.png`, если runtime не найден;
 * нельзя оставлять PNG под ложным расширением.
 *
 * @param {string|Buffer} source
 * @param {string} outputPath
 * @param {{width?: number, height?: number, format?: 'auto'|'webp'|'png', quality?: number, ffmpegPath?: string, strictAspect?: boolean, force?: boolean}} [options]
 */
export function saveGeneratedImage(source, outputPath, options = {}) {
  const sourceBytes = Buffer.isBuffer(source) ? source : readFileSync(resolve(source))
  const normalized = normalizeGeneratedImage(sourceBytes, options)
  let target = resolve(outputPath)
  if (options.format === 'auto' || options.format == null) {
    const expectedExtension = normalized.format === 'webp' ? '.webp' : '.png'
    if (extname(target).toLocaleLowerCase() !== expectedExtension) target = `${target.slice(0, target.length - extname(target).length)}${expectedExtension}`
  }
  if (existsSync(target) && options.force !== true) {
    throw new TacticalMapImagegenError(`Файл уже существует: ${target}; для замены укажите --force`, 'OUTPUT_EXISTS')
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, normalized.bytes)
  return { ...normalized, filePath: target, bytes: normalized.bytes.length, sourcePath: typeof source === 'string' ? resolve(source) : null }
}

// --- CLI ------------------------------------------------------------------

/** @param {string[]} argv @param {string} name */
function cliOption(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith('--') ? argv[index + 1] : ''
}

/** @param {string} path */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'))
  } catch (error) {
    throw new TacticalMapImagegenError(`Не удалось прочитать JSON карты: ${error instanceof Error ? error.message : String(error)}`, 'MAP_JSON_READ_FAILED')
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (command === 'blueprint') {
    const inputPath = cliOption(argv, '--scene-json') || cliOption(argv, '--map')
    const outputPath = cliOption(argv, '--out')
    if (!inputPath || !outputPath) throw new TacticalMapImagegenError('blueprint требует --scene-json <file> и --out <file.png>', 'CLI_ARGUMENTS_INVALID')
    const result = writeTacticalMapBlueprint(readJson(inputPath), outputPath, {
      width: Number(cliOption(argv, '--width')) || undefined,
      height: Number(cliOption(argv, '--height')) || undefined,
      cellSize: Number(cliOption(argv, '--cell')) || DEFAULT_CELL_SIZE,
      includeProps: argv.includes('--include-props'),
      grid: argv.includes('--grid'),
    })
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command,
      version: result.version,
      filePath: result.filePath,
      bytes: result.bytes,
      width: result.image.width,
      height: result.image.height,
      map: `${result.map.width}×${result.map.height}`,
      cells: result.map.layers.present.reduce((count, byte) => count + byte.toString(2).split('1').length - 1, 0),
      cellSize: result.layout.cellSize,
      includeProps: result.includeProps,
      props: result.map.props.length,
    }, null, 2)}\n`)
    return
  }
  if (command === 'production') {
    const inputPath = cliOption(argv, '--input')
    const outputPath = cliOption(argv, '--out')
    if (!inputPath || !outputPath) throw new TacticalMapImagegenError('production требует --input <source.png|source.webp> и --out <file>', 'CLI_ARGUMENTS_INVALID')
    const scenePath = cliOption(argv, '--scene-json') || cliOption(argv, '--map')
    const map = scenePath ? resolveTacticalMap(readJson(scenePath)) : null
    const cellSize = Number(cliOption(argv, '--cell')) || DEFAULT_CELL_SIZE
    const requestedFormat = cliOption(argv, '--format')
    if (requestedFormat && requestedFormat !== 'auto' && requestedFormat !== 'png' && requestedFormat !== 'webp') {
      throw new TacticalMapImagegenError('--format допускает auto, webp или png', 'CLI_ARGUMENTS_INVALID')
    }
    const result = saveGeneratedImage(inputPath, outputPath, {
      width: Number(cliOption(argv, '--width')) || (map ? map.width * cellSize : PRODUCTION_WIDTH),
      height: Number(cliOption(argv, '--height')) || (map ? map.height * cellSize : PRODUCTION_HEIGHT),
      format: /** @type {'auto'|'webp'|'png'|undefined} */ (requestedFormat || 'auto'),
      quality: Number(cliOption(argv, '--quality')) || PRODUCTION_DEFAULT_WEBP_QUALITY,
      strictAspect: argv.includes('--strict-aspect'),
      ffmpegPath: cliOption(argv, '--ffmpeg') || undefined,
      force: argv.includes('--force'),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...result, bytes: result.bytes }, null, 2)}\n`)
    return
  }
  throw new TacticalMapImagegenError('Команда: blueprint или production', 'CLI_ARGUMENTS_INVALID')
}

if (process.argv[1] && process.argv[1].endsWith('tactical-map-imagegen.mjs')) {
  try {
    await main()
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'TACTICAL_MAP_IMAGEGEN_FAILED'
    process.stderr.write(`${JSON.stringify({ ok: false, code, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
    process.exitCode = 1
  }
}
