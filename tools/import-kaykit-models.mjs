// Модели KayKit из официальных CC0-наборов. Версии закреплены, исходники
// нужны только при обновлении ассетов: во время игры файлы обслуживает сам проект.
//
// node tools/import-kaykit-models.mjs            — набор 1.0 (четыре модели, загрузка с GitHub);
// node tools/import-kaykit-models.mjs --v2       — Adventurers 2.0 + Skeletons 1.1 + Character
//   Animations 1.1 из локальных архивов itch.io (по умолчанию tmp/asset-src, --archives <dir>),
//   результат — неизменяемый каталог public/assets/models/kaykit/characters-<sha>/ (или --out <dir>).
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const output = join(ROOT, 'public', 'assets', 'models', 'kaykit')
const packs = {
  adventurers: { repo: 'KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0', revision: '672074b73ba276876a19e8816ecdc5241817ab47', directory: 'addons/kaykit_character_pack_adventures' },
  skeletons: { repo: 'KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0', revision: '15b62b9bad122f72926c10fb14d622c73819fa54', directory: 'addons/kaykit_character_pack_skeletons' },
}
const models = [
  { source: 'Knight', file: 'knight.glb', pack: 'adventurers', hidden: ['1H_Sword_Offhand', 'Badge_Shield', 'Rectangle_Shield', 'Spike_Shield', '2H_Sword'], attack: '1H_Melee_Attack_Chop' },
  { source: 'Mage', file: 'mage.glb', pack: 'adventurers', hidden: ['Spellbook_open', '1H_Wand'], attack: '2H_Melee_Attack_Chop' },
  { source: 'Rogue', file: 'rogue.glb', pack: 'adventurers', hidden: ['1H_Crossbow', '2H_Crossbow', 'Throwable'], attack: 'Dualwield_Melee_Attack_Slice' },
  { source: 'Skeleton_Warrior', file: 'skeleton-warrior.glb', pack: 'skeletons', hidden: [], attack: 'Unarmed_Melee_Attack_Punch_A' },
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const padded = (bytes, fill = 0) => {
  const result = Buffer.alloc(Math.ceil(bytes.length / 4) * 4, fill)
  bytes.copy(result)
  return result
}
async function download(pack, path) {
  const url = `https://raw.githubusercontent.com/${pack.repo}/${pack.revision}/${path}`
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${response.status}: ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Файл превышает 16 МБ')
  return bytes
}

/** Оставляем нужные клипы и переносим только используемые двоичные блоки. */
function prepare(source, model) {
  if (source.readUInt32LE(0) !== 0x46546c67 || source.readUInt32LE(4) !== 2) throw new Error('Ожидался GLB 2')
  const jsonLength = source.readUInt32LE(12)
  const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString('utf8'))
  const binaryHeader = 20 + jsonLength
  if (source.readUInt32LE(binaryHeader + 4) !== 0x004e4942 || json.buffers.length !== 1) throw new Error('Ожидался один встроенный buffer')
  const binary = source.subarray(binaryHeader + 8, binaryHeader + 8 + source.readUInt32LE(binaryHeader))
  const clips = { idle: 'Idle', walk: 'Walking_A', attack: model.attack, cast: 'Spellcast_Raise', hit: 'Hit_A', death: 'Death_A' }
  json.animations = Object.entries(clips).map(([name, original]) => {
    const clip = json.animations.find((entry) => entry.name === original)
    if (!clip) throw new Error(`Нет клипа ${original} в ${model.source}`)
    return { ...clip, name }
  })
  // В исходнике варианты оружия лежат одновременно на одной кости. Сохраняем
  // один комплект; узлы и кости не удаляем, поэтому ссылки анимаций стабильны.
  for (const name of model.hidden) {
    const node = json.nodes.find((entry) => entry.name === name)
    if (!node || node.mesh == null) throw new Error(`Не найден аксессуар ${name}`)
    delete node.mesh
  }
  const meshIds = [...new Set(json.nodes.filter((node) => node.mesh != null).map((node) => node.mesh))].sort((a, b) => a - b)
  const meshIndex = new Map(meshIds.map((id, index) => [id, index]))
  json.nodes.forEach((node) => { if (node.mesh != null) node.mesh = meshIndex.get(node.mesh) })
  json.meshes = meshIds.map((id) => json.meshes[id])
  const visitAccessors = (map) => {
    for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
      if (primitive.indices != null) primitive.indices = map(primitive.indices)
      for (const attributes of [primitive.attributes, ...(primitive.targets ?? [])]) {
        for (const key of Object.keys(attributes)) attributes[key] = map(attributes[key])
      }
    }
    for (const skin of json.skins ?? []) if (skin.inverseBindMatrices != null) skin.inverseBindMatrices = map(skin.inverseBindMatrices)
    for (const clip of json.animations) for (const sampler of clip.samplers) {
      sampler.input = map(sampler.input); sampler.output = map(sampler.output)
    }
  }
  const usedAccessors = new Set()
  visitAccessors((id) => { usedAccessors.add(id); return id })
  const accessorIds = [...usedAccessors].sort((a, b) => a - b)
  const accessorIndex = new Map(accessorIds.map((id, index) => [id, index]))
  visitAccessors((id) => accessorIndex.get(id))
  json.accessors = accessorIds.map((id) => json.accessors[id])
  const visitViews = (map) => {
    for (const accessor of json.accessors) {
      if (accessor.bufferView != null) accessor.bufferView = map(accessor.bufferView)
      if (accessor.sparse) {
        accessor.sparse.indices.bufferView = map(accessor.sparse.indices.bufferView)
        accessor.sparse.values.bufferView = map(accessor.sparse.values.bufferView)
      }
    }
    for (const image of json.images ?? []) {
      if (image.uri || image.bufferView == null) throw new Error('Текстура должна быть встроена в GLB')
      image.bufferView = map(image.bufferView)
    }
  }
  const usedViews = new Set()
  visitViews((id) => { usedViews.add(id); return id })
  const viewIds = [...usedViews].sort((a, b) => a - b)
  const viewIndex = new Map(viewIds.map((id, index) => [id, index]))
  visitViews((id) => viewIndex.get(id))
  const chunks = []
  let offset = 0
  json.bufferViews = viewIds.map((id) => {
    const view = json.bufferViews[id]
    if (view.buffer !== 0 || (view.byteOffset ?? 0) + view.byteLength > binary.length) throw new Error('Некорректный bufferView')
    const data = padded(binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength))
    const result = { ...view, buffer: 0, byteOffset: offset }
    offset += data.length; chunks.push(data)
    return result
  })
  json.buffers = [{ byteLength: offset }]
  return writeGlb(json, chunks)
}

function writeGlb(json, chunks) {
  const jsonBytes = padded(Buffer.from(JSON.stringify(json)), 0x20)
  const binaryBytes = Buffer.concat(chunks)
  const header = Buffer.alloc(20), binaryChunkHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + jsonBytes.length + binaryBytes.length, 8)
  header.writeUInt32LE(jsonBytes.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  binaryChunkHeader.writeUInt32LE(binaryBytes.length, 0); binaryChunkHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonBytes, binaryChunkHeader, binaryBytes])
}

async function importV1() {
  await mkdir(output, { recursive: true })
  for (const [name, pack] of Object.entries(packs)) await writeFile(join(output, `${name}-LICENSE.txt`), await download(pack, 'LICENSE.txt'))
  for (const model of models) {
    const pack = packs[model.pack]
    const source = await download(pack, `${pack.directory}/Characters/gltf/${model.source}.glb`)
    const ready = prepare(source, model)
    await writeFile(join(output, model.file), ready)
    console.log(JSON.stringify({ file: model.file, bytes: ready.length, originalBytes: source.length, originalSha256: hash(source), sha256: hash(ready), clips: 6 }))
  }
}

// ---------------------------------------------------------------------------
// KayKit Adventurers 2.0 / Skeletons 1.1 / Character Animations 1.1
// ---------------------------------------------------------------------------

/** Архивы itch.io: имя файла, размер и SHA-256 закреплены (tmp/asset-src/SOURCES.md). */
export const KAYKIT_V2_ARCHIVES = Object.freeze({
  adventurers: {
    file: 'KayKit_Adventurers_2.0_FREE.zip', bytes: 13024345,
    sha256: 'abe48f4763fba0896bab486ee9e6d08ca6b5b3884b9601f235c8847ae94dc479',
    source: 'https://kaylousberg.itch.io/kaykit-adventurers', version: 'Free 2.0', license: 'License.txt',
  },
  skeletons: {
    file: 'KayKit_Skeletons_1.1_FREE.zip', bytes: 8177445,
    sha256: '21fbad59ee6cc1d7bed12d0e425acab8ebe564b8620bbc1d017aedb29dd8a3d2',
    source: 'https://kaylousberg.itch.io/kaykit-skeletons', version: 'Free 1.1', license: 'License.txt',
  },
  animations: {
    file: 'KayKit_Character_Animations_1.1_FREE.zip', bytes: 14858957,
    sha256: '65882f31f905ad2e953819648a59287cdeab8f623908d5ef701971d3758be20f',
    source: 'https://kaylousberg.itch.io/kaykit-character-animations', version: 'Free 1.1', license: 'License.txt',
  },
})

/** Префикс узлов встроенного снаряжения: клиент прячет их при внешности v1/v2. */
export const KAYKIT_GEAR_PREFIX = 'KayKitGear_'

/** Доля такта доски, на которую приходится контакт удара или выпуск снаряда. */
const MELEE_CONTACT = .3
const RANGED_LAUNCH = .2

/**
 * Клипы фигурок. Имена совпадают с разбором `clipPose`/`clipStyle` в
 * src/actor-models.ts: `Attack_<стиль>` и `Ranged_<стиль>` — варианты позы по
 * оружию, `Run` — вариант ходьбы. `contact` — доля исходного клипа с
 * наибольшей скоростью кисти (замерено по handslot), `at` — куда её перенести.
 */
const ANIMATION_FILE = 'Animations/gltf/Rig_Medium/Rig_Medium_'
const COMMON_CLIPS = [
  { name: 'Walk', file: 'MovementBasic', clip: 'Walking_A' },
  { name: 'Run', file: 'MovementBasic', clip: 'Running_A' },
  { name: 'Attack_Slash', file: 'CombatMelee', clip: 'Melee_1H_Attack_Slice_Diagonal', contact: .42, at: MELEE_CONTACT },
  { name: 'Attack_Chop', file: 'CombatMelee', clip: 'Melee_1H_Attack_Chop', contact: .55, at: MELEE_CONTACT },
  { name: 'Attack_Stab', file: 'CombatMelee', clip: 'Melee_1H_Attack_Stab', contact: .25, at: MELEE_CONTACT },
  { name: 'Attack_TwoHanded', file: 'CombatMelee', clip: 'Melee_2H_Attack_Chop', contact: .45, at: MELEE_CONTACT },
  { name: 'Attack_Unarmed', file: 'CombatMelee', clip: 'Melee_Unarmed_Attack_Punch_A', contact: .38, at: MELEE_CONTACT },
  { name: 'Ranged_Bow', file: 'CombatRanged', clip: 'Ranged_Bow_Release', contact: .05, at: RANGED_LAUNCH },
  { name: 'Ranged_Crossbow', file: 'CombatRanged', clip: 'Ranged_2H_Shoot', contact: .15, at: RANGED_LAUNCH },
  { name: 'Ranged_Throw', file: 'General', clip: 'Throw', contact: .47, at: RANGED_LAUNCH },
  { name: 'Cast', file: 'CombatRanged', clip: 'Ranged_Magic_Shoot' },
  { name: 'Hit', file: 'General', clip: 'Hit_A' },
]
const HERO_CLIPS = [
  { name: 'Idle', file: 'General', clip: 'Idle_A' },
  ...COMMON_CLIPS,
  { name: 'Death', file: 'General', clip: 'Death_A' },
]
const SKELETON_CLIPS = [
  { name: 'Idle', file: 'Special', clip: 'Skeletons_Idle' },
  ...COMMON_CLIPS.map((clip) => clip.name === 'Walk' ? { name: 'Walk', file: 'Special', clip: 'Skeletons_Walking' } : clip),
  // Скелет рассыпается назад; root motion X/Z гасится, иначе кости уезжают
  // в соседнюю клетку, а отображение позиции — дело доски.
  { name: 'Death', file: 'Special', clip: 'Skeletons_Death', freezeRoot: true },
  // Подъём из земли: старт ниже пола — это и есть задуманный вид появления.
  { name: 'Spawn', file: 'Special', clip: 'Skeletons_Spawn_Ground' },
]

const ADVENTURERS = 'Characters/gltf/'
const SKELETONS = 'characters/gltf/'
const ADVENTURER_ASSETS = 'Assets/gltf/'
const SKELETON_ASSETS = 'assets/gltf/'

/**
 * Готовые фигурки. `gear` — встроенный комплект на handslot (показывается
 * только без серверной внешности), `attack`/`ranged` — клип по умолчанию для
 * такого комплекта, `drop` — меши, не входящие в образ по умолчанию.
 */
export const KAYKIT_V2_MODELS = Object.freeze([
  { key: 'knight', file: 'knight.glb', archive: 'adventurers', source: `${ADVENTURERS}Knight.glb`, clips: HERO_CLIPS, drop: ['Knight_HelmetVisor'],
    gear: [{ asset: 'sword_1handed', slot: 'handslot.r' }, { asset: 'shield_badge_color', slot: 'handslot.l' }] },
  { key: 'barbarian', file: 'barbarian.glb', archive: 'adventurers', source: `${ADVENTURERS}Barbarian.glb`, clips: HERO_CLIPS, attack: 'Attack_TwoHanded',
    gear: [{ asset: 'axe_2handed', slot: 'handslot.r' }] },
  { key: 'mage', file: 'mage.glb', archive: 'adventurers', source: `${ADVENTURERS}Mage.glb`, clips: HERO_CLIPS, attack: 'Attack_Chop',
    gear: [{ asset: 'staff', slot: 'handslot.r' }, { asset: 'spellbook_closed', slot: 'handslot.l' }] },
  { key: 'ranger', file: 'ranger.glb', archive: 'adventurers', source: `${ADVENTURERS}Ranger.glb`, clips: HERO_CLIPS,
    gear: [{ asset: 'bow_withString', slot: 'handslot.l' }] },
  { key: 'rogue', file: 'rogue.glb', archive: 'adventurers', source: `${ADVENTURERS}Rogue.glb`, clips: HERO_CLIPS, attack: 'Attack_Stab',
    gear: [{ asset: 'dagger', slot: 'handslot.r' }, { asset: 'dagger', slot: 'handslot.l' }] },
  { key: 'rogue-hooded', file: 'rogue-hooded.glb', archive: 'adventurers', source: `${ADVENTURERS}Rogue_Hooded.glb`, clips: HERO_CLIPS, attack: 'Attack_Stab',
    gear: [{ asset: 'dagger', slot: 'handslot.r' }, { asset: 'dagger', slot: 'handslot.l' }] },
  { key: 'skeleton-warrior', file: 'skeleton-warrior.glb', archive: 'skeletons', source: `${SKELETONS}Skeleton_Warrior.glb`, clips: SKELETON_CLIPS, attack: 'Attack_Chop',
    gear: [{ asset: 'Skeleton_Axe', slot: 'handslot.r' }, { asset: 'Skeleton_Shield_Large_A', slot: 'handslot.l' }] },
  { key: 'skeleton-rogue', file: 'skeleton-rogue.glb', archive: 'skeletons', source: `${SKELETONS}Skeleton_Rogue.glb`, clips: SKELETON_CLIPS,
    gear: [{ asset: 'Skeleton_Blade', slot: 'handslot.r' }] },
  { key: 'skeleton-mage', file: 'skeleton-mage.glb', archive: 'skeletons', source: `${SKELETONS}Skeleton_Mage.glb`, clips: SKELETON_CLIPS, attack: 'Attack_Chop',
    gear: [{ asset: 'Skeleton_Staff', slot: 'handslot.r' }] },
  { key: 'skeleton-minion', file: 'skeleton-minion.glb', archive: 'skeletons', source: `${SKELETONS}Skeleton_Minion.glb`, clips: SKELETON_CLIPS,
    gear: [{ asset: 'Skeleton_Blade', slot: 'handslot.r' }, { asset: 'Skeleton_Shield_Small_A', slot: 'handslot.l' }] },
])

/** Минимальный читатель ZIP (store/deflate) поверх zlib: без новых зависимостей. */
export function readZip(bytes) {
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break }
  }
  if (end < 0) throw new Error('ZIP: не найден конец центрального каталога')
  const count = bytes.readUInt16LE(end + 10)
  let pointer = bytes.readUInt32LE(end + 16)
  const entries = new Map()
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(pointer) !== 0x02014b50) throw new Error('ZIP: повреждён центральный каталог')
    const method = bytes.readUInt16LE(pointer + 10)
    const compressedSize = bytes.readUInt32LE(pointer + 20)
    const size = bytes.readUInt32LE(pointer + 24)
    const nameLength = bytes.readUInt16LE(pointer + 28)
    const extraLength = bytes.readUInt16LE(pointer + 30)
    const commentLength = bytes.readUInt16LE(pointer + 32)
    const local = bytes.readUInt32LE(pointer + 42)
    const name = bytes.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8').replace(/\\/gu, '/')
    pointer += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    entries.set(name, () => {
      if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error(`ZIP: повреждён локальный заголовок ${name}`)
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
      const raw = bytes.subarray(start, start + compressedSize)
      const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null
      if (!data) throw new Error(`ZIP: метод сжатия ${method} не поддержан (${name})`)
      if (data.length !== size) throw new Error(`ZIP: размер ${name} не совпал`)
      return data
    })
  }
  /** Файл по хвосту пути: архивы itch.io завёрнуты в каталог с именем набора. */
  const read = (suffix) => {
    const matches = [...entries.keys()].filter((name) => name === suffix || name.endsWith(`/${suffix}`))
    if (matches.length !== 1) throw new Error(`ZIP: ожидался ровно один файл …/${suffix}, найдено ${matches.length}`)
    return { name: matches[0], bytes: entries.get(matches[0])() }
  }
  return { names: [...entries.keys()], read }
}

function parseGlb(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error('Ожидался GLB 2')
  const jsonLength = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'))
  const binaryHeader = 20 + jsonLength
  if (bytes.readUInt32LE(binaryHeader + 4) !== 0x004e4942 || json.buffers?.length !== 1) throw new Error('Ожидался один встроенный buffer')
  return { json, binary: bytes.subarray(binaryHeader + 8, binaryHeader + 8 + bytes.readUInt32LE(binaryHeader)) }
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

function viewBytes(document, viewIndex) {
  const view = document.json.bufferViews[viewIndex]
  return document.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
}

function readFloats(document, accessorIndex) {
  const accessor = document.json.accessors[accessorIndex]
  if (accessor.componentType !== 5126 || accessor.sparse) throw new Error('Ожидался плотный float accessor анимации')
  const width = COMPONENTS[accessor.type]
  const view = document.json.bufferViews[accessor.bufferView]
  const stride = view.byteStride ?? width * 4
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const rows = []
  for (let index = 0; index < accessor.count; index++) {
    const row = []
    for (let component = 0; component < width; component++) row.push(document.binary.readFloatLE(base + index * stride + component * 4))
    rows.push(row)
  }
  return rows
}

/** Сборщик GLB: исходные bufferView переносятся как есть, новые — дописываются. */
function createBuilder(document) {
  const json = structuredClone(document.json)
  const views = json.bufferViews.map((_, index) => viewBytes(document, index))
  const addView = (bytes, target) => {
    views.push(bytes)
    json.bufferViews.push({ buffer: 0, byteLength: bytes.length, ...(target ? { target } : {}) })
    return json.bufferViews.length - 1
  }
  const addFloatAccessor = (rows, type, withBounds) => {
    const width = COMPONENTS[type]
    const bytes = Buffer.alloc(rows.length * width * 4)
    rows.forEach((row, index) => row.forEach((value, component) => bytes.writeFloatLE(value, (index * width + component) * 4)))
    const accessor = { bufferView: addView(bytes), componentType: 5126, count: rows.length, type }
    if (withBounds) {
      accessor.min = Array.from({ length: width }, (_, component) => Math.min(...rows.map((row) => Math.fround(row[component]))))
      accessor.max = Array.from({ length: width }, (_, component) => Math.max(...rows.map((row) => Math.fround(row[component]))))
    }
    json.accessors.push(accessor)
    return json.accessors.length - 1
  }
  const serialize = () => {
    let offset = 0
    const chunks = views.map((bytes, index) => {
      const data = padded(Buffer.from(bytes))
      json.bufferViews[index] = { ...json.bufferViews[index], buffer: 0, byteOffset: offset, byteLength: bytes.length }
      offset += data.length
      return data
    })
    json.buffers = [{ byteLength: offset }]
    return writeGlb(json, chunks)
  }
  return { json, addView, addFloatAccessor, serialize }
}

const nearly = (left, right, epsilon) => left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) <= epsilon)

function restValue(node, path) {
  if (path === 'translation') return node.translation ?? [0, 0, 0]
  if (path === 'rotation') return node.rotation ?? [0, 0, 0, 1]
  if (path === 'scale') return node.scale ?? [1, 1, 1]
  return null
}

/** Перенос времени: контакт исходного клипа попадает в заданную долю такта. */
function retime(times, duration, contact, at) {
  if (contact == null || at == null || duration <= 0) return times
  return times.map((time) => {
    const u = time / duration
    const mapped = u <= contact ? u * at / contact : at + (u - contact) * (1 - at) / (1 - contact)
    return mapped * duration
  })
}

/**
 * Встраивает клип из файла анимаций Rig_Medium. Каналы привязываются по ИМЕНИ
 * кости (порядок костей в файлах разный). Каналы, совпадающие с покоем
 * кости на всём клипе, и единичный масштаб не переносятся: AnimationMixer
 * возвращает кость в исходное состояние сам.
 */
function embedClip(builder, nodeIndexByName, animationDocument, spec) {
  const source = animationDocument.json.animations.find((animation) => animation.name === spec.clip)
  if (!source) throw new Error(`Нет клипа ${spec.clip} в Rig_Medium_${spec.file}`)
  const duration = Math.max(...source.samplers.map((sampler) => animationDocument.json.accessors[sampler.input].max?.[0] ?? 0))
  const channels = [], samplers = []
  const inputs = new Map()
  for (const channel of source.channels) {
    const path = channel.target.path
    if (!['translation', 'rotation', 'scale'].includes(path)) continue
    const boneName = animationDocument.json.nodes[channel.target.node]?.name
    const target = nodeIndexByName.get(boneName)
    if (target == null) throw new Error(`Кость ${boneName} клипа ${spec.clip} отсутствует в фигурке`)
    const sampler = source.samplers[channel.sampler]
    let values = readFloats(animationDocument, sampler.output)
    if (spec.freezeRoot && boneName === 'root' && path === 'translation') {
      const rest = restValue(builder.json.nodes[target], path)
      values = values.map(([, y]) => [rest[0], y, rest[2]])
    }
    const rest = restValue(builder.json.nodes[target], path)
    const epsilon = path === 'rotation' ? 1e-4 : 1e-4
    if (values.every((value) => nearly(value, rest, epsilon))) continue
    if (sampler.interpolation === 'CUBICSPLINE') throw new Error(`CUBICSPLINE в ${spec.clip} не поддержан`)
    let input = inputs.get(sampler.input)
    if (input == null) {
      const times = retime(readFloats(animationDocument, sampler.input).map(([time]) => time), duration, spec.contact, spec.at)
      input = builder.addFloatAccessor(times.map((time) => [time]), 'SCALAR', true)
      inputs.set(sampler.input, input)
    }
    const output = builder.addFloatAccessor(values, path === 'rotation' ? 'VEC4' : 'VEC3', false)
    samplers.push({ input, output, interpolation: sampler.interpolation ?? 'LINEAR' })
    channels.push({ sampler: samplers.length - 1, target: { node: target, path } })
  }
  if (!channels.length) throw new Error(`Клип ${spec.clip} не изменяет ни одной кости`)
  builder.json.animations ??= []
  builder.json.animations.push({ name: spec.name, channels, samplers })
  return { name: spec.name, source: `Rig_Medium_${spec.file}/${spec.clip}`, duration: +duration.toFixed(4), channels: channels.length, ...(spec.contact != null ? { contact: spec.contact, at: spec.at } : {}) }
}

/** Копия клипа под другим именем: те же sampler-ы и accessor-ы, ноль байт. */
function aliasClip(builder, name, original) {
  const clip = builder.json.animations.find((animation) => animation.name === original)
  if (!clip) throw new Error(`Нет клипа ${original} для псевдонима ${name}`)
  builder.json.animations.push({ name, channels: structuredClone(clip.channels), samplers: structuredClone(clip.samplers) })
}

function parseGltfAsset(archive, directory, asset) {
  const gltf = JSON.parse(archive.read(`${directory}${asset}.gltf`).bytes.toString('utf8'))
  if (gltf.buffers?.length !== 1 || !gltf.buffers[0].uri || /[\\/:]|\.\./u.test(gltf.buffers[0].uri)) throw new Error(`${asset}: ожидался один локальный .bin`)
  const binary = archive.read(`${directory}${gltf.buffers[0].uri}`).bytes
  const images = (gltf.images ?? []).map((image) => {
    if (!image.uri || /[\\/:]|\.\./u.test(image.uri) || image.mimeType !== 'image/png') throw new Error(`${asset}: ожидалась локальная PNG-текстура`)
    return { name: image.name ?? image.uri.replace(/\.png$/u, ''), bytes: archive.read(`${directory}${image.uri}`).bytes }
  })
  return { json: gltf, binary, images }
}

/**
 * Встраивает статическую модель снаряжения дочерним узлом handslot. Текстура
 * переиспользуется, если в фигурке уже есть изображение с тем же именем и
 * теми же байтами; иначе PNG встраивается отдельно.
 */
function embedGear(builder, characterImages, gearDocument, slotIndex, nodeName) {
  const { json } = builder
  const source = gearDocument.json
  if (source.nodes?.length !== 1 || source.meshes?.length !== 1 || source.nodes[0].children?.length) throw new Error(`${nodeName}: ожидался один узел с одной сеткой`)
  const accessorMap = new Map()
  const accessorFor = (index) => {
    if (accessorMap.has(index)) return accessorMap.get(index)
    const accessor = source.accessors[index]
    const view = source.bufferViews[accessor.bufferView]
    const bytes = gearDocument.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    const viewIndex = builder.addView(Buffer.from(bytes), view.target)
    if (view.byteStride) json.bufferViews[viewIndex].byteStride = view.byteStride
    const copy = { ...accessor, bufferView: viewIndex }
    // glTF требует min/max у POSITION; у части исходников KayKit их нет.
    if (accessor.type === 'VEC3' && accessor.componentType === 5126 && (!accessor.min || !accessor.max)) {
      const rows = readFloats(gearDocument, index)
      copy.min = [0, 1, 2].map((axis) => Math.min(...rows.map((row) => Math.fround(row[axis]))))
      copy.max = [0, 1, 2].map((axis) => Math.max(...rows.map((row) => Math.fround(row[axis]))))
    }
    json.accessors.push(copy)
    accessorMap.set(index, json.accessors.length - 1)
    return json.accessors.length - 1
  }
  const imageFor = (index) => {
    const image = gearDocument.images[index]
    const existing = characterImages.find((candidate) => candidate.name === image.name && candidate.bytes.equals(image.bytes))
    if (existing) return existing.index
    json.images ??= []
    json.images.push({ bufferView: builder.addView(Buffer.from(image.bytes)), mimeType: 'image/png', name: image.name })
    characterImages.push({ name: image.name, bytes: image.bytes, index: json.images.length - 1 })
    return json.images.length - 1
  }
  const materialFor = (index) => {
    const material = structuredClone(source.materials[index])
    const textureInfo = material.pbrMetallicRoughness?.baseColorTexture
    if (textureInfo) {
      const sourceTexture = source.textures[textureInfo.index]
      const sampler = structuredClone(source.samplers?.[sourceTexture.sampler] ?? {})
      json.samplers ??= []
      json.samplers.push(sampler)
      json.textures ??= []
      json.textures.push({ sampler: json.samplers.length - 1, source: imageFor(sourceTexture.source) })
      textureInfo.index = json.textures.length - 1
    }
    json.materials.push(material)
    return json.materials.length - 1
  }
  const primitives = source.meshes[0].primitives.map((primitive) => ({
    ...primitive,
    attributes: Object.fromEntries(Object.entries(primitive.attributes).map(([key, value]) => [key, accessorFor(value)])),
    ...(primitive.indices != null ? { indices: accessorFor(primitive.indices) } : {}),
    ...(primitive.material != null ? { material: materialFor(primitive.material) } : {}),
  }))
  json.meshes.push({ name: nodeName, primitives })
  json.nodes.push({ name: nodeName, mesh: json.meshes.length - 1 })
  const slot = json.nodes[slotIndex]
  slot.children = [...(slot.children ?? []), json.nodes.length - 1]
}

async function verifiedArchive(directory, entry) {
  const bytes = await readFile(join(directory, entry.file))
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`${entry.file}: размер или SHA-256 не совпадает с закреплённым`)
  return readZip(bytes)
}

/**
 * Собирает фигурки KayKit 2.0 в память. Возвращает файлы и происхождение;
 * запись на диск делает вызывающий код.
 */
export async function buildKayKitV2({ archivesDir = join(ROOT, 'tmp', 'asset-src') } = {}) {
  const archives = {}
  for (const [name, entry] of Object.entries(KAYKIT_V2_ARCHIVES)) archives[name] = await verifiedArchive(archivesDir, entry)
  const animationDocuments = new Map()
  const animationDocument = (file) => {
    if (!animationDocuments.has(file)) animationDocuments.set(file, parseGlb(archives.animations.read(`${ANIMATION_FILE}${file}.glb`).bytes))
    return animationDocuments.get(file)
  }
  const files = []
  for (const model of KAYKIT_V2_MODELS) {
    const sourceFile = archives[model.archive].read(model.source)
    const document = parseGlb(sourceFile.bytes)
    if ((document.json.animations ?? []).length) throw new Error(`${model.source}: ожидалась фигурка без клипов`)
    const builder = createBuilder(document)
    const nodeIndexByName = new Map(builder.json.nodes.map((node, index) => [node.name, index]))
    for (const name of model.drop ?? []) {
      const node = builder.json.nodes.find((entry) => entry.name === name)
      if (!node || node.mesh == null) throw new Error(`${model.key}: не найден меш ${name}`)
      delete node.mesh
      delete node.skin
    }
    const characterImages = (builder.json.images ?? []).map((image, index) => ({ name: image.name, bytes: viewBytes(document, image.bufferView), index }))
    const gearSources = []
    model.gear.forEach((gear, index) => {
      const directory = model.archive === 'skeletons' ? SKELETON_ASSETS : ADVENTURER_ASSETS
      const gearDocument = parseGltfAsset(archives[model.archive], directory, gear.asset)
      const slotIndex = nodeIndexByName.get(gear.slot)
      if (slotIndex == null) throw new Error(`${model.key}: нет кости ${gear.slot}`)
      const nodeName = `${KAYKIT_GEAR_PREFIX}${gear.asset}${model.gear.filter((item) => item.asset === gear.asset).length > 1 ? `_${index}` : ''}`
      embedGear(builder, characterImages, gearDocument, slotIndex, nodeName)
      gearSources.push({ asset: gear.asset, slot: gear.slot, node: nodeName })
    })
    const clips = model.clips.map((spec) => embedClip(builder, nodeIndexByName, animationDocument(spec.file), spec))
    if (model.attack) aliasClip(builder, 'Attack', model.attack)
    // Ссылки на удалённые меши (drop) не оставляем: GLTFLoader не должен
    // разбирать сетку, которая не входит в образ.
    const usedMeshes = new Set(builder.json.nodes.filter((node) => node.mesh != null).map((node) => node.mesh))
    const meshIndex = new Map([...usedMeshes].sort((a, b) => a - b).map((id, index) => [id, index]))
    builder.json.meshes = [...usedMeshes].sort((a, b) => a - b).map((id) => builder.json.meshes[id])
    builder.json.nodes.forEach((node) => { if (node.mesh != null) node.mesh = meshIndex.get(node.mesh) })
    builder.json.asset = { ...builder.json.asset, extras: { source: sourceFile.name, preparedBy: 'tools/import-kaykit-models.mjs --v2' } }
    const bytes = builder.serialize()
    files.push({
      key: model.key, file: model.file, bytes, sha256: hash(bytes),
      source: { archive: KAYKIT_V2_ARCHIVES[model.archive].file, path: sourceFile.name, sha256: hash(sourceFile.bytes) },
      gear: gearSources,
      clips: [...clips, ...(model.attack ? [{ name: 'Attack', alias: model.attack }] : [])],
    })
  }
  const licenses = Object.entries(KAYKIT_V2_ARCHIVES).map(([name, entry]) => {
    const license = archives[name].read(entry.license)
    return { name, file: `${name}-LICENSE.txt`, bytes: license.bytes, sha256: hash(license.bytes) }
  })
  const releaseHash = hash(Buffer.concat(files.map((file) => file.bytes)))
  return { releaseId: `characters-${releaseHash.slice(0, 20)}`, releaseHash, files, licenses }
}

async function importV2(args) {
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
  const archivesDir = resolve(option('--archives') ?? join(ROOT, 'tmp', 'asset-src'))
  const built = await buildKayKitV2({ archivesDir })
  const target = resolve(option('--out') ?? join(output, built.releaseId))
  await mkdir(target, { recursive: true })
  for (const file of built.files) await writeFile(join(target, file.file), file.bytes)
  for (const license of built.licenses) await writeFile(join(target, license.file), license.bytes)
  const notice = {
    release: { id: built.releaseId, glbConcatSha256: built.releaseHash, preparedBy: 'node tools/import-kaykit-models.mjs --v2' },
    license: 'CC0-1.0',
    attribution: 'Kay Lousberg / KayKit — https://kaylousberg.com (необязательна по CC0)',
    archives: Object.values(KAYKIT_V2_ARCHIVES).map(({ file, bytes, sha256, source, version }) => ({ file, bytes, sha256, source, version })),
    licenses: built.licenses.map(({ name, file, sha256 }) => ({ archive: name, file, sha256 })),
    outputs: built.files.map(({ key, file, bytes, sha256, source, gear, clips }) => ({ key, file, bytes: bytes.length, sha256, source, gear, clips })),
  }
  await writeFile(join(target, 'NOTICE.json'), `${JSON.stringify(notice, null, 2)}\n`)
  for (const file of built.files) console.log(JSON.stringify({ file: file.file, bytes: file.bytes.length, sha256: file.sha256, clips: file.clips.length }))
  console.log(JSON.stringify({ release: built.releaseId, out: target }))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  if (args.includes('--v2')) await importV2(args)
  else await importV1()
}
