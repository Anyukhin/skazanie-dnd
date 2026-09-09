import * as THREE from 'three'

import { propVisualLayout, resolvePropAssetId, PROP_FOOTPRINT_FILL, type BoardPalette } from './board-render'
import type { TacticalProp } from './types'
import { propModelFor } from './prop-model-catalog'
import type { PropModelAssets } from './prop-model-assets'

type Layout = ReturnType<typeof propVisualLayout>

type Tones = {
  wood: string
  woodLight: string
  woodDark: string
  stone: string
  stoneLight: string
  fabric: string
  foliage: string
  foliageLight: string
  earth: string
  metal: string
  water: string
  ember: string
  shadow: string
}

type Resources = {
  geometries: Set<THREE.BufferGeometry>
  materials: Set<THREE.Material>
  textures: Set<THREE.Texture>
  geometryPool: Map<string, THREE.BufferGeometry>
  materialPool: Map<string, THREE.Material>
}

/**
 * Канонический asset id → семантическая процедурная модель. Это намеренная
 * точная таблица: новый id реестра требует отдельного визуального решения.
 */
const MODEL_KINDS: Readonly<Record<string, string>> = Object.freeze({
  table_round: 'table-round', table_long: 'table-long', table_royal: 'table-royal', royal_throne: 'throne',
  table_small: 'table-small', bench: 'bench', chair: 'chair', stool: 'stool', bar_counter: 'counter',
  bar_shelf: 'shelf-bottles', fireplace: 'fireplace', hearth_fire: 'hearth', cauldron: 'cauldron',
  firewood_stack: 'firewood-stack', barrel: 'barrel', barrel_stack: 'barrel-stack', keg: 'keg', crate: 'crate',
  crate_stack: 'crate-stack', sack: 'sack', basket: 'basket', bucket: 'bucket', chest: 'chest',
  cupboard: 'cupboard', wardrobe: 'wardrobe', bookshelf: 'bookshelf', shelf_wall: 'shelf-wall', broom: 'broom',
  mug: 'mug', plate: 'plate', bowl_stew: 'bowl', bottle: 'bottle', jug: 'jug', bread_loaf: 'bread',
  cheese_wheel: 'cheese', candle: 'candle', dice_cup: 'dice-cup', coin_pile: 'coin-pile', lute: 'lute',
  cutting_board: 'cutting-board', pot: 'pot', bed: 'bed', bunk_bed: 'bunk-bed', night_table: 'night-table',
  washbasin: 'washbasin', torch_wall: 'wall-torch', lantern_wall: 'wall-lantern', candelabra: 'stand-light',
  chandelier: 'chandelier', banner: 'wall-banner', sign_board: 'sign-board', rug: 'rug', floor_stain: 'floor-stain',
  stairs_up: 'stairs-up', stairs_down: 'stairs-down', trapdoor: 'trapdoor', tree_oak: 'tree-oak', tree_pine: 'tree-pine',
  tree_birch: 'tree-birch', tree_dead: 'tree-dead', tree_stump: 'tree-stump', bush: 'bush', shrub: 'shrub',
  grass_tuft: 'grass-tuft', flowers: 'flowers', rock_small: 'rock-small', boulder: 'boulder', woodpile: 'woodpile',
  cart: 'cart', wagon_wheel: 'wagon-wheel', hitching_post: 'hitching-post', water_trough: 'water-trough', well: 'well',
  lamp_post: 'lamp-post', signpost: 'signpost', haystack: 'haystack', path_stone: 'path-stone', campfire: 'campfire',
  pillar: 'pillar', altar: 'altar', statue: 'statue', brazier: 'brazier', offering_bowl: 'offering-bowl',
  prayer_bench: 'prayer-bench', temple_banner: 'temple-banner', reliquary: 'reliquary', mosaic: 'mosaic',
  sarcophagus: 'sarcophagus', grave: 'grave', bone_pile: 'bone-pile', urn: 'urn', crypt_niche: 'crypt-niche',
  cobweb: 'cobweb', stalagmite: 'stalagmite', cave_pool: 'cave-pool', mushroom_cluster: 'mushroom-cluster',
  ore_vein: 'ore-vein', rubble_heap: 'rubble-heap', tree_spruce: 'tree-spruce', fallen_log: 'fallen-log',
  fern: 'fern', milestone: 'milestone', roadside_shrine: 'roadside-shrine', market_stall: 'market-stall',
  village_fence: 'village-fence',
})

const LIGHT_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  fireplace: 0.34, hearth: 0.43, campfire: 0.43, brazier: 0.43,
  'wall-torch': 0.86, 'wall-lantern': 0.66, 'stand-light': 0.84,
  chandelier: 0.48, candle: 0.46, 'lamp-post': 0.91,
})

function tones(palette: BoardPalette): Tones {
  return {
    wood: palette.prop,
    woodLight: palette.propAccent,
    woodDark: palette.wall,
    stone: palette.wall,
    stoneLight: palette.ledge,
    fabric: palette.floorAlt,
    foliage: palette.foliage,
    foliageLight: palette.foliageLight,
    earth: palette.zoneExterior,
    metal: palette.rail,
    water: palette.window,
    ember: palette.lightWarm,
    shadow: '#211812',
  }
}

function resources(): Resources {
  return {
    geometries: new Set(), materials: new Set(), textures: new Set(),
    geometryPool: new Map(), materialPool: new Map(),
  }
}

function geometry(resources: Resources, key: string, factory: () => THREE.BufferGeometry) {
  const cached = resources.geometryPool.get(key)
  if (cached) return cached
  const value = factory()
  resources.geometryPool.set(key, value)
  resources.geometries.add(value)
  return value
}

function material(
  resources: Resources,
  key: string,
  color: string,
  options: THREE.MeshStandardMaterialParameters = {},
) {
  const cached = resources.materialPool.get(key)
  if (cached) return cached
  const value = new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.03, ...options })
  resources.materialPool.set(key, value)
  resources.materials.add(value)
  return value
}

function part(
  resources: Resources,
  parent: THREE.Group,
  name: string,
  key: string,
  factory: () => THREE.BufferGeometry,
  materialValue: THREE.Material,
  size: [number, number, number],
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
  castShadow = true,
) {
  const mesh = new THREE.Mesh(geometry(resources, key, factory), materialValue)
  mesh.name = name
  mesh.position.set(...position)
  mesh.rotation.set(...rotation)
  mesh.scale.set(...size)
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function cube(resources: Resources, parent: THREE.Group, name: string, materialValue: THREE.Material, size: [number, number, number], position: [number, number, number] = [0, 0, 0], rotation: [number, number, number] = [0, 0, 0], castShadow = true) {
  return part(resources, parent, name, 'cube', () => new THREE.BoxGeometry(1, 1, 1), materialValue, size, position, rotation, castShadow)
}

function round(resources: Resources, parent: THREE.Group, name: string, materialValue: THREE.Material, diameter: number, height: number, position: [number, number, number], castShadow = true) {
  return part(resources, parent, name, 'round', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 10), materialValue, [diameter, height, diameter], position, [0, 0, 0], castShadow)
}

function cone(resources: Resources, parent: THREE.Group, name: string, materialValue: THREE.Material, diameter: number, height: number, position: [number, number, number], castShadow = true) {
  return part(resources, parent, name, 'cone', () => new THREE.ConeGeometry(0.5, 1, 8), materialValue, [diameter, height, diameter], position, [0, 0, 0], castShadow)
}

function sphere(resources: Resources, parent: THREE.Group, name: string, materialValue: THREE.Material, size: [number, number, number], position: [number, number, number], castShadow = true) {
  return part(resources, parent, name, 'sphere', () => new THREE.SphereGeometry(0.5, 8, 5), materialValue, size, position, [0, 0, 0], castShadow)
}

function rock(resources: Resources, parent: THREE.Group, name: string, materialValue: THREE.Material, size: [number, number, number], position: [number, number, number]) {
  return part(resources, parent, name, 'rock', () => new THREE.DodecahedronGeometry(0.5, 0), materialValue, size, position)
}

function ring(resources: Resources, parent: THREE.Group, name: string, materialValue: THREE.Material, diameter: number, thickness: number, position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) {
  return part(resources, parent, name, 'ring', () => new THREE.TorusGeometry(0.5, 0.1, 5, 12), materialValue, [diameter / 1.2, Math.max(0.25, thickness / 0.2), diameter / 1.2], position, rotation, false)
}

function flat(resources: Resources, parent: THREE.Group, name: string, materialValue: THREE.Material, width: number, depth: number, y = 0.018) {
  return cube(resources, parent, name, materialValue, [Math.max(0.08, width), 0.024, Math.max(0.08, depth)], [0, y, 0], [0, 0, 0], false)
}

function dimensions(layout: Layout) {
  return { width: Math.max(0.18, layout.width), depth: Math.max(0.18, layout.depth) }
}

function buildTable(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, shape: 'round' | 'long' | 'royal' | 'small') {
  const { width, depth } = dimensions(layout)
  const wood = material(resources, 'wood', t.wood)
  const dark = material(resources, 'wood-dark', t.woodDark)
  if (shape === 'round') {
    round(resources, parent, 'table-top-round', wood, Math.min(width, depth) * 0.86, 0.1, [0, 0.68, 0])
    round(resources, parent, 'table-pedestal', dark, 0.18, 0.64, [0, 0.32, 0])
  } else {
    const topW = Math.max(0.4, width * 0.84), topD = Math.max(0.34, depth * 0.84)
    cube(resources, parent, 'table-top', wood, [topW, 0.1, topD], [0, 0.68, 0])
    const legXs = shape === 'small' ? [-topW * 0.34, topW * 0.34] : [-topW * 0.4, topW * 0.4]
    for (const x of legXs) for (const z of [-topD * 0.34, topD * 0.34]) cube(resources, parent, 'table-leg', dark, [0.09, 0.66, 0.09], [x, 0.33, z])
    if (shape === 'royal') {
      cube(resources, parent, 'royal-apron', dark, [topW * 0.88, 0.2, 0.07], [0, 0.53, topD * 0.42])
      for (const x of [-topW * 0.38, topW * 0.38]) sphere(resources, parent, 'royal-finial', material(resources, 'brass', t.woodLight, { metalness: 0.35 }), [0.1, 0.14, 0.1], [x, 0.78, 0])
    }
  }
}

function buildSeat(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, shape: 'bench' | 'chair' | 'stool' | 'throne' | 'prayer') {
  const { width, depth } = dimensions(layout)
  const wood = material(resources, 'wood', t.wood), dark = material(resources, 'wood-dark', t.woodDark)
  const seatW = Math.min(1.7, Math.max(0.28, width * 0.78)), seatD = Math.min(0.72, Math.max(0.25, depth * 0.76))
  const y = shape === 'stool' ? 0.5 : 0.43
  if (shape === 'stool') round(resources, parent, 'stool-seat', wood, seatW, 0.13, [0, y, 0])
  else cube(resources, parent, `${shape}-seat`, wood, [seatW, 0.12, seatD], [0, y, 0])
  if (shape !== 'stool') cube(resources, parent, `${shape}-back`, dark, [seatW, shape === 'throne' ? 0.74 : 0.48, 0.1], [0, shape === 'throne' ? 0.79 : 0.65, -seatD * 0.43])
  const legW = shape === 'bench' || shape === 'prayer' ? 0.08 : 0.07
  for (const x of [-seatW * 0.35, seatW * 0.35]) {
    cube(resources, parent, `${shape}-leg`, dark, [legW, y, legW], [x, y / 2, 0])
    if (shape !== 'stool') cube(resources, parent, `${shape}-leg`, dark, [legW, y, legW], [x, y / 2, -seatD * 0.33])
  }
  if (shape === 'throne') for (const x of [-seatW * 0.48, seatW * 0.48]) cube(resources, parent, 'throne-arm', wood, [0.09, 0.28, seatD], [x, 0.57, 0])
}

function buildShelf(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, books = false) {
  const { width, depth } = dimensions(layout), wood = material(resources, 'wood', t.wood), dark = material(resources, 'wood-dark', t.woodDark)
  const w = Math.min(2.8, width * 0.84), d = Math.min(0.7, depth * 0.74), h = 0.96
  for (const x of [-w * 0.45, w * 0.45]) cube(resources, parent, 'shelf-side', dark, [0.08, h, 0.08], [x, h / 2, 0])
  for (const y of [0.12, 0.42, 0.72, 0.96]) cube(resources, parent, 'shelf-board', wood, [w, 0.07, d], [0, y, 0])
  if (books) for (let i = 0; i < 6; i += 1) cube(resources, parent, 'book', material(resources, `book-${i % 3}`, [t.fabric, t.woodLight, t.earth][i % 3]), [0.07, 0.2 + (i % 2) * 0.06, 0.2], [-w * 0.32 + (i % 3) * 0.27, 0.22 + Math.floor(i / 3) * 0.3, 0.02])
}

function buildCabinet(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, shape: 'cupboard' | 'wardrobe' | 'night' | 'books') {
  const { width, depth } = dimensions(layout), wood = material(resources, 'wood', t.wood), dark = material(resources, 'wood-dark', t.woodDark)
  const w = Math.min(1.8, width * 0.84), d = Math.min(0.72, depth * 0.72), h = shape === 'night' ? 0.58 : 0.96
  cube(resources, parent, `${shape}-body`, dark, [w, h, d], [0, h / 2, 0])
  if (shape === 'books') buildShelf(resources, parent, layout, t, true)
  else {
    cube(resources, parent, `${shape}-front`, wood, [w * 0.86, h * 0.84, 0.045], [0, h * 0.51, d * 0.52])
    if (shape === 'wardrobe') cube(resources, parent, 'wardrobe-seam', dark, [0.025, h * 0.78, 0.05], [0, h * 0.51, d * 0.55])
    cube(resources, parent, `${shape}-handle`, material(resources, 'brass', t.woodLight, { metalness: 0.35 }), [0.06, 0.06, 0.06], [shape === 'wardrobe' ? 0.08 : 0, h * 0.52, d * 0.57], undefined, false)
  }
}

function buildBarrel(resources: Resources, parent: THREE.Group, t: Tones, shape: 'barrel' | 'stack' | 'keg') {
  const wood = material(resources, 'wood', t.wood), hoop = material(resources, 'metal', t.metal, { metalness: 0.32, roughness: 0.5 })
  if (shape === 'keg') {
    const body = round(resources, parent, 'keg-body', wood, 0.58, 0.72, [0, 0.35, 0]); body.rotation.z = Math.PI / 2
    for (const x of [-0.22, 0.22]) { const band = ring(resources, parent, 'keg-hoop', hoop, 0.62, 0.055, [x, 0.35, 0], [0, 0, Math.PI / 2]); band.rotation.z = Math.PI / 2 }
    return
  }
  const add = (x: number, z: number, scale: number, name: string) => {
    round(resources, parent, name, wood, 0.58 * scale, 0.68 * scale, [x, 0.34 * scale, z])
    for (const y of [0.16, 0.52]) ring(resources, parent, 'barrel-hoop', hoop, 0.62 * scale, 0.045, [x, y * scale, z])
  }
  add(0, 0, 1, 'barrel-body')
  if (shape === 'stack') { add(-0.25, 0.05, 0.82, 'barrel-body'); add(0.25, 0.05, 0.82, 'barrel-body') }
}

function buildCrate(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, shape: 'crate' | 'stack' | 'chest') {
  const { width, depth } = dimensions(layout), wood = material(resources, 'wood', t.wood), dark = material(resources, 'wood-dark', t.woodDark)
  const add = (x: number, z: number, size: number, name: string) => {
    cube(resources, parent, `${name}-body`, wood, [0.64 * size, 0.55 * size, 0.64 * size], [x, 0.275 * size, z])
    cube(resources, parent, `${name}-slat-x`, dark, [0.68 * size, 0.045, 0.06 * size], [x, 0.28 * size, z - 0.33 * size], undefined, false)
    cube(resources, parent, `${name}-slat-z`, dark, [0.06 * size, 0.045, 0.68 * size], [x - 0.33 * size, 0.28 * size, z], undefined, false)
  }
  if (shape === 'chest') {
    const w = Math.min(1.4, width * 0.84), d = Math.min(0.75, depth * 0.76)
    cube(resources, parent, 'chest-body', wood, [w, 0.38, d], [0, 0.22, 0])
    cube(resources, parent, 'chest-lid', wood, [w * 1.04, 0.12, d * 1.05], [0, 0.46, 0])
    cube(resources, parent, 'chest-band', dark, [0.06, 0.45, d * 1.05], [0, 0.25, 0], undefined, false)
    cube(resources, parent, 'chest-latch', material(resources, 'brass', t.woodLight, { metalness: 0.35 }), [0.1, 0.12, 0.06], [0, 0.37, d * 0.56], undefined, false)
  } else { add(0, 0, 1, 'crate'); if (shape === 'stack') { add(-0.22, 0.08, 0.76, 'crate'); add(0.23, 0.12, 0.76, 'crate') } }
}

function buildTableware(resources: Resources, parent: THREE.Group, t: Tones, kind: string) {
  const clay = material(resources, 'clay', t.woodLight), dark = material(resources, 'wood-dark', t.woodDark), food = material(resources, 'food', t.earth)
  if (kind === 'mug') { round(resources, parent, 'mug-cup', clay, 0.27, 0.25, [0, 0.13, 0]); const handle = ring(resources, parent, 'mug-handle', clay, 0.2, 0.045, [0.14, 0.15, 0], [Math.PI / 2, 0, 0]); handle.rotation.x = Math.PI / 2 }
  else if (kind === 'plate') { round(resources, parent, 'plate', clay, 0.42, 0.045, [0, 0.03, 0]); ring(resources, parent, 'plate-rim', dark, 0.38, 0.025, [0, 0.06, 0]) }
  else if (kind === 'bowl') { cone(resources, parent, 'bowl', clay, 0.44, 0.18, [0, 0.09, 0]); round(resources, parent, 'stew', food, 0.27, 0.025, [0, 0.19, 0], false) }
  else if (kind === 'bottle' || kind === 'jug') { round(resources, parent, `${kind}-body`, clay, kind === 'jug' ? 0.34 : 0.25, 0.34, [0, 0.17, 0]); round(resources, parent, `${kind}-neck`, clay, 0.13, 0.22, [0, 0.44, 0]); if (kind === 'jug') { const handle = ring(resources, parent, 'jug-handle', clay, 0.24, 0.045, [0.18, 0.3, 0], [Math.PI / 2, 0, 0]); handle.rotation.x = Math.PI / 2 } }
  else if (kind === 'bread') { sphere(resources, parent, 'bread-loaf', material(resources, 'bread', t.woodLight), [0.5, 0.23, 0.33], [0, 0.115, 0]); cube(resources, parent, 'bread-score', dark, [0.025, 0.015, 0.22], [0, 0.24, 0], [0, 0, 0.18], false) }
  else if (kind === 'cheese') { round(resources, parent, 'cheese-wheel', material(resources, 'cheese', t.woodLight), 0.37, 0.13, [0, 0.065, 0]); cube(resources, parent, 'cheese-cut', dark, [0.02, 0.11, 0.27], [0.03, 0.07, 0.06], undefined, false) }
  else if (kind === 'dice-cup') { round(resources, parent, 'dice-cup', dark, 0.25, 0.25, [0, 0.125, 0]); ring(resources, parent, 'dice-cup-rim', clay, 0.24, 0.035, [0, 0.26, 0]) }
  else if (kind === 'coin-pile') { for (let i = 0; i < 3; i += 1) round(resources, parent, 'coin', material(resources, 'coin', t.woodLight, { metalness: 0.42, roughness: 0.45 }), 0.21, 0.035, [i * 0.035 - 0.035, 0.02 + i * 0.035, 0]) }
  else if (kind === 'cutting-board') { cube(resources, parent, 'cutting-board', woodMaterial(t, resources), [0.54, 0.045, 0.34], [0, 0.025, 0]); cube(resources, parent, 'board-handle', woodMaterial(t, resources), [0.12, 0.045, 0.14], [0.31, 0.025, 0], undefined, false) }
  else { round(resources, parent, 'pot', dark, 0.36, 0.26, [0, 0.13, 0]); ring(resources, parent, 'pot-rim', clay, 0.36, 0.035, [0, 0.27, 0]); for (const x of [-0.22, 0.22]) cube(resources, parent, 'pot-handle', dark, [0.07, 0.06, 0.16], [x, 0.16, 0], [0, 0, x]) }
}

function woodMaterial(t: Tones, resources: Resources) { return material(resources, 'wood', t.wood) }

function buildCauldron(resources: Resources, parent: THREE.Group, t: Tones) {
  const metal = material(resources, 'metal', t.metal, { metalness: 0.3, roughness: 0.54 })
  cone(resources, parent, 'cauldron-bowl', metal, 0.5, 0.32, [0, 0.26, 0])
  ring(resources, parent, 'cauldron-rim', material(resources, 'brass', t.woodLight, { metalness: 0.35 }), 0.5, 0.045, [0, 0.44, 0])
  for (const x of [-0.16, 0.16]) cube(resources, parent, 'cauldron-leg', metal, [0.06, 0.24, 0.06], [x, 0.12, 0])
}

function buildFirewood(resources: Resources, parent: THREE.Group, t: Tones) {
  const wood = material(resources, 'wood-dark', t.woodDark), band = material(resources, 'wood-light', t.woodLight)
  for (const [x, z] of [[-0.18, -0.08], [0.12, 0], [0, 0.12]] as Array<[number, number]>) {
    const log = round(resources, parent, 'firewood-log', wood, 0.16, 0.68, [x, 0.12 + Math.abs(z), z])
    log.rotation.z = Math.PI / 2
    ring(resources, parent, 'firewood-band', band, 0.18, 0.025, [x - 0.2, 0.12 + Math.abs(z), z], [0, 0, Math.PI / 2])
  }
}

function buildLute(resources: Resources, parent: THREE.Group, t: Tones) {
  const wood = material(resources, 'wood', t.wood), dark = material(resources, 'wood-dark', t.woodDark)
  sphere(resources, parent, 'lute-body', wood, [0.34, 0.12, 0.44], [0, 0.08, 0])
  round(resources, parent, 'lute-neck', dark, 0.09, 0.5, [0, 0.08, -0.34])
  cube(resources, parent, 'lute-pegbox', dark, [0.14, 0.08, 0.14], [0, 0.08, -0.61], [0, 0, 0], false)
  ring(resources, parent, 'lute-soundhole', material(resources, 'brass', t.woodLight), 0.09, 0.018, [0, 0.145, 0])
}

function buildWashbasin(resources: Resources, parent: THREE.Group, t: Tones) {
  const stone = material(resources, 'stone-light', t.stoneLight), metal = material(resources, 'metal', t.metal, { metalness: 0.28 })
  round(resources, parent, 'washbasin-bowl', stone, 0.48, 0.14, [0, 0.62, 0])
  round(resources, parent, 'washbasin-stand', metal, 0.09, 0.62, [0, 0.31, 0])
  cube(resources, parent, 'washbasin-back', stone, [0.5, 0.55, 0.08], [0, 0.48, -0.2])
}

function buildBed(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, bunk = false) {
  const { width, depth } = dimensions(layout), wood = woodMaterial(t, resources), cloth = material(resources, 'fabric', t.fabric)
  const w = Math.min(1.9, width * 0.86), d = Math.min(0.85, depth * 0.78)
  const levels = bunk ? [0.34, 0.78] : [0.34]
  for (const y of levels) { cube(resources, parent, 'bed-frame', wood, [w, 0.16, d], [0, y, 0]); cube(resources, parent, 'mattress', cloth, [w * 0.9, 0.14, d * 0.86], [0, y + 0.12, 0.02]); cube(resources, parent, 'pillow', material(resources, 'fabric-light', t.woodLight), [w * 0.28, 0.1, d * 0.5], [w * 0.25, y + 0.22, -d * 0.14]) }
  for (const x of [-w * 0.47, w * 0.47]) cube(resources, parent, 'bed-post', wood, [0.08, bunk ? 1.05 : 0.72, 0.08], [x, bunk ? 0.53 : 0.36, -d * 0.46])
  if (bunk) cube(resources, parent, 'bunk-ladder', wood, [0.07, 0.72, 0.08], [w * 0.37, 0.53, d * 0.43])
  else cube(resources, parent, 'headboard', wood, [w, 0.65, 0.08], [0, 0.36, -d * 0.46])
}

function buildFire(resources: Resources, parent: THREE.Group, t: Tones, kind: 'fireplace' | 'hearth' | 'campfire' | 'brazier') {
  const stone = material(resources, 'stone', t.stone), ember = material(resources, 'ember', t.ember, { emissive: t.ember, emissiveIntensity: 0.45 }), flame = material(resources, 'flame', t.woodLight, { emissive: t.ember, emissiveIntensity: 0.8, transparent: true, opacity: 0.88 })
  if (kind === 'fireplace') {
    for (const x of [-0.35, 0.35]) cube(resources, parent, 'fireplace-jamb', stone, [0.2, 0.8, 0.34], [x, 0.4, 0])
    cube(resources, parent, 'fireplace-lintel', material(resources, 'stone-light', t.stoneLight), [0.9, 0.18, 0.38], [0, 0.84, 0])
    cube(resources, parent, 'fireplace-hearth', stone, [0.9, 0.08, 0.48], [0, 0.04, 0.04])
    cone(resources, parent, 'fireplace-flame', flame, 0.3, 0.5, [0, 0.3, -0.1], false)
  } else {
    ring(resources, parent, `${kind}-ring`, stone, kind === 'brazier' ? 0.48 : 0.64, 0.08, [0, 0.08, 0])
    if (kind === 'brazier') round(resources, parent, 'brazier-stand', stone, 0.16, 0.45, [0, 0.28, 0])
    else for (const x of [-0.2, 0.2]) cube(resources, parent, `${kind}-log`, material(resources, 'wood-dark', t.woodDark), [0.46, 0.1, 0.1], [x, 0.13, 0], [0, x > 0 ? 0.28 : -0.28, 0])
    rock(resources, parent, `${kind}-embers`, ember, [0.3, 0.18, 0.3], [0, 0.17, 0]); cone(resources, parent, `${kind}-flame`, flame, 0.23, 0.46, [0, 0.43, 0], false)
  }
}

function buildLight(resources: Resources, parent: THREE.Group, t: Tones, kind: 'wall-torch' | 'wall-lantern' | 'stand-light' | 'chandelier' | 'candle') {
  const metal = material(resources, 'metal', t.metal, { metalness: 0.38, roughness: 0.5 }), glow = material(resources, 'glow', t.woodLight, { emissive: t.ember, emissiveIntensity: 0.75, transparent: true, opacity: 0.92 })
  if (kind === 'candle') { round(resources, parent, 'candle-wax', material(resources, 'wax', t.woodLight), 0.1, 0.35, [0, 0.18, 0]); cone(resources, parent, 'candle-flame', glow, 0.11, 0.2, [0, 0.46, 0], false); return }
  if (kind === 'wall-torch' || kind === 'wall-lantern') {
    cube(resources, parent, 'wall-mount', metal, [0.1, 0.1, 0.1], [0, 0.45, 0.1])
    if (kind === 'wall-torch') { cube(resources, parent, 'torch-bracket', metal, [0.07, 0.3, 0.07], [0, 0.6, 0]); cone(resources, parent, 'torch-flame', glow, 0.18, 0.32, [0, 0.86, 0], false) }
    else { cube(resources, parent, 'lantern-frame', metal, [0.24, 0.3, 0.2], [0, 0.66, 0]); sphere(resources, parent, 'lantern-glow', glow, [0.13, 0.18, 0.13], [0, 0.66, 0], false) }
  } else if (kind === 'stand-light') { round(resources, parent, 'light-stand', metal, 0.08, 0.7, [0, 0.35, 0]); ring(resources, parent, 'light-bowl', metal, 0.3, 0.05, [0, 0.7, 0]); cone(resources, parent, 'light-flame', glow, 0.12, 0.24, [0, 0.84, 0], false) }
  else { cube(resources, parent, 'chandelier-chain', metal, [0.05, 0.42, 0.05], [0, 0.72, 0]); ring(resources, parent, 'chandelier-ring', metal, 0.55, 0.06, [0, 0.48, 0]); for (const [x, z] of [[-0.2, 0], [0.2, 0], [0, 0.2]] as Array<[number, number]>) cone(resources, parent, 'chandelier-candle', glow, 0.12, 0.25, [x, 0.36, z], false) }
}

function buildNatural(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, kind: string) {
  const wood = material(resources, 'wood-dark', t.woodDark), green = material(resources, 'foliage', t.foliage), light = material(resources, 'foliage-light', t.foliageLight), stone = material(resources, 'stone', t.stone)
  if (kind === 'tree-oak' || kind === 'tree-pine' || kind === 'tree-birch' || kind === 'tree-dead' || kind === 'tree-stump' || kind === 'tree-spruce') {
    if (kind === 'tree-stump') { round(resources, parent, 'stump', wood, 0.55, 0.28, [0, 0.14, 0]); ring(resources, parent, 'stump-ring', light, 0.44, 0.025, [0, 0.29, 0]); return }
    const dead = kind === 'tree-dead', pine = kind === 'tree-pine' || kind === 'tree-spruce', birch = kind === 'tree-birch'
    round(resources, parent, 'tree-trunk', wood, birch ? 0.2 : 0.27, dead ? 0.72 : 0.9, [0, (dead ? 0.72 : 0.9) / 2, 0])
    if (dead) { for (const side of [-1, 1]) cube(resources, parent, 'dead-branch', wood, [0.45, 0.07, 0.07], [side * 0.18, 0.62, 0], [0, side * 0.55, side * 0.22]); return }
    if (pine) for (const [y, d] of [[0.66, 0.78], [0.97, 0.58], [1.23, 0.38]] as Array<[number, number]>) cone(resources, parent, 'pine-crown', green, d, 0.48, [0, y, 0])
    else { sphere(resources, parent, 'tree-crown', green, [birch ? 0.58 : 0.86, 0.62, birch ? 0.58 : 0.86], [0, 1.08, 0]); sphere(resources, parent, 'tree-crown-light', light, [0.5, 0.4, 0.5], [0.17, 1.28, 0.05]) }
  } else if (kind === 'bush' || kind === 'shrub') { const d = kind === 'bush' ? 0.75 : 0.55; for (const [x, y, z] of [[-0.18, 0.3, 0], [0.16, 0.34, 0.05], [0, 0.46, -0.12]] as Array<[number, number, number]>) sphere(resources, parent, 'shrub-clump', kind === 'bush' ? green : light, [d, d * 0.85, d], [x, y, z]) }
  else if (kind === 'rock-small') rock(resources, parent, 'rock-small', stone, [0.42, 0.27, 0.34], [0, 0.14, 0])
  else if (kind === 'boulder') { rock(resources, parent, 'boulder', stone, [0.7, 0.52, 0.6], [0, 0.26, 0]); rock(resources, parent, 'boulder-chip', material(resources, 'stone-light', t.stoneLight), [0.22, 0.14, 0.16], [0.22, 0.43, 0.08]) }
  else if (kind === 'stalagmite') cone(resources, parent, 'stalagmite', stone, 0.54, 0.92, [0, 0.46, 0])
  else if (kind === 'rubble-heap') for (const [x, y, z, s] of [[-0.2, 0.13, 0, 0.34], [0.15, 0.16, 0.08, 0.4], [0, 0.3, -0.1, 0.3]] as Array<[number, number, number, number]>) rock(resources, parent, 'rubble', stone, [s, s * 0.75, s], [x, y, z])
  else { const log = round(resources, parent, 'log', wood, 0.22, Math.min(1.6, Math.max(0.5, layout.width * 0.65)), [0, 0.15, 0]); log.rotation.z = Math.PI / 2; for (const x of [-0.28, 0.28]) ring(resources, parent, 'log-end-band', light, 0.25, 0.03, [x, 0.15, 0], [0, 0, Math.PI / 2]) }
}

function buildGroundDetail(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, kind: string) {
  const { width, depth } = dimensions(layout), cloth = material(resources, 'fabric', t.fabric), earth = material(resources, 'earth', t.earth), green = material(resources, 'foliage', t.foliage), light = material(resources, 'foliage-light', t.foliageLight), stone = material(resources, 'stone-light', t.stoneLight)
  if (kind === 'rug') { flat(resources, parent, 'rug', cloth, width * 0.92, depth * 0.92); flat(resources, parent, 'rug-border', material(resources, 'wood-dark', t.woodDark), width * 0.78, depth * 0.78, 0.034) }
  else if (kind === 'floor-stain') { flat(resources, parent, 'stain', material(resources, 'stain', t.shadow, { transparent: true, opacity: 0.48 }), width * 0.82, depth * 0.6) }
  else if (kind === 'trapdoor') { flat(resources, parent, 'trapdoor', woodMaterial(t, resources), width * 0.82, depth * 0.82); for (const x of [-width * 0.25, width * 0.25]) cube(resources, parent, 'trapdoor-band', material(resources, 'metal', t.metal), [0.045, 0.035, depth * 0.76], [x, 0.045, 0], undefined, false) }
  else if (kind === 'grass-tuft' || kind === 'fern') for (const x of [-0.14, 0, 0.14]) cube(resources, parent, 'grass-blade', green, [0.035, kind === 'fern' ? 0.28 : 0.18, 0.06], [x, kind === 'fern' ? 0.14 : 0.09, 0], [0, x * 2, x * 2], false)
  else if (kind === 'flowers') { for (const x of [-0.14, 0.08, 0.24]) { cube(resources, parent, 'flower-stem', green, [0.025, 0.16, 0.025], [x, 0.08, 0]); sphere(resources, parent, 'flower-head', light, [0.11, 0.08, 0.11], [x, 0.18, 0], false) } }
  else if (kind === 'path-stone' || kind === 'mosaic') { const count = kind === 'mosaic' ? 4 : 3; for (let i = 0; i < count; i += 1) rock(resources, parent, kind, stone, [width / count * 0.75, 0.035, depth / count * 0.75], [(i - (count - 1) / 2) * width / count, 0.03, (i % 2 - 0.5) * depth * 0.3]) }
}

function buildSettlement(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, kind: string) {
  const { width, depth } = dimensions(layout), wood = woodMaterial(t, resources), dark = material(resources, 'wood-dark', t.woodDark), cloth = material(resources, 'fabric', t.fabric), stone = material(resources, 'stone', t.stone)
  if (kind === 'cart') { cube(resources, parent, 'cart-bed', wood, [Math.min(1.5, width * 0.7), 0.18, Math.min(0.7, depth * 0.7)], [0, 0.46, 0]); for (const x of [-0.48, 0.48]) { const wheel = ring(resources, parent, 'cart-wheel', dark, 0.5, 0.08, [x, 0.3, 0], [Math.PI / 2, 0, 0]); wheel.rotation.x = Math.PI / 2 } cube(resources, parent, 'cart-shaft', wood, [0.65, 0.08, 0.08], [0, 0.42, depth * 0.55], [0, 0, 0]) }
  else if (kind === 'wagon-wheel') { const wheel = ring(resources, parent, 'wagon-wheel', dark, 0.56, 0.08, [0, 0.31, 0], [Math.PI / 2, 0, 0]); wheel.rotation.x = Math.PI / 2; for (const angle of [0, Math.PI / 3, Math.PI * 2 / 3]) cube(resources, parent, 'wheel-spoke', wood, [0.05, 0.48, 0.04], [0, 0.31, 0], [0, angle, 0], false) }
  else if (kind === 'hitching-post' || kind === 'signpost' || kind === 'milestone') { const post = kind === 'milestone' ? stone : wood; round(resources, parent, 'post', post, kind === 'milestone' ? 0.28 : 0.12, kind === 'milestone' ? 0.62 : 0.82, [0, kind === 'milestone' ? 0.31 : 0.41, 0]); if (kind === 'hitching-post') cube(resources, parent, 'hitch-crossbar', dark, [0.58, 0.08, 0.08], [0, 0.58, 0]); else if (kind === 'signpost') cube(resources, parent, 'sign-board', wood, [0.62, 0.22, 0.07], [0, 0.68, 0]) }
  else if (kind === 'water-trough') { cube(resources, parent, 'trough-body', wood, [Math.min(1.5, width * 0.78), 0.3, Math.min(0.72, depth * 0.68)], [0, 0.18, 0]); flat(resources, parent, 'trough-water', material(resources, 'water', t.water, { transparent: true, opacity: 0.8 }), width * 0.6, depth * 0.45, 0.36) }
  else if (kind === 'well') { ring(resources, parent, 'well-stone-ring', stone, 0.9, 0.18, [0, 0.24, 0]); round(resources, parent, 'well-inner', material(resources, 'water', t.water), 0.58, 0.03, [0, 0.34, 0], false); for (const x of [-0.42, 0.42]) round(resources, parent, 'well-post', wood, 0.1, 0.78, [x, 0.61, 0]); cube(resources, parent, 'well-roof', wood, [1.02, 0.09, 0.55], [0, 1.02, 0]) }
  else if (kind === 'lamp-post') { round(resources, parent, 'lamp-post', dark, 0.1, 0.85, [0, 0.43, 0]); ring(resources, parent, 'lamp-cap', material(resources, 'metal', t.metal), 0.26, 0.05, [0, 0.82, 0]); sphere(resources, parent, 'lamp-glow', material(resources, 'glow', t.woodLight, { emissive: t.ember, emissiveIntensity: 0.7 }), [0.16, 0.2, 0.16], [0, 0.91, 0], false) }
  else if (kind === 'haystack') { const hay = material(resources, 'hay', t.woodLight); cone(resources, parent, 'haystack', hay, Math.min(1.25, width * 0.8), 0.96, [0, 0.48, 0]); ring(resources, parent, 'haystack-band', dark, Math.min(1.05, width * 0.68), 0.04, [0, 0.48, 0]) }
  else if (kind === 'market-stall') { cube(resources, parent, 'stall-counter', wood, [width * 0.72, 0.32, depth * 0.52], [0, 0.32, 0.05]); for (const x of [-width * 0.34, width * 0.34]) round(resources, parent, 'stall-post', dark, 0.07, 1.15, [x, 0.58, -depth * 0.28]); cube(resources, parent, 'stall-canopy', cloth, [width * 0.82, 0.08, depth * 0.68], [0, 1.12, 0]) }
  else { for (const x of [-width * 0.42, width * 0.42]) round(resources, parent, 'fence-post', dark, 0.08, 0.72, [x, 0.36, 0]); for (const y of [0.28, 0.52]) cube(resources, parent, 'fence-rail', dark, [width * 0.88, 0.07, 0.07], [0, y, 0]) }
}

function buildTempleCrypt(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, kind: string) {
  const { width, depth } = dimensions(layout), stone = material(resources, 'stone', t.stone), lightStone = material(resources, 'stone-light', t.stoneLight), metal = material(resources, 'metal', t.metal), cloth = material(resources, 'fabric', t.fabric)
  if (kind === 'pillar') { round(resources, parent, 'pillar-shaft', stone, Math.min(0.55, width * 0.58), 0.92, [0, 0.46, 0]); round(resources, parent, 'pillar-base', lightStone, 0.68, 0.1, [0, 0.05, 0]); round(resources, parent, 'pillar-capital', lightStone, 0.68, 0.1, [0, 0.94, 0]) }
  else if (kind === 'altar') { cube(resources, parent, 'altar-base', stone, [Math.min(1.5, width * 0.8), 0.42, Math.min(0.75, depth * 0.72)], [0, 0.21, 0]); cube(resources, parent, 'altar-top', lightStone, [width * 0.86, 0.1, depth * 0.78], [0, 0.47, 0]); ring(resources, parent, 'altar-inlay', metal, 0.22, 0.035, [0, 0.53, 0]) }
  else if (kind === 'statue') { cube(resources, parent, 'statue-pedestal', stone, [0.55, 0.3, 0.5], [0, 0.15, 0]); cone(resources, parent, 'statue-body', lightStone, 0.46, 0.58, [0, 0.59, 0]); sphere(resources, parent, 'statue-head', lightStone, [0.24, 0.24, 0.24], [0, 0.97, 0]); for (const x of [-0.28, 0.28]) cube(resources, parent, 'statue-arm', lightStone, [0.1, 0.38, 0.1], [x, 0.63, 0], [0, 0, x]) }
  else if (kind === 'offering-bowl' || kind === 'urn') { cone(resources, parent, kind, stone, kind === 'urn' ? 0.4 : 0.48, kind === 'urn' ? 0.45 : 0.2, [0, kind === 'urn' ? 0.23 : 0.1, 0]); ring(resources, parent, `${kind}-rim`, lightStone, kind === 'urn' ? 0.36 : 0.44, 0.04, [0, kind === 'urn' ? 0.46 : 0.21, 0]) }
  else if (kind === 'prayer-bench') buildSeat(resources, parent, layout, t, 'prayer')
  else if (kind === 'reliquary') { cube(resources, parent, 'reliquary-body', stone, [0.55, 0.58, 0.4], [0, 0.29, 0]); cone(resources, parent, 'reliquary-roof', lightStone, 0.62, 0.24, [0, 0.7, 0]); cube(resources, parent, 'reliquary-lock', metal, [0.08, 0.12, 0.04], [0, 0.29, 0.22], undefined, false) }
  else if (kind === 'sarcophagus' || kind === 'grave') { cube(resources, parent, `${kind}-slab`, stone, [Math.min(1.7, width * 0.86), 0.22, Math.min(0.78, depth * 0.76)], [0, 0.11, 0]); if (kind === 'sarcophagus') { cube(resources, parent, 'sarcophagus-lid', lightStone, [width * 0.78, 0.16, depth * 0.66], [0, 0.3, 0]); cone(resources, parent, 'sarcophagus-crest', stone, 0.26, 0.14, [0, 0.45, -0.02]) } else cube(resources, parent, 'grave-marker', stone, [0.16, 0.5, 0.08], [0, 0.34, -depth * 0.3]) }
  else if (kind === 'bone-pile') { for (const [x, z, angle] of [[-0.14, 0, 0.6], [0.13, 0.04, -0.6], [0, 0.14, 0.1]] as Array<[number, number, number]>) cube(resources, parent, 'bone', lightStone, [0.06, 0.06, 0.42], [x, 0.09, z], [angle, 0, angle], false) }
  else if (kind === 'crypt-niche') { for (const x of [-0.36, 0.36]) cube(resources, parent, 'niche-pillar', stone, [0.16, 0.8, 0.18], [x, 0.4, 0]); cube(resources, parent, 'niche-lintel', lightStone, [0.88, 0.16, 0.2], [0, 0.82, 0]) }
  else if (kind === 'mushroom-cluster') { for (const [x, z, s] of [[-0.18, 0, 0.7], [0.12, 0.04, 0.9], [0, -0.12, 0.58]] as Array<[number, number, number]>) { round(resources, parent, 'mushroom-stem', lightStone, 0.08 * s, 0.3 * s, [x, 0.15 * s, z]); sphere(resources, parent, 'mushroom-cap', cloth, [0.3 * s, 0.12 * s, 0.3 * s], [x, 0.34 * s, z], false) } }
  else if (kind === 'cave-pool') { flat(resources, parent, 'pool-edge', material(resources, 'earth', t.earth), width * 0.9, depth * 0.9); flat(resources, parent, 'pool-water', material(resources, 'water', t.water, { transparent: true, opacity: 0.76 }), width * 0.74, depth * 0.74, 0.04) }
  else if (kind === 'ore-vein') for (const [x, y, z] of [[-0.16, 0.28, 0], [0, 0.43, 0], [0.15, 0.3, 0]] as Array<[number, number, number]>) rock(resources, parent, 'ore-chunk', material(resources, 'ore', t.woodLight, { metalness: 0.3 }), [0.14, 0.22, 0.08], [x, y, z])
  else if (kind === 'roadside-shrine') { cube(resources, parent, 'shrine-base', stone, [0.65, 0.15, 0.38], [0, 0.08, 0]); for (const x of [-0.25, 0.25]) round(resources, parent, 'shrine-post', woodMaterial(t, resources), 0.08, 0.7, [x, 0.43, 0]); cone(resources, parent, 'shrine-roof', cloth, 0.8, 0.22, [0, 0.88, 0]) }
  else if (kind === 'temple-banner') { cube(resources, parent, 'temple-banner-cloth', cloth, [Math.max(0.28, width), 0.7, 0.025], [0, 0.55, 0], undefined, false); round(resources, parent, 'temple-banner-pole', metal, 0.04, 1.05, [-width * 0.48, 0.52, 0], false) }
  else if (kind === 'cobweb') { for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4]) cube(resources, parent, 'cobweb-thread', material(resources, 'cobweb', t.stoneLight, { transparent: true, opacity: 0.55 }), [0.018, 0.018, 0.52], [0, 0.45, 0], [0, angle, 0], false) }
  else { cube(resources, parent, 'banner-cloth', cloth, [Math.max(0.28, width), 0.7, 0.025], [0, 0.55, 0], undefined, false); round(resources, parent, 'banner-pole', metal, 0.04, 1.05, [-width * 0.48, 0.52, 0], false) }
}

function buildWallOrSign(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, kind: string) {
  const { width, depth } = dimensions(layout), wood = woodMaterial(t, resources), cloth = material(resources, 'fabric', t.fabric), metal = material(resources, 'metal', t.metal)
  if (kind === 'sign-board') { cube(resources, parent, 'sign-board', wood, [Math.max(0.4, width), 0.35, 0.04], [0, 0.56, 0]); round(resources, parent, 'sign-post', metal, 0.05, 0.72, [0, 0.36, 0]) }
  else if (kind === 'ore-vein') buildTempleCrypt(resources, parent, layout, t, kind)
  else if (kind === 'broom') { round(resources, parent, 'broom-handle', wood, 0.045, 0.75, [0, 0.38, 0], false); cube(resources, parent, 'broom-head', material(resources, 'broom', t.woodLight), [0.28, 0.1, 0.12], [0.08, 0.06, 0], [0, 0, -0.18], false) }
  else buildTableware(resources, parent, t, kind === 'cauldron' ? 'pot' : kind)
}

function buildModel(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, kind: string) {
  switch (kind) {
    case 'table-round': buildTable(resources, parent, layout, t, 'round'); break
    case 'table-long': buildTable(resources, parent, layout, t, 'long'); break
    case 'table-royal': buildTable(resources, parent, layout, t, 'royal'); break
    case 'table-small': buildTable(resources, parent, layout, t, 'small'); break
    case 'bench': buildSeat(resources, parent, layout, t, 'bench'); break
    case 'chair': buildSeat(resources, parent, layout, t, 'chair'); break
    case 'stool': buildSeat(resources, parent, layout, t, 'stool'); break
    case 'throne': buildSeat(resources, parent, layout, t, 'throne'); break
    case 'counter': buildTable(resources, parent, layout, t, 'long'); break
    case 'shelf-bottles': buildShelf(resources, parent, layout, t); break
    case 'shelf-wall': buildShelf(resources, parent, layout, t); break
    case 'bookshelf': buildShelf(resources, parent, layout, t, true); break
    case 'cupboard': buildCabinet(resources, parent, layout, t, 'cupboard'); break
    case 'wardrobe': buildCabinet(resources, parent, layout, t, 'wardrobe'); break
    case 'night-table': buildCabinet(resources, parent, layout, t, 'night'); break
    case 'fireplace': buildFire(resources, parent, t, 'fireplace'); break
    case 'hearth': buildFire(resources, parent, t, 'hearth'); break
    case 'campfire': buildFire(resources, parent, t, 'campfire'); break
    case 'brazier': buildFire(resources, parent, t, 'brazier'); break
    case 'cauldron': buildCauldron(resources, parent, t); break
    case 'firewood-stack': buildFirewood(resources, parent, t); break
    case 'wall-torch': buildLight(resources, parent, t, 'wall-torch'); break
    case 'wall-lantern': buildLight(resources, parent, t, 'wall-lantern'); break
    case 'stand-light': buildLight(resources, parent, t, 'stand-light'); break
    case 'chandelier': buildLight(resources, parent, t, 'chandelier'); break
    case 'candle': buildLight(resources, parent, t, 'candle'); break
    case 'barrel': buildBarrel(resources, parent, t, 'barrel'); break
    case 'barrel-stack': buildBarrel(resources, parent, t, 'stack'); break
    case 'keg': buildBarrel(resources, parent, t, 'keg'); break
    case 'crate': buildCrate(resources, parent, layout, t, 'crate'); break
    case 'crate-stack': buildCrate(resources, parent, layout, t, 'stack'); break
    case 'chest': buildCrate(resources, parent, layout, t, 'chest'); break
    case 'bed': buildBed(resources, parent, layout, t); break
    case 'bunk-bed': buildBed(resources, parent, layout, t, true); break
    case 'mug': case 'plate': case 'bowl': case 'bottle': case 'jug': case 'bread': case 'cheese': case 'dice-cup': case 'coin-pile': case 'cutting-board': case 'pot': buildTableware(resources, parent, t, kind); break
    case 'lute': buildLute(resources, parent, t); break
    case 'sack': sphere(resources, parent, 'sack-body', material(resources, 'fabric', t.fabric), [0.4, 0.48, 0.34], [0, 0.24, 0]); round(resources, parent, 'sack-tie', material(resources, 'wood-dark', t.woodDark), 0.08, 0.1, [0, 0.52, 0]); break
    case 'basket': case 'bucket': { cone(resources, parent, kind, material(resources, 'wood', t.wood), kind === 'basket' ? 0.45 : 0.36, 0.32, [0, 0.16, 0]); ring(resources, parent, `${kind}-rim`, material(resources, 'wood-light', t.woodLight), kind === 'basket' ? 0.45 : 0.36, 0.045, [0, 0.33, 0]); break }
    case 'broom': buildWallOrSign(resources, parent, layout, t, kind); break
    case 'washbasin': buildWashbasin(resources, parent, t); break
    case 'stairs-up': case 'stairs-down': for (let i = 0; i < 5; i += 1) cube(resources, parent, 'stair-step', material(resources, 'stone', t.stone), [Math.max(0.3, layout.width * 0.72), 0.08 + i * 0.035, Math.max(0.2, layout.depth * 0.16)], [0, i * 0.07, (i - 2) * layout.depth * 0.14]); break
    case 'tree-oak': case 'tree-pine': case 'tree-birch': case 'tree-dead': case 'tree-stump': case 'tree-spruce': case 'bush': case 'shrub': case 'rock-small': case 'boulder': case 'stalagmite': case 'rubble-heap': case 'fallen-log': buildNatural(resources, parent, layout, t, kind); break
    case 'woodpile': for (const z of [-0.14, 0, 0.14]) { const log = round(resources, parent, 'woodpile-log', material(resources, 'wood', t.wood), 0.18, 0.76, [0, 0.12 + Math.abs(z), z]); log.rotation.z = Math.PI / 2 } break
    case 'cart': case 'wagon-wheel': case 'hitching-post': case 'water-trough': case 'well': case 'lamp-post': case 'signpost': case 'haystack': case 'market-stall': case 'village-fence': case 'milestone': case 'roadside-shrine': buildSettlement(resources, parent, layout, t, kind); break
    case 'grass-tuft': case 'flowers': case 'fern': case 'path-stone': case 'mosaic': case 'rug': case 'floor-stain': case 'trapdoor': buildGroundDetail(resources, parent, layout, t, kind); break
    case 'pillar': case 'altar': case 'statue': case 'offering-bowl': case 'urn': case 'prayer-bench': case 'reliquary': case 'sarcophagus': case 'grave': case 'bone-pile': case 'crypt-niche': case 'mushroom-cluster': case 'cave-pool': case 'ore-vein': case 'temple-banner': case 'cobweb': case 'banner': case 'wall-banner': buildTempleCrypt(resources, parent, layout, t, kind); break
    case 'sign-board': buildWallOrSign(resources, parent, layout, t, kind); break
    default: buildUnknown(resources, parent, t)
  }
}

function buildUnknown(resources: Resources, parent: THREE.Group, t: Tones) {
  const marker = material(resources, 'unknown', t.woodLight, { emissive: t.woodDark, emissiveIntensity: 0.25 })
  rock(resources, parent, 'unknown-marker', marker, [0.18, 0.18, 0.18], [0, 0.09, 0])
  cube(resources, parent, 'unknown-cross-x', marker, [0.32, 0.025, 0.025], [0, 0.09, 0], [0, 0.7, 0], false)
}

function applyState(resources: Resources, parent: THREE.Group, layout: Layout, t: Tones, state: string) {
  if (state === 'toppled') {
    // Поворот вокруг основания оставляет авторитетные XY и футпринт нетронутыми.
    parent.rotation.z = 0.92
  } else if (state === 'burned') {
    flat(resources, parent, 'burned-ash', material(resources, 'burned', t.shadow, { transparent: true, opacity: 0.72 }), layout.width * 0.78, layout.depth * 0.62, 0.035)
    rock(resources, parent, 'burned-ember', material(resources, 'burned-ember', t.ember, { emissive: t.ember, emissiveIntensity: 0.36 }), [0.12, 0.07, 0.12], [0.12, 0.09, 0])
  } else if (state === 'broken') {
    const debris = material(resources, 'broken', t.woodDark)
    rock(resources, parent, 'broken-fragment', debris, [0.2, 0.1, 0.14], [layout.width * 0.25, 0.06, layout.depth * 0.24])
    rock(resources, parent, 'broken-fragment', debris, [0.14, 0.08, 0.1], [-layout.width * 0.26, 0.05, -layout.depth * 0.2])
  }
}

/** Возвращает точный вид семантической модели для канонического или legacy id. */
export function environmentModelKind(assetId: string): string | null {
  return MODEL_KINDS[resolvePropAssetId(assetId)] ?? null
}

/** Общий процедурный каталог окружения. Видимость и свет принадлежат вызывающему коду. */
export function createEnvironmentModels(palette: BoardPalette, assets?: PropModelAssets | null): { create: (prop: TacticalProp) => THREE.Group; dispose: () => void } {
  const owned = resources()
  const t = tones(palette)
  let disposed = false
  return {
    create(prop) {
      if (disposed) throw new Error('Каталог моделей окружения уже освобождён')
      const layout = propVisualLayout(prop)
      const canonical = resolvePropAssetId(prop.assetId)
      const kind = MODEL_KINDS[canonical] ?? 'unknown'
      const group = new THREE.Group()
      group.name = `prop:${prop.id}`
      group.userData.modelKind = kind
      group.userData.assetId = prop.assetId
      group.userData.state = prop.state
      const lightHeight = LIGHT_HEIGHTS[kind]
      if (lightHeight !== undefined) group.userData.lightHeight = lightHeight
      group.position.set(layout.x, 0, layout.y)
      group.rotation.y = -layout.rotation * Math.PI / 180
      group.scale.setScalar(layout.scale)
      const entry = propModelFor(assets?.catalog, canonical, prop.id)
      const template = entry ? assets?.models.get(entry.key) : null
      if (template) {
        const model = template.clone(true)
        model.updateMatrixWorld(true)
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const fit = Math.min(layout.width / Math.max(.01, size.x), layout.depth / Math.max(.01, size.z)) * PROP_FOOTPRINT_FILL
        const fitted = new THREE.Group()
        model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
        fitted.add(model)
        fitted.scale.setScalar(fit)
        group.add(fitted)
        group.userData.modelKey = entry!.key
        group.userData.modelSource = 'glb'
        if (lightHeight !== undefined) group.userData.lightHeight = size.y * fit * .8
      } else if (kind === 'unknown') buildUnknown(owned, group, t)
      else buildModel(owned, group, layout, t, kind)
      if (prop.state === 'toppled' || prop.state === 'burned' || prop.state === 'broken') applyState(owned, group, layout, t, prop.state)
      return group
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const texture of owned.textures) texture.dispose()
      for (const materialValue of owned.materials) materialValue.dispose()
      for (const geometryValue of owned.geometries) geometryValue.dispose()
      owned.textures.clear(); owned.materials.clear(); owned.geometries.clear()
      owned.geometryPool.clear(); owned.materialPool.clear()
    },
  }
}
