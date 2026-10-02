/** Авторские низкополигональные модели города, библиотеки и набережной. */
import { Model } from './map-detail-model-helpers.mjs'

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

function buildGlobe() {
  const model = new Model('globe')
  model.cylinder('globe-foot', 0.29, 0.31, 0.08, [0, 0.04, 0], C.woodDark, 12)
  model.cylinder('globe-column', 0.055, 0.075, 0.38, [0, 0.27, 0], C.wood, 10)
  model.box('globe-crossbar', [0.38, 0.045, 0.07], [0, 0.47, 0], C.woodLight)
  model.sphere('globe-sphere', [0.42, 0.42, 0.42], [0, 0.70, 0], C.blue)
  model.torus('globe-meridian', 0.235, 0.018, [0, 0.70, 0], C.brass)
  model.torus('globe-equator', 0.215, 0.012, [0, 0.70, 0], C.brass, [PI / 2, 0, 0])
  model.box('globe-axis', [0.035, 0.46, 0.035], [0, 0.70, 0], C.brass, [0, 0, 0.12])
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
  }
  return finish(model, 'scroll_rack')
}

function buildReadingNook() {
  const model = new Model('reading_nook')
  const chairX = -0.42
  model.box('reading-chair-seat', [0.92, 0.18, 0.72], [chairX, 0.56, 0.05], C.green)
  model.box('reading-chair-back', [0.92, 0.58, 0.15], [chairX, 0.91, 0.34], C.greenDark)
  model.box('reading-chair-left-arm', [0.14, 0.38, 0.76], [chairX - 0.40, 0.72, 0.03], C.wood)
  model.box('reading-chair-right-arm', [0.14, 0.38, 0.76], [chairX + 0.40, 0.72, 0.03], C.wood)
  for (const x of [chairX - 0.34, chairX + 0.34]) for (const z of [-0.22, 0.29]) {
    model.beam('reading-chair-leg', [x, 0.10, z], [x, 0.48, z], 0.035, C.woodDark)
  }
  model.table('reading-side-table', 0.48, 0.46, 0.58, C.wood)
  // Сдвиг стола и его содержимого к свободной стороне кресла.
  const table = model.root.children.at(-1)
  if (table) table.position.x = 0.70
  addBook(model, 'reading-book-bottom', 0.70, 0.64, 0, 0.34, 0.26, 0.07, C.red, -0.08)
  addBook(model, 'reading-book-top', 0.68, 0.72, 0, 0.30, 0.23, 0.06, C.blue, 0.06)
  model.cylinder('reading-candle', 0.035, 0.04, 0.16, [0.78, 0.84, 0], C.brass, 10)
  model.sphere('reading-flame', [0.06, 0.10, 0.06], [0.78, 0.96, 0], C.yellow)
  return finish(model, 'reading_nook')
}

function buildCandleDesk() {
  const model = new Model('candle_desk')
  model.table('candle-desk', 1.72, 0.70, 0.68, C.wood)
  const desk = model.root.children.at(-1)
  if (desk) desk.position.x = -0.20
  addBook(model, 'candle-desk-book-a', -0.20, 0.75, -0.08, 0.42, 0.27, 0.07, C.red, -0.08)
  addBook(model, 'candle-desk-book-b', -0.17, 0.83, -0.08, 0.38, 0.25, 0.07, C.blue, 0.05)
  addBook(model, 'candle-desk-book-c', 0.28, 0.75, 0.08, 0.30, 0.22, 0.06, C.green, 0.08)
  model.cylinder('candle-desk-candlestick', 0.045, 0.065, 0.14, [0.54, 0.75, -0.03], C.brass, 10)
  model.cylinder('candle-desk-candle', 0.025, 0.03, 0.12, [0.54, 0.88, -0.03], C.paper, 10)
  model.sphere('candle-desk-flame', [0.05, 0.04, 0.05], [0.54, 0.96, -0.03], C.yellow)
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
  model.cylinder('telescope-eyepiece', 0.055, 0.055, 0.12, [0, 1.18, 0.31], C.iron, 10)
  model.beam('telescope-mount', [0, 0.72, 0.10], [0, 1.12, 0.10], 0.04, C.woodDark)
  return finish(model, 'telescope')
}

function buildFountain() {
  const model = new Model('fountain')
  model.cylinder('fountain-basin', 2.04, 2.10, 0.22, [0, 0.11, 0], C.stone, 18)
  model.torus('fountain-rim', 1.91, 0.11, [0, 0.24, 0], C.stoneLight, [PI / 2, 0, 0])
  model.cylinder('fountain-water', 1.80, 1.80, 0.045, [0, 0.25, 0], C.water, 18)
  model.cylinder('fountain-pedestal', 0.31, 0.42, 0.78, [0, 0.65, 0], C.stoneDark, 12)
  model.cylinder('fountain-bowl', 0.55, 0.62, 0.16, [0, 1.11, 0], C.stoneLight, 14)
  model.cylinder('fountain-bowl-water', 0.43, 0.43, 0.035, [0, 1.20, 0], C.water, 14)
  model.sphere('fountain-cap', [0.13, 0.18, 0.13], [0, 1.33, 0], C.stone)
  for (const end of [[0.72, 0.31, 0], [-0.72, 0.31, 0], [0, 0.31, 0.72], [0, 0.31, -0.72]]) {
    model.beam('fountain-spill', [0, 1.16, 0], end, 0.025, C.water)
  }
  return finish(model, 'fountain')
}

function buildStatuePlinth() {
  const model = new Model('statue_plinth')
  model.slab('statue-plinth-foot', 2.18, 2.18, 0.24, [0, 0.12, 0], C.stoneDark)
  model.slab('statue-plinth-upper', 1.74, 1.74, 0.28, [0, 0.38, 0], C.stoneLight)
  model.box('warrior-hips', [0.55, 0.32, 0.38], [0, 0.70, 0], C.iron)
  model.box('warrior-torso', [0.65, 0.72, 0.42], [0, 1.16, 0], C.iron)
  model.box('warrior-chest-plate', [0.50, 0.48, 0.045], [0, 1.19, -0.235], C.brass)
  for (const x of [-0.27, 0.27]) model.beam('warrior-leg', [x, 0.48, 0], [x * 0.82, 0.91, 0], 0.09, C.iron)
  model.box('warrior-shoulders', [0.98, 0.22, 0.46], [0, 1.54, 0], C.iron)
  model.sphere('warrior-pauldron-left', [0.27, 0.22, 0.27], [-0.49, 1.52, 0], C.brass)
  model.sphere('warrior-pauldron-right', [0.27, 0.22, 0.27], [0.49, 1.52, 0], C.brass)
  for (const x of [-0.50, 0.50]) model.beam('warrior-arm', [x, 1.48, 0], [x * 0.88, 1.10, -0.03], 0.065, C.iron)
  model.sphere('warrior-head', [0.38, 0.40, 0.36], [0, 1.90, 0], C.stone)
  model.cylinder('warrior-helmet', 0.24, 0.26, 0.12, [0, 2.12, 0], C.brass, 12)
  model.box('warrior-helmet-nose', [0.07, 0.18, 0.08], [0, 1.96, -0.20], C.brass)
  model.box('warrior-shield', [0.24, 0.54, 0.08], [-0.62, 1.05, -0.12], C.wood, [0.10, 0, 0])
  model.beam('warrior-sword', [0.64, 0.68, 0.10], [0.64, 1.62, 0.10], 0.025, C.iron)
  model.box('warrior-sword-hilt', [0.26, 0.035, 0.05], [0.64, 0.98, 0.10], C.brass)
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
  model.box('pillory-stock-hinge', [0.07, 0.33, 0.25], [-0.28, 1.34, 0], C.iron)
  model.box('pillory-stock-hinge', [0.07, 0.33, 0.25], [0.28, 1.34, 0], C.iron)
  return finish(model, 'pillory')
}

function buildTownWell() {
  const model = new Model('town_well')
  model.cylinder('town-well-wall', 1.08, 1.15, 0.60, [0, 0.30, 0], C.stone, 14)
  model.torus('town-well-rim', 1.03, 0.12, [0, 0.65, 0], C.stoneLight, [PI / 2, 0, 0])
  model.cylinder('town-well-water', 0.88, 0.88, 0.035, [0, 0.69, 0], C.water, 14)
  for (const [x, z] of [[-0.88, -0.78], [0.88, -0.78], [-0.88, 0.78], [0.88, 0.78]]) {
    model.box('town-well-post', [0.14, 1.65, 0.14], [x, 1.48, z], C.wood)
  }
  model.box('town-well-front-beam', [2.02, 0.14, 0.14], [0, 2.23, -0.78], C.woodDark)
  model.box('town-well-back-beam', [2.02, 0.14, 0.14], [0, 2.23, 0.78], C.woodDark)
  model.box('town-well-roof-left', [2.20, 0.12, 1.02], [0, 2.30, -0.48], C.red, [0.43, 0, 0])
  model.box('town-well-roof-right', [2.20, 0.12, 1.02], [0, 2.30, 0.48], C.red, [-0.43, 0, 0])
  model.box('town-well-ridge', [2.25, 0.12, 0.14], [0, 2.50, 0], C.woodDark)
  model.cylinder('town-well-spindle', 0.06, 0.06, 1.70, [0, 1.84, 0], C.woodDark, 10, [0, 0, PI / 2])
  model.beam('town-well-rope', [0, 1.83, 0], [0, 0.83, 0], 0.018, C.rope)
  model.barrel('town-well-bucket', 0.18, 0.24, [0, 0.77, -0.02], C.woodLight)
  return finish(model, 'town_well')
}

function buildStreetPlanter() {
  const model = new Model('street_planter')
  model.barrel('street-planter-tub', 0.36, 0.34, [0, 0, 0], C.wood)
  model.cylinder('street-planter-soil', 0.28, 0.28, 0.04, [0, 0.36, 0], C.woodDark, 12)
  model.cylinder('street-planter-trunk', 0.075, 0.09, 0.72, [0, 0.78, 0], C.woodDark, 8)
  model.beam('street-planter-branch-left', [0, 1.06, 0], [-0.20, 1.22, 0], 0.035, C.wood)
  model.beam('street-planter-branch-right', [0, 1.08, 0], [0.18, 1.29, -0.03], 0.035, C.wood)
  model.sphere('street-planter-crown', [0.58, 0.48, 0.58], [0, 1.30, 0], C.green)
  return finish(model, 'street_planter')
}

function addArrowSign(model, name, x, y, z, rotation, color) {
  model.box(`${name}-board`, [0.48, 0.16, 0.065], [x, y, z], color, [0, rotation, 0])
  model.box(`${name}-tip`, [0.13, 0.16, 0.065], [x + Math.cos(rotation) * 0.29, y, z - Math.sin(rotation) * 0.29], color, [0, rotation + PI / 4, 0])
}

function buildSignPostCity() {
  const model = new Model('sign_post_city')
  model.box('city-sign-post', [0.10, 2.02, 0.10], [0, 1.01, 0], C.wood)
  model.box('city-sign-foot', [0.32, 0.08, 0.28], [0, 0.04, 0], C.woodDark)
  addArrowSign(model, 'city-sign-low', 0.03, 1.37, -0.02, PI / 2, C.woodLight)
  addArrowSign(model, 'city-sign-mid', -0.03, 1.66, -0.02, -PI / 2, C.woodLight)
  addArrowSign(model, 'city-sign-high', 0.03, 1.95, -0.02, PI / 2, C.woodLight)
  return finish(model, 'sign_post_city')
}

function buildRowboat() {
  const model = new Model('rowboat')
  model.slab('rowboat-keel', 0.86, 3.35, 0.12, [0, 0.08, 0], C.woodDark)
  model.box('rowboat-left-side', [0.13, 0.42, 3.55], [-0.55, 0.28, 0], C.wood)
  model.box('rowboat-right-side', [0.13, 0.42, 3.55], [0.55, 0.28, 0], C.wood)
  model.beam('rowboat-bow', [-0.55, 0.28, -1.78], [0.55, 0.28, -1.78], 0.07, C.woodLight)
  model.beam('rowboat-stern', [-0.55, 0.28, 1.78], [0.55, 0.28, 1.78], 0.07, C.woodLight)
  for (const z of [-0.72, 0.58]) model.box('rowboat-bench', [0.94, 0.10, 0.14], [0, 0.47, z], C.woodLight)
  model.beam('rowboat-oar-left', [-0.60, 0.56, -0.70], [0.58, 0.56, -0.70], 0.028, C.woodLight)
  model.beam('rowboat-oar-right', [-0.58, 0.58, 0.57], [0.60, 0.58, 0.57], 0.028, C.woodLight)
  model.box('rowboat-oar-blade-left', [0.12, 0.05, 0.12], [0.64, 0.56, -0.70], C.woodLight)
  model.box('rowboat-oar-blade-right', [0.12, 0.05, 0.12], [-0.64, 0.58, 0.57], C.woodLight)
  return finish(model, 'rowboat')
}

function buildPunt() {
  const model = new Model('punt')
  model.slab('punt-bottom', 1.02, 3.72, 0.12, [0, 0.06, 0], C.woodDark)
  model.box('punt-left-side', [0.12, 0.30, 3.88], [-0.55, 0.21, 0], C.wood)
  model.box('punt-right-side', [0.12, 0.30, 3.88], [0.55, 0.21, 0], C.wood)
  model.box('punt-bow', [1.18, 0.30, 0.12], [0, 0.21, -1.95], C.woodLight)
  model.box('punt-stern', [1.18, 0.30, 0.12], [0, 0.21, 1.95], C.woodLight)
  model.box('punt-bench', [0.90, 0.10, 0.14], [0, 0.39, -0.36], C.woodLight)
  model.beam('punt-pole', [0.28, 0.42, 1.38], [0.28, 0.33, -1.84], 0.028, C.woodLight)
  model.box('punt-pole-grip', [0.10, 0.08, 0.24], [0.28, 0.44, 1.42], C.woodDark, [0.02, 0, 0])
  return finish(model, 'punt')
}

function buildMooringPost() {
  const model = new Model('mooring_post')
  model.cylinder('mooring-post-shaft', 0.12, 0.15, 0.86, [0, 0.43, 0], C.wood, 10)
  model.cylinder('mooring-post-cap', 0.16, 0.14, 0.08, [0, 0.90, 0], C.woodLight, 10)
  for (const y of [0.30, 0.43, 0.56]) model.torus('mooring-rope-coil', 0.17, 0.022, [0, y, 0], C.rope, [PI / 2, 0, 0])
  return finish(model, 'mooring_post')
}

function addFish(model, name, x, z, y, color) {
  model.sphere(`${name}-body`, [0.14, 0.40, 0.12], [x, y, z], color)
  model.beam(`${name}-tail-a`, [x, y - 0.17, z], [x - 0.10, y - 0.27, z], 0.018, color)
  model.beam(`${name}-tail-b`, [x, y - 0.17, z], [x + 0.10, y - 0.27, z], 0.018, color)
  model.sphere(`${name}-head`, [0.15, 0.13, 0.13], [x, y + 0.18, z], C.stoneLight)
}

function buildFishRack() {
  const model = new Model('fish_rack')
  for (const x of [-1.02, 1.02]) for (const z of [-0.28, 0.28]) {
    model.box('fish-rack-post', [0.10, 1.34, 0.10], [x, 0.67, z], C.wood)
  }
  for (const y of [1.38, 1.05]) model.box('fish-rack-crossbar', [2.20, 0.10, 0.10], [0, y, 0], C.woodLight)
  model.box('fish-rack-depth-bar-front', [2.20, 0.10, 0.10], [0, 1.38, -0.28], C.woodLight)
  model.box('fish-rack-depth-bar-back', [2.20, 0.10, 0.10], [0, 1.38, 0.28], C.woodLight)
  ;[-0.76, -0.25, 0.25, 0.76].forEach((x, index) => addFish(model, `fish-rack-fish-${index}`, x, index % 2 ? 0.17 : -0.17, 1.02 - (index % 2) * 0.08, index % 2 ? C.fish : C.blue))
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
  }
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
