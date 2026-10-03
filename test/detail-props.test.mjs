import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { assetById, listAssets, readDetailAtlas, validateAssetRegistry } from '../server/asset-registry.mjs'
import { DETAIL_PROPS } from '../server/detail-props.mjs'

const root = new URL('../', import.meta.url)
const clientSource = readFileSync(new URL('src/detail-props.ts', root), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('public/assets/maps/detail-v1/manifest.json', root), 'utf8'))
const pending = manifest.pendingIntegration ?? { stamps: [], models: [], textures: [] }
const pendingModels = new Set(pending.models)
const structuralModels = new Set(manifest.structuralIntegration?.models ?? [])
const styleStamps = new Set(manifest.styleIntegration?.stamps ?? [])
const NATIVE_STYLE_IDS = new Set([
  'arch_shelf', 'cutlery_set', 'tool_peg_rack', 'chain_coil', 'book_piles', 'shield_display',
  'alchemy_bottles', 'desk_candlestick', 'single_book', 'vial_display_shelf', 'ceremonial_chalice',
  'book_row', 'scroll_pile', 'rope_coils', 'clover_patch', 'forest_plant', 'wall_ivy', 'wall_ivy_corner',
  'wall_ivy_wide', 'key_bundle', 'coin_pouch',
])
const styleManifest = JSON.parse(readFileSync(new URL('public/assets/styles/stylized/manifest.json', root), 'utf8'))

function styleModelPath(url) {
  if (typeof url !== 'string') return null
  if (url.startsWith('/assets/')) return new URL(`public/${url.slice('/assets/'.length)}`, root)
  if (url.startsWith('props/')) return new URL(`public/assets/styles/stylized/${url}`, root)
  return null
}

/** Пары `id: 'двойник'` из клиентской таблицы. */
function clientAliases() {
  const block = /DETAIL_PROP_ALIASES[^{]*\{([\s\S]*?)\}\)/u.exec(clientSource)?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(/([a-z0-9_]+): '([a-z0-9_]+)'/gu)].map((match) => [match[1], match[2]]))
}

test('клиентская таблица двойников совпадает с серверной', () => {
  const server = Object.fromEntries(DETAIL_PROPS.map((record) => [record.id, record.alias]))
  assert.deepEqual(clientAliases(), server)
  const models = /DETAIL_PROP_MODELS[^[]*\[([\s\S]*?)\]\)/u.exec(clientSource)?.[1] ?? ''
  const clientModels = new Set([...models.matchAll(/'([a-z0-9_]+)'/gu)].map((match) => match[1]))
  const declared = new Set(DETAIL_PROPS.map((record) => record.id))
  const manifestModels = new Set(manifest.models.filter((model) => declared.has(model.id)).map((model) => model.id))
  assert.equal(clientModels.size, 85)
  assert.deepEqual(clientModels, manifestModels, 'список detail-v1 GLB разошёлся с манифестом набора')
})

test('каждый предмет набора стоит в реестре со штампом, а двойник — прежний предмет', () => {
  assert.equal(validateAssetRegistry().ok, true)
  const atlas = readDetailAtlas()
  assert.equal(atlas.image, 'maps/detail-v1/prop-atlas.png')
  const declared = new Set(DETAIL_PROPS.map((record) => record.id))
  const clientModels = new Set([...((/DETAIL_PROP_MODELS[^[]*\[([\s\S]*?)\]\)/u.exec(clientSource)?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/gu))].map((match) => match[1]))
  for (const record of DETAIL_PROPS) {
    const entry = assetById(record.id)
    assert.ok(entry, `${record.id} нет в реестре`)
    if (atlas.frames[record.id]) assert.equal(entry.raster, `${atlas.image}#${record.id}`, `${record.id}: нет штампа`)
    else {
      assert.ok(NATIVE_STYLE_IDS.has(record.id), `${record.id}: нет ни detail-, ни native-style описания`)
      assert.ok(entry.vector, `${record.id}: native-модель без fallback-вектора`)
      assert.ok(!entry.raster || entry.rightsId, `${record.id}: raster без прав`)
    }
    assert.equal(entry.interactive, false, `${record.id}: интерактивность требует записи в каталоге взаимодействий`)
    const alias = assetById(record.alias)
    assert.ok(alias && !declared.has(record.alias), `${record.id}: двойник ${record.alias} — не прежний предмет`)
    // Плоский штамп и двойник — плоские оба: декаль не рисуется объёмом.
    if (record.kind === 'decal') assert.equal(alias.kind === 'decal' || alias.baseFootprint.w === 0, true, `${record.id}: объёмный двойник`)
  }
  // Каждый подключённый кадр — предмет реестра, кроме стыков стен.
  // Новая партия остаётся подготовленной и перечислена явно в паспорте.
  const unregistered = Object.keys(atlas.frames).filter((id) => !declared.has(id) && !id.startsWith('wall_joint_'))
  assert.deepEqual(new Set(unregistered), new Set(pending.stamps))
  const modelsWithoutProps = manifest.models.filter(model => !declared.has(model.id)).map(model => model.id)
  assert.deepEqual(new Set(modelsWithoutProps), new Set([...pendingModels, ...structuralModels]), 'модель без предмета должна быть явно подготовлена для подключения')
  // Состав набора закреплён числами: выпавший из DETAIL_PROPS предмет или
  // лишний подготовленный штамп иначе прошли бы незамеченными.
  assert.equal(declared.size, 206)
  assert.equal(pending.stamps.length, 22)
  assert.equal(pending.models.length, 0)
  assert.equal(pending.textures.length, 6)
  assert.equal(styleStamps.size, 38)
  for (const values of [pending.stamps, pending.models, pending.textures]) assert.equal(new Set(values).size, values.length, 'подготовленный список не содержит повторов')
  for (const id of pending.models) assert.ok(pending.stamps.includes(id), `${id}: подготовленная модель без штампа`)
  for (const id of [...pending.stamps, ...pending.models]) assert.ok(!declared.has(id), `${id}: подключённый предмет ошибочно помечен подготовленным`)
  assert.deepEqual(new Set(DETAIL_PROPS.filter((record) => NATIVE_STYLE_IDS.has(record.id)).map((record) => record.id)), NATIVE_STYLE_IDS)
  assert.ok(styleManifest.atlas && styleManifest.atlas.image === 'topdown.webp', 'native style-моделям нужен topdown atlas')
  // Штамп, подключённый моделью стиля: он в реестре, GLB набора у него нет,
  // а 3D и 2D-превью приходят из пакета стиля.
  for (const id of styleStamps) {
    assert.ok(declared.has(id), `${id}: стилевой штамп не объявлен в DETAIL_PROPS`)
    assert.ok(!manifest.models.some((model) => model.id === id), `${id}: у стилевого штампа не должно быть GLB набора`)
  }
  for (const id of [...NATIVE_STYLE_IDS, ...styleStamps]) {
    const entries = styleManifest.props?.[id]
    assert.ok(Array.isArray(entries) && entries.length > 0, `${id}: нет style-модели`)
    for (const entry of entries) {
      assert.ok(entry.preview && ['x', 'y', 'w', 'h'].every((key) => Number.isInteger(entry.preview[key]) && entry.preview[key] >= 0), `${id}: нет style preview`)
      const modelPath = styleModelPath(entry.url)
      assert.ok(modelPath && existsSync(modelPath), `${id}: style-модель не найдена: ${entry.url}`)
    }
  }
})

test('предметы назначения не попадают в общие темы дома и двора', () => {
  const housing = new Set(['building', 'tavern', 'house', 'interior', 'yard'])
  const leaked = DETAIL_PROPS.filter((record) => record.themes.some((theme) => housing.has(theme))).map((record) => record.id)
  assert.deepEqual(leaked, [], 'дыба не должна встать в трактир случайным добором')
  assert.ok(listAssets().some((record) => record.id === 'torture_rack' && record.themes.includes('prison')))
})
