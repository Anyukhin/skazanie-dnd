import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// Модуль чистый, но написан на TypeScript. Компилируем настоящий исходник во
// временный каталог, чтобы проверять алгоритм выбора пути, а не его копию в
// тесте. Type-only импорт GameState после компиляции исчезает.
const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-world-travel-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sourcePath = fileURLToPath(new URL('../src/world-travel.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, sourcePath,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const modulePath = join(buildDir, 'world-travel.mjs')
writeFileSync(modulePath, readFileSync(join(buildDir, 'world-travel.js'), 'utf8'))
const { currentWorldLocation, neighboringDestinations, reachableDestinations } = await import(pathToFileURL(modulePath).href)

test.after(() => rmSync(buildDir, { recursive: true, force: true }))

function state() {
  return {
    scene: { location: 'Тихий Брод' },
    worldMap: {
      currentLocationId: 'a',
      locations: [
        { id: 'a', name: 'Тихий Брод', kind: 'village', known: true, visited: true },
        { id: 'b', name: 'Дорфорд', kind: 'city', known: true, visited: false },
        { id: 'c', name: 'Кальская твердыня', kind: 'fortress', known: true, visited: false },
        { id: 'hidden', name: 'Скрытая башня', kind: 'fortress', known: true, visited: false },
      ],
      routes: [
        { id: 'ab', from: 'a', to: 'b', kind: 'road', distance: 2, danger: 'низкая', discovered: true },
        { id: 'bc', from: 'b', to: 'c', kind: 'road', distance: 3, danger: 'высокая', discovered: true },
        { id: 'ah', from: 'a', to: 'hidden', kind: 'trail', distance: 1, danger: 'средняя', discovered: false },
      ],
    },
  }
}

test('быстрый выход показывает только прямого соседа, а дальний путь остаётся глобальной карте', () => {
  const campaign = state()
  assert.deepEqual(neighboringDestinations(campaign).map((entry) => entry.location.id), ['b'])
  assert.deepEqual(neighboringDestinations(campaign)[0].routeNames, ['Тихий Брод', 'Дорфорд'])
  assert.deepEqual(reachableDestinations(campaign).map((entry) => entry.location.id), ['b', 'c'])
})

test('текущая точка ищется без учёта регистра и лишних пробелов, но не подменяется первой известной', () => {
  const campaign = state()
  campaign.worldMap.currentLocationId = 'устаревший-id'
  campaign.scene.location = '  тихий   брод '
  assert.equal(currentWorldLocation(campaign)?.id, 'a')

  campaign.scene.location = 'Несуществующее место'
  assert.equal(currentWorldLocation(campaign), null)
  assert.deepEqual(neighboringDestinations(campaign), [])
})
