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
  TILE_CELLS,
  type BoardPalette,
  type BoardScene,
  type BoardTexture,
  type TerrainTiles,
} from './board-render'
import type { TacticalCell, TacticalDoorState, TacticalEdge, TacticalMap } from './types'
import { cellAt, edgeList, edgeNeighbor, revealedAt } from './tactical-map-client'
import { createEnvironmentModels } from './board3d-props'
import { loadPropModelAssets, type PropModelAssets } from './prop-model-assets'
import { LIGHT_SOURCE_ASSETS, lightSourceAssetId } from './board-lighting'
import { batchEnvironmentMeshes } from './board3d-batching'
import { createTerrainSideGeometry, createTerrainSurfaceGeometry, propTerrainHeight, terrainHeightAt } from './board3d-terrain'

/** Высота срезанной стены в мировых единицах клетки. */
export const BOARD3D_WALL_HEIGHT = 0.68
/** Граница стены совпадает с границей клеток, как и в 2D-доске. */
export const BOARD3D_WALL_THICKNESS = 1 / 6
/** Canvas-фактура не должна занимать больше этого размера по стороне. */
export const BOARD3D_MAX_GROUND_CANVAS = 4096
const TERRAIN_MANIFEST_URL = '/assets/maps/terrain/terrain-tiles.json'

type Board3DOptions = {
  lighting?: boolean
  palette?: BoardPalette
  artUrl?: string | null
  artMode?: 'map' | 'backdrop'
  onReady?: () => void
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

function edgeVisible(map: TacticalMap, edge: TacticalEdge) {
  const neighbor = edgeNeighbor(edge)
  // Ребро видно, как только раскрыта любая его сторона. Это правило 2D-доски
  // не даёт заглянуть сквозь границу ещё не открытой комнаты.
  return revealedAt(map, edge.x, edge.y) || revealedAt(map, neighbor.x, neighbor.y)
}

function edgeSideCell(map: TacticalMap, edge: TacticalEdge) {
  const owner = cellAt(map, edge.x, edge.y)
  const neighbor = edgeNeighbor(edge)
  const other = cellAt(map, neighbor.x, neighbor.y)
  const visible = [owner, other].filter((cell): cell is TacticalCell => Boolean(cell?.revealed))
  const built = (cell: TacticalCell | null) => cell && ['stone', 'wood', 'marble', 'metal'].includes(cell.material) ? cell : null
  return visible.map(built).find(Boolean) ?? visible[0] ?? built(owner) ?? built(other) ?? owner ?? other
}

function doorState(map: TacticalMap, edge: TacticalEdge): TacticalDoorState {
  const door = map.doors.find((entry) => entry.id === edge.doorId
    || (entry.x === edge.x && entry.y === edge.y && entry.dir === edge.dir))
  return door?.state ?? 'closed'
}

function edgeCenter(edge: TacticalEdge) {
  return edge.dir === 'e'
    ? { x: edge.x + 1, z: edge.y + 0.5 }
    : { x: edge.x + 0.5, z: edge.y + 1 }
}

/** Высота ребра принадлежит только раскрытым соседям, никогда туманной клетке. */
function edgeFloorHeight(map: TacticalMap, edge: TacticalEdge) {
  const neighbor = edgeNeighbor(edge)
  const heights = [[edge.x, edge.y], [neighbor.x, neighbor.y]]
    .filter(([x, y]) => revealedAt(map, x, y))
    .map(([x, y]) => terrainHeightAt(map, x, y))
    .filter(Number.isFinite)
  return heights.length ? Math.max(...heights) : 0
}

function addEdgeScene(resources: OwnedResources, map: TacticalMap, parent: THREE.Group, palette: BoardPalette) {
  const wallPieces: EdgePiece[] = []
  const lowPieces: EdgePiece[] = []
  const framePieces: EdgePiece[] = []
  const doorGroup = new THREE.Group()
  doorGroup.name = 'doors'

  for (const edge of edgeList(map)) {
    if (!edgeVisible(map, edge) || edge.kind === 'none') continue
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
      wallPieces.push(piece(BOARD3D_WALL_HEIGHT))
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
    const leafHeight = 0.58
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
  if (walls.children.length) parent.add(walls)
  if (doorGroup.children.length) parent.add(doorGroup)
}

function createGroundGeometry(resources: OwnedResources, map: TacticalMap, palette: BoardPalette) {
  const colors: number[] = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!revealedAt(map, x, y)) continue
      const cell = cellAt(map, x, y)
      if (!cell) continue
      const color = new THREE.Color(cellColor(cell, palette))
      for (let vertex = 0; vertex < 4; vertex += 1) colors.push(color.r, color.g, color.b)
    }
  }
  const geometry = ownGeometry(resources, createTerrainSurfaceGeometry(map))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

function addTerrainSides(resources: OwnedResources, map: TacticalMap, parent: THREE.Group, palette: BoardPalette) {
  const geometry = createTerrainSideGeometry(map)
  if (!geometry.getAttribute('position')?.count) {
    geometry.dispose()
    return
  }
  const sides = new THREE.Mesh(ownGeometry(resources, geometry), material(resources, palette.wall))
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

function paintTerrainCanvas(resources: OwnedResources, map: TacticalMap, palette: BoardPalette, terrain: TerrainTiles) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  try {
    const pixelsPerCell = Math.max(1, Math.min(64, Math.floor(BOARD3D_MAX_GROUND_CANVAS / Math.max(1, map.width, map.height))))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.min(BOARD3D_MAX_GROUND_CANVAS, map.width * pixelsPerCell))
    canvas.height = Math.max(1, Math.min(BOARD3D_MAX_GROUND_CANVAS, map.height * pixelsPerCell))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.clearRect(0, 0, canvas.width, canvas.height)
    const scene: BoardScene = { map, palette, cellSize: pixelsPerCell, terrain, artMode: 'backdrop', showElevationLabels: false }
    const tilesX = Math.max(1, Math.ceil(map.width / TILE_CELLS))
    const tilesY = Math.max(1, Math.ceil(map.height / TILE_CELLS))
    for (let tileY = 0; tileY < tilesY; tileY += 1) {
      for (let tileX = 0; tileX < tilesX; tileX += 1) {
        context.save()
        context.translate(tileX * TILE_CELLS * pixelsPerCell, tileY * TILE_CELLS * pixelsPerCell)
        const tile = { tileX, tileY }
        drawFloorTiles(context, scene, tile)
        drawDecals(context, scene, tile)
        drawCellFeatures(context, scene, tile)
        drawGrid(context, scene, tile)
        drawFog(context, scene, tile)
        context.restore()
      }
    }
    const texture = ownTexture(resources, new THREE.CanvasTexture(canvas))
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    texture.needsUpdate = true
    return texture
  } catch {
    return null
  }
}

function addProps(map: TacticalMap, parent: THREE.Group, lighting: boolean, palette: BoardPalette, assets?: PropModelAssets | null) {
  const library = createEnvironmentModels(palette, assets)
  const propsGroup = new THREE.Group()
  propsGroup.name = 'props'
  const lightGroup = new THREE.Group()
  lightGroup.name = 'local-lights'
  const lights: THREE.PointLight[] = []
  for (const prop of map.props) {
    if (!Number.isFinite(prop.x) || !Number.isFinite(prop.y) || !revealedAt(map, Math.floor(prop.x), Math.floor(prop.y))) continue
    const model = library.create(prop)
    // Высота предмета следует за раскрытым футпринтом; батчер ниже увидит уже
    // установленную мировую матрицу, поэтому возвышенные предметы не упадут на Y=0.
    model.position.y = propTerrainHeight(map, prop)
    propsGroup.add(model)
    const sourceId = lightSourceAssetId(prop.assetId)
    if (!lighting || !sourceId || lights.length >= 4) continue
    const profile = LIGHT_SOURCE_ASSETS[sourceId]
    const light = new THREE.PointLight(palette.lightWarm, 1.35, Math.min(8, profile.radius), 2)
    light.name = 'fire-light'
    light.position.copy(model.position)
    light.position.y += (Number(model.userData.lightHeight) || .55) * model.scale.y
    light.castShadow = true
    light.shadow.mapSize.set(256, 256)
    light.shadow.camera.near = .1
    light.shadow.camera.far = Math.min(8, profile.radius)
    lightGroup.add(light)
    lights.push(light)
  }
  const batches = batchEnvironmentMeshes(propsGroup)
  propsGroup.userData.originalDrawCalls = batches.originalDrawCalls
  propsGroup.userData.batchedDrawCalls = batches.batchedDrawCalls
  if (propsGroup.children.length) parent.add(propsGroup)
  if (lightGroup.children.length) parent.add(lightGroup)
  return { group: propsGroup, dispose() { propsGroup.removeFromParent(); lightGroup.removeFromParent(); batches.dispose(); library.dispose(); lights.forEach((light) => light.shadow.dispose()) } }
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
  const groundGeometry = createGroundGeometry(resources, map, palette)
  const groundMaterial = material(resources, '#ffffff', { vertexColors: true, roughness: 0.94, metalness: 0 }) as THREE.MeshStandardMaterial
  const groundTexture = createGroundCanvasTexture(resources, map, palette)
  if (groundTexture) {
    groundMaterial.map = groundTexture
    groundMaterial.vertexColors = false
    groundMaterial.needsUpdate = true
  }
  const ground = new THREE.Mesh(groundGeometry, groundMaterial)
  ground.name = 'ground-plane'
  ground.receiveShadow = true
  ground.castShadow = false
  groundGroup.add(ground)
  addTerrainSides(resources, map, groundGroup, palette)

  addEdgeScene(resources, map, group, palette)
  let props = addProps(map, group, options.lighting !== false, palette)
  let propAssets: PropModelAssets | null = null
  const propAbort = new AbortController()
  if (typeof window !== 'undefined') {
    const visibleProps = map.props.filter((prop) => Number.isFinite(prop.x) && Number.isFinite(prop.y) && revealedAt(map, Math.floor(prop.x), Math.floor(prop.y)))
    void loadPropModelAssets(visibleProps, propAbort.signal).then((assets) => {
      if (!assets) return
      if (disposed) { assets.dispose(); return }
      const replacement = addProps(map, group, options.lighting !== false, palette, assets)
      props.dispose()
      props = replacement
      propAssets = assets
      options.onReady?.()
    }).catch(() => {})
  }

  let authoritativeArtLoaded = false
  const artOverlayMaterial = artMode === 'backdrop'
    ? material(resources, '#ffffff', { transparent: true, opacity: 0.34, depthWrite: false }) as THREE.MeshStandardMaterial
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
        if (groundMaterial.map && groundMaterial.map !== texture) {
          resources.textures.delete(groundMaterial.map)
          groundMaterial.map.dispose()
        }
        groundMaterial.map = texture
        groundMaterial.vertexColors = false
        groundMaterial.needsUpdate = true
      }
    }, callReady, () => disposed)
  } else {
    callReady()
  }

  loadTerrainTiles(map, (terrain) => {
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
    groundMaterial.vertexColors = false
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
    group.clear()
    for (const materialValue of resources.materials) materialValue.dispose()
    for (const geometry of resources.geometries) geometry.dispose()
    for (const texture of resources.textures) texture.dispose()
    resources.materials.clear()
    resources.geometries.clear()
    resources.textures.clear()
  }

  return { group, dispose }
}
