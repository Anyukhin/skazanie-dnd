// @ts-check
/**
 * Импорт карты из TaleSpire: слэб → этажи тактической карты «Сказания».
 *
 * TaleSpire — объёмный редактор: в слэбе лежат тайлы и предметы с точными
 * координатами и поворотом, но без смысла «пол», «стена», «дверь». Смысл даёт
 * производная таблица `data/talespire-assets-v1.json` (её собирает
 * `tools/build-talespire-asset-table.mjs` из установленной игры), а всё
 * остальное решает геометрия:
 *
 * 1. Экземпляр превращается в коробку в мировых координатах. У v2 — по
 *    габариту из таблицы с учётом поворота; точка экземпляра — минимальный
 *    угол повёрнутого габарита (проверено на образцах: при такой трактовке
 *    плиты пола ложатся ровно по сетке без наложений). У v1 габарит уже в слэбе.
 * 2. Пол — верхняя грань плоских плит, ступеней и полосы пола у комбинированных
 *    тайлов «стена + пол». Плита, на которой прямо лежит другая, полом не
 *    считается: это подложка.
 * 3. Этажи — по высоте пола с шагом 2,5 единицы (стена 2 + перекрытие 0,5,
 *    стандартная сборка в TaleSpire). Этаж 0 — самая людная высота: обычно это
 *    улица или первый этаж. Неровности внутри этажа становятся `elevation`.
 * 4. Тонкая стена встаёт на ребро между клетками, толстая делает клетки
 *    глухими. Дверь, окно и низкое ограждение — ребра своих типов.
 * 5. Предмет переносится, если у него есть пара в каталоге «Сказания» и он
 *    стоит на полу этого этажа; мелочь и висящее на стенах пропускаются.
 * 6. Лестница или стремянка, соединяющая соседние этажи, даёт пару переходов
 *    `stairs_up` / `stairs_down` — ровно то, что ищет `UseLevelTransition`.
 *
 * Модуль чистый и детерминированный: одинаковый слэб даёт байт-в-байт
 * одинаковые карты. Он не читает состояние кампании и ничего не коммитит —
 * этим занимается команда `ImportLocationMap` в Rules Engine.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { assetById } from './asset-registry.mjs'
import { levelLabelFor } from './level-generator.mjs'
import { countPlatforms } from './map-quality.mjs'
import { anchorCountsFor } from './scene-requirements.mjs'
import { DOORWAY_SIGHT_CELLS, cellsVisibleFrom } from './rules/tactical-geometry.mjs'
import { decodeSlab } from './talespire-slab.mjs'
import {
  MAX_LEVEL_OFFSET,
  SIZE_CLASSES,
  addProp,
  addSpawnPoint,
  addZone,
  canonicalEdge,
  cellAt,
  createTacticalMap,
  edgeBetween,
  movementStepBlocked,
  reachableCells,
  serializeTacticalMap,
  setCell,
  setDoor,
  setEdge,
  sizeClassFor,
  validateTacticalMap,
} from './tactical-map.mjs'

export const TALESPIRE_IMPORT_VERSION = '1'
export const TALESPIRE_ASSET_TABLE_FILE = fileURLToPath(new URL('../data/talespire-assets-v1.json', import.meta.url))

/** Высота этажа в единицах TaleSpire (1 единица = 5 футов = 1 клетка). */
const STOREY_HEIGHT = 2.5
/** Доля высоты этажа, на которую пол может подняться и остаться на своём этаже. */
const STOREY_TOLERANCE = 1.0
/** Высота «тела» над полом: всё, что пересекает эту полосу, мешает пройти. */
const BODY_LOW = 0.3
const BODY_HIGH = 1.8
/** Меньше этого этаж считается обрезком и не импортируется. */
const MIN_LEVEL_CELLS = 6
const MIN_MAP_SIDE = 16
const EPSILON = 0.02

/**
 * Бюджет площади исходных коробок: сумма клеток, которые обойдут
 * `coveredCells` и раскладка поверхностей (аудит PR #131, MAP-BOUNDARY-01/02).
 * Предел готовой карты (`SIZE_CLASSES`) проверяется позже, когда обход уже
 * сделан, и не спасает от слэба из десятков тысяч коробок по полсотни клеток.
 *
 * Запас: семь этажей по 100×100 — 70 тысяч клеток пола, больше импорт не
 * примет; подложки, стены и предметы добавляют к этому разы, а не порядок.
 */
export const TALESPIRE_MAX_SOURCE_CELLS = 400_000

export class TaleSpireImportError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'TaleSpireImportError'
    this.code = code
  }
}

/**
 * Строка таблицы: [вид, роль, cx, cy, cz, ex, ey, ez, материал, вид каталога, жанр набора].
 * Жанр — 'f' (фэнтези) или 's' (научная фантастика и современность).
 * @typedef {['t'|'p', string, number, number, number, number, number, number, string, string, string?]} AssetRow
 */

/**
 * @typedef {object} WorldBox
 * @property {'t'|'p'} kind
 * @property {string} role
 * @property {string} material
 * @property {string} propAsset
 * @property {string} genre 'f' или 's'
 * @property {number} rotation
 * @property {number} minX
 * @property {number} maxX
 * @property {number} minY
 * @property {number} maxY
 * @property {number} minZ
 * @property {number} maxZ
 */

/**
 * @typedef {object} Surface
 * @property {number} x
 * @property {number} z
 * @property {number} top
 * @property {number} bottom нижняя грань опоры: по ней видно, что плита лежит на другой
 * @property {string} role
 * @property {string} material
 * @property {WorldBox} box
 */

/**
 * @typedef {object} ImportedLevel
 * @property {number} index
 * @property {string} label
 * @property {Record<string, unknown>} map сериализованная карта
 */

/**
 * @typedef {object} TaleSpireImportResult
 * @property {ImportedLevel[]} levels
 * @property {ReturnType<typeof mapPassport> & { genre: 'scifi'|'fantasy', quality: ReturnType<typeof importQuality> }} passport
 * @property {Record<string, number>} stats
 * @property {string[]} warnings
 * @property {{ format: string, version: number, sha256: string, instances: number }} source
 */

/** @type {Map<string, AssetRow>|null} */
let assetTable = null

/**
 * Таблица читается один раз: файл неизменен в пределах процесса, а разбор
 * трёхсот килобайт на каждый импорт — пустая трата.
 * @returns {Map<string, AssetRow>}
 */
export function taleSpireAssetTable() {
  if (assetTable) return assetTable
  const parsed = JSON.parse(readFileSync(TALESPIRE_ASSET_TABLE_FILE, 'utf8'))
  if (parsed?.schema_version !== 1 || !parsed.assets || typeof parsed.assets !== 'object') {
    throw new TaleSpireImportError('Таблица ассетов TaleSpire повреждена', 'TALESPIRE_TABLE_INVALID')
  }
  assetTable = new Map(Object.entries(/** @type {Record<string, AssetRow>} */ (parsed.assets)))
  return assetTable
}

const overlap = (/** @type {number} */ a0, /** @type {number} */ a1, /** @type {number} */ b0, /** @type {number} */ b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
const cellKey = (/** @type {number} */ x, /** @type {number} */ z) => `${x},${z}`
const round2 = (/** @type {number} */ value) => Math.round(value * 100) / 100

/**
 * Коробки в мировых координатах. Неизвестные ассеты (пользовательские наборы,
 * свежие ассеты после обновления игры) пропускаются и считаются.
 *
 * @param {ReturnType<typeof decodeSlab>} slab
 * @param {Map<string, AssetRow>} table
 * @returns {{ boxes: WorldBox[], unknown: number }}
 */
export function worldBoxesForSlab(slab, table) {
  /** @type {WorldBox[]} */
  const boxes = []
  let unknown = 0
  for (const instance of slab.instances) {
    const row = table.get(instance.assetId)
    if (!row) {
      unknown += 1
      continue
    }
    const [kind, role, , , , ex, ey, ez, material, propAsset, genre = 'f'] = row
    /** @type {WorldBox} */
    let box
    if ('center' in instance) {
      box = {
        kind, role, material, propAsset, genre, rotation: instance.rotation,
        minX: instance.center.x - instance.extent.x, maxX: instance.center.x + instance.extent.x,
        minY: instance.center.y - instance.extent.y, maxY: instance.center.y + instance.extent.y,
        minZ: instance.center.z - instance.extent.z, maxZ: instance.center.z + instance.extent.z,
      }
    } else {
      const angle = (instance.rotation * Math.PI) / 180
      const cos = Math.abs(Math.cos(angle))
      const sin = Math.abs(Math.sin(angle))
      const halfX = cos * ex + sin * ez
      const halfZ = sin * ex + cos * ez
      box = {
        kind, role, material, propAsset, genre, rotation: instance.rotation,
        minX: instance.x, maxX: instance.x + 2 * halfX,
        minY: instance.y, maxY: instance.y + 2 * ey,
        minZ: instance.z, maxZ: instance.z + 2 * halfZ,
      }
    }
    boxes.push(box)
  }
  return { boxes, unknown }
}

/**
 * Клетки, которые коробка закрывает не меньше чем на `share` площади.
 * @param {WorldBox} box
 * @param {number} share
 * @returns {Array<{x:number, z:number}>}
 */
function coveredCells(box, share) {
  /** @type {Array<{x:number, z:number}>} */
  const cells = []
  for (let x = Math.floor(box.minX + EPSILON); x < Math.ceil(box.maxX - EPSILON); x += 1) {
    for (let z = Math.floor(box.minZ + EPSILON); z < Math.ceil(box.maxZ - EPSILON); z += 1) {
      if (overlap(box.minX, box.maxX, x, x + 1) * overlap(box.minZ, box.maxZ, z, z + 1) >= share) cells.push({ x, z })
    }
  }
  return cells
}

/**
 * Все поверхности, по которым можно ходить. Подложки под другим полом и пол,
 * над которым почти сразу лежит следующая плита, отбрасываются.
 *
 * @param {WorldBox[]} boxes
 * @returns {Map<string, Surface[]>}
 */
function walkableSurfaces(boxes) {
  /** @type {Map<string, Surface[]>} */
  const byCell = new Map()
  for (const box of boxes) {
    if (box.kind !== 't' || !['floor', 'stairs', 'wallfloor'].includes(box.role)) continue
    const top = box.role === 'wallfloor' ? Math.min(box.minY + 0.5, box.maxY) : box.maxY
    for (const cell of coveredCells(box, 0.45)) {
      const key = cellKey(cell.x, cell.z)
      const list = byCell.get(key) ?? []
      list.push({ x: cell.x, z: cell.z, top: round2(top), bottom: round2(box.minY), role: box.role, material: box.material, box })
      byCell.set(key, list)
    }
  }
  // Поверхность отбрасывается, если над ней выше EPSILON лежит другая, чья
  // нижняя грань ближе 1,2 к её верху. Прежде каждая сверялась с каждой, и
  // стопка из тысяч плит в одной клетке давала квадрат (аудит PR #131,
  // MAP-BOUNDARY-01). Теперь клетка идёт сверху вниз: для каждой поверхности
  // известна самая низкая нижняя грань среди тех, что выше неё, — правило то же.
  for (const [key, list] of byCell) {
    if (list.length < 2) continue
    const order = list.map((_, index) => index).sort((left, right) => list[right].top - list[left].top)
    /** @type {Set<number>} */
    const under = new Set()
    let lowestAbove = Infinity
    let above = 0
    for (const index of order) {
      const surface = list[index]
      while (above < order.length && list[order[above]].top > surface.top + EPSILON) {
        lowestAbove = Math.min(lowestAbove, list[order[above]].bottom)
        above += 1
      }
      if (lowestAbove < surface.top + 1.2) under.add(index)
    }
    if (under.size) byCell.set(key, list.filter((_, index) => !under.has(index)))
  }
  return byCell
}

/**
 * Охват клеток списка. Не через `Math.min(...список)`: у большого слэба в
 * списке сотни тысяч поверхностей, а число аргументов вызова упирается в стек.
 * @param {Array<{ x: number, z: number }>} cells
 */
function cellBounds(cells) {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const cell of cells) {
    if (cell.x < minX) minX = cell.x
    if (cell.x > maxX) maxX = cell.x
    if (cell.z < minZ) minZ = cell.z
    if (cell.z > maxZ) maxZ = cell.z
  }
  return { minX, maxX, minZ, maxZ }
}

/**
 * Сколько клеток обойдут коробки слэба. Считается по охвату каждой коробки —
 * тем же округлением, что у `coveredCells`, — до первого обхода.
 * @param {WorldBox[]} boxes
 */
function sourceCells(boxes) {
  let cells = 0
  for (const box of boxes) {
    const sideX = Math.ceil(box.maxX - EPSILON) - Math.floor(box.minX + EPSILON)
    const sideZ = Math.ceil(box.maxZ - EPSILON) - Math.floor(box.minZ + EPSILON)
    cells += Math.max(0, sideX) * Math.max(0, sideZ)
  }
  return cells
}

/**
 * Самая частая высота пола среди списка (по числу клеток), при равенстве — нижняя.
 * @param {number[]} tops
 * @returns {number}
 */
function modeHeight(tops) {
  /** @type {Map<number, number>} */
  const counts = new Map()
  for (const top of tops) counts.set(top, (counts.get(top) ?? 0) + 1)
  let best = tops[0] ?? 0
  let bestCount = -1
  for (const [top, count] of [...counts.entries()].sort((left, right) => left[0] - right[0])) {
    if (count > bestCount) {
      best = top
      bestCount = count
    }
  }
  return best
}

/**
 * Нулевая отметка — высота пола этажа входа.
 *
 * Высоты пола собираются в полосы от самых массовых: высота, отстоящая от
 * опоры полосы не больше чем на 0,75, — та же полоса (неровная земля, порог,
 * помост). Вход — полоса, у которой больше всего клеток на краю скопированной
 * области: улица и двор заполняют слэб до краёв, а подвал и верхние этажи — нет.
 * Площадь не годится: спальни второго этажа часто больше зала первого.
 *
 * @param {Surface[]} flat поверхности без ступеней
 * @returns {number}
 */
function entryFloorHeight(flat) {
  /** @type {Map<number, number>} */
  const weights = new Map()
  for (const surface of flat) weights.set(surface.top, (weights.get(surface.top) ?? 0) + 1)
  /** @type {Array<{ anchor: number, tops: Set<number> }>} */
  const bands = []
  for (const [top] of [...weights.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])) {
    const band = bands.find((candidate) => Math.abs(candidate.anchor - top) <= 0.75)
    if (band) band.tops.add(top)
    else bands.push({ anchor: top, tops: new Set([top]) })
  }
  const { minX, maxX, minZ, maxZ } = cellBounds(flat)
  const scored = bands.map((band) => {
    const cells = flat.filter((surface) => band.tops.has(surface.top))
    const border = cells.filter((surface) => surface.x === minX || surface.x === maxX || surface.z === minZ || surface.z === maxZ).length
    return { anchor: band.anchor, border, area: cells.length }
  })
  scored.sort((left, right) => right.border - left.border || right.area - left.area || left.anchor - right.anchor)
  return scored[0].anchor
}

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * @param {unknown} text строка слэба
 * @param {{ locationId?: string, theme?: string, levelLabels?: Record<string, string>, underground?: boolean }} [options]
 * `underground` — пещера или подземелье: открытого неба там нет, и всё, что не
 *   под крышей, всё равно помещение.
 * @returns {TaleSpireImportResult}
 */
export function importTaleSpireSlab(text, { locationId = 'talespire-import', theme = '', levelLabels = {}, underground = false } = {}) {
  const slab = decodeSlab(text)
  const { boxes, unknown } = worldBoxesForSlab(slab, taleSpireAssetTable())
  /** @type {string[]} */
  const warnings = []
  if (unknown) warnings.push(`Незнакомых ассетов: ${unknown} — это пользовательские наборы или ассеты новее таблицы; они пропущены`)
  if (!boxes.length) throw new TaleSpireImportError('В слэбе нет ни одного известного ассета TaleSpire', 'TALESPIRE_NOTHING_KNOWN')
  // Бюджет — до первого обхода клеток: размер готовой карты известен только
  // после него (аудит PR #131, MAP-BOUNDARY-01/02).
  const footprint = sourceCells(boxes)
  if (!(footprint <= TALESPIRE_MAX_SOURCE_CELLS)) {
    throw new TaleSpireImportError(`Объекты слэба покрывают ${footprint} клеток — больше предела ${TALESPIRE_MAX_SOURCE_CELLS}: скопируйте часть доски`, 'TALESPIRE_SLAB_TOO_COMPLEX')
  }

  // --- поверхности и этажи --------------------------------------------------
  const surfaces = walkableSurfaces(boxes)
  const flatTops = [...surfaces.values()].flat().filter((surface) => surface.role !== 'stairs').map((surface) => surface.top)
  if (!flatTops.length) throw new TaleSpireImportError('В слэбе нет пола: выделите область вместе с полом или землёй', 'TALESPIRE_NO_FLOOR')
  const groundTop = entryFloorHeight([...surfaces.values()].flat())
  const levelOf = (/** @type {number} */ top) => Math.floor((top - groundTop + STOREY_TOLERANCE) / STOREY_HEIGHT)

  /** @type {Map<number, Map<string, Surface>>} */
  const levelCells = new Map()
  for (const list of surfaces.values()) {
    for (const surface of list) {
      const level = levelOf(surface.top)
      const cells = levelCells.get(level) ?? new Map()
      const key = cellKey(surface.x, surface.z)
      const previous = cells.get(key)
      if (!previous || surface.top > previous.top) cells.set(key, surface)
      levelCells.set(level, cells)
    }
  }
  for (const [level, cells] of [...levelCells.entries()]) {
    if (level === 0) continue
    if (Math.abs(level) > MAX_LEVEL_OFFSET) {
      warnings.push(`Этаж ${level > 0 ? '+' : ''}${level} дальше ±${MAX_LEVEL_OFFSET} от входа — пропущен`)
      levelCells.delete(level)
    } else if (cells.size < MIN_LEVEL_CELLS) {
      levelCells.delete(level)
    }
  }
  /** @type {Map<number, number>} */
  const levelBase = new Map()
  for (const [level, cells] of levelCells) {
    const tops = [...cells.values()].filter((surface) => surface.role !== 'stairs').map((surface) => surface.top)
    levelBase.set(level, tops.length ? modeHeight(tops) : groundTop + level * STOREY_HEIGHT)
  }

  // --- общая система координат всех этажей -----------------------------------
  const allCells = [...levelCells.values()].flatMap((cells) => [...cells.values()])
  const { minX, maxX, minZ, maxZ } = cellBounds(allCells)
  const spanX = maxX - minX + 1
  const spanZ = maxZ - minZ + 1
  if (spanX > SIZE_CLASSES.region.maxWidth || spanZ > SIZE_CLASSES.region.maxHeight) {
    throw new TaleSpireImportError(`Область ${spanX}×${spanZ} клеток больше предела ${SIZE_CLASSES.region.maxWidth}×${SIZE_CLASSES.region.maxHeight}: скопируйте часть доски`, 'TALESPIRE_MAP_TOO_LARGE')
  }
  const width = Math.max(MIN_MAP_SIDE, spanX)
  const height = Math.max(MIN_MAP_SIDE, spanZ)
  const offsetX = Math.floor((width - spanX) / 2)
  const offsetY = Math.floor((height - spanZ) / 2)
  // Север вверх: ось z TaleSpire смотрит «вперёд», строки карты растут вниз.
  const toX = (/** @type {number} */ x) => x - minX + offsetX
  const toY = (/** @type {number} */ z) => maxZ - z + offsetY
  const sizeClass = sizeClassFor(width, height)
  const limits = SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (sizeClass)]
  const sourceHash = sha256(String(text)).slice(0, 16)

  /** @type {Record<string, number>} */
  const stats = {
    instances: slab.instances.length, unknown, floorCells: 0, blockedCells: 0, difficultCells: 0,
    walls: 0, doors: 0, windows: 0, rails: 0, props: 0, propsSkipped: 0, transitions: 0,
  }

  /** @type {Map<number, import('./tactical-map.mjs').TacticalMap>} */
  const maps = new Map()
  const levels = [...levelCells.keys()].sort((left, right) => left - right)
  for (const level of levels) {
    const cells = /** @type {Map<string, Surface>} */ (levelCells.get(level))
    const base = /** @type {number} */ (levelBase.get(level))
    const label = String(levelLabels[String(level)] ?? '').trim().slice(0, 60) || levelLabelFor(level)
    const map = createTacticalMap({
      width, height, locationId, levelIndex: level, levelLabel: label, theme, sizeClass,
      seed: `talespire:${sourceHash}:${level}`, generator: { id: 'talespire-slab', version: TALESPIRE_IMPORT_VERSION },
    })
    for (const surface of cells.values()) {
      const delta = surface.top - base
      const steps = Math.sign(delta) * Math.floor(Math.abs(delta) + 0.25)
      setCell(map, toX(surface.x), toY(surface.z), {
        passable: true, revealed: false, material: surface.material, elevation: Math.max(-4, Math.min(4, steps)) * 5,
      })
      stats.floorCells += 1
    }
    projectObstacles(map, boxes, cells, base, { toX, toY, limits, stats })
    maps.set(level, map)
  }

  // --- переходы между этажами ------------------------------------------------
  linkLevels(maps, levelCells, boxes, { toX, toY, levelOf, stats, warnings })
  for (const level of levels) {
    if (level === 0) continue
    const map = /** @type {import('./tactical-map.mjs').TacticalMap} */ (maps.get(level))
    if (!map.props.some((prop) => prop.transition)) {
      warnings.push(`${map.levelLabel}: нет лестницы, которая бы на него вела, — этаж пропущен`)
      maps.delete(level)
    }
  }
  // Этаж, на который вела лестница только с пропущенного этажа, тоже недостижим.
  for (const map of maps.values()) {
    map.props = map.props.filter((prop) => !prop.transition || maps.has(prop.transition.toLevel))
  }

  // --- комнаты --------------------------------------------------------------
  // Перекрытия над клетками: по ним видно, где «под крышей», а где открытое небо.
  /** @type {Map<string, number[]>} */
  const ceilings = new Map()
  for (const box of boxes) {
    if (box.kind !== 't' || !['roof', 'floor', 'wallfloor'].includes(box.role)) continue
    for (const cell of coveredCells(box, 0.4)) {
      // Дописываем в тот же список, а не копируем его: у стопки плит в одной
      // клетке копирование давало квадрат (аудит PR #131, MAP-BOUNDARY-01).
      const key = cellKey(cell.x, cell.z)
      const list = ceilings.get(key)
      if (list) list.push(box.minY)
      else ceilings.set(key, [box.minY])
    }
  }
  for (const [level, map] of maps) {
    assignRooms(map, /** @type {Map<string, Surface>} */ (levelCells.get(level)), ceilings, { toX, toY, level, underground })
    repairImportedLevel(map, stats)
  }

  // --- вход, раскрытие, проверка ---------------------------------------------
  const ground = /** @type {import('./tactical-map.mjs').TacticalMap} */ (maps.get(0))
  const entrance = chooseEntrance(ground)
  if (!entrance) throw new TaleSpireImportError('На этаже входа нет свободной клетки для отряда', 'TALESPIRE_NO_ENTRANCE')
  addSpawnPoint(ground, { id: 'talespire-entrance', x: entrance.x, y: entrance.y, role: 'party' })
  revealAround(ground, entrance)
  // Сквозь окна и открытые двери от входа видно и то, что за ними: тем же
  // правилом, что раскрывает клетки при шаге героя (`cellsVisibleFrom`).
  // Прежде дом за окном оставался чёрным провалом, хотя отряд смотрит прямо
  // в него (этап 5 `docs/map-generation-plan.md`). Закрытая дверь и стена
  // взгляд по-прежнему держат.
  for (const cell of cellsVisibleFrom(ground, entrance, { radius: DOORWAY_SIGHT_CELLS })) setCell(ground, cell.x, cell.y, { revealed: true })
  for (const map of maps.values()) {
    if (map === ground) continue
    const arrival = map.props.find((prop) => prop.transition)?.footprint[0]
    if (arrival) revealAround(map, arrival)
  }

  /** @type {ImportedLevel[]} */
  const imported = []
  for (const [level, map] of [...maps.entries()].sort((left, right) => left[0] - right[0])) {
    const check = validateTacticalMap(map)
    if (!check.ok) {
      throw new TaleSpireImportError(`Импорт собрал неверную карту (${check.errors[0]?.code}): ${check.errors[0]?.message}`, 'TALESPIRE_MAP_INVALID')
    }
    imported.push({ index: level, label: map.levelLabel || levelLabelFor(level), map: serializeTacticalMap(map) })
  }
  return {
    levels: imported,
    passport: {
      ...mapPassport([...maps.values()]),
      genre: boxes.filter((box) => box.genre === 's').length > boxes.length * 0.2 ? 'scifi' : 'fantasy',
      quality: importQuality(ground, stats),
    },
    stats,
    warnings,
    source: { format: 'talespire-slab', version: slab.version, sha256: sha256(String(text)), instances: slab.instances.length },
  }
}

/**
 * Стены, двери, глухие клетки, трудная местность и предметы одного этажа.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {WorldBox[]} boxes
 * @param {Map<string, Surface>} cells пол этого этажа
 * @param {number} base типичная высота пола этажа
 * @param {{ toX: (x:number)=>number, toY: (z:number)=>number, limits: {maxProps:number, maxWallEdges:number}, stats: Record<string, number> }} context
 */
function projectObstacles(map, boxes, cells, base, { toX, toY, limits, stats }) {
  const has = (/** @type {number} */ x, /** @type {number} */ z) => cells.has(cellKey(x, z))
  const topAt = (/** @type {number} */ x, /** @type {number} */ z) => cells.get(cellKey(x, z))?.top ?? base
  /** @type {Set<string>} */
  const blocked = new Set()
  /** @type {Set<string>} */
  const difficult = new Set()
  let wallEdges = 0

  /**
   * Ребро между мировыми клетками a и b. Хоть одна из них должна быть полом
   * этого этажа; вторая может отсутствовать — тогда стена стоит по краю карты.
   * @param {number} ax @param {number} az @param {number} bx @param {number} bz
   * @param {'wall'|'door'|'window'|'rail'|'grate'} kind
   */
  const putEdge = (ax, az, bx, bz, kind) => {
    if (!has(ax, az) && !has(bx, bz)) return
    const [x1, y1, x2, y2] = [toX(ax), toY(az), toX(bx), toY(bz)]
    const existing = map.edges[`${canonicalEdge(x1, y1, x2, y2).x},${canonicalEdge(x1, y1, x2, y2).y},${canonicalEdge(x1, y1, x2, y2).dir}`]
    if (existing && (existing.kind === 'door' || kind !== 'door')) return
    if (kind === 'door') {
      if (!has(ax, az) || !has(bx, bz)) return // дверь в никуда — просто стена
      const edge = canonicalEdge(x1, y1, x2, y2)
      setDoor(map, { id: `door-${map.doors.length + 1}`, x: edge.x, y: edge.y, dir: edge.dir, state: 'closed' })
      stats.doors += 1
      return
    }
    if (kind === 'wall' || kind === 'window') {
      if (wallEdges >= limits.maxWallEdges) return
      wallEdges += 1
    }
    if (kind === 'wall') {
      setEdge(map, x1, y1, x2, y2, { kind: 'wall' })
      stats.walls += 1
    } else if (kind === 'window') {
      setEdge(map, x1, y1, x2, y2, { kind: 'window', blocksMove: true, blocksSight: false, cover: 'half' })
      stats.windows += 1
    } else if (kind === 'grate') {
      setEdge(map, x1, y1, x2, y2, { kind: 'grate', blocksMove: true, blocksSight: false, cover: 'half' })
      stats.walls += 1
    } else {
      setEdge(map, x1, y1, x2, y2, { kind: 'rail', blocksMove: false, blocksSight: false, cover: 'half' })
      stats.rails += 1
    }
  }

  /**
   * Стена по краю участка: по тем сторонам, за которыми у этажа нет пола
   * примерно той же высоты. Так проецируются комбинированные тайлы «стена +
   * пол» и широкие угловые стены: у обоих коробка накрывает участок целиком,
   * а сама стена — лишь по наружным сторонам.
   * @param {Array<{x:number, z:number}>} footprint
   */
  const wallsAroundPatch = (footprint) => {
    const inside = new Set(footprint.map((cell) => cellKey(cell.x, cell.z)))
    for (const cell of footprint) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cell.x + dx
        const nz = cell.z + dz
        if (inside.has(cellKey(nx, nz))) continue
        if (has(nx, nz) && Math.abs(topAt(nx, nz) - topAt(cell.x, cell.z)) <= 1.0) continue
        putEdge(cell.x, cell.z, nx, nz, 'wall')
      }
    }
  }

  for (const box of boxes) {
    if (box.kind !== 't') continue
    if (box.role === 'wallfloor') {
      const footprint = coveredCells(box, 0.45).filter((cell) => has(cell.x, cell.z))
      if (!footprint.length || Math.abs(topAt(footprint[0].x, footprint[0].z) - Math.min(box.minY + 0.5, box.maxY)) > 0.3) continue
      wallsAroundPatch(footprint)
      continue
    }
    if (!['wall', 'door', 'window', 'fence'].includes(box.role)) continue
    if (overlap(box.minY, box.maxY, base + BODY_LOW, base + BODY_HIGH) < 0.25) continue
    const sizeX = box.maxX - box.minX
    const sizeZ = box.maxZ - box.minZ
    const tall = box.maxY - box.minY
    if (box.role === 'wall' && sizeX >= 1.5 && sizeZ >= 1.5 && tall >= 1.5) {
      const footprint = coveredCells(box, 0.45).filter((cell) => has(cell.x, cell.z) && Math.abs(topAt(cell.x, cell.z) - box.minY) <= 0.6)
      if (footprint.length) {
        wallsAroundPatch(footprint)
        continue
      }
    }
    const thin = Math.min(sizeX, sizeZ) <= 0.6 && Math.max(sizeX, sizeZ) >= 0.9
    if (thin) {
      const alongZ = sizeX < sizeZ
      const line = Math.round(alongZ ? (box.minX + box.maxX) / 2 : (box.minZ + box.maxZ) / 2)
      const from = Math.round(alongZ ? box.minZ : box.minX)
      const to = Math.round(alongZ ? box.maxZ : box.maxX)
      /** @type {'wall'|'door'|'window'|'rail'|'grate'} */
      const kind = box.role === 'door' ? 'door'
        : box.role === 'window' ? 'window'
          : box.role === 'fence' ? (tall <= 0.7 ? 'rail' : 'grate')
            : 'wall'
      for (let along = from; along < to; along += 1) {
        if (alongZ) putEdge(line - 1, along, line, along, kind)
        else putEdge(along, line - 1, along, line, kind)
      }
      continue
    }
    if (box.role === 'door' || box.role === 'window') continue
    for (const cell of coveredCells(box, 0.4)) {
      if (!has(cell.x, cell.z)) continue
      const top = topAt(cell.x, cell.z)
      if (box.maxY - top < 0.35 || box.minY > top + 1.5) continue
      if (box.role === 'fence' && tall <= 0.7) continue
      blocked.add(cellKey(cell.x, cell.z))
    }
  }

  // Предметы: сперва крупные, чтобы мелочь не заняла их клетки.
  const props = boxes
    .filter((box) => box.kind === 'p' && (box.role === 'prop' || box.role === 'rock'))
    .map((box) => ({ box, area: (box.maxX - box.minX) * (box.maxZ - box.minZ) }))
    .sort((left, right) => right.area - left.area || left.box.minX - right.box.minX || left.box.minZ - right.box.minZ || left.box.minY - right.box.minY)
  /** @type {Set<string>} */
  const taken = new Set()
  for (const { box, area } of props) {
    const centerX = Math.floor((box.minX + box.maxX) / 2)
    const centerZ = Math.floor((box.minZ + box.maxZ) / 2)
    if (!has(centerX, centerZ)) continue
    const top = topAt(centerX, centerZ)
    const protrude = box.maxY - top
    if (box.role === 'rock') {
      if (protrude < 0.35 || box.minY > top + 1.2) continue
      const covered = coveredCells(box, 0.4).filter((cell) => has(cell.x, cell.z))
      if (protrude < 0.9) for (const cell of covered) difficult.add(cellKey(cell.x, cell.z))
      else if (covered.length > 1) for (const cell of covered) blocked.add(cellKey(cell.x, cell.z))
      else if (covered.length === 1 && !taken.has(cellKey(covered[0].x, covered[0].z))) {
        if (placeProp(map, 'boulder', box, covered, { toX, toY, taken, blocked, limits })) stats.props += 1
      }
      continue
    }
    if (area < 0.12 || box.minY > top + 1.0 || box.minY < top - 0.6) {
      stats.propsSkipped += 1
      continue
    }
    const entry = assetById(box.propAsset)
    if (!entry) continue
    // Плоское — ковры, паутина — только если у вида каталога есть плоский вариант.
    if (protrude < 0.25 && entry.kind !== 'decal') {
      stats.propsSkipped += 1
      continue
    }
    const covered = coveredCells(box, 0.3).filter((cell) => has(cell.x, cell.z))
    if (!covered.length) covered.push({ x: centerX, z: centerZ })
    if (placeProp(map, box.propAsset, box, covered, { toX, toY, taken, blocked, limits })) stats.props += 1
    else stats.propsSkipped += 1
  }

  for (const key of blocked) {
    const [x, z] = key.split(',').map(Number)
    const cell = cellAt(map, toX(x), toY(z))
    if (!cell || !cell.passable) continue
    if (map.props.some((prop) => prop.footprint.some((spot) => spot.x === toX(x) && spot.y === toY(z)))) continue
    setCell(map, toX(x), toY(z), { passable: false })
    stats.blockedCells += 1
  }
  for (const key of difficult) {
    if (blocked.has(key)) continue
    const [x, z] = key.split(',').map(Number)
    setCell(map, toX(x), toY(z), { moveCost: 2, surface: 'rubble' })
    stats.difficultCells += 1
  }
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} assetId
 * @param {WorldBox} box
 * @param {Array<{x:number, z:number}>} covered
 * @param {{ toX: (x:number)=>number, toY: (z:number)=>number, taken: Set<string>, blocked: Set<string>, limits: {maxProps:number} }} context
 * @returns {boolean}
 */
function placeProp(map, assetId, box, covered, { toX, toY, taken, blocked, limits }) {
  if (map.props.length >= limits.maxProps) return false
  const free = covered.filter((cell) => !taken.has(cellKey(cell.x, cell.z)) && !blocked.has(cellKey(cell.x, cell.z)))
  if (!free.length) return false
  const entry = assetById(assetId)
  const blocksMove = entry?.blocksMove === true
  for (const cell of free) taken.add(cellKey(cell.x, cell.z))
  addProp(map, {
    id: `ts-${assetId}-${map.props.length + 1}`,
    assetId,
    x: round2(toX((box.minX + box.maxX) / 2)),
    // непрерывная координата: клетка z занимает [z, z+1], её строка — toY(z)
    y: round2(toY((box.minZ + box.maxZ) / 2) + 1),
    rotation: Math.round(box.rotation) % 360,
    footprint: free.map((cell) => ({ x: toX(cell.x), y: toY(cell.z) })),
    blocksMove,
    blocksSight: false,
    cover: blocksMove ? 'half' : 'none',
  })
  return true
}

/**
 * Пары переходов между соседними этажами. Лестница TaleSpire — связная цепочка
 * ступеней; её ступени сами расходятся по этажам по высоте. Нижняя пара — самая
 * высокая ступень нижнего этажа, верхняя — самая низкая ступень верхнего (или
 * ближайший к верху лестницы пол, если ступени до верхнего этажа не дошли).
 * Стремянка (предмет) работает так же: её низ и верх — две высоты.
 *
 * @param {Map<number, import('./tactical-map.mjs').TacticalMap>} maps
 * @param {Map<number, Map<string, Surface>>} levelCells
 * @param {WorldBox[]} boxes
 * @param {{ toX: (x:number)=>number, toY: (z:number)=>number, levelOf: (top:number)=>number, stats: Record<string, number>, warnings: string[] }} context
 */
function linkLevels(maps, levelCells, boxes, { toX, toY, levelOf, stats }) {
  /** @type {Array<{ low: {level:number, x:number, z:number}, high: {level:number, x:number, z:number} }>} */
  const links = []

  // 1. Цепочки ступеней
  /** @type {Map<string, Surface>} */
  const steps = new Map()
  for (const [level, cells] of levelCells) {
    for (const surface of cells.values()) {
      if (surface.role === 'stairs') steps.set(`${level}:${cellKey(surface.x, surface.z)}`, surface)
    }
  }
  /** @type {Set<string>} */
  const seen = new Set()
  // Соседи ступени ищутся по ключу, а не перебором всех ступеней: поле из
  // тысяч ступеней давало квадрат (аудит PR #131, MAP-BOUNDARY-01). Порядок
  // прежний — порядок вставки в `steps`: от него зависит, какая из равных по
  // высоте ступеней станет нижней или верхней парой перехода.
  const position = new Map([...steps.keys()].map((key, index) => [key, index]))
  const stepLevels = [...levelCells.keys()]
  for (const [key, start] of steps) {
    if (seen.has(key)) continue
    /** @type {Array<Surface & {level:number}>} */
    const run = []
    const queue = [start]
    seen.add(key)
    for (let head = 0; head < queue.length; head += 1) {
      const surface = queue[head]
      run.push({ ...surface, level: levelOf(surface.top) })
      /** @type {string[]} */
      const near = []
      for (const level of stepLevels) {
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            const otherKey = `${level}:${cellKey(surface.x + dx, surface.z + dz)}`
            const other = steps.get(otherKey)
            if (!other || seen.has(otherKey)) continue
            if (Math.abs(other.top - surface.top) > 1.01) continue
            near.push(otherKey)
          }
        }
      }
      near.sort((left, right) => /** @type {number} */ (position.get(left)) - /** @type {number} */ (position.get(right)))
      for (const otherKey of near) {
        seen.add(otherKey)
        queue.push(/** @type {Surface} */ (steps.get(otherKey)))
      }
    }
    const levelsInRun = [...new Set(run.map((step) => step.level))].sort((left, right) => left - right)
    const lowest = levelsInRun[0]
    const highestStep = run.reduce((best, step) => (step.top > best.top ? step : best), run[0])
    for (let level = lowest; level <= levelsInRun[levelsInRun.length - 1]; level += 1) {
      const upper = level + 1
      if (!levelCells.has(level) || !levelCells.has(upper)) continue
      const lowSteps = run.filter((step) => step.level === level)
      if (!lowSteps.length) continue
      const low = lowSteps.reduce((best, step) => (step.top > best.top ? step : best), lowSteps[0])
      const highSteps = run.filter((step) => step.level === upper)
      /** @type {{x:number, z:number}|null} */
      let high = highSteps.length ? highSteps.reduce((best, step) => (step.top < best.top ? step : best), highSteps[0]) : null
      if (!high) high = nearestFloor(/** @type {Map<string, Surface>} */ (levelCells.get(upper)), highestStep.x, highestStep.z)
      if (high) links.push({ low: { level, x: low.x, z: low.z }, high: { level: upper, x: high.x, z: high.z } })
    }
  }

  // 2. Стремянки
  for (const box of boxes) {
    if (box.kind !== 'p' || box.role !== 'ladder') continue
    const x = Math.floor((box.minX + box.maxX) / 2)
    const z = Math.floor((box.minZ + box.maxZ) / 2)
    const lowLevel = levelOf(box.minY)
    const highLevel = levelOf(box.maxY + 0.3)
    if (highLevel !== lowLevel + 1 || !levelCells.has(lowLevel) || !levelCells.has(highLevel)) continue
    const low = nearestFloor(/** @type {Map<string, Surface>} */ (levelCells.get(lowLevel)), x, z)
    const high = nearestFloor(/** @type {Map<string, Surface>} */ (levelCells.get(highLevel)), x, z)
    if (low && high) links.push({ low: { level: lowLevel, x: low.x, z: low.z }, high: { level: highLevel, x: high.x, z: high.z } })
  }

  // Занятые предметами клетки каждого этажа собираются один раз и дополняются
  // поставленными лестницами. Прежде `freeSpot` пересобирал их на каждый
  // переход, и поле одиночных ступеней давало квадрат (аудит PR #131,
  // MAP-BOUNDARY-01).
  /** @type {Map<import('./tactical-map.mjs').TacticalMap, Set<string>>} */
  const occupiedOn = new Map()
  const occupied = (/** @type {import('./tactical-map.mjs').TacticalMap} */ map) => {
    let cells = occupiedOn.get(map)
    if (!cells) {
      cells = new Set(map.props.flatMap((prop) => prop.footprint.map((cell) => `${cell.x},${cell.y}`)))
      occupiedOn.set(map, cells)
    }
    return cells
  }
  for (const link of links) {
    const lowMap = maps.get(link.low.level)
    const highMap = maps.get(link.high.level)
    if (!lowMap || !highMap) continue
    const lowSpot = freeSpot(lowMap, toX(link.low.x), toY(link.low.z), occupied(lowMap))
    const highSpot = freeSpot(highMap, toX(link.high.x), toY(link.high.z), occupied(highMap))
    if (!lowSpot || !highSpot) continue
    const up = addProp(lowMap, {
      id: `ts-stairs-up-${lowMap.props.length + 1}`, assetId: 'stairs_up', x: lowSpot.x + 0.5, y: lowSpot.y + 0.5,
      footprint: [lowSpot], blocksMove: false, blocksSight: false, cover: 'none', interactive: true,
      transition: { toLevel: link.high.level, label: highMap.levelLabel || levelLabelFor(link.high.level) },
    })
    const down = addProp(highMap, {
      id: `ts-stairs-down-${highMap.props.length + 1}`, assetId: 'stairs_down', x: highSpot.x + 0.5, y: highSpot.y + 0.5,
      footprint: [highSpot], blocksMove: false, blocksSight: false, cover: 'none', interactive: true,
      transition: { toLevel: link.low.level, label: lowMap.levelLabel || levelLabelFor(link.low.level) },
    })
    for (const cell of up.footprint) occupied(lowMap).add(`${cell.x},${cell.y}`)
    for (const cell of down.footprint) occupied(highMap).add(`${cell.x},${cell.y}`)
    stats.transitions += 1
  }
}

/**
 * @param {Map<string, Surface>} cells
 * @param {number} x
 * @param {number} z
 * @returns {Surface|null}
 */
function nearestFloor(cells, x, z) {
  let best = null
  let bestDistance = 2.5
  for (const surface of cells.values()) {
    const distance = Math.hypot(surface.x - x, surface.z - z)
    if (distance < bestDistance - EPSILON) {
      best = surface
      bestDistance = distance
    }
  }
  return best
}

/**
 * Свободная проходимая клетка для лестницы: сама точка или ближайшая соседняя.
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @param {Set<string>} occupied клетки под предметами этажа
 * @returns {{x:number, y:number}|null}
 */
function freeSpot(map, x, y, occupied) {
  for (let radius = 0; radius <= 2; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const cell = cellAt(map, x + dx, y + dy)
        if (cell?.passable && !occupied.has(`${x + dx},${y + dy}`)) return { x: x + dx, y: y + dy }
      }
    }
  }
  return null
}

/**
 * Вход на этаж: клетка самой большой связной области у края карты, ближайшая
 * к середине нижнего (южного) края — отряд «подходит снизу».
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {{x:number, y:number}|null}
 */
function chooseEntrance(map) {
  const occupied = new Set(map.props.filter((prop) => prop.blocksMove).flatMap((prop) => prop.footprint.map((cell) => `${cell.x},${cell.y}`)))
  /** @type {Array<{x:number, y:number}>} */
  const open = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (cellAt(map, x, y)?.passable && !occupied.has(`${x},${y}`)) open.push({ x, y })
    }
  }
  if (!open.length) return null
  /** @type {Set<string>} */
  const visited = new Set()
  /** @type {Set<string>} */
  let largest = new Set()
  for (const cell of open) {
    if (visited.has(`${cell.x},${cell.y}`)) continue
    const region = reachableCells(map, cell.x, cell.y, { throughDoors: true, blockedCells: occupied })
    for (const key of region) visited.add(key)
    if (region.size > largest.size) largest = region
  }
  const middle = (map.bounds.minX + map.bounds.maxX) / 2
  const border = open.filter((cell) => largest.has(`${cell.x},${cell.y}`))
  border.sort((left, right) => (right.y - left.y) || (Math.abs(left.x - middle) - Math.abs(right.x - middle)) || (left.x - right.x))
  return border[0] ?? null
}

/**
 * Раскрывает область, видимую с точки без открывания дверей.
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{x:number, y:number}} from
 */
function revealAround(map, from) {
  for (const key of reachableCells(map, from.x, from.y, { throughDoors: false })) {
    const [x, y] = key.split(',').map(Number)
    setCell(map, x, y, { revealed: true })
  }
  setCell(map, from.x, from.y, { revealed: true })
}

// --- комнаты и паспорт карты ---------------------------------------------------

/** Сколько комнат на этаже получает подпись; остальное — коридоры и закутки. */
const MAX_ROOMS = 60
const MIN_ROOM_CELLS = 4

/**
 * Подпись комнаты по её обстановке. Порядок — от самого узнаваемого признака:
 * стойка и столы делают зал залом, даже если в углу стоят бочки.
 *
 * @param {Record<string, number>} props счёт видов каталога в комнате
 * @param {{ cells: number, interior: boolean, level: number, material: string, underground?: boolean }} room
 * @returns {string}
 */
export function roomLabelFor(props, room) {
  const count = (/** @type {string[]} */ ...ids) => ids.reduce((sum, id) => sum + (props[id] ?? 0), 0)
  const seats = count('chair', 'stool', 'bench')
  const tables = count('table_round', 'table_long', 'table_small')
  // Один декоративный череп склепом комнату не делает: нужна гробница, ниша
  // или несколько могил и костей.
  const burial = count('sarcophagus', 'crypt_niche') >= 1 || count('grave') >= 2 || count('bone_pile', 'grave') >= 3
  if (!room.interior) {
    if (count('market_stall') >= 2) return 'Торговые ряды'
    if (count('grave', 'sarcophagus') >= 3) return 'Кладбище'
    if (room.level < 0 || (room.material === 'earth' && count('stalagmite', 'mushroom_cluster') > 0)) return 'Пещера'
    if (count('tree_oak', 'tree_pine', 'tree_birch', 'tree_dead', 'tree_spruce') >= 4) return 'Роща'
    if (count('campfire', 'woodpile') >= 1 && room.cells < 400) return 'Стоянка'
    if (room.cells < 120) return 'Двор'
    // Большое открытое место называется по земле: мощёное — улица, остальное — по природе.
    return { grass: 'Поляна', sand: 'Пески', ice: 'Снега', earth: 'Открытое место' }[room.material] ?? 'Улица'
  }
  if (room.underground) {
    if (burial) return 'Склеп'
    if (count('altar', 'statue', 'reliquary') >= 1) return 'Святилище'
    if (count('bed', 'bunk_bed') >= 1) return 'Логово'
    return room.material === 'earth' || room.material === 'grass' ? 'Пещера' : 'Подземелье'
  }
  if (count('bar_counter') > 0 || (tables >= 2 && seats >= 3)) return 'Общий зал'
  if (count('royal_throne') > 0) return 'Тронный зал'
  if (count('altar', 'prayer_bench', 'reliquary', 'statue') >= 1 && count('bed', 'bunk_bed') === 0) return 'Святилище'
  if (burial) return 'Склеп'
  if (count('bunk_bed') >= 2) return 'Казарма'
  if (count('bed', 'bunk_bed') >= 3) return 'Спальни'
  if (count('bed', 'bunk_bed') >= 1) return 'Спальня'
  if (count('fireplace', 'cauldron', 'pot', 'cutting_board') >= 1 && tables + count('cupboard') >= 1) return 'Кухня'
  if (count('market_stall') >= 1) return 'Лавка'
  if (count('bookshelf') >= 2) return 'Библиотека'
  if (count('barrel', 'barrel_stack', 'keg', 'crate', 'crate_stack', 'sack') >= 3) return room.level < 0 ? 'Погреб' : 'Кладовая'
  if (room.level < 0) return room.material === 'earth' ? 'Пещера' : 'Подземелье'
  return room.cells >= 40 ? 'Зал' : room.cells <= 8 ? 'Коридор' : 'Комната'
}

/**
 * Делит этаж на комнаты и записывает их зонами карты. Комната — связная
 * область проходимого пола, которую режут стены, двери и граница «под крышей /
 * под открытым небом». Зоны с подписями читает контекст Рассказчика и NPC
 * (`sceneContextForAgent`), поэтому описание места следует карте.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Map<string, Surface>} cells пол этажа в мировых координатах
 * @param {Map<string, number[]>} ceilings нижние грани перекрытий над клетками
 * @param {{ toX: (x:number)=>number, toY: (z:number)=>number, level: number, underground?: boolean }} context
 */
function assignRooms(map, cells, ceilings, { toX, toY, level, underground = false }) {
  /** @type {Map<string, { covered: boolean, material: string }>} */
  const byMapCell = new Map()
  for (const surface of cells.values()) {
    const above = ceilings.get(cellKey(surface.x, surface.z)) ?? []
    const covered = above.some((bottom) => bottom >= surface.top + 1.4 && bottom <= surface.top + 7.5)
    byMapCell.set(`${toX(surface.x)},${toY(surface.z)}`, { covered, material: surface.material })
  }
  /** @type {Map<string, Record<string, number>>} */
  const propsAt = new Map()
  for (const prop of map.props) {
    if (prop.transition) continue
    for (const spot of prop.footprint.slice(0, 1)) {
      const key = `${spot.x},${spot.y}`
      const counts = propsAt.get(key) ?? {}
      counts[prop.assetId] = (counts[prop.assetId] ?? 0) + 1
      propsAt.set(key, counts)
    }
  }
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Array<{ keys: string[], covered: boolean, closed: number, open: number, materials: Record<string, number> }>} */
  const components = []
  for (const [start, info] of [...byMapCell.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (seen.has(start)) continue
    const [sx, sy] = start.split(',').map(Number)
    if (!cellAt(map, sx, sy)?.passable) continue
    /** @type {string[]} */
    const keys = []
    /** @type {Record<string, number>} */
    const materials = {}
    // Стороны границы комнаты: закрытые (стена, дверь, окно, глухая клетка) и
    // открытые в пустоту. Подземелье в TaleSpire обычно без потолка, и только
    // замкнутость отличает его зал от улицы.
    let closed = 0
    let open = 0
    const queue = [start]
    seen.add(start)
    while (queue.length) {
      const key = /** @type {string} */ (queue.pop())
      keys.push(key)
      const [x, y] = key.split(',').map(Number)
      const own = /** @type {{covered:boolean, material:string}} */ (byMapCell.get(key))
      materials[own.material] = (materials[own.material] ?? 0) + 1
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = `${x + dx},${y + dy}`
        const neighbourCell = cellAt(map, x + dx, y + dy)
        const walled = movementStepBlocked(map, x, y, x + dx, y + dy) || Boolean(edgeBetween(map, x, y, x + dx, y + dy))
        if (walled || (neighbourCell && !neighbourCell.passable)) closed += 1
        else if (!neighbourCell) open += 1
        if (seen.has(next)) continue
        const neighbour = byMapCell.get(next)
        if (!neighbour || neighbour.covered !== info.covered || !neighbourCell?.passable) continue
        if (movementStepBlocked(map, x, y, x + dx, y + dy)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    components.push({ keys, covered: info.covered, closed, open, materials })
  }
  components.sort((left, right) => right.keys.length - left.keys.length || left.keys[0].localeCompare(right.keys[0]))
  /** @type {Map<string, number>} */
  const usedLabels = new Map()
  for (const [index, component] of components.filter((entry) => entry.keys.length >= MIN_ROOM_CELLS).slice(0, MAX_ROOMS).entries()) {
    /** @type {Record<string, number>} */
    const props = {}
    for (const key of component.keys) for (const [id, amount] of Object.entries(propsAt.get(key) ?? {})) props[id] = (props[id] ?? 0) + amount
    const material = Object.entries(component.materials).sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'stone'
    const interior = underground || component.covered || component.closed >= 0.6 * Math.max(1, component.closed + component.open)
    const base = roomLabelFor(props, { cells: component.keys.length, interior, level, material, underground })
    const seenBefore = usedLabels.get(base) ?? 0
    usedLabels.set(base, seenBefore + 1)
    const label = seenBefore ? `${base} ${seenBefore + 1}` : base
    const id = `room-${index + 1}`
    addZone(map, {
      id, kind: interior ? 'interior' : 'exterior', material,
      lightLevel: interior ? (level < 0 || !component.covered ? 'dark' : 'dim') : 'bright', label,
    })
    for (const key of component.keys) {
      const [x, y] = key.split(',').map(Number)
      setCell(map, x, y, { zone: id })
    }
  }
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: map.zones.filter((zone) => zone.kind === 'interior' && zone.label).map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }
}

/** @param {string[]} items */
function listRu(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`
}

const LEVEL_WORDS = /** @type {Record<string, string>} */ ({ 1: 'одноэтажное', 2: 'двухэтажное', 3: 'трёхэтажное', 4: 'четырёхэтажное' })

/**
 * Паспорт карты: что на ней есть, словами и признаками. Считается по готовым
 * этажам без модели. По признакам библиотека подбирает карту под сцену, по
 * сводке ведущий и Рассказчик понимают, какое это место.
 *
 * @param {import('./tactical-map.mjs').TacticalMap[]} maps
 */
export function mapPassport(maps) {
  /** @type {Set<string>} */
  const features = new Set()
  /** @type {Record<string, number>} */
  const props = {}
  /** @type {Record<string, number>} */
  const materials = {}
  let interiorCells = 0
  let floorCells = 0
  let doors = 0
  let windows = 0
  /** @type {Array<{ index: number, label: string, cells: number, rooms: string[] }>} */
  const levels = []
  for (const map of [...maps].sort((left, right) => left.levelIndex - right.levelIndex)) {
    for (const prop of map.props) if (!prop.transition) props[prop.assetId] = (props[prop.assetId] ?? 0) + 1
    doors += map.doors.length
    windows += Object.values(map.edges).filter((edge) => edge.kind === 'window').length
    let cells = 0
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const cell = cellAt(map, x, y)
        if (!cell) continue
        cells += 1
        materials[cell.material] = (materials[cell.material] ?? 0) + 1
        const zone = cell.zone ? map.zones.find((entry) => entry.id === cell.zone) : null
        if (zone?.kind === 'interior') interiorCells += 1
      }
    }
    floorCells += cells
    levels.push({ index: map.levelIndex, label: map.levelLabel, cells, rooms: map.zones.filter((zone) => zone.label).map((zone) => zone.label) })
    if (map.levelIndex < 0) features.add('cellar')
    if (map.levelIndex > 0) features.add('upstairs')
  }
  const rooms = levels.flatMap((level) => level.rooms.map((room) => room.replace(/ \d+$/u, '')))
  const has = (/** @type {string} */ label) => rooms.includes(label)
  /** @type {Array<[string, boolean]>} */
  const checks = [
    ['common_room', has('Общий зал')], ['bedrooms', has('Спальня') || has('Спальни') || has('Казарма')],
    ['kitchen', has('Кухня')], ['storage', has('Кладовая') || has('Погреб')], ['shrine', has('Святилище')],
    ['crypt', has('Склеп') || has('Кладбище')], ['library', has('Библиотека')], ['shop', has('Лавка') || has('Торговые ряды')],
    ['throne', has('Тронный зал')], ['barracks', has('Казарма')], ['cave', has('Пещера') || has('Логово')], ['underground', has('Подземелье')],
    ['yard', has('Двор')], ['street', has('Улица')], ['grove', has('Роща') || has('Поляна')], ['camp', has('Стоянка')],
    ['doors', doors > 0], ['windows', windows > 0],
  ]
  for (const [feature, present] of checks) if (present) features.add(feature)
  // Паспорт якорей (этап 5 `docs/map-generation-plan.md`): виды словаря
  // программы сцены на этаже входа — по всем его предметам и настилам, а не по
  // двадцати частым из `props`. По нему библиотека сверяет обещанное сценой.
  const entryMap = maps.find((map) => map.levelIndex === 0) ?? maps[0]
  /** @type {Record<string, number>} */
  const entryProps = {}
  for (const prop of entryMap?.props ?? []) if (!prop.transition) entryProps[prop.assetId] = (entryProps[prop.assetId] ?? 0) + 1
  const anchors = entryMap ? anchorCountsFor(entryProps, { platform: countPlatforms(entryMap) }) : {}
  const interiorShare = floorCells ? interiorCells / floorCells : 0
  features.add(interiorShare >= 0.5 ? 'interior' : 'exterior')
  const dominantMaterial = Object.entries(materials).sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'stone'

  const lower = (/** @type {string} */ room) => room.replace(/ \d+$/u, '').toLocaleLowerCase('ru')
  const ground = levels.find((level) => level.index === 0) ?? levels[0]
  const notable = [...new Set((ground?.rooms ?? []).map(lower))].slice(0, 5)
  const above = [...new Set(levels.filter((level) => level.index > 0).flatMap((level) => level.rooms).map(lower))].slice(0, 4)
  const below = [...new Set(levels.filter((level) => level.index < 0).flatMap((level) => level.rooms).map(lower))].slice(0, 4)
  const storeys = levels.filter((level) => level.index >= 0).length
  const parts = [
    interiorShare >= 0.3 ? `${LEVEL_WORDS[storeys] ?? `${storeys}-этажное`} строение` : 'открытая местность',
    notable.length ? `внизу: ${listRu(notable)}` : '',
    above.length ? `наверху: ${listRu(above)}` : '',
    below.length ? `под землёй: ${listRu(below)}` : '',
  ].filter(Boolean)
  const summary = `${parts.join('; ')}.`
  return {
    version: 2,
    summary: summary.charAt(0).toLocaleUpperCase('ru') + summary.slice(1),
    features: [...features].sort(),
    levels,
    width: maps[0]?.width ?? 0,
    height: maps[0]?.height ?? 0,
    floor_cells: floorCells,
    interior_share: Math.round(interiorShare * 100) / 100,
    material: dominantMaterial,
    doors,
    windows,
    props: Object.fromEntries(Object.entries(props).sort((left, right) => right[1] - left[1]).slice(0, 20)),
    anchors,
  }
}

/**
 * Оценка качества импорта: досягаема ли суша этажа входа и сколько ассетов
 * пришлось отбросить. Карта ниже порога `MIN_LIBRARY_QUALITY`
 * (`server/map-library.mjs`) в автоподбор не идёт — только в ручной импорт
 * ведущего, где он видит её сам.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} ground этаж входа
 * @param {Record<string, number>} stats счётчики импорта
 * @returns {{ score: number, reachable: number, dropped: number, cells: number }}
 */
export function importQuality(ground, stats) {
  /** @type {Set<string>} */
  const blocked = new Set()
  for (const prop of ground.props) {
    if (!prop.blocksMove || prop.mount) continue
    for (const point of prop.footprint) blocked.add(cellKey(point.x, point.y))
  }
  const party = ground.spawnPoints.find((point) => point.role === 'party')
  const reached = party ? reachableCells(ground, party.x, party.y, { blockedCells: blocked }) : new Set()
  let land = 0
  let reachable = 0
  for (let y = 0; y < ground.height; y += 1) for (let x = 0; x < ground.width; x += 1) {
    const cell = cellAt(ground, x, y)
    if (!cell?.passable || cell.surface === 'water' || blocked.has(cellKey(x, y))) continue
    land += 1
    if (reached.has(cellKey(x, y))) reachable += 1
  }
  const reachableShare = land ? reachable / land : 0
  // Отброшенное — незнакомые ассеты и предметы, которые некуда было поставить.
  const dropped = Math.min(1, ((Number(stats.unknown) || 0) + (Number(stats.propsSkipped) || 0)) / Math.max(1, Number(stats.instances) || 1))
  const round = (/** @type {number} */ value) => Math.round(value * 100) / 100
  return {
    score: round(reachableShare * (1 - Math.min(0.5, dropped))),
    reachable: round(reachableShare),
    dropped: round(dropped),
    cells: land,
  }
}

/** Наибольший шаг между соседними клетками без лазания, в футах. */
const IMPORT_STEP_FEET = 3

/** Островок выше этой площади не замуровывается, даже если к нему нет подхода. */
const SEALED_ISLAND_CELLS = 8

/**
 * Перепады и края этажа после импорта (этап 5):
 *
 * - пол, поднятый над соседним больше чем на три фута без лестницы,
 *   получает пандус — одну клетку посередине высоты, если перепад не больше
 *   шести футов; при большем перепаде маленький островок становится глухим,
 *   чтобы карта не обещала площадку, на которую не подняться;
 * - предмет на крайней клетке сдвигается на клетку внутрь, а если там занято —
 *   убирается: на краю доски его не видно и к нему не подойти.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Record<string, number>} stats
 */
export function repairImportedLevel(map, stats) {
  const free = (/** @type {number} */ x, /** @type {number} */ y) => {
    const cell = cellAt(map, x, y)
    return Boolean(cell?.passable) && cell?.surface !== 'water'
  }
  const level = (/** @type {number} */ x, /** @type {number} */ y) => cellAt(map, x, y)?.elevation ?? 0
  const propCells = () => new Set(map.props.flatMap((prop) => prop.footprint.map((point) => cellKey(point.x, point.y))))
  for (let pass = 0; pass < 12; pass += 1) {
    // Связные площадки: соседи с шагом не больше трёх футов.
    /** @type {Map<string, number>} */
    const component = new Map()
    /** @type {Array<string[]>} */
    const components = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      if (!free(x, y) || component.has(cellKey(x, y))) continue
      const id = components.length
      const queue = [cellKey(x, y)]
      component.set(queue[0], id)
      for (let index = 0; index < queue.length; index += 1) {
        const [cx, cy] = queue[index].split(',').map(Number)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const key = cellKey(cx + dx, cy + dy)
          if (component.has(key) || !free(cx + dx, cy + dy) || Math.abs(level(cx + dx, cy + dy) - level(cx, cy)) > IMPORT_STEP_FEET) continue
          if (edgeBetween(map, cx, cy, cx + dx, cy + dy)?.blocksMove) continue
          component.set(key, id)
          queue.push(key)
        }
      }
      components.push(queue)
    }
    if (components.length < 2) break
    const largest = components.reduce((best, cells, id) => (cells.length > components[best].length ? id : best), 0)
    const occupied = propCells()
    let changed = false
    for (const [id, cells] of components.entries()) {
      if (id === largest) continue
      // Ближайший шов с главной площадкой — самый низкий перепад через ребро без стены.
      /** @type {{ x: number, y: number, other: { x: number, y: number }, diff: number }|null} */
      let seam = null
      for (const key of cells) {
        const [x, y] = key.split(',').map(Number)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const other = { x: x + dx, y: y + dy }
          if (!free(other.x, other.y) || component.get(cellKey(other.x, other.y)) === id) continue
          if (edgeBetween(map, x, y, other.x, other.y)?.blocksMove) continue
          const diff = Math.abs(level(x, y) - level(other.x, other.y))
          if (!seam || diff < seam.diff) seam = { x, y, other, diff }
        }
      }
      if (!seam) continue
      if (seam.diff <= IMPORT_STEP_FEET * 2) {
        const middle = Math.round((level(seam.x, seam.y) + level(seam.other.x, seam.other.y)) / 2)
        // Пандус — на той стороне шва, где клетка свободна от предметов.
        const spot = [seam.other, { x: seam.x, y: seam.y }].find((point) => !occupied.has(cellKey(point.x, point.y)))
        if (spot) {
          setCell(map, spot.x, spot.y, { elevation: middle })
          stats.ramps = (Number(stats.ramps) || 0) + 1
          changed = true
        }
      } else if (cells.length <= SEALED_ISLAND_CELLS && !cells.some((key) => occupied.has(key))) {
        for (const key of cells) {
          const [x, y] = key.split(',').map(Number)
          setCell(map, x, y, { passable: false })
        }
        stats.sealedCells = (Number(stats.sealedCells) || 0) + cells.length
        changed = true
      }
    }
    if (!changed) break
  }

  // Предметы на крайних клетках: внутрь на клетку или прочь.
  const edge = (/** @type {{x: number, y: number}} */ point) => point.x <= 0 || point.y <= 0 || point.x >= map.width - 1 || point.y >= map.height - 1
  for (const prop of [...map.props]) {
    if (prop.transition || !prop.footprint.some(edge)) continue
    const others = new Set(map.props.filter((other) => other !== prop).flatMap((other) => other.footprint.map((point) => cellKey(point.x, point.y))))
    const shift = {
      x: prop.footprint.some((point) => point.x <= 0) ? 1 : prop.footprint.some((point) => point.x >= map.width - 1) ? -1 : 0,
      y: prop.footprint.some((point) => point.y <= 0) ? 1 : prop.footprint.some((point) => point.y >= map.height - 1) ? -1 : 0,
    }
    const moved = prop.footprint.map((point) => ({ x: point.x + shift.x, y: point.y + shift.y }))
    if (moved.every((point) => !edge(point) && free(point.x, point.y) && !others.has(cellKey(point.x, point.y)))) {
      prop.footprint = moved
      prop.x += shift.x
      prop.y += shift.y
      stats.edgePropsMoved = (Number(stats.edgePropsMoved) || 0) + 1
    } else {
      map.props = map.props.filter((candidate) => candidate !== prop)
      stats.edgePropsDropped = (Number(stats.edgePropsDropped) || 0) + 1
    }
  }
}
