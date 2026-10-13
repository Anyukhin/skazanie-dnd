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
  steel: '#8b949a',
  steelEdge: '#9ea6ac',
  steelDark: '#4b5257',
  brass: '#b08d4f',
  wood: '#6e4c31',
  woodLight: '#9b7149',
  woodDark: '#3a2a1e',
  leather: '#4a2f22',
  leatherLight: '#7a5034',
  cloth: '#d6ccb6',
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
const SWORD_GRIP = Object.freeze({ primary: Object.freeze([0, 0, 0]), offHand: Object.freeze([0, -0.07, 0]) })
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

/**
 * Рецепты пишутся в метрах настоящего оружия (длинный меч — 1,1 м, клинок
 * шириной 4,8 см), а в каноническую фигурку ростом 1,4 м приводятся одним
 * множителем. Прежние модели были вылеплены «на глаз» и выходили втрое-
 * вчетверо шире настоящих: меч в руке героя читался серым бруском.
 */
const HUMAN_HEIGHT = 1.8
const CANONICAL_HEIGHT = 1.4
const SCALE = CANONICAL_HEIGHT / HUMAN_HEIGHT

function material(name, color = COLORS[name] ?? COLORS.steel, options = {}) {
  const value = new THREE.MeshStandardMaterial({
    color,
    roughness: name === 'cloth' ? 0.94 : name === 'steel' ? 0.38 : 0.78,
    metalness: name === 'steel' ? 0.78 : 0.035,
    ...options,
  })
  value.name = name
  return value
}

function palette() {
  return {
    steel: material('steel'),
    steelEdge: material('steel', COLORS.steelEdge, { metalness: 0.55, roughness: 0.52, side: THREE.DoubleSide }),
    steelDark: material('steel', COLORS.steelDark, { metalness: 0.7, roughness: 0.46 }),
    brass: material('steel', COLORS.brass, { metalness: 0.82, roughness: 0.34 }),
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

function roundedBox(parent, name, size, position, value, radius = 0.01, rotation = [0, 0, 0]) {
  const safeRadius = Math.min(radius, ...size.map((item) => Math.max(0.001, item / 2)))
  return mesh(parent, name, new RoundedBoxGeometry(...size, 2, safeRadius), value, position, rotation)
}

function cylinder(parent, name, radiusTop, radiusBottom, height, position, value, segments = 10, rotation = [0, 0, 0]) {
  return mesh(parent, name, new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), value, position, rotation)
}

function cone(parent, name, radius, height, position, value, segments = 8, rotation = [0, 0, 0]) {
  return cylinder(parent, name, 0, radius, height, position, value, segments, rotation)
}

function sphere(parent, name, radius, position, value, scale = [1, 1, 1]) {
  const object = mesh(parent, name, new THREE.SphereGeometry(radius, 12, 8), value, position)
  object.scale.set(...scale)
  return object
}

function torus(parent, name, radius, tube, position, value, rotation = [Math.PI / 2, 0, 0], radialSegments = 6, tubularSegments = 16) {
  return mesh(parent, name, new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments), value, position, rotation)
}

function tube(parent, name, points, radius, value, tubularSegments = 16, radialSegments = 6) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, 'centripetal')
  return mesh(parent, name, new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false), value)
}

function beam(parent, name, start, end, radius, value, segments = 6) {
  const a = new THREE.Vector3(...start)
  const b = new THREE.Vector3(...end)
  const direction = b.clone().sub(a)
  const length = direction.length()
  if (length < 0.0001) return null
  const object = cylinder(parent, name, radius, radius, length, a.clone().add(b).multiplyScalar(0.5).toArray(), value, segments)
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  return object
}

/**
 * Клинок с ромбовидным сечением. Станции идут от пяты к острию:
 * [x, y, ширина влево, ширина вправо, сдвиг ребра, доля толщины]. Ребро
 * сдвигается к обуху у однолезвийных клинков (сабля, глефа, серп).
 */
function blade(parent, name, stations, thickness, value) {
  const points = stations.map(([x, y, wL, wR, ridge = 0, t = 1]) => ({ x, y, wL, wR, ridge, t }))
  const tangent = (index) => {
    const a = points[Math.max(0, index - 1)]
    const b = points[Math.min(points.length - 1, index + 1)]
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return [(b.x - a.x) / length, (b.y - a.y) / length]
  }
  const rings = points.map((point, index) => {
    const [tx, ty] = tangent(index)
    const nx = -ty; const ny = tx
    const half = thickness * point.t / 2
    return {
      L: [point.x + nx * point.wL, point.y + ny * point.wL, 0],
      R: [point.x - nx * point.wR, point.y - ny * point.wR, 0],
      F: [point.x + nx * point.ridge, point.y + ny * point.ridge, half],
      B: [point.x + nx * point.ridge, point.y + ny * point.ridge, -half],
    }
  })
  const positions = []
  const quad = (a, b, c, d) => positions.push(...a, ...b, ...c, ...a, ...c, ...d)
  for (let index = 0; index < rings.length - 1; index += 1) {
    const r0 = rings[index]; const r1 = rings[index + 1]
    quad(r0.L, r0.F, r1.F, r1.L)
    quad(r0.F, r0.R, r1.R, r1.F)
    quad(r0.R, r0.B, r1.B, r1.R)
    quad(r0.B, r0.L, r1.L, r1.B)
  }
  const first = rings[0]
  quad(first.L, first.B, first.R, first.F)
  const last = rings.at(-1)
  if (Math.hypot(last.L[0] - last.R[0], last.L[1] - last.R[1]) > 1e-5) quad(last.L, last.F, last.R, last.B)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return mesh(parent, name, geometry, value)
}

/** Плоская деталь по контуру в XY: толщина спадает от обуха к лезвию клином. */
function wedge(parent, name, points, thickness, value, edgeAt = 'max-x', edgeShare = 0.18) {
  const shape = new THREE.Shape()
  shape.moveTo(points[0][0], points[0][1])
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1, steps: 1 })
  geometry.translate(0, 0, -thickness / 2)
  geometry.computeBoundingBox()
  const { min, max } = geometry.boundingBox
  const position = geometry.getAttribute('position')
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index)
    const share = edgeAt === 'min-x' ? (max.x - x) / Math.max(1e-6, max.x - min.x) : (x - min.x) / Math.max(1e-6, max.x - min.x)
    position.setZ(index, position.getZ(index) * (1 - share * (1 - edgeShare)))
  }
  geometry.computeVertexNormals()
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

/** Метры настоящего оружия → каноническая фигурка; хват остаётся в (0, 0, 0). */
function finish(root, key) {
  for (const child of root.children) {
    child.position.multiplyScalar(SCALE)
    child.scale.multiplyScalar(SCALE)
  }
  const item = SPEC_BY_KEY.get(key)
  root.name = `weapon:${key}`
  root.userData = { weaponKey: key, recipe: 'skazanie-weapons-v2', source: 'original', kind: item?.kind, units: 'real-meters-scaled' }
  grip(root, item)
  root.updateMatrixWorld(true)
  return root
}

/** Рукоять с навершием и гардой; клинок начинается над гардой. */
function hilt(root, key, p, { grip: length = 0.2, radius = 0.015, guard = 0.2, pommel = 0.024 } = {}) {
  cylinder(root, `${key}-grip`, radius, radius * 1.08, length, [0, 0, 0], p.leather, 10)
  for (const y of [-length * 0.3, 0, length * 0.3]) torus(root, `${key}-grip-wrap`, radius * 1.02, 0.0028, [0, y, 0], p.leatherLight)
  sphere(root, `${key}-pommel`, pommel, [0, -length / 2 - pommel * 0.75, 0], p.steelDark, [1, 0.85, 0.75])
  roundedBox(root, `${key}-crossguard`, [guard, 0.02, 0.026], [0, length / 2 + 0.01, 0], p.steel, 0.006)
  return length / 2 + 0.02
}

/** Прямой обоюдоострый клинок: пята, мягкое сужение, острие. */
function straightBlade(root, key, p, base, length, width, thickness = 0.009, fuller = true) {
  const tip = Math.min(length * 0.22, width * 3.2)
  blade(root, `${key}-blade`, [
    [0, base, width / 2, width / 2],
    [0, base + length * 0.55, width * 0.43, width * 0.43],
    [0, base + length - tip, width * 0.36, width * 0.36, 0, 0.85],
    [0, base + length, 0, 0, 0, 0.3],
  ], thickness, p.steelEdge)
  if (fuller) box(root, `${key}-fuller`, [width * 0.16, length * 0.62, 0.002], [0, base + length * 0.36, thickness / 2 - 0.0006], p.steelDark)
}

function buildClub(key = 'club') {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, `${key}-handle`, 0.02, 0.016, 0.3, [0, 0, 0], p.wood, 9)
  torus(root, `${key}-grip-binding`, 0.018, 0.004, [0, -0.06, 0], p.leather)
  cylinder(root, `${key}-head`, 0.036, 0.02, 0.34, [0, 0.32, 0], p.woodLight, 9)
  sphere(root, `${key}-head-knot`, 0.036, [0, 0.49, 0], p.woodLight, [1, 0.7, 1])
  for (const [x, y, z] of [[0.03, 0.36, 0.01], [-0.026, 0.42, -0.016], [0.006, 0.3, 0.032]]) sphere(root, `${key}-head-burl`, 0.014, [x, y, z], p.wood)
  return finish(root, key)
}

function buildDagger() {
  const root = new THREE.Group(); const p = palette()
  const base = hilt(root, 'dagger', p, { grip: 0.1, radius: 0.012, guard: 0.085, pommel: 0.016 })
  straightBlade(root, 'dagger', p, base, 0.22, 0.034, 0.008, false)
  return finish(root, 'dagger')
}

function buildGreatclub() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'greatclub-shaft', 0.026, 0.022, 0.6, [0, 0.05, 0], p.woodDark, 9)
  cylinder(root, 'greatclub-head', 0.062, 0.03, 0.46, [0, 0.58, 0], p.wood, 9)
  sphere(root, 'greatclub-head-cap', 0.062, [0, 0.81, 0], p.wood, [1, 0.6, 1])
  torus(root, 'greatclub-iron-band', 0.058, 0.007, [0, 0.66, 0], p.steelDark)
  torus(root, 'greatclub-iron-band', 0.05, 0.007, [0, 0.5, 0], p.steelDark)
  for (const [x, y, z] of [[0.055, 0.72, 0], [-0.05, 0.6, 0.02], [0.01, 0.76, -0.055]]) cone(root, 'greatclub-stud', 0.01, 0.022, [x, y, z], p.steelDark, 5, [0, 0, x > 0.03 ? -Math.PI / 2 : x < -0.03 ? Math.PI / 2 : 0])
  torus(root, 'greatclub-grip-wrap', 0.025, 0.004, [0, -0.1, 0], p.leather)
  return finish(root, 'greatclub')
}

/** Топорище с проушиной и клином лезвия в сторону +X. */
function axeHead(root, key, p, top, scale, bearded = true) {
  const s = scale
  box(root, `${key}-eye`, [0.04 * s, 0.07 * s, 0.038 * s], [0, top - 0.03 * s, 0], p.steelDark)
  const head = bearded
    ? [[0.015, -0.055], [0.05, -0.05], [0.085, -0.085], [0.12, -0.1], [0.135, -0.04], [0.135, 0.03], [0.12, 0.06], [0.07, 0.025], [0.015, 0.01]]
    : [[0.015, -0.05], [0.06, -0.06], [0.12, -0.085], [0.14, -0.02], [0.14, 0.04], [0.12, 0.08], [0.06, 0.035], [0.015, 0.02]]
  wedge(root, `${key}-blade`, head.map(([x, y]) => [x * s, top - 0.02 * s + y * s]), 0.026 * s, p.steel)
  wedge(root, `${key}-cutting-edge`, (bearded
    ? [[0.112, -0.1], [0.12, -0.1], [0.135, -0.04], [0.135, 0.03], [0.12, 0.06], [0.112, 0.056], [0.125, 0.03], [0.125, -0.04]]
    : [[0.122, -0.085], [0.13, -0.083], [0.14, -0.02], [0.14, 0.04], [0.12, 0.08], [0.115, 0.075], [0.13, 0.04], [0.13, -0.02]]).map(([x, y]) => [x * s, top - 0.02 * s + y * s]), 0.012 * s, p.steelEdge)
}

function buildHandaxe() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'handaxe-haft', 0.016, 0.018, 0.4, [0, 0.07, 0], p.wood, 9)
  torus(root, 'handaxe-haft-grip', 0.018, 0.004, [0, -0.06, 0], p.leather)
  axeHead(root, 'handaxe', p, 0.27, 0.85)
  return finish(root, 'handaxe')
}

function buildBattleaxe() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'battleaxe-haft', 0.018, 0.021, 0.78, [0, 0.18, 0], p.wood, 9)
  torus(root, 'battleaxe-grip-wrap', 0.021, 0.004, [0, -0.05, 0], p.leather)
  cylinder(root, 'battleaxe-butt', 0.022, 0.02, 0.03, [0, -0.205, 0], p.steelDark, 9)
  axeHead(root, 'battleaxe', p, 0.56, 1.35)
  cone(root, 'battleaxe-back-spike', 0.016, 0.06, [-0.045, 0.51, 0], p.steelDark, 6, [0, 0, Math.PI / 2])
  return finish(root, 'battleaxe')
}

function buildGreataxe() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'greataxe-haft', 0.02, 0.024, 1.2, [0, 0.27, 0], p.woodDark, 9)
  torus(root, 'greataxe-grip-wrap', 0.024, 0.005, [0, -0.08, 0], p.leather)
  torus(root, 'greataxe-grip-wrap', 0.024, 0.005, [0, 0.2, 0], p.leather)
  box(root, 'greataxe-eye', [0.06, 0.12, 0.05], [0, 0.78, 0], p.steelDark)
  // Двулезвийная секира: два полумесяца в обе стороны от проушины.
  for (const side of [1, -1]) {
    const crescent = [[0.025, -0.07], [0.09, -0.11], [0.16, -0.16], [0.19, -0.06], [0.2, 0.04], [0.18, 0.14], [0.12, 0.11], [0.06, 0.07], [0.025, 0.06]]
    wedge(root, `greataxe-blade${side > 0 ? '' : '-back'}`, crescent.map(([x, y]) => [x * side, 0.79 + y]), 0.03, p.steel, side > 0 ? 'max-x' : 'min-x')
    tube(root, `greataxe-edge${side > 0 ? '' : '-back'}`, [[0.16 * side, 0.63, 0], [0.19 * side, 0.73, 0], [0.2 * side, 0.83, 0], [0.18 * side, 0.93, 0]], 0.0045, p.steelEdge, 12, 5)
  }
  cone(root, 'greataxe-top-spike', 0.014, 0.08, [0, 0.88, 0], p.steelDark, 6)
  return finish(root, 'greataxe')
}

function buildJavelin() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'javelin-shaft', 0.011, 0.013, 1.3, [0, 0.2, 0], p.wood, 8)
  torus(root, 'javelin-grip-binding', 0.013, 0.004, [0, 0, 0], p.leather)
  cone(root, 'javelin-socket', 0.014, 0.06, [0, 0.88, 0], p.steelDark, 8)
  blade(root, 'javelin-head', [[0, 0.88, 0.012, 0.012], [0, 0.94, 0.016, 0.016], [0, 1.01, 0, 0, 0, 0.3]], 0.008, p.steelEdge)
  return finish(root, 'javelin')
}

function buildLightHammer() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'light-hammer-grip', 0.015, 0.017, 0.36, [0, 0.06, 0], p.wood, 9)
  torus(root, 'light-hammer-grip-wrap', 0.017, 0.004, [0, -0.06, 0], p.leather)
  box(root, 'light-hammer-head', [0.1, 0.034, 0.034], [0.012, 0.25, 0], p.steel)
  cylinder(root, 'light-hammer-face', 0.022, 0.02, 0.025, [0.072, 0.25, 0], p.steelEdge, 10, [0, 0, Math.PI / 2])
  wedge(root, 'light-hammer-claw', [[-0.035, -0.012], [-0.075, -0.02], [-0.085, -0.04], [-0.06, -0.012], [-0.035, 0.012]].map(([x, y]) => [x, 0.25 + y]), 0.024, p.steelDark, 'min-x', 0.5)
  return finish(root, 'light-hammer')
}

function buildMace() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'mace-grip', 0.016, 0.017, 0.2, [0, 0, 0], p.leather, 9)
  cylinder(root, 'mace-haft', 0.013, 0.015, 0.28, [0, 0.24, 0], p.steelDark, 9)
  sphere(root, 'mace-pommel', 0.02, [0, -0.11, 0], p.steelDark)
  cylinder(root, 'mace-head', 0.022, 0.026, 0.11, [0, 0.42, 0], p.steel, 10)
  sphere(root, 'mace-head-cap', 0.022, [0, 0.475, 0], p.steel, [1, 0.6, 1])
  for (let index = 0; index < 7; index += 1) {
    const angle = index * Math.PI * 2 / 7
    const flange = wedge(root, 'mace-flange', [[0.018, -0.055], [0.05, -0.035], [0.055, 0.02], [0.04, 0.055], [0.018, 0.06]].map(([x, y]) => [x, y]), 0.007, p.steelEdge, 'max-x', 0.4)
    flange.position.set(0, 0.42, 0)
    flange.rotation.y = angle
  }
  return finish(root, 'mace')
}

function buildMorningstar() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'morningstar-grip', 0.016, 0.018, 0.5, [0, 0.1, 0], p.wood, 9)
  torus(root, 'morningstar-grip-wrap', 0.018, 0.004, [0, -0.05, 0], p.leather)
  torus(root, 'morningstar-collar', 0.02, 0.006, [0, 0.36, 0], p.steelDark)
  sphere(root, 'morningstar-head', 0.045, [0, 0.43, 0], p.steelDark)
  const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [0.7, 0.7, 0], [-0.7, 0.7, 0], [0, 0.7, 0.7], [0, 0.7, -0.7], [0.7, -0.3, 0.6], [-0.7, -0.3, -0.6]]
  for (const [x, y, z] of directions) {
    const direction = new THREE.Vector3(x, y, z).normalize()
    const spike = cone(root, 'morningstar-spike', 0.009, 0.035, direction.clone().multiplyScalar(0.058).add(new THREE.Vector3(0, 0.43, 0)).toArray(), p.steelEdge, 6)
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction)
  }
  return finish(root, 'morningstar')
}

function buildQuarterstaff() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'quarterstaff-shaft', 0.017, 0.018, 1.8, [0, 0.15, 0], p.wood, 9)
  cylinder(root, 'quarterstaff-cap-top', 0.02, 0.019, 0.05, [0, 1.04, 0], p.steelDark, 9)
  cylinder(root, 'quarterstaff-cap-bottom', 0.019, 0.02, 0.05, [0, -0.74, 0], p.steelDark, 9)
  for (const y of [-0.05, 0.05, 0.45, 0.55]) torus(root, 'quarterstaff-grip-wrap', 0.0185, 0.0035, [0, y, 0], p.leather)
  return finish(root, 'quarterstaff')
}

function buildSickle() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'sickle-grip', 0.015, 0.017, 0.14, [0, 0, 0], p.wood, 9)
  torus(root, 'sickle-ferrule', 0.016, 0.004, [0, 0.07, 0], p.steelDark)
  const stations = []
  for (let index = 0; index <= 8; index += 1) {
    const angle = Math.PI * 0.95 - index / 8 * Math.PI * 1.05
    const width = 0.018 * (1 - index / 8) + 0.002
    stations.push([0.11 + Math.cos(angle) * 0.11, 0.075 + Math.sin(angle) * 0.13, width * 0.35, width, width * 0.25, 1 - index / 12])
  }
  stations[0][0] = 0; stations[0][1] = 0.075
  blade(root, 'sickle-blade', stations, 0.006, p.steelEdge)
  return finish(root, 'sickle')
}

function polearmShaft(root, key, p, bottom, top, radius = 0.015) {
  cylinder(root, `${key}-shaft`, radius * 0.95, radius, top - bottom, [0, (top + bottom) / 2, 0], p.wood, 9)
  cylinder(root, `${key}-butt-cap`, radius * 1.15, radius * 1.05, 0.04, [0, bottom - 0.01, 0], p.steelDark, 9)
  torus(root, `${key}-grip-wrap`, radius * 1.05, 0.004, [0, 0, 0], p.leather)
}

function buildSpear() {
  const root = new THREE.Group(); const p = palette()
  polearmShaft(root, 'spear', p, -0.6, 1.25)
  cone(root, 'spear-socket', 0.017, 0.09, [0, 1.27, 0], p.steelDark, 9)
  blade(root, 'spear-head', [[0, 1.28, 0.012, 0.012], [0, 1.35, 0.024, 0.024], [0, 1.43, 0.017, 0.017], [0, 1.5, 0, 0, 0, 0.3]], 0.012, p.steelEdge)
  return finish(root, 'spear')
}

function buildDart() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'dart-shaft', 0.006, 0.007, 0.22, [0, 0.02, 0], p.wood, 7)
  blade(root, 'dart-tip', [[0, 0.13, 0.009, 0.009], [0, 0.17, 0.008, 0.008], [0, 0.21, 0, 0, 0, 0.3]], 0.006, p.steelEdge)
  for (const angle of [0, Math.PI / 2]) {
    const fletching = box(root, 'dart-fletching', [0.034, 0.05, 0.002], [0, -0.075, 0], p.cloth)
    fletching.rotation.y = angle
  }
  muzzle(root, [0, 0.21, 0])
  return finish(root, 'dart')
}

/** Лук «буквой D»: плечи гнутся к стрелку (−Z), тетива прямая. */
function buildBow(key, tall) {
  const root = new THREE.Group(); const p = palette()
  const half = tall ? 0.78 : 0.52
  const bend = tall ? 0.13 : 0.11
  const recurve = tall ? 0 : 0.03
  const limb = []
  for (let index = 0; index <= 12; index += 1) {
    const t = index / 12 * 2 - 1
    limb.push([0, t * half, -bend * t * t + (Math.abs(t) > 0.85 ? recurve * (Math.abs(t) - 0.85) / 0.15 : 0)])
  }
  tube(root, `${key}-limb`, limb, tall ? 0.011 : 0.01, p.wood, 30, 6)
  tube(root, `${key}-limb-belly`, limb.slice(4, 9).map(([x, y, z]) => [x, y, z + 0.004]), 0.013, p.woodDark, 8, 6)
  beam(root, `${key}-string`, limb[0], limb[limb.length - 1], 0.0018, p.cloth, 4)
  cylinder(root, `${key}-grip-wrap`, 0.016, 0.016, 0.11, [0, 0, 0.002], p.leather, 9)
  box(root, `${key}-arrow-rest`, [0.012, 0.012, 0.02], [0.012, 0.06, 0.006], p.leatherLight)
  muzzle(root, [0, 0.06, 0.03])
  return finish(root, key)
}

function buildSling() {
  const root = new THREE.Group(); const p = palette()
  torus(root, 'sling-finger-loop', 0.016, 0.003, [0, 0, 0], p.leather, [0, 0, 0])
  tube(root, 'sling-cord-left', [[0, 0, 0], [-0.03, 0.12, 0.01], [-0.035, 0.27, 0.02], [-0.02, 0.36, 0.03]], 0.003, p.leather, 14, 5)
  tube(root, 'sling-cord-right', [[0, 0, 0], [0.03, 0.12, 0.01], [0.035, 0.27, 0.02], [0.02, 0.36, 0.03]], 0.003, p.leather, 14, 5)
  roundedBox(root, 'sling-pouch', [0.06, 0.025, 0.04], [0, 0.38, 0.03], p.leatherLight, 0.008)
  sphere(root, 'sling-projectile', 0.014, [0, 0.39, 0.03], p.steelDark)
  muzzle(root, [0, 0.39, 0.05])
  return finish(root, 'sling')
}

function buildNet() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'net-handle', 0.014, 0.016, 0.16, [0, 0, 0], p.wood, 8)
  torus(root, 'net-handle-loop', 0.02, 0.004, [0, -0.09, 0], p.leather, [0, 0, 0])
  // Сеть свёрнута в руке: ромбовидные ячейки читаются силуэтом, без физики верёвки.
  for (let row = 0; row < 3; row += 1) {
    const y = 0.12 + row * 0.07
    tube(root, `net-mesh-row-${row + 1}`, [[-0.08 - row * 0.015, y, 0], [-0.03, y + 0.03, 0.025], [0.03, y + 0.03, 0.025], [0.08 + row * 0.015, y, 0]], 0.003, p.cloth, 12, 4)
  }
  for (const side of [-1, 1]) {
    tube(root, 'net-mesh-cord', [[0, 0.08, 0], [side * 0.06, 0.18, 0.015], [side * 0.11, 0.3, 0.005]], 0.003, p.cloth, 10, 4)
    sphere(root, 'net-edge-weight', 0.013, [side * 0.11, 0.3, 0.005], p.steelDark)
  }
  muzzle(root, [0, 0.3, 0.03])
  return finish(root, 'net')
}

function buildFlail() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'flail-grip', 0.016, 0.018, 0.38, [0, 0.05, 0], p.wood, 9)
  torus(root, 'flail-grip-wrap', 0.018, 0.004, [0, -0.06, 0], p.leather)
  cylinder(root, 'flail-end-cap', 0.02, 0.018, 0.03, [0, 0.25, 0], p.steelDark, 9)
  for (let index = 0; index < 5; index += 1) {
    torus(root, 'flail-chain-link', 0.011, 0.0028, [0, 0.285 + index * 0.02, 0], p.steel, [0, index % 2 ? Math.PI / 2 : 0, 0], 5, 10)
  }
  sphere(root, 'flail-striker', 0.035, [0, 0.42, 0], p.steelDark)
  for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
    const direction = new THREE.Vector3(x, y, z)
    const spike = cone(root, 'flail-striker-spike', 0.008, 0.026, direction.clone().multiplyScalar(0.045).add(new THREE.Vector3(0, 0.42, 0)).toArray(), p.steelEdge, 6)
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction)
  }
  return finish(root, 'flail')
}

function buildGlaive() {
  const root = new THREE.Group(); const p = palette()
  polearmShaft(root, 'glaive', p, -0.6, 1.15)
  box(root, 'glaive-socket', [0.034, 0.1, 0.03], [0, 1.18, 0], p.steelDark)
  blade(root, 'glaive-blade', [
    [0, 1.22, 0.012, 0.03, -0.006], [0.006, 1.34, 0.014, 0.04, -0.008], [0.02, 1.48, 0.012, 0.04, -0.006], [0.04, 1.6, 0.01, 0.025, -0.004], [0.06, 1.68, 0, 0, 0, 0.3],
  ], 0.01, p.steelEdge)
  return finish(root, 'glaive')
}

function buildHalberd() {
  const root = new THREE.Group(); const p = palette()
  polearmShaft(root, 'halberd', p, -0.6, 1.2)
  box(root, 'halberd-socket', [0.036, 0.16, 0.034], [0, 1.18, 0], p.steelDark)
  wedge(root, 'halberd-axe-head', [[0.018, 1.1], [0.07, 1.08], [0.15, 1.04], [0.17, 1.13], [0.17, 1.24], [0.15, 1.3], [0.07, 1.22], [0.018, 1.21]], 0.018, p.steel)
  tube(root, 'halberd-edge', [[0.155, 1.05, 0], [0.17, 1.14, 0], [0.17, 1.23, 0], [0.152, 1.29, 0]], 0.004, p.steelEdge, 10, 5)
  wedge(root, 'halberd-hook', [[-0.018, 1.14], [-0.06, 1.17], [-0.1, 1.22], [-0.085, 1.15], [-0.018, 1.2]], 0.014, p.steelDark, 'min-x')
  blade(root, 'halberd-top-spike', [[0, 1.26, 0.012, 0.012], [0, 1.4, 0.01, 0.01], [0, 1.5, 0, 0, 0, 0.3]], 0.01, p.steelEdge)
  return finish(root, 'halberd')
}

function buildLance() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'lance-shaft', 0.012, 0.03, 2.0, [0, 0.75, 0], p.wood, 10)
  cylinder(root, 'lance-grip', 0.02, 0.022, 0.2, [0, -0.08, 0], p.leather, 10)
  cylinder(root, 'lance-butt-cap', 0.026, 0.024, 0.06, [0, -0.28, 0], p.steelDark, 10)
  cone(root, 'lance-vamplate', 0.09, 0.14, [0, 0.12, 0], p.steel, 14, [Math.PI, 0, 0])
  blade(root, 'lance-head', [[0, 1.74, 0.013, 0.013], [0, 1.84, 0.012, 0.012], [0, 1.92, 0, 0, 0, 0.3]], 0.016, p.steelEdge)
  return finish(root, 'lance')
}

function buildLongsword() {
  const root = new THREE.Group(); const p = palette()
  const base = hilt(root, 'longsword', p, { grip: 0.22, radius: 0.015, guard: 0.2, pommel: 0.024 })
  straightBlade(root, 'longsword', p, base, 0.84, 0.048, 0.01)
  return finish(root, 'longsword')
}

function buildGreatsword() {
  const root = new THREE.Group(); const p = palette()
  const base = hilt(root, 'greatsword', p, { grip: 0.34, radius: 0.017, guard: 0.3, pommel: 0.03 })
  blade(root, 'greatsword-ricasso', [[0, base, 0.016, 0.016], [0, base + 0.12, 0.016, 0.016]], 0.012, p.steel)
  for (const side of [-1, 1]) cone(root, 'greatsword-parry-lug', 0.008, 0.03, [side * 0.026, base + 0.12, 0], p.steel, 6, [0, 0, side * -Math.PI / 2])
  straightBlade(root, 'greatsword', p, base + 0.12, 1.08, 0.056, 0.012)
  return finish(root, 'greatsword')
}

function buildMaul() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'maul-shaft', 0.021, 0.025, 1.0, [0, 0.2, 0], p.woodDark, 9)
  torus(root, 'maul-grip-wrap', 0.025, 0.005, [0, -0.15, 0], p.leather)
  roundedBox(root, 'maul-head', [0.24, 0.1, 0.1], [0, 0.74, 0], p.steel, 0.012)
  for (const side of [-1, 1]) box(root, 'maul-head-face', [0.012, 0.085, 0.085], [side * 0.124, 0.74, 0], p.steelEdge)
  box(root, 'maul-head-band', [0.05, 0.106, 0.106], [0, 0.74, 0], p.steelDark)
  return finish(root, 'maul')
}

function buildPike() {
  const root = new THREE.Group(); const p = palette()
  polearmShaft(root, 'pike', p, -0.7, 1.85, 0.016)
  cone(root, 'pike-socket', 0.018, 0.1, [0, 1.87, 0], p.steelDark, 9)
  blade(root, 'pike-head', [[0, 1.89, 0.012, 0.012], [0, 1.97, 0.016, 0.016], [0, 2.07, 0, 0, 0, 0.3]], 0.012, p.steelEdge)
  return finish(root, 'pike')
}

function buildRapier() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'rapier-grip', 0.013, 0.014, 0.14, [0, 0, 0], p.leather, 9)
  sphere(root, 'rapier-pommel', 0.02, [0, -0.085, 0], p.steelDark)
  torus(root, 'rapier-guard', 0.05, 0.0035, [0, 0.085, 0], p.steel, [Math.PI / 2, 0, 0], 6, 20)
  box(root, 'rapier-quillon', [0.2, 0.008, 0.008], [0, 0.08, 0], p.steel)
  tube(root, 'rapier-knuckle-bow', [[0.1, 0.08, 0], [0.06, 0.02, 0.02], [0.03, -0.06, 0.02], [0, -0.078, 0]], 0.0035, p.steel, 12, 5)
  blade(root, 'rapier-blade', [[0, 0.09, 0.011, 0.011], [0, 0.6, 0.008, 0.008], [0, 0.98, 0.005, 0.005], [0, 1.03, 0, 0, 0, 0.3]], 0.008, p.steelEdge)
  return finish(root, 'rapier')
}

function buildScimitar() {
  const root = new THREE.Group(); const p = palette()
  const base = hilt(root, 'scimitar', p, { grip: 0.13, radius: 0.014, guard: 0.12, pommel: 0.02 })
  const stations = []
  for (let index = 0; index <= 8; index += 1) {
    const t = index / 8
    const width = t < 0.75 ? 0.036 + t * 0.016 : 0.048 * (1 - (t - 0.75) / 0.25)
    stations.push([0.11 * t * t, base + 0.7 * t, width * 0.25, width * 0.75, -width * 0.2, t > 0.9 ? 0.4 : 1])
  }
  blade(root, 'scimitar-blade', stations, 0.009, p.steelEdge)
  return finish(root, 'scimitar')
}

function buildShortsword() {
  const root = new THREE.Group(); const p = palette()
  const base = hilt(root, 'shortsword', p, { grip: 0.12, radius: 0.014, guard: 0.13, pommel: 0.02 })
  straightBlade(root, 'shortsword', p, base, 0.5, 0.05, 0.009)
  return finish(root, 'shortsword')
}

function buildTrident() {
  const root = new THREE.Group(); const p = palette()
  polearmShaft(root, 'trident', p, -0.5, 0.95)
  roundedBox(root, 'trident-collar', [0.13, 0.03, 0.022], [0, 0.98, 0], p.steelDark, 0.006)
  for (const x of [-0.055, 0, 0.055]) {
    cylinder(root, 'trident-prong-shaft', 0.006, 0.007, 0.16, [x, 1.07, 0], p.steel, 7)
    blade(root, 'trident-prong', [[x, 1.14, 0.009, 0.009], [x, 1.18, 0.012, 0.004], [x, 1.24, 0, 0, 0, 0.3]], 0.008, p.steelEdge)
  }
  return finish(root, 'trident')
}

function buildWarhammer() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'warhammer-grip', 0.016, 0.018, 0.62, [0, 0.15, 0], p.wood, 9)
  torus(root, 'warhammer-grip-wrap', 0.018, 0.004, [0, -0.05, 0], p.leather)
  for (const side of [-1, 1]) box(root, 'warhammer-langet', [0.004, 0.14, 0.012], [side * 0.018, 0.4, 0], p.steelDark)
  roundedBox(root, 'warhammer-head', [0.08, 0.04, 0.04], [0.01, 0.46, 0], p.steel, 0.006)
  cylinder(root, 'warhammer-face', 0.026, 0.022, 0.03, [0.064, 0.46, 0], p.steelEdge, 8, [0, 0, Math.PI / 2])
  cone(root, 'warhammer-peen', 0.017, 0.08, [-0.07, 0.455, 0], p.steelDark, 6, [0, 0, Math.PI / 2])
  cone(root, 'warhammer-top-spike', 0.01, 0.05, [0, 0.505, 0], p.steelEdge, 6)
  return finish(root, 'warhammer')
}

function buildWarPick() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'war-pick-haft', 0.016, 0.018, 0.62, [0, 0.15, 0], p.wood, 9)
  torus(root, 'war-pick-grip-wrap', 0.018, 0.004, [0, -0.05, 0], p.leather)
  box(root, 'war-pick-head', [0.05, 0.05, 0.036], [0, 0.46, 0], p.steelDark)
  blade(root, 'war-pick-beak', [[0.02, 0.465, 0.014, 0.014], [0.09, 0.45, 0.011, 0.011], [0.16, 0.42, 0.006, 0.006], [0.2, 0.39, 0, 0, 0, 0.3]], 0.016, p.steelEdge)
  cylinder(root, 'war-pick-back', 0.017, 0.015, 0.04, [-0.042, 0.46, 0], p.steel, 8, [0, 0, Math.PI / 2])
  return finish(root, 'war-pick')
}

function buildWhip() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'whip-handle', 0.014, 0.017, 0.24, [0, 0, 0], p.leather, 9)
  torus(root, 'whip-handle-collar', 0.017, 0.004, [0, 0.12, 0], p.steelDark)
  const coil = []
  for (let index = 0; index <= 36; index += 1) {
    const angle = index / 36 * Math.PI * 4.5
    coil.push([Math.cos(angle) * 0.07, 0.15 + index * 0.0035, Math.sin(angle) * 0.07])
  }
  tube(root, 'whip-coiled-thong', coil, 0.006, p.leatherLight, 72, 5)
  tube(root, 'whip-tip', [coil.at(-1), [0.05, 0.22, 0.09], [0.03, 0.12, 0.12]], 0.0028, p.leather, 10, 4)
  return finish(root, 'whip')
}

function buildBlowgun() {
  const root = new THREE.Group(); const p = palette()
  cylinder(root, 'blowgun-tube', 0.013, 0.015, 1.2, [0, 0.45, 0], p.woodDark, 10)
  for (const y of [0.15, 0.6]) torus(root, 'blowgun-binding', 0.015, 0.003, [0, y, 0], p.leather)
  cylinder(root, 'blowgun-muzzle-ring', 0.018, 0.017, 0.03, [0, 1.05, 0], p.steelDark, 10)
  cylinder(root, 'blowgun-mouthpiece', 0.02, 0.014, 0.05, [0, -0.17, 0], p.bone, 9)
  muzzle(root, [0, 1.07, 0])
  return finish(root, 'blowgun')
}

/** Арбалет лежит вдоль +Z: приклад у хвата, плечи (лук) — впереди. */
function buildCrossbow(key, heavy, hand) {
  const root = new THREE.Group(); const p = palette()
  const length = heavy ? 0.95 : hand ? 0.36 : 0.72
  const span = heavy ? 0.82 : hand ? 0.32 : 0.62
  const front = length * 0.78
  roundedBox(root, `${key}-stock`, [0.04, 0.05, length], [0, 0.03, length / 2 - 0.12], p.wood, 0.01)
  roundedBox(root, `${key}-grip`, [0.035, hand ? 0.1 : 0.06, hand ? 0.04 : 0.16], [0, hand ? -0.035 : -0.005, hand ? 0 : -0.1], p.woodDark, 0.01)
  box(root, `${key}-rail`, [0.012, 0.006, length * 0.7], [0, 0.058, length * 0.38], p.steelDark)
  const prod = []
  for (let index = 0; index <= 10; index += 1) {
    const t = index / 10 * 2 - 1
    prod.push([t * span / 2, 0.05, front - 0.07 * t * t])
  }
  tube(root, `${key}-prod`, prod, heavy ? 0.013 : hand ? 0.007 : 0.01, p.steel, 24, 6)
  beam(root, `${key}-string`, prod[0], [0, 0.058, length * 0.32], 0.0018, p.cloth, 4)
  beam(root, `${key}-string-return`, prod[prod.length - 1], [0, 0.058, length * 0.32], 0.0018, p.cloth, 4)
  box(root, `${key}-trigger`, [0.006, 0.04, 0.012], [0, -0.004, 0.02], p.steelDark, [0.3, 0, 0])
  torus(root, `${key}-trigger-guard`, 0.02, 0.003, [0, 0, 0.02], p.steelDark, [0, Math.PI / 2, 0], 5, 12)
  if (!hand) torus(root, `${key}-stirrup`, heavy ? 0.06 : 0.045, 0.006, [0, 0.03, front + 0.05], p.steelDark, [Math.PI / 2, 0, 0], 5, 14)
  if (heavy) roundedBox(root, `${key}-windlass`, [0.12, 0.04, 0.05], [0, 0.03, -0.1], p.steelDark, 0.008)
  muzzle(root, [0, 0.06, front + 0.02], [Math.PI / 2, 0, 0])
  return finish(root, key)
}

function buildFirearm(key, long) {
  const root = new THREE.Group(); const p = palette()
  const barrel = long ? 1.0 : 0.26
  if (long) roundedBox(root, `${key}-stock`, [0.045, 0.42, 0.07], [0, -0.22, -0.015], p.wood, 0.012, [0.08, 0, 0])
  else roundedBox(root, `${key}-stock`, [0.032, 0.13, 0.045], [0, -0.04, -0.02], p.wood, 0.01, [0.35, 0, 0])
  cylinder(root, `${key}-barrel`, long ? 0.012 : 0.011, long ? 0.015 : 0.013, barrel, [0, barrel / 2 + 0.02, 0.012], p.steel, 10)
  roundedBox(root, `${key}-forestock`, [0.04, barrel * 0.75, 0.034], [0, barrel * 0.4, 0], p.woodLight, 0.008)
  cylinder(root, `${key}-muzzle-ring`, 0.017, 0.017, 0.02, [0, barrel + 0.015, 0.012], p.steelDark, 10)
  roundedBox(root, `${key}-lock`, [0.012, 0.06, 0.03], [0.022, 0.05, 0.01], p.steelDark, 0.004)
  torus(root, `${key}-trigger-guard`, 0.018, 0.003, [0, 0.0, -0.03], p.steelDark, [0, Math.PI / 2, 0], 5, 12)
  box(root, `${key}-trigger`, [0.005, 0.025, 0.006], [0, 0.005, -0.03], p.steelEdge)
  box(root, `${key}-sight`, [0.005, 0.012, 0.005], [0, barrel, 0.03], p.steelEdge)
  muzzle(root, [0, barrel + 0.03, 0.012])
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
