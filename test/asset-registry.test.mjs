import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSET_ANCHORS,
  ASSET_KINDS,
  assetById,
  assetsForTheme,
  listAssets,
  registeredRightsIds,
  validateAssetRegistry,
} from '../server/asset-registry.mjs'

test('реестр проходит собственную проверку', () => {
  const report = validateAssetRegistry()
  assert.deepEqual(report.errors, [])
  assert.equal(report.ok, true)
})

test('набор под тему «здание с участком» покрывает сцену-эталон', () => {
  const assets = listAssets()
  assert.ok(assets.length >= 60 && assets.length <= 80,
    `в реестре ${assets.length} записей, ориентир плана — 60–75`)

  // Раздел 1 плана: стулья у столов, бочки вдоль стен, очаг у стены, деревья и
  // тропа снаружи. Без этих записей сцену-эталон собрать нечем.
  for (const id of ['table_round', 'chair', 'barrel', 'fireplace', 'bar_counter', 'bed',
    'tree_oak', 'bush', 'path_stone', 'cart', 'well', 'stairs_up']) {
    assert.ok(assetById(id), `в реестре нет обязательной записи ${id}`)
  }
})

test('идентификаторы уникальны, а виды и якоря — из перечислений', () => {
  const ids = listAssets().map((record) => record.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const record of listAssets()) {
    assert.ok(ASSET_KINDS.includes(record.kind), `${record.id}: вид ${record.kind}`)
    assert.ok(ASSET_ANCHORS.includes(record.anchor), `${record.id}: якорь ${record.anchor}`)
  }
})

test('деревья и кусты живут только во внешней теме', () => {
  const interior = assetsForTheme('interior').map((record) => record.id)
  for (const id of ['tree_oak', 'tree_pine', 'bush', 'well', 'cart']) {
    assert.equal(interior.includes(id), false, `${id} не должен попадать в интерьер`)
  }
  const yard = assetsForTheme('yard').map((record) => record.id)
  assert.ok(yard.includes('tree_oak'))
  assert.equal(yard.includes('bar_counter'), false, 'стойка не стоит во дворе')
})

test('растровая запись без прав отклоняется', () => {
  const report = validateAssetRegistry([{
    id: 'table_raster', kind: 'prop', themes: ['tavern'], baseFootprint: { w: 1, h: 1 },
    anchor: 'center', vector: 'table_round', raster: 'maps/props/table.webp', rightsId: null,
    blocksMove: false, blocksSight: false, cover: 'none', destructible: false, hp: 0,
    interactive: false, scaleRange: { min: 1, max: 1 },
  }])
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'ASSET_RASTER_WITHOUT_RIGHTS'))
})

test('незарегистрированные права отклоняются, зарегистрированные принимаются', () => {
  const base = {
    id: 'chest_raster', kind: 'prop', themes: ['tavern'], baseFootprint: { w: 1, h: 1 },
    anchor: 'center', vector: 'chest', blocksMove: false, blocksSight: false, cover: 'none',
    destructible: false, hp: 0, interactive: false, scaleRange: { min: 1, max: 1 },
  }
  const unknown = validateAssetRegistry([{ ...base, raster: 'maps/props/nope.webp', rightsId: 'maps/props/nope.webp' }])
  assert.ok(unknown.errors.some((issue) => issue.code === 'ASSET_RIGHTS_NOT_REGISTERED'))

  const rights = registeredRightsIds()
  assert.ok(rights.has('maps/props/ruins-chest-v1.webp'), 'ожидалась уже зарегистрированная запись прав')
  const known = validateAssetRegistry([{
    ...base,
    raster: 'maps/props/ruins-chest-v1.webp',
    rightsId: 'maps/props/ruins-chest-v1.webp',
  }])
  assert.deepEqual(known.errors, [])
})

test('запись без рисунка отклоняется, а запись без растра — нет', () => {
  const base = {
    id: 'ghost', kind: 'prop', themes: ['tavern'], baseFootprint: { w: 1, h: 1 }, anchor: 'center',
    raster: null, rightsId: null, blocksMove: false, blocksSight: false, cover: 'none',
    destructible: false, hp: 0, interactive: false, scaleRange: { min: 1, max: 1 },
  }
  assert.ok(validateAssetRegistry([{ ...base, vector: '' }]).errors
    .some((issue) => issue.code === 'ASSET_HAS_NO_DRAWING'))
  assert.deepEqual(validateAssetRegistry([{ ...base, vector: 'ghost' }]).errors, [])
})

test('перекрывающий движение предмет обязан занимать клетки', () => {
  const report = validateAssetRegistry([{
    id: 'floating_wall', kind: 'prop', themes: ['tavern'], baseFootprint: { w: 0, h: 0 },
    anchor: 'center', vector: 'x', raster: null, rightsId: null, blocksMove: true,
    blocksSight: false, cover: 'none', destructible: false, hp: 0, interactive: false,
    scaleRange: { min: 1, max: 1 },
  }])
  assert.ok(report.errors.some((issue) => issue.code === 'ASSET_BLOCKS_WITHOUT_FOOTPRINT'))
})

test('мелкая утварь ничего не занимает и не перекрывает', () => {
  for (const id of ['mug', 'plate', 'bottle', 'candle', 'rug']) {
    const record = assetById(id)
    assert.ok(record)
    assert.deepEqual(record.baseFootprint, { w: 0, h: 0 }, `${id} не должен занимать клетку`)
    assert.equal(record.blocksMove, false)
  }
})

test('крупная мебель занимает больше одной клетки и даёт укрытие', () => {
  for (const [id, cells] of [['table_round', 4], ['bar_counter', 4], ['bed', 2], ['tree_oak', 4]]) {
    const record = assetById(String(id))
    assert.ok(record)
    assert.equal(record.baseFootprint.w * record.baseFootprint.h, cells, `${id}: размер по умолчанию`)
    assert.notEqual(record.cover, 'none', `${id} обязан давать укрытие`)
  }
})

test('ни одна запись пока не заявляет растр — набор не нарисован', () => {
  const withRaster = listAssets().filter((record) => record.raster)
  assert.deepEqual(withRaster, [], 'заявлять нарисованный набор нельзя, пока его нет')
})
