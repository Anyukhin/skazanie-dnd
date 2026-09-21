#!/usr/bin/env node
// @ts-check
/** Собирает GLB моделей экипировки в изолированный временный кандидат. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

import { ITEM_CATALOG } from '../server/item-catalog.mjs'
import { EQUIPMENT_ITEM_VISUALS } from '../server/equipment-visuals.mjs'
import { ACCESSORY_MODELS, createAccessoryModel } from './equipment-accessory-models.mjs'
import { ARMOR_MODELS, SHIELD_MODEL, createArmorModel } from './equipment-armor-models.mjs'
import { createWeaponModel, WEAPON_MODELS } from './equipment-weapon-models.mjs'
import { registerAssets } from './register-asset-rights.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DEFAULT_OUTPUT = join(ROOT, 'tmp/equipment-model-candidate')
const URL_ROOT = '/assets/models/equipment/'
const GENERATOR_PATH = fileURLToPath(import.meta.url)

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sourceInput(file) {
  const bytes = readFileSync(file)
  return Object.freeze({
    path: relative(ROOT, file).replaceAll('\\', '/'),
    sha256: digest(bytes),
    bytes: bytes.length,
  })
}

const SOURCE_INPUTS = Object.freeze([
  sourceInput(GENERATOR_PATH),
  sourceInput(fileURLToPath(new URL('../server/item-catalog.mjs', import.meta.url))),
  sourceInput(fileURLToPath(new URL('../server/equipment-visuals.mjs', import.meta.url))),
  sourceInput(fileURLToPath(new URL('./equipment-weapon-models.mjs', import.meta.url))),
  sourceInput(fileURLToPath(new URL('./equipment-armor-models.mjs', import.meta.url))),
  sourceInput(fileURLToPath(new URL('./equipment-accessory-models.mjs', import.meta.url))),
].sort((left, right) => left.path.localeCompare(right.path)))

function modelForCategory(category, key, variant = 'default') {
  if (category === 'weapon') return createWeaponModel(key)
  if (category === 'armor' || category === 'shield') return createArmorModel(key)
  if (category === 'accessory') return createAccessoryModel(key, variant)
  return null
}

function leafSpecs() {
  return [
    ...WEAPON_MODELS.map((spec) => ({ ...spec, category: 'weapon' })),
    ...ARMOR_MODELS.map((spec) => ({ ...spec, category: 'armor', coverage: spec.parts.map((part) => part.slice('part:'.length)) })),
    { ...SHIELD_MODEL, category: 'shield' },
    ...ACCESSORY_MODELS.map((spec) => ({ ...spec, category: 'accessory' })),
  ]
}

const LEAF_SPECS = Object.freeze(leafSpecs())
const CATALOG_EQUIPPABLE_COUNT = Object.values(ITEM_CATALOG)
  .filter((entry) => entry.lifecycle?.equippable === true).length

function visualEntries(key) {
  return Object.entries(EQUIPMENT_ITEM_VISUALS)
    .filter(([, visual]) => visual.model_key === key)
}

function exactCatalogIds(spec, slot, variant = null) {
  // Сеть живёт в PHB starter-kit как описательная вещь и намеренно не
  // получает выдуманный catalog id. Для остальных ключей маппинг экипировки
  // является единственным источником вариантов и магических alias.
  if (spec.key === 'net') return []
  const mapped = visualEntries(spec.key)
    .filter(([, visual]) => visual.slot === slot && (variant === null || (visual.variant ?? 'default') === variant))
    .map(([catalogId]) => catalogId)
  return [...new Set(mapped.length ? mapped : spec.catalogIds)].sort()
}

function partsForModel(spec, model) {
  const exportedName = (name) => String(name).replaceAll(':', '')
  if (Array.isArray(spec.parts) && spec.parts.length > 0) {
    return spec.parts.map((part) => {
      const name = String(part)
      if (model.getObjectByName(name)) return exportedName(name)
      const bare = name.replace(/^part:/u, '')
      return model.getObjectByName(bare) ? bare : name
    })
  }
  const names = []
  model.traverse((objectValue) => {
    if (!objectValue.isMesh || !objectValue.name || names.includes(objectValue.name)) return
    names.push(exportedName(objectValue.name))
  })
  for (const marker of ['hand-grip', 'off-hand-grip', 'muzzle']) {
    if (model.getObjectByName(marker)) names.push(exportedName(marker))
  }
  return names
}

function slotsForSpec(spec) {
  const slots = [...new Set(visualEntries(spec.key).map(([, visual]) => visual.slot))]
  if (slots.length) return slots
  if (spec.category === 'weapon') return ['main_hand']
  if (spec.category === 'armor') return ['body']
  if (spec.category === 'shield') return ['off_hand']
  if (spec.key === 'cloak') return ['cloak']
  if (spec.key === 'brooch') return ['brooch']
  return ['main_hand']
}

function variantsForSpec(spec, slot) {
  const variants = [...new Set(visualEntries(spec.key)
    .filter(([, visual]) => visual.slot === slot)
    .map(([, visual]) => visual.variant ?? 'default'))]
  return variants.length ? variants : ['default']
}

function manifestSpecs(spec, model) {
  const parts = partsForModel(spec, model)
  const slots = slotsForSpec(spec)
  return slots.flatMap((slot) => {
    const variants = variantsForSpec(spec, slot)
    const emittedVariants = spec.key === 'wand' ? variants : [variants[0]]
    return emittedVariants.map((variant) => ({
      key: spec.key,
      label: spec.label,
      category: spec.category,
      slot,
      variant,
      ...(spec.key !== 'wand' && variants.length > 1 ? { variants } : {}),
      ...(spec.kind ? { kind: spec.kind } : {}),
      ...(spec.handedness ? { handedness: spec.handedness } : {}),
      parts,
      ...(spec.coverage ? { coverage: [...spec.coverage] } : {}),
      url: `${URL_ROOT}${spec.key}${spec.key === 'wand' && variant !== 'default' ? `-${variant}` : ''}.glb`,
      catalogIds: exactCatalogIds(spec, slot, spec.key === 'wand' ? variant : null),
    }))
  })
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

    readAsDataURL(blob) {
      blob.arrayBuffer().then((value) => {
        const mime = blob.type || 'application/octet-stream'
        this.result = `data:${mime};base64,${Buffer.from(value).toString('base64')}`
        this.onloadend?.()
      }, (error) => {
        this.error = error
        this.onerror?.(error)
      })
    }
  }
}

function dispose(root) {
  const geometries = new Set()
  const materials = new Set()
  root.traverse((objectValue) => {
    if (objectValue.geometry) geometries.add(objectValue.geometry)
    const values = Array.isArray(objectValue.material) ? objectValue.material : objectValue.material ? [objectValue.material] : []
    for (const material of values) materials.add(material)
  })
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
}

/** @param {{category:string,key:string,variant?:string}} spec */
export async function exportEquipmentModel(spec) {
  const model = modelForCategory(spec.category, spec.key, spec.variant ?? 'default')
  if (!model) throw new Error(`Нет фабрики модели экипировки: ${spec.category}:${spec.key}`)
  ensureFileReader()
  const scene = new THREE.Scene()
  scene.name = 'skazanie-equipment-export'
  scene.add(model)
  try {
    const output = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true, trs: true })
    if (!(output instanceof ArrayBuffer)) throw new Error('GLTFExporter вернул текст вместо GLB')
    return Buffer.from(output)
  } finally {
    dispose(scene)
  }
}

function assertOutputDirectory(directory) {
  const candidate = resolve(directory)
  const temporaryRoot = resolve(ROOT, 'tmp')
  const relativePath = relative(temporaryRoot, candidate)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Кандидат экипировки должен находиться внутри ${temporaryRoot}`)
  }
  return candidate
}

function assertCatalogCoverage(models) {
  const equippable = Object.values(ITEM_CATALOG)
    .filter((entry) => entry.lifecycle?.equippable === true)
    .map((entry) => entry.catalog_id)
  const covered = models.flatMap((model) => model.catalogIds)
  const coveredSet = new Set(covered)
  if (covered.length !== coveredSet.size) throw new Error('В manifest повторяется catalog id экипировки')
  const missing = equippable.filter((catalogId) => !coveredSet.has(catalogId))
  const extra = [...coveredSet].filter((catalogId) => !equippable.includes(catalogId))
  if (missing.length || extra.length) throw new Error(`Покрытие экипировки расходится: missing=${missing.join(',')} extra=${extra.join(',')}`)
  if (coveredSet.size !== CATALOG_EQUIPPABLE_COUNT) throw new Error(`Ожидалось ${CATALOG_EQUIPPABLE_COUNT} catalog id экипировки, получено ${coveredSet.size}`)
}

function noticeText(manifest, releaseId = null) {
  const build = manifest.build
  const lines = [
    releaseId
      ? `Неизменяемый локальный выпуск моделей экипировки «Сказания»: ${releaseId}.`
      : 'Самодостаточный кандидат оригинальных моделей экипировки проекта «Сказание».',
    'Авторство геометрии: проект «Сказание». Лицензия: оригинальная работа проекта; условия использования определяет владелец проекта.',
    'Сторонние геометрии и фиктивные сведения о лицензиях в этот набор не включались.',
    `Генератор: ${build.generator}; SHA-256: ${build.generatorSha256}.`,
    `Three.js r${build.threeRevision}; моделей: ${manifest.models.length}; каталожных id: ${new Set(manifest.models.flatMap((model) => model.catalogIds)).size}.`,
    'Исходные файлы генерации:',
    ...build.sourceInputs.map((input) => `- ${input.path}; SHA-256: ${input.sha256}; байт: ${input.bytes}.`),
  ]
  if (!releaseId) lines.push('Кандидат не активирован и не публикуется автоматически.')
  return `${lines.join('\n')}\n`
}

/**
 * Строит самодостаточный кандидат. Он не пишет public/ и data/; публикация
 * выполняется отдельным конвейером ассетов после ручной проверки.
 *
 * @param {{out?:string}} [options]
 * @returns {Promise<{directory:string,manifest:Record<string,unknown>,files:string[]}>}
 */
export async function buildEquipmentModels({ out = DEFAULT_OUTPUT } = {}) {
  const directory = assertOutputDirectory(out)
  await mkdir(directory, { recursive: true })
  const prepared = []
  for (const leaf of LEAF_SPECS) {
    const model = modelForCategory(leaf.category, leaf.key)
    if (!model) throw new Error(`Фабрика не создала ${leaf.category}:${leaf.key}`)
    const manifestModels = manifestSpecs(leaf, model)
    for (const manifestModel of manifestModels) {
      const bytes = await exportEquipmentModel(leaf.key === 'wand' ? { ...leaf, variant: manifestModel.variant } : leaf)
      await writeFile(join(directory, basename(manifestModel.url)), bytes)
      prepared.push({ ...manifestModel, bytes: bytes.length, sha256: digest(bytes) })
    }
    dispose(model)
  }
  assertCatalogCoverage(prepared)
  const generatorBytes = readFileSync(GENERATOR_PATH)
  const manifest = {
    schema: 'skazanie-equipment-model-candidate/v1',
    version: 1,
    build: {
      generator: 'tools/build-equipment-models.mjs',
      generatorVersion: 1,
      generatorSha256: digest(generatorBytes),
      threeRevision: THREE.REVISION,
      canonicalHumanHeight: 1.4,
      catalogEquippableCount: CATALOG_EQUIPPABLE_COUNT,
      sourceInputs: SOURCE_INPUTS,
    },
    models: prepared,
  }
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(directory, 'NOTICE.txt'), noticeText(manifest))
  await writeFile(join(directory, 'LICENSE.txt'), 'Оригинальные модели проекта «Сказание». Условия использования определяет владелец проекта.\n')
  return { directory, manifest, files: prepared.map((item) => basename(item.url)) }
}

async function plainDirectory(path, label) {
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (info?.isSymbolicLink()) throw new Error(`${label} не может быть symlink/junction: ${path}`)
  if (info && !info.isDirectory()) throw new Error(`${label} должен быть каталогом: ${path}`)
  return info
}

async function plainFile(path, label) {
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (info?.isSymbolicLink()) throw new Error(`${label} не может быть symlink/junction: ${path}`)
  if (info && !info.isFile()) throw new Error(`${label} должен быть обычным файлом: ${path}`)
  return info
}

async function checkedCandidate(directory) {
  const candidate = resolve(directory)
  const manifest = JSON.parse((await readFile(join(candidate, 'manifest.json'))).toString('utf8'))
  if (manifest.schema !== 'skazanie-equipment-model-candidate/v1' || manifest.version !== 1 || !Array.isArray(manifest.models)) {
    throw new Error('Кандидат экипировки имеет неизвестную схему')
  }
  const files = new Map()
  for (const model of manifest.models) {
    const value = model && typeof model === 'object' ? model : null
    const name = basename(String(value?.url ?? ''))
    const expectedName = value?.key === 'wand' && value?.variant === 'enchanted' ? 'wand-enchanted.glb' : `${value?.key}.glb`
    if (!name || name !== expectedName || name.includes('..') || /[\\/:]/u.test(name)) throw new Error(`Небезопасное имя GLB: ${name}`)
    const bytes = files.get(name) ?? await readFile(join(candidate, name))
    if (bytes.length !== Number(value?.bytes) || digest(bytes) !== value?.sha256) throw new Error(`Кандидат изменился: ${name}`)
    files.set(name, bytes)
  }
  for (const name of ['LICENSE.txt']) {
    const bytes = await readFile(join(candidate, name))
    files.set(name, bytes)
  }
  return { candidate, manifest, files }
}

function releaseFingerprint(manifest) {
  const metadata = JSON.stringify({
    build: manifest.build,
    models: manifest.models.map((model) => ({ key: model.key, bytes: model.bytes, sha256: model.sha256 })).sort((left, right) => String(left.key).localeCompare(String(right.key))),
  })
  return digest(Buffer.from(metadata))
}

/**
 * Публикует проверенный кандидат в новый неизменяемый выпуск. Активный
 * указатель и узкие записи прав меняются только после проверки всех GLB.
 *
 * @param {string} directory
 * @param {{rootDir?:string,register?:(paths:string[],registryFile:string,options:{assetsRoot:string})=>unknown}} [options]
 */
export async function publishEquipmentCandidate(directory, { rootDir = ROOT, register = registerAssets } = {}) {
  const { candidate, manifest, files } = await checkedCandidate(directory)
  const root = resolve(rootDir)
  const publicAssets = join(root, 'public', 'assets')
  const equipmentRoot = join(publicAssets, 'models', 'equipment')
  const rightsFile = join(root, 'data', 'asset-rights.json')
  await plainDirectory(publicAssets, 'public/assets')
  await plainDirectory(join(publicAssets, 'models'), 'public/assets/models')
  await plainDirectory(equipmentRoot, 'public/assets/models/equipment')
  await plainDirectory(join(root, 'data'), 'data')
  await plainFile(rightsFile, 'data/asset-rights.json')
  const fingerprint = releaseFingerprint(manifest)
  const releaseId = `equipment-${fingerprint.slice(0, 24)}`
  const releaseUrl = `${URL_ROOT}${releaseId}/`
  const releaseManifest = structuredClone(manifest)
  releaseManifest.models = releaseManifest.models.map((model) => ({ ...model, url: `${releaseUrl}${basename(model.url)}` }))
  releaseManifest.release = {
    schema: 'equipment-release/v1',
    id: releaseId,
    fingerprint,
    files: releaseManifest.models.map((model) => ({ path: basename(model.url), bytes: model.bytes, sha256: model.sha256 })),
  }
  const releaseManifestBytes = Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`)
  const releaseNotice = Buffer.from(noticeText(releaseManifest, releaseId))
  const releaseFiles = new Map([
    ['manifest.json', releaseManifestBytes],
    ['NOTICE.txt', releaseNotice],
    ['LICENSE.txt', files.get('LICENSE.txt')],
  ])
  for (const model of manifest.models) releaseFiles.set(basename(model.url), files.get(basename(model.url)))
  const releaseDirectory = join(equipmentRoot, releaseId)
  const existing = await plainDirectory(releaseDirectory, `выпуск ${releaseId}`)
  if (existing) {
    const existingManifest = await readFile(join(releaseDirectory, 'manifest.json')).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error(`Выпуск ${releaseId} неполон`)
      throw error
    })
    if (!existingManifest.equals(releaseManifestBytes)) throw new Error(`Неизменяемый выпуск ${releaseId} уже содержит другой manifest`)
    for (const [name, bytes] of releaseFiles) {
      const current = await readFile(join(releaseDirectory, name))
      if (!current.equals(bytes)) throw new Error(`Неизменяемый выпуск ${releaseId} содержит другой ${name}`)
    }
  } else {
    await mkdir(releaseDirectory, { recursive: true })
    for (const [name, bytes] of releaseFiles) await writeFile(join(releaseDirectory, name), bytes, { flag: 'wx' })
  }
  const activeManifest = join(equipmentRoot, 'manifest.json')
  await plainFile(activeManifest, 'public/assets/models/equipment/manifest.json')
  const rightsPaths = [
    ...[...releaseFiles.keys()].map((name) => `models/equipment/${releaseId}/${name}`),
    'models/equipment/manifest.json',
  ]
  await writeFile(activeManifest, releaseManifestBytes)
  const rights = register(rightsPaths, rightsFile, { assetsRoot: publicAssets })
  return { candidate, releaseId, fingerprint, releaseDirectory, activeManifest, manifest: releaseManifest, rights }
}

async function main() {
  const { values, positionals } = parseArgs({ options: { out: { type: 'string' }, publish: { type: 'boolean' } }, allowPositionals: true })
  if (positionals.length) throw new Error('Используйте --out <каталог-кандидат>')
  const result = await buildEquipmentModels({ out: values.out ?? DEFAULT_OUTPUT })
  const published = values.publish ? await publishEquipmentCandidate(result.directory) : null
  process.stdout.write(`${JSON.stringify({ directory: result.directory, models: result.manifest.models.length, catalogIds: result.manifest.build.catalogEquippableCount, ...(published ? { releaseId: published.releaseId, activated: true } : {}) }, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
