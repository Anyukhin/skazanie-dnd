#!/usr/bin/env node
/** Самодостаточные авторские модели домашнего реквизита для GLB-сборщика. */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

const COLORS = Object.freeze({
  wood: '#654833', woodLight: '#a4774d', woodDark: '#352920',
  stone: '#77756d', stoneLight: '#aaa18d', stoneDark: '#4b4945',
  metal: '#484946', metalLight: '#9a7844',
  fabric: '#665264', fabricLight: '#8b6b75',
  food: '#b8753f', foodLight: '#d5a35c', foodDark: '#6c3828',
  water: '#596f6b',
})

/** @typedef {{w:number,h:number}} Footprint */
/** @typedef {{assetId:string,key:string,label:string,category:string,file:string,yaw:number,textures:readonly string[],footprint:Footprint}} ExtraModelSpec */

const spec = (assetId, key, label, category, footprint, textures) => Object.freeze({
  assetId, key, label, category, file: `${key}.glb`, yaw: 0,
  textures: Object.freeze([...textures]), footprint: Object.freeze({ ...footprint }),
})

/** Параметрические модели сознательно имеют один assetId на одну запись. */
export const EXTRA_MODELS = Object.freeze([
  spec('table_royal', 'sk-household-table-royal', 'Длинный королевский стол', 'Мебель', { w: 5, h: 2 }, ['wood', 'metal']),
  spec('royal_throne', 'sk-household-royal-throne', 'Трон с высокой спинкой', 'Мебель', { w: 2, h: 2 }, ['wood', 'fabric', 'metal']),
  spec('wardrobe', 'sk-household-wardrobe', 'Деревянный шкаф', 'Мебель', { w: 2, h: 1 }, ['wood', 'metal']),
  spec('bunk_bed', 'sk-household-bunk-bed', 'Двухъярусная кровать', 'Мебель', { w: 2, h: 1 }, ['wood', 'fabric', 'metal']),
  spec('washbasin', 'sk-household-washbasin', 'Каменный умывальник', 'Мебель', { w: 1, h: 1 }, ['stone', 'metal']),
  spec('barrel_stack', 'sk-household-barrel-stack', 'Штабель бочек', 'Хранилища', { w: 2, h: 1 }, ['wood', 'metal']),
  spec('crate_stack', 'sk-household-crate-stack', 'Штабель ящиков', 'Хранилища', { w: 2, h: 1 }, ['wood', 'metal']),
  spec('basket', 'sk-household-basket', 'Плетёная корзина', 'Хранилища', { w: 1, h: 1 }, ['wood']),
  spec('broom', 'sk-household-broom', 'Метла', 'Утварь', { w: 1, h: 1 }, ['wood', 'metal']),
  spec('bowl_stew', 'sk-household-bowl-stew', 'Миска с похлёбкой', 'Утварь', { w: 1, h: 1 }, ['stone', 'food']),
  spec('jug', 'sk-household-jug', 'Глиняный кувшин', 'Утварь', { w: 1, h: 1 }, ['stone', 'metal']),
  spec('bread_loaf', 'sk-household-bread-loaf', 'Буханка хлеба', 'Утварь', { w: 1, h: 1 }, ['food']),
  spec('cheese_wheel', 'sk-household-cheese-wheel', 'Головка сыра', 'Утварь', { w: 1, h: 1 }, ['food']),
  spec('dice_cup', 'sk-household-dice-cup', 'Кубковая кружка', 'Утварь', { w: 1, h: 1 }, ['fabric', 'metal', 'wood']),
  spec('lute', 'sk-household-lute', 'Лютня', 'Утварь', { w: 1, h: 1 }, ['wood', 'metal']),
  spec('cutting_board', 'sk-household-cutting-board', 'Разделочная доска', 'Утварь', { w: 1, h: 1 }, ['wood', 'metal']),
  spec('offering_bowl', 'sk-household-offering-bowl', 'Жертвенная чаша', 'Утварь', { w: 1, h: 1 }, ['stone', 'metal']),
  spec('urn', 'sk-household-urn', 'Погребальная урна', 'Утварь', { w: 1, h: 1 }, ['stone', 'metal']),
])

const SPEC_BY_ASSET = new Map(EXTRA_MODELS.map((item) => [item.assetId, item]))

function material(name, color, options = {}) {
  const value = new THREE.MeshStandardMaterial({ color, roughness: 0.84, metalness: 0.03, ...options })
  value.name = name
  return value
}

function palette() {
  return {
    wood: material('wood', COLORS.wood),
    woodLight: material('wood', COLORS.woodLight),
    woodDark: material('wood', COLORS.woodDark),
    stone: material('stone', COLORS.stone),
    stoneLight: material('stone', COLORS.stoneLight),
    stoneDark: material('stone', COLORS.stoneDark),
    metal: material('metal', COLORS.metal, { metalness: 0.6, roughness: 0.48 }),
    metalLight: material('metal', COLORS.metalLight, { metalness: 0.7, roughness: 0.4 }),
    fabric: material('fabric', COLORS.fabric, { roughness: 0.96 }),
    fabricLight: material('fabric', COLORS.fabricLight, { roughness: 0.96 }),
    food: material('food', COLORS.food),
    foodLight: material('food', COLORS.foodLight),
    foodDark: material('food', COLORS.foodDark),
    water: material('water', COLORS.water, { roughness: 0.32 }),
  }
}

function rootFor(assetId) {
  const root = new THREE.Group()
  root.name = `household:${assetId}`
  root.userData = { assetId, recipe: 'skazanie-household-v1' }
  return root
}

function mesh(parent, name, geometry, value, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
  const object = new THREE.Mesh(geometry, value)
  object.name = name
  object.position.set(...position)
  object.rotation.set(...rotation)
  object.scale.set(...scale)
  object.castShadow = true
  object.receiveShadow = true
  parent.add(object)
  return object
}

function box(parent, name, size, position, value, rotation = [0, 0, 0]) {
  return mesh(parent, name, new THREE.BoxGeometry(...size), value, position, rotation)
}

function roundedBox(parent, name, size, position, value, radius = 0.03, rotation = [0, 0, 0]) {
  const safeRadius = Math.min(radius, ...size.map((item) => Math.max(0.001, item / 2)))
  return mesh(parent, name, new RoundedBoxGeometry(...size, 2, safeRadius), value, position, rotation)
}

function cylinder(parent, name, radiusTop, radiusBottom, height, position, value, segments = 12, rotation = [0, 0, 0]) {
  return mesh(parent, name, new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), value, position, rotation)
}

function cone(parent, name, radius, height, position, value, segments = 12, rotation = [0, 0, 0]) {
  return cylinder(parent, name, 0, radius, height, position, value, segments, rotation)
}

function sphere(parent, name, size, position, value, rotation = [0, 0, 0]) {
  return mesh(parent, name, new THREE.SphereGeometry(0.5, 14, 10), value, position, rotation, size)
}

function torus(parent, name, radius, tube, position, value, rotation = [0, 0, 0]) {
  return mesh(parent, name, new THREE.TorusGeometry(radius, tube, 8, 18), value, position, rotation)
}

function tube(parent, name, points, radius, value, tubularSegments = 12) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)))
  return mesh(parent, name, new THREE.TubeGeometry(curve, tubularSegments, radius, 6, false), value)
}

function lathe(parent, name, profile, value, segments = 18) {
  return mesh(parent, name, new THREE.LatheGeometry(profile.map(([radius, y]) => new THREE.Vector2(radius, y)), segments), value)
}

function freeSurface(parent, y, name = 'surface-top') {
  const node = new THREE.Group()
  node.name = name
  node.position.y = y
  node.userData = { role: 'support-surface', clearForProps: true }
  parent.add(node)
  return node
}

/** Нормализует свежий рецепт по полу и центру, не трогая вложенные pivot-ы. */
function finish(root, assetId) {
  root.name = `household:${assetId}`
  const item = SPEC_BY_ASSET.get(assetId)
  root.userData = {
    assetId,
    recipe: 'skazanie-household-v1',
    footprint: item ? { ...item.footprint } : undefined,
  }
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root)
  const shift = new THREE.Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    bounds.min.y,
    (bounds.min.z + bounds.max.z) / 2,
  )
  for (const child of root.children) child.position.sub(shift)
  root.updateMatrixWorld(true)
  return root
}

function makeCask(parent, prefix, x, bottom, z, height, radius, wood, darkWood, metal) {
  cylinder(parent, `${prefix}-body`, radius, radius * 0.96, height, [x, bottom + height / 2, z], wood, 14)
  cylinder(parent, `${prefix}-top`, radius * 0.84, radius * 0.84, 0.025, [x, bottom + height - 0.012, z], darkWood, 14)
  cylinder(parent, `${prefix}-bottom`, radius * 0.84, radius * 0.84, 0.025, [x, bottom + 0.012, z], darkWood, 14)
  for (const offset of [0.16, height / 2, height - 0.16]) {
    torus(parent, `${prefix}-hoop`, radius * 0.99, 0.018, [x, bottom + offset, z], metal, [Math.PI / 2, 0, 0])
  }
}

function makeCrate(parent, prefix, x, bottom, z, size, wood, light, dark, metal, rotation = 0) {
  const depth = size * 0.9
  roundedBox(parent, `${prefix}-body`, [size, size, depth], [x, bottom + size / 2, z], wood, 0.035, [0, rotation, 0])
  const frontZ = z + Math.cos(rotation) * depth / 2 + Math.sin(rotation) * size / 2
  const sideX = x + Math.cos(rotation) * size / 2 - Math.sin(rotation) * depth / 2
  for (const y of [bottom + size * 0.28, bottom + size * 0.63]) {
    box(parent, `${prefix}-front-plank`, [size * 0.82, 0.055, 0.035], [x, y, frontZ + 0.01], light, [0, rotation, 0])
  }
  box(parent, `${prefix}-cross`, [0.055, size * 0.62, 0.035], [sideX, bottom + size / 2, frontZ + 0.015], dark, [0, rotation, 0])
  roundedBox(parent, `${prefix}-lid`, [size + 0.04, 0.06, depth + 0.04], [x, bottom + size + 0.025, z], light, 0.018, [0, rotation, 0])
  for (const dx of [-1, 1]) for (const dz of [-1, 1]) {
    const localX = dx * (size / 2 - 0.055), localZ = dz * (depth / 2 - 0.045)
    const worldX = x + Math.cos(rotation) * localX - Math.sin(rotation) * localZ
    const worldZ = z + Math.sin(rotation) * localX + Math.cos(rotation) * localZ
    box(parent, `${prefix}-corner`, [0.045, size * 0.9, 0.045], [worldX, bottom + size / 2, worldZ], metal, [0, rotation, 0])
  }
}

function buildTableRoyal() {
  const root = rootFor('table_royal')
  const p = palette()
  const width = 3.48, depth = 1.12
  roundedBox(root, 'table-royal-top', [width, 0.13, depth], [0, 1.04, 0], p.woodLight, 0.045)
  box(root, 'table-royal-apron-front', [width - 0.22, 0.17, 0.09], [0, 0.92, depth / 2 - 0.055], p.wood)
  box(root, 'table-royal-apron-back', [width - 0.22, 0.17, 0.09], [0, 0.92, -depth / 2 + 0.055], p.wood)
  box(root, 'table-royal-apron-left', [0.09, 0.17, depth - 0.16], [-width / 2 + 0.11, 0.92, 0], p.wood)
  box(root, 'table-royal-apron-right', [0.09, 0.17, depth - 0.16], [width / 2 - 0.11, 0.92, 0], p.wood)
  for (const x of [-1.48, 1.48]) for (const z of [-0.39, 0.39]) {
    box(root, 'table-royal-leg', [0.15, 0.87, 0.15], [x, 0.47, z], p.woodDark)
    cylinder(root, 'table-royal-foot', 0.13, 0.11, 0.07, [x, 0.055, z], p.metal, 10)
    box(root, 'table-royal-knee', [0.2, 0.08, 0.2], [x, 0.86, z], p.woodLight)
  }
  for (const x of [-0.8, -0.27, 0.27, 0.8]) {
    box(root, 'table-royal-plank-seam', [0.012, 0.008, depth - 0.18], [x, 1.112, 0], p.woodDark)
  }
  box(root, 'table-royal-inlay-front', [1.35, 0.022, 0.025], [0, 1.117, depth / 2 - 0.11], p.metalLight)
  box(root, 'table-royal-inlay-back', [1.35, 0.022, 0.025], [0, 1.117, -depth / 2 + 0.11], p.metalLight)
  freeSurface(root, 1.14)
  return root
}

function buildRoyalThrone() {
  const root = rootFor('royal_throne')
  const p = palette()
  const back = new THREE.Group()
  back.name = 'throne-back'
  root.add(back)
  roundedBox(back, 'throne-back-panel', [0.78, 1.08, 0.12], [0, 1.25, -0.31], p.wood, 0.03)
  box(back, 'throne-back-upholstery', [0.61, 0.78, 0.035], [0, 1.19, -0.377], p.fabric)
  box(back, 'throne-back-crest', [0.28, 0.22, 0.04], [0, 1.71, -0.39], p.metalLight)
  cone(back, 'throne-finial-left', 0.07, 0.16, [-0.32, 1.79, -0.31], p.metalLight, 8)
  cone(back, 'throne-finial-right', 0.07, 0.16, [0.32, 1.79, -0.31], p.metalLight, 8)
  roundedBox(root, 'throne-seat-frame', [0.84, 0.2, 0.7], [0, 0.62, 0.02], p.woodDark, 0.035)
  roundedBox(root, 'throne-seat-cushion', [0.7, 0.14, 0.57], [0, 0.79, 0.01], p.fabricLight, 0.045)
  for (const side of [-1, 1]) for (const front of [-1, 1]) {
    // Ножка действительно связывает пол с нижней гранью seat-frame, без
    // видимого зазора между y=.10 и y=.52.
    box(root, 'throne-leg', [0.11, 0.42, 0.11], [side * 0.35, 0.31, front * 0.27], p.woodDark)
  }
  for (const side of [-1, 1]) {
    box(root, 'throne-arm-post', [0.13, 0.76, 0.13], [side * 0.42, 0.78, -0.02], p.woodDark)
    roundedBox(root, 'throne-arm-rest', [0.15, 0.12, 0.66], [side * 0.42, 1.08, 0.02], p.woodLight, 0.035)
    cylinder(root, 'throne-front-finial', 0.055, 0.07, 0.13, [side * 0.42, 1.205, 0.28], p.metalLight, 8)
  }
  for (const side of [-1, 1]) {
    box(root, 'throne-front-foot', [0.15, 0.1, 0.15], [side * 0.35, 0.05, 0.27], p.woodDark)
    box(root, 'throne-back-foot', [0.15, 0.1, 0.15], [side * 0.35, 0.05, -0.27], p.woodDark)
  }
  box(root, 'throne-carving-vertical', [0.045, 0.33, 0.03], [0, 1.2, -0.402], p.metalLight)
  box(root, 'throne-carving-crossbar', [0.2, 0.045, 0.03], [0, 1.2, -0.402], p.metalLight)
  return root
}

function buildWardrobe() {
  const root = rootFor('wardrobe')
  const p = palette()
  const width = 1.26, depth = 0.58, height = 1.82
  roundedBox(root, 'wardrobe-case', [width, height, depth], [0, height / 2, 0], p.woodDark, 0.035)
  box(root, 'wardrobe-backboard', [width - 0.15, height - 0.14, 0.045], [0, height / 2, -depth / 2 - 0.018], p.wood)
  box(root, 'wardrobe-crown', [width + 0.08, 0.1, depth + 0.04], [0, height + 0.05, 0], p.woodLight)
  box(root, 'wardrobe-base', [width + 0.04, 0.09, depth + 0.02], [0, 0.045, 0], p.woodLight)
  for (const y of [0.64, 1.2]) box(root, 'wardrobe-inner-shelf', [width - 0.2, 0.055, depth - 0.12], [0, y, 0.02], p.woodLight)
  const doors = new THREE.Group()
  doors.name = 'hinge-lid'
  doors.userData = { animated: true, pivotRole: 'wardrobe-front-doors' }
  root.add(doors)
  for (const side of [-1, 1]) {
    const door = new THREE.Group()
    door.name = `wardrobe-door-${side < 0 ? 'left' : 'right'}`
    door.userData = { animated: true, pivotRole: side < 0 ? 'left-hinge' : 'right-hinge' }
    doors.add(door)
    const x = side * 0.32
    roundedBox(door, 'wardrobe-door-panel', [0.59, 1.58, 0.07], [x, 0.92, depth / 2 + 0.015], p.wood, 0.025)
    box(door, 'wardrobe-door-inset', [0.43, 1.18, 0.025], [x, 0.92, depth / 2 + 0.058], p.woodLight)
    box(door, 'wardrobe-door-divider', [0.39, 0.035, 0.028], [x, 0.92, depth / 2 + 0.077], p.woodDark)
    box(door, 'wardrobe-door-divider', [0.035, 1.1, 0.028], [x, 0.92, depth / 2 + 0.077], p.woodDark)
    cylinder(door, 'wardrobe-hinge', 0.025, 0.025, 0.14, [x + side * 0.255, 0.45, depth / 2 + 0.08], p.metal, 8)
    cylinder(door, 'wardrobe-hinge', 0.025, 0.025, 0.14, [x + side * 0.255, 1.38, depth / 2 + 0.08], p.metal, 8)
    cylinder(door, `wardrobe-handle-${side < 0 ? 'left' : 'right'}`, 0.025, 0.025, 0.13, [x - side * 0.08, 0.9, depth / 2 + 0.1], p.metalLight, 8, [Math.PI / 2, 0, 0])
  }
  return root
}

function buildBunkBed() {
  const root = rootFor('bunk_bed')
  const p = palette()
  const width = 0.96, length = 1.9
  for (const x of [-0.78, 0.78]) for (const z of [-0.41, 0.41]) {
    box(root, 'bunk-bed-post', [0.12, 2.02, 0.12], [x, 1.01, z], p.woodDark)
    cylinder(root, 'bunk-bed-post-cap', 0.075, 0.09, 0.1, [x, 2.06, z], p.metalLight, 10)
  }
  for (const y of [0.52, 1.42]) {
    roundedBox(root, 'bunk-bed-mattress', [1.58, 0.16, 0.82], [0, y, 0], p.fabricLight, 0.05)
    box(root, 'bunk-bed-side-rail-left', [length, 0.25, 0.08], [0, y - 0.02, -0.46], p.wood)
    box(root, 'bunk-bed-side-rail-right', [length, 0.25, 0.08], [0, y - 0.02, 0.46], p.wood)
    box(root, 'bunk-bed-foot-rail', [0.08, 0.23, width], [0.85, y - 0.02, 0], p.wood)
  }
  for (const y of [0.62, 1.52]) roundedBox(root, 'bunk-bed-pillow', [0.28, 0.09, 0.62], [-0.61, y + 0.13, 0], p.fabric, 0.045)
  for (const y of [0.28, 0.6, 0.92, 1.24, 1.56]) {
    box(root, 'bunk-bed-ladder-rung', [0.43, 0.07, 0.07], [0.37, y, 0.46], p.woodLight)
  }
  box(root, 'bunk-bed-ladder-left', [0.07, 1.48, 0.07], [0.18, 0.93, 0.46], p.woodLight)
  box(root, 'bunk-bed-ladder-right', [0.07, 1.48, 0.07], [0.56, 0.93, 0.46], p.woodLight)
  return root
}

function buildWashbasin() {
  const root = rootFor('washbasin')
  const p = palette()
  cylinder(root, 'washbasin-foot', 0.34, 0.37, 0.1, [0, 0.05, 0], p.stoneDark, 14)
  cylinder(root, 'washbasin-pedestal', 0.2, 0.27, 0.48, [0, 0.32, 0], p.stone, 14)
  lathe(root, 'washbasin-basin', [[0.08, 0.52], [0.33, 0.52], [0.4, 0.59], [0.38, 0.7], [0.31, 0.79]], p.stoneLight, 22)
  torus(root, 'washbasin-rim', 0.345, 0.038, [0, 0.78, 0], p.stone, [Math.PI / 2, 0, 0])
  cylinder(root, 'washbasin-drain', 0.07, 0.07, 0.018, [0, 0.535, 0.02], p.metal, 12)
  const faucet = new THREE.Group()
  faucet.name = 'washbasin-faucet'
  root.add(faucet)
  cylinder(faucet, 'washbasin-faucet-base', 0.07, 0.08, 0.06, [0, 0.82, -0.16], p.metal, 12)
  cylinder(faucet, 'washbasin-faucet-neck', 0.035, 0.045, 0.24, [0, 0.94, -0.16], p.metal, 10)
  tube(faucet, 'washbasin-faucet-spout', [[0, 1.03, -0.16], [0, 1.03, -0.05], [0, 0.95, 0.02]], 0.035, p.metal, 10)
  freeSurface(root, 0.82)
  return root
}

function buildBarrelStack() {
  const root = rootFor('barrel_stack')
  const p = palette()
  makeCask(root, 'barrel-stack', -0.31, 0.04, 0, 0.86, 0.3, p.wood, p.woodDark, p.metal)
  makeCask(root, 'barrel-stack-right', 0.31, 0.04, 0, 0.86, 0.3, p.wood, p.woodDark, p.metal)
  makeCask(root, 'barrel-stack-top', 0, 0.88, 0.02, 0.55, 0.3, p.woodLight, p.woodDark, p.metalLight)
  return root
}

function buildCrateStack() {
  const root = rootFor('crate_stack')
  const p = palette()
  makeCrate(root, 'crate-stack', -0.31, 0.03, 0, 0.58, p.wood, p.woodLight, p.woodDark, p.metal, -0.03)
  makeCrate(root, 'crate-stack-right', 0.31, 0.03, 0, 0.58, p.wood, p.woodLight, p.woodDark, p.metal, 0.03)
  makeCrate(root, 'crate-stack-top', 0, 0.63, 0.03, 0.58, p.woodLight, p.wood, p.woodDark, p.metal, -0.02)
  return root
}

function buildBasket() {
  const root = rootFor('basket')
  const p = palette()
  cylinder(root, 'basket-base', 0.22, 0.25, 0.05, [0, 0.025, 0], p.woodDark, 16)
  lathe(root, 'basket-body', [[0.22, 0.04], [0.3, 0.09], [0.33, 0.22], [0.32, 0.39], [0.28, 0.5]], p.wood, 20)
  torus(root, 'basket-rim', 0.285, 0.035, [0, 0.5, 0], p.woodLight, [Math.PI / 2, 0, 0])
  for (const y of [0.17, 0.31, 0.43]) torus(root, 'basket-weave-band', 0.315, 0.012, [0, y, 0], p.woodLight, [Math.PI / 2, 0, 0])
  for (const angle of [0, Math.PI / 3, (2 * Math.PI) / 3, Math.PI, (4 * Math.PI) / 3, (5 * Math.PI) / 3]) {
    const x = Math.cos(angle) * 0.29, z = Math.sin(angle) * 0.29
    box(root, 'basket-weave-stave', [0.018, 0.42, 0.018], [x, 0.27, z], p.woodLight, [0, -angle, 0])
  }
  tube(root, 'basket-handle', [[-0.27, 0.38, 0], [-0.3, 0.69, 0], [0, 0.76, 0], [0.3, 0.69, 0], [0.27, 0.38, 0]], 0.025, p.woodDark, 18)
  return root
}

function buildBroom() {
  const root = rootFor('broom')
  const p = palette()
  cylinder(root, 'broom-handle', 0.022, 0.028, 1.05, [0, 0.72, 0], p.woodLight, 10)
  cylinder(root, 'broom-grip', 0.032, 0.032, 0.18, [0, 1.24, 0], p.woodDark, 10)
  cone(root, 'broom-bristles', 0.095, 0.28, [0, 0.16, 0], p.wood, 12)
  torus(root, 'broom-binding', 0.065, 0.014, [0, 0.29, 0], p.metal, [Math.PI / 2, 0, 0])
  for (const x of [-0.045, 0, 0.045]) box(root, 'broom-bristle-groove', [0.012, 0.2, 0.012], [x, 0.15, 0.01], p.woodDark, [0.05, 0, 0])
  return root
}

function buildBowlStew() {
  const root = rootFor('bowl_stew')
  const p = palette()
  cylinder(root, 'bowl-stew-foot', 0.13, 0.15, 0.05, [0, 0.025, 0], p.stoneDark, 14)
  lathe(root, 'bowl-stew-vessel', [[0.06, 0.04], [0.17, 0.04], [0.22, 0.1], [0.22, 0.18], [0.18, 0.235]], p.stoneLight, 20)
  torus(root, 'bowl-stew-rim', 0.185, 0.024, [0, 0.225, 0], p.stone, [Math.PI / 2, 0, 0])
  cylinder(root, 'bowl-stew-surface', 0.165, 0.17, 0.02, [0, 0.22, 0], p.foodDark, 16)
  for (const [x, z, size] of [[-0.07, 0.04, 0.028], [0.05, 0.07, 0.022], [0.08, -0.04, 0.025], [-0.03, -0.08, 0.018]]) {
    sphere(root, 'bowl-stew-garnish', [size, size * 0.55, size], [x, 0.243, z], p.foodLight)
  }
  return root
}

function buildJug() {
  const root = rootFor('jug')
  const p = palette()
  lathe(root, 'jug-body', [[0.09, 0.04], [0.16, 0.07], [0.19, 0.16], [0.18, 0.36], [0.14, 0.47], [0.09, 0.53]], p.stoneLight, 20)
  torus(root, 'jug-rim', 0.09, 0.022, [0, 0.54, 0], p.metalLight, [Math.PI / 2, 0, 0])
  tube(root, 'jug-handle', [[0.14, 0.43, 0], [0.28, 0.5, 0], [0.33, 0.34, 0], [0.2, 0.2, 0]], 0.03, p.stone, 16)
  tube(root, 'jug-spout', [[-0.14, 0.36, 0], [-0.25, 0.42, 0], [-0.34, 0.5, 0]], 0.035, p.stone, 12)
  cylinder(root, 'jug-spout-lip', 0.046, 0.05, 0.03, [-0.34, 0.5, 0], p.metalLight, 10, [0, 0, Math.PI / 2])
  box(root, 'jug-band', [0.34, 0.025, 0.025], [0, 0.28, 0.17], p.metalLight)
  return root
}

function buildBreadLoaf() {
  const root = rootFor('bread_loaf')
  const p = palette()
  sphere(root, 'bread-loaf-body', [0.68, 0.2, 0.36], [0, 0.11, 0], p.foodLight)
  sphere(root, 'bread-loaf-end', [0.25, 0.15, 0.29], [-0.24, 0.1, 0], p.food)
  for (const [x, angle] of [[-0.14, -0.2], [0.02, 0.05], [0.18, 0.23]]) {
    box(root, 'bread-score', [0.12, 0.014, 0.05], [x, 0.205, 0], p.food, [0, 0, angle])
  }
  return root
}

function buildCheeseWheel() {
  const root = rootFor('cheese_wheel')
  const p = palette()
  cylinder(root, 'cheese-wheel-body', 0.21, 0.2, 0.19, [0, 0.095, 0], p.foodLight, 18)
  torus(root, 'cheese-wheel-rim', 0.2, 0.018, [0, 0.19, 0], p.food, [Math.PI / 2, 0, 0])
  for (const [x, z, size] of [[-0.08, 0.06, 0.028], [0.08, 0.08, 0.023], [0.03, -0.08, 0.025], [-0.1, -0.04, 0.018]]) {
    sphere(root, 'cheese-wheel-hole', [size, size * 0.7, size], [x, 0.2, z], p.foodDark)
  }
  cylinder(root, 'cheese-wheel-band', 0.205, 0.205, 0.025, [0, 0.09, 0], p.food, 18)
  return root
}

function buildDiceCup() {
  const root = rootFor('dice_cup')
  const p = palette()
  lathe(root, 'dice-cup-body', [[0.1, 0.03], [0.14, 0.04], [0.16, 0.27], [0.14, 0.32]], p.fabric, 18)
  torus(root, 'dice-cup-rim', 0.145, 0.018, [0, 0.315, 0], p.metalLight, [Math.PI / 2, 0, 0])
  torus(root, 'dice-cup-base', 0.11, 0.014, [0, 0.04, 0], p.metal, [Math.PI / 2, 0, 0])
  box(root, 'dice-cup-strap', [0.035, 0.2, 0.018], [0.14, 0.16, 0], p.metalLight, [0, 0.08, 0])
  roundedBox(root, 'dice-cup-die', [0.09, 0.09, 0.09], [-0.04, 0.34, 0.02], p.woodLight, 0.012, [0.1, 0.2, 0.1])
  roundedBox(root, 'dice-cup-die', [0.08, 0.08, 0.08], [0.05, 0.36, -0.03], p.wood, 0.012, [0.2, 0.1, 0.3])
  return root
}

function buildLute() {
  const root = rootFor('lute')
  const p = palette()
  sphere(root, 'lute-body-lower', [0.44, 0.48, 0.18], [0, 0.25, 0], p.woodLight)
  sphere(root, 'lute-body-upper', [0.32, 0.28, 0.15], [0, 0.55, 0], p.wood)
  box(root, 'lute-waist', [0.12, 0.19, 0.12], [0, 0.4, 0], p.wood)
  torus(root, 'lute-soundhole-rim', 0.07, 0.018, [0, 0.31, 0.097], p.metalLight, [Math.PI / 2, 0, 0])
  cylinder(root, 'lute-soundhole', 0.055, 0.055, 0.02, [0, 0.31, 0.1], p.woodDark, 16, [Math.PI / 2, 0, 0])
  box(root, 'lute-neck', [0.08, 0.39, 0.06], [0, 0.81, 0], p.woodDark)
  box(root, 'lute-fingerboard', [0.065, 0.36, 0.025], [0, 0.81, 0.041], p.wood)
  box(root, 'lute-pegbox', [0.16, 0.14, 0.08], [0, 1.04, 0], p.woodDark, [0, 0, -0.08])
  for (const y of [0.66, 0.73, 0.8, 0.87, 0.94]) box(root, 'lute-fret', [0.075, 0.012, 0.035], [0, y, 0.058], p.metal)
  for (const x of [-0.022, 0, 0.022]) box(root, 'lute-string', [0.006, 0.67, 0.006], [x, 0.68, 0.075], p.metalLight)
  for (const side of [-1, 1]) sphere(root, 'lute-tuning-peg', [0.065, 0.035, 0.03], [side * 0.1, 1.04, 0], p.metal)
  return root
}

function buildCuttingBoard() {
  const root = rootFor('cutting_board')
  const p = palette()
  roundedBox(root, 'cutting-board-body', [0.62, 0.08, 0.34], [0, 0.05, 0], p.woodLight, 0.035)
  for (const x of [-0.19, 0, 0.19]) box(root, 'cutting-board-plank-seam', [0.012, 0.01, 0.27], [x, 0.096, 0], p.woodDark)
  torus(root, 'cutting-board-handle-hole', 0.045, 0.012, [0.24, 0.097, 0], p.metal, [Math.PI / 2, 0, 0])
  box(root, 'cutting-board-handle', [0.1, 0.08, 0.2], [0.29, 0.05, 0], p.wood, [0, 0, 0.04])
  box(root, 'cutting-board-end-grain', [0.04, 0.06, 0.27], [-0.29, 0.05, 0], p.woodDark)
  return root
}

function buildOfferingBowl() {
  const root = rootFor('offering_bowl')
  const p = palette()
  cylinder(root, 'offering-bowl-foot', 0.2, 0.23, 0.07, [0, 0.035, 0], p.stoneDark, 16)
  cylinder(root, 'offering-bowl-stem', 0.09, 0.13, 0.18, [0, 0.15, 0], p.stone, 14)
  lathe(root, 'offering-bowl-vessel', [[0.07, 0.21], [0.2, 0.22], [0.27, 0.29], [0.26, 0.42], [0.22, 0.48]], p.stoneLight, 22)
  torus(root, 'offering-bowl-rim', 0.23, 0.028, [0, 0.47, 0], p.metalLight, [Math.PI / 2, 0, 0])
  torus(root, 'offering-bowl-inlay', 0.255, 0.012, [0, 0.33, 0], p.metal, [Math.PI / 2, 0, 0])
  for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    box(root, 'offering-bowl-carving', [0.025, 0.1, 0.02], [Math.cos(angle) * 0.255, 0.34, Math.sin(angle) * 0.255], p.metalLight, [0, -angle, 0])
  }
  return root
}

function buildUrn() {
  const root = rootFor('urn')
  const p = palette()
  cylinder(root, 'urn-foot', 0.17, 0.2, 0.08, [0, 0.04, 0], p.stoneDark, 16)
  lathe(root, 'urn-body', [[0.08, 0.08], [0.19, 0.1], [0.24, 0.2], [0.22, 0.43], [0.17, 0.53], [0.115, 0.61]], p.stoneLight, 22)
  cylinder(root, 'urn-neck', 0.115, 0.13, 0.1, [0, 0.65, 0], p.stone, 16)
  torus(root, 'urn-rim', 0.14, 0.027, [0, 0.71, 0], p.metalLight, [Math.PI / 2, 0, 0])
  cylinder(root, 'urn-lid', 0.11, 0.08, 0.035, [0, 0.735, 0], p.stoneLight, 14)
  cone(root, 'urn-finial', 0.045, 0.06, [0, 0.78, 0], p.metalLight, 10)
  torus(root, 'urn-band', 0.222, 0.012, [0, 0.36, 0], p.metal, [Math.PI / 2, 0, 0])
  for (const side of [-1, 1]) {
    tube(root, 'urn-handle', [[side * 0.17, 0.54, 0], [side * 0.29, 0.57, 0], [side * 0.3, 0.38, 0], [side * 0.2, 0.28, 0]], 0.025, p.metal, 14)
  }
  return root
}

/** @param {string} assetId @returns {THREE.Group|null} */
export function createExtraModel(assetId) {
  if (!SPEC_BY_ASSET.has(assetId)) return null
  let model
  switch (assetId) {
    case 'table_royal': model = buildTableRoyal(); break
    case 'royal_throne': model = buildRoyalThrone(); break
    case 'wardrobe': model = buildWardrobe(); break
    case 'bunk_bed': model = buildBunkBed(); break
    case 'washbasin': model = buildWashbasin(); break
    case 'barrel_stack': model = buildBarrelStack(); break
    case 'crate_stack': model = buildCrateStack(); break
    case 'basket': model = buildBasket(); break
    case 'broom': model = buildBroom(); break
    case 'bowl_stew': model = buildBowlStew(); break
    case 'jug': model = buildJug(); break
    case 'bread_loaf': model = buildBreadLoaf(); break
    case 'cheese_wheel': model = buildCheeseWheel(); break
    case 'dice_cup': model = buildDiceCup(); break
    case 'lute': model = buildLute(); break
    case 'cutting_board': model = buildCuttingBoard(); break
    case 'offering_bowl': model = buildOfferingBowl(); break
    case 'urn': model = buildUrn(); break
    default: return null
  }
  return finish(model, assetId)
}
