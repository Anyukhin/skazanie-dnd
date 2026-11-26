import * as THREE from 'three'
import { wallSideCell, zoneOfCell } from './board-render'
import { isMasonryCell, isRockCell } from './board3d-landscape'
import { terrainHeightAt } from './board3d-terrain'
import type { GraphicsStylePack, StyleMaterial } from './board3d-style'
import { STRUCTURAL_ROLES, structuralInstance, structuralTemplate, type StructuralModelAssets, type StructuralRole } from './board3d-structural'
import { cellAt, edgeList, edgeNeighbor, revealedAt } from './tactical-map-client'
import type { TacticalCell, TacticalDoorState, TacticalEdge, TacticalMap } from './types'

/**
 * Стены, двери и окна 3D-доски в рисованном стиле: те же места и размеры, что
 * у прежних (граница стены — ребро клетки, высота среза — `wallHeight`), но
 * поверхность — фактуры Quaternius из пакета стиля: неровный камень, кирпич,
 * штукатурка с брусом фахверка, доски, частокол из брёвен. Двери собраны из
 * досок с железными полосами и кольцом, окна — с подоконником и рамой.
 *
 * Фактура ложится по мировым координатам (трипланарно): соседние отрезки стены
 * продолжают рисунок друг друга, а сотни отрезков — экземпляры нескольких
 * коробок. Только представление: правила видят прежние рёбра.
 */

// ---------------------------------------------------------------- рёбра

/** Ребро видно, как только раскрыта любая его сторона — правило 2D-доски. */
export function edgeVisible(map: TacticalMap, edge: TacticalEdge) {
  const neighbor = edgeNeighbor(edge)
  return revealedAt(map, edge.x, edge.y) || revealedAt(map, neighbor.x, neighbor.y)
}

/** Сторона ребра, чья кладка рисуется: помещение, а не его пол; туман цвет не выдаёт. */
export function edgeSideCell(map: TacticalMap, edge: TacticalEdge) {
  const owner = cellAt(map, edge.x, edge.y)
  const neighbor = edgeNeighbor(edge)
  const other = cellAt(map, neighbor.x, neighbor.y)
  const visible = [owner, other].map((cell) => (cell?.revealed ? cell : null))
  if (visible.some(Boolean)) return wallSideCell(map, visible[0], visible[1])
  return wallSideCell(map, owner, other)
}

export function doorState(map: TacticalMap, edge: TacticalEdge): TacticalDoorState {
  const door = map.doors.find((entry) => entry.id === edge.doorId
    || (entry.x === edge.x && entry.y === edge.y && entry.dir === edge.dir))
  return door?.state ?? 'closed'
}

export function edgeCenter(edge: TacticalEdge) {
  return edge.dir === 'e'
    ? { x: edge.x + 1, z: edge.y + 0.5 }
    : { x: edge.x + 0.5, z: edge.y + 1 }
}

export function wallEdgeEndpoints(edge: TacticalEdge) {
  return edge.dir === 'e'
    ? [{ x: edge.x + 1, z: edge.y }, { x: edge.x + 1, z: edge.y + 1 }]
    : [{ x: edge.x, z: edge.y + 1 }, { x: edge.x + 1, z: edge.y + 1 }]
}

export function wallEndpointKey(x: number, z: number) {
  return `${x},${z}`
}

/** Высота ребра принадлежит только раскрытым соседям, никогда туманной клетке. */
export function edgeFloorHeight(map: TacticalMap, edge: TacticalEdge) {
  const neighbor = edgeNeighbor(edge)
  const heights = [[edge.x, edge.y], [neighbor.x, neighbor.y]]
    .filter(([x, y]) => revealedAt(map, x, y))
    .map(([x, y]) => terrainHeightAt(map, x, y))
    .filter(Number.isFinite)
  return heights.length ? Math.max(...heights) : 0
}

/** Стена вдоль скалы не рисуется: объём породы сам закрывает проход. */
export function edgeAgainstRock(map: TacticalMap, edge: TacticalEdge) {
  const neighbor = edgeNeighbor(edge)
  return isRockCell(map, edge.x, edge.y) || isRockCell(map, neighbor.x, neighbor.y)
}

// ------------------------------------------------------------- виды стен

export type WallKind = 'masonry' | 'planks' | 'fachwerk' | 'palisade'
/** Вид стены: материал тела, материал бруса и оттенок поверх фактуры. */
export type WallLook = { kind: WallKind; body: string; tint: string }

/** Оттенок неровного камня для непостроенных материалов: глина, песчаник, лёд. */
const STONE_TINTS: Record<string, string> = {
  earth: '#c9b08c', sand: '#e6d3ae', grass: '#c2c4ae', ice: '#cfe0e8', metal: '#c3c9d1',
}

/**
 * Вид стены по стороне ребра: сначала вид кладки помещения (`zone.wall`),
 * иначе материал. Таблица та же по смыслу, что `wallTextureKeyForSide` 2D-доски.
 */
export function wallLookFor(map: TacticalMap, side: TacticalCell | null | undefined): WallLook {
  switch (zoneOfCell(map, side)?.wall) {
    case 'brick': return { kind: 'masonry', body: 'brick', tint: '#ffffff' }
    case 'fortress': return { kind: 'masonry', body: 'fortress', tint: '#ffffff' }
    case 'fachwerk': return { kind: 'fachwerk', body: 'plaster', tint: '#f4efe6' }
    case 'palisade': return { kind: 'palisade', body: 'log', tint: '#b9a48e' }
    case 'embankment': return { kind: 'masonry', body: 'stone', tint: STONE_TINTS.earth }
  }
  const material = side?.material ?? 'stone'
  if (material === 'wood') return { kind: 'planks', body: 'planks', tint: '#ffffff' }
  if (material === 'marble') return { kind: 'masonry', body: 'plaster', tint: '#ffffff' }
  return { kind: 'masonry', body: 'stone', tint: STONE_TINTS[material] ?? '#ffffff' }
}

/** Виды, без которых стиль стен не включается: остальные сводятся к камню. */
const REQUIRED_LOOKS = ['stone', 'planks', 'timber', 'iron'] as const

export function packHasWallLooks(pack: GraphicsStylePack | null | undefined): pack is GraphicsStylePack {
  return Boolean(pack && REQUIRED_LOOKS.every((key) => pack.walls[key] && pack.materials[pack.walls[key].material]))
}

// ----------------------------------------------------------- материалы

export type WallTextureLoader = (url: string, done: () => void) => THREE.Texture

type CachedTexture = { texture: THREE.Texture; ready: boolean; waiters: Set<() => void> }
/**
 * Текстуры стен живут дольше сцены: доска пересобирается на каждое открытие
 * двери, и без кэша стены на миг белели бы, пока картинка грузится заново.
 */
const textureCache = new Map<string, CachedTexture>()

function cachedTexture(url: string, color: boolean, onReady: () => void, load?: WallTextureLoader) {
  const key = `${url}:${color}`
  let entry = textureCache.get(key)
  if (!entry || load) {
    const created: CachedTexture = { texture: new THREE.Texture(), ready: false, waiters: new Set() }
    const finish = () => {
      created.ready = true
      for (const waiter of created.waiters) waiter()
      created.waiters.clear()
    }
    created.texture = load ? load(url, finish) : new THREE.TextureLoader().load(url, finish, undefined, finish)
    created.texture.wrapS = created.texture.wrapT = THREE.RepeatWrapping
    created.texture.anisotropy = 8
    if (color) created.texture.colorSpace = THREE.SRGBColorSpace
    // Подменённый загрузчик (тесты) в общий кэш не пишет.
    if (!load) textureCache.set(key, created)
    entry = created
  }
  if (!entry.ready) entry.waiters.add(onReady)
  return entry.texture
}

const TRIPLANAR_PARS = /* glsl */`
uniform vec2 skzScale;
uniform float skzSwap;
varying vec3 vSkzWorld;
varying vec3 vSkzNormal;
// Проекция по преобладающей оси нормали: стены — (вдоль, вверх), верх — (x, z).
vec2 skzTriplanarUv() {
  vec3 n = abs( vSkzNormal );
  vec2 uv = n.y >= n.x && n.y >= n.z ? vSkzWorld.xz : n.x >= n.z ? vSkzWorld.zy : vSkzWorld.xy;
  if ( skzSwap > 0.5 ) uv = uv.yx;
  return uv / skzScale;
}
`

const TRIPLANAR_CHUNKS = ['map_fragment', 'roughnessmap_fragment', 'metalnessmap_fragment', 'normal_fragment_begin', 'normal_fragment_maps', 'aomap_fragment'] as const

function withTriplanarUv(chunk: string) {
  return chunk.replace(/v(?:Map|RoughnessMap|MetalnessMap|AoMap|NormalMap)Uv/gu, 'skzUv')
}

/**
 * Материал с фактурой по мировым координатам. Экземплярный цвет умножает
 * фактуру: так один материал красит и чистый камень, и глинобитный.
 * `swap` поворачивает рисунок на четверть: доски двери идут сверху вниз.
 */
export function createTriplanarMaterial(spec: StyleMaterial, cells: number, maps: { color: THREE.Texture; normal: THREE.Texture | null; orm: THREE.Texture | null }, swap = false) {
  const material = new THREE.MeshStandardMaterial({
    map: maps.color,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(.9, .9),
    roughnessMap: maps.orm,
    metalnessMap: maps.orm,
    aoMap: maps.orm,
    aoMapIntensity: .8,
    roughness: spec.roughness,
    metalness: maps.orm ? spec.metalness : 0,
    side: spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  })
  const scale = new THREE.Vector2(cells, cells * spec.aspect)
  material.onBeforeCompile = (shader) => {
    shader.uniforms.skzScale = { value: scale }
    shader.uniforms.skzSwap = { value: swap ? 1 : 0 }
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vSkzWorld;\nvarying vec3 vSkzNormal;\nvoid main() {')
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 skzWorld = vec4( transformed, 1.0 );
  vec3 skzNormal = objectNormal;
  #ifdef USE_INSTANCING
    skzWorld = instanceMatrix * skzWorld;
    skzNormal = mat3( instanceMatrix ) * skzNormal;
  #endif
  skzWorld = modelMatrix * skzWorld;
  vSkzWorld = skzWorld.xyz;
  vSkzNormal = normalize( mat3( modelMatrix ) * skzNormal );`)
    let fragment = shader.fragmentShader.replace('void main() {', `${TRIPLANAR_PARS}\nvoid main() {\n  vec2 skzUv = skzTriplanarUv();`)
    for (const chunk of TRIPLANAR_CHUNKS) fragment = fragment.replace(`#include <${chunk}>`, withTriplanarUv(THREE.ShaderChunk[chunk]))
    shader.fragmentShader = fragment
  }
  material.customProgramCacheKey = () => 'board3d-wall-triplanar-v1'
  return material
}

export type LookMaterialOptions = {
  /** Повернуть рисунок на четверть: доски сверху вниз. */
  swap?: boolean
  onTexture?: () => void
  loadTexture?: WallTextureLoader
}

function lookMaps(pack: GraphicsStylePack, look: string, options: LookMaterialOptions) {
  const spec = pack.materials[pack.walls[look].material]
  const onTexture = () => options.onTexture?.()
  return {
    spec,
    maps: {
      color: cachedTexture(spec.color, true, onTexture, options.loadTexture),
      normal: spec.normal ? cachedTexture(spec.normal, false, onTexture, options.loadTexture) : null,
      orm: spec.orm ? cachedTexture(spec.orm, false, onTexture, options.loadTexture) : null,
    },
  }
}

/** Материал вида пакета с фактурой по мировым координатам: стены, фронтоны, своды. */
export function createLookMaterial(pack: GraphicsStylePack, look: string, options: LookMaterialOptions = {}) {
  const { spec, maps } = lookMaps(pack, look, options)
  const material = createTriplanarMaterial(spec, pack.walls[look].cells, maps, options.swap)
  material.name = `wall:${look}${options.swap ? ':swap' : ''}`
  return material
}

/**
 * Материал вида пакета по UV самой сетки: скат крыши знает, где карниз и где
 * конёк, и черепица ложится рядами вдоль конька, а не проекцией сверху. UV
 * сетки задаются в повторах фактуры (`lookRepeat`), текстуры общие.
 */
export function createUvLookMaterial(pack: GraphicsStylePack, look: string, options: LookMaterialOptions = {}) {
  const { spec, maps } = lookMaps(pack, look, options)
  const material = new THREE.MeshStandardMaterial({
    map: maps.color,
    normalMap: maps.normal,
    roughnessMap: maps.orm,
    metalnessMap: maps.orm,
    aoMap: maps.orm,
    aoMapIntensity: .8,
    roughness: spec.roughness,
    metalness: maps.orm ? spec.metalness : 0,
  })
  material.name = `roof:${look}`
  return material
}

/** Сколько мировых единиц накрывает один повтор фактуры вида: по ширине и по высоте. */
export function lookRepeat(pack: GraphicsStylePack, look: string) {
  const wall = pack.walls[look]
  return { u: wall.cells, v: wall.cells * pack.materials[wall.material].aspect }
}

// -------------------------------------------------------------- сборка

type Shape = 'box' | 'log' | 'tip' | 'ring'
type Item = { matrix: THREE.Matrix4; color: THREE.Color }
type Bucket = { shape: Shape; look: string; swap: boolean; items: Item[] }

const IRON = '#53504c'
const TIMBER = '#ffffff'

function createShape(shape: Shape): THREE.BufferGeometry {
  if (shape === 'box') return new THREE.BoxGeometry(1, 1, 1)
  if (shape === 'ring') return new THREE.TorusGeometry(1, .22, 6, 14)
  // Брёвна гранёные: у грани постоянная нормаль, и проекция фактуры не рвётся посреди грани.
  const source = shape === 'log' ? new THREE.CylinderGeometry(1, 1, 1, 8, 1, true) : new THREE.ConeGeometry(1, 1, 8, 1, true)
  const faceted = source.toNonIndexed()
  source.dispose()
  faceted.computeVertexNormals()
  return faceted
}

/** Локальная рамка ребра: x — вдоль ребра, y — вверх, z — поперёк (правая тройка). */
function edgeFrame(edge: TacticalEdge, floorY: number) {
  const center = edgeCenter(edge)
  const along = edge.dir === 's' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)
  const across = new THREE.Vector3().crossVectors(along, new THREE.Vector3(0, 1, 0))
  const frame = new THREE.Matrix4().makeBasis(along, new THREE.Vector3(0, 1, 0), across)
  frame.setPosition(center.x, floorY, center.z)
  return frame
}

const scratch = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(), euler: new THREE.Euler() }

function local(position: [number, number, number], size: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) {
  scratch.euler.set(...rotation)
  scratch.quaternion.setFromEuler(scratch.euler)
  return new THREE.Matrix4().compose(scratch.position.set(...position), scratch.quaternion, scratch.scale.set(...size))
}

function cellNoise(x: number, y: number, salt = 0) {
  const value = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453
  return value - Math.floor(value)
}

function contextText(map: TacticalMap, side: TacticalCell | null | undefined) {
  const zone = zoneOfCell(map, side)
  return `${map.theme ?? ''} ${map.locationId ?? ''} ${map.levelLabel ?? ''} ${zone?.label ?? ''}`.toLowerCase()
}

/** Песчаниковая арка — у пустынной кладки: песок под ногами или пустыня в названии места. */
function sandstoneContext(map: TacticalMap, side: TacticalCell | null | undefined) {
  const zone = zoneOfCell(map, side)
  return side?.material === 'sand' || zone?.material === 'sand' || /desert|oasis|пустын|оазис|барханн/u.test(contextText(map, side))
}

/** Руинные арки и углы — только в развалинах; целый городской дом их не получает. */
function ruinContext(map: TacticalMap, side: TacticalCell | null | undefined) {
  return /ruin|руин|развалин|разрушен|заброшен/u.test(contextText(map, side))
}

/**
 * Кованая ограда — у мощёного двора, на кладбище и у храма; деревенский
 * участок остаётся с жердями. Смотрим на сам грунт по обе стороны ребра:
 * сторона стены подменила бы его материалом внутренней зоны.
 */
function ironFenceContext(map: TacticalMap, edge: TacticalEdge) {
  const neighbor = edgeNeighbor(edge)
  const paved = [cellAt(map, edge.x, edge.y), cellAt(map, neighbor.x, neighbor.y)]
    .some((cell) => cell?.material === 'stone' || cell?.material === 'marble')
  return paved || ['graveyard', 'temple', 'crypt'].includes(map.theme ?? '')
}

/**
 * Какая структурная модель ложится на проём ребра. Одна функция и для списка
 * загрузки, и для сборки стен: иначе роль грузилась бы зря или не ставилась.
 */
function edgeStructuralRole(map: TacticalMap, edge: TacticalEdge, look: WallLook): StructuralRole | null {
  const side = edgeSideCell(map, edge)
  if (edge.kind === 'rail') return ironFenceContext(map, edge) ? 'ornate_iron_fence' : null
  if (edge.kind === 'window') return look.kind !== 'palisade' && look.body === 'brick' ? 'round_window_brick' : null
  if (edge.kind === 'door' && look.kind === 'masonry') {
    return sandstoneContext(map, side) ? 'sandstone_arch' : ruinContext(map, side) ? 'ruin_wall_arch' : null
  }
  return null
}

type WallEndpoint = { x: number; z: number; count: number; directions: Set<TacticalEdge['dir']>; floorY: number; look: WallLook; ruin: boolean }

/** Концы и повороты видимых стен: здесь ставятся стойки и угловые столбы. */
function wallEndpoints(map: TacticalMap) {
  const endpoints = new Map<string, WallEndpoint>()
  if (!map.edges) return endpoints
  for (const edge of edgeList(map)) {
    if (edge.kind !== 'wall' || !edgeVisible(map, edge) || edgeAgainstRock(map, edge)) continue
    const floorY = edgeFloorHeight(map, edge)
    const side = edgeSideCell(map, edge)
    const look = wallLookFor(map, side)
    const ruin = ruinContext(map, side)
    for (const point of wallEdgeEndpoints(edge)) {
      const key = wallEndpointKey(point.x, point.z)
      const current = endpoints.get(key) ?? { ...point, count: 0, directions: new Set(), floorY, look, ruin }
      current.count += 1
      current.directions.add(edge.dir)
      current.floorY = Math.max(current.floorY, floorY)
      current.ruin ||= ruin
      // Брус фахверка и стойки дощатой стены главнее камня на стыке.
      if (look.kind === 'fachwerk' || look.kind === 'planks') current.look = look
      endpoints.set(key, current)
    }
  }
  return endpoints
}

/**
 * Кирпичный угловой столб — на настоящем повороте кладки в руинах. Конец стены
 * у двери или окна столба не получает: он заходил бы в проём.
 */
function cornerStructuralRole(point: WallEndpoint): StructuralRole | null {
  return point.directions.size >= 2 && point.look.body === 'brick' && point.ruin ? 'ruin_corner_brick' : null
}

/**
 * Отдаёт загрузчику только роли, для которых уже есть раскрытая опора на
 * карте. Сами модели остаются слоем buildStyledEdges и не меняют рёбра.
 */
export function structuralEdgeRolesForMap(map: TacticalMap): StructuralRole[] {
  const wanted = new Set<StructuralRole>()
  for (const edge of edgeList(map)) {
    if (!edgeVisible(map, edge) || edge.kind === 'none') continue
    const role = edgeStructuralRole(map, edge, wallLookFor(map, edgeSideCell(map, edge)))
    if (role) wanted.add(role)
  }
  for (const point of wallEndpoints(map).values()) {
    const role = cornerStructuralRole(point)
    if (role) wanted.add(role)
  }
  return STRUCTURAL_ROLES.filter((role) => wanted.has(role))
}

export type StyledEdges = { group: THREE.Group; instances: number; dispose: () => void }

export type StyledEdgeOptions = {
  wallHeight: number
  thickness: number
  /** Модели, привязанные к существующим рёбрам; не меняют TacticalMap. */
  structuralAssets?: StructuralModelAssets | null
  /** Подгрузилась фактура: доске пора перерисоваться. */
  onTexture?: () => void
  /** Подмена загрузчика в тестах. */
  loadTexture?: WallTextureLoader
}

/**
 * Стены по рёбрам, двери, окна, перила и клетки-кладка в стиле пакета.
 * Возвращает группы с прежними именами (`cutaway-walls`, `doors`), чтобы
 * остальная доска не различала, какими стены нарисованы.
 */
export function buildStyledEdges(map: TacticalMap, pack: GraphicsStylePack, options: StyledEdgeOptions): StyledEdges {
  const H = options.wallHeight
  const T = options.thickness
  const buckets = new Map<string, Bucket>()
  const lookKey = (body: string) => pack.walls[body] ? body : 'stone'
  const add = (shape: Shape, look: string, matrix: THREE.Matrix4, color: string | THREE.Color = '#ffffff', swap = false, target = 'walls') => {
    const key = `${target}|${shape}|${lookKey(look)}|${swap}`
    let bucket = buckets.get(key)
    if (!bucket) { bucket = { shape, look: lookKey(look), swap, items: [] }; buckets.set(key, bucket) }
    bucket.items.push({ matrix, color: color instanceof THREE.Color ? color : new THREE.Color(color) })
  }
  const box = (frame: THREE.Matrix4, look: string, position: [number, number, number], size: [number, number, number], color: string | THREE.Color = '#ffffff', rotation?: [number, number, number], swap = false, target = 'walls') => {
    add('box', look, frame.clone().multiply(local(position, size, rotation)), color, swap, target)
  }
  const structuralGroup = new THREE.Group()
  structuralGroup.name = 'structural-edges'
  const structural = options.structuralAssets

  // Стойки в концах и на поворотах: прямой ряд — без стоек, как и прежде.
  const endpoints = wallEndpoints(map)
  const identity = new THREE.Matrix4()
  for (const point of endpoints.values()) {
    const corner = point.count === 1 || point.directions.size >= 2
    if (point.look.kind === 'palisade') continue
    if (point.look.kind === 'masonry') {
      if (!corner) continue
      box(identity, point.look.body, [point.x, point.floorY + (H + .05) / 2, point.z], [.22, H + .05, .22], point.look.tint)
      continue
    }
    // Брус фахверка стоит на каждом стыке отрезков, у досок — только на углах.
    if (point.look.kind === 'planks' && !corner) continue
    box(identity, 'timber', [point.x, point.floorY + (H + .04) / 2, point.z], [.12, H + .04, T + .05], TIMBER)
  }
  // Кирпичный угол — только в вершине уже существующей стены. Он не создаёт
  // новую стену и не меняет ни клетку, ни линию прохода; почти квадратный
  // столб вписывается целиком, поэтому поворот ему не нужен.
  if (structuralTemplate(structural, 'ruin_corner_brick')) for (const point of endpoints.values()) {
    if (cornerStructuralRole(point) !== 'ruin_corner_brick') continue
    const model = structuralInstance(structural, {
      role: 'ruin_corner_brick', x: point.x, y: point.floorY, z: point.z,
      width: .78, height: H + .08, depth: .78,
    })
    if (model) structuralGroup.add(model)
  }
  /**
   * Модель на ребре вписывается по высоте стены и не сплющивается; если она
   * уже клетки, остаток ребра по бокам закрывается той же кладкой.
   */
  const fillEdge = (frame: THREE.Matrix4, fitted: number, look: string, tint: THREE.Color) => {
    const rest = (1 - fitted) / 2
    if (rest <= .01) return
    for (const side of [-1, 1]) box(frame, look, [side * (.5 - rest / 2), H / 2, 0], [rest, H, T], tint)
  }

  for (const edge of edgeList(map)) {
    if (!edgeVisible(map, edge) || edge.kind === 'none') continue
    if (edge.kind === 'wall' && edgeAgainstRock(map, edge)) continue
    const floorY = edgeFloorHeight(map, edge)
    const frame = edgeFrame(edge, floorY)
    const look = wallLookFor(map, edgeSideCell(map, edge))
    const seed = edge.x * 31 + edge.y * 17 + (edge.dir === 's' ? 7 : 3)
    const tint = new THREE.Color(look.tint)
    // У частокола проёмы и уступ — из бруса, а не из брёвен.
    const body = look.kind === 'palisade' ? 'timber' : look.body

    if (edge.kind === 'wall') {
      if (look.kind === 'palisade') {
        // Частокол: пять брёвен вплотную, макушки затёсаны и разной высоты.
        for (let index = 0; index < 5; index += 1) {
          const n = (salt: number) => cellNoise(seed, index, salt)
          const radius = .098 + n(1) * .012
          const height = H - .04 + n(2) * .12
          const along = -.4 + index * .2 + (n(3) - .5) * .02
          const across = (n(4) - .5) * .03
          add('log', 'log', frame.clone().multiply(local([along, height / 2, across], [radius, height, radius], [0, n(5) * Math.PI, 0])), look.tint)
          add('tip', 'log', frame.clone().multiply(local([along, height + .07, across], [radius, .14, radius])), look.tint)
        }
        // Поперечина с внутренней стороны держит брёвна.
        box(frame, 'timber', [0, H * .62, -.1], [1, .07, .05], TIMBER)
        continue
      }
      box(frame, look.body, [0, H / 2, 0], [1, H, T], tint)
      if (look.kind === 'fachwerk') {
        box(frame, 'timber', [0, .04, 0], [1, .08, T + .03], TIMBER)
        box(frame, 'timber', [0, H - .045, 0], [1, .09, T + .03], TIMBER)
        // Раскос на обеих сторонах; направление чередуется по ребру.
        const rise = H - .17, run = .88
        const angle = Math.atan2(rise, run) * (seed % 2 ? 1 : -1)
        const length = Math.hypot(rise, run)
        for (const side of [-1, 1]) box(frame, 'timber', [0, .08 + rise / 2, side * (T / 2 + .012)], [length, .07, .03], TIMBER, [0, 0, angle])
        continue
      }
      // Венчающий ряд: чуть шире стены и светлее, как обрез кладки сверху.
      if (look.kind === 'planks') box(frame, 'timber', [0, H + .025, 0], [1, .05, T + .04], TIMBER)
      else box(frame, look.body, [0, H + .025, 0], [1, .05, T + .04], tint.clone().multiplyScalar(1.12))
      continue
    }

    const structuralRole = edgeStructuralRole(map, edge, look)
    if (edge.kind === 'rail') {
      // Высокая секция кованой ограды в низких перилах повторяется по ширине ребра.
      const model = structuralRole === 'ornate_iron_fence' ? structuralInstance(structural, {
        role: 'ornate_iron_fence', x: edgeCenter(edge).x, y: floorY, z: edgeCenter(edge).z,
        yaw: edge.dir === 's' ? 0 : Math.PI / 2,
        width: 1.04, height: .56, depth: .18, fit: 'face', repeat: true,
      }) : null
      if (model) {
        structuralGroup.add(model)
        continue
      }
      for (const along of [-.46, .46]) box(frame, 'timber', [along, .26, 0], [.07, .52, .07], TIMBER)
      box(frame, 'timber', [0, .5, 0], [1, .05, .07], TIMBER)
      box(frame, 'timber', [0, .27, 0], [1, .04, .05], TIMBER)
      continue
    }
    if (edge.kind === 'ledge') {
      box(frame, body, [0, .1, 0], [1, .2, .14], tint)
      continue
    }

    if (edge.kind === 'window' || edge.kind === 'loophole' || edge.kind === 'grate') {
      // Фрагмент стены с круглым окном заменяет только существующее кирпичное
      // окно; без такого ребра модель никогда не становится проходом.
      if (structuralRole === 'round_window_brick') {
        const model = structuralInstance(structural, {
          role: 'round_window_brick', x: edgeCenter(edge).x, y: floorY, z: edgeCenter(edge).z,
          yaw: edge.dir === 's' ? 0 : Math.PI / 2,
          width: 1.04, height: H + .06, depth: Math.max(.22, T * 1.6), fit: 'face',
        })
        if (model) {
          structuralGroup.add(model)
          fillEdge(frame, Number(model.userData.fittedWidth) || 1, body, tint)
          box(frame, body, [0, H + .025, 0], [1, .05, T + .04], tint.clone().multiplyScalar(1.12))
          continue
        }
      }
      // Проём посередине свободен: сквозь окно видно комнату, как и прежде.
      const post = edge.kind === 'loophole' ? .38 : .21
      for (const side of [-1, 1]) box(frame, body, [side * (.5 - post / 2), H / 2, 0], [post, H, T], tint)
      const opening = 1 - post * 2
      if (edge.kind === 'grate') {
        box(frame, body, [0, H - .05, 0], [opening, .1, T], tint)
        for (const along of [-.21, -.07, .07, .21]) box(frame, 'iron', [along, (H - .1) / 2, 0], [.03, H - .1, .03], IRON)
        for (const y of [.3, H - .28]) box(frame, 'iron', [0, y, 0], [opening, .03, .035], IRON)
        continue
      }
      const sill = edge.kind === 'loophole' ? .45 : .28
      const lintel = edge.kind === 'loophole' ? .12 : .14
      box(frame, body, [0, sill / 2, 0], [opening, sill, T], tint)
      box(frame, body, [0, H - lintel / 2, 0], [opening, lintel, T], tint)
      box(frame, body, [0, H + .025, 0], [1, .05, T + .04], tint.clone().multiplyScalar(1.12))
      if (edge.kind === 'window') {
        const span = H - sill - lintel
        const middle = sill + span / 2
        box(frame, 'timber', [0, sill + .015, 0], [opening + .04, .03, T + .05], TIMBER)
        for (const side of [-1, 1]) box(frame, 'timber', [side * (opening / 2 - .02), middle, 0], [.04, span, .06], TIMBER)
        box(frame, 'timber', [0, middle, 0], [.03, span, .04], TIMBER)
        box(frame, 'timber', [0, middle, 0], [opening - .04, .03, .04], TIMBER)
      }
      continue
    }

    if (edge.kind !== 'door') continue
    // Арка ограничена существующим дверным пролётом и не создаёт отдельную
    // 2×2 арку поверх соседних клеток; узкую арку добирает кладка по бокам.
    const arch = structuralRole === 'sandstone_arch' || structuralRole === 'ruin_wall_arch' ? structuralInstance(structural, {
      role: structuralRole, x: edgeCenter(edge).x, y: floorY, z: edgeCenter(edge).z,
      yaw: edge.dir === 's' ? 0 : Math.PI / 2,
      width: 1.14, height: H + .08, depth: Math.max(.22, T * 1.8), fit: 'face',
    }) : null
    if (arch) {
      structuralGroup.add(arch)
      fillEdge(frame, Number(arch.userData.fittedWidth) || 1, look.body, tint)
    }
    const state = doorState(map, edge)
    // Коробка двери: брусья по бокам и притолока, как у Door Frame Quaternius.
    for (const side of [-1, 1]) box(frame, 'timber', [side * .28, H / 2, 0], [.1, H, T + .04], TIMBER, undefined, false, 'doors')
    box(frame, 'timber', [0, H - .05, 0], [.66, .1, T + .05], TIMBER, undefined, false, 'doors')
    const leafHeight = H - .13
    const leaf = (matrix: THREE.Matrix4, part: [number, number, number], size: [number, number, number], look: string, color: string | THREE.Color, rotation?: [number, number, number], swap = false) => {
      add('box', look, matrix.clone().multiply(local(part, size, rotation)), color, swap, 'doors')
    }
    const leafPieces = (matrix: THREE.Matrix4, locked: boolean) => {
      for (let index = 0; index < 4; index += 1) {
        const shade = .86 + cellNoise(seed, index, 9) * .2
        leaf(matrix, [-.1875 + index * .125, leafHeight / 2, 0], [.12, leafHeight - (index % 2) * .012, .06], 'planks', new THREE.Color(shade, shade, shade), undefined, true)
      }
      for (const y of [.17, leafHeight - .17]) leaf(matrix, [0, y, 0], [.5, .045, .075], 'iron', IRON)
      for (const side of [-1, 1]) {
        add('ring', 'iron', matrix.clone().multiply(local([.15, leafHeight * .48, side * .05], [.034, .034, .034])), IRON, false, 'doors')
        if (locked) leaf(matrix, [.15, leafHeight * .48 - .075, side * .05], [.06, .07, .03], 'iron', '#8a6a3a')
      }
    }
    if (state === 'open') {
      // Петля у края проёма: створка уходит в соседнюю клетку (+x или +z),
      // середина прохода свободна.
      const openSign = edge.dir === 's' ? 1 : -1
      const hinge = frame.clone()
        .multiply(new THREE.Matrix4().makeTranslation(-.25, 0, 0))
        .multiply(new THREE.Matrix4().makeRotationY(-openSign * Math.PI / 2))
        .multiply(new THREE.Matrix4().makeTranslation(.25, 0, 0))
      leafPieces(hinge, false)
    } else if (state === 'broken') {
      for (let index = 0; index < 3; index += 1) {
        const n = (salt: number) => cellNoise(seed, index, salt)
        leaf(frame, [(n(1) - .5) * .5, .035, (n(2) - .5) * .5], [.12, leafHeight * (.5 + n(3) * .4), .06], 'planks', '#d9cbb8', [Math.PI / 2, 0, (n(4) - .5) * 2], true)
      }
      leaf(frame, [-.19, .15, 0], [.12, .3, .06], 'planks', '#d9cbb8', [0, 0, .25], true)
    } else {
      leafPieces(frame, state === 'locked')
    }
  }

  // Клетки-кладка: стена дома толщиной в клетку — блок той же фактуры.
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (!isMasonryCell(map, x, y)) continue
    const cell = cellAt(map, x, y)
    const look = wallLookFor(map, cell)
    const body = look.kind === 'palisade' ? 'stone' : look.body
    const level = terrainHeightAt(map, x, y)
    box(identity, body, [x + .5, level + H / 2, y + .5], [1, H, 1], look.tint)
  }

  // Сборка: один материал на вид и поворот рисунка, по экземплярному мешу на форму.
  const group = new THREE.Group()
  group.name = 'styled-edges'
  const wallsGroup = new THREE.Group()
  wallsGroup.name = 'cutaway-walls'
  const doorsGroup = new THREE.Group()
  doorsGroup.name = 'doors'
  const geometries = new Map<Shape, THREE.BufferGeometry>()
  const materials = new Map<string, THREE.MeshStandardMaterial>()
  const materialFor = (look: string, swap: boolean) => {
    const key = `${look}:${swap}`
    let material = materials.get(key)
    if (!material) {
      material = createLookMaterial(pack, look, { swap, onTexture: options.onTexture, loadTexture: options.loadTexture })
      materials.set(key, material)
    }
    return material
  }
  let instances = 0
  for (const [key, bucket] of buckets) {
    let geometry = geometries.get(bucket.shape)
    if (!geometry) { geometry = createShape(bucket.shape); geometries.set(bucket.shape, geometry) }
    const mesh = new THREE.InstancedMesh(geometry, materialFor(bucket.look, bucket.swap), bucket.items.length)
    mesh.name = `wall-${bucket.shape}:${bucket.look}${bucket.swap ? ':swap' : ''}`
    bucket.items.forEach((item, index) => { mesh.setMatrixAt(index, item.matrix); mesh.setColorAt(index, item.color) })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    instances += bucket.items.length
    ;(key.startsWith('doors|') ? doorsGroup : wallsGroup).add(mesh)
  }
  if (wallsGroup.children.length) group.add(wallsGroup)
  if (doorsGroup.children.length) group.add(doorsGroup)
  if (structuralGroup.children.length) group.add(structuralGroup)
  return {
    group,
    instances,
    dispose() {
      group.removeFromParent()
      structuralGroup.clear()
      group.clear()
      for (const geometry of geometries.values()) geometry.dispose()
      for (const material of materials.values()) material.dispose()
      geometries.clear()
      materials.clear()
    },
  }
}
