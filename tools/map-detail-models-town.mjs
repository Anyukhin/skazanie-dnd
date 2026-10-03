/** Авторские низкополигональные модели города, библиотеки и набережной. */
import { Model, THREE, random } from './map-detail-model-helpers.mjs'

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
function boatHull(model, name, length, width, height, color = C.wood, { flatBottom = 0.6, sheer = 0.16 } = {}) {
  // Семнадцать шпангоутов по плавной кривой: борт сходится к штевням,
  // планширь поднимается к носу и корме. flatBottom — доля ширины днища.
  const stations = Array.from({ length: 17 }, (_, index) => index / 16 - 0.5)
  const half = fraction => Math.max(0.02, width / 2 * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(fraction * 2), 2.4)), 0.55))
  const position = []
  const addQuad = (a, b, c, d) => {
    position.push(...a, ...b, ...c, ...a, ...c, ...d)
  }
  const side = sign => stations.map((fraction) => {
    const z = fraction * length, rim = half(fraction), bottom = rim * flatBottom
    const rimY = height * (0.72 + sheer * Math.pow(fraction * 2, 2))
    const outerBottom = [sign * bottom, 0, z]
    const outerRim = [sign * rim, rimY, z]
    const innerRim = [sign * Math.max(0.012, rim - width * 0.045), rimY - height * 0.05, z]
    const innerFloor = [sign * Math.max(0.01, bottom * 0.9), height * 0.14, z]
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
  // Привальный брус по планширю обоих бортов.
  for (const a of [left, right]) {
    model.taperTube(`${name}-gunwale`, a.map(station => station.outerRim), 0.03, 0.03, C.woodLight, 48, 8)
  }
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
  // Ступенчатый постамент с карнизом и бронзовой табличкой; статуя — из одного
  // камня: воин опирается руками на меч, остриём упёртый в постамент.
  const statue = '#9b968a', statueShade = '#878276'
  model.slab('statue-plinth-foot', 2.4, 2.4, 0.24, [0, 0.12, 0], C.stoneDark)
  model.slab('statue-plinth-step', 2.1, 2.1, 0.14, [0, 0.31, 0], C.stone)
  model.slab('statue-plinth-block', 1.76, 1.76, 0.86, [0, 0.81, 0], C.stoneLight)
  model.slab('statue-plinth-cornice', 1.98, 1.98, 0.12, [0, 1.30, 0], C.stone)
  model.slab('statue-plinth-top', 1.4, 1.4, 0.08, [0, 1.40, 0], C.stoneLight)
  model.box('statue-plinth-plaque-bronze', [0.8, 0.34, 0.03], [0, 0.84, -0.885], C.brass)
  for (const y of [0.92, 0.84, 0.76]) model.box('statue-plinth-plaque-line', [0.6, 0.02, 0.012], [0, y, -0.905], C.woodDark)
  model.lumpy('statue-plinth-moss', new THREE.SphereGeometry(0.5, 16, 6, 0, PI * 2, 0, PI / 2), [0.7, 0.24, -0.9], C.green, { size: [0.5, 0.12, 0.2], amount: 0.02, frequency: 9, seed: 81 })
  const y0 = 1.44
  for (const side of [-1, 1]) {
    model.taperTube('warrior-leg', [[side * 0.14, y0 + 0.78, 0.02], [side * 0.16, y0 + 0.42, 0], [side * 0.17, y0 + 0.12, 0.01]], 0.105, 0.075, statue, 12, 16)
    model.lumpy('warrior-boot', new THREE.BoxGeometry(1, 1, 1, 3, 2, 3), [side * 0.17, y0 + 0.06, -0.04], statueShade, { size: [0.17, 0.13, 0.3], amount: 0.01, frequency: 8, seed: 82 + side })
  }
  const skirt = model.mesh('warrior-tunic', new THREE.LatheGeometry([[0.30, y0 + 0.62], [0.27, y0 + 0.80], [0.25, y0 + 0.98]].map(([r, y]) => new THREE.Vector2(r, y)), 28), [0, 0, 0], statue)
  skirt.scale.set(1, 1, 0.75)
  const torso = model.mesh('warrior-torso', new THREE.LatheGeometry([[0.25, y0 + 0.96], [0.27, y0 + 1.18], [0.31, y0 + 1.38], [0.24, y0 + 1.48], [0.09, y0 + 1.52]].map(([r, y]) => new THREE.Vector2(r, y)), 28), [0, 0, 0], statue)
  torso.scale.set(1, 1, 0.66)
  model.torus('warrior-belt', 0.255, 0.03, [0, y0 + 0.98, 0], statueShade, [PI / 2, 0, 0]).scale.set(1, 0.75, 1)
  const cape = model.mesh('warrior-cape', new THREE.CylinderGeometry(0.33, 0.42, 1.36, 24, 1, true, -PI / 2, PI), [0, y0 + 0.82, 0.05], statueShade)
  cape.scale.set(1, 1, 0.55)
  for (const side of [-1, 1]) {
    model.sphere('warrior-pauldron', [0.24, 0.17, 0.22], [side * 0.3, y0 + 1.42, 0], statueShade)
    model.taperTube('warrior-arm', [[side * 0.32, y0 + 1.36, 0], [side * 0.29, y0 + 1.1, -0.17], [side * 0.07, y0 + 0.98, -0.33]], 0.075, 0.06, statue, 12, 14)
    model.lumpy('warrior-hand', new THREE.SphereGeometry(0.5, 12, 10), [side * 0.05, y0 + 0.98, -0.35], statue, { size: [0.1, 0.09, 0.1], amount: 0.005, frequency: 15, seed: 85 + side })
  }
  model.box('warrior-sword-blade', [0.075, 0.74, 0.02], [0, y0 + 0.37, -0.36], statueShade)
  model.box('warrior-sword-guard', [0.32, 0.045, 0.06], [0, y0 + 0.76, -0.36], statue)
  model.cylinder('warrior-sword-grip', 0.025, 0.025, 0.17, [0, y0 + 0.86, -0.36], statueShade, 24)
  model.sphere('warrior-sword-pommel', [0.07, 0.07, 0.07], [0, y0 + 0.96, -0.36], statue)
  model.cylinder('warrior-shield', 0.3, 0.3, 0.06, [-0.46, y0 + 0.34, -0.05], statueShade, 32, [0, 0, PI / 2 - 0.22])
  model.sphere('warrior-shield-boss', [0.1, 0.1, 0.1], [-0.50, y0 + 0.35, -0.05], statue)
  model.cylinder('warrior-neck', 0.08, 0.09, 0.1, [0, y0 + 1.56, 0], statue, 24)
  model.lumpy('warrior-head', new THREE.SphereGeometry(0.5, 20, 16), [0, y0 + 1.70, -0.01], statue, { size: [0.25, 0.29, 0.27], amount: 0.006, frequency: 10, seed: 88 })
  model.mesh('warrior-helmet', new THREE.LatheGeometry([[0.15, y0 + 1.70], [0.15, y0 + 1.78], [0.12, y0 + 1.86], [0.06, y0 + 1.90], [0, y0 + 1.91]].map(([r, y]) => new THREE.Vector2(r, y)), 28), [0, 0, 0], statueShade)
  model.torus('warrior-helmet-rim', 0.15, 0.02, [0, y0 + 1.71, 0], statueShade, [PI / 2, 0, 0])
  model.box('warrior-helmet-nasal', [0.035, 0.12, 0.03], [0, y0 + 1.66, -0.15], statueShade)
  return finish(model, 'statue_plinth')
}

function buildFlowerBed() {
  const model = new Model('flower_bed')
  // Стенки из отдельных тёсаных камней, сверху — кусты и цветы с лепестками.
  const next = random(51)
  for (const z of [-0.50, 0.50]) for (let index = 0; index < 6; index += 1) {
    model.lumpy('flower-bed-stone', new THREE.BoxGeometry(1, 1, 1, 3, 2, 2), [-1.08 + index * 0.432, 0.17, z], index % 2 ? C.stone : C.stoneLight,
      { size: [0.42, 0.34, 0.16], amount: 0.012, frequency: 7, seed: 52 + index + (z > 0 ? 10 : 0) })
  }
  for (const x of [-1.28, 1.28]) for (const z of [-0.2, 0.2]) {
    model.lumpy('flower-bed-stone', new THREE.BoxGeometry(1, 1, 1, 2, 2, 3), [x, 0.17, z], C.stoneLight, { size: [0.16, 0.34, 0.42], amount: 0.012, frequency: 7, seed: 70 + (x > 0 ? 2 : 0) + (z > 0 ? 1 : 0) })
  }
  model.lumpy('flower-bed-soil', new THREE.BoxGeometry(1, 1, 1, 12, 2, 4), [0, 0.28, 0], C.woodDark, { size: [2.4, 0.1, 0.86], amount: 0.015, frequency: 6, seed: 59 })
  for (const [x, z, s, seed] of [[-0.85, 0.1, 0.42, 61], [0.05, -0.1, 0.5, 62], [0.82, 0.12, 0.44, 63]]) {
    model.lumpy('flower-bed-bush', new THREE.SphereGeometry(0.5, 18, 10, 0, PI * 2, 0, PI * 0.6), [x, 0.3, z], C.green, { size: [s, s * 0.55, s * 0.8], amount: 0.03, frequency: 8, seed })
  }
  const colors = [C.red, C.yellow, C.purple, C.paper]
  for (let index = 0; index < 18; index += 1) {
    const x = -1.05 + (index / 17) * 2.1 + (next() - 0.5) * 0.12, z = (next() - 0.5) * 0.6
    const y = 0.40 + next() * 0.14, color = colors[index % colors.length]
    model.beam('flower-bed-stem', [x, 0.3, z], [x, y, z], 0.01, C.greenDark)
    for (let petal = 0; petal < 5; petal += 1) {
      const angle = petal / 5 * PI * 2 + index
      model.mesh('flower-bed-petal', new THREE.SphereGeometry(0.5, 10, 6), [x + Math.cos(angle) * 0.03, y, z + Math.sin(angle) * 0.03], color, [0, -angle, 0]).scale.set(0.06, 0.018, 0.04)
    }
    model.sphere('flower-bed-flower-heart', [0.03, 0.025, 0.03], [x, y + 0.008, z], C.yellow)
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
  boatHull(model, 'rowboat-hollow-hull', 3.7, 1.18, 0.66, C.wood, { flatBottom: 0.45, sheer: 0.22 })
  model.taperTube('rowboat-keel', [[0, 0.02, -1.7], [0, 0, 0], [0, 0.02, 1.7]], 0.035, 0.035, C.woodDark, 24, 8)
  for (const z of [-1.86, 1.86]) model.box('rowboat-stem-post', [0.07, 0.62, 0.07], [0, 0.34, z], C.woodDark)
  for (const z of [-0.9, 0.0, 0.85]) model.box('rowboat-thwart', [z ? 0.94 : 1.06, 0.06, 0.2], [0, 0.42, z], C.woodLight)
  for (let index = -6; index <= 6; index += 1) {
    const z = index * 0.24, half = 0.5 * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(z / 1.85), 2.4)), 0.55)
    if (half < 0.15) continue
    for (const side of [-1, 1]) model.beam('rowboat-rib', [side * half * 0.4, 0.11, z], [side * (half - 0.03), 0.47, z], 0.016, C.woodLight)
  }
  for (const side of [-1, 1]) {
    model.torus('rowboat-oarlock', 0.045, 0.012, [side * 0.55, 0.53, -0.25], C.iron, [0, PI / 2, 0])
    model.beam('rowboat-oar', [side * 0.5, 0.55, -0.25], [side * -0.2, 0.62, 1.25], 0.022, C.woodLight)
    model.box('rowboat-oar-blade', [0.12, 0.02, 0.36], [side * -0.24, 0.625, 1.42], C.woodLight, [0, side * 0.43, 0])
  }
  model.box('rowboat-bucket-seat', [0.2, 0.16, 0.2], [0.18, 0.18, -1.3], C.woodDark)
  return finish(model, 'rowboat')
}

function buildPunt() {
  const model = new Model('punt')
  // Плоскодонка: широкое днище, низкие борта, срезанные транцы и шест.
  boatHull(model, 'punt-hollow-hull', 4.0, 1.18, 0.5, C.wood, { flatBottom: 0.9, sheer: 0.08 })
  for (const z of [-1.05, 0.2, 1.3]) model.box('punt-bench', [0.98, 0.05, 0.18], [0, 0.31, z], C.woodLight)
  for (let index = -7; index <= 7; index += 1) model.box('punt-floor-board', [0.7, 0.02, 0.24], [0, 0.085, index * 0.25], index % 2 ? C.woodDark : C.wood)
  model.beam('punt-pole', [0.38, 0.38, 1.7], [-0.1, 0.42, -1.9], 0.025, C.woodLight)
  model.sphere('punt-pole-knob', [0.06, 0.06, 0.06], [0.38, 0.38, 1.72], C.woodDark)
  const coil = []
  for (let step = 0; step <= 30; step += 1) {
    const angle = step / 10 * PI * 2, radius = 0.05 + step * 0.004
    coil.push([-0.15 + Math.cos(angle) * radius, 0.11, 1.55 + Math.sin(angle) * radius])
  }
  model.taperTube('punt-rope-coil', coil, 0.02, 0.018, C.rope, 90, 8)
  return finish(model, 'punt')
}

function buildMooringPost() {
  const model = new Model('mooring_post')
  // Тумба на дощатом пятачке: канат обмотан вокруг неё и свёрнут бухтой у основания.
  for (const x of [-0.18, 0, 0.18]) model.box('mooring-post-deck-plank', [0.17, 0.05, 0.58], [x, 0.025, 0], x ? C.wood : C.woodLight)
  model.mesh('mooring-post-shaft', new THREE.LatheGeometry([[0.14, 0.05], [0.13, 0.3], [0.115, 0.62], [0.12, 0.76], [0.17, 0.82], [0.17, 0.88], [0.0, 0.9]].map(([r, y]) => new THREE.Vector2(r, y)), 28), [0, 0, 0], C.wood)
  for (const y of [0.12, 0.70]) model.torus('mooring-post-band', 0.135 - (y > 0.5 ? 0.017 : 0), 0.014, [0, y, 0], C.iron, [PI / 2, 0, 0])
  const turns = []
  for (let step = 0; step <= 36; step += 1) {
    const angle = step / 12 * PI * 2
    turns.push([Math.cos(angle) * 0.145, 0.36 + step * 0.0075, Math.sin(angle) * 0.145])
  }
  model.taperTube('mooring-rope-wrap', turns, 0.022, 0.022, C.rope, 120, 8)
  const coil = []
  for (let step = 0; step <= 60; step += 1) {
    const angle = step / 15 * PI * 2, radius = 0.06 + step * 0.0028
    coil.push([0.12 + Math.cos(angle) * radius, 0.07, 0.12 + Math.sin(angle) * radius])
  }
  model.taperTube('mooring-rope-coil', [[0.08, 0.36, 0.12], [0.16, 0.18, 0.18], ...coil.reverse()], 0.02, 0.018, C.rope, 180, 8)
  return finish(model, 'mooring_post')
}

function addFish(model, name, x, z, y, color) {
  // Вяленая рыба висит головой вниз: сплюснутое с боков тело, хвост с двумя лопастями.
  const length = 0.34
  model.mesh(`${name}-body`, new THREE.SphereGeometry(0.5, 16, 12), [x, y, z], color).scale.set(0.06, length, 0.14)
  model.mesh(`${name}-belly`, new THREE.SphereGeometry(0.5, 12, 8), [x, y - 0.03, z - 0.02], C.stoneLight).scale.set(0.05, length * 0.7, 0.1)
  for (const side of [-1, 1]) {
    model.mesh(`${name}-tail-fin`, new THREE.ConeGeometry(0.05, 0.12, 3), [x, y + length / 2 + 0.04, z + side * 0.035], color, [side * 0.5, 0, 0]).scale.set(0.3, 1, 1)
  }
  model.mesh(`${name}-dorsal-fin`, new THREE.ConeGeometry(0.04, 0.12, 3), [x, y + 0.02, z + 0.07], color, [PI / 2 - 0.3, 0, 0]).scale.set(0.3, 1, 1)
  for (const side of [-1, 1]) model.sphere(`${name}-eye`, [0.02, 0.02, 0.02], [x + side * 0.028, y - length / 2 + 0.06, z - 0.03], C.iron)
  model.beam(`${name}-hanging-twine`, [x, y + length / 2 + 0.08, z], [x, 1.335, z], 0.008, C.rope)
}

function buildFishRack() {
  const model = new Model('fish_rack')
  // Две А-образные стойки с жердью наверху; рыба висит на обеих жердях.
  for (const x of [-1.04, 1.04]) {
    for (const z of [-0.32, 0.32]) model.beam('fish-rack-leg', [x, 0, z], [x, 1.42, z * 0.12], 0.045, C.wood)
    model.beam('fish-rack-leg-tie', [x, 0.45, -0.24], [x, 0.45, 0.24], 0.03, C.woodDark)
  }
  for (const z of [-0.05, 0.05]) model.beam('fish-rack-pole', [-1.25, 1.38, z * 2], [1.25, 1.38, z * 2], 0.04, C.woodLight)
  for (const x of [-1.04, 1.04]) model.torus('fish-rack-lashing', 0.07, 0.014, [x, 1.38, 0], C.rope, [0, PI / 2, 0])
  const colors = [C.fish, C.blue, C.fish, C.stone]
  for (let index = 0; index < 8; index += 1) {
    const x = -0.82 + index * 0.235, z = index % 2 ? 0.1 : -0.1
    addFish(model, `fish-rack-fish-${index}`, x, z, 1.05 - (index % 3) * 0.04, colors[index % colors.length])
  }
  model.lumpy('fish-rack-basket', new THREE.CylinderGeometry(0.22, 0.18, 0.26, 20, 3), [0.65, 0.13, 0.45], C.straw, { amount: 0.01, frequency: 12, seed: 121 })
  return finish(model, 'fish_rack')
}

function buildFishingNets() {
  const model = new Model('fishing_nets')
  // Сеть растянута между кольями и провисает; ячея — ромбы из бечёвки,
  // по верхней верёвке поплавки, у правого кола — сложенная куча сети.
  for (const x of [-1.2, 1.2]) {
    model.beam('fishing-net-stake', [x, 0, 0], [x * 1.02, 1.36, 0], 0.05, C.wood)
    model.sphere('fishing-net-stake-cap', [0.11, 0.08, 0.11], [x * 1.02, 1.37, 0], C.woodLight)
  }
  const sag = (x, y) => (1 - (x / 1.16) ** 2) * (0.08 + (1.24 - y) * 0.12)
  const strand = (from, to) => {
    const points = []
    for (let step = 0; step <= 10; step += 1) {
      const t = step / 10, x = from[0] + (to[0] - from[0]) * t, y = from[1] + (to[1] - from[1]) * t
      points.push([x, y - sag(x, y) * 0.6, sag(x, y)])
    }
    return points
  }
  model.taperTube('fishing-net-top-rope', strand([-1.16, 1.24], [1.16, 1.24]), 0.016, 0.016, C.rope, 20, 6)
  model.taperTube('fishing-net-bottom-rope', strand([-1.16, 0.2], [1.16, 0.2]), 0.014, 0.014, C.rope, 20, 6)
  for (let index = -9; index <= 9; index += 1) {
    const x0 = index * 0.13
    model.taperTube('fishing-net-mesh', strand([x0 - 0.5, 1.24], [x0 + 0.5, 0.2]).filter(([x]) => Math.abs(x) <= 1.16), 0.006, 0.006, C.rope, 14, 4)
    model.taperTube('fishing-net-mesh', strand([x0 + 0.5, 1.24], [x0 - 0.5, 0.2]).filter(([x]) => Math.abs(x) <= 1.16), 0.006, 0.006, C.rope, 14, 4)
  }
  for (let index = 0; index < 7; index += 1) {
    const x = -0.9 + index * 0.3, y = 1.24 - sag(x, 1.24) * 0.6
    model.mesh('fishing-net-float', new THREE.SphereGeometry(0.5, 12, 8), [x, y, sag(x, 1.24)], C.yellow).scale.set(0.1, 0.07, 0.07)
  }
  model.lumpy('fishing-net-heap', new THREE.SphereGeometry(0.5, 20, 8, 0, PI * 2, 0, PI / 2), [0.85, 0, 0.12], C.rope, { size: [0.6, 0.3, 0.32], amount: 0.03, frequency: 11, seed: 131 })
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
