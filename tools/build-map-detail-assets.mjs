#!/usr/bin/env node
/** Собирает заказ ассетов в отдельный пакет, без активации новой механики карты. */
import { createHash } from 'node:crypto'
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { buildMapDetailRasters } from './build-map-detail-rasters.mjs'
import { buildMapDetailModels, mapDetailModelSources } from './build-map-detail-models.mjs'
import { decodePng, encodePng } from './png-codec.mjs'
import { previewSheet } from './build-prop-atlas.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value)) throw new Error(`${label} должен быть массивом непустых строк`)
  if (new Set(values).size !== values.length) throw new Error(`${label} содержит повторы`)
  return values
}

/** Граница подключения берётся из спецификации, а не из текущего каталога runtime. */
export function resolveMapDetailIntegration(spec) {
  const sourceSheets = new Set((spec.pendingIntegration?.sheets ?? []).filter(file => typeof file === 'string'))
  const sourcePendingStamps = spec.rasters.filter(item => sourceSheets.has(item.file)).flatMap(item => item.ids)
  const sourceStampSet = new Set(sourcePendingStamps)
  const modelIds = new Set((spec.models ?? []).map(model => model.id))
  const integration = spec.integration ?? {}
  const detailProps = integration.detailProps ?? {}
  const activatedModels = uniqueStrings(detailProps.models ?? [], 'integration.detailProps.models')
  const activatedStamps = uniqueStrings(detailProps.stamps ?? [], 'integration.detailProps.stamps')
  const structuralEntries = Array.isArray(integration.structural) ? integration.structural : []
  const structural = structuralEntries.map((entry, index) => {
    if (typeof entry === 'string') return { model: entry, role: entry }
    if (!entry || typeof entry !== 'object' || typeof entry.model !== 'string' || typeof entry.role !== 'string') throw new Error(`integration.structural[${index}] должен содержать model и role`)
    return { model: entry.model, role: entry.role }
  })
  const structuralModels = uniqueStrings(structural.map(entry => entry.model), 'integration.structural.models')
  const activatedModelSet = new Set(activatedModels)
  const activatedStampSet = new Set(activatedStamps)
  const structuralModelSet = new Set(structuralModels)
  if (activatedModels.length !== activatedStamps.length || activatedModels.some(id => !activatedStampSet.has(id)) || activatedStamps.some(id => !activatedModelSet.has(id))) {
    throw new Error('Активация detail props должна иметь одинаковые model и stamp ID')
  }
  for (const id of [...activatedModels, ...structuralModels]) {
    if (!modelIds.has(id)) throw new Error(`Неизвестная модель интеграции: ${id}`)
    if (!sourceStampSet.has(id)) throw new Error(`Модель интеграции без исходного pending-штампа: ${id}`)
  }
  for (const id of activatedStamps) if (!sourceStampSet.has(id)) throw new Error(`Неизвестный pending-штамп интеграции: ${id}`)
  // Штампы, у которых 3D-модель есть только в пакете стиля (рецепт
  // tools/map-detail-models-frontier.mjs), а GLB в наборе нет.
  const styleStamps = uniqueStrings(integration.styleProps?.stamps ?? [], 'integration.styleProps.stamps')
  for (const id of styleStamps) {
    if (!sourceStampSet.has(id)) throw new Error(`Неизвестный pending-штамп стиля: ${id}`)
    if (activatedStampSet.has(id) || structuralModelSet.has(id)) throw new Error(`Штамп подключён дважды: ${id}`)
  }
  const styleStampSet = new Set(styleStamps)
  const pendingStamps = sourcePendingStamps.filter(id => !activatedStampSet.has(id) && !styleStampSet.has(id))
  const pendingModels = spec.models.filter(model => pendingStamps.includes(model.id) && !activatedModelSet.has(model.id) && !structuralModelSet.has(model.id)).map(model => model.id)
  const pendingTextures = (spec.pendingIntegration?.textures ?? []).map(file => file.replace(/\.png$/u, ''))
  return {
    pendingIntegration: { stamps: pendingStamps, models: pendingModels, textures: pendingTextures },
    structuralIntegration: { models: structuralModels },
    styleIntegration: { stamps: styleStamps },
    structural,
  }
}

async function mapDetailAssetSources() {
  const sources = await mapDetailModelSources()
  for (const file of ['build-map-detail-assets.mjs', 'build-map-detail-rasters.mjs']) {
    const bytes = await readFile(new URL(file, import.meta.url))
    sources.push({ file: `tools/${file}`, sha256: hash(bytes), bytes: bytes.length })
  }
  return sources
}

function provenanceWithIntegration(provenance, specBytes, sources) {
  const sourceSpec = { file: 'docs/map-detail-assets-spec-v1.json', sha256: hash(specBytes), bytes: specBytes.length }
  const generator = sources.find(source => source.file === 'tools/build-map-detail-assets.mjs')
  return {
    ...provenance,
    sourceSpec,
    sourceSha256: sourceSpec.sha256,
    generatorSha256: generator?.sha256,
    generators: sources,
  }
}

/** Обновляет только metadata подключения и происхождения, не трогая байты ассетов. */
export async function updateMapDetailAssetManifest({ specFile, manifestFile }) {
  const specBytes = await readFile(specFile)
  const spec = JSON.parse(specBytes.toString('utf8'))
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  const integration = resolveMapDetailIntegration(spec)
  const sources = await mapDetailAssetSources()
  const next = {
    ...manifest,
    pendingIntegration: integration.pendingIntegration,
    structuralIntegration: integration.structuralIntegration,
    styleIntegration: integration.styleIntegration,
    provenance: provenanceWithIntegration(manifest.provenance ?? {}, specBytes, sources),
  }
  await writeFile(manifestFile, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export async function buildMapDetailAssets({ specFile, sourceDir, outputDir, modelPreviewDir }) {
  const specBytes = await readFile(specFile)
  const spec = JSON.parse(specBytes.toString('utf8'))
  if (spec.models?.length !== spec.counts?.models || new Set(spec.models.map(model => model.id)).size !== spec.counts.models) throw new Error('Состав моделей должен совпадать с заказом и не содержать повторов')
  const integration = resolveMapDetailIntegration(spec)
  const raster = buildMapDetailRasters({ spec, sourceDir, outputDir })
  const models = await buildMapDetailModels({ models: spec.models, outputDir })
  const atlas = decodePng(await readFile(join(outputDir, 'prop-atlas.png')))
  await writeFile(join(outputDir, 'raster-preview.png'), encodePng(previewSheet(atlas, raster.atlasManifest)))
  const expansionFrames = Object.fromEntries(spec.rasters.filter(item => spec.previewSheets?.includes(item.file)).flatMap(item => item.ids.map(id => [id, raster.atlasManifest.frames[id]])))
  const hasExpansionPreview = Object.keys(expansionFrames).length > 0
  if (hasExpansionPreview) await writeFile(join(outputDir, 'expansion-preview.png'), encodePng(previewSheet(atlas, { frames: expansionFrames })))
  const modelRecords = models.map(model => ({ ...spec.models.find(item => item.id === model.id), ...model }))
  const pending = spec.pendingIntegration ?? { sheets: [], textures: [] }
  for (const file of [...pending.sheets, ...pending.textures]) {
    if (!spec.rasters.some(item => item.file === file && (pending.sheets.includes(file) ? item.type === 'sheet' : item.type !== 'sheet'))) throw new Error(`Неизвестный подготовленный источник: ${file}`)
  }
  if (modelPreviewDir) {
    const previews = JSON.parse(await readFile(join(modelPreviewDir, 'manifest.json'), 'utf8'))
    const image = decodePng(await readFile(join(modelPreviewDir, 'topdown.png')))
    if (previews.models.length !== models.length || image.width !== 2048 || image.height !== Math.ceil(models.length / 8) * 256) throw new Error('Предпросмотр должен содержать все модели заказа')
    for (const model of modelRecords) {
      const entry = previews.models.find(item => item.key === model.id)
      if (!entry?.preview) throw new Error(`Нет предпросмотра модели: ${model.id}`)
      const previewBytes = await readFile(join(modelPreviewDir, 'skazanie', `${model.id}.glb`))
      if (hash(previewBytes) !== model.sha256) throw new Error(`Предпросмотр устарел: ${model.id}`)
      model.preview = entry.preview
    }
    await copyFile(join(modelPreviewDir, 'topdown.png'), join(outputDir, 'model-preview.png'))
  }
  const sources = await mapDetailAssetSources()
  const files = []
  async function collect(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + entry.name
      if (entry.isDirectory()) await collect(join(directory, entry.name), `${path}/`)
      else if (path !== 'manifest.json') {
        const bytes = await readFile(join(directory, entry.name))
        files.push({ file: path, sha256: hash(bytes), bytes: bytes.length })
      }
    }
  }
  await collect(outputDir)
  const manifest = {
    ...raster.manifest,
    schema: 'map-detail-assets/v1',
    status: 'prepared',
    counts: raster.manifest.counts,
    promptSpec: 'docs/map-detail-assets-spec-v1.json',
    pendingIntegration: integration.pendingIntegration,
    structuralIntegration: integration.structuralIntegration,
    styleIntegration: integration.styleIntegration,
    provenance: {
      rasterMethod: 'OpenAI built-in image_gen',
      modelMethod: 'original detailed geometry, UV and PBR, Three.js GLTFExporter',
      modelTriangleBudget: 50000,
      materialSources: models[0]?.materialSources ?? [],
      thirdPartyModelsIncluded: false,
      requestedByOwner: '2026-10-02',
      sourcePrompts: 'docs/map-detail-assets-prompts.md',
      ...provenanceWithIntegration({}, specBytes, sources),
    },
    models: modelRecords,
    previews: { raster: 'raster-preview.png', ...(modelPreviewDir ? { models: 'model-preview.png' } : {}), ...(hasExpansionPreview ? { expansion: 'expansion-preview.png' } : {}) },
    files,
  }
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    spec: { type: 'string', default: 'docs/map-detail-assets-spec-v1.json' },
    'source-dir': { type: 'string', default: 'assets-src/map-detail' },
    out: { type: 'string', default: 'public/assets/maps/detail-v1' },
    'model-preview-dir': { type: 'string' },
    'metadata-only': { type: 'boolean', default: false },
  } })
  if (values['metadata-only']) {
    const manifest = await updateMapDetailAssetManifest({ specFile: values.spec, manifestFile: join(values.out, 'manifest.json') })
    process.stdout.write(`${JSON.stringify({ outputDir: values.out, counts: manifest.counts, metadataOnly: true })}\n`)
    process.exit(0)
  }
  const manifest = await buildMapDetailAssets({ specFile: values.spec, sourceDir: values['source-dir'], outputDir: values.out, modelPreviewDir: values['model-preview-dir'] })
  process.stdout.write(`${JSON.stringify({ outputDir: values.out, counts: manifest.counts, bytes: manifest.files.reduce((total, file) => total + file.bytes, 0) })}\n`)
}
