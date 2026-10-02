/** Экспорт 64 оригинальных low-poly моделей заказа детализации в автономные GLB. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { encodePng } from './png-codec.mjs'
import { inspectModelFile } from './import-environment-models.mjs'
import * as workshop from './map-detail-models-workshop.mjs'
import * as household from './map-detail-models-household.mjs'
import * as town from './map-detail-models-town.mjs'
import * as dungeon from './map-detail-models-dungeon.mjs'

const factories = [workshop, household, town, dungeon]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pad = (bytes, value = 0) => Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4, value)])

function ensureFileReader() {
  if (typeof globalThis.FileReader === 'function') return
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.() }, error => { this.error = error; this.onerror?.(error) })
    }
  }
}

/** Палитра встроена в GLB: один материал и одна небольшая PNG-текстура. */
function embedPalette(bytes, image) {
  const jsonLength = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength))
  const binary = bytes.subarray(28 + jsonLength)
  const png = encodePng(image)
  const nextBinary = pad(Buffer.concat([binary, png]))
  json.bufferViews.push({ buffer: 0, byteOffset: binary.length, byteLength: png.length })
  json.images = [{ name: 'map-detail-palette-v1', bufferView: json.bufferViews.length - 1, mimeType: 'image/png' }]
  json.samplers = [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }]
  json.textures = [{ source: 0, sampler: 0 }]
  json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 }
  json.buffers[0].byteLength = nextBinary.length
  const encodedJson = pad(Buffer.from(JSON.stringify(json)), 32)
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + encodedJson.length + nextBinary.length, 8)
  header.writeUInt32LE(encodedJson.length, 12)
  header.writeUInt32LE(0x4e4f534a, 16)
  const binaryHeader = Buffer.alloc(8)
  binaryHeader.writeUInt32LE(nextBinary.length, 0)
  binaryHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, encodedJson, binaryHeader, nextBinary])
}

export function createMapDetailModel(id) {
  const matching = factories.filter(factory => factory.MODEL_IDS.includes(id))
  if (matching.length !== 1) throw new Error(`Модель должна иметь единственного автора рецепта: ${id}`)
  return matching[0].createModel(id)
}

/** Сохраняет силуэт рецепта, приводит границы к заданным метрам и основание к Y=0. */
function prepareModel(spec) {
  const root = createMapDetailModel(spec.id)
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root, true)
  const size = bounds.getSize(new THREE.Vector3())
  if (![size.x, size.y, size.z].every(value => Number.isFinite(value) && value > 0)) throw new Error(`Пустая модель: ${spec.id}`)
  const [width, depth, height] = spec.dimensions
  if (spec.dimensions.length !== 3 || ![width, depth, height].every(value => Number.isFinite(value) && value > 0)) throw new Error(`Некорректные размеры: ${spec.id}`)
  root.scale.set(width / size.x, height / size.y, depth / size.z)
  root.updateMatrixWorld(true)
  const fitted = new THREE.Box3().setFromObject(root, true)
  root.position.set(-(fitted.min.x + fitted.max.x) / 2, -fitted.min.y, -(fitted.min.z + fitted.max.z) / 2)
  root.updateMatrixWorld(true)
  const meshes = [], colors = []
  root.traverse(object => {
    if (!object.isMesh) return
    if (Array.isArray(object.material)) throw new Error(`Ожидался один цвет на примитив: ${spec.id}`)
    const color = object.material.color.getHex()
    if (!colors.includes(color)) colors.push(color)
    meshes.push({ object, color })
  })
  const side = Math.max(2, Math.ceil(Math.sqrt(colors.length)))
  const palette = { width: side, height: side, data: new Uint8Array(side * side * 4) }
  for (let index = 0; index < side * side; index++) {
    const color = colors[index] ?? colors[0]
    palette.data.set([color >> 16 & 255, color >> 8 & 255, color & 255, 255], index * 4)
  }
  const geometries = meshes.map(({ object, color }) => {
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()
    geometry.applyMatrix4(object.matrixWorld)
    for (const attribute of Object.keys(geometry.attributes)) if (!['position', 'normal'].includes(attribute)) geometry.deleteAttribute(attribute)
    if (!geometry.attributes.normal) geometry.computeVertexNormals()
    const index = colors.indexOf(color)
    const uv = new Float32Array(geometry.attributes.position.count * 2)
    for (let vertex = 0; vertex < uv.length / 2; vertex++) {
      uv[vertex * 2] = (index % side + .5) / side
      uv[vertex * 2 + 1] = (Math.floor(index / side) + .5) / side
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    return geometry
  })
  const merged = mergeGeometries(geometries, false)
  if (!merged) throw new Error(`Несовместимые примитивы: ${spec.id}`)
  const triangles = merged.attributes.position.count / 3
  if (triangles > 4000) throw new Error(`Лимит 4000 треугольников: ${spec.id}, получено ${triangles}`)
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .9, metalness: 0 }))
  mesh.name = spec.id
  mesh.userData = { assetId: spec.id, units: 'meters', front: '-Z', origin: 'base-center', recipe: 'map-detail-v1' }
  geometries.forEach(geometry => geometry.dispose())
  root.traverse(object => { if (object.isMesh) object.geometry.dispose() })
  return { mesh, palette, triangles }
}

export async function buildMapDetailModels({ models, outputDir }) {
  ensureFileReader()
  const dir = join(outputDir, 'models')
  await mkdir(dir, { recursive: true })
  const records = []
  for (const spec of models) {
    const { mesh, palette, triangles } = prepareModel(spec)
    try {
      const result = await new GLTFExporter().parseAsync(mesh, { binary: true, onlyVisible: true })
      const bytes = embedPalette(Buffer.from(result), palette)
      const file = `models/${spec.id}.glb`
      await writeFile(join(outputDir, file), bytes)
      const checked = await inspectModelFile(join(outputDir, file))
      if (checked.json.animations?.length || checked.json.skins?.length || checked.json.materials.length !== 1) throw new Error(`Нарушен контракт статического GLB: ${spec.id}`)
      records.push({ id: spec.id, file, dimensions: spec.dimensions, triangles, textureSize: [palette.width, palette.height], sha256: checked.sha256, bytes: checked.bytes, method: 'authored-low-poly' })
    } finally { mesh.geometry.dispose(); mesh.material.dispose() }
  }
  return records
}

export async function mapDetailModelSources() {
  const files = ['build-map-detail-models.mjs', 'map-detail-model-helpers.mjs', 'map-detail-models-workshop.mjs', 'map-detail-models-household.mjs', 'map-detail-models-town.mjs', 'map-detail-models-dungeon.mjs']
  return Promise.all(files.map(async file => {
    const bytes = await readFile(new URL(file, import.meta.url))
    return { file: `tools/${file}`, sha256: hash(bytes), bytes: bytes.length }
  }))
}
