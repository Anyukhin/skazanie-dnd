import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listAssets } from '../server/asset-registry.mjs'
import { AUTHORED_MODELS } from '../tools/build-interior-models.mjs'
import {
  ENVIRONMENT_PACKS, SUPERSEDED_AUTHORED_KEYS, muteGraveyardColor, packModelKey,
} from '../tools/environment-packs.mjs'
import { KENNEY_SELECTION, convertPackModel, inspectModelFile } from '../tools/import-environment-models.mjs'
import { decodePng } from '../tools/png-codec.mjs'

const root = new URL('../', import.meta.url)
const assets = new Map(listAssets().map((asset) => [asset.id, asset]))
const packsRoot = join(process.cwd(), 'tmp/asset-src')
const work = await mkdtemp(join(tmpdir(), 'environment-packs-'))
test.after(() => rm(work, { recursive: true, force: true }))

/** Хеши архивов из tmp/asset-src/SOURCES.md: другой архив останавливает импорт. */
const PINNED = {
  nature: '298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9',
  kaykit: 'e96a65ce4040b6b630f04470a60fd523d621c124cfbad062809cf7b94ccf714b',
  graveyard: '1a93613f2e5675f3310acf49ec9ef13ae7adeb756ac3b205bfb6cc9311a81062',
}

test('наборы дают только варианты существующих видов и закрепляют хеши архивов', () => {
  const keys = new Set()
  for (const pack of ENVIRONMENT_PACKS) {
    assert.equal(pack.source.archiveSha256, PINNED[pack.id], `${pack.id}: хеш архива`)
    assert.equal(pack.source.license, 'CC0-1.0')
    assert.ok(pack.selection.length > 0)
    for (const model of pack.selection) {
      const key = packModelKey(pack, model)
      assert.ok(!keys.has(key), `${key}: ключ уникален`)
      keys.add(key)
      assert.ok(model.assetIds.length > 0, `${key}: модель привязана к виду`)
      for (const id of model.assetIds) assert.ok(assets.has(id), `${key}: ${id} есть в реестре`)
    }
  }
})

test('лес и подземелье больше не смешивают гранёный Kenney с текстурированными наборами', () => {
  const nature = ENVIRONMENT_PACKS.find((pack) => pack.id === 'nature')
  const replaced = ['tree_oak', 'tree_birch', 'tree_pine', 'tree_spruce', 'bush', 'shrub', 'grass_tuft', 'flowers', 'mushroom_cluster', 'boulder', 'rock_small']
  for (const id of replaced) {
    assert.ok(nature.selection.some((model) => model.assetIds.includes(id)), `${id}: есть вариант Stylized Nature`)
    assert.ok(!KENNEY_SELECTION.some(([, , , ids]) => ids.includes(id)), `${id}: вариант Kenney Nature снят`)
  }
  assert.ok(nature.selection.some((model) => model.assetIds.includes('fern')), 'папоротник получил объёмную модель')
})

test('вытесненная собственная модель существует и её вид покрыт набором', () => {
  const authored = new Map(AUTHORED_MODELS.map((item) => [item.key, item.assetId]))
  for (const key of SUPERSEDED_AUTHORED_KEYS) {
    assert.ok(authored.has(key), `${key}: есть среди собственных моделей`)
    const assetId = authored.get(key)
    assert.ok(ENVIRONMENT_PACKS.some((pack) => pack.selection.some((model) => model.assetIds.includes(assetId))), `${assetId}: покрыт набором`)
  }
})

test('палитра Graveyard приглушает мультяшные цвета и не трогает прозрачность', () => {
  const saturation = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255
  const lavender = muteGraveyardColor(160, 168, 201)
  assert.ok(saturation(lavender) < 0.06, `сиреневый камень стал серым: ${lavender}`)
  assert.ok(lavender[0] >= lavender[2], 'серый камня тёплый, а не холодный')
  const mint = muteGraveyardColor(97, 203, 139)
  assert.ok(Math.max(...mint) < 90, `мятный металл потемнел: ${mint}`)
  const orange = muteGraveyardColor(255, 126, 68)
  assert.ok(saturation(orange) < saturation([255, 126, 68]) && Math.max(...orange) < 180, `оранжевое дерево приглушено: ${orange}`)
  assert.deepEqual(muteGraveyardColor(0, 0, 0), [0, 0, 0])
})

const pack = (id) => ENVIRONMENT_PACKS.find((item) => item.id === id)
const sourceDir = (id) => join(packsRoot, pack(id).directoryPath)
const model = (id, file) => pack(id).selection.find((item) => item.file === file && !item.parts)
  ?? pack(id).selection.find((item) => item.file === file)

function imageSides(file) {
  const bytes = readFileSync(file)
  const jsonLength = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'))
  const binary = bytes.subarray(20 + jsonLength + 8)
  return (json.images ?? []).map((image) => {
    const view = json.bufferViews[image.bufferView]
    const png = decodePng(binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength))
    return { name: image.name, side: Math.max(png.width, png.height) }
  })
}

test('модели наборов становятся самодостаточными GLB с точными границами и осью крышки', {
  skip: !existsSync(join(sourceDir('nature'), 'Fern_1.gltf')) || !existsSync(join(sourceDir('kaykit'), 'chest.glb')) || !existsSync(join(sourceDir('graveyard'), 'grave.glb')),
}, async () => {
  const fern = join(work, 'fern.glb')
  await convertPackModel(pack('nature'), model('nature', 'Fern_1.gltf'), sourceDir('nature'), fern)
  const fernJson = (await inspectModelFile(fern)).json
  const position = fernJson.accessors[fernJson.meshes[0].primitives[0].attributes.POSITION]
  // В исходнике границы записаны как ±4,5 по X; реальные вершины лежат в радиусе 1,5.
  assert.ok(position.max[0] < 2 && position.min[0] > -2 && position.max[1] < 1, `границы папоротника ${position.min} … ${position.max}`)
  for (const { name, side } of imageSides(fern)) assert.ok(side <= 512, `${name}: ${side}`)

  const tree = join(work, 'tree.glb')
  await convertPackModel(pack('nature'), model('nature', 'CommonTree_1.gltf'), sourceDir('nature'), tree)
  const treeSides = Object.fromEntries(imageSides(tree).map(({ name, side }) => [name, side]))
  assert.equal(treeSides.Bark_NormalTree_Normal, 128)
  assert.equal(treeSides.Bark_NormalTree, 256)
  assert.equal(treeSides.Leaves_NormalTree_C, 512)

  const chest = join(work, 'chest.glb')
  await convertPackModel(pack('kaykit'), model('kaykit', 'chest.glb'), sourceDir('kaykit'), chest)
  const chestJson = (await inspectModelFile(chest)).json
  assert.ok(chestJson.nodes.some((node) => node.name === 'hinge-lid'), 'крышка сундука открывается клиентом')
  assert.equal(chestJson.images.length, 1, 'исходная встроенная палитра не дублируется')
  assert.equal(imageSides(chest)[0].side, 512)

  const grave = join(work, 'grave.glb')
  await convertPackModel(pack('graveyard'), pack('graveyard').selection.find((item) => item.name === 'grave-round'), sourceDir('graveyard'), grave)
  const graveJson = (await inspectModelFile(grave)).json
  assert.equal(graveJson.meshes.length, 2, 'холм и надгробие собраны в одну модель')
  assert.deepEqual(graveJson.scenes[0].nodes.length, 2)
  assert.ok(graveJson.images.every((image) => image.uri === undefined), 'colormap встроен')
  assert.equal(imageSides(grave)[0].side, 256)
})

test('активный выпуск окружения содержит наборы и укладывается в бюджет 64 МиБ', () => {
  const manifest = JSON.parse(readFileSync(new URL('public/assets/models/environment/manifest.json', root), 'utf8'))
  const keys = new Set(manifest.models.map((entry) => entry.key))
  for (const item of ENVIRONMENT_PACKS) for (const selected of item.selection) {
    assert.ok(keys.has(packModelKey(item, selected)), `${item.id}: ${selected.file} есть в выпуске`)
  }
  for (const key of SUPERSEDED_AUTHORED_KEYS) {
    assert.deepEqual(manifest.models.find((entry) => entry.key === key)?.assetIds, [], `${key}: модель хранится без привязки`)
  }
  const releaseBytes = manifest.release.files.reduce((sum, file) => sum + file.bytes, 0)
  assert.ok(releaseBytes < 64 * 1024 * 1024, `выпуск ${releaseBytes} байт`)
  for (const item of ENVIRONMENT_PACKS) {
    assert.ok(manifest.sources.some((source) => source.archive === item.source.archive && source.archiveSha256 === item.source.archiveSha256), `${item.id}: источник записан`)
  }
})
