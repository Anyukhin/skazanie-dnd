import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-area-geometry-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const source = fileURLToPath(new URL('../src/area-geometry.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext',
  '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', buildDir, source,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
renameSync(join(buildDir, 'area-geometry.js'), join(buildDir, 'area-geometry.mjs'))
const geometry = await import(pathToFileURL(join(buildDir, 'area-geometry.mjs')).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

const keys = (cells) => cells.map((cell) => `${cell.x},${cell.y}`)

test('сфера и цилиндр используют клеточный радиус и обрезаются границами карты', () => {
  const sphere = geometry.areaCells({
    shape: 'sphere',
    origin: { x: 0, y: 0 },
    target: { x: 1, y: 1 },
    sizeFeet: 5,
    bounds: { minX: 0, minY: 0, maxX: 3, maxY: 3 },
  })
  assert.deepEqual(keys(sphere), [
    '0,0', '1,0', '2,0',
    '0,1', '1,1', '2,1',
    '0,2', '1,2', '2,2',
  ])
  assert.deepEqual(
    geometry.areaCells({ shape: 'cylinder', origin: { x: 2, y: 2 }, sizeFeet: 0 }),
    [],
    'нулевая область не должна подсвечивать клетку и создавать ложную цель',
  )
  assert.deepEqual(
    keys(geometry.areaCells({ shape: 'sphere', origin: { x: 2, y: 2 }, target: { x: 3, y: 3 }, sizeFeet: 2 })),
    ['3,3'],
    'положительная область меньше клетки всё равно задевает выбранную клетку, как сервер',
  )
})

test('конус совпадает с серверным углом и не включает заклинателя', () => {
  const cone = geometry.areaCells({
    shape: 'cone',
    origin: { x: 2, y: 2 },
    target: { x: 5, y: 2 },
    sizeFeet: 15,
  })
  assert.equal(keys(cone).includes('2,2'), false)
  assert.deepEqual(keys(cone), ['4,1', '5,1', '3,2', '4,2', '5,2', '4,3', '5,3'])

  const diagonal = geometry.areaCells({
    shape: 'cone',
    origin: { x: 0, y: 0 },
    target: { x: 2, y: 2 },
    sizeFeet: 10,
  })
  assert.ok(keys(diagonal).includes('1,1'))
  assert.equal(keys(diagonal).includes('-1,1'), false, 'клетка позади направления не входит')
})

test('направленный куб имеет заданное ребро, а линия идёт к цели стабильными шагами', () => {
  assert.deepEqual(keys(geometry.areaCells({
    shape: 'cube',
    origin: { x: 2, y: 2 },
    target: { x: 6, y: 2 },
    originMode: 'self',
    sizeFeet: 15,
  })), [
    '3,1', '4,1', '5,1',
    '3,2', '4,2', '5,2',
    '3,3', '4,3', '5,3',
  ])
  assert.deepEqual(keys(geometry.areaCells({
    shape: 'line',
    origin: { x: 1, y: 1 },
    target: { x: 5, y: 4 },
    sizeFeet: 15,
  })), ['2,2', '3,3', '4,4'])
  assert.deepEqual(
    geometry.areaCells({ shape: 'line', origin: { x: 1, y: 1 }, target: { x: 1, y: 1 }, sizeFeet: 30 }),
    [],
    'линия без направления не должна создавать область',
  )
})

test('point-cube трактует размер как серверный Chebyshev-радиус', () => {
  assert.deepEqual(keys(geometry.areaCells({
    shape: 'cube',
    origin: { x: 0, y: 0 },
    target: { x: 4, y: 4 },
    originMode: 'point',
    sizeFeet: 5,
  })), [
    '3,3', '4,3', '5,3',
    '3,4', '4,4', '5,4',
    '3,5', '4,5', '5,5',
  ])
  assert.deepEqual(keys(geometry.areaCells({
    shape: 'cube',
    origin: { x: 0, y: 0 },
    target: { x: 4, y: 4 },
    originMode: 'point',
    sizeFeet: 10,
  })), [
    '2,2', '3,2', '4,2', '5,2', '6,2',
    '2,3', '3,3', '4,3', '5,3', '6,3',
    '2,4', '3,4', '4,4', '5,4', '6,4',
    '2,5', '3,5', '4,5', '5,5', '6,5',
    '2,6', '3,6', '4,6', '5,6', '6,6',
  ])
})

test('self-cube трактует размер как направленное ребро', () => {
  assert.deepEqual(keys(geometry.areaCells({
    shape: 'cube',
    origin: { x: 2, y: 2 },
    target: { x: 6, y: 2 },
    originMode: 'self',
    sizeFeet: 15,
  })), [
    '3,1', '4,1', '5,1',
    '3,2', '4,2', '5,2',
    '3,3', '4,3', '5,3',
  ])
  assert.deepEqual(
    geometry.areaCells({ shape: 'cube', origin: { x: 2, y: 2 }, originMode: 'self', sizeFeet: 15 }),
    [],
    'self-cube без направления не должен подсвечивать область',
  )
})

test('предпросмотр возвращает и врагов, и союзников, но не выбывших', () => {
  const cells = geometry.areaCells({
    shape: 'sphere',
    origin: { x: 2, y: 2 },
    sizeFeet: 5,
  })
  const affected = geometry.affectedAreaActors(cells, [
    { id: 'caster', team: 'ally', x: 2, y: 2 },
    { id: 'friend', team: 'ally', x: 3, y: 2 },
    { id: 'enemy', team: 'enemy', x: 2, y: 3 },
    { id: 'fallen', team: 'enemy', x: 1, y: 2, alive: false },
    { id: 'far', team: 'enemy', x: 7, y: 7 },
  ])
  assert.deepEqual(affected.map((actor) => actor.id), ['caster', 'friend', 'enemy'])
})
