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
  for (const region of spec.regionNodes ?? []) {
    if (!region || typeof region.source !== 'string' || typeof region.output !== 'string') throw new Error(`${spec.key}: некорректное имя региона`)
    const sourceIndex = json.nodes.findIndex((node) => node.name === region.source)
    if (sourceIndex < 0) throw new Error(`${spec.key}: не найден регион ${region.source}`)
    json.nodes[sourceIndex].name = region.output
    const meshIndex = json.nodes[sourceIndex].mesh
    if (Number.isInteger(meshIndex) && json.meshes[meshIndex]) json.meshes[meshIndex].name = region.output
  }
  const nodeIndexes = new Map(json.nodes.map((node, index) => [node.name, index]))
  const baseHeadJoint = jointNames(base).indexOf('Head')
  if (baseHeadJoint < 0) throw new Error('В base rig нет Head')
  const bodySource = spec.bodySource ?? 'SuperHero_Male'
  const body = nodeByName(base, bodySource).node
  const bodyMesh = base.json.meshes[body.mesh]
  const bodyPrimitive = bodyMesh?.primitives?.[0]
  if (!bodyMesh || !bodyPrimitive) throw new Error(`У ${bodySource} нет primitive`)
  const bodyJoints = readAccessor(base, bodyPrimitive.attributes.JOINTS_0)
  const bodyWeights = readAccessor(base, bodyPrimitive.attributes.WEIGHTS_0)
  const isHeadVertex = (index) => bodyJoints[index].some((joint, slot) => joint === baseHeadJoint && bodyWeights[index][slot] > .5)
  const headStats = { triangles: 0, vertices: 0 }
  const headOutputs = spec.headOutputs ?? {}
  const headParts = [
    { source: 'Eyebrows', output: headOutputs.eyebrows ?? `${spec.key}_Head_Eyebrows`, keep: () => true },
    { source: 'Eyes', output: headOutputs.eyes ?? `${spec.key}_Head_Eyes`, keep: () => true },
    { source: bodySource, output: headOutputs.face ?? `${spec.key}_Head_Face`, keep: isHeadVertex },
  ]
  for (const part of headParts) {
    const sourceNode = nodeByName(base, part.source).node
    const mesh = copyMesh(state, base, base.json.meshes[sourceNode.mesh], resources, part.keep, part.output, part.source === bodySource ? headStats : undefined)
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

const EQUIPMENT_BASE_PROFILES = Object.freeze([
  {
    key: 'human-male', label: 'Человек · мужская основа', gender: 'male',
    base: 'Superhero_Male_FullBody.gltf', bodySource: 'SuperHero_Male', outfit: 'Male_Peasant.gltf', file: 'human-male.glb',
    regionNodes: [
      { source: 'Male_Peasant_Arms', output: 'Arms' },
      { source: 'Male_Peasant_Body', output: 'Body' },
      { source: 'Male_Peasant_Feet', output: 'Feet' },
      { source: 'Male_Peasant_Legs', output: 'Legs' },
    ],
  },
  {
    key: 'human-female', label: 'Человек · женская основа', gender: 'female',
    base: 'Superhero_Female_FullBody.gltf', bodySource: 'Superhero_Female', outfit: 'Female_Peasant.gltf', file: 'human-female.glb',
    regionNodes: [
      { source: 'Female_Peasant_Arms', output: 'Arms' },
      { source: 'Female_Peasant_Body', output: 'Body' },
      { source: 'Female_Peasant_Feet', output: 'Feet' },
      { source: 'Female_Peasant_Legs', output: 'Legs' },
    ],
  },
])

function stableEquipmentBaseJson(ready, spec, feetOffset) {
  const armature = ready.json.scenes?.[ready.json.scene ?? 0]?.nodes?.[0]
  if (!Number.isInteger(armature) || ready.json.nodes[armature]?.name !== 'Armature') throw new Error(`${spec.key}: не найден Armature для нормализации`)
  const node = ready.json.nodes[armature]
  const translation = Array.isArray(node.translation) ? [...node.translation] : [0, 0, 0]
  translation[1] = Number(translation[1] ?? 0) + feetOffset
  node.translation = translation
  ready.json.asset = { ...ready.json.asset, generator: 'skazanie-equipment-base-candidate/v1' }
  ready.json.extras = {
    ...(ready.json.extras ?? {}),
    skazanie: {
      ...(ready.json.extras?.skazanie ?? {}),
      gearBase: {
        version: 1,
        profile: spec.key,
        gender: spec.gender,
        rig: { root: 'root', head: 'Head', handSockets: ['hand_l', 'hand_r'], bones: 65 },
        forwardAxis: '+Z',
        feetOrigin: 'minY=0',
        feetOffset,
        regions: { arms: 'Arms', body: 'Body', legs: 'Legs', feet: 'Feet', head: 'Head_Face' },
        headMeshes: { face: 'Head_Face', eyes: 'Head_Eyes', eyebrows: 'Head_Eyebrows' },
        outfit: 'neutral-peasant',
        armor: 'none-baked',
      },
    },
  }
  return ready
}

/**
 * Собирает две нейтральные основы для слоя предметов, используя тот же
 * packer, что и готовые traveler/ranger. Модели остаются кандидатами в tmp/.
 */
export async function importQuaterniusEquipmentBases(options = {}) {
  const values = { ...DEFAULTS, ...options, out: options.out ?? join(TMP_ROOT, 'equipment-bases') }
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
  const work = await mkdtemp(join(TMP_ROOT, 'quaternius-equipment-work-'))
  try {
    const tracker = sourceTracker()
    const animationBytes = await readFile(values.ualFile)
    trackInput(tracker, values.ualFile, animationBytes)
    const animation = parseGlb(animationBytes, values.ualFile)
    assertNoRootMotion(animation, CLIP_NAMES)
    const baseCache = new Map()
    const reports = []
    for (const spec of EQUIPMENT_BASE_PROFILES) {
      let base = baseCache.get(spec.gender)
      if (!base) {
        const baseFile = join(values.baseDir, spec.base)
        base = await converted(baseFile, join(work, `${spec.gender}-base.glb`), tracker, work)
        baseCache.set(spec.gender, base)
      }
      const outfit = await converted(join(values.outfitDir, spec.outfit), join(work, `${spec.key}-outfit.glb`), tracker, work)
      const ready = assembleProfile(outfit, base, animation, {
        ...spec,
        headOutputs: { eyebrows: 'Head_Eyebrows', eyes: 'Head_Eyes', face: 'Head_Face' },
      })
      const raw = writeGlb(ready.json, ready.binary)
      const parsed = await parseWithLoader(raw, spec.key)
      const feetOffset = -parsed.box.min[1]
      disposeResources(parsed.gltf.scene)
      stableEquipmentBaseJson(ready, spec, feetOffset)
      const outputFile = join(output, spec.file)
      await writeFile(outputFile, writeGlb(ready.json, ready.binary))
      const report = await inspectOutput(outputFile, spec)
      reports.push({
        ...report,
        key: spec.key,
        label: spec.label,
        file: spec.file,
        gender: spec.gender,
        outfit: spec.outfit,
        regions: { arms: 'Arms', body: 'Body', legs: 'Legs', feet: 'Feet', head: 'Head_Face' },
        rig: { root: 'root', head: 'Head', handSockets: ['hand_l', 'hand_r'], bones: 65 },
        forwardAxis: '+Z',
        feetOrigin: 'minY=0',
        feetOffset,
        armor: 'none-baked',
      })
    }
    const manifest = {
      version: 1,
      schema: 'skazanie-equipment-base-candidate/v1',
      sources: sources.map(({ path, bytes, sha256, ...source }) => ({ ...source, archiveFile: path, bytes, sha256, archiveSha256: sha256 })),
      build: {
        importer: 'tools/build-equipment-bases.mjs', importerVersion: 1,
        packer: 'tools/import-quaternius-actors.mjs',
        textureMaxSide: MAX_TEXTURE_SIDE, animationPack: 'UAL1_Standard.glb', rootMotion: false,
        rig: { root: 'root', head: 'Head', handSockets: ['hand_l', 'hand_r'], bones: 65, forwardAxis: '+Z' },
        feetOrigin: 'minY=0', regions: { arms: 'Arms', body: 'Body', legs: 'Legs', feet: 'Feet', head: 'Head_Face' },
        sourceInputs: sourceInputRecords(tracker), profiles: reports,
      },
      profiles: reports,
    }
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const notice = {
      version: 1,
      schema: 'skazanie-equipment-base-notice/v1',
      outputs: reports,
      stableRegions: { arms: 'Arms', body: 'Body', legs: 'Legs', feet: 'Feet', head: 'Head_Face' },
      rig: { root: 'root', head: 'Head', handSockets: ['hand_l', 'hand_r'], bones: 65, forwardAxis: '+Z' },
      bakedArmor: false,
      safeHideableAccessories: {
        quaterniusRanger: ['Male_Ranger_Acc_Pauldron', 'Male_Ranger_Arms_Bracer', 'Male_Ranger_Body_Belt_1', 'Male_Ranger_Body_Belt_2', 'Male_Ranger_Feet_Boots', 'Male_Ranger_Head_Hood'],
        quaterniusMage: ['Male_Ranger_Acc_Pauldron', 'Male_Ranger_Arms_Bracer', 'Male_Ranger_Body_Belt_1', 'Male_Ranger_Body_Belt_2', 'Male_Ranger_Feet_Boots', 'Male_Ranger_Head_Hood'],
        kaykitKnight: ['Knight_Helmet', 'Knight_Cape', '1H_Sword', 'Round_Shield'],
        kaykitMage: ['Mage_Hat', 'Mage_Cape', '2H_Staff', 'Spellbook'],
        kaykitRogue: ['Rogue_Cape', 'Knife_Offhand'],
        kaykitSkeleton: ['Skeleton_Warrior_Helmet', 'Skeleton_Warrior_Cloak'],
      },
      neverHide: ['Head', 'Head_Face', 'Head_Eyes', 'Head_Eyebrows', 'ranger_Head_Face', 'traveler_Head_Face', 'Male_Peasant_Body', 'Female_Peasant_Body'],
      provenance: sources,
    }
    await writeFile(join(output, 'NOTICE.json'), `${JSON.stringify(notice, null, 2)}\n`)
    await writeFile(join(output, 'LICENSE.txt'), `${sources.map((source) => `${source.id}: ${source.license}; ${source.author}; ${source.url}; archive ${source.archive} SHA-256 ${source.sha256}`).join('\n')}\nМодели состоят из лицензированной Quaternius-геометрии; проект «Сказание» сохраняет neutral Peasant outfit и нормализует только сцену/имена регионов.\n`)
    return { ok: true, output, sources, profiles: reports, manifest }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/*
 * Герои реалистичных пропорций (2 октября 2026).
 *
 * Тело и одежда — те же Quaternius Outfits + голова Base Characters, что у
 * путника и следопыта, но с причёской и бородой из «Rigged to Head Bone»:
 * у прежних фигур голова была лысой, а брови — белыми, потому что текстуры
 * волос в наборе серые и рассчитаны на оттенок материала. Цвет волос задаётся
 * baseColorFactor материала MI_Hair_*; брови той же базы получают тот же тон.
 *
 * Из файла убирается всё, что рантайм не читает: вершинные цвета (во всём
 * наборе они белые) и UV-каналы, кроме нулевого, недостижимые узлы капюшона,
 * исходная текстура до перекраски. Roughness-карты уменьшаются до 256 px —
 * на клетке доски их разницу не видно, а это по ~120 КБ на карту.
 */
const HERO_IMPORTER_VERSION = 1
const HERO_ROUGHNESS_MAX_SIDE = 256
const HAIR_DIR = join(TMP_ROOT, 'quaternius-actors-standard-20260911', 'extracted', 'Universal-Base-Characters-Standard', 'Universal Base Characters[Standard]', 'Hairstyles', 'Rigged to Head Bone', 'glTF (Godot -Unreal)')
const OUTFIT_TEXTURE_DIR = join(TMP_ROOT, 'quaternius-actors-standard-20260911', 'extracted', 'Modular-Character-Outfits-Fantasy-Standard', 'Modular Character Outfits - Fantasy[Standard]', 'Textures')
/** Линейные множители серой текстуры волос (sRGB ≈ 0.65). */
export const HAIR_TINTS = Object.freeze({
  'dark-brown': [0.2, 0.115, 0.07, 1],
  chestnut: [0.32, 0.15, 0.075, 1],
  black: [0.09, 0.075, 0.065, 1],
  grey: [0.78, 0.76, 0.72, 1],
  auburn: [0.55, 0.2, 0.09, 1],
})
const PEASANT_REGIONS = (prefix) => [
  { source: `${prefix}_Peasant_Arms`, output: 'Arms' },
  { source: `${prefix}_Peasant_Body`, output: 'Body' },
  { source: `${prefix}_Peasant_Feet`, output: 'Feet' },
  { source: `${prefix}_Peasant_Legs`, output: 'Legs' },
]
const MALE_BASE = { gender: 'male', base: 'Superhero_Male_FullBody.gltf', bodySource: 'SuperHero_Male' }
const FEMALE_BASE = { gender: 'female', base: 'Superhero_Female_FullBody.gltf', bodySource: 'Superhero_Female' }

export const HERO_PROFILES = Object.freeze([
  { key: 'hero-male', label: 'Человек', role: 'gear-base', ...MALE_BASE, outfit: 'Male_Peasant.gltf', file: 'hero-male.glb', regionNodes: PEASANT_REGIONS('Male'), hair: ['Hair_SimpleParted.gltf', 'Hair_Beard.gltf'], hairTint: 'dark-brown' },
  { key: 'hero-female', label: 'Человек · женщина', role: 'gear-base', ...FEMALE_BASE, outfit: 'Female_Peasant.gltf', file: 'hero-female.glb', regionNodes: PEASANT_REGIONS('Female'), hair: ['Hair_Long.gltf'], hairTint: 'chestnut' },
  { key: 'ranger-male', label: 'Следопыт', role: 'outfit', ...MALE_BASE, outfit: 'Male_Ranger.gltf', file: 'ranger-male.glb', hair: ['Hair_Beard.gltf'], hairTint: 'dark-brown' },
  { key: 'ranger-female', label: 'Следопыт · женщина', role: 'outfit', ...FEMALE_BASE, outfit: 'Female_Ranger.gltf', file: 'ranger-female.glb', hair: ['Hair_Buns.gltf'], hairTint: 'auburn', dropNodes: ['Female_Ranger_Head_Hood'] },
  { key: 'mage-male', label: 'Маг', role: 'outfit', ...MALE_BASE, outfit: 'Male_Ranger.gltf', file: 'mage-male.glb', hair: ['Hair_Beard.gltf'], hairTint: 'grey', recolor: 'mage', dropNodes: ['Male_Ranger_Acc_Pauldron'] },
  { key: 'mage-female', label: 'Маг · женщина', role: 'outfit', ...FEMALE_BASE, outfit: 'Female_Ranger.gltf', file: 'mage-female.glb', hair: [], hairTint: 'black', recolor: 'mage', dropNodes: ['Female_Ranger_Acc_Pauldrons'] },
])

/** Узлы, достижимые из сцены, плюс кости skin и цели анимаций. */
function reachableNodes(json) {
  const seen = new Set()
  const visit = (index) => {
    if (!Number.isInteger(index) || seen.has(index)) return
    seen.add(index)
    for (const child of json.nodes[index]?.children ?? []) visit(child)
  }
  for (const scene of json.scenes ?? []) for (const root of scene.nodes ?? []) visit(root)
  for (const skin of json.skins ?? []) for (const joint of skin.joints ?? []) visit(joint)
  return seen
}

/**
 * Пересобирает документ только из используемых ресурсов. Индексы узлов не
 * меняются: у недостижимого узла снимаются mesh/skin, и всё, на что ссылался
 * только он, в выходной BIN не попадает.
 */
function compactDocument(json, binary) {
  const reachable = reachableNodes(json)
  json.nodes.forEach((node, index) => { if (!reachable.has(index)) { delete node.mesh; delete node.skin } })
  const remap = (list, used) => {
    const order = [...used].sort((left, right) => left - right)
    const map = new Map(order.map((value, index) => [value, index]))
    return { map, items: order.map((index) => list[index]) }
  }
  const meshes = remap(json.meshes ?? [], new Set(json.nodes.map((node) => node.mesh).filter(Number.isInteger)))
  for (const node of json.nodes) if (Number.isInteger(node.mesh)) node.mesh = meshes.map.get(node.mesh)
  json.meshes = meshes.items
  const usedMaterials = new Set(json.meshes.flatMap((mesh) => mesh.primitives.map((primitive) => primitive.material)).filter(Number.isInteger))
  const materials = remap(json.materials ?? [], usedMaterials)
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) if (Number.isInteger(primitive.material)) primitive.material = materials.map.get(primitive.material)
  json.materials = materials.items
  const textureInfos = (material) => [material.pbrMetallicRoughness?.baseColorTexture, material.pbrMetallicRoughness?.metallicRoughnessTexture, material.normalTexture, material.occlusionTexture, material.emissiveTexture].filter((info) => Number.isInteger(info?.index))
  const textures = remap(json.textures ?? [], new Set(json.materials.flatMap((material) => textureInfos(material).map((info) => info.index))))
  for (const material of json.materials) for (const info of textureInfos(material)) info.index = textures.map.get(info.index)
  json.textures = textures.items
  const images = remap(json.images ?? [], new Set(json.textures.map((texture) => texture.source).filter(Number.isInteger)))
  const samplers = remap(json.samplers ?? [], new Set(json.textures.map((texture) => texture.sampler).filter(Number.isInteger)))
  for (const texture of json.textures) {
    if (Number.isInteger(texture.source)) texture.source = images.map.get(texture.source)
    if (Number.isInteger(texture.sampler)) texture.sampler = samplers.map.get(texture.sampler)
  }
  json.images = images.items
  json.samplers = samplers.items
  const usedAccessors = new Set()
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    for (const id of Object.values(primitive.attributes)) usedAccessors.add(id)
    if (Number.isInteger(primitive.indices)) usedAccessors.add(primitive.indices)
    for (const target of primitive.targets ?? []) for (const id of Object.values(target)) usedAccessors.add(id)
  }
  for (const skin of json.skins ?? []) if (Number.isInteger(skin.inverseBindMatrices)) usedAccessors.add(skin.inverseBindMatrices)
  for (const animation of json.animations ?? []) for (const sampler of animation.samplers) { usedAccessors.add(sampler.input); usedAccessors.add(sampler.output) }
  const accessors = remap(json.accessors ?? [], usedAccessors)
  const accessorId = (id) => accessors.map.get(id)
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    primitive.attributes = Object.fromEntries(Object.entries(primitive.attributes).map(([name, id]) => [name, accessorId(id)]))
    if (Number.isInteger(primitive.indices)) primitive.indices = accessorId(primitive.indices)
    if (primitive.targets) primitive.targets = primitive.targets.map((target) => Object.fromEntries(Object.entries(target).map(([name, id]) => [name, accessorId(id)])))
  }
  for (const skin of json.skins ?? []) if (Number.isInteger(skin.inverseBindMatrices)) skin.inverseBindMatrices = accessorId(skin.inverseBindMatrices)
  for (const animation of json.animations ?? []) for (const sampler of animation.samplers) { sampler.input = accessorId(sampler.input); sampler.output = accessorId(sampler.output) }
  json.accessors = accessors.items
  const oldViews = json.bufferViews
  const state = { json: { bufferViews: [] }, chunks: [], binaryLength: 0 }
  const viewMap = new Map()
  const copyView = (id) => {
    if (viewMap.has(id)) return viewMap.get(id)
    const view = oldViews[id]
    const start = view.byteOffset ?? 0
    const extra = view.byteStride ? { byteStride: view.byteStride } : {}
    if (view.target) Object.assign(extra, { target: view.target })
    const next = appendView(state, binary.subarray(start, start + view.byteLength), extra)
    viewMap.set(id, next)
    return next
  }
  for (const accessor of json.accessors) if (Number.isInteger(accessor.bufferView)) accessor.bufferView = copyView(accessor.bufferView)
  for (const image of json.images) if (Number.isInteger(image.bufferView)) image.bufferView = copyView(image.bufferView)
  json.bufferViews = state.json.bufferViews
  json.buffers = [{ byteLength: state.binaryLength }]
  return Buffer.concat(state.chunks, state.binaryLength)
}

/** Вершинные цвета набора белые, материалы читают только TEXCOORD_0. */
function stripUnusedAttributes(json) {
  const usesExtraUv = (json.materials ?? []).some((material) => JSON.stringify(material).includes('"texCoord":') && /"texCoord":[1-9]/u.test(JSON.stringify(material)))
  if (usesExtraUv) throw new Error('Материал читает TEXCOORD_1+: удалять UV нельзя')
  let removed = 0
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives) {
    for (const name of Object.keys(primitive.attributes)) {
      if (/^COLOR_\d+$/u.test(name) || /^TEXCOORD_[1-9]\d*$/u.test(name)) { delete primitive.attributes[name]; removed += 1 }
    }
  }
  return removed
}

/**
 * В клипах UAL1 большинство каналов (пальцы, scale всех костей) не меняются
 * за клип. Такой канал сворачивается в один ключ с тем же значением: поза
 * та же, а клип теряет ~80 % байтов анимации.
 */
function collapseConstantTracks(state) {
  const document = { json: state.json, binary: Buffer.concat(state.chunks, state.binaryLength) }
  const restValue = (node, path) => path === 'translation' ? node.translation ?? [0, 0, 0] : path === 'rotation' ? node.rotation ?? [0, 0, 0, 1] : path === 'scale' ? node.scale ?? [1, 1, 1] : null
  const near = (left, right) => left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) <= 1e-5)
  // Значения всех свёрнутых каналов лежат в одном bufferView: тысяча
  // отдельных view раздула бы JSON-часть GLB сильнее, чем экономия в BIN.
  const packed = []
  let packedLength = 0
  const pending = []
  const report = { dropped: 0, collapsed: 0, kept: 0 }
  for (const animation of state.json.animations ?? []) {
    const samplers = []
    const channels = []
    let singleTime = null
    for (const channel of animation.channels) {
      const sampler = animation.samplers[channel.sampler]
      const output = readAccessor(document, sampler.output)
      const first = output[0]
      const outputAccessor = state.json.accessors[sampler.output]
      const constant = first && sampler.interpolation !== 'CUBICSPLINE' && outputAccessor.componentType === 5126
        && output.every((value) => near(value, first))
      if (!constant) {
        // glTF требует min/max у времени анимации; общий копировщик их снимает.
        const input = state.json.accessors[sampler.input]
        if (!Array.isArray(input.min) || !Array.isArray(input.max)) {
          const times = readAccessor(document, sampler.input).map((value) => value[0])
          input.min = [Math.min(...times)]
          input.max = [Math.max(...times)]
        }
        channels.push({ ...channel, sampler: samplers.push(sampler) - 1 }); report.kept += 1
        continue
      }
      const rest = restValue(state.json.nodes[channel.target.node], channel.target.path)
      const negated = first.map((value) => -value)
      if (rest && (near(first, rest) || (channel.target.path === 'rotation' && near(negated, rest)))) { report.dropped += 1; continue }
      if (singleTime == null) {
        const time = readAccessor(document, sampler.input)[0][0]
        singleTime = { time, accessor: state.json.accessors.push({ bufferView: -1, byteOffset: packedLength, componentType: 5126, count: 1, type: 'SCALAR', min: [time], max: [time] }) - 1 }
        const bytes = Buffer.alloc(4); bytes.writeFloatLE(time, 0)
        packed.push(bytes); packedLength += 4
        pending.push(singleTime.accessor)
      }
      const bytes = Buffer.alloc(first.length * 4)
      first.forEach((value, index) => bytes.writeFloatLE(value, index * 4))
      const outputId = state.json.accessors.push({ bufferView: -1, byteOffset: packedLength, componentType: 5126, count: 1, type: outputAccessor.type }) - 1
      packed.push(bytes); packedLength += bytes.length
      pending.push(outputId)
      channels.push({ ...channel, sampler: samplers.push({ ...sampler, input: singleTime.accessor, output: outputId }) - 1 })
      report.collapsed += 1
    }
    animation.samplers = samplers
    animation.channels = channels
  }
  if (pending.length) {
    const view = appendView(state, Buffer.concat(packed, packedLength))
    for (const id of pending) state.json.accessors[id].bufferView = view
  }
  return report
}

/**
 * JOINTS_0 → UNSIGNED_BYTE (65 костей), WEIGHTS_0 → нормализованный
 * UNSIGNED_BYTE с суммой ровно 255. Оба варианта есть в ядре glTF 2.0.
 */
function quantizeSkinAttributes(state) {
  const document = { json: state.json, binary: Buffer.concat(state.chunks, state.binaryLength) }
  const joints = new Map()
  const weights = new Map()
  let primitives = 0
  for (const mesh of state.json.meshes ?? []) for (const primitive of mesh.primitives) {
    const jointId = primitive.attributes.JOINTS_0
    const weightId = primitive.attributes.WEIGHTS_0
    if (!Number.isInteger(jointId) || !Number.isInteger(weightId)) continue
    if (!joints.has(jointId)) {
      const values = readAccessor(document, jointId)
      if (values.some((vertex) => vertex.some((joint) => joint > 255))) throw new Error('JOINTS_0 больше 255')
      const bytes = Buffer.from(values.flat())
      joints.set(jointId, state.json.accessors.push({ bufferView: appendView(state, bytes), componentType: 5121, count: values.length, type: 'VEC4' }) - 1)
    }
    if (!weights.has(weightId)) {
      const values = readAccessor(document, weightId)
      const bytes = Buffer.alloc(values.length * 4)
      values.forEach((vertex, index) => {
        const sum = vertex.reduce((total, value) => total + Math.max(0, value), 0) || 1
        const quantized = vertex.map((value) => Math.round(Math.max(0, value) / sum * 255))
        const largest = quantized.indexOf(Math.max(...quantized))
        quantized[largest] += 255 - quantized.reduce((total, value) => total + value, 0)
        quantized.forEach((value, component) => bytes.writeUInt8(value, index * 4 + component))
      })
      weights.set(weightId, state.json.accessors.push({ bufferView: appendView(state, bytes), componentType: 5121, normalized: true, count: values.length, type: 'VEC4' }) - 1)
    }
    primitive.attributes.JOINTS_0 = joints.get(jointId)
    primitive.attributes.WEIGHTS_0 = weights.get(weightId)
    primitives += 1
  }
  return primitives
}

/**
 * NORMAL → нормализованный BYTE (KHR_mesh_quantization, его читает
 * GLTFLoader three.js). Элемент выравнивается до 4 байт: 3 компонента + 0.
 */
function quantizeNormals(state) {
  const document = { json: state.json, binary: Buffer.concat(state.chunks, state.binaryLength) }
  const cache = new Map()
  for (const mesh of state.json.meshes ?? []) for (const primitive of mesh.primitives) {
    const normalId = primitive.attributes.NORMAL
    if (!Number.isInteger(normalId) || state.json.accessors[normalId].componentType !== 5126) continue
    if (!cache.has(normalId)) {
      const values = readAccessor(document, normalId)
      const bytes = Buffer.alloc(values.length * 4)
      values.forEach((normal, index) => {
        const length = Math.hypot(...normal) || 1
        normal.forEach((value, component) => bytes.writeInt8(Math.max(-127, Math.min(127, Math.round(value / length * 127))), index * 4 + component))
      })
      cache.set(normalId, state.json.accessors.push({ bufferView: appendView(state, bytes, { byteStride: 4 }), componentType: 5120, normalized: true, count: values.length, type: 'VEC3' }) - 1)
    }
    primitive.attributes.NORMAL = cache.get(normalId)
  }
  if (cache.size) {
    state.json.extensionsUsed = [...new Set([...(state.json.extensionsUsed ?? []), 'KHR_mesh_quantization'])]
    state.json.extensionsRequired = [...new Set([...(state.json.extensionsRequired ?? []), 'KHR_mesh_quantization'])]
  }
  return cache.size
}

function imageView(json, binary, imageId) {
  const image = json.images?.[imageId]
  const view = image && json.bufferViews?.[image.bufferView]
  if (!image || !view || image.mimeType !== 'image/png') throw new Error(`Изображение ${imageId} не PNG или без bufferView`)
  const start = view.byteOffset ?? 0
  return { image, bytes: binary.subarray(start, start + view.byteLength) }
}

async function shrinkRoughness(state) {
  const { resampleImage } = await import('./build-prop-atlas.mjs')
  const { decodePng, encodePng } = await import('./png-codec.mjs')
  const reports = []
  for (const [imageId, image] of (state.json.images ?? []).entries()) {
    if (!/roughness/iu.test(String(image.name ?? ''))) continue
    const decoded = decodePng(imageView(state.json, Buffer.concat(state.chunks, state.binaryLength), imageId).bytes)
    const scale = Math.min(1, HERO_ROUGHNESS_MAX_SIDE / Math.max(decoded.width, decoded.height))
    if (scale >= 1) continue
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))
    image.bufferView = appendView(state, encodePng(resampleImage(decoded, width, height)))
    reports.push({ image: image.name, from: decoded.width, to: width })
  }
  return reports
}

async function recolorMage(state) {
  const { mageBlueVioletTexture } = await import('./build-character-models.mjs')
  const { decodePng, encodePng } = await import('./png-codec.mjs')
  const material = state.json.materials.find((entry) => entry.name === 'MI_Ranger')
  const textureId = material?.pbrMetallicRoughness?.baseColorTexture?.index
  if (!Number.isInteger(textureId)) throw new Error('mage: MI_Ranger без baseColorTexture')
  const imageId = state.json.textures[textureId].source
  const recolored = mageBlueVioletTexture(decodePng(imageView(state.json, Buffer.concat(state.chunks, state.binaryLength), imageId).bytes))
  if (recolored.afterGreen > recolored.beforeGreen * .08 || recolored.lumaRatio < .96 || recolored.lumaRatio > 1.04) throw new Error('mage: перекраска не прошла palette guard')
  // Перекрашенная текстура — отдельное изображение: исходное остаётся у других
  // материалов, если они на него ссылаются, а лишнее уберёт compactDocument.
  const image = { ...state.json.images[imageId], name: `${state.json.images[imageId].name ?? 'T_Ranger_BaseColor'}_Mage`, bufferView: appendView(state, encodePng(recolored.image)) }
  const nextImage = state.json.images.push(image) - 1
  const nextTexture = state.json.textures.push({ ...state.json.textures[textureId], source: nextImage }) - 1
  material.pbrMetallicRoughness.baseColorTexture = { ...material.pbrMetallicRoughness.baseColorTexture, index: nextTexture }
  material.pbrMetallicRoughness.metallicFactor = Math.min(material.pbrMetallicRoughness.metallicFactor ?? 0, .08)
  material.pbrMetallicRoughness.roughnessFactor = Math.max(material.pbrMetallicRoughness.roughnessFactor ?? .5, .82)
  const { image: _image, ...report } = recolored
  return report
}

/** Причёска того же 65-костного rig-а; материал с тем же именем переиспользуется. */
function addHair(state, outfit, hairDocument, hairFile, outfitRoot) {
  const outfitJoints = jointNames(outfit)
  if (JSON.stringify(jointNames(hairDocument)) !== JSON.stringify(outfitJoints)) throw new Error(`${hairFile}: rig причёски не совпадает с одеждой`)
  assertBindMatricesMatch(hairDocument, outfit, `hair/${hairFile}`)
  const resources = createResourceCopier(state, hairDocument)
  const sharedMaterial = (id) => {
    const name = hairDocument.json.materials?.[id]?.name
    const existing = state.json.materials.findIndex((material) => material.name === name)
    return existing >= 0 ? existing : resources.copyMaterial(id)
  }
  const hairNode = hairDocument.json.nodes.find((node) => Number.isInteger(node.mesh) && Number.isInteger(node.skin))
  if (!hairNode) throw new Error(`${hairFile}: нет skinned mesh`)
  const name = `Hair_${basename(hairFile, '.gltf').replace(/^Hair_/u, '')}`
  const mesh = copyMesh(state, hairDocument, hairDocument.json.meshes[hairNode.mesh], { copyMaterial: sharedMaterial }, () => true, name)
  if (mesh == null) throw new Error(`${hairFile}: пустая причёска`)
  const nodeIndex = state.json.nodes.push({ name, mesh, skin: 0 }) - 1
  state.json.nodes[outfitRoot].children = [...(state.json.nodes[outfitRoot].children ?? []), nodeIndex]
  return name
}

function tintHair(json, tint) {
  const color = HAIR_TINTS[tint]
  if (!color) throw new Error(`Неизвестный цвет волос ${tint}`)
  const tinted = []
  for (const material of json.materials ?? []) {
    if (!/^MI_Hair_\d+$/u.test(String(material.name ?? ''))) continue
    material.pbrMetallicRoughness = { ...(material.pbrMetallicRoughness ?? {}), baseColorFactor: [...color] }
    tinted.push(material.name)
  }
  if (!tinted.length) throw new Error('Не найден материал волос/бровей')
  return tinted
}

async function assembleHero(spec, { base, outfit, animation, hairDocuments }) {
  const ready = assembleProfile(outfit, base, animation, { ...spec, headOutputs: { eyebrows: 'Head_Eyebrows', eyes: 'Head_Eyes', face: 'Head_Face' } })
  const state = { json: ready.json, chunks: [ready.binary], binaryLength: ready.binary.length }
  const outfitRoot = state.json.scenes[state.json.scene ?? 0].nodes[0]
  for (const name of spec.dropNodes ?? []) {
    const index = state.json.nodes.findIndex((node) => node.name === name)
    const children = state.json.nodes[outfitRoot].children ?? []
    if (index < 0 || !children.includes(index)) throw new Error(`${spec.key}: нет узла одежды ${name}`)
    state.json.nodes[outfitRoot].children = children.filter((child) => child !== index)
  }
  const hair = spec.hair.map((file) => addHair(state, outfit, hairDocuments.get(file), file, outfitRoot))
  const tinted = tintHair(state.json, spec.hairTint)
  const recolor = spec.recolor === 'mage' ? await recolorMage(state) : null
  const roughness = await shrinkRoughness(state)
  const strippedAttributes = stripUnusedAttributes(state.json)
  const collapsedTracks = collapseConstantTracks(state)
  const quantizedPrimitives = quantizeSkinAttributes(state)
  const quantizedNormals = quantizeNormals(state)
  const binary = compactDocument(state.json, Buffer.concat(state.chunks, state.binaryLength))
  return { json: state.json, binary, headStats: ready.headStats, hair, tinted, recolor, roughness, strippedAttributes, collapsedTracks, quantizedPrimitives, quantizedNormals }
}

/**
 * Собирает шесть героев (мужской и женский варианты основы, следопыта и мага)
 * в кандидат внутри tmp/. Действующий каталог не меняется.
 */
export async function importQuaterniusHeroes(options = {}) {
  const values = { ...DEFAULTS, hairDir: HAIR_DIR, ...options, out: options.out ?? join(TMP_ROOT, 'quaternius-heroes') }
  const output = resolve(values.out)
  const outside = relative(resolve(TMP_ROOT), output)
  if (isAbsolute(outside) || outside === '..' || outside.startsWith(`..${sep}`)) throw new Error('Кандидат должен лежать внутри tmp/')
  await validateCandidateOutputDir(output, { requireEmpty: true })
  await mkdir(output, { recursive: true })
  for (const [path, label] of [[values.baseDir, 'baseDir'], [values.outfitDir, 'outfitDir'], [values.hairDir, 'hairDir']]) {
    const info = await lstat(path).catch((error) => { if (error?.code === 'ENOENT') return null; throw error })
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label}: нужен обычный каталог ${path}`)
  }
  await existingFile(values.ualFile, 'ualFile')
  const sources = []
  for (const [path, source] of [[values.baseArchive, SOURCE_ARCHIVES.base], [values.outfitArchive, SOURCE_ARCHIVES.outfits], [values.animationArchive, SOURCE_ARCHIVES.animations]]) {
    sources.push(await verifyArchive(path, source))
  }
  const work = await mkdtemp(join(TMP_ROOT, 'quaternius-heroes-work-'))
  try {
    const tracker = sourceTracker()
    const animationBytes = await readFile(values.ualFile)
    trackInput(tracker, values.ualFile, animationBytes)
    const animation = parseGlb(animationBytes, values.ualFile)
    assertNoRootMotion(animation, CLIP_NAMES)
    const bases = new Map()
    const outfits = new Map()
    const hairDocuments = new Map()
    const reports = []
    for (const spec of HERO_PROFILES) {
      if (!bases.has(spec.gender)) bases.set(spec.gender, await converted(join(values.baseDir, spec.base), join(work, `${spec.gender}-base.glb`), tracker, work))
      if (!outfits.has(spec.outfit)) outfits.set(spec.outfit, await converted(join(values.outfitDir, spec.outfit), join(work, `${basename(spec.outfit, '.gltf')}-outfit.glb`), tracker, work))
      for (const file of spec.hair) if (!hairDocuments.has(file)) hairDocuments.set(file, await converted(join(values.hairDir, file), join(work, `${basename(file, '.gltf')}-hair.glb`), tracker, work))
      const ready = await assembleHero(spec, { base: bases.get(spec.gender), outfit: outfits.get(spec.outfit), animation, hairDocuments })
      const parsed = await parseWithLoader(writeGlb(ready.json, ready.binary), spec.key)
      const feetOffset = -parsed.box.min[1]
      disposeResources(parsed.gltf.scene)
      const armature = ready.json.nodes[ready.json.scenes[ready.json.scene ?? 0].nodes[0]]
      const translation = Array.isArray(armature.translation) ? [...armature.translation] : [0, 0, 0]
      translation[1] = Number(translation[1] ?? 0) + feetOffset
      armature.translation = translation
      ready.json.asset = { ...ready.json.asset, generator: `skazanie-quaternius-hero/v${HERO_IMPORTER_VERSION}` }
      const hero = {
        version: 1, profile: spec.key, gender: spec.gender, role: spec.role, outfit: basename(spec.outfit, '.gltf'),
        hair: ready.hair, hairTint: spec.hairTint, recolor: spec.recolor ?? null,
        rig: { root: 'root', head: 'Head', handSockets: ['hand_l', 'hand_r'], bones: 65 }, forwardAxis: '+Z', feetOrigin: 'minY=0', feetOffset,
      }
      ready.json.extras = { ...(ready.json.extras ?? {}), skazanie: { ...(ready.json.extras?.skazanie ?? {}), hero } }
      const outputFile = join(output, spec.file)
      await writeFile(outputFile, writeGlb(ready.json, ready.binary))
      const report = await inspectOutput(outputFile, spec)
      reports.push({
        ...report, key: spec.key, label: spec.label, file: spec.file, gender: spec.gender, role: spec.role, outfit: spec.outfit,
        hair: ready.hair, hairTint: spec.hairTint, tintedMaterials: ready.tinted, recolor: ready.recolor, roughness: ready.roughness,
        strippedAttributes: ready.strippedAttributes, collapsedTracks: ready.collapsedTracks, quantizedPrimitives: ready.quantizedPrimitives, quantizedNormals: ready.quantizedNormals, head: { source: spec.bodySource, weight: '>0.5', ...ready.headStats }, feetOffset,
      })
    }
    const notice = {
      version: 1,
      schema: 'skazanie-quaternius-heroes/v1',
      sources: sources.map(({ path, bytes, sha256, ...source }) => ({ ...source, archiveFile: path, bytes, sha256, archiveSha256: sha256 })),
      build: {
        importer: 'tools/import-quaternius-actors.mjs --heroes', importerVersion: HERO_IMPORTER_VERSION,
        textureMaxSide: MAX_TEXTURE_SIDE, roughnessMaxSide: HERO_ROUGHNESS_MAX_SIDE, animationPack: 'UAL1_Standard.glb', clips: CLIP_NAMES, rootMotion: false,
        rig: { root: 'root', head: 'Head', handSockets: ['hand_l', 'hand_r'], bones: 65, forwardAxis: '+Z' },
        hairTints: HAIR_TINTS, removed: ['COLOR_* (все белые)', 'TEXCOORD_1+', 'недостижимые узлы и неиспользуемые ресурсы', 'каналы анимации, равные позе покоя'],
        quantized: { JOINTS_0: 'UNSIGNED_BYTE', WEIGHTS_0: 'UNSIGNED_BYTE normalized', NORMAL: 'BYTE normalized (KHR_mesh_quantization)' }, constantTracks: 'один ключ',
        sourceInputs: sourceInputRecords(tracker),
      },
      profiles: reports,
    }
    // Имя неизменяемого выпуска выводится из байтов: другой результат сборки
    // обязан лечь в новый каталог, а не перезаписать уже опубликованные URL.
    const files = HERO_PROFILES.map((spec) => spec.file)
    const glbConcatSha256 = hash(Buffer.concat(await Promise.all(files.map((file) => readFile(join(output, file))))))
    notice.immutableRelease = { id: `heroes-${glbConcatSha256.slice(0, 20)}`, glbConcatSha256, files }
    await writeFile(join(output, 'NOTICE.json'), `${JSON.stringify(notice, null, 2)}\n`)
    await writeFile(join(output, 'LICENSE.txt'), `${sources.map((source) => `${source.id}: ${source.license}; ${source.author}; ${source.url}; archive ${source.archive} SHA-256 ${source.sha256}`).join('\n')}\nГерои собраны из Quaternius Outfits Standard, головы и причёсок Universal Base Characters Standard и шести клипов UAL1 Standard. Проект «Сказание» задаёт цвет волос, перекрашивает ткань мага и удаляет неиспользуемые данные.\n`)
    return { ok: true, output, sources, profiles: reports, notice }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function main() {
  if (process.argv.includes('--heroes')) {
    const { values } = parseArgs({ options: { heroes: { type: 'boolean' }, out: { type: 'string' }, 'hair-dir': { type: 'string' } }, allowPositionals: true, strict: false })
    const result = await importQuaterniusHeroes({
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
      ...(typeof values['hair-dir'] === 'string' ? { hairDir: values['hair-dir'] } : {}),
    })
    process.stdout.write(`${JSON.stringify(result.profiles.map(({ key, file, bytes, sha256, hair }) => ({ key, file, bytes, sha256, hair })), null, 2)}\n`)
    return
  }
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
