import type {
  TacticalCell, TacticalDoorState, TacticalEdge, TacticalEdgeKind, TacticalMap, TacticalMaterial,
  TacticalProp, TacticalSurface,
} from './types'
import { cellAt, doorStates, edgeList, edgeNeighbor, revealedAt } from './tactical-map-client'

/**
 * Чистая отрисовка тактической доски. Модуль ничего не знает ни о React, ни о
 * состоянии кампании: он получает карту, палитру и контекст рисования.
 * Именно поэтому порядок слоёв, отбор тайлов, уровни детализации и путь без
 * арта проверяются тестами на поддельном контексте.
 *
 * Порядок слоёв снизу вверх (`docs/tactical-map-plan.md`, раздел 7):
 * фон зоны → тайлы пола → декали → сегменты стен по рёбрам → предметы →
 * сетка 5 футов → туман войны. Фишки и интерактив живут в DOM поверх холста.
 */

/** Сторона тайла кэша местности в клетках. */
export const TILE_CELLS = 16

/**
 * Уровни детализации предметов (`docs/tactical-map-plan.md`, раздел 7). Порог
 * задаётся размером клетки в пикселях, потому что читается именно он: предмет
 * занимает от половины клетки до нескольких клеток.
 *
 * Ниже `PROP_MIN_CELL_PIXELS` весь предмет — десяток точек, и узнать в нём
 * бочку или стул нельзя ни при какой прорисовке. Но **исчезать он не должен**:
 * при сильном отдалении игрок смотрит на общий план и обязан видеть, где
 * заставлено, а где пусто. Поэтому нижний уровень рисует метку — залитое пятно
 * по габариту предмета, не меньше двух пикселей.
 *
 * Между порогами рисуется один силуэт характерной формы. Детали внутри
 * рисунка — обручи бочки, полки шкафа, доски стола — занимают около одной
 * седьмой его размера: при клетке в 20 px это меньше трёх точек, они сливаются
 * в грязь и стоят лишних вызовов. С 22 px деталь уже различима, и рисунок
 * выводится целиком.
 */
export const PROP_MIN_CELL_PIXELS = 12
export const PROP_FULL_DETAIL_CELL_PIXELS = 22

/**
 * Доля футпринта, которую занимает рисунок. Остаток — зазор: без него соседние
 * предметы сливаются в сплошное пятно. У предмета 1×1 это даёт прежний радиус
 * в 0.42 клетки, поэтому мелкая мебель выглядит как раньше.
 */
export const PROP_FOOTPRINT_FILL = 0.84

/**
 * Прозрачность декалей. Ковёр, тропа и пятно лежат на полу, а не поверх него,
 * поэтому сквозь них обязан читаться материал клетки.
 */
export const PROP_DECAL_ALPHA = 0.82

/** Толщина сегмента стены — около одной шестой клетки. */
export const WALL_THICKNESS_RATIO = 1 / 6

/** Предел кэша тайлов: без него панорамирование большой карты растит его без границ. */
export const DEFAULT_TILE_CACHE_LIMIT = 64

/**
 * Подмножество 2D-контекста, которым пользуется отрисовка. Отдельный тип нужен
 * ради тестируемости: и `CanvasRenderingContext2D`, и `OffscreenCanvasRenderingContext2D`,
 * и поддельный контекст, записывающий вызовы, подходят под него одинаково.
 */
export type BoardContext2D = {
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
  stroke(): void
  fillRect(x: number, y: number, width: number, height: number): void
  strokeRect(x: number, y: number, width: number, height: number): void
  clearRect(x: number, y: number, width: number, height: number): void
  setLineDash(segments: number[]): void
  drawImage(image: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  lineWidth: number
  globalAlpha: number
  globalCompositeOperation: GlobalCompositeOperation
}

/** Растровая текстура: размеры нужны, чтобы вырезать окно по варианту тайла. */
export type BoardTexture = { image: CanvasImageSource; width: number; height: number }

export type BoardPalette = {
  floor: string
  floorAlt: string
  wall: string
  gridLine: string
  door: string
  doorFrame: string
  window: string
  rail: string
  ledge: string
  lock: string
  prop: string
  propAccent: string
  foliage: string
  foliageLight: string
  fog: string
  zoneInterior: string
  zoneExterior: string
}

/**
 * Значения по умолчанию повторяют базовую тему из `src/styles.css`
 * (`--map-floor`, `--map-floor-alt`, `--map-wall`, `--map-grid-line`).
 * Остальные цвета выведены из них и из палитры предметов той же таблицы стилей.
 */
export const DEFAULT_BOARD_PALETTE: BoardPalette = {
  floor: '#8b7658',
  floorAlt: '#927d5e',
  wall: '#493f34',
  gridLine: 'rgba(67,48,29,.2)',
  door: '#8a5a30',
  doorFrame: '#33291f',
  window: '#a9cbd6',
  rail: '#7d6a4f',
  ledge: '#6b5c48',
  lock: '#e0b070',
  prop: '#8c6540',
  propAccent: '#c59a62',
  // Листва — собственный цвет, а не производная зоны. Цвет внешней зоны и цвет
  // материала «трава» — это оба цвета земли, они лежат в одном оливковом
  // диапазоне; крона, выведенная смешением с ними, получала тон в нескольких
  // единицах от газона и на нём просто исчезала — дерево читалось камнем.
  // Крона обязана быть заметно темнее и зеленее газона, просвет — заметно
  // светлее и тоже зеленее, поэтому оба тона задаются здесь напрямую.
  foliage: '#3d6b2b',
  foliageLight: '#7ba63e',
  fog: 'rgba(13,11,9,.62)',
  zoneInterior: '#5b4a35',
  zoneExterior: '#4a5738',
}

/** Названия переменных темы, которые доска читает из CSS. */
const PALETTE_VARIABLES: Array<[keyof BoardPalette, string]> = [
  ['floor', '--map-floor'],
  ['floorAlt', '--map-floor-alt'],
  ['wall', '--map-wall'],
  ['gridLine', '--map-grid-line'],
]

/**
 * Палитра доски по переменным темы. Всё, чего в теме нет, берётся из значений
 * по умолчанию — доска обязана рисоваться и без единой переменной.
 */
export function boardPaletteFrom(read: (name: string) => string | null | undefined): BoardPalette {
  const palette: BoardPalette = { ...DEFAULT_BOARD_PALETTE }
  for (const [key, variable] of PALETTE_VARIABLES) {
    const value = String(read(variable) ?? '').trim()
    if (value) palette[key] = value
  }
  // Производные цвета следуют за темой, иначе дверь на светлом полу теряется.
  palette.doorFrame = shade(palette.wall, -0.35)
  palette.zoneInterior = shade(palette.floor, -0.28)
  return palette
}

// --- цвет ----------------------------------------------------------------

type Rgb = [number, number, number]

function parseColor(value: string): Rgb | null {
  const text = String(value ?? '').trim()
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return [parseInt(text[1] + text[1], 16), parseInt(text[2] + text[2], 16), parseInt(text[3] + text[3], 16)]
  }
  if (/^#[0-9a-f]{6}$/i.test(text)) {
    return [parseInt(text.slice(1, 3), 16), parseInt(text.slice(3, 5), 16), parseInt(text.slice(5, 7), 16)]
  }
  const match = /^rgba?\(([^)]+)\)$/i.exec(text)
  if (match) {
    const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [parts[0], parts[1], parts[2]]
    }
  }
  return null
}

function toHex(rgb: Rgb) {
  return `#${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`
}

/** Смешивает два цвета; `ratio` — доля второго. Непрозрачный результат. */
export function mixColors(left: string, right: string, ratio: number) {
  const a = parseColor(left) ?? parseColor(DEFAULT_BOARD_PALETTE.floor) as Rgb
  const b = parseColor(right) ?? a
  const share = Math.max(0, Math.min(1, ratio))
  return toHex([
    a[0] + (b[0] - a[0]) * share,
    a[1] + (b[1] - a[1]) * share,
    a[2] + (b[2] - a[2]) * share,
  ])
}

/** Осветляет (`amount > 0`) или затемняет цвет. Непрозрачный результат. */
export function shade(color: string, amount: number) {
  return mixColors(color, amount >= 0 ? '#ffffff' : '#000000', Math.abs(amount))
}

/** Цвета материалов повторяют фон соответствующих правил `.map-cell.floor.material-*`. */
const MATERIAL_COLORS: Record<TacticalMaterial, string> = {
  stone: '#a58b65',
  wood: '#9b6237',
  earth: '#aa8152',
  grass: '#799345',
  sand: '#cba45b',
  marble: '#c2b69d',
  metal: '#52666d',
  ice: '#7fa8b4',
}

/** Материалы, из которых строят стены: остальные — покрытие пола. */
const BUILT_MATERIALS = new Set<TacticalMaterial>(['stone', 'wood', 'marble', 'metal'])

const SURFACE_COLORS: Record<TacticalSurface, string | null> = {
  none: null,
  water: '#3f7d84',
  ice: '#8fb9c2',
  oil: '#2f2a33',
  mud: '#5c4a34',
  rubble: '#7a7168',
}

/** Что именно закрашивается. Тип нужен для проверки пути без арта (Р6). */
export type BoardFillTarget =
  | { kind: 'floor'; cell: TacticalCell }
  | { kind: 'wall'; cell?: TacticalCell | null }
  | { kind: 'door'; state?: TacticalDoorState }
  | { kind: 'window' }
  | { kind: 'rail' }
  | { kind: 'ledge' }
  | { kind: 'zone'; exterior?: boolean }

/**
 * Цвет заливки элемента доски. `texturesAvailable: false` — путь Р6: текстур и
 * реестра предметов нет, и доска обязана остаться играбельной на плоских
 * заливках. В обоих случаях цвет непрозрачный, а пол, стена и дверь заведомо
 * различаются: без арта разница между ними — единственный носитель планировки.
 */
export function boardFillColor(target: BoardFillTarget, palette: BoardPalette, texturesAvailable: boolean): string {
  if (target.kind === 'zone') {
    return target.exterior ? palette.zoneExterior : palette.zoneInterior
  }
  if (target.kind === 'wall') {
    // Стену подкрашивает только материал, из которого её и правда строят: трава
    // и песок — это грунт под стеной, и от их подмеса кладка сливалась с полем.
    const material = target.cell?.material
    const base = material && material !== 'stone' && BUILT_MATERIALS.has(material)
      ? mixColors(palette.wall, MATERIAL_COLORS[material], 0.22)
      : palette.wall
    // Под текстурой заливка служит подложкой и остаётся ближе к теме; без неё
    // стену приходится уводить темнее, чтобы она не сливалась с полом.
    return texturesAvailable ? base : shade(base, -0.12)
  }
  if (target.kind === 'door') {
    const state = target.state ?? 'closed'
    if (state === 'broken') return shade(palette.door, -0.3)
    if (state === 'open') return shade(palette.door, 0.12)
    return palette.door
  }
  if (target.kind === 'window') return palette.window
  if (target.kind === 'rail') return palette.rail
  if (target.kind === 'ledge') return palette.ledge

  const cell = target.cell
  const parity = (cell.x + cell.y) % 2 === 0
  const base = parity ? palette.floor : palette.floorAlt
  const surface = SURFACE_COLORS[cell.surface]
  if (surface) return mixColors(base, surface, texturesAvailable ? 0.7 : 0.82)
  // Материал под текстурой лишь подкрашивает подложку; без текстуры он и есть
  // единственный признак покрытия, поэтому подмешивается сильнее.
  const material = mixColors(base, MATERIAL_COLORS[cell.material], texturesAvailable ? 0.3 : 0.55)
  const variantShade = [0, -0.04, 0.03, -0.02, 0.05, -0.06][Math.abs(cell.variant) % 6]
  const elevated = cell.elevation === 0 ? material : shade(material, Math.max(-0.2, Math.min(0.2, cell.elevation * 0.05)))
  const tinted = shade(elevated, variantShade)
  // Непроходимая клетка без поверхности — это массив породы или кладка, а не
  // стена-граница (Р2): она сохраняет свой материал, но уходит в глухой тон,
  // иначе скалу нельзя отличить от пола.
  return cell.passable ? tinted : mixColors(tinted, palette.wall, 0.55)
}

// --- сцена, тайлы и отбор ------------------------------------------------

export type BoardScene = {
  map: TacticalMap
  palette: BoardPalette
  /** Размер клетки в пикселях холста. */
  cellSize: number
  /** Материал → текстура. Пустая карта означает путь без арта. */
  textures?: Map<string, BoardTexture>
  /** Фактуры пола, поверхностей и стен. Их отсутствие — штатный путь Р6. */
  terrain?: TerrainTiles | null
  /** Иллюстрация локации, нарезаемая по клеткам поверх заливки. */
  art?: BoardTexture | null
  /** Ключ иллюстрации: входит в ключ тайла, иначе смена арта не перерисует кэш. */
  artKey?: string
  /** Растровые штампы предметов. Их отсутствие — штатный путь Р6: рисуется вектор. */
  propAtlas?: PropAtlas | null
}

/**
 * Тайлсет местности. Каждая фактура — бесшовная плитка на `cellsPerTile`
 * клеток по стороне, поэтому она раскладывается по карте **непрерывно**:
 * клетка берёт своё окно фактуры по собственным координатам, а не случайное.
 * Так кладка и доски идут через всё помещение единым полотном, а не
 * рассыпаются на самостоятельные квадраты.
 */
export type TerrainTiles = {
  cellsPerTile: number
  /** Материал клетки → фактура пола. */
  floors: Map<string, BoardTexture>
  /** Поверхность поверх пола → фактура. */
  surfaces: Map<string, BoardTexture>
  /** Вид кладки → фактура стены; ключ даёт `wallTextureKeyFor`. */
  walls: Map<string, BoardTexture>
  /** Входит в ключ тайла: подгрузка фактуры обязана обесценить кэш. */
  key: string
}

/**
 * Из чего сложена стена при таком материале клетки. Отдельных материалов
 * стены в контракте карты нет, поэтому вид кладки выводится из материала: у
 * мрамора стена оштукатурена, у металла — та же тёсаная кладка, а земля,
 * трава и песок означают, что это не постройка, а порода.
 */
export function wallTextureKeyFor(material: TacticalMaterial): string {
  if (material === 'wood') return 'wood'
  if (material === 'marble') return 'plaster'
  if (material === 'stone' || material === 'metal') return 'stone'
  return 'cave'
}

/** Кадр спрайта в атласе: окно в пикселях исходного изображения. */
export type PropFrame = { x: number; y: number; w: number; h: number }

/**
 * Атлас штампов: одна картинка и таблица кадров по `assetId`. Реестр ассетов
 * знает про растр то же самое (`server/asset-registry.mjs`), но доска берёт
 * кадры напрямую из манифеста — по сети идёт карта, а не библиотека рисунков.
 */
export type PropAtlas = {
  texture: BoardTexture
  frames: Record<string, PropFrame>
  /** Входит в ключ тайла: без него подгрузка атласа не перерисует кэш. */
  key: string
}

export type BoardTile = { tileX: number; tileY: number }

/** Окно просмотра в координатах клеток. */
export type BoardViewport = { x: number; y: number; width: number; height: number }

/**
 * Какие фактуры карте вообще нужны. Набор весит несколько мегабайт, и грузить
 * его целиком ради таверны из дерева и камня незачем: во дворе нет ни льда, ни
 * металла, ни мрамора.
 */
export function terrainKeysFor(map: TacticalMap): { floors: string[]; surfaces: string[]; walls: string[] } {
  const floors = new Set<string>()
  const surfaces = new Set<string>()
  const walls = new Set<string>()
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell) continue
      if (cell.passable) floors.add(cell.material)
      else walls.add(wallTextureKeyFor(cell.material))
      if (cell.surface !== 'none') surfaces.add(cell.surface)
    }
  }
  // Стена живёт на ребре (Р2), и её кладка берётся с той стороны, где
  // постройка. Такой клетки может не быть среди непроходимых вовсе.
  for (const edge of edgeList(map)) {
    if (edge.kind === 'none') continue
    const cell = cellAt(map, edge.x, edge.y)
    if (cell) walls.add(wallTextureKeyFor(cell.material))
  }
  // Лёд как поверхность рисуется ледяным полом — фактуру надо запросить.
  if (surfaces.has('ice')) floors.add('ice')
  return { floors: [...floors].sort(), surfaces: [...surfaces].sort(), walls: [...walls].sort() }
}

export function texturesAvailableIn(scene: BoardScene) {
  return Boolean((scene.textures && scene.textures.size > 0) || (scene.terrain && scene.terrain.floors.size > 0))
}

/**
 * Тайлы, попадающие в видимое окно с запасом в один тайл. Стоимость кадра
 * определяется размером окна, а не размером карты (Р8).
 */
export function visibleTiles(map: TacticalMap, view: BoardViewport, margin = 1): BoardTile[] {
  const tilesX = Math.max(1, Math.ceil(map.width / TILE_CELLS))
  const tilesY = Math.max(1, Math.ceil(map.height / TILE_CELLS))
  const fromX = Math.max(0, Math.floor(view.x / TILE_CELLS) - margin)
  const toX = Math.min(tilesX - 1, Math.floor((view.x + Math.max(0, view.width)) / TILE_CELLS) + margin)
  const fromY = Math.max(0, Math.floor(view.y / TILE_CELLS) - margin)
  const toY = Math.min(tilesY - 1, Math.floor((view.y + Math.max(0, view.height)) / TILE_CELLS) + margin)
  const tiles: BoardTile[] = []
  for (let tileY = fromY; tileY <= toY; tileY += 1) {
    for (let tileX = fromX; tileX <= toX; tileX += 1) tiles.push({ tileX, tileY })
  }
  return tiles
}

/** Отпечаток раскрытия внутри тайла: только он меняется от хода к ходу. */
/**
 * Насколько далеко за границу тайла может уйти рисунок предмета. Самый широкий
 * предмет реестра — стойка 4×1, самый крупный масштаб — 1.5, поэтому четырёх
 * клеток запаса хватает с избытком.
 */
export const PROP_OVERHANG_CELLS = 4

/**
 * Отпечаток раскрытия тайла. Захватывает поля шириной `PROP_OVERHANG_CELLS`:
 * предмет, чья якорная клетка лежит в соседнем тайле, рисуется и здесь, а его
 * видимость определяется раскрытием именно якорной клетки. Без запаса смена
 * раскрытия у соседа не меняла бы ключ этого тайла, и на шве осталась бы
 * устаревшая половина предмета.
 */
export function tileRevealSignature(map: TacticalMap, tile: BoardTile) {
  const minX = tile.tileX * TILE_CELLS - PROP_OVERHANG_CELLS
  const minY = tile.tileY * TILE_CELLS - PROP_OVERHANG_CELLS
  const span = TILE_CELLS + PROP_OVERHANG_CELLS * 2
  let hash = 0x811c9dc5
  for (let y = minY; y < minY + span; y += 1) {
    for (let x = minX; x < minX + span; x += 1) {
      hash ^= revealedAt(map, x, y) ? 1 : 2
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return (hash >>> 0).toString(16)
}

/**
 * Ключ тайла: отпечаток местности, размер клетки, координаты тайла и раскрытие
 * внутри него. Тайл перерисовывается только при смене своего ключа.
 */
export function tileKey(scene: BoardScene, tile: BoardTile) {
  const art = scene.art ? (scene.artKey ?? 'art') : ''
  const textures = texturesAvailableIn(scene) ? 't' : 'f'
  const stamps = scene.propAtlas?.key ?? ''
  const tiles = scene.terrain?.key ?? ''
  return `${scene.map.terrainHash}:${scene.cellSize}:${textures}:${art}:${stamps}:${tiles}:${tile.tileX}:${tile.tileY}:${tileRevealSignature(scene.map, tile)}`
}

/**
 * Предметы тайла в порядке отрисовки. Пустой список при клетке мельче порога —
 * это и есть уровень детализации.
 *
 * Предмет попадает в тайл, если в него заходит **рисунок**, а не только якорная
 * клетка: стойка 4×1 и дуб 2×2 пересекают границу тайла, и без этого их
 * срезало бы ровно по шву кэша. Раскрытие при этом спрашивается у якорной
 * клетки — предмет либо виден целиком, либо не виден вовсе.
 */
export function propsInTile(map: TacticalMap, tile: BoardTile, cellSize: number): TacticalProp[] {
  const minX = tile.tileX * TILE_CELLS
  const minY = tile.tileY * TILE_CELLS
  const inside = map.props.filter((prop) => {
    const reach = propReach(prop)
    if (reach.x + reach.radius <= minX || reach.x - reach.radius >= minX + TILE_CELLS) return false
    if (reach.y + reach.radius <= minY || reach.y - reach.radius >= minY + TILE_CELLS) return false
    return cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.revealed === true
  })
  return inside.sort((left, right) => left.zOrder - right.zOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

// --- отрисовка местности -------------------------------------------------

/** Окна текстуры по варианту тайла: повторяют смещения правил `.map-cell.variant-*`. */
const VARIANT_WINDOWS: Array<[number, number]> = [[0, 0], [0.13, 0.07], [0.41, 0.29], [0.71, 0.63], [0.91, 0.17], [0.28, 0.87]]

/**
 * Кусок фактуры под прямоугольник, заданный **в клетках карты**. Окно фактуры
 * выбирается по координате клетки по модулю размера плитки, поэтому соседние
 * клетки продолжают друг друга, а не повторяют один и тот же квадрат.
 *
 * Узкая полоса стены на ребре берётся тем же способом: у неё просто дробная
 * ширина в клетках.
 */
function drawTerrainRect(
  context: BoardContext2D, texture: BoardTexture, cellsPerTile: number,
  cellX: number, cellY: number, cellWidth: number, cellHeight: number,
  left: number, top: number, width: number, height: number,
) {
  const perCellX = texture.width / cellsPerTile
  const perCellY = texture.height / cellsPerTile
  const wrap = (value: number) => ((value % cellsPerTile) + cellsPerTile) % cellsPerTile
  const sourceWidth = Math.max(1, cellWidth * perCellX)
  const sourceHeight = Math.max(1, cellHeight * perCellY)
  // Окно, вылезшее за край плитки, сдвигается внутрь. Для клетки это никогда
  // не случается (ровно одна восьмая плитки), а у полосы стены сдвиг меньше её
  // толщины и на глаз не читается.
  const sx = Math.min(wrap(cellX) * perCellX, texture.width - sourceWidth)
  const sy = Math.min(wrap(cellY) * perCellY, texture.height - sourceHeight)
  context.drawImage(texture.image, sx, sy, sourceWidth, sourceHeight, left, top, width, height)
}

/**
 * Прозрачность поверхности поверх пола. Вода и грязь скрывают пол почти
 * целиком, лёд остаётся полупрозрачным — под ним обязано читаться, что там
 * было.
 */
const SURFACE_TEXTURE_ALPHA: Record<TacticalSurface, number> = {
  none: 0, water: 0.92, ice: 0.72, oil: 0.85, mud: 0.94, rubble: 0.94,
}

/** Фактура поверхности. У льда своей нет — берётся ледяной пол. */
function surfaceTextureFor(terrain: TerrainTiles, surface: TacticalSurface): BoardTexture | undefined {
  if (surface === 'none') return undefined
  return terrain.surfaces.get(surface) ?? (surface === 'ice' ? terrain.floors.get('ice') : undefined)
}

function drawSurfaceTexture(
  context: BoardContext2D, scene: BoardScene, cell: TacticalCell,
  left: number, top: number, size: number, x: number, y: number,
) {
  const terrain = scene.terrain
  if (!terrain || cell.surface === 'none') return
  const texture = surfaceTextureFor(terrain, cell.surface)
  if (!texture) return
  context.save()
  context.globalAlpha = SURFACE_TEXTURE_ALPHA[cell.surface]
  drawTerrainRect(context, texture, terrain.cellsPerTile, x, y, 1, 1, left, top, size, size)
  context.restore()
}

/** Фактура пола или породы для клетки: у непроходимой клетки это кладка. */
function terrainTextureFor(scene: BoardScene, cell: TacticalCell): BoardTexture | undefined {
  const terrain = scene.terrain
  if (!terrain) return undefined
  if (!cell.passable) return terrain.walls.get(wallTextureKeyFor(cell.material)) ?? terrain.floors.get(cell.material)
  return terrain.floors.get(cell.material)
}

function drawTexture(context: BoardContext2D, texture: BoardTexture, variant: number, alpha: number, left: number, top: number, size: number) {
  const window = VARIANT_WINDOWS[Math.abs(variant) % VARIANT_WINDOWS.length]
  const sourceWidth = Math.max(1, texture.width / 2.5)
  const sourceHeight = Math.max(1, texture.height / 2.5)
  const sx = Math.min(texture.width - sourceWidth, window[0] * (texture.width - sourceWidth))
  const sy = Math.min(texture.height - sourceHeight, window[1] * (texture.height - sourceHeight))
  context.save()
  context.globalAlpha = alpha
  context.globalCompositeOperation = 'multiply'
  context.drawImage(texture.image, sx, sy, sourceWidth, sourceHeight, left, top, size, size)
  context.restore()
}

function drawFloorTerrainTexture(
  context: BoardContext2D, scene: BoardScene, texture: BoardTexture, cell: TacticalCell,
  left: number, top: number, size: number, floorDirection: string,
) {
  const terrain = scene.terrain
  if (!terrain) return
  if (cell.passable && floorDirection === 'vertical') {
    context.save()
    context.translate(left + size / 2, top + size / 2)
    context.rotate(Math.PI / 2)
    // Координаты источника меняются местами вместе с поворотом: соседние
    // окна фактуры остаются сшитыми, а не превращаются в набор квадратов.
    drawTerrainRect(context, texture, terrain.cellsPerTile, cell.y, cell.x, 1, 1, -size / 2, -size / 2, size, size)
    context.restore()
    return
  }
  drawTerrainRect(context, texture, terrain.cellsPerTile, cell.x, cell.y, 1, 1, left, top, size, size)
}

function drawLegacyFloorTexture(
  context: BoardContext2D, texture: BoardTexture, cell: TacticalCell,
  alpha: number, left: number, top: number, size: number, floorDirection: string,
) {
  if (cell.passable && floorDirection === 'vertical') {
    context.save()
    context.translate(left + size / 2, top + size / 2)
    context.rotate(Math.PI / 2)
    drawTexture(context, texture, cell.variant, alpha, -size / 2, -size / 2, size)
    context.restore()
    return
  }
  drawTexture(context, texture, cell.variant, alpha, left, top, size)
}

function drawSceneArt(context: BoardContext2D, scene: BoardScene, cell: TacticalCell, left: number, top: number) {
  const art = scene.art
  if (!art) return
  const sliceWidth = art.width / Math.max(1, scene.map.width)
  const sliceHeight = art.height / Math.max(1, scene.map.height)
  context.save()
  context.globalAlpha = 0.72
  context.globalCompositeOperation = 'multiply'
  context.drawImage(art.image, cell.x * sliceWidth, cell.y * sliceHeight, sliceWidth, sliceHeight, left, top, scene.cellSize, scene.cellSize)
  context.restore()
}

type TileFrame = { minX: number; minY: number; maxX: number; maxY: number; size: number }

function tileFrame(scene: BoardScene, tile: BoardTile): TileFrame {
  return {
    minX: tile.tileX * TILE_CELLS,
    minY: tile.tileY * TILE_CELLS,
    maxX: tile.tileX * TILE_CELLS + TILE_CELLS - 1,
    maxY: tile.tileY * TILE_CELLS + TILE_CELLS - 1,
    size: scene.cellSize,
  }
}

/** Слой 1: фон зоны. */
export function drawZoneBackground(context: BoardContext2D, scene: BoardScene, tile: BoardTile) {
  const frame = tileFrame(scene, tile)
  const zoneKind = new Map(scene.map.zones.map((zone) => [zone.id, zone.kind]))
  for (let y = frame.minY; y <= frame.maxY; y += 1) {
    for (let x = frame.minX; x <= frame.maxX; x += 1) {
      const cell = cellAt(scene.map, x, y)
      if (!cell) continue
      context.fillStyle = boardFillColor({ kind: 'zone', exterior: zoneKind.get(cell.zone) === 'exterior' }, scene.palette, texturesAvailableIn(scene))
      context.fillRect((x - frame.minX) * frame.size, (y - frame.minY) * frame.size, frame.size, frame.size)
    }
  }
}

/** Слой 2: тайлы пола по материалу и варианту, поверх — иллюстрация локации. */
export function drawFloorTiles(context: BoardContext2D, scene: BoardScene, tile: BoardTile) {
  const frame = tileFrame(scene, tile)
  const textures = scene.textures
  const available = texturesAvailableIn(scene)
  const zoneDirections = new Map(scene.map.zones.map((zone) => [zone.id, zone.floorDirection]))
  for (let y = frame.minY; y <= frame.maxY; y += 1) {
    for (let x = frame.minX; x <= frame.maxX; x += 1) {
      const cell = cellAt(scene.map, x, y)
      if (!cell) continue
      const left = (x - frame.minX) * frame.size
      const top = (y - frame.minY) * frame.size
      context.fillStyle = boardFillColor({ kind: 'floor', cell }, scene.palette, available)
      context.fillRect(left, top, frame.size, frame.size)
      const tile = terrainTextureFor(scene, cell)
      const floorDirection = zoneDirections.get(cell.zone) ?? 'horizontal'
      if (tile && scene.terrain) {
        drawFloorTerrainTexture(context, scene, tile, cell, left, top, frame.size, floorDirection)
        // Непроходимая клетка — это массив породы или кладка. Фактура у неё
        // своя, но без притемнения она на светлом полу читается как пол.
        if (!cell.passable) {
          context.save()
          context.globalAlpha = 0.28
          context.fillStyle = shade(scene.palette.wall, -0.3)
          context.fillRect(left, top, frame.size, frame.size)
          context.restore()
        }
        drawSurfaceTexture(context, scene, cell, left, top, frame.size, x, y)
      } else {
        const texture = textures?.get(cell.material)
        if (texture) drawLegacyFloorTexture(context, texture, cell, cell.passable ? 0.55 : 0.72, left, top, frame.size, floorDirection)
      }
      drawSceneArt(context, scene, cell, left, top)
    }
  }
}

/** Слой 3: декали — рябь на воде, трещины на щебне, наледь. */
export function drawDecals(context: BoardContext2D, scene: BoardScene, tile: BoardTile) {
  const frame = tileFrame(scene, tile)
  context.save()
  context.lineWidth = Math.max(1, frame.size / 22)
  for (let y = frame.minY; y <= frame.maxY; y += 1) {
    for (let x = frame.minX; x <= frame.maxX; x += 1) {
      const cell = cellAt(scene.map, x, y)
      if (!cell || cell.surface === 'none') continue
      // Поверхность, нарисованная фактурой, в штриховке не нуждается: поверх
      // настоящей воды эти штрихи читаются грязью, а не рябью.
      if (scene.terrain && surfaceTextureFor(scene.terrain, cell.surface)) continue
      const left = (x - frame.minX) * frame.size
      const top = (y - frame.minY) * frame.size
      context.strokeStyle = shade(SURFACE_COLORS[cell.surface] ?? scene.palette.floor, 0.35)
      context.globalAlpha = 0.5
      context.beginPath()
      if (cell.surface === 'water' || cell.surface === 'ice') {
        context.moveTo(left + frame.size * 0.15, top + frame.size * 0.38)
        context.lineTo(left + frame.size * 0.85, top + frame.size * 0.32)
        context.moveTo(left + frame.size * 0.2, top + frame.size * 0.68)
        context.lineTo(left + frame.size * 0.8, top + frame.size * 0.62)
      } else {
        context.moveTo(left + frame.size * 0.25, top + frame.size * 0.3)
        context.lineTo(left + frame.size * 0.5, top + frame.size * 0.55)
        context.lineTo(left + frame.size * 0.78, top + frame.size * 0.42)
      }
      context.stroke()
      context.globalAlpha = 1
    }
  }
  context.restore()
}

type EdgeGeometry = { left: number; top: number; width: number; height: number; vertical: boolean; length: number; thickness: number }

function edgeGeometry(edge: TacticalEdge, frame: TileFrame): EdgeGeometry {
  const thickness = Math.max(1, frame.size * WALL_THICKNESS_RATIO)
  if (edge.dir === 'e') {
    const centerX = (edge.x + 1 - frame.minX) * frame.size
    const top = (edge.y - frame.minY) * frame.size
    return { left: centerX - thickness / 2, top, width: thickness, height: frame.size, vertical: true, length: frame.size, thickness }
  }
  const centerY = (edge.y + 1 - frame.minY) * frame.size
  const left = (edge.x - frame.minX) * frame.size
  return { left, top: centerY - thickness / 2, width: frame.size, height: thickness, vertical: false, length: frame.size, thickness }
}

function fillAlongEdge(context: BoardContext2D, geometry: EdgeGeometry, from: number, to: number, thickness: number) {
  const start = Math.min(from, to)
  const span = Math.abs(to - from)
  if (geometry.vertical) {
    const centerX = geometry.left + geometry.width / 2
    context.fillRect(centerX - thickness / 2, geometry.top + start, thickness, span)
  } else {
    const centerY = geometry.top + geometry.height / 2
    context.fillRect(geometry.left + start, centerY - thickness / 2, span, thickness)
  }
}

function drawDoorLeaf(context: BoardContext2D, scene: BoardScene, geometry: EdgeGeometry, state: TacticalDoorState) {
  const available = texturesAvailableIn(scene)
  context.fillStyle = boardFillColor({ kind: 'door', state }, scene.palette, available)
  const openingFrom = geometry.length * 0.22
  const openingTo = geometry.length * 0.78
  const leafThickness = Math.max(1, geometry.thickness * 0.62)
  if (state === 'open') {
    // Открыто в сторону: полотно уходит вдоль стены и проём остаётся свободным.
    const centerX = geometry.left + geometry.width / 2
    const centerY = geometry.top + geometry.height / 2
    if (geometry.vertical) context.fillRect(centerX, geometry.top + openingFrom, geometry.length * 0.5, leafThickness)
    else context.fillRect(geometry.left + openingFrom, centerY, leafThickness, geometry.length * 0.5)
    return
  }
  if (state === 'broken') {
    // Обломки: полотна нет, в проёме остаются два огрызка.
    fillAlongEdge(context, geometry, openingFrom, openingFrom + geometry.length * 0.14, leafThickness)
    fillAlongEdge(context, geometry, openingTo - geometry.length * 0.12, openingTo, leafThickness)
    return
  }
  fillAlongEdge(context, geometry, openingFrom, openingTo, leafThickness)
  if (state !== 'locked') return
  // Метка замка: без неё запертая дверь неотличима от закрытой.
  context.fillStyle = scene.palette.lock
  const middle = geometry.length / 2
  const mark = Math.max(2, geometry.thickness * 0.7)
  if (geometry.vertical) context.fillRect(geometry.left + geometry.width / 2 - mark / 2, geometry.top + middle - mark / 2, mark, mark)
  else context.fillRect(geometry.left + middle - mark / 2, geometry.top + geometry.height / 2 - mark / 2, mark, mark)
}

/**
 * Слой 4: сегменты стен по рёбрам, поверх — косяки, двери и окна.
 *
 * Стена — это граница, а не клетка (Р2): непроходимая клетка без рёбер вокруг
 * (скала, вода) заливается текстурой на слое пола, но стену по своему периметру
 * не получает.
 */
/**
 * Штамп двери по состоянию. Запертая дверь показывается окованной: состояние
 * обязано читаться с карты, а не только из подсказки, и «дверь покрепче» —
 * привычный для боевых карт способ это показать.
 */
const DOOR_STAMPS: Record<string, string> = {
  closed: 'door_closed', open: 'door_open', locked: 'door_iron', broken: 'door_broken',
}

/**
 * Штамп на ребре: рисунок кладётся вдоль ребра во всю его длину, толщину
 * задаёт пропорция рисунка. Толщина при этом выходит больше полосы стены — так
 * и надо: косяк и наличник на боевой карте выступают из стены.
 *
 * Возвращает `false`, если кадра нет: тогда рисуется прежняя сборка из
 * заливок, и карта остаётся читаемой без атласа (решение Р6).
 */
function drawEdgeStamp(context: BoardContext2D, scene: BoardScene, geometry: EdgeGeometry, assetId: string) {
  const atlas = scene.propAtlas
  const stamp = atlas?.frames[assetId]
  if (!atlas || !stamp) return false
  const across = geometry.length * (stamp.h / stamp.w)
  context.save()
  context.translate(geometry.left + geometry.width / 2, geometry.top + geometry.height / 2)
  if (geometry.vertical) context.rotate(Math.PI / 2)
  context.drawImage(atlas.texture.image, stamp.x, stamp.y, stamp.w, stamp.h, -geometry.length / 2, -across / 2, geometry.length, across)
  context.restore()
  return true
}

export function drawEdgeSegments(context: BoardContext2D, scene: BoardScene, tile: BoardTile) {
  const frame = tileFrame(scene, tile)
  const states = doorStates(scene.map)
  const available = texturesAvailableIn(scene)
  // Ребро лежит на границе клеток, поэтому половина его толщины заходит в
  // соседний тайл: рёбра соседей слева и сверху рисуются тоже.
  const edges = edgeList(scene.map).filter((edge) => (
    edge.x >= frame.minX - 1 && edge.x <= frame.maxX && edge.y >= frame.minY - 1 && edge.y <= frame.maxY
  ))
  for (const edge of edges) {
    if (edge.kind === 'none') continue
    const owner = cellAt(scene.map, edge.x, edge.y)
    const neighborPosition = edgeNeighbor(edge)
    const neighbor = cellAt(scene.map, neighborPosition.x, neighborPosition.y)
    if (!owner?.revealed && !neighbor?.revealed) continue
    // Материал стены берётся с той стороны, где действительно есть кладка.
    const side = [owner, neighbor].find((cell) => cell && BUILT_MATERIALS.has(cell.material)) ?? owner ?? neighbor
    const geometry = edgeGeometry(edge, frame)
    if (edge.kind === 'wall') {
      context.fillStyle = boardFillColor({ kind: 'wall', cell: side }, scene.palette, available)
      context.fillRect(geometry.left, geometry.top, geometry.width, geometry.height)
      const masonry = scene.terrain?.walls.get(wallTextureKeyFor(side?.material ?? 'stone'))
      if (masonry && scene.terrain) {
        drawTerrainRect(
          context, masonry, scene.terrain.cellsPerTile,
          edge.x, edge.y, geometry.width / frame.size, geometry.height / frame.size,
          geometry.left, geometry.top, geometry.width, geometry.height,
        )
      }
      // Тонкая тёмная обводка: без неё сегмент в одну шестую клетки теряется на
      // светлом полу и стена перестаёт читаться как граница.
      context.fillStyle = shade(scene.palette.wall, -0.45)
      if (geometry.vertical) {
        context.fillRect(geometry.left, geometry.top, Math.max(1, geometry.thickness * 0.16), geometry.height)
        context.fillRect(geometry.left + geometry.width - Math.max(1, geometry.thickness * 0.16), geometry.top, Math.max(1, geometry.thickness * 0.16), geometry.height)
      } else {
        context.fillRect(geometry.left, geometry.top, geometry.width, Math.max(1, geometry.thickness * 0.16))
        context.fillRect(geometry.left, geometry.top + geometry.height - Math.max(1, geometry.thickness * 0.16), geometry.width, Math.max(1, geometry.thickness * 0.16))
      }
      continue
    }
    if (edge.kind === 'rail') {
      if (drawEdgeStamp(context, scene, geometry, 'rail_fence')) continue
      context.fillStyle = boardFillColor({ kind: 'rail' }, scene.palette, available)
      fillAlongEdge(context, geometry, 0, geometry.length, Math.max(1, geometry.thickness * 0.28))
      continue
    }
    if (edge.kind === 'ledge') {
      if (drawEdgeStamp(context, scene, geometry, 'ledge_step')) continue
      context.fillStyle = boardFillColor({ kind: 'ledge' }, scene.palette, available)
      fillAlongEdge(context, geometry, 0, geometry.length, Math.max(1, geometry.thickness * 0.4))
      // Отбивка смотрит в сторону понижения высоты.
      const drop = (neighbor?.elevation ?? 0) < (owner?.elevation ?? 0) ? 1 : -1
      const tick = Math.max(2, geometry.thickness * 0.9)
      for (let step = 0.2; step < 1; step += 0.3) {
        if (geometry.vertical) {
          const centerX = geometry.left + geometry.width / 2
          context.fillRect(drop > 0 ? centerX : centerX - tick, geometry.top + geometry.length * step, tick, Math.max(1, geometry.thickness * 0.3))
        } else {
          const centerY = geometry.top + geometry.height / 2
          context.fillRect(geometry.left + geometry.length * step, drop > 0 ? centerY : centerY - tick, Math.max(1, geometry.thickness * 0.3), tick)
        }
      }
      continue
    }
    // Проём — это разрыв в стене с косяками по краям. У штампа косяки
    // нарисованы внутри самого рисунка, поэтому он заменяет всю сборку целиком.
    const doorState = (edge.doorId ? states.get(edge.doorId) : undefined) ?? 'closed'
    const openingStamp = edge.kind === 'window'
      ? 'window_glazed'
      : edge.kind === 'loophole'
        ? 'arrow_slit'
        : edge.kind === 'grate'
          ? 'portcullis_gate'
          : DOOR_STAMPS[doorState]
    if (drawEdgeStamp(context, scene, geometry, openingStamp)) continue
    if (edge.kind === 'loophole') {
      // Бойница — узкая щель в цельной стене: движение перекрыто, но через
      // центр читается линия обзора и укрытие в три четверти.
      context.fillStyle = boardFillColor({ kind: 'wall', cell: side }, scene.palette, available)
      fillAlongEdge(context, geometry, 0, geometry.length, geometry.thickness)
      context.fillStyle = boardFillColor({ kind: 'window' }, scene.palette, available)
      fillAlongEdge(context, geometry, geometry.length * 0.39, geometry.length * 0.61, Math.max(1, geometry.thickness * 0.3))
      continue
    }
    context.fillStyle = boardFillColor({ kind: 'wall', cell: side }, scene.palette, available)
    fillAlongEdge(context, geometry, 0, geometry.length * 0.22, geometry.thickness)
    fillAlongEdge(context, geometry, geometry.length * 0.78, geometry.length, geometry.thickness)
    context.fillStyle = scene.palette.doorFrame
    fillAlongEdge(context, geometry, geometry.length * 0.2, geometry.length * 0.24, geometry.thickness)
    fillAlongEdge(context, geometry, geometry.length * 0.76, geometry.length * 0.8, geometry.thickness)
    if (edge.kind === 'window') {
      context.fillStyle = boardFillColor({ kind: 'window' }, scene.palette, available)
      fillAlongEdge(context, geometry, geometry.length * 0.24, geometry.length * 0.76, Math.max(1, geometry.thickness * 0.45))
      continue
    }
    if (edge.kind === 'grate') {
      context.fillStyle = scene.palette.rail
      fillAlongEdge(context, geometry, geometry.length * 0.24, geometry.length * 0.76, Math.max(1, geometry.thickness * 0.24))
      const centerX = geometry.left + geometry.width / 2
      const centerY = geometry.top + geometry.height / 2
      const bar = Math.max(1, geometry.thickness * 0.18)
      for (const step of [0.32, 0.44, 0.56, 0.68]) {
        if (geometry.vertical) {
          context.fillRect(centerX - geometry.thickness * 0.62, geometry.top + geometry.length * step - bar / 2, geometry.thickness * 1.24, bar)
        } else {
          context.fillRect(geometry.left + geometry.length * step - bar / 2, centerY - geometry.thickness * 0.62, bar, geometry.thickness * 1.24)
        }
      }
      continue
    }
    drawDoorLeaf(context, scene, geometry, doorState)
  }
}

/**
 * Библиотека рисунков предметов (`docs/tactical-map-plan.md`, раздел 6 и
 * решение Р3). Карта хранит только `assetId`; здесь по нему находится рисунок.
 *
 * Устроена семействами с параметром, а не одной функцией на запись: на
 * референсе около 25 деревьев нарисованы 4–5 спрайтами разного масштаба и
 * поворота (раздел 2 плана). Поэтому породы дерева — один рисовальщик с
 * параметром плотности кроны, столы — один с параметром формы, бочка, бочонок
 * и штабель — один с параметром числа барабанов.
 *
 * Всё считается от габарита и палитры: ни зашитых пикселей, ни внешних
 * ресурсов, поэтому рисунок одинаково годится и для клетки в 24 px, и для
 * клетки в 96 px, и остаётся играбельным путём Р6.
 */

/**
 * Габарит рисунка в пикселях: половина ширины и половина высоты в локальной
 * системе предмета — до поворота. Габарит берётся из футпринта, поэтому стол
 * 2×2 рисуется на четыре клетки, а не кружком в одной.
 */
export type PropBox = { hw: number; hh: number }

type PropPainter = (context: BoardContext2D, box: PropBox, palette: BoardPalette) => void

/** Форма упрощённого силуэта: средний уровень детализации — одна заливка. */
type PropSilhouette = 'round' | 'block' | 'flat'

type PropDrawing = {
  paint: PropPainter
  simple: PropSilhouette
  /**
   * Визуальный размер в клетках для записей с пустым футпринтом: кружка мельче
   * клетки, ковёр рисуется на три клетки и не занимает ни одной (раздел 5).
   */
  visual?: { w: number; h: number }
  /** Декаль: плоский рисунок без объёма и тени. */
  flat?: boolean
  /**
   * Тон силуэта и метки. По умолчанию — цвет предмета из палитры. Зелень,
   * камень и вода названы отдельно: иначе при отдалении лес во дворе
   * превращается в бурую сыпь, неотличимую от бочек, — ровно та же беда,
   * которой болел и полный рисунок, только на два уровня детализации ниже.
   * Подземное озеро 2×2 без своего тона тонуло там же.
   */
  tint?: 'prop' | 'foliage' | 'stone' | 'water'
}

/** Цвет силуэта и метки по тону записи библиотеки. */
function silhouetteColor(palette: BoardPalette, drawing: PropDrawing) {
  if (drawing.tint === 'foliage') return palette.foliage
  if (drawing.tint === 'stone') return tones(palette).stone
  if (drawing.tint === 'water') return tones(palette).water
  return palette.prop
}

// --- примитивы -----------------------------------------------------------

function circle(context: BoardContext2D, x: number, y: number, radius: number) {
  context.beginPath()
  context.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2)
  context.fill()
}

/**
 * Эллипс многоугольником. `ellipse` есть не у каждой реализации контекста, а
 * весь модуль обязан рисоваться и в поддельном контексте тестов, поэтому
 * овальные силуэты собираются из отрезков.
 */
function ellipseShape(context: BoardContext2D, cx: number, cy: number, rx: number, ry: number) {
  const steps = 18
  context.beginPath()
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2
    const x = cx + Math.cos(angle) * Math.max(0.5, rx)
    const y = cy + Math.sin(angle) * Math.max(0.5, ry)
    if (step === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  }
  context.closePath()
  context.fill()
}

function polygon(context: BoardContext2D, points: ReadonlyArray<readonly [number, number]>) {
  if (!points.length) return
  context.beginPath()
  context.moveTo(points[0][0], points[0][1])
  for (let index = 1; index < points.length; index += 1) context.lineTo(points[index][0], points[index][1])
  context.closePath()
  context.fill()
}

function lines(context: BoardContext2D, color: string, width: number, segments: ReadonlyArray<readonly [number, number, number, number]>) {
  context.strokeStyle = color
  context.lineWidth = Math.max(0.6, width)
  context.beginPath()
  for (const [x1, y1, x2, y2] of segments) {
    context.moveTo(x1, y1)
    context.lineTo(x2, y2)
  }
  context.stroke()
}

/**
 * Оттенки предмета из палитры доски. Все рисунки берут цвет отсюда: тема
 * меняет один `--map-prop`, и вся библиотека следует за ней.
 */
type PropTones = {
  base: string; light: string; dark: string; deep: string
  accent: string; glow: string; cool: string; stone: string; stoneLight: string
  water: string; waterDeep: string
  leaf: string; leafDeep: string; leafLight: string; bark: string; shadow: string
}

function tones(palette: BoardPalette): PropTones {
  // Камень: одного цвета стены мало — кладка в палитре бурая, и валун на газоне
  // читался деревяшкой. Подмешивается холодный серый, иначе камень не камень.
  const stone = mixColors(mixColors(palette.prop, palette.wall, 0.62), '#8f8d88', 0.54)
  return {
    base: palette.prop,
    light: shade(palette.prop, 0.24),
    dark: shade(palette.prop, -0.3),
    deep: shade(palette.prop, -0.55),
    accent: palette.propAccent,
    glow: shade(palette.propAccent, 0.4),
    // Стекло, вода и металл — холодная часть палитры.
    cool: mixColors(palette.prop, palette.window, 0.62),
    stone,
    stoneLight: shade(stone, 0.26),
    // Открытая вода — тон окна, а не холодная смесь `cool`: подземное озеро
    // занимает четыре клетки, и подмес древесины уводил его в серо-зелёный, в
    // котором вода уже не читается водой.
    water: shade(palette.window, -0.18),
    waterDeep: shade(palette.window, -0.46),
    leaf: palette.foliage,
    leafDeep: shade(palette.foliage, -0.34),
    leafLight: palette.foliageLight,
    // Кора и сучья: дерево палитры, уведённое почти в чёрный, — ствол обязан
    // быть темнее любой кроны, иначе он теряется в её же тени.
    bark: shade(palette.prop, -0.58),
    // Тень у основания. Цвет от стены, а не от зоны: один и тот же предмет
    // стоит и на газоне, и на дощатом полу, и тень обязана читаться на обоих.
    shadow: shade(palette.wall, -0.45),
  }
}

/**
 * Кромка долями: радиус гуляет между `1` и `1 - depth`, поэтому силуэт выходит
 * не кругом, а лиственным пятном. Ровный круг на газоне читается как окатыш —
 * именно этим кроны и терялись среди камней.
 */
function lobedShape(
  context: BoardContext2D, cx: number, cy: number,
  rx: number, ry: number, lobes: number, depth: number, phase = 0,
) {
  const steps = Math.max(24, lobes * 7)
  context.beginPath()
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2
    const wave = 1 - depth * (0.5 + 0.5 * Math.cos(angle * lobes + phase))
    const x = cx + Math.cos(angle) * Math.max(0.5, rx * wave)
    const y = cy + Math.sin(angle) * Math.max(0.5, ry * wave)
    if (step === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  }
  context.closePath()
  context.fill()
}

/**
 * Звезда-розетка: `reach` задаёт длинный и короткий лучи. Так рисуется хвойная
 * лапа сверху и так же — трещины на пне.
 */
function starShape(
  context: BoardContext2D, cx: number, cy: number,
  rx: number, ry: number, rays: number, inner: number, phase = 0,
) {
  const points: Array<[number, number]> = []
  for (let index = 0; index < rays * 2; index += 1) {
    const angle = (index / (rays * 2)) * Math.PI * 2 + phase
    const reach = index % 2 === 0 ? 1 : inner
    points.push([cx + Math.cos(angle) * rx * reach, cy + Math.sin(angle) * ry * reach])
  }
  polygon(context, points)
}

/**
 * Тёмный контур под силуэтом — подложка, а не отброшенная тень.
 *
 * Смещённая тень была бы физичнее, но предмет рисуется с произвольным
 * поворотом, и смещение поворачивается вместе с ним: тень оказывалась то снизу,
 * то сверху, и свет по двору шёл вразнобой. Ровный контур поворота не боится и
 * делает главное — отрывает крону от газона, на котором она иначе тонет.
 */
function propContour(context: BoardContext2D, palette: BoardPalette, cx: number, cy: number, rx: number, ry: number) {
  context.fillStyle = tones(palette).shadow
  ellipseShape(context, cx, cy, rx, ry)
}

/** Доли с контуром: контур повторяет ту же форму, поэтому обводка ровная. */
function outlinedLobes(
  context: BoardContext2D, palette: BoardPalette, fill: string,
  cx: number, cy: number, rx: number, ry: number,
  lobes: number, depth: number, phase = 0, edge = 0.12,
) {
  context.fillStyle = tones(palette).shadow
  lobedShape(context, cx, cy, rx * (1 + edge), ry * (1 + edge), lobes, depth, phase)
  context.fillStyle = fill
  lobedShape(context, cx, cy, rx, ry, lobes, depth, phase)
}

function flame(context: BoardContext2D, radius: number, palette: BoardPalette) {
  context.fillStyle = palette.propAccent
  context.beginPath()
  context.moveTo(0, -radius)
  context.lineTo(radius * 0.62, radius * 0.35)
  context.lineTo(0, radius * 0.72)
  context.lineTo(-radius * 0.62, radius * 0.35)
  context.closePath()
  context.fill()
  context.fillStyle = shade(palette.propAccent, 0.4)
  circle(context, 0, radius * 0.1, radius * 0.24)
}

// --- семейства рисунков --------------------------------------------------

/** Столы: круглый, длинный и маленький — одна форма с параметром. */
function tablePainter(kind: 'round' | 'long' | 'small'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'round') {
      // Тёмный кант, а не смещённая тень: при смещении круглая столешница даёт
      // серп сбоку, который читается как отдельный предмет.
      context.fillStyle = t.deep
      ellipseShape(context, 0, hh * 0.05, hw, hh)
      context.fillStyle = t.base
      ellipseShape(context, 0, 0, hw * 0.94, hh * 0.94)
      context.fillStyle = t.light
      ellipseShape(context, 0, -hh * 0.03, hw * 0.58, hh * 0.58)
      return
    }
    const width = kind === 'small' ? 0.76 : 0.96
    const height = kind === 'small' ? 0.76 : 0.9
    context.fillStyle = t.deep
    context.fillRect(-hw * width, -hh * height + hh * 0.14, hw * 2 * width, hh * 2 * height)
    context.fillStyle = t.base
    context.fillRect(-hw * width, -hh * height, hw * 2 * width, hh * 2 * height)
    const planks = kind === 'small' ? 2 : 5
    const segments: Array<[number, number, number, number]> = []
    for (let index = 1; index < planks; index += 1) {
      const x = -hw * width + (hw * 2 * width * index) / planks
      segments.push([x, -hh * height, x, hh * height])
    }
    lines(context, t.dark, thin * 0.08, segments)
  }
}

/**
 * Сиденья. Спинка смотрит вверх, поэтому поворот показывает, к какому столу
 * придвинут стул — ровно то, ради чего у предмета вообще есть поворот.
 */
function seatPainter(kind: 'chair' | 'stool' | 'bench' | 'prayer'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'prayer') {
      // Молитвенная скамья — та же скамья, но с приступкой для колен: две доски
      // разной ширины с просветом между ними. Одна доска повторяла бы обычную
      // скамью, а именно по паре досок ряд в храме и опознаётся.
      context.fillStyle = t.deep
      for (const end of [-0.84, 0.84]) {
        context.fillRect(hw * end - thin * 0.13, -hh * 0.92, thin * 0.26, hh * 1.84)
      }
      context.fillStyle = t.dark
      context.fillRect(-hw * 0.92, hh * 0.34, hw * 1.84, hh * 0.5)
      context.fillStyle = t.deep
      context.fillRect(-hw * 0.94, -hh * 0.78, hw * 1.88, hh * 0.86)
      context.fillStyle = t.base
      context.fillRect(-hw * 0.94, -hh * 0.78, hw * 1.88, hh * 0.7)
      context.fillStyle = t.light
      context.fillRect(-hw * 0.94, -hh * 0.78, hw * 1.88, hh * 0.24)
      return
    }
    if (kind === 'stool') {
      // Три ножки торчат из-под круглого сиденья. Без них табурет — это круг, а
      // круг на полу трактира читается бочкой или тарелкой.
      for (let index = 0; index < 3; index += 1) {
        const angle = (index / 3) * Math.PI * 2 - Math.PI / 2
        context.fillStyle = t.deep
        circle(context, Math.cos(angle) * thin * 0.82, Math.sin(angle) * thin * 0.82, thin * 0.2)
      }
      context.fillStyle = t.deep
      circle(context, 0, 0, thin * 0.78)
      context.fillStyle = t.base
      circle(context, 0, 0, thin * 0.68)
      context.fillStyle = t.light
      circle(context, -thin * 0.08, -thin * 0.08, thin * 0.36)
      return
    }
    if (kind === 'bench') {
      // Скамья — длинная доска без спинки, с ножками по торцам. Спинка была
      // ошибкой: с ней скамья повторяла стул, только шире.
      context.fillStyle = t.deep
      for (const end of [-0.78, 0.78]) {
        context.fillRect(hw * end - thin * 0.14, -hh * 0.92, thin * 0.28, hh * 1.84)
      }
      context.fillStyle = t.dark
      context.fillRect(-hw * 0.96, -hh * 0.54, hw * 1.92, hh * 1.1)
      context.fillStyle = t.base
      context.fillRect(-hw * 0.96, -hh * 0.54, hw * 1.92, hh * 0.94)
      lines(context, t.deep, thin * 0.09, [
        [-hw * 0.96, hh * 0.06, hw * 0.96, hh * 0.06],
      ])
      return
    }
    // Стул: спинка шире сиденья и отделена просветом, поэтому силуэт читается
    // буквой «⊓» с бруском под ней, а не сплошным квадратом-ящиком.
    context.fillStyle = t.deep
    context.fillRect(-hw * 0.98, -hh * 0.96, hw * 1.96, hh * 0.4)
    context.fillStyle = t.dark
    context.fillRect(-hw * 0.92, -hh * 0.9, hw * 1.84, hh * 0.28)
    context.fillStyle = t.deep
    context.fillRect(-hw * 0.8, -hh * 0.4, hw * 1.6, hh * 1.3)
    context.fillStyle = t.base
    context.fillRect(-hw * 0.74, -hh * 0.34, hw * 1.48, hh * 1.16)
    context.fillStyle = t.light
    context.fillRect(-hw * 0.5, -hh * 0.16, hw * 1.0, hh * 0.78)
  }
}

/** Стойка трактирщика, полка с бутылками и настенная полка. */
function counterPainter(kind: 'counter' | 'bottles' | 'shelf'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    const height = kind === 'shelf' ? 0.5 : 0.86
    context.fillStyle = t.dark
    context.fillRect(-hw * 0.98, -hh * height, hw * 1.96, hh * height * 2)
    context.fillStyle = t.base
    context.fillRect(-hw * 0.98, -hh * height, hw * 1.96, hh * height * 1.1)
    if (kind === 'counter') {
      context.fillStyle = t.light
      context.fillRect(-hw * 0.98, -hh * height, hw * 1.96, hh * height * 0.34)
      lines(context, t.deep, thin * 0.09, [
        [-hw * 0.4, -hh * height, -hw * 0.4, hh * height],
        [hw * 0.4, -hh * height, hw * 0.4, hh * height],
      ])
      return
    }
    // Ряд бутылок и кружек: по нему полка и отличается от глухого шкафа.
    const tall = kind === 'bottles' ? 0.9 : 0.62
    context.fillStyle = t.accent
    for (let index = 0; index < 5; index += 1) {
      const x = -hw * 0.72 + (hw * 1.44 * index) / 4
      context.fillRect(x - thin * 0.11, -hh * height * tall, thin * 0.22, hh * height * tall * 0.9)
    }
  }
}

/** Шкафы: буфет, платяной, книжный и прикроватная тумба. */
function cabinetPainter(kind: 'cupboard' | 'wardrobe' | 'books' | 'night'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    const depth = kind === 'night' ? 0.72 : 0.92
    context.fillStyle = t.deep
    context.fillRect(-hw * 0.96, -hh * depth, hw * 1.92, hh * depth * 2)
    context.fillStyle = t.base
    context.fillRect(-hw * 0.9, -hh * depth * 0.9, hw * 1.8, hh * depth * 1.8)
    if (kind === 'books') {
      // Корешки книг двумя рядами — по ним книжный шкаф и опознаётся сверху.
      for (let row = 0; row < 2; row += 1) {
        const top = -hh * depth * 0.72 + row * hh * depth * 0.8
        for (let index = 0; index < 6; index += 1) {
          context.fillStyle = index % 2 ? t.accent : t.light
          context.fillRect(-hw * 0.78 + (hw * 1.56 * index) / 6, top, hw * 0.2, hh * depth * 0.58)
        }
      }
      return
    }
    if (kind === 'night') {
      context.fillStyle = t.light
      context.fillRect(-hw * 0.48, -hh * depth * 0.2, hw * 0.96, hh * depth * 0.5)
      return
    }
    context.fillStyle = t.light
    context.fillRect(-hw * 0.9, -hh * depth * 0.9, hw * 1.8, hh * depth * 0.4)
    lines(context, t.deep, thin * 0.09, [[0, -hh * depth * 0.9, 0, hh * depth * 0.9]])
    context.fillStyle = t.accent
    circle(context, -hw * 0.16, hh * depth * 0.2, thin * 0.1)
    circle(context, hw * 0.16, hh * depth * 0.2, thin * 0.1)
  }
}

/** Бочки: одиночная, бочонок и штабель из двух барабанов. */
function caskPainter(kind: 'barrel' | 'keg' | 'stack'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const drum = (cx: number, radius: number) => {
      context.fillStyle = t.base
      circle(context, cx, 0, radius)
      context.fillStyle = t.dark
      context.fillRect(cx - radius, -radius * 0.46, radius * 2, radius * 0.16)
      context.fillRect(cx - radius, radius * 0.3, radius * 2, radius * 0.16)
      context.fillStyle = t.light
      circle(context, cx, 0, radius * 0.28)
    }
    if (kind === 'stack') {
      const radius = Math.min(hw * 0.48, hh * 0.94)
      drum(-hw * 0.48, radius)
      drum(hw * 0.48, radius)
      return
    }
    drum(0, Math.min(hw, hh) * (kind === 'keg' ? 0.72 : 0.94))
  }
}

/** Ящики: одиночный, штабель и сундук с замком. */
function cratePainter(kind: 'single' | 'stack' | 'chest'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    context.fillStyle = t.deep
    context.fillRect(-hw * 0.94, -hh * 0.94, hw * 1.88, hh * 1.88)
    context.fillStyle = t.base
    context.fillRect(-hw * 0.86, -hh * 0.86, hw * 1.72, hh * 1.72)
    if (kind === 'chest') {
      context.fillStyle = t.dark
      context.fillRect(-hw * 0.86, -hh * 0.18, hw * 1.72, hh * 0.36)
      context.fillStyle = palette.lock
      context.fillRect(-thin * 0.16, -thin * 0.24, thin * 0.32, thin * 0.48)
      return
    }
    lines(context, t.deep, thin * 0.09, kind === 'stack'
      ? [[-hw * 0.86, 0, hw * 0.86, 0], [0, -hh * 0.86, 0, hh * 0.86]]
      : [[-hw * 0.86, -hh * 0.86, hw * 0.86, hh * 0.86], [hw * 0.86, -hh * 0.86, -hw * 0.86, hh * 0.86]])
  }
}

/** Открытые ёмкости: ведро, корзина, котёл, таз, горшок, урна и чаша. */
function basinPainter(kind: 'bucket' | 'basket' | 'cauldron' | 'washbasin' | 'pot' | 'urn' | 'offering'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'urn') {
      // Погребальная урна — та же ёмкость, только каменная и закрытая: тулово
      // шире плечиков, поверх лежит крышка с шишечкой. Без сужения кверху урна
      // повторяла бы горшок, а он в склепе не стоит.
      propContour(context, palette, 0, hh * 0.06, hw * 0.78, hh * 0.96)
      context.fillStyle = shade(t.stone, -0.32)
      ellipseShape(context, 0, hh * 0.08, hw * 0.72, hh * 0.88)
      // Ушки по бокам: без них закрытая ёмкость повторяет горшок под крышкой.
      context.fillStyle = shade(t.stone, -0.46)
      ellipseShape(context, -hw * 0.7, -hh * 0.04, hw * 0.18, hh * 0.24)
      ellipseShape(context, hw * 0.7, -hh * 0.04, hw * 0.18, hh * 0.24)
      context.fillStyle = t.stone
      ellipseShape(context, 0, hh * 0.1, hw * 0.6, hh * 0.74)
      context.fillStyle = shade(t.stone, -0.44)
      ellipseShape(context, 0, -hh * 0.2, hw * 0.46, hh * 0.42)
      context.fillStyle = t.stoneLight
      ellipseShape(context, 0, -hh * 0.22, hw * 0.34, hh * 0.3)
      context.fillStyle = shade(t.stone, -0.5)
      circle(context, 0, -hh * 0.24, thin * 0.13)
      return
    }
    if (kind === 'offering') {
      // Чаша подношений — та же форма, но мелкая и с приношением внутри: по
      // светлому ободу и тёплой сердцевине она и отличается от миски похлёбки.
      context.fillStyle = shade(t.stone, -0.26)
      circle(context, 0, 0, thin * 0.96)
      context.fillStyle = t.stoneLight
      circle(context, 0, 0, thin * 0.78)
      context.fillStyle = t.accent
      circle(context, 0, 0, thin * 0.5)
      context.fillStyle = t.glow
      circle(context, -thin * 0.14, -thin * 0.16, thin * 0.18)
      return
    }
    const radius = thin * (kind === 'pot' ? 0.8 : 0.92)
    context.fillStyle = kind === 'cauldron' ? t.deep : t.base
    circle(context, 0, 0, radius)
    context.fillStyle = kind === 'basket' ? t.light : kind === 'washbasin' ? t.cool : t.dark
    circle(context, 0, 0, radius * 0.66)
    if (kind === 'basket') {
      lines(context, t.dark, radius * 0.12, [
        [-radius * 0.62, -radius * 0.2, radius * 0.62, -radius * 0.2],
        [-radius * 0.62, radius * 0.24, radius * 0.62, radius * 0.24],
      ])
      return
    }
    if (kind === 'washbasin') return
    // Дужка: по ней ведро и котёл сверху отличаются от бочки.
    lines(context, t.deep, radius * 0.14, [[-radius, -radius * 0.1, radius, -radius * 0.1]])
  }
}

/**
 * Мягкая куча: мешок и стог. Стог сверху — это купол соломы, поэтому солома
 * расходится лучами от вершины: пара косых штрихов, как было, читалась
 * перечёркнутым пятном, а не укладкой.
 */
function heapPainter(kind: 'sack' | 'hay'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind !== 'hay') {
      propContour(context, palette, 0, hh * 0.14, hw * 1.0, hh * 0.9)
      context.fillStyle = t.base
      ellipseShape(context, 0, hh * 0.14, hw * 0.92, hh * 0.8)
      context.fillStyle = t.light
      ellipseShape(context, -hw * 0.2, -hh * 0.18, hw * 0.58, hh * 0.5)
      // Перехват горловины: по нему мешок и отличается от валуна.
      context.fillStyle = t.dark
      ellipseShape(context, 0, -hh * 0.6, hw * 0.34, hh * 0.28)
      context.fillStyle = t.deep
      ellipseShape(context, 0, -hh * 0.44, hw * 0.44, hh * 0.12)
      return
    }
    outlinedLobes(context, palette, shade(palette.propAccent, -0.3), 0, 0, hw * 0.96, hh * 0.94, 7, 0.12, 0, 0.06)
    context.fillStyle = t.accent
    lobedShape(context, -hw * 0.05, -hh * 0.06, hw * 0.84, hh * 0.82, 6, 0.14, 0.6)
    // Солома идёт от вершины к краю. Длина и начало у каждой пряди свои, иначе
    // ровные лучи от центра превращают стог в колесо со спицами.
    const straw: Array<[number, number, number, number]> = []
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2 + 0.35
      const from = 0.16 + (index % 3) * 0.12
      const to = 0.72 + (index % 4) * 0.07
      straw.push([
        -hw * 0.06 + Math.cos(angle) * hw * from, -hh * 0.08 + Math.sin(angle) * hh * from,
        -hw * 0.06 + Math.cos(angle) * hw * to, -hh * 0.08 + Math.sin(angle) * hh * to,
      ])
    }
    lines(context, shade(palette.propAccent, -0.34), thin * 0.07, straw)
    context.fillStyle = shade(palette.propAccent, 0.3)
    lobedShape(context, -hw * 0.06, -hh * 0.08, hw * 0.22, hh * 0.22, 4, 0.3)
  }
}

/**
 * Деревья. Порода задаёт форму и плотность кроны: один рисовальщик закрывает
 * пять записей реестра — тот самый приём, которым референс рисует два десятка
 * деревьев пятью спрайтами разного масштаба и поворота (раздел 2 плана).
 */
function treePainter(kind: 'oak' | 'pine' | 'birch' | 'dead' | 'spruce' | 'stump'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'stump') {
      // Пень — это спил: тёмное кольцо коры, светлая древесина, годичное кольцо
      // и трещина от сердцевины. Без колец он неотличим от окатыша.
      propContour(context, palette, 0, 0, thin * 1.02, thin * 1.02)
      context.fillStyle = t.bark
      circle(context, 0, 0, thin * 0.94)
      context.fillStyle = shade(palette.prop, 0.3)
      circle(context, 0, 0, thin * 0.72)
      context.fillStyle = shade(palette.prop, -0.06)
      starShape(context, 0, 0, thin * 0.5, thin * 0.5, 3, 0.86, 0.4)
      context.fillStyle = shade(palette.prop, 0.34)
      circle(context, 0, 0, thin * 0.26)
      lines(context, t.bark, thin * 0.12, [[0, 0, hw * 0.68, -hh * 0.5]])
      return
    }
    if (kind === 'dead') {
      // Сухое дерево: голые сучья с развилками и тёмный ствол в центре. Сучья
      // длинные и тонкие, ствол мелкий: толстая ступица с короткими отростками
      // читалась насекомым, а не деревом.
      propContour(context, palette, 0, 0, hw * 0.34, hh * 0.34)
      lines(context, t.bark, thin * 0.2, [
        [0, 0, -hw * 0.94, -hh * 0.68], [0, 0, hw * 0.88, -hh * 0.54],
        [0, 0, -hw * 0.6, hh * 0.94], [0, 0, hw * 0.72, hh * 0.86],
        [0, 0, hw * 0.1, -hh * 0.98],
      ])
      lines(context, t.bark, thin * 0.1, [
        [-hw * 0.52, -hh * 0.38, -hw * 0.78, hh * 0.16],
        [hw * 0.48, -hh * 0.3, hw * 0.98, hh * 0.1],
        [hw * 0.05, -hh * 0.5, -hw * 0.4, -hh * 0.96],
        [-hw * 0.32, hh * 0.5, hw * 0.2, hh * 0.94],
        [hw * 0.4, hh * 0.48, hw * 0.02, hh * 0.9],
      ])
      context.fillStyle = t.bark
      circle(context, 0, 0, thin * 0.17)
      return
    }
    if (kind === 'spruce') {
      // Ель — та же хвойная розетка, что и сосна, но лап вдвое больше и они
      // короче: крона получается плотной и почти сплошной. На своих 2×2 это
      // единственное, чем ель отличима от сосны, — порода читается густотой.
      context.fillStyle = t.shadow
      starShape(context, 0, 0, hw * 1.06, hh * 1.06, 13, 0.56)
      context.fillStyle = t.leafDeep
      starShape(context, 0, 0, hw * 0.98, hh * 0.98, 13, 0.56)
      context.fillStyle = t.leaf
      starShape(context, 0, 0, hw * 0.74, hh * 0.74, 13, 0.54, Math.PI / 13)
      context.fillStyle = mixColors(t.leaf, t.leafLight, 0.45)
      starShape(context, -hw * 0.12, -hh * 0.14, hw * 0.36, hh * 0.36, 11, 0.52)
      context.fillStyle = t.leafDeep
      circle(context, 0, 0, thin * 0.13)
      return
    }
    if (kind === 'pine') {
      // Сверху хвойное дерево читается розеткой из лап. Треугольник — вид
      // сбоку, а на плане вида сбоку нет, и при повороте он ложится набок.
      context.fillStyle = t.shadow
      starShape(context, 0, 0, hw * 1.08, hh * 1.08, 8, 0.66)
      context.fillStyle = t.leafDeep
      starShape(context, 0, 0, hw * 0.99, hh * 0.99, 8, 0.66)
      context.fillStyle = t.leaf
      starShape(context, 0, 0, hw * 0.84, hh * 0.84, 8, 0.6, Math.PI / 8)
      // Просвет смещён от центра: ровное светлое ядро посреди розетки читалось
      // огоньком, а не верхушкой хвои.
      context.fillStyle = mixColors(t.leaf, t.leafLight, 0.4)
      starShape(context, -hw * 0.16, -hh * 0.18, hw * 0.44, hh * 0.44, 7, 0.56)
      context.fillStyle = t.leafDeep
      circle(context, 0, 0, thin * 0.17)
      return
    }
    // Лиственные: доли по краю кроны, тёмный испод, светлая освещённая сторона
    // и намёк на ствол в просвете. Дуб плотнее и темнее, берёза реже и светлее,
    // а ствол у берёзы белый — по нему породы и различаются на общем плане.
    const oak = kind === 'oak'
    outlinedLobes(context, palette, t.leafDeep, 0, 0, hw * 0.96, hh * 0.96, oak ? 6 : 5, oak ? 0.24 : 0.34)
    context.fillStyle = t.leaf
    lobedShape(context, -hw * 0.05, -hh * 0.06, hw * 0.82, hh * 0.82, oak ? 5 : 4, oak ? 0.26 : 0.36, 0.8)
    // Просветы в кроне — несколько мелких пятен, а не одна светлая доля: единая
    // заливка поверх кроны превращала дерево в цветок с ровными лепестками.
    context.fillStyle = oak ? mixColors(t.leaf, t.leafLight, 0.72) : t.leafLight
    const gaps: Array<[number, number, number]> = [[-0.34, -0.3, 0.34], [0.22, -0.36, 0.26], [-0.12, 0.3, 0.24], [0.4, 0.16, 0.2]]
    for (const [cx, cy, size] of gaps) {
      lobedShape(context, hw * cx, hh * cy, hw * size, hh * size, 3, 0.3, cx * 7 + cy)
    }
    // Ствол в просвете кроны. У берёзы он белый, у дуба тёмный — на общем плане
    // это единственное, чем породы одного силуэта и различаются.
    context.fillStyle = oak ? t.bark : shade(palette.prop, 0.66)
    circle(context, hw * 0.04, hh * 0.06, thin * (oak ? 0.15 : 0.14))
  }
}

/**
 * Кустарник: куст гуще подлеска, но крона у них одна. От дерева отличается тем,
 * что ствола нет вовсе, а силуэт — низкая приплюснутая куртина из нескольких
 * долей, а не одна крона: именно по этому куст и не путается с берёзой.
 */
function shrubPainter(kind: 'bush' | 'shrub'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    if (kind === 'shrub') {
      // Подлесок — не одна куртина, а несколько отдельных кустиков с просветами
      // травы между ними: сплошное пятно повторяло куст, только светлее.
      const leaf = mixColors(t.leaf, t.leafLight, 0.45)
      const clumps: Array<[number, number, number]> = [[-0.46, 0.3, 0.5], [0.44, 0.4, 0.44], [0.1, -0.44, 0.52]]
      for (const [cx, cy, size] of clumps) {
        outlinedLobes(context, palette, shade(leaf, -0.3), hw * cx, hh * cy, hw * size, hh * size * 0.88, 4, 0.34, cx * 6, 0.16)
        context.fillStyle = leaf
        lobedShape(context, hw * (cx - 0.1), hh * (cy - 0.12), hw * size * 0.6, hh * size * 0.54, 3, 0.32, cy * 5)
      }
      context.fillStyle = t.leafLight
      lobedShape(context, hw * 0.02, hh * -0.52, hw * 0.24, hh * 0.2, 3, 0.3)
      return
    }
    // Куст — плотная низкая куртина без ствола: этим он и не путается с берёзой.
    outlinedLobes(context, palette, shade(t.leaf, -0.3), 0, hh * 0.04, hw * 0.96, hh * 0.86, 5, 0.24)
    context.fillStyle = t.leaf
    lobedShape(context, -hw * 0.34, -hh * 0.12, hw * 0.58, hh * 0.52, 4, 0.3, 1.1)
    lobedShape(context, hw * 0.36, hh * 0.16, hw * 0.52, hh * 0.46, 4, 0.32, 2.3)
    context.fillStyle = t.leafLight
    lobedShape(context, -hw * 0.24, -hh * 0.3, hw * 0.36, hh * 0.32, 3, 0.3)
  }
}

/**
 * Камни: валун с гранями и пара окатышей. Камень узнаётся не формой — сверху он
 * почти круглый, — а серым тоном и резкой границей света и тени по одной грани.
 * Поэтому валун собран из тёмного низа, серого тела и светлой верхней грани.
 */
function rockPainter(kind: 'small' | 'boulder' | 'stalagmite' | 'rubble'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'stalagmite') {
      // Сталагмит — тот же камень, только конус. Сверху конус читается кольцами,
      // сходящимися к светлому острию: гранёный силуэт валуна тут не годится —
      // натёк округлый, а сужение к вершине бывает только у него.
      propContour(context, palette, 0, 0, hw * 0.98, hh * 0.98)
      context.fillStyle = shade(t.stone, -0.36)
      starShape(context, 0, 0, hw * 0.92, hh * 0.92, 7, 0.74, 0.3)
      context.fillStyle = t.stone
      starShape(context, 0, 0, hw * 0.64, hh * 0.64, 7, 0.74, 0.5)
      context.fillStyle = t.stoneLight
      starShape(context, 0, 0, hw * 0.38, hh * 0.38, 7, 0.72, 0.7)
      const cracks: Array<[number, number, number, number]> = []
      for (let index = 0; index < 4; index += 1) {
        const angle = (index / 4) * Math.PI * 2 + 0.6
        cracks.push([
          Math.cos(angle) * hw * 0.22, Math.sin(angle) * hh * 0.22,
          Math.cos(angle) * hw * 0.86, Math.sin(angle) * hh * 0.86,
        ])
      }
      lines(context, shade(t.stone, -0.5), thin * 0.08, cracks)
      context.fillStyle = shade(t.stone, 0.5)
      circle(context, 0, 0, thin * 0.14)
      return
    }
    if (kind === 'rubble') {
      // Осыпь — тот же камень, но битый: россыпь угловатых обломков. Каждый
      // обводится отдельно, иначе куча слипается в одно пятно и перестаёт
      // отличаться от валуна, у которого грань всего одна.
      const chip = (cx: number, cy: number, radius: number, seed: number) => {
        const points: Array<[number, number]> = []
        for (let index = 0; index < 5; index += 1) {
          const angle = (index / 5) * Math.PI * 2 + seed
          const reach = 0.68 + 0.32 * Math.abs(Math.sin(seed * 3 + index * 1.7))
          points.push([cx + Math.cos(angle) * radius * reach, cy + Math.sin(angle) * radius * reach * 0.92])
        }
        polygon(context, points)
      }
      const chips: Array<[number, number, number, number]> = [
        [-0.44, 0.36, 0.5, 0.3], [0.46, 0.44, 0.42, 1.2], [0.5, -0.32, 0.48, 2.1],
        [-0.5, -0.38, 0.42, 0.9], [0.0, 0.0, 0.54, 1.7],
      ]
      for (const [cx, cy, size, seed] of chips) {
        context.fillStyle = t.shadow
        chip(hw * cx, hh * cy, thin * size * 1.2, seed)
      }
      for (const [cx, cy, size, seed] of chips) {
        context.fillStyle = seed > 1.5 ? t.stoneLight : shade(t.stone, seed > 0.8 ? -0.24 : 0)
        chip(hw * cx, hh * cy, thin * size, seed)
      }
      return
    }
    if (kind === 'small') {
      // Контур обводит каждый окатыш отдельно, иначе пара камней слипается в
      // одно пятно и перестаёт читаться как россыпь.
      propContour(context, palette, -hw * 0.34, hh * 0.1, hw * 0.62, hh * 0.62)
      propContour(context, palette, hw * 0.54, hh * 0.14, hw * 0.5, hh * 0.6)
      context.fillStyle = shade(t.stone, -0.2)
      polygon(context, [[-hw * 0.86, hh * 0.5], [-hw * 0.6, -hh * 0.28], [-hw * 0.02, -hh * 0.44], [hw * 0.16, hh * 0.24], [-hw * 0.32, hh * 0.64]])
      context.fillStyle = t.stoneLight
      polygon(context, [[-hw * 0.7, hh * 0.1], [-hw * 0.48, -hh * 0.24], [-hw * 0.08, -hh * 0.34], [-hw * 0.16, hh * 0.14]])
      context.fillStyle = t.stone
      polygon(context, [[hw * 0.12, hh * 0.6], [hw * 0.2, -hh * 0.2], [hw * 0.72, -hh * 0.42], [hw * 0.94, hh * 0.26], [hw * 0.56, hh * 0.72]])
      context.fillStyle = t.stoneLight
      polygon(context, [[hw * 0.28, hh * 0.06], [hw * 0.36, -hh * 0.22], [hw * 0.72, -hh * 0.32], [hw * 0.62, hh * 0.04]])
      return
    }
    context.fillStyle = t.shadow
    polygon(context, [[-hw * 1.0, hh * 0.5], [-hw * 0.8, -hh * 0.52], [-hw * 0.1, -hh * 1.0], [hw * 0.74, -hh * 0.78], [hw * 1.0, hh * 0.2], [hw * 0.52, hh * 1.0], [-hw * 0.5, hh * 0.98]])
    context.fillStyle = shade(t.stone, -0.34)
    polygon(context, [[-hw * 0.9, hh * 0.4], [-hw * 0.7, -hh * 0.44], [-hw * 0.1, -hh * 0.9], [hw * 0.64, -hh * 0.68], [hw * 0.9, hh * 0.14], [hw * 0.44, hh * 0.88], [-hw * 0.42, hh * 0.86]])
    context.fillStyle = t.stone
    polygon(context, [[-hw * 0.8, hh * 0.24], [-hw * 0.56, -hh * 0.42], [-hw * 0.04, -hh * 0.82], [hw * 0.58, -hh * 0.56], [hw * 0.8, hh * 0.1], [hw * 0.34, hh * 0.72], [-hw * 0.34, hh * 0.68]])
    // Освещённая грань: одна на камень, всегда сверху слева — тот же свет, что
    // и у тени. Без неё валун остаётся плоским пятном.
    context.fillStyle = t.stoneLight
    polygon(context, [[-hw * 0.62, -hh * 0.06], [-hw * 0.4, -hh * 0.56], [hw * 0.06, -hh * 0.76], [hw * 0.3, -hh * 0.3], [-hw * 0.16, hh * 0.06]])
    lines(context, shade(t.stone, -0.42), thin * 0.1, [
      [-hw * 0.18, -hh * 0.72, hw * 0.06, -hh * 0.1],
      [hw * 0.06, -hh * 0.1, hw * 0.66, hh * 0.16],
      [hw * 0.06, -hh * 0.1, -hw * 0.2, hh * 0.62],
    ])
  }
}

/** Огонь: очаг у стены, открытый очаг, костёр и жаровня. */
function firePainter(kind: 'fireplace' | 'hearth' | 'camp' | 'brazier'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'brazier') {
      // Жаровня — тот же открытый огонь, но на треноге. Ноги, торчащие из-под
      // чаши, и есть то, чем она отличается от очага: у очага опор нет, и без
      // них жаровня повторяла бы его кружок в кружке.
      const legs: Array<[number, number, number, number]> = []
      for (let index = 0; index < 3; index += 1) {
        const angle = (index / 3) * Math.PI * 2 - Math.PI / 2
        legs.push([
          Math.cos(angle) * hw * 0.3, Math.sin(angle) * hh * 0.3,
          Math.cos(angle) * hw * 1.0, Math.sin(angle) * hh * 1.0,
        ])
      }
      lines(context, t.shadow, thin * 0.26, legs)
      lines(context, t.deep, thin * 0.17, legs)
      context.fillStyle = shade(t.stone, -0.34)
      starShape(context, 0, 0, hw * 0.84, hh * 0.84, 8, 0.9)
      context.fillStyle = t.stone
      starShape(context, 0, 0, hw * 0.72, hh * 0.72, 8, 0.9, Math.PI / 8)
      context.fillStyle = shade(palette.wall, -0.42)
      circle(context, 0, 0, thin * 0.5)
      flame(context, thin * 0.56, palette)
      return
    }
    if (kind === 'fireplace') {
      context.fillStyle = t.stone
      context.fillRect(-hw * 0.96, -hh * 0.86, hw * 1.92, hh * 1.72)
      context.fillStyle = t.deep
      context.fillRect(-hw * 0.46, -hh * 0.1, hw * 0.92, hh * 0.94)
      flame(context, thin * 0.52, palette)
      return
    }
    if (kind === 'camp') {
      // Кольцо камней вокруг кострища. Костёр узнаётся именно по обкладке:
      // одно светлое пятнышко пламени на газоне читается цветком.
      for (let index = 0; index < 7; index += 1) {
        const angle = (index / 7) * Math.PI * 2 + 0.4
        context.fillStyle = index % 2 ? t.stone : shade(t.stone, -0.24)
        circle(context, Math.cos(angle) * hw * 0.84, Math.sin(angle) * hh * 0.84, thin * 0.24)
      }
      context.fillStyle = shade(palette.wall, -0.4)
      circle(context, 0, 0, thin * 0.66)
      lines(context, t.dark, thin * 0.16, [
        [-hw * 0.56, -hh * 0.34, hw * 0.56, hh * 0.34],
        [-hw * 0.56, hh * 0.34, hw * 0.56, -hh * 0.34],
      ])
      flame(context, thin * 0.62, palette)
      return
    }
    context.fillStyle = t.stone
    circle(context, 0, 0, thin * 0.94)
    context.fillStyle = t.deep
    circle(context, 0, 0, thin * 0.66)
    flame(context, thin * 0.6, palette)
  }
}

/**
 * Поленница: торцы брёвен рядами. Дрова у очага и штабель во дворе.
 *
 * Под торцами лежит тёмный короб во весь габарит: без него редкие кружки на
 * траве читались рассыпанной крупой, а не сложенной кучей — масса штабеля и
 * есть то, по чему поленница узнаётся с общего плана.
 */
function logsPainter(kind: 'indoor' | 'outdoor' | 'fallen'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    if (kind === 'fallen') {
      // Валежник — то же бревно, но одно и лежащее: длинное тулово в коре и
      // светлый спил на торце. Спил и есть примета, по которой ствол не путается
      // с бортиком или скамьёй — у тех торцов нет.
      const thin = Math.min(hw, hh)
      context.fillStyle = t.shadow
      context.fillRect(-hw * 0.98, -hh * 0.7, hw * 1.96, hh * 1.4)
      context.fillStyle = t.bark
      context.fillRect(-hw * 0.96, -hh * 0.64, hw * 1.92, hh * 1.28)
      context.fillStyle = shade(palette.prop, -0.34)
      context.fillRect(-hw * 0.96, -hh * 0.64, hw * 1.92, hh * 0.5)
      lines(context, shade(palette.prop, -0.66), thin * 0.09, [
        [-hw * 0.9, -hh * 0.16, hw * 0.82, -hh * 0.1],
        [-hw * 0.84, hh * 0.3, hw * 0.9, hh * 0.24],
        // Обломанный сук: без него ствол — просто брус.
        [-hw * 0.2, -hh * 0.6, -hw * 0.42, -hh * 1.0],
      ])
      context.fillStyle = shade(palette.prop, 0.12)
      ellipseShape(context, hw * 0.88, 0, hw * 0.11, hh * 0.62)
      context.fillStyle = shade(palette.prop, 0.4)
      ellipseShape(context, hw * 0.88, 0, hw * 0.07, hh * 0.4)
      context.fillStyle = t.bark
      ellipseShape(context, hw * 0.88, 0, hw * 0.025, hh * 0.14)
      return
    }
    // Полено у очага крупнее и их меньше: на клетке 1×1 шесть торцов дают
    // кружки в три-четыре точки, которые сливаются в крапину.
    const columns = kind === 'outdoor' ? 4 : 2
    context.fillStyle = t.shadow
    context.fillRect(-hw * 0.94, -hh * 0.9, hw * 1.88, hh * 1.86)
    context.fillStyle = t.deep
    context.fillRect(-hw * 0.88, -hh * 0.84, hw * 1.76, hh * 1.68)
    const radius = Math.min((hw * 1.76) / (columns * 2), (hh * 1.68) / 4)
    const left = -radius * columns
    const top = -radius * 2
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = left + radius + column * radius * 2
        const y = top + radius + row * radius * 2
        context.fillStyle = (row + column) % 2 ? t.base : t.dark
        circle(context, x, y, radius * 0.94)
        context.fillStyle = shade(palette.prop, (row + column) % 2 ? 0.34 : 0.12)
        circle(context, x, y, radius * 0.5)
        context.fillStyle = t.deep
        circle(context, x, y, radius * 0.16)
      }
    }
  }
}

/** Кровати: одиночная и двухъярусная. Подушка показывает изголовье. */
function bedPainter(kind: 'single' | 'bunk'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    context.fillStyle = t.dark
    context.fillRect(-hw * 0.96, -hh * 0.94, hw * 1.92, hh * 1.88)
    context.fillStyle = t.base
    context.fillRect(-hw * 0.88, -hh * 0.86, hw * 1.76, hh * 1.72)
    context.fillStyle = t.light
    context.fillRect(-hw * 0.82, -hh * 0.7, hw * 0.5, hh * 1.4)
    context.fillStyle = shade(palette.propAccent, 0.18)
    context.fillRect(-hw * 0.24, -hh * 0.7, hw * 1.0, hh * 1.4)
    if (kind === 'bunk') lines(context, t.deep, Math.min(hw, hh) * 0.1, [[-hw * 0.88, 0, hw * 0.88, 0]])
  }
}

/** Лестницы: вверх ступени сужаются, вниз — расширяются. */
function stairsPainter(kind: 'up' | 'down'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const steps = 4
    const step = (hh * 1.84) / steps
    for (let index = 0; index < steps; index += 1) {
      const share = kind === 'up' ? index / steps : (steps - 1 - index) / steps
      const width = hw * 2 * (1 - share * 0.44)
      context.fillStyle = index % 2 ? t.base : t.dark
      context.fillRect(-width / 2, -hh * 0.92 + index * step, width, Math.max(0.5, step * 0.82))
    }
  }
}

/**
 * Настенные декали: факел, фонарь, знамя, вывеска, храмовая хоругвь, паутина и
 * рудная жила. Плоско, без тени и объёма: всё это лежит на стене, а не стоит.
 */
function wallDecalPainter(kind: 'torch' | 'lantern' | 'banner' | 'sign' | 'temple' | 'cobweb' | 'ore'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'temple') {
      // Хоругвь — то же полотнище, что и знамя, но со светлой полосой и звездой
      // вместо круглой нашивки: по знаку храмовое полотно и отличается от
      // трактирного, силуэт у них один.
      context.fillStyle = shade(palette.propAccent, -0.24)
      polygon(context, [[-hw * 0.78, -hh], [hw * 0.78, -hh], [hw * 0.78, hh * 0.56], [0, hh], [-hw * 0.78, hh * 0.56]])
      context.fillStyle = t.glow
      context.fillRect(-hw * 0.24, -hh, hw * 0.48, hh * 1.62)
      context.fillStyle = shade(palette.propAccent, -0.5)
      starShape(context, 0, -hh * 0.24, thin * 0.62, thin * 0.62, 6, 0.42)
      return
    }
    if (kind === 'cobweb') {
      // Паутина затягивает угол, поэтому нити идут от одного угла габарита, а не
      // из центра: круглая сеть посреди клетки читалась бы мишенью.
      const pale = shade(palette.propAccent, 0.52)
      const originX = -hw * 0.92
      const originY = -hh * 0.92
      const rays = 5
      const radials: Array<[number, number, number, number]> = []
      for (let index = 0; index < rays; index += 1) {
        const angle = (index / (rays - 1)) * (Math.PI / 2)
        radials.push([originX, originY, originX + Math.cos(angle) * hw * 1.86, originY + Math.sin(angle) * hh * 1.86])
      }
      lines(context, pale, thin * 0.1, radials)
      const webs: Array<[number, number, number, number]> = []
      for (const reach of [0.42, 0.72, 1.0]) {
        for (let index = 0; index < rays - 1; index += 1) {
          const from = (index / (rays - 1)) * (Math.PI / 2)
          const to = ((index + 1) / (rays - 1)) * (Math.PI / 2)
          webs.push([
            originX + Math.cos(from) * hw * 1.86 * reach, originY + Math.sin(from) * hh * 1.86 * reach,
            originX + Math.cos(to) * hw * 1.86 * reach, originY + Math.sin(to) * hh * 1.86 * reach,
          ])
        }
      }
      lines(context, pale, thin * 0.08, webs)
      return
    }
    if (kind === 'ore') {
      // Жила: тёмный вывал породы и светлая прожилка металла поперёк него.
      // Металл берётся тоном замка — единственным «блестящим» в палитре.
      context.fillStyle = shade(t.stone, -0.44)
      lobedShape(context, 0, 0, hw * 0.9, hh * 0.94, 5, 0.28)
      context.fillStyle = shade(t.stone, -0.2)
      lobedShape(context, -hw * 0.08, -hh * 0.06, hw * 0.6, hh * 0.62, 4, 0.3, 1.2)
      lines(context, palette.lock, thin * 0.15, [
        [-hw * 0.72, hh * 0.5, -hw * 0.16, -hh * 0.06],
        [-hw * 0.16, -hh * 0.06, hw * 0.3, hh * 0.2],
        [hw * 0.3, hh * 0.2, hw * 0.74, -hh * 0.52],
      ])
      context.fillStyle = shade(palette.lock, 0.32)
      circle(context, -hw * 0.16, -hh * 0.06, thin * 0.15)
      circle(context, hw * 0.34, hh * 0.22, thin * 0.12)
      return
    }
    if (kind === 'banner') {
      context.fillStyle = t.accent
      polygon(context, [[-hw * 0.8, -hh], [hw * 0.8, -hh], [hw * 0.8, hh * 0.6], [0, hh], [-hw * 0.8, hh * 0.6]])
      context.fillStyle = shade(palette.propAccent, -0.32)
      circle(context, 0, -hh * 0.12, thin * 0.34)
      return
    }
    if (kind === 'sign') {
      context.fillStyle = t.base
      context.fillRect(-hw * 0.9, -hh * 0.7, hw * 1.8, hh * 1.4)
      lines(context, t.deep, thin * 0.13, [
        [-hw * 0.6, -hh * 0.2, hw * 0.6, -hh * 0.2],
        [-hw * 0.6, hh * 0.24, hw * 0.3, hh * 0.24],
      ])
      return
    }
    context.fillStyle = t.dark
    context.fillRect(-hw * 0.22, -hh * 0.1, hw * 0.44, hh * 1.04)
    if (kind === 'lantern') {
      context.fillStyle = t.accent
      polygon(context, [[-hw * 0.66, -hh * 0.16], [hw * 0.66, -hh * 0.16], [hw * 0.46, -hh], [-hw * 0.46, -hh]])
      context.fillStyle = t.glow
      circle(context, 0, -hh * 0.56, thin * 0.3)
      return
    }
    flame(context, thin * 0.86, palette)
  }
}

/** Наземные декали: ковёр, пятно, камень тропы, трава, цветы, мозаика, папоротник и люк. */
function groundDecalPainter(kind: 'rug' | 'stain' | 'path' | 'grass' | 'flowers' | 'mosaic' | 'fern' | 'trapdoor'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'mosaic') {
      // Мозаика — тот же настил, что и ковёр, но круглый и каменный: розетка из
      // колец. Прямоугольник повторял бы ковёр, а храмовый пол набирают кругом.
      context.fillStyle = shade(t.stone, 0.16)
      ellipseShape(context, 0, 0, hw * 0.96, hh * 0.96)
      context.fillStyle = shade(t.stone, -0.24)
      ellipseShape(context, 0, 0, hw * 0.88, hh * 0.88)
      context.fillStyle = t.cool
      starShape(context, 0, 0, hw * 0.82, hh * 0.82, 8, 0.62)
      context.fillStyle = shade(t.stone, 0.3)
      ellipseShape(context, 0, 0, hw * 0.46, hh * 0.46)
      context.fillStyle = t.accent
      starShape(context, 0, 0, hw * 0.42, hh * 0.42, 6, 0.52, Math.PI / 6)
      context.fillStyle = shade(palette.propAccent, -0.4)
      ellipseShape(context, 0, 0, hw * 0.16, hh * 0.16)
      // Расшивка: без швов заливка читается лужей, а не набором.
      const seams: Array<[number, number, number, number]> = []
      for (let index = 0; index < 8; index += 1) {
        const angle = (index / 8) * Math.PI * 2
        seams.push([Math.cos(angle) * hw * 0.2, Math.sin(angle) * hh * 0.2, Math.cos(angle) * hw * 0.92, Math.sin(angle) * hh * 0.92])
      }
      lines(context, shade(t.stone, -0.4), thin * 0.05, seams)
      return
    }
    if (kind === 'fern') {
      // Папоротник — веер вай из одного основания, а не розетка по кругу:
      // симметричная розетка уже занята хвойной кроной, и на опушке папоротник
      // от неё было не отличить. Вайя рисуется залитым пером с зубчатым краем —
      // волоски при клетке в 22 px не видны вовсе.
      const frond = (angle: number, length: number, width: number, color: string) => {
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        const at = (along: number, out: number): [number, number] => [
          hw * (cos * length * along - sin * out),
          hh * (0.78 + sin * length * along + cos * out),
        ]
        const steps = 6
        const points: Array<[number, number]> = []
        for (let index = 0; index <= steps; index += 1) {
          points.push(at(index / steps, width * (1 - index / steps) * (index % 2 ? 1 : 0.44)))
        }
        for (let index = steps; index >= 0; index -= 1) {
          points.push(at(index / steps, -width * (1 - index / steps) * (index % 2 ? 1 : 0.44)))
        }
        context.fillStyle = color
        polygon(context, points)
      }
      const deep = shade(palette.foliage, -0.3)
      const fan: Array<[number, number]> = [[-0.95, 1.1], [-0.72, 1.45], [-0.5, 1.66], [-0.28, 1.45], [-0.05, 1.1]]
      fan.forEach(([share, length], index) => {
        frond(Math.PI * share, length, 0.22, index % 2 ? deep : palette.foliage)
      })
      frond(-Math.PI * 0.62, 0.95, 0.15, palette.foliageLight)
      frond(-Math.PI * 0.38, 0.95, 0.15, palette.foliageLight)
      return
    }
    if (kind === 'rug') {
      context.fillStyle = t.accent
      context.fillRect(-hw, -hh, hw * 2, hh * 2)
      context.fillStyle = shade(palette.propAccent, -0.34)
      context.fillRect(-hw * 0.86, -hh * 0.78, hw * 1.72, hh * 1.56)
      context.fillStyle = shade(palette.propAccent, 0.22)
      context.fillRect(-hw * 0.56, -hh * 0.46, hw * 1.12, hh * 0.92)
      return
    }
    if (kind === 'trapdoor') {
      context.fillStyle = t.dark
      context.fillRect(-hw * 0.86, -hh * 0.86, hw * 1.72, hh * 1.72)
      lines(context, t.deep, thin * 0.1, [
        [-hw * 0.86, -hh * 0.2, hw * 0.86, -hh * 0.2],
        [-hw * 0.86, hh * 0.3, hw * 0.86, hh * 0.3],
      ])
      context.fillStyle = palette.lock
      circle(context, hw * 0.5, 0, thin * 0.14)
      return
    }
    if (kind === 'path') {
      context.fillStyle = shade(t.stone, -0.1)
      ellipseShape(context, -hw * 0.3, -hh * 0.2, hw * 0.56, hh * 0.5)
      context.fillStyle = shade(t.stone, 0.14)
      ellipseShape(context, hw * 0.34, hh * 0.26, hw * 0.5, hh * 0.44)
      return
    }
    if (kind === 'stain') {
      context.fillStyle = t.deep
      ellipseShape(context, 0, 0, hw * 0.88, hh * 0.74)
      ellipseShape(context, hw * 0.52, hh * 0.4, hw * 0.34, hh * 0.3)
      return
    }
    // Былинки берут тот же тон листвы: выведенный из зоны цвет ложился в тон
    // газона, и пучок травы на газоне было не разглядеть.
    lines(context, shade(palette.foliage, -0.12), thin * 0.15, [
      [-hw * 0.6, hh * 0.8, -hw * 0.3, -hh * 0.7],
      [0, hh * 0.8, hw * 0.1, -hh * 0.85],
      [hw * 0.6, hh * 0.8, hw * 0.4, -hh * 0.5],
    ])
    lines(context, palette.foliageLight, thin * 0.1, [
      [-hw * 0.3, hh * 0.8, -hw * 0.62, -hh * 0.4],
      [hw * 0.3, hh * 0.8, hw * 0.66, -hh * 0.3],
    ])
    if (kind !== 'flowers') return
    context.fillStyle = palette.propAccent
    circle(context, -hw * 0.3, -hh * 0.7, thin * 0.19)
    circle(context, hw * 0.1, -hh * 0.8, thin * 0.17)
    circle(context, hw * 0.4, -hh * 0.5, thin * 0.16)
  }
}

/** Посуда на столе: кружка, кувшин, бутылка, стакан для костей. */
function tablewarePainter(kind: 'mug' | 'jug' | 'bottle' | 'cup'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'bottle') {
      context.fillStyle = t.cool
      context.fillRect(-hw * 0.62, -hh * 0.12, hw * 1.24, hh * 1.1)
      context.fillRect(-hw * 0.24, -hh * 0.98, hw * 0.48, hh * 0.92)
      context.fillStyle = t.dark
      context.fillRect(-hw * 0.26, -hh * 0.98, hw * 0.52, hh * 0.22)
      return
    }
    context.fillStyle = kind === 'jug' ? t.light : t.base
    circle(context, 0, 0, thin * 0.84)
    context.fillStyle = kind === 'cup' ? t.deep : t.dark
    circle(context, 0, 0, thin * 0.52)
    if (kind === 'cup') return
    lines(context, t.dark, thin * 0.17, [[thin * 0.76, -thin * 0.2, thin * 1.08, thin * 0.2]])
  }
}

/** Плоская снедь: тарелка, миска, сыр, доска, хлеб и горстка монет. */
function platterPainter(kind: 'plate' | 'bowl' | 'cheese' | 'board' | 'bread' | 'coins'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'board') {
      context.fillStyle = t.base
      context.fillRect(-hw * 0.9, -hh * 0.8, hw * 1.8, hh * 1.6)
      context.fillStyle = t.light
      circle(context, hw * 0.22, 0, thin * 0.42)
      return
    }
    if (kind === 'bread') {
      context.fillStyle = shade(palette.propAccent, -0.18)
      ellipseShape(context, 0, 0, hw * 0.92, hh * 0.86)
      lines(context, shade(palette.propAccent, -0.46), thin * 0.16, [
        [-hw * 0.4, -hh * 0.3, -hw * 0.18, hh * 0.3],
        [hw * 0.12, -hh * 0.34, hw * 0.32, hh * 0.26],
      ])
      return
    }
    if (kind === 'coins') {
      context.fillStyle = palette.lock
      circle(context, -hw * 0.3, hh * 0.2, thin * 0.52)
      circle(context, hw * 0.28, hh * 0.12, thin * 0.46)
      context.fillStyle = shade(palette.lock, 0.3)
      circle(context, 0, -hh * 0.26, thin * 0.44)
      return
    }
    context.fillStyle = kind === 'cheese' ? shade(palette.propAccent, 0.16) : t.light
    circle(context, 0, 0, thin * 0.94)
    context.fillStyle = kind === 'bowl' ? shade(palette.propAccent, -0.3) : kind === 'cheese' ? shade(palette.propAccent, -0.24) : t.base
    if (kind === 'cheese') polygon(context, [[0, 0], [thin * 0.94, -thin * 0.34], [thin * 0.86, thin * 0.4]])
    else circle(context, 0, 0, thin * 0.6)
  }
}

/** Свечи: одиночная на столе и канделябр на три рожка. */
function candlePainter(kind: 'candle' | 'stand'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'stand') {
      context.fillStyle = t.dark
      circle(context, 0, hh * 0.42, thin * 0.6)
      context.fillStyle = t.light
      for (const share of [-0.5, 0, 0.5]) context.fillRect(hw * share - thin * 0.12, -hh * 0.8, thin * 0.24, hh * 0.9)
      context.fillStyle = t.glow
      for (const share of [-0.5, 0, 0.5]) circle(context, hw * share, -hh * 0.86, thin * 0.17)
      return
    }
    context.fillStyle = t.light
    context.fillRect(-hw * 0.38, -hh * 0.36, hw * 0.76, hh * 1.3)
    context.fillStyle = t.glow
    circle(context, 0, -hh * 0.6, thin * 0.5)
  }
}

/** Столбы: коновязь, фонарный столб, указатель и метла в углу. */
function postPainter(kind: 'hitching' | 'lamp' | 'sign' | 'broom'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'hitching') {
      // Коновязь — это перекладина на двух столбах. Один столб с поперечиной
      // давал знак «Т», который на газоне читался обломком доски.
      context.fillStyle = t.shadow
      context.fillRect(-hw * 0.94, -hh * 0.68, hw * 1.88, thin * 0.4)
      context.fillStyle = t.deep
      for (const side of [-0.74, 0.74]) {
        context.fillRect(hw * side - thin * 0.2, -hh * 0.9, thin * 0.4, hh * 1.84)
      }
      context.fillStyle = t.base
      context.fillRect(-hw * 0.94, -hh * 0.8, hw * 1.88, thin * 0.34)
      context.fillStyle = t.light
      for (const side of [-0.74, 0.74]) {
        context.fillRect(hw * side - thin * 0.13, -hh * 0.84, thin * 0.26, hh * 0.6)
      }
      return
    }
    context.fillStyle = t.dark
    context.fillRect(-thin * 0.15, -hh * 0.8, thin * 0.3, hh * 1.7)
    if (kind === 'lamp') {
      context.fillStyle = t.accent
      circle(context, 0, -hh * 0.76, thin * 0.44)
      context.fillStyle = t.glow
      circle(context, 0, -hh * 0.76, thin * 0.22)
      return
    }
    if (kind === 'sign') {
      context.fillStyle = t.base
      context.fillRect(-hw * 0.8, -hh * 0.88, hw * 1.6, hh * 0.62)
      lines(context, t.deep, thin * 0.11, [[-hw * 0.54, -hh * 0.58, hw * 0.5, -hh * 0.58]])
      return
    }
    context.fillStyle = t.accent
    polygon(context, [[-thin * 0.42, hh * 0.28], [thin * 0.42, hh * 0.28], [thin * 0.62, hh * 0.9], [-thin * 0.62, hh * 0.9]])
  }
}

/**
 * Телега: кузов с досками, четыре колеса по углам и дышло. Двух колёс мало —
 * сверху они читаются как случайные пятна под ящиком; четыре по углам и оглобля
 * впереди дают ту самую пару осей, по которой повозка узнаётся сразу.
 */
function cartPainter(): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    const wheel = thin * 0.34
    // Контур обводит кузов, а не весь габарит: колёса торчат из-под него сами.
    context.fillStyle = t.shadow
    context.fillRect(-hw * 0.86, -hh * 0.78, hw * 1.72, hh * 1.56)
    // Дышло: только оно показывает, каким концом телега стоит.
    context.fillStyle = t.dark
    context.fillRect(-hw * 1.0, -thin * 0.09, hw * 0.34, thin * 0.18)
    for (const side of [-1, 1]) {
      for (const end of [-0.52, 0.52]) {
        context.fillStyle = t.deep
        circle(context, hw * end, hh * side * 0.82, wheel)
        context.fillStyle = shade(palette.prop, -0.12)
        circle(context, hw * end, hh * side * 0.82, wheel * 0.52)
      }
    }
    context.fillStyle = t.deep
    context.fillRect(-hw * 0.78, -hh * 0.68, hw * 1.6, hh * 1.36)
    context.fillStyle = t.base
    context.fillRect(-hw * 0.72, -hh * 0.6, hw * 1.48, hh * 1.2)
    lines(context, t.deep, thin * 0.1, [
      [-hw * 0.28, -hh * 0.6, -hw * 0.28, hh * 0.6],
      [hw * 0.26, -hh * 0.6, hw * 0.26, hh * 0.6],
    ])
  }
}

/**
 * Колесо от телеги: обод, ступица и шесть спиц. Спиц именно шесть, а не крест:
 * крестом рисуется ворот колодца, и с четырьмя спицами колесо и колодец на
 * общем плане сливались в один значок.
 */
function wheelPainter(): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const radius = Math.min(hw, hh) * 0.96
    propContour(context, palette, 0, 0, radius * 1.1, radius * 1.1)
    context.fillStyle = t.deep
    circle(context, 0, 0, radius)
    context.fillStyle = t.base
    circle(context, 0, 0, radius * 0.84)
    context.fillStyle = t.dark
    circle(context, 0, 0, radius * 0.66)
    const spokes: Array<[number, number, number, number]> = []
    for (let index = 0; index < 3; index += 1) {
      const angle = (index / 3) * Math.PI
      spokes.push([
        -Math.cos(angle) * radius * 0.8, -Math.sin(angle) * radius * 0.8,
        Math.cos(angle) * radius * 0.8, Math.sin(angle) * radius * 0.8,
      ])
    }
    lines(context, t.light, radius * 0.11, spokes)
    context.fillStyle = t.deep
    circle(context, 0, 0, radius * 0.22)
  }
}

/**
 * Стоячая вода: поилка во дворе и подземное озеро. Одна и та же вода в разной
 * оправе — у поилки короб из досок, у озера каменный окаём. Дно и блик берут
 * тон окна: он и есть вода в палитре доски.
 */
function waterPainter(kind: 'trough' | 'pool'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    if (kind === 'pool') {
      // Берег неровный: ровный овал посреди пещеры читается плитой, а не водой.
      context.fillStyle = t.shadow
      lobedShape(context, 0, 0, hw * 0.99, hh * 0.99, 5, 0.14)
      context.fillStyle = shade(t.stone, -0.3)
      lobedShape(context, 0, 0, hw * 0.94, hh * 0.94, 5, 0.14, 0.3)
      context.fillStyle = t.stone
      lobedShape(context, -hw * 0.02, hh * 0.02, hw * 0.86, hh * 0.86, 6, 0.16, 1.1)
      context.fillStyle = t.waterDeep
      lobedShape(context, 0, 0, hw * 0.74, hh * 0.74, 6, 0.18, 2.0)
      context.fillStyle = t.water
      lobedShape(context, -hw * 0.05, -hh * 0.04, hw * 0.6, hh * 0.6, 5, 0.2, 0.7)
      // Блики: без них вода — просто тёмное пятно, а тёмное пятно в пещере
      // читается провалом, и по нему пойдут пешком.
      context.fillStyle = shade(palette.window, 0.3)
      ellipseShape(context, -hw * 0.3, -hh * 0.3, hw * 0.2, hh * 0.09)
      ellipseShape(context, hw * 0.18, hh * 0.22, hw * 0.15, hh * 0.07)
      ellipseShape(context, hw * 0.02, -hh * 0.06, hw * 0.1, hh * 0.05)
      return
    }
    context.fillStyle = t.dark
    context.fillRect(-hw * 0.96, -hh * 0.8, hw * 1.92, hh * 1.6)
    context.fillStyle = t.cool
    context.fillRect(-hw * 0.82, -hh * 0.58, hw * 1.64, hh * 1.16)
    context.fillStyle = shade(palette.window, 0.25)
    ellipseShape(context, -hw * 0.3, 0, hw * 0.24, hh * 0.3)
  }
}

/**
 * Колодец: кладка, вода, два столба и ворот с ведром. Столбы и ведро добавлены
 * ради того же различения, что и спицы у колеса: круг с перекладиной сам по
 * себе — это и колесо, и жёрнов, а два столба поперёк сруба бывают только тут.
 */
function wellPainter(): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    propContour(context, palette, 0, 0, thin * 1.06, thin * 1.06)
    context.fillStyle = shade(t.stone, -0.3)
    circle(context, 0, 0, thin * 0.96)
    context.fillStyle = t.stone
    circle(context, 0, 0, thin * 0.84)
    context.fillStyle = t.stoneLight
    starShape(context, 0, 0, thin * 0.84, thin * 0.84, 7, 0.86, 0.3)
    context.fillStyle = shade(t.stone, -0.42)
    circle(context, 0, 0, thin * 0.62)
    context.fillStyle = mixColors(palette.window, '#000000', 0.5)
    circle(context, 0, 0, thin * 0.54)
    context.fillStyle = shade(palette.window, 0.2)
    ellipseShape(context, -thin * 0.2, -thin * 0.18, thin * 0.16, thin * 0.12)
    // Столбы по краю сруба и перекладина ворота между ними.
    context.fillStyle = t.dark
    context.fillRect(-thin * 0.98, -thin * 0.2, thin * 0.3, thin * 0.4)
    context.fillRect(thin * 0.68, -thin * 0.2, thin * 0.3, thin * 0.4)
    context.fillStyle = t.base
    context.fillRect(-thin * 0.9, -thin * 0.1, thin * 1.8, thin * 0.2)
    context.fillStyle = t.deep
    context.fillRect(-thin * 0.18, -thin * 0.18, thin * 0.36, thin * 0.36)
  }
}

/** Лютня: грушевидный корпус и гриф. */
function lutePainter(): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    context.fillStyle = t.base
    ellipseShape(context, 0, hh * 0.42, hw * 0.94, hh * 0.54)
    context.fillStyle = t.dark
    context.fillRect(-hw * 0.18, -hh * 0.96, hw * 0.36, hh * 1.36)
    context.fillStyle = t.deep
    circle(context, 0, hh * 0.36, thin * 0.28)
  }
}

// --- храм, склеп, пещера, дорога и поселение ------------------------------

/**
 * Колонна: барабан с каннелюрами. Цвет каменный, а не мебельный: колонна из
 * дерева трактира сливалась с бочками и на плане храма читалась пнём.
 */
function pillarPainter(): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    propContour(context, palette, 0, 0, hw * 0.99, hh * 0.99)
    context.fillStyle = shade(t.stone, -0.4)
    ellipseShape(context, 0, 0, hw * 0.96, hh * 0.96)
    context.fillStyle = t.stone
    ellipseShape(context, 0, 0, hw * 0.86, hh * 0.86)
    // Каннелюры — светлые рёбра от края к сердцевине. Тёмными по тёмному ободу
    // их не видно вовсе, а без них барабан колонны — просто окатыш.
    const flutes: Array<[number, number, number, number]> = []
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2 + 0.2
      flutes.push([
        Math.cos(angle) * hw * 0.3, Math.sin(angle) * hh * 0.3,
        Math.cos(angle) * hw * 0.84, Math.sin(angle) * hh * 0.84,
      ])
    }
    lines(context, t.stoneLight, thin * 0.12, flutes)
    context.fillStyle = t.stoneLight
    ellipseShape(context, 0, 0, hw * 0.4, hh * 0.4)
    context.fillStyle = shade(t.stone, -0.18)
    ellipseShape(context, 0, 0, hw * 0.22, hh * 0.22)
  }
}

/** Статуя: постамент, фигура, разведённые руки и голова. */
function statuePainter(): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    // Постамент светлый: тёмным он превращался в глухой ящик, и на плане храма
    // изваяние было не отличить от сундука у стены.
    context.fillStyle = t.shadow
    context.fillRect(-hw * 0.9, -hh * 0.94, hw * 1.8, hh * 1.88)
    context.fillStyle = shade(t.stone, -0.24)
    context.fillRect(-hw * 0.84, -hh * 0.88, hw * 1.68, hh * 1.76)
    context.fillStyle = t.stone
    context.fillRect(-hw * 0.72, -hh * 0.76, hw * 1.44, hh * 1.52)
    // Изваяние: плечи шире бёдер, руки разведены — этим фигура и отличается от
    // глухого столба, который иначе получается из любого камня в клетке.
    context.fillStyle = shade(t.stone, -0.34)
    polygon(context, [[-hw * 0.46, hh * 0.62], [-hw * 0.3, -hh * 0.22], [hw * 0.3, -hh * 0.22], [hw * 0.46, hh * 0.62]])
    context.fillRect(-hw * 0.62, -hh * 0.3, hw * 1.24, thin * 0.26)
    context.fillStyle = shade(t.stone, -0.44)
    circle(context, 0, -hh * 0.5, thin * 0.28)
    context.fillStyle = t.stoneLight
    circle(context, -thin * 0.06, -hh * 0.52, thin * 0.17)
    lines(context, shade(t.stone, -0.5), thin * 0.08, [[0, -hh * 0.22, 0, hh * 0.6]])
  }
}

/** Алтарь: каменный стол с покровом, знаком и свечами по краям. */
function altarPainter(): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    context.fillStyle = t.shadow
    context.fillRect(-hw * 0.96, -hh * 0.9, hw * 1.92, hh * 1.8)
    context.fillStyle = shade(t.stone, -0.3)
    polygon(context, [[-hw * 0.8, -hh * 0.84], [hw * 0.8, -hh * 0.84], [hw * 0.92, hh * 0.84], [-hw * 0.92, hh * 0.84]])
    context.fillStyle = t.stone
    polygon(context, [[-hw * 0.74, -hh * 0.76], [hw * 0.74, -hh * 0.76], [hw * 0.84, hh * 0.66], [-hw * 0.84, hh * 0.66]])
    // Покров и знак поверх него: голый камень 2×1 неотличим от саркофага.
    context.fillStyle = t.accent
    context.fillRect(-hw * 0.5, -hh * 0.66, hw * 1.0, hh * 1.4)
    context.fillStyle = shade(palette.propAccent, -0.38)
    starShape(context, 0, -hh * 0.02, thin * 0.5, thin * 0.5, 6, 0.44)
    context.fillStyle = t.glow
    for (const side of [-0.8, 0.8]) circle(context, hw * side, -hh * 0.1, thin * 0.16)
  }
}

/**
 * Пристенные святыни и ниши: ковчег, придорожная часовня и погребальная ниша.
 * Всё это ящик у стены со святыней внутри — меняется только оправа.
 */
function shrinePainter(kind: 'reliquary' | 'roadside' | 'niche'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'niche') {
      // Ниша — это провал в кладке: тёмный арочный проём в каменной рамке, с
      // костями в глубине. Светлого верха у неё нет, и по темноте она читается.
      context.fillStyle = t.shadow
      context.fillRect(-hw * 0.96, -hh * 0.96, hw * 1.92, hh * 1.92)
      context.fillStyle = shade(t.stone, -0.24)
      context.fillRect(-hw * 0.9, -hh * 0.9, hw * 1.8, hh * 1.8)
      context.fillStyle = t.stoneLight
      context.fillRect(-hw * 0.9, -hh * 0.9, hw * 1.8, hh * 0.22)
      context.fillStyle = shade(palette.wall, -0.55)
      ellipseShape(context, 0, -hh * 0.12, hw * 0.6, hh * 0.6)
      context.fillRect(-hw * 0.6, -hh * 0.12, hw * 1.2, hh * 0.86)
      const pale = shade(palette.propAccent, 0.5)
      context.fillStyle = pale
      ellipseShape(context, 0, hh * 0.24, hw * 0.26, hh * 0.22)
      context.fillStyle = shade(palette.wall, -0.62)
      circle(context, -hw * 0.1, hh * 0.2, thin * 0.07)
      circle(context, hw * 0.1, hh * 0.2, thin * 0.07)
      return
    }
    if (kind === 'roadside') {
      // Часовенка: каменное основание, деревянный киот и двускатная кровелька.
      // Кровелька — единственное, что отличает её от верстового камня.
      context.fillStyle = t.shadow
      context.fillRect(-hw * 0.72, hh * 0.36, hw * 1.44, hh * 0.6)
      context.fillStyle = t.stone
      context.fillRect(-hw * 0.66, hh * 0.32, hw * 1.32, hh * 0.5)
      context.fillStyle = t.deep
      context.fillRect(-hw * 0.46, -hh * 0.32, hw * 0.92, hh * 0.76)
      context.fillStyle = t.base
      context.fillRect(-hw * 0.38, -hh * 0.26, hw * 0.76, hh * 0.64)
      context.fillStyle = t.deep
      polygon(context, [[-hw * 0.68, -hh * 0.26], [0, -hh * 0.9], [hw * 0.68, -hh * 0.26]])
      context.fillStyle = t.dark
      polygon(context, [[-hw * 0.54, -hh * 0.3], [0, -hh * 0.76], [hw * 0.54, -hh * 0.3]])
      context.fillStyle = t.accent
      circle(context, 0, hh * 0.06, thin * 0.2)
      context.fillStyle = t.glow
      circle(context, 0, hh * 0.06, thin * 0.1)
      return
    }
    // Ковчег: каменный ларец с двускатной крышкой. Скаты — два трапециевидных
    // ската от конька к краям: плоские полосы поперёк давали не ларец, а полку.
    // Замка, как у сундука, нет — вместо него самоцвет на коньке.
    context.fillStyle = t.shadow
    context.fillRect(-hw * 0.88, -hh * 0.76, hw * 1.76, hh * 1.52)
    context.fillStyle = shade(t.stone, -0.44)
    context.fillRect(-hw * 0.82, -hh * 0.7, hw * 1.64, hh * 1.4)
    context.fillStyle = shade(t.stone, -0.14)
    polygon(context, [[-hw * 0.82, -hh * 0.7], [hw * 0.82, -hh * 0.7], [hw * 0.58, 0], [-hw * 0.58, 0]])
    context.fillStyle = t.stoneLight
    polygon(context, [[-hw * 0.58, 0], [hw * 0.58, 0], [hw * 0.82, hh * 0.7], [-hw * 0.82, hh * 0.7]])
    context.fillStyle = palette.lock
    context.fillRect(-hw * 0.6, -thin * 0.1, hw * 1.2, thin * 0.2)
    context.fillStyle = shade(t.stone, -0.5)
    for (const x of [-0.78, 0.78]) for (const y of [-0.66, 0.5]) {
      context.fillRect(hw * x - thin * 0.09, hh * y, thin * 0.18, thin * 0.18)
    }
    context.fillStyle = t.accent
    circle(context, 0, 0, thin * 0.23)
    context.fillStyle = t.glow
    circle(context, -thin * 0.05, -thin * 0.06, thin * 0.11)
  }
}

/**
 * Каменные плиты: надгробие, верстовой камень и саркофаг. Одна порода, три
 * огранки — этим семейство и держится вместе.
 */
function slabPainter(kind: 'grave' | 'milestone' | 'sarcophagus'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'milestone') {
      // Верстовой камень: приземистый столбик с побелённой верхушкой и парой
      // насечек. Креста нет — крест бывает только на могиле.
      propContour(context, palette, 0, hh * 0.08, hw * 0.56, hh * 0.86)
      context.fillStyle = shade(t.stone, -0.3)
      ellipseShape(context, 0, -hh * 0.26, hw * 0.5, hh * 0.44)
      context.fillRect(-hw * 0.5, -hh * 0.26, hw * 1.0, hh * 1.12)
      context.fillStyle = t.stone
      ellipseShape(context, 0, -hh * 0.3, hw * 0.42, hh * 0.36)
      context.fillRect(-hw * 0.42, -hh * 0.3, hw * 0.84, hh * 1.06)
      context.fillStyle = t.stoneLight
      ellipseShape(context, 0, -hh * 0.32, hw * 0.34, hh * 0.28)
      context.fillRect(-hw * 0.34, -hh * 0.32, hw * 0.68, hh * 0.4)
      lines(context, shade(t.stone, -0.5), thin * 0.09, [
        [-hw * 0.24, hh * 0.24, hw * 0.24, hh * 0.24],
        [-hw * 0.24, hh * 0.52, hw * 0.1, hh * 0.52],
      ])
      return
    }
    if (kind === 'sarcophagus') {
      // Саркофаг: короб с уступом и крышка поменьше поверх него. Уступ по краю
      // и есть то, чем каменный гроб отличается от алтаря того же габарита.
      context.fillStyle = t.shadow
      context.fillRect(-hw * 0.98, -hh * 0.94, hw * 1.96, hh * 1.88)
      context.fillStyle = shade(t.stone, -0.34)
      context.fillRect(-hw * 0.94, -hh * 0.9, hw * 1.88, hh * 1.8)
      context.fillStyle = shade(t.stone, -0.12)
      context.fillRect(-hw * 0.84, -hh * 0.74, hw * 1.68, hh * 1.48)
      context.fillStyle = t.stone
      context.fillRect(-hw * 0.8, -hh * 0.7, hw * 1.6, hh * 1.4)
      context.fillStyle = t.stoneLight
      context.fillRect(-hw * 0.8, -hh * 0.7, hw * 1.6, hh * 0.4)
      // Изваяние на крышке: голова у изголовья и меч вдоль тела.
      context.fillStyle = shade(t.stone, -0.42)
      circle(context, -hw * 0.58, 0, thin * 0.3)
      lines(context, shade(t.stone, -0.46), thin * 0.11, [
        [-hw * 0.36, 0, hw * 0.66, 0],
        [hw * 0.2, -hh * 0.36, hw * 0.2, hh * 0.36],
      ])
      return
    }
    // Надгробие: плита с закруглённым верхом и крестом.
    context.fillStyle = shade(t.stone, -0.2)
    ellipseShape(context, 0, -hh * 0.1, hw * 0.72, hh * 0.72)
    context.fillStyle = t.stone
    context.fillRect(-hw * 0.7, -hh * 0.1, hw * 1.4, hh * 1.0)
    lines(context, t.deep, thin * 0.1, [
      [0, -hh * 0.5, 0, hh * 0.6], [-hw * 0.36, -hh * 0.1, hw * 0.36, -hh * 0.1],
    ])
  }
}

/**
 * Поселение: торговый навес и плетень. Оба — каркас из жердей, только у навеса
 * поверх него полотнище, а у плетня оно ни к чему.
 */
function settlementPainter(kind: 'stall' | 'fence'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'fence') {
      // Изгородь: столбики поперёк и две жерди вдоль. Сплошная доска читалась бы
      // бортиком, а редкие столбы — тем, что через плетень видно.
      context.fillStyle = t.dark
      context.fillRect(-hw * 0.98, -hh * 0.36, hw * 1.96, thin * 0.24)
      context.fillRect(-hw * 0.98, hh * 0.14, hw * 1.96, thin * 0.24)
      context.fillStyle = t.deep
      for (const share of [-0.88, -0.3, 0.28, 0.86]) {
        context.fillRect(hw * share - thin * 0.14, -hh * 0.78, thin * 0.28, hh * 1.56)
      }
      context.fillStyle = t.base
      for (const share of [-0.88, -0.3, 0.28, 0.86]) {
        context.fillRect(hw * share - thin * 0.09, -hh * 0.74, thin * 0.18, hh * 1.2)
      }
      context.fillStyle = t.light
      context.fillRect(-hw * 0.98, -hh * 0.36, hw * 1.96, thin * 0.12)
      return
    }
    // Прилавок: полосатый навес во всю клетку и стойка с товаром под передним
    // краем. Полосы — самая заметная примета торга на общем плане.
    context.fillStyle = t.shadow
    context.fillRect(-hw * 0.96, -hh * 0.94, hw * 1.92, hh * 1.86)
    const stripes = 6
    for (let index = 0; index < stripes; index += 1) {
      const width = (hw * 1.84) / stripes
      context.fillStyle = index % 2 ? t.accent : shade(palette.propAccent, -0.54)
      context.fillRect(-hw * 0.92 + width * index, -hh * 0.9, width, hh * 1.32)
    }
    context.fillStyle = t.deep
    for (const share of [-0.9, 0.9]) {
      context.fillRect(hw * share - thin * 0.12, -hh * 0.9, thin * 0.24, hh * 1.8)
    }
    context.fillStyle = t.deep
    context.fillRect(-hw * 0.96, hh * 0.34, hw * 1.92, hh * 0.6)
    context.fillStyle = t.base
    context.fillRect(-hw * 0.96, hh * 0.34, hw * 1.92, hh * 0.44)
    context.fillStyle = t.light
    for (const share of [-0.58, -0.16, 0.28, 0.68]) circle(context, hw * share, hh * 0.54, thin * 0.16)
  }
}

// --- рисунки старых значений feature без записи в реестре -----------------

/** Руна: восьмиконечный знак. */
function runePainter(): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    context.fillStyle = shade(palette.propAccent, 0.3)
    polygon(context, [
      [0, -hh], [hw * 0.32, -hh * 0.28], [hw, 0], [hw * 0.32, hh * 0.28],
      [0, hh], [-hw * 0.32, hh * 0.28], [-hw, 0], [-hw * 0.32, -hh * 0.28],
    ])
    context.fillStyle = t.deep
    circle(context, 0, 0, Math.min(hw, hh) * 0.22)
  }
}

/** Кости: перекрестье двух и груда с черепом. */
function bonesPainter(kind: 'crossed' | 'pile'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    const pale = shade(palette.propAccent, 0.5)
    if (kind === 'pile') {
      // Груда: подсыпка, кости вразнобой и череп поверх. Ровное перекрестье уже
      // занято, а по черепу куча узнаётся даже когда от неё осталось три пятна.
      context.fillStyle = shade(palette.propAccent, -0.24)
      ellipseShape(context, 0, hh * 0.2, hw * 0.94, hh * 0.7)
      lines(context, pale, thin * 0.15, [
        [-hw * 0.82, hh * 0.56, hw * 0.76, -hh * 0.12],
        [-hw * 0.64, -hh * 0.16, hw * 0.86, hh * 0.44],
        [-hw * 0.5, hh * 0.7, hw * 0.5, hh * 0.72],
      ])
      context.fillStyle = pale
      for (const [x, y] of [[-0.82, 0.56], [0.76, -0.12], [-0.64, -0.16], [0.86, 0.44]]) {
        circle(context, hw * x, hh * y, thin * 0.15)
      }
      context.fillStyle = shade(palette.propAccent, 0.64)
      ellipseShape(context, -hw * 0.16, -hh * 0.42, hw * 0.4, hh * 0.36)
      context.fillStyle = t.deep
      circle(context, -hw * 0.3, -hh * 0.44, thin * 0.1)
      circle(context, -hw * 0.02, -hh * 0.44, thin * 0.1)
      return
    }
    lines(context, pale, thin * 0.14, [
      [-hw * 0.8, -hh * 0.7, hw * 0.8, hh * 0.7],
      [hw * 0.8, -hh * 0.7, -hw * 0.8, hh * 0.7],
    ])
    context.fillStyle = pale
    for (const [x, y] of [[-0.8, -0.7], [0.8, 0.7], [0.8, -0.7], [-0.8, 0.7]]) {
      circle(context, hw * x, hh * y, thin * 0.18)
    }
  }
}

/** Механизм: панель со светящимся экраном. */
function consolePainter(): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    context.fillStyle = t.base
    context.fillRect(-hw * 0.96, -hh * 0.62, hw * 1.92, hh * 1.24)
    context.fillStyle = t.cool
    context.fillRect(-hw * 0.74, -hh * 0.42, hw * 1.48, hh * 0.7)
    context.fillStyle = t.glow
    for (const share of [-0.5, 0, 0.5]) circle(context, hw * share, hh * 0.44, Math.min(hw, hh) * 0.1)
  }
}

/** Грибы: одиночный в крапинах и подземная семейка. */
function mushroomPainter(kind: 'single' | 'cluster'): PropPainter {
  return (context, { hw, hh }, palette) => {
    const t = tones(palette)
    const thin = Math.min(hw, hh)
    if (kind === 'cluster') {
      // Семейка: три шляпки разного роста. Цвет холодный — подземный гриб светит
      // сам, и по этому свету он и отличается от боровика на опушке.
      for (const [cx, cy, size] of [[-0.42, 0.24, 0.52], [0.4, 0.36, 0.44], [0.06, -0.3, 0.6]]) {
        context.fillStyle = shade(palette.window, -0.5)
        context.fillRect(hw * cx - thin * 0.09, hh * cy, thin * 0.18, hh * 0.5)
        context.fillStyle = t.waterDeep
        ellipseShape(context, hw * cx, hh * cy, hw * size * 0.62, hh * size * 0.5)
        context.fillStyle = t.water
        ellipseShape(context, hw * cx, hh * cy - hh * size * 0.08, hw * size * 0.5, hh * size * 0.38)
        context.fillStyle = shade(palette.window, 0.34)
        circle(context, hw * cx - hw * size * 0.14, hh * cy - hh * size * 0.14, thin * size * 0.2)
      }
      return
    }
    context.fillStyle = t.light
    context.fillRect(-hw * 0.22, -hh * 0.1, hw * 0.44, hh * 0.94)
    context.fillStyle = t.accent
    ellipseShape(context, 0, -hh * 0.24, hw * 0.86, hh * 0.6)
    context.fillStyle = shade(palette.propAccent, 0.45)
    circle(context, -hw * 0.32, -hh * 0.32, thin * 0.12)
    circle(context, hw * 0.2, -hh * 0.44, thin * 0.11)
    circle(context, hw * 0.48, -hh * 0.16, thin * 0.1)
  }
}

// --- реестр рисунков -----------------------------------------------------

/**
 * Идентификатор реестра → рисунок. Ключи повторяют `server/asset-registry.mjs`
 * (реестр — источник истины, здесь он только читается) плюс старые значения
 * `feature`, которым записи в реестре нет.
 */
const PROP_LIBRARY: Record<string, PropDrawing> = {
  // --- мебель общего зала -------------------------------------------------
  table_round: { paint: tablePainter('round'), simple: 'round' },
  table_long: { paint: tablePainter('long'), simple: 'block' },
  table_small: { paint: tablePainter('small'), simple: 'block' },
  bench: { paint: seatPainter('bench'), simple: 'block' },
  chair: { paint: seatPainter('chair'), simple: 'block' },
  stool: { paint: seatPainter('stool'), simple: 'round' },
  bar_counter: { paint: counterPainter('counter'), simple: 'block' },
  bar_shelf: { paint: counterPainter('bottles'), simple: 'block' },
  fireplace: { paint: firePainter('fireplace'), simple: 'block' },
  hearth_fire: { paint: firePainter('hearth'), simple: 'round' },
  cauldron: { paint: basinPainter('cauldron'), simple: 'round' },
  firewood_stack: { paint: logsPainter('indoor'), simple: 'block' },

  // --- хранение и утварь --------------------------------------------------
  barrel: { paint: caskPainter('barrel'), simple: 'round' },
  barrel_stack: { paint: caskPainter('stack'), simple: 'round' },
  keg: { paint: caskPainter('keg'), simple: 'round' },
  crate: { paint: cratePainter('single'), simple: 'block' },
  crate_stack: { paint: cratePainter('stack'), simple: 'block' },
  sack: { paint: heapPainter('sack'), simple: 'round' },
  basket: { paint: basinPainter('basket'), simple: 'round' },
  bucket: { paint: basinPainter('bucket'), simple: 'round' },
  chest: { paint: cratePainter('chest'), simple: 'block' },
  cupboard: { paint: cabinetPainter('cupboard'), simple: 'block' },
  wardrobe: { paint: cabinetPainter('wardrobe'), simple: 'block' },
  bookshelf: { paint: cabinetPainter('books'), simple: 'block' },
  shelf_wall: { paint: counterPainter('shelf'), simple: 'block' },
  broom: { paint: postPainter('broom'), simple: 'block' },

  // --- мелочь на столах: футпринт пуст, размер задаётся здесь --------------
  mug: { paint: tablewarePainter('mug'), simple: 'round', visual: { w: 0.44, h: 0.44 } },
  plate: { paint: platterPainter('plate'), simple: 'round', visual: { w: 0.52, h: 0.52 } },
  bowl_stew: { paint: platterPainter('bowl'), simple: 'round', visual: { w: 0.48, h: 0.48 } },
  bottle: { paint: tablewarePainter('bottle'), simple: 'round', visual: { w: 0.3, h: 0.56 } },
  jug: { paint: tablewarePainter('jug'), simple: 'round', visual: { w: 0.42, h: 0.5 } },
  bread_loaf: { paint: platterPainter('bread'), simple: 'round', visual: { w: 0.52, h: 0.36 } },
  cheese_wheel: { paint: platterPainter('cheese'), simple: 'round', visual: { w: 0.46, h: 0.46 } },
  candle: { paint: candlePainter('candle'), simple: 'round', visual: { w: 0.24, h: 0.52 } },
  dice_cup: { paint: tablewarePainter('cup'), simple: 'round', visual: { w: 0.36, h: 0.42 } },
  coin_pile: { paint: platterPainter('coins'), simple: 'round', visual: { w: 0.46, h: 0.38 } },
  lute: { paint: lutePainter(), simple: 'round', visual: { w: 0.42, h: 0.92 } },
  cutting_board: { paint: platterPainter('board'), simple: 'block', visual: { w: 0.7, h: 0.46 } },
  pot: { paint: basinPainter('pot'), simple: 'round', visual: { w: 0.46, h: 0.46 } },

  // --- спальные помещения -------------------------------------------------
  bed: { paint: bedPainter('single'), simple: 'block' },
  bunk_bed: { paint: bedPainter('bunk'), simple: 'block' },
  night_table: { paint: cabinetPainter('night'), simple: 'block' },
  washbasin: { paint: basinPainter('washbasin'), simple: 'round' },

  // --- освещение и убранство ----------------------------------------------
  torch_wall: { paint: wallDecalPainter('torch'), simple: 'round', visual: { w: 0.5, h: 0.72 }, flat: true },
  lantern_wall: { paint: wallDecalPainter('lantern'), simple: 'round', visual: { w: 0.5, h: 0.72 }, flat: true },
  candelabra: { paint: candlePainter('stand'), simple: 'round' },
  banner: { paint: wallDecalPainter('banner'), simple: 'block', visual: { w: 0.7, h: 1.3 }, flat: true },
  sign_board: { paint: wallDecalPainter('sign'), simple: 'block', visual: { w: 1.1, h: 0.8 }, flat: true },
  rug: { paint: groundDecalPainter('rug'), simple: 'block', visual: { w: 3, h: 2 }, flat: true },
  floor_stain: { paint: groundDecalPainter('stain'), simple: 'round', visual: { w: 1.15, h: 1.15 }, flat: true },

  // --- переходы -----------------------------------------------------------
  stairs_up: { paint: stairsPainter('up'), simple: 'block' },
  stairs_down: { paint: stairsPainter('down'), simple: 'block' },
  trapdoor: { paint: groundDecalPainter('trapdoor'), simple: 'block', visual: { w: 1, h: 1 }, flat: true },

  // --- внешняя территория -------------------------------------------------
  tree_oak: { paint: treePainter('oak'), simple: 'round', tint: 'foliage' },
  tree_pine: { paint: treePainter('pine'), simple: 'round', tint: 'foliage' },
  tree_birch: { paint: treePainter('birch'), simple: 'round', tint: 'foliage' },
  tree_dead: { paint: treePainter('dead'), simple: 'round' },
  tree_stump: { paint: treePainter('stump'), simple: 'round' },
  bush: { paint: shrubPainter('bush'), simple: 'round', tint: 'foliage' },
  shrub: { paint: shrubPainter('shrub'), simple: 'round', tint: 'foliage' },
  grass_tuft: { paint: groundDecalPainter('grass'), simple: 'round', visual: { w: 0.8, h: 0.7 }, flat: true, tint: 'foliage' },
  flowers: { paint: groundDecalPainter('flowers'), simple: 'round', visual: { w: 0.8, h: 0.7 }, flat: true, tint: 'foliage' },
  rock_small: { paint: rockPainter('small'), simple: 'round', tint: 'stone' },
  boulder: { paint: rockPainter('boulder'), simple: 'round', tint: 'stone' },
  woodpile: { paint: logsPainter('outdoor'), simple: 'block' },
  cart: { paint: cartPainter(), simple: 'block' },
  wagon_wheel: { paint: wheelPainter(), simple: 'round' },
  hitching_post: { paint: postPainter('hitching'), simple: 'block' },
  water_trough: { paint: waterPainter('trough'), simple: 'block' },
  well: { paint: wellPainter(), simple: 'round', tint: 'stone' },
  lamp_post: { paint: postPainter('lamp'), simple: 'round' },
  signpost: { paint: postPainter('sign'), simple: 'block' },
  haystack: { paint: heapPainter('hay'), simple: 'round' },
  path_stone: { paint: groundDecalPainter('path'), simple: 'round', visual: { w: 0.9, h: 0.9 }, flat: true, tint: 'stone' },
  campfire: { paint: firePainter('camp'), simple: 'round' },

  // --- храм ----------------------------------------------------------------
  pillar: { paint: pillarPainter(), simple: 'round', tint: 'stone' },
  altar: { paint: altarPainter(), simple: 'block', tint: 'stone' },
  statue: { paint: statuePainter(), simple: 'block', tint: 'stone' },
  brazier: { paint: firePainter('brazier'), simple: 'round' },
  offering_bowl: { paint: basinPainter('offering'), simple: 'round', visual: { w: 0.68, h: 0.68 }, tint: 'stone' },
  prayer_bench: { paint: seatPainter('prayer'), simple: 'block' },
  temple_banner: { paint: wallDecalPainter('temple'), simple: 'block', visual: { w: 0.7, h: 1.3 }, flat: true },
  reliquary: { paint: shrinePainter('reliquary'), simple: 'block', tint: 'stone' },
  mosaic: { paint: groundDecalPainter('mosaic'), simple: 'round', visual: { w: 2, h: 2 }, flat: true, tint: 'stone' },

  // --- склеп ---------------------------------------------------------------
  sarcophagus: { paint: slabPainter('sarcophagus'), simple: 'block', tint: 'stone' },
  grave: { paint: slabPainter('grave'), simple: 'block', tint: 'stone' },
  bone_pile: { paint: bonesPainter('pile'), simple: 'round', visual: { w: 0.9, h: 0.76 } },
  urn: { paint: basinPainter('urn'), simple: 'round', tint: 'stone' },
  crypt_niche: { paint: shrinePainter('niche'), simple: 'block', tint: 'stone' },
  cobweb: { paint: wallDecalPainter('cobweb'), simple: 'round', visual: { w: 0.95, h: 0.95 }, flat: true },

  // --- пещера --------------------------------------------------------------
  stalagmite: { paint: rockPainter('stalagmite'), simple: 'round', tint: 'stone' },
  cave_pool: { paint: waterPainter('pool'), simple: 'round', tint: 'water' },
  mushroom_cluster: { paint: mushroomPainter('cluster'), simple: 'round', visual: { w: 0.9, h: 0.76 } },
  ore_vein: { paint: wallDecalPainter('ore'), simple: 'round', visual: { w: 0.85, h: 0.9 }, flat: true, tint: 'stone' },
  rubble_heap: { paint: rockPainter('rubble'), simple: 'round', tint: 'stone' },

  // --- лес, дорога, поселение ----------------------------------------------
  tree_spruce: { paint: treePainter('spruce'), simple: 'round', tint: 'foliage' },
  fallen_log: { paint: logsPainter('fallen'), simple: 'block' },
  fern: { paint: groundDecalPainter('fern'), simple: 'round', visual: { w: 0.9, h: 0.85 }, flat: true, tint: 'foliage' },
  milestone: { paint: slabPainter('milestone'), simple: 'round', tint: 'stone' },
  roadside_shrine: { paint: shrinePainter('roadside'), simple: 'block' },
  market_stall: { paint: settlementPainter('stall'), simple: 'block' },
  village_fence: { paint: settlementPainter('fence'), simple: 'block' },

  // --- старые значения feature, которым записи в реестре нет ---------------
  rune: { paint: runePainter(), simple: 'round', flat: true },
  bones: { paint: bonesPainter('crossed'), simple: 'round' },
  console: { paint: consolePainter(), simple: 'block' },
  mushroom: { paint: mushroomPainter('single'), simple: 'round' },
}

/**
 * Старое значение `cell.feature` → идентификатор реестра. Сохранённые кампании
 * несут именно эти значения (`server/tactical-map.mjs` переносит `feature` в
 * `assetId` как есть), поэтому таблица обязана оставаться полной: потерянная
 * строка означает, что предмет на уже сыгранной карте превратится в кружок.
 */
export const LEGACY_PROP_ASSETS: Record<string, string> = {
  table: 'table_round',
  chair: 'chair',
  bed: 'bed',
  bookshelf: 'bookshelf',
  fireplace: 'fireplace',
  barrel: 'barrel',
  crate: 'crate',
  chest: 'chest',
  tree: 'tree_oak',
  bush: 'bush',
  rock: 'boulder',
  mushroom: 'mushroom',
  bones: 'bones',
  grave: 'grave',
  pillar: 'pillar',
  statue: 'statue',
  campfire: 'campfire',
  wagon: 'cart',
  well: 'well',
  console: 'console',
  altar: 'altar',
  torch: 'torch_wall',
  rune: 'rune',
  stairs: 'stairs_up',
}

/**
 * Запасной рисунок. Неизвестный предмет обязан быть виден: молча потерять
 * объект карты хуже, чем нарисовать его кружком. Ни один идентификатор реестра
 * сюда попадать не должен — сторож в `test/prop-library.test.mjs`.
 */
export const DEFAULT_PROP_DRAWING: PropDrawing = {
  simple: 'round',
  paint: (context, { hw, hh }, palette) => {
    const t = tones(palette)
    context.fillStyle = t.base
    ellipseShape(context, 0, 0, hw * 0.7, hh * 0.7)
    context.fillStyle = t.light
    circle(context, -hw * 0.2, -hh * 0.2, Math.min(hw, hh) * 0.22)
  },
}

/** Визуальный размер по умолчанию для записи с пустым футпринтом. */
const DEFAULT_PROP_VISUAL = { w: 0.62, h: 0.62 }

/** Старый идентификатор приводится к нынешнему; нынешний остаётся собой. */
export function resolvePropAssetId(assetId: string): string {
  const id = String(assetId ?? '')
  return LEGACY_PROP_ASSETS[id] ?? id
}

export function propDrawingFor(assetId: string): PropDrawing {
  return PROP_LIBRARY[resolvePropAssetId(assetId)] ?? DEFAULT_PROP_DRAWING
}

/** Есть ли у идентификатора собственный рисунок, а не запасной кружок. */
export function hasPropDrawing(assetId: string): boolean {
  return propDrawingFor(assetId) !== DEFAULT_PROP_DRAWING
}

// --- размещение и уровни детализации -------------------------------------

/**
 * Габарит предмета в клетках, в системе координат карты. Занимаемые клетки
 * задают размер рисунка: стол 2×2 обязан занять свои четыре клетки, а не
 * кружок в одной. У записи с пустым футпринтом размер берётся из библиотеки.
 */
function propSpanInCells(prop: TacticalProp, drawing: PropDrawing) {
  if (!prop.footprint.length) {
    const visual = drawing.visual ?? DEFAULT_PROP_VISUAL
    return { centerX: prop.x, centerY: prop.y, w: visual.w, h: visual.h, fromFootprint: false }
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const cell of prop.footprint) {
    if (cell.x < minX) minX = cell.x
    if (cell.x > maxX) maxX = cell.x
    if (cell.y < minY) minY = cell.y
    if (cell.y > maxY) maxY = cell.y
  }
  return {
    centerX: (minX + maxX + 1) / 2,
    centerY: (minY + maxY + 1) / 2,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    fromFootprint: true,
  }
}

/** Центр и радиус охвата рисунка в клетках — для отбора предметов по тайлам. */
function propReach(prop: TacticalProp) {
  const span = propSpanInCells(prop, propDrawingFor(prop.assetId))
  const scale = prop.scale > 0 ? prop.scale : 1
  return {
    x: span.centerX,
    y: span.centerY,
    // Половина диагонали: она накрывает габарит при любом угле поворота.
    radius: (Math.hypot(span.w, span.h) / 2) * PROP_FOOTPRINT_FILL * scale,
  }
}

/** Куда переносить начало координат и каким габаритом рисовать. */
function propPlacement(prop: TacticalProp, drawing: PropDrawing, cellSize: number) {
  const span = propSpanInCells(prop, drawing)
  const scale = prop.scale > 0 ? prop.scale : 1
  // Занимаемые клетки уже развёрнуты поворотом (стойка 4×1 на 90° занимает
  // 1×4), а рисунок разворачивает сам контекст. Габарит возвращается в
  // локальную систему предмета, иначе стойка окажется поперёк себя.
  const quarter = Math.round((((prop.rotation % 360) + 360) % 360) / 90) % 4
  const swap = span.fromFootprint && quarter % 2 === 1
  const half = (cells: number) => Math.max(1, (cells * cellSize * PROP_FOOTPRINT_FILL * scale) / 2)
  return {
    x: span.centerX,
    y: span.centerY,
    box: { hw: half(swap ? span.h : span.w), hh: half(swap ? span.w : span.h) },
  }
}

export type PropDetailLevel = 'full' | 'simple' | 'mark'

/**
 * Уровень детализации по размеру клетки. Пороги — выше, с обоснованием.
 * Уровня «не рисовать» нет: при любом отдалении предмет остаётся хотя бы
 * меткой, иначе с общего плана пропадает половина обстановки.
 */
export function propDetailLevel(cellSize: number): PropDetailLevel {
  if (cellSize < PROP_MIN_CELL_PIXELS) return 'mark'
  return cellSize < PROP_FULL_DETAIL_CELL_PIXELS ? 'simple' : 'full'
}

/**
 * Нижний уровень: пятно по габариту предмета. Минимум два пикселя — одна точка
 * теряется на фоне текстуры пола.
 */
function drawMark(context: BoardContext2D, box: PropBox, palette: BoardPalette, drawing: PropDrawing) {
  const tint = silhouetteColor(palette, drawing)
  context.fillStyle = drawing.flat ? shade(tint, 0.24) : tint
  const hw = Math.max(1, box.hw * 0.8)
  const hh = Math.max(1, box.hh * 0.8)
  if (drawing.simple === 'block') context.fillRect(-hw, -hh, hw * 2, hh * 2)
  else ellipseShape(context, 0, 0, hw, hh)
}

/** Средний уровень: одна заливка характерной формы, без единой детали. */
function drawSilhouette(context: BoardContext2D, box: PropBox, palette: BoardPalette, drawing: PropDrawing) {
  const tint = silhouetteColor(palette, drawing)
  context.fillStyle = drawing.flat ? shade(tint, 0.18) : tint
  if (drawing.simple === 'block') {
    context.fillRect(-box.hw * 0.86, -box.hh * 0.86, box.hw * 1.72, box.hh * 1.72)
    return
  }
  ellipseShape(context, 0, 0, box.hw * 0.86, box.hh * 0.86)
}

/**
 * Растровый штамп в габарит предмета. Пропорция рисунка сохраняется: спрайт
 * вписывается в габарит, а не растягивается по нему. Растянуть — значит
 * сплющить круглый стол в овал на клетке 2×1, а габарит приходит из футпринта
 * и совпадает с пропорцией рисунка не всегда.
 */
function drawStamp(context: BoardContext2D, box: PropBox, atlas: PropAtlas, frame: PropFrame) {
  const fit = Math.min((box.hw * 2) / frame.w, (box.hh * 2) / frame.h)
  const width = frame.w * fit
  const height = frame.h * fit
  context.drawImage(atlas.texture.image, frame.x, frame.y, frame.w, frame.h, -width / 2, -height / 2, width, height)
}

/** Слой 5: предметы по `zOrder`, с поворотом, масштабом и футпринтом. */
export function drawProps(context: BoardContext2D, scene: BoardScene, tile: BoardTile) {
  const level = propDetailLevel(scene.cellSize)
  const frame = tileFrame(scene, tile)
  for (const prop of propsInTile(scene.map, tile, scene.cellSize)) {
    const drawing = propDrawingFor(prop.assetId)
    const placement = propPlacement(prop, drawing, frame.size)
    // Штамп берётся только на полной детализации: ниже её предмет занимает
    // считаные пиксели, и силуэт заливкой там и дешевле, и разборчивее.
    const stamp = level === 'full' ? scene.propAtlas?.frames[prop.assetId] : undefined
    context.save()
    context.translate((placement.x - frame.minX) * frame.size, (placement.y - frame.minY) * frame.size)
    if (prop.rotation) context.rotate((prop.rotation * Math.PI) / 180)
    // Декаль лежит на полу: прозрачность возвращается руками, а не `restore`, —
    // поддельный контекст тестов не обязан хранить стек состояний.
    if (drawing.flat) context.globalAlpha = PROP_DECAL_ALPHA
    if (stamp && scene.propAtlas) drawStamp(context, placement.box, scene.propAtlas, stamp)
    else if (level === 'full') drawing.paint(context, placement.box, scene.palette)
    else if (level === 'simple') drawSilhouette(context, placement.box, scene.palette, drawing)
    else drawMark(context, placement.box, scene.palette, drawing)
    if (drawing.flat) context.globalAlpha = 1
    context.restore()
  }
}

/** Слой 6: сетка 5 футов. */
export function drawGrid(context: BoardContext2D, scene: BoardScene, tile: BoardTile) {
  const frame = tileFrame(scene, tile)
  context.save()
  // На плоской заливке хватает бледной линии темы. На фактуре — нет: доска,
  // трава и кладка сами по себе пёстрые, и сетка в них растворяется, а на
  // боевой карте она нужнее рисунка — по ней считают ходы и дальности.
  if (texturesAvailableIn(scene)) {
    context.strokeStyle = shade(scene.palette.wall, -0.2)
    context.globalAlpha = 0.38
  } else {
    context.strokeStyle = scene.palette.gridLine
  }
  context.lineWidth = Math.max(1, frame.size / 32)
  for (let y = frame.minY; y <= frame.maxY; y += 1) {
    for (let x = frame.minX; x <= frame.maxX; x += 1) {
      if (!cellAt(scene.map, x, y)) continue
      context.strokeRect((x - frame.minX) * frame.size, (y - frame.minY) * frame.size, frame.size, frame.size)
    }
  }
  // Прозрачность возвращается руками: поддельный контекст тестов не обязан
  // хранить стек состояний.
  context.globalAlpha = 1
  context.restore()
}

/** Световая заливка зоны; `null` означает нейтральный яркий свет. */
export function zoneLightTreatment(lightLevel: string): string | null {
  const level = String(lightLevel ?? '').trim().toLowerCase()
  if (level === 'dark' || level === 'darkness') return 'rgba(7,9,14,.44)'
  if (level === 'dim' || level === 'low') return 'rgba(24,22,29,.2)'
  if (level === 'bright' || level === 'sunlit') return 'rgba(255,235,177,.08)'
  return null
}

/**
 * Свет ложится поверх пола, стен и предметов, но только в раскрытых клетках.
 * Нераскрытая часть остаётся единым туманом и не выдаёт границы тёмной зоны.
 */
export function drawZoneLighting(context: BoardContext2D, scene: BoardScene, tile: BoardTile) {
  const frame = tileFrame(scene, tile)
  const lights = new Map(scene.map.zones.map((zone) => [zone.id, zoneLightTreatment(zone.lightLevel)]))
  context.save()
  for (let y = frame.minY; y <= frame.maxY; y += 1) {
    for (let x = frame.minX; x <= frame.maxX; x += 1) {
      const cell = cellAt(scene.map, x, y)
      if (!cell?.revealed) continue
      const treatment = lights.get(cell.zone)
      if (!treatment) continue
      context.fillStyle = treatment
      context.fillRect((x - frame.minX) * frame.size, (y - frame.minY) * frame.size, frame.size, frame.size)
    }
  }
  context.restore()
}

/** Слой 7: туман войны по `revealed`. */
export function drawFog(context: BoardContext2D, scene: BoardScene, tile: BoardTile) {
  const frame = tileFrame(scene, tile)
  context.fillStyle = scene.palette.fog
  for (let y = frame.minY; y <= frame.maxY; y += 1) {
    for (let x = frame.minX; x <= frame.maxX; x += 1) {
      const cell = cellAt(scene.map, x, y)
      if (!cell || cell.revealed) continue
      context.fillRect((x - frame.minX) * frame.size, (y - frame.minY) * frame.size, frame.size, frame.size)
    }
  }
}

/**
 * Местность одного тайла целиком. Начало координат контекста — левый верхний
 * угол тайла, поэтому функция одинаково годится и для offscreen-тайла, и для
 * прямой отрисовки.
 */
export function drawTerrainTile(context: BoardContext2D, scene: BoardScene, tile: BoardTile) {
  drawZoneBackground(context, scene, tile)
  drawFloorTiles(context, scene, tile)
  drawDecals(context, scene, tile)
  drawEdgeSegments(context, scene, tile)
  drawProps(context, scene, tile)
  drawZoneLighting(context, scene, tile)
  drawGrid(context, scene, tile)
  drawFog(context, scene, tile)
}

// --- динамический слой поверх местности ----------------------------------

/**
 * Массовые подсветки. В DOM они дали бы узел на каждую клетку карты — ровно то,
 * от чего уходит этап M1, — поэтому рисуются на холсте. Точечные состояния
 * (маршрут, цель, область команды) остаются DOM-узлами вместе с доступностью.
 */
export type BoardOverlayKind = 'command-range' | 'command-out-of-range' | 'move-unavailable'
export type BoardOverlayCell = { x: number; y: number; kind: BoardOverlayKind }

export function drawBoardOverlay(context: BoardContext2D, scene: BoardScene, cells: readonly BoardOverlayCell[]) {
  const size = scene.cellSize
  context.save()
  for (const item of cells) {
    const left = item.x * size
    const top = item.y * size
    if (item.kind === 'command-out-of-range') {
      context.fillStyle = 'rgba(9,8,7,.34)'
      context.fillRect(left, top, size, size)
      continue
    }
    if (item.kind === 'command-range') {
      context.strokeStyle = 'rgba(225,166,84,.34)'
      context.lineWidth = Math.max(1, size / 26)
      context.strokeRect(left + size / 24, top + size / 24, size - size / 12, size - size / 12)
      continue
    }
    context.fillStyle = 'rgba(20,10,8,.36)'
    context.fillRect(left, top, size, size)
    // Крест недоступной клетки повторяет метку «×» прежней разметки.
    context.strokeStyle = 'rgba(125,65,59,.72)'
    context.lineWidth = Math.max(1, size / 16)
    context.beginPath()
    context.moveTo(left + size * 0.34, top + size * 0.34)
    context.lineTo(left + size * 0.66, top + size * 0.66)
    context.moveTo(left + size * 0.66, top + size * 0.34)
    context.lineTo(left + size * 0.34, top + size * 0.66)
    context.stroke()
  }
  context.restore()
}

// --- печатные оверлеи карты ---------------------------------------------

export type RoomLabelPlacement = { zoneId: string; label: string; x: number; y: number; revealedCells: number }

type ZoneBounds = { minX: number; minY: number; maxX: number; maxY: number; revealedCells: number }

/**
 * Декодированная карта на клиенте неизменяема: раскрытие приходит дельтой и
 * даёт новый объект (`sceneTacticalMap` в `src/tactical-map-client.ts`).
 * Поэтому границы зон считаются один раз на карту, а не на каждый кадр: слой
 * подписей рисуется вне тайлового кэша и переживает каждый пан и зум.
 */
const roomLabelCache = new WeakMap<TacticalMap, RoomLabelPlacement[]>()

/**
 * Центры подписей только по уже раскрытым клеткам. Само наличие подписи в
 * `map.overlays` не даёт права показать название комнаты сквозь туман.
 */
export function revealedRoomLabelPlacements(map: TacticalMap): RoomLabelPlacement[] {
  const cached = roomLabelCache.get(map)
  if (cached) return cached
  // Один проход по карте на все подписи сразу: по проходу на подпись — это
  // ширина × высота × число комнат на каждый вызов.
  const wanted = new Map(map.overlays.roomLabels.map((entry) => [entry.zoneId, entry.label]))
  const bounds = new Map<string, ZoneBounds>()
  if (wanted.size) {
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const cell = cellAt(map, x, y)
        if (!cell?.revealed || !wanted.has(cell.zone)) continue
        const own = bounds.get(cell.zone)
        if (!own) bounds.set(cell.zone, { minX: x, minY: y, maxX: x, maxY: y, revealedCells: 1 })
        else {
          own.minX = Math.min(own.minX, x)
          own.minY = Math.min(own.minY, y)
          own.maxX = Math.max(own.maxX, x)
          own.maxY = Math.max(own.maxY, y)
          own.revealedCells += 1
        }
      }
    }
  }
  const placements: RoomLabelPlacement[] = []
  for (const entry of map.overlays.roomLabels) {
    const own = bounds.get(entry.zoneId)
    if (!own || !entry.label.trim()) continue
    placements.push({
      zoneId: entry.zoneId,
      label: entry.label,
      x: (own.minX + own.maxX + 1) / 2,
      y: (own.minY + own.maxY + 1) / 2,
      revealedCells: own.revealedCells,
    })
  }
  roomLabelCache.set(map, placements)
  return placements
}

function drawCompass(context: BoardContext2D, scene: BoardScene) {
  const size = scene.cellSize
  const width = scene.map.width * size
  const radius = Math.max(7, Math.min(size * 0.62, width * 0.07))
  const centerX = Math.max(radius + 3, width - radius - size * 0.55)
  const centerY = radius + size * 0.68
  context.save()
  context.fillStyle = 'rgba(232,214,174,.82)'
  context.beginPath()
  context.arc(centerX, centerY, radius * 1.12, 0, Math.PI * 2)
  context.fill()
  context.strokeStyle = 'rgba(48,39,29,.84)'
  context.lineWidth = Math.max(1, size / 20)
  context.beginPath()
  context.moveTo(centerX, centerY - radius)
  context.lineTo(centerX + radius * 0.23, centerY)
  context.lineTo(centerX, centerY + radius)
  context.lineTo(centerX - radius * 0.23, centerY)
  context.closePath()
  context.stroke()
  context.fillStyle = '#30271d'
  context.font = `700 ${Math.max(8, radius * 0.72)}px Spectral, serif`
  context.textAlign = 'center'
  context.textBaseline = 'bottom'
  context.fillText('С', centerX, centerY - radius * 1.02)
  context.restore()
}

function drawScaleBar(context: BoardContext2D, scene: BoardScene) {
  const size = scene.cellSize
  const mapWidth = scene.map.width * size
  const mapHeight = scene.map.height * size
  const cells = Math.max(1, Math.min(4, scene.map.width - 2))
  const segment = Math.max(5, Math.min(size, mapWidth / (cells + 2)))
  const barWidth = cells * segment
  const left = Math.max(3, size * 0.7)
  const top = Math.max(size, mapHeight - size * 1.35)
  const barHeight = Math.max(3, size * 0.13)
  context.save()
  for (let index = 0; index < cells; index += 1) {
    context.fillStyle = index % 2 === 0 ? '#30271d' : 'rgba(232,214,174,.92)'
    context.fillRect(left + index * segment, top, segment, barHeight)
  }
  context.strokeStyle = 'rgba(48,39,29,.9)'
  context.lineWidth = Math.max(1, size / 28)
  context.strokeRect(left, top, barWidth, barHeight)
  context.fillStyle = '#30271d'
  context.font = `700 ${Math.max(7, Math.min(12, size * 0.25))}px Manrope, sans-serif`
  context.textAlign = 'left'
  context.textBaseline = 'bottom'
  context.fillText(`${cells * 5} футов`, left, top - Math.max(2, size * 0.08))
  context.restore()
}

function drawRoomLabels(context: BoardContext2D, scene: BoardScene) {
  const size = scene.cellSize
  const fontSize = Math.max(8, Math.min(18, size * 0.36))
  context.save()
  context.font = `600 ${fontSize}px Spectral, serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  for (const entry of revealedRoomLabelPlacements(scene.map)) {
    const x = entry.x * size
    const y = entry.y * size
    const width = Math.min(scene.map.width * size * 0.45, Math.max(size * 1.7, entry.label.length * fontSize * 0.58))
    context.fillStyle = 'rgba(238,221,184,.72)'
    context.fillRect(x - width / 2, y - fontSize * 0.75, width, fontSize * 1.5)
    context.fillStyle = '#34291e'
    context.fillText(entry.label, x, y, Math.max(size, width - size * 0.22))
  }
  context.restore()
}

/**
 * Слой печатной карты: координатная рамка обязательна, остальные элементы
 * следуют флагам серверного контракта.
 */
export function drawMapDecorations(context: BoardContext2D, scene: BoardScene) {
  if (scene.map.overlays.roomLabels.length) drawRoomLabels(context, scene)
  if (scene.map.overlays.compass) drawCompass(context, scene)
  if (scene.map.overlays.scaleBar) drawScaleBar(context, scene)
}

// --- кэш тайлов ----------------------------------------------------------

export type TileSurface = { canvas: unknown; context: BoardContext2D }
export type TileCacheEntry = { key: string; tileX: number; tileY: number; surface: TileSurface; usedAt: number }
export type TileCache = { limit: number; clock: number; entries: Map<string, TileCacheEntry> }

export function createTileCache(limit = DEFAULT_TILE_CACHE_LIMIT): TileCache {
  return { limit: Math.max(1, limit), clock: 0, entries: new Map() }
}

/**
 * Приводит кэш в соответствие видимым тайлам: недостающие рисует, лишние
 * вытесняет по давности. Возвращает, что именно пришлось перерисовать — на этом
 * держится проверка «кадр без изменений не перерисовывает ни одного тайла».
 */
export function syncTileCache(
  cache: TileCache,
  scene: BoardScene,
  tiles: readonly BoardTile[],
  createSurface: (size: number) => TileSurface,
): { entries: TileCacheEntry[]; drawn: string[]; reused: string[] } {
  const size = TILE_CELLS * scene.cellSize
  const drawn: string[] = []
  const reused: string[] = []
  const entries: TileCacheEntry[] = []
  const wanted = new Set<string>()
  for (const tile of tiles) {
    const key = tileKey(scene, tile)
    wanted.add(key)
    let entry = cache.entries.get(key)
    if (entry) {
      reused.push(key)
    } else {
      // Прежний ключ того же тайла уже неактуален: держать его — значит
      // занимать место в кэше мусором.
      for (const [otherKey, other] of cache.entries) {
        if (other.tileX === tile.tileX && other.tileY === tile.tileY) cache.entries.delete(otherKey)
      }
      const surface = createSurface(size)
      surface.context.clearRect(0, 0, size, size)
      drawTerrainTile(surface.context, scene, tile)
      entry = { key, tileX: tile.tileX, tileY: tile.tileY, surface, usedAt: 0 }
      cache.entries.set(key, entry)
      drawn.push(key)
    }
    cache.clock += 1
    entry.usedAt = cache.clock
    entries.push(entry)
  }
  while (cache.entries.size > cache.limit) {
    let oldestKey: string | null = null
    let oldestUse = Number.POSITIVE_INFINITY
    for (const [key, entry] of cache.entries) {
      if (wanted.has(key) || entry.usedAt >= oldestUse) continue
      oldestKey = key
      oldestUse = entry.usedAt
    }
    if (!oldestKey) break
    cache.entries.delete(oldestKey)
  }
  return { entries, drawn, reused }
}
