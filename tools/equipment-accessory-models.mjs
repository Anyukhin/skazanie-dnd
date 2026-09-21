#!/usr/bin/env node
/** Авторские модели небольших носимых магических предметов. */

import * as THREE from 'three'
import { ITEM_CATALOG } from '../server/item-catalog.mjs'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

const CATALOG_PREFIX = 'srd_5_2_1:'

const COLORS = Object.freeze({
  cloth: '#6d4d5d',
  clothLight: '#a66f72',
  clothDark: '#3d3040',
  leather: '#68452f',
  leatherLight: '#a87549',
  leatherDark: '#38261e',
  steel: '#89979a',
  steelDark: '#394750',
  steelLight: '#d0d6d0',
  wood: '#6e4a30',
  woodLight: '#a8784c',
  woodDark: '#35251c',
  bone: '#d1c39f',
  brass: '#b0823e',
  gemBlue: '#4a9bd4',
  gemRed: '#a83b36',
})

const catalogId = (id) => `${CATALOG_PREFIX}${id}`

/** Позиции используются только для частей плаща: остальные предметы крепятся собственным grip/origin. */
export const ACCESSORY_PART_POSES = Object.freeze({
  back: Object.freeze([0, 0.84, -0.14]),
  collar: Object.freeze([0, 1.04, -0.08]),
  front: Object.freeze([0, 0, 0]),
  pin: Object.freeze([0, 0, 0]),
  brooch: Object.freeze([0, 0, 0]),
})

const RING_VARIANTS = Object.freeze([
  Object.freeze({
    key: 'protection',
    label: 'Кольцо защиты',
    catalogIds: Object.freeze([catalogId('ring-of-protection')]),
    materialVariant: 'silver-blue',
  }),
  Object.freeze({
    key: 'fire-resistance',
    label: 'Кольцо сопротивления огню',
    catalogIds: Object.freeze([catalogId('ring-of-fire-resistance')]),
    materialVariant: 'garnet-gold',
  }),
])

const spec = (key, label, catalogIds, parts, variants = ['default']) => Object.freeze({
  key,
  label,
  catalogIds: Object.freeze([...catalogIds]),
  parts: Object.freeze(parts.map((part) => `part:${part}`)),
  variants: Object.freeze(variants.map((variant) => typeof variant === 'string' ? variant : Object.freeze({ ...variant }))),
  source: 'original',
})

/** Базовые геометрические ключи намеренно не размножаются по магическим эффектам. */
export const ACCESSORY_MODELS = Object.freeze([
  spec('wand', ITEM_CATALOG[catalogId('wand-of-magic-missiles')]?.name ?? 'Жезл волшебных стрел', [catalogId('wand-of-magic-missiles')], ['grip'], ['default', 'enchanted']),
  spec('cloak', ITEM_CATALOG[catalogId('cloak-of-protection')]?.name ?? 'Плащ защиты', [catalogId('cloak-of-protection')], ['back', 'collar'], ['default', 'enchanted']),
  spec('brooch', ITEM_CATALOG[catalogId('brooch-of-shielding')]?.name ?? 'Брошь защиты', [catalogId('brooch-of-shielding')], ['front', 'pin'], ['default', 'enchanted']),
  spec('ring', 'Кольцо', RING_VARIANTS.flatMap((variant) => variant.catalogIds), ['band', 'stone'], RING_VARIANTS),
  spec('arcane-crystal', ITEM_CATALOG[catalogId('arcane-focus-crystal')]?.name ?? 'Кристалл', [catalogId('arcane-focus-crystal')], ['grip']),
  spec('arcane-orb', ITEM_CATALOG[catalogId('arcane-focus-orb')]?.name ?? 'Сфера', [catalogId('arcane-focus-orb')], ['grip']),
  spec('arcane-rod', ITEM_CATALOG[catalogId('arcane-focus-rod')]?.name ?? 'Скипетр', [catalogId('arcane-focus-rod')], ['grip']),
  spec('druidic-mistletoe', ITEM_CATALOG[catalogId('druidic-focus-mistletoe')]?.name ?? 'Веточка омелы', [catalogId('druidic-focus-mistletoe')], ['grip']),
  spec('druidic-totem', ITEM_CATALOG[catalogId('druidic-focus-totem')]?.name ?? 'Тотем', [catalogId('druidic-focus-totem')], ['grip']),
  spec('holy-amulet', ITEM_CATALOG[catalogId('holy-symbol-amulet')]?.name ?? 'Амулет', [catalogId('holy-symbol-amulet')], ['brooch']),
  spec('holy-emblem', ITEM_CATALOG[catalogId('holy-symbol-emblem')]?.name ?? 'Эмблема', [catalogId('holy-symbol-emblem')], ['grip']),
  spec('holy-reliquary', ITEM_CATALOG[catalogId('holy-symbol-reliquary')]?.name ?? 'Реликварий', [catalogId('holy-symbol-reliquary')], ['grip']),
  ...['bagpipes', 'drum', 'dulcimer', 'flute', 'lute', 'lyre', 'horn', 'pan-flute', 'shawm', 'viol'].map((key) => (
    spec(key, ITEM_CATALOG[catalogId(key)]?.name ?? key, [catalogId(key)], ['grip'])
  )),
])

export const ACCESSORY_RING_VARIANTS = RING_VARIANTS

const SPEC_BY_KEY = new Map(ACCESSORY_MODELS.map((item) => [item.key, item]))
const VARIANT_BY_CATALOG_ID = new Map(RING_VARIANTS.flatMap((variant) => variant.catalogIds.map((id) => [id, variant.key])))

function material(name, color, options = {}) {
  const value = new THREE.MeshStandardMaterial({
    color,
    roughness: name === 'cloth' ? 0.96 : name === 'gem' ? 0.3 : 0.82,
    metalness: name === 'steel' || name === 'brass' ? 0.74 : 0.025,
    ...options,
  })
  value.name = name
  value.userData = { materialRole: name }
  return value
}

function palette(variant = 'default') {
  const fire = variant === 'fire-resistance'
  const enchanted = variant === 'enchanted'
  return {
    cloth: material('cloth', COLORS.cloth),
    clothLight: material('cloth', COLORS.clothLight),
    clothDark: material('cloth', COLORS.clothDark),
    leather: material('leather', COLORS.leather),
    leatherLight: material('leather', COLORS.leatherLight),
    leatherDark: material('leather', COLORS.leatherDark),
    steel: material('steel', fire ? '#765f58' : COLORS.steel, { metalness: 0.8, roughness: 0.42 }),
    steelDark: material('steel', COLORS.steelDark, { metalness: 0.72, roughness: 0.5 }),
    steelLight: material('steel', COLORS.steelLight, { metalness: 0.86, roughness: 0.3 }),
    wood: material('wood', COLORS.wood),
    woodLight: material('wood', COLORS.woodLight),
    woodDark: material('wood', COLORS.woodDark),
    bone: material('bone', COLORS.bone),
    brass: material('brass', fire ? '#d08a38' : enchanted ? '#d2aa58' : COLORS.brass, { metalness: 0.82, roughness: 0.34 }),
    gem: material('gem', fire ? COLORS.gemRed : enchanted ? '#70d8ff' : COLORS.gemBlue, {
      metalness: 0.04,
      roughness: 0.23,
      ...(enchanted ? { emissive: '#247da5', emissiveIntensity: 1.15 } : {}),
    }),
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

function cylinder(parent, name, radiusTop, radiusBottom, height, position, value, segments = 10, rotation = [0, 0, 0]) {
  return mesh(parent, name, new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), value, position, rotation)
}

function sphere(parent, name, size, position, value) {
  return mesh(parent, name, new THREE.SphereGeometry(0.5, 10, 7), value, position, [0, 0, 0], size)
}

function torus(parent, name, radius, tube, position, value, rotation = [Math.PI / 2, 0, 0]) {
  return mesh(parent, name, new THREE.TorusGeometry(radius, tube, 7, 16), value, position, rotation)
}

function dodecahedron(parent, name, size, position, value) {
  return mesh(parent, name, new THREE.DodecahedronGeometry(0.5, 0), value, position, [0, 0, 0], size)
}

function tube(parent, name, points, radius, value, tubularSegments = 12, radialSegments = 6) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, 'centripetal')
  return mesh(parent, name, new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false), value)
}

function extrudedShape(parent, name, points, depth, value, position = [0, 0, 0]) {
  const shape = new THREE.Shape()
  shape.moveTo(points[0][0], points[0][1])
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.008, bevelThickness: 0.006, curveSegments: 2 })
  geometry.translate(0, 0, -depth / 2)
  return mesh(parent, name, geometry, value, position)
}

function part(root, name, build) {
  const node = new THREE.Group()
  node.name = `part:${name}`
  node.position.set(...ACCESSORY_PART_POSES[name])
  node.userData = { accessoryPart: name, canonicalPose: true }
  root.add(node)
  build(node)
  return node
}

function finish(root, key, variant = 'default') {
  root.name = `accessory:${key}`
  root.userData = {
    ...root.userData,
    key,
    variant,
    recipe: 'skazanie-accessories-v1',
    source: 'original',
    canonicalHeight: 1.4,
  }
  root.updateMatrixWorld(true)
  return root
}

function buildWand(variant) {
  const p = palette(variant)
  const root = new THREE.Group()
  const grip = new THREE.Group()
  grip.name = 'grip'
  grip.position.set(0, 0, 0)
  grip.userData = { role: 'primary-grip', origin: [0, 0, 0], axis: '+Y' }
  root.add(grip)
  cylinder(grip, 'wand-shaft', 0.024, 0.031, 0.31, [0, 0.16, 0], p.wood, 8)
  cylinder(grip, 'wand-pommel', 0.045, 0.035, 0.035, [0, 0.0175, 0], p.brass, 8)
  torus(grip, 'wand-grip-wrap', 0.034, 0.008, [0, 0.06, 0], p.leather)
  torus(grip, 'wand-grip-wrap', 0.034, 0.008, [0, 0.12, 0], p.leather)
  cylinder(grip, 'wand-collar', 0.046, 0.038, 0.035, [0, 0.32, 0], p.brass, 8)
  dodecahedron(grip, 'wand-focus', [0.055, 0.055, 0.055], [0, 0.37, 0], p.gem)
  if (variant === 'enchanted') {
    torus(grip, 'wand-enchanted-halo', 0.075, 0.007, [0, 0.37, 0], p.brass)
    for (let index = 0; index < 4; index += 1) {
      const angle = index * Math.PI / 2
      dodecahedron(grip, 'wand-enchanted-spark', [.018, .018, .018], [Math.cos(angle) * .075, .37, Math.sin(angle) * .075], p.gem)
    }
  }
  coneWandTip(grip, p, 0.44)
  return finish(root, 'wand', variant)
}

function coneWandTip(parent, p, y) {
  const geometry = new THREE.ConeGeometry(0.038, 0.08, 8)
  mesh(parent, 'wand-tip', geometry, p.steelLight, [0, y, 0])
}

function buildCloak(variant) {
  const p = palette(variant)
  const root = new THREE.Group()
  part(root, 'back', (back) => {
    extrudedShape(back, 'cloak-contoured-body', [
      [-0.22, 0.27], [-0.32, 0.18], [-0.31, -0.03], [-0.35, -0.29],
      [-0.25, -0.38], [-0.11, -0.42], [0, -0.39], [0.11, -0.42],
      [0.25, -0.38], [0.35, -0.29], [0.31, -0.03], [0.32, 0.18], [0.22, 0.27],
    ], 0.075, p.cloth, [0, -0.02, 0])
    for (const [index, x] of [-0.24, -0.13, 0, 0.13, 0.24].entries()) {
      tube(back, `cloak-soft-fold-${index + 1}`, [[x, 0.2, 0.05], [x * 0.95, 0.02, 0.08], [x * 0.9, -0.2, 0.045], [x * 0.82, -0.36, 0.02]], 0.018, index % 2 ? p.clothLight : p.clothDark, 8, 5)
    }
    tube(back, 'cloak-hem', [[-0.25, -0.38, 0.05], [-0.12, -0.41, 0.06], [0, -0.39, 0.06], [0.12, -0.41, 0.06], [0.25, -0.38, 0.05]], 0.025, p.clothLight, 12, 6)
    box(back, 'cloak-shoulder-seam', [0.43, 0.025, 0.045], [0, 0.24, 0.05], p.clothLight)
    for (const side of [-1, 1]) box(back, 'cloak-side-weight', [0.035, 0.08, 0.035], [side * 0.3, -0.28, 0.045], p.brass)
  })
  part(root, 'collar', (collar) => {
    roundedBoxCloak(collar, 'cloak-shoulder-collar', [0.42, 0.09, 0.14], [0, 0, 0], p.clothDark)
    torus(collar, 'cloak-neck-roll', 0.125, 0.032, [0, 0, 0], p.clothLight)
    box(collar, 'cloak-clasp-strap', [0.035, 0.1, 0.18], [0, -0.01, 0.08], p.leather)
    dodecahedron(collar, 'cloak-clasp-gem', [0.045, 0.045, 0.032], [0, -0.01, 0.18], p.gem)
  })
  return finish(root, 'cloak', variant)
}

function roundedBoxCloak(parent, name, size, position, value) {
  const radius = Math.min(0.025, ...size.map((item) => Math.max(0.001, item / 2 - 0.001)))
  return mesh(parent, name, new RoundedBoxGeometry(...size, 2, radius), value, position)
}

function buildBrooch(variant) {
  const p = palette(variant)
  const root = new THREE.Group()
  part(root, 'front', (front) => {
    front.userData = { accessoryPart: 'front', plane: 'XY', faceDirection: '+Z', canonicalPose: true }
    cylinder(front, 'brooch-medallion', 0.085, 0.085, 0.018, [0, 0, 0.02], p.steel, 12, [Math.PI / 2, 0, 0])
    torus(front, 'brooch-rim', 0.075, 0.012, [0, 0, 0.035], p.brass, [0, 0, 0])
    for (const angle of [0, Math.PI / 3, (2 * Math.PI) / 3, Math.PI, (4 * Math.PI) / 3, (5 * Math.PI) / 3]) {
      const x = Math.cos(angle) * 0.085
      const y = Math.sin(angle) * 0.085
      box(front, 'brooch-sun-ray', [0.018, 0.045, 0.018], [x, y, 0.03], p.brass, [0, 0, angle])
    }
    dodecahedron(front, 'brooch-center-stone', [0.047, 0.047, 0.034], [0, 0, 0.065], p.gem)
    box(front, 'brooch-center-ridge', [0.018, 0.11, 0.018], [0, 0, 0.075], p.steelLight)
  })
  part(root, 'pin', (pin) => {
    pin.userData = { accessoryPart: 'pin', attachment: 'chest', canonicalPose: true }
    cylinder(pin, 'brooch-pin', 0.009, 0.009, 0.19, [0, 0, -0.035], p.steelLight, 8, [0, 0, Math.PI / 2])
    sphere(pin, 'brooch-pin-tip', [0.018, 0.018, 0.018], [0.1, 0, -0.035], p.steel)
  })
  root.userData = { ...root.userData, plane: 'XY', faceDirection: '+Z' }
  return finish(root, 'brooch', variant)
}

function buildRing(variant) {
  const p = palette(variant)
  const root = new THREE.Group()
  root.userData = { plane: 'XZ', faceDirection: '+Y', materialVariant: variant }
  const band = new THREE.Group()
  band.name = 'part:band'
  band.userData = { accessoryPart: 'band', canonicalPose: true, plane: 'XZ' }
  root.add(band)
  torus(band, 'ring-band', 0.06, 0.014, [0, 0, 0], p.steel, [Math.PI / 2, 0, 0])
  torus(band, 'ring-shoulder-left', 0.035, 0.009, [-0.037, 0.004, 0], p.brass, [Math.PI / 2, 0, 0])
  torus(band, 'ring-shoulder-right', 0.035, 0.009, [0.037, 0.004, 0], p.brass, [Math.PI / 2, 0, 0])
  const stone = new THREE.Group()
  stone.name = 'part:stone'
  stone.position.set(0, 0, 0)
  stone.userData = { accessoryPart: 'stone', canonicalPose: true, materialVariant: variant }
  root.add(stone)
  dodecahedron(stone, 'ring-gem', [0.05, 0.035, 0.05], [0, 0.065, 0], p.gem)
  box(stone, 'ring-gem-setting', [0.06, 0.018, 0.06], [0, 0.035, 0], p.brass)
  return finish(root, 'ring', variant)
}

function heldRoot(key) {
  const root = new THREE.Group()
  const grip = new THREE.Group()
  grip.name = 'grip'
  grip.userData = { role: 'primary-grip', origin: [0, 0, 0], axis: '+Y' }
  root.add(grip)
  return { root, grip }
}

function solarRune(parent, prefix, center, radius, value) {
  const [cx, cy, cz] = center
  sphere(parent, `${prefix}-center`, [radius * .35, radius * .35, .018], center, value)
  for (let index = 0; index < 8; index += 1) {
    const angle = index * Math.PI / 4
    box(parent, `${prefix}-ray`, [radius * .14, radius * .34, .014], [
      cx + Math.sin(angle) * radius * .7,
      cy + Math.cos(angle) * radius * .7,
      cz,
    ], value, [0, 0, -angle])
  }
}

function buildFocus(key, variant) {
  const p = palette(variant)
  if (key === 'holy-amulet') {
    const root = new THREE.Group()
    part(root, 'brooch', (front) => {
      torus(front, 'amulet-chain', 0.12, 0.008, [0, 0.05, 0], p.brass, [0, 0, 0])
      cylinder(front, 'amulet-medallion', 0.055, 0.055, 0.018, [0, -0.075, 0.02], p.brass, 16, [Math.PI / 2, 0, 0])
      solarRune(front, 'amulet-sun', [0, -0.075, 0.045], .047, p.steelLight)
    })
    return finish(root, key, variant)
  }
  const { root, grip } = heldRoot(key)
  if (key === 'arcane-crystal') {
    cylinder(grip, 'crystal-handle', 0.027, 0.033, 0.18, [0, 0.09, 0], p.leather, 8)
    dodecahedron(grip, 'crystal-focus', [0.12, 0.2, 0.1], [0, 0.27, 0], p.gem)
    for (const side of [-1, 1]) dodecahedron(grip, 'crystal-splinter', [0.05, 0.13, 0.05], [side * 0.07, 0.23, 0], p.gem)
  } else if (key === 'arcane-orb') {
    cylinder(grip, 'orb-handle', 0.03, 0.038, 0.17, [0, 0.085, 0], p.leather, 10)
    torus(grip, 'orb-cradle', 0.1, 0.014, [0, 0.25, 0], p.brass, [0, 0, 0])
    for (const side of [-1, 1]) cylinder(grip, 'orb-cradle-arm', .012, .012, .16, [side * .075, .2, 0], p.brass, 6, [0, 0, side * .5])
    sphere(grip, 'orb-focus', [0.18, 0.18, 0.18], [0, 0.25, 0], p.gem)
  } else if (key === 'arcane-rod') {
    cylinder(grip, 'rod-shaft', 0.035, 0.045, 0.48, [0, 0.24, 0], p.wood, 10)
    for (const y of [0.04, 0.18, 0.36]) torus(grip, 'rod-band', 0.042, 0.009, [0, y, 0], p.brass)
    dodecahedron(grip, 'rod-focus', [0.09, 0.12, 0.09], [0, 0.52, 0], p.gem)
  } else if (key === 'druidic-mistletoe') {
    tube(grip, 'mistletoe-stem', [[0, 0, 0], [0, 0.17, 0], [-0.05, 0.31, 0.01], [0, 0.43, 0]], 0.018, p.wood, 10, 6)
    for (const [x, y, angle] of [[-.09, .2, -.65], [.08, .27, .7], [-.07, .36, -.6], [.08, .4, .65]]) {
      mesh(grip, 'mistletoe-leaf', new THREE.SphereGeometry(0.5, 8, 5), p.clothLight, [x, y, 0], [0, 0, angle], [.12, .035, .055])
    }
    for (const x of [-.035, 0, .035]) sphere(grip, 'mistletoe-berry', [.025, .025, .025], [x, .32, .035], p.steelLight)
  } else if (key === 'druidic-totem') {
    cylinder(grip, 'totem-handle', 0.035, 0.045, 0.25, [0, 0.125, 0], p.woodDark, 8)
    cylinder(grip, 'totem-body', 0.08, 0.065, 0.21, [0, 0.35, 0], p.wood, 8)
    sphere(grip, 'totem-head', [.09, .085, .08], [0, .49, 0], p.woodLight)
    for (const side of [-1, 1]) mesh(grip, 'totem-antler', new THREE.ConeGeometry(.025, .13, 6), p.bone, [side * .075, .57, 0], [0, 0, side * .45])
  } else if (key === 'holy-emblem') {
    cylinder(grip, 'emblem-handle', .035, .045, .18, [0, .09, 0], p.leather, 8)
    cylinder(grip, 'emblem-disc', .17, .17, .025, [0, .28, 0], p.steel, 16, [Math.PI / 2, 0, 0])
    torus(grip, 'emblem-rim', .145, .015, [0, .28, .02], p.brass, [0, 0, 0])
    solarRune(grip, 'emblem-mark', [0, .28, .045], .115, p.steelLight)
  } else if (key === 'holy-reliquary') {
    cylinder(grip, 'reliquary-handle', .035, .045, .18, [0, .09, 0], p.leather, 8)
    box(grip, 'reliquary-case', [.2, .25, .11], [0, .3, 0], p.brass)
    box(grip, 'reliquary-door', [.14, .18, .015], [0, .3, .063], p.steelDark)
    solarRune(grip, 'reliquary-sun', [0, .3, .085], .08, p.steelLight)
    dodecahedron(grip, 'reliquary-relic', [.055, .075, .035], [0, .3, .085], p.gem)
    mesh(grip, 'reliquary-roof', new THREE.ConeGeometry(.15, .12, 4), p.brass, [0, .485, 0], [0, Math.PI / 4, 0])
  }
  return finish(root, key, variant)
}

function stringLine(parent, name, from, to, value) {
  return tube(parent, name, [from, to], 0.004, value, 3, 4)
}

function buildInstrument(key, variant) {
  const p = palette(variant)
  const { root, grip } = heldRoot(key)
  if (key === 'bagpipes') {
    sphere(grip, 'bagpipes-bag', [.18, .25, .13], [0, .23, 0], p.cloth)
    for (const [index, x] of [-.1, 0, .1].entries()) cylinder(grip, `bagpipes-drone-${index + 1}`, .018, .025, .48 + index * .05, [x, .52, 0], p.wood, 8)
    tube(grip, 'bagpipes-blowpipe', [[.13, .29, 0], [.25, .4, 0], [.28, .52, 0]], .018, p.woodLight, 8, 6)
  } else if (key === 'drum') {
    cylinder(grip, 'drum-shell', .18, .18, .24, [0, .2, 0], p.wood, 16, [Math.PI / 2, 0, 0])
    for (const z of [-.12, .12]) cylinder(grip, 'drum-head', .175, .175, .018, [0, .2, z], p.bone, 16, [Math.PI / 2, 0, 0])
    for (const x of [-.13, 0, .13]) stringLine(grip, 'drum-lacing', [x, .04, -.13], [-x, .36, .13], p.leather)
  } else if (key === 'dulcimer') {
    extrudedShape(grip, 'dulcimer-body', [[-.2, 0], [.2, 0], [.14, .34], [-.14, .34]], .08, p.wood, [0, .08, 0])
    for (const x of [-.1, -.05, 0, .05, .1]) stringLine(grip, 'dulcimer-string', [x, .1, .05], [x * .7, .37, .05], p.steelLight)
  } else if (key === 'flute') {
    cylinder(grip, 'flute-body', .022, .022, .62, [0, .31, 0], p.steelLight, 12)
    for (const y of [.12, .2, .28, .36, .44, .52]) sphere(grip, 'flute-hole', [.012, .007, .012], [0, y, .022], p.steelDark)
  } else if (key === 'lute' || key === 'viol') {
    const bowed = key === 'viol'
    sphere(grip, `${key}-body`, [.2, .25, .085], [0, .2, 0], bowed ? p.woodDark : p.wood)
    sphere(grip, `${key}-waist`, [.13, .16, .09], [0, .4, 0], p.woodLight)
    cylinder(grip, `${key}-neck`, .035, .045, .38, [0, .65, 0], p.woodDark, 8)
    box(grip, `${key}-pegbox`, [.1, .14, .08], [0, .88, 0], p.wood)
    for (const x of [-.025, 0, .025]) stringLine(grip, `${key}-string`, [x, .08, .09], [x, .9, .045], p.steelLight)
  } else if (key === 'lyre') {
    cylinder(grip, 'lyre-base', .05, .07, .24, [0, .12, 0], p.woodDark, 8)
    tube(grip, 'lyre-frame-left', [[0, .2, 0], [-.18, .35, 0], [-.16, .65, 0]], .035, p.wood, 10, 7)
    tube(grip, 'lyre-frame-right', [[0, .2, 0], [.18, .35, 0], [.16, .65, 0]], .035, p.wood, 10, 7)
    cylinder(grip, 'lyre-crossbar', .03, .03, .36, [0, .65, 0], p.brass, 8, [0, 0, Math.PI / 2])
    for (const x of [-.1, -.05, 0, .05, .1]) stringLine(grip, 'lyre-string', [x * .5, .24, 0], [x, .65, 0], p.steelLight)
  } else if (key === 'horn') {
    tube(grip, 'horn-body', [[0, 0, 0], [0, .18, 0], [.08, .34, 0], [.24, .44, 0]], .035, p.brass, 12, 8)
    torus(grip, 'horn-bell', .09, .025, [.25, .45, 0], p.brass, [0, Math.PI / 2, 0])
    cylinder(grip, 'horn-mouthpiece', .018, .026, .09, [0, -.035, 0], p.steelLight, 8)
    torus(grip, 'horn-grip-band', .045, .009, [0, .13, 0], p.leather)
  } else if (key === 'pan-flute') {
    for (let index = 0; index < 7; index += 1) {
      const x = (index - 3) * .045
      cylinder(grip, 'pan-flute-pipe', .018, .018, .26 + index * .035, [x, .13 + index * .0175, 0], p.woodLight, 8)
    }
    box(grip, 'pan-flute-bind', [.34, .055, .055], [0, .12, 0], p.leather)
  } else if (key === 'shawm') {
    cylinder(grip, 'shawm-body', .025, .035, .52, [0, .26, 0], p.wood, 10)
    mesh(grip, 'shawm-bell', new THREE.ConeGeometry(.085, .15, 12, 1, true), p.woodLight, [0, .59, 0])
    for (const y of [.16, .24, .32, .4]) sphere(grip, 'shawm-hole', [.014, .008, .014], [0, y, .03], p.steelDark)
  }
  return finish(root, key, variant)
}

function normalizeVariant(key, variant) {
  const value = String(variant ?? 'default')
  if (key === 'ring') {
    if (value === 'fire' || value === 'flaming' || value === 'fire-resistance') return 'fire-resistance'
    if (value === 'protection' || value === 'enchanted' || value === 'default') return 'protection'
    return value
  }
  return value === 'enchanted' ? 'enchanted' : 'default'
}

/** @param {string} key @param {string} [variant] @returns {THREE.Group|null} */
export function createAccessoryModel(key, variant = 'default') {
  if (!SPEC_BY_KEY.has(key)) return null
  const selectedVariant = normalizeVariant(key, variant)
  if (key === 'ring' && !RING_VARIANTS.some((item) => item.key === selectedVariant)) return null
  let model
  switch (key) {
    case 'wand': model = buildWand(selectedVariant); break
    case 'cloak': model = buildCloak(selectedVariant); break
    case 'brooch': model = buildBrooch(selectedVariant); break
    case 'ring': model = buildRing(selectedVariant); break
    case 'arcane-crystal':
    case 'arcane-orb':
    case 'arcane-rod':
    case 'druidic-mistletoe':
    case 'druidic-totem':
    case 'holy-amulet':
    case 'holy-emblem':
    case 'holy-reliquary': model = buildFocus(key, selectedVariant); break
    case 'bagpipes':
    case 'drum':
    case 'dulcimer':
    case 'flute':
    case 'lute':
    case 'lyre':
    case 'horn':
    case 'pan-flute':
    case 'shawm':
    case 'viol': model = buildInstrument(key, selectedVariant); break
    default: return null
  }
  model.updateMatrixWorld(true)
  return model
}

export const createEquipmentAccessoryModel = createAccessoryModel

/** Возвращает базовый ключ и материальный вариант для каталожной записи. */
export function accessoryModelForCatalogId(catalogIdValue) {
  const entry = ACCESSORY_MODELS.find((item) => item.catalogIds.includes(catalogIdValue))
  if (!entry) return null
  const variant = entry.key === 'ring' ? (VARIANT_BY_CATALOG_ID.get(catalogIdValue) ?? 'protection') : 'default'
  return { key: entry.key, variant }
}
