#!/usr/bin/env node
/**
 * Собирает набор моделей местности 3D-доски: камни гряд, глыбы толщи скалы,
 * кувшинки и тростник у воды, пролёты деревянного моста.
 *
 * Исходники (CC0) лежат вне репозитория, в tmp/asset-src. Каждая выбранная
 * модель сначала становится самодостаточным GLB через `convert` из
 * import-environment-models.mjs (текстуры ≤ 512 px внутри BIN), затем модели
 * одной группы сливаются в один GLB: общая текстура камня хранится один раз, а
 * каждая модель — узел с именем своего ключа.
 *
 * Результат пишется в public/assets/models/landscape/<ревизия>/ — ревизия это
 * хеш содержимого, каталог неизменяем. Активный manifest.json рядом с
 * каталогами ревизий указывает на текущую. Реестр прав (data/asset-rights.json)
 * инструмент не трогает.
 *
 *   node tools/build-landscape-kit.mjs [--src tmp/asset-src] [--out public/assets/models/landscape] [--dry-run]
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { convert } from './import-environment-models.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const LANDSCAPE_URL_ROOT = '/assets/models/landscape/'
export const LANDSCAPE_ROLES = Object.freeze(['rock', 'cliff', 'lily', 'reed', 'bridge'])
const MAX_KIT_BYTES = 4 * 1024 * 1024

export const LANDSCAPE_SOURCES = Object.freeze([
  {
    id: 'quaternius-stylized-nature-megakit-standard',
    author: 'Quaternius',
    url: 'https://quaternius.itch.io/stylized-nature-megakit',
    license: 'CC0-1.0',
    archive: 'Stylized_Nature_MegaKit_Standard.zip',
    archiveSha256: '298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9',
    directory: 'Stylized_Nature_MegaKit_Standard/glTF',
  },
  {
    id: 'kenney-nature-kit',
    author: 'Kenney',
    url: 'https://kenney.nl/assets/nature-kit',
    license: 'CC0-1.0',
    archive: 'kenney_nature-kit.zip',
    archiveSha256: 'fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d',
    directory: 'kenney_nature-kit/Models/GLTF format',
  },
])

/**
 * Выбор. `group` — выходной GLB, `node` — имя узла в нём. Глыбы толщи (`cliff`)
 * — те же крупные камни Quaternius, что и у кромки: отдельная запись задаёт роль,
 * а байты не дублируются (общий узел).
 */
export const LANDSCAPE_SELECTION = Object.freeze([
  { key: 'rock-medium-1', role: 'rock', group: 'rocks', node: 'rock-medium-1', sourceId: 'quaternius-stylized-nature-megakit-standard', file: 'Rock_Medium_1.gltf' },
  { key: 'rock-medium-2', role: 'rock', group: 'rocks', node: 'rock-medium-2', sourceId: 'quaternius-stylized-nature-megakit-standard', file: 'Rock_Medium_2.gltf' },
  { key: 'rock-medium-3', role: 'rock', group: 'rocks', node: 'rock-medium-3', sourceId: 'quaternius-stylized-nature-megakit-standard', file: 'Rock_Medium_3.gltf' },
  { key: 'rock-slab-1', role: 'rock', group: 'slabs', node: 'rock-slab-1', sourceId: 'quaternius-stylized-nature-megakit-standard', file: 'Pebble_Square_1.gltf' },
  { key: 'rock-slab-5', role: 'rock', group: 'slabs', node: 'rock-slab-5', sourceId: 'quaternius-stylized-nature-megakit-standard', file: 'Pebble_Square_5.gltf' },
  { key: 'cliff-medium-1', role: 'cliff', group: 'rocks', node: 'rock-medium-1', sourceId: 'quaternius-stylized-nature-megakit-standard', file: 'Rock_Medium_1.gltf' },
  { key: 'cliff-medium-3', role: 'cliff', group: 'rocks', node: 'rock-medium-3', sourceId: 'quaternius-stylized-nature-megakit-standard', file: 'Rock_Medium_3.gltf' },
  { key: 'lily-large', role: 'lily', group: 'water', node: 'lily-large', sourceId: 'kenney-nature-kit', file: 'lily_large.glb' },
  { key: 'lily-small', role: 'lily', group: 'water', node: 'lily-small', sourceId: 'kenney-nature-kit', file: 'lily_small.glb' },
  { key: 'reed-wispy', role: 'reed', group: 'water', node: 'reed-wispy', sourceId: 'quaternius-stylized-nature-megakit-standard', file: 'Grass_Wispy_Tall.gltf' },
  { key: 'reed-common', role: 'reed', group: 'water', node: 'reed-common', sourceId: 'quaternius-stylized-nature-megakit-standard', file: 'Grass_Common_Tall.gltf' },
  { key: 'bridge-wood', role: 'bridge', group: 'bridge', node: 'bridge-wood', sourceId: 'kenney-nature-kit', file: 'bridge_wood.glb' },
])

/**
 * Палитра Kenney для местности (sRGB). Nature Kit красит плоскими цветами с
 * metallic=1; доска приглушает их под текстурированный камень Quaternius.
 * У моста «stone» — настил, поэтому он деревянный, а не серый.
 */
export const KENNEY_LANDSCAPE_SRGB = Object.freeze({
  woodBark: '#4e3423',
  wood: '#6f4c2f',
  stone: '#866444',
  stoneDark: '#4a3a2c',
  leafsGreen: '#4f7a33',
  leafsDark: '#38552a',
  colorRed: '#c4687a',
})

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const align4 = (value) => (value + 3) & ~3

function srgbToLinear(channel) {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function linearColor(hex) {
  const value = hex.replace(/^#/u, '')
  return [0, 2, 4].map((offset) => srgbToLinear(Number.parseInt(value.slice(offset, offset + 2), 16))).concat(1)
}

/** Разбирает GLB 2 на JSON и BIN. */
export function parseGlb(bytes, file = '<glb>') {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error(`Ожидался GLB 2: ${file}`)
  let offset = 12, json = null, binary = Buffer.alloc(0)
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8').replace(/[\u0000 ]+$/gu, ''))
    else if (type === 0x004e4942) binary = Buffer.from(body)
    offset += 8 + length
  }
  if (!json) throw new Error(`Нет JSON в GLB: ${file}`)
  return { json, binary }
}

export function writeGlb(json, binary) {
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

/** Kenney: свои цвета, металличность 0, шероховатость 1. Неизвестный материал — ошибка. */
function recolorKenney(json, file) {
  for (const material of json.materials ?? []) {
    const hex = KENNEY_LANDSCAPE_SRGB[String(material.name ?? '')]
    if (!hex) throw new Error(`Нет цвета для материала Kenney ${material.name} в ${file}`)
    const pbr = material.pbrMetallicRoughness ?? (material.pbrMetallicRoughness = {})
    pbr.baseColorFactor = linearColor(hex)
    pbr.metallicFactor = 0
    pbr.roughnessFactor = 1
  }
}

/**
 * Сливает самодостаточные GLB в один. Узлы каждой части собираются под узлом с
 * именем `node`; одинаковые изображения (общая текстура камня) хранятся один раз.
 * Берутся только узлы сцены: служебный родитель Kenney вне сцены отбрасывается.
 */
export function mergeGlbParts(parts) {
  const out = { asset: { version: '2.0', generator: 'skazanie build-landscape-kit' }, scene: 0, scenes: [{ name: 'landscape', nodes: [] }],
    nodes: [], meshes: [], materials: [], textures: [], samplers: [], images: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] }
  const chunks = []
  let length = 0
  const imageByHash = new Map(), samplerByJson = new Map(), textureByJson = new Map(), materialByJson = new Map()
  const extensions = new Set()
  const pushBytes = (bytes) => {
    const aligned = align4(length)
    if (aligned > length) chunks.push(Buffer.alloc(aligned - length))
    chunks.push(bytes)
    length = aligned + bytes.length
    return aligned
  }
  for (const part of parts) {
    const { json, binary } = part
    for (const name of json.extensionsUsed ?? []) extensions.add(name)
    const viewBytes = (index) => {
      const view = json.bufferViews[index]
      return binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    }
    const viewMap = new Map()
    const mapView = (index) => {
      if (!viewMap.has(index)) {
        const view = json.bufferViews[index]
        const copy = { buffer: 0, byteOffset: pushBytes(viewBytes(index)), byteLength: view.byteLength }
        if (view.byteStride) copy.byteStride = view.byteStride
        if (view.target) copy.target = view.target
        out.bufferViews.push(copy)
        viewMap.set(index, out.bufferViews.length - 1)
      }
      return viewMap.get(index)
    }
    const accessorMap = new Map()
    const mapAccessor = (index) => {
      if (!accessorMap.has(index)) {
        const accessor = { ...json.accessors[index] }
        if (accessor.sparse) throw new Error('Разреженные accessor не поддерживаются')
        if (accessor.bufferView != null) accessor.bufferView = mapView(accessor.bufferView)
        out.accessors.push(accessor)
        accessorMap.set(index, out.accessors.length - 1)
      }
      return accessorMap.get(index)
    }
    const mapImage = (index) => {
      const image = json.images[index]
      const bytes = viewBytes(image.bufferView)
      const key = sha(bytes)
      if (!imageByHash.has(key)) {
        const view = out.bufferViews.push({ buffer: 0, byteOffset: pushBytes(bytes), byteLength: bytes.length }) - 1
        imageByHash.set(key, out.images.push({ name: image.name ?? `image-${out.images.length}`, mimeType: image.mimeType, bufferView: view }) - 1)
      }
      return imageByHash.get(key)
    }
    const dedupe = (list, cache, value) => {
      const key = JSON.stringify(value)
      if (!cache.has(key)) cache.set(key, list.push(value) - 1)
      return cache.get(key)
    }
    const mapTexture = (index) => {
      const texture = { ...json.textures[index] }
      if (texture.source != null) texture.source = mapImage(texture.source)
      if (texture.sampler != null) texture.sampler = dedupe(out.samplers, samplerByJson, { ...json.samplers[texture.sampler] })
      return dedupe(out.textures, textureByJson, texture)
    }
    const materialMap = new Map()
    const mapMaterial = (index) => {
      if (!materialMap.has(index)) {
        const material = structuredClone(json.materials[index])
        const pbr = material.pbrMetallicRoughness ?? {}
        for (const slot of [pbr.baseColorTexture, pbr.metallicRoughnessTexture, material.normalTexture, material.occlusionTexture, material.emissiveTexture]) {
          if (slot && typeof slot.index === 'number') slot.index = mapTexture(slot.index)
        }
        materialMap.set(index, dedupe(out.materials, materialByJson, material))
      }
      return materialMap.get(index)
    }
    const meshMap = new Map()
    const mapMesh = (index) => {
      if (!meshMap.has(index)) {
        const mesh = json.meshes[index]
        const primitives = mesh.primitives.map((primitive) => {
          if (primitive.targets) throw new Error('Морф-цели не поддерживаются')
          const copy = { attributes: Object.fromEntries(Object.entries(primitive.attributes).map(([name, accessor]) => [name, mapAccessor(accessor)])) }
          if (primitive.indices != null) copy.indices = mapAccessor(primitive.indices)
          if (primitive.material != null) copy.material = mapMaterial(primitive.material)
          if (primitive.mode != null) copy.mode = primitive.mode
          return copy
        })
        meshMap.set(index, out.meshes.push({ name: mesh.name ?? part.node, primitives }) - 1)
      }
      return meshMap.get(index)
    }
    const mapNode = (index) => {
      const node = json.nodes[index]
      if (node.skin != null || node.camera != null) throw new Error('Скины и камеры в наборе местности не поддерживаются')
      const copy = {}
      if (node.name) copy.name = node.name
      for (const key of ['translation', 'rotation', 'scale', 'matrix']) if (node[key]) copy[key] = node[key]
      if (node.mesh != null) copy.mesh = mapMesh(node.mesh)
      const at = out.nodes.push(copy) - 1
      if (node.children?.length) copy.children = node.children.map(mapNode)
      return at
    }
    const roots = json.scenes[json.scene ?? 0].nodes
    const wrapper = out.nodes.push({ name: part.node, children: [] }) - 1
    out.nodes[wrapper].children = roots.map(mapNode)
    out.scenes[0].nodes.push(wrapper)
  }
  out.buffers[0].byteLength = length
  if (extensions.size) out.extensionsUsed = [...extensions].sort()
  for (const key of ['textures', 'samplers', 'images']) if (!out[key].length) delete out[key]
  return writeGlb(out, Buffer.concat(chunks, length))
}

/** Файлы исходника, прочитанные ради модели: .gltf, .bin и PNG рядом. */
async function sourceInputs(file) {
  const files = [file]
  if (extname(file).toLowerCase() === '.gltf') {
    const json = JSON.parse(await readFile(file, 'utf8'))
    for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
      if (typeof item.uri === 'string' && !item.uri.startsWith('data:')) files.push(join(dirname(file), decodeURIComponent(item.uri)))
    }
  }
  return files
}

async function verifyArchive(srcDir, source) {
  const path = join(srcDir, source.archive)
  if (!existsSync(path)) return { archive: source.archive, verified: false }
  const actual = sha(await readFile(path))
  if (actual !== source.archiveSha256) throw new Error(`SHA-256 архива ${source.archive} не совпадает: ${actual}`)
  return { archive: source.archive, verified: true }
}

export async function buildLandscapeKit({ srcDir = join(ROOT, 'tmp/asset-src'), outDir = join(ROOT, 'public/assets/models/landscape'), dryRun = false } = {}) {
  const sources = new Map(LANDSCAPE_SOURCES.map((source) => [source.id, source]))
  const archives = await Promise.all(LANDSCAPE_SOURCES.map((source) => verifyArchive(srcDir, source)))
  const work = await mkdtemp(join(tmpdir(), 'landscape-kit-'))
  try {
    const inputs = new Map()
    const groups = new Map()
    for (const entry of LANDSCAPE_SELECTION) {
      const parts = groups.get(entry.group) ?? []
      groups.set(entry.group, parts)
      if (parts.some((part) => part.node === entry.node)) continue
      const source = sources.get(entry.sourceId)
      if (!source) throw new Error(`Неизвестный источник ${entry.sourceId}`)
      const file = join(srcDir, source.directory, entry.file)
      for (const input of await sourceInputs(file)) {
        const bytes = await readFile(input)
        inputs.set(input, { sourceId: source.id, path: relative(srcDir, input).split('\\').join('/'), sha256: sha(bytes), bytes: bytes.length })
      }
      const converted = join(work, `${entry.node}.glb`)
      await convert(file, converted)
      const parsed = parseGlb(await readFile(converted), converted)
      if (source.id === 'kenney-nature-kit') recolorKenney(parsed.json, entry.file)
      parts.push({ node: entry.node, ...parsed })
    }
    const files = new Map()
    for (const [group, parts] of groups) files.set(`${group}.glb`, mergeGlbParts(parts))
    const total = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0)
    if (total > MAX_KIT_BYTES) throw new Error(`Набор местности ${total} байт превышает ${MAX_KIT_BYTES}`)
    const fileHashes = Object.fromEntries([...files].map(([name, bytes]) => [name, sha(bytes)]))
    const revision = sha(Buffer.from(JSON.stringify({ selection: LANDSCAPE_SELECTION, fileHashes }))).slice(0, 16)
    const prefix = `${LANDSCAPE_URL_ROOT}${revision}/`
    const manifest = {
      version: 1,
      schema: 'landscape-kit/v1',
      revision,
      models: LANDSCAPE_SELECTION.map((entry) => {
        const source = sources.get(entry.sourceId)
        return {
          key: entry.key, role: entry.role, url: `${prefix}${entry.group}.glb`, node: entry.node,
          source: `${source.directory.split('/')[0]}/${entry.file}`, sourceId: entry.sourceId, license: source.license,
          sha256: fileHashes[`${entry.group}.glb`],
        }
      }),
    }
    const notice = {
      schema: 'landscape-kit-notice/v1',
      revision,
      generator: 'tools/build-landscape-kit.mjs',
      processing: 'Текстуры уменьшены до 512 px и встроены в GLB; модели одной группы слиты в один файл, общая текстура хранится один раз; '
        + 'цвета Kenney заменены палитрой местности (metallic 0, roughness 1). Геометрия не изменялась.',
      sources: LANDSCAPE_SOURCES.map((source) => ({
        id: source.id, author: source.author, url: source.url, license: source.license,
        archive: source.archive, archiveSha256: source.archiveSha256,
        archiveVerified: archives.find((item) => item.archive === source.archive)?.verified ?? false,
      })),
      inputs: [...inputs.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      files: [...files].map(([name, bytes]) => ({ path: name, sha256: fileHashes[name], bytes: bytes.length })),
    }
    const summary = { revision, files: notice.files, totalBytes: total, models: manifest.models.length }
    if (dryRun) return summary
    const directory = join(outDir, revision)
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    if (existsSync(join(directory, 'manifest.json'))) {
      const existing = await readFile(join(directory, 'manifest.json'))
      if (!existing.equals(manifestBytes)) throw new Error(`Неизменяемая ревизия ${revision} уже существует с другим содержимым`)
    } else {
      await mkdir(directory, { recursive: true })
      for (const [name, bytes] of files) await writeFile(join(directory, name), bytes)
      await writeFile(join(directory, 'NOTICE.json'), `${JSON.stringify(notice, null, 2)}\n`)
      await writeFile(join(directory, 'manifest.json'), manifestBytes)
    }
    // Активный указатель: клиент читает его без кэша и идёт в неизменяемую ревизию.
    await writeFile(join(outDir, 'manifest.json'), manifestBytes)
    return { ...summary, directory }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function main() {
  const { values } = parseArgs({ options: { src: { type: 'string' }, out: { type: 'string' }, 'dry-run': { type: 'boolean' } } })
  const result = await buildLandscapeKit({
    srcDir: values.src ? resolve(values.src) : undefined,
    outDir: values.out ? resolve(values.out) : undefined,
    dryRun: values['dry-run'],
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1 })
}

