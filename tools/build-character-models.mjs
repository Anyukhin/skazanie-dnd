#!/usr/bin/env node
// @ts-check
/**
 * Собирает четыре локальных actor-кандидата из проверенных Quaternius GLB/FBX.
 *
 * На этом шаге генератор намеренно пишет только в tmp/. Финальный импорт в
 * public/assets и изменение каталога выполняются отдельным reviewable шагом.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { decodePng, encodePng } from './png-codec.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TMP_ROOT = join(ROOT, 'tmp')
const DEFAULT_SOURCE = join(TMP_ROOT, 'quaternius-actor-candidate', 'ranger.glb')
const DEFAULT_SOURCE_MANIFEST = join(TMP_ROOT, 'quaternius-actor-candidate', 'manifest.json')
const DEFAULT_OUTPUT = join(TMP_ROOT, 'actor-final-candidate')
const CLIPS = Object.freeze(['Idle_Loop', 'Walk_Loop', 'Sword_Attack', 'Spell_Simple_Shoot', 'Hit_Chest', 'Death01'])
const SCOUT_ROOT = join(TMP_ROOT, 'actor-source-scout')
const SCOUT_CONVERTED = join(SCOUT_ROOT, 'converted')
const SCOUT_SOURCES = join(SCOUT_ROOT, 'sources')
const SCOUT_MODELS = Object.freeze({
  beast: {
    file: 'beast.glb', label: 'Зверь', sourceFile: join(SCOUT_SOURCES, 'Ultimate-Animated-Animals_Wolf.gltf'),
    sourceSha256: 'cc02e9d128b5715f352ee8bea086f97a35f1d875d240de99b0f9f2775c37d415',
    convertedFile: join(SCOUT_CONVERTED, 'Ultimate-Animated-Animals_Wolf.glb'),
    convertedSha256: 'bdfb3064b2d6d552bc03b07e4757c4e77cfff98f8c7f1058d6341c0eabcb5d5d',
    package: 'Ultimate Animated Animal Pack', source: 'https://quaternius.com/packs/ultimateanimatedanimals.html',
    licenseFile: 'Ultimate-Animated-Animals_License.txt', licenseSha256: '83d8959f9fc56353ed571fbe2dc52e4bcd64508e2399501cd45ac2ce3df0bf8c',
    attribution: 'Quaternius', rigRoot: 'Body', head: 'Head', handSockets: [],
    poseMap: { idle: 'Idle', walk: 'Walk', attack: 'Attack', hit: 'Idle_HitReact1', cast: null, death: 'Death' },
    clips: ['Attack', 'Death', 'Idle', 'Idle_HitReact1', 'Walk'], height: 1.18,
  },
  goblin: {
    file: 'goblin.glb', label: 'Гоблин', sourceFile: join(SCOUT_SOURCES, 'Ultimate-Animated-Character_Goblin_Male.gltf'),
    sourceSha256: 'cab2cbe315e34f1f223fac6754c1e0c3f635060b7ebd516b95e5efbc9ba2c9ea',
    convertedFile: join(SCOUT_CONVERTED, 'Ultimate-Animated-Character_Goblin_Male.glb'),
    convertedSha256: '7d46d520f1c966b559b417c3a4959bce06d988a38afc17f854e4e9e6e3c74bdd',
    package: 'Ultimate Animated Character Pack', source: 'https://quaternius.com/packs/ultimatedanimatedcharacter.html',
    licenseFile: 'Ultimate-Animated-Character_License.txt', licenseSha256: '83d8959f9fc56353ed571fbe2dc52e4bcd64508e2399501cd45ac2ce3df0bf8c',
    attribution: 'Quaternius', rigRoot: 'Bone', head: 'Head', handSockets: ['hand_l', 'hand_r'], socketParents: { hand_l: 'Fist.L', hand_r: 'Fist.R' },
    poseMap: { idle: 'Idle', walk: 'Walk', attack: 'SwordSlash', hit: 'RecieveHit', cast: null, death: 'Death' },
    clips: ['Death', 'Idle', 'RecieveHit', 'SwordSlash', 'Walk'], height: 1.18,
  },
  skeleton: {
    file: 'skeleton.glb', label: 'Скелет-воин', sourceFile: join(SCOUT_SOURCES, 'Animated-Monster_Skeleton.fbx'),
    sourceSha256: 'be0a5992b677e563c6c9601e76fdcb9d50e91c195aebb1eb70604fbfe8fb26d5',
    archiveFile: join(SCOUT_ROOT, 'archives', 'Monster-Pack-Animated-by-Quaternius.zip'),
    archiveSha256: 'c0b73e7d641a25348e46195e1413d050d08cf14302d999e0d40a634c43c47a9b',
    package: 'Animated Monster Pack', source: 'https://quaternius.itch.io/lowpoly-animated-monsters',
    licenseFile: 'Animated-Monster_License.txt', licenseSha256: '2b04fed13cc05aa0ae58f42cc8fd194121204e3151ee8abb8d35049a9b1c1d93',
    attribution: 'Animated Monsters by Quaternius', rigRoot: 'Hips', head: 'Head', handSockets: ['hand_l', 'hand_r'], socketParents: { hand_l: 'LDownLeg001_end', hand_r: 'RDownLeg001_end' },
    poseMap: { idle: 'SkeletonArmature|Skeleton_Idle', walk: 'SkeletonArmature|Skeleton_Running', attack: 'SkeletonArmature|Skeleton_Attack', hit: null, cast: null, death: 'SkeletonArmature|Skeleton_Death' },
    clips: ['SkeletonArmature|Skeleton_Attack', 'SkeletonArmature|Skeleton_Death', 'SkeletonArmature|Skeleton_Idle', 'SkeletonArmature|Skeleton_Running', 'SkeletonArmature|Skeleton_Spawn'], height: 1.4,
  },
})
const GLB_MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

function align4(value) { return (value + 3) & ~3 }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

/** @param {Buffer} source @param {string} file */
function parseGlb(source, file) {
  if (source.length < 20 || source.readUInt32LE(0) !== GLB_MAGIC || source.readUInt32LE(4) !== 2) throw new Error(`Ожидался GLB 2: ${file}`)
  const declaredLength = source.readUInt32LE(8)
  if (declaredLength !== source.length) throw new Error(`Размер GLB не совпадает: ${file}`)
  let offset = 12
  /** @type {Record<string, any>|null} */
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

/** @param {Record<string, any>} json @param {Buffer} binary */
function writeGlb(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json))
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)])
  const paddedBinary = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(GLB_MAGIC, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + paddedBinary.length, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(paddedJson.length, 0)
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4)
  const binaryHeader = Buffer.alloc(8)
  binaryHeader.writeUInt32LE(paddedBinary.length, 0)
  binaryHeader.writeUInt32LE(BIN_CHUNK, 4)
  return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, paddedBinary])
}

/** @param {{json: Record<string, any>, chunks: Buffer[], binaryLength: number}} state @param {Buffer} bytes @param {Record<string, any>} [extra] */
function appendView(state, bytes, extra = {}) {
  const offset = align4(state.binaryLength)
  if (offset > state.binaryLength) state.chunks.push(Buffer.alloc(offset - state.binaryLength))
  const value = Buffer.from(bytes)
  state.chunks.push(value)
  state.binaryLength = offset + value.length
  const view = { buffer: 0, byteOffset: offset, byteLength: value.length, ...extra }
  return state.json.bufferViews.push(view) - 1
}

/** @param {Record<string, any>} json @param {string} name */
function nodeIndex(json, name) {
  const index = json.nodes.findIndex((node) => node.name === name)
  if (index < 0) throw new Error(`Не найден узел ${name}`)
  return index
}

function ensureFileReader() {
  if (typeof globalThis.FileReader === 'function') return
  globalThis.FileReader = class {
    result = null
    error = null
    onloadend = null
    onerror = null

    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((value) => {
        this.result = value
        this.onloadend?.()
      }, (error) => {
        this.error = error
        this.onerror?.(error)
      })
    }
  }
}

/** @param {string} file @param {string} expected @param {string} label */
async function verifiedBytes(file, expected, label) {
  const bytes = await readFile(file)
  const actual = sha256(bytes)
  if (actual !== expected) throw new Error(`${label}: SHA-256 не совпал, ожидался ${expected}, получен ${actual}`)
  return bytes
}

/** @param {Record<string, any>} json @param {Buffer} binary @param {number} accessorId */
function accessorFloatRange(json, binary, accessorId) {
  const accessor = json.accessors?.[accessorId]
  const bufferView = accessor && json.bufferViews?.[accessor.bufferView]
  if (!accessor || !bufferView || accessor.componentType !== 5126 || accessor.type !== 'VEC3') throw new Error(`Ожидался float VEC3 accessor ${accessorId}`)
  const stride = bufferView.byteStride ?? 12
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < accessor.count; index += 1) for (let component = 0; component < 3; component += 1) {
    const value = binary.readFloatLE(start + index * stride + component * 4)
    min[component] = Math.min(min[component], value)
    max[component] = Math.max(max[component], value)
  }
  return { min, max }
}

/** @param {Record<string, any>} json @param {Buffer} binary @param {number} accessorId @param {number[]} baseline */
function freezeTranslationXZ(json, binary, accessorId, baseline) {
  const accessor = json.accessors?.[accessorId]
  const bufferView = accessor && json.bufferViews?.[accessor.bufferView]
  if (!accessor || !bufferView || accessor.componentType !== 5126 || accessor.type !== 'VEC3') throw new Error(`Root translation должен быть float VEC3 accessor ${accessorId}`)
  const stride = bufferView.byteStride ?? 12
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const before = accessorFloatRange(json, binary, accessorId)
  for (let index = 0; index < accessor.count; index += 1) {
    const offset = start + index * stride
    binary.writeFloatLE(baseline[0], offset)
    binary.writeFloatLE(baseline[2], offset + 8)
  }
  accessor.min = [baseline[0], before.min[1], baseline[2]]
  accessor.max = [baseline[0], before.max[1], baseline[2]]
  return { before, after: { min: [baseline[0], before.min[1], baseline[2]], max: [baseline[0], before.max[1], baseline[2]] } }
}

/** @param {{json: Record<string, any>, binary: Buffer}} document @param {{rootJointName: string, removeWrapperNames?: string[], generator: string}} options */
function sanitizeAnimationData(document, options) {
  const { json, binary } = document
  const rootJoint = nodeIndex(json, options.rootJointName)
  const rootNode = json.nodes[rootJoint]
  const baseline = rootNode.translation ?? [0, 0, 0]
  const wrapperNames = new Set(options.removeWrapperNames ?? [])
  let removedScaleChannels = 0
  let removedWrapperTranslationChannels = 0
  const rootMotion = []
  for (const animation of json.animations ?? []) {
    const channels = []
    for (const channel of animation.channels ?? []) {
      const target = json.nodes[channel.target?.node]
      if (channel.target?.path === 'scale') {
        removedScaleChannels += 1
        continue
      }
      if (channel.target?.path === 'translation' && target?.name === options.rootJointName) {
        const sampler = animation.samplers?.[channel.sampler]
        const result = freezeTranslationXZ(json, binary, sampler?.output, baseline)
        rootMotion.push({ animation: animation.name, node: options.rootJointName, before: result.before, after: result.after })
      }
      if (channel.target?.path === 'translation' && wrapperNames.has(target?.name)) {
        removedWrapperTranslationChannels += 1
        continue
      }
      channels.push(channel)
    }
    animation.channels = channels
  }
  json.asset = { ...json.asset, generator: options.generator }
  json.extras = {
    ...(json.extras ?? {}),
    skazanieAnimationSanitizer: {
      rootMotionXZ: 'frozen to rest translation; static scene transform retained',
      removedScaleChannels,
      removedWrapperTranslationChannels,
      rootMotion,
    },
  }
  return { rootJoint: options.rootJointName, removedScaleChannels, removedWrapperTranslationChannels, rootMotion }
}

/** @param {Record<string, any>} json @param {{hand_l: string, hand_r: string}|undefined} sockets */
function addSocketAliases(json, sockets) {
  if (!sockets) return []
  const added = []
  for (const [name, parentName] of Object.entries(sockets)) {
    if (json.nodes.some((node) => node.name === name)) continue
    const parent = json.nodes[nodeIndex(json, parentName)]
    const child = json.nodes.push({ name, extras: { skazanieSocket: true, sourceBone: parentName } }) - 1
    parent.children = [...(parent.children ?? []), child]
    added.push({ name, parent: parentName })
  }
  return added
}

/** @param {Record<string, any>} json @param {string} profile */
function tuneSourceMaterials(json, profile) {
  const adjustments = []
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness
    if (pbr && profile !== 'skeleton') {
      pbr.roughnessFactor = Math.max(pbr.roughnessFactor ?? 0.5, 0.78)
      adjustments.push(`${material.name ?? 'material'}: roughness>=0.78`)
    }
    if (profile === 'skeleton' && material.name === 'Skeleton' && material.emissiveFactor) {
      delete material.emissiveFactor
      adjustments.push('Skeleton: removed source emissive glow')
    }
  }
  return adjustments
}

/** @param {Record<string, any>} json */
function tuneMageMaterials(json) {
  const adjustments = []
  for (const material of json.materials ?? []) {
    if (material.name !== 'MI_Ranger') continue
    const pbr = material.pbrMetallicRoughness ?? (material.pbrMetallicRoughness = {})
    pbr.baseColorFactor = [1, 1, 1, 1]
    pbr.metallicFactor = Math.min(pbr.metallicFactor ?? 0, 0.08)
    pbr.roughnessFactor = Math.max(pbr.roughnessFactor ?? 0.5, 0.82)
    adjustments.push('MI_Ranger: green texels are remapped to muted blue-violet; folds/source texture retained')
  }
  if (!adjustments.length) throw new Error('mage: в ranger GLB не найден MI_Ranger')
  return adjustments
}

function hslOf(red, green, blue) {
  red /= 255; green /= 255; blue /= 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  const lightness = (max + min) / 2
  if (!delta) return { hue: 0, saturation: 0, lightness }
  const saturation = lightness > .5 ? delta / (2 - max - min) : delta / (max + min)
  let hue
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0)
  else if (max === green) hue = (blue - red) / delta + 2
  else hue = (red - green) / delta + 4
  return { hue: hue / 6, saturation, lightness }
}

function huePart(p, q, value) {
  let t = value
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < .5) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

function rgbFromHsl(hue, saturation, lightness) {
  if (!saturation) return [lightness, lightness, lightness]
  const q = lightness < .5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  return [huePart(p, q, hue + 1 / 3), huePart(p, q, hue), huePart(p, q, hue - 1 / 3)]
}

function mageBlueVioletTexture(image) {
  const data = new Uint8Array(image.data)
  let beforeGreen = 0
  let afterGreen = 0
  let changedPixels = 0
  let beforeLuma = 0
  let afterLuma = 0
  for (let at = 0; at < data.length; at += 4) {
    const red = data[at]
    const green = data[at + 1]
    const blue = data[at + 2]
    if (!(green > red * 1.12 && green > blue * 1.08)) continue
    beforeGreen += 1
    const oldLuma = .2126 * red + .7152 * green + .0722 * blue
    const hsl = hslOf(red, green, blue)
    let [nextRed, nextGreen, nextBlue] = rgbFromHsl(.70, Math.min(.52, Math.max(.16, hsl.saturation * .72)), hsl.lightness).map((value) => value * 255)
    const nextLuma = .2126 * nextRed + .7152 * nextGreen + .0722 * nextBlue
    const lumaScale = nextLuma > 0 ? oldLuma / nextLuma : 1
    nextRed = Math.max(0, Math.min(255, nextRed * lumaScale))
    nextGreen = Math.max(0, Math.min(255, nextGreen * lumaScale))
    nextBlue = Math.max(0, Math.min(255, nextBlue * lumaScale))
    data[at] = Math.round(nextRed)
    data[at + 1] = Math.round(nextGreen)
    data[at + 2] = Math.round(nextBlue)
    if (data[at + 1] > data[at] * 1.12 && data[at + 1] > data[at + 2] * 1.08) afterGreen += 1
    changedPixels += 1
    beforeLuma += oldLuma
    afterLuma += .2126 * data[at] + .7152 * data[at + 1] + .0722 * data[at + 2]
  }
  if (!beforeGreen || !changedPixels) throw new Error('mage: ranger baseColor не содержит проверяемых зелёных texels')
  return {
    image: { width: image.width, height: image.height, data },
    beforeGreen, afterGreen, changedPixels,
    lumaBefore: beforeLuma / beforeGreen, lumaAfter: afterLuma / beforeGreen,
    lumaRatio: beforeLuma ? afterLuma / beforeLuma : 1,
  }
}

/** @param {{json: Record<string, any>, binary: Buffer}} document */
function recolorMageTextures(document) {
  const { json, binary } = document
  const textureIds = new Set()
  for (const material of json.materials ?? []) {
    if (material.name !== 'MI_Ranger') continue
    const texture = material.pbrMetallicRoughness?.baseColorTexture
    if (Number.isInteger(texture?.index)) textureIds.add(texture.index)
  }
  if (!textureIds.size) throw new Error('mage: MI_Ranger без baseColorTexture')
  const state = { json, chunks: [binary], binaryLength: binary.length }
  const reports = []
  const images = new Set()
  for (const textureId of textureIds) {
    const texture = json.textures?.[textureId]
    const imageId = texture?.source
    if (!Number.isInteger(imageId) || images.has(imageId)) continue
    images.add(imageId)
    const image = json.images?.[imageId]
    const view = image && json.bufferViews?.[image.bufferView]
    if (!image || !view || image.mimeType !== 'image/png') throw new Error(`mage: MI_Ranger image ${imageId} не PNG или без bufferView`)
    const start = view.byteOffset ?? 0
    const end = start + (view.byteLength ?? 0)
    if (start < 0 || end > binary.length) throw new Error(`mage: MI_Ranger image ${imageId} выходит за BIN`)
    const recolored = mageBlueVioletTexture(decodePng(binary.subarray(start, end)))
    if (recolored.afterGreen > recolored.beforeGreen * .08 || recolored.lumaRatio < .96 || recolored.lumaRatio > 1.04) {
      throw new Error(`mage: перекраска ${image.name ?? imageId} не прошла palette guard`)
    }
    const viewId = appendView(state, encodePng(recolored.image))
    image.bufferView = viewId
    const { image: _recoloredImage, ...textureReport } = recolored
    reports.push({ image: image.name ?? `image-${imageId}`, sourceImage: imageId, ...textureReport })
  }
  document.binary = Buffer.concat(state.chunks, state.binaryLength)
  if (!reports.length) throw new Error('mage: не перекрашена MI_Ranger baseColor')
  return reports
}

/** @param {Buffer} sourceBytes */
async function convertSkeletonFbx(sourceBytes) {
  ensureFileReader()
  const loader = new FBXLoader()
  const object = loader.parse(sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength), '')
  const exported = await new GLTFExporter().parseAsync(object, { binary: true, onlyVisible: true, trs: true, animations: object.animations ?? [] })
  if (!(exported instanceof ArrayBuffer)) throw new Error('FBX skeleton export вернул текст вместо GLB')
  return Buffer.from(exported)
}

/** @param {{json: Record<string, any>, binary: Buffer}} document @param {THREE.Matrix4[]} matrices @param {number} accessorId */
function appendInverseBindMatrices(document, matrices, accessorId) {
  const { json, binary } = document
  const sourceAccessor = json.accessors?.[accessorId]
  const sourceView = sourceAccessor && json.bufferViews?.[sourceAccessor.bufferView]
  if (!sourceAccessor || !sourceView || sourceAccessor.componentType !== 5126 || sourceAccessor.type !== 'MAT4') throw new Error('Skeleton inverse bind matrices должны быть float MAT4')
  const sourceStride = sourceView.byteStride ?? 64
  const sourceStart = (sourceView.byteOffset ?? 0) + (sourceAccessor.byteOffset ?? 0)
  const oldData = Buffer.alloc(sourceAccessor.count * 64)
  for (let index = 0; index < sourceAccessor.count; index += 1) for (let component = 0; component < 16; component += 1) {
    oldData.writeFloatLE(binary.readFloatLE(sourceStart + index * sourceStride + component * 4), index * 64 + component * 4)
  }
  const addedData = Buffer.alloc(matrices.length * 64)
  for (const [index, matrix] of matrices.entries()) for (let component = 0; component < 16; component += 1) addedData.writeFloatLE(matrix.elements[component], index * 64 + component * 4)
  const state = { json, chunks: [binary], binaryLength: binary.length }
  const view = appendView(state, Buffer.concat([oldData, addedData]))
  const accessor = { bufferView: view, componentType: 5126, count: sourceAccessor.count + matrices.length, type: 'MAT4' }
  const nextAccessor = json.accessors.push(accessor) - 1
  return { binary: Buffer.concat(state.chunks, state.binaryLength), accessor: nextAccessor }
}

/** @param {Buffer} bytes @param {{json: Record<string, any>, binary: Buffer}} document */
async function preserveSkeletonEndJoints(bytes, document) {
  const skin = document.json.skins?.[0]
  if (!skin || !Array.isArray(skin.joints)) throw new Error('Skeleton GLB без skin joints')
  const existing = new Set(skin.joints)
  const endIndices = document.json.nodes.map((node, index) => ({ node, index })).filter(({ node, index }) => /_end$/u.test(node.name ?? '') && !existing.has(index))
  if (!endIndices.length) return { sourceBoneCount: skin.joints.length, skinnedBoneCount: skin.joints.length, added: [] }
  const previousSelf = globalThis.self
  const previousProgressEvent = globalThis.ProgressEvent
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.ProgressEvent ??= class { constructor(type, values) { this.type = type; Object.assign(this, values) } }
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })
  try {
    const gltf = await new Promise((resolvePromise, reject) => new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', resolvePromise, reject))
    gltf.scene.updateMatrixWorld(true)
    let mesh
    gltf.scene.traverse((object) => { if (!mesh && object.isSkinnedMesh) mesh = object })
    if (!mesh) throw new Error('Skeleton GLB без SkinnedMesh')
    const meshWorld = mesh.matrixWorld.clone()
    const matrices = endIndices.map(({ node }) => {
      const joint = gltf.scene.getObjectByName(node.name)
      if (!joint) throw new Error(`Skeleton end joint не найден: ${node.name}`)
      return joint.matrixWorld.clone().invert().multiply(meshWorld)
    })
    const next = appendInverseBindMatrices(document, matrices, skin.inverseBindMatrices)
    skin.joints = [...skin.joints, ...endIndices.map(({ index }) => index)]
    skin.inverseBindMatrices = next.accessor
    document.binary = next.binary
    document.json.extras = {
      ...(document.json.extras ?? {}),
      skazanieSkeletonRig: { sourceBones: skin.joints.length, addedEndJoints: endIndices.map(({ node }) => node.name), inverseBindMatrices: 'meshWorld-relative; generated from exported FBX bind pose' },
    }
    return { sourceBoneCount: skin.joints.length, skinnedBoneCount: skin.joints.length, added: endIndices.map(({ node }) => node.name) }
  } finally {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
    if (previousProgressEvent === undefined) delete globalThis.ProgressEvent; else globalThis.ProgressEvent = previousProgressEvent
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
  }
}

/** @param {Record<string, any>} json @param {Buffer} binary @param {number} accessorId @param {number} index */
function readAccessorComponent(json, binary, accessorId, index) {
  const accessor = json.accessors?.[accessorId]
  const view = accessor && json.bufferViews?.[accessor.bufferView]
  if (!accessor || !view) throw new Error(`Не найден accessor ${accessorId}`)
  const components = accessor.type === 'VEC4' ? 4 : accessor.type === 'VEC3' ? 3 : accessor.type === 'VEC2' ? 2 : 1
  const bytes = accessor.componentType === 5121 ? 1 : accessor.componentType === 5123 ? 2 : accessor.componentType === 5126 ? 4 : 0
  if (!bytes) throw new Error(`Неподдерживаемый accessor ${accessorId}`)
  const stride = view.byteStride ?? components * bytes
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * stride
  const result = []
  for (let component = 0; component < components; component += 1) {
    const at = offset + component * bytes
    result.push(accessor.componentType === 5121 ? binary.readUInt8(at) : accessor.componentType === 5123 ? binary.readUInt16LE(at) : binary.readFloatLE(at))
  }
  return result
}

/** @param {Record<string, any>} json @param {Buffer} binary @param {number} accessorId @param {number} index @param {number[]} point */
function writePosition(json, binary, accessorId, index, point) {
  const accessor = json.accessors?.[accessorId]
  const view = accessor && json.bufferViews?.[accessor.bufferView]
  if (!accessor || !view || accessor.componentType !== 5126 || accessor.type !== 'VEC3') throw new Error(`Position accessor ${accessorId} должен быть float VEC3`)
  const stride = view.byteStride ?? 12
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * stride
  for (let component = 0; component < 3; component += 1) binary.writeFloatLE(point[component], offset + component * 4)
}

/** @param {Record<string, any>} json @param {Buffer} binary @param {number} accessorId */
function updatePositionBounds(json, binary, accessorId) {
  const accessor = json.accessors[accessorId]
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < accessor.count; index += 1) {
    const point = readAccessorComponent(json, binary, accessorId, index)
    for (let component = 0; component < 3; component += 1) {
      min[component] = Math.min(min[component], point[component])
      max[component] = Math.max(max[component], point[component])
    }
  }
  accessor.min = min
  accessor.max = max
}

/** @param {Buffer} bytes @param {{json: Record<string, any>, binary: Buffer}} document @param {number} factor */
async function scaleHeadGeometry(bytes, document, factor) {
  if (!(factor > 0 && factor <= 1)) throw new Error(`Некорректный head scale ${factor}`)
  const skin = document.json.skins?.[0]
  const headJoint = skin?.joints?.findIndex((index) => document.json.nodes[index]?.name === 'Head') ?? -1
  if (headJoint < 0) throw new Error('В actor GLB нет кости Head')
  const previousSelf = globalThis.self
  const previousProgressEvent = globalThis.ProgressEvent
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.ProgressEvent ??= class { constructor(type, values) { this.type = type; Object.assign(this, values) } }
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })
  try {
    const gltf = await new Promise((resolvePromise, reject) => new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', resolvePromise, reject))
    gltf.scene.updateMatrixWorld(true)
    const head = gltf.scene.getObjectByName('Head')
    let mesh
    gltf.scene.traverse((object) => { if (!mesh && object.isSkinnedMesh) mesh = object })
    if (!head || !mesh) throw new Error('Не найден Head или SkinnedMesh для head scale')
    const meshInverse = mesh.matrixWorld.clone().invert()
    const pivot = new THREE.Vector3()
    head.getWorldPosition(pivot)
    pivot.applyMatrix4(meshInverse)
    const changedAccessors = new Set()
    let changedVertices = 0
    let changedPrimitives = 0
    for (const meshDefinition of document.json.meshes ?? []) for (const primitive of meshDefinition.primitives ?? []) {
      const positionId = primitive.attributes?.POSITION
      const jointsId = primitive.attributes?.JOINTS_0
      const weightsId = primitive.attributes?.WEIGHTS_0
      if (!Number.isInteger(positionId) || !Number.isInteger(jointsId) || !Number.isInteger(weightsId) || changedAccessors.has(positionId)) continue
      const position = document.json.accessors[positionId]
      const joints = document.json.accessors[jointsId]
      const weights = document.json.accessors[weightsId]
      if (position?.type !== 'VEC3' || position?.componentType !== 5126 || joints?.type !== 'VEC4' || weights?.type !== 'VEC4') throw new Error('Head scale требует POSITION/JOINTS_0/WEIGHTS_0')
      let primitiveVertices = 0
      for (let index = 0; index < position.count; index += 1) {
        const jointRow = readAccessorComponent(document.json, document.binary, jointsId, index)
        const weightRow = readAccessorComponent(document.json, document.binary, weightsId, index)
        if (!jointRow.some((joint, slot) => joint === headJoint && weightRow[slot] > 0.45)) continue
        const point = readAccessorComponent(document.json, document.binary, positionId, index)
        const scaled = pivot.toArray().map((value, component) => value + (point[component] - value) * factor)
        writePosition(document.json, document.binary, positionId, index, scaled)
        changedVertices += 1
        primitiveVertices += 1
      }
      if (primitiveVertices) { changedPrimitives += 1; changedAccessors.add(positionId); updatePositionBounds(document.json, document.binary, positionId) }
    }
    if (!changedVertices) throw new Error(`Head scale ${factor}: не найдено head vertices`)
    return { factor, pivot: pivot.toArray(), headJointIndex: headJoint, changedVertices, changedPrimitives }
  } finally {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
    if (previousProgressEvent === undefined) delete globalThis.ProgressEvent; else globalThis.ProgressEvent = previousProgressEvent
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
  }
}

/** @param {Buffer} bytes @param {{key: string, label: string, poseMap: Record<string, string|null>, height: number, rigRoot: string}} spec @param {{removedScaleChannels: number}} animationReport @param {{requireScaleSanitization?: boolean}} [options] */
async function inspectRuntimeCandidate(bytes, spec, animationReport, options = {}) {
  if (options.requireScaleSanitization !== false && animationReport.removedScaleChannels <= 0) throw new Error(`${spec.key}: в source не найдено ни одного scale channel для удаления`)
  const previousSelf = globalThis.self
  const previousProgressEvent = globalThis.ProgressEvent
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.ProgressEvent ??= class { constructor(type, values) { this.type = type; Object.assign(this, values) } }
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })
  try {
    const loader = new GLTFLoader()
    const gltf = await new Promise((resolvePromise, reject) => loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', resolvePromise, reject))
    gltf.scene.updateMatrixWorld(true)
    const restBox = new THREE.Box3().setFromObject(gltf.scene)
    let forward = null
    if (spec.key === 'beast') {
      const body = gltf.scene.getObjectByName('Body')
      const head = gltf.scene.getObjectByName('Head')
      if (body && head) {
        const bodyPosition = body.getWorldPosition(new THREE.Vector3())
        const headPosition = head.getWorldPosition(new THREE.Vector3())
        const direction = headPosition.sub(bodyPosition)
        forward = { from: 'Body', to: 'Head', vector: direction.toArray(), yawToPlusZ: Math.atan2(direction.x, direction.z) }
      }
    }
    const idleName = spec.poseMap.idle
    const idle = idleName ? gltf.animations.find((clip) => clip.name === idleName) : undefined
    if (!idle) throw new Error(`${spec.key}: отсутствует честный idle clip ${idleName}`)
    const bones = []
    gltf.scene.traverse((object) => { if (object.isBone) bones.push(object) })
    const beforeRotations = new Map(bones.map((bone) => [bone.uuid, bone.quaternion.clone()]))
    const mixer = new THREE.AnimationMixer(gltf.scene)
    const action = mixer.clipAction(idle).reset().play()
    mixer.update(Math.min(Math.max(idle.duration * 0.37, 1 / 60), 0.25))
    gltf.scene.updateMatrixWorld(true)
    const idleBox = new THREE.Box3().setFromObject(gltf.scene)
    const changedBones = bones.filter((bone) => !bone.quaternion.equals(beforeRotations.get(bone.uuid))).length
    const wrapper = new THREE.Group()
    wrapper.add(gltf.scene)
    const restHeight = restBox.max.y - restBox.min.y
    if (!Number.isFinite(restHeight) || restHeight <= 0) throw new Error(`${spec.key}: rest bounds имеют неположительную высоту`)
    const fitScale = spec.height / restHeight
    wrapper.scale.setScalar(fitScale)
    wrapper.position.y -= restBox.min.y * fitScale
    wrapper.position.x -= ((restBox.min.x + restBox.max.x) / 2) * fitScale
    wrapper.position.z -= ((restBox.min.z + restBox.max.z) / 2) * fitScale
    wrapper.updateMatrixWorld(true)
    const fittedIdleBox = new THREE.Box3().setFromObject(wrapper)
    const scaleBefore = wrapper.scale.toArray()
    mixer.update(Math.min(idle.duration * 0.13, 0.25))
    wrapper.updateMatrixWorld(true)
    const scaleAfter = wrapper.scale.toArray()
    const finite = [...restBox.min.toArray(), ...restBox.max.toArray(), ...idleBox.min.toArray(), ...idleBox.max.toArray(), ...fittedIdleBox.min.toArray(), ...fittedIdleBox.max.toArray()].every(Number.isFinite)
    if (!finite || changedBones <= 0 || scaleBefore.some((value, index) => Math.abs(value - scaleAfter[index]) > 1e-12)) throw new Error(`${spec.key}: idle/scale/bounds runtime proof failed`)
    action.stop()
    mixer.uncacheRoot(gltf.scene)
    return {
      idleClip: idle.name,
      changedBones,
      rest: { min: restBox.min.toArray(), max: restBox.max.toArray(), size: restBox.getSize(new THREE.Vector3()).toArray() },
      afterIdle: { min: idleBox.min.toArray(), max: idleBox.max.toArray(), size: idleBox.getSize(new THREE.Vector3()).toArray() },
      fittedAfterIdle: { min: fittedIdleBox.min.toArray(), max: fittedIdleBox.max.toArray(), size: fittedIdleBox.getSize(new THREE.Vector3()).toArray() },
      fitScale,
      wrapperScaleBefore: scaleBefore,
      wrapperScaleAfter: scaleAfter,
      forward,
      finite,
      scaleChannelsRemaining: 0,
      bones: bones.length,
      animations: gltf.animations.map((clip) => ({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length })),
    }
  } finally {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
    if (previousProgressEvent === undefined) delete globalThis.ProgressEvent; else globalThis.ProgressEvent = previousProgressEvent
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
  }
}

/** @param {keyof typeof SCOUT_MODELS} key @param {string} target */
async function buildScoutModel(key, target) {
  const spec = SCOUT_MODELS[key]
  const sourceBytes = await verifiedBytes(spec.sourceFile, spec.sourceSha256, `${key}: исходник scout`)
  const licensePath = join(SCOUT_SOURCES, spec.licenseFile)
  await verifiedBytes(licensePath, spec.licenseSha256, `${key}: License.txt`)
  let sourceGlb
  let conversion
  if (key === 'skeleton') {
    const archive = await verifiedBytes(spec.archiveFile, spec.archiveSha256, `${key}: архив`)
    conversion = { archiveBytes: archive.length, archiveSha256: sha256(archive) }
    sourceGlb = await convertSkeletonFbx(sourceBytes)
  } else {
    sourceGlb = await verifiedBytes(spec.convertedFile, spec.convertedSha256, `${key}: scout GLB`)
    conversion = { convertedBytes: sourceGlb.length, convertedSha256: sha256(sourceGlb) }
  }
  const parsed = parseGlb(sourceGlb, key)
  if (parsed.json.buffers?.some((buffer) => buffer.uri) || parsed.json.images?.some((image) => image.uri)) throw new Error(`${key}: внешний ресурс в scout GLB`)
  const headAdjustment = key === 'goblin' ? await scaleHeadGeometry(sourceGlb, parsed, 0.78) : key === 'skeleton' ? await scaleHeadGeometry(sourceGlb, parsed, 0.65) : null
  const skeletonRig = key === 'skeleton' ? await preserveSkeletonEndJoints(sourceGlb, parsed) : null
  const animationReport = sanitizeAnimationData(parsed, { rootJointName: spec.rigRoot, removeWrapperNames: key === 'skeleton' ? ['SkeletonArmature'] : [], generator: `skazanie-${key}-candidate/v1` })
  const socketAliases = addSocketAliases(parsed.json, spec.socketParents)
  const materialAdjustments = tuneSourceMaterials(parsed.json, key)
  parsed.json.extras = {
    ...(parsed.json.extras ?? {}),
    skazanieCandidate: {
      profile: key, ...(key === 'beast' ? { sourceSpecies: 'wolf' } : {}), sourcePack: spec.package, sourceUrl: spec.source,
      sourceFile: relative(ROOT, spec.sourceFile).split(sep).join('/'), sourceSha256: spec.sourceSha256,
      rig: { root: spec.rigRoot, head: spec.head, handSockets: spec.handSockets, socketAliases, ...(skeletonRig ? { bones: skeletonRig.skinnedBoneCount } : {}) },
      poseMap: spec.poseMap, sourceClips: spec.clips,
      materialAdjustments, headAdjustment,
    },
  }
  parsed.json.buffers[0].byteLength = parsed.binary.length
  const outputBytes = writeGlb(parsed.json, parsed.binary)
  const outputFile = join(target, spec.file)
  await writeFile(outputFile, outputBytes)
  const runtime = await inspectRuntimeCandidate(outputBytes, { ...spec, key }, animationReport)
  const sourceInfo = {
    package: spec.package, species: key === 'beast' ? 'wolf' : key, url: spec.source, file: relative(ROOT, spec.sourceFile).split(sep).join('/'), sha256: spec.sourceSha256,
    license: 'CC0-1.0', licenseFile: `tmp/actor-source-scout/sources/${spec.licenseFile}`, licenseSha256: spec.licenseSha256,
    ...(spec.archiveFile ? { archive: relative(ROOT, spec.archiveFile).split(sep).join('/'), archiveSha256: spec.archiveSha256 } : {}),
    ...conversion,
  }
  return {
    key, label: spec.label, file: spec.file, bytes: outputBytes.length, sha256: sha256(outputBytes),
    clips: parsed.json.animations?.map((animation) => animation.name) ?? [], sourceClips: spec.clips, poseMap: spec.poseMap,
    rig: { root: spec.rigRoot, head: spec.head, handSockets: spec.handSockets, socketAliases, ...(skeletonRig ? { bones: skeletonRig.skinnedBoneCount } : {}) },
    headAdjustment, source: sourceInfo, animation: animationReport, runtime,
    provenance: { source: spec.source, sourceFile: sourceInfo.file, sourceSha256: spec.sourceSha256, license: 'CC0-1.0', attribution: spec.attribution, licenseFile: sourceInfo.licenseFile, licenseSha256: spec.licenseSha256, ...(spec.archiveSha256 ? { archiveSha256: spec.archiveSha256 } : {}) },
  }
}

/** @param {string} sourceFile @param {string} sourceManifestFile @param {string} output */
export async function buildCharacterModels({ sourceFile = DEFAULT_SOURCE, sourceManifestFile = DEFAULT_SOURCE_MANIFEST, output = DEFAULT_OUTPUT } = {}) {
  const target = resolve(output)
  const tmpPrefix = `${resolve(TMP_ROOT)}${sep}`
  if (!target.startsWith(tmpPrefix)) throw new Error('Кандидат должен лежать внутри tmp/')
  const outputInfo = await lstat(target).catch((error) => { if (error?.code === 'ENOENT') return null; throw error })
  if (outputInfo && (!outputInfo.isDirectory() || outputInfo.isSymbolicLink())) throw new Error(`Нужен обычный каталог: ${target}`)
  if (outputInfo) {
    const entries = await readdir(target)
    if (entries.length) throw new Error(`Каталог кандидата не пуст: ${target}`)
  } else await mkdir(target, { recursive: true })
  const sourcePath = resolve(sourceFile)
  const sourceBytes = await readFile(sourcePath)
  const source = parseGlb(sourceBytes, sourcePath)
  const sourceManifest = JSON.parse(await readFile(resolve(sourceManifestFile), 'utf8'))
  const mageJson = structuredClone(source.json)
  let mageBinary = Buffer.from(source.binary)
  if (mageJson.buffers?.some((buffer) => buffer.uri) || mageJson.images?.some((image) => image.uri)) throw new Error('mage: ranger GLB содержит внешний ресурс')
  const materialAdjustments = tuneMageMaterials(mageJson)
  const mageDocument = { json: mageJson, binary: mageBinary }
  const textureAdjustments = recolorMageTextures(mageDocument)
  mageBinary = mageDocument.binary
  const mageAnimationReport = sanitizeAnimationData({ json: mageJson, binary: mageBinary }, { rootJointName: 'root', generator: 'skazanie-mage-candidate/v2' })
  mageJson.buffers[0].byteLength = mageBinary.length
  mageJson.asset = { ...mageJson.asset, generator: 'skazanie-mage-candidate/v2' }
  mageJson.extras = {
    ...(mageJson.extras ?? {}),
    skazanie: {
      profile: 'mage',
      authoredParts: [],
      sourceModel: 'Quaternius ranger.glb',
      clips: CLIPS,
      rigBinding: 'Quaternius ranger skin and UAL1 animations preserved; palette-only mage adaptation',
      materialAdjustments, textureAdjustments,
    },
  }
  const outputBytes = writeGlb(mageJson, mageBinary)
  const outputFile = join(target, 'mage.glb')
  await writeFile(outputFile, outputBytes)

  const mageLicenseFiles = {
    'universal-base-characters-standard': join(TMP_ROOT, 'quaternius-actors-standard-20260911', 'extracted', 'Universal-Base-Characters-Standard', 'Universal Base Characters[Standard]', 'License_Standard.txt'),
    'modular-character-outfits-fantasy-standard': join(TMP_ROOT, 'quaternius-actors-standard-20260911', 'extracted', 'Modular-Character-Outfits-Fantasy-Standard', 'Modular Character Outfits - Fantasy[Standard]', 'License_Standard.txt'),
    'universal-animation-library-standard': join(TMP_ROOT, 'quaternius-actors-standard-20260911', 'extracted', 'Universal-Animation-Library-Standard', 'Universal Animation Library[Standard]', 'License.txt'),
  }
  const mageLicenseHashes = Object.fromEntries(await Promise.all(Object.entries(mageLicenseFiles).map(async ([id, file]) => [id, { file: relative(ROOT, file).split(sep).join('/'), sha256: sha256(await readFile(file)) }])))
  const sourceRefs = sourceManifest.sources?.map((source) => ({ id: source.id, author: source.author, url: source.url, license: source.license, archiveSha256: source.archiveSha256 ?? source.sha256, licenseFile: mageLicenseHashes[source.id]?.file, licenseSha256: mageLicenseHashes[source.id]?.sha256 })) ?? []
  const mageRuntime = await inspectRuntimeCandidate(outputBytes, { key: 'mage', label: 'Волшебник', poseMap: { idle: 'Idle_Loop' }, height: 1.4, rigRoot: 'root' }, mageAnimationReport)
  const profile = {
    key: 'mage', label: 'Волшебник', file: 'mage.glb', sourceModel: 'ranger.glb',
    bytes: outputBytes.length, sha256: sha256(outputBytes), sourceModelSha256: sha256(sourceBytes), clips: CLIPS,
    rig: { root: 'root', head: 'Head', handSockets: ['hand_l', 'hand_r'] }, poseMap: { idle: 'Idle_Loop', walk: 'Walk_Loop', attack: 'Sword_Attack', hit: 'Hit_Chest', cast: 'Spell_Simple_Shoot', death: 'Death01' },
    authoredParts: [], materialAdjustments, textureAdjustments,
    animation: mageAnimationReport, runtime: mageRuntime,
    provenance: { sources: sourceRefs.map((source) => source.id), sourceSha256: sha256(sourceBytes), archiveSha256: sourceRefs[0]?.archiveSha256, licenseSha256: sourceRefs.map((source) => source.licenseSha256).filter(Boolean), license: 'CC0-1.0', attribution: 'Quaternius; палитра адаптирована проектом «Сказание»' },
  }
  const scoutProfiles = []
  for (const key of ['beast', 'goblin', 'skeleton']) scoutProfiles.push(await buildScoutModel(key, target))
  const profiles = [profile, ...scoutProfiles]
  const allSources = [...sourceRefs, ...scoutProfiles.map((entry) => entry.source)]
  const manifest = {
    version: 1,
    schema: 'skazanie-actor-final-candidate/v1',
    sources: allSources,
    build: {
      importer: 'tools/build-character-models.mjs', importerVersion: 2,
      sourceManifest: 'tmp/quaternius-actor-candidate/manifest.json', rootMotionXZ: 'frozen per source rig while static scene transforms are retained',
      authoredGeometry: 'palette-only mage adaptation; source geometry preserved', rigs: Object.fromEntries(profiles.map((entry) => [entry.key, entry.rig])),
      profiles,
    },
    profiles,
  }
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(target, 'NOTICE.json'), `${JSON.stringify({
    outputs: profiles.map((entry) => ({ key: entry.key, file: entry.file, bytes: entry.bytes, sha256: entry.sha256, clips: entry.clips, rig: entry.rig, poseMap: entry.poseMap, source: entry.source, provenance: entry.provenance, headAdjustment: entry.headAdjustment, textureAdjustments: entry.textureAdjustments, animation: entry.animation, runtime: entry.runtime })),
    sources: allSources, authoredGeometry: profile.authoredParts.map((part) => part.name), authoredBy: 'Проект «Сказание» (mage palette only)', noExternalResources: true,
  }, null, 2)}\n`)
  await writeFile(join(target, 'LICENSE.txt'), `${allSources.map((source) => `${source.id ?? source.package}: ${source.license}; ${source.author ?? 'Quaternius'}; ${source.url}; source SHA-256 ${source.sha256 ?? source.archiveSha256}; license SHA-256 ${source.licenseSha256 ?? 'see source manifest'}`).join('\n')}\nMage использует исходную геометрию Quaternius ranger; проект «Сказание» изменяет только палитру материала.\n`)
  return { ok: true, output: target, profiles, manifest }
}

async function main() {
  const args = process.argv.slice(2)
  const value = (name, fallback) => {
    const index = args.indexOf(name)
    return index < 0 ? fallback : args[index + 1]
  }
  const options = { sourceFile: value('--source', DEFAULT_SOURCE), sourceManifestFile: value('--source-manifest', DEFAULT_SOURCE_MANIFEST), output: value('--out', DEFAULT_OUTPUT) }
  process.stdout.write(`${JSON.stringify(await buildCharacterModels(options), null, 2)}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('build-character-models.mjs')) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1 })
