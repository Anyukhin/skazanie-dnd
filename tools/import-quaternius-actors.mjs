#!/usr/bin/env node
// @ts-check
/** Собирает два staged humanoid-профиля из бесплатных Standard-архивов. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { convert, inspectModelFile, validateCandidateOutputDir } from './import-environment-models.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TMP_ROOT = join(ROOT, 'tmp')
const MAX_TEXTURE_SIDE = 512
const MAX_MODEL_BYTES = 8 * 1024 * 1024
const GLB_MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const SOURCE_ARCHIVES = Object.freeze({
  base: {
    id: 'universal-base-characters-standard',
    author: 'Quaternius',
    url: 'https://quaternius.com/packs/universalbasecharacters.html',
    archive: 'Universal-Base-Characters-Standard.zip',
    sha256: 'FDBF1804C90DFC1EA03E992BFF7DA2DFD1A79318E13270A660180F9308455F40',
    license: 'CC0-1.0',
  },
  outfits: {
    id: 'modular-character-outfits-fantasy-standard',
    author: 'Quaternius',
    url: 'https://quaternius.com/packs/modularcharacteroutfitsfantasy.html',
    archive: 'Modular-Character-Outfits-Fantasy-Standard.zip',
    sha256: 'C3468B18871CC8C8F05AB14DF7712BAF22CB9F389CBD870BABF130E595187F70',
    license: 'CC0-1.0',
  },
  animations: {
    id: 'universal-animation-library-standard',
    author: 'Quaternius',
    url: 'https://quaternius.itch.io/universal-animation-library',
    archive: 'Universal-Animation-Library-Standard.zip',
    sha256: 'CC73FC4E495B82958207316596317A3F40B9FA38065BDE1027937452DA537724',
    license: 'CC0-1.0',
  },
})

const DEFAULTS = {
  out: join(TMP_ROOT, 'quaternius-actor-candidate'),
  baseDir: join(TMP_ROOT, 'quaternius-actors-standard-20260911', 'extracted', 'Universal-Base-Characters-Standard', 'Universal Base Characters[Standard]', 'Base Characters', 'Godot - UE'),
  outfitDir: join(TMP_ROOT, 'quaternius-actors-standard-20260911', 'extracted', 'Modular-Character-Outfits-Fantasy-Standard', 'Modular Character Outfits - Fantasy[Standard]', 'Exports', 'glTF (Godot-Unreal)', 'Outfits'),
  ualFile: join(TMP_ROOT, 'quaternius-actors-standard-20260911', 'extracted', 'Universal-Animation-Library-Standard', 'Universal Animation Library[Standard]', 'Unreal-Godot', 'UAL1_Standard.glb'),
  baseArchive: join(TMP_ROOT, 'quaternius-actors-standard-20260911', SOURCE_ARCHIVES.base.archive),
  outfitArchive: join(TMP_ROOT, 'quaternius-actors-standard-20260911', SOURCE_ARCHIVES.outfits.archive),
  animationArchive: join(TMP_ROOT, 'quaternius-actors-standard-20260911', SOURCE_ARCHIVES.animations.archive),
}

const PROFILES = Object.freeze([
  { key: 'traveler', label: 'Путник', outfit: 'Male_Peasant.gltf', file: 'traveler.glb' },
  { key: 'ranger', label: 'Следопыт', outfit: 'Male_Ranger.gltf', file: 'ranger.glb' },
])
const CLIP_NAMES = Object.freeze(['Idle_Loop', 'Walk_Loop', 'Sword_Attack', 'Spell_Simple_Shoot', 'Hit_Chest', 'Death01'])

function align4(value) { return (value + 3) & ~3 }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }

function parseGlb(source, file) {
  if (source.length < 20 || source.readUInt32LE(0) !== GLB_MAGIC || source.readUInt32LE(4) !== 2) throw new Error(`Ожидался GLB 2: ${file}`)
  const declaredLength = source.readUInt32LE(8)
  if (declaredLength !== source.length) throw new Error(`Размер GLB не совпадает: ${file}`)
  let offset = 12
  let json = null
  let binary = Buffer.alloc(0)
  while (offset + 8 <= declaredLength) {
    const length = source.readUInt32LE(offset)
    const type = source.readUInt32LE(offset + 4)
    offset += 8
    const end = offset + length
    if (end > declaredLength) throw new Error(`Обрезанный chunk GLB: ${file}`)
    const chunk = source.subarray(offset, end)
    if (type === JSON_CHUNK) json = JSON.parse(chunk.toString('utf8').replace(/[\u0000 ]+$/gu, ''))
    else if (type === BIN_CHUNK) binary = Buffer.from(chunk)
    offset = end
  }
  if (!json || !Array.isArray(json.buffers) || json.buffers.length !== 1) throw new Error(`GLB без одного buffer: ${file}`)
  if (binary.length < (json.buffers[0].byteLength ?? 0)) throw new Error(`BIN короче заявленного: ${file}`)
  return { json, binary }
}

function writeGlb(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json))
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)])
  const paddedBinary = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(GLB_MAGIC, 0); header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + paddedBinary.length, 8)
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(paddedJson.length, 0); jsonHeader.writeUInt32LE(JSON_CHUNK, 4)
  const binaryHeader = Buffer.alloc(8); binaryHeader.writeUInt32LE(paddedBinary.length, 0); binaryHeader.writeUInt32LE(BIN_CHUNK, 4)
  return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, paddedBinary])
}

function sourceView(source, accessorId) {
  const accessor = source.json.accessors?.[accessorId]
  const view = accessor && source.json.bufferViews?.[accessor.bufferView]
  if (!accessor || !view || accessor.sparse || !Number.isInteger(view.byteOffset) && view.byteOffset !== undefined) throw new Error(`Некорректный accessor ${accessorId}`)
  const componentBytes = COMPONENT_BYTES[accessor.componentType]
  const components = COMPONENTS[accessor.type]
  if (!componentBytes || !components) throw new Error(`Неподдерживаемый accessor ${accessorId}`)
  const elementBytes = componentBytes * components
  const stride = view.byteStride ?? elementBytes
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  if (start < 0 || start + Math.max(0, accessor.count - 1) * stride + elementBytes > source.binary.length) throw new Error(`Accessor выходит за BIN: ${accessorId}`)
  return { accessor, view, componentBytes, components, elementBytes, stride, start }
}

function readComponent(view, offset, componentType) {
  if (componentType === 5120) return view.getInt8(offset)
  if (componentType === 5121) return view.getUint8(offset)
  if (componentType === 5122) return view.getInt16(offset, true)
  if (componentType === 5123) return view.getUint16(offset, true)
  if (componentType === 5125) return view.getUint32(offset, true)
  if (componentType === 5126) return view.getFloat32(offset, true)
  throw new Error(`Неподдерживаемый componentType ${componentType}`)
}

function readAccessor(source, accessorId) {
  const info = sourceView(source, accessorId)
  const view = new DataView(source.binary.buffer, source.binary.byteOffset, source.binary.byteLength)
  return Array.from({ length: info.accessor.count }, (_, index) => Array.from({ length: info.components }, (_, component) => (
    readComponent(view, info.start + index * info.stride + component * info.componentBytes, info.accessor.componentType)
  )))
}

function appendView(state, bytes, extra = {}) {
  const offset = align4(state.binaryLength)
  if (offset > state.binaryLength) state.chunks.push(Buffer.alloc(offset - state.binaryLength))
  const value = Buffer.from(bytes)
  state.chunks.push(value)
  state.binaryLength = offset + value.length
  const index = state.json.bufferViews.length
  state.json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: value.length, ...extra })
  return index
}

function copyAccessor(state, source, accessorId, indices, { withBounds = false } = {}) {
  const info = sourceView(source, accessorId)
  const data = Buffer.alloc(info.elementBytes * indices.length)
  const dataView = withBounds ? new DataView(source.binary.buffer, source.binary.byteOffset, source.binary.byteLength) : null
  const min = withBounds ? Array(info.components).fill(Infinity) : null
  const max = withBounds ? Array(info.components).fill(-Infinity) : null
  for (const [position, index] of indices.entries()) {
    if (!Number.isInteger(index) || index < 0 || index >= info.accessor.count) throw new Error(`Индекс accessor вне диапазона: ${accessorId}`)
    const from = info.start + index * info.stride
    source.binary.copy(data, position * info.elementBytes, from, from + info.elementBytes)
    if (dataView && min && max) for (let component = 0; component < info.components; component += 1) {
      const value = readComponent(dataView, from + component * info.componentBytes, info.accessor.componentType)
      min[component] = Math.min(min[component], value)
      max[component] = Math.max(max[component], value)
    }
  }
  const result = structuredClone(info.accessor)
  delete result.min; delete result.max; delete result.sparse
  if (min && max) { result.min = min; result.max = max }
  result.bufferView = appendView(state, data)
  result.byteOffset = 0
  result.count = indices.length
  const index = state.json.accessors.length
  state.json.accessors.push(result)
  return index
}

function copyWholeAccessor(state, source, accessorId, cache) {
  if (cache.has(accessorId)) return cache.get(accessorId)
  const info = sourceView(source, accessorId)
  const result = copyAccessor(state, source, accessorId, Array.from({ length: info.accessor.count }, (_, index) => index))
  cache.set(accessorId, result)
  return result
}

function createResourceCopier(state, source) {
  const samplers = new Map()
  const images = new Map()
  const textures = new Map()
  const materials = new Map()
  const copySampler = (id) => {
    if (id == null) return id
    if (samplers.has(id)) return samplers.get(id)
    const value = source.json.samplers?.[id]
    if (!value) throw new Error(`Нет sampler ${id}`)
    const result = state.json.samplers.push(structuredClone(value)) - 1
    samplers.set(id, result)
    return result
  }
  const copyImage = (id) => {
    if (images.has(id)) return images.get(id)
    const value = source.json.images?.[id]
    if (!value || !Number.isInteger(value.bufferView)) throw new Error(`Изображение без embedded bufferView ${id}`)
    const view = source.json.bufferViews[value.bufferView]
    const start = view?.byteOffset ?? 0
    const end = start + (view?.byteLength ?? 0)
    if (!view || end > source.binary.length) throw new Error(`Изображение выходит за BIN ${id}`)
    const result = structuredClone(value)
    delete result.uri
    result.bufferView = appendView(state, source.binary.subarray(start, end))
    const index = state.json.images.push(result) - 1
    images.set(id, index)
    return index
  }
  const copyTexture = (id) => {
    if (textures.has(id)) return textures.get(id)
    const value = source.json.textures?.[id]
    if (!value) throw new Error(`Нет texture ${id}`)
    const result = structuredClone(value)
    if (result.sampler != null) result.sampler = copySampler(result.sampler)
    if (result.source != null) result.source = copyImage(result.source)
    const index = state.json.textures.push(result) - 1
    textures.set(id, index)
    return index
  }
  const copyTextureInfo = (value) => value && Number.isInteger(value.index) ? { ...value, index: copyTexture(value.index) } : value
  const copyMaterial = (id) => {
    if (materials.has(id)) return materials.get(id)
    const value = source.json.materials?.[id]
    if (!value) throw new Error(`Нет material ${id}`)
    const result = structuredClone(value)
    if (result.pbrMetallicRoughness) {
      for (const key of ['baseColorTexture', 'metallicRoughnessTexture']) result.pbrMetallicRoughness[key] = copyTextureInfo(result.pbrMetallicRoughness[key])
    }
    for (const key of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) result[key] = copyTextureInfo(result[key])
    const index = state.json.materials.push(result) - 1
    materials.set(id, index)
    return index
  }
  return { copyMaterial }
}

function copyIndexAccessor(state, values) {
  const max = Math.max(0, ...values)
  const componentType = max <= 0xff ? 5121 : max <= 0xffff ? 5123 : 5125
  const bytesPer = COMPONENT_BYTES[componentType]
  const data = Buffer.alloc(values.length * bytesPer)
  values.forEach((value, index) => {
    if (componentType === 5121) data.writeUInt8(value, index)
    else if (componentType === 5123) data.writeUInt16LE(value, index * 2)
    else data.writeUInt32LE(value, index * 4)
  })
  const result = { bufferView: appendView(state, data), componentType, count: values.length, type: 'SCALAR', min: [0], max: [max] }
  const index = state.json.accessors.length
  state.json.accessors.push(result)
  return index
}

function copyPrimitive(state, source, primitive, resources, keepVertex, stats) {
  if ((primitive.mode ?? 4) !== 4) throw new Error('Кандидат поддерживает только треугольные GLTF primitive')
  const positionId = primitive.attributes?.POSITION
  if (!Number.isInteger(positionId)) throw new Error('Primitive без POSITION')
  const position = readAccessor(source, positionId)
  const original = Number.isInteger(primitive.indices)
    ? readAccessor(source, primitive.indices).flat()
    : Array.from({ length: position.length }, (_, index) => index)
  if (original.length % 3) throw new Error('Индексы primitive не образуют треугольники')
  const selected = []
  for (let index = 0; index < original.length; index += 3) {
    const triangle = original.slice(index, index + 3)
    if (triangle.every((vertex) => keepVertex(vertex))) selected.push(...triangle)
  }
  if (!selected.length) return null
  const vertices = [...new Set(selected)]
  if (stats) { stats.triangles += selected.length / 3; stats.vertices += vertices.length }
  const remap = new Map(vertices.map((vertex, index) => [vertex, index]))
  const result = structuredClone(primitive)
  result.attributes = Object.fromEntries(Object.entries(primitive.attributes).map(([name, id]) => [name, copyAccessor(state, source, id, vertices, { withBounds: name === 'POSITION' })]))
  if (primitive.targets) result.targets = primitive.targets.map((target) => Object.fromEntries(Object.entries(target).map(([name, id]) => [name, copyAccessor(state, source, id, vertices)])))
  result.indices = copyIndexAccessor(state, selected.map((vertex) => remap.get(vertex)))
  if (primitive.material != null) result.material = resources.copyMaterial(primitive.material)
  return result
}

function copyMesh(state, source, mesh, resources, keepVertex, name, stats) {
  const primitives = mesh.primitives.map((primitive) => copyPrimitive(state, source, primitive, resources, keepVertex, stats)).filter(Boolean)
  if (!primitives.length) return null
  const result = { ...structuredClone(mesh), name, primitives }
  const index = state.json.meshes.length
  state.json.meshes.push(result)
  return index
}

function nodeByName(document, name) {
  const index = document.json.nodes.findIndex((node) => node.name === name)
  if (index < 0) throw new Error(`Не найден узел ${name}`)
  return { index, node: document.json.nodes[index] }
}

function jointNames(document) {
  const skin = document.json.skins?.[0]
  if (!skin || !Array.isArray(skin.joints)) throw new Error('В GLTF нет skin')
  const names = skin.joints.map((index) => document.json.nodes[index]?.name)
  if (names.some((name) => typeof name !== 'string' || !name)) throw new Error('В skin есть неизвестная кость')
  if (new Set(names).size !== names.length) throw new Error('В skin есть повторная кость')
  return names
}

function bindMatrices(document) {
  const accessorId = document.json.skins?.[0]?.inverseBindMatrices
  if (!Number.isInteger(accessorId)) throw new Error('В GLTF нет inverse bind matrices')
  const values = readAccessor(document, accessorId)
  if (values.some((matrix) => matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value)))) throw new Error('Некорректная inverse bind matrix')
  return values
}

function assertBindMatricesMatch(left, right, label) {
  const leftMatrices = bindMatrices(left)
  const rightMatrices = bindMatrices(right)
  if (leftMatrices.length !== rightMatrices.length) throw new Error(`Несовместимые inverse bind matrices: ${label}`)
  const leftNames = jointNames(left)
  const rightNames = jointNames(right)
  for (const name of ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head']) {
    const leftIndex = leftNames.indexOf(name)
    const rightIndex = rightNames.indexOf(name)
    if (leftIndex < 0 || rightIndex < 0) throw new Error(`Несовместимый root..Head rig: ${label}`)
    for (let value = 0; value < 16; value += 1) {
      if (Math.abs(leftMatrices[leftIndex][value] - rightMatrices[rightIndex][value]) > 1e-6) throw new Error(`Несовместимые inverse bind matrices: ${label}`)
    }
  }
}

function assertRigCompatibility(outfit, base, animation) {
  const names = jointNames(outfit)
  assertBindMatricesMatch(outfit, base, 'outfit/base')
  for (const [label, document] of [['base', base], ['animations', animation]]) {
    const other = jointNames(document)
    if (JSON.stringify(names) !== JSON.stringify(other)) throw new Error(`Несовместимый Humanoid rig: ${label}`)
  }
}

function assertNoRootMotion(document, names) {
  const root = nodeByName(document, 'root').index
  for (const name of names) {
    const clip = document.json.animations?.find((entry) => entry.name === name)
    if (!clip) continue
    for (const channel of clip.channels ?? []) {
      if (channel.target?.node !== root || channel.target.path !== 'translation') continue
      const sampler = clip.samplers?.[channel.sampler]
      if (!sampler) throw new Error(`Клип ${name} ссылается на неизвестный sampler`)
      const values = readAccessor(document, sampler.output).flat()
      if (values.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e-6)) throw new Error(`Клип ${name} содержит root motion`)
    }
  }
}

function copyAnimation(state, source, animation, nodeIndexes, accessorCache) {
  const result = structuredClone(animation)
  result.samplers = animation.samplers.map((sampler) => ({
    ...sampler,
    input: copyWholeAccessor(state, source, sampler.input, accessorCache),
    output: copyWholeAccessor(state, source, sampler.output, accessorCache),
  }))
  result.channels = animation.channels.map((channel) => {
    const name = source.json.nodes[channel.target.node]?.name
    const node = nodeIndexes.get(name)
    if (node == null) throw new Error(`Анимация ${animation.name} ссылается на неизвестную кость ${name}`)
    return { ...channel, target: { ...channel.target, node } }
  })
  return result
}

function assembleProfile(outfit, base, animation, spec) {
  assertRigCompatibility(outfit, base, animation)
  const json = structuredClone(outfit.json)
  json.animations = []
  const state = { json, chunks: [outfit.binary], binaryLength: outfit.binary.length }
  const resources = createResourceCopier(state, base)
  const outfitRoot = json.scenes?.[json.scene ?? 0]?.nodes?.[0]
  if (!Number.isInteger(outfitRoot) || json.nodes[outfitRoot]?.name !== 'Armature') throw new Error(`У ${spec.outfit} нет корня Armature`)
  const nodeIndexes = new Map(json.nodes.map((node, index) => [node.name, index]))
  const baseHeadJoint = jointNames(base).indexOf('Head')
  if (baseHeadJoint < 0) throw new Error('В base rig нет Head')
  const body = nodeByName(base, 'SuperHero_Male').node
  const bodyMesh = base.json.meshes[body.mesh]
  const bodyPrimitive = bodyMesh?.primitives?.[0]
  if (!bodyMesh || !bodyPrimitive) throw new Error('У SuperHero_Male нет primitive')
  const bodyJoints = readAccessor(base, bodyPrimitive.attributes.JOINTS_0)
  const bodyWeights = readAccessor(base, bodyPrimitive.attributes.WEIGHTS_0)
  const isHeadVertex = (index) => bodyJoints[index].some((joint, slot) => joint === baseHeadJoint && bodyWeights[index][slot] > .5)
  const headStats = { triangles: 0, vertices: 0 }
  const headParts = [
    { source: 'Eyebrows', output: `${spec.key}_Head_Eyebrows`, keep: () => true },
    { source: 'Eyes', output: `${spec.key}_Head_Eyes`, keep: () => true },
    { source: 'SuperHero_Male', output: `${spec.key}_Head_Face`, keep: isHeadVertex },
  ]
  for (const part of headParts) {
    const sourceNode = nodeByName(base, part.source).node
    const mesh = copyMesh(state, base, base.json.meshes[sourceNode.mesh], resources, part.keep, part.output, part.source === 'SuperHero_Male' ? headStats : undefined)
    if (mesh == null) throw new Error(`${part.source}: не выделилась геометрия головы`)
    const node = { name: part.output, mesh, skin: 0 }
    const nodeIndex = json.nodes.push(node) - 1
    json.nodes[outfitRoot].children = [...(json.nodes[outfitRoot].children ?? []), nodeIndex]
  }
  const accessorCache = new Map()
  for (const name of CLIP_NAMES) {
    const clip = animation.json.animations?.find((entry) => entry.name === name)
    if (clip) json.animations.push(copyAnimation(state, animation, clip, nodeIndexes, accessorCache))
  }
  const missing = CLIP_NAMES.filter((name) => !json.animations.some((clip) => clip.name === name))
  if (missing.length) throw new Error(`${spec.key}: нет клипов ${missing.join(', ')}`)
  json.buffers[0].byteLength = state.binaryLength
  json.asset = { ...json.asset, generator: 'skazanie-quaternius-actor-candidate/v1' }
  const binary = Buffer.concat(state.chunks, state.binaryLength)
  return { json, binary, headStats }
}

function finiteBox(gltf, label) {
  gltf.scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(gltf.scene)
  const size = box.getSize(new THREE.Vector3())
  if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray(), ...size.toArray()].every(Number.isFinite)) throw new Error(`${label}: bounds не конечны`)
  return { min: box.min.toArray(), max: box.max.toArray(), size: size.toArray() }
}

function parseWithLoader(bytes, label) {
  const previousSelf = globalThis.self
  const previousProgressEvent = globalThis.ProgressEvent
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.ProgressEvent ??= class { constructor(type, values) { this.type = type; Object.assign(this, values) } }
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })
  const loader = new GLTFLoader()
  return new Promise((resolve, reject) => loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', (gltf) => {
    try { resolve({ gltf, box: finiteBox(gltf, label) }) } catch (error) { reject(error) }
    finally {
      if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
      if (previousProgressEvent === undefined) delete globalThis.ProgressEvent; else globalThis.ProgressEvent = previousProgressEvent
      if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
    }
  }, (error) => {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
    if (previousProgressEvent === undefined) delete globalThis.ProgressEvent; else globalThis.ProgressEvent = previousProgressEvent
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
    reject(error)
  }))
}

function collectResources(scene) {
  const geometries = new Set()
  const materials = new Set()
  const textures = new Set()
  scene.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry)
    const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
    for (const material of list) {
      materials.add(material)
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
    }
  })
  return { geometries, materials, textures }
}

function assertDisjointResources(first, second, label) {
  for (const [kind, left] of Object.entries(first)) for (const value of left) if (second[kind].has(value)) throw new Error(`${label}: GLTFLoader разделил ${kind}`)
}

function disposeResources(scene) {
  const resources = collectResources(scene)
  for (const geometry of resources.geometries) geometry.dispose()
  for (const material of resources.materials) material.dispose()
  for (const texture of resources.textures) texture.dispose()
}

function exerciseMixer(gltf, label) {
  const root = gltf.scene.getObjectByName('root')
  if (!root) throw new Error(`${label}: не найден root для AnimationMixer`)
  for (const clip of gltf.animations) {
    const mixer = new THREE.AnimationMixer(gltf.scene)
    const action = mixer.clipAction(clip).reset().play()
    mixer.update(Math.min(Math.max(1 / 60, clip.duration * .37), .25))
    if (!root.position.toArray().every(Number.isFinite) || root.position.length() > 1e-6) throw new Error(`${label}: клип ${clip.name} содержит root motion`)
    finiteBox(gltf, `${label}-${clip.name}`)
    action.stop()
    mixer.uncacheRoot(gltf.scene)
  }
}

async function inspectOutput(file, spec) {
  const inspection = await inspectModelFile(file)
  if (inspection.bytes > MAX_MODEL_BYTES) throw new Error(`${spec.key}: GLB больше ${MAX_MODEL_BYTES} байт`)
  const bytes = await readFile(file)
  const first = await parseWithLoader(bytes, spec.key)
  const second = await parseWithLoader(bytes, `${spec.key}-copy`)
  if (first.gltf.scene === second.gltf.scene) throw new Error(`${spec.key}: две копии делят сцену`)
  const names = first.gltf.animations.map((clip) => clip.name)
  if (JSON.stringify(names) !== JSON.stringify(CLIP_NAMES)) throw new Error(`${spec.key}: список клипов не совпал`)
  if (first.gltf.animations.some((clip) => clip.duration <= 0 || !clip.tracks.length || /bow/iu.test(clip.name))) throw new Error(`${spec.key}: клип не является допустимым полноценным действием`)
  const skinned = []
  first.gltf.scene.traverse((object) => { if (object.isSkinnedMesh) skinned.push(object) })
  if (!skinned.length || skinned.some((mesh) => mesh.skeleton.bones.find((bone) => bone.name === 'Head') == null)) throw new Error(`${spec.key}: Head не привязан к skin`)
  const firstResources = collectResources(first.gltf.scene)
  const secondResources = collectResources(second.gltf.scene)
  assertDisjointResources(firstResources, secondResources, spec.key)
  exerciseMixer(first.gltf, spec.key)
  disposeResources(first.gltf.scene)
  finiteBox(second.gltf, `${spec.key}-surviving-copy`)
  exerciseMixer(second.gltf, `${spec.key}-surviving-copy`)
  disposeResources(second.gltf.scene)
  return { bytes: inspection.bytes, sha256: inspection.sha256, box: first.box, animations: names, meshes: skinned.length }
}

async function existingFile(path, label) {
  const info = await lstat(path).catch((error) => { if (error?.code === 'ENOENT') return null; throw error })
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label}: нужен обычный файл ${path}`)
}

async function verifyArchive(path, source) {
  await existingFile(path, source.archive)
  const bytes = await readFile(path)
  const actual = hash(bytes).toUpperCase()
  if (actual !== source.sha256) throw new Error(`${source.archive}: SHA256 не совпал, ожидался ${source.sha256}, получен ${actual}`)
  return { ...source, sha256: actual.toLowerCase(), bytes: bytes.length, path: basename(path) }
}

async function converted(sourceFile, outputFile, tracker, work) {
  const stagedFile = join(work, `${basename(sourceFile, '.gltf')}.staged.gltf`)
  await stageGltf(sourceFile, stagedFile, tracker)
  await convert(stagedFile, outputFile)
  return parseGlb(await readFile(outputFile), outputFile)
}

async function sourceResource(sourceFile, uri) {
  if (typeof uri !== 'string' || uri.startsWith('data:')) return null
  if (/^(?:https?:)?\/\//u.test(uri)) throw new Error(`Внешний ресурс запрещён: ${uri}`)
  const decoded = decodeURIComponent(uri.replace(/^file:\/\//u, ''))
  const name = basename(decoded)
  const names = [name, name.replace(/_png(?=\.[^.]+$)/iu, '')]
  const directory = dirname(sourceFile)
  const directories = [directory, join(directory, '..', 'Textures'), join(directory, '..', '..', 'Textures'), join(directory, '..', '..', '..', 'Textures')]
  for (const folder of directories) for (const candidateName of names) {
    const file = join(folder, candidateName)
    const bytes = await readFile(file).catch(() => null)
    if (bytes) return { file, bytes }
  }
  throw new Error(`Не найден внешний ресурс ${uri} рядом с ${sourceFile}`)
}

/** Ставит .bin и текстуры в отдельный work-каталог и лечит известный _png typo. */
async function stageGltf(sourceFile, stagedFile, tracker) {
  const json = JSON.parse(await readFile(sourceFile, 'utf8'))
  trackInput(tracker, sourceFile, await readFile(sourceFile))
  const folder = dirname(stagedFile)
  await mkdir(folder, { recursive: true })
  for (const [index, buffer] of (json.buffers ?? []).entries()) {
    const resource = await sourceResource(sourceFile, buffer.uri)
    if (!resource) continue
    trackInput(tracker, resource.file, resource.bytes)
    const staged = `resource-${index}-${basename(resource.file)}`
    await writeFile(join(folder, staged), resource.bytes)
    buffer.uri = staged
  }
  for (const [index, image] of (json.images ?? []).entries()) {
    const resource = await sourceResource(sourceFile, image.uri)
    if (!resource) continue
    trackInput(tracker, resource.file, resource.bytes)
    const staged = `resource-image-${index}-${basename(resource.file)}`
    await writeFile(join(folder, staged), resource.bytes)
    image.uri = staged
  }
  await writeFile(stagedFile, `${JSON.stringify(json)}\n`)
}

function sourceTracker() { return { family: 'actors', inputs: new Map() } }

function trackInput(tracker, file, bytes) {
  const absolute = resolve(file)
  if (tracker.inputs.has(absolute)) return
  const tmpRoot = resolve(TMP_ROOT)
  const prefix = `${tmpRoot}${process.platform === 'win32' ? '\\' : '/'}`
  const relativePath = absolute.startsWith(prefix)
    ? absolute.slice(prefix.length).split(/[\\/]/u).join('/')
    : `external/${basename(absolute)}`
  let path = `${tracker.family}/${relativePath.replace(/[^A-Za-z0-9._/-]+/gu, '_')}`
  if ([...tracker.inputs.values()].some((input) => input.path === path)) path = `${tracker.family}/external/${hash(bytes).slice(0, 16)}-${basename(absolute).replace(/[^A-Za-z0-9._-]+/gu, '_')}`
  tracker.inputs.set(absolute, { path, sha256: hash(bytes), bytes: bytes.length })
}

function sourceInputRecords(tracker) {
  return [...tracker.inputs.values()]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
}

function candidateManifest(sources, reports, tracker) {
  return {
    version: 1,
    schema: 'skazanie-actor-candidate/v1',
    sources: sources.map(({ path, bytes, sha256, ...source }) => ({
      ...source, archiveFile: path, bytes, sha256, archiveSha256: sha256,
    })),
    build: {
      importer: 'tools/import-quaternius-actors.mjs', importerVersion: 1,
      textureMaxSide: MAX_TEXTURE_SIDE, animationPack: 'UAL1_Standard.glb', rootMotion: false,
      rig: { root: 'root', head: 'Head', handSockets: ['hand_l', 'hand_r'], forwardAxis: '+Z' },
      ranged: null,
      sourceInputs: sourceInputRecords(tracker),
      profiles: reports,
    },
    profiles: reports.map((report) => ({
      key: report.key, label: report.label, file: report.file, outfit: report.outfit,
      clips: CLIP_NAMES, ranged: null, head: report.head,
      provenance: { sources: ['universal-base-characters-standard', 'modular-character-outfits-fantasy-standard', 'universal-animation-library-standard'], license: 'CC0-1.0', attribution: 'Quaternius' },
    })),
  }
}

export async function importQuaterniusActors(options = {}) {
  const values = { ...DEFAULTS, ...options }
  const output = resolve(values.out)
  const outside = relative(resolve(TMP_ROOT), output)
  if (isAbsolute(outside) || outside === '..' || outside.startsWith(`..${sep}`)) throw new Error('Кандидат должен лежать внутри tmp/')
  await validateCandidateOutputDir(output, { requireEmpty: true })
  await mkdir(output, { recursive: true })
  for (const [path, label] of [[values.baseDir, 'baseDir'], [values.outfitDir, 'outfitDir']]) {
    const info = await lstat(path).catch((error) => { if (error?.code === 'ENOENT') return null; throw error })
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label}: нужен обычный каталог ${path}`)
  }
  await existingFile(values.ualFile, 'ualFile')
  const sources = []
  for (const [path, source] of [[values.baseArchive, SOURCE_ARCHIVES.base], [values.outfitArchive, SOURCE_ARCHIVES.outfits], [values.animationArchive, SOURCE_ARCHIVES.animations]]) {
    sources.push(await verifyArchive(path, source))
  }
  const work = await mkdtemp(join(TMP_ROOT, 'quaternius-actor-work-'))
  try {
    const tracker = sourceTracker()
    const basePath = join(work, 'base.glb')
    const base = await converted(join(values.baseDir, 'Superhero_Male_FullBody.gltf'), basePath, tracker, work)
    const animationBytes = await readFile(values.ualFile)
    trackInput(tracker, values.ualFile, animationBytes)
    const animation = parseGlb(animationBytes, values.ualFile)
    assertNoRootMotion(animation, CLIP_NAMES)
    const reports = []
    for (const spec of PROFILES) {
      const outfit = await converted(join(values.outfitDir, spec.outfit), join(work, `${spec.key}-outfit.glb`), tracker, work)
      const ready = assembleProfile(outfit, base, animation, spec)
      const outputFile = join(output, spec.file)
      await writeFile(outputFile, writeGlb(ready.json, ready.binary))
      const report = await inspectOutput(outputFile, spec)
      reports.push({ ...report, key: spec.key, label: spec.label, file: spec.file, outfit: spec.outfit, head: { source: 'SuperHero_Male', weight: '>0.5', ...ready.headStats } })
    }
    const manifest = candidateManifest(sources, reports, tracker)
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(output, 'LICENSE.txt'), `${sources.map((source) => `${source.id}: ${source.license}; ${source.author}; ${source.url}; archive ${source.archive} SHA-256 ${source.sha256}`).join('\n')}\n`)
    return { ok: true, output, sources, profiles: reports, manifest }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' }, 'base-dir': { type: 'string' }, 'outfit-dir': { type: 'string' }, 'ual-file': { type: 'string' },
      'base-archive': { type: 'string' }, 'outfit-archive': { type: 'string' }, 'animation-archive': { type: 'string' },
    }, allowPositionals: true,
  })
  const options = {
    out: values.out ?? DEFAULTS.out, baseDir: values['base-dir'] ?? DEFAULTS.baseDir, outfitDir: values['outfit-dir'] ?? DEFAULTS.outfitDir,
    ualFile: values['ual-file'] ?? DEFAULTS.ualFile, baseArchive: values['base-archive'] ?? DEFAULTS.baseArchive,
    outfitArchive: values['outfit-archive'] ?? DEFAULTS.outfitArchive, animationArchive: values['animation-archive'] ?? DEFAULTS.animationArchive,
  }
  process.stdout.write(`${JSON.stringify(await importQuaterniusActors(options), null, 2)}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('import-quaternius-actors.mjs')) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
