import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { assetById, listAssets, readDetailAtlas, validateAssetRegistry } from '../server/asset-registry.mjs'
import { DETAIL_PROPS } from '../server/detail-props.mjs'

const root = new URL('../', import.meta.url)
const clientSource = readFileSync(new URL('src/detail-props.ts', root), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('public/assets/maps/detail-v1/manifest.json', root), 'utf8'))

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
  assert.deepEqual(clientModels, new Set(manifest.models.map((model) => model.id)), 'список GLB разошёлся с манифестом набора')
})

test('каждый предмет набора стоит в реестре со штампом, а двойник — прежний предмет', () => {
  assert.equal(validateAssetRegistry().ok, true)
  const atlas = readDetailAtlas()
  assert.equal(atlas.image, 'maps/detail-v1/prop-atlas.png')
  const declared = new Set(DETAIL_PROPS.map((record) => record.id))
  for (const record of DETAIL_PROPS) {
    const entry = assetById(record.id)
    assert.ok(entry, `${record.id} нет в реестре`)
    assert.equal(entry.raster, `${atlas.image}#${record.id}`, `${record.id}: нет штампа`)
    assert.equal(entry.interactive, false, `${record.id}: интерактивность требует записи в каталоге взаимодействий`)
    const alias = assetById(record.alias)
    assert.ok(alias && !declared.has(record.alias), `${record.id}: двойник ${record.alias} — не прежний предмет`)
    // Плоский штамп и двойник — плоские оба: декаль не рисуется объёмом.
    if (record.kind === 'decal') assert.equal(alias.kind === 'decal' || alias.baseFootprint.w === 0, true, `${record.id}: объёмный двойник`)
  }
  // Каждый кадр набора — предмет реестра, кроме стыков стен: это детали
  // отрисовки стены, а не предметы на клетке.
  const unregistered = Object.keys(atlas.frames).filter((id) => !declared.has(id) && !id.startsWith('wall_joint_'))
  assert.deepEqual(unregistered, [])
  for (const model of manifest.models) assert.ok(declared.has(model.id), `${model.id}: модель без предмета`)
})

test('предметы назначения не попадают в общие темы дома и двора', () => {
  const housing = new Set(['building', 'tavern', 'house', 'interior', 'yard'])
  const leaked = DETAIL_PROPS.filter((record) => record.themes.some((theme) => housing.has(theme))).map((record) => record.id)
  assert.deepEqual(leaked, [], 'дыба не должна встать в трактир случайным добором')
  assert.ok(listAssets().some((record) => record.id === 'torture_rack' && record.themes.includes('prison')))
})
