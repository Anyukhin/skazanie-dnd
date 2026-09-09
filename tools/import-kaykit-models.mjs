// Четыре модели из официальных CC0-наборов. Версии закреплены, загрузки нужны
// только при обновлении ассетов: во время игры файлы обслуживает сам проект.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const output = fileURLToPath(new URL('../public/assets/models/kaykit/', import.meta.url))
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
  const jsonBytes = padded(Buffer.from(JSON.stringify(json)), 0x20)
  const binaryBytes = Buffer.concat(chunks)
  const header = Buffer.alloc(20), binaryChunkHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + jsonBytes.length + binaryBytes.length, 8)
  header.writeUInt32LE(jsonBytes.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  binaryChunkHeader.writeUInt32LE(binaryBytes.length, 0); binaryChunkHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonBytes, binaryChunkHeader, binaryBytes])
}

await mkdir(output, { recursive: true })
for (const [name, pack] of Object.entries(packs)) await writeFile(join(output, `${name}-LICENSE.txt`), await download(pack, 'LICENSE.txt'))
for (const model of models) {
  const pack = packs[model.pack]
  const source = await download(pack, `${pack.directory}/Characters/gltf/${model.source}.glb`)
  const ready = prepare(source, model)
  await writeFile(join(output, model.file), ready)
  console.log(JSON.stringify({ file: model.file, bytes: ready.length, originalBytes: source.length, originalSha256: hash(source), sha256: hash(ready), clips: 6 }))
}
