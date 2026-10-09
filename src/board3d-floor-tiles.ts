import * as THREE from 'three'
import { zoneOfCell } from './board-render'
import { createTileGroundGeometry, type TileGroundRelief } from './board3d-landscape'
import { createTerrainSideGeometry, terrainHeightAt } from './board3d-terrain'
import { BOARD3D_FLOOR_RELIEF, heightSamplerFromTexture, reliefSubdivisions, type FloorReliefLevel } from './board3d-floor-relief'
import type { GraphicsStylePack, StyleFloor } from './board3d-style'
import { cellAt } from './tactical-map-client'
import type { TacticalCell, TacticalMap } from './types'

/**
 * Пол стиля графики: клетки одного покрытия — одна сетка плиток со скосами
 * (`createTileGroundGeometry`) и PBR-материал пакета стиля. Рельеф камней и
 * досок рисует параллакс по карте высот: геометрия остаётся двумя
 * треугольниками на верх клетки, глубину строит видеокарта.
 *
 * Вода, масло и непроходимые клетки остаются на прежнем полу с рисунком:
 * у них своя анимация и свои слои.
 */

/** Покрытие клетки в терминах пакета стиля; null — клетка остаётся на прежнем полу. */
export function floorKeyForCell(map: TacticalMap, cell: TacticalCell | null | undefined): string | null {
  if (!cell?.revealed || !cell.passable) return null
  if (cell.surface === 'water' || cell.surface === 'oil') return null
  if (cell.surface === 'mud' || cell.surface === 'rubble' || cell.surface === 'ice') return cell.surface
  return zoneOfCell(map, cell)?.floor ?? cell.material
}

/**
 * Естественные покрытия лежат сплошным ковром: швы плиток на газоне и дороге
 * читались сверху сеткой. Мощёные полы остаются плитками с фаской.
 */
export const NATURAL_FLOORS: ReadonlySet<string> = new Set(['grass', 'earth', 'sand', 'mud', 'snow', 'gravel'])

const PARALLAX_CHUNK = /* glsl */`
uniform sampler2D uFloorHeight;
uniform float uFloorParallax;
// Рельеф параллаксом с поиском пересечения: шаги по высоте вдоль взгляда,
// затем линейное уточнение между последними двумя слоями. Все выборки идут
// с производными исходных UV: сдвиг в соседних пикселях разный, и обычная
// выборка уходила бы в самый мелкий мип — пол заливался бы средним цветом.
vec2 floorDx;
vec2 floorDy;
vec4 floorSample(sampler2D map, vec2 uv) { return textureGrad(map, uv, floorDx, floorDy); }
vec2 floorParallaxUv(vec2 uv) {
  floorDx = dFdx(uv);
  floorDy = dFdy(uv);
  vec3 tangent = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  vec3 bitangent = normalize((viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 up = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 eye = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  vec3 view = vec3(dot(eye, tangent), dot(eye, bitangent), dot(eye, up));
  float layers = mix(28.0, 10.0, clamp(abs(view.z), 0.0, 1.0));
  float layerDepth = 1.0 / layers;
  vec2 delta = view.xy / max(view.z, 0.25) * uFloorParallax / layers;
  vec2 current = uv;
  float depth = 0.0;
  float surface = 1.0 - floorSample(uFloorHeight, current).r;
  for (int i = 0; i < 32; i++) {
    if (float(i) >= layers || depth >= surface) break;
    current -= delta;
    surface = 1.0 - floorSample(uFloorHeight, current).r;
    depth += layerDepth;
  }
  vec2 previous = current + delta;
  float after = surface - depth;
  float before = (1.0 - floorSample(uFloorHeight, previous).r) - depth + layerDepth;
  float weight = after / (after - before + 1e-5);
  return mix(current, previous, clamp(weight, 0.0, 1.0));
}
`

/** Выборки карт пола идут по сдвинутым параллаксом координатам. */
function withParallaxUv(chunk: string) {
  return chunk
    .replace(/v(?:Map|RoughnessMap|MetalnessMap|AoMap|NormalMap)Uv/gu, 'floorUv')
    .replace(/texture2D\(\s*(\w+)\s*,\s*floorUv\s*\)/gu, 'floorSample( $1, floorUv )')
}

export type FloorTextures = { color: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture; height: THREE.Texture }

export function createStyledFloorMaterial(floor: StyleFloor, textures: FloorTextures, { parallax }: { parallax: boolean }) {
  const material = new THREE.MeshStandardMaterial({
    map: textures.color,
    normalMap: textures.normal,
    roughnessMap: textures.orm,
    metalnessMap: textures.orm,
    aoMap: textures.orm,
    aoMapIntensity: .85,
    roughness: 1,
    metalness: 1,
    vertexColors: true,
    // Плитки стиля лежат точно на прежнем полу и должны перекрывать его.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  })
  const scale = parallax ? floor.relief / Math.max(.2, floor.cells) : 0
  if (scale > 0) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFloorHeight = { value: textures.height }
      shader.uniforms.uFloorParallax = { value: scale }
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${PARALLAX_CHUNK}\nvoid main() {`)
        .replace('#include <map_fragment>', `vec2 floorUv = floorParallaxUv(vMapUv);\n${withParallaxUv(THREE.ShaderChunk.map_fragment)}`)
        .replace('#include <roughnessmap_fragment>', withParallaxUv(THREE.ShaderChunk.roughnessmap_fragment))
        .replace('#include <metalnessmap_fragment>', withParallaxUv(THREE.ShaderChunk.metalnessmap_fragment))
        .replace('#include <normal_fragment_maps>', withParallaxUv(THREE.ShaderChunk.normal_fragment_maps))
        .replace('#include <aomap_fragment>', withParallaxUv(THREE.ShaderChunk.aomap_fragment))
    }
    material.customProgramCacheKey = () => 'board3d-floor-parallax-v1'
  }
  return material
}

/** `onLoad` — картинка пришла; по карте высот пол достраивает рельеф. */
export type StyledFloorTextureLoader = (url: string, onLoad?: (texture: THREE.Texture) => void) => THREE.Texture

/** Текстуры через ImageLoader: картинки того же источника, CSP их пропускает. */
export function loadFloorTextures(floor: StyleFloor, load: StyledFloorTextureLoader, onHeight?: (texture: THREE.Texture) => void): FloorTextures {
  const textures = { color: load(floor.color), normal: load(floor.normal), orm: load(floor.orm), height: load(floor.height, onHeight) }
  for (const texture of Object.values(textures)) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = 8
  }
  textures.color.colorSpace = THREE.SRGBColorSpace
  return textures
}

/**
 * Покрытие боковины уступа и края доски: грунт под газоном и землёй, камень
 * под камнем. Боковина берёт материал верхней из двух клеток.
 */
export const SIDE_FLOOR_KEYS: Readonly<Record<string, string>> = {
  grass: 'earth', earth: 'earth', sand: 'sand', stone: 'stone', marble: 'marble', wood: 'wood', metal: 'metal', ice: 'ice',
}

function sideFloorKey(map: TacticalMap, x: number, z: number): string {
  let material = 'stone', best = -Infinity
  for (const cx of [Math.floor(x - 1e-3), Math.floor(x + 1e-3)]) for (const cz of [Math.floor(z - 1e-3), Math.floor(z + 1e-3)]) {
    const cell = cellAt(map, cx, cz)
    if (!cell?.revealed) continue
    const height = terrainHeightAt(map, cx, cz)
    if (height > best) { best = height; material = cell.material }
  }
  return SIDE_FLOOR_KEYS[material] ?? 'stone'
}

/**
 * Боковины уступов и края доски фактурой пакета (ориентир — тайлы TaleSpire:
 * у плитки есть толща грунта или кладки, а не ровная заливка). Геометрия та
 * же, что у прежних боковин (`createTerrainSideGeometry`); UV — в мировых
 * координатах вдоль грани и по высоте, поэтому рисунок идёт без шва через
 * соседние клетки. Цвет вершин темнит низ грани, как прежний градиент.
 */
export function buildStyledTerrainSides(map: TacticalMap, pack: GraphicsStylePack, { loadTexture }: { loadTexture: StyledFloorTextureLoader }) {
  const group = new THREE.Group()
  group.name = 'styled-terrain-sides'
  const source = createTerrainSideGeometry(map)
  const position = source.getAttribute('position') as THREE.BufferAttribute | undefined
  const quads = new Map<string, { positions: number[]; uvs: number[]; colors: number[] }>()
  for (let quad = 0; position && quad + 3 < position.count; quad += 4) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = -Infinity, bottom = Infinity
    for (let index = quad; index < quad + 4; index += 1) {
      minX = Math.min(minX, position.getX(index)); maxX = Math.max(maxX, position.getX(index))
      minZ = Math.min(minZ, position.getZ(index)); maxZ = Math.max(maxZ, position.getZ(index))
      top = Math.max(top, position.getY(index)); bottom = Math.min(bottom, position.getY(index))
    }
    const key = sideFloorKey(map, (minX + maxX) / 2, (minZ + maxZ) / 2)
    const floor = pack.floors[key]
    if (!floor) continue
    const alongX = maxX - minX > maxZ - minZ
    const scale = 1 / Math.max(.5, floor.cells)
    const bucket = quads.get(key) ?? { positions: [], uvs: [], colors: [] }
    for (let index = quad; index < quad + 4; index += 1) {
      const x = position.getX(index), y = position.getY(index), z = position.getZ(index)
      bucket.positions.push(x, y, z)
      bucket.uvs.push((alongX ? x : z) * scale, y * scale)
      // Низ грани в тени уступа: светлый верх, тёмное основание.
      const shade = top - bottom > 1e-6 ? .58 + .42 * (y - bottom) / (top - bottom) : 1
      bucket.colors.push(shade, shade, shade)
    }
    quads.set(key, bucket)
  }
  source.dispose()
  const owned: { dispose(): void }[] = []
  for (const [key, bucket] of [...quads].sort(([a], [b]) => a.localeCompare(b))) {
    const count = bucket.positions.length / 3
    const indices: number[] = []
    for (let vertex = 0; vertex < count; vertex += 4) indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(bucket.colors, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    const floor = pack.floors[key]
    const color = loadTexture(floor.color), normal = loadTexture(floor.normal)
    for (const texture of [color, normal]) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      texture.anisotropy = 8
    }
    color.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.MeshStandardMaterial({ map: color, normalMap: normal, vertexColors: true, roughness: 1, metalness: 0 })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `styled-terrain-sides:${key}`
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    owned.push(geometry, material, color, normal)
  }
  return { group, keys: [...quads.keys()].sort(), dispose() { for (const item of owned) item.dispose() } }
}

/**
 * Сетки пола стиля по покрытиям. Возвращает группу и освобождение ресурсов;
 * клетки без покрытия в пакете остаются на прежнем полу.
 *
 * `relief` — объёмный пол (`board3d-floor-relief`): когда приходит карта
 * высот покрытия, его сетка пересобирается с опущенными швами и впадинами, и
 * вызывается `onRelief`. До того пол плоский, как прежде.
 */
export function buildStyledFloors(map: TacticalMap, pack: GraphicsStylePack, { parallax, loadTexture, relief = null, onRelief }: { parallax: boolean; loadTexture: StyledFloorTextureLoader; relief?: FloorReliefLevel | null; onRelief?: (key: string, geometry: THREE.BufferGeometry) => void }) {
  const group = new THREE.Group()
  group.name = 'styled-floors'
  const keys = new Set<string>()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const key = floorKeyForCell(map, cellAt(map, x, y))
    if (key && pack.floors[key]) keys.add(key)
  }
  const owned = new Set<{ dispose(): void }>()
  let disposed = false
  const level = relief ? BOARD3D_FLOOR_RELIEF[relief] : null
  for (const key of [...keys].sort()) {
    const floor = pack.floors[key]
    const build = (reliefOptions: TileGroundRelief | null = null) => {
      const geometry = createTileGroundGeometry(map, {
        include: (_x, _y, cell) => floorKeyForCell(map, cell) === key,
        uvCells: floor.cells,
        seamless: (cell) => NATURAL_FLOORS.has(floorKeyForCell(map, cell) ?? ''),
        neutralShade: true,
        relief: reliefOptions,
      })
      geometry.setAttribute('uv1', geometry.attributes.uv)
      return geometry
    }
    const geometry = build()
    let mesh: THREE.Mesh | null = null
    const applyRelief = (heightTexture: THREE.Texture) => {
      if (disposed || !mesh || !level) return
      let cells = 0
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (floorKeyForCell(map, cellAt(map, x, y)) === key) cells += 1
      const subdivisions = reliefSubdivisions(cells, level.subdivisions)
      const height = heightSamplerFromTexture(heightTexture, floor.cells * subdivisions)
      if (!height) return
      const next = build({ subdivisions, depth: floor.relief * level.depthScale, height, surfaceKey: (cell) => floorKeyForCell(map, cell) })
      const previous = mesh.geometry
      mesh.geometry = next
      owned.delete(previous)
      previous.dispose()
      owned.add(next)
      onRelief?.(key, next)
    }
    const textures = loadFloorTextures(floor, loadTexture, level ? applyRelief : undefined)
    const material = createStyledFloorMaterial(floor, textures, { parallax })
    mesh = new THREE.Mesh(geometry, material)
    mesh.name = `styled-floor:${key}`
    mesh.receiveShadow = true
    // Объёмный пол бросает тень сам на себя: камни затеняют швы.
    mesh.castShadow = Boolean(level)
    group.add(mesh)
    for (const item of [geometry, material, ...Object.values(textures)]) owned.add(item)
  }
  return { group, keys: [...keys].sort(), dispose() { disposed = true; for (const item of owned) item.dispose(); owned.clear() } }
}
