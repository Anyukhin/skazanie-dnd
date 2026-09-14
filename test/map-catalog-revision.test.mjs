import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { MapStore } from '../server/map-store.mjs'
import { publicTacticalMapFor } from '../server/viewer-projection.mjs'
import {
  createTacticalMap,
  deserializeTacticalMap,
  serializeTacticalMap,
  serializedTacticalMapHash,
  tacticalMapFromLegacyCells,
} from '../server/tactical-map.mjs'
import {
  currentEnvironmentCatalogRevision,
  LEGACY_CATALOG_REVISION,
} from '../server/environment-catalog-revision.mjs'

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-map-catalog-revision-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const source = fileURLToPath(new URL('../src/tactical-map-client.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, source,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(buildDir)) {
  if (!name.endsWith('.js')) continue
  const file = join(buildDir, name)
  const text = readFileSync(file, 'utf8').replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3')
  writeFileSync(join(buildDir, name.replace(/\.js$/u, '.mjs')), text)
  rmSync(file)
}
globalThis.atob ??= (value) => Buffer.from(value, 'base64').toString('binary')
globalThis.btoa ??= (value) => Buffer.from(value, 'binary').toString('base64')
const client = await import(pathToFileURL(join(buildDir, 'tactical-map-client.mjs')).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function legacyCells() {
  return [
    { x: 0, y: 0, type: 'floor', revealed: true, material: 'stone', variant: 1 },
    { x: 1, y: 0, type: 'door', revealed: true, material: 'wood', variant: 0 },
  ]
}

test('новая карта закрепляет текущий выпуск, а override принимает неизвестный safe ID', () => {
  const fresh = createTacticalMap({ width: 2, height: 1 })
  assert.equal(fresh.catalogRevision, currentEnvironmentCatalogRevision())
  assert.match(fresh.catalogRevision, /^[a-z0-9][a-z0-9_-]{0,95}$/u)

  const explicit = createTacticalMap({ width: 2, height: 1, catalogRevision: 'future_release-2' })
  assert.equal(explicit.catalogRevision, 'future_release-2')
  assert.equal(serializeTacticalMap(explicit).catalogRevision, 'future_release-2')
  assert.equal(deserializeTacticalMap(serializeTacticalMap(explicit)).catalogRevision, 'future_release-2')
})

test('legacy карта сохраняет отсутствие revision и прежний hash через store и projection', (t) => {
  const map = tacticalMapFromLegacyCells(legacyCells())
  assert.equal(Object.hasOwn(map, 'catalogRevision'), false)
  const before = serializeTacticalMap(map)
  assert.equal(Object.hasOwn(before, 'catalogRevision'), false)
  const bytes = JSON.stringify(before)
  const hash = serializedTacticalMapHash(before)
  const after = serializeTacticalMap(deserializeTacticalMap(JSON.parse(bytes)))
  assert.equal(JSON.stringify(after), bytes)
  assert.equal(serializedTacticalMapHash(after), hash)

  const projected = publicTacticalMapFor(before)
  assert.ok(projected)
  assert.equal(Object.hasOwn(projected, 'catalogRevision'), false)
  const decoded = client.decodeTacticalMap(before)
  assert.ok(decoded)
  assert.equal(Object.hasOwn(decoded, 'catalogRevision'), false)

  const root = mkdtempSync(join(tmpdir(), 'skazanie-map-catalog-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MapStore({ rootDir: root })
  const ref = store.put(before)
  assert.deepEqual(store.get(ref.hash), before)
})

test('explicit revision переживает projection и client decode; null оставляет legacy форму', () => {
  const map = createTacticalMap({ width: 1, height: 1, catalogRevision: 'future' })
  const serialized = serializeTacticalMap(map)
  assert.equal(publicTacticalMapFor(serialized)?.catalogRevision, 'future')
  assert.equal(client.decodeTacticalMap(serialized)?.catalogRevision, 'future')

  const legacy = createTacticalMap({ width: 1, height: 1, catalogRevision: null })
  assert.equal(Object.hasOwn(legacy, 'catalogRevision'), false)
  assert.equal(Object.hasOwn(serializeTacticalMap(legacy), 'catalogRevision'), false)
  assert.equal(LEGACY_CATALOG_REVISION, 'pr79')
})

test('некорректный explicit revision отклоняется, safe ID остаётся без проверки каталога', () => {
  for (const value of ['', 'UPPER', '../release', 'a'.repeat(97), 42, null]) {
    if (value === null) continue
    assert.throws(
      () => createTacticalMap({ width: 1, height: 1, catalogRevision: value }),
      (error) => error?.code === 'CATALOG_REVISION_INVALID',
    )
  }
  const raw = serializeTacticalMap(createTacticalMap({ width: 1, height: 1, catalogRevision: null }))
  raw.catalogRevision = 'BAD'
  assert.throws(() => deserializeTacticalMap(raw), (error) => error?.code === 'CATALOG_REVISION_INVALID')
})

test('текущий выпуск читается из release.id, а отсутствие манифеста даёт pr79', () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-map-catalog-manifest-'))
  try {
    const manifest = join(root, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({ release: { id: 'new_release' } }))
    assert.equal(currentEnvironmentCatalogRevision(manifest), 'new_release')
    writeFileSync(manifest, JSON.stringify({ version: 1 }))
    assert.equal(currentEnvironmentCatalogRevision(manifest), LEGACY_CATALOG_REVISION)
    assert.equal(currentEnvironmentCatalogRevision(join(root, 'missing.json')), LEGACY_CATALOG_REVISION)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('в Docker layout берётся dist manifest, но dev public имеет приоритет', () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-map-catalog-runtime-layout-'))
  try {
    const publicManifest = join(root, 'public', 'assets', 'models', 'environment', 'manifest.json')
    const distManifest = join(root, 'dist', 'assets', 'models', 'environment', 'manifest.json')
    mkdirSync(join(root, 'dist', 'assets', 'models', 'environment'), { recursive: true })
    writeFileSync(distManifest, JSON.stringify({ version: 1, release: { id: 'docker-release' } }))
    assert.equal(currentEnvironmentCatalogRevision(publicManifest, distManifest), 'docker-release')

    mkdirSync(join(root, 'public', 'assets', 'models', 'environment'), { recursive: true })
    writeFileSync(publicManifest, JSON.stringify({ version: 1 }))
    assert.equal(currentEnvironmentCatalogRevision(publicManifest, distManifest), LEGACY_CATALOG_REVISION)

    writeFileSync(publicManifest, JSON.stringify({ version: 1, release: { id: 'dev-release' } }))
    assert.equal(currentEnvironmentCatalogRevision(publicManifest, distManifest), 'dev-release')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
