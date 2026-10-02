import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { decodePng } from '../tools/png-codec.mjs'
import { inspectModelFile } from '../tools/import-environment-models.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = `${root}public/assets/maps/detail-v1/`
const spec = JSON.parse(readFileSync(`${root}docs/map-detail-assets-spec-v1.json`, 'utf8'))
const manifest = JSON.parse(readFileSync(`${directory}manifest.json`, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('заказ детализации содержит весь набор и закреплённые хеши файлов и рецептов', () => {
  assert.deepEqual(manifest.counts, { sourceRasters: 34, textures: 19, sheets: 15, stamps: 135, models: 64 })
  assert.equal(manifest.status, 'prepared')
  assert.equal(spec.rasters.length, 34)
  assert.equal(Object.keys(manifest.textures).length, 19)
  assert.equal(Object.keys(manifest.sheets).length, 15)
  assert.deepEqual(new Set(manifest.models.map(model => model.id)), new Set(spec.models.map(model => model.id)))
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

test('135 штампов сохраняют соответствие ячеек ID, альфу, футпринты и квадратные якоря стен', () => {
  const atlas = JSON.parse(readFileSync(`${directory}prop-atlas.json`, 'utf8'))
  const image = decodePng(readFileSync(`${directory}prop-atlas.png`))
  const sheets = spec.rasters.filter(raster => raster.type === 'sheet')
  assert.deepEqual(new Set(Object.keys(atlas.frames)), new Set(sheets.flatMap(sheet => sheet.ids)))
  assert.equal(Object.keys(atlas.frames).length, 135)
  const rectangles = []
  for (const sheet of sheets) for (let index = 0; index < sheet.ids.length; index++) {
    const id = sheet.ids[index], frame = atlas.frames[id]
    assert.equal(frame.sheet, sheet.file)
    assert.equal(frame.sourceIndex, index)
    assert.deepEqual(frame.footprint, sheet.footprints[index])
    assert.ok(frame.x >= 0 && frame.y >= 0 && frame.x + frame.w <= image.width && frame.y + frame.h <= image.height, id)
    let visible = 0, transparent = 0
    for (let y = frame.y; y < frame.y + frame.h; y++) for (let x = frame.x; x < frame.x + frame.w; x++) {
      const alpha = image.data[(y * image.width + x) * 4 + 3]
      if (alpha > 128) visible++
      if (alpha === 0) transparent++
    }
    assert.ok(visible > 8, `Пустой штамп: ${id}`)
    assert.ok(transparent > 0, `Не снят фон: ${id}`)
    if (id.startsWith('wall_joint_')) assert.equal(frame.w, frame.h, id)
    for (const other of rectangles) {
      assert.ok(frame.x + frame.w <= other.x || other.x + other.w <= frame.x || frame.y + frame.h <= other.y || other.y + other.h <= frame.y, `Перекрытие кадра ${id}`)
    }
    rectangles.push(frame)
  }
})

test('64 GLB самодостаточны, сохраняют размеры в метрах и лимит геометрии', async () => {
  for (const model of manifest.models) {
    const { json, sha256 } = await inspectModelFile(`${directory}${model.file}`)
    assert.equal(sha256, model.sha256, model.id)
    assert.equal(json.meshes.length, 1, model.id)
    assert.equal(json.materials.length, 1, model.id)
    assert.equal(json.images.length, 1, model.id)
    assert.ok(json.images.every(image => image.bufferView !== undefined && image.uri === undefined))
    assert.ok(json.buffers.every(buffer => buffer.uri === undefined))
    assert.ok(!json.animations?.length && !json.skins?.length)
    const primitive = json.meshes[0].primitives[0]
    const positions = json.accessors[primitive.attributes.POSITION]
    assert.ok(positions.count / 3 <= 4000, model.id)
    assert.equal(positions.count / 3, model.triangles, model.id)
    const actual = [positions.max[0] - positions.min[0], positions.max[2] - positions.min[2], positions.max[1] - positions.min[1]]
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[axis] - model.dimensions[axis]) < .0001, `${model.id}: размер ${axis}`)
    assert.ok(Math.abs(positions.min[1]) < .0001, `${model.id}: основание`)
    assert.ok(Math.abs(positions.min[0] + positions.max[0]) < .0001 && Math.abs(positions.min[2] + positions.max[2]) < .0001, `${model.id}: центр`)
    assert.ok(model.textureSize.every(side => side <= 1024))
    assert.ok(model.preview?.w > 0 && model.preview?.h > 0, model.id)
  }
})
