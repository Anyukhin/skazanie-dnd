// @ts-check
import { cellAt, FLOOR_STYLES, setCell, WALL_STYLES } from './tactical-map.mjs'

/**
 * Пол комнаты по её назначению. Генератор строит дом из одного материала, и
 * кухня, горница и кладовая выходили одинаковым настилом: глаз не отличал
 * комнату, где готовят, от комнаты, где спят. Здесь назначение комнаты
 * превращается в материал клетки (правила его знают: земля, камень, дерево) и
 * в рисунок пола (`zone.floor`, фактура набора `detail-v1`), который знает
 * только отрисовка.
 *
 * Стена от пола не зависит: кладка тонкой стены берётся из материала зоны
 * (`zone.material`), а он остаётся материалом постройки. Поэтому каменная
 * кухня деревянного дома остаётся в бревенчатых стенах.
 *
 * Модуль детерминирован: решение зависит только от id и подписи зоны, вида
 * постройки и её материала. Модели здесь нет.
 */

export const ROOM_FLOORS_VERSION = 'room-floors/v1'

/** Постройки из экзотического материала держат его и на полу: ледяной дворец не мостят. */
const KEEP_ARCHITECTURE = new Set(['ice', 'metal', 'sand'])

/**
 * Правила по порядку: первое совпавшее решает. `material` — что увидят
 * правила, `floor` — рисунок поверх (из `FLOOR_STYLES`).
 *
 * @type {ReadonlyArray<{test: RegExp, material: string, floor: string|null, uses?: ReadonlyArray<string>}>}
 */
const RULES = Object.freeze([
  // Камера и темница: голая земля с подстилкой.
  { test: /камер|темниц|узилищ|карцер|prison|(?<![a-z])cells?(?![a-z])/u, material: 'earth', floor: 'straw' },
  // Склеп и подземелье: истёртая кладка пола целиком — кроме камер выше.
  // Стоит раньше бытовых правил: «Погребальная» склепа — не погреб дома.
  { test: /./u, material: 'stone', floor: 'dungeon', uses: ['crypt', 'dungeon'] },
  // Конюшня, хлев, сеновал: утоптанная земля и солома.
  { test: /конюш|хлев|скотн|сеновал|stable|barn/u, material: 'earth', floor: 'straw' },
  // Кухня и кузня: камень у огня, дерево горит.
  { test: /кухн|kitchen|кузн|горн|smithy|forge/u, material: 'stone', floor: 'flagstone' },
  // Кладовая, склад, оружейная, амбар: земляной пол.
  { test: /кладов|склад|амбар|сарай|оружейн|store|armory|storehouse/u, material: 'earth', floor: null },
  // Мастерская: каменные плиты под верстаком.
  { test: /мастерск|столярн|красильн|гончарн|workshop/u, material: 'stone', floor: 'flagstone' },
  // Салон и приёмная усадьбы: мраморная шашка.
  { test: /салон|salon|приёмн|гостин|бальный/u, material: 'marble', floor: 'checker' },
  // Зал усадьбы и кабинет: паркет.
  { test: /кабинет|study|библиотек/u, material: 'wood', floor: 'parquet' },
  { test: /зал|hall|горниц|усадьб|резиденц/u, material: 'wood', floor: 'parquet', uses: ['manor'] },
  // Общий зал трактира и казарма: тёмные затёртые доски.
  { test: /зал|hall|таверн|постоял|питейн|гостев|казарм|караульн|barracks/u, material: 'wood', floor: 'planks-dark', uses: ['tavern', 'barracks'] },
  // Спальня и жильё: обычный настил.
  { test: /спальн|bedroom|горниц|жиль|дом|living/u, material: 'wood', floor: null },
  // Погреб и подвал: тёсаные плиты.
  { test: /погреб|подвал|cellar/u, material: 'stone', floor: 'flagstone' },
  // Храм: неф и алтарная выложены мозаикой.
  { test: /неф|алтар|святил|часовн|молельн|nave|altar|chapel|sanctum/u, material: 'marble', floor: 'mosaic', uses: ['temple'] },
])

/**
 * Пол помещения по назначению.
 *
 * @param {{id: string, label?: string}} zone
 * @param {{use?: string, architecture?: string}} [context]
 * @returns {{material: string, floor: string|null}|null} `null` — оставить как есть
 */
export function roomFloorFor(zone, { use = '', architecture = 'wood' } = {}) {
  if (KEEP_ARCHITECTURE.has(architecture)) return null
  const text = `${zone.id} ${zone.label ?? ''}`.toLocaleLowerCase('ru')
  for (const rule of RULES) {
    if (rule.uses && !rule.uses.includes(use)) continue
    if (!rule.test.test(text)) continue
    // В каменном и мраморном доме земляной пол кладовой — тёсаный камень:
    // глинобитный пол бывает у сруба, а не у палат.
    if (rule.material === 'earth' && rule.floor === null && architecture !== 'wood') return { material: 'stone', floor: 'flagstone' }
    return { material: rule.material, floor: rule.floor }
  }
  return null
}

/**
 * Вид кладки постройки (`zone.wall`). Сруб в городе — фахверк, каменная кузня
 * и мастерская — кирпич; остальные стены рисуются по материалу, как прежде.
 *
 * @param {{use?: string, architecture?: string, urban?: boolean}} context
 * @returns {string|null}
 */
export function buildingWallStyleFor({ use = '', architecture = 'wood', urban = false } = {}) {
  if (architecture === 'wood' && urban && ['tavern', 'manor', 'shop'].includes(use)) return 'fachwerk'
  if (architecture === 'stone' && ['smithy', 'workshop'].includes(use)) return 'brick'
  return null
}

/**
 * Красит пол помещений карты по назначению. Вызывается после `thinWalls`:
 * бывшие клетки стены к этому моменту уже стали полом комнат и красятся вместе
 * с ними. Непроходимые клетки (углы кладки, край карты) не трогаются.
 *
 * `wall` — вид кладки всех помещений постройки (`WALL_STYLES`); без него
 * стены рисуются по материалу зоны.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{use?: string, architecture?: string, wall?: string|null, defaultFloor?: {material: string, floor: string|null}|null, zones?: (zone: import('./tactical-map.mjs').TacticalZone) => boolean}} [options]
 * @returns {number} сколько помещений получили свой пол
 */
export function applyRoomFloors(map, { use = '', architecture = 'wood', wall = null, defaultFloor = null, zones = () => true } = {}) {
  /** @type {Map<string, {material: string, floor: string|null}>} */
  const chosen = new Map()
  for (const zone of map.zones) {
    if (zone.kind !== 'interior' || zone.id === 'walls' || !zones(zone)) continue
    if (wall && WALL_STYLES.includes(wall)) zone.wall = wall
    const floor = roomFloorFor(zone, { use, architecture }) ?? defaultFloor
    if (!floor) continue
    chosen.set(zone.id, floor)
    if (floor.floor && FLOOR_STYLES.includes(floor.floor)) zone.floor = floor.floor
    else delete zone.floor
  }
  if (!chosen.size) return 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    const floor = cell?.passable ? chosen.get(cell.zone) : null
    if (floor && cell && cell.material !== floor.material) setCell(map, x, y, { material: floor.material })
  }
  return chosen.size
}
