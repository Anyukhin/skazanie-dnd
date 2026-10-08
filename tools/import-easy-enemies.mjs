#!/usr/bin/env node
/**
 * Враги Quaternius «Animated Easy Enemies» (январь 2019): крыса, паук, оса,
 * лягушка, змея — в GLB для 3D-доски.
 *
 * Пак выпущен только в FBX, OBJ и Blend. Конвертация — средствами three.js,
 * которые уже стоят в проекте: `FBXLoader` читает скелет, материалы и клипы,
 * `GLTFExporter` пишет самодостаточный GLB. Материалы Phong заменяются
 * стандартными того же цвета (свет доски рассчитан на PBR), из имён клипов
 * убирается префикс арматуры (`Armature|Rat_Run` → `Rat_Run`): позу по имени
 * доска выбирает сама (`actorClipInfo` в `src/actor-models.ts`).
 *
 * Лицензия: на странице пака https://quaternius.itch.io/animated-easy-enemies
 * — «FBX, OBJ and Blend formats and CC0 license»; файла лицензии в архиве нет
 * (сверено при загрузке 2026-10-09, см. `tmp/asset-src/SOURCES.md`).
 *
 *   node tools/import-easy-enemies.mjs                 # кандидат в tmp/easy-enemies-candidate
 *   node tools/import-easy-enemies.mjs --publish       # в public/assets/models/quaternius/creatures-<hash>
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PACK_DIR = join(ROOT, 'tmp', 'asset-src', 'dl-quaternius-animated-easy-enemies')
const SOURCE = Object.freeze({
  pack: 'Quaternius — Animated Easy Enemies (Jan 2019)',
  url: 'https://quaternius.itch.io/animated-easy-enemies',
  archive: 'dl-quaternius-animated-easy-enemies (tmp/asset-src)',
  license: 'CC0-1.0',
  licenseStatement: 'FBX, OBJ and Blend formats and CC0 license (страница пака на itch.io, 2026-10-09; файла лицензии в архиве нет)',
})
/** Ключ модели → файл пака. Змея в боевой стойке — отдельная модель пака. */
const CREATURES = Object.freeze([
  { key: 'rat', file: 'Rat.fbx' },
  { key: 'spider', file: 'Spider.fbx' },
  { key: 'wasp', file: 'Wasp.fbx' },
  { key: 'frog', file: 'Frog.fbx' },
  { key: 'snake', file: 'Snake_angry.fbx' },
])

const { values: args } = parseArgs({ options: { src: { type: 'string' }, out: { type: 'string' }, publish: { type: 'boolean', default: false } } })
const sourceDir = args.src ?? join(PACK_DIR, 'unpacked', 'Easy Animated Enemy Pack - Jan 2019', 'FBX')

// GLTFExporter и загрузчики рассчитаны на браузер: `self` и FileReader для Blob.
globalThis.self ??= globalThis
if (!globalThis.FileReader) {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then((buffer) => { this.result = buffer; this.onloadend?.() }) }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`
        this.onloadend?.()
      })
    }
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const arrayBufferOf = (data) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)

/** Phong → стандартный материал того же цвета; кожа скелета сохраняется. */
function standardize(root) {
  const cache = new Map()
  root.traverse((object) => {
    if (!object.isMesh) return
    const swap = (material) => {
      if (cache.has(material)) return cache.get(material)
      const next = new THREE.MeshStandardMaterial({ name: material.name, color: material.color?.clone() ?? new THREE.Color(0xcccccc), roughness: .85, metalness: 0 })
      cache.set(material, next)
      return next
    }
    object.material = Array.isArray(object.material) ? object.material.map(swap) : swap(object.material)
  })
}

async function convertCreature({ key, file }) {
  const source = readFileSync(join(sourceDir, file))
  const root = new FBXLoader().parse(arrayBufferOf(source), '')
  root.name = key
  // Пак в сантиметрах; доска сама вписывает рост, но метры удобнее для bbox.
  root.scale.setScalar(.01)
  standardize(root)
  const clips = root.animations.map((clip) => {
    const copy = clip.clone()
    copy.name = clip.name.replace(/^[^|]*\|/u, '')
    return copy
  })
  const glb = await new Promise((resolve, reject) => new GLTFExporter().parse(root, resolve, reject, { binary: true, animations: clips, onlyVisible: true }))
  const bytes = Buffer.from(glb)
  // Проверка: собранный GLB читается обратно, со скелетом и всеми клипами.
  const back = await new Promise((resolve, reject) => new GLTFLoader().parse(arrayBufferOf(bytes), '', resolve, reject))
  let skinned = 0
  back.scene.traverse((object) => { if (object.isSkinnedMesh) skinned += 1 })
  if (!skinned) throw new Error(`${key}: в GLB нет скелетного меша`)
  const names = back.animations.map((clip) => clip.name)
  if (names.length !== clips.length) throw new Error(`${key}: клипов ${names.length} из ${clips.length}`)
  back.scene.updateMatrixWorld(true)
  const size = new THREE.Box3().setFromObject(back.scene).getSize(new THREE.Vector3())
  return { key, bytes, clips: names, size: size.toArray().map((value) => Number(value.toFixed(3))), sourceFile: file, sourceSha256: sha256(source) }
}

const results = []
for (const creature of CREATURES) results.push(await convertCreature(creature))

const digest = sha256(Buffer.concat(results.map((result) => result.bytes))).slice(0, 20)
const outDir = args.out ?? (args.publish
  ? join(ROOT, 'public', 'assets', 'models', 'quaternius', `creatures-${digest}`)
  : join(ROOT, 'tmp', 'easy-enemies-candidate'))
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const outputs = []
for (const result of results) {
  writeFileSync(join(outDir, `${result.key}.glb`), result.bytes)
  outputs.push({
    key: result.key, file: `${result.key}.glb`, bytes: result.bytes.length, sha256: sha256(result.bytes),
    clips: result.clips, size: result.size,
    provenance: { pack: SOURCE.pack, url: SOURCE.url, sourceFile: result.sourceFile, sourceSha256: result.sourceSha256, license: SOURCE.license, attribution: 'Quaternius' },
  })
}
writeFileSync(join(outDir, 'NOTICE.json'), `${JSON.stringify({ source: SOURCE, tool: 'tools/import-easy-enemies.mjs', outputs }, null, 2)}\n`)
writeFileSync(join(outDir, 'LICENSE.txt'), [
  'Quaternius — Animated Easy Enemies (January 2019)',
  `Source: ${SOURCE.url}`,
  `License: Creative Commons Zero (CC0 1.0), as stated on the pack page: "${SOURCE.licenseStatement}".`,
  'https://creativecommons.org/publicdomain/zero/1.0/',
  'Converted from FBX to GLB by the Skazanie project (materials re-created as PBR with the same colours, clip prefixes removed).',
  '',
].join('\n'))
for (const output of outputs) console.log(`${output.key.padEnd(7)} ${(output.bytes / 1024).toFixed(0).padStart(5)} КБ  ${output.size.join('×')} м  ${output.clips.join(', ')}`)
console.log(`\n${relative(ROOT, outDir)}`)
