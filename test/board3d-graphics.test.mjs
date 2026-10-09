import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Color, DirectionalLight, Vector3 } from 'three'

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

test('огонь: центр пятна спокойнее прежнего, в двух-трёх клетках светит так же, свеча слабее жаровни', () => {
  const brazier = { radius: 6, strength: 130 }, candle = { radius: 2, strength: 48 }
  for (const darkness of [0, .6, 1]) {
    const fire = graphics.fireLightFor(brazier, darkness)
    const before = { intensity: 1.35 + 16 * darkness, decay: 2 }
    const at = (light, distance) => light.intensity / distance ** light.decay
    assert.equal(fire.decay, 1.5)
    assert.ok(Math.abs(at(fire, 2.5) / at(before, 2.5) - 1) < .02, 'яркость в 2,5 клетки прежняя')
    assert.ok(at(fire, .77) < .6 * at(before, .77), 'пол под низким огнём больше не выгорает в белый диск')
    assert.ok(fire.distance >= 6, 'радиус огня не сократился')
    assert.ok(graphics.fireLightFor(candle, darkness).intensity < .5 * fire.intensity, 'свеча светит слабее жаровни')
  }
  assert.ok(graphics.fireLightFor(brazier, 1).intensity > graphics.fireLightFor(brazier, 0).intensity * 5, 'в сумраке огонь — главный свет')
})

test('дыхание огня: детерминированно, в пределах амплитуды, соседние огни не мигают хором', () => {
  const amplitude = graphics.BOARD3D_FIRE_FLICKER.amplitude
  const samples = Array.from({ length: 600 }, (_, index) => graphics.fireFlicker(index / 60, 1))
  assert.ok(samples.every((value) => value >= 1 - amplitude - 1e-9 && value <= 1 + amplitude + 1e-9))
  assert.ok(Math.max(...samples) - Math.min(...samples) > amplitude, 'огонь заметно дышит')
  assert.equal(graphics.fireFlicker(3.21, 4), graphics.fireFlicker(3.21, 4))
  const other = Array.from({ length: 600 }, (_, index) => graphics.fireFlicker(index / 60, 2))
  assert.ok(samples.some((value, index) => Math.abs(value - other[index]) > .05), 'у соседнего огня своя фаза')
})

test('холодный тон: только сумрачные помещения и подземелья, огонь на нём тёплый, днём свет прежний', () => {
  const { BOARD3D_LIGHTING: light, BOARD3D_GRADE: grade } = graphics
  for (const darkness of [0, .35, .6]) {
    assert.equal(graphics.dungeonCoolness(darkness), 0, `сумрак ${darkness} — без холодного тона`)
    const ambience = graphics.lightingForDarkness(darkness)
    assert.equal(ambience.sunColor, new Color(light.sun.color).getStyle(), 'солнце дня и светлой таверны прежнее')
    assert.equal(ambience.hemisphereGround, new Color(light.hemisphere.ground).getStyle())
    assert.equal(ambience.warmth, grade.warmth)
  }
  assert.equal(graphics.dungeonCoolness(.85), 1, 'сумрачный склеп — полностью холодный')
  assert.equal(graphics.dungeonCoolness(1), 1)
  const dungeon = graphics.lightingForDarkness(.85)
  const sky = new Color(dungeon.hemisphereSky), moon = new Color(dungeon.sunColor)
  assert.ok(sky.b > sky.r && moon.b > moon.r, 'заливка и лунный ключ холодные')
  assert.ok(dungeon.warmth < 0, 'цветокоррекция не греет тень подземелья')
  assert.ok(dungeon.hemisphere > light.hemisphere.intensity * (1 - .8 * .85), 'холодная заливка сильнее прежней: камень читается')
  assert.deepEqual(graphics.dungeonBackdrop(['#2a2620', '#0d0c0a'], 0), ['#2a2620', '#0d0c0a'], 'вне подземелья фон прежний')
  assert.deepEqual(graphics.dungeonBackdrop(['#2a2620', '#0d0c0a'], 1), [...graphics.BOARD3D_DUNGEON_TONE.backdrop])
})
