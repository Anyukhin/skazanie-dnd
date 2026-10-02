/** Авторские низкополигональные модели города, библиотеки и набережной. */
import { Model, THREE } from './map-detail-model-helpers.mjs'

const PI = Math.PI

const C = Object.freeze({
  wood: '#63452f',
  woodLight: '#9a7048',
  woodDark: '#3b2b22',
  stone: '#77766d',
  stoneLight: '#aaa18d',
  stoneDark: '#4e4d48',
  brass: '#a47a3d',
  iron: '#454744',
  water: '#3f7776',
  glass: '#6f9690',
  green: '#536a45',
  greenDark: '#304832',
  red: '#82483d',
  yellow: '#b28b42',
  blue: '#4e6870',
  purple: '#6b536d',
  paper: '#c2b492',
  rope: '#8b704b',
  straw: '#ae8a4d',
  fish: '#71827b',
})

/** Модели, для которых в разделе 6.3 требуется генерация 3D. */
export const MODEL_IDS = Object.freeze([
  'globe',
  'scroll_rack',
  'reading_nook',
  'candle_desk',
  'telescope',
  'fountain',
  'statue_plinth',
  'flower_bed',
  'pillory',
  'town_well',
  'street_planter',
  'sign_post_city',
  'rowboat',
  'punt',
  'mooring_post',
  'fish_rack',
  'fishing_nets',
])

function finish(model, id) {
  model.root.name = `map-detail:${id}`
  model.root.userData = { assetId: id, recipe: 'skazanie-map-detail-town-v1' }
  model.root.updateMatrixWorld(true)
  return model.root
}

function addBook(model, name, x, y, z, width, depth, height, color, rotation = 0) {
  model.box(name, [width, height, depth], [x, y, z], color, [0, rotation, 0])
}

function addFlower(model, name, x, z, color, height = 0.27) {
  model.beam(`${name}-stem`, [x, 0.25, z], [x, 0.25 + height, z], 0.018, C.greenDark)
  model.sphere(`${name}-head`, [0.11, 0.11, 0.11], [x, 0.25 + height, z], color)
}

/** Профильная деталь даёт настоящую кромку, а не стопку плоских цилиндров. */
function lathe(model, name, profile, color, segments = 24) {
  const points = profile.map(([radius, y]) => new THREE.Vector2(radius, y))
  return model.mesh(name, new THREE.LatheGeometry(points, segments), [0, 0, 0], color)
}

function tube(model, name, points, radius, color, tubularSegments = 12, radialSegments = 8) {
  const curve = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point)), false, 'centripetal')
  return model.mesh(name, new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false), [0, 0, 0], color)
}

function addBolt(model, name, x, y, z, color = C.iron, size = 0.045) {
  model.sphere(name, [size, size, size], [x, y, z], color)
}

/** Полый корпус лодки: наружный борт, внутренний борт, привальный брус и дно. */
function boatHull(model, name, length, width, height, color = C.wood) {
  const stations = [-0.5, -0.34, -0.12, 0.14, 0.36, 0.5]
  const widths = [0.05, 0.34, 0.5, 0.5, 0.34, 0.05].map(value => value * width)
  const bottomWidths = [0.03, 0.20, 0.30, 0.30, 0.20, 0.03].map(value => value * width)
  const position = []
  const addQuad = (a, b, c, d) => {
    position.push(...a, ...b, ...c, ...a, ...c, ...d)
  }
  const side = sign => stations.map((fraction, index) => {
    const z = fraction * length
    const outerBottom = [sign * bottomWidths[index], 0.08, z]
    const outerRim = [sign * widths[index], height * 0.72, z]
    const innerRim = [sign * Math.max(0.018, widths[index] - width * 0.055), height * 0.65, z]
    const innerFloor = [sign * Math.max(0.012, bottomWidths[index] * 0.68), height * 0.25, z]
    return { outerBottom, outerRim, innerRim, innerFloor }
  })
  const left = side(-1)
  const right = side(1)
  for (const a of [left, right]) {
    for (let index = 0; index < stations.length - 1; index += 1) {
      addQuad(a[index].outerBottom, a[index + 1].outerBottom, a[index + 1].outerRim, a[index].outerRim)
      addQuad(a[index].innerFloor, a[index].innerRim, a[index + 1].innerRim, a[index + 1].innerFloor)
      addQuad(a[index].outerRim, a[index + 1].outerRim, a[index + 1].innerRim, a[index].innerRim)
    }
  }
  for (let index = 0; index < stations.length - 1; index += 1) {
    addQuad(left[index].innerFloor, right[index].innerFloor, right[index + 1].innerFloor, left[index + 1].innerFloor)
    addQuad(left[index].outerBottom, left[index + 1].outerBottom, right[index + 1].outerBottom, right[index].outerBottom)
  }
  for (const index of [0, stations.length - 1]) {
    addQuad(left[index].outerBottom, right[index].outerBottom, right[index].outerRim, left[index].outerRim)
    addQuad(left[index].innerFloor, left[index].innerRim, right[index].innerRim, right[index].innerFloor)
    addQuad(left[index].outerRim, right[index].outerRim, right[index].innerRim, left[index].innerRim)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  geometry.computeVertexNormals()
  return model.mesh(name, geometry, [0, 0, 0], color)
}

function buildGlobe() {
  const model = new Model('globe')
  model.cylinder('globe-foot', 0.29, 0.31, 0.08, [0, 0.04, 0], C.woodDark, 16)
  model.torus('globe-foot-inlay', 0.22, 0.025, [0, 0.085, 0], C.brass, [Math.PI / 2, 0, 0])
  model.cylinder('globe-column', 0.055, 0.075, 0.38, [0, 0.27, 0], C.wood, 10)
  model.box('globe-crossbar', [0.38, 0.045, 0.07], [0, 0.47, 0], C.woodLight)
  model.sphere('globe-sphere', [0.42, 0.42, 0.42], [0, 0.70, 0], C.blue)
  model.torus('globe-meridian', 0.235, 0.018, [0, 0.70, 0], C.brass)
  model.torus('globe-equator', 0.215, 0.012, [0, 0.70, 0], C.brass, [PI / 2, 0, 0])
  model.torus('globe-tropic-north', 0.19, 0.009, [0, 0.79, 0], C.brass, [PI / 2, 0, 0])
  model.torus('globe-tropic-south', 0.19, 0.009, [0, 0.61, 0], C.brass, [PI / 2, 0, 0])
  model.box('globe-axis', [0.035, 0.46, 0.035], [0, 0.70, 0], C.brass, [0, 0, 0.12])
  model.sphere('globe-axis-cap-top', [0.05, 0.05, 0.05], [0.03, 0.93, 0], C.brass)
  model.sphere('globe-axis-cap-bottom', [0.05, 0.05, 0.05], [-0.03, 0.47, 0], C.brass)
  return finish(model, 'globe')
}

function buildScrollRack() {
  const model = new Model('scroll_rack')
  model.box('scroll-rack-back', [2.38, 1.30, 0.06], [0, 0.78, 0.14], C.woodDark)
  model.box('scroll-rack-top', [2.52, 0.10, 0.34], [0, 1.46, 0], C.wood)
  model.box('scroll-rack-bottom', [2.52, 0.10, 0.34], [0, 0.10, 0], C.wood)
  for (const x of [-1.20, 1.20]) model.box('scroll-rack-side', [0.10, 1.38, 0.34], [x, 0.78, 0], C.wood)
  for (const x of [-0.80, 0, 0.80]) {
    model.beam('scroll-rack-diamond-left', [x, 0.25, -0.18], [x - 0.32, 0.78, -0.18], 0.035, C.woodLight)
    model.beam('scroll-rack-diamond-right', [x - 0.32, 0.78, -0.18], [x, 1.31, -0.18], 0.035, C.woodLight)
    model.beam('scroll-rack-diamond-left-lower', [x, 0.25, -0.18], [x + 0.32, 0.78, -0.18], 0.035, C.woodLight)
    model.beam('scroll-rack-diamond-right-lower', [x + 0.32, 0.78, -0.18], [x, 1.31, -0.18], 0.035, C.woodLight)
    model.cylinder('scroll-rack-scroll', 0.075, 0.075, 0.42, [x, 0.78, -0.10], C.paper, 10, [0, 0, PI / 2])
    model.cylinder('scroll-rack-scroll-cap', 0.09, 0.09, 0.018, [x - 0.22, 0.78, -0.10], C.red, 10, [0, 0, PI / 2])
    model.torus('scroll-rack-scroll-band', 0.078, 0.012, [x + 0.13, 0.78, -0.10], C.red, [0, PI / 2, 0])
    model.sphere('scroll-rack-scroll-seal', [0.035, 0.035, 0.025], [x - 0.22, 0.78, -0.10], C.brass)
  }
  for (const x of [-1.02, -0.34, 0.34, 1.02]) model.cylinder('scroll-rack-shelf-peg', 0.035, 0.035, 0.20, [x, 0.22, -0.22], C.woodLight, 8, [Math.PI / 2, 0, 0])
  return finish(model, 'scroll_rack')
}

function buildReadingNook() {
  const model = new Model('reading_nook')
  const chairX = -0.42
  model.box('reading-chair-seat', [0.92, 0.18, 0.72], [chairX, 0.56, 0.05], C.green)
  model.box('reading-chair-back', [0.92, 0.58, 0.15], [chairX, 0.91, 0.34], C.greenDark)
  model.slab('reading-chair-cushion', 0.78, 0.58, 0.10, [chairX, 0.68, 0.03], C.green)
  model.torus('reading-chair-button', 0.045, 0.012, [chairX, 0.72, -0.27], C.woodDark, [Math.PI / 2, 0, 0])
  model.box('reading-chair-left-arm', [0.14, 0.38, 0.76], [chairX - 0.40, 0.72, 0.03], C.wood)
  model.box('reading-chair-right-arm', [0.14, 0.38, 0.76], [chairX + 0.40, 0.72, 0.03], C.wood)
  for (const x of [chairX - 0.34, chairX + 0.34]) for (const z of [-0.22, 0.29]) {
    model.beam('reading-chair-leg', [x, 0.10, z], [x, 0.48, z], 0.035, C.woodDark)
  }
  model.table('reading-side-table', 0.48, 0.46, 0.58, C.wood)
  // Сдвиг стола и его содержимого к свободной стороне кресла.
  const table = model.root.children.at(-1)
  if (table) table.position.x = 0.70
  addBook(model, 'reading-book-bottom', 0.70, 0.56, 0, 0.34, 0.26, 0.07, C.red, -0.08)
  addBook(model, 'reading-book-top', 0.68, 0.63, 0, 0.30, 0.23, 0.06, C.blue, 0.06)
  model.cylinder('reading-candle', 0.035, 0.04, 0.16, [0.78, 0.64, 0], C.brass, 10)
  model.torus('reading-candle-drip-catch', 0.07, 0.012, [0.78, 0.56, 0], C.brass, [Math.PI / 2, 0, 0])
  model.sphere('reading-flame', [0.06, 0.10, 0.06], [0.78, 0.76, 0], C.yellow)
  return finish(model, 'reading_nook')
}

function buildCandleDesk() {
  const model = new Model('candle_desk')
  model.table('candle-desk', 1.72, 0.70, 0.68, C.wood)
  const desk = model.root.children.at(-1)
  if (desk) desk.position.x = -0.20
  addBook(model, 'candle-desk-book-a', -0.20, 0.710, -0.08, 0.42, 0.27, 0.07, C.red, -0.08)
  addBook(model, 'candle-desk-book-b', -0.17, 0.790, -0.08, 0.38, 0.25, 0.07, C.blue, 0.05)
  addBook(model, 'candle-desk-book-c', 0.28, 0.715, 0.08, 0.30, 0.22, 0.06, C.green, 0.08)
  model.box('candle-desk-drawer', [0.62, 0.20, 0.055], [-0.20, 0.53, -0.36], C.woodDark)
  model.box('candle-desk-drawer-handle', [0.11, 0.035, 0.025], [-0.20, 0.53, -0.40], C.brass)
  model.cylinder('candle-desk-candlestick', 0.045, 0.065, 0.14, [0.54, 0.75, -0.03], C.brass, 10)
  model.torus('candle-desk-catch-plate', 0.09, 0.015, [0.54, 0.69, -0.03], C.brass, [Math.PI / 2, 0, 0])
  model.cylinder('candle-desk-candle', 0.025, 0.03, 0.12, [0.54, 0.875, -0.03], C.paper, 10)
  model.sphere('candle-desk-flame', [0.05, 0.04, 0.05], [0.54, 0.955, -0.03], C.yellow)
  model.beam('candle-desk-quill', [0.35, 0.78, -0.18], [0.54, 0.97, -0.18], 0.012, C.woodDark)
  return finish(model, 'candle_desk')
}

function buildTelescope() {
  const model = new Model('telescope')
  const hub = [0, 0.72, 0.10]
  for (const end of [[-0.31, 0.04, 0.31], [0.31, 0.04, 0.31], [0, 0.04, -0.34]]) {
    model.beam('telescope-tripod-leg', hub, end, 0.035, C.wood)
  }
  model.cylinder('telescope-hub', 0.09, 0.09, 0.10, hub, C.brass, 10)
  model.beam('telescope-tube', [0, 1.18, 0.22], [0, 1.18, -0.27], 0.09, C.brass)
  model.torus('telescope-objective-ring', 0.105, 0.018, [0, 1.18, -0.27], C.iron)
  model.torus('telescope-barrel-ring', 0.094, 0.014, [0, 1.18, 0.05], C.brass)
  model.cylinder('telescope-objective-glass', 0.073, 0.073, 0.012, [0, 1.18, -0.272], C.glass, 16, [Math.PI / 2, 0, 0])
  model.cylinder('telescope-eyepiece', 0.055, 0.055, 0.12, [0, 1.18, 0.31], C.iron, 10)
  model.torus('telescope-eyepiece-collar', 0.062, 0.012, [0, 1.18, 0.28], C.iron, [Math.PI / 2, 0, 0])
  model.beam('telescope-mount', [0, 0.72, 0.10], [0, 1.12, 0.10], 0.04, C.woodDark)
  model.sphere('telescope-focusing-knob', [0.06, 0.06, 0.06], [0.12, 1.16, 0.03], C.iron)
  return finish(model, 'telescope')
}

function buildFountain() {
  const model = new Model('fountain')
  lathe(model, 'fountain-basin', [
    [0.18, 0], [1.72, 0], [1.98, 0.06], [2.08, 0.16], [2.04, 0.27],
    [1.94, 0.34], [1.84, 0.32], [1.78, 0.27], [0.24, 0.27], [0.16, 0.18], [0.16, 0.04],
  ], C.stone, 28)
  model.torus('fountain-rim', 1.93, 0.12, [0, 0.32, 0], C.stoneLight, [PI / 2, 0, 0])
  model.torus('fountain-inner-rim', 1.80, 0.045, [0, 0.28, 0], C.stoneDark, [PI / 2, 0, 0])
  model.cylinder('fountain-water', 1.76, 1.76, 0.045, [0, 0.275, 0], C.water, 28)
  for (const [name, position, size] of [
    ['front', [0, 0.09, -1.78], [0.70, 0.18, 0.28]],
    ['back', [0, 0.09, 1.78], [0.70, 0.18, 0.28]],
    ['left', [-1.78, 0.09, 0], [0.28, 0.18, 0.70]],
    ['right', [1.78, 0.09, 0], [0.28, 0.18, 0.70]],
  ]) model.slab(`fountain-step-${name}`, size[0], size[2], size[1], position, C.stoneDark)
  lathe(model, 'fountain-pedestal', [
    [0, 0.31], [0.20, 0.31], [0.38, 0.34], [0.42, 0.41], [0.34, 0.47], [0.30, 0.98], [0.40, 1.04], [0, 1.04],
  ], C.stoneDark, 20)
  lathe(model, 'fountain-bowl', [
    [0.12, 1.00], [0.58, 1.00], [0.64, 1.07], [0.58, 1.18], [0.48, 1.23], [0.41, 1.19], [0.12, 1.18],
  ], C.stoneLight, 20)
  model.torus('fountain-bowl-rim', 0.52, 0.06, [0, 1.19, 0], C.stone, [PI / 2, 0, 0])
  model.cylinder('fountain-bowl-water', 0.41, 0.41, 0.035, [0, 1.205, 0], C.water, 18)
  model.sphere('fountain-cap', [0.13, 0.18, 0.13], [0, 1.33, 0], C.stone)
  for (const end of [[0.72, 0.31, 0], [-0.72, 0.31, 0], [0, 0.31, 0.72], [0, 0.31, -0.72]]) {
    model.beam('fountain-spill', [0, 1.16, 0], end, 0.025, C.water)
  }
  for (const angle of [0, PI / 2, PI, 3 * PI / 2]) {
    const x = Math.cos(angle) * 1.93
    const z = Math.sin(angle) * 1.93
    model.sphere('fountain-corner-carving', [0.12, 0.12, 0.12], [x, 0.33, z], C.stoneLight)
  }
  return finish(model, 'fountain')
}

function buildStatuePlinth() {
  const model = new Model('statue_plinth')
  model.slab('statue-plinth-foot', 2.18, 2.18, 0.24, [0, 0.12, 0], C.stoneDark)
  model.slab('statue-plinth-upper', 1.74, 1.74, 0.28, [0, 0.38, 0], C.stoneLight)
  model.box('warrior-hips', [0.58, 0.28, 0.42], [0, 0.70, 0], C.iron)
  model.slab('warrior-torso', 0.68, 0.46, 0.68, [0, 1.16, 0], C.iron)
  model.box('warrior-belt', [0.62, 0.08, 0.48], [0, 0.91, -0.01], C.brass)
  model.box('warrior-chest-plate', [0.50, 0.48, 0.045], [0, 1.19, -0.255], C.brass)
  model.box('warrior-chest-ridge', [0.045, 0.40, 0.03], [0, 1.20, -0.285], C.iron)
  for (const x of [-0.27, 0.27]) {
    model.beam('warrior-leg', [x, 0.48, 0], [x * 0.82, 0.91, 0], 0.09, C.iron)
    model.box('warrior-greave', [0.18, 0.28, 0.28], [x * 0.82, 0.66, -0.08], C.iron)
    model.box('warrior-boot', [0.22, 0.10, 0.35], [x * 0.82, 0.47, -0.08], C.iron)
  }
  for (const [x, z, rotation] of [[-0.22, -0.20, -0.16], [0, -0.24, 0], [0.22, -0.20, 0.16]]) {
    model.box('warrior-tasset', [0.18, 0.26, 0.06], [x, 0.78, z], C.brass, [rotation, 0, 0])
  }
  model.box('warrior-shoulders', [0.98, 0.22, 0.46], [0, 1.54, 0], C.iron)
  model.sphere('warrior-pauldron-left', [0.27, 0.22, 0.27], [-0.49, 1.52, 0], C.brass)
  model.sphere('warrior-pauldron-right', [0.27, 0.22, 0.27], [0.49, 1.52, 0], C.brass)
  for (const x of [-0.50, 0.50]) model.beam('warrior-arm', [x, 1.48, 0], [x * 0.88, 1.10, -0.03], 0.065, C.iron)
  model.cylinder('warrior-neck', 0.15, 0.17, 0.22, [0, 1.69, 0], C.stoneDark, 12)
  model.torus('warrior-neck-collar', 0.18, 0.035, [0, 1.60, 0], C.brass, [PI / 2, 0, 0])
  model.sphere('warrior-head', [0.38, 0.40, 0.36], [0, 1.90, -0.01], C.stone)
  model.sphere('warrior-helmet-dome', [0.43, 0.24, 0.40], [0, 2.08, 0], C.brass)
  model.torus('warrior-helmet-rim', 0.26, 0.035, [0, 1.99, 0], C.brass, [PI / 2, 0, 0])
  model.box('warrior-helmet-nose', [0.07, 0.18, 0.08], [0, 1.96, -0.20], C.brass)
  model.box('warrior-helmet-cheek-left', [0.07, 0.16, 0.06], [-0.17, 1.95, -0.16], C.brass)
  model.box('warrior-helmet-cheek-right', [0.07, 0.16, 0.06], [0.17, 1.95, -0.16], C.brass)
  model.box('warrior-helmet-crest', [0.08, 0.33, 0.06], [0, 2.28, 0], C.red)
  for (const x of [-0.11, 0.11]) model.sphere('warrior-eye-shadow', [0.045, 0.035, 0.025], [x, 1.99, -0.205], C.woodDark)
  model.cylinder('warrior-shield', 0.31, 0.31, 0.10, [-0.64, 1.05, -0.12], C.wood, 14, [PI / 2, 0, 0])
  model.torus('warrior-shield-rim', 0.28, 0.035, [-0.64, 1.05, -0.19], C.brass, [PI / 2, 0, 0])
  model.sphere('warrior-shield-boss', [0.08, 0.08, 0.08], [-0.64, 1.05, -0.25], C.iron)
  model.beam('warrior-sword-grip', [0.64, 0.80, 0.10], [0.64, 0.97, 0.10], 0.040, C.woodDark)
  model.beam('warrior-sword-blade', [0.64, 1.00, 0.10], [0.64, 1.62, 0.10], 0.032, C.iron)
  model.box('warrior-sword-hilt', [0.30, 0.045, 0.06], [0.64, 0.98, 0.10], C.brass)
  model.sphere('warrior-sword-pommel', [0.055, 0.055, 0.055], [0.64, 0.86, 0.10], C.brass)
  return finish(model, 'statue_plinth')
}

function buildFlowerBed() {
  const model = new Model('flower_bed')
  model.slab('flower-bed-bottom', 2.52, 0.94, 0.10, [0, 0.05, 0], C.stoneDark)
  model.box('flower-bed-front', [2.58, 0.34, 0.12], [0, 0.22, 0.48], C.stone)
  model.box('flower-bed-back', [2.58, 0.34, 0.12], [0, 0.22, -0.48], C.stone)
  model.box('flower-bed-left', [0.12, 0.34, 0.84], [-1.23, 0.22, 0], C.stoneLight)
  model.box('flower-bed-right', [0.12, 0.34, 0.84], [1.23, 0.22, 0], C.stoneLight)
  model.box('flower-bed-soil', [2.32, 0.16, 0.75], [0, 0.38, 0], C.woodDark)
  const flowers = [[-0.92, -0.20, C.red], [-0.58, 0.20, C.yellow], [-0.23, -0.18, C.purple], [0.16, 0.16, C.red], [0.54, -0.16, C.yellow], [0.91, 0.18, C.purple]]
  flowers.forEach(([x, z, color], index) => addFlower(model, `flower-bed-flower-${index}`, x, z, color, 0.18 + (index % 2) * 0.05))
  for (const [x, z] of [[-1.23, -0.48], [1.23, -0.48], [-1.23, 0.48], [1.23, 0.48]]) {
    model.sphere('flower-bed-corner-cap', [0.12, 0.11, 0.12], [x, 0.42, z], C.stoneLight)
  }
  for (const [x, z] of [[-0.72, 0.05], [-0.34, -0.04], [0.40, 0.04], [0.78, -0.02]]) {
    model.beam('flower-bed-leaf', [x, 0.40, z], [x + (x < 0 ? -0.12 : 0.12), 0.50, z + 0.08], 0.025, C.green)
  }
  return finish(model, 'flower_bed')
}

function buildPillory() {
  const model = new Model('pillory')
  model.slab('pillory-platform', 2.28, 0.92, 0.20, [0, 0.10, 0], C.woodDark)
  for (const x of [-0.88, 0.88]) model.box('pillory-post', [0.16, 1.55, 0.16], [x, 0.96, 0], C.wood)
  model.box('pillory-top-beam', [2.02, 0.18, 0.18], [0, 1.65, 0], C.woodLight)
  model.box('pillory-lower-beam', [2.02, 0.16, 0.18], [0, 1.08, 0], C.wood)
  // Раздельные половины доски оставляют два читаемых отверстия для головы.
  model.box('pillory-stock-left', [0.62, 0.30, 0.22], [-0.58, 1.34, 0], C.woodLight)
  model.box('pillory-stock-middle', [0.24, 0.30, 0.22], [0, 1.34, 0], C.woodLight)
  model.box('pillory-stock-right', [0.62, 0.30, 0.22], [0.58, 1.34, 0], C.woodLight)
  for (const x of [-0.28, 0.28]) {
    model.box('pillory-stock-hinge', [0.07, 0.33, 0.25], [x, 1.34, 0], C.iron)
    addBolt(model, 'pillory-stock-bolt-front', x, 1.34, -0.14)
    addBolt(model, 'pillory-stock-bolt-back', x, 1.34, 0.14)
  }
  for (const x of [-0.195, 0.195]) {
    model.box('pillory-stock-strap', [0.035, 0.30, 0.24], [x, 1.34, 0], C.iron)
    addBolt(model, 'pillory-stock-strap-bolt-front', x, 1.34, -0.13)
    addBolt(model, 'pillory-stock-strap-bolt-back', x, 1.34, 0.13)
  }
  for (const x of [-0.88, 0.88]) model.beam('pillory-diagonal-brace', [x, 0.30, 0.01], [x * 0.72, 1.45, 0.01], 0.035, C.woodDark)
  return finish(model, 'pillory')
}

function buildTownWell() {
  const model = new Model('town_well')
  lathe(model, 'town-well-wall', [
    [0.72, 0.02], [0.96, 0.02], [1.12, 0.10], [1.14, 0.49], [1.08, 0.61], [0.98, 0.67], [0.90, 0.61], [0.90, 0.18],
  ], C.stone, 22)
  model.torus('town-well-rim', 1.03, 0.12, [0, 0.65, 0], C.stoneLight, [PI / 2, 0, 0])
  model.torus('town-well-inner-rim', 0.83, 0.045, [0, 0.64, 0], C.stoneDark, [PI / 2, 0, 0])
  model.cylinder('town-well-water', 0.88, 0.88, 0.035, [0, 0.69, 0], C.water, 14)
  for (const [x, z] of [[-0.88, -0.78], [0.88, -0.78], [-0.88, 0.78], [0.88, 0.78]]) {
    model.box('town-well-post', [0.14, 1.65, 0.14], [x, 1.48, z], C.wood)
    model.box('town-well-post-foot', [0.25, 0.10, 0.25], [x, 0.08, z], C.woodDark)
    model.box('town-well-post-cap', [0.22, 0.12, 0.22], [x, 2.29, z], C.woodLight)
  }
  model.box('town-well-front-beam', [2.02, 0.14, 0.14], [0, 2.23, -0.78], C.woodDark)
  model.box('town-well-back-beam', [2.02, 0.14, 0.14], [0, 2.23, 0.78], C.woodDark)
  model.box('town-well-roof-left', [2.20, 0.12, 1.02], [0, 2.30, -0.48], C.red, [-0.43, 0, 0])
  model.box('town-well-roof-right', [2.20, 0.12, 1.02], [0, 2.30, 0.48], C.red, [0.43, 0, 0])
  for (const z of [-0.84, -0.56, -0.28, 0, 0.28, 0.56, 0.84]) {
    const roofY = 2.50 - Math.abs(z) * 0.38
    model.beam('town-well-roof-rib', [-1.02, roofY, z], [1.02, roofY, z], 0.025, C.woodDark)
  }
  model.box('town-well-ridge', [2.25, 0.12, 0.14], [0, 2.50, 0], C.woodDark)
  for (const x of [-0.88, 0.88]) {
    model.beam('town-well-brace-front', [x, 1.02, -0.78], [x * 0.72, 1.96, -0.78], 0.035, C.woodDark)
    model.beam('town-well-brace-back', [x, 1.02, 0.78], [x * 0.72, 1.96, 0.78], 0.035, C.woodDark)
  }
  model.cylinder('town-well-spindle', 0.06, 0.06, 1.70, [0, 1.84, 0], C.woodDark, 10, [0, 0, PI / 2])
  model.cylinder('town-well-crank', 0.045, 0.045, 0.22, [0.92, 1.84, 0], C.iron, 8, [0, 0, PI / 2])
  model.beam('town-well-crank-handle', [1.02, 1.84, 0], [1.02, 1.56, 0], 0.035, C.wood)
  model.beam('town-well-rope', [0, 1.83, 0], [0, 1.18, -0.02], 0.018, C.rope)
  model.barrel('town-well-bucket', 0.18, 0.24, [0, 0.77, -0.02], C.woodLight)
  model.torus('town-well-bucket-rim', 0.17, 0.018, [0, 1.01, -0.02], C.iron, [PI / 2, 0, 0])
  tube(model, 'town-well-bucket-handle', [[-0.16, 1.00, -0.02], [-0.19, 1.12, -0.02], [0, 1.19, -0.02], [0.19, 1.12, -0.02], [0.16, 1.00, -0.02]], 0.014, C.iron, 12, 6)
  return finish(model, 'town_well')
}

function buildStreetPlanter() {
  const model = new Model('street_planter')
  model.barrel('street-planter-tub', 0.36, 0.34, [0, 0, 0], C.wood)
  for (const y of [0.08, 0.26]) model.torus('street-planter-tub-hoop', 0.33, 0.022, [0, y, 0], C.iron, [PI / 2, 0, 0])
  model.cylinder('street-planter-soil', 0.28, 0.28, 0.04, [0, 0.36, 0], C.woodDark, 12)
  model.cylinder('street-planter-trunk', 0.075, 0.09, 0.72, [0, 0.78, 0], C.woodDark, 8)
  model.beam('street-planter-branch-left', [0, 1.06, 0], [-0.20, 1.22, 0], 0.035, C.wood)
  model.beam('street-planter-branch-right', [0, 1.08, 0], [0.18, 1.29, -0.03], 0.035, C.wood)
  for (const [x, y, z, scale] of [[-0.18, 1.26, 0, 0.34], [0.15, 1.30, -0.04, 0.38], [0, 1.47, 0.03, 0.30]]) {
    model.sphere('street-planter-crown', [scale, scale * 0.82, scale], [x, y, z], C.green)
  }
  model.sphere('street-planter-crown-shadow', [0.20, 0.12, 0.20], [0, 1.18, -0.05], C.greenDark)
  return finish(model, 'street_planter')
}

function addArrowSign(model, name, x, y, z, rotation, color) {
  model.box(`${name}-board`, [0.48, 0.16, 0.065], [x, y, z], color, [0, rotation, 0])
  const shape = new THREE.Shape()
  shape.moveTo(0, -0.08)
  shape.lineTo(0.18, 0)
  shape.lineTo(0, 0.08)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.065,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.008,
    bevelThickness: 0.008,
  })
  geometry.translate(0, 0, -0.0325)
  model.mesh(`${name}-tip`, geometry, [x + Math.cos(rotation) * 0.22, y, z - Math.sin(rotation) * 0.22], color, [0, rotation, 0])
}

function buildSignPostCity() {
  const model = new Model('sign_post_city')
  model.box('city-sign-post', [0.10, 2.02, 0.10], [0, 1.01, 0], C.wood)
  model.box('city-sign-foot', [0.32, 0.08, 0.28], [0, 0.04, 0], C.woodDark)
  addArrowSign(model, 'city-sign-low', 0.03, 1.37, -0.02, PI / 2, C.woodLight)
  addArrowSign(model, 'city-sign-mid', -0.03, 1.66, -0.02, -PI / 2, C.woodLight)
  addArrowSign(model, 'city-sign-high', 0.03, 1.95, -0.02, PI / 2, C.woodLight)
  model.sphere('city-sign-finial', [0.11, 0.13, 0.11], [0, 2.06, 0], C.brass)
  for (const [x, y, rotation] of [[0.03, 1.37, PI / 2], [-0.03, 1.66, -PI / 2], [0.03, 1.95, PI / 2]]) {
    model.beam('city-sign-support', [0, y - 0.08, 0], [x + Math.cos(rotation) * 0.16, y, -Math.sin(rotation) * 0.16], 0.022, C.woodDark)
    addBolt(model, 'city-sign-bolt', x, y, -0.06, C.iron, 0.035)
  }
  return finish(model, 'sign_post_city')
}

function buildRowboat() {
  const model = new Model('rowboat')
  boatHull(model, 'rowboat-hollow-hull', 3.58, 1.12, 0.68, C.wood)
  model.slab('rowboat-keel', 0.34, 3.18, 0.11, [0, 0.06, 0], C.woodDark)
  model.slab('rowboat-floor', 0.52, 2.62, 0.07, [0, 0.19, 0.05], C.woodDark)
  for (const z of [-0.78, 0.48]) {
    model.slab('rowboat-bench', 0.96, 0.15, 0.10, [0, 0.50, z], C.woodLight)
    model.beam('rowboat-bench-cleat-left', [-0.40, 0.43, z], [-0.40, 0.52, z], 0.025, C.woodDark)
    model.beam('rowboat-bench-cleat-right', [0.40, 0.43, z], [0.40, 0.52, z], 0.025, C.woodDark)
  }
  for (const z of [-1.32, -0.72, 0, 0.72, 1.32]) {
    model.beam('rowboat-rib-left', [-0.20, 0.20, z], [-0.45, 0.50, z], 0.022, C.woodLight)
    model.beam('rowboat-rib-right', [0.20, 0.20, z], [0.45, 0.50, z], 0.022, C.woodLight)
  }
  model.beam('rowboat-oar-left', [-0.58, 0.56, -0.70], [0.62, 0.56, -0.70], 0.028, C.woodLight)
  model.beam('rowboat-oar-right', [-0.62, 0.58, 0.57], [0.58, 0.58, 0.57], 0.028, C.woodLight)
  model.slab('rowboat-oar-blade-left', 0.14, 0.16, 0.045, [0.65, 0.56, -0.70], C.woodLight)
  model.slab('rowboat-oar-blade-right', 0.14, 0.16, 0.045, [-0.65, 0.58, 0.57], C.woodLight)
  model.torus('rowboat-oarlock-left', 0.07, 0.018, [-0.48, 0.54, -0.70], C.iron, [PI / 2, 0, 0])
  model.torus('rowboat-oarlock-right', 0.07, 0.018, [0.48, 0.54, 0.57], C.iron, [PI / 2, 0, 0])
  return finish(model, 'rowboat')
}

function buildPunt() {
  const model = new Model('punt')
  boatHull(model, 'punt-hollow-hull', 3.92, 1.14, 0.54, C.wood)
  model.slab('punt-bottom', 0.72, 3.58, 0.10, [0, 0.06, 0], C.woodDark)
  model.slab('punt-floor', 0.70, 2.98, 0.06, [0, 0.19, 0], C.woodDark)
  for (const z of [-0.78, 0.38, 1.26]) model.slab('punt-bench', 0.98, 0.14, 0.09, [0, 0.39, z], C.woodLight)
  for (const z of [-1.35, -0.45, 0.45, 1.35]) {
    model.beam('punt-rib-left', [-0.22, 0.16, z], [-0.47, 0.40, z], 0.020, C.woodLight)
    model.beam('punt-rib-right', [0.22, 0.16, z], [0.47, 0.40, z], 0.020, C.woodLight)
  }
  model.beam('punt-pole', [0.28, 0.42, 1.38], [0.28, 0.33, -1.84], 0.028, C.woodLight)
  model.slab('punt-pole-grip', 0.10, 0.24, 0.08, [0.28, 0.44, 1.42], C.woodDark)
  model.torus('punt-pole-grip-ring', 0.065, 0.012, [0.28, 0.44, 1.33], C.iron, [PI / 2, 0, 0])
  return finish(model, 'punt')
}

function buildMooringPost() {
  const model = new Model('mooring_post')
  model.slab('mooring-post-base', 0.48, 0.48, 0.10, [0, 0.05, 0], C.woodDark)
  model.cylinder('mooring-post-shaft', 0.12, 0.15, 0.86, [0, 0.43, 0], C.wood, 10)
  model.cylinder('mooring-post-cap', 0.16, 0.14, 0.08, [0, 0.90, 0], C.woodLight, 10)
  for (const y of [0.30, 0.43, 0.56]) model.torus('mooring-rope-coil', 0.17, 0.022, [0, y, 0], C.rope, [PI / 2, 0, 0])
  model.torus('mooring-post-cap-ring', 0.13, 0.018, [0, 0.88, 0], C.iron, [PI / 2, 0, 0])
  addBolt(model, 'mooring-post-bolt', 0, 0.12, -0.22, C.iron, 0.035)
  return finish(model, 'mooring_post')
}

function addFish(model, name, x, z, y, color) {
  model.sphere(`${name}-body`, [0.14, 0.40, 0.12], [x, y, z], color)
  model.slab(`${name}-tail-fin`, 0.16, 0.18, 0.035, [x, y - 0.22, z], color)
  model.beam(`${name}-tail-a`, [x, y - 0.17, z], [x - 0.10, y - 0.27, z], 0.018, color)
  model.beam(`${name}-tail-b`, [x, y - 0.17, z], [x + 0.10, y - 0.27, z], 0.018, color)
  model.sphere(`${name}-head`, [0.15, 0.13, 0.13], [x, y + 0.18, z], C.stoneLight)
  model.sphere(`${name}-eye`, [0.018, 0.018, 0.018], [x, y + 0.23, z - 0.055], C.iron)
  model.beam(`${name}-hanging-rope`, [x, y + 0.22, z], [x, 1.335, z], 0.012, C.rope)
}

function buildFishRack() {
  const model = new Model('fish_rack')
  for (const x of [-1.02, 1.02]) for (const z of [-0.28, 0.28]) {
    model.box('fish-rack-post', [0.10, 1.34, 0.10], [x, 0.67, z], C.wood)
    model.sphere('fish-rack-post-cap', [0.08, 0.08, 0.08], [x, 1.37, z], C.woodLight)
  }
  for (const y of [1.38, 1.05]) {
    for (const z of [-0.28, 0.28]) {
      model.box('fish-rack-crossbar', [2.20, 0.10, 0.10], [0, y, z], C.woodLight)
    }
  }
  model.box('fish-rack-depth-bar-front', [2.20, 0.10, 0.10], [0, 1.38, -0.28], C.woodLight)
  model.box('fish-rack-depth-bar-back', [2.20, 0.10, 0.10], [0, 1.38, 0.28], C.woodLight)
  const fish = [[-0.76, -0.28], [-0.25, 0.28], [0.25, -0.28], [0.76, 0.28]]
  fish.forEach(([x, z], index) => {
    const y = 1.02
    model.beam('fish-rack-hook-stem', [x, 1.37, z], [x, 1.335, z], 0.012, C.iron)
    model.torus('fish-rack-hook', 0.045, 0.012, [x, 1.335, z], C.iron, [PI / 2, 0, 0])
    addFish(model, `fish-rack-fish-${index}`, x, z, y, index % 2 ? C.fish : C.blue)
  })
  return finish(model, 'fish_rack')
}

function buildFishingNets() {
  const model = new Model('fishing_nets')
  for (const x of [-1.18, 1.18]) {
    model.box('fishing-net-stake', [0.10, 1.32, 0.10], [x, 0.66, 0], C.wood)
    model.sphere('fishing-net-stake-cap', [0.14, 0.12, 0.14], [x, 1.33, 0], C.woodLight)
  }
  model.beam('fishing-net-top-rope', [-1.14, 1.22, 0], [1.14, 1.22, 0], 0.018, C.rope)
  model.beam('fishing-net-bottom-rope', [-1.14, 0.18, 0], [1.14, 0.18, 0], 0.018, C.rope)
  for (let index = 0; index < 7; index += 1) {
    const x = -1.05 + index * 0.30
    model.beam('fishing-net-diagonal-a', [x, 0.22, -0.01], [x + 0.27, 1.18, -0.01], 0.012, C.rope)
    model.beam('fishing-net-diagonal-b', [x, 1.18, 0.01], [x + 0.27, 0.22, 0.01], 0.012, C.rope)
    model.sphere('fishing-net-knot', [0.028, 0.028, 0.028], [x, 0.22, 0], C.rope)
  }
  tube(model, 'fishing-net-sag', [[-1.12, 1.20, 0.03], [-0.50, 1.10, 0.03], [0, 1.16, 0.03], [0.56, 1.08, 0.03], [1.12, 1.20, 0.03]], 0.014, C.rope, 16, 6)
  return finish(model, 'fishing_nets')
}

const BUILDERS = Object.freeze({
  globe: buildGlobe,
  scroll_rack: buildScrollRack,
  reading_nook: buildReadingNook,
  candle_desk: buildCandleDesk,
  telescope: buildTelescope,
  fountain: buildFountain,
  statue_plinth: buildStatuePlinth,
  flower_bed: buildFlowerBed,
  pillory: buildPillory,
  town_well: buildTownWell,
  street_planter: buildStreetPlanter,
  sign_post_city: buildSignPostCity,
  rowboat: buildRowboat,
  punt: buildPunt,
  mooring_post: buildMooringPost,
  fish_rack: buildFishRack,
  fishing_nets: buildFishingNets,
})

/** @param {string} id @returns {import('three').Group} */
export function createModel(id) {
  const builder = BUILDERS[id]
  if (!builder) throw new RangeError(`Неизвестная модель города: ${id}`)
  return builder()
}
