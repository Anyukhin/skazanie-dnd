import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createCampaignWorldMap } from '../server/world-map.mjs'
import { publicWorldMapFor } from '../server/viewer-projection.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporaryRoot = join(root, 'tmp')
mkdirSync(temporaryRoot, { recursive: true })
const buildDir = mkdtempSync(join(temporaryRoot, 'world-map-render-'))
assert.ok(buildDir.startsWith(temporaryRoot + sep))
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))
const compiled = spawnSync(process.execPath, [
  join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--target', 'ES2022',
  '--module', 'ESNext', '--moduleResolution', 'Bundler', '--jsx', 'react-jsx',
  '--lib', 'ES2022,DOM', '--types', 'vite/client', '--strict', '--skipLibCheck', '--outDir', buildDir,
  join(root, 'src/WorldMapView.tsx'),
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(buildDir).filter((name) => name.endsWith('.js'))) {
  const path = join(buildDir, name)
  const code = readFileSync(path, 'utf8')
    .replace(/^import ['"][^'"]+\.css['"];?\s*$/gmu, '')
    .replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/gu, (match, before, specifier, after) => /\.(?:mjs|js)$/u.test(specifier) ? match : `${before}${specifier}.mjs${after}`)
  writeFileSync(path, code)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}
const { WorldMapView } = await import(pathToFileURL(join(buildDir, 'WorldMapView.mjs')).href)

test('глобальная карта отображает настоящую проекцию игрока без внутреннего seed', () => {
  const privateMap = createCampaignWorldMap({ seed: 'private-world-seed', campaignName: 'Проверка карты', startingLocation: 'Норвин' })
  const worldMap = publicWorldMapFor(privateMap)
  assert.equal(worldMap.seed, undefined, 'внутренний seed остаётся закрытым')
  const state = { campaign: 'Проверка карты', scene: { location: 'Норвин' }, worldMap }
  const markup = renderToStaticMarkup(createElement(WorldMapView, { state, busy: false, onTravel() {} }))
  assert.match(markup, /class="world-map-canvas\b/u)
  assert.match(markup, /Норвин/u)
  assert.doesNotMatch(markup, /private-world-seed|NaN/u)
  assert.equal(renderToStaticMarkup(createElement(WorldMapView, { state, busy: false, onTravel() {} })), markup, 'декоративная карта стабильна при повторном открытии')
})
