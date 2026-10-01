#!/usr/bin/env node
// @ts-check
/**
 * Таблица ассетов TaleSpire для импорта слэбов (`server/talespire-import.mjs`).
 *
 * Читает индексы официальных наборов из установленной игры
 * (`<TaleSpire>/Taleweaver/<pack>/index.json`) и пишет производную таблицу
 * `data/talespire-assets-v1.json`: идентификатор ассета → вид (тайл/предмет),
 * роль для проекции на клетки, габарит коллайдера, материал пола и вид
 * каталога «Сказания» для предмета.
 *
 * Что в таблицу НЕ попадает: имена, теги, значки, модели и любые файлы игры.
 * Имена и теги нужны только здесь, чтобы назначить роль; на сервер уходит
 * результат классификации. Графика TaleSpire принадлежит Bouncyrock и в
 * проект не переносится — карта рисуется нашими тайлами и предметами.
 *
 * Запуск (после обновления TaleSpire, если в слэбах появились незнакомые ассеты):
 *   pnpm talespire:assets
 *   pnpm talespire:assets -- --dir "D:/SteamLibrary/steamapps/common/TaleSpire"
 *   pnpm talespire:assets -- --check      # сравнить с сохранённой таблицей, ничего не писать
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assetById } from '../server/asset-registry.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const TABLE_FILE = join(ROOT, 'data', 'talespire-assets-v1.json')
export const TABLE_SCHEMA_VERSION = 1
const DEFAULT_DIR = 'C:/Program Files (x86)/Steam/steamapps/common/TaleSpire'

/**
 * @typedef {{
 *   Id: string, Name: string, GroupTag?: string, Tags?: string[], IsDeprecated?: boolean,
 *   ColliderBoundsBound?: { m_Center: {x:number,y:number,z:number}, m_Extent: {x:number,y:number,z:number} }
 * }} IndexAsset
 */

/**
 * Предмет TaleSpire → вид каталога «Сказания». Первое совпадение выигрывает,
 * поэтому частные правила стоят выше общих («barrel stack» раньше «barrel»).
 * @type {Array<[RegExp, string]>}
 */
export const PROP_RULES = [
  [/\bstall\b|market/u, 'market_stall'],
  [/barrel stack|barrels\b/u, 'barrel_stack'],
  [/\bkeg/u, 'keg'],
  [/barrel/u, 'barrel'],
  [/crate stack|crates\b|stacked crate/u, 'crate_stack'],
  [/crate|\bbox(es)?\b/u, 'crate'],
  [/\bchest\b|treasure chest/u, 'chest'],
  [/bunk/u, 'bunk_bed'],
  [/\bbed\b|bedroll/u, 'bed'],
  [/bookshelf|bookcase/u, 'bookshelf'],
  [/wardrobe|closet/u, 'wardrobe'],
  [/cabinet|cupboard|drawer|dresser/u, 'cupboard'],
  [/\bshelf\b|shelves|wall rack/u, 'shelf_wall'],
  [/throne/u, 'royal_throne'],
  [/bar counter|\bcounter\b/u, 'bar_counter'],
  [/round table|table round|table.*circle/u, 'table_round'],
  [/long table|table long|table large|banquet|dining table/u, 'table_long'],
  [/\btable\b|\bdesk\b/u, 'table_small'],
  [/\bbench\b|\bpew\b/u, 'bench'],
  [/\bstool\b/u, 'stool'],
  [/\bchair\b|armchair/u, 'chair'],
  [/fireplace|\boven\b|furnace|\bkiln\b|hearth/u, 'fireplace'],
  [/cauldron/u, 'cauldron'],
  [/campfire|fire pit|bonfire/u, 'campfire'],
  [/brazier/u, 'brazier'],
  [/candelabra|candleabra/u, 'candelabra'],
  [/\bwell\b/u, 'well'],
  [/water trough|\btrough\b/u, 'water_trough'],
  [/\bcart\b|wagon/u, 'cart'],
  [/\bhay/u, 'haystack'],
  [/statue/u, 'statue'],
  [/\baltar\b/u, 'altar'],
  [/sarcophag|coffin/u, 'sarcophagus'],
  [/grave|tombstone|headstone/u, 'grave'],
  [/\bpillar\b|\bcolumn\b/u, 'pillar'],
  [/stalagmite|stalactite/u, 'stalagmite'],
  [/\bbones?\b|skull|skeleton/u, 'bone_pile'],
  [/cobweb|\bweb\b/u, 'cobweb'],
  [/mushroom/u, 'mushroom_cluster'],
  [/dead tree/u, 'tree_dead'],
  [/\bpine\b|spruce|\bfir\b/u, 'tree_pine'],
  [/birch/u, 'tree_birch'],
  [/\btree\b|\bpalm\b/u, 'tree_oak'],
  [/\bstump\b/u, 'tree_stump'],
  [/\blog\b|\blogs\b/u, 'fallen_log'],
  [/\bfern\b/u, 'fern'],
  [/\bbush\b|shrub|cactus|hedge/u, 'bush'],
  [/firewood|woodpile|wood pile/u, 'woodpile'],
  [/\bsack\b|\bsacks\b|\bbag\b/u, 'sack'],
  [/basket/u, 'basket'],
  [/bucket/u, 'bucket'],
  [/\burn\b|\bvase\b|pottery|amphora/u, 'urn'],
  [/\bjug\b|pitcher/u, 'jug'],
  [/\bpot\b/u, 'pot'],
  [/\brug\b|carpet/u, 'rug'],
  [/lamp ?post|street ?lamp/u, 'lamp_post'],
  [/sign ?post/u, 'signpost'],
  [/rubble|debris/u, 'rubble_heap'],
]

/**
 * Роль ассета для проекции на клетки. Геометрические решения (тонкая стена
 * или толстая, высокий забор или низкий, торчит ли предмет над полом)
 * принимает импортёр по габариту — здесь только смысл.
 *
 * @param {IndexAsset} asset
 * @param {'tile'|'prop'} kind
 * @returns {{ role: string, material: string, propAsset: string }}
 */
export function classifyAsset(asset, kind) {
  const text = `${asset.Name} ${asset.GroupTag ?? ''} ${(asset.Tags ?? []).join(' ')}`.toLowerCase()
  const extent = asset.ColliderBoundsBound?.m_Extent ?? { x: 0, y: 0, z: 0 }
  const height = 2 * extent.y
  const footprintMin = 2 * Math.min(extent.x, extent.z)
  const material = materialFor(text)
  if (kind === 'tile') {
    if (/hatch|trapdoor|trap door/u.test(text)) return { role: 'hatch', material, propAsset: '' }
    // «Плоская ступень» и «блок ступеней» — площадка и куб; строители кладут их
    // и как обычный пол, и как землю двора. Ходят по их верхней грани.
    if (/stair|steps\b/u.test(text)) {
      const flatOrBlock = footprintMin >= 0.9 && (height <= 0.3 || /block/u.test(text))
      return { role: flatOrBlock ? 'floor' : 'stairs', material, propAsset: '' }
    }
    if (/\bdoor\b|portcullis|\bgate\b/u.test(text)) return { role: 'door', material, propAsset: '' }
    // Фронтон под крышей («roof side wall») — настоящая стена этажа, а не кровля.
    const gableWall = /\bwall\b/u.test(asset.Name.toLowerCase()) && height >= 1.5
    if (!gableWall && /roof|overhang|\bdome\b|chimney|merlon|awning/u.test(text)) return { role: 'roof', material, propAsset: '' }
    if (/window/u.test(text)) return { role: 'window', material, propAsset: '' }
    if (/palisade|rampart/u.test(text)) return { role: 'wall', material, propAsset: '' }
    if (/fence|railing|\brail\b|balust|\bbar\b/u.test(text)) return { role: 'fence', material, propAsset: '' }
    // пол и стена одной моделью: полоса пола внизу, стена по краю
    if (height >= 2.2 && (/combo|combination/u.test(text) || (/floor/u.test(text) && /wall/u.test(text)))) {
      return { role: 'wallfloor', material, propAsset: '' }
    }
    if (height <= 0.6 && footprintMin >= 0.9) return { role: 'floor', material, propAsset: '' }
    if (/\bnet\b|banner|decor|cable|pipe/u.test(text) && height < 1.5) return { role: 'decor', material, propAsset: '' }
    return { role: 'wall', material, propAsset: '' }
  }
  if (/ladder/u.test(text)) return { role: 'ladder', material, propAsset: '' }
  if (/cliff|\brock|boulder|\bstone pile|rubble|debris/u.test(text) && !/statue|altar|well|pillar|column/u.test(text)) {
    return { role: 'rock', material, propAsset: '' }
  }
  for (const [pattern, id] of PROP_RULES) {
    if (pattern.test(text) && assetById(id)) return { role: 'prop', material, propAsset: id }
  }
  return { role: 'decor', material, propAsset: '' }
}

/** @param {string} text */
function materialFor(text) {
  if (/marble/u.test(text)) return 'marble'
  if (/\bwood|plank|tavern|rural|\bdock|harbor|harbour|\bship\b|\bboat\b/u.test(text)) return 'wood'
  if (/grass|jungle|forest|\bmoss|meadow/u.test(text)) return 'grass'
  if (/\bsand|dune|oasis|beach|desert ground/u.test(text)) return 'sand'
  if (/dirt|\bmud\b|earth|cave|cavern|soil|underdark|swamp/u.test(text)) return 'earth'
  if (/metal|\biron\b|steel|sci.?fi|cyberpunk/u.test(text)) return 'metal'
  if (/\bice\b|\bsnow|frost/u.test(text)) return 'ice'
  return 'stone'
}

const round = (/** @type {number} */ value) => Math.round(value * 1000) / 1000

/**
 * @param {string} dir каталог установки TaleSpire
 */
export function buildTable(dir) {
  const weaver = join(dir, 'Taleweaver')
  if (!existsSync(weaver)) throw new Error(`Не найден каталог ${weaver}: укажите установку TaleSpire через --dir`)
  /** @type {Record<string, [string, string, number, number, number, number, number, number, string, string, string]>} */
  const assets = {}
  /** @type {Array<{ id: string, tiles: number, props: number }>} */
  const packs = []
  for (const packId of readdirSync(weaver).sort()) {
    const file = join(weaver, packId, 'index.json')
    if (!existsSync(file)) continue
    const pack = JSON.parse(readFileSync(file, 'utf8'))
    // Жанр набора: «Cyberpunk and Sci-fi» не должен попадать в фэнтези-мир.
    const genre = /cyber|sci-?fi|modern|futur/iu.test(String(pack.Name ?? '')) ? 's' : 'f'
    let tiles = 0
    let props = 0
    for (const [listName, kind] of /** @type {const} */ ([['Tiles', 'tile'], ['Props', 'prop']])) {
      for (const asset of /** @type {IndexAsset[]} */ (pack[listName] ?? [])) {
        const bounds = asset.ColliderBoundsBound
        if (!bounds || !/^[0-9a-f-]{36}$/u.test(asset.Id)) continue
        const { role, material, propAsset } = classifyAsset(asset, kind)
        const c = bounds.m_Center
        const e = bounds.m_Extent
        assets[asset.Id] = [kind === 'tile' ? 't' : 'p', role, round(c.x), round(c.y), round(c.z), round(e.x), round(e.y), round(e.z), material, propAsset, genre]
        if (kind === 'tile') tiles += 1
        else props += 1
      }
    }
    packs.push({ id: packId, tiles, props })
  }
  const sorted = Object.fromEntries(Object.entries(assets).sort(([left], [right]) => left.localeCompare(right)))
  return {
    schema_version: TABLE_SCHEMA_VERSION,
    note: 'Производная таблица из индексов официальных наборов TaleSpire: только идентификаторы ассетов, габариты коллайдеров и роли для проекции на клетки. Имён, моделей и изображений TaleSpire здесь нет. Пересборка: pnpm talespire:assets.',
    columns: ['kind', 'role', 'cx', 'cy', 'cz', 'ex', 'ey', 'ez', 'material', 'prop_asset', 'genre'],
    packs,
    assets: sorted,
  }
}

function main() {
  const args = process.argv.slice(2)
  const dirIndex = args.indexOf('--dir')
  const dir = dirIndex >= 0 ? String(args[dirIndex + 1] ?? '') : (process.env.TALESPIRE_DIR || DEFAULT_DIR)
  const table = buildTable(dir)
  const text = `${JSON.stringify(table, null, 0).replace(/\],"/gu, '],\n"')}\n`
  const roles = /** @type {Record<string, number>} */ ({})
  for (const row of Object.values(table.assets)) roles[row[1]] = (roles[row[1]] ?? 0) + 1
  console.log(`ассетов: ${Object.keys(table.assets).length}; роли: ${Object.entries(roles).map(([role, count]) => `${role}=${count}`).join(', ')}`)
  if (args.includes('--check')) {
    const saved = existsSync(TABLE_FILE) ? readFileSync(TABLE_FILE, 'utf8').replace(/\r\n/gu, '\n') : ''
    if (saved !== text) {
      console.error('Таблица устарела: pnpm talespire:assets')
      process.exitCode = 1
    } else console.log('Таблица актуальна')
    return
  }
  writeFileSync(TABLE_FILE, text)
  console.log(`записано: ${TABLE_FILE}`)
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main()
