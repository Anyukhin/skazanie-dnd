import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

// Сборка внутри tmp видит установленный three; игровые данные не используются.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(repositoryRoot, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(repositoryRoot, 'tmp', 'board3d-effects-'))
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
