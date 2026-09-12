import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

// Сборка внутри tmp видит установленный three; игровые данные не используются.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(repositoryRoot, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(repositoryRoot, 'tmp', 'board3d-effects-'))
mkdirSync(join(buildDir, 'server'), { recursive: true })
copyFileSync(join(repositoryRoot, 'server', 'actor-footprint.mjs'), join(buildDir, 'server', 'actor-footprint.mjs'))
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))
const compiled = spawnSync(process.execPath, [
  join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--resolveJsonModule', '--esModuleInterop',
  '--rootDir', repositoryRoot, '--outDir', buildDir, join(repositoryRoot, 'src/board3d-effects.ts'),
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
function emittedFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? emittedFiles(path) : [path]
  })
}
for (const path of emittedFiles(buildDir).filter((candidate) => candidate.endsWith('.js'))) {
  const rewritten = readFileSync(path, 'utf8')
    .replace(/(from\s+["'])(\.\.?\/[^"']+\.json)(["'])/gu, '$1$2$3 with { type: "json" }')
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) => /\.(json|mjs|js)$/u.test(specifier) ? match : `${before}${specifier}.mjs${after}`)
  writeFileSync(path, rewritten)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}
const { createCombatEffect3D } = await import(pathToFileURL(join(buildDir, 'src/board3d-effects.mjs')).href)
const { spellBurstCells } = await import(pathToFileURL(join(buildDir, 'src/spell-effects.mjs')).href)
const { decodeTacticalMap, revealedAt } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
function map(hidden = []) {
  const value = createTacticalMap({ width: 8, height: 5, locationId: 'effects-test', fill: { passable: true, revealed: true, material: 'stone' } })
  hidden.forEach(({ x, y }) => setCell(value, x, y, { revealed: false }))
  return decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(value))))
}
const actors = [{ id: 'mage', x: 1, y: 2 }, { id: 'target', x: 6, y: 2 }]
const projectile = { id: 'spell-confirmed', kind: 'projectile', actorId: 'mage', targetIds: ['target'], spellId: 'fire-bolt', school: 'evocation', projectileCount: 2, durationMs: 500 }

test('3D ranged strike летит физической стрелой по event trajectory', () => {
  const cue = {
    id: 'attack-bow', kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5,
    attackKind: 'ranged', equipment: 'bow', from: { x: 0, y: 0 }, to: { x: 5, y: 3 }, durationMs: 480, detail: 'full',
  }
  // Позиции участников намеренно не совпадают с событием: cue обязан вести
  // стрелу по замороженной траектории, а не по текущему снимку актёров.
  const effect = createCombatEffect3D(cue, [{ id: 'mage', x: 7, y: 4 }, { id: 'target', x: 1, y: 4 }], map())
  const arrow = effect.group.children.find((child) => child.type === 'Group')
  assert.ok(arrow)
  assert.equal(arrow.children.length, 2, 'стрела состоит из древка и наконечника, а не из melee beam-сегментов')
  effect.update(.36)
  assert.ok(arrow.visible)
  assert.ok(arrow.position.x > 1 && arrow.position.x < 5, 'стрела должна быть между концами trajectory')
  effect.update(.73)
  assert.equal(arrow.visible, false, 'к моменту impact стрела уже прилетела')
  effect.dispose()
})

test('3D thrown strike создаёт физический снаряд, а не луч', () => {
  const cue = {
    id: 'attack-thrown', kind: 'strike', actorId: 'mage', targetId: 'target', hit: false, amount: 0,
    attackKind: 'thrown', equipment: 'dagger', from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480, detail: 'reduced',
  }
  const effect = createCombatEffect3D(cue, actors, map())
  const projectileMesh = effect.group.children.find((child) => child.type === 'Group')
  assert.ok(projectileMesh)
  assert.equal(projectileMesh.children.length, 1)
  effect.update(.35)
  assert.ok(projectileMesh.visible)
  effect.dispose()
})

test('3D physical strike не выпускается по скрытой траектории', () => {
  const cue = {
    id: 'attack-hidden', kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5,
    attackKind: 'ranged', equipment: 'bow', from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480,
  }
  const effect = createCombatEffect3D(cue, actors, map([{ x: 3, y: 2 }]))
  assert.equal(effect.group.children.length, 0)
  effect.dispose()
})

test('3D combat center использует центр footprint, но возвращается к anchor в тумане', () => {
  const largeActors = [
    { id: 'mage', x: 1, y: 1, footprint: { version: 1, size: 2 } },
    { id: 'target', x: 5, y: 1, footprint: { version: 1, size: 2 } },
  ]
  const cue = {
    id: 'large-arrow', kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5,
    attackKind: 'ranged', equipment: 'bow', from: { x: 1, y: 1 }, to: { x: 5, y: 1 }, durationMs: 480, detail: 'full',
  }
  const full = createCombatEffect3D(cue, largeActors, map())
  const fullArrow = full.group.children.find((child) => child.type === 'Group')
  assert.ok(fullArrow)
  full.update(0)
  assert.equal(fullArrow.position.x, 2, 'полный footprint начинается из центра большой клетки')
  assert.equal(fullArrow.position.z, 2, 'полный footprint центрируется по Z')
  full.dispose()

  const partialBoard = map([{ x: 2, y: 1 }])
  const partial = createCombatEffect3D(cue, largeActors, partialBoard)
  assert.equal(partial.group.children.length, 0, 'скрытая часть footprint блокирует физическую траекторию')
  partial.dispose()
})

test('cue.detail и внешний более строгий detail уменьшают sparks и beam segments', () => {
  const base = { id: 'detail-strike', kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5, attackKind: 'melee', from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480 }
  const full = createCombatEffect3D({ ...base, detail: 'full' }, actors, map())
  const reduced = createCombatEffect3D({ ...base, detail: 'reduced' }, actors, map())
  const minimal = createCombatEffect3D({ ...base, detail: 'full' }, actors, map(), 'minimal')
  assert.ok(full.group.children.length > reduced.group.children.length)
  assert.ok(reduced.group.children.length > minimal.group.children.length)
  full.dispose(); reduced.dispose(); minimal.dispose()
})

test('3D-снаряды не рисуют скрытую цель и скрытые участки траектории', () => {
  const hiddenTarget = createCombatEffect3D(projectile, actors, map([{ x: 6, y: 2 }]))
  assert.equal(hiddenTarget.group.children.length, 0)
  hiddenTarget.dispose()
  const board = map([{ x: 3, y: 2 }, { x: 4, y: 2 }])
  const effect = createCombatEffect3D(projectile, actors, board)
  assert.ok(effect.group.children.length > 0)
  for (let progress = 0; progress <= 1; progress += .025) {
    effect.update(progress)
    for (const mesh of effect.group.children.filter((child) => child.visible)) assert.ok(revealedAt(board, Math.floor(mesh.position.x), Math.floor(mesh.position.z)))
  }
  effect.dispose()
})

test('3D-эффект использует переданные события без изменения карты и участников', () => {
  const board = map()
  const before = JSON.stringify({ board, actors, projectile })
  const effect = createCombatEffect3D(projectile, actors, board)
  effect.update(.25); effect.update(.7)
  assert.equal(JSON.stringify({ board, actors, projectile }), before)
  const resources = new Set(effect.group.children.flatMap((mesh) => [mesh.geometry, mesh.material]))
  let disposed = 0
  resources.forEach((resource) => resource.addEventListener('dispose', () => disposed++))
  effect.dispose()
  assert.equal(disposed, resources.size)
})

test('объёмный взрыв следует тем же клеткам сферы, конуса, куба и линии, что и 2D', () => {
  const board = map()
  for (const shape of ['sphere', 'cone', 'cube', 'line']) {
    const cue = { id: 'area-' + shape, kind: 'burst', actorId: 'mage', targetIds: ['target'], school: 'evocation', spellId: 'burning-hands', shape, originMode: 'self', sizeFeet: 10, durationMs: 500 }
    const expected = new Set(spellBurstCells(board, cue, actors).map((cell) => `${cell.x},${cell.y}`))
    assert.ok(expected.size > 0)
    const effect = createCombatEffect3D(cue, actors, board)
    effect.update(.65)
    const visible = effect.group.children.filter((mesh) => mesh.visible)
    assert.ok(visible.length > 0, `${shape}: не нарисован эффект`)
    for (const mesh of visible) assert.ok(expected.has(`${Math.floor(mesh.position.x)},${Math.floor(mesh.position.z)}`), `${shape}: частица за пределами области 2D`)
    effect.dispose()
  }
})
