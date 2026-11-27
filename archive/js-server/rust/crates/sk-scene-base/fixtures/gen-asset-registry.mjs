// Эталон `server/detail-props.mjs` и `server/asset-registry.mjs` для sk-scene-base.
// Запуск из корня репозитория: node rust/crates/sk-scene-base/fixtures/gen-asset-registry.mjs
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DETAIL_PROPS } from '../../../../server/detail-props.mjs'
import {
  ASSET_ANCHORS,
  ASSET_COVER_LEVELS,
  ASSET_KINDS,
  OPENINGS_THEME,
  assetById,
  assetsForTheme,
  listAssets,
  readDetailAtlas,
  readPropAtlas,
  registeredRightsIds,
  validateAssetRegistry,
  withAtlasArt,
} from '../../../../server/asset-registry.mjs'
import { jsonOf } from './corpus.mjs'

const assets = listAssets()
const themes = [...new Set(assets.flatMap((record) => record.themes))].sort()
const sha = (value) => createHash('sha256').update(value).digest('hex')

const propAtlas = readPropAtlas()
const detailAtlas = readDetailAtlas()
const rights = [...registeredRightsIds()].sort()

// Манифесты атласа: битые, пустые, массив кадров, кадры по ключам прототипа.
const dir = mkdtempSync(join(tmpdir(), 'sk-scene-base-atlas-'))
const ATLAS_TEXTS = [
  '{"image":"maps/props/a.png","cellPixels":96,"frames":{"crate":{"x":1},"constructor":0}}',
  '{"image":"b.png","cellPixels":"48","frames":{"chair":1}}',
  '{"image":"c.png","frames":{}}',
  '{"image":"","frames":{"chair":1}}',
  '{"image":"d.png","cellPixels":"x","frames":[1,2,3]}',
  '{"image":"e.png","frames":"строка"}',
  '{"image":7,"frames":{"x":null}}',
  'null', '[]', '"строка"', '{битый json', '',
  '{"image":"maps/detail-v1/f.png","cellPixels":12.5,"frames":{"rug":{"x":0},"mug":false,"bed":""}}',
]
const atlasCases = ATLAS_TEXTS.map((text, index) => {
  const file = join(dir, `atlas-${index}.json`)
  writeFileSync(file, text)
  return { text, prop: jsonOf(readPropAtlas(file)), detail: jsonOf(readDetailAtlas(file)) }
})
const RIGHTS_TEXTS = [
  '{"assets":[["maps/a.png","hash"],["b"],[],[null],[7],{"0":"c"},"de",5,null]}',
  '{"assets":"нет"}', 'null', '{битый', '{}',
]
const rightsCases = RIGHTS_TEXTS.map((text, index) => {
  const file = join(dir, `rights-${index}.json`)
  writeFileSync(file, text)
  return { text, output: [...registeredRightsIds(file)].sort() }
})
const missing = { prop: jsonOf(readPropAtlas(join(dir, 'нет такого файла.json'))), rights: [...registeredRightsIds(join(dir, 'нет.json'))] }
rmSync(dir, { recursive: true, force: true })

// Прикладка растра к записям: атлас с кадрами по id реестра, по ключам
// прототипа и массивом.
const sample = assets.slice(0, 12)
const withArt = [
  { image: 'x.png', cellPixels: 1, frames: { table_round: 1, chair: 0, bench: { x: 1 } } },
  { image: '', cellPixels: 0, frames: { table_round: 1 } },
  { image: 'arr.png', cellPixels: 0, frames: [1, 0] },
].map((atlas) => ({ atlas, output: jsonOf(withAtlasArt([...sample, { ...sample[0], id: 'constructor' }, { ...sample[0], id: '0' }, { ...sample[0], id: '1' }, { ...sample[0], id: 'map' }], atlas)) }))

// Проверка реестра на записях с ошибками.
const base = {
  id: 'ghost', kind: 'prop', themes: ['tavern'], baseFootprint: { w: 1, h: 1 }, anchor: 'center', vector: 'ghost',
  raster: null, rightsId: null, blocksMove: false, blocksSight: false, cover: 'none', destructible: false, hp: 0,
  interactive: false, scaleRange: { min: 1, max: 1 },
}
const VALIDATE = [
  [base],
  [{ ...base, vector: '' }],
  [{ ...base, raster: 'maps/props/table.webp' }],
  [{ ...base, raster: 'maps/props/nope.webp', rightsId: 'maps/props/nope.webp' }],
  [{ ...base, raster: 'maps/props/ruins-chest-v1.webp', rightsId: 'maps/props/ruins-chest-v1.webp' }],
  [{ ...base, baseFootprint: { w: 0, h: 0 }, blocksMove: true }],
  [{ ...base, baseFootprint: { w: 0, h: 1 } }, { ...base, baseFootprint: { w: -1, h: -1 } }],
  [{ ...base, scaleRange: { min: 0, max: 1 } }, { ...base, scaleRange: { min: 2, max: 1 } }],
  [{ ...base, id: '' }, { ...base, id: '' }, { ...base, kind: 'tile', anchor: 'top', cover: 'full' }],
  [base, base, { ...base, raster: '', rightsId: 'maps/props/nope.webp' }, { ...base, vector: '', raster: '' }],
  assets,
  withAtlasArt(assets, { image: '', cellPixels: 0, frames: {} }),
]
const validate = VALIDATE.map((entries) => ({ entries: entries === assets ? 'registry' : entries, output: jsonOf(validateAssetRegistry(entries)) }))

const fixture = {
  constants: { ASSET_KINDS, ASSET_ANCHORS, ASSET_COVER_LEVELS, OPENINGS_THEME },
  detailProps: jsonOf(DETAIL_PROPS),
  assets: jsonOf(assets),
  themes: Object.fromEntries([...themes, 'нет', ''].map((theme) => [theme, assetsForTheme(theme).map((record) => record.id)])),
  byId: Object.fromEntries([...assets.map((record) => record.id), 'нет', 'constructor', '__proto__', ''].map((id) => [id, assetById(id)?.id ?? null])),
  propAtlas: { image: propAtlas.image, cellPixels: propAtlas.cellPixels, frames: Object.keys(propAtlas.frames) },
  detailAtlas: { image: detailAtlas.image, cellPixels: detailAtlas.cellPixels, frames: Object.keys(detailAtlas.frames) },
  rights: { count: rights.length, sha256: sha(rights.join('\n')) },
  atlasCases,
  rightsCases,
  missing,
  withArt,
  validate,
  defaultReport: jsonOf(validateAssetRegistry()),
}
writeFileSync(new URL('./asset-registry.json', import.meta.url), `${JSON.stringify(fixture)}\n`)
console.log(`asset-registry: ${DETAIL_PROPS.length} предметов набора, ${assets.length} записей реестра, ${atlasCases.length + rightsCases.length + withArt.length + validate.length} прочих случаев`)
