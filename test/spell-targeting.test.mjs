import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createTacticalMap, serializeTacticalMap, setCell, setDoor, setEdge } from '../server/tactical-map.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'skazanie-spell-targeting-'))
mkdirSync(join(temporary, 'src'))
mkdirSync(join(temporary, 'server'))
copyFileSync(new URL('../server/actor-footprint.mjs', import.meta.url), join(temporary, 'server/actor-footprint.mjs'))
process.on('exit', () => rmSync(temporary, { recursive: true, force: true }))
const modules = ['spell-targeting', 'tactical-ui', 'tactical-map-client', 'area-geometry']
// Типы проверяет общий build; здесь исполняются реальные модули без React/DOM.
const compiled = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
  '--ignoreConfig', '--noCheck', '--noResolve', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--outDir', join(temporary, 'src'), ...modules.map((name) => fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)))], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr)
for (const name of modules) {
  const output = readFileSync(join(temporary, 'src', `${name}.js`), 'utf8')
  writeFileSync(join(temporary, 'src', `${name}.mjs`), output.replace(/from '(\.\/[^']+)'/gu, "from '$1.mjs'"))
}
const { maskSpellAreaCells, spellPreviewActors, createSpellTargetRenderer } = await import(pathToFileURL(join(temporary, 'src/spell-targeting.mjs')))
const { decodeTacticalMap } = await import(pathToFileURL(join(temporary, 'src/tactical-map-client.mjs')))

function fixture() {
  const raw = createTacticalMap({ width: 8, height: 8, fill: { passable: true, revealed: true } })
  setCell(raw, 5, 5, { revealed: false })
  return decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(raw))))
}

test('предпросмотр учитывает союзников и край крупной фигуры, не раскрывая скрытые и выбывшие цели', () => {
  const map = fixture()
  const actors = [
    { id: 'ally', kind: 'hero', x: 1, y: 1 },
    { id: 'large', kind: 'enemy', x: 2, y: 2, footprint: { version: 1, size: 2 } },
    { id: 'hidden', kind: 'enemy', x: 5, y: 5 },
    { id: 'dead', kind: 'enemy', x: 1, y: 1, defeated: true },
  ]
  assert.deepEqual(spellPreviewActors(map, new Set(['1,1', '3,3', '5,5']), actors).map((actor) => actor.id), ['ally', 'large'])
  assert.deepEqual(spellPreviewActors(null, new Set(['1,1']), actors), [])
})

test('частично скрытая крупная фигура не расширяет предпросмотр за видимый anchor', () => {
  const actor = { id: 'large', kind: 'enemy', x: 4, y: 4, footprint: { version: 1, size: 2 } }
  assert.equal(spellPreviewActors(fixture(), new Set(['5,4']), [actor]).length, 0)
  assert.equal(spellPreviewActors(fixture(), new Set(['4,4']), [actor]).length, 1)
})

function loeMap() {
  const raw = createTacticalMap({ width: 10, height: 8, locationId: 'area-loe-client', fill: { passable: true, revealed: true, material: 'stone' } })
  return raw
}

const point = (x, y) => ({ x, y })

test('client LoE маскирует стену, закрытую дверь и диагональный закрытый угол', () => {
  const wall = loeMap()
  setCell(wall, 4, 2, { type: 'wall', passable: false })
  assert.deepEqual([...maskSpellAreaCells(
    decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(wall)))),
    [point(7, 2)], { origins: [point(1, 2)] },
  )], [], 'стена блокирует generic область')

  const door = loeMap()
  setDoor(door, { id: 'closed', x: 4, y: 2, dir: 'e', state: 'closed', blocksMove: true, blocksSight: true })
  assert.deepEqual([...maskSpellAreaCells(
    decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(door)))),
    [point(7, 2)], { origins: [point(1, 2)] },
  )], [], 'закрытая дверь блокирует generic область')

  const corner = loeMap()
  setDoor(corner, { id: 'corner-east', x: 4, y: 4, dir: 'e', state: 'closed', blocksMove: true, blocksSight: true })
  setDoor(corner, { id: 'corner-south', x: 4, y: 4, dir: 's', state: 'closed', blocksMove: true, blocksSight: true })
  assert.deepEqual([...maskSpellAreaCells(
    decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(corner)))),
    [point(6, 6)], { origins: [point(3, 3)] },
  )], [], 'диагональ не проходит сквозь закрытый угол')
})

test('client LoE mirrors corner wrapping, sealed room and large footprint', () => {
  const around = loeMap()
  setCell(around, 6, 2, { type: 'wall', passable: false })
  const openMap = decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(around))))
  const target = [point(7, 2)]
  assert.deepEqual([...maskSpellAreaCells(openMap, target, { origins: [point(1, 2)] })], [], 'generic effect stops at wall')
  assert.deepEqual([...maskSpellAreaCells(openMap, target, { origins: [point(1, 2)], spreadsAroundCorners: true, radiusFeet: 60 })], ['7,2'], 'corner-wrapping reaches open target')

  const sealed = loeMap()
  for (const [x, y] of [[6, 2], [7, 1], [7, 3], [8, 2]]) setCell(sealed, x, y, { type: 'wall', passable: false })
  const sealedMap = decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(sealed))))
  assert.deepEqual([...maskSpellAreaCells(sealedMap, target, { origins: [point(1, 2)], spreadsAroundCorners: true, radiusFeet: 60 })], [], 'corner-wrapping cannot enter sealed room')

  const large = loeMap()
  setCell(large, 1, 1, { type: 'wall', passable: false })
  setCell(large, 0, 1, { type: 'wall', passable: false })
  setCell(large, 0, 2, { type: 'wall', passable: false })
  const largeMap = decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(large))))
  const footprint = () => [point(1, 2), point(2, 2), point(1, 3), point(2, 3)]
  assert.deepEqual([...maskSpellAreaCells(largeMap, [point(1, 2)], { origins: [point(0, 0)], radiusFeet: 20, targetCells: footprint })], [], 'large target footprint keeps blocked cells from rescuing LoE')
})

test('corner flood respects sight-only edge and footprint intersection with original area', () => {
  const sightOnly = loeMap()
  for (let y = 0; y < 8; y += 1) setEdge(sightOnly, 3, y, 4, y, { kind: 'wall', blocksMove: false, blocksSight: true })
  const sightMap = decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(sightOnly))))
  assert.deepEqual([...maskSpellAreaCells(sightMap, [point(6, 2)], {
    origins: [point(1, 2)], spreadsAroundCorners: true, radiusFeet: 60,
  })], [], 'blocksSight blocks corner flood even when movement is allowed')

  const footprintMap = loeMap()
  setCell(footprintMap, 0, 1, { type: 'wall', passable: false })
  const open = decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(footprintMap))))
  assert.deepEqual([...maskSpellAreaCells(open, [point(1, 2)], {
    origins: [point(0, 0)], radiusFeet: 20,
    targetCells: () => [point(1, 2), point(2, 2)],
  })], ['1,2'], 'footprint cells outside original area cannot rescue LoE')
})

test('контур объединяет соседние клетки, обрезает туман и явно помечает недопустимую точку', () => {
  const fills = [], paths = [], styles = []
  let path = []
  const context = {
    save() {}, restore() {}, clip() {}, rect() {}, setLineDash() {},
    beginPath() { path = [] },
    moveTo(x, y) { path.push(['move', x, y]) },
    lineTo(x, y) { path.push(['line', x, y]) },
    arc() {},
    fillRect(...args) { fills.push(args) },
    stroke() { paths.push(path); styles.push(this.strokeStyle) },
  }
  createSpellTargetRenderer({ cells: new Set(['1,1', '2,1', '5,5']), origin: { x: 0, y: 1 }, target: { x: 1, y: 1 }, color: '#f2a15c', blocked: true })(context, { map: fixture(), cellSize: 10 })
  assert.deepEqual(fills, [[10, 10, 10, 10], [20, 10, 10, 10]])
  assert.equal(paths[0].length, 12, 'у двух соседних клеток шесть наружных рёбер')
  assert.equal(styles[1], '#ed7771')
  assert.equal(styles.at(-1), '#ed7771')
})

test('прицел применяется кликом по карте без отдельной панели и защищён от повторной отправки', () => {
  const source = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /spell-aim-panel|kind: 'spell-point'/u)
  assert.match(source, /if \(pointSpellReason\(\{ x, y \}\)\) return[\s\S]*if \(selectTargetsInAreaSpell\) \{[\s\S]*if \(!areaSpellPoint\) \{[\s\S]*setAreaSpellPoint\(\{ x, y \}\)[\s\S]*\}\s+return\s+\}\s+void issueSpell\(\{ x, y \}\)/u)
  const issue = source.slice(source.indexOf('const issueSpell ='), source.indexOf('const castAtTarget ='))
  assert.match(issue, /spellCommandInFlight\.current\) return/u)
  assert.ok(issue.indexOf('spellCommandInFlight.current = true') < issue.indexOf('await onCastSpell'))
  assert.match(issue, /if \(outcome\.ok\) \{[\s\S]*setCombatMode\('weapon'\)/u)
  assert.match(issue, /finally \{\s+spellCommandInFlight\.current = false/u)
  assert.match(source, /onCancelAiming=\{spellAiming \? clearPrepared : undefined\}/u)
  assert.match(source, /combatMode !== 'magic' && inspectedTarget && inspectedAnchor/u)
})
