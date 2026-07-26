import type {
  MapCell, SerializedTacticalMap, TacticalCell, TacticalCover, TacticalDoor, TacticalDoorState,
  TacticalEdge, TacticalEdgeDirection, TacticalEdgeKind, TacticalLayers, TacticalMap,
  TacticalMaterial, TacticalProp, TacticalSpawnRole, TacticalSurface, TacticalZone, TacticalZoneKind,
} from './types'

/**
 * Чтение тактической карты на клиенте. Модуль зеркалит формат хранения из
 * `server/tactical-map.mjs` и не знает ни о React, ни о состоянии кампании:
 * на вход приходит сериализованная карта из проекции, на выходе — логические
 * клетки, рёбра, двери и предметы.
 *
 * Порядок значений в перечислениях — часть формата: код равен индексу.
 * Перестановка ломает уже сохранённые слои.
 */

export const SURFACES: readonly TacticalSurface[] = ['none', 'water', 'ice', 'oil', 'mud', 'rubble']
export const MATERIALS: readonly TacticalMaterial[] = ['stone', 'wood', 'earth', 'grass', 'sand', 'marble', 'metal', 'ice']
export const EDGE_KINDS: readonly TacticalEdgeKind[] = ['none', 'wall', 'door', 'window', 'rail', 'ledge']
export const COVER_LEVELS: readonly TacticalCover[] = ['none', 'half', 'three_quarters']
export const DOOR_STATES: readonly TacticalDoorState[] = ['open', 'closed', 'locked', 'broken']
export const ZONE_KINDS: readonly TacticalZoneKind[] = ['interior', 'exterior']
export const SPAWN_ROLES: readonly TacticalSpawnRole[] = ['party', 'enemy', 'neutral']

const MAX_WIDTH = 100
const MAX_HEIGHT = 100

// --- битсеты и базовые преобразования ------------------------------------

function bitAt(bits: Uint8Array, index: number) {
  return (bits[index >> 3] & (1 << (index & 7))) !== 0
}

function setBitAt(bits: Uint8Array, index: number, value: boolean) {
  if (value) bits[index >> 3] |= 1 << (index & 7)
  else bits[index >> 3] &= ~(1 << (index & 7)) & 0xff
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

function text(value: unknown, maximum: number, fallback = '') {
  if (typeof value !== 'string') return fallback
  const result = value.trim().slice(0, maximum)
  return result || fallback
}

/**
 * Однородный слой сервер сжимает в одно число, а не в строку base64: в реальном
 * интерьере однородны сразу несколько слоёв. Разбирать надо оба вида.
 */
function decodeUnsignedLayer(value: unknown, expectedLength: number, label: string) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const filled = new Uint8Array(expectedLength)
    filled.fill(value & 0xff)
    return filled
  }
  if (typeof value !== 'string') throw new Error(`Слой ${label} должен быть строкой base64 или числом`)
  const bytes = base64ToBytes(value)
  if (bytes.length !== expectedLength) throw new Error(`Длина слоя ${label} равна ${bytes.length}, ожидалось ${expectedLength}`)
  return bytes
}

function decodeSignedLayer(value: unknown, expectedLength: number, label: string) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const filled = new Int8Array(expectedLength)
    filled.fill((value << 24) >> 24)
    return filled
  }
  const bytes = decodeUnsignedLayer(value, expectedLength, label)
  return Int8Array.from(bytes, (byte) => (byte << 24) >> 24)
}

// --- координаты и рёбра --------------------------------------------------

export function cellIndex(map: TacticalMap, x: number, y: number) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return -1
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return -1
  return y * map.width + x
}

export function cellExists(map: TacticalMap, x: number, y: number) {
  const index = cellIndex(map, x, y)
  return index >= 0 && bitAt(map.layers.present, index)
}

/**
 * Раскрыта ли клетка, без сборки логической клетки. Нужна там, где раскрытие
 * читают тысячами — например при подсчёте отпечатка тайла на каждом кадре:
 * `cellAt` создавал бы там объект на каждую клетку.
 */
export function revealedAt(map: TacticalMap, x: number, y: number): boolean {
  const index = cellIndex(map, x, y)
  return index >= 0 && bitAt(map.layers.present, index) && bitAt(map.layers.revealed, index)
}

/**
 * Логическая клетка. `null` означает, что клетки нет вовсе, — это единственный
 * способ отличить «клетки нет» от «клетка есть, но непроходима».
 */
export function cellAt(map: TacticalMap, x: number, y: number): TacticalCell | null {
  const index = cellIndex(map, x, y)
  if (index < 0 || !bitAt(map.layers.present, index)) return null
  const zoneCode = map.layers.zoneId[index]
  return {
    x,
    y,
    passable: bitAt(map.layers.passable, index),
    moveCost: map.layers.moveCost[index] || 1,
    surface: SURFACES[map.layers.surface[index]] ?? 'none',
    hazardId: Object.prototype.hasOwnProperty.call(map.hazards, String(index)) ? map.hazards[String(index)] : null,
    material: MATERIALS[map.layers.material[index]] ?? 'stone',
    elevation: map.layers.elevation[index],
    zone: zoneCode > 0 ? (map.zones[zoneCode - 1]?.id ?? '') : '',
    variant: map.layers.variant[index],
    revealed: bitAt(map.layers.revealed, index),
  }
}

/**
 * Канонизация ребра: каждое ребро принадлежит клетке с меньшим индексом и
 * смотрит на восток или на юг. Правило обязано совпадать с серверным, иначе
 * одно и то же ребро получит два ключа. В отличие от сервера, несоседние
 * клетки не бросают исключение: рендер не должен падать из-за данных.
 */
export function canonicalEdge(ax: number, ay: number, bx: number, by: number): { x: number; y: number; dir: TacticalEdgeDirection } | null {
  if (ay === by && bx === ax + 1) return { x: ax, y: ay, dir: 'e' }
  if (ay === by && bx === ax - 1) return { x: bx, y: by, dir: 'e' }
  if (ax === bx && by === ay + 1) return { x: ax, y: ay, dir: 's' }
  if (ax === bx && by === ay - 1) return { x: bx, y: by, dir: 's' }
  return null
}

/** Вторая клетка ребра — та, на которую ребро смотрит. */
export function edgeNeighbor(edge: { x: number; y: number; dir: TacticalEdgeDirection }) {
  return edge.dir === 'e' ? { x: edge.x + 1, y: edge.y } : { x: edge.x, y: edge.y + 1 }
}

export function edgeKey(x: number, y: number, dir: TacticalEdgeDirection) {
  return `${x},${y},${dir}`
}

export function edgeBetween(map: TacticalMap, ax: number, ay: number, bx: number, by: number): TacticalEdge | null {
  const canonical = canonicalEdge(ax, ay, bx, by)
  if (!canonical) return null
  return map.edges[edgeKey(canonical.x, canonical.y, canonical.dir)] ?? null
}

/** Рёбра в детерминированном порядке: y, затем x, затем направление. */
export function edgeList(map: TacticalMap): TacticalEdge[] {
  return Object.values(map.edges).sort((left, right) => (
    left.y - right.y || left.x - right.x || (left.dir === right.dir ? 0 : left.dir === 'e' ? -1 : 1)
  ))
}

/** Состояния дверей по идентификатору: полотно рисуется именно по ним. */
export function doorStates(map: TacticalMap) {
  const states = new Map<string, TacticalDoorState>()
  for (const door of map.doors) states.set(door.id, door.state)
  return states
}

// --- отпечаток местности -------------------------------------------------

/**
 * FNV-1a: короткий отпечаток без криптографии. Нужен только как ключ кэша —
 * требование одно: одинаковое содержимое даёт одинаковый ключ.
 */
function fnv1a(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Отпечаток местности считается по всему, кроме слоя `revealed`: раскрытие
 * меняется каждый ход и учитывается потайлово, иначе один шаг разведчика
 * обнулял бы весь кэш.
 */
function terrainHashOf(raw: Record<string, unknown>) {
  const layers = (raw.layers ?? {}) as Record<string, unknown>
  const parts = [
    String(raw.version ?? ''), String(raw.width ?? ''), String(raw.height ?? ''),
    String(raw.locationId ?? ''), String(raw.seed ?? ''), String(raw.theme ?? ''), String(raw.tilesetId ?? ''),
    ...(['present', 'passable', 'moveCost', 'surface', 'material', 'variant', 'elevation', 'zoneId']
      .map((name) => String(layers[name] ?? ''))),
    JSON.stringify(raw.edges ?? null),
    JSON.stringify(raw.doors ?? null),
    JSON.stringify(raw.props ?? null),
    JSON.stringify(raw.zones ?? null),
    JSON.stringify(raw.hazards ?? null),
  ]
  return fnv1a(parts.join('|'))
}

// --- сборка карты --------------------------------------------------------

function emptyLayers(length: number): TacticalLayers {
  const bitsetLength = Math.ceil(length / 8)
  const moveCost = new Uint8Array(length)
  moveCost.fill(1)
  return {
    present: new Uint8Array(bitsetLength),
    passable: new Uint8Array(bitsetLength),
    revealed: new Uint8Array(bitsetLength),
    moveCost,
    surface: new Uint8Array(length),
    material: new Uint8Array(length),
    variant: new Uint8Array(length),
    elevation: new Int8Array(length),
    zoneId: new Uint8Array(length),
  }
}

function emptyMap(width: number, height: number): TacticalMap {
  return {
    version: '',
    locationId: '',
    seed: '',
    generator: { id: 'manual', version: '1' },
    width,
    height,
    bounds: { minX: 0, minY: 0, maxX: -1, maxY: -1 },
    layers: emptyLayers(width * height),
    hazards: {},
    edges: {},
    doors: [],
    props: [],
    zones: [],
    spawnPoints: [],
    combatBounds: null,
    theme: '',
    tilesetId: '',
    overlays: { compass: false, scaleBar: false, roomLabels: [] },
    sizeClass: 'arena',
    terrainHash: '',
  }
}

/** Пересчитывает охват существующих клеток. */
export function recomputeBounds(map: TacticalMap) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!bitAt(map.layers.present, y * map.width + x)) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  map.bounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: -1, maxY: -1 }
  return map.bounds
}

function putEdge(map: TacticalMap, edge: TacticalEdge) {
  map.edges[edgeKey(edge.x, edge.y, edge.dir)] = edge
}

/**
 * Рёбра приходят упакованными: `cells` — пары байтов с индексом клетки-владельца,
 * `attrs` — байт признаков (тип 0–2, blocksMove 3, blocksSight 4, укрытие 5–6,
 * направление 7), `doors` — «порядковый номер ребра → doorId».
 */
function decodeEdges(map: TacticalMap, value: unknown) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    // Совместимость: первая редакция формата писала рёбра массивом объектов.
    for (const raw of value) {
      const record = raw as Record<string, unknown>
      const dir: TacticalEdgeDirection = record.dir === 's' ? 's' : 'e'
      putEdge(map, {
        x: boundedInteger(record.x, 0, 0, MAX_WIDTH),
        y: boundedInteger(record.y, 0, 0, MAX_HEIGHT),
        dir,
        kind: (EDGE_KINDS.includes(record.kind as TacticalEdgeKind) ? record.kind : 'wall') as TacticalEdgeKind,
        blocksMove: record.blocksMove === true,
        blocksSight: record.blocksSight === true,
        cover: (COVER_LEVELS.includes(record.cover as TacticalCover) ? record.cover : 'none') as TacticalCover,
        doorId: typeof record.doorId === 'string' ? record.doorId : null,
      })
    }
    return
  }
  const packed = value as Record<string, unknown>
  const cells = base64ToBytes(String(packed.cells ?? ''))
  const attrs = base64ToBytes(String(packed.attrs ?? ''))
  if (cells.length !== attrs.length * 2) throw new Error('Упакованные рёбра повреждены: длины массивов не согласованы')
  const doors = (packed.doors && typeof packed.doors === 'object' ? packed.doors : {}) as Record<string, unknown>
  for (let index = 0; index < attrs.length; index += 1) {
    const owner = cells[index * 2] | (cells[index * 2 + 1] << 8)
    const attribute = attrs[index]
    const doorId = doors[String(index)]
    putEdge(map, {
      x: owner % map.width,
      y: Math.floor(owner / map.width),
      dir: (attribute & (1 << 7)) ? 's' : 'e',
      kind: EDGE_KINDS[attribute & 0b111] ?? 'wall',
      blocksMove: (attribute & (1 << 3)) !== 0,
      blocksSight: (attribute & (1 << 4)) !== 0,
      cover: COVER_LEVELS[(attribute >> 5) & 0b11] ?? 'none',
      doorId: typeof doorId === 'string' ? doorId : null,
    })
  }
}

/**
 * Предмет сериализуется без полей, равных значению по умолчанию, — при чтении
 * их надо восстановить.
 */
function decodeProp(value: unknown): TacticalProp | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id, 120)
  if (!id) return null
  const scale = Number(raw.scale)
  return {
    id,
    assetId: text(raw.assetId, 120),
    x: Number(raw.x) || 0,
    y: Number(raw.y) || 0,
    rotation: Number.isFinite(Number(raw.rotation)) ? Number(raw.rotation) : 0,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    footprint: (Array.isArray(raw.footprint) ? raw.footprint : []).map((cell) => ({
      x: boundedInteger((cell as Record<string, unknown>)?.x, 0, -1_000, 1_000),
      y: boundedInteger((cell as Record<string, unknown>)?.y, 0, -1_000, 1_000),
    })),
    zOrder: boundedInteger(raw.zOrder, 0, -1_000, 1_000),
    blocksMove: raw.blocksMove === true,
    blocksSight: raw.blocksSight === true,
    cover: (COVER_LEVELS.includes(raw.cover as TacticalCover) ? raw.cover : 'none') as TacticalCover,
    destructible: raw.destructible === true,
    hp: boundedInteger(raw.hp, 0, 0, 1_000),
    interactive: raw.interactive === true,
    state: text(raw.state, 40),
  }
}

function decodeZone(value: unknown): TacticalZone | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id, 120)
  if (!id) return null
  return {
    id,
    kind: (ZONE_KINDS.includes(raw.kind as TacticalZoneKind) ? raw.kind : 'interior') as TacticalZoneKind,
    material: (MATERIALS.includes(raw.material as TacticalMaterial) ? raw.material : 'stone') as TacticalMaterial,
    lightLevel: text(raw.lightLevel, 40, 'bright'),
    label: text(raw.label, 120),
  }
}

function decodeDoor(value: unknown): TacticalDoor | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id, 120)
  if (!id) return null
  return {
    id,
    x: boundedInteger(raw.x, 0, 0, MAX_WIDTH),
    y: boundedInteger(raw.y, 0, 0, MAX_HEIGHT),
    dir: raw.dir === 's' ? 's' : 'e',
    state: (DOOR_STATES.includes(raw.state as TacticalDoorState) ? raw.state : 'closed') as TacticalDoorState,
    lockDc: boundedInteger(raw.lockDc, 0, 0, 40),
    keyItemId: typeof raw.keyItemId === 'string' ? raw.keyItemId : null,
  }
}

/**
 * Разбор сериализованной карты. Возвращает `null` для всего, что картой не
 * является: поле `map` может прийти из старой проекции или из рецепта сцены, и
 * доска обязана в этом случае просто отработать по клеткам.
 */
export function decodeTacticalMap(value: unknown): TacticalMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const width = boundedInteger(raw.width, 0, 1, MAX_WIDTH)
  const height = boundedInteger(raw.height, 0, 1, MAX_HEIGHT)
  if (!width || !height || !raw.layers || typeof raw.layers !== 'object') return null
  const length = width * height
  const bitsetLength = Math.ceil(length / 8)
  const layers = raw.layers as Record<string, unknown>
  try {
    const map = emptyMap(width, height)
    map.version = text(raw.version, 60)
    map.locationId = text(raw.locationId, 120)
    map.seed = text(raw.seed, 200)
    map.generator = {
      id: text((raw.generator as Record<string, unknown>)?.id, 60, 'manual'),
      version: text((raw.generator as Record<string, unknown>)?.version, 20, '1'),
    }
    map.layers = {
      present: decodeUnsignedLayer(layers.present, bitsetLength, 'present'),
      passable: decodeUnsignedLayer(layers.passable, bitsetLength, 'passable'),
      revealed: decodeUnsignedLayer(layers.revealed, bitsetLength, 'revealed'),
      moveCost: decodeUnsignedLayer(layers.moveCost, length, 'moveCost'),
      surface: decodeUnsignedLayer(layers.surface, length, 'surface'),
      material: decodeUnsignedLayer(layers.material, length, 'material'),
      variant: decodeUnsignedLayer(layers.variant, length, 'variant'),
      elevation: decodeSignedLayer(layers.elevation, length, 'elevation'),
      zoneId: decodeUnsignedLayer(layers.zoneId, length, 'zoneId'),
    }
    for (const [index, hazard] of Object.entries((raw.hazards ?? {}) as Record<string, unknown>)) {
      if (typeof hazard === 'string' && hazard) map.hazards[index] = hazard
    }
    for (const zone of Array.isArray(raw.zones) ? raw.zones : []) {
      const record = decodeZone(zone)
      if (record) map.zones.push(record)
    }
    decodeEdges(map, raw.edges)
    for (const door of Array.isArray(raw.doors) ? raw.doors : []) {
      const record = decodeDoor(door)
      if (record) map.doors.push(record)
    }
    for (const prop of Array.isArray(raw.props) ? raw.props : []) {
      const record = decodeProp(prop)
      if (record) map.props.push(record)
    }
    for (const point of Array.isArray(raw.spawnPoints) ? raw.spawnPoints : []) {
      const record = point as Record<string, unknown>
      const id = text(record?.id, 120)
      if (!id) continue
      map.spawnPoints.push({
        id,
        x: boundedInteger(record.x, 0, 0, MAX_WIDTH),
        y: boundedInteger(record.y, 0, 0, MAX_HEIGHT),
        role: (SPAWN_ROLES.includes(record.role as TacticalSpawnRole) ? record.role : 'party') as TacticalSpawnRole,
      })
    }
    const overlays = (raw.overlays ?? {}) as Record<string, unknown>
    map.overlays = {
      compass: overlays.compass === true,
      scaleBar: overlays.scaleBar === true,
      roomLabels: (Array.isArray(overlays.roomLabels) ? overlays.roomLabels : []).map((label) => ({
        zoneId: text((label as Record<string, unknown>)?.zoneId, 120),
        label: text((label as Record<string, unknown>)?.label, 120),
      })),
    }
    if (raw.combatBounds && typeof raw.combatBounds === 'object') {
      const bounds = raw.combatBounds as Record<string, unknown>
      map.combatBounds = {
        minX: boundedInteger(bounds.minX, 0, -1_000, 1_000),
        minY: boundedInteger(bounds.minY, 0, -1_000, 1_000),
        maxX: boundedInteger(bounds.maxX, 0, -1_000, 1_000),
        maxY: boundedInteger(bounds.maxY, 0, -1_000, 1_000),
      }
    }
    map.theme = text(raw.theme, 60)
    map.tilesetId = text(raw.tilesetId, 60)
    map.sizeClass = text(raw.sizeClass, 20, 'arena')
    map.terrainHash = terrainHashOf(raw)
    recomputeBounds(map)
    return map
  } catch {
    return null
  }
}

// --- совместимость со старыми клетками -----------------------------------

const LEGACY_WALKABLE = new Set(['floor', 'door'])

function setCellFields(map: TacticalMap, x: number, y: number, patch: Partial<TacticalCell>) {
  const index = cellIndex(map, x, y)
  if (index < 0) return
  setBitAt(map.layers.present, index, true)
  if (patch.passable !== undefined) setBitAt(map.layers.passable, index, patch.passable === true)
  if (patch.revealed !== undefined) setBitAt(map.layers.revealed, index, patch.revealed === true)
  if (patch.surface !== undefined) map.layers.surface[index] = Math.max(0, SURFACES.indexOf(patch.surface))
  if (patch.material !== undefined) map.layers.material[index] = Math.max(0, MATERIALS.indexOf(patch.material))
  if (patch.variant !== undefined) map.layers.variant[index] = boundedInteger(patch.variant, 0, 0, 255)
}

/**
 * Путь совместимости: сцена без поля `map` (старая проекция) собирается в карту
 * из разреженных клеток. Правила ровно те же, что на сервере
 * (`docs/tactical-map-plan.md`, раздел 9): вода непроходима, клетка-стена даёт
 * ребро-стену на каждой границе с проходимым соседом, дверь становится ребром
 * с полотном, `feature` — предметом в центре клетки.
 */
export function tacticalMapFromCells(cells: readonly MapCell[]): TacticalMap | null {
  const source = (Array.isArray(cells) ? cells : []).filter((cell) => (
    cell && Number.isSafeInteger(Number(cell.x)) && Number.isSafeInteger(Number(cell.y))
    && Number(cell.x) >= 0 && Number(cell.y) >= 0
  ))
  if (!source.length) return null
  let width = 0
  let height = 0
  for (const cell of source) {
    width = Math.max(width, Number(cell.x) + 1)
    height = Math.max(height, Number(cell.y) + 1)
  }
  if (width > MAX_WIDTH || height > MAX_HEIGHT) return null
  const map = emptyMap(width, height)
  const signature: string[] = []
  for (const cell of source) {
    const x = Number(cell.x)
    const y = Number(cell.y)
    const type = String(cell.type ?? 'floor')
    setCellFields(map, x, y, {
      passable: LEGACY_WALKABLE.has(type),
      surface: type === 'water' ? 'water' : 'none',
      material: (MATERIALS.includes(cell.material as TacticalMaterial) ? cell.material : 'stone') as TacticalMaterial,
      variant: Number(cell.variant) || 0,
      revealed: cell.revealed === true,
    })
    signature.push(`${x},${y},${type},${cell.material ?? ''},${cell.variant ?? 0},${cell.feature ?? ''}`)
  }
  for (const cell of source) {
    const x = Number(cell.x)
    const own = cellAt(map, x, Number(cell.y))
    const y = Number(cell.y)
    if (!own || own.passable) continue
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = cellAt(map, x + dx, y + dy)
      if (!neighbor || !neighbor.passable) continue
      const canonical = canonicalEdge(x, y, x + dx, y + dy)
      if (!canonical) continue
      putEdge(map, { ...canonical, kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters', doorId: null })
    }
  }
  for (const cell of source) {
    if (String(cell.type) !== 'door') continue
    const x = Number(cell.x)
    const y = Number(cell.y)
    const east = cellAt(map, x + 1, y)
    const south = cellAt(map, x, y + 1)
    let dir: TacticalEdgeDirection = 'e'
    if (!east || east.passable) {
      if (!south || !south.passable) dir = 's'
    }
    const neighbor = dir === 'e' ? east : south
    const blocks = !neighbor || !neighbor.passable
    const id = `door-${x}-${y}`
    map.doors.push({ id, x, y, dir, state: 'closed', lockDc: 0, keyItemId: null })
    putEdge(map, { x, y, dir, kind: 'door', blocksMove: blocks, blocksSight: blocks, cover: 'none', doorId: id })
  }
  for (const cell of source) {
    const feature = typeof cell.feature === 'string' ? cell.feature.trim() : ''
    if (!feature || feature === 'enemy') continue
    const x = Number(cell.x)
    const y = Number(cell.y)
    map.props.push({
      id: `prop-${x}-${y}`,
      assetId: feature,
      x: x + 0.5,
      y: y + 0.5,
      rotation: 0,
      scale: 1,
      footprint: [{ x, y }],
      zOrder: 0,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      destructible: false,
      hp: 0,
      interactive: false,
      state: '',
    })
  }
  map.terrainHash = fnv1a(signature.join('|'))
  recomputeBounds(map)
  return map
}

/**
 * Единая точка входа для доски: каноническая карта сцены, а при её отсутствии —
 * сборка из старых клеток. Второго пути отрисовки не появляется.
 */
export function sceneTacticalMap(scene: { map?: SerializedTacticalMap; cells?: readonly MapCell[] }): TacticalMap | null {
  return decodeTacticalMap(scene?.map) ?? tacticalMapFromCells(scene?.cells ?? [])
}
