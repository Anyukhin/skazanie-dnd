import * as THREE from 'three'
import { zoneOfCell } from './board-render'
import { createTileGroundGeometry } from './board3d-landscape'
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

export type StyledFloorTextureLoader = (url: string) => THREE.Texture

/** Текстуры через ImageLoader: картинки того же источника, CSP их пропускает. */
export function loadFloorTextures(floor: StyleFloor, load: StyledFloorTextureLoader): FloorTextures {
  const textures = { color: load(floor.color), normal: load(floor.normal), orm: load(floor.orm), height: load(floor.height) }
  for (const texture of Object.values(textures)) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = 8
  }
  textures.color.colorSpace = THREE.SRGBColorSpace
  return textures
}

/**
 * Сетки пола стиля по покрытиям. Возвращает группу и освобождение ресурсов;
 * клетки без покрытия в пакете остаются на прежнем полу.
 */
export function buildStyledFloors(map: TacticalMap, pack: GraphicsStylePack, { parallax, loadTexture }: { parallax: boolean; loadTexture: StyledFloorTextureLoader }) {
  const group = new THREE.Group()
  group.name = 'styled-floors'
  const keys = new Set<string>()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const key = floorKeyForCell(map, cellAt(map, x, y))
    if (key && pack.floors[key]) keys.add(key)
  }
  const owned: { dispose(): void }[] = []
  for (const key of [...keys].sort()) {
    const floor = pack.floors[key]
    const geometry = createTileGroundGeometry(map, {
      include: (_x, _y, cell) => floorKeyForCell(map, cell) === key,
      uvCells: floor.cells,
      seamless: (cell) => NATURAL_FLOORS.has(floorKeyForCell(map, cell) ?? ''),
      neutralShade: true,
    })
    geometry.setAttribute('uv1', geometry.attributes.uv)
    const textures = loadFloorTextures(floor, loadTexture)
    const material = createStyledFloorMaterial(floor, textures, { parallax })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `styled-floor:${key}`
    mesh.receiveShadow = true
    mesh.castShadow = false
    group.add(mesh)
    owned.push(geometry, material, ...Object.values(textures))
  }
  return { group, keys: [...keys].sort(), dispose() { for (const item of owned) item.dispose() } }
}
