import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { DirectionalLight, Vector3 } from 'three'

// Сборка внутри репозитория: из временного каталога снаружи Node не видит `three`.
const testTempRoot = fileURLToPath(new URL('../tmp/', import.meta.url))
mkdirSync(testTempRoot, { recursive: true })
const buildDir = mkdtempSync(join(testTempRoot, 'board3d-graphics-'))
test.after(() => rmSync(buildDir, { recursive: true, force: true }))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/board3d-graphics.ts'].map((path) => fileURLToPath(new URL(path, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(buildDir).filter((entry) => entry.endsWith('.js'))) {
  const path = join(buildDir, name)
  const source = readFileSync(path, 'utf8').replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) => (
    /\.(json|mjs|js)$/u.test(specifier) ? match : `${before}${specifier}.mjs${after}`
  ))
  writeFileSync(path, source)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}
const graphics = await import(pathToFileURL(join(buildDir, 'board3d-graphics.mjs')).href)

test('вспышки эффекта: не больше двух, мусор и нулевые отбрасываются, значения ограничены', () => {
  const light = { x: 1, y: 2, z: 3, color: '#ffaa33', intensity: 4, distance: 6 }
  assert.deepEqual(graphics.boardEffectLights(undefined), [])
  assert.deepEqual(graphics.boardEffectLights('лампа'), [])
  assert.deepEqual(graphics.boardEffectLights([light, light, light]).length, 2)
  assert.deepEqual(graphics.boardEffectLights([{ ...light, intensity: 0 }, { ...light, color: 'red' }, { ...light, x: Number.NaN }, null]), [])
  const [clamped] = graphics.boardEffectLights([{ ...light, intensity: 99, distance: 500 }])
  assert.equal(clamped.intensity, 8)
  assert.equal(clamped.distance, 12)
})

test('тень солнца охватывает всю карту и смотрит в её центр', () => {
  const sun = new DirectionalLight()
  const bounds = { minX: 0, minZ: 0, maxX: 60, maxZ: 40, minY: 0, maxY: 3 }
  graphics.fitSunShadow(sun, bounds)
  const camera = sun.shadow.camera
  const halfDiagonal = Math.hypot(60, 40) / 2
  assert.ok(camera.right >= halfDiagonal && camera.top >= halfDiagonal, 'края большой карты не остаются без тени')
  assert.ok(camera.right < halfDiagonal + 4, 'камера тени не раздута — тень остаётся резкой')
  assert.deepEqual(sun.target.position.toArray(), [30, 1.5, 20])
  const distance = sun.position.distanceTo(sun.target.position)
  assert.ok(camera.far > distance + halfDiagonal, 'дальняя плоскость накрывает карту целиком')
  assert.ok(sun.position.y > sun.target.position.y)
  const toTarget = new Vector3().subVectors(sun.target.position, sun.position).normalize()
  assert.ok(toTarget.y < -.4, 'солнце светит сверху, а не вдоль пола')
})

test('свет: заливка слабее солнца, подложка не заливает пол при линейном смешивании', () => {
  assert.ok(graphics.BOARD3D_LIGHTING.sun.intensity > graphics.BOARD3D_LIGHTING.hemisphere.intensity)
  assert.ok(graphics.BOARD3D_LIGHTING.linearArtOverlayOpacity < .34)
})

test('без DOM фон-виньетка не создаётся и не ломает сцену', () => {
  assert.equal(graphics.createBoardBackdropTexture(), null)
})

test('сумрак: подземелье темнее помещения при свете, открытая местность — дневная', () => {
  const cellsOf = (zone) => (x, y) => ({ revealed: true, passable: true, zone })
  const map = (kind, lightLevel) => ({ width: 2, height: 2, zones: [{ id: 'z', kind, lightLevel }] })
  assert.equal(graphics.boardDarkness(map('exterior', 'bright'), cellsOf('z')), 0)
  assert.equal(graphics.boardDarkness(map('interior', 'dark'), cellsOf('z')), 1)
  assert.ok(graphics.boardDarkness(map('interior', 'bright'), cellsOf('z')) < graphics.boardDarkness(map('interior', 'dim'), cellsOf('z')))
  assert.equal(graphics.boardDarkness(map('exterior', 'bright'), () => null), 0, 'пустая карта — без сумрака')
  const day = graphics.lightingForDarkness(0), night = graphics.lightingForDarkness(1)
  assert.equal(day.sun, graphics.BOARD3D_LIGHTING.sun.intensity)
  assert.ok(night.sun < day.sun * .1, 'в подземелье солнце почти гаснет')
  assert.ok(night.hemisphere < day.hemisphere)
})
