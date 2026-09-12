#!/usr/bin/env node
/** Авторские low-poly модели носимой брони и щита для 3D-аватара. */

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const CATALOG_PREFIX = 'srd_5_2_1:'

const COLORS = Object.freeze({
  cloth: '#6d4d5d',
  clothLight: '#a66f72',
  clothDark: '#3d3040',
  leather: '#68452f',
  leatherLight: '#a87549',
  leatherDark: '#38261e',
  steel: '#66727a',
  steelLight: '#a3aeb0',
  steelDark: '#303b45',
  steelBlue: '#536a78',
  brass: '#b0823e',
  fur: '#7a5f4c',
  furLight: '#b08a68',
  opening: '#17191c',
})

/** Каноническая нейтральная поза гуманоидной фигуры в мировых единицах (рост около 1,4). */
export const ARMOR_PART_POSES = Object.freeze({
  chest: Object.freeze([0, 0.91, 0]),
  waist: Object.freeze([0, 0.62, 0]),
  'upper-arm-left': Object.freeze([-0.29, 0.86, 0]),
  'upper-arm-right': Object.freeze([0.29, 0.86, 0]),
  'forearm-left': Object.freeze([-0.31, 0.61, 0]),
  'forearm-right': Object.freeze([0.31, 0.61, 0]),
  'thigh-left': Object.freeze([-0.13, 0.46, 0]),
  'thigh-right': Object.freeze([0.13, 0.46, 0]),
  'shin-left': Object.freeze([-0.13, 0.2, 0]),
  'shin-right': Object.freeze([0.13, 0.2, 0]),
  'foot-left': Object.freeze([-0.13, 0.06, 0.045]),
  'foot-right': Object.freeze([0.13, 0.06, 0.045]),
  'hand-left': Object.freeze([-0.32, 0.47, 0]),
  'hand-right': Object.freeze([0.32, 0.47, 0]),
  head: Object.freeze([0, 1.24, 0]),
})

const armorCatalog = (id) => `${CATALOG_PREFIX}${id}`

const PARTS = Object.freeze({
  light: Object.freeze(['chest', 'waist', 'upper-arm-left', 'upper-arm-right', 'forearm-left', 'forearm-right', 'foot-left', 'foot-right']),
  hide: Object.freeze(['chest', 'waist', 'upper-arm-left', 'upper-arm-right', 'forearm-left', 'forearm-right', 'thigh-left', 'thigh-right', 'shin-left', 'shin-right', 'foot-left', 'foot-right']),
  shirt: Object.freeze(['chest', 'waist', 'upper-arm-left', 'upper-arm-right', 'forearm-left', 'forearm-right']),
  scale: Object.freeze(['chest', 'waist', 'upper-arm-left', 'upper-arm-right', 'forearm-left', 'forearm-right', 'thigh-left', 'thigh-right', 'shin-left', 'shin-right', 'foot-left', 'foot-right']),
  torso: Object.freeze(['chest', 'waist']),
  half: Object.freeze(['chest', 'waist', 'upper-arm-left', 'upper-arm-right', 'forearm-left', 'forearm-right', 'thigh-left', 'thigh-right', 'shin-left', 'shin-right', 'foot-left', 'foot-right']),
  heavy: Object.freeze(['chest', 'waist', 'upper-arm-left', 'upper-arm-right', 'forearm-left', 'forearm-right', 'thigh-left', 'thigh-right', 'shin-left', 'shin-right', 'foot-left', 'foot-right']),
  plate: Object.freeze(['chest', 'waist', 'upper-arm-left', 'upper-arm-right', 'forearm-left', 'forearm-right', 'thigh-left', 'thigh-right', 'shin-left', 'shin-right', 'foot-left', 'foot-right', 'hand-left', 'hand-right', 'head']),
})

function spec(key, label, catalogIds, parts, occludes = parts) {
  return Object.freeze({
    key,
    label,
    catalogIds: Object.freeze(catalogIds.map(armorCatalog)),
    parts: Object.freeze(parts.map((part) => `part:${part}`)),
    occludes: Object.freeze([...occludes]),
    source: 'original',
  })
}

/** Открытый каталог для рендера персонажа и сборщика GLB. */
export const ARMOR_MODELS = Object.freeze([
  spec('armor-padded', 'Стёганый доспех', ['padded-armor'], PARTS.light),
  spec('armor-leather', 'Кожаный доспех', ['leather-armor'], PARTS.light),
  spec('armor-studded', 'Клёпаный кожаный доспех', ['studded-leather-armor'], PARTS.light),
  spec('armor-hide', 'Шкурный доспех', ['hide-armor'], PARTS.hide),
  spec('armor-chainshirt', 'Кольчужная рубаха', ['chain-shirt'], PARTS.shirt),
  spec('armor-scalemail', 'Чешуйчатый доспех', ['scale-mail'], PARTS.scale),
  spec('armor-breastplate', 'Кираса', ['breastplate'], PARTS.torso),
  spec('armor-halfplate', 'Полулаты', ['half-plate-armor'], PARTS.half),
  spec('armor-ringmail', 'Кольчатый доспех', ['ring-mail'], PARTS.heavy),
  spec('armor-chainmail', 'Кольчуга', ['chain-mail'], PARTS.heavy),
  spec('armor-splint', 'Ламеллярный доспех', ['splint-armor'], PARTS.heavy),
  spec('armor-plate', 'Латы', ['plate-armor'], PARTS.plate),
])

export const SHIELD_MODEL = Object.freeze({
  key: 'shield',
  label: 'Щит',
  catalogIds: Object.freeze([armorCatalog('shield')]),
  parts: Object.freeze(['shield-face', 'shield-rim', 'shield-boss', 'grip']),
  occludes: Object.freeze(['off-hand', 'chest']),
  source: 'original',
})

const SPEC_BY_KEY = new Map(ARMOR_MODELS.map((item) => [item.key, item]))

function material(name, color, options = {}) {
  const value = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.82,
    metalness: 0.02,
    ...options,
  })
  value.name = name
  value.userData = { materialRole: name }
  return value
}

function palette() {
  return {
    cloth: material('cloth', COLORS.cloth, { roughness: 0.96 }),
    clothLight: material('cloth', COLORS.clothLight, { roughness: 0.96 }),
    clothDark: material('cloth', COLORS.clothDark, { roughness: 0.98 }),
    leather: material('leather', COLORS.leather, { roughness: 0.88 }),
    leatherLight: material('leather', COLORS.leatherLight, { roughness: 0.84 }),
    leatherDark: material('leather', COLORS.leatherDark, { roughness: 0.9 }),
    steel: material('steel', COLORS.steel, { roughness: 0.48, metalness: 0.76 }),
    steelLight: material('steel', COLORS.steelLight, { roughness: 0.35, metalness: 0.86 }),
    steelDark: material('steel', COLORS.steelDark, { roughness: 0.55, metalness: 0.72 }),
    steelBlue: material('steel', COLORS.steelBlue, { roughness: 0.46, metalness: 0.76 }),
    brass: material('brass', COLORS.brass, { roughness: 0.39, metalness: 0.78 }),
    fur: material('fur', COLORS.fur, { roughness: 1 }),
    furLight: material('fur', COLORS.furLight, { roughness: 1 }),
    opening: material('opening', COLORS.opening, { roughness: 1 }),
  }
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

function roundedBox(parent, name, size, position, value, radius = 0.02, rotation = [0, 0, 0]) {
  const safeRadius = Math.min(radius, ...size.map((item) => Math.max(0.001, item / 2 - 0.001)))
  return mesh(parent, name, new RoundedBoxGeometry(...size, 2, safeRadius), value, position, rotation)
}

function cylinder(parent, name, radiusTop, radiusBottom, height, position, value, segments = 10, rotation = [0, 0, 0]) {
  return mesh(parent, name, new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), value, position, rotation)
}

function sphere(parent, name, size, position, value, rotation = [0, 0, 0]) {
  return mesh(parent, name, new THREE.SphereGeometry(0.5, 10, 7), value, position, rotation, size)
}

function torus(parent, name, radius, tube, position, value, rotation = [Math.PI / 2, 0, 0]) {
  return mesh(parent, name, new THREE.TorusGeometry(radius, tube, 6, 12), value, position, rotation)
}

function addPart(root, part, build) {
  const group = new THREE.Group()
  group.name = `part:${part}`
  group.position.set(...ARMOR_PART_POSES[part])
  group.userData = { armorPart: part, canonicalPose: true }
  root.add(group)
  build(group)
  return group
}

function rootFor(key) {
  const root = new THREE.Group()
  root.name = `armor:${key}`
  root.userData = {
    key,
    recipe: 'skazanie-armor-v1',
    source: 'original',
    canonicalHeight: 1.4,
  }
  return root
}

function addChestCloth(part, p, accent = p.clothLight) {
  roundedBox(part, 'cloth-chest', [0.44, 0.34, 0.23], [0, 0, 0], p.cloth, 0.045)
  for (const x of [-0.13, 0, 0.13]) {
    box(part, 'quilt-seam-front', [0.012, 0.28, 0.008], [x, 0, 0.12], accent)
    box(part, 'quilt-seam-back', [0.012, 0.28, 0.008], [x, 0, -0.12], accent)
  }
  for (const y of [-0.11, 0, 0.11]) {
    box(part, 'quilt-seam-front-cross', [0.36, 0.012, 0.008], [0, y, 0.122], accent)
    box(part, 'quilt-seam-back-cross', [0.36, 0.012, 0.008], [0, y, -0.122], accent)
  }
  torus(part, 'cloth-neckline', 0.105, 0.012, [0, 0.15, 0.02], accent, [Math.PI / 2, 0, 0])
}

function addClothWaist(part, p, accent = p.clothLight) {
  roundedBox(part, 'cloth-waist', [0.39, 0.2, 0.2], [0, 0, 0], p.cloth, 0.035)
  for (const x of [-0.13, 0, 0.13]) box(part, 'waist-quilt-seam', [0.012, 0.15, 0.012], [x, 0, 0.105], accent)
  torus(part, 'waist-hem', 0.19, 0.014, [0, -0.085, 0], accent)
}

function addPaddedSleeve(part, p) {
  roundedBox(part, 'padded-sleeve', [0.16, 0.26, 0.15], [0, 0, 0], p.cloth, 0.035)
  for (const y of [-0.08, 0.08]) torus(part, 'padded-cuff-seam', 0.075, 0.009, [0, y, 0], p.clothLight)
  box(part, 'padded-sleeve-seam', [0.012, 0.2, 0.008], [0, 0, 0.078], p.clothLight)
}

function addPaddedFoot(part, p) {
  roundedBox(part, 'padded-boot', [0.17, 0.11, 0.24], [0, 0, 0], p.clothDark, 0.025)
  box(part, 'boot-sole', [0.17, 0.025, 0.24], [0, -0.045, 0.005], p.leatherDark)
  box(part, 'boot-strap', [0.16, 0.018, 0.018], [0, 0.025, 0.09], p.leatherLight)
}

function addLeatherCuirass(part, p, kind = 'leather') {
  const main = kind === 'dark' ? p.leatherDark : p.leather
  const edge = kind === 'dark' ? p.leather : p.leatherLight
  sphere(part, 'leather-cuirass-front', [0.45, 0.35, 0.15], [0, 0, 0.035], main)
  sphere(part, 'leather-cuirass-back', [0.43, 0.33, 0.09], [0, 0, -0.045], p.leatherDark)
  box(part, 'leather-side-strap-left', [0.025, 0.28, 0.025], [-0.2, 0, 0.04], edge)
  box(part, 'leather-side-strap-right', [0.025, 0.28, 0.025], [0.2, 0, 0.04], edge)
  torus(part, 'leather-neck-collar', 0.105, 0.014, [0, 0.145, 0.015], edge)
}

function addLeatherWaist(part, p, studded = false) {
  roundedBox(part, 'leather-waist', [0.4, 0.17, 0.21], [0, 0, 0], p.leatherDark, 0.035)
  box(part, 'leather-belt', [0.43, 0.045, 0.24], [0, 0.055, 0], p.leather)
  box(part, 'belt-buckle', [0.075, 0.075, 0.035], [0, 0.06, 0.13], studded ? p.brass : p.leatherLight)
}

function addLeatherBracer(part, p, studded = false) {
  roundedBox(part, 'leather-bracer', [0.14, 0.22, 0.13], [0, 0, 0], p.leather, 0.025)
  for (const y of [-0.075, 0.075]) box(part, 'bracer-strap', [0.15, 0.022, 0.145], [0, y, 0], p.leatherLight)
  if (studded) {
    for (const y of [-0.07, 0, 0.07]) sphere(part, 'bracer-rivet', [0.018, 0.018, 0.012], [0, y, 0.073], p.brass)
  }
}

function addLeatherFoot(part, p, heavy = false) {
  roundedBox(part, 'leather-boot', [0.18, 0.13, 0.25], [0, 0, 0], p.leatherDark, 0.03)
  box(part, 'boot-toe-cap', [0.17, 0.04, 0.12], [0, 0.025, 0.08], heavy ? p.steel : p.leather)
  torus(part, 'boot-ankle-band', 0.085, 0.012, [0, 0.035, 0], p.leatherLight)
}

function addRivets(part, p, locations) {
  for (const [x, y, z = 0.13] of locations) sphere(part, 'armor-rivet', [0.018, 0.018, 0.012], [x, y, z], p.brass)
}

function addStuddedChest(part, p) {
  addLeatherCuirass(part, p)
  for (const y of [-0.11, 0, 0.11]) {
    box(part, 'studded-front-strap', [0.36, 0.025, 0.02], [0, y, 0.115], p.leatherLight)
    addRivets(part, p, [[-0.14, y], [0, y], [0.14, y]])
  }
  box(part, 'studded-center-strap', [0.03, 0.29, 0.02], [0, 0, 0.12], p.leatherLight)
  addRivets(part, p, [[0, -0.09], [0, 0.02], [0, 0.13]])
}

function addFurChest(part, p) {
  sphere(part, 'hide-fur-front', [0.47, 0.36, 0.18], [0, 0, 0.02], p.fur)
  sphere(part, 'hide-fur-back', [0.45, 0.34, 0.1], [0, 0, -0.05], p.furLight)
  for (const side of [-1, 1]) {
    torus(part, 'hide-neck-fur', 0.11, 0.027, [side * 0.075, 0.14, 0.02], p.furLight)
    box(part, 'hide-lace', [0.018, 0.24, 0.018], [side * 0.19, 0, 0.115], p.leatherLight)
  }
  for (const x of [-0.15, -0.05, 0.05, 0.15]) box(part, 'hide-pelt-seam', [0.016, 0.28, 0.012], [x, 0, 0.125], p.furLight)
}

function addHideWaist(part, p) {
  roundedBox(part, 'hide-waist', [0.43, 0.2, 0.23], [0, 0, 0], p.fur, 0.04)
  box(part, 'hide-belt', [0.45, 0.045, 0.24], [0, 0.06, 0], p.leatherDark)
  for (const x of [-0.14, 0, 0.14]) sphere(part, 'hide-belt-bead', [0.024, 0.024, 0.018], [x, 0.06, 0.13], p.brass)
}

function addFurSleeve(part, p) {
  sphere(part, 'hide-shoulder-fur', [0.19, 0.16, 0.17], [0, 0.03, 0], p.fur)
  roundedBox(part, 'hide-sleeve', [0.15, 0.22, 0.14], [0, -0.045, 0], p.leather, 0.03)
  torus(part, 'hide-sleeve-binding', 0.073, 0.016, [0, -0.1, 0], p.furLight)
}

function addFurLeg(part, p, lower = false) {
  if (lower) {
    roundedBox(part, 'hide-greave', [0.15, 0.24, 0.15], [0, 0, 0], p.leather, 0.03)
    box(part, 'hide-greave-fur', [0.145, 0.05, 0.155], [0, 0.09, 0], p.fur)
  } else {
    sphere(part, 'hide-thigh-pelt', [0.19, 0.27, 0.18], [0, 0, 0], p.fur)
    box(part, 'hide-thigh-lace', [0.018, 0.22, 0.02], [0, 0, 0.095], p.leatherLight)
  }
}

function addRingField(part, p, width, height, rows, columns, radius = 0.026, dense = false) {
  const start = part.children.length
  if (dense) {
    radius = .012
    rows = Math.max(3, Math.ceil(height / .021))
    columns = Math.max(3, Math.ceil(width / .021))
  }
  const dx = columns === 1 ? 0 : width / (columns - 1)
  const dy = rows === 1 ? 0 : height / (rows - 1)
  const startX = -width / 2
  const startY = -height / 2
  const count = dense ? 1 : 2
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const x = startX + column * dx + ((row % 2) * dx * 0.5)
    if (Math.abs(x) > width / 2 + 0.02) continue
    const y = startY + row * dy
    for (let side = 0; side < count; side += 1) {
      const z = side === 0 ? 0.115 : -0.115
      torus(part, dense ? 'chainmail-ring' : 'ringmail-ring', radius, dense ? .003 : .006, [x, y, z], p.steel, [0, 0, 0])
    }
  }
  for (const side of [-1, 1]) {
    for (let row = 0; row < Math.max(2, Math.floor(rows / 2)); row += 1) {
      torus(part, dense ? 'chainmail-side-ring' : 'ringmail-side-ring', radius, dense ? .003 : .006, [side * (width / 2 + 0.01), startY + row * dy * 2, 0], p.steel, [0, Math.PI / 2, 0])
    }
  }
  // Плотное плетение собирается в два меша, а не в сотни отдельных draw calls.
  const rings = part.children.slice(start).filter((child) => child.isMesh)
  for (const name of new Set(rings.map((ring) => ring.name))) {
    const selected = rings.filter((ring) => ring.name === name)
    const geometries = selected.map((ring) => { ring.updateMatrix(); return ring.geometry.clone().applyMatrix4(ring.matrix) })
    const geometry = mergeGeometries(geometries)
    geometries.forEach((value) => value.dispose())
    selected.forEach((ring) => { part.remove(ring); ring.geometry.dispose() })
    mesh(part, name, geometry, p.steel)
  }
}

function addChainBase(part, p, chest = false) {
  const waist = part.userData.armorPart === 'waist'
  const width = chest ? .43 : waist ? .39 : .15
  const height = chest ? .33 : waist ? .18 : .22
  roundedBox(part, 'chainmail-underlayer', [width, height, .22], [0, 0, 0], p.steelDark, .025)
  addRingField(part, p, width - .04, height - .04, 4, 7, 0.026, true)
  if (chest) torus(part, 'chainmail-neck-ring', 0.11, 0.014, [0, 0.15, 0], p.steel)
}

function addScaleField(part, p, width, height, rows, columns) {
  const dx = width / Math.max(1, columns - 1)
  const dy = height / Math.max(1, rows - 1)
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const x = -width / 2 + column * dx + (row % 2 ? dx * 0.35 : 0)
    if (Math.abs(x) > width / 2 + 0.025) continue
    const y = -height / 2 + row * dy
    for (const z of [0.117, -0.117]) sphere(part, 'scale-overlap', [0.062, 0.048, 0.014], [x, y, z], row % 3 === 0 ? p.steelLight : p.steel)
  }
}

function addScaleChest(part, p) {
  roundedBox(part, 'scale-mail-underlayer', [0.43, 0.33, 0.2], [0, 0, 0], p.leatherDark, 0.035)
  addScaleField(part, p, 0.37, 0.27, 4, 6)
  box(part, 'scale-mail-yoke', [0.39, 0.035, 0.05], [0, 0.135, 0], p.leather)
  torus(part, 'scale-mail-neckline', 0.11, 0.015, [0, 0.15, 0], p.steelLight)
}

function addScaleWaist(part, p) {
  roundedBox(part, 'scale-mail-waist-base', [0.4, 0.19, 0.2], [0, 0, 0], p.leatherDark, 0.03)
  addScaleField(part, p, 0.35, 0.15, 2, 5)
  box(part, 'scale-mail-belt', [0.42, 0.04, 0.22], [0, 0.05, 0], p.leather)
}

function addScaleLimb(part, p, long = false) {
  roundedBox(part, 'scale-limb-underlayer', [long ? 0.16 : 0.14, long ? 0.25 : 0.21, 0.14], [0, 0, 0], p.leatherDark, 0.025)
  addScaleField(part, p, long ? 0.13 : 0.11, long ? 0.2 : 0.15, long ? 3 : 2, 2)
  torus(part, 'scale-limb-hem', long ? 0.075 : 0.065, 0.012, [0, long ? -0.1 : -0.08, 0], p.leatherLight)
}

function addCuirass(part, p, full = false) {
  sphere(part, 'breastplate-front', [0.46, 0.35, 0.17], [0, 0, 0.04], p.steel)
  sphere(part, 'breastplate-back', [0.45, 0.34, 0.11], [0, 0, -0.05], p.steelDark)
  torus(part, 'breastplate-neck-ring', 0.108, 0.014, [0, 0.15, 0.02], p.steelLight)
  for (const side of [-1, 1]) {
    box(part, 'breastplate-shoulder-strap', [0.035, 0.28, 0.04], [side * 0.17, 0, 0.08], p.leatherDark, [0, side * 0.1, 0])
    cylinder(part, 'breastplate-strap-rivet', 0.018, 0.018, 0.025, [side * 0.17, 0.08, 0.12], p.brass, 8, [Math.PI / 2, 0, 0])
  }
  if (full) {
    box(part, 'plate-center-ridge', [0.025, 0.27, 0.035], [0, 0, 0.13], p.steelLight)
    for (const y of [-0.1, 0.02, 0.13]) cylinder(part, 'plate-ridge-rivet', 0.016, 0.016, 0.018, [0, y, 0.15], p.brass, 8, [Math.PI / 2, 0, 0])
  }
}

function addPlateWaist(part, p, faulds = false) {
  roundedBox(part, 'plate-waist-belt', [0.42, 0.16, 0.22], [0, 0, 0], p.leatherDark, 0.025)
  box(part, 'plate-belt-plate', [0.4, 0.08, 0.045], [0, 0.02, 0.12], p.steel)
  box(part, 'plate-belt-buckle', [0.075, 0.075, 0.04], [0, 0.02, 0.15], p.brass)
  if (faulds) {
    for (const y of [-0.08, -0.02]) box(part, 'articulated-faulds', [0.38, 0.05, 0.2], [0, y, 0.04], p.steel, [0, 0, 0.02])
    torus(part, 'fauld-hem', 0.19, 0.014, [0, -0.11, 0.04], p.steelLight)
  }
}

function addPauldron(part, p, articulated = false) {
  sphere(part, 'pauldron-shell', [0.22, 0.16, 0.2], [0, 0.035, 0], p.steel)
  box(part, 'pauldron-shoulder-ridge', [0.15, 0.035, 0.08], [0, 0.12, 0.03], p.steelLight)
  for (const y of articulated ? [-0.06, 0, 0.06] : [0]) torus(part, 'pauldron-articulation', 0.075, 0.012, [0, y, 0.015], p.steelLight)
}

function addVambrace(part, p, articulated = false) {
  roundedBox(part, 'vambrace-shell', [0.14, 0.23, 0.14], [0, 0, 0], p.steel, 0.025)
  roundedBox(part, 'vambrace-elbow-joint', [0.12, 0.15, 0.12], [0, 0.17, 0], p.steelDark, 0.02)
  box(part, 'vambrace-ridge', [0.025, 0.2, 0.035], [0, 0, 0.085], p.steelLight)
  for (const y of articulated ? [-0.09, 0.09] : [0]) torus(part, 'vambrace-cuff', 0.07, 0.012, [0, y, 0], p.steelDark)
}

function addCuisses(part, p, articulated = false) {
  roundedBox(part, 'cuisses-shell', [0.18, 0.27, 0.17], [0, 0, 0], p.steel, 0.035)
  box(part, 'cuisses-ridge', [0.028, 0.22, 0.035], [0, 0, 0.105], p.steelLight)
  if (articulated) for (const y of [-0.08, 0.08]) cylinder(part, 'cuisses-rivet', 0.016, 0.016, 0.02, [0, y, 0.115], p.brass, 8, [Math.PI / 2, 0, 0])
}

function addGreaves(part, p, articulated = false) {
  roundedBox(part, 'greave-shell', [0.15, 0.25, 0.16], [0, 0, 0], p.steelDark, 0.025)
  box(part, 'greave-ridge', [0.03, 0.22, 0.04], [0, 0, 0.1], p.steelLight)
  if (articulated) for (const y of [-0.08, 0.08]) torus(part, 'greave-articulation', 0.072, 0.011, [0, y, 0], p.steel)
}

function addSabatons(part, p) {
  roundedBox(part, 'sabaton-shell', [0.18, 0.11, 0.26], [0, 0, 0.01], p.steel, 0.025)
  for (const z of [-0.06, 0.015, 0.09]) box(part, 'sabaton-toe-plate', [0.17, 0.025, 0.035], [0, 0.03, z], p.steelLight)
  box(part, 'sabaton-sole', [0.19, 0.025, 0.27], [0, -0.05, 0.01], p.leatherDark)
}

function addGauntlet(part, p) {
  roundedBox(part, 'gauntlet-cuff', [0.14, 0.1, 0.13], [0, 0.02, 0], p.steel, 0.022)
  for (const x of [-0.045, 0, 0.045]) box(part, 'gauntlet-finger', [0.032, 0.075, 0.055], [x, -0.05, 0.035], p.steelLight, [0.12, 0, 0])
  torus(part, 'gauntlet-cuff-ring', 0.065, 0.01, [0, 0.065, 0], p.brass)
}

function addHelmet(part, p) {
  const shell = new THREE.SphereGeometry(0.17, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.7)
  mesh(part, 'helmet-crown', shell, p.steel, [0, -0.045, 0])
  roundedBox(part, 'helmet-brow', [0.27, 0.055, 0.065], [0, 0.035, 0.12], p.steelLight, 0.012)
  const opening = new THREE.Group()
  opening.name = 'face-opening'
  opening.userData = { role: 'face-opening', bodyVisible: true }
  part.add(opening)
  roundedBox(opening, 'face-opening-void', [0.14, 0.12, 0.012], [0, -0.055, 0.14], p.opening, 0.012)
  for (const side of [-1, 1]) {
    box(part, 'helmet-cheek-guard', [0.045, 0.16, 0.08], [side * 0.12, -0.07, 0.075], p.steelDark)
    box(part, 'helmet-visor-rail', [0.04, 0.14, 0.04], [side * 0.09, -0.055, 0.15], p.steelLight)
  }
  box(part, 'helmet-nose-guard', [0.035, 0.11, 0.045], [0, -0.045, 0.16], p.steelLight)
  box(part, 'helmet-crest', [0.035, 0.17, 0.05], [0, 0.12, 0], p.brass)
}

function buildPadded() {
  const root = rootFor('armor-padded')
  const p = palette()
  addPart(root, 'chest', (part) => addChestCloth(part, p))
  addPart(root, 'waist', (part) => addClothWaist(part, p))
  for (const side of ['left', 'right']) {
    addPart(root, `upper-arm-${side}`, (part) => addPaddedSleeve(part, p))
    addPart(root, `forearm-${side}`, (part) => addPaddedSleeve(part, p))
    addPart(root, `foot-${side}`, (part) => addPaddedFoot(part, p))
  }
  return root
}

function buildLeather(studded = false) {
  const key = studded ? 'armor-studded' : 'armor-leather'
  const root = rootFor(key)
  const p = palette()
  addPart(root, 'chest', (part) => studded ? addStuddedChest(part, p) : addLeatherCuirass(part, p))
  addPart(root, 'waist', (part) => addLeatherWaist(part, p, studded))
  for (const side of ['left', 'right']) {
    addPart(root, `upper-arm-${side}`, (part) => {
      roundedBox(part, 'leather-shoulder-wrap', [0.17, 0.19, 0.16], [0, 0.025, 0], p.leather, 0.035)
      torus(part, 'shoulder-wrap-edge', 0.08, 0.012, [0, -0.06, 0], p.leatherLight)
    })
    addPart(root, `forearm-${side}`, (part) => addLeatherBracer(part, p, studded))
    addPart(root, `foot-${side}`, (part) => addLeatherFoot(part, p))
  }
  return root
}

function buildHide() {
  const root = rootFor('armor-hide')
  const p = palette()
  addPart(root, 'chest', (part) => addFurChest(part, p))
  addPart(root, 'waist', (part) => addHideWaist(part, p))
  for (const side of ['left', 'right']) {
    addPart(root, `upper-arm-${side}`, (part) => addFurSleeve(part, p))
    addPart(root, `forearm-${side}`, (part) => addFurSleeve(part, p))
    addPart(root, `thigh-${side}`, (part) => addFurLeg(part, p))
    addPart(root, `shin-${side}`, (part) => addFurLeg(part, p, true))
    addPart(root, `foot-${side}`, (part) => addLeatherFoot(part, p))
  }
  return root
}

function buildChainshirt() {
  const root = rootFor('armor-chainshirt')
  const p = palette()
  addPart(root, 'chest', (part) => addChainBase(part, p, true))
  addPart(root, 'waist', (part) => addChainBase(part, p))
  for (const side of ['left', 'right']) {
    addPart(root, `upper-arm-${side}`, (part) => addChainBase(part, p))
    addPart(root, `forearm-${side}`, (part) => addChainBase(part, p))
  }
  return root
}

function buildScaleMail() {
  const root = rootFor('armor-scalemail')
  const p = palette()
  addPart(root, 'chest', (part) => addScaleChest(part, p))
  addPart(root, 'waist', (part) => addScaleWaist(part, p))
  for (const side of ['left', 'right']) {
    addPart(root, `upper-arm-${side}`, (part) => addScaleLimb(part, p))
    addPart(root, `forearm-${side}`, (part) => addScaleLimb(part, p))
    addPart(root, `thigh-${side}`, (part) => addScaleLimb(part, p, true))
    addPart(root, `shin-${side}`, (part) => addScaleLimb(part, p, true))
    addPart(root, `foot-${side}`, (part) => addLeatherFoot(part, p, true))
  }
  return root
}

function buildBreastplate() {
  const root = rootFor('armor-breastplate')
  const p = palette()
  addPart(root, 'chest', (part) => addCuirass(part, p))
  addPart(root, 'waist', (part) => {
    roundedBox(part, 'breastplate-waist-strap', [0.41, 0.14, 0.21], [0, 0, 0], p.leatherDark, 0.025)
    box(part, 'breastplate-waist-plate', [0.3, 0.08, 0.04], [0, 0.01, 0.12], p.steelLight)
    box(part, 'breastplate-waist-buckle', [0.07, 0.06, 0.04], [0, 0.02, 0.145], p.brass)
  })
  return root
}

function buildHalfplate() {
  const root = rootFor('armor-halfplate')
  const p = palette()
  addPart(root, 'chest', (part) => addCuirass(part, p, true))
  addPart(root, 'waist', (part) => addPlateWaist(part, p, true))
  for (const side of ['left', 'right']) {
    addPart(root, `upper-arm-${side}`, (part) => addPauldron(part, p, true))
    addPart(root, `forearm-${side}`, (part) => addVambrace(part, p, true))
    addPart(root, `thigh-${side}`, (part) => addCuisses(part, p, true))
    addPart(root, `shin-${side}`, (part) => addGreaves(part, p, true))
    addPart(root, `foot-${side}`, (part) => addSabatons(part, p))
  }
  return root
}

function buildRingMail() {
  const root = rootFor('armor-ringmail')
  const p = palette()
  addPart(root, 'chest', (part) => {
    roundedBox(part, 'ringmail-leather-base', [0.43, 0.33, 0.2], [0, 0, 0], p.leatherDark, 0.035)
    addRingField(part, p, 0.38, 0.26, 3, 6, 0.026)
    box(part, 'ringmail-shoulder-seam', [0.38, 0.04, 0.03], [0, 0.13, 0], p.leather)
  })
  addPart(root, 'waist', (part) => {
    roundedBox(part, 'ringmail-waist-base', [0.4, 0.19, 0.2], [0, 0, 0], p.leatherDark, 0.03)
    addRingField(part, p, 0.34, 0.14, 2, 5, 0.026)
    box(part, 'ringmail-belt', [0.42, 0.04, 0.22], [0, 0.06, 0], p.leather)
  })
  for (const side of ['left', 'right']) {
    addPart(root, `upper-arm-${side}`, (part) => addRingField(part, p, 0.13, 0.2, 3, 2))
    addPart(root, `forearm-${side}`, (part) => addRingField(part, p, 0.11, 0.18, 3, 2))
    addPart(root, `thigh-${side}`, (part) => addRingField(part, p, 0.13, 0.22, 3, 2))
    addPart(root, `shin-${side}`, (part) => addRingField(part, p, 0.11, 0.2, 3, 2))
    addPart(root, `foot-${side}`, (part) => addLeatherFoot(part, p, true))
  }
  return root
}

function buildChainMail() {
  const root = rootFor('armor-chainmail')
  const p = palette()
  addPart(root, 'chest', (part) => addChainBase(part, p, true))
  addPart(root, 'waist', (part) => addChainBase(part, p))
  for (const side of ['left', 'right']) {
    addPart(root, `upper-arm-${side}`, (part) => addRingField(part, p, 0.14, 0.22, 4, 2, 0.026, true))
    addPart(root, `forearm-${side}`, (part) => addRingField(part, p, 0.12, 0.21, 4, 2, 0.026, true))
    addPart(root, `thigh-${side}`, (part) => addRingField(part, p, 0.15, 0.24, 4, 2, 0.026, true))
    addPart(root, `shin-${side}`, (part) => addRingField(part, p, 0.12, 0.22, 4, 2, 0.026, true))
    addPart(root, `foot-${side}`, (part) => addLeatherFoot(part, p, true))
  }
  return root
}

function buildSplint() {
  const root = rootFor('armor-splint')
  const p = palette()
  addPart(root, 'chest', (part) => {
    roundedBox(part, 'splint-padded-base', [0.44, 0.33, 0.2], [0, 0, 0], p.leatherDark, 0.035)
    for (const x of [-0.15, -0.05, 0.05, 0.15]) {
      box(part, 'splint-chest-strip-front', [0.035, 0.3, 0.05], [x, 0, 0.115], p.steel)
      box(part, 'splint-chest-strip-back', [0.035, 0.3, 0.04], [x, 0, -0.115], p.steelDark)
      for (const y of [-0.1, 0.1]) cylinder(part, 'splint-strip-rivet', 0.014, 0.014, 0.02, [x, y, 0.145], p.brass, 8, [Math.PI / 2, 0, 0])
    }
    torus(part, 'splint-neck-ring', 0.11, 0.014, [0, 0.15, 0], p.steelLight)
  })
  addPart(root, 'waist', (part) => {
    roundedBox(part, 'splint-waist-base', [0.41, 0.18, 0.21], [0, 0, 0], p.leatherDark, 0.025)
    for (const x of [-0.14, 0, 0.14]) box(part, 'splint-waist-strip', [0.035, 0.17, 0.045], [x, 0, 0.12], p.steel)
    box(part, 'splint-waist-belt', [0.43, 0.04, 0.22], [0, 0.06, 0], p.leather)
  })
  for (const side of ['left', 'right']) {
    addPart(root, `upper-arm-${side}`, (part) => addVambrace(part, p, true))
    addPart(root, `forearm-${side}`, (part) => addVambrace(part, p, true))
    addPart(root, `thigh-${side}`, (part) => addCuisses(part, p, true))
    addPart(root, `shin-${side}`, (part) => addGreaves(part, p, true))
    addPart(root, `foot-${side}`, (part) => addSabatons(part, p))
  }
  return root
}

function buildPlate() {
  const root = rootFor('armor-plate')
  const p = palette()
  addPart(root, 'chest', (part) => addCuirass(part, p, true))
  addPart(root, 'waist', (part) => addPlateWaist(part, p, true))
  for (const side of ['left', 'right']) {
    addPart(root, `upper-arm-${side}`, (part) => addPauldron(part, p, true))
    addPart(root, `forearm-${side}`, (part) => addVambrace(part, p, true))
    addPart(root, `thigh-${side}`, (part) => addCuisses(part, p, true))
    addPart(root, `shin-${side}`, (part) => addGreaves(part, p, true))
    addPart(root, `foot-${side}`, (part) => addSabatons(part, p))
    addPart(root, `hand-${side}`, (part) => addGauntlet(part, p))
  }
  addPart(root, 'head', (part) => addHelmet(part, p))
  return root
}

function buildShield() {
  const root = new THREE.Group()
  root.name = 'armor:shield'
  root.userData = { key: 'shield', recipe: 'skazanie-armor-v1', source: 'original', plane: 'XY', faceDirection: '+Z' }
  const shape = new THREE.Shape()
  shape.moveTo(0, 0.27)
  shape.quadraticCurveTo(0.17, 0.24, 0.18, 0.1)
  shape.lineTo(0.16, -0.12)
  shape.quadraticCurveTo(0.1, -0.23, 0, -0.29)
  shape.quadraticCurveTo(-0.1, -0.23, -0.16, -0.12)
  shape.lineTo(-0.18, 0.1)
  shape.quadraticCurveTo(-0.17, 0.24, 0, 0.27)
  shape.closePath()
  const bodyGeometry = new THREE.ExtrudeGeometry(shape, { depth: 0.055, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.012, bevelThickness: 0.008, curveSegments: 2 })
  bodyGeometry.translate(0, 0, -0.0275)
  mesh(root, 'shield-face', bodyGeometry, material('steel', COLORS.steelBlue, { roughness: 0.45, metalness: 0.78 }))
  const rim = new THREE.Group()
  rim.name = 'shield-rim'
  rim.userData = { role: 'edge-protection' }
  root.add(rim)
  for (const side of [-1, 1]) {
    box(rim, 'shield-rim-side', [0.025, 0.3, 0.04], [side * 0.17, 0, 0.035], material('steel', COLORS.steelLight, { roughness: 0.36, metalness: 0.84 }), [0, side * 0.08, 0])
  }
  box(rim, 'shield-rim-top', [0.18, 0.025, 0.04], [0, 0.235, 0.035], material('steel', COLORS.steelLight, { roughness: 0.36, metalness: 0.84 }))
  box(rim, 'shield-rim-bottom', [0.13, 0.025, 0.04], [0, -0.22, 0.035], material('steel', COLORS.steelLight, { roughness: 0.36, metalness: 0.84 }))
  const boss = new THREE.Group()
  boss.name = 'shield-boss'
  boss.userData = { role: 'center-boss', faceDirection: '+Z' }
  root.add(boss)
  cylinder(boss, 'shield-boss-dome', 0.058, 0.072, 0.045, [0, 0.02, 0.055], material('brass', COLORS.brass, { roughness: 0.35, metalness: 0.82 }), 12, [Math.PI / 2, 0, 0])
  for (const y of [0.15, -0.1]) box(root, 'shield-rivet-row', [0.08, 0.014, 0.014], [0, y, 0.06], material('brass', COLORS.brass, { roughness: 0.35, metalness: 0.82 }))
  const grip = new THREE.Group()
  grip.name = 'grip'
  grip.position.set(0, 0, 0)
  grip.userData = { role: 'grip', attachment: 'off-hand' }
  root.add(grip)
  box(grip, 'shield-grip-bar', [0.055, 0.27, 0.045], [0, 0, -0.055], material('leather', COLORS.leatherDark, { roughness: 0.9 }))
  box(grip, 'shield-grip-strap', [0.15, 0.035, 0.03], [0, 0, -0.02], material('leather', COLORS.leather, { roughness: 0.88 }))
  root.updateMatrixWorld(true)
  return root
}

/** @param {string} key @returns {THREE.Group|null} */
export function createArmorModel(key) {
  if (key === 'shield') return buildShield()
  if (!SPEC_BY_KEY.has(key)) return null
  let model
  switch (key) {
    case 'armor-padded': model = buildPadded(); break
    case 'armor-leather': model = buildLeather(); break
    case 'armor-studded': model = buildLeather(true); break
    case 'armor-hide': model = buildHide(); break
    case 'armor-chainshirt': model = buildChainshirt(); break
    case 'armor-scalemail': model = buildScaleMail(); break
    case 'armor-breastplate': model = buildBreastplate(); break
    case 'armor-halfplate': model = buildHalfplate(); break
    case 'armor-ringmail': model = buildRingMail(); break
    case 'armor-chainmail': model = buildChainMail(); break
    case 'armor-splint': model = buildSplint(); break
    case 'armor-plate': model = buildPlate(); break
    default: return null
  }
  model.updateMatrixWorld(true)
  return model
}

/** Находит комплект по catalog id, чтобы рендереру не дублировать таблицу. */
export function armorModelForCatalogId(catalogId) {
  return ARMOR_MODELS.find((item) => item.catalogIds.includes(catalogId)) ?? (SHIELD_MODEL.catalogIds.includes(catalogId) ? SHIELD_MODEL : null)
}
