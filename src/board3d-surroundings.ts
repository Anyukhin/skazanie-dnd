/**
 * Окрестности 3D-доски: земля, растительность и камни за краем карты.
 *
 * Без них карта висела в темноте, как плита на пустом столе. Окрестности —
 * только представление: клеток в них нет, шагнуть туда нельзя, и тумана войны
 * они не обходят — цвет земли берётся только у раскрытых клеток, а у скрытых и
 * пустых мест — цвет края по биому места. Земля за краем продолжает материал
 * ближайшей раскрытой уличной клетки (луг — лугом, мостовая — камнем, река
 * уходит водой) и к дальнему краю гаснет в фон. Биом выводится из темы карты
 * и её уличных клеток: лес, луг, горы, толща камня (пещера). Помещения
 * окрестностей не получают — им подходит темнота.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { cellAt } from './tactical-map-client'
import type { TacticalMap } from './types'
import { createBoulderGeometry } from './board3d-landscape'

export type SurroundingsBiome = 'forest' | 'deadwood' | 'meadow' | 'mountain' | 'rock' | 'sea' | 'indoor'
type OutdoorBiome = Exclude<SurroundingsBiome, 'indoor'>
const OUTDOOR_BIOMES = new Set<string>(['forest', 'deadwood', 'meadow', 'mountain', 'rock', 'sea'])

/** Ширина полосы окрестностей вокруг карты, в клетках. */
export const SURROUNDINGS_MARGIN = 18
/** Пикселей текстуры земли на клетку. */
const PIXELS_PER_CELL = 6
/** Насколько клеток вода реки или озера продолжается за край карты. */
const WATER_REACH = 7

const MATERIAL_COLOR: Record<string, string> = {
  grass: '#4d6a33', earth: '#5f4b33', stone: '#5c5951', sand: '#8a7752', marble: '#68655d', wood: '#4d6a33', metal: '#5c5951', ice: '#9cb3bc',
}
const BIOME_GROUND: Record<OutdoorBiome, string> = {
  forest: '#38532a', deadwood: '#3a3329', meadow: '#557038', mountain: '#56534c', rock: '#2d2a26', sea: '#1f4f5c',
}
const WATER_COLOR = '#2d5d68'
const BACKDROP: Record<SurroundingsBiome, [string, string]> = {
  forest: ['#2a3a22', '#0a0e08'],
  deadwood: ['#2a2622', '#0a0908'],
  meadow: ['#33402a', '#0d110a'],
  mountain: ['#302f2c', '#0c0c0b'],
  rock: ['#1e1c1a', '#080707'],
  sea: ['#203540', '#070c10'],
  indoor: ['#2a2620', '#0d0c0a'],
}

function hash(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function isExteriorZone(map: TacticalMap, zoneId: string): boolean {
  return map.zones.find((zone) => zone.id === zoneId)?.kind === 'exterior'
}

/**
 * Биом окрестностей. Авторская карта может назвать его сама (`surroundings`
 * карты: замок на утёсе над морем, логово в толще горы); иначе он выводится
 * из темы карты и её уличных клеток.
 */
export function surroundingsBiome(map: TacticalMap): SurroundingsBiome {
  const authored = map.surroundings?.biome
  if (authored && OUTDOOR_BIOMES.has(authored) && derivedBiome(map) !== 'indoor') return authored as OutdoorBiome
  return derivedBiome(map)
}

function derivedBiome(map: TacticalMap): SurroundingsBiome {
  let present = 0
  let exterior = 0
  let stone = 0
  let green = 0
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell) continue
      present += 1
      if (!cell.passable || !isExteriorZone(map, cell.zone)) continue
      exterior += 1
      if (cell.material === 'stone' || cell.material === 'marble') stone += 1
      if (cell.material === 'grass') green += 1
    }
  }
  if (map.theme === 'cave') return 'rock'
  if (!present || exterior < present * .15) return 'indoor'
  if (map.theme === 'forest') return 'forest'
  if (stone > green && stone > exterior * .4) return 'mountain'
  return 'meadow'
}

/** Цвета фона (центр и край виньетки) в тон окрестностям. */
export function surroundingsBackdrop(map: TacticalMap): [string, string] {
  return BACKDROP[surroundingsBiome(map)]
}

type Source = { color: THREE.Color; water: boolean }

/**
 * Биом клетки полосы: сторона света за краем карты или общий. Пустота внутри
 * прямоугольника карты принадлежит стороне, к краю которой от неё нет ни одной
 * клетки карты: так море подходит вплотную к замку на утёсе, а не за полосой луга.
 */
function cellBiome(map: TacticalMap, main: OutdoorBiome, margin: number, gx: number, gy: number, present?: Uint8Array, gridWidth = 0): OutdoorBiome {
  const sides = map.surroundings?.sides
  if (!sides) return main
  const x = gx - margin
  const y = gy - margin
  const over = { w: -x, e: x - (map.width - 1), n: -y, s: y - (map.height - 1) }
  let side: 'n' | 'e' | 's' | 'w' | null = null
  let most = 0
  for (const key of ['n', 'e', 's', 'w'] as const) if (over[key] > most) { most = over[key]; side = key }
  if (!side && present && gridWidth) {
    const open = (dx: number, dy: number) => {
      for (let cx = gx + dx, cy = gy + dy; cx >= margin && cy >= margin && cx < margin + map.width && cy < margin + map.height; cx += dx, cy += dy) {
        if (present[cy * gridWidth + cx]) return false
      }
      return true
    }
    let nearest = Infinity
    const candidates: Array<['n' | 'e' | 's' | 'w', number, number, number]> = [['n', 0, -1, y], ['s', 0, 1, map.height - 1 - y], ['w', -1, 0, x], ['e', 1, 0, map.width - 1 - x]]
    for (const [key, dx, dy, distance] of candidates) {
      if (sides[key] && distance < nearest && open(dx, dy)) { nearest = distance; side = key }
    }
  }
  const chosen = side ? sides[side] : undefined
  return chosen && OUTDOOR_BIOMES.has(chosen) ? chosen as OutdoorBiome : main
}

/**
 * Ближайший источник цвета для каждой клетки расширенной сетки: обход в
 * ширину от раскрытых уличных клеток. Скрытые и непрозрачные для улицы клетки
 * (помещения, кладка) источником не служат — у них цвет биома.
 */
function nearestSources(map: TacticalMap, margin: number, biomeColor: THREE.Color) {
  const width = map.width + margin * 2
  const height = map.height + margin * 2
  const distance = new Float32Array(width * height).fill(Infinity)
  const source: Array<Source | null> = new Array(width * height).fill(null)
  const present = new Uint8Array(width * height)
  const queue: number[] = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell) continue
      const index = (y + margin) * width + (x + margin)
      present[index] = 1
      if (!cell.revealed || !isExteriorZone(map, cell.zone)) continue
      const water = cell.surface === 'water'
      if (!cell.passable && !water) continue
      distance[index] = 0
      source[index] = { color: water ? new THREE.Color(WATER_COLOR) : new THREE.Color(MATERIAL_COLOR[cell.material] ?? MATERIAL_COLOR.grass), water }
      queue.push(index)
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head]
    const x = index % width
    const y = Math.floor(index / width)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const next = ny * width + nx
      if (distance[next] <= distance[index] + 1) continue
      distance[next] = distance[index] + 1
      source[next] = source[index]
      queue.push(next)
    }
  }
  // Отступ от любой клетки карты — раскрытой или нет, улицы или помещения:
  // дерево или камень не должны вставать вплотную к стене или под туман.
  const clearance = new Float32Array(width * height).fill(Infinity)
  const ring: number[] = []
  for (let index = 0; index < present.length; index += 1) if (present[index]) { clearance[index] = 0; ring.push(index) }
  for (let head = 0; head < ring.length; head += 1) {
    const index = ring[head]
    const x = index % width
    const y = Math.floor(index / width)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const next = ny * width + nx
      if (clearance[next] <= clearance[index] + 1) continue
      clearance[next] = clearance[index] + 1
      ring.push(next)
    }
  }
  return { width, height, distance, source, present, clearance, biomeColor }
}

function groundTexture(map: TacticalMap, main: OutdoorBiome, grid: ReturnType<typeof nearestSources>, margin: number): THREE.Texture | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  const raw = document.createElement('canvas')
  raw.width = grid.width * PIXELS_PER_CELL
  raw.height = grid.height * PIXELS_PER_CELL
  const context = raw.getContext('2d')
  if (!context) return null
  const color = new THREE.Color()
  const rgb = { r: 0, g: 0, b: 0 }
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const index = y * grid.width + x
      const found = grid.source[index]
      const d = grid.distance[index]
      const biomeColor = new THREE.Color(BIOME_GROUND[cellBiome(map, main, margin, x, y, grid.present, grid.width)])
      if (found?.water && d <= WATER_REACH) color.copy(found.color)
      else if (found && Number.isFinite(d)) color.copy(found.color).lerp(biomeColor, Math.min(1, d / 6))
      else color.copy(biomeColor)
      const shade = .9 + hash(x, y, 7) * .18
      color.multiplyScalar(shade)
      // Гаснет к внешнему краю полосы: окрестности растворяются в фоне.
      const edge = Math.min(x, y, grid.width - 1 - x, grid.height - 1 - y)
      // Под самой картой земли нет: там её пол и вода, иначе плоскость их
      // перекрыла бы (вода лежит ниже верха плиток).
      const alpha = grid.present[index] ? 0 : Math.max(0, Math.min(1, edge / (margin * .7)))
      // THREE.Color хранит линейные значения, холст ждёт sRGB.
      color.getRGB(rgb, THREE.SRGBColorSpace)
      context.fillStyle = `rgba(${Math.round(rgb.r * 255)},${Math.round(rgb.g * 255)},${Math.round(rgb.b * 255)},${alpha.toFixed(3)})`
      context.fillRect(x * PIXELS_PER_CELL, y * PIXELS_PER_CELL, PIXELS_PER_CELL, PIXELS_PER_CELL)
    }
  }
  const soft = document.createElement('canvas')
  soft.width = raw.width
  soft.height = raw.height
  const softContext = soft.getContext('2d')
  if (!softContext) return null
  softContext.filter = `blur(${Math.round(PIXELS_PER_CELL * .8)}px)`
  softContext.drawImage(raw, 0, 0)
  // Дыра под картой вырезается после размытия: иначе край земли у карты стал
  // бы полупрозрачным и сквозь него виднелся бы борт доски.
  softContext.filter = 'none'
  softContext.globalCompositeOperation = 'destination-out'
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      if (grid.present[y * grid.width + x]) softContext.fillRect(x * PIXELS_PER_CELL, y * PIXELS_PER_CELL, PIXELS_PER_CELL, PIXELS_PER_CELL)
    }
  }
  softContext.globalCompositeOperation = 'source-over'
  const texture = new THREE.CanvasTexture(soft)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function coniferGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(.06, .09, .35, 6).translate(0, .175, 0)
  const lower = new THREE.ConeGeometry(.42, .8, 7).translate(0, .65, 0)
  const upper = new THREE.ConeGeometry(.3, .6, 7).translate(0, 1.05, 0)
  return paintedMerge([[trunk, '#4a3523'], [lower, '#ffffff'], [upper, '#ffffff']])
}

function broadleafGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(.07, .1, .45, 6).translate(0, .225, 0)
  const crown = new THREE.IcosahedronGeometry(.48, 1).scale(1, .85, 1).translate(0, .82, 0)
  return paintedMerge([[trunk, '#4a3523'], [crown, '#ffffff']])
}

/** Сухой ствол с обломанными ветвями: мёртвый лес без кроны. */
function deadTreeGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(.05, .1, 1.1, 5).translate(0, .55, 0)
  const branchA = new THREE.CylinderGeometry(.025, .045, .55, 4).rotateZ(.9).translate(.2, .85, 0)
  const branchB = new THREE.CylinderGeometry(.02, .04, .45, 4).rotateZ(-1.1).rotateY(1.7).translate(-.12, .7, .1)
  const branchC = new THREE.CylinderGeometry(.015, .03, .35, 4).rotateZ(.5).rotateY(-1).translate(.05, 1.05, -.1)
  return paintedMerge([[trunk, '#ffffff'], [branchA, '#ffffff'], [branchB, '#ffffff'], [branchC, '#ffffff']])
}

function bushGeometry(): THREE.BufferGeometry {
  return paintedMerge([[new THREE.IcosahedronGeometry(.3, 0).scale(1.2, .7, 1.1).translate(0, .18, 0), '#ffffff']])
}

/**
 * Склейка частей с цветом вершин: ствол — свой цвет, крона — белая, её тон
 * даёт цвет экземпляра. Так один InstancedMesh рисует разные по цвету деревья.
 */
function paintedMerge(parts: Array<[THREE.BufferGeometry, string]>): THREE.BufferGeometry {
  const painted = parts.map(([geometry, tone]) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry
    if (flat !== geometry) geometry.dispose()
    const colors = new Float32Array(flat.getAttribute('position').count * 3)
    const color = new THREE.Color(tone)
    for (let index = 0; index < colors.length; index += 3) colors.set([color.r, color.g, color.b], index)
    flat.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    flat.deleteAttribute('uv')
    return flat
  })
  const merged = mergeGeometries(painted, false) ?? painted[0]
  for (const geometry of painted) if (geometry !== merged) geometry.dispose()
  merged.computeVertexNormals()
  return merged
}

/**
 * Модель окрестностей в общем виде: части (геометрия + материал), центр
 * основания в начале координат, большая сторона по X/Z равна 1. Так одинаково
 * размещаются камни набора местности, деревья и утёсы стиль-пака и
 * процедурные заменители.
 */
export type SurroundingsModel = { parts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }>; size: THREE.Vector3 }

/** Модели, подгружаемые сценой; без них окрестности рисуются заменителями. */
export type SurroundingsModels = {
  cliffRocks?: readonly SurroundingsModel[]
  cliffs?: readonly SurroundingsModel[]
  broadleaf?: readonly SurroundingsModel[]
  conifers?: readonly SurroundingsModel[]
  dead?: readonly SurroundingsModel[]
  bushes?: readonly SurroundingsModel[]
  /**
   * Загруженная фактура покрытия пакета стиля (`surroundingsGroundFloor`) и
   * её повтор в клетках: земля за краем получает тот же рисунок, что пол
   * карты, а не ровную заливку. Фактурой владеет сцена.
   */
  groundDetail?: { texture: THREE.Texture; cells: number }
}

/** Покрытие пакета стиля, чей рисунок ложится на землю окрестностей; null — окрестностей нет. */
export function surroundingsGroundFloor(map: TacticalMap): 'grass' | 'earth' | null {
  const biome = surroundingsBiome(map)
  if (biome === 'indoor') return null
  return biome === 'forest' || biome === 'meadow' ? 'grass' : 'earth'
}

/**
 * Рисунок покрытия поверх цвета земли: берётся только яркость фактуры,
 * делённая на её среднюю (последний мип), поэтому цвет низины — от биома и
 * соседних клеток, как прежде, а травинки и камешки — от пакета. UV — мировые.
 */
function applyGroundDetail(material: THREE.MeshStandardMaterial, detail: NonNullable<SurroundingsModels['groundDetail']>) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.groundDetail = { value: detail.texture }
    shader.uniforms.groundDetailScale = { value: 1 / Math.max(.5, detail.cells) }
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec2 vGroundWorld;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform sampler2D groundDetail;\nuniform float groundDetailScale;\nvarying vec2 vGroundWorld;\nvoid main() {')
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec2 detailUv = vGroundWorld * groundDetailScale;
  float detailLuma = dot(texture2D(groundDetail, detailUv).rgb, vec3(.2126, .7152, .0722));
  float detailMean = dot(textureLod(groundDetail, detailUv, 12.0).rgb, vec3(.2126, .7152, .0722));
  diffuseColor.rgb *= clamp(mix(1.0, detailLuma / max(.02, detailMean), .85), .55, 1.45);
}`)
  }
  material.customProgramCacheKey = () => 'board3d-surroundings-detail-v1'
}

/** Виды предметов, чьи модели окрестности берут из выпуска и стиль-пака. */
export const SURROUNDINGS_MODEL_ASSETS = Object.freeze({
  cliffs: ['cliff_large', 'cliff_medium', 'cliff_long'],
  broadleaf: ['tree_oak', 'tree_birch'],
  conifers: ['tree_pine', 'tree_spruce'],
  dead: ['tree_dead'],
  bushes: ['bush'],
} as const)

/**
 * Шаблон GLB → модель окрестностей. Геометрии частей запекаются в общий вид
 * (клон, свои), материалы остаются материалами шаблона (их освобождает набор).
 */
export function surroundingsModelFromTemplate(template: THREE.Object3D): SurroundingsModel | null {
  const root = template.clone(true)
  root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return null
  const size = box.getSize(new THREE.Vector3())
  const scale = 1 / Math.max(.001, size.x, size.z)
  const parts: SurroundingsModel['parts'] = []
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
    geometry.scale(scale, scale, scale)
    parts.push({ geometry, material: Array.isArray(mesh.material) ? mesh.material[0] : mesh.material })
  })
  return parts.length ? { parts, size: size.multiplyScalar(scale) } : null
}

/** Высота обрыва под картой по биому: невысокий берег у луга, утёс у гор и моря. */
const CLIFF_DROP: Record<OutdoorBiome, number> = { meadow: 1.1, forest: 1.3, deadwood: 1.3, mountain: 2.8, rock: 3.2, sea: 2.6 }

type Item = { model: SurroundingsModel; matrix: THREE.Matrix4; color: THREE.Color | null }

/** Экземпляры: один InstancedMesh на пару (геометрия части, материал) и участок. */
function instanceItems(group: THREE.Group, name: string, items: readonly Item[]) {
  const batches = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; entries: Item[] }>()
  for (const item of items) for (const part of item.model.parts) {
    // Крупные участки: окрестности далеко от огней, мелкое дробление давало
    // лишь лишние вызовы отрисовки.
    const chunk = `${Math.floor(item.matrix.elements[12] / 40)}:${Math.floor(item.matrix.elements[14] / 40)}`
    const key = `${part.geometry.uuid}:${part.material.uuid}:${chunk}`
    const batch = batches.get(key) ?? { geometry: part.geometry, material: part.material, entries: [] }
    batch.entries.push(item)
    batches.set(key, batch)
  }
  for (const batch of batches.values()) {
    const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.entries.length)
    mesh.name = name
    batch.entries.forEach((entry, index) => {
      mesh.setMatrixAt(index, entry.matrix)
      if (entry.color) mesh.setColorAt(index, entry.color)
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    group.add(mesh)
  }
}

/** Процедурные заменители, пока модели не загружены (и в тестах без браузера). */
function fallbackModels(): { models: Required<Omit<SurroundingsModels, 'groundDetail'>>; owned: Array<{ dispose: () => void }> } {
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: .95, metalness: 0, flatShading: true })
  // Оттенок камня (`rockTint`) рассчитан на светлую фактуру моделей набора; у
  // заменителя фактуры нет, и белая база давала белые глыбы, пока набор не
  // загрузится. Серо-бурая база даёт под тем же оттенком обычный камень.
  const rockMaterial = new THREE.MeshStandardMaterial({ color: '#7a7268', roughness: .92, metalness: 0, flatShading: true })
  const wrap = (geometry: THREE.BufferGeometry, mat: THREE.Material): SurroundingsModel => {
    geometry.computeBoundingBox()
    const size = geometry.boundingBox!.getSize(new THREE.Vector3())
    return { parts: [{ geometry, material: mat }], size }
  }
  const rocks = [wrap(createBoulderGeometry(3).translate(0, .5, 0), rockMaterial), wrap(createBoulderGeometry(7).translate(0, .5, 0), rockMaterial)]
  const models = {
    cliffRocks: rocks,
    cliffs: [] as SurroundingsModel[],
    broadleaf: [wrap(broadleafGeometry(), material)],
    conifers: [wrap(coniferGeometry(), material)],
    dead: [wrap(deadTreeGeometry(), material)],
    bushes: [wrap(bushGeometry(), material)],
  }
  const owned: Array<{ dispose: () => void }> = [material, rockMaterial]
  for (const list of Object.values(models)) for (const model of list) for (const part of model.parts) owned.push(part.geometry)
  return { models, owned }
}

// Деревья моделей тяжёлые (тысячи треугольников): потолок держит окрестности
// заметно легче самой карты.
const DECOR_LIMITS = { full: 1100, reduced: 650, minimal: 260 } as const

/** Уровень моря над низиной: подножие утёсов и осыпь уходят под воду. */
const SEA_LEVEL = .38
/** Цвет открытого моря; мелководье подмешивается в шейдере. */
const SEA_DEEP = '#123c4a'

type SeaMaterial = THREE.MeshStandardMaterial & { userData: { time: { value: number } } }

/**
 * Гладь моря по клеткам полосы со стороной `sea`. Вершины общие на сетке —
 * волна сдвигает их непрерывно. Атрибут `coast` — расстояние до берега в
 * клетках (утёс карты или суша низины): у берега пена и прибой; `beach` —
 * расстояние до суши низины: там вода полого опускается к земле; `fade` гасит
 * гладь к внешнему краю полосы, как землю.
 */
function createSeaGeometry(map: TacticalMap, main: OutdoorBiome, grid: ReturnType<typeof nearestSources>, margin: number): THREE.BufferGeometry | null {
  const sea = new Uint8Array(grid.width * grid.height)
  let any = false
  for (let gy = 0; gy < grid.height; gy += 1) {
    for (let gx = 0; gx < grid.width; gx += 1) {
      const index = gy * grid.width + gx
      if (grid.present[index] || cellBiome(map, main, margin, gx, gy, grid.present, grid.width) !== 'sea') continue
      sea[index] = 1
      any = true
    }
  }
  if (!any) return null
  // Расстояние до низины соседнего биома (луг, лес): там пологий берег.
  const beachDistance = new Float32Array(grid.width * grid.height).fill(Infinity)
  const queue: number[] = []
  for (let index = 0; index < sea.length; index += 1) {
    if (!sea[index] && !grid.present[index]) { beachDistance[index] = 0; queue.push(index) }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head]
    const x = index % grid.width, y = Math.floor(index / grid.width)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue
      const next = ny * grid.width + nx
      if (grid.present[next] || beachDistance[next] <= beachDistance[index] + 1) continue
      beachDistance[next] = beachDistance[index] + 1
      queue.push(next)
    }
  }
  const columns = grid.width + 1
  const vertexOf = new Int32Array(columns * (grid.height + 1)).fill(-1)
  const positions: number[] = [], coast: number[] = [], beach: number[] = [], fade: number[] = [], indices: number[] = []
  const vertex = (vx: number, vy: number) => {
    const key = vy * columns + vx
    if (vertexOf[key] >= 0) return vertexOf[key]
    // Угол делят до четырёх клеток: берег — ближайшая из них к карте или к суше.
    let cliff = Infinity, land = Infinity
    for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
      const cx = vx + dx, cy = vy + dy
      if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) continue
      const index = cy * grid.width + cx
      cliff = Math.min(cliff, grid.clearance[index] - 1)
      land = Math.min(land, sea[index] ? beachDistance[index] - .5 : 0)
    }
    const edge = Math.min(vx, vy, grid.width - vx, grid.height - vy)
    vertexOf[key] = positions.length / 3
    positions.push(vx - margin, 0, vy - margin)
    const shore = Math.min(cliff, land)
    coast.push(Number.isFinite(shore) ? Math.max(0, shore) : margin)
    beach.push(Number.isFinite(land) ? Math.max(0, land) : margin)
    fade.push(Math.max(0, Math.min(1, edge / (margin * .7))))
    return vertexOf[key]
  }
  for (let gy = 0; gy < grid.height; gy += 1) {
    for (let gx = 0; gx < grid.width; gx += 1) {
      if (!sea[gy * grid.width + gx]) continue
      const a = vertex(gx, gy), b = vertex(gx, gy + 1), c = vertex(gx + 1, gy + 1), d = vertex(gx + 1, gy)
      indices.push(a, b, c, a, c, d)
    }
  }
  const vertexCount = positions.length / 3
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: vertexCount * 3 }, (_, index) => index % 3 === 1 ? 1 : 0), 3))
  geometry.setAttribute('coast', new THREE.Float32BufferAttribute(coast, 1))
  geometry.setAttribute('beach', new THREE.Float32BufferAttribute(beach, 1))
  geometry.setAttribute('fade', new THREE.Float32BufferAttribute(fade, 1))
  geometry.setIndex(vertexCount > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}

/** Бегущие волны моря: высота и её производные по x и z — для вершины и нормали. */
const SEA_WAVES_GLSL = `
  uniform float uSeaTime;
  attribute float coast;
  attribute float beach;
  attribute float fade;
  varying float vCoast;
  varying float vFade;
  varying float vCrest;
  varying vec2 vSeaXZ;
  vec3 seaWave(vec2 p, float t) {
    vec3 sum = vec3(0.);
    // xy — направление, z — волновое число, w — высота.
    vec4 waves[4];
    waves[0] = vec4(.82, .57, .55, .11);
    waves[1] = vec4(-.35, .94, .9, .06);
    waves[2] = vec4(.97, -.24, 1.45, .035);
    waves[3] = vec4(-.7, -.71, 2.3, .02);
    for (int i = 0; i < 4; i++) {
      vec2 d = waves[i].xy;
      float k = waves[i].z;
      float a = waves[i].w;
      float phase = dot(d, p) * k + t * sqrt(9.8 * k) * .55;
      sum.x += a * sin(phase);
      sum.yz += a * k * cos(phase) * d;
    }
    return sum;
  }`

/**
 * Материал моря: вершины качают несколько бегущих волн, нормаль считается по
 * той же формуле. Гребни светлеют, у утёсов белеет пена и катятся полосы
 * прибоя. Время — одна униформа, как у воды и лавы на карте.
 */
function createSeaMaterial(): SeaMaterial {
  const material = new THREE.MeshStandardMaterial({ color: SEA_DEEP, transparent: true, roughness: .34, metalness: .05, depthWrite: false })
  const time = { value: 0 }
  material.userData.time = time
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSeaTime = time
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SEA_WAVES_GLSL}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        // У самого утёса волна гаснет: вода не перехлёстывает через камни.
        vec3 seaH = seaWave(position.xz, uSeaTime) * smoothstep(0., 2.5, coast);
        objectNormal = normalize(vec3(-seaH.y, 1., -seaH.z));`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // У пологого берега вода опускается под землю низины: без ступеньки.
        transformed.y += seaH.x - ${(SEA_LEVEL + .05).toFixed(2)} * (1. - smoothstep(0., 1.6, beach));
        vCoast = coast;
        vFade = fade;
        vCrest = seaH.x;
        vSeaXZ = position.xz;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSeaTime;\nvarying float vCoast;\nvarying float vFade;\nvarying float vCrest;\nvarying vec2 vSeaXZ;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float t = uSeaTime;
          // Мелководье у берега бирюзовее, открытое море глубже.
          float shallow = 1. - smoothstep(0., 6., vCoast);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.05, .32, .34), shallow * .7);
          // Гребни волн светлеют.
          diffuseColor.rgb += vec3(.04, .07, .07) * smoothstep(.08, .2, vCrest);
          // Пена у камней и полосы прибоя, бегущие к утёсу.
          float jitter = sin(vSeaXZ.x * 1.3 + vSeaXZ.y * .9) * .35 + sin(vSeaXZ.x * .41 - vSeaXZ.y * .77 + t * .3) * .5;
          float surf = smoothstep(.72, .96, sin((vCoast + jitter) * 2.2 + t * 1.6)) * (1. - smoothstep(.5, 4.5, vCoast));
          float rim = 1. - smoothstep(0., 1.1, vCoast + jitter * .4);
          float foam = clamp(max(rim, surf * .8), 0., 1.);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.86, .93, .92), foam * .85);
          diffuseColor.a = mix(.86, .97, foam) * vFade;
        }`)
  }
  material.customProgramCacheKey = () => 'board3d-sea-v1'
  return material as SeaMaterial
}

export type Surroundings = {
  group: THREE.Group
  /** Есть ли что качать во времени: море у карты. */
  animated: boolean
  /** Время в секундах для волн моря. */
  animate: (seconds: number) => void
  dispose: () => void
}

/**
 * Окрестности карты: карта — плато, по её краю обрыв из скальных моделей и
 * утёсов, у подножия осыпь, ниже — низина биома с деревьями, лугом или морем.
 * `null` — у помещения окрестностей нет. `models` — модели, которые сцена
 * успела загрузить; чего нет, то рисуется заменителем.
 */
export function createSurroundings(map: TacticalMap, detail: 'full' | 'reduced' | 'minimal' = 'reduced', models: SurroundingsModels = {}): Surroundings | null {
  const resolved = surroundingsBiome(map)
  if (resolved === 'indoor') return null
  const biome: OutdoorBiome = resolved
  const margin = SURROUNDINGS_MARGIN
  const biomeColor = new THREE.Color(BIOME_GROUND[biome])
  const grid = nearestSources(map, margin, biomeColor)
  const group = new THREE.Group()
  group.name = 'surroundings'
  const owned: Array<{ dispose: () => void }> = []
  const fallback = fallbackModels()
  owned.push(...fallback.owned)
  const pick = <T>(list: readonly T[] | undefined, alt: readonly T[], noise: number): T | null => {
    const source = list?.length ? list : alt
    return source.length ? source[Math.floor(noise * source.length) % source.length] : null
  }
  const sideBiomes = Object.values(map.surroundings?.sides ?? {})
    .filter((value): value is OutdoorBiome => typeof value === 'string' && OUTDOOR_BIOMES.has(value))
  const drop = Math.max(CLIFF_DROP[biome], ...sideBiomes.map((value) => CLIFF_DROP[value]))

  const texture = groundTexture(map, biome, grid, margin)
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: texture ? '#ffffff' : biomeColor,
    map: texture,
    roughness: 1,
    metalness: 0,
    transparent: Boolean(texture),
    alphaTest: .02,
  })
  if (texture && models.groundDetail) applyGroundDetail(groundMaterial, models.groundDetail)
  const groundGeometry = new THREE.PlaneGeometry(grid.width, grid.height).rotateX(-Math.PI / 2)
  const ground = new THREE.Mesh(groundGeometry, groundMaterial)
  ground.name = 'surroundings-ground'
  ground.position.set(map.width / 2, -drop, map.height / 2)
  ground.receiveShadow = true
  ground.renderOrder = -1
  group.add(ground)
  owned.push(groundGeometry, groundMaterial)
  if (texture) owned.push(texture)

  // Море: волнистая гладь над низиной по сторонам `sea`, у утёсов — прибой.
  const seaGeometry = createSeaGeometry(map, biome, grid, margin)
  const seaMaterial = seaGeometry ? createSeaMaterial() : null
  if (seaGeometry && seaMaterial) {
    const sea = new THREE.Mesh(seaGeometry, seaMaterial)
    sea.name = 'surroundings-sea'
    sea.position.y = -drop + SEA_LEVEL
    sea.receiveShadow = true
    sea.renderOrder = 1
    group.add(sea)
    owned.push(seaGeometry, seaMaterial)
  }

  const object = new THREE.Object3D()
  const matrixFor = (x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, tilt = 0) => {
    object.position.set(x, y, z)
    object.rotation.set(tilt, yaw, 0)
    object.scale.set(sx, sy, sz)
    object.updateMatrix()
    return object.matrix.clone()
  }
  const rockTint = (gx: number, gy: number, salt: number) => {
    // Множитель к текстуре камня: светлый, иначе глыбы уходят в черноту.
    const base = biome === 'rock' ? '#a39a8f' : biome === 'mountain' ? '#e2dbcf' : biome === 'deadwood' ? '#bfb3a3' : '#f2ede4'
    return new THREE.Color(base).offsetHSL(0, 0, (hash(gx, gy, salt) - .5) * .12)
  }

  // Обрыв: столб из камней на каждой клетке вплотную к карте, через равные
  // промежутки — утёс, развёрнутый наружу. Верх ниже плиток: край карты
  // остаётся видимым уступом, камень не заходит на клетки.
  const cliffItems: Item[] = []
  const talusItems: Item[] = []
  const layers = Math.max(1, Math.ceil(drop / (detail === 'full' ? 1.05 : 1.4)))
  for (let gy = 0; gy < grid.height; gy += 1) {
    for (let gx = 0; gx < grid.width; gx += 1) {
      const index = gy * grid.width + gx
      if (grid.present[index]) continue
      const clearance = grid.clearance[index]
      const x = gx - margin + .5
      const z = gy - margin + .5
      if (clearance === 1) {
        let nx = 0
        let nz = 0
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const ox = gx + dx
          const oy = gy + dy
          if (ox < 0 || oy < 0 || ox >= grid.width || oy >= grid.height || !grid.present[oy * grid.width + ox]) continue
          nx -= dx
          nz -= dy
        }
        const length = Math.hypot(nx, nz) || 1
        nx /= length
        nz /= length
        const span = drop / layers
        for (let layer = 0; layer < layers; layer += 1) {
          const model = pick(models.cliffRocks, fallback.models.cliffRocks, hash(gx, gy, 20 + layer))
          if (!model) continue
          const footprint = 1.35 + hash(gx, gy, 30 + layer) * .55
          const height = Math.min(span * 1.5, drop - layer * span)
          const sy = Math.min(2.6, Math.max(.7, height / Math.max(.05, model.size.y * footprint))) * footprint
          const base = -drop + layer * span - .1
          const top = base + model.size.y * sy
          // Верхний камень не выше уровня плиток: иначе он накрыл бы край карты.
          const clamp = top > -.06 ? Math.max(.2, (-.06 - base) / (model.size.y * sy)) : 1
          cliffItems.push({
            model,
            matrix: matrixFor(x + nx * .42, base, z + nz * .42, hash(gx, gy, 40 + layer) * Math.PI * 2, footprint, sy * clamp, footprint * (.85 + hash(gx, gy, 50) * .3), (hash(gx, gy, 60) - .5) * .15),
            color: rockTint(gx, gy, 70 + layer),
          })
        }
        if (hash(gx, gy, 80) < .14) {
          const cliff = pick(models.cliffs, [], hash(gx, gy, 81))
          if (cliff) {
            const scale = drop * 1.02 / Math.max(.05, cliff.size.y)
            const push = .5 + cliff.size.z * scale * .35
            cliffItems.push({
              model: cliff,
              matrix: matrixFor(x + nx * push, -drop - .05, z + nz * push, Math.atan2(nx, nz), scale, scale, scale),
              color: rockTint(gx, gy, 82),
            })
          }
        }
      } else if (clearance <= 3 && hash(gx, gy, 90) < .32) {
        const model = pick(models.cliffRocks, fallback.models.cliffRocks, hash(gx, gy, 91))
        if (model) {
          const footprint = .6 + hash(gx, gy, 92) * .8
          talusItems.push({
            model,
            matrix: matrixFor(x + (hash(gx, gy, 93) - .5) * .6, -drop - .05, z + (hash(gx, gy, 94) - .5) * .6, hash(gx, gy, 95) * Math.PI * 2, footprint, footprint * (.6 + hash(gx, gy, 96) * .5), footprint),
            color: rockTint(gx, gy, 97),
          })
        }
      }
    }
  }
  instanceItems(group, 'surroundings-cliff', cliffItems)
  instanceItems(group, 'surroundings-talus', talusItems)

  // Низина: деревья, кусты и камни биома ниже уровня карты.
  const limit = DECOR_LIMITS[detail]
  const TREE = { forest: .45, deadwood: 0, meadow: .05, mountain: .02, rock: 0, sea: 0 }
  const DEAD = { forest: 0, deadwood: .35, meadow: 0, mountain: 0, rock: 0, sea: 0 }
  const CONIFER = { forest: .45, deadwood: 0, meadow: .25, mountain: .8, rock: 0, sea: 0 }
  const BUSH = { forest: .1, deadwood: 0, meadow: .07, mountain: .02, rock: 0, sea: 0 }
  const ROCK = { forest: .02, deadwood: .05, meadow: .02, mountain: .12, rock: .22, sea: 0 }
  const decor: Record<'broadleaf' | 'conifers' | 'dead' | 'bushes' | 'rocks', Item[]> = { broadleaf: [], conifers: [], dead: [], bushes: [], rocks: [] }
  for (let gy = 0; gy < grid.height && limit > 0; gy += 1) {
    for (let gx = 0; gx < grid.width; gx += 1) {
      const index = gy * grid.width + gx
      if (grid.present[index] || grid.clearance[index] < 3.5) continue
      const d = grid.distance[index]
      const found = grid.source[index]
      if (found?.water && d <= WATER_REACH) continue
      const edge = Math.min(gx, gy, grid.width - 1 - gx, grid.height - 1 - gy)
      if (edge < 2) continue
      const fade = Math.min(1, edge / (margin * .6))
      const local = cellBiome(map, biome, margin, gx, gy, grid.present, grid.width)
      const x = gx - margin + .5 + (hash(gx, gy, 1) - .5) * .7
      const z = gy - margin + .5 + (hash(gx, gy, 2) - .5) * .7
      const roll = hash(gx, gy, 3)
      const yaw = hash(gx, gy, 4) * Math.PI * 2
      const size = (low: number, high: number) => low + hash(gx, gy, 9) * (high - low)
      const place = (key: keyof typeof decor, list: readonly SurroundingsModel[] | undefined, alt: readonly SurroundingsModel[], scale: number, color: THREE.Color | null) => {
        const model = pick(list, alt, hash(gx, gy, 11))
        if (model) decor[key].push({ model, matrix: matrixFor(x, -drop, z, yaw, scale, scale, scale), color })
      }
      const modelled = (list: readonly SurroundingsModel[] | undefined) => Boolean(list?.length)
      if (DEAD[local] && roll < DEAD[local] * fade) {
        place('dead', models.dead, fallback.models.dead, size(1.8, 3), modelled(models.dead) ? null : new THREE.Color('#3b3128'))
      } else if (roll < TREE[local] * fade) {
        const conifer = hash(gx, gy, 5) < CONIFER[local]
        const tone = modelled(conifer ? models.conifers : models.broadleaf) ? null
          : new THREE.Color(conifer ? '#2f4a2a' : '#45632f').offsetHSL((hash(gx, gy, 6) - .5) * .05, 0, (hash(gx, gy, 8) - .5) * .12)
        place(conifer ? 'conifers' : 'broadleaf', conifer ? models.conifers : models.broadleaf, conifer ? fallback.models.conifers : fallback.models.broadleaf, size(2, 3.4), tone)
      } else if (roll < (TREE[local] + BUSH[local]) * fade) {
        place('bushes', models.bushes, fallback.models.bushes, size(1, 1.8), modelled(models.bushes) ? null : new THREE.Color('#4f6b34'))
      } else if (roll < (TREE[local] + BUSH[local] + ROCK[local]) * fade) {
        place('rocks', models.cliffRocks, fallback.models.cliffRocks, size(.6, local === 'rock' || local === 'mountain' ? 2.2 : 1.1), rockTint(gx, gy, 12))
      }
    }
  }
  // Лимит берётся равномерно по всей полосе, а не первыми строками.
  const capped = (list: Item[], share: number) => {
    const maximum = Math.max(0, Math.floor(limit * share))
    if (list.length <= maximum) return list
    const step = list.length / maximum
    return Array.from({ length: maximum }, (_, index) => list[Math.floor(index * step)])
  }
  // Лиственные модели в несколько раз тяжелее хвойных: их доля меньше.
  instanceItems(group, 'surroundings-trees', capped(decor.broadleaf, .08))
  instanceItems(group, 'surroundings-conifers', capped(decor.conifers, .45))
  instanceItems(group, 'surroundings-deadwood', capped(decor.dead, .5))
  instanceItems(group, 'surroundings-bushes', capped(decor.bushes, .2))
  instanceItems(group, 'surroundings-rocks', capped(decor.rocks, .3))
  return {
    group,
    animated: Boolean(seaMaterial),
    animate: (seconds: number) => { if (seaMaterial) seaMaterial.userData.time.value = seconds },
    dispose: () => {
      for (const resource of owned) resource.dispose()
      group.clear()
    },
  }
}
