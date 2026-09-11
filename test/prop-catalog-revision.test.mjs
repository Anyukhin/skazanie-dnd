import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(root, 'tmp', 'prop-catalog-revision-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const source = fileURLToPath(new URL('../src/prop-model-catalog.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, source,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)

function emittedFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? emittedFiles(path) : [path]
  })
}
for (const path of emittedFiles(buildDir).filter((candidate) => candidate.endsWith('.js'))) {
  const sourceText = readFileSync(path, 'utf8')
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) =>
      /\.(json|mjs|js)$/u.test(specifier) ? match : `${before}${specifier}.mjs${after}`)
  writeFileSync(path, sourceText)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}
const catalogModule = await import(pathToFileURL(join(buildDir, 'prop-model-catalog.mjs')).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

const rootUrl = '/assets/models/environment/'
const baselinePath = join(root, 'public', 'assets', 'models', 'environment', 'baseline-pr79.json')
const baselineBytes = readFileSync(baselinePath)
const baselineRaw = JSON.parse(baselineBytes)
const routes = new Map()
const requests = []

function catalogUrl(revision) {
  return revision === catalogModule.LEGACY_CATALOG_REVISION
    ? `${rootUrl}baseline-pr79.json`
    : `${rootUrl}releases/${revision}/manifest.json`
}

function setRoute(revision, raw, options = {}) {
  routes.set(catalogUrl(revision), {
    body: typeof raw === 'string' ? raw : JSON.stringify(raw),
    status: 200,
    ...options,
  })
}

function model(key, assetId = 'barrel', revision = 'v1') {
  return {
    key, label: key, category: 'test', url: `${rootUrl}releases/${revision}/${key}.glb`, assetIds: [assetId], yaw: 0,
  }
}

function releaseCatalog(revision, models) {
  return {
    version: 1, release: { id: revision }, models,
    atlas: { image: `${rootUrl}releases/${revision}/topdown.png`, key: 'a'.repeat(64) },
  }
}

async function fakeFetch(url) {
  const requestUrl = String(url)
  requests.push(requestUrl)
  const route = routes.get(requestUrl)
  if (route?.gate) await route.gate
  return new Response(route?.body ?? 'not found', { status: route?.status ?? 404 })
}

const previousWindow = globalThis.window
const previousFetch = globalThis.fetch
globalThis.window = {}
globalThis.fetch = fakeFetch

test('baseline pr79 сохраняет исходные URL и optional revision', () => {
  assert.equal(catalogModule.LEGACY_CATALOG_REVISION, 'pr79')
  assert.equal(baselineRaw.revision, 'pr79')
  assert.equal(baselineRaw.models.length, 125)
  assert.equal(baselineRaw.models[0].url, `${rootUrl}quaternius/anvil.glb`)
  assert.equal(baselineRaw.atlas.image, `${rootUrl}topdown.png`)
  assert.ok(baselineRaw.models.every(({ url }) => !url.includes('/releases/')))

  const catalog = catalogModule.validatePropModelCatalog(baselineRaw)
  assert.equal(catalog.revision, 'pr79')
  assert.equal(catalog.models.length, 125)
  assert.equal(catalog.atlas.image, `${rootUrl}topdown.png`)
  assert.equal(catalogModule.validatePropModelCatalog({ version: 1, models: [] }).revision, undefined)
  assert.equal(catalogModule.validatePropModelCatalog({ version: 1, revision: '../escape', models: [] }).revision, undefined)
})

test('загрузка по revision pin-ит выбор, дедуплицирует v1/v2/v1 и не меняет baseline', async () => {
  const missingRevision = structuredClone(baselineRaw)
  delete missingRevision.revision
  setRoute('pr79', missingRevision)
  assert.equal(await catalogModule.loadPropModelCatalog(), null)
  setRoute('pr79', baselineBytes.toString('utf8'))

  const modified = structuredClone(baselineRaw)
  delete modified.revision
  modified.release = { id: 'v2' }
  modified.models = modified.models.map((entry) => ({ ...entry, url: `${rootUrl}releases/v2/${entry.url.slice(rootUrl.length)}` }))
  modified.atlas = { ...modified.atlas, image: `${rootUrl}releases/v2/topdown.png` }
  const barrel = modified.models.filter(({ assetIds }) => assetIds.includes('barrel'))
  assert.ok(barrel.length >= 2)
  modified.models = modified.models.filter(({ assetIds }) => !assetIds.includes('barrel'))
  modified.models.push(...barrel.reverse(), { ...barrel[0], key: 'v2-added-barrel' })

  const v1Raw = releaseCatalog('v1', [model('v1-a', 'barrel', 'v1'), model('v1-b', 'barrel', 'v1')])
  let releaseV1
  const v1Gate = new Promise((resolve) => { releaseV1 = resolve })
  let releaseV2
  const v2Gate = new Promise((resolve) => { releaseV2 = resolve })
  setRoute('v1', v1Raw, { gate: v1Gate })
  setRoute('v2', modified, { gate: v2Gate })

  const modifiedCatalog = catalogModule.validatePropModelCatalog(modified)
  const pinned = await catalogModule.loadPropModelCatalog()
  assert.equal(pinned?.revision, 'pr79')
  const baselineSelectionBefore = catalogModule.propModelFor(pinned, 'barrel', 'pinned-barrel')
  assert.ok(baselineSelectionBefore)

  const beforeRequests = requests.length
  const v1First = catalogModule.loadPropModelCatalog('v1')
  const v1Second = catalogModule.loadPropModelCatalog('v1')
  const v2First = catalogModule.loadPropModelCatalog('v2')
  const v2Second = catalogModule.loadPropModelCatalog('v2')
  await Promise.resolve()
  assert.equal(requests.length, beforeRequests + 2)
  assert.equal(requests.filter((url) => url === catalogUrl('v1')).length, 1)
  assert.equal(requests.filter((url) => url === catalogUrl('v2')).length, 1)
  releaseV1()
  releaseV2()
  const [v1, v1Again, v2, v2Again] = await Promise.all([v1First, v1Second, v2First, v2Second])
  assert.strictEqual(v1, v1Again)
  assert.strictEqual(v2, v2Again)
  assert.equal(v1?.revision, 'v1')
  assert.equal(v2?.revision, 'v2')
  assert.equal(await catalogModule.loadPropModelCatalog('v1'), v1)

  const pinnedSelectionAfter = catalogModule.propModelFor(pinned, 'barrel', 'pinned-barrel')
  const currentSelection = catalogModule.propModelFor(v2, 'barrel', 'pinned-barrel')
  assert.equal(pinnedSelectionAfter?.key, baselineSelectionBefore.key)
  assert.notEqual(currentSelection?.key, baselineSelectionBefore.key, 'изменённые варианты должны отличаться от старого pin')
  assert.equal(readFileSync(baselinePath).compare(baselineBytes), 0)
  assert.ok(v2?.models.some(({ key }) => key === 'v2-added-barrel'))
  assert.ok(modifiedCatalog.models.some(({ key }) => key === 'v2-added-barrel'))
})

test('неизвестный или некорректный revision не откатывается к active manifest', async () => {
  const mismatch = releaseCatalog('else', [model('mismatch', 'barrel', 'else')])
  setRoute('bad-release', mismatch)
  const failed = await catalogModule.loadPropModelCatalog('bad-release')
  assert.equal(failed, null)
  setRoute('bad-release', releaseCatalog('bad-release', [model('recovered', 'barrel', 'bad-release')]))
  const recovered = await catalogModule.loadPropModelCatalog('bad-release')
  assert.equal(recovered?.revision, 'bad-release')
  assert.equal(requests.filter((url) => url === catalogUrl('bad-release')).length, 2)

  const beforeInvalid = requests.length
  for (const invalid of ['', '../manifest', 'https://evil.invalid/manifest', null, 42]) {
    assert.equal(await catalogModule.loadPropModelCatalog(invalid), null)
  }
  assert.equal(requests.length, beforeInvalid)

  const missing = await catalogModule.loadPropModelCatalog('missing')
  assert.equal(missing, null)
  assert.equal(requests.at(-1), catalogUrl('missing'))
  assert.equal(requests.includes(`${rootUrl}manifest.json`), false)
})

test('release отклоняет GLB и atlas вне собственного immutable prefix, legacy остаётся совместимым', () => {
  const valid = releaseCatalog('v9', [model('valid', 'barrel', 'v9')])
  assert.doesNotThrow(() => catalogModule.validatePropModelCatalog(valid))

  const mutableModel = structuredClone(valid)
  mutableModel.models[0].url = `${rootUrl}quaternius/valid.glb`
  assert.throws(() => catalogModule.validatePropModelCatalog(mutableModel), /Некорректная запись модели/u)

  const mutableAtlas = structuredClone(valid)
  mutableAtlas.atlas.image = `${rootUrl}topdown.png`
  assert.throws(() => catalogModule.validatePropModelCatalog(mutableAtlas), /Некорректная запись атласа/u)

  assert.doesNotThrow(() => catalogModule.validatePropModelCatalog(baselineRaw, 'pr79'))
})

process.on('exit', () => {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
  if (previousFetch === undefined) delete globalThis.fetch
  else globalThis.fetch = previousFetch
})
