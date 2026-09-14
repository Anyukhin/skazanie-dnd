/**
 * Авторские модели базового оружия в руке.
 *
 * Экспортом GLB и публикацией занимается сборщик окружения. Этот модуль
 * намеренно только создаёт свежий THREE.Group: его можно использовать в
 * превью персонажа и в серверном конвейере ассетов без состояния между вызовами.
 */
import * as THREE from 'three'
import { ITEM_CATALOG } from '../server/item-catalog.mjs'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

const CATALOG_PREFIX = 'srd_5_2_1:'

const COLORS = Object.freeze({
  steel: '#697277',
  steelEdge: '#a3abb0',
  steelDark: '#343b40',
  wood: '#674a32',
  woodLight: '#9a7047',
  woodDark: '#30241d',
  leather: '#51352b',
  leatherLight: '#81553a',
  cloth: '#716275',
  clothLight: '#a08a92',
  bone: '#c8b996',
})

/** @typedef {'blade'|'club'|'axe'|'hammer'|'mace'|'staff'|'polearm'|'flail'|'bow'|'crossbow'|'sling'|'net'|'whip'|'dart'|'blowgun'|'firearm'} WeaponKind */
/** @typedef {'one-handed'|'two-handed'|'variable'} Handedness */
/** @typedef {{primary: readonly [number, number, number], offHand?: readonly [number, number, number]}} GripSpec */
/** @typedef {{key:string,label:string,catalogIds:readonly string[],kind:WeaponKind,handedness:Handedness,grip:GripSpec,source:'original'}} WeaponModelSpec */

function catalogId(key) {
  return `${CATALOG_PREFIX}${key}`
}

const MAGIC_LONGSWORD_IDS = Object.freeze([
  catalogId('longsword-plus-1'),
  catalogId('weapon-of-warning-longsword'),
  catalogId('vicious-longsword'),
  catalogId('flame-tongue-longsword'),
])

const TWO_HAND_GRIP = Object.freeze({ primary: Object.freeze([0, 0, 0]), offHand: Object.freeze([0, 0.35, 0]) })
const VARIABLE_GRIP = Object.freeze({ primary: Object.freeze([0, 0, 0]), offHand: Object.freeze([0, 0.35, 0]) })
const SWORD_GRIP = Object.freeze({ primary: Object.freeze([0, 0, 0]), offHand: Object.freeze([0, -0.12, 0]) })
const BOW_GRIP = Object.freeze({ primary: Object.freeze([0, 0, 0]), offHand: Object.freeze([0, 0, 0.08]) })
const CROSSBOW_GRIP = Object.freeze({ primary: Object.freeze([0, 0, 0]), offHand: Object.freeze([0, 0.1, 0.28]) })
const ONE_HAND_GRIP = Object.freeze({ primary: Object.freeze([0, 0, 0]) })

const definition = (key, kind, handedness = 'one-handed', grip = handedness === 'two-handed' ? TWO_HAND_GRIP : handedness === 'variable' ? VARIABLE_GRIP : ONE_HAND_GRIP, aliases = []) => {
  const item = ITEM_CATALOG[catalogId(key)]
  if (!item && key !== 'net') throw new Error(`Нет записи оружия в каталоге: ${catalogId(key)}`)
  return Object.freeze({
    key,
    label: item?.name ?? 'Сеть',
    catalogIds: Object.freeze(key === 'net' ? [] : [catalogId(key), ...aliases]),
    kind,
    handedness,
    grip,
    source: 'original',
  })
}

/** @type {readonly WeaponModelSpec[]} */
export const WEAPON_MODELS = Object.freeze([
  definition('club', 'club'),
  definition('dagger', 'blade'),
  definition('greatclub', 'club', 'two-handed'),
  definition('handaxe', 'axe'),
  definition('javelin', 'polearm'),
  definition('light-hammer', 'hammer'),
  definition('mace', 'mace'),
  definition('quarterstaff', 'staff', 'variable'),
  definition('sickle', 'blade'),
  definition('spear', 'polearm', 'variable'),
  definition('dart', 'dart'),
  definition('light-crossbow', 'crossbow', 'two-handed', CROSSBOW_GRIP),
  definition('shortbow', 'bow', 'two-handed', BOW_GRIP),
  definition('sling', 'sling'),
  definition('net', 'net'),
  definition('battleaxe', 'axe', 'variable'),
  definition('flail', 'flail'),
  definition('glaive', 'polearm', 'two-handed'),
  definition('greataxe', 'axe', 'two-handed'),
  definition('greatsword', 'blade', 'two-handed', SWORD_GRIP),
  definition('halberd', 'polearm', 'two-handed'),
  definition('lance', 'polearm', 'two-handed'),
  definition('longsword', 'blade', 'variable', SWORD_GRIP, MAGIC_LONGSWORD_IDS),
  definition('maul', 'hammer', 'two-handed'),
  definition('morningstar', 'mace'),
  definition('pike', 'polearm', 'two-handed'),
  definition('rapier', 'blade'),
  definition('scimitar', 'blade'),
  definition('shortsword', 'blade'),
  definition('trident', 'polearm', 'variable'),
  definition('warhammer', 'hammer', 'variable'),
  definition('war-pick', 'axe', 'variable'),
  definition('whip', 'whip'),
  definition('blowgun', 'blowgun'),
  definition('hand-crossbow', 'crossbow'),
  definition('heavy-crossbow', 'crossbow', 'two-handed', CROSSBOW_GRIP),
  definition('longbow', 'bow', 'two-handed', BOW_GRIP),
  definition('musket', 'firearm', 'two-handed'),
  definition('pistol', 'firearm'),
])

const SPEC_BY_KEY = new Map(WEAPON_MODELS.map((item) => [item.key, item]))

function material(name, color = COLORS[name] ?? COLORS.steel, options = {}) {
  const value = new THREE.MeshStandardMaterial({
    color,
    roughness: name === 'cloth' ? 0.94 : 0.82,
    metalness: name === 'steel' ? 0.62 : 0.035,
    ...options,
  })
  value.name = name
  return value
}

function palette() {
  return {
    steel: material('steel'),
    steelEdge: material('steel', COLORS.steelEdge, { metalness: 0.72, roughness: 0.45 }),
    steelDark: material('steel', COLORS.steelDark, { metalness: 0.56, roughness: 0.52 }),
    wood: material('wood'),
    woodLight: material('wood', COLORS.woodLight),
    woodDark: material('wood', COLORS.woodDark),
    leather: material('leather'),
    leatherLight: material('leather', COLORS.leatherLight),
    cloth: material('cloth'),
    clothLight: material('cloth', COLORS.clothLight),
    bone: material('bone'),
  }
}

function mesh(parent, name, geometry, value, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const object = new THREE.Mesh(geometry, value)
  object.name = name
  object.position.set(...position)
  object.rotation.set(...rotation)
  object.castShadow = true
  object.receiveShadow = true
  parent.add(object)
  return object
}

function box(parent, name, size, position, value, rotation = [0, 0, 0]) {
  return mesh(parent, name, new THREE.BoxGeometry(...size), value, position, rotation)
}

function roundedBox(parent, name, size, position, value, radius = 0.025, rotation = [0, 0, 0]) {
  const safeRadius = Math.min(radius, ...size.map((item) => Math.max(0.001, item / 2)))
  const geometry = new RoundedBoxGeometry(...size, 2, safeRadius)
  return mesh(parent, name, geometry, value, position, rotation)
}

function cylinder(parent, name, radiusTop, radiusBottom, height, position, value, segments = 8, rotation = [0, 0, 0]) {
  return mesh(parent, name, new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), value, position, rotation)
}

function cone(parent, name, radius, height, position, value, segments = 8, rotation = [0, 0, 0]) {
  return cylinder(parent, name, 0, radius, height, position, value, segments, rotation)
}

function dodecahedron(parent, name, size, position, value) {
  const object = mesh(parent, name, new THREE.DodecahedronGeometry(0.5, 0), value, position)
  object.scale.set(...size)
  return object
}

function torus(parent, name, radius, tube, position, value, rotation = [0, 0, 0], radialSegments = 8, tubularSegments = 12) {
  return mesh(parent, name, new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments), value, position, rotation)
}

function beam(parent, name, start, end, radius, value, segments = 6) {
  const a = new THREE.Vector3(...start)
  const b = new THREE.Vector3(...end)
  const direction = b.clone().sub(a)
  const length = direction.length()
  if (length < 0.0001) return null
  const object = cylinder(parent, name, radius * 0.82, radius, length, a.clone().add(b).multiplyScalar(0.5).toArray(), value, segments)
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  return object
}

function tube(parent, name, points, radius, value, tubularSegments = 12, radialSegments = 6) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, 'centripetal')
  return mesh(parent, name, new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false), value)
}

/** Объёмный контур в X/Y; клинок остаётся тонким вдоль направления Z. */
function blade(parent, name, points, depth, value) {
  const shape = new THREE.Shape()
  shape.moveTo(points[0][0], points[0][1])
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1, steps: 1 })
  geometry.translate(0, 0, -depth / 2)
  return mesh(parent, name, geometry, value)
}

function grip(parent, spec) {
  const node = new THREE.Group()
  node.name = 'hand-grip'
  node.position.set(...spec.grip.primary)
  node.userData = { role: 'primary-grip', weaponKey: spec.key }
  parent.add(node)
  if (spec.grip.offHand) {
    const offHand = new THREE.Group()
    offHand.name = 'off-hand-grip'
    offHand.position.set(...spec.grip.offHand)
    offHand.userData = { role: 'secondary-grip', weaponKey: spec.key }
    parent.add(offHand)
  }
}

function muzzle(parent, position, rotation = [0, 0, 0]) {
  const node = new THREE.Group()
  node.name = 'muzzle'
  node.position.set(...position)
  node.rotation.set(...rotation)
  node.userData = { role: 'projectile-origin' }
  parent.add(node)
  return node
}

/** Масштабирует геометрию вокруг рукояти, оставляя начало хвата в (0, 0, 0). */
function fitHeight(root, target) {
  if (!(target > 0)) return
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root)
  const current = bounds.max.y - bounds.min.y
  if (!(current > 0)) return
  const factor = target / current
  for (const child of root.children) {
    child.position.y *= factor
    child.scale.y *= factor
  }
}

function finish(root, key, targetHeight = null) {
  fitHeight(root, targetHeight)
  const item = SPEC_BY_KEY.get(key)
  root.name = `weapon:${key}`
  root.userData = { weaponKey: key, recipe: 'skazanie-weapons-v1', source: 'original', kind: item?.kind }
  grip(root, item)
  root.updateMatrixWorld(true)
  return root
}

function buildClub(key = 'club') {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'club-handle', 0.045, 0.055, 0.27, [0, 0.05, 0], p.wood, 8)
  torus(root, 'club-grip-binding', 0.052, 0.012, [0, -0.075, 0], p.leather, [Math.PI / 2, 0, 0])
  dodecahedron(root, 'club-head', [0.16, 0.18, 0.14], [0, 0.25, 0], p.woodLight)
  box(root, 'club-head-band', [0.18, 0.035, 0.15], [0, 0.24, 0], p.leather)
  return finish(root, key)
}

function buildDagger() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'dagger-grip', 0.04, 0.045, 0.18, [0, 0.01, 0], p.leather, 8)
  box(root, 'dagger-pommel', [0.07, 0.045, 0.07], [0, -0.1, 0], p.steelDark)
  box(root, 'dagger-guard', [0.17, 0.025, 0.045], [0, 0.12, 0], p.steel)
  blade(root, 'dagger-blade', [[-0.055, 0.13], [0.055, 0.13], [0.035, 0.39], [0, 0.56], [-0.035, 0.39]], 0.035, p.steelEdge)
  box(root, 'dagger-fuller', [0.018, 0.29, 0.006], [0, 0.3, 0.021], p.steelDark)
  return finish(root, 'dagger')
}

function buildGreatclub() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'greatclub-shaft', 0.06, 0.08, 0.68, [0, 0.27, 0], p.woodDark, 8)
  dodecahedron(root, 'greatclub-head', [0.27, 0.28, 0.22], [0, 0.66, 0], p.wood)
  box(root, 'greatclub-head-ridge', [0.32, 0.055, 0.12], [0, 0.73, 0], p.woodLight)
  torus(root, 'greatclub-neck-band', 0.095, 0.018, [0, 0.48, 0], p.leather, [Math.PI / 2, 0, 0])
  return finish(root, 'greatclub')
}

function buildHandaxe() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'handaxe-haft', 0.045, 0.052, 0.32, [0, 0.1, 0], p.wood, 8, [0, 0, 0.05])
  torus(root, 'handaxe-haft-grip', 0.052, 0.012, [0, -0.055, 0], p.leather, [Math.PI / 2, 0, 0])
  blade(root, 'handaxe-blade', [[0.02, 0.23], [0.13, 0.25], [0.3, 0.39], [0.27, 0.57], [0.1, 0.53], [0.02, 0.38]], 0.075, p.steel)
  blade(root, 'handaxe-edge', [[0.15, 0.28], [0.3, 0.39], [0.27, 0.57], [0.21, 0.46]], 0.082, p.steelEdge)
  return finish(root, 'handaxe')
}

function buildJavelin() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'javelin-shaft', 0.025, 0.034, 1.1, [0, 0.48, 0], p.wood, 7)
  blade(root, 'javelin-head', [[-0.03, 1.0], [0.03, 1.0], [0.045, 1.18], [0, 1.35], [-0.045, 1.18]], 0.035, p.steelEdge)
  for (const side of [-1, 1]) box(root, 'javelin-fletching', [0.055, 0.11, 0.012], [side * 0.035, -0.035, 0], p.cloth, [0, 0, side * 0.35])
  return finish(root, 'javelin', 1.3)
}

function buildLightHammer() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'light-hammer-grip', 0.045, 0.055, 0.26, [0, 0.07, 0], p.wood, 8)
  box(root, 'light-hammer-head', [0.26, 0.13, 0.16], [0, 0.27, 0], p.steel, [0, 0, 0])
  cylinder(root, 'light-hammer-neck', 0.055, 0.055, 0.1, [0, 0.21, 0], p.steelDark, 8)
  box(root, 'light-hammer-face', [0.045, 0.09, 0.18], [0, 0.27, 0.12], p.steelEdge)
  return finish(root, 'light-hammer')
}

function buildMace() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'mace-grip', 0.045, 0.055, 0.25, [0, 0.04, 0], p.leather, 8)
  torus(root, 'mace-collar', 0.065, 0.016, [0, 0.2, 0], p.steelDark, [Math.PI / 2, 0, 0])
  dodecahedron(root, 'mace-head', [0.13, 0.15, 0.13], [0, 0.31, 0], p.steel)
  for (let index = 0; index < 6; index += 1) {
    const angle = index * Math.PI / 3
    box(root, 'mace-flange', [0.18, 0.025, 0.045], [Math.cos(angle) * 0.09, 0.31 + Math.sin(angle) * 0.09, 0], p.steelEdge, [0, 0, angle])
  }
  return finish(root, 'mace')
}

function buildQuarterstaff() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'quarterstaff-shaft', 0.032, 0.04, 1.08, [0, 0.42, 0], p.wood, 8)
  cylinder(root, 'quarterstaff-cap-top', 0.05, 0.05, 0.035, [0, 0.975, 0], p.steelDark, 8)
  cylinder(root, 'quarterstaff-cap-bottom', 0.05, 0.05, 0.035, [0, -0.135, 0], p.steelDark, 8)
  for (const y of [0.07, 0.32, 0.56]) torus(root, 'quarterstaff-grip-wrap', 0.041, 0.007, [0, y, 0], p.leather, [Math.PI / 2, 0, 0])
  return finish(root, 'quarterstaff')
}

function buildSickle() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'sickle-grip', 0.042, 0.05, 0.2, [0, 0.01, 0], p.wood, 8)
  torus(root, 'sickle-pommel', 0.048, 0.012, [0, -0.105, 0], p.leather, [Math.PI / 2, 0, 0])
  blade(root, 'sickle-blade', [[0.01, 0.13], [0.11, 0.17], [0.23, 0.28], [0.31, 0.4], [0.3, 0.55], [0.21, 0.57], [0.18, 0.42], [0.09, 0.31]], 0.04, p.steelEdge)
  box(root, 'sickle-spine', [0.035, 0.31, 0.05], [0.08, 0.34, 0], p.steelDark, [0, 0, -0.25])
  return finish(root, 'sickle')
}

function buildSpear() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'spear-shaft', 0.028, 0.036, 1.12, [0, 0.45, 0], p.wood, 8)
  torus(root, 'spear-grip-ring', 0.041, 0.009, [0, 0.08, 0], p.leather, [Math.PI / 2, 0, 0])
  blade(root, 'spear-head', [[-0.035, 0.98], [0.035, 0.98], [0.055, 1.18], [0, 1.38], [-0.055, 1.18]], 0.045, p.steelEdge)
  box(root, 'spear-head-fuller', [0.014, 0.27, 0.008], [0, 1.14, 0.026], p.steelDark)
  return finish(root, 'spear', 1.3)
}

function buildDart() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'dart-shaft', 0.016, 0.022, 0.34, [0, 0.08, 0], p.wood, 7)
  blade(root, 'dart-tip', [[-0.022, 0.23], [0.022, 0.23], [0.026, 0.35], [0, 0.47], [-0.026, 0.35]], 0.022, p.steelEdge)
  for (const side of [-1, 1]) box(root, 'dart-fletching', [0.05, 0.09, 0.01], [side * 0.03, -0.12, 0], p.cloth, [0, 0, side * 0.32])
  muzzle(root, [0, 0.47, 0])
  return finish(root, 'dart')
}

function buildBow(key, tall) {
  const root = new THREE.Group(); const p = palette()
  const height = tall ? 0.92 : 0.68
  const half = tall ? 0.31 : 0.26
  const limb = [
    [-0.018, -0.05, 0.02], [-half * 0.66, -height * 0.36, 0.045], [-half, -height * 0.5, 0.055],
    [0, 0.02, 0.07],
    [half, height * 0.5, 0.055], [half * 0.66, height * 0.36, 0.045], [0.018, 0.05, 0.02],
  ]
  tube(root, `${key}-limb`, limb, tall ? 0.026 : 0.023, p.wood, 18, 6)
  beam(root, `${key}-string`, [-half, -height * 0.5, -0.005], [half, height * 0.5, -0.005], 0.009, p.leather, 5)
  box(root, `${key}-grip-wrap`, [0.07, 0.18, 0.05], [0, 0, 0.025], p.leather)
  box(root, `${key}-upper-nock`, [0.05, 0.025, 0.06], [0, height * 0.5, 0.055], p.steelDark)
  box(root, `${key}-lower-nock`, [0.05, 0.025, 0.06], [0, -height * 0.5, 0.055], p.steelDark)
  muzzle(root, [0, 0, 0.08])
  return finish(root, key)
}

function buildSling() {
  const root = new THREE.Group(); const p = palette()
  tube(root, 'sling-cord-left', [[0, 0, 0], [-0.1, 0.16, 0.05], [-0.16, 0.29, 0.09]], 0.012, p.leather, 8, 5)
  tube(root, 'sling-cord-right', [[0, 0, 0], [0.1, 0.16, 0.05], [0.16, 0.29, 0.09]], 0.012, p.leather, 8, 5)
  box(root, 'sling-pouch', [0.18, 0.025, 0.11], [0, 0.28, 0.1], p.leather, [0, 0.1, 0])
  dodecahedron(root, 'sling-projectile', [0.045, 0.045, 0.045], [0, 0.32, 0.1], p.steelDark)
  muzzle(root, [0, 0.32, 0.13])
  return finish(root, 'sling')
}

function buildNet() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'net-handle', 0.04, 0.048, 0.17, [0, 0.01, 0], p.wood, 8)
  torus(root, 'net-handle-loop', 0.06, 0.012, [0, -0.09, 0], p.leather, [Math.PI / 2, 0, 0])
  // Сеть остаётся свёрнутой в руке: ромбовидные ячейки читаются силуэтом,
  // но модель не пытается симулировать раскрытие или физику верёвки.
  const rows = [
    [[-0.11, 0.19, 0], [0, 0.31, 0.035], [0.11, 0.19, 0]],
    [[-0.08, 0.2, 0.015], [0, 0.12, 0.02], [0.08, 0.2, 0.015]],
  ]
  for (const [index, points] of rows.entries()) tube(root, `net-mesh-row-${index + 1}`, points, 0.012, p.cloth, 8, 5)
  for (const side of [-1, 1]) {
    tube(root, 'net-mesh-cord', [[side * 0.11, 0.19, 0], [side * 0.17, 0.08, 0.015], [side * 0.13, -0.01, 0]], 0.013, p.leather, 8, 5)
    dodecahedron(root, 'net-edge-weight', [0.04, 0.05, 0.04], [side * 0.13, -0.04, 0], p.steelDark)
  }
  muzzle(root, [0, 0.31, 0.04])
  return finish(root, 'net')
}

function buildBattleaxe() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'battleaxe-haft', 0.04, 0.052, 0.7, [0, 0.3, 0], p.wood, 8)
  torus(root, 'battleaxe-grip-wrap', 0.052, 0.012, [0, -0.04, 0], p.leather, [Math.PI / 2, 0, 0])
  blade(root, 'battleaxe-blade', [[0.02, 0.52], [0.15, 0.57], [0.33, 0.68], [0.39, 0.87], [0.33, 0.98], [0.14, 0.93], [0.02, 0.75]], 0.085, p.steel)
  blade(root, 'battleaxe-cutting-edge', [[0.29, 0.61], [0.39, 0.87], [0.33, 0.98], [0.27, 0.84]], 0.092, p.steelEdge)
  return finish(root, 'battleaxe')
}

function buildFlail() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'flail-grip', 0.045, 0.052, 0.24, [0, 0.04, 0], p.wood, 8)
  torus(root, 'flail-pommel', 0.055, 0.014, [0, -0.095, 0], p.steelDark, [Math.PI / 2, 0, 0])
  for (const [y, z] of [[0.18, 0], [0.27, 0.015], [0.36, 0]]) torus(root, 'flail-chain-link', 0.055, 0.012, [0, y, z], p.steel, [Math.PI / 2, z ? Math.PI / 2 : 0, 0], 6, 10)
  dodecahedron(root, 'flail-striker', [0.115, 0.12, 0.115], [0, 0.47, 0], p.steelDark)
  for (const side of [-1, 1]) cone(root, 'flail-striker-rivet', 0.025, 0.08, [side * 0.08, 0.47, 0], p.steelEdge, 6, [0, 0, side * Math.PI / 2])
  return finish(root, 'flail')
}

function buildGlaive() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'glaive-pole', 0.034, 0.045, 1.16, [0, 0.47, 0], p.wood, 8)
  blade(root, 'glaive-blade', [[0.01, 0.9], [0.13, 0.95], [0.3, 1.18], [0.28, 1.42], [0.16, 1.31], [0.03, 1.12]], 0.065, p.steelEdge)
  box(root, 'glaive-haft-socket', [0.085, 0.15, 0.09], [0, 0.96, 0], p.steelDark)
  return finish(root, 'glaive', 1.3)
}

function buildGreataxe() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'greataxe-haft', 0.045, 0.06, 0.82, [0, 0.34, 0], p.woodDark, 8)
  torus(root, 'greataxe-grip-wrap', 0.061, 0.014, [0, -0.06, 0], p.leather, [Math.PI / 2, 0, 0])
  blade(root, 'greataxe-blade', [[0.02, 0.58], [0.2, 0.62], [0.43, 0.75], [0.5, 0.96], [0.44, 1.11], [0.25, 1.06], [0.08, 0.88], [0.02, 0.75]], 0.105, p.steel)
  blade(root, 'greataxe-edge', [[0.35, 0.67], [0.5, 0.96], [0.44, 1.11], [0.35, 1.0]], 0.112, p.steelEdge)
  box(root, 'greataxe-eye', [0.14, 0.13, 0.12], [0.02, 0.66, 0], p.steelDark)
  return finish(root, 'greataxe')
}

function buildGreatsword() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'greatsword-grip', 0.048, 0.058, 0.3, [0, -0.02, 0], p.leather, 8)
  dodecahedron(root, 'greatsword-pommel', [0.075, 0.075, 0.075], [0, -0.2, 0], p.steelDark)
  box(root, 'greatsword-crossguard', [0.28, 0.035, 0.06], [0, 0.16, 0], p.steel)
  blade(root, 'greatsword-blade', [[-0.08, 0.18], [0.08, 0.18], [0.095, 0.7], [0.05, 1.02], [0, 1.18], [-0.05, 1.02], [-0.095, 0.7]], 0.065, p.steelEdge)
  box(root, 'greatsword-fuller', [0.025, 0.78, 0.008], [0, 0.57, 0.037], p.steelDark)
  return finish(root, 'greatsword', 1.0)
}

function buildHalberd() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'halberd-pole', 0.035, 0.045, 1.15, [0, 0.47, 0], p.wood, 8)
  blade(root, 'halberd-axe-head', [[0.01, 0.91], [0.16, 0.95], [0.34, 1.08], [0.34, 1.28], [0.24, 1.22], [0.06, 1.08]], 0.075, p.steel)
  blade(root, 'halberd-top-spike', [[-0.03, 1.06], [0.07, 1.06], [0.03, 1.48], [-0.04, 1.26]], 0.06, p.steelEdge)
  blade(root, 'halberd-hook', [[0.26, 0.98], [0.38, 1.0], [0.34, 0.84], [0.22, 0.89]], 0.065, p.steelEdge)
  return finish(root, 'halberd', 1.35)
}

function buildLance() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'lance-shaft', 0.034, 0.042, 1.3, [0, 0.56, 0], p.wood, 8)
  torus(root, 'lance-grip-wrap', 0.048, 0.01, [0, 0.06, 0], p.leather, [Math.PI / 2, 0, 0])
  blade(root, 'lance-head', [[-0.03, 1.17], [0.03, 1.17], [0.04, 1.36], [0, 1.53], [-0.04, 1.36]], 0.038, p.steelEdge)
  cylinder(root, 'lance-butt-cap', 0.052, 0.052, 0.045, [0, -0.12, 0], p.steelDark, 8)
  return finish(root, 'lance', 1.35)
}

function buildLongsword() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'longsword-grip', 0.043, 0.052, 0.23, [0, -0.005, 0], p.leather, 8)
  dodecahedron(root, 'longsword-pommel', [0.065, 0.065, 0.065], [0, -0.15, 0], p.steelDark)
  box(root, 'longsword-crossguard', [0.24, 0.032, 0.052], [0, 0.13, 0], p.steel)
  blade(root, 'longsword-blade', [[-0.06, 0.15], [0.06, 0.15], [0.07, 0.48], [0.045, 0.73], [0, 0.88], [-0.045, 0.73], [-0.07, 0.48]], 0.05, p.steelEdge)
  box(root, 'longsword-fuller', [0.018, 0.56, 0.007], [0, 0.43, 0.028], p.steelDark)
  return finish(root, 'longsword', 0.72)
}

function buildMaul() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'maul-shaft', 0.05, 0.065, 0.84, [0, 0.32, 0], p.woodDark, 8)
  roundedBox(root, 'maul-head', [0.34, 0.2, 0.2], [0, 0.8, 0], p.steel, 0.04)
  box(root, 'maul-head-face-front', [0.25, 0.13, 0.055], [0, 0.8, 0.13], p.steelEdge)
  box(root, 'maul-head-band', [0.37, 0.035, 0.22], [0, 0.8, 0], p.steelDark)
  return finish(root, 'maul')
}

function buildMorningstar() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'morningstar-grip', 0.045, 0.052, 0.28, [0, 0.05, 0], p.wood, 8)
  dodecahedron(root, 'morningstar-head', [0.13, 0.13, 0.13], [0, 0.31, 0], p.steelDark)
  for (const [x, y, z, rot] of [[0.12, 0.31, 0, [0, 0, Math.PI / 2]], [-0.12, 0.31, 0, [0, 0, -Math.PI / 2]], [0, 0.43, 0, [0, 0, 0]], [0, 0.19, 0, [Math.PI, 0, 0]], [0, 0.31, 0.12, [Math.PI / 2, 0, 0]], [0, 0.31, -0.12, [-Math.PI / 2, 0, 0]]]) cone(root, 'morningstar-spike', 0.027, 0.1, [x, y, z], p.steelEdge, 6, rot)
  return finish(root, 'morningstar')
}

function buildPike() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'pike-shaft', 0.035, 0.045, 1.52, [0, 0.7, 0], p.woodDark, 8)
  torus(root, 'pike-grip-wrap', 0.052, 0.01, [0, 0.13, 0], p.leather, [Math.PI / 2, 0, 0])
  blade(root, 'pike-head', [[-0.035, 1.4], [0.035, 1.4], [0.043, 1.63], [0, 1.83], [-0.043, 1.63]], 0.045, p.steelEdge)
  cylinder(root, 'pike-butt-cap', 0.052, 0.052, 0.045, [0, -0.08, 0], p.steelDark, 8)
  return finish(root, 'pike', 1.55)
}

function buildRapier() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'rapier-grip', 0.035, 0.042, 0.22, [0, 0, 0], p.leather, 8)
  dodecahedron(root, 'rapier-pommel', [0.05, 0.05, 0.05], [0, -0.14, 0], p.steelDark)
  torus(root, 'rapier-guard', 0.105, 0.014, [0, 0.13, 0], p.steel, [Math.PI / 2, 0, 0], 8, 16)
  blade(root, 'rapier-blade', [[-0.018, 0.15], [0.018, 0.15], [0.015, 0.72], [0, 0.98], [-0.015, 0.72]], 0.026, p.steelEdge)
  box(root, 'rapier-knuckle-bow', [0.018, 0.17, 0.018], [0.09, 0.05, 0.02], p.steelDark, [0, 0.25, 0])
  return finish(root, 'rapier', 0.95)
}

function buildScimitar() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'scimitar-grip', 0.042, 0.048, 0.2, [0, 0.01, 0], p.leather, 8)
  box(root, 'scimitar-guard', [0.19, 0.03, 0.05], [0, 0.12, 0], p.steel)
  blade(root, 'scimitar-blade', [[-0.06, 0.14], [0.05, 0.14], [0.13, 0.39], [0.2, 0.55], [0.16, 0.73], [0.06, 0.79], [0.08, 0.59], [-0.01, 0.4]], 0.045, p.steelEdge)
  box(root, 'scimitar-spine', [0.025, 0.46, 0.025], [0.1, 0.42, 0], p.steelDark, [0, 0, -0.25])
  return finish(root, 'scimitar', 0.78)
}

function buildShortsword() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'shortsword-grip', 0.04, 0.045, 0.18, [0, 0, 0], p.leather, 8)
  box(root, 'shortsword-pommel', [0.07, 0.04, 0.06], [0, -0.11, 0], p.steelDark)
  box(root, 'shortsword-guard', [0.18, 0.028, 0.045], [0, 0.11, 0], p.steel)
  blade(root, 'shortsword-blade', [[-0.05, 0.13], [0.05, 0.13], [0.055, 0.39], [0, 0.64], [-0.055, 0.39]], 0.043, p.steelEdge)
  return finish(root, 'shortsword', 0.68)
}

function buildTrident() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'trident-shaft', 0.034, 0.044, 0.9, [0, 0.36, 0], p.wood, 8)
  box(root, 'trident-collar', [0.16, 0.06, 0.09], [0, 0.79, 0], p.steelDark)
  for (const x of [-0.13, 0, 0.13]) {
    cylinder(root, 'trident-prong-shaft', 0.018, 0.022, 0.28, [x, 0.99, 0], p.steel, 7)
    blade(root, 'trident-prong', [[x - 0.025, 1.1], [x + 0.025, 1.1], [x + 0.025, 1.27], [x, 1.42], [x - 0.025, 1.27]], 0.032, p.steelEdge)
  }
  return finish(root, 'trident')
}

function buildWarhammer() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'warhammer-grip', 0.045, 0.052, 0.34, [0, 0.08, 0], p.wood, 8)
  roundedBox(root, 'warhammer-head', [0.3, 0.14, 0.18], [0, 0.31, 0], p.steel, 0.025)
  box(root, 'warhammer-face', [0.045, 0.09, 0.2], [0, 0.31, 0.13], p.steelEdge)
  box(root, 'warhammer-peen', [0.07, 0.1, 0.16], [0.18, 0.31, 0], p.steelDark)
  return finish(root, 'warhammer')
}

function buildWarPick() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'war-pick-haft', 0.045, 0.052, 0.31, [0, 0.07, 0], p.wood, 8)
  box(root, 'war-pick-head', [0.26, 0.1, 0.13], [0, 0.28, 0], p.steelDark)
  blade(root, 'war-pick-beak', [[0.1, 0.31], [0.22, 0.34], [0.38, 0.25], [0.34, 0.18], [0.17, 0.25]], 0.065, p.steelEdge)
  box(root, 'war-pick-back', [0.08, 0.13, 0.16], [-0.15, 0.28, 0], p.steel)
  return finish(root, 'war-pick')
}

function buildWhip() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'whip-handle', 0.04, 0.05, 0.22, [0, 0.02, 0], p.leather, 8)
  torus(root, 'whip-handle-collar', 0.052, 0.012, [0, 0.13, 0], p.steelDark, [Math.PI / 2, 0, 0])
  tube(root, 'whip-coiled-thong', [[0, 0.14, 0], [0.08, 0.2, 0.03], [0.17, 0.28, 0.05], [0.2, 0.38, 0.08], [0.14, 0.47, 0.1], [0.04, 0.51, 0.11]], 0.018, p.leatherLight, 18, 6)
  tube(root, 'whip-tip', [[0.04, 0.51, 0.11], [0.01, 0.55, 0.11]], 0.009, p.leather, 6, 5)
  return finish(root, 'whip')
}

function buildBlowgun() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'blowgun-tube', 0.045, 0.052, 0.94, [0, 0.43, 0], p.woodDark, 10)
  cylinder(root, 'blowgun-muzzle-ring', 0.068, 0.068, 0.05, [0, 0.925, 0], p.leather, 10)
  cylinder(root, 'blowgun-mouthpiece', 0.06, 0.045, 0.07, [0, -0.075, 0], p.woodLight, 8)
  box(root, 'blowgun-sight', [0.025, 0.07, 0.025], [0, 0.58, 0], p.steelDark)
  muzzle(root, [0, 0.98, 0])
  return finish(root, 'blowgun')
}

function buildCrossbow(key, heavy, hand) {
  const root = new THREE.Group(); const p = palette()
  const width = heavy ? 0.54 : hand ? 0.38 : 0.47
  const depth = heavy ? 0.62 : hand ? 0.46 : 0.56
  box(root, `${key}-stock`, [0.1, 0.11, depth], [0, 0.035, depth / 2 - 0.08], p.wood, [0, 0, 0])
  box(root, `${key}-grip`, [0.09, hand ? 0.2 : 0.24, 0.1], [0, hand ? -0.05 : -0.06, 0.02], p.woodDark, [0.12, 0, 0])
  cylinder(root, `${key}-barrel`, 0.022, 0.026, depth * 0.78, [0, 0.11, depth * 0.46], p.steelDark, 8, [Math.PI / 2, 0, 0])
  box(root, `${key}-prod-center`, [0.08, 0.08, 0.12], [0, 0.09, 0.02], p.steelDark)
  box(root, `${key}-prod-left`, [width / 2, 0.055, 0.065], [-width / 4, 0.09, 0.02], p.woodLight, [0, 0, hand ? -0.18 : -0.12])
  box(root, `${key}-prod-right`, [width / 2, 0.055, 0.065], [width / 4, 0.09, 0.02], p.woodLight, [0, 0, hand ? 0.18 : 0.12])
  beam(root, `${key}-string`, [-width / 2, 0.09, 0.02], [0, 0.09, depth * 0.45], 0.009, p.leather, 5)
  beam(root, `${key}-string-return`, [width / 2, 0.09, 0.02], [0, 0.09, depth * 0.45], 0.009, p.leather, 5)
  box(root, `${key}-trigger-guard`, [0.08, 0.06, 0.12], [0, -0.055, 0.16], p.steelDark)
  muzzle(root, [0, 0.11, depth * 0.82], [Math.PI / 2, 0, 0])
  return finish(root, key)
}

function buildFirearm(key, long) {
  const root = new THREE.Group(); const p = palette()
  const barrelLength = long ? 0.75 : 0.38
  const stockLength = long ? 0.32 : 0.2
  box(root, `${key}-stock`, [long ? 0.12 : 0.1, stockLength, 0.1], [0, -stockLength / 2, 0], p.wood, [0.12, 0, 0])
  cylinder(root, `${key}-barrel`, long ? 0.045 : 0.04, long ? 0.052 : 0.048, barrelLength, [0, barrelLength / 2 - 0.02, 0], p.steel, 8)
  cylinder(root, `${key}-muzzle-ring`, long ? 0.067 : 0.058, long ? 0.067 : 0.058, 0.045, [0, barrelLength - 0.02, 0], p.steelDark, 8)
  box(root, `${key}-trigger-guard`, [0.06, 0.08, 0.06], [0, -0.16, 0], p.steelDark)
  box(root, `${key}-trigger`, [0.02, 0.07, 0.025], [0, -0.13, 0.045], p.steelEdge)
  box(root, `${key}-sight`, [0.018, 0.045, 0.018], [0, long ? 0.25 : 0.14, 0], p.steelEdge)
  muzzle(root, [0, barrelLength + 0.025, 0])
  return finish(root, key)
}

const BUILDERS = new Map([
  ['club', () => buildClub()], ['dagger', buildDagger], ['greatclub', buildGreatclub], ['handaxe', buildHandaxe],
  ['javelin', buildJavelin], ['light-hammer', buildLightHammer], ['mace', buildMace], ['quarterstaff', buildQuarterstaff],
  ['sickle', buildSickle], ['spear', buildSpear], ['dart', buildDart], ['light-crossbow', () => buildCrossbow('light-crossbow', false, false)],
  ['shortbow', () => buildBow('shortbow', false)], ['sling', buildSling], ['net', buildNet], ['battleaxe', buildBattleaxe], ['flail', buildFlail],
  ['glaive', buildGlaive], ['greataxe', buildGreataxe], ['greatsword', buildGreatsword], ['halberd', buildHalberd], ['lance', buildLance],
  ['longsword', buildLongsword], ['maul', buildMaul], ['morningstar', buildMorningstar], ['pike', buildPike], ['rapier', buildRapier],
  ['scimitar', buildScimitar], ['shortsword', buildShortsword], ['trident', buildTrident], ['warhammer', buildWarhammer], ['war-pick', buildWarPick],
  ['whip', buildWhip], ['blowgun', buildBlowgun], ['hand-crossbow', () => buildCrossbow('hand-crossbow', false, true)],
  ['heavy-crossbow', () => buildCrossbow('heavy-crossbow', true, false)], ['longbow', () => buildBow('longbow', true)],
  ['musket', () => buildFirearm('musket', true)], ['pistol', () => buildFirearm('pistol', false)],
])

const catalogWeapons = Object.values(ITEM_CATALOG).filter((item) => item.category === 'weapon' && !item.magic_item?.base_item_catalog_id)
const coveredCatalogIds = new Set(WEAPON_MODELS.flatMap((item) => item.catalogIds))
for (const item of catalogWeapons) {
  if (!coveredCatalogIds.has(item.catalog_id)) throw new Error(`Оружие каталога не имеет модели: ${item.catalog_id}`)
}
if (BUILDERS.size !== WEAPON_MODELS.length) throw new Error('Каталог моделей оружия и фабрики расходятся')

/** Создаёт независимую модель; неизвестный ключ оставляет прежний запасной вариант рендера. */
export function createWeaponModel(key) {
  const builder = BUILDERS.get(String(key ?? ''))
  return builder ? builder() : null
}
