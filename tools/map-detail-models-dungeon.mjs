/** Авторские низкополигональные предметы для темниц и храмов. */
import { Model, THREE, random } from './map-detail-model-helpers.mjs'

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
  earth: '#4d3d2e',
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

/** Низкий бугор земли: полусфера с неровной поверхностью. */
function mound(m, name, size, position, color, seed) {
  return m.lumpy(name, new THREE.SphereGeometry(0.5, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2), position, color, { size, amount: 0.025, frequency: 5, seed })
}

function rootTangle() {
  const m = new Model('root_tangle')
  // Каждый корень выходит из земли толстым концом, выгибается дугой и уходит
  // обратно тонким: концы прикрыты земляными буграми, торцов труб не видно.
  const roots = [
    [[-1.30, 0.04, -0.20], [-0.95, 0.42, -0.12], [-0.45, 0.62, 0.02], [0.05, 0.38, 0.12], [0.30, 0.03, 0.18]],
    [[1.32, 0.04, 0.22], [0.95, 0.50, 0.12], [0.40, 0.70, -0.02], [-0.10, 0.44, -0.16], [-0.38, 0.03, -0.24]],
    [[-1.05, 0.04, 0.34], [-0.62, 0.30, 0.26], [-0.18, 0.40, 0.08], [0.22, 0.22, -0.18], [0.48, 0.02, -0.36]],
    [[1.00, 0.04, -0.34], [0.72, 0.28, -0.20], [0.42, 0.34, 0.06], [0.12, 0.16, 0.30], [-0.05, 0.02, 0.42]],
  ]
  roots.forEach((points, index) => {
    m.taperTube(`root-${index + 1}`, points, 0.15 - index * 0.015, 0.035, index % 2 ? C.wood : C.woodDark, 26, 12)
  })
  const rootlets = [
    [[-0.62, 0.55, 0.06], [-0.55, 0.30, 0.30], [-0.48, 0.02, 0.46]],
    [[0.62, 0.62, 0.06], [0.70, 0.36, -0.22], [0.78, 0.02, -0.44]],
    [[0.10, 0.36, 0.20], [0.24, 0.18, 0.40], [0.30, 0.02, 0.52]],
    [[-0.20, 0.42, -0.10], [-0.36, 0.22, -0.34], [-0.40, 0.02, -0.50]],
  ]
  rootlets.forEach((points, index) => m.taperTube(`rootlet-${index + 1}`, points, 0.045, 0.015, C.wood, 14, 8))
  for (const [x, z, w, d, seed] of [[-1.30, -0.20, 0.55, 0.42, 1], [1.32, 0.22, 0.55, 0.44, 2], [-1.05, 0.34, 0.40, 0.32, 3],
    [1.00, -0.34, 0.42, 0.34, 4], [0.32, 0.18, 0.30, 0.26, 5], [-0.38, -0.24, 0.30, 0.28, 6], [0.48, -0.36, 0.26, 0.24, 7], [-0.05, 0.42, 0.26, 0.24, 8]]) {
    mound(m, 'root-soil-mound', [w, 0.16, d], [x, 0, z], C.earth, seed)
  }
  for (const [x, y, z] of [[-0.70, 0.56, -0.06], [0.68, 0.64, 0.08], [0.02, 0.38, 0.10]]) {
    m.sphere('root-bark-knot', [0.13, 0.10, 0.12], [x, y, z], C.woodLight)
  }
  return finish(m)
}

function armorStand() {
  const m = new Model('armor_stand')
  // Крестовина, стойка и плечики — одна деревянная конструкция; кольчуга
  // надета на плечики, шлем сидит на верхушке стойки.
  m.slab('stand-foot', 0.92, 0.16, 0.09, [0, 0.045, 0], C.woodDark)
  m.slab('stand-foot-cross', 0.16, 0.66, 0.09, [0, 0.045, 0], C.woodDark)
  for (const [x, z] of [[-0.44, 0], [0.44, 0], [0, -0.31], [0, 0.31]]) m.slab('stand-foot-pad', 0.12, 0.12, 0.04, [x, 0.02, z], C.wood)
  m.cylinder('stand-post', 0.05, 0.06, 1.52, [0, 0.85, 0], C.wood, 16)
  for (const [x, z] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) m.beam('stand-post-brace', [x * 0.30, 0.09, z * 0.22], [0, 0.42, 0], 0.028, C.wood)
  m.box('stand-shoulder-bar', [0.64, 0.07, 0.08], [0, 1.36, 0], C.wood)
  m.sphere('stand-post-knob', [0.10, 0.08, 0.10], [0, 1.62, 0], C.woodDark)
  // Кольчуга: тело вращения, сплющенное спереди назад, с плечами по перекладине.
  const shirt = lathe(m, 'chainmail-shirt', [[0.30, 0.70], [0.29, 0.74], [0.25, 0.92], [0.26, 1.06], [0.29, 1.26], [0.28, 1.36], [0.20, 1.42], [0.10, 1.47]], C.iron, 28)
  shirt.scale.set(1, 1, 0.62)
  for (const y of [0.78, 0.90, 1.02, 1.14, 1.26]) {
    m.torus('chainmail-ring', [0.290, 0.262, 0.265, 0.280, 0.298][[0.78, 0.90, 1.02, 1.14, 1.26].indexOf(y)], 0.01, [0, y, 0], C.ironLight, [Math.PI / 2, 0, 0]).scale.set(1, 0.62, 1)
  }
  m.torus('chainmail-hem', 0.30, 0.022, [0, 0.71, 0], C.ironLight, [Math.PI / 2, 0, 0]).scale.set(1, 0.62, 1)
  m.torus('chainmail-collar', 0.11, 0.025, [0, 1.46, 0], C.ironLight, [Math.PI / 2, 0, 0])
  for (const side of [-1, 1]) {
    m.taperTube('chainmail-sleeve', [[side * 0.24, 1.33, 0], [side * 0.34, 1.20, 0], [side * 0.39, 1.04, 0]], 0.10, 0.085, C.iron, 10, 14)
    m.torus('chainmail-sleeve-hem', 0.085, 0.016, [side * 0.39, 1.04, 0], C.ironLight, [Math.PI / 2, 0, side * 0.3])
  }
  m.box('chainmail-belt', [0.50, 0.05, 0.36], [0, 0.95, 0], C.woodDark)
  m.box('chainmail-belt-buckle', [0.07, 0.07, 0.03], [0, 0.95, -0.18], C.bronze)
  // Шлем с наносником сидит на верхушке стойки.
  lathe(m, 'helmet', [[0.175, 1.57], [0.168, 1.58], [0.165, 1.63], [0.155, 1.72], [0.12, 1.80], [0.06, 1.85], [0.0, 1.86]], C.iron, 28)
  m.torus('helmet-rim', 0.172, 0.018, [0, 1.575, 0], C.ironLight, [Math.PI / 2, 0, 0])
  m.box('helmet-nasal', [0.045, 0.16, 0.03], [0, 1.52, -0.175], C.iron)
  return finish(m)
}

function archeryTarget() {
  const m = new Model('archery_target')
  // Тренога: две передние ноги и задняя подпорка сходятся у перекладины,
  // на которую опирается наклонённый соломенный щит.
  m.beam('target-leg-left', [-0.50, 0.03, 0.02], [-0.30, 1.32, 0.22], 0.035, C.wood)
  m.beam('target-leg-right', [0.50, 0.03, 0.02], [0.30, 1.32, 0.22], 0.035, C.wood)
  m.beam('target-leg-back', [0, 0.03, 0.62], [0, 1.25, 0.24], 0.035, C.woodDark)
  m.beam('target-top-bar', [-0.33, 1.22, 0.204], [0.33, 1.22, 0.204], 0.03, C.woodDark)
  for (const side of [-1, 1]) m.beam('target-rest-peg', [side * 0.427, 0.50, 0.093], [side * 0.36, 0.50, -0.12], 0.035, C.woodDark)
  m.group('target-face', [0, 0.96, 0.06], [0.20, 0, 0], () => {
    // Щит смотрит вперёд (-Z); кольца лежат на лицевой стороне ступенькой.
    m.cylinder('target-disc', 0.44, 0.44, 0.16, [0, 0, 0], C.straw, 40, [Math.PI / 2, 0, 0])
    m.torus('target-straw-rim', 0.44, 0.05, [0, 0, 0], C.strawLight, [0, 0, 0])
    for (const z of [-0.06, 0.06]) m.torus('target-straw-binding', 0.452, 0.012, [0, 0, z], C.rope)
    const rings = [[0.40, C.strawLight], [0.31, C.red], [0.22, C.strawLight], [0.13, C.red], [0.055, C.bronze]]
    rings.forEach(([radius, color], index) => {
      m.cylinder('target-ring', radius, radius, 0.012, [0, 0, -0.082 - index * 0.006], color, 40, [Math.PI / 2, 0, 0])
    })
    for (const [x, y, ax, ay] of [[-0.17, 0.13, 0.10, -0.05], [0.08, -0.20, -0.06, 0.08], [0.19, 0.06, 0.04, 0.10]]) {
      const tail = [x + ax, y + ay, -0.56]
      m.beam('target-arrow-shaft', [x, y, -0.06], tail, 0.011, C.woodLight)
      for (const turn of [0, 2.09, 4.19]) {
        m.box('target-arrow-fletching', [0.006, 0.035, 0.09], [tail[0] + Math.cos(turn) * 0.018, tail[1] + Math.sin(turn) * 0.018, tail[2] + 0.04], C.red, [0, 0, turn])
      }
    }
  })
  return finish(m)
}

function strawBed() {
  const m = new Model('straw_bed')
  // Куча соломы — неровный низкий купол; одеяло ложится по её поверхности.
  const halfX = 0.54, halfZ = 1.12, top = 0.17
  const heap = (x, z) => top * Math.sqrt(Math.max(0, 1 - (x / halfX) ** 2 - (z / halfZ) ** 2))
  m.lumpy('straw-heap', new THREE.SphereGeometry(0.5, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2), [0, 0, 0], C.straw, { size: [halfX * 2, top, halfZ * 2], amount: 0.018, frequency: 7, seed: 11 })
  for (const [x, z, w, d, seed] of [[-0.40, -0.80, 0.42, 0.50, 12], [0.42, -0.30, 0.36, 0.56, 13], [-0.44, 0.52, 0.34, 0.50, 14], [0.36, 0.86, 0.40, 0.42, 15]]) {
    m.lumpy('straw-tuft', new THREE.SphereGeometry(0.5, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2), [x, 0, z], C.strawLight, { size: [w, 0.10, d], amount: 0.015, frequency: 9, seed })
  }
  const next = random(41)
  for (let index = 0; index < 46; index += 1) {
    const angle = next() * Math.PI * 2
    const ring = 0.86 + next() * 0.22
    const x = Math.cos(angle) * halfX * ring, z = Math.sin(angle) * halfZ * ring
    const length = 0.16 + next() * 0.14
    const turn = angle + (next() - 0.5) * 1.4
    const y = heap(x * 0.92, z * 0.92) * 0.5 + 0.012
    m.beam('straw-strand', [x, y, z], [x + Math.cos(turn) * length, 0.01, z + Math.sin(turn) * length], 0.006, next() > 0.5 ? C.strawLight : C.straw)
  }
  m.lumpy('straw-pillow', new THREE.SphereGeometry(0.5, 28, 14), [0.02, 0.17, 0.78], C.strawLight, { size: [0.56, 0.14, 0.36], amount: 0.012, frequency: 8, seed: 16 })
  // Рваное одеяло наискось поверх кучи: высота повторяет купол с небольшими складками.
  const blanket = m.drape('blanket', 0.92, 1.30, (x, z) => {
    const wx = x * Math.cos(0.18) - z * Math.sin(0.18) + 0.04, wz = x * Math.sin(0.18) + z * Math.cos(0.18) - 0.22
    return heap(wx, wz) + 0.02 + Math.sin(x * 9 + z * 3) * 0.012 - Math.max(0, Math.abs(x) - 0.38) * 0.35
  }, C.blanket, { segments: [18, 24], ragged: 0.08, seed: 17 })
  blanket.position.set(0.04, 0, -0.22)
  blanket.rotation.y = -0.18
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
