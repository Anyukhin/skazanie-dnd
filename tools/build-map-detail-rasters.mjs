#!/usr/bin/env node
// @ts-check
/**
 * Сборка отдельного набора растра детализации карты.
 *
 * Набор намеренно не подключается к действующему атласу предметов и не
 * меняет реестр ассетов: это самостоятельный пакет `maps/detail-v1`, который
 * можно подключить к генератору карты после визуальной приёмки.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { cropImage, keyOutBackground, packSprites, paintAtlas, resampleImage, sliceSheet } from './build-prop-atlas.mjs'
import { makeSeamless } from './build-terrain-tiles.mjs'
import { decodePng, encodeIndexedPng, encodePng } from './png-codec.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

export const MAP_DETAIL_VERSION = 'skazanie:map-detail-v1'
export const MAP_DETAIL_PACKAGE = 'maps/detail-v1'
export const TILE_SIDE = 512
export const CELLS_PER_TILE = 8
export const CELL_PIXELS = 96
export const ATLAS_WIDTH = 2048
export const MAX_ATLAS_SIDE = 4095

/** @typedef {import('./png-codec.mjs').PngImage} PngImage */
/** @typedef {{x: number, y: number, w: number, h: number}} Box */

/**
 * @typedef {object} NormalizedRaster
 * @property {string} file
 * @property {'floor'|'wall'|'surface'|'sheet'} type
 * @property {string} prompt
 * @property {string[]} ids
 * @property {Array<{w: number, h: number}>} footprints
 * @property {string} key
 */

/**
 * @typedef {object} Sprite
 * @property {string} id
 * @property {PngImage} image
 * @property {{w: number, h: number}} footprint
 * @property {string} sheet
 * @property {number} sourceIndex
 * @property {string} sourceHash
 * @property {string} promptHash
 */

/**
 * @typedef {object} BuildFile
 * @property {string} path Путь относительно outputDir.
 * @property {Buffer} bytes
 * @property {'texture'|'atlas'|'metadata'} kind
 */

const HASH_ALGORITHM = 'sha256'

/**
 * @param {Buffer|string|Uint8Array} value
 * @returns {string}
 */
function hash(value) {
  return createHash(HASH_ALGORITHM).update(value).digest('hex')
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: ожидается объект`)
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: ожидается непустая строка`)
  return value
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}: ожидается положительное целое число`)
  return /** @type {number} */ (value)
}

/**
 * Проверка относительного имени. Файл из спецификации не должен позволять
 * записи уйти из каталога исходников или из каталога готового пакета.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function relativeName(value, label) {
  const name = nonEmptyString(value, label).replaceAll('\\', '/')
  if (isAbsolute(name) || name.startsWith('/') || name.split('/').includes('..')) {
    throw new Error(`${label}: путь должен быть относительным и не содержать '..'`)
  }
  return name
}

/**
 * @param {string} file
 * @returns {string}
 */
function keyFromFile(file) {
  const base = file.slice(file.lastIndexOf('/') + 1)
  return base.toLowerCase().endsWith('.png') ? base.slice(0, -4) : base
}

/**
 * @param {unknown} value
 * @param {string} file
 * @returns {'floor'|'wall'|'surface'|'sheet'}
 */
function normalizeType(value, file) {
  if (value === 'floor' || value === 'wall' || value === 'surface' || value === 'sheet') return value
  throw new Error(`${file}: неизвестный type ${String(value)}; нужен floor, wall, surface или sheet`)
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Array<unknown>}
 */
function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}: ожидается массив`)
  return value
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string[]} ids
 * @param {string} label
 * @returns {Array<{w: number, h: number}>}
 */
function normalizeFootprints(entry, ids, label) {
  const value = entry.footprints
  if (value === undefined && ids.length === 0) return []
  const values = array(value, `${label}.footprints`)
  if (values.length !== ids.length) throw new Error(`${label}.footprints: ${values.length} записей для ${ids.length} ID`)
  return values.map((item, index) => {
    const footprint = record(item, `${label}.footprints[${index}]`)
    return {
      w: positiveInteger(footprint.w, `${label}.footprints[${index}].w`),
      h: positiveInteger(footprint.h, `${label}.footprints[${index}].h`),
    }
  })
}

/**
 * @param {unknown} specValue
 * @returns {{rasters: NormalizedRaster[], models: Array<Record<string, unknown>>, counts: Record<string, number>}}
 */
function normalizeSpec(specValue) {
  const spec = record(specValue, 'spec')
  const declared = record(spec.counts, 'spec.counts')
  const counts = Object.fromEntries(['sourceRasters', 'textures', 'sheets', 'stamps', 'models'].map(key => [key, positiveInteger(declared[key], `spec.counts.${key}`)]))
  const rawRasters = array(spec.rasters, 'spec.rasters')
  /** @type {NormalizedRaster[]} */
  const rasters = []
  const files = new Set()
  const keys = new Set()
  const ids = new Set()

  rawRasters.forEach((raw, index) => {
    const entry = record(raw, `spec.rasters[${index}]`)
    const file = relativeName(entry.file, `spec.rasters[${index}].file`)
    if (files.has(file)) throw new Error(`spec.rasters: повторяется файл ${file}`)
    files.add(file)
    const key = keyFromFile(file)
    if (keys.has(key)) throw new Error(`spec.rasters: повторяется key ${key}`)
    keys.add(key)
    const type = normalizeType(entry.type, file)
    const prompt = nonEmptyString(entry.prompt, `${file}.prompt`)
    const rawIds = entry.ids === undefined ? [] : array(entry.ids, `${file}.ids`)
    const rasterIds = rawIds.map((id, idIndex) => nonEmptyString(id, `${file}.ids[${idIndex}]`))
    if (type !== 'sheet' && rasterIds.length) throw new Error(`${file}: у фактуры не должно быть ids`)
    if (type === 'sheet' && rasterIds.length !== 9) throw new Error(`${file}: лист должен содержать ровно 9 ID, получено ${rasterIds.length}`)
    for (const id of rasterIds) {
      if (ids.has(id)) throw new Error(`ID штампа повторяется: ${id}`)
      ids.add(id)
    }
    const footprints = normalizeFootprints(entry, rasterIds, file)
    if (type !== 'sheet' && footprints.length) throw new Error(`${file}: у фактуры не должно быть footprints`)
    rasters.push({ file, type, prompt, ids: rasterIds, footprints, key })
  })

  const textureCount = rasters.filter((item) => item.type !== 'sheet').length
  const sheetCount = rasters.filter((item) => item.type === 'sheet').length
  if (rasters.length !== counts.sourceRasters) throw new Error(`spec.rasters: нужно ${counts.sourceRasters} исходников, получено ${rasters.length}`)
  if (textureCount !== counts.textures) throw new Error(`spec.rasters: нужно ${counts.textures} фактур, получено ${textureCount}`)
  if (sheetCount !== counts.sheets) throw new Error(`spec.rasters: нужно ${counts.sheets} листов, получено ${sheetCount}`)
  if (ids.size !== counts.stamps) throw new Error(`spec.rasters: нужно ${counts.stamps} уникальных ID, получено ${ids.size}`)

  const modelsValue = spec.models === undefined ? [] : array(spec.models, 'spec.models')
  const modelIds = new Set()
  const models = modelsValue.map((raw, index) => {
    const model = record(raw, `spec.models[${index}]`)
    const id = nonEmptyString(model.id, `spec.models[${index}].id`)
    if (modelIds.has(id)) throw new Error(`spec.models: повторяется ID ${id}`)
    modelIds.add(id)
    const dimensionsValue = model.dimensions
    let dimensions
    if (Array.isArray(dimensionsValue)) {
      if (dimensionsValue.length !== 3) throw new Error(`spec.models[${index}].dimensions: нужен массив [w, d, h]`)
      dimensions = { w: Number(dimensionsValue[0]), d: Number(dimensionsValue[1]), h: Number(dimensionsValue[2]) }
    } else {
      const dimensionsObject = record(dimensionsValue, `spec.models[${index}].dimensions`)
      dimensions = { w: Number(dimensionsObject.w), d: Number(dimensionsObject.d), h: Number(dimensionsObject.h) }
    }
    for (const [name, dimension] of Object.entries(dimensions)) {
      if (!Number.isFinite(dimension) || dimension <= 0) throw new Error(`spec.models[${index}].dimensions.${name}: нужно положительное число`)
    }
    const footprintValue = record(model.footprint, `spec.models[${index}].footprint`)
    const footprint = {
      w: positiveInteger(footprintValue.w, `spec.models[${index}].footprint.w`),
      h: positiveInteger(footprintValue.h, `spec.models[${index}].footprint.h`),
    }
    return { ...model, id, dimensions, footprint }
  })
  if (models.length !== counts.models) throw new Error(`spec.models: нужно ${counts.models} моделей, получено ${models.length}`)
  return { rasters, models, counts }
}

/**
 * @param {string} root
 * @param {string} file
 * @param {string} label
 * @returns {string}
 */
function sourcePath(root, file, label) {
  const full = resolve(root, file)
  const outside = relative(resolve(root), full)
  if (outside.startsWith('..') || isAbsolute(outside)) throw new Error(`${label}: путь вышел из sourceDir`)
  return full
}

/**
 * @param {PngImage} image
 * @param {string} label
 */
function assertSquare(image, label) {
  if (image.width !== image.height) throw new Error(`${label}: PNG должен быть квадратным, получено ${image.width}×${image.height}`)
}

/**
 * @param {PngImage} image
 * @param {string} label
 */
function assertOpaque(image, label) {
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] !== 255) throw new Error(`${label}: фактура содержит прозрачные пиксели`)
  }
}

/**
 * @param {PngImage} image
 * @returns {number}
 */
function visiblePixels(image) {
  let count = 0
  for (let index = 3; index < image.data.length; index += 4) if (image.data[index] > 0) count += 1
  return count
}

/**
 * Проверка того, что компонент не обрезан границей листа. Компонент может
 * слегка пересечь линию виртуальной сетки: `sliceSheet` группирует его по
 * центру, а обрезание по линии как раз потеряло бы край рисунка.
 *
 * @param {Box} box
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {number} index
 * @param {string} file
 */
function assertBoxInCell(box, imageWidth, imageHeight, index, file) {
  if (box.x < 0 || box.y < 0 || box.x + box.w > imageWidth || box.y + box.h > imageHeight) {
    throw new Error(`${file}: предмет ${index + 1} обрезан границей PNG`)
  }
}

/**
 * @param {PngImage} image
 * @param {string} file
 * @returns {Box[]}
 */
function fixedGridBoxes(image, file) {
  /** @type {Box[]} */
  const boxes = []
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const x = Math.floor(col * image.width / 3)
      const y = Math.floor(row * image.height / 3)
      const right = Math.floor((col + 1) * image.width / 3)
      const bottom = Math.floor((row + 1) * image.height / 3)
      const box = { x, y, w: right - x, h: bottom - y }
      if (box.w <= 0 || box.h <= 0) throw new Error(`${file}: сетка 3×3 не помещается в PNG ${image.width}×${image.height}`)
      boxes.push(box)
    }
  }
  return boxes
}

/**
 * @param {Box} box
 * @param {{w: number, h: number}} footprint
 * @param {string} id
 * @param {string} file
 */
function assertAspect(box, footprint, id, file) {
  const expected = footprint.w / footprint.h
  const actual = box.w / box.h
  const ratio = actual / expected
  // Допускаем декоративные выступы и прозрачные поля, но не превращаем
  // квадратный предмет в длинную полосу из-за неверного футпринта.
  if (!Number.isFinite(ratio) || ratio < 0.25 || ratio > 4) {
    throw new Error(`${file}: ${id} имеет подозрительную пропорцию ${box.w}×${box.h} для футпринта ${footprint.w}×${footprint.h}`)
  }
}

/**
 * Проверка результата штатной укладки атласа. Саму раскладку держит
 * `build-prop-atlas.mjs`, здесь проверяем только ограничения отдельного
 * пакета детализации.
 *
 * @param {{width: number, height: number, frames: Array<{id: string, box: Box, image: PngImage}>}} packed
 */
function validatePackedFrames(packed) {
  if (packed.width !== ATLAS_WIDTH) throw new Error(`Атлас: штатная ширина изменилась с ${ATLAS_WIDTH}px`)
  if (packed.width > MAX_ATLAS_SIDE || packed.height > MAX_ATLAS_SIDE) {
    throw new Error(`Атлас: размер ${packed.width}×${packed.height} превышает ${MAX_ATLAS_SIDE}×${MAX_ATLAS_SIDE}px`)
  }
  for (let left = 0; left < packed.frames.length; left += 1) {
    const a = packed.frames[left].box
    if (a.x < 0 || a.y < 0 || a.x + a.w > packed.width || a.y + a.h > packed.height) {
      throw new Error(`Атлас: кадр ${packed.frames[left].id} выходит за границы`)
    }
    for (let right = left + 1; right < packed.frames.length; right += 1) {
      const b = packed.frames[right].box
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        throw new Error(`Атлас: кадры ${packed.frames[left].id} и ${packed.frames[right].id} пересекаются`)
      }
    }
  }
}

/**
 * @param {string} root
 * @param {NormalizedRaster} raster
 * @returns {{image: PngImage, bytes: Buffer, sourceHash: string, promptHash: string, nativeDimensions: {width: number, height: number}}}
 */
function readRaster(root, raster) {
  const file = sourcePath(root, raster.file, raster.file)
  if (!existsSync(file)) throw new Error(`Не найден исходный PNG: ${raster.file}`)
  const raw = readFileSync(file)
  let image
  try {
    image = decodePng(raw)
  } catch (error) {
    throw new Error(`${raster.file}: не удалось прочитать PNG: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    image,
    bytes: raw,
    sourceHash: hash(raw),
    promptHash: hash(raster.prompt),
    nativeDimensions: { width: image.width, height: image.height },
  }
}

/**
 * @param {{spec: unknown, sourceDir?: string, outputDir?: string}} options
 * @returns {{files: BuildFile[], manifest: Record<string, unknown>, atlasManifest: Record<string, unknown>, outputDir: string|null}}
 */
export function buildMapDetailRasters(options) {
  if (!options || typeof options !== 'object') throw new Error('buildMapDetailRasters: нужны options')
  const normalized = normalizeSpec(options.spec)
  const sourceDir = resolve(options.sourceDir ?? join(ROOT, 'assets-src/map-detail'))
  const outputDir = options.outputDir === undefined ? null : resolve(options.outputDir)
  /** @type {BuildFile[]} */
  const files = []
  /** @type {Record<string, Record<string, unknown>>} */
  const textures = {}
  /** @type {Record<string, Record<string, unknown>>} */
  const sheets = {}
  /** @type {Sprite[]} */
  const sprites = []

  for (const raster of normalized.rasters) {
    const read = readRaster(sourceDir, raster)
    const source = {
      key: raster.key,
      file: raster.file,
      type: raster.type,
      sourceHash: read.sourceHash,
      promptHash: read.promptHash,
      nativeDimensions: read.nativeDimensions,
    }
    if (raster.type !== 'sheet') {
      assertSquare(read.image, raster.file)
      assertOpaque(read.image, raster.file)
      const tile = resampleImage(makeSeamless(read.image), TILE_SIDE, TILE_SIDE)
      const path = `textures/${raster.file}`
      files.push({ path, bytes: encodeIndexedPng(tile), kind: 'texture' })
      textures[raster.key] = { ...source, path, tileSide: TILE_SIDE, cellsPerTile: CELLS_PER_TILE }
      continue
    }

    assertSquare(read.image, raster.file)
    const keyed = keyOutBackground(read.image)
    const fixed = raster.file.startsWith('sheet-24-')
    const boxes = fixed ? fixedGridBoxes(keyed, raster.file) : sliceSheet(keyed, { cols: 3, rows: 3 }, { minArea: 4 })
    if (boxes.length !== 9) throw new Error(`${raster.file}: найдено ${boxes.length} предметов, ожидалось 9`)
    sheets[raster.file] = source
    for (let index = 0; index < boxes.length; index += 1) {
      const id = raster.ids[index]
      const footprint = raster.footprints[index]
      const box = boxes[index]
      if (!fixed) {
        assertBoxInCell(box, keyed.width, keyed.height, index, raster.file)
        assertAspect(box, footprint, id, raster.file)
      }
      const cropped = cropImage(keyed, box)
      if (!visiblePixels(cropped)) throw new Error(`${raster.file}: ${id} пустой или полностью прозрачен`)
      const target = CELL_PIXELS * Math.max(footprint.w, footprint.h)
      const scale = target / Math.max(cropped.width, cropped.height)
      const width = Math.max(1, Math.round(cropped.width * scale))
      const height = Math.max(1, Math.round(cropped.height * scale))
      sprites.push({
        id,
        image: resampleImage(cropped, width, height),
        footprint,
        sheet: raster.file,
        sourceIndex: index,
        sourceHash: read.sourceHash,
        promptHash: read.promptHash,
      })
    }
  }

  if (sprites.length !== normalized.counts.stamps) throw new Error(`Атлас: собрано ${sprites.length} кадров, ожидалось ${normalized.counts.stamps}`)
  const packed = packSprites(sprites.map(({ id, image }) => ({ id, image })))
  validatePackedFrames(packed)
  const atlasPath = 'prop-atlas.png'
  const atlasManifestPath = 'prop-atlas.json'
  /** @type {Record<string, Record<string, unknown>>} */
  const atlasFrames = {}
  const spriteById = new Map(sprites.map((sprite) => [sprite.id, sprite]))
  for (const frame of packed.frames) {
    const sprite = spriteById.get(frame.id)
    if (!sprite) throw new Error(`Атлас: нет метаданных для кадра ${frame.id}`)
    atlasFrames[frame.id] = {
      ...frame.box,
      footprint: sprite.footprint,
      sheet: sprite.sheet,
      sourceIndex: sprite.sourceIndex,
      sourceHash: sprite.sourceHash,
      promptHash: sprite.promptHash,
    }
  }
  const atlasManifest = {
    version: MAP_DETAIL_VERSION,
    image: atlasPath,
    width: packed.width,
    height: packed.height,
    cellPixels: CELL_PIXELS,
    frameCount: Object.keys(atlasFrames).length,
    frames: atlasFrames,
    sources: sheets,
  }
  files.push({ path: atlasPath, bytes: encodePng(paintAtlas(packed)), kind: 'atlas' })
  files.push({ path: atlasManifestPath, bytes: Buffer.from(`${JSON.stringify(atlasManifest, null, 2)}\n`), kind: 'metadata' })

  const models = normalized.models.map((model) => ({
    ...model,
    promptHash: typeof model.prompt === 'string' ? hash(model.prompt) : typeof model.description === 'string' ? hash(model.description) : null,
  }))
  const manifest = {
    version: MAP_DETAIL_VERSION,
    package: MAP_DETAIL_PACKAGE,
    tileSide: TILE_SIDE,
    cellsPerTile: CELLS_PER_TILE,
    textures,
    atlas: { image: atlasPath, metadata: atlasManifestPath, width: packed.width, height: packed.height, frameCount: normalized.counts.stamps },
    counts: normalized.counts,
    sheets,
    models,
  }
  const manifestPath = 'manifest.json'
  files.push({ path: manifestPath, bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), kind: 'metadata' })

  if (outputDir) {
    for (const file of files) {
      const target = resolve(outputDir, file.path)
      const escape = relative(outputDir, target)
      if (escape.startsWith('..') || isAbsolute(escape)) throw new Error(`Путь результата вышел из outputDir: ${file.path}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.bytes)
    }
  }
  return { files, manifest, atlasManifest, outputDir }
}

/**
 * @param {string[]} argv
 * @param {string} name
 * @returns {string|null}
 */
function option(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
}

if (process.argv[1] && process.argv[1].endsWith('build-map-detail-rasters.mjs')) {
  const argv = process.argv.slice(2)
  const specFile = option(argv, '--spec') ?? join(ROOT, 'tmp/map-detail/spec.json')
  const sourceDir = option(argv, '--source-dir') ?? join(ROOT, 'assets-src/map-detail')
  const outputDir = option(argv, '--output-dir') ?? join(ROOT, 'public/assets/maps/detail-v1')
  try {
    const spec = JSON.parse(readFileSync(specFile, 'utf8'))
    const result = buildMapDetailRasters({ spec, sourceDir, outputDir })
    process.stdout.write(`${JSON.stringify({
      ok: true,
      outputDir,
      files: result.files.map((file) => ({ path: file.path, bytes: file.bytes.length })),
      textures: Object.keys(result.manifest.textures).length,
      frames: result.atlasManifest.frameCount,
      models: Array.isArray(result.manifest.models) ? result.manifest.models.length : 0,
    }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
