/** Экспорт детализированных моделей с UV и PBR-материалами в автономные GLB. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { loadModelMaterialAtlas, compactModelMaterialAtlas } from './map-detail-model-textures.mjs'
import { inspectModelFile } from './import-environment-models.mjs'
import * as workshop from './map-detail-models-workshop.mjs'
import * as household from './map-detail-models-household.mjs'
import * as town from './map-detail-models-town.mjs'
import * as dungeon from './map-detail-models-dungeon.mjs'
import * as mineCamp from './map-detail-models-mine-camp.mjs'
import * as urbanWilderness from './map-detail-models-urban-wilderness.mjs'

const factories = [workshop, household, town, dungeon, mineCamp, urbanWilderness]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pad = (bytes, value = 0) => Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4, value)])
export const MODEL_TRIANGLE_BUDGET = 50000

function ensureFileReader() {
  if (typeof globalThis.FileReader === 'function') return
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.() }, error => { this.error = error; this.onerror?.(error) })
    }
  }
}

/** Три карты PBR встроены в GLB; внешних файлов для загрузки модели не нужно. */
function embedMaterialMaps(bytes, atlas) {
  const jsonLength = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength))
  const binary = bytes.subarray(28 + jsonLength)
  let nextBinary = Buffer.from(binary)
  json.images = []
  json.textures = []
  json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }]
  for (const [name, png] of [['base-color', atlas.baseColor], ['normal', atlas.normal], ['orm', atlas.orm]]) {
    const byteOffset = nextBinary.length
    nextBinary = pad(Buffer.concat([nextBinary, png]))
    json.bufferViews.push({ buffer: 0, byteOffset, byteLength: png.length })
    json.images.push({ name: `map-detail-${name}`, bufferView: json.bufferViews.length - 1, mimeType: 'image/png' })
    json.textures.push({ source: json.images.length - 1, sampler: 0 })
  }
  const material = json.materials[0]
  material.pbrMetallicRoughness.baseColorTexture = { index: 0 }
  material.pbrMetallicRoughness.metallicRoughnessTexture = { index: 2 }
  material.normalTexture = { index: 1, scale: .45 }
  material.occlusionTexture = { index: 2, strength: .5 }
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
function prepareModel(spec, atlas) {
  const root = createMapDetailModel(spec.id)
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root, true)
  const size = bounds.getSize(new THREE.Vector3())
  if (![size.x, size.y, size.z].every(value => Number.isFinite(value) && value > 0)) throw new Error(`Пустая модель: ${spec.id}`)
  const [width, depth, height] = spec.dimensions
  if (spec.dimensions.length !== 3 || ![width, depth, height].every(value => Number.isFinite(value) && value > 0)) throw new Error(`Некорректные размеры: ${spec.id}`)
  root.scale.multiply(new THREE.Vector3(width / size.x, height / size.y, depth / size.z))
  root.updateMatrixWorld(true)
  const fitted = new THREE.Box3().setFromObject(root, true)
  root.position.add(new THREE.Vector3(-(fitted.min.x + fitted.max.x) / 2, -fitted.min.y, -(fitted.min.z + fitted.max.z) / 2))
  root.updateMatrixWorld(true)
  const meshes = []
  root.traverse(object => {
    if (!object.isMesh) return
    if (Array.isArray(object.material)) throw new Error(`Ожидался один цвет на примитив: ${spec.id}`)
    meshes.push(object)
  })
  atlas = compactModelMaterialAtlas(atlas, meshes.map(object => object.material.name).filter(kind => Object.hasOwn(atlas.rects, kind)))
  const geometries = meshes.map(object => {
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()
    geometry.applyMatrix4(object.matrixWorld)
    for (const attribute of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv'].includes(attribute)) geometry.deleteAttribute(attribute)
    if (!geometry.attributes.normal) geometry.computeVertexNormals()
    const sourceUv = geometry.attributes.uv
    const rect = atlas.rects[object.material.name]
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity
    if (sourceUv) for (let vertex = 0; vertex < sourceUv.count; vertex++) {
      minU = Math.min(minU, sourceUv.getX(vertex)); maxU = Math.max(maxU, sourceUv.getX(vertex))
      minV = Math.min(minV, sourceUv.getY(vertex)); maxV = Math.max(maxV, sourceUv.getY(vertex))
    }
    const normalizeUv = minU < 0 || minV < 0 || maxU > 1 || maxV > 1
    geometry.computeBoundingBox()
    const box = geometry.boundingBox, size = box.getSize(new THREE.Vector3())
    const uv = new Float32Array(geometry.attributes.position.count * 2)
    const colors = new Float32Array(geometry.attributes.position.count * 3)
    const tint = object.material.color.toArray()
    for (let vertex = 0; vertex < uv.length / 2; vertex++) {
      let u, v
      if (sourceUv) {
        u = normalizeUv ? (sourceUv.getX(vertex) - minU) / (maxU - minU || 1) : sourceUv.getX(vertex)
        v = normalizeUv ? (sourceUv.getY(vertex) - minV) / (maxV - minV || 1) : sourceUv.getY(vertex)
      } else {
        const pos = geometry.attributes.position, normal = geometry.attributes.normal
        const x = (pos.getX(vertex) - box.min.x) / (size.x || 1), y = (pos.getY(vertex) - box.min.y) / (size.y || 1), z = (pos.getZ(vertex) - box.min.z) / (size.z || 1)
        const nx = Math.abs(normal.getX(vertex)), ny = Math.abs(normal.getY(vertex)), nz = Math.abs(normal.getZ(vertex))
        if (ny >= nx && ny >= nz) { u = x; v = z } else if (nx >= nz) { u = z; v = y } else { u = x; v = y }
      }
      uv[vertex * 2] = rect ? rect.u0 + u * (rect.u1 - rect.u0) : atlas.flatUv[0]
      uv[vertex * 2 + 1] = rect ? rect.v0 + v * (rect.v1 - rect.v0) : atlas.flatUv[1]
      colors.set(tint, vertex * 3)
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return geometry
  })
  const merged = mergeGeometries(geometries, false)
  if (!merged) throw new Error(`Несовместимые примитивы: ${spec.id}`)
  const triangles = merged.attributes.position.count / 3
  if (triangles > MODEL_TRIANGLE_BUDGET) throw new Error(`Лимит ${MODEL_TRIANGLE_BUDGET} треугольников: ${spec.id}, получено ${triangles}`)
  const indexed = mergeVertices(merged, .000001)
  merged.dispose()
  const mesh = new THREE.Mesh(indexed, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 1, vertexColors: true }))
  mesh.name = spec.id
  mesh.userData = { assetId: spec.id, units: 'meters', front: '-Z', origin: 'base-center', recipe: 'map-detail-quality-v2' }
  geometries.forEach(geometry => geometry.dispose())
  root.traverse(object => { if (object.isMesh) object.geometry.dispose() })
  return { mesh, triangles, atlas }
}

export async function buildMapDetailModels({ models, outputDir, materialDir = 'assets-src/map-detail-materials' }) {
  ensureFileReader()
  const atlas = loadModelMaterialAtlas(materialDir)
  const dir = join(outputDir, 'models')
  await mkdir(dir, { recursive: true })
  const records = []
  for (const spec of models) {
    const { mesh, triangles, atlas: modelAtlas } = prepareModel(spec, atlas)
    try {
      const result = await new GLTFExporter().parseAsync(mesh, { binary: true, onlyVisible: true })
      const bytes = embedMaterialMaps(Buffer.from(result), modelAtlas)
      const file = `models/${spec.id}.glb`
      await writeFile(join(outputDir, file), bytes)
      const checked = await inspectModelFile(join(outputDir, file))
      if (checked.json.animations?.length || checked.json.skins?.length || checked.json.materials.length !== 1) throw new Error(`Нарушен контракт статического GLB: ${spec.id}`)
      records.push({ id: spec.id, file, dimensions: spec.dimensions, triangles, textureSize: modelAtlas.textureSize, sha256: checked.sha256, bytes: checked.bytes, method: 'authored-detailed-pbr', materialSources: atlas.sources })
    } finally { mesh.geometry.dispose(); mesh.material.dispose() }
  }
  return records
}

export async function mapDetailModelSources() {
  const files = ['build-map-detail-models.mjs', 'map-detail-model-textures.mjs', 'map-detail-model-helpers.mjs', 'map-detail-models-workshop.mjs', 'map-detail-models-household.mjs', 'map-detail-models-town.mjs', 'map-detail-models-dungeon.mjs', 'map-detail-models-mine-camp.mjs', 'map-detail-models-urban-wilderness.mjs']
  return Promise.all(files.map(async file => {
    const bytes = await readFile(new URL(file, import.meta.url))
    return { file: `tools/${file}`, sha256: hash(bytes), bytes: bytes.length }
  }))
}
