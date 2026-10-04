// @ts-check
/**
 * Детерминированная упаковка материалов для статических GLB карт.
 *
 * Исходники остаются отдельными файлами: этот модуль только читает четыре
 * PNG, сшивает их края, приводит яркость к нейтральной и возвращает три
 * встраиваемых PNG. Запись на диск и CLI здесь намеренно отсутствуют.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { decodePng, encodeIndexedPng } from './png-codec.mjs'
import { cropImage, resampleImage } from './build-prop-atlas.mjs'
import { makeSeamless } from './build-terrain-tiles.mjs'

/** @typedef {import('./png-codec.mjs').PngImage} PngImage */

const ATLAS_SIDE = 512
const TILE_SIDE = 256
const GUTTER = 4
const INNER_SIDE = TILE_SIDE - GUTTER * 2
const SOURCE_NAMES = /** @type {const} */ (['wood', 'stone', 'metal', 'cloth'])

/** @typedef {'wood'|'stone'|'metal'|'cloth'} MaterialSlot */

/**
 * Ячейки заданы в координатах PNG. В glTF координата (0,0) соответствует
 * верхнему левому пикселю изображения, поэтому rects используют ту же
 * ориентацию и перевод не нужен.
 */
/** @type {Readonly<Record<MaterialSlot, readonly [number, number]>>} */
const SLOT_ORIGINS = Object.freeze({
  wood: [0, 0],
  stone: [TILE_SIDE, 0],
  metal: [0, TILE_SIDE],
  cloth: [TILE_SIDE, TILE_SIDE],
})

const ROUGHNESS = Object.freeze({ wood: 210, stone: 235, metal: 105, cloth: 225 })
const BUMP_STRENGTH = Object.freeze({ wood: 0.55, stone: 0.95, metal: 0.28, cloth: 0.7 })

/**
 * Резерв под нейтральный материал в нижнем левом углу PNG. Эта область лежит
 * в гуттере нижнего левого слота и не пересекает полезную часть metal.
 * Центр возвращается в той же верхнелевой ориентации, что и glTF UV.
 */
const FLAT_PIXEL = Object.freeze({ x: 0, y: ATLAS_SIDE - 4 })
const FLAT_UV = Object.freeze([
  (FLAT_PIXEL.x + 0.5) / ATLAS_SIDE,
  (FLAT_PIXEL.y + 0.5) / ATLAS_SIDE,
])

/** Повторяемый источник: один путь — одна запись кэша за серию сборки. */
/** @type {Map<string, {signature: string, atlas: ModelMaterialAtlas}>} */
const CACHE = new Map()
/** Полный atlas может участвовать в нескольких компактных комбинациях. */
/** @type {WeakMap<object, string>} */
const FULL_ATLAS_SIGNATURES = new WeakMap()
/** @type {WeakMap<object, {signature:string, images:{base:PngImage,normal:PngImage,orm:PngImage}}>} */
const FULL_ATLAS_IMAGES = new WeakMap()
/** @type {Map<string, ModelMaterialAtlas>} */
const COMPACT_CACHE = new Map()

/**
 * @typedef {{u0:number,v0:number,u1:number,v1:number}} AtlasRect
 * @typedef {{file:string,sha256:string,bytes:number,nativeDimensions:{width:number,height:number}}} MaterialSource
 * @typedef {{baseColor:Buffer,normal:Buffer,orm:Buffer,sources:MaterialSource[],rects:Record<string,AtlasRect>,flatUv:readonly [number,number],textureSize:readonly [number,number],materialKinds?:MaterialSlot[]}} ModelMaterialAtlas
 */

/** @param {number} value @param {number} minimum @param {number} maximum */
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

/** @param {PngImage} image */
function assertImage(image) {
  if (image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) {
    throw new Error('Материал должен быть непустым RGBA PNG')
  }
}

/**
 * Для очень маленького тестового изображения `makeSeamless` не может убрать
 * полосу, равную всей ширине. Рабочие генеративные листы намного больше, но
 * такой вход всё равно лучше обработать как обычную одноцветную фактуру.
 * @param {PngImage} image
 */
function seamless(image) {
  return image.width > 1 && image.height > 1 ? makeSeamless(image) : image
}

/** @param {PngImage} image @returns {Float32Array} */
function luminance(image) {
  const result = new Float32Array(image.width * image.height)
  for (let index = 0; index < result.length; index += 1) {
    const at = index * 4
    const alpha = image.data[at + 3] / 255
    const rgb = image.data[at] * 0.299 + image.data[at + 1] * 0.587 + image.data[at + 2] * 0.114
    // Прозрачные пиксели у фактуры не должны превращаться в чёрные ямы.
    result[index] = rgb * alpha + 235 * (1 - alpha)
  }
  return result
}

/** @param {PngImage} image @param {Float32Array} height @param {'wood'|'stone'|'metal'|'cloth'} slot */
function materialMaps(image, height, slot) {
  const pixels = image.width * image.height
  let mean = 0
  for (const value of height) mean += value
  mean /= pixels

  const base = { width: image.width, height: image.height, data: new Uint8Array(pixels * 4) }
  const normal = { width: image.width, height: image.height, data: new Uint8Array(pixels * 4) }
  const orm = { width: image.width, height: image.height, data: new Uint8Array(pixels * 4) }
  const strength = BUMP_STRENGTH[slot]
  const roughness = ROUGHNESS[slot]

  /** @param {number} x @param {number} y */
  const sampleHeight = (x, y) => {
    const wrappedX = (x + image.width) % image.width
    const wrappedY = (y + image.height) % image.height
    let value = height[wrappedY * image.width + wrappedX]
    if (slot === 'cloth') {
      // Мелкая переплётка без случайного шума; период делится на 248 пикселей.
      value += Math.sin(wrappedX * Math.PI / 2) * 1.4 + Math.sin(wrappedY * Math.PI / 2) * 1.4
    }
    return value
  }

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = y * image.width + x
      const from = index * 4
      const value = height[index]
      const normalized = 235 + (value - mean) * 0.85
      const red = clamp(normalized + (image.data[from] - value) * 0.08, 160, 255)
      const green = clamp(normalized + (image.data[from + 1] - value) * 0.08, 160, 255)
      const blue = clamp(normalized + (image.data[from + 2] - value) * 0.08, 160, 255)
      base.data[from] = Math.round(red)
      base.data[from + 1] = Math.round(green)
      base.data[from + 2] = Math.round(blue)
      base.data[from + 3] = 255

      const dx = (sampleHeight(x + 1, y) - sampleHeight(x - 1, y)) / 255
      const dy = (sampleHeight(x, y + 1) - sampleHeight(x, y - 1)) / 255
      // В верхнелевой UV-системе +V идёт вниз по PNG, поэтому знак G
      // соответствует тому же касательному базису, что и координата фактуры.
      let nx = -dx * strength
      let ny = -dy * strength
      let nz = 1
      const length = Math.hypot(nx, ny, nz)
      nx /= length
      ny /= length
      nz /= length
      normal.data[from] = clamp(Math.round(128 + nx * 127), 0, 255)
      normal.data[from + 1] = clamp(Math.round(128 + ny * 127), 0, 255)
      normal.data[from + 2] = clamp(Math.round(128 + nz * 127), 0, 255)
      normal.data[from + 3] = 255

      const roughDelta = clamp(Math.round((value - mean) * 0.12), -8, 8)
      orm.data[from] = 255
      orm.data[from + 1] = clamp(roughness + roughDelta, 0, 255)
      orm.data[from + 2] = slot === 'metal' ? clamp(180 + Math.round(roughDelta * 0.25), 0, 255) : 0
      orm.data[from + 3] = 255
    }
  }
  return { base, normal, orm }
}

/**
 * Переносит квадратный материал в слот и дублирует края на четыре пикселя.
 * Копирование выполняется по координате, поэтому и углы гуттера корректны.
 * @param {PngImage} atlas
 * @param {PngImage} tile
 * @param {readonly [number,number]} origin
 */
function paintTile(atlas, tile, origin) {
  for (let y = 0; y < TILE_SIDE; y += 1) {
    const sourceY = clamp(y, GUTTER, GUTTER + INNER_SIDE - 1) - GUTTER
    for (let x = 0; x < TILE_SIDE; x += 1) {
      const sourceX = clamp(x, GUTTER, GUTTER + INNER_SIDE - 1) - GUTTER
      const source = (sourceY * INNER_SIDE + sourceX) * 4
      const target = ((origin[1] + y) * atlas.width + origin[0] + x) * 4
      atlas.data[target] = tile.data[source]
      atlas.data[target + 1] = tile.data[source + 1]
      atlas.data[target + 2] = tile.data[source + 2]
      atlas.data[target + 3] = 255
    }
  }
}

/** @param {PngImage} image @param {number[]} rgba @param {number} x @param {number} y */
function paintPixel(image, rgba, x, y) {
  const at = (y * image.width + x) * 4
  image.data[at] = rgba[0]
  image.data[at + 1] = rgba[1]
  image.data[at + 2] = rgba[2]
  image.data[at + 3] = 255
}

/** @param {PngImage} image @param {number[]} rgba @param {number} [x] @param {number} [y] */
function paintFlatArea(image, rgba, x = FLAT_PIXEL.x, y = FLAT_PIXEL.y) {
  for (let row = y; row < y + 4; row += 1) {
    for (let column = x; column < x + 4; column += 1) paintPixel(image, rgba, column, row)
  }
}

/** @param {string} file @returns {{signature:string, bytes:Buffer, image:PngImage, source:MaterialSource}} */
function readSource(file) {
  const bytes = readFileSync(file)
  const image = decodePng(bytes)
  assertImage(image)
  return {
    signature: `${bytes.length}:${statSync(file).mtimeMs}:${statSync(file).ctimeMs}`,
    bytes,
    image,
    source: {
      file: file.split('\\').at(-1) ?? file.split('/').at(-1) ?? file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      nativeDimensions: { width: image.width, height: image.height },
    },
  }
}

/** @param {string} directory @returns {string} */
function sourceSignature(directory) {
  return SOURCE_NAMES.map((name) => {
    const file = join(directory, `${name}.png`)
    const info = statSync(file)
    if (!info.isFile()) throw new Error(`Источник материала не является файлом: ${file}`)
    return `${name}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  }).join('|')
}

/** @param {number} x @param {number} y @param {number} [width] @param {number} [height] @returns {AtlasRect} */
function rectFor(x, y, width = ATLAS_SIDE, height = ATLAS_SIDE) {
  // glTF и PNG здесь используют одну верхнелевую ориентацию UV.
  return {
    u0: (x + GUTTER) / width,
    v0: (y + GUTTER) / height,
    u1: (x + TILE_SIDE - GUTTER) / width,
    v1: (y + TILE_SIDE - GUTTER) / height,
  }
}

/**
 * Загружает материалы и собирает общий атлас для GLB.
 *
 * UV исходной геометрии [0,1] переводятся напрямую в `rects[name]`:
 * `u=u0+sourceU*(u1-u0)`, `v=v0+sourceV*(v1-v0)`. glTF и PNG используют
 * верхний левый угол как начало координат, так что изображение не отражается.
 *
 * @param {string} sourceDir
 * @returns {ModelMaterialAtlas}
 */
export function loadModelMaterialAtlas(sourceDir) {
  if (typeof sourceDir !== 'string' || !sourceDir.trim()) throw new Error('Нужен каталог фактур материалов')
  const directory = resolve(sourceDir)
  const signature = sourceSignature(directory)
  const cached = CACHE.get(directory)
  if (cached?.signature === signature) return cached.atlas

  /** @type {Record<'wood'|'stone'|'metal'|'cloth', MaterialSource>} */
  const sourceRecords = /** @type {Record<'wood'|'stone'|'metal'|'cloth', MaterialSource>} */ ({})
  /** @type {Record<'wood'|'stone'|'metal'|'cloth', {base:PngImage,normal:PngImage,orm:PngImage}>} */
  const maps = /** @type {Record<'wood'|'stone'|'metal'|'cloth', {base:PngImage,normal:PngImage,orm:PngImage}>} */ ({})
  const baseAtlas = { width: ATLAS_SIDE, height: ATLAS_SIDE, data: new Uint8Array(ATLAS_SIDE * ATLAS_SIDE * 4) }
  const normalAtlas = { width: ATLAS_SIDE, height: ATLAS_SIDE, data: new Uint8Array(ATLAS_SIDE * ATLAS_SIDE * 4) }
  const ormAtlas = { width: ATLAS_SIDE, height: ATLAS_SIDE, data: new Uint8Array(ATLAS_SIDE * ATLAS_SIDE * 4) }

  for (const slot of SOURCE_NAMES) {
    const loaded = readSource(join(directory, `${slot}.png`))
    const prepared = resampleImage(seamless(loaded.image), INNER_SIDE, INNER_SIDE)
    const preparedHeight = luminance(prepared)
    sourceRecords[slot] = loaded.source
    maps[slot] = materialMaps(prepared, preparedHeight, slot)
    const origin = SLOT_ORIGINS[slot]
    paintTile(baseAtlas, maps[slot].base, origin)
    paintTile(normalAtlas, maps[slot].normal, origin)
    paintTile(ormAtlas, maps[slot].orm, origin)
  }

  paintFlatArea(baseAtlas, [255, 255, 255])
  paintFlatArea(normalAtlas, [128, 128, 255])
  paintFlatArea(ormAtlas, [255, 180, 0])

  const atlas = {
    baseColor: encodeIndexedPng(baseAtlas),
    normal: encodeIndexedPng(normalAtlas),
    orm: encodeIndexedPng(ormAtlas),
    sources: SOURCE_NAMES.map((slot) => sourceRecords[slot]),
    rects: {
      wood: rectFor(...SLOT_ORIGINS.wood),
      stone: rectFor(...SLOT_ORIGINS.stone),
      metal: rectFor(...SLOT_ORIGINS.metal),
      cloth: rectFor(...SLOT_ORIGINS.cloth),
    },
    flatUv: /** @type {readonly [number,number]} */ ([FLAT_UV[0], FLAT_UV[1]]),
    textureSize: /** @type {readonly [number,number]} */ ([ATLAS_SIDE, ATLAS_SIDE]),
  }
  CACHE.set(directory, { signature, atlas })
  return atlas
}

/** @param {ModelMaterialAtlas} atlas @returns {string} */
function fullAtlasSignature(atlas) {
  const known = FULL_ATLAS_SIGNATURES.get(atlas)
  if (known) return known
  if (!Buffer.isBuffer(atlas.baseColor) || !Buffer.isBuffer(atlas.normal) || !Buffer.isBuffer(atlas.orm)) {
    throw new Error('Полный атлас должен содержать три PNG Buffer')
  }
  const hash = createHash('sha256')
  hash.update(atlas.baseColor)
  hash.update(atlas.normal)
  hash.update(atlas.orm)
  hash.update(JSON.stringify({ textureSize: atlas.textureSize, rects: atlas.rects, sources: atlas.sources }))
  const signature = hash.digest('hex')
  FULL_ATLAS_SIGNATURES.set(atlas, signature)
  return signature
}

/** @param {ModelMaterialAtlas} atlas @param {string} signature */
function decodedFullAtlas(atlas, signature) {
  const known = FULL_ATLAS_IMAGES.get(atlas)
  if (known?.signature === signature) return known.images
  const images = {
    base: decodePng(atlas.baseColor),
    normal: decodePng(atlas.normal),
    orm: decodePng(atlas.orm),
  }
  for (const image of Object.values(images)) {
    if (image.width !== ATLAS_SIDE || image.height !== ATLAS_SIDE) {
      throw new Error(`Полный атлас должен быть ${ATLAS_SIDE}×${ATLAS_SIDE}px`)
    }
  }
  FULL_ATLAS_IMAGES.set(atlas, { signature, images })
  return images
}

/** @param {readonly MaterialSlot[]} kinds @returns {MaterialSlot[]} */
function normalizeMaterialKinds(kinds) {
  if (!Array.isArray(kinds)) throw new Error('Список материалов должен быть массивом')
  const wanted = new Set()
  for (const kind of kinds) {
    if (kind === 'flat') continue
    if (!SOURCE_NAMES.includes(kind)) throw new Error(`Неизвестный материал модели: ${kind}`)
    wanted.add(kind)
  }
  // Порядок фиксирован, чтобы один набор не дал разные UV между моделями.
  return SOURCE_NAMES.filter(kind => wanted.has(kind))
}

/** @param {number} width @param {number} height @param {number[]} rgba @returns {PngImage} */
function blankImage(width, height, rgba) {
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) data.set(rgba, index * 4)
  return { width, height, data }
}

/** @param {PngImage} target @param {PngImage} source @param {number} x @param {number} y */
function copyImageAt(target, source, x, y) {
  for (let row = 0; row < source.height; row += 1) {
    const from = row * source.width * 4
    const to = ((y + row) * target.width + x) * 4
    target.data.set(source.data.subarray(from, from + source.width * 4), to)
  }
}

/** @param {number} width @param {number} height @returns {readonly [number,number]} */
function compactFlatUv(width, height) {
  const x = Math.max(0, width - GUTTER)
  const y = Math.max(0, height - GUTTER)
  return /** @type {readonly [number,number]} */ ([(x + 0.5) / width, (y + 0.5) / height])
}

/**
 * Вырезает из общего атласа только материалы одной модели.
 *
 * Слоты сохраняют 256×256 и исходный 4 px гуттер, но сами rects нормируются
 * к новому размеру. Для пустого набора создаётся маленький полностью
 * нейтральный атлас: это дешевле, чем тащить карты материалов в flat-only GLB.
 *
 * @param {ModelMaterialAtlas} atlas
 * @param {readonly MaterialSlot[]} kinds
 * @returns {ModelMaterialAtlas}
 */
export function compactModelMaterialAtlas(atlas, kinds) {
  if (!atlas || typeof atlas !== 'object') throw new Error('Нужен полный атлас материалов')
  const signature = fullAtlasSignature(atlas)
  const selected = normalizeMaterialKinds(kinds)
  const cacheKey = `${signature}|${selected.join(',')}`
  const cached = COMPACT_CACHE.get(cacheKey)
  if (cached) return cached

  const columns = selected.length === 1 ? 1 : 2
  const rows = selected.length === 0 ? 1 : Math.ceil(selected.length / columns)
  const width = selected.length === 0 ? 16 : columns * TILE_SIDE
  const height = selected.length === 0 ? 16 : rows * TILE_SIDE
  const base = blankImage(width, height, [255, 255, 255, 255])
  const normal = blankImage(width, height, [128, 128, 255, 255])
  const orm = blankImage(width, height, [255, 180, 0, 255])
  /** @type {Record<string, AtlasRect>} */
  const rects = {}

  if (selected.length) {
    const images = decodedFullAtlas(atlas, signature)
    selected.forEach((kind, index) => {
      const compactOrigin = /** @type {readonly [number,number]} */ ([
        (index % columns) * TILE_SIDE,
        Math.floor(index / columns) * TILE_SIDE,
      ])
      const fullOrigin = SLOT_ORIGINS[kind]
      // В исходном metal-гуттере есть neutral patch; не переносим его в слот.
      const box = { x: fullOrigin[0] + GUTTER, y: fullOrigin[1] + GUTTER, w: INNER_SIDE, h: INNER_SIDE }
      paintTile(base, cropImage(images.base, box), compactOrigin)
      paintTile(normal, cropImage(images.normal, box), compactOrigin)
      paintTile(orm, cropImage(images.orm, box), compactOrigin)
      rects[kind] = rectFor(compactOrigin[0], compactOrigin[1], width, height)
    })
  }

  const flatX = width - GUTTER
  const flatY = height - GUTTER
  paintFlatArea(base, [255, 255, 255], flatX, flatY)
  paintFlatArea(normal, [128, 128, 255], flatX, flatY)
  paintFlatArea(orm, [255, 180, 0], flatX, flatY)
  const compact = {
    baseColor: encodeIndexedPng(base),
    normal: encodeIndexedPng(normal),
    orm: encodeIndexedPng(orm),
    sources: atlas.sources,
    rects,
    flatUv: compactFlatUv(width, height),
    textureSize: /** @type {readonly [number,number]} */ ([width, height]),
    materialKinds: selected,
  }
  COMPACT_CACHE.set(cacheKey, compact)
  return compact
}
