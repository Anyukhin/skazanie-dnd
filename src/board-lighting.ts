import type { TacticalMap } from './types'
import { cellExists, cellIndex, edgeBetween, edgeList, edgeNeighbor, passableAt } from './tactical-map-client'

/**
 * Сетка освещённости тактической карты — этап L5
 * (`docs/multilevel-map-plan.md`, раздел 7.1).
 *
 * Свет здесь только **считается**. Рисует его `src/board-render.ts`, и рисует
 * один раз на тайл: сетка запекается в тайловый кэш, а не пересчитывается в
 * кадре. Поэтому модуль чистый — ни канвы, ни React, ни состояния кампании.
 *
 * Индекс клетки тот же, что у слоёв карты: `i = y * width + x`. Значение — 0
 * полная тьма, 255 дневной свет.
 */

/** Дневной свет: верх шкалы. */
export const LIGHT_FULL = 255

/**
 * Минимум читаемости. Раскрытая клетка обязана оставаться различимой: игрок
 * читает по карте геометрию, укрытия и дальности, и «честная» тьма в склепе
 * превратила бы боевую карту в чёрный прямоугольник. Ориентир плана — не ниже
 * ~35 % яркости.
 */
export const LIGHT_MIN_READABLE = 90

/** Амбиент открытого неба. Времени суток в MVP нет — снаружи всегда день. */
export const AMBIENT_DAYLIGHT = 248

/**
 * Во сколько раз темнее подвал своего базового амбиента. Верхние этажи света
 * не теряют: окна там те же, что на первом.
 */
export const BASEMENT_AMBIENT_FACTOR = 0.7

/** Свет из окна днём: мягкая полоса на две-три клетки внутрь помещения. */
export const WINDOW_LIGHT_RADIUS = 3
export const WINDOW_LIGHT_STRENGTH = 96

export type ThemeLighting = {
  /** Амбиент клетки во внутренней зоне. */
  interior: number
  /** Амбиент клетки без зоны: пещера и подобные этажи зон не размечают. */
  open: number
}

/**
 * Амбиент по теме сцены. Темы — те же семь, что в `server/scene-themes.mjs` и
 * `src/scene-art.ts`; здесь у каждой два числа, потому что «внутри» у таверны и
 * у пещеры означает разное.
 */
const THEME_LIGHTING: Record<string, ThemeLighting> = {
  building: { interior: 176, open: AMBIENT_DAYLIGHT },
  settlement: { interior: 176, open: AMBIENT_DAYLIGHT },
  temple: { interior: 152, open: AMBIENT_DAYLIGHT },
  forest: { interior: 200, open: AMBIENT_DAYLIGHT },
  road: { interior: 200, open: AMBIENT_DAYLIGHT },
  crypt: { interior: 100, open: 100 },
  cave: { interior: 96, open: 96 },
}

/**
 * Темы, которых в реестре нет, но которые приходят из сохранённых кампаний и от
 * архитектора: подземелье, шахта, катакомбы. Опознаются по названию, как и в
 * `SCENE_THEMES`, и получают тёмный амбиент подземелья.
 */
const DARK_THEME_MATCH = /dungeon|crypt|cave|tomb|sewer|mine|catacomb|подзем|склеп|пещер|катаком|шахт|гробниц|каземат/iu

const DEFAULT_THEME_LIGHTING: ThemeLighting = { interior: 160, open: AMBIENT_DAYLIGHT }
const DARK_THEME_LIGHTING: ThemeLighting = { interior: 104, open: 104 }

/** Амбиент темы. Неизвестная тема — умеренный интерьер, а не тьма. */
export function themeLighting(theme: string): ThemeLighting {
  const key = String(theme ?? '').trim().toLowerCase()
  const known = THEME_LIGHTING[key]
  if (known) return known
  return DARK_THEME_MATCH.test(key) ? DARK_THEME_LIGHTING : DEFAULT_THEME_LIGHTING
}

/**
 * Огненные предметы реестра и их свет: радиус в клетках, прибавка к амбиенту в
 * точке источника. Костёр и очаг светят на всю комнату, факел и канделябр —
 * на пару шагов вокруг себя.
 *
 * Мерцание — этап L7 и живёт на слое эффектов; здесь только статичная часть.
 */
export const LIGHT_SOURCE_ASSETS: Record<string, { radius: number; strength: number }> = {
  campfire: { radius: 7, strength: 150 },
  fireplace: { radius: 7, strength: 140 },
  hearth_fire: { radius: 6, strength: 132 },
  brazier: { radius: 6, strength: 130 },
  torch_wall: { radius: 5, strength: 120 },
  lantern_wall: { radius: 5, strength: 112 },
  lamp_post: { radius: 5, strength: 112 },
  candelabra: { radius: 4, strength: 92 },
  candle: { radius: 2, strength: 48 },
}

/**
 * Старые значения `cell.feature`, которые доходят до клиента как `assetId`
 * (таблица `LEGACY_PROP_ASSETS` в `src/board-render.ts`). Здесь нужны только
 * огненные: сохранённая кампания не должна терять свет у своего очага.
 */
const LEGACY_LIGHT_ASSETS: Record<string, string> = {
  torch: 'torch_wall',
  campfire: 'campfire',
  fireplace: 'fireplace',
}

export type LightSource = {
  x: number
  y: number
  radius: number
  strength: number
  /** Огонь красит свет тёплым; окно — нет. Ореол рисуется только у огня. */
  warm: boolean
}

/** Светится ли предмет с таким идентификатором ассета. */
export function lightSourceAssetId(assetId: string): string | null {
  const id = String(assetId ?? '')
  const resolved = LEGACY_LIGHT_ASSETS[id] ?? id
  return LIGHT_SOURCE_ASSETS[resolved] ? resolved : null
}

/**
 * Источники света карты в детерминированном порядке: сначала огонь по порядку
 * предметов, затем окна по порядку рёбер.
 *
 * Окно освещает ту сторону, которая не под открытым небом: снаружи и так день,
 * а внутрь падает дневная полоса. Разметки зон может не быть вовсе — тогда
 * освещаются обе стороны, и это дешевле, чем гадать.
 */
export function lightSourcesOf(map: TacticalMap): LightSource[] {
  const sources: LightSource[] = []
  for (const prop of map.props) {
    const assetId = lightSourceAssetId(prop.assetId)
    if (!assetId) continue
    const x = Math.floor(prop.x)
    const y = Math.floor(prop.y)
    if (!cellExists(map, x, y)) continue
    const profile = LIGHT_SOURCE_ASSETS[assetId]
    sources.push({ x, y, radius: profile.radius, strength: profile.strength, warm: true })
  }
  const exteriorZones = new Set(map.zones.filter((zone) => zone.kind === 'exterior').map((zone) => zone.id))
  const zoneOf = (x: number, y: number) => {
    const index = cellIndex(map, x, y)
    if (index < 0) return ''
    const code = map.layers.zoneId[index]
    return code > 0 ? (map.zones[code - 1]?.id ?? '') : ''
  }
  for (const edge of edgeList(map)) {
    if (edge.kind !== 'window') continue
    const neighbor = edgeNeighbor(edge)
    for (const side of [{ x: edge.x, y: edge.y }, neighbor]) {
      if (!cellExists(map, side.x, side.y)) continue
      if (exteriorZones.has(zoneOf(side.x, side.y))) continue
      sources.push({ x: side.x, y: side.y, radius: WINDOW_LIGHT_RADIUS, strength: WINDOW_LIGHT_STRENGTH, warm: false })
    }
  }
  return sources
}

/**
 * Пропускает ли граница между соседними клетками свет. Стена и запертая или
 * закрытая дверь — нет; окно, перила, бойница и решётка — да.
 *
 * Это грубая отсечка по рёбрам, а не честный raycast: плана она держится
 * буквально (раздел 7.1), а бюджет запекания — с запасом.
 */
function lightPasses(map: TacticalMap, doorState: Map<string, string>, ax: number, ay: number, bx: number, by: number) {
  const edge = edgeBetween(map, ax, ay, bx, by)
  if (!edge) return true
  if (edge.kind === 'wall') return false
  if (edge.kind !== 'door') return true
  const state = edge.doorId ? doorState.get(edge.doorId) ?? 'closed' : 'closed'
  return state === 'open' || state === 'broken'
}

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/**
 * Сетка освещённости карты. Функция чистая и детерминированная: одинаковая
 * карта и тема дают побайтово одинаковый результат.
 *
 * Порядок: амбиент по зоне и теме → источники → кламп. Амбиент считается
 * прямо по слою `zoneId`, без сборки логической клетки: на карте 100×100 это
 * десять тысяч объектов на пустом месте.
 */
export function computeLightGrid(map: TacticalMap, theme: string = map.theme): Uint8Array {
  const width = Math.max(0, map.width)
  const height = Math.max(0, map.height)
  const grid = new Uint8Array(width * height)
  if (grid.length === 0) return grid

  const lighting = themeLighting(theme)
  const levelFactor = map.levelIndex < 0 ? BASEMENT_AMBIENT_FACTOR : 1
  // Амбиент зоны заранее: зон единицы, клеток тысячи.
  const zoneAmbient = map.zones.map((zone) => (
    Math.round((zone.kind === 'exterior' ? AMBIENT_DAYLIGHT : lighting.interior) * levelFactor)
  ))
  const openAmbient = Math.round(lighting.open * levelFactor)
  const light = new Float64Array(grid.length)
  for (let index = 0; index < grid.length; index += 1) {
    const code = map.layers.zoneId[index]
    light[index] = code > 0 ? (zoneAmbient[code - 1] ?? openAmbient) : openAmbient
  }

  const doorState = new Map<string, string>()
  for (const door of map.doors) doorState.set(door.id, door.state)

  const visited = new Int32Array(grid.length).fill(-1)
  const queue = new Int32Array(grid.length)
  const stepOf = new Int32Array(grid.length)
  let stamp = 0
  for (const source of lightSourcesOf(map)) {
    const originIndex = cellIndex(map, source.x, source.y)
    if (originIndex < 0) continue
    // Шаговый предел щедрее радиуса: обход по четырём соседям добирается до
    // диагонали круга за |dx|+|dy| шагов, и без запаса в углах круга остались
    // бы тёмные клинья. Дальность всё равно режет евклидов радиус.
    const stepLimit = Math.ceil(source.radius * 1.5)
    let head = 0
    let tail = 0
    queue[tail] = originIndex
    tail += 1
    visited[originIndex] = stamp
    stepOf[originIndex] = 0
    while (head < tail) {
      const index = queue[head]
      head += 1
      const step = stepOf[index]
      const x = index % width
      const y = (index - x) / width
      const distance = Math.hypot(x - source.x, y - source.y)
      if (distance <= source.radius) {
        light[index] += source.strength * (1 - distance / source.radius)
      }
      if (step >= stepLimit) continue
      // Свет входит в непроходимую клетку — так подсвечивается лицо скалы или
      // кладки, — но дальше сквозь массив не идёт. Пещера стены рёбрами не
      // размечает, и без этого правила свет шёл бы сквозь породу.
      if (step > 0 && !passableAt(map, x, y)) continue
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx
        const ny = y + dy
        const neighborIndex = cellIndex(map, nx, ny)
        if (neighborIndex < 0 || visited[neighborIndex] === stamp) continue
        if (!lightPasses(map, doorState, x, y, nx, ny)) continue
        visited[neighborIndex] = stamp
        stepOf[neighborIndex] = step + 1
        queue[tail] = neighborIndex
        tail += 1
      }
    }
    stamp += 1
  }

  for (let index = 0; index < grid.length; index += 1) {
    grid[index] = Math.max(LIGHT_MIN_READABLE, Math.min(LIGHT_FULL, Math.round(light[index])))
  }
  return grid
}

/** Освещённость клетки; за пределами карты — дневной свет, а не тьма. */
export function lightAt(grid: Uint8Array, map: TacticalMap, x: number, y: number): number {
  const index = cellIndex(map, x, y)
  return index < 0 ? LIGHT_FULL : grid[index]
}

/**
 * Отпечаток, при смене которого сетку надо считать заново. `terrainHash`
 * покрывает клетки, рёбра, двери, предметы, зоны и тему (`terrainHashOf` в
 * `src/tactical-map-client.ts`), поэтому открытая дверь, переставленный факел и
 * раскрытие новой области меняют его сами. Этаж в отпечаток карты не входит —
 * его добавляем здесь: подвал светится иначе первого этажа.
 */
export function lightSignature(map: TacticalMap, theme: string = map.theme): string {
  return `${map.terrainHash}:${map.levelIndex}:${theme}`
}

const lightGridCache = new WeakMap<TacticalMap, { signature: string; grid: Uint8Array }>()

/**
 * Сетка освещённости карты с запоминанием. Ключ — сам объект карты: панорама и
 * зум его не меняют, и пересчёта на них не происходит. Новая карта приходит с
 * клиента новым объектом (`decodeTacticalMap`), а сверка отпечатка страхует от
 * правки карты на месте.
 */
export function lightGridFor(map: TacticalMap, theme: string = map.theme): Uint8Array {
  const signature = lightSignature(map, theme)
  const cached = lightGridCache.get(map)
  if (cached && cached.signature === signature) return cached.grid
  const grid = computeLightGrid(map, theme)
  lightGridCache.set(map, { signature, grid })
  return grid
}
