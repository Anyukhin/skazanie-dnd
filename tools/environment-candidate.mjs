#!/usr/bin/env node
// @ts-check
/** Офлайн-проверка собранного кандидата с моделями окружения. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { listAssets } from '../server/asset-registry.mjs'
import { inspectModelFile } from './import-environment-models.mjs'
import { decodePng } from './png-codec.mjs'

export const ENVIRONMENT_URL_ROOT = '/assets/models/environment/'
export const ENVIRONMENT_MANIFEST_FILE = 'manifest.json'
export const ENVIRONMENT_RECEIPT_FILE = 'receipt.json'
export const MAX_MODEL_BYTES = 8_000_000
export const MAX_LIBRARY_BYTES = 64 * 1024 * 1024
export const MAX_MODEL_COUNT = 512

const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_RECEIPT_BYTES = 512 * 1024
const MAX_METADATA_BYTES = 1_000_000
const MAX_CANDIDATE_FILES = MAX_MODEL_COUNT * 4 + 32
const MAX_WALK_DEPTH = 64
const MAX_PNG_PIXELS = 16_777_216
const SHA256 = /^[0-9a-f]{64}$/u
const KEY = /^[a-z0-9][a-z0-9_-]{0,95}$/u
const URL_SEGMENT = /^[A-Za-z0-9_-]+$/u
const GLB_FILE = /^[A-Za-z0-9_-]+\.glb$/u
const PNG_FILE = /^[A-Za-z0-9_-]+\.png$/u
const GLB_MAGIC = 0x46546c67
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })

/** @typedef {{path: string, sha256: string, bytes: number}} CandidateFile */
/** @typedef {{path: string, absolute: string, bytes: number}} CandidateEntry */
/** @typedef {Record<string, unknown>} JsonObject */

export class EnvironmentCandidateError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'EnvironmentCandidateError'
    this.code = code
  }
}

/** @param {string} code @param {string} message */
function fail(code, message) { throw new EnvironmentCandidateError(code, message) }

/** @param {unknown} value @returns {value is JsonObject} */
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
/** @param {unknown} value @returns {value is number} */
function finite(value) { return typeof value === 'number' && Number.isFinite(value) }
/** @param {unknown} value @returns {value is number} */
function integer(value) { return typeof value === 'number' && Number.isSafeInteger(value) }
/** @param {unknown} value @returns {value is number} */
function nonnegativeInteger(value) { return integer(value) && value >= 0 }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === 'string' && value.trim().length > 0 }
/** @param {Buffer} bytes @returns {string} */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }

/** @param {string} root @param {string} target @returns {string} */
function relativePath(root, target) {
  const value = relative(root, target).split(sep).join('/')
  const parts = value.split('/')
  if (!value || value.startsWith('/') || value.includes('\0') || parts.some((part) => !part || part === '.' || part === '..')) {
    fail('CANDIDATE_PATH_INVALID', `небезопасный путь: ${value}`)
  }
  return value
}

/** @param {string} root @param {string} current @param {CandidateEntry[]} output @param {number} [depth] */
async function collectFiles(root, current, output, depth = 0) {
  if (depth > MAX_WALK_DEPTH) fail('CANDIDATE_DEPTH_LIMIT', 'каталог слишком глубоко вложен')
  let entries
  try { entries = await readdir(current, { withFileTypes: true }) } catch (error) {
    fail('CANDIDATE_READ_FAILED', `не удалось прочитать каталог: ${error instanceof Error ? error.message : String(error)}`)
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const target = join(current, entry.name)
    if (entry.isSymbolicLink()) fail('CANDIDATE_SYMLINK', `символьная ссылка запрещена: ${relativePath(root, target)}`)
    const metadata = await lstat(target).catch((error) => {
      fail('CANDIDATE_STAT_FAILED', `не удалось проверить ${target}: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (metadata.isSymbolicLink()) fail('CANDIDATE_SYMLINK', `символьная ссылка запрещена: ${relativePath(root, target)}`)
    if (metadata.isDirectory()) { await collectFiles(root, target, output, depth + 1); continue }
    if (!metadata.isFile()) fail('CANDIDATE_FILE_TYPE', `нужен обычный файл: ${relativePath(root, target)}`)
    if (output.length >= MAX_CANDIDATE_FILES) fail('CANDIDATE_FILE_COUNT_LIMIT', `слишком много файлов: максимум ${MAX_CANDIDATE_FILES}`)
    output.push({ path: relativePath(root, target), absolute: target, bytes: metadata.size })
  }
}

/** @param {unknown} value @param {'.glb'|'.png'} extension @returns {string} */
function localUrlPath(value, extension) {
  if (typeof value !== 'string' || !value.startsWith(ENVIRONMENT_URL_ROOT)) fail('CANDIDATE_URL_ROOT', `путь должен лежать под ${ENVIRONMENT_URL_ROOT}`)
  const path = value.slice(ENVIRONMENT_URL_ROOT.length)
  const parts = path.split('/')
  if (!path || parts.slice(0, -1).some((part) => !part || part === '.' || part === '..' || !URL_SEGMENT.test(part))) fail('CANDIDATE_URL_TRAVERSAL', `небезопасный путь: ${value}`)
  const file = parts.at(-1) ?? ''
  if (!(extension === '.glb' ? GLB_FILE : PNG_FILE).test(file)) fail('CANDIDATE_URL_EXTENSION', `ожидался локальный ${extension}: ${value}`)
  return parts.join('/')
}

/** @param {Buffer} bytes @param {string} path @returns {JsonObject} */
function parseJson(bytes, path) {
  try {
    const value = JSON.parse(TEXT_DECODER.decode(bytes))
    if (!isObject(value)) fail('CANDIDATE_JSON_OBJECT', `${path} должен содержать объект`)
    return value
  } catch (error) {
    if (error instanceof EnvironmentCandidateError) throw error
    fail('CANDIDATE_JSON_INVALID', `некорректный JSON ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** @param {unknown} value @param {string} path @returns {JsonObject} */
function objectAt(value, path) { if (!isObject(value)) fail('GLB_JSON_SHAPE', `${path}: ожидался объект`); return value }
/** @param {unknown} value @param {string} path @returns {unknown[]} */
function arrayAt(value, path) { if (!Array.isArray(value)) fail('GLB_JSON_SHAPE', `${path}: ожидался массив`); return value }
/** @param {unknown} value @param {number} length @param {string} path */
function indexAt(value, length, path) { if (!nonnegativeInteger(value) || value >= length) fail('GLB_REFERENCE_RANGE', `${path}: индекс вне диапазона`); return value }

/**
 * Импортер проверяет контейнер GLB и встроенные PNG. Этот проход дополнительно
 * проверяет ссылки, смысл которых виден только после чтения JSON: bufferView,
 * accessor, изображения и индексы примитивов mesh.
 *
 * @param {JsonObject} json
 * @param {string} path
 */
function validateGlbReferences(json, path) {
  const buffers = arrayAt(json.buffers, `${path}.buffers`)
  if (buffers.length !== 1) fail('GLB_BUFFER_COUNT', `${path}: нужен один buffer`)
  const buffer = objectAt(buffers[0], `${path}.buffers[0]`)
  if (buffer.uri !== undefined && buffer.uri !== null) fail('GLB_EXTERNAL_URI', `${path}: внешний buffer uri запрещён`)
  if (!nonnegativeInteger(buffer.byteLength)) fail('GLB_BUFFER_LENGTH', `${path}: byteLength buffer задан неверно`)
  const rawViews = json.bufferViews === undefined ? [] : arrayAt(json.bufferViews, `${path}.bufferViews`)
  /** @type {Array<JsonObject>} */
  const views = []
  rawViews.forEach((raw, index) => {
    const view = objectAt(raw, `${path}.bufferViews[${index}]`)
    const byteOffset = view.byteOffset === undefined ? 0 : view.byteOffset
    if (view.buffer !== undefined && view.buffer !== 0) fail('GLB_BUFFER_VIEW_BUFFER', `${path}.bufferViews[${index}].buffer задан неверно`)
    if (!nonnegativeInteger(byteOffset) || !nonnegativeInteger(view.byteLength) || byteOffset + view.byteLength > buffer.byteLength) fail('GLB_BUFFER_VIEW_RANGE', `${path}.bufferViews[${index}] выходит за BIN`)
    if (view.byteStride !== undefined && (!integer(view.byteStride) || view.byteStride < 4 || view.byteStride > 252 || view.byteStride % 4 !== 0)) fail('GLB_BUFFER_STRIDE', `${path}.bufferViews[${index}].byteStride задан неверно`)
    views.push({ ...view, byteOffset, buffer: 0 })
  })
  const rawAccessors = json.accessors === undefined ? [] : arrayAt(json.accessors, `${path}.accessors`)
  const componentSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
  const componentCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
  rawAccessors.forEach((raw, accessorIndex) => {
    const accessor = objectAt(raw, `${path}.accessors[${accessorIndex}]`)
    if (!nonnegativeInteger(accessor.count) || !Object.prototype.hasOwnProperty.call(componentSize, String(accessor.componentType)) || typeof accessor.type !== 'string' || !Object.prototype.hasOwnProperty.call(componentCount, accessor.type)) fail('GLB_ACCESSOR_TYPE', `${path}.accessors[${accessorIndex}] задан неверно`)
    const elementSize = componentSize[/** @type {keyof typeof componentSize} */ (String(accessor.componentType))] * componentCount[/** @type {keyof typeof componentCount} */ (accessor.type)]
    const byteOffset = accessor.byteOffset === undefined ? 0 : accessor.byteOffset
    if (!nonnegativeInteger(byteOffset)) fail('GLB_ACCESSOR_OFFSET', `${path}.accessors[${accessorIndex}].byteOffset задан неверно`)
    if (accessor.bufferView !== undefined) {
      const view = views[indexAt(accessor.bufferView, views.length, `${path}.accessors[${accessorIndex}].bufferView`)]
      const stride = view.byteStride ?? elementSize
      if (!integer(stride) || stride < elementSize) fail('GLB_BUFFER_STRIDE', `${path}.accessors[${accessorIndex}] : byteStride меньше элемента`)
      const end = accessor.count === 0 ? byteOffset : byteOffset + (accessor.count - 1) * stride + elementSize
      if (!Number.isSafeInteger(end) || byteOffset > view.byteLength || end > view.byteLength) fail('GLB_ACCESSOR_RANGE', `${path}.accessors[${accessorIndex}] выходит за bufferView`)
    } else if (accessor.count > 0 && accessor.sparse === undefined) fail('GLB_ACCESSOR_RANGE', `${path}.accessors[${accessorIndex}] не имеет bufferView`)
    if (accessor.sparse !== undefined) {
      const sparse = objectAt(accessor.sparse, `${path}.accessors[${accessorIndex}].sparse`)
      if (!nonnegativeInteger(sparse.count) || sparse.count > accessor.count) fail('GLB_SPARSE_COUNT', `${path}.accessors[${accessorIndex}].sparse.count задан неверно`)
      const indices = objectAt(sparse.indices, `${path}.accessors[${accessorIndex}].sparse.indices`)
      const values = objectAt(sparse.values, `${path}.accessors[${accessorIndex}].sparse.values`)
      const indexSize = { 5121: 1, 5123: 2, 5125: 4 }[String(indices.componentType)]
      if (!indexSize) fail('GLB_SPARSE_TYPE', `${path}.accessors[${accessorIndex}].sparse.indices задан неверно`)
      const indexView = views[indexAt(indices.bufferView, views.length, `${path}.sparse.indices.bufferView`)]
      const valueView = views[indexAt(values.bufferView, views.length, `${path}.sparse.values.bufferView`)]
      const indexOffset = indices.byteOffset === undefined ? 0 : indices.byteOffset
      const valueOffset = values.byteOffset === undefined ? 0 : values.byteOffset
      if (!nonnegativeInteger(indexOffset) || !nonnegativeInteger(valueOffset) || indexOffset + sparse.count * indexSize > indexView.byteLength || valueOffset + sparse.count * elementSize > valueView.byteLength) fail('GLB_SPARSE_RANGE', `${path}.accessors[${accessorIndex}].sparse выходит за bufferView`)
    }
  })
  const meshes = arrayAt(json.meshes, `${path}.meshes`)
  if (!meshes.length) fail('GLB_MESH_MISSING', `${path}: в модели нет mesh`)
  meshes.forEach((rawMesh, meshIndex) => {
    const mesh = objectAt(rawMesh, `${path}.meshes[${meshIndex}]`)
    const primitives = arrayAt(mesh.primitives, `${path}.meshes[${meshIndex}].primitives`)
    primitives.forEach((rawPrimitive, primitiveIndex) => {
      const primitive = objectAt(rawPrimitive, `${path}.meshes[${meshIndex}].primitives[${primitiveIndex}]`)
      const attributes = objectAt(primitive.attributes, `${path}.meshes[${meshIndex}].primitives[${primitiveIndex}].attributes`)
      for (const accessor of Object.values(attributes)) indexAt(accessor, rawAccessors.length, `${path}.meshes[${meshIndex}].primitives[${primitiveIndex}].attributes`)
      if (primitive.indices !== undefined) indexAt(primitive.indices, rawAccessors.length, `${path}.meshes[${meshIndex}].primitives[${primitiveIndex}].indices`)
      if (primitive.material !== undefined) indexAt(primitive.material, Array.isArray(json.materials) ? json.materials.length : 0, `${path}.meshes[${meshIndex}].primitives[${primitiveIndex}].material`)
    })
  })
  const images = json.images === undefined ? [] : arrayAt(json.images, `${path}.images`)
  images.forEach((rawImage, imageIndex) => {
    const image = objectAt(rawImage, `${path}.images[${imageIndex}]`)
    if (image.uri !== undefined && image.uri !== null) fail('GLB_EXTERNAL_URI', `${path}.images[${imageIndex}]: внешний uri запрещён`)
    indexAt(image.bufferView, views.length, `${path}.images[${imageIndex}].bufferView`)
  })
}

/** @param {JsonObject} manifest */
function validateSources(manifest) {
  if (!Array.isArray(manifest.sources) || !manifest.sources.length) fail('CANDIDATE_SOURCE_METADATA', 'в manifest отсутствуют sources')
  manifest.sources.forEach((raw, index) => {
    const source = objectAt(raw, `sources[${index}]`)
    for (const field of ['url', 'license', 'author']) if (!text(source[field])) fail('CANDIDATE_SOURCE_METADATA', `sources[${index}].${field} обязателен`)
    if (source.archive !== undefined && !text(source.archive)) fail('CANDIDATE_SOURCE_METADATA', `sources[${index}].archive задан неверно`)
    if (source.archiveSha256 !== undefined && (typeof source.archiveSha256 !== 'string' || !SHA256.test(source.archiveSha256))) fail('CANDIDATE_SOURCE_HASH', `sources[${index}].archiveSha256 задан неверно`)
  })
}

/** @param {JsonObject} manifest */
function validateBuild(manifest) {
  if (manifest.build === undefined) return
  const build = objectAt(manifest.build, 'build')
  if (build.schema !== 'environment-candidate/v1') fail('CANDIDATE_BUILD_METADATA', 'build.schema задан неверно')
  for (const field of ['importerVersion', 'normalizationVersion', 'selectionVersion']) if (!integer(build[field]) || build[field] <= 0) fail('CANDIDATE_BUILD_METADATA', `build.${field} задан неверно`)
  if (!Array.isArray(build.sourceInputs)) fail('CANDIDATE_BUILD_METADATA', 'build.sourceInputs должен быть массивом')
  build.sourceInputs.forEach((raw, index) => {
    const input = objectAt(raw, `build.sourceInputs[${index}]`)
    if (typeof input.path !== 'string' || !input.path || input.path.startsWith('/') || input.path.includes('\\') || input.path.split('/').some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/u.test(part)) || typeof input.sha256 !== 'string' || !SHA256.test(input.sha256) || !nonnegativeInteger(input.bytes) || input.bytes > MAX_LIBRARY_BYTES) fail('CANDIDATE_BUILD_METADATA', `build.sourceInputs[${index}] задан неверно`)
  })
}

/** @param {Set<string>} families @param {Map<string, CandidateEntry>} byPath @param {Map<string, Buffer>} bytesByPath */
function validateFamilyMetadata(families, byPath, bytesByPath) {
  for (const family of families) {
    const prefix = family ? `${family}/` : ''
    for (const name of ['LICENSE.txt', 'NOTICE.txt']) {
      const path = prefix + name
      const entry = byPath.get(path)
      if (!entry) fail('CANDIDATE_LICENSE_METADATA', `для семейства ${family || 'root'} отсутствует ${path}`)
      if (entry.bytes > MAX_METADATA_BYTES) fail('CANDIDATE_LICENSE_METADATA', `${path} слишком велик`)
      let contents
      try { contents = TEXT_DECODER.decode(bytesByPath.get(path)) } catch (error) { fail('CANDIDATE_LICENSE_METADATA', `${path} не является текстом: ${error instanceof Error ? error.message : String(error)}`) }
      if (!contents.trim()) fail('CANDIDATE_LICENSE_METADATA', `${path} пуст`)
    }
  }
}

/** @param {JsonObject} value @returns {unknown} */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => (isObject(item) ? canonicalize(item) : Array.isArray(item) ? canonicalize(item) : item))
  const result = {}
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    result[key] = isObject(item) ? canonicalize(item) : Array.isArray(item) ? canonicalize(item) : item
  }
  return result
}

/** @param {JsonObject} manifest @param {CandidateFile[]} files @returns {string} */
function fingerprintOf(manifest, files) {
  const content = files.filter((file) => file.path !== ENVIRONMENT_MANIFEST_FILE && file.path !== ENVIRONMENT_RECEIPT_FILE)
    .map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
  return hash(Buffer.from(JSON.stringify({ manifest: canonicalize(manifest), files: content })))
}

/** @param {Buffer} bytes @param {string} fingerprint @param {CandidateFile[]} files */
function validateReceipt(bytes, fingerprint, files) {
  if (bytes.length > MAX_RECEIPT_BYTES) fail('CANDIDATE_RECEIPT_SIZE', 'receipt.json слишком велик')
  const receipt = parseJson(bytes, ENVIRONMENT_RECEIPT_FILE)
  if (receipt.schema !== 'environment-candidate-receipt/v1') fail('CANDIDATE_RECEIPT_SCHEMA', 'receipt.json имеет неизвестную schema')
  if (receipt.fingerprint !== fingerprint) fail('CANDIDATE_RECEIPT_FINGERPRINT', 'receipt.json не совпадает с candidate')
  if (!Array.isArray(receipt.files)) fail('CANDIDATE_RECEIPT_FILES', 'receipt.json.files должен быть массивом')
  const expected = files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
  if (JSON.stringify(receipt.files) !== JSON.stringify(expected)) fail('CANDIDATE_RECEIPT_FILES', 'receipt.json.files не совпадает с inventory')
}

/**
 * @param {string} directory
 * @param {{checkReceipt?: boolean}} [options]
 * @returns {Promise<{manifest: JsonObject, files: CandidateFile[], fingerprint: string}>}
 */
export async function validateEnvironmentCandidate(directory, { checkReceipt = true } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) fail('CANDIDATE_DIRECTORY', 'нужен путь к каталогу candidate')
  const root = resolve(directory)
  const rootMetadata = await lstat(root).catch((error) => fail('CANDIDATE_DIRECTORY', `каталог не найден: ${error instanceof Error ? error.message : String(error)}`))
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) fail('CANDIDATE_DIRECTORY', 'candidate должен быть обычным каталогом')
  /** @type {CandidateEntry[]} */
  const entries = []
  await collectFiles(root, root, entries)
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const receiptEntry = byPath.get(ENVIRONMENT_RECEIPT_FILE)
  let totalBytes = 0
  /** @type {CandidateFile[]} */
  const files = []
  const bytesByPath = new Map()
  for (const entry of entries) {
    totalBytes += entry.bytes
    if (totalBytes > MAX_LIBRARY_BYTES) fail('CANDIDATE_LIBRARY_SIZE', `библиотека больше ${MAX_LIBRARY_BYTES} байт`)
    const bytes = await readFile(entry.absolute)
    if (bytes.length !== entry.bytes) fail('CANDIDATE_RACE', `файл изменился во время проверки: ${entry.path}`)
    bytesByPath.set(entry.path, bytes)
    if (entry.path !== ENVIRONMENT_RECEIPT_FILE) files.push({ path: entry.path, sha256: hash(bytes), bytes: bytes.length })
  }
  const manifestEntry = byPath.get(ENVIRONMENT_MANIFEST_FILE)
  if (!manifestEntry) fail('CANDIDATE_MANIFEST_MISSING', 'отсутствует manifest.json')
  if (manifestEntry.bytes > MAX_MANIFEST_BYTES) fail('CANDIDATE_MANIFEST_SIZE', 'manifest.json слишком велик')
  const manifest = parseJson(bytesByPath.get(ENVIRONMENT_MANIFEST_FILE), ENVIRONMENT_MANIFEST_FILE)
  if (manifest.version !== 1 || !Array.isArray(manifest.models) || manifest.models.length < 1 || manifest.models.length > MAX_MODEL_COUNT) fail('CANDIDATE_MANIFEST_VERSION', `ожидался manifest version 1 и от 1 до ${MAX_MODEL_COUNT} моделей`)
  const knownAssetIds = new Set(listAssets().map((asset) => asset.id))
  const keys = new Set()
  const modelUrls = new Set()
  const families = new Set()
  const modelRecords = []
  manifest.models.forEach((raw, index) => {
    const model = objectAt(raw, `models[${index}]`)
    if (typeof model.key !== 'string' || !KEY.test(model.key) || keys.has(model.key)) fail('CANDIDATE_MODEL_KEY', `models[${index}].key не уникален или небезопасен`)
    keys.add(model.key)
    if (!text(model.label) || model.label.length > 160) fail('CANDIDATE_MODEL_LABEL', `models[${index}].label задан неверно`)
    if (!text(model.category) || model.category.length > 80) fail('CANDIDATE_MODEL_CATEGORY', `models[${index}].category задан неверно`)
    if (!finite(model.yaw)) fail('CANDIDATE_MODEL_YAW', `models[${index}].yaw должен быть конечным числом`)
    if (!Array.isArray(model.assetIds)) fail('CANDIDATE_ASSET_IDS', `models[${index}].assetIds должен быть массивом`)
    const assetIds = new Set()
    for (const assetId of model.assetIds) {
      if (typeof assetId !== 'string' || !knownAssetIds.has(assetId)) fail('CANDIDATE_ASSET_ID', `неизвестный semantic assetId: ${String(assetId)}`)
      if (assetIds.has(assetId)) fail('CANDIDATE_ASSET_ID_DUPLICATE', `assetId повторяется: ${assetId}`)
      assetIds.add(assetId)
    }
    const path = localUrlPath(model.url, '.glb')
    if (modelUrls.has(path)) fail('CANDIDATE_MODEL_URL_DUPLICATE', `модель повторно ссылается на ${path}`)
    modelUrls.add(path)
    const preview = objectAt(model.preview, `models[${index}].preview`)
    for (const field of ['x', 'y', 'w', 'h']) if (!nonnegativeInteger(preview[field]) || preview[field] > 8192) fail('CANDIDATE_PREVIEW_FRAME', `models[${index}].preview.${field} задан неверно`)
    if (preview.w <= 0 || preview.h <= 0) fail('CANDIDATE_PREVIEW_FRAME', `models[${index}].preview должен иметь положительные размеры`)
    const pathParts = path.split('/')
    families.add(pathParts.length > 1 ? pathParts[0] : '')
    modelRecords.push({ model, path })
  })
  validateSources(manifest)
  validateBuild(manifest)
  if (!isObject(manifest.atlas)) fail('CANDIDATE_ATLAS_METADATA', 'в manifest отсутствует atlas')
  const atlasPath = localUrlPath(manifest.atlas.image, '.png')
  if (typeof manifest.atlas.key !== 'string' || !SHA256.test(manifest.atlas.key)) fail('CANDIDATE_ATLAS_KEY', 'atlas.key должен быть SHA-256')
  // В выпуск попадают только заявленные модели, атлас и происхождение.
  // Архивы, временные файлы и случайно скопированные данные не публикуются.
  const allowed = new Set([ENVIRONMENT_MANIFEST_FILE, ENVIRONMENT_RECEIPT_FILE, atlasPath, ...modelUrls])
  for (const family of families) for (const name of ['LICENSE.txt', 'NOTICE.txt']) allowed.add(family ? `${family}/${name}` : name)
  for (const entry of entries) if (!allowed.has(entry.path)) fail('CANDIDATE_UNDECLARED_FILE', `незаявленный файл: ${entry.path}`)
  for (const { model, path } of modelRecords) {
    const entry = byPath.get(path)
    if (!entry) fail('CANDIDATE_MODEL_MISSING', `модель не найдена внутри candidate: ${path}`)
    if (entry.bytes > MAX_MODEL_BYTES) fail('GLB_TOO_LARGE', `${path}: GLB больше ${MAX_MODEL_BYTES} байт`)
    let inspected
    try { inspected = await inspectModelFile(entry.absolute) } catch (error) { fail('GLB_INVALID', `${path}: ${error instanceof Error ? error.message : String(error)}`) }
    const modelBytes = bytesByPath.get(path)
    if (inspected.bytes !== modelBytes.length || inspected.sha256 !== hash(modelBytes)) fail('CANDIDATE_RACE', `модель изменилась во время проверки: ${path}`)
    if (modelBytes.length < 20 || modelBytes.readUInt32LE(0) !== GLB_MAGIC || modelBytes.readUInt32LE(8) !== modelBytes.length) fail('GLB_LENGTH', `${path}: некорректная длина GLB`)
    validateGlbReferences(inspected.json, path)
  }
  const atlasEntry = byPath.get(atlasPath)
  if (!atlasEntry) fail('CANDIDATE_ATLAS_MISSING', `PNG атласа не найден: ${atlasPath}`)
  const atlasBytes = bytesByPath.get(atlasPath)
  if (atlasBytes.length < 33 || !PNG_SIGNATURE.equals(atlasBytes.subarray(0, 8)) || atlasBytes.toString('ascii', 12, 16) !== 'IHDR') fail('CANDIDATE_PNG_INVALID', `файл не является PNG: ${atlasPath}`)
  const width = atlasBytes.readUInt32BE(16)
  const height = atlasBytes.readUInt32BE(20)
  if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_PNG_PIXELS) fail('CANDIDATE_PNG_DIMENSIONS', `размер PNG не укладывается в лимит: ${atlasPath}`)
  let decodedAtlas
  try { decodedAtlas = decodePng(atlasBytes) } catch (error) { fail('CANDIDATE_ATLAS_INVALID', `повреждённый PNG атласа: ${error instanceof Error ? error.message : String(error)}`) }
  if (decodedAtlas.width !== width || decodedAtlas.height !== height) fail('CANDIDATE_PNG_INVALID', `размер PNG не совпадает с IHDR: ${atlasPath}`)
  if (hash(atlasBytes) !== manifest.atlas.key) fail('CANDIDATE_ATLAS_HASH', 'atlas.key не совпадает с SHA-256 PNG')
  // Префиксная сумма альфа-пикселей даёт точную проверку любого frame за O(1)
  // и не принимает прозрачную дырку между двумя соседними частями рисунка.
  const prefixWidth = width + 1
  const alphaPrefix = new Uint32Array(prefixWidth * (height + 1))
  for (let y = 1; y <= height; y += 1) {
    let rowPixels = 0
    for (let x = 1; x <= width; x += 1) {
      if (decodedAtlas.data[((y - 1) * width + x - 1) * 4 + 3] !== 0) rowPixels += 1
      alphaPrefix[y * prefixWidth + x] = alphaPrefix[(y - 1) * prefixWidth + x] + rowPixels
    }
  }
  for (const { model } of modelRecords) {
    const frame = model.preview
    if (frame.x + frame.w > width || frame.y + frame.h > height) fail('CANDIDATE_PREVIEW_BOUNDS', `${model.key}: preview выходит за границы PNG`)
    const left = frame.x
    const top = frame.y
    const right = left + frame.w
    const bottom = top + frame.h
    const visiblePixels = alphaPrefix[bottom * prefixWidth + right] - alphaPrefix[top * prefixWidth + right]
      - alphaPrefix[bottom * prefixWidth + left] + alphaPrefix[top * prefixWidth + left]
    if (visiblePixels <= 0) fail('CANDIDATE_PREVIEW_EMPTY', `${model.key}: preview не содержит непрозрачных пикселей`)
  }
  validateFamilyMetadata(families, byPath, bytesByPath)
  const fingerprint = fingerprintOf(manifest, files)
  if (receiptEntry && checkReceipt) validateReceipt(bytesByPath.get(ENVIRONMENT_RECEIPT_FILE), fingerprint, files)
  return { manifest, files, fingerprint }
}
