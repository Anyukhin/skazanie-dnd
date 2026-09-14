import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { addProp, createTacticalMap, deserializeTacticalMap, serializeTacticalMap, setCell, setEdge } from '../server/tactical-map.mjs'
import { attachPropSupports } from '../server/prop-placement.mjs'
import { publicTacticalMapFor } from '../server/viewer-projection.mjs'
import { buildThemedScene } from '../server/scene-themes.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const compiledDir = mkdtempSync(join(root, 'tmp', 'prop-supports-'))
test.after(() => rmSync(compiledDir, { recursive: true, force: true }))
const compiler = join(root, 'node_modules/typescript/bin/tsc')
const compile = spawnSync(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext',
  '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', compiledDir,
  join(root, 'src/board3d-scene.ts')], { encoding: 'utf8' })
assert.equal(compile.status, 0, compile.stderr || compile.stdout)
for (const name of readdirSync(compiledDir).filter((name) => name.endsWith('.js'))) {
  const file = join(compiledDir, name)
  writeFileSync(file.replace(/\.js$/u, '.mjs'), readFileSync(file, 'utf8').replace(/(from\s+["'])(\.\/[^"']+)(["'])/gu, '$1$2.mjs$3'))
  rmSync(file)
}
const client = await import(pathToFileURL(join(compiledDir, 'tactical-map-client.mjs')).href)
const render = await import(pathToFileURL(join(compiledDir, 'board-render.mjs')).href)
const scene3d = await import(pathToFileURL(join(compiledDir, 'board3d-scene.mjs')).href)

function fixture() {
  const map = createTacticalMap({ width: 6, height: 6, seed: 'supports', catalogRevision: null })
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) setCell(map, x, y, { passable: true, revealed: true, elevation: 5 })
  const table = addProp(map, { id: 'table', assetId: 'table_round', x: 2.5, y: 2.5, scale: 1.1,
    footprint: [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }], blocksMove: true })
  addProp(map, { id: 'mug', assetId: 'mug', x: 2.5, y: 2.5 })
  addProp(map, { id: 'plate', assetId: 'plate', x: 2.5, y: 2.5 })
  addProp(map, { id: 'candle', assetId: 'candle', x: 2.5, y: 2.5 })
  addProp(map, { id: 'lantern', assetId: 'lantern_wall', x: 2.5, y: 1.5, rotation: 180 })
  setEdge(map, 2, 1, 2, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
  return { map, table }
}

test('утварь получает опору без новой игровой площади, roundtrip сохраняет связь', () => {
  const { map, table } = fixture()
  const passable = map.layers.passable.slice(), footprint = structuredClone(table.footprint)
  attachPropSupports(map)
  const mounted = map.props.filter((prop) => prop.mount?.kind === 'surface')
  assert.equal(mounted.length, 3)
  assert.equal(new Set(mounted.map((prop) => `${prop.x},${prop.y}`)).size, 3)
  for (const prop of mounted) {
    assert.deepEqual(prop.mount, { kind: 'surface', propId: table.id })
    assert.equal(prop.footprint.length, 0)
    assert.equal(prop.blocksMove, false)
    assert.ok(prop.zOrder > table.zOrder)
    assert.ok(table.footprint.some((cell) => cell.x === Math.floor(prop.x) && cell.y === Math.floor(prop.y)))
  }
  assert.deepEqual(map.layers.passable, passable)
  assert.deepEqual(table.footprint, footprint)
  const stored = serializeTacticalMap(map)
  assert.deepEqual(serializeTacticalMap(deserializeTacticalMap(stored)), stored)
  assert.deepEqual(client.decodeTacticalMap(stored).props.find((prop) => prop.id === 'mug').mount, mounted[0].mount)
  attachPropSupports(map)
  assert.deepEqual(serializeTacticalMap(map), stored, 'повтор не сдвигает уже закреплённую утварь')
})

test('утварь остаётся над уменьшенной столешницей после сохранения', () => {
  const { map, table } = fixture()
  table.scale = .5
  attachPropSupports(map)
  const loaded = deserializeTacticalMap(serializeTacticalMap(map))
  for (const prop of loaded.props.filter((prop) => prop.mount?.kind === 'surface')) {
    assert.ok(Math.abs(prop.x - 3) <= .25 && Math.abs(prop.y - 3) <= .25)
    assert.equal(prop.mount.propId, table.id)
  }
  assert.equal(loaded.props.find((prop) => prop.id === table.id).scale, .5)
})

test('скрытая опора скрывает утварь в проекции и обоих рендерах', () => {
  const { map } = fixture()
  attachPropSupports(map)
  setCell(map, 3, 3, { revealed: false })
  const publicMap = publicTacticalMapFor(serializeTacticalMap(map))
  assert.ok(publicMap)
  assert.equal(publicMap.props.some((prop) => prop.id === 'table' || prop.mount?.kind === 'surface'), false)
  const decoded = client.decodeTacticalMap(serializeTacticalMap(map))
  assert.equal(render.visiblePropsOnBoard(decoded).some((prop) => prop.mount?.kind === 'surface'), false)
  const scene = scene3d.createBoard3DScene(decoded)
  try { assert.equal(scene.group.getObjectByName('prop:mug'), undefined) } finally { scene.dispose() }
})

test('3D ставит кружку на поверхность с высотой пола и опускает при поломке', () => {
  const { map, table } = fixture()
  attachPropSupports(map)
  const before = serializeTacticalMap(map)
  const scene = scene3d.createBoard3DScene(client.decodeTacticalMap(before))
  try {
    assert.ok(Math.abs(scene.group.getObjectByName('prop:mug').position.y - (1 + .73 * table.scale)) < 1e-6)
    const lantern = map.props.find((prop) => prop.id === 'lantern')
    assert.deepEqual(lantern.mount, { kind: 'wall', side: 'n' })
    const layout = render.propVisualLayout(lantern)
    const model = scene.group.getObjectByName('prop:lantern')
    assert.equal(model.position.x, layout.x)
    assert.equal(model.position.z, layout.y)
    assert.equal(layout.y, 1.1)
  } finally { scene.dispose() }
  assert.deepEqual(serializeTacticalMap(map), before, 'рендер не меняет исходную карту')
  table.state = 'broken'
  const broken = scene3d.createBoard3DScene(client.decodeTacticalMap(serializeTacticalMap(map)))
  try { assert.equal(broken.group.getObjectByName('prop:mug').position.y, 1) } finally { broken.dispose() }
})

test('обычные генераторы таверны и склепа воспроизводят опоры на нескольких seed', () => {
  let surfaces = 0, walls = 0
  for (const themeId of ['building', 'crypt']) for (const seed of ['interior-a', 'interior-b', 'interior-c']) {
    const input = { themeId, seed, locationId: `supports-${themeId}`, width: 26, height: 26 }
    const first = buildThemedScene(input).map, second = buildThemedScene(input).map
    assert.deepEqual(serializeTacticalMap(first), serializeTacticalMap(second))
    for (const prop of first.props) {
      if (prop.mount?.kind === 'surface') {
        surfaces++
        assert.ok(first.props.some((support) => support.id === prop.mount.propId))
        assert.equal(prop.blocksMove, false)
      } else if (prop.mount?.kind === 'wall') walls++
    }
  }
  assert.ok(surfaces > 0 && walls > 0, 'приёмка должна пройти настоящие опоры и крепления генератора')
})
