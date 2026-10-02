/** Авторские низкополигональные предметы для темниц и храмов. */
import { Model, THREE } from './map-detail-model-helpers.mjs'

const C = Object.freeze({
  stone: '#746f65',
  stoneLight: '#9a9383',
  stoneDark: '#454642',
  wood: '#604736',
  woodLight: '#927252',
  woodDark: '#342923',
  iron: '#414541',
  ironLight: '#756f63',
  bronze: '#806741',
  straw: '#aa8b50',
  strawLight: '#c09c5a',
  cloth: '#76605f',
  blanket: '#656565',
  red: '#795052',
  water: '#2f565a',
  dark: '#242a28',
  rope: '#5b4938',
  smoke: '#8b8d86',
})

/** Профильная геометрия делает камень, металл и чаши читаемыми в силуэте. */
function lathe(model, name, profile, color, segments = 24) {
  const points = profile.map(([radius, y]) => new THREE.Vector2(radius, y))
  return model.mesh(name, new THREE.LatheGeometry(points, segments), [0, 0, 0], color)
}

function tube(model, name, points, radius, color, tubularSegments = 12, radialSegments = 8) {
  const curve = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point)), false, 'centripetal')
  return model.mesh(name, new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false), [0, 0, 0], color)
}

function bolt(model, name, position, color = C.ironLight, size = 0.04) {
  model.sphere(name, [size, size, size], position, color)
}

export const MODEL_IDS = Object.freeze([
  'stone_steps', 'root_tangle', 'armor_stand', 'archery_target',
  'straw_bed', 'wall_chains', 'stocks', 'torture_rack',
  'jailer_desk', 'idol', 'font_basin', 'incense_burner',
  'bell_frame', 'holy_pool', 'kneeling_cushions',
])

function finish(model) {
  const root = model.root
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

function stoneSteps() {
  const m = new Model('stone_steps')
  for (const [index, height] of [0.26, 0.52, 0.78].entries()) {
    const z = -0.42 + index * 0.42
    m.slab(`step-${index + 1}`, 2.58, 0.42, height, [0, height / 2, z], index === 2 ? C.stoneLight : C.stone)
    m.box('step-front-edge', [2.38, 0.035, 0.035], [0, height + 0.01, z - 0.19], C.stoneDark)
  }
  m.slab('steps-left-cheek', 0.18, 1.42, 0.26, [-1.20, 0.13, 0], C.stoneDark)
  m.slab('steps-right-cheek', 0.18, 1.42, 0.26, [1.20, 0.13, 0], C.stoneDark)
  m.sphere('steps-left-cap', [0.13, 0.10, 0.13], [-1.20, 0.29, -0.52], C.stoneLight)
  m.sphere('steps-right-cap', [0.13, 0.10, 0.13], [1.20, 0.29, -0.52], C.stoneLight)
  return finish(m)
}

function rootTangle() {
  const m = new Model('root_tangle')
  const paths = [
    [[-0.08, 0.08, 0], [-0.38, 0.27, -0.03], [-0.77, 0.5, -0.27], [-1.18, 0.2, -0.42]],
    [[0.02, 0.08, 0.02], [0.31, 0.31, 0.08], [0.72, 0.56, 0.24], [1.22, 0.27, 0.4]],
    [[0.03, 0.1, -0.01], [-0.05, 0.36, 0.23], [0.08, 0.61, 0.46], [0.33, 0.36, 0.53]],
    [[-0.05, 0.09, 0], [-0.28, 0.2, 0.18], [-0.55, 0.28, 0.36]],
    [[0.02, 0.09, 0], [0.28, 0.19, -0.18], [0.54, 0.29, -0.39]],
  ]
  for (const [pathIndex, path] of paths.entries()) {
    for (let index = 1; index < path.length; index += 1) {
      const radius = Math.max(0.035, 0.095 - index * 0.018)
      m.beam(`root-${pathIndex + 1}-${index}`, path[index - 1], path[index], radius, pathIndex % 2 ? C.wood : C.woodDark)
    }
    tube(m, `root-smooth-${pathIndex + 1}`, path, Math.max(0.028, 0.075 - pathIndex * 0.008), pathIndex % 2 ? C.wood : C.woodDark, 12, 6)
  }
  m.sphere('root-knot', [0.34, 0.25, 0.3], [0, 0.14, 0], C.wood)
  m.sphere('root-soil-mound', [0.82, 0.10, 0.58], [0, 0.04, 0.08], C.stoneDark)
  for (const [x, z] of [[-0.88, -0.24], [-0.42, 0.32], [0.50, 0.28], [0.88, -0.18]]) {
    m.sphere('root-bark-knot', [0.08, 0.06, 0.08], [x, 0.08, z], C.woodLight)
  }
  return finish(m)
}

function armorStand() {
  const m = new Model('armor_stand')
  m.slab('stand-foot', 0.72, 0.42, 0.08, [0, 0.04, 0.12], C.woodDark)
  m.beam('stand-left-leg', [0, 0.08, 0.12], [-0.31, 0.38, 0.12], 0.035, C.wood)
  m.beam('stand-right-leg', [0, 0.08, 0.12], [0.31, 0.38, 0.12], 0.035, C.wood)
  m.cylinder('stand-post', 0.045, 0.055, 1.18, [0, 0.72, 0.12], C.woodDark, 8)
  m.box('stand-shoulder-bar', [0.7, 0.07, 0.08], [0, 1.27, 0.12], C.wood)
  m.cylinder('chainmail-shirt', 0.2, 0.27, 0.56, [0, 1.02, -0.01], C.iron, 10)
  for (const y of [0.84, 1.01, 1.18]) m.torus('chainmail-ring', 0.2, 0.018, [0, y, -0.01], C.ironLight, [Math.PI / 2, 0, 0])
  m.slab('breastplate', 0.34, 0.10, 0.40, [0, 1.13, -0.21], C.ironLight)
  m.box('breastplate-ridge', [0.04, 0.34, 0.03], [0, 1.14, -0.27], C.iron)
  for (const x of [-0.26, 0.26]) {
    m.sphere('shoulder-guard', [0.20, 0.12, 0.20], [x, 1.28, 0.12], C.ironLight)
    m.beam('arm-guard', [x, 1.18, 0.12], [x * 1.05, 0.82, 0.12], 0.055, C.iron)
  }
  m.cylinder('armor-stand-neck', 0.11, 0.13, 0.24, [0, 1.37, 0.02], C.iron, 10)
  m.torus('armor-stand-collar', 0.15, 0.025, [0, 1.30, 0.02], C.ironLight, [Math.PI / 2, 0, 0])
  m.sphere('helmet', [0.32, 0.24, 0.29], [0, 1.57, -0.01], C.iron)
  m.torus('helmet-rim', 0.17, 0.028, [0, 1.53, -0.01], C.ironLight, [Math.PI / 2, 0, 0])
  m.box('helmet-visor', [0.2, 0.07, 0.035], [0, 1.56, -0.16], C.ironLight)
  m.slab('helmet-crest', 0.08, 0.2, 0.07, [0, 1.70, -0.01], C.iron)
  m.beam('armor-stand-sword-grip', [0.35, 0.24, 0.14], [0.35, 0.49, 0.14], 0.030, C.woodDark)
  m.box('armor-stand-sword-guard', [0.20, 0.035, 0.04], [0.35, 0.50, 0.14], C.bronze)
  m.beam('armor-stand-sword-blade', [0.35, 0.52, 0.14], [0.35, 1.16, 0.14], 0.022, C.ironLight)
  m.sphere('armor-stand-sword-pommel', [0.045, 0.045, 0.045], [0.35, 0.21, 0.14], C.bronze)
  return finish(m)
}

function archeryTarget() {
  const m = new Model('archery_target')
  m.beam('target-leg-left', [0, 0.49, 0.12], [-0.45, 0.06, 0.3], 0.035, C.wood)
  m.beam('target-leg-right', [0, 0.49, 0.12], [0.45, 0.06, 0.3], 0.035, C.wood)
  m.beam('target-leg-back', [0, 0.49, 0.12], [0, 0.06, -0.34], 0.035, C.woodDark)
  m.beam('target-disc-support', [0, 0.49, 0.12], [0, 0.94, 0.08], 0.045, C.woodDark)
  m.cylinder('target-disc', 0.43, 0.43, 0.16, [0, 1.01, 0], C.straw, 12, [Math.PI / 2, 0, 0])
  m.torus('target-outer-ring', 0.35, 0.035, [0, 1.01, -0.09], C.strawLight, [Math.PI / 2, 0, 0])
  m.torus('target-middle-ring', 0.29, 0.025, [0, 1.01, -0.10], C.red, [Math.PI / 2, 0, 0])
  m.torus('target-inner-ring', 0.22, 0.03, [0, 1.01, -0.1], C.strawLight, [Math.PI / 2, 0, 0])
  m.cylinder('target-bullseye', 0.11, 0.11, 0.18, [0, 1.01, -0.01], C.red, 10, [Math.PI / 2, 0, 0])
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const x = Math.cos(angle) * 0.31
    const y = 1.01 + Math.sin(angle) * 0.31
    m.beam('target-straw-binding', [x, y, -0.10], [x * 0.90, y, -0.14], 0.012, C.rope)
  }
  for (const [x, y, dx] of [[-0.2, 1.17, -0.02], [0.15, 0.87, 0.01], [0.23, 1.05, 0.025]]) {
    m.beam('target-arrow-shaft', [x, y, -0.08], [x + dx, y + 0.02, -0.32], 0.014, C.iron)
    m.slab('target-arrow-fletching', 0.10, 0.05, 0.025, [x, y, -0.09], C.woodLight)
  }
  return finish(m)
}

function strawBed() {
  const m = new Model('straw_bed')
  for (const [index, z] of [-0.7, -0.18, 0.38, 0.78].entries()) {
    m.sphere(`straw-bundle-${index + 1}`, [0.72, 0.2, 0.62], [index % 2 ? 0.16 : -0.14, 0.1, z], index % 2 ? C.straw : C.strawLight)
    m.torus('straw-bundle-tie', 0.12, 0.014, [index % 2 ? 0.16 : -0.14, 0.10, z], C.rope, [0, 0, 0])
  }
  m.sphere('straw-pillow', [0.52, 0.16, 0.40], [-0.10, 0.28, 0.70], C.strawLight)
  m.torus('straw-pillow-seam', 0.22, 0.015, [-0.10, 0.28, 0.70], C.rope, [Math.PI / 2, 0, 0])
  m.box('blanket-front', [0.86, 0.055, 0.46], [-0.08, 0.255, -0.48], C.blanket, [0.04, 0.05, -0.1])
  m.box('blanket-middle', [0.72, 0.055, 0.52], [0.13, 0.25, 0.02], C.blanket, [-0.03, -0.06, 0.08])
  m.box('blanket-torn-end', [0.45, 0.05, 0.32], [-0.19, 0.245, 0.58], C.blanket, [0.02, 0.08, -0.13])
  return finish(m)
}

function wallChains() {
  const m = new Model('wall_chains')
  m.slab('wall-plate', 0.78, 0.12, 1.2, [0, 0.68, 0.1], C.stoneDark)
  m.slab('wall-anchor-cap', 0.50, 0.08, 0.16, [0, 1.32, 0.05], C.stoneLight)
  for (const x of [-0.22, 0.22]) {
    m.torus('shackle', 0.12, 0.035, [x, 0.22, -0.08], C.ironLight)
    m.torus('shackle-cuff-band', 0.095, 0.025, [x, 0.22, -0.13], C.iron)
    bolt(m, 'shackle-rivet-left', [x - 0.09, 0.22, -0.14], C.bronze, 0.025)
    bolt(m, 'shackle-rivet-right', [x + 0.09, 0.22, -0.14], C.bronze, 0.025)
    let previous = null
    for (const [index, y] of [0.40, 0.55, 0.70, 0.85, 1.00, 1.15].entries()) {
      const point = [x + (index % 2 ? 0.025 : 0), y, -0.08]
      m.torus('chain-link', 0.065, 0.014, point, C.iron, index % 2 ? [Math.PI / 2, 0, 0] : [0, 0, 0])
      if (previous) m.beam('chain-link-connector', previous, point, 0.012, C.iron)
      previous = point
    }
    m.beam('chain-anchor-tail', [x, 1.15, -0.08], [x, 1.30, -0.08], 0.014, C.iron)
  }
  m.beam('wall-chain-anchor-bar', [-0.30, 1.30, -0.08], [0.30, 1.30, -0.08], 0.025, C.iron)
  return finish(m)
}

function stocks() {
  const m = new Model('stocks')
  m.slab('stocks-platform', 2.35, 0.9, 0.12, [0, 0.06, 0], C.woodDark)
  m.box('stocks-front-rail', [2.25, 0.12, 0.1], [0, 0.77, -0.4], C.wood)
  m.box('stocks-back-rail', [2.25, 0.12, 0.1], [0, 0.77, 0.4], C.woodDark)
  for (const x of [-1.04, 1.04]) {
    m.box('stocks-upright', [0.12, 0.78, 0.12], [x, 0.46, 0], C.wood)
    m.box('stocks-top-cap', [0.18, 0.09, 0.18], [x, 0.87, 0], C.woodLight)
  }
  for (const z of [-0.43, 0.43]) {
    m.box('stocks-lower-rail', [2.12, 0.1, 0.1], [0, 0.37, z], C.wood)
    for (const x of [-0.45, 0.45]) {
      m.sphere('stocks-hole-dark', [0.23, 0.23, 0.025], [x, 0.56, z + (z < 0 ? -0.06 : 0.06)], C.dark)
      m.torus('stocks-hole-rim', 0.12, 0.025, [x, 0.56, z + (z < 0 ? -0.065 : 0.065)], C.woodLight)
      bolt(m, 'stocks-hinge-bolt', [x, 0.73, z + (z < 0 ? -0.03 : 0.03)], C.ironLight, 0.035)
    }
  }
  for (const x of [-1.04, 1.04]) for (const z of [-0.43, 0.43]) {
    m.beam('stocks-side-depth-rail', [x, 0.37, 0], [x, 0.37, z], 0.04, C.woodDark)
    m.beam('stocks-side-top-rail', [x, 0.77, 0], [x, 0.77, z], 0.04, C.woodDark)
  }
  m.box('stocks-split-left', [0.98, 0.10, 0.16], [-0.52, 0.72, 0], C.woodLight)
  m.box('stocks-split-right', [0.98, 0.10, 0.16], [0.52, 0.72, 0], C.woodLight)
  m.cylinder('stocks-lock-pin', 0.035, 0.035, 0.20, [0, 0.78, -0.05], C.ironLight, 8, [0, 0, Math.PI / 2])
  return finish(m)
}

function tortureRack() {
  const m = new Model('torture_rack')
  m.table('rack-table', 2.3, 0.82, 0.64, C.wood)
  for (const x of [-0.72, -0.24, 0.24, 0.72]) m.slab('rack-bed-slat', 0.10, 0.62, 0.05, [x, 0.71, 0], C.woodLight)
  m.box('rack-side-rail-left', [2.18, 0.1, 0.1], [0, 0.74, -0.34], C.woodDark)
  m.box('rack-side-rail-right', [2.18, 0.1, 0.1], [0, 0.74, 0.34], C.woodDark)
  for (const x of [-1.03, 1.03]) m.cylinder('rack-post', 0.08, 0.1, 0.27, [x, 0.775, 0], C.woodDark, 8)
  m.cylinder('rack-winch', 0.11, 0.11, 0.48, [0, 0.78, -0.51], C.iron, 10, [0, 0, Math.PI / 2])
  m.cylinder('rack-winch-handle', 0.025, 0.025, 0.22, [0.3, 0.78, -0.51], C.ironLight, 8, [0, 0, Math.PI / 2])
  for (const x of [-0.88, 0.88]) {
    m.beam('rack-rope', [x, 0.83, -0.39], [x * 0.82, 0.84, 0.32], 0.018, C.rope)
    m.beam('rack-rope-tail', [x * 0.82, 0.84, 0.32], [x * 0.74, 0.69, 0.39], 0.014, C.rope)
    m.torus('rack-tie-ring', 0.045, 0.012, [x, 0.84, -0.39], C.ironLight, [Math.PI / 2, 0, 0])
  }
  m.beam('rack-winch-spoke-top', [0, 0.78, -0.51], [0, 0.91, -0.51], 0.018, C.ironLight)
  m.beam('rack-winch-spoke-bottom', [0, 0.78, -0.51], [0, 0.65, -0.51], 0.018, C.ironLight)
  return finish(m)
}

function jailerDesk() {
  const m = new Model('jailer_desk')
  m.table('jailer-desk', 1.08, 0.66, 0.62, C.wood)
  m.box('jailer-desk-drawer', [0.48, 0.16, 0.05], [0, 0.47, -0.34], C.woodDark)
  m.torus('jailer-desk-drawer-handle', 0.04, 0.012, [0, 0.47, -0.38], C.ironLight, [Math.PI / 2, 0, 0])
  m.slab('closed-logbook', 0.45, 0.28, 0.055, [-0.18, 0.66, 0], C.woodDark)
  m.box('logbook-band', [0.035, 0.065, 0.29], [-0.18, 0.69, 0], C.ironLight)
  m.torus('key-ring', 0.1, 0.018, [0.27, 0.68, -0.08], C.ironLight, [Math.PI / 2, 0, 0])
  for (const [x, z, length] of [[0.34, -0.08, 0.22], [0.22, -0.03, 0.17], [0.31, 0.04, 0.13]]) {
    m.box('key-stem', [0.025, 0.025, length], [x, 0.68, z], C.ironLight, [0, 0, x > 0.3 ? 0.2 : -0.18])
  }
  m.cylinder('jailer-desk-inkwell', 0.08, 0.10, 0.13, [-0.42, 0.74, 0.14], C.iron, 10)
  m.torus('jailer-desk-inkwell-rim', 0.075, 0.012, [-0.42, 0.81, 0.14], C.ironLight, [Math.PI / 2, 0, 0])
  m.beam('jailer-desk-quill', [-0.42, 0.80, 0.14], [-0.30, 1.02, 0.14], 0.012, C.straw)
  return finish(m)
}

function idol() {
  const m = new Model('idol')
  m.cylinder('idol-base', 0.82, 0.9, 0.28, [0, 0.14, 0], C.stoneDark, 12)
  m.cylinder('idol-pedestal', 0.64, 0.7, 0.28, [0, 0.42, 0], C.stoneLight, 12)
  m.beam('idol-left-leg', [-0.34, 0.63, -0.02], [0.34, 0.64, -0.25], 0.16, C.stone)
  m.beam('idol-right-leg', [0.34, 0.64, 0.02], [-0.34, 0.68, -0.25], 0.16, C.stoneLight)
  lathe(m, 'idol-robe', [[0, 0.66], [0.27, 0.66], [0.48, 0.72], [0.52, 0.92], [0.40, 1.42], [0.56, 1.52], [0.48, 1.60], [0.22, 1.60], [0, 1.60]], C.stone, 16)
  m.sphere('idol-shoulders', [0.94, 0.34, 0.54], [0, 1.52, 0.01], C.stone)
  m.torus('idol-robe-collar', 0.27, 0.04, [0, 1.61, 0], C.stoneDark)
  for (const x of [-0.25, 0, 0.25]) m.beam('idol-robe-fold', [x, 0.72, -0.38], [x * 0.86, 1.45, -0.31], 0.022, C.stoneDark)
  m.beam('idol-arm-left', [-0.36, 1.45, -0.04], [-0.18, 1.1, -0.3], 0.1, C.stoneLight)
  m.beam('idol-arm-right', [0.36, 1.45, -0.04], [0.18, 1.1, -0.3], 0.1, C.stone)
  m.beam('idol-folded-hands', [-0.18, 1.1, -0.3], [0.18, 1.1, -0.3], 0.085, C.stoneLight)
  m.torus('idol-hand-cuff', 0.10, 0.018, [-0.18, 1.10, -0.30], C.stoneDark, [Math.PI / 2, 0, 0])
  m.cylinder('idol-neck', 0.18, 0.2, 0.18, [0, 1.78, 0], C.stoneDark, 10)
  m.sphere('idol-head', [0.58, 0.62, 0.54], [0, 2.1, -0.01], C.stoneLight)
  m.sphere('idol-headdress', [0.70, 0.27, 0.50], [0, 2.34, 0.04], C.stoneDark)
  m.torus('idol-halo', 0.56, 0.045, [0, 2.05, 0.18], C.bronze, [Math.PI / 2, 0, 0])
  for (const x of [-0.35, 0.35]) m.sphere('idol-ear', [0.10, 0.16, 0.08], [x, 2.10, -0.01], C.stone)
  m.box('idol-nose', [0.09, 0.13, 0.12], [0, 2.12, -0.31], C.stoneDark)
  for (const x of [-0.13, 0.13]) {
    m.sphere('idol-eye', [0.045, 0.045, 0.03], [x, 2.21, -0.285], C.dark)
    m.box('idol-brow', [0.14, 0.04, 0.04], [x, 2.29, -0.27], C.stoneDark, [0, 0, x < 0 ? -0.12 : 0.12])
  }
  m.slab('idol-mouth', 0.20, 0.04, 0.035, [0, 2.00, -0.30], C.stoneDark)
  m.sphere('idol-third-eye', [0.05, 0.05, 0.04], [0, 2.24, -0.29], C.bronze)
  m.slab('idol-crown-front', 0.44, 0.08, 0.10, [0, 2.48, -0.06], C.bronze)
  return finish(m)
}

function fontBasin() {
  const m = new Model('font_basin')
  m.cylinder('font-foot', 0.28, 0.32, 0.08, [0, 0.04, 0], C.stoneDark, 12)
  m.cylinder('font-pedestal', 0.19, 0.25, 0.48, [0, 0.32, 0], C.stone, 10)
  lathe(m, 'font-bowl', [[0.10, 0.52], [0.29, 0.52], [0.38, 0.60], [0.37, 0.74], [0.32, 0.82], [0.27, 0.82], [0.10, 0.76]], C.stoneLight, 20)
  m.torus('font-rim', 0.32, 0.045, [0, 0.79, 0], C.stone, [Math.PI / 2, 0, 0])
  m.torus('font-inner-rim', 0.26, 0.020, [0, 0.77, 0], C.stoneDark, [Math.PI / 2, 0, 0])
  m.cylinder('font-water', 0.26, 0.26, 0.028, [0, 0.785, 0], C.water, 16)
  for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4, Math.PI, Math.PI * 5 / 4, Math.PI * 3 / 2, Math.PI * 7 / 4]) {
    const x = Math.cos(angle) * 0.355
    const z = Math.sin(angle) * 0.355
    m.beam('font-carved-flute', [x, 0.59, z], [x * 0.95, 0.76, z * 0.95], 0.012, C.stoneDark)
  }
  return finish(m)
}

function incenseBurner() {
  const m = new Model('incense_burner')
  for (const [x, z] of [[-0.24, -0.15], [0.24, -0.15], [0, 0.22]]) {
    m.beam('burner-tripod-leg', [x, 0.06, z], [0, 0.46, 0], 0.025, C.bronze)
    m.sphere('burner-tripod-foot', [0.05, 0.035, 0.05], [x, 0.04, z], C.ironLight)
  }
  lathe(m, 'burner-bowl', [[0.08, 0.46], [0.19, 0.46], [0.25, 0.54], [0.22, 0.66], [0.12, 0.70], [0.08, 0.65]], C.bronze, 16)
  m.torus('burner-rim', 0.22, 0.025, [0, 0.64, 0], C.ironLight, [Math.PI / 2, 0, 0])
  m.cylinder('burner-lid', 0.13, 0.18, 0.1, [0, 0.69, 0], C.bronze, 10)
  m.cylinder('burner-finial', 0.035, 0.035, 0.1, [0, 0.79, 0], C.bronze, 8)
  for (const angle of [0, Math.PI / 3, Math.PI * 2 / 3, Math.PI, Math.PI * 4 / 3, Math.PI * 5 / 3]) {
    m.sphere('burner-lid-hole', [0.018, 0.018, 0.018], [Math.cos(angle) * 0.08, 0.73, Math.sin(angle) * 0.08], C.dark)
  }
  m.beam('smoke-lower', [0, 0.86, 0], [0.04, 1.0, 0.01], 0.018, C.smoke)
  m.beam('smoke-upper', [0.04, 1.0, 0.01], [-0.03, 1.13, -0.02], 0.014, C.smoke)
  tube(m, 'smoke-wisp', [[-0.03, 1.13, -0.02], [0.08, 1.23, -0.01], [0.00, 1.34, 0.01]], 0.011, C.smoke, 10, 6)
  return finish(m)
}

function bellFrame() {
  const m = new Model('bell_frame')
  for (const x of [-1.03, 1.03]) for (const z of [-0.3, 0.3]) {
    m.box('bell-frame-post', [0.12, 2.12, 0.12], [x, 1.06, z], C.woodDark)
    m.slab('bell-frame-foot', 0.24, 0.24, 0.12, [x, 0.06, z], C.wood)
    m.box('bell-frame-foot-bolt', [0.08, 0.035, 0.08], [x, 0.13, z - 0.08], C.ironLight)
  }
  m.box('bell-frame-top-front', [2.25, 0.14, 0.14], [0, 2.18, -0.3], C.wood)
  m.box('bell-frame-top-back', [2.25, 0.14, 0.14], [0, 2.18, 0.3], C.wood)
  m.box('bell-frame-crossbar', [0.14, 0.14, 0.72], [0, 2.18, 0], C.woodLight)
  for (const x of [-1.03, 1.03]) for (const z of [-0.3, 0.3]) {
    m.beam('bell-frame-brace', [x, 0.74, z], [x * 0.72, 2.02, z], 0.035, C.woodLight)
  }
  m.beam('bell-hanger', [0, 2.1, 0], [0, 1.89, 0], 0.025, C.rope)
  lathe(m, 'bell-body', [[0.13, 1.40], [0.29, 1.40], [0.37, 1.47], [0.34, 1.66], [0.29, 1.85], [0.21, 1.94], [0.14, 1.96]], C.bronze, 24)
  m.torus('bell-lip', 0.35, 0.05, [0, 1.42, 0], C.bronze, [Math.PI / 2, 0, 0])
  m.torus('bell-waist-band', 0.30, 0.018, [0, 1.74, 0], C.ironLight, [Math.PI / 2, 0, 0])
  m.cylinder('bell-neck', 0.16, 0.19, 0.12, [0, 1.94, 0], C.bronze, 10)
  m.cylinder('bell-yoke', 0.045, 0.045, 0.66, [0, 2.00, 0], C.ironLight, 10, [0, 0, Math.PI / 2])
  m.beam('bell-clapper', [0, 1.88, 0], [0, 1.37, 0], 0.018, C.iron)
  m.sphere('bell-clapper-ball', [0.11, 0.11, 0.11], [0, 1.34, 0], C.iron)
  m.sphere('bell-top-finial', [0.07, 0.07, 0.07], [0, 2.11, 0], C.bronze)
  return finish(m)
}

function holyPool() {
  const m = new Model('holy_pool')
  m.slab('pool-bottom', 2.52, 2.52, 0.08, [0, 0.04, 0], C.stoneDark)
  m.box('pool-rim-front', [2.68, 0.22, 0.18], [0, 0.19, -1.23], C.stoneLight)
  m.box('pool-rim-back', [2.68, 0.22, 0.18], [0, 0.19, 1.23], C.stone)
  m.box('pool-rim-left', [0.18, 0.22, 2.3], [-1.23, 0.19, 0], C.stone)
  m.box('pool-rim-right', [0.18, 0.22, 2.3], [1.23, 0.19, 0], C.stoneLight)
  m.slab('pool-inner-lip-front', 2.24, 0.08, 0.06, [0, 0.31, -1.10], C.stoneDark)
  m.slab('pool-inner-lip-back', 2.24, 0.08, 0.06, [0, 0.31, 1.10], C.stoneDark)
  m.slab('pool-inner-lip-left', 0.08, 2.10, 0.06, [-1.10, 0.31, 0], C.stoneDark)
  m.slab('pool-inner-lip-right', 0.08, 2.10, 0.06, [1.10, 0.31, 0], C.stoneDark)
  m.slab('pool-water', 2.18, 2.18, 0.035, [0, 0.16, 0], C.water)
  for (const [x, z] of [[-1.23, -1.23], [1.23, -1.23], [-1.23, 1.23], [1.23, 1.23]]) {
    m.slab('pool-corner-block', 0.30, 0.30, 0.28, [x, 0.22, z], C.stoneLight)
    bolt(m, 'pool-corner-rivet', [x, 0.37, z], C.bronze, 0.025)
  }
  for (const [x, z] of [[-0.70, -0.70], [0.70, -0.70], [-0.70, 0.70], [0.70, 0.70]]) {
    m.sphere('pool-water-ripple', [0.14, 0.012, 0.14], [x, 0.18, z], C.stoneLight)
  }
  return finish(m)
}

function kneelingCushions() {
  const m = new Model('kneeling_cushions')
  for (const [index, x] of [-0.86, 0, 0.86].entries()) {
    m.sphere(`cushion-${index + 1}`, [0.76, 0.24, 0.66], [x, 0.12, 0], C.red)
    m.sphere(`cushion-button-${index + 1}`, [0.045, 0.025, 0.045], [x, 0.245, 0], C.cloth)
    m.torus(`cushion-seam-${index + 1}`, 0.26, 0.015, [x, 0.22, -0.02], C.cloth, [Math.PI / 2, 0, 0])
    for (const side of [-1, 1]) m.sphere(`cushion-tassel-${index + 1}`, [0.035, 0.06, 0.035], [x + side * 0.31, 0.06, -0.25], C.straw)
  }
  return finish(m)
}

const BUILDERS = new Map([
  ['stone_steps', stoneSteps],
  ['root_tangle', rootTangle],
  ['armor_stand', armorStand],
  ['archery_target', archeryTarget],
  ['straw_bed', strawBed],
  ['wall_chains', wallChains],
  ['stocks', stocks],
  ['torture_rack', tortureRack],
  ['jailer_desk', jailerDesk],
  ['idol', idol],
  ['font_basin', fontBasin],
  ['incense_burner', incenseBurner],
  ['bell_frame', bellFrame],
  ['holy_pool', holyPool],
  ['kneeling_cushions', kneelingCushions],
])

export function createModel(id) {
  const builder = BUILDERS.get(id)
  if (!builder) throw new Error(`Unknown dungeon model: ${id}`)
  return builder()
}
