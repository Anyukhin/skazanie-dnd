#!/usr/bin/env node
// @ts-check
/**
 * Импортирует готовые GLTF/GLB-предметы в локальную библиотеку окружения.
 *
 * Источники намеренно остаются вне репозитория (tmp/). На выходе каждый файл
 * самодостаточен: исходные .bin и PNG читаются один раз, PNG уменьшаются до
 * 512 px по длинной стороне и кладутся в новый BIN chunk.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { decodePng, encodePng } from './png-codec.mjs'
import { resampleImage } from './build-prop-atlas.mjs'
import { listAssets } from '../server/asset-registry.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const OUTPUT = join(ROOT, 'public/assets/models/environment')
const QUATERNIUS_DIR = join(ROOT, 'tmp/quaternius-fantasy-props-extracted/Exports/glTF')
const KENNEY_DIR = join(ROOT, 'tmp/kenney-nature-kit-extracted/Models/GLTF format')
const QUATERNIUS_ARCHIVE = join(ROOT, 'tmp/fantasy_props_megakitstandard.zip')
const KENNEY_ARCHIVE = join(ROOT, 'tmp/kenney_nature-kit.zip')
const MAX_TEXTURE_SIDE = 512
const MAX_FILE_BYTES = 8_000_000
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Имена материалов Nature Kit фиксированы исходным набором. */
const MATERIAL_SRGB = Object.freeze({
  leafsGreen: '#435b2a',
  leafsDark: '#344729',
  leafsFall: '#a4772b',
  woodBark: '#6a4328',
  woodBarkDark: '#4b3324',
  woodBirch: '#7b603d',
  woodInner: '#9a6a3a',
  wood: '#754a2b',
  woodDark: '#4b3024',
  grass: '#4a682c',
  dirt: '#6d604f',
  _defaultMat: '#6f6453',
  colorRed: '#8b3426',
  colorYellow: '#ad832a',
  colorTan: '#8b6a42',
})

const SOURCES = [
  {
    url: 'https://quaternius.com/packs/fantasypropsmegakit.html',
    license: 'CC0-1.0',
    author: 'Quaternius',
    archive: 'fantasy_props_megakitstandard.zip',
    archiveSha256: '0bc1e5843c9f245c44bda82f97f738b09f88fe51bb34d2a69a7847a969f868e3',
  },
  {
    url: 'https://kenney.nl/assets/nature-kit',
    license: 'CC0-1.0',
    author: 'Kenney',
    archive: 'kenney_nature-kit.zip',
    archiveSha256: 'fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d',
  },
]

/** У выбранных вариантов есть осмысленная связь с каноническим assetId. */
const ASSET_IDS = {
  Table_Large: ['table_long'],
  Bench: ['bench'],
  Chair_1: ['chair'],
  Stool: ['stool'],
  Bed_Twin1: ['bed'],
  Bed_Twin2: ['bed'],
  Barrel: ['barrel', 'keg'],
  Barrel_Apples: ['barrel'],
  Crate_Wooden: ['crate'],
  Chest_Wood: ['chest'],
  Bag: ['sack'],
  Bucket_Metal: ['bucket'],
  Cabinet: ['cupboard'],
  Bookcase_2: ['bookshelf'],
  Shelf_Simple: ['shelf_wall'],
  Mug: ['mug'],
  Table_Plate: ['plate'],
  Bottle_1: ['bottle'],
  Candle_1: ['candle'],
  Pot_1: ['pot'],
  Coin_Pile: ['coin_pile'],
  Cauldron: ['cauldron'],
  Chandelier: ['chandelier'],
  Torch_Metal: ['torch_wall'],
  Lantern_Wall: ['lantern_wall'],
  CandleStick_Triple: ['candelabra'],
  Banner_1: ['banner'],
  Stall_Cart_Empty: ['cart'],
  Stall_Empty: ['market_stall'],
}

/** Поворот в градусах; клиент применяет его вокруг вертикальной оси. */
const YAW = {
  Bed_Twin1: 90,
  Bed_Twin2: 90,
}

/** Около тридцати форм из Nature Kit: деревья, пни, древесина, камни и трава. */
const KENNEY_SELECTION = [
  ['tree_default', 'Природа', 'Лиственное дерево', ['tree_birch'], 0],
  ['tree_oak', 'Природа', 'Дуб', ['tree_oak'], 0],
  ['tree_pineDefaultA', 'Природа', 'Сосна', ['tree_pine'], 0],
  ['tree_pineRoundA', 'Природа', 'Круглая сосна', ['tree_spruce'], 0],
  ['tree_pineTallA_detailed', 'Природа', 'Высокая сосна', ['tree_pine'], 0],
  ['tree_simple', 'Природа', 'Молодое дерево', ['tree_birch'], 0],
  ['tree_default_fall', 'Природа', 'Осеннее дерево', [], 0],
  ['stump_old', 'Природа', 'Старый пень', ['tree_stump'], 0],
  ['stump_roundDetailed', 'Природа', 'Круглый пень', ['tree_stump'], 0],
  ['stump_squareDetailedWide', 'Природа', 'Широкий пень', ['tree_stump'], 0],
  ['log', 'Природа', 'Бревно', ['fallen_log'], 90],
  ['log_large', 'Природа', 'Большое бревно', ['fallen_log'], 0],
  ['log_stack', 'Природа', 'Стопка брёвен', ['woodpile'], 90],
  ['log_stackLarge', 'Природа', 'Большая стопка брёвен', ['woodpile'], 90],
  ['rock_smallA', 'Природа', 'Небольшой камень', ['rock_small'], 0],
  ['rock_smallB', 'Природа', 'Камень округлой формы', ['rock_small'], 0],
  ['rock_smallFlatA', 'Природа', 'Плоский камень', ['rock_small'], 0],
  ['rock_largeA', 'Природа', 'Валун', ['boulder'], 0],
  ['rock_tallA', 'Природа', 'Высокий валун', ['boulder'], 0],
  ['plant_bush', 'Природа', 'Куст', ['bush'], 0],
  ['plant_bushDetailed', 'Природа', 'Густой куст', ['bush'], 0],
  ['plant_bushLarge', 'Природа', 'Большой куст', ['bush'], 0],
  ['plant_bushSmall', 'Природа', 'Маленький куст', ['shrub'], 0],
  ['mushroom_red', 'Природа', 'Красный гриб', ['mushroom_cluster'], 0],
  ['mushroom_redGroup', 'Природа', 'Группа красных грибов', ['mushroom_cluster'], 0],
  ['mushroom_tanGroup', 'Природа', 'Группа светлых грибов', ['mushroom_cluster'], 0],
  ['grass', 'Природа', 'Пучок травы', ['grass_tuft'], 0],
  ['grass_large', 'Природа', 'Высокая трава', ['grass_tuft'], 0],
  ['flower_redA', 'Природа', 'Красный цветок', ['flowers'], 0],
  ['flower_yellowA', 'Природа', 'Жёлтый цветок', ['flowers'], 0],
  ['campfire_logs', 'Природа', 'Костёр на брёвнах', ['campfire'], 0],
]

const PNG_CACHE = new Map()

function align4(value) {
  return (value + 3) & ~3
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function srgbToLinear(value) {
  const channel = Number.parseInt(value, 16) / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function linearColor(hex) {
  const value = String(hex).replace(/^#/u, '')
  if (!/^[0-9a-f]{6}$/iu.test(value)) throw new Error(`Некорректный цвет материала: ${hex}`)
  return [srgbToLinear(value.slice(0, 2)), srgbToLinear(value.slice(2, 4)), srgbToLinear(value.slice(4, 6)), 1]
}

function normalizeKenneyMaterials(json, file) {
  let changed = 0
  for (const material of json.materials ?? []) {
    const name = String(material.name ?? '')
    const hex = MATERIAL_SRGB[name]
    if (!hex) throw new Error(`Неизвестный материал Kenney ${name} в ${file}`)
    const pbr = material.pbrMetallicRoughness ?? (material.pbrMetallicRoughness = {})
    pbr.baseColorFactor = linearColor(hex)
    pbr.metallicFactor = 0
    pbr.roughnessFactor = 1
    changed += 1
  }
  return changed
}

function slug(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^a-zA-Z0-9_-]+/gu, '_')
    .replace(/^[_-]+|[_-]+$/gu, '')
    .toLowerCase()
}

function titleOf(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' ')
}

function categoryOf(value) {
  if (/^(Banner|Torch|Lantern|Candle|Chandelier)/u.test(value)) return 'Освещение и декор'
  if (/^(Bed|Bench|Chair|Stool|Table|Shelf|Bookcase|Cabinet|Nightstand|Peg|Stall|WeaponStand|Workbench)/u.test(value)) return 'Мебель'
  if (/^(Barrel|Bag|Bucket|Cage|Chest|Crate|FarmCrate|Pot|Vase|Cauldron)/u.test(value)) return 'Хранилища'
  if (/^(Tree|Book|Bottle|Coin|Mug|Plate|Candle|Chalice|Carrot|Potion|Pouch|Rope|Scroll|Shield|Sword|Pickaxe|Axe|Anvil|Whetstone|SmallBottle)/u.test(value)) return 'Утварь'
  return 'Предметы'
}

export function labelOf(value) {
  const known = {
    Anvil: 'Наковальня', Anvil_Log: 'Наковальня на колоде', Axe_Bronze: 'Бронзовый топор', Bag: 'Мешок',
    Banner_1_Cloth: 'Полотнище знамени', Banner_2: 'Знамя, вариант 2', Banner_2_Cloth: 'Полотнище знамени, вариант 2',
    Barrel_Holder: 'Подставка для бочки',
    BookGroup_Medium_1: 'Большой ряд книг', BookGroup_Medium_2: 'Большой ряд книг, вариант 2', BookGroup_Medium_3: 'Большой ряд книг, вариант 3',
    BookGroup_Small_1: 'Небольшой ряд книг', BookGroup_Small_2: 'Небольшой ряд книг, вариант 2', BookGroup_Small_3: 'Небольшой ряд книг, вариант 3',
    BookStand: 'Подставка для книги', Book_5: 'Книга в синем переплёте', Book_7: 'Книга в красном переплёте',
    Book_Simplified_Single: 'Книга', Book_Stack_1: 'Стопка книг', Book_Stack_2: 'Стопка книг, вариант 2',
    Bucket_Metal: 'Металлическое ведро', Bucket_Wooden_1: 'Деревянное ведро', Cage_Small: 'Небольшая клетка',
    CandleStick: 'Подсвечник', CandleStick_Stand: 'Напольный подсвечник', CandleStick_Triple: 'Тройной подсвечник',
    Candle_1: 'Свеча', Candle_2: 'Свеча, вариант 2', Carrot: 'Морковь', Chain_Coil: 'Смотанная цепь', Chalice: 'Кубок',
    Coin: 'Монета', Coin_Pile_2: 'Россыпь монет', Crate_Metal: 'Окованный ящик', Dummy: 'Тренировочное чучело',
    FarmCrate_Apple: 'Ящик с яблоками', FarmCrate_Carrot: 'Ящик с морковью', FarmCrate_Empty: 'Овощной ящик',
    Key_Gold: 'Золотой ключ', Key_Metal: 'Железный ключ', Nightstand_Shelf: 'Прикроватная тумба',
    Peg_Rack: 'Вешалка с крючками', Pickaxe_Bronze: 'Бронзовая кирка',
    Potion_1: 'Зелье в зелёной бутылке', Potion_2: 'Зелье в красной бутылке', Potion_4: 'Зелье в фиолетовой бутылке',
    Pot_1_Lid: 'Крышка горшка', Pouch_Large: 'Большой кошель',
    Rope_1: 'Моток верёвки', Rope_2: 'Моток верёвки, вариант 2', Rope_3: 'Моток верёвки, вариант 3',
    Scroll_1: 'Свиток с зелёной лентой', Scroll_2: 'Свиток с красной лентой',
    Shelf_Arch: 'Арочная полка', Shelf_Small_Bottles: 'Полка с бутылками', Shield_Wooden: 'Деревянный щит',
    SmallBottle: 'Маленькая бутылка', SmallBottles_1: 'Маленькие бутылки', Sword_Bronze: 'Бронзовый меч',
    Table_Fork: 'Вилка', Table_Knife: 'Столовый нож', Table_Spoon: 'Ложка', Vase_2: 'Глиняная ваза',
    Vase_4: 'Глиняная ваза, вариант 2', Vase_Rubble_Medium: 'Черепки вазы',
    WeaponStand: 'Стойка для оружия', Whetstone: 'Точильный круг', Workbench: 'Верстак', Workbench_Drawers: 'Верстак с ящиками',
    Table_Large: 'Длинный стол',
    Bed_Twin1: 'Кровать',
    Bed_Twin2: 'Кровать, вариант',
    Barrel: 'Бочка',
    Barrel_Apples: 'Бочка с яблоками',
    Crate_Wooden: 'Деревянный ящик',
    Chest_Wood: 'Деревянный сундук',
    Chair_1: 'Стул',
    Bench: 'Скамья',
    Stool: 'Табурет',
    Cabinet: 'Шкаф',
    Bookcase_2: 'Книжный шкаф',
    Shelf_Simple: 'Настенная полка',
    Mug: 'Кружка',
    Table_Plate: 'Тарелка',
    Bottle_1: 'Бутылка',
    Pot_1: 'Горшок',
    Cauldron: 'Котёл',
    Coin_Pile: 'Стопка монет',
    Chandelier: 'Люстра',
    Torch_Metal: 'Настенный факел',
    Lantern_Wall: 'Настенный фонарь',
    Banner_1: 'Знамя',
    Stall_Empty: 'Торговая стойка',
    Stall_Cart_Empty: 'Торговая тележка',
  }
  return known[value] ?? `Предмет: ${titleOf(value)}`
}

function decodeDataUri(uri) {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/su.exec(uri)
  if (!match) throw new Error(`Некорректный data URI: ${uri.slice(0, 40)}`)
  return uri.includes(';base64') ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]))
}

function externalPath(sourceFile, uri) {
  if (/^(?:https?:)?\/\//u.test(uri)) throw new Error(`Внешний ресурс запрещён: ${uri}`)
  const root = resolve(dirname(sourceFile))
  const candidate = resolve(root, decodeURIComponent(uri.replace(/^file:\/\//u, '')))
  const outside = relative(root, candidate)
  if (outside === '..' || outside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(outside)) {
    throw new Error(`Ссылка выходит из каталога исходника: ${uri}`)
  }
  return candidate
}

async function readExternal(sourceFile, uri) {
  const direct = externalPath(sourceFile, uri)
  const name = basename(decodeURIComponent(uri))
  const directory = dirname(sourceFile)
  // Quaternius хранит общие текстуры в соседнем каталоге Textures,
  // оставляя в URI каждой модели только короткое имя файла.
  const candidates = [
    direct,
    join(directory, '..', 'Textures', name),
    join(directory, '..', '..', 'Textures', name),
    join(directory, '..', '..', '..', 'Textures', name),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return readFile(candidate)
  throw new Error(`Не найден внешний ресурс ${uri} рядом с ${sourceFile}`)
}

function parseGlb(source, sourceFile) {
  if (source.length < 20 || source.readUInt32LE(0) !== 0x46546c67 || source.readUInt32LE(4) !== 2) {
    throw new Error(`Ожидался GLB 2: ${sourceFile}`)
  }
  const declaredLength = source.readUInt32LE(8)
  if (declaredLength > source.length || declaredLength < 20) throw new Error(`Обрезанный GLB: ${sourceFile}`)
  let offset = 12
  let json = null
  let binary = Buffer.alloc(0)
  while (offset + 8 <= declaredLength) {
    const length = source.readUInt32LE(offset)
    const type = source.readUInt32LE(offset + 4)
    const end = offset + 8 + length
    if (end > declaredLength) throw new Error(`Обрезанный chunk GLB: ${sourceFile}`)
    const body = source.subarray(offset + 8, end)
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8').replace(/[\u0000 ]+$/gu, ''))
    else if (type === 0x004e4942) binary = Buffer.from(body)
    offset = end
  }
  if (!json || !Array.isArray(json.buffers) || json.buffers.length !== 1) throw new Error(`Некорректный JSON GLB: ${sourceFile}`)
  return { json, binary: binary.subarray(0, json.buffers[0].byteLength ?? binary.length) }
}

async function readSource(file) {
  if (extname(file).toLowerCase() === '.glb') return parseGlb(await readFile(file), file)
  const json = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(json.buffers) || !json.buffers.length) throw new Error(`В glTF нет buffers: ${file}`)
  const buffers = []
  for (const buffer of json.buffers) {
    if (!buffer.uri) throw new Error(`Внешний .gltf buffer не имеет URI: ${file}`)
    const bytes = buffer.uri.startsWith('data:') ? decodeDataUri(buffer.uri) : await readExternal(file, buffer.uri)
    if (bytes.length < (buffer.byteLength ?? 0)) throw new Error(`Buffer короче заявленного: ${file}`)
    buffers.push(Buffer.from(bytes.subarray(0, buffer.byteLength ?? bytes.length)))
  }
  const chunks = []
  let length = 0
  const offsets = []
  for (const bytes of buffers) {
    const aligned = align4(length)
    if (aligned > length) chunks.push(Buffer.alloc(aligned - length))
    offsets.push(aligned)
    chunks.push(bytes)
    length = aligned + bytes.length
  }
  for (const view of json.bufferViews ?? []) {
    const base = offsets[view.buffer ?? 0]
    if (base == null || (view.byteOffset ?? 0) + view.byteLength > buffers[view.buffer ?? 0].length) throw new Error(`Некорректный bufferView: ${file}`)
    view.buffer = 0
    view.byteOffset = base + (view.byteOffset ?? 0)
  }
  json.buffers = [{ byteLength: length }]
  return { json, binary: Buffer.concat(chunks, length) }
}

function resizedPng(bytes, cacheKey, maxSide) {
  if (!PNG_SIGNATURE.equals(bytes.subarray(0, 8))) return bytes
  const cached = PNG_CACHE.get(cacheKey)
  if (cached) return cached
  const image = decodePng(bytes)
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
  const output = scale < 1
    ? encodePng(resampleImage(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale))))
    : bytes
  PNG_CACHE.set(cacheKey, output)
  return output
}

async function imageBytes(image, sourceFile, binary, sourceJson) {
  let bytes
  if (typeof image.uri === 'string') {
    bytes = image.uri.startsWith('data:') ? decodeDataUri(image.uri) : await readExternal(sourceFile, image.uri)
  } else if (Number.isInteger(image.bufferView)) {
    const view = sourceJson.bufferViews?.[image.bufferView]
    if (!view || (view.byteOffset ?? 0) + view.byteLength > binary.length) throw new Error(`Некорректная текстура: ${sourceFile}`)
    bytes = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
  } else {
    throw new Error(`У изображения нет uri или bufferView: ${sourceFile}`)
  }
  const mime = image.mimeType ?? (PNG_SIGNATURE.equals(bytes.subarray(0, 8)) ? 'image/png' : '')
  const maxSide = /(?:normal|orm)/iu.test(String(image.name ?? image.uri ?? '')) ? 256 : MAX_TEXTURE_SIDE
  return { bytes: mime === 'image/png' ? resizedPng(Buffer.from(bytes), hash(bytes), maxSide) : Buffer.from(bytes), mime }
}

function writeGlb(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json))
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)])
  const paddedBinary = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + paddedBinary.length, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(paddedJson.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binaryHeader = Buffer.alloc(8)
  binaryHeader.writeUInt32LE(paddedBinary.length, 0)
  binaryHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, paddedBinary])
}

async function convert(sourceFile, outputFile) {
  const source = await readSource(sourceFile)
  const json = structuredClone(source.json)
  const chunks = [source.binary]
  let binaryLength = source.binary.length
  const originalViews = structuredClone(json.bufferViews ?? [])
  const sourceJson = { ...json, bufferViews: originalViews }
  json.bufferViews = originalViews
  json.buffers = [{ byteLength: 0 }]
  for (const image of json.images ?? []) {
    const prepared = await imageBytes(image, sourceFile, source.binary, sourceJson)
    const aligned = align4(binaryLength)
    if (aligned > binaryLength) chunks.push(Buffer.alloc(aligned - binaryLength))
    image.bufferView = json.bufferViews.length
    delete image.uri
    image.mimeType = prepared.mime || image.mimeType || 'application/octet-stream'
    json.bufferViews.push({ buffer: 0, byteOffset: aligned, byteLength: prepared.bytes.length })
    chunks.push(prepared.bytes)
    binaryLength = aligned + prepared.bytes.length
  }
  json.buffers[0].byteLength = binaryLength
  const binary = Buffer.concat(chunks, binaryLength)
  const output = writeGlb(json, binary)
  if (output.length > MAX_FILE_BYTES) throw new Error(`${outputFile} превышает ${MAX_FILE_BYTES} байт`)
  await writeFile(outputFile, output)
  return { bytes: output.length, hash: hash(output), json }
}

function assertModelJson(json, binary, file) {
  if (json.buffers?.some((buffer) => buffer.uri) || json.images?.some((image) => image.uri)) throw new Error(`Внешний ресурс в результате: ${file}`)
  if (!json.meshes?.length) throw new Error(`В модели нет mesh: ${file}`)
  for (const image of json.images ?? []) {
    const view = json.bufferViews?.[image.bufferView]
    if (!view || view.buffer !== 0 || view.byteOffset + view.byteLength > json.buffers[0].byteLength) throw new Error(`Изображение вне BIN: ${file}`)
    if (image.mimeType === 'image/png') {
      const bytes = binary.subarray(view.byteOffset, view.byteOffset + view.byteLength)
      const decoded = decodePng(bytes)
      if (Math.max(decoded.width, decoded.height) > MAX_TEXTURE_SIDE) throw new Error(`PNG больше 512 px: ${file}`)
    }
  }
}

async function archiveHash(file, fallback) {
  if (!existsSync(file)) return fallback
  return hash(await readFile(file))
}

function sourceWithArchiveHashes(hashes) {
  return SOURCES.map((source, index) => ({ ...source, archiveSha256: hashes[index] }))
}

async function writeNotice(directory, text) {
  await writeFile(join(directory, 'NOTICE.txt'), `${text.trim()}\n`)
}

async function normalizeKenneyOutput() {
  const directory = join(OUTPUT, 'kenney')
  const files = KENNEY_SELECTION.map(([sourceName]) => join(directory, `${slug(sourceName)}.glb`))
  if (files.some((file) => !existsSync(file))) throw new Error('Палитра Kenney: сначала соберите библиотеку моделей')
  let changedMaterials = 0
  let changedFiles = 0
  for (const file of files) {
    const original = await readFile(file)
    const parsed = parseGlb(original, file)
    assertModelJson(parsed.json, parsed.binary, file)
    changedMaterials += normalizeKenneyMaterials(parsed.json, file)
    const normalized = writeGlb(parsed.json, parsed.binary)
    if (!normalized.equals(original)) changedFiles += 1
    await writeFile(file, normalized)
  }
  const noticeFile = join(directory, 'NOTICE.txt')
  const notice = existsSync(noticeFile) ? await readFile(noticeFile, 'utf8') : ''
  const paletteNotice = 'Палитра материалов нормализована для «Сказания»: листва тёмно-зелёная/оливковая, кора коричневая, камни серо-бурые, осенняя листва охристая; metallicFactor=0, roughnessFactor=1.'
  if (!notice.includes(paletteNotice)) await writeFile(noticeFile, `${notice.trim()}\n${paletteNotice}\n`)
  process.stdout.write(`${JSON.stringify({ ok: true, files: files.length, changedFiles, changedMaterials, manifest: 'не изменён' }, null, 2)}\n`)
}

async function main() {
  const qDir = resolve(process.argv.includes('--quaternius-dir') ? process.argv[process.argv.indexOf('--quaternius-dir') + 1] : QUATERNIUS_DIR)
  const kDir = resolve(process.argv.includes('--kenney-dir') ? process.argv[process.argv.indexOf('--kenney-dir') + 1] : KENNEY_DIR)
  if (!existsSync(qDir) || !existsSync(kDir)) throw new Error(`Не найдены исходники. Нужны каталоги ${qDir} и ${kDir}`)
  const available = new Set(listAssets().map((asset) => asset.id))
  for (const [source, ids] of Object.entries(ASSET_IDS)) for (const id of ids) if (!available.has(id)) throw new Error(`Неизвестный assetId ${id} у ${source}`)
  for (const [, , , ids] of KENNEY_SELECTION) for (const id of ids) if (!available.has(id)) throw new Error(`Неизвестный assetId ${id} у Kenney`)

  const qNames = (await readdir(qDir)).filter((name) => name.toLowerCase().endsWith('.gltf')).sort()
  if (qNames.length !== 94) throw new Error(`Ожидалось 94 Quaternius glTF, найдено ${qNames.length}`)
  const kNames = new Set(await readdir(kDir))
  for (const [name] of KENNEY_SELECTION) if (!kNames.has(`${name}.glb`)) throw new Error(`Не найден Kenney GLB: ${name}`)

  const qOut = join(OUTPUT, 'quaternius')
  const kOut = join(OUTPUT, 'kenney')
  await mkdir(qOut, { recursive: true })
  await mkdir(kOut, { recursive: true })
  /** @type {Array<Record<string, unknown>>} */
  const models = []
  let totalBytes = 0
  const built = []
  for (const name of qNames) {
    const sourceName = name.slice(0, -5)
    const key = `q-${slug(sourceName)}`
    const fileName = `${slug(sourceName)}.glb`
    const outputFile = join(qOut, fileName)
    const result = await convert(join(qDir, name), outputFile)
    const binary = await readFile(outputFile)
    assertModelJson(result.json, parseGlb(binary, outputFile).binary, outputFile)
    const bytes = result.bytes
    totalBytes += bytes
    built.push({ key, file: outputFile, bytes, source: 'Quaternius', sourceName })
    models.push({ key, label: labelOf(sourceName), category: categoryOf(sourceName), url: `/assets/models/environment/quaternius/${fileName}`, assetIds: [...(ASSET_IDS[sourceName] ?? [])], yaw: YAW[sourceName] ?? 0 })
  }
  for (const [sourceName, category, label, assetIds, yaw] of KENNEY_SELECTION) {
    const key = `k-${slug(sourceName)}`
    const fileName = `${slug(sourceName)}.glb`
    const outputFile = join(kOut, fileName)
    const result = await convert(join(kDir, `${sourceName}.glb`), outputFile)
    const binary = await readFile(outputFile)
    assertModelJson(result.json, parseGlb(binary, outputFile).binary, outputFile)
    totalBytes += result.bytes
    built.push({ key, file: outputFile, bytes: result.bytes, source: 'Kenney', sourceName })
    models.push({ key, label, category, url: `/assets/models/environment/kenney/${fileName}`, assetIds: [...assetIds], yaw })
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Библиотека превышает бюджет 64 МиБ: ${totalBytes}`)

  const hashes = await Promise.all([archiveHash(QUATERNIUS_ARCHIVE, SOURCES[0].archiveSha256), archiveHash(KENNEY_ARCHIVE, SOURCES[1].archiveSha256)])
  await writeFile(join(OUTPUT, 'manifest.json'), `${JSON.stringify({ version: 1, sources: sourceWithArchiveHashes(hashes), models }, null, 2)}\n`)
  await writeFile(join(qOut, 'LICENSE.txt'), 'Fantasy Props MegaKit Standard — Quaternius\nLicense: CC0 1.0 Universal.\nhttps://creativecommons.org/publicdomain/zero/1.0/\nSource: https://quaternius.com/packs/fantasypropsmegakit.html\n')
  await writeNotice(qOut, `Fantasy Props MegaKit Standard by Quaternius.\nSource archive: ${SOURCES[0].archive}; SHA-256: ${hashes[0]}.\nGenerated from all 94 glTF files. External .bin files and PNG textures were embedded; PNG textures were reduced to at most 512 px per side.`)
  const kenneyLicenseFile = join(kDir, '..', '..', 'License.txt')
  const kenneyLicense = existsSync(kenneyLicenseFile)
    ? await readFile(kenneyLicenseFile, 'utf8')
    : 'Nature Kit (2.1) — Kenney\nLicense: Creative Commons Zero (CC0).\nhttps://creativecommons.org/publicdomain/zero/1.0/\nSource: https://kenney.nl/assets/nature-kit\n'
  await writeFile(join(kOut, 'LICENSE.txt'), kenneyLicense)
  await writeNotice(kOut, `Nature Kit (2.1) by Kenney.\nSource archive: ${SOURCES[1].archive}; SHA-256: ${hashes[1]}.\nSelected ${KENNEY_SELECTION.length} GLB files from the official GLTF export. No DAE or FBX files are imported.`)
  process.stdout.write(`${JSON.stringify({ ok: true, quaternius: qNames.length, kenney: KENNEY_SELECTION.length, models: models.length, mappedAssetIds: [...new Set(models.flatMap((model) => model.assetIds))].sort(), bytes: totalBytes, largest: built.sort((a, b) => b.bytes - a.bytes).slice(0, 5) }, null, 2)}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('import-environment-models.mjs')) {
  if (process.argv.includes('--palette-only')) await normalizeKenneyOutput()
  else await main()
}
