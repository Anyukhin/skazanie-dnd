import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { OrthographicCamera, Vector3 } from 'three'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'tmp'), { recursive: true })
const output = mkdtempSync(join(root, 'tmp', 'board3d-camera-'))
process.on('exit', () => rmSync(output, { recursive: true, force: true }))
const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', output, join(root, 'src/board3d-camera.ts')], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
renameSync(join(output, 'board3d-camera.js'), join(output, 'board3d-camera.mjs'))
const { boardCameraFitZoom } = await import(pathToFileURL(join(output, 'board3d-camera.mjs')).href)

function cameraFor(width, height, columns, rows, heightRange) {
  const camera = new OrthographicCamera(-7 * width / height, 7 * width / height, 7, -7, .1, 500)
  const targetY = heightRange ? (heightRange.min + heightRange.max + 2) / 2 : 0
  const target = new Vector3(columns / 2, targetY, rows / 2)
  camera.position.copy(target).add(new Vector3(10, 17, 13))
  camera.lookAt(target)
  camera.updateProjectionMatrix()
  const bounds = { minX: 0, minY: 0, maxX: columns - 1, maxY: rows - 1 }
  camera.zoom = heightRange
    ? boardCameraFitZoom(camera, bounds, width, height, heightRange)
    : boardCameraFitZoom(camera, bounds, width, height)
  camera.updateProjectionMatrix()
  return camera
}

test('Вся карта вмещает границы и высоту фигурок, включая карту 100×100', () => {
  for (const [width, height, columns, rows] of [[1280, 720, 12, 8], [480, 800, 30, 15], [1280, 720, 100, 100], [2560, 800, 100, 20]]) {
    const camera = cameraFor(width, height, columns, rows)
    for (const x of [0, columns]) for (const z of [0, rows]) for (const y of [0, 2]) {
      const point = new Vector3(x, y, z).project(camera)
      assert.ok(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1, `${columns}×${rows} не помещается в ${width}×${height}`)
    }
  }
})

test('широкое окно использует дополнительное место для длинной карты', () => {
  assert.ok(cameraFor(1920, 600, 20, 4).zoom > cameraFor(500, 900, 20, 4).zoom)
})

test('диапазон высот вмещает положительную и отрицательную местность', () => {
  for (const [width, height, columns, rows, heightRange] of [
    [1280, 720, 12, 8, { min: -6, max: 8 }],
    [480, 800, 30, 15, { min: -18, max: 3 }],
    [1280, 720, 100, 100, { min: 2, max: 24 }],
  ]) {
    const camera = cameraFor(width, height, columns, rows, heightRange)
    for (const x of [0, columns]) for (const z of [0, rows]) for (const y of [heightRange.min, heightRange.max + 2]) {
      const point = new Vector3(x, y, z).project(camera)
      assert.ok(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1, `${columns}×${rows} с высотами ${heightRange.min}…${heightRange.max} не помещается`)
    }
  }
})

test('портретное окно вмещает широкий рельеф с высотой фигурки', () => {
  const bounds = { minX: 0, minY: 0, maxX: 39, maxY: 5 }
  const heightRange = { min: -4, max: 16 }
  const camera = new OrthographicCamera(-7 * 360 / 960, 7 * 360 / 960, 7, -7, .1, 500)
  const target = new Vector3(20, (heightRange.min + heightRange.max + 2) / 2, 3)
  camera.position.copy(target).add(new Vector3(10, 17, 13))
  camera.lookAt(target)
  camera.updateProjectionMatrix()
  camera.zoom = boardCameraFitZoom(camera, bounds, 360, 960, heightRange)
  camera.updateProjectionMatrix()
  for (const x of [bounds.minX, bounds.maxX + 1]) for (const z of [bounds.minY, bounds.maxY + 1]) for (const y of [heightRange.min, heightRange.max + 2]) {
    const point = new Vector3(x, y, z).project(camera)
    assert.ok(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1, `широкий рельеф вышел за край портретного окна: ${point.x},${point.y}`)
  }
})

test('явный диапазон 0…0 сохраняет четырёхаргументный fit', () => {
  const bounds = { minX: 0, minY: 0, maxX: 11, maxY: 7 }
  const make = () => {
    const camera = new OrthographicCamera(-7 * 1280 / 720, 7 * 1280 / 720, 7, -7, .1, 500)
    const target = new Vector3(6, 0, 4)
    camera.position.copy(target).add(new Vector3(10, 17, 13))
    camera.lookAt(target)
    camera.updateProjectionMatrix()
    return camera
  }
  const legacy = make()
  const explicit = make()
  assert.equal(
    boardCameraFitZoom(legacy, bounds, 1280, 720),
    boardCameraFitZoom(explicit, bounds, 1280, 720, { min: 0, max: 0 }),
  )
})
