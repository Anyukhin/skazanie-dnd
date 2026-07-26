#!/usr/bin/env node
// @ts-check
/**
 * Сборка тайлсета местности: пол по материалам, поверхности поверх пола и
 * фактуры стен.
 *
 * Что делает: сшивает края фактуры, чтобы плитка стыковалась сама с собой,
 * уменьшает до рабочего разрешения и пишет палитровым PNG с манифестом.
 *
 * Почему сшивать приходится здесь. Ни одна генеративная модель бесшовную
 * плитку не выдаёт: замер набора 2026-07-26 показал расхождение краёв от 6 до
 * 43 единиц яркости при нулевой разнице между соседними столбцами внутри
 * кадра. На карте такой стык читается решёткой. Поэтому от генерации требуется
 * только ровность фактуры (`docs/floor-wall-stamps-prompts.md`), а стыковка —
 * работа инструмента.
 *
 * Запуск:
 *   pnpm terrain:tiles --sheets <каталог с фактурами>
 *   pnpm terrain:tiles --check
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { decodePng, encodeIndexedPng } from './png-codec.mjs'
import { resampleImage } from './build-prop-atlas.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

export const TERRAIN_TILES_VERSION = 'skazanie:terrain-tiles-v1'

export const DEFAULT_SOURCE_DIR = 'assets-src/floor-wall-stamps'

/** Путь внутри `public/assets`, он же `rightsId`. */
export const TERRAIN_MANIFEST_PATH = 'maps/terrain/terrain-tiles.json'

/**
 * Сколько клеток 5×5 футов укладывается в одну плитку. Значение задано
 * промптом («восемь на восемь клеток в кадре») и определяет, как рендер
 * раскладывает фактуру по карте.
 */
export const CELLS_PER_TILE = 8

/**
 * Сторона готовой плитки. 512 на восемь клеток — это 64 пикселя на клетку;
 * доска показывает клетку в 30–70 пикселях, то есть запас есть, а вес файла
 * ещё разумный: палитровый PNG около 200 КБ против полумегабайта в полном
 * цвете и полутора мегабайт при стороне 768.
 */
export const DEFAULT_TILE_SIDE = 512

/**
 * Ширина полосы сшивки в пикселях исходника. На 2048 это шесть процентов
 * кадра: достаточно, чтобы стык растворился, и мало, чтобы призрак наложения
 * был заметен.
 */
export const DEFAULT_BLEND_BAND = 128

/**
 * Раскладка набора: файл → куда он идёт.
 *
 * `floor` — материал клетки из контракта карты, `surface` — поверхность поверх
 * пола, `wall` — фактура, из которой нарезается полоса стены на ребре.
 */
export const TERRAIN_SOURCES = Object.freeze([
  { file: 'floor-stone.png', slot: 'floors', key: 'stone' },
  { file: 'floor-wood.png', slot: 'floors', key: 'wood' },
  { file: 'floor-earth.png', slot: 'floors', key: 'earth' },
  { file: 'floor-grass.png', slot: 'floors', key: 'grass' },
  { file: 'floor-sand.png', slot: 'floors', key: 'sand' },
  { file: 'floor-marble.png', slot: 'floors', key: 'marble' },
  { file: 'floor-metal.png', slot: 'floors', key: 'metal' },
  { file: 'floor-ice.png', slot: 'floors', key: 'ice' },
  { file: 'surface-water.png', slot: 'surfaces', key: 'water' },
  { file: 'surface-mud.png', slot: 'surfaces', key: 'mud' },
  { file: 'surface-oil.png', slot: 'surfaces', key: 'oil' },
  { file: 'surface-rubble.png', slot: 'surfaces', key: 'rubble' },
  { file: 'wall-stone.png', slot: 'walls', key: 'stone' },
  { file: 'wall-timber.png', slot: 'walls', key: 'wood' },
  { file: 'wall-plaster.png', slot: 'walls', key: 'plaster' },
  { file: 'wall-cave.png', slot: 'walls', key: 'cave' },
])

/**
 * @typedef {import('./png-codec.mjs').PngImage} PngImage
 */

/**
 * Расхождение противоположных краёв: среднее отличие крайнего столбца от
 * первого (и крайней строки от первой) на канал. У бесшовной плитки эта
 * величина равна разнице соседних пикселей внутри кадра, у обычной картинки —
 * в разы больше.
 *
 * @param {PngImage} image
 * @returns {{x: number, y: number}}
 */
export function seamScore(image) {
  const { width, height, data } = image
  const channelDiff = (/** @type {number} */ a, /** @type {number} */ b) => (
    Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2])
  ) / 3
  let x = 0
  for (let row = 0; row < height; row += 1) x += channelDiff((row * width) * 4, (row * width + width - 1) * 4)
  let y = 0
  for (let column = 0; column < width; column += 1) y += channelDiff(column * 4, ((height - 1) * width + column) * 4)
  return { x: x / height, y: y / width }
}

/**
 * Сшивка краёв перекрытием. Плитка укорачивается на ширину полосы, а в самой
 * полосе изображение перетекает из противоположного края в свой:
 * `out(0)` берётся ровно из того пикселя исходника, который в нём соседствует
 * с `out(ширина - 1)`. Поэтому уложенные рядом копии стыкуются по построению,
 * а не по удаче.
 *
 * @param {PngImage} image
 * @param {number} [band]
 * @returns {PngImage}
 */
export function makeSeamless(image, band = DEFAULT_BLEND_BAND) {
  const overlap = Math.max(1, Math.min(band, Math.floor(Math.min(image.width, image.height) / 4)))
  const acrossX = blendAxis(image, overlap, true)
  return blendAxis(acrossX, overlap, false)
}

/**
 * @param {PngImage} image
 * @param {number} overlap
 * @param {boolean} horizontal
 * @returns {PngImage}
 */
function blendAxis(image, overlap, horizontal) {
  const width = horizontal ? image.width - overlap : image.width
  const height = horizontal ? image.height : image.height - overlap
  const data = new Uint8Array(width * height * 4)
  const span = horizontal ? width : height
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const along = horizontal ? x : y
      const near = ((y * image.width) + x) * 4
      const to = (y * width + x) * 4
      if (along >= overlap) {
        data.set(image.data.subarray(near, near + 4), to)
        continue
      }
      const far = horizontal
        ? ((y * image.width) + x + span) * 4
        : (((y + span) * image.width) + x) * 4
      const weight = along / overlap
      for (let channel = 0; channel < 4; channel += 1) {
        data[to + channel] = Math.round(image.data[far + channel] * (1 - weight) + image.data[near + channel] * weight)
      }
    }
  }
  return { width, height, data }
}

/**
 * @param {{sourceDir?: string, side?: number, band?: number, colors?: number, onWarning?: (message: string) => void}} [options]
 */
export function buildTerrainTiles(options = {}) {
  const sourceDir = options.sourceDir ?? join(ROOT, DEFAULT_SOURCE_DIR)
  const side = options.side ?? DEFAULT_TILE_SIDE
  const warn = options.onWarning ?? (() => {})
  /** @type {Array<{path: string, bytes: Buffer}>} */
  const files = []
  /** @type {Record<string, Record<string, string>>} */
  const manifest = { floors: {}, surfaces: {}, walls: {} }
  /** @type {Array<{key: string, before: {x: number, y: number}, after: {x: number, y: number}}>} */
  const seams = []
  /** @type {string[]} */
  const missing = []

  for (const source of TERRAIN_SOURCES) {
    const file = join(sourceDir, source.file)
    if (!existsSync(file)) {
      missing.push(source.file)
      warn(`фактура не найдена, пропущена: ${source.file}`)
      continue
    }
    const original = decodePng(readFileSync(file))
    const before = seamScore(original)
    const stitched = makeSeamless(original, options.band)
    const tile = resampleImage(stitched, side, side)
    seams.push({ key: `${source.slot}.${source.key}`, before, after: seamScore(tile) })
    const path = `maps/terrain/${source.file}`
    files.push({ path, bytes: encodeIndexedPng(tile, { colors: options.colors ?? 256 }) })
    manifest[source.slot][source.key] = path
  }

  return {
    files,
    seams,
    missing,
    manifest: {
      version: TERRAIN_TILES_VERSION,
      cellsPerTile: CELLS_PER_TILE,
      tileSide: side,
      ...manifest,
    },
  }
}

if (process.argv[1] && process.argv[1].endsWith('build-terrain-tiles.mjs')) {
  const argv = process.argv.slice(2)
  const option = (/** @type {string} */ name) => {
    const index = argv.indexOf(name)
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
  }
  const sourceDir = option('--sheets') ?? join(ROOT, DEFAULT_SOURCE_DIR)
  const side = Number(option('--side') ?? DEFAULT_TILE_SIDE)
  const band = Number(option('--band') ?? DEFAULT_BLEND_BAND)
  const check = argv.includes('--check')
  /** @type {string[]} */
  const warnings = []
  const built = buildTerrainTiles({ sourceDir, side, band, onWarning: (message) => warnings.push(message) })
  const manifestFile = join(ROOT, 'public/assets', TERRAIN_MANIFEST_PATH)
  const manifestText = `${JSON.stringify(built.manifest, null, 2)}\n`

  if (check) {
    const same = existsSync(manifestFile) && readFileSync(manifestFile, 'utf8').replace(/\r\n/gu, '\n') === manifestText
    process.stdout.write(`${JSON.stringify({ ok: same, tiles: built.files.length, warnings }, null, 2)}\n`)
    if (!same) process.exitCode = 1
  } else {
    mkdirSync(dirname(manifestFile), { recursive: true })
    for (const file of built.files) writeFileSync(join(ROOT, 'public/assets', file.path), file.bytes)
    writeFileSync(manifestFile, manifestText)
    process.stdout.write(`${JSON.stringify({
      ok: true,
      tiles: built.files.length,
      bytes: built.files.reduce((sum, file) => sum + file.bytes.length, 0),
      seams: built.seams.map((item) => ({
        [item.key]: `${item.before.x.toFixed(1)}/${item.before.y.toFixed(1)} → ${item.after.x.toFixed(1)}/${item.after.y.toFixed(1)}`,
      })),
      missing: built.missing,
      warnings,
      next: 'зарегистрировать хеши: pnpm terrain:rights',
    }, null, 2)}\n`)
  }
}
