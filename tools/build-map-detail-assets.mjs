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

export async function buildMapDetailAssets({ specFile, sourceDir, outputDir, modelPreviewDir }) {
  const spec = JSON.parse(await readFile(specFile, 'utf8'))
  if (spec.models?.length !== 64 || new Set(spec.models.map(model => model.id)).size !== 64) throw new Error('Нужны 64 уникальные модели заказа')
  const raster = buildMapDetailRasters({ spec, sourceDir, outputDir })
  const models = await buildMapDetailModels({ models: spec.models, outputDir })
  const atlas = decodePng(await readFile(join(outputDir, 'prop-atlas.png')))
  await writeFile(join(outputDir, 'raster-preview.png'), encodePng(previewSheet(atlas, raster.atlasManifest)))
  const modelRecords = models.map(model => ({ ...spec.models.find(item => item.id === model.id), ...model }))
  if (modelPreviewDir) {
    const previews = JSON.parse(await readFile(join(modelPreviewDir, 'manifest.json'), 'utf8'))
    const image = decodePng(await readFile(join(modelPreviewDir, 'topdown.png')))
    if (previews.models.length !== models.length || image.width !== 2048 || image.height !== 2048) throw new Error('Предпросмотр должен содержать все 64 модели')
    for (const model of modelRecords) {
      const entry = previews.models.find(item => item.key === model.id)
      if (!entry?.preview) throw new Error(`Нет предпросмотра модели: ${model.id}`)
      const previewBytes = await readFile(join(modelPreviewDir, 'skazanie', `${model.id}.glb`))
      if (hash(previewBytes) !== model.sha256) throw new Error(`Предпросмотр устарел: ${model.id}`)
      model.preview = entry.preview
    }
    await copyFile(join(modelPreviewDir, 'topdown.png'), join(outputDir, 'model-preview.png'))
  }
  const sources = await mapDetailModelSources()
  for (const file of ['build-map-detail-assets.mjs', 'build-map-detail-rasters.mjs']) {
    const bytes = await readFile(new URL(file, import.meta.url))
    sources.push({ file: `tools/${file}`, sha256: hash(bytes), bytes: bytes.length })
  }
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
    counts: { sourceRasters: 34, textures: 19, sheets: 15, stamps: 135, models: 64 },
    promptSpec: 'docs/map-detail-assets-spec-v1.json',
    provenance: {
      rasterMethod: 'OpenAI built-in image_gen',
      modelMethod: 'original procedural low-poly, Three.js GLTFExporter',
      thirdPartyModelsIncluded: false,
      requestedByOwner: '2026-10-02',
      sourcePrompts: 'docs/map-detail-assets-prompts.md',
      generators: sources,
    },
    models: modelRecords,
    previews: { raster: 'raster-preview.png', ...(modelPreviewDir ? { models: 'model-preview.png' } : {}) },
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
  } })
  const manifest = await buildMapDetailAssets({ specFile: values.spec, sourceDir: values['source-dir'], outputDir: values.out, modelPreviewDir: values['model-preview-dir'] })
  process.stdout.write(`${JSON.stringify({ outputDir: values.out, counts: manifest.counts, bytes: manifest.files.reduce((total, file) => total + file.bytes, 0) })}\n`)
}
