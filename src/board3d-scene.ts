import * as THREE from 'three'

import {
  boardFillColor,
  DEFAULT_BOARD_PALETTE,
  drawCellFeatures,
  drawDecals,
  drawFloorTiles,
  drawFog,
  drawGrid,
  terrainKeysFor,
  visiblePropsOnBoard,
  TILE_CELLS,
  type BoardPalette,
  type BoardScene,
  type BoardTexture,
  type TerrainTiles,
} from './board-render'
import type { TacticalCell, TacticalEdge, TacticalMap } from './types'
import { cellAt, edgeList, edgeNeighbor, revealedAt } from './tactical-map-client'
import { createEnvironmentModels } from './board3d-props'
import { loadPropModelAssets, type PropModelAssets } from './prop-model-assets'
import { LIGHT_SOURCE_ASSETS, lightSourceAssetId } from './board-lighting'
import { batchEnvironmentMeshes } from './board3d-batching'
import { createTerrainSideGeometry, createTerrainSurfaceGeometry, propTerrainHeight, terrainHeightAt } from './board3d-terrain'
import { createBoard3DRoofs, structuralRoofRolesForMap, type Board3DRoofMode } from './board3d-roofs'
import { createMasonryDressing, masonryStyleFor, MASONRY_COLORS, type MasonryRun } from './board3d-masonry'
import { createBridgeRails, createFogCapGeometry, createGrassTufts, createRockClusters, createTileGroundGeometry, createWaterMaterial, createWaterPlants, createWaterSurfaceGeometry, isRockCell, landscapeWantsModels, structuralBridgeRolesForMap, type LandscapeDetail, type LandscapeInstances } from './board3d-landscape'
import { acquireLandscapeKit, type LandscapeKitHandle } from './landscape-model-assets'
import { loadGraphicsStylePack, peekGraphicsStylePack, type GraphicsStylePack } from './board3d-style'
import { buildStyledEdges, doorState, edgeCenter, edgeFloorHeight, edgeSideCell, edgeVisible, packHasWallLooks, structuralEdgeRolesForMap, wallEdgeEndpoints, wallEndpointKey, type StyledEdges } from './board3d-walls'
import { buildStyledFloors } from './board3d-floor-tiles'
import { structuralLoadProps, structuralTemplate, type StructuralRole } from './board3d-structural'

/** Высота срезанной стены в мировых единицах клетки. */
/** Высота стены: выше пояса фигурки, как у наборных диорам, но не закрывает поле при взгляде сверху. */
export const BOARD3D_WALL_HEIGHT = 0.95
/** Граница стены совпадает с границей клеток, как и в 2D-доске. */
export const BOARD3D_WALL_THICKNESS = 1 / 6
/** Небольшая отделка среза стены не меняет её игровую границу. */
const BOARD3D_WALL_CAP_HEIGHT = 0.045
const BOARD3D_WALL_DETAIL_LIMIT = 24
/** Canvas-фактура не должна занимать больше этого размера по стороне. */
export const BOARD3D_MAX_GROUND_CANVAS = 4096
const TERRAIN_MANIFEST_URL = '/assets/maps/terrain/terrain-tiles.json'

export type Board3DOptions = {
  lighting?: boolean
  pointLightShadows?: boolean
  palette?: BoardPalette
  /** Режим видимости только визуального слоя крыш; по умолчанию — cutaway. */
  roofMode?: Board3DRoofMode
  artUrl?: string | null
  artMode?: 'map' | 'backdrop'
  /**
   * Непрозрачность рисунка-подложки. При постобработке смешивание идёт в
   * линейном пространстве, и та же доля заливает пол заметно сильнее.
   */
  artOverlayOpacity?: number
  /** Детализация местности: густота травы и валунов, анимация воды. */
  landscapeDetail?: LandscapeDetail
  /** Сумрак карты 0..1: в подземелье огни ярче, шире и их больше. */
  darkness?: number
  /**
   * Рисованный стиль: пол и модели предметов из пакета стиля. По умолчанию
   * включён; `false` оставляет прежний пол с рисунком и модели выпуска.
   */
  graphicsStyle?: boolean
  /** Рельеф плиток параллаксом; на «Экономном» выключен. */
  floorParallax?: boolean
  onReady?: () => void
}

export type Board3DPropPickTarget = {
  propId: string
  zOrder: number
  object: THREE.Object3D
  bounds: THREE.Box3
}

/** Выбирает ближайший видимый prop по его предбатчевому Box3. */
export function nearestPropPickTarget(ray: THREE.Ray, targets: readonly Board3DPropPickTarget[]) {
  let selected: Board3DPropPickTarget | null = null
  let distance = Number.POSITIVE_INFINITY
  const point = new THREE.Vector3()
  for (const target of targets) {
    let visible = true
    for (let current: THREE.Object3D | null = target.object; current; current = current.parent) {
      if (!current.visible) { visible = false; break }
    }
    if (!visible) continue
    const hit = ray.intersectBox(target.bounds, point)
    if (!hit) continue
    const nextDistance = ray.origin.distanceToSquared(hit)
    if (nextDistance < distance || (nextDistance === distance && target.zOrder > (selected?.zOrder ?? -Infinity))) {
      selected = target
      distance = nextDistance
    }
  }
  return selected
}

type TerrainManifest = {
  cellsPerTile: number
  floors: Record<string, string>
  surfaces: Record<string, string>
  walls: Record<string, string>
}

type TerrainKeys = ReturnType<typeof terrainKeysFor>

let terrainManifestPromise: Promise<TerrainManifest | null> | null = null
const terrainImagePromises = new Map<string, Promise<BoardTexture | null>>()
const terrainImages = new Map<string, BoardTexture>()

type OwnedResources = {
  geometries: Set<THREE.BufferGeometry>
  materials: Set<THREE.Material>
  textures: Set<THREE.Texture>
}

type Instance = {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
}

type EdgePiece = Instance & { color: string }


function ownGeometry(resources: OwnedResources, geometry: THREE.BufferGeometry) {
  resources.geometries.add(geometry)
  return geometry
}

function ownMaterial(resources: OwnedResources, material: THREE.Material) {
  resources.materials.add(material)
  return material
}

function ownTexture(resources: OwnedResources, texture: THREE.Texture) {
  resources.textures.add(texture)
  return texture
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, path]) => typeof path === 'string' && path.length > 0))
}

function parseTerrainManifest(value: unknown): TerrainManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const cellsPerTile = Number(raw.cellsPerTile)
  if (!Number.isSafeInteger(cellsPerTile) || cellsPerTile < 1 || cellsPerTile > 64) return null
  return {
    cellsPerTile,
    floors: recordOfStrings(raw.floors),
    surfaces: recordOfStrings(raw.surfaces),
    walls: recordOfStrings(raw.walls),
  }
}

function terrainAssetsAvailable() {
  return typeof document !== 'undefined' && typeof Image === 'function' && typeof fetch === 'function'
}

function loadTerrainManifest() {
  if (terrainManifestPromise) return terrainManifestPromise
  if (!terrainAssetsAvailable()) return Promise.resolve(null)
  terrainManifestPromise = fetch(TERRAIN_MANIFEST_URL)
    .then((response) => response.ok ? response.json() : null)
    .then(parseTerrainManifest)
    .catch(() => null)
  return terrainManifestPromise
}

function loadTerrainImage(url: string) {
  const cached = terrainImagePromises.get(url)
  if (cached) return cached
  if (!terrainAssetsAvailable()) return Promise.resolve(null)
  const promise = new Promise<BoardTexture | null>((resolve) => {
    let settled = false
    const finish = (texture: BoardTexture | null) => {
      if (settled) return
      settled = true
      if (texture) terrainImages.set(url, texture)
      resolve(texture)
    }
    try {
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => {
        const width = Number(image.naturalWidth || image.width)
        const height = Number(image.naturalHeight || image.height)
        finish(width > 0 && height > 0 ? { image, width, height } : null)
      }
      image.onerror = () => finish(null)
      image.src = url
    } catch {
      finish(null)
    }
  })
  terrainImagePromises.set(url, promise)
  return promise
}

function terrainTilesFromLoaded(manifest: TerrainManifest, keys: TerrainKeys): TerrainTiles | null {
  const result = {
    floors: new Map<string, BoardTexture>(),
    surfaces: new Map<string, BoardTexture>(),
    walls: new Map<string, BoardTexture>(),
  }
  const slots = [
    ['floors', keys.floors, manifest.floors],
    ['surfaces', keys.surfaces, manifest.surfaces],
    ['walls', keys.walls, manifest.walls],
  ] as const
  for (const [slot, wanted, paths] of slots) {
    for (const key of wanted) {
      const path = paths[key]
      const texture = path ? terrainImages.get(`/assets/${path}`) : undefined
      if (texture) result[slot].set(key, texture)
    }
  }
  const loaded = [...result.floors.keys(), ...result.surfaces.keys(), ...result.walls.keys()]
  if (!loaded.length) return null
  return {
    cellsPerTile: manifest.cellsPerTile,
    ...result,
    key: `3d-terrain:${loaded.sort().join(',')}`,
  }
}

function loadTerrainTiles(map: TacticalMap, onReady: (terrain: TerrainTiles) => void, isDisposed: () => boolean) {
  if (!terrainAssetsAvailable()) return
  const keys = terrainKeysFor(map)
  void loadTerrainManifest().then((manifest) => {
    if (!manifest || isDisposed()) return
    const paths = [
      ...keys.floors.map((key) => manifest.floors[key]),
      ...keys.surfaces.map((key) => manifest.surfaces[key]),
      ...keys.walls.map((key) => manifest.walls[key]),
    ].filter((path): path is string => Boolean(path))
    const uniqueUrls = [...new Set(paths.map((path) => `/assets/${path}`))]
    if (!uniqueUrls.length) return
    void Promise.all(uniqueUrls.map(loadTerrainImage)).then(() => {
      if (isDisposed()) return
      const terrain = terrainTilesFromLoaded(manifest, keys)
      if (terrain) onReady(terrain)
    })
  })
}

function material(resources: OwnedResources, color: string, options: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return ownMaterial(resources, new THREE.MeshStandardMaterial({
    color,
    roughness: 0.86,
    metalness: 0.04,
    ...options,
  }))
}

function mesh(
  resources: OwnedResources,
  parent: THREE.Object3D,
  name: string,
  geometry: THREE.BufferGeometry,
  materialValue: THREE.Material,
  position: [number, number, number] = [0, 0, 0],
  castShadow = true,
) {
  const object = new THREE.Mesh(ownGeometry(resources, geometry), materialValue)
  object.name = name
  object.position.set(...position)
  object.castShadow = castShadow
  object.receiveShadow = true
  parent.add(object)
  return object
}

function cellColor(cell: TacticalCell, palette: BoardPalette) {
  // `boardFillColor` остаётся владельцем палитры 2D-доски. `false` намеренно
  // выбирает плоский fallback, чтобы 3D-сцена работала и без canvas.
  return boardFillColor({ kind: 'floor', cell }, palette, false)
}

function wallColor(cell: TacticalCell | null, palette: BoardPalette) {
  return boardFillColor({ kind: 'wall', cell }, palette, false)
}

function addInstancedPieces(
  resources: OwnedResources,
  parent: THREE.Object3D,
  name: string,
  pieces: readonly EdgePiece[],
) {
  if (!pieces.length) return null
  const geometry = ownGeometry(resources, new THREE.BoxGeometry(1, 1, 1))
  const uniqueColors = [...new Set(pieces.map((piece) => piece.color))]
  // Несколько корзин материалов сохраняют стены инстансированными, даже если
  // на соседних рёбрах карты меняется вид кладки.
  const meshes: THREE.InstancedMesh[] = []
  for (const color of uniqueColors) {
    const bucket = pieces.filter((piece) => piece.color === color)
    const instanced = new THREE.InstancedMesh(geometry, material(resources, color), bucket.length)
    instanced.name = `${name}:${color}`
    instanced.castShadow = true
    instanced.receiveShadow = true
    const transform = new THREE.Object3D()
    bucket.forEach((piece, index) => {
      transform.position.set(piece.x, piece.y, piece.z)
      transform.scale.set(piece.sx, piece.sy, piece.sz)
      transform.rotation.set(0, 0, 0)
      transform.updateMatrix()
      instanced.setMatrixAt(index, transform.matrix)
    })
    instanced.instanceMatrix.needsUpdate = true
    parent.add(instanced)
    meshes.push(instanced)
  }
  return meshes
}

function addEdgeScene(resources: OwnedResources, map: TacticalMap, parent: THREE.Group, palette: BoardPalette, detail: LandscapeDetail = 'reduced') {
  // На «Экономном» стена — гладкий блок цвета кладки, без отдельных камней.
  const dressed = detail !== 'minimal'
  const wallPieces: EdgePiece[] = []
  const lowPieces: EdgePiece[] = []
  const framePieces: EdgePiece[] = []
  const wallCapPieces: EdgePiece[] = []
  const wallBeamPieces: EdgePiece[] = []
  const wallCutPieces: EdgePiece[] = []
  const cornerPostPieces: EdgePiece[] = []
  // Кладка поверх тела стены: камни или плахи по материалу клетки.
  const masonryRuns: MasonryRun[] = []
  const doorGroup = new THREE.Group()
  doorGroup.name = 'doors'
  const doorTrimGroup = new THREE.Group()
  doorTrimGroup.name = 'door-trims'

  // Стена вдоль скалы не рисуется: объём породы сам закрывает проход, а
  // тонкая стенка поверх валунов читалась бы забором посреди пещеры.
  const againstRock = (edge: TacticalEdge) => {
    const neighbor = edgeNeighbor(edge)
    return isRockCell(map, edge.x, edge.y) || isRockCell(map, neighbor.x, neighbor.y)
  }
  const visibleWallEdges = edgeList(map).filter((edge) => edge.kind === 'wall' && edgeVisible(map, edge) && !againstRock(edge))
  const endpoints = new Map<string, { x: number; z: number; count: number; directions: Set<TacticalEdge['dir']>; floorY: number }>()
  for (const edge of visibleWallEdges) {
    const floorY = edgeFloorHeight(map, edge)
    for (const endpoint of wallEdgeEndpoints(edge)) {
      const key = wallEndpointKey(endpoint.x, endpoint.z)
      const current = endpoints.get(key) ?? { ...endpoint, count: 0, directions: new Set(), floorY }
      current.count += 1
      current.directions.add(edge.dir)
      current.floorY = Math.max(current.floorY, floorY)
      endpoints.set(key, current)
    }
  }
  for (const endpoint of endpoints.values()) {
    // Прямой ряд стен получает только конечные стойки; повороты и Т-образные
    // стыки получают стойку в вершине. Срезанные рёбра берутся только из
    // уже видимого набора, поэтому туман не порождает геометрию.
    if (endpoint.count !== 1 && endpoint.directions.size < 2) continue
    const height = BOARD3D_WALL_HEIGHT + BOARD3D_WALL_CAP_HEIGHT
    cornerPostPieces.push({ x: endpoint.x, y: endpoint.floorY + height / 2, z: endpoint.z, sx: 0.14, sy: height, sz: 0.14, color: palette.ledge })
  }

  const exposedWallCount = visibleWallEdges.filter((edge) => {
    const neighbor = edgeNeighbor(edge)
    return revealedAt(map, edge.x, edge.y) !== revealedAt(map, neighbor.x, neighbor.y)
  }).length
  const detailStride = Math.max(1, Math.ceil(exposedWallCount / BOARD3D_WALL_DETAIL_LIMIT))
  let exposedWallIndex = 0

  for (const edge of edgeList(map)) {
    if (!edgeVisible(map, edge) || edge.kind === 'none') continue
    if (edge.kind === 'wall' && againstRock(edge)) continue
    const neighbor = edgeNeighbor(edge)
    const side = edgeSideCell(map, edge)
    const center = edgeCenter(edge)
    const floorY = edgeFloorHeight(map, edge)
    const horizontal = edge.dir === 's'
    const color = wallColor(side, palette)
    const piece = (height: number, along = 1, thickness = BOARD3D_WALL_THICKNESS): EdgePiece => ({
      x: center.x,
      y: floorY + height / 2,
      z: center.z,
      sx: horizontal ? along : thickness,
      sy: height,
      sz: horizontal ? thickness : along,
      color,
    })

    if (edge.kind === 'wall') {
      const style = masonryStyleFor(side?.material)
      const body = piece(BOARD3D_WALL_HEIGHT)
      // Тело стены — тёмный шов между камнями; лицо стены дают камни кладки.
      if (dressed) body.color = style === 'wood' ? '#2f2219' : '#2b2722'
      wallPieces.push(body)
      if (dressed) masonryRuns.push({
        x: center.x, z: center.z, y: floorY, length: 1, thickness: BOARD3D_WALL_THICKNESS, height: BOARD3D_WALL_HEIGHT,
        alongX: horizontal, style, color: MASONRY_COLORS[side?.material ?? 'stone'] ?? MASONRY_COLORS.stone,
        seed: edge.x * 31 + edge.y * 17 + (horizontal ? 7 : 3),
      })
      const cap = piece(BOARD3D_WALL_CAP_HEIGHT, 1, BOARD3D_WALL_THICKNESS)
      cap.y = floorY + BOARD3D_WALL_HEIGHT + BOARD3D_WALL_CAP_HEIGHT / 2
      cap.color = palette.ledge
      wallCapPieces.push(cap)

      const isExposed = revealedAt(map, edge.x, edge.y) !== revealedAt(map, neighbor.x, neighbor.y)
      if (isExposed) {
        const detailIndex = exposedWallIndex++
        if (detailIndex % detailStride === 0 && wallBeamPieces.length < BOARD3D_WALL_DETAIL_LIMIT) {
          const beam = piece(0.05, 0.82, 0.055)
          beam.y = floorY + BOARD3D_WALL_HEIGHT - 0.055
          const ownerRevealed = revealedAt(map, edge.x, edge.y)
          const towardVisible = ownerRevealed ? -1 : 1
          if (horizontal) beam.z += towardVisible * (BOARD3D_WALL_THICKNESS / 2 + 0.028)
          else beam.x += towardVisible * (BOARD3D_WALL_THICKNESS / 2 + 0.028)
          beam.color = palette.wall
          wallBeamPieces.push(beam)

          // Короткий лицевой срез подчёркивает открытый край, не выходя за
          // плоскость уже существующей стены и не занимая соседнюю клетку.
          const cut = piece(0.22, 0.72, 0.025)
          if (horizontal) cut.z += towardVisible * (BOARD3D_WALL_THICKNESS / 2 + 0.014)
          else cut.x += towardVisible * (BOARD3D_WALL_THICKNESS / 2 + 0.014)
          cut.y = floorY + BOARD3D_WALL_HEIGHT - 0.13
          cut.color = palette.ledge
          wallCutPieces.push(cut)
        }
      }
      continue
    }

    if (edge.kind === 'rail' || edge.kind === 'ledge') {
      lowPieces.push({ ...piece(edge.kind === 'rail' ? 0.32 : 0.18, 1, edge.kind === 'rail' ? 0.075 : 0.12), color: edge.kind === 'rail' ? palette.rail : palette.ledge })
      continue
    }

    if (edge.kind === 'window' || edge.kind === 'loophole' || edge.kind === 'grate') {
      // В проёме оставляем середину свободной. Два коротких столба обозначают
      // границу, но не превращают окно в случайную глухую стену.
      const postLength = 0.21
      for (const offset of [0.11, 0.89]) {
        const post = piece(BOARD3D_WALL_HEIGHT, postLength)
        if (horizontal) post.x += (offset - 0.5)
        else post.z += (offset - 0.5)
        post.color = color
        framePieces.push(post)
      }
      if (edge.kind === 'grate') {
        const bar = piece(0.52, 0.07, 0.045)
        bar.color = palette.rail
        framePieces.push(bar)
      }
      continue
    }

    if (edge.kind !== 'door') continue
    const state = doorState(map, edge)
    const frameMaterial = material(resources, palette.doorFrame)
    const leafMaterial = material(resources, boardFillColor({ kind: 'door', state }, palette, false))
    const frameWidth = 0.09
    const leafHeight = BOARD3D_WALL_HEIGHT - 0.13
    const baseX = center.x
    const baseZ = center.z

    const postA = horizontal
      ? new THREE.BoxGeometry(frameWidth, BOARD3D_WALL_HEIGHT, frameWidth)
      : new THREE.BoxGeometry(frameWidth, BOARD3D_WALL_HEIGHT, frameWidth)
    const postB = postA.clone()
    // Оба столба имеют квадратное сечение, различается только положение вдоль
    // ребра.
    const first = edge.dir === 'e' ? [baseX, floorY + BOARD3D_WALL_HEIGHT / 2, edge.y + 0.22] as [number, number, number]
      : [edge.x + 0.22, floorY + BOARD3D_WALL_HEIGHT / 2, baseZ] as [number, number, number]
    const second = edge.dir === 'e' ? [baseX, floorY + BOARD3D_WALL_HEIGHT / 2, edge.y + 0.78] as [number, number, number]
      : [edge.x + 0.78, floorY + BOARD3D_WALL_HEIGHT / 2, baseZ] as [number, number, number]
    mesh(resources, doorGroup, `door-frame:${edge.x},${edge.y},${edge.dir}`, postA, frameMaterial, first)
    mesh(resources, doorGroup, `door-frame:${edge.x},${edge.y},${edge.dir}`, postB, frameMaterial, second)
    const lintel = horizontal
      ? new THREE.BoxGeometry(0.64, 0.09, 0.12)
      : new THREE.BoxGeometry(0.12, 0.09, 0.64)
    mesh(resources, doorGroup, `door-lintel:${edge.x},${edge.y},${edge.dir}`, lintel, frameMaterial, [baseX, floorY + BOARD3D_WALL_HEIGHT - 0.045, baseZ])

    // Отделка лежит на видимой стороне уже существующей рамы. Она тоньше
    // рамы и не сдвигает границу проёма, которой пользуется сервер.
    const trimMaterial = material(resources, palette.ledge)
    const trimHeight = BOARD3D_WALL_HEIGHT - 0.08
    const trimOffset = BOARD3D_WALL_THICKNESS / 2 + 0.018
    const towardVisible = revealedAt(map, edge.x, edge.y) ? -1 : 1
    const trim = new THREE.BoxGeometry(0.035, trimHeight, 0.035)
    const trimY = floorY + trimHeight / 2 + 0.02
    const trimPositions: Array<[number, number, number]> = horizontal
      ? [[baseX + towardVisible * trimOffset, trimY, edge.y + 0.22], [baseX + towardVisible * trimOffset, trimY, edge.y + 0.78]]
      : [[edge.x + 0.22, trimY, baseZ + towardVisible * trimOffset], [edge.x + 0.78, trimY, baseZ + towardVisible * trimOffset]]
    for (const position of trimPositions) mesh(resources, doorTrimGroup, `door-trim:${edge.x},${edge.y},${edge.dir}`, trim, trimMaterial, position)
    const trimLintel = horizontal
      ? new THREE.BoxGeometry(0.64, 0.035, 0.035)
      : new THREE.BoxGeometry(0.035, 0.035, 0.64)
    mesh(resources, doorTrimGroup, `door-trim:${edge.x},${edge.y},${edge.dir}`, trimLintel, trimMaterial, [baseX, floorY + BOARD3D_WALL_HEIGHT - 0.08, baseZ])

    if (state === 'open') {
      // Петля стоит на краю проёма: створка уходит в соседнюю клетку и оставляет
      // середину прохода свободной.
      const openLeaf = edge.dir === 'e' ? new THREE.BoxGeometry(0.52, leafHeight, 0.09) : new THREE.BoxGeometry(0.09, leafHeight, 0.52)
      const position: [number, number, number] = edge.dir === 'e'
        ? [baseX + 0.26, floorY + leafHeight / 2, edge.y + 0.22]
        : [edge.x + 0.22, floorY + leafHeight / 2, baseZ + 0.26]
      mesh(resources, doorGroup, `door-leaf:${edge.x},${edge.y},${edge.dir}:open`, openLeaf, leafMaterial, position)
    } else if (state === 'broken') {
      const debris = horizontal ? new THREE.BoxGeometry(0.17, 0.16, 0.13) : new THREE.BoxGeometry(0.13, 0.16, 0.17)
      const debrisPositions: Array<[number, number, number]> = horizontal
        ? [[baseX - 0.18, floorY + 0.08, baseZ], [baseX + 0.18, floorY + 0.08, baseZ]]
        : [[baseX, floorY + 0.08, baseZ - 0.18], [baseX, floorY + 0.08, baseZ + 0.18]]
      debrisPositions.forEach((position, index) => mesh(resources, doorGroup, `door-debris:${edge.x},${edge.y},${edge.dir}`, index === 0 ? debris : debris.clone(), leafMaterial, position))
    } else {
      const closedLeaf = horizontal ? new THREE.BoxGeometry(0.58, leafHeight, 0.1) : new THREE.BoxGeometry(0.1, leafHeight, 0.58)
      mesh(resources, doorGroup, `door-leaf:${edge.x},${edge.y},${edge.dir}:${state}`, closedLeaf, leafMaterial, [baseX, floorY + leafHeight / 2, baseZ])
      if (state === 'locked') {
        const lock = ownGeometry(resources, new THREE.SphereGeometry(0.065, 8, 6))
        mesh(resources, doorGroup, `door-lock:${edge.x},${edge.y},${edge.dir}`, lock, material(resources, palette.lock, { metalness: 0.55, roughness: 0.38 }), [baseX + (horizontal ? 0 : 0.06), floorY + 0.3, baseZ + (horizontal ? 0.06 : 0)], false)
      }
    }
  }

  const walls = new THREE.Group()
  walls.name = 'cutaway-walls'
  addInstancedPieces(resources, walls, 'wall-segments', wallPieces)
  addInstancedPieces(resources, walls, 'edge-segments', lowPieces)
  addInstancedPieces(resources, walls, 'opening-frames', framePieces)

  if (masonryRuns.length) {
    const masonry = createMasonryDressing(masonryRuns, 'wall-masonry')
    for (const child of masonry.group.children) {
      const instanced = child as THREE.InstancedMesh
      resources.geometries.add(instanced.geometry)
      resources.materials.add(instanced.material as THREE.Material)
    }
    walls.add(masonry.group)
  }

  const wallCaps = new THREE.Group()
  wallCaps.name = 'wall-caps'
  addInstancedPieces(resources, wallCaps, 'wall-cap', wallCapPieces)
  if (wallCaps.children.length) walls.add(wallCaps)
  const cornerPosts = new THREE.Group()
  cornerPosts.name = 'corner-posts'
  addInstancedPieces(resources, cornerPosts, 'corner-post', cornerPostPieces)
  if (cornerPosts.children.length) walls.add(cornerPosts)
  const wallBeams = new THREE.Group()
  wallBeams.name = 'wall-beams'
  addInstancedPieces(resources, wallBeams, 'wall-beam', wallBeamPieces)
  if (wallBeams.children.length) walls.add(wallBeams)
  const wallCuts = new THREE.Group()
  wallCuts.name = 'wall-cuts'
  addInstancedPieces(resources, wallCuts, 'wall-cut', wallCutPieces)
  if (wallCuts.children.length) walls.add(wallCuts)
  if (walls.children.length) parent.add(walls)
  if (doorTrimGroup.children.length) doorGroup.add(doorTrimGroup)
  if (doorGroup.children.length) parent.add(doorGroup)
}

/**
 * Пол плитками: у каждой клетки фаска и шов, у воды — опущенное дно. Цвет
 * вершин несёт затенение шва и дна; без canvas-фактуры (SSR, тесты) он
 * дополнительно окрашивается цветом клетки, как прежний плоский пол.
 */
function createGroundGeometry(resources: OwnedResources, map: TacticalMap, palette: BoardPalette, withCellColors: boolean) {
  const geometry = ownGeometry(resources, createTileGroundGeometry(map))
  if (withCellColors) {
    const position = geometry.getAttribute('position') as THREE.BufferAttribute
    const color = geometry.getAttribute('color') as THREE.BufferAttribute
    const tint = new THREE.Color()
    for (let index = 0; index < position.count; index += 1) {
      const cell = cellAt(map, Math.min(map.width - 1, Math.floor(position.getX(index) - 1e-4)), Math.min(map.height - 1, Math.floor(position.getZ(index) - 1e-4)))
      if (!cell) continue
      tint.set(cellColor(cell, palette))
      color.setXYZ(index, color.getX(index) * tint.r, color.getY(index) * tint.g, color.getZ(index) * tint.b)
    }
  }
  return geometry
}

/**
 * Цвет склона по материалу верхней клетки: под травой и землёй — слоистый
 * грунт, под камнем — порода, под песком — песчаник. Низ склона темнее верха.
 */
const SIDE_COLORS: Record<string, [string, string]> = {
  grass: ['#6b4a2e', '#3c2a1b'], earth: ['#6b4a2e', '#3c2a1b'], sand: ['#a8875c', '#6e5537'],
  stone: ['#7a746a', '#45413b'], marble: ['#a39d92', '#5e5a53'], wood: ['#6d5238', '#3a2b1e'],
  metal: ['#6f747a', '#3d4044'], ice: ['#9fb9c4', '#5d7480'],
}

function terrainSideColor(map: TacticalMap, x: number, z: number, y: number, top: boolean, out: THREE.Color) {
  // Вершина склона лежит на ребре клетки: верхняя клетка — та из двух, что выше.
  const candidates = [[Math.floor(x - 1e-3), Math.floor(z - 1e-3)], [Math.floor(x - 1e-3), Math.floor(z + 1e-3)], [Math.floor(x + 1e-3), Math.floor(z - 1e-3)], [Math.floor(x + 1e-3), Math.floor(z + 1e-3)]]
  let material = 'stone', best = -Infinity
  for (const [cx, cz] of candidates) {
    const cell = cellAt(map, cx, cz)
    if (!cell?.revealed) continue
    const height = terrainHeightAt(map, cx, cz)
    if (height > best) { best = height; material = cell.material }
  }
  const [light, dark] = SIDE_COLORS[material] ?? SIDE_COLORS.stone
  // Тонкие полосы слоёв: высота в мире даёт рисунок, общий для соседних граней.
  const band = .9 + .1 * Math.sin(y * 9.7)
  return out.set(top ? light : dark).multiplyScalar(band)
}

function addTerrainSides(resources: OwnedResources, map: TacticalMap, parent: THREE.Group, palette: BoardPalette) {
  const geometry = createTerrainSideGeometry(map)
  if (!geometry.getAttribute('position')?.count) {
    geometry.dispose()
    return
  }
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  const colors = new Float32Array(position.count * 3)
  const color = new THREE.Color()
  for (let quad = 0; quad < position.count; quad += 4) {
    let top = -Infinity
    for (let index = quad; index < quad + 4; index += 1) top = Math.max(top, position.getY(index))
    for (let index = quad; index < quad + 4; index += 1) {
      terrainSideColor(map, position.getX(index), position.getZ(index), position.getY(index), position.getY(index) >= top - 1e-6, color)
      colors.set([color.r, color.g, color.b], index * 3)
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const sideMaterial = material(resources, '#ffffff', { vertexColors: true, roughness: .95, metalness: 0 })
  void palette
  const sides = new THREE.Mesh(ownGeometry(resources, geometry), sideMaterial)
  sides.name = 'terrain-sides'
  sides.castShadow = true
  sides.receiveShadow = true
  parent.add(sides)
}

function createGroundCanvasTexture(resources: OwnedResources, map: TacticalMap, palette: BoardPalette) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  try {
    const pixelsPerCell = Math.max(1, Math.min(64, Math.floor(BOARD3D_MAX_GROUND_CANVAS / Math.max(1, map.width, map.height))))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.min(BOARD3D_MAX_GROUND_CANVAS, map.width * pixelsPerCell))
    canvas.height = Math.max(1, Math.min(BOARD3D_MAX_GROUND_CANVAS, map.height * pixelsPerCell))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.clearRect(0, 0, canvas.width, canvas.height)
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (!revealedAt(map, x, y)) continue
        const cell = cellAt(map, x, y)
        if (!cell) continue
        context.fillStyle = cellColor(cell, palette)
        context.fillRect(x * pixelsPerCell, y * pixelsPerCell, pixelsPerCell + 1, pixelsPerCell + 1)
      }
    }
    const texture = ownTexture(resources, new THREE.CanvasTexture(canvas))
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    return texture
  } catch {
    // В тестовом окружении document иногда есть, а 2D-контекста нет. Цвета
    // вершин остаются полноценным запасным путём.
    return null
  }
}

/** Сила рельефа пола из раскраски плиток; 0 — плоский пол. */
export const BOARD3D_GROUND_RELIEF = 2.2

function paintTerrainCanvas(resources: OwnedResources, map: TacticalMap, palette: BoardPalette, terrain: TerrainTiles | null, overlayOnly = false) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  try {
    const pixelsPerCell = Math.max(1, Math.min(64, Math.floor(BOARD3D_MAX_GROUND_CANVAS / Math.max(1, map.width, map.height))))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.min(BOARD3D_MAX_GROUND_CANVAS, map.width * pixelsPerCell))
    canvas.height = Math.max(1, Math.min(BOARD3D_MAX_GROUND_CANVAS, map.height * pixelsPerCell))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.clearRect(0, 0, canvas.width, canvas.height)
    const scene: BoardScene = { map, palette, cellSize: pixelsPerCell, terrain, artMode: 'backdrop', showElevationRelief: false }
    // Над плитками стиля холст несёт только то, что важно для игры: опасные
    // клетки, сетку и туман. Покрытие и пятна рисует сам пол стиля.
    const tilesX = Math.max(1, Math.ceil(map.width / TILE_CELLS))
    const tilesY = Math.max(1, Math.ceil(map.height / TILE_CELLS))
    for (let tileY = 0; tileY < tilesY; tileY += 1) {
      for (let tileX = 0; tileX < tilesX; tileX += 1) {
        context.save()
        context.translate(tileX * TILE_CELLS * pixelsPerCell, tileY * TILE_CELLS * pixelsPerCell)
        const tile = { tileX, tileY }
        if (!overlayOnly) {
          drawFloorTiles(context, scene, tile)
          drawDecals(context, scene, tile)
        }
        drawCellFeatures(context, scene, tile)
        drawGrid(context, scene, tile)
        drawFog(context, scene, tile)
        context.restore()
      }
    }
    const texture = ownTexture(resources, new THREE.CanvasTexture(canvas))
    texture.colorSpace = THREE.SRGBColorSpace
    // Камера смотрит на пол под острым углом: без мипмапов и анизотропии
    // фактура плит и сетка рябят при отдалении. Three ограничит значение
    // возможностями видеокарты.
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.generateMipmaps = true
    texture.anisotropy = 8
    texture.needsUpdate = true
    return texture
  } catch {
    return null
  }
}

function addProps(map: TacticalMap, parent: THREE.Group, lighting: boolean, pointLightShadows: boolean, palette: BoardPalette, assets?: PropModelAssets | null, darkness = 0) {
  const library = createEnvironmentModels(palette, assets)
  const propsGroup = new THREE.Group()
  propsGroup.name = 'props'
  const lightGroup = new THREE.Group()
  lightGroup.name = 'local-lights'
  const lights: THREE.PointLight[] = []
  const visibleProps = visiblePropsOnBoard(map)
  const models = new Map(visibleProps.map((prop) => [prop.id, library.create(prop)]))
  const propsById = new Map(visibleProps.map((prop) => [prop.id, prop]))
  for (const prop of visibleProps) {
    const model = models.get(prop.id)!
    // Высота предмета следует за раскрытым футпринтом; батчер ниже увидит уже
    // установленную мировую матрицу, поэтому возвышенные предметы не упадут на Y=0.
    model.position.y = propTerrainHeight(map, prop)
    if (prop.mount?.kind === 'surface') {
      const support = models.get(prop.mount.propId), supportProp = propsById.get(prop.mount.propId)
      if (support && supportProp && !['toppled', 'burned', 'broken'].includes(supportProp.state)) {
        model.position.y = propTerrainHeight(map, supportProp) + Number(support.userData.surfaceHeight ?? 0) * support.scale.y
      } else {
        // Упавшая утварь остаётся оформлением: никакого второго предмета добычи.
        model.rotation.z = .8
      }
    }
    propsGroup.add(model)
    const sourceId = lightSourceAssetId(prop.assetId)
    // Источник света не отбрасывает тень сам: иначе чаша жаровни кладёт под
    // себя тёмный диск от собственного огня.
    if (sourceId) model.traverse((object) => { if ((object as THREE.Mesh).isMesh) object.castShadow = false })
    // В сумраке огней больше и они сильнее: они — главный свет подземелья.
    if (!lighting || !sourceId || lights.length >= 4 + Math.round(4 * darkness)) continue
    const profile = LIGHT_SOURCE_ASSETS[sourceId]
    const light = new THREE.PointLight(palette.lightWarm, 1.35 + 16 * darkness, Math.min(8, profile.radius) * (1 + .7 * darkness), 2)
    light.name = 'fire-light'
    light.position.copy(model.position)
    // Огонь чуть выше чаши: иначе сама чаша отбрасывает на пол ломаное кольцо тени.
    light.position.y += (Number(model.userData.lightHeight) || .55) * model.scale.y + .22
    light.castShadow = pointLightShadows && lights.length < 4
    // Край светового пятна мягкий: грубая кубическая карта давала ломаные тени.
    light.shadow.mapSize.set(512, 512)
    light.shadow.radius = 4
    light.shadow.camera.near = .1
    light.shadow.camera.far = Math.min(8, profile.radius)
    // Карта 256 на кубе даёт крупный тексель: без смещения стены и пол
    // покрываются полосами самозатенения («акне»).
    light.shadow.bias = -.002
    light.shadow.normalBias = .03
    lightGroup.add(light)
    lights.push(light)
  }
  propsGroup.updateMatrixWorld(true)
  const pickTargets: Board3DPropPickTarget[] = visibleProps.flatMap((prop) => {
    if (!prop.interactive) return []
    const object = models.get(prop.id)
    if (!object) return []
    object.userData.propId = prop.id
    object.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(object)
    return bounds.isEmpty() ? [] : [{ propId: prop.id, zOrder: prop.zOrder, object, bounds }]
  })
  const batches = batchEnvironmentMeshes(propsGroup)
  propsGroup.userData.originalDrawCalls = batches.originalDrawCalls
  propsGroup.userData.batchedDrawCalls = batches.batchedDrawCalls
  if (propsGroup.children.length) parent.add(propsGroup)
  if (lightGroup.children.length) parent.add(lightGroup)
  return {
    group: propsGroup,
    pickTargets,
    dispose() {
      pickTargets.length = 0
      propsGroup.removeFromParent()
      lightGroup.removeFromParent()
      batches.dispose()
      library.dispose()
      for (const light of lights) {
        light.shadow.dispose()
      }
    },
  }
}

function resizeTextureIfNeeded(resources: OwnedResources, texture: THREE.Texture) {
  const image = texture.image as { width?: number; height?: number } | undefined
  const width = Number(image?.width)
  const height = Number(image?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || Math.max(width, height) <= BOARD3D_MAX_GROUND_CANVAS) return texture
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return texture
  try {
    const scale = BOARD3D_MAX_GROUND_CANVAS / Math.max(width, height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(width * scale))
    canvas.height = Math.max(1, Math.floor(height * scale))
    const context = canvas.getContext('2d')
    if (!context) return texture
    context.drawImage(image as CanvasImageSource, 0, 0, canvas.width, canvas.height)
    const resized = ownTexture(resources, new THREE.CanvasTexture(canvas))
    resized.colorSpace = THREE.SRGBColorSpace
    resized.needsUpdate = true
    resources.textures.delete(texture)
    texture.dispose()
    return resized
  } catch {
    return texture
  }
}

function loadArtTexture(
  resources: OwnedResources,
  url: string,
  onTexture: (texture: THREE.Texture) => void,
  onSettled: () => void,
  isDisposed: () => boolean,
) {
  // TextureLoader нужен document.createElementNS. В SSR и тестах нет запроса,
  // который можно отменить, поэтому плоский грунт готов сразу.
  if (typeof document === 'undefined' || typeof document.createElementNS !== 'function') {
    onSettled()
    return
  }
  let pending: THREE.Texture | null = null
  let failedBeforeTrack = false
  try {
    const loader = new THREE.TextureLoader()
    const loadedTexture = loader.load(url, (loaded) => {
      // Браузерный mock может завершить загрузку синхронно из `image.src = url`.
      // Сначала регистрируем возвращённую текстуру, и только потом вызываем
      // код, который может передать управление пользователю.
      if (!resources.textures.has(loaded)) ownTexture(resources, loaded)
      if (!pending) pending = loaded
      if (isDisposed()) {
        resources.textures.delete(loaded)
        loaded.dispose()
        return
      }
      const bounded = resizeTextureIfNeeded(resources, loaded)
      bounded.colorSpace = THREE.SRGBColorSpace
      bounded.needsUpdate = true
      onTexture(bounded)
      onSettled()
    }, undefined, () => {
      // `pending` — placeholder, возвращённый TextureLoader. Сцена владеет им
      // даже при ошибке сетевого запроса.
      if (pending) {
        resources.textures.delete(pending)
        pending.dispose()
      } else {
        failedBeforeTrack = true
      }
      if (!isDisposed()) onSettled()
    })
    pending = ownTexture(resources, loadedTexture)
    if (failedBeforeTrack) {
      resources.textures.delete(pending)
      pending.dispose()
    }
  } catch {
    if (pending) {
      resources.textures.delete(pending)
      pending.dispose()
    }
    if (!isDisposed()) onSettled()
  }
}

/**
 * Строит плоскую 3D-проекцию тактической карты.
 *
 * Серверные клетки, рёбра и раскрытие остаются единственным источником
 * геометрии. Это отдельный слой представления: актёры и боевые эффекты может
 * добавить родительский рендерер в тот же `group`.
 */
export function createBoard3DScene(map: TacticalMap, options: Board3DOptions = {}) {
  const resources: OwnedResources = { geometries: new Set(), materials: new Set(), textures: new Set() }
  const group = new THREE.Group()
  group.name = 'board-3d-scene'
  let disposed = false
  let readyCalled = false
  const palette = options.palette ?? DEFAULT_BOARD_PALETTE
  const artMode = options.artMode ?? 'backdrop'
  const artUrl = typeof options.artUrl === 'string' ? options.artUrl.trim() : ''

  const callReady = () => {
    if (readyCalled || disposed) return
    readyCalled = true
    options.onReady?.()
  }

  const groundGroup = new THREE.Group()
  groundGroup.name = 'ground'
  group.add(groundGroup)
  const groundTexture = createGroundCanvasTexture(resources, map, palette)
  const groundGeometry = createGroundGeometry(resources, map, palette, !groundTexture)
  const groundMaterial = material(resources, '#ffffff', { vertexColors: true, roughness: 0.94, metalness: 0 }) as THREE.MeshStandardMaterial
  if (groundTexture) {
    groundMaterial.map = groundTexture
    groundMaterial.needsUpdate = true
  }
  const ground = new THREE.Mesh(groundGeometry, groundMaterial)
  ground.name = 'ground-plane'
  ground.receiveShadow = true
  ground.castShadow = false
  groundGroup.add(ground)
  addTerrainSides(resources, map, groundGroup, palette)
  const fogGeometry = createFogCapGeometry(map)
  if (fogGeometry) {
    ownGeometry(resources, fogGeometry)
    const fog = new THREE.Mesh(fogGeometry, material(resources, '#27221c', { roughness: 1, metalness: 0 }))
    fog.name = 'fog-cap'
    fog.receiveShadow = false
    groundGroup.add(fog)
  }

  // Местность: вода над дном, скалы на непроходимых клетках, трава.
  const landscapeDetail = options.landscapeDetail ?? 'reduced'
  const waterGeometry = createWaterSurfaceGeometry(map)
  const waterMaterial = waterGeometry ? createWaterMaterial() : null
  if (waterGeometry && waterMaterial) {
    ownGeometry(resources, waterGeometry)
    resources.materials.add(waterMaterial)
    const water = new THREE.Mesh(waterGeometry, waterMaterial)
    water.name = 'water-surface'
    water.receiveShadow = true
    water.renderOrder = 2
    groundGroup.add(water)
  }
  // Скалы, мосты и растения у воды: сначала процедурные; по загрузке набора
  // моделей пересобираются только эти слои, как предметы по загрузке GLB.
  // Стены, двери и клетки-кладка в рисованном стиле, если пакет уже загружен:
  // пересобранная доска (каждое открытие двери) сразу рисует их фактурами.
  const initialPack = options.graphicsStyle !== false ? peekGraphicsStylePack() : null
  let styledEdges: StyledEdges | null = null
  let structuralAssets: PropModelAssets | null = null
  let rocks = createRockClusters(map, landscapeDetail, BOARD3D_WALL_HEIGHT, null, { skipMasonry: packHasWallLooks(initialPack) })
  if (rocks.group.children.length) group.add(rocks.group)
  const grass = createGrassTufts(map, visiblePropsOnBoard(map), landscapeDetail)
  if (grass) group.add(grass.group)
  let bridges = createBridgeRails(map, null, structuralAssets)
  if (bridges) group.add(bridges.group)
  let waterPlants: LandscapeInstances | null = null
  let landscapeKit: LandscapeKitHandle | null = null
  const landscapeAbort = new AbortController()
  if (typeof window !== 'undefined' && landscapeWantsModels(map)) {
    void acquireLandscapeKit(landscapeAbort.signal).then((kit) => {
      if (!kit) return
      if (disposed) { kit.release(); return }
      landscapeKit = kit
      const nextRocks = createRockClusters(map, landscapeDetail, BOARD3D_WALL_HEIGHT, kit, { skipMasonry: Boolean(styledEdges) })
      rocks.dispose()
      rocks = nextRocks
      if (rocks.group.children.length) group.add(rocks.group)
      const nextBridges = createBridgeRails(map, kit, structuralAssets)
      bridges?.dispose()
      bridges = nextBridges
      if (bridges) group.add(bridges.group)
      waterPlants = createWaterPlants(map, landscapeDetail, kit)
      if (waterPlants) group.add(waterPlants.group)
      options.onReady?.()
    }).catch(() => {})
  }

  const roofTextureReady = () => { if (!disposed) options.onReady?.() }
  let roofs = createBoard3DRoofs(map, palette, { wallHeight: BOARD3D_WALL_HEIGHT, mode: options.roofMode, stylePack: initialPack, structuralAssets, onTexture: roofTextureReady })
  group.add(roofs.group)
  const edgeLayer = new THREE.Group()
  edgeLayer.name = 'edge-layer'
  const styledEdgeOptions = { wallHeight: BOARD3D_WALL_HEIGHT, thickness: BOARD3D_WALL_THICKNESS, structuralAssets: structuralAssets as PropModelAssets | null, onTexture: () => { if (!disposed) options.onReady?.() } }
  if (packHasWallLooks(initialPack)) {
    styledEdges = buildStyledEdges(map, initialPack, styledEdgeOptions)
    group.add(styledEdges.group)
  } else {
    addEdgeScene(resources, map, edgeLayer, palette, options.landscapeDetail ?? 'reduced')
    group.add(edgeLayer)
  }
  const darkness = Math.max(0, Math.min(1, options.darkness ?? 0))
  let props = addProps(map, group, options.lighting !== false, options.pointLightShadows !== false, palette, null, darkness)
  let propAssets: PropModelAssets | null = null
  const propAbort = new AbortController()
  // Пакет стиля нужен и полу, и предметам: один запрос на оба.
  const stylePack: Promise<GraphicsStylePack | null> = options.graphicsStyle !== false && typeof window !== 'undefined'
    ? loadGraphicsStylePack()
    : Promise.resolve(null)
  const bridgeRoles = structuralBridgeRolesForMap(map)
  const edgeRoles = structuralEdgeRolesForMap(map)
  const roofRoles = structuralRoofRolesForMap(map)
  const structuralRoles = [...new Set<StructuralRole>([...bridgeRoles, ...edgeRoles, ...roofRoles])]
  let resolvedStylePack = initialPack
  if (typeof window !== 'undefined') {
    const visibleProps = visiblePropsOnBoard(map)
    void stylePack.then(async (pack) => {
      resolvedStylePack = pack
      if (disposed) return null
      return loadPropModelAssets([...visibleProps, ...structuralLoadProps(pack, structuralRoles)], propAbort.signal, map.catalogRevision, pack)
    }).then((assets) => {
      if (!assets) return
      if (disposed) { assets.dispose(); return }
      const replacement = addProps(map, group, options.lighting !== false, options.pointLightShadows !== false, palette, assets, darkness)
      props.dispose()
      props = replacement
      propAssets = assets
      structuralAssets = assets
      styledEdgeOptions.structuralAssets = assets
      // Слой пересобирается, только если для него пришла хоть одна модель:
      // доска пересобирается на каждой двери, и пустая пересборка стен и
      // крыш удваивала бы эту работу.
      const loaded = (roles: readonly StructuralRole[]) => roles.some((role) => structuralTemplate(assets, role))
      if (loaded(bridgeRoles)) {
        const nextBridges = createBridgeRails(map, landscapeKit, structuralAssets)
        bridges?.dispose()
        bridges = nextBridges
        if (bridges) group.add(bridges.group)
      }
      if (styledEdges && packHasWallLooks(resolvedStylePack) && loaded(edgeRoles)) {
        const nextEdges = buildStyledEdges(map, resolvedStylePack, styledEdgeOptions)
        styledEdges.dispose()
        styledEdges = nextEdges
        group.add(styledEdges.group)
      }
      if (styledEdges && packHasWallLooks(resolvedStylePack) && loaded(roofRoles)) {
        const nextRoofs = createBoard3DRoofs(map, palette, {
          wallHeight: BOARD3D_WALL_HEIGHT, mode: roofs.getMode(), stylePack: resolvedStylePack,
          structuralAssets, onTexture: roofTextureReady,
        })
        roofs.dispose()
        roofs = nextRoofs
        group.add(roofs.group)
      }
      options.onReady?.()
    }).catch(() => {})
  }

  let authoritativeArtLoaded = false
  const artOverlayMaterial = artMode === 'backdrop'
    ? material(resources, '#ffffff', { transparent: true, opacity: options.artOverlayOpacity ?? 0.34, depthWrite: false }) as THREE.MeshStandardMaterial
    : null
  if (artUrl) {
    loadArtTexture(resources, artUrl, (texture) => {
      if (disposed) {
        texture.dispose()
        resources.textures.delete(texture)
        return
      }
      if (artOverlayMaterial) {
        artOverlayMaterial.map = texture
        artOverlayMaterial.needsUpdate = true
        const overlay = new THREE.Mesh(groundGeometry, artOverlayMaterial)
        overlay.name = 'ground-art-backdrop'
        overlay.position.y = 0.002
        overlay.receiveShadow = false
        overlay.castShadow = false
        groundGroup.add(overlay)
      } else {
        authoritativeArtLoaded = true
        // Готовая карта с архитектурой главнее пола стиля.
        removeStyledFloors()
        if (groundMaterial.map && groundMaterial.map !== texture) {
          resources.textures.delete(groundMaterial.map)
          groundMaterial.map.dispose()
        }
        groundMaterial.map = texture
        groundMaterial.bumpMap = null
        groundMaterial.needsUpdate = true
      }
    }, callReady, () => disposed)
  } else {
    callReady()
  }

  // Пол стиля: плитки по покрытиям поверх прежнего пола и прозрачный слой
  // с сеткой, опасными клетками и туманом над ними.
  let styledFloors: ReturnType<typeof buildStyledFloors> | null = null
  let loadedTerrain: TerrainTiles | null = null
  let groundOverlay: THREE.Mesh | null = null
  const paintGroundOverlay = () => {
    if (!styledFloors || disposed) return
    const texture = paintTerrainCanvas(resources, map, palette, loadedTerrain, true)
    if (!texture) return
    if (!groundOverlay) {
      const overlayMaterial = material(resources, '#ffffff', { transparent: true, depthWrite: false, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }) as THREE.MeshStandardMaterial
      groundOverlay = new THREE.Mesh(groundGeometry, overlayMaterial)
      groundOverlay.name = 'ground-overlay'
      groundOverlay.renderOrder = 1
      groundOverlay.receiveShadow = true
      groundOverlay.castShadow = false
      groundGroup.add(groundOverlay)
    }
    const overlayMaterial = groundOverlay.material as THREE.MeshStandardMaterial
    if (overlayMaterial.map && overlayMaterial.map !== texture) {
      resources.textures.delete(overlayMaterial.map)
      overlayMaterial.map.dispose()
    }
    overlayMaterial.map = texture
    overlayMaterial.needsUpdate = true
  }
  function removeStyledFloors() {
    styledFloors?.group.removeFromParent()
    styledFloors?.dispose()
    styledFloors = null
    groundOverlay?.removeFromParent()
  }
  // Первая доска сессии: пакет пришёл после сборки — прежние стены и кладка
  // уступают место стенам стиля.
  void stylePack.then((pack) => {
    if (disposed || styledEdges || !packHasWallLooks(pack)) return
    // Прежние стены снимаются только после удачной сборки новых: доска без
    // стен хуже доски со стенами прежнего вида.
    resolvedStylePack = pack
    const nextEdges = buildStyledEdges(map, pack, styledEdgeOptions)
    const nextRocks = createRockClusters(map, landscapeDetail, BOARD3D_WALL_HEIGHT, landscapeKit, { skipMasonry: true })
    // Крыши того же стиля, в том же режиме, что выбран сейчас.
    const nextRoofs = createBoard3DRoofs(map, palette, {
      wallHeight: BOARD3D_WALL_HEIGHT, mode: roofs.getMode(), stylePack: pack, structuralAssets, onTexture: roofTextureReady,
    })
    roofs.dispose()
    roofs = nextRoofs
    group.add(roofs.group)
    edgeLayer.removeFromParent()
    styledEdges = nextEdges
    group.add(styledEdges.group)
    rocks.dispose()
    rocks = nextRocks
    if (rocks.group.children.length) group.add(rocks.group)
    options.onReady?.()
  }).catch((error: unknown) => console.warn('Стены стиля не собрались, остаются прежние', error))
  void stylePack.then((pack) => {
    if (!pack || disposed || authoritativeArtLoaded || typeof document === 'undefined') return
    const loader = new THREE.TextureLoader()
    const built = buildStyledFloors(map, pack, {
      parallax: options.floorParallax !== false,
      loadTexture: (url) => loader.load(url, () => { if (!disposed) options.onReady?.() }),
    })
    if (!built.keys.length) { built.dispose(); return }
    styledFloors = built
    groundGroup.add(built.group)
    paintGroundOverlay()
    options.onReady?.()
  })

  loadTerrainTiles(map, (terrain) => {
    loadedTerrain = terrain
    paintGroundOverlay()
    const texture = paintTerrainCanvas(resources, map, palette, terrain)
    if (!texture) return
    if (authoritativeArtLoaded) {
      resources.textures.delete(texture)
      texture.dispose()
      return
    }
    if (groundMaterial.map && groundMaterial.map !== texture) {
      resources.textures.delete(groundMaterial.map)
      groundMaterial.map.dispose()
    }
    groundMaterial.map = texture
    // Рельеф берётся из той же раскраски плиток: камни брусчатки, дёрн и швы
    // между клетками ловят свет и тень, как объёмные плитки настольной диорамы.
    groundMaterial.bumpMap = texture
    groundMaterial.bumpScale = BOARD3D_GROUND_RELIEF
    groundMaterial.needsUpdate = true
    if (!disposed) options.onReady?.()
  }, () => disposed)

  const dispose = () => {
    if (disposed) return
    group.removeFromParent()
    disposed = true
    propAbort.abort()
    props.dispose()
    propAssets?.dispose()
    styledFloors?.dispose()
    styledFloors = null
    roofs.dispose()
    landscapeAbort.abort()
    rocks.dispose()
    styledEdges?.dispose()
    grass?.dispose()
    bridges?.dispose()
    waterPlants?.dispose()
    landscapeKit?.release()
    landscapeKit = null
    group.clear()
    for (const materialValue of resources.materials) materialValue.dispose()
    for (const geometry of resources.geometries) geometry.dispose()
    for (const texture of resources.textures) texture.dispose()
    resources.materials.clear()
    resources.geometries.clear()
    resources.textures.clear()
  }

  return {
    group,
    /** Вода рябит, пока доска её рисует; на «Экономном» стоит. */
    animated: Boolean(waterMaterial) && landscapeDetail !== 'minimal',
    animate(nowMs: number) {
      if (waterMaterial && landscapeDetail !== 'minimal') waterMaterial.userData.time.value = nowMs / 1000
    },
    getPropPickTargets: () => disposed ? [] : props.pickTargets,
    setRoofMode: (mode: Board3DRoofMode) => roofs.setMode(mode),
    getRoofMode: () => roofs.getMode(),
    dispose,
  }
}
