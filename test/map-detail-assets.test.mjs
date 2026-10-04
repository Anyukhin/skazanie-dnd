import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { decodePng, encodePng } from '../tools/png-codec.mjs'
import { inspectModelFile } from '../tools/import-environment-models.mjs'
import { createMapDetailModel } from '../tools/build-map-detail-models.mjs'
import { resolveMapDetailIntegration } from '../tools/build-map-detail-assets.mjs'
import { THREE } from '../tools/map-detail-model-helpers.mjs'
import { compactModelMaterialAtlas } from '../tools/map-detail-model-textures.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = `${root}public/assets/maps/detail-v1/`
const spec = JSON.parse(readFileSync(`${root}docs/map-detail-assets-spec-v1.json`, 'utf8'))
const manifest = JSON.parse(readFileSync(`${directory}manifest.json`, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('компактный PBR-атлас не подменяет дерево металлом при перестановке UV-слотов', () => {
  const data = new Uint8Array(512 * 512 * 4)
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) data.set([255, 200, y >= 256 && x < 256 ? 180 : 0, 255], (y * 512 + x) * 4)
  for (let y = 508; y < 512; y++) for (let x = 0; x < 4; x++) data.set([255, 180, 0, 255], (y * 512 + x) * 4)
  const png = encodePng({ width: 512, height: 512, data })
  const full = { baseColor: png, normal: png, orm: png, sources: [], textureSize: [512, 512] }
  for (const kinds of [[], ['wood'], ['metal'], ['stone', 'metal'], ['wood', 'stone', 'cloth'], ['wood', 'stone', 'metal', 'cloth']]) {
    const atlas = compactModelMaterialAtlas(full, kinds)
    const image = decodePng(atlas.orm)
    for (const kind of kinds) {
      const rect = atlas.rects[kind]
      const x = Math.floor((rect.u0 + rect.u1) * image.width / 2), y = Math.floor((rect.v0 + rect.v1) * image.height / 2)
      assert.equal(image.data[(y * image.width + x) * 4 + 2], kind === 'metal' ? 180 : 0, kind)
      if (kind === 'metal') {
        const gutterX = Math.round(rect.u0 * image.width) - 2, gutterY = Math.round(rect.v1 * image.height) + 2
        assert.equal(image.data[(gutterY * image.width + gutterX) * 4 + 2], 180, 'neutral patch не должен переноситься в metal-гуттер')
      }
    }
    assert.ok(atlas.textureSize.every(side => side <= 512))
  }
})

test('крыша командирского шатра вращается вокруг вертикали и не заваливается набок', () => {
  const tent = createMapDetailModel('command_tent')
  const canopy = tent.getObjectByName('tent-canopy')
  assert.ok(canopy)
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(canopy.quaternion)
  assert.ok(axis.distanceTo(new THREE.Vector3(0, 1, 0)) < .000001)
})

test('заказ детализации содержит весь набор и закреплённые хеши файлов и рецептов', () => {
  assert.deepEqual(manifest.counts, { sourceRasters: 49, textures: 25, sheets: 24, stamps: 216, models: 88 })
  assert.equal(manifest.status, 'prepared')
  assert.equal(spec.rasters.length, 49)
  assert.equal(Object.keys(manifest.textures).length, 25)
  assert.equal(Object.keys(manifest.sheets).length, 24)
  assert.deepEqual(new Set(manifest.models.map(model => model.id)), new Set(spec.models.map(model => model.id)))
  const integration = resolveMapDetailIntegration(spec)
  assert.deepEqual(manifest.pendingIntegration, integration.pendingIntegration)
  assert.deepEqual(manifest.structuralIntegration, integration.structuralIntegration)
  assert.deepEqual(manifest.styleIntegration, integration.styleIntegration)
  const sourceSpec = readFileSync(`${root}docs/map-detail-assets-spec-v1.json`)
  assert.equal(manifest.provenance.sourceSpec.file, 'docs/map-detail-assets-spec-v1.json')
  assert.equal(manifest.provenance.sourceSpec.sha256, hash(sourceSpec))
  assert.equal(manifest.provenance.sourceSha256, hash(sourceSpec))
  const assetGenerator = manifest.provenance.generators.find(generator => generator.file === 'tools/build-map-detail-assets.mjs')
  assert.equal(manifest.provenance.generatorSha256, assetGenerator.sha256)
  for (const file of manifest.files) {
    assert.ok(!file.file.includes('..') && !file.file.startsWith('/'))
    const bytes = readFileSync(`${directory}${file.file}`)
    assert.equal(bytes.length, file.bytes, file.file)
    assert.equal(hash(bytes), file.sha256, file.file)
  }
  for (const generator of manifest.provenance.generators) {
    assert.equal(hash(readFileSync(`${root}${generator.file}`)), generator.sha256, generator.file)
  }
})

test('216 штампов сохраняют соответствие ячеек ID, альфу, футпринты и квадратные якоря стен', () => {
  const atlas = JSON.parse(readFileSync(`${directory}prop-atlas.json`, 'utf8'))
  const image = decodePng(readFileSync(`${directory}prop-atlas.png`))
  const sheets = spec.rasters.filter(raster => raster.type === 'sheet')
  assert.deepEqual(new Set(Object.keys(atlas.frames)), new Set(sheets.flatMap(sheet => sheet.ids)))
  assert.equal(Object.keys(atlas.frames).length, 216)
  const rectangles = []
  for (const sheet of sheets) for (let index = 0; index < sheet.ids.length; index++) {
    const id = sheet.ids[index], frame = atlas.frames[id]
    assert.equal(frame.sheet, sheet.file)
    assert.equal(frame.sourceIndex, index)
    assert.deepEqual(frame.footprint, sheet.footprints[index])
    assert.ok(frame.x >= 0 && frame.y >= 0 && frame.x + frame.w <= image.width && frame.y + frame.h <= image.height, id)
    let visible = 0
    for (let y = frame.y; y < frame.y + frame.h; y++) for (let x = frame.x; x < frame.x + frame.w; x++) {
      const alpha = image.data[(y * image.width + x) * 4 + 3]
      if (alpha > 128) visible++
    }
    assert.ok(visible > 8, `Пустой штамп: ${id}`)
    // Квадратная плита может заполнять кадр целиком; фон проверяем в жёлобе.
    for (const [x, y] of [[frame.x - 1, frame.y - 1], [frame.x + frame.w, frame.y - 1], [frame.x - 1, frame.y + frame.h], [frame.x + frame.w, frame.y + frame.h]]) {
      assert.equal(image.data[(y * image.width + x) * 4 + 3], 0, `Не снят фон вокруг: ${id}`)
    }
    if (id.startsWith('wall_joint_')) assert.equal(frame.w, frame.h, id)
    for (const other of rectangles) {
      assert.ok(frame.x + frame.w <= other.x || other.x + other.w <= frame.x || frame.y + frame.h <= other.y || other.y + other.h <= frame.y, `Перекрытие кадра ${id}`)
    }
    rectangles.push(frame)
  }
})

test('88 GLB самодостаточны, сохраняют размеры в метрах и лимит геометрии', async () => {
  for (const model of manifest.models) {
    const { json, sha256 } = await inspectModelFile(`${directory}${model.file}`)
    assert.equal(sha256, model.sha256, model.id)
    assert.equal(json.meshes.length, 1, model.id)
    assert.equal(json.materials.length, 1, model.id)
    assert.equal(json.images.length, 3, model.id)
    assert.ok(json.images.every(image => image.bufferView !== undefined && image.uri === undefined))
    assert.ok(json.buffers.every(buffer => buffer.uri === undefined))
    assert.ok(!json.animations?.length && !json.skins?.length)
    const primitive = json.meshes[0].primitives[0]
    const positions = json.accessors[primitive.attributes.POSITION]
    const triangles = (primitive.indices === undefined ? positions.count : json.accessors[primitive.indices].count) / 3
    assert.ok(triangles <= 50000, model.id)
    assert.equal(triangles, model.triangles, model.id)
    assert.ok(primitive.attributes.COLOR_0 !== undefined, model.id)
    const uv = json.accessors[primitive.attributes.TEXCOORD_0]
    assert.ok(uv.min.every(value => value >= 0) && uv.max.every(value => value <= 1), `${model.id}: UV вне атласа`)
    assert.ok(json.materials[0].normalTexture && json.materials[0].pbrMetallicRoughness.metallicRoughnessTexture, `${model.id}: PBR`)
    const actual = [positions.max[0] - positions.min[0], positions.max[2] - positions.min[2], positions.max[1] - positions.min[1]]
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[axis] - model.dimensions[axis]) < .0001, `${model.id}: размер ${axis}`)
    assert.ok(Math.abs(positions.min[1]) < .0001, `${model.id}: основание`)
    assert.ok(Math.abs(positions.min[0] + positions.max[0]) < .0001 && Math.abs(positions.min[2] + positions.max[2]) < .0001, `${model.id}: центр`)
    assert.ok(model.textureSize.every(side => side <= 512))
    assert.equal(model.materialSources.length, 4, model.id)
    assert.ok(model.preview?.w > 0 && model.preview?.h > 0, model.id)
  }
})
