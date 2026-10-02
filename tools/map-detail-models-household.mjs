#!/usr/bin/env node
/** Авторские низкополигональные модели для бытовых предметов листов 30–31. */
import { Model, THREE } from './map-detail-model-helpers.mjs'

const C = Object.freeze({
  wood: '#684b35',
  woodLight: '#9a7048',
  woodDark: '#3b2c24',
  stone: '#7c786e',
  stoneLight: '#a59d88',
  stoneDark: '#4d4b46',
  brick: '#704d3e',
  iron: '#3f4240',
  brass: '#a77b3d',
  copper: '#a85f3e',
  red: '#733f45',
  green: '#4e6b55',
  blue: '#526b78',
  cloth: '#76606b',
  cream: '#c6b78e',
  paper: '#d8cba8',
  water: '#55777a',
  dark: '#292928',
  straw: '#ad8d4f',
})

const v = (x, y, z) => [x, y, z]

function buildFoldingScreen() {
  const m = new Model('folding_screen')
  const panels = [
    [-0.88, -0.28],
    [0, 0.28],
    [0.88, -0.28],
  ]
  for (const [x, yaw] of panels) {
    m.box('panel', [0.84, 1.8, 0.07], v(x, 0.9, 0), C.wood, [0, yaw, 0])
    m.box('painted-inset', [0.66, 1.48, 0.025], v(x, 0.9, -0.046), C.cloth, [0, yaw, 0])
    m.box('top-rail', [0.9, 0.08, 0.1], v(x, 1.76, 0), C.woodLight, [0, yaw, 0])
    m.box('bottom-rail', [0.9, 0.08, 0.1], v(x, 0.04, 0), C.woodDark, [0, yaw, 0])
    m.box('upright', [0.07, 1.7, 0.1], v(x - 0.38, 0.9, 0), C.woodLight, [0, yaw, 0])
    m.box('upright', [0.07, 1.7, 0.1], v(x + 0.38, 0.9, 0), C.woodLight, [0, yaw, 0])
  }
  m.cylinder('hinge', 0.035, 0.035, 1.55, v(-0.44, 0.9, -0.08), C.brass, 8)
  m.cylinder('hinge', 0.035, 0.035, 1.55, v(0.44, 0.9, -0.08), C.brass, 8)
  return m
}

function buildBathtub() {
  const m = new Model('bathtub')
  // Деревянная ванна собрана из торцов, клёпок и широких железных обручей.
  m.slab('tub-body', 1.95, 0.82, 0.52, v(0, 0.36, 0), C.wood)
  m.slab('inner-water', 1.57, 0.56, 0.035, v(0, 0.64, 0), C.water)
  m.box('rim-front', [2.12, 0.09, 0.1], v(0, 0.67, -0.4), C.woodLight)
  m.box('rim-back', [2.12, 0.09, 0.1], v(0, 0.67, 0.4), C.woodLight)
  for (const x of [-0.84, -0.56, -0.28, 0, 0.28, 0.56, 0.84]) {
    m.box('stave', [0.035, 0.5, 0.035], v(x, 0.36, -0.416), C.woodLight)
    m.box('stave', [0.035, 0.5, 0.035], v(x, 0.36, 0.416), C.woodLight)
  }
  for (const x of [-0.63, 0, 0.63]) {
    m.box('iron-band', [0.055, 0.055, 0.9], v(x, 0.37, 0), C.iron)
  }
  for (const x of [-0.78, 0.78]) for (const z of [-0.27, 0.27]) {
    m.box('short-leg', [0.1, 0.18, 0.1], v(x, 0.09, z), C.iron)
  }
  return m
}

function buildCradle() {
  const m = new Model('cradle')
  m.slab('cradle-bed', 0.82, 0.5, 0.22, v(0, 0.43, 0), C.wood)
  m.box('side-rail-front', [0.86, 0.25, 0.07], v(0, 0.64, -0.24), C.woodLight)
  m.box('side-rail-back', [0.86, 0.25, 0.07], v(0, 0.64, 0.24), C.woodLight)
  m.box('headboard', [0.08, 0.5, 0.6], v(-0.39, 0.68, 0), C.woodDark)
  m.box('footboard', [0.08, 0.42, 0.58], v(0.39, 0.64, 0), C.wood)
  m.slab('blanket', 0.55, 0.38, 0.07, v(0.12, 0.59, 0), C.red)
  for (const z of [-0.21, 0.21]) {
    m.beam('rocker', v(-0.48, 0.1, z), v(0.48, 0.1, z), 0.055, C.woodDark)
    m.beam('rocker-tip', v(-0.48, 0.1, z), v(-0.38, 0.2, z), 0.055, C.woodDark)
    m.beam('rocker-tip', v(0.38, 0.2, z), v(0.48, 0.1, z), 0.055, C.woodDark)
  }
  for (const x of [-0.3, 0.3]) {
    m.box('rocker-support', [0.07, 0.32, 0.07], v(x, 0.27, -0.21), C.wood)
    m.box('rocker-support', [0.07, 0.32, 0.07], v(x, 0.27, 0.21), C.wood)
  }
  return m
}

function buildStandingMirror() {
  const m = new Model('standing_mirror')
  m.slab('mirror-glass', 0.56, 0.06, 1.34, v(0, 1.03, 0), C.blue)
  m.box('frame-top', [0.76, 0.1, 0.1], v(0, 1.75, 0), C.woodDark)
  m.box('frame-bottom', [0.76, 0.1, 0.1], v(0, 0.31, 0), C.woodDark)
  m.box('frame-left', [0.1, 1.45, 0.1], v(-0.33, 1.03, 0), C.woodLight)
  m.box('frame-right', [0.1, 1.45, 0.1], v(0.33, 1.03, 0), C.woodLight)
  m.slab('base', 0.78, 0.42, 0.1, v(0, 0.05, 0.04), C.woodDark)
  m.beam('rear-brace', v(0, 0.18, 0.18), v(0, 1.2, 0.28), 0.045, C.wood)
  m.box('ornament', [0.16, 0.07, 0.05], v(0, 1.78, -0.02), C.brass)
  return m
}

function buildCoatRack() {
  const m = new Model('coat_rack')
  m.cylinder('post', 0.055, 0.075, 1.55, v(0, 0.82, 0), C.woodDark, 10)
  m.slab('foot', 0.48, 0.42, 0.08, v(0, 0.04, 0), C.wood)
  for (const [x, z] of [[-0.18, 0], [0.18, 0], [0, -0.17], [0, 0.17]]) {
    m.beam('foot-spoke', v(0, 0.09, 0), v(x, 0.09, z), 0.035, C.woodLight)
  }
  m.beam('hook-left', v(0, 1.48, 0), v(-0.24, 1.66, 0), 0.035, C.woodLight)
  m.beam('hook-right', v(0, 1.48, 0), v(0.24, 1.66, 0), 0.035, C.woodLight)
  m.beam('hook-front', v(0, 1.5, 0), v(0, 1.68, -0.2), 0.035, C.woodLight)
  // Плащ и шляпа делают силуэт стойки различимым сверху.
  m.box('cloak', [0.3, 0.7, 0.08], v(-0.18, 1.18, -0.02), C.red, [0, 0, -0.08])
  m.sphere('hat-crown', [0.2, 0.12, 0.2], v(0.22, 1.72, 0), C.woodDark)
  m.cylinder('hat-brim', 0.15, 0.15, 0.035, v(0.22, 1.66, 0), C.woodDark, 10)
  return m
}

function buildKitchenStove() {
  const m = new Model('kitchen_stove')
  m.slab('brick-body', 2.36, 0.9, 0.82, v(0, 0.48, 0), C.brick)
  for (const x of [-0.82, 0, 0.82]) m.box('mortar-line', [0.018, 0.74, 0.018], v(x, 0.48, -0.46), C.stoneDark)
  for (const y of [0.25, 0.5, 0.75]) m.box('brick-joint', [2.3, 0.018, 0.018], v(0, y, -0.46), C.stoneDark)
  m.slab('cast-iron-top', 2.48, 1.02, 0.1, v(0, 0.94, 0), C.iron)
  for (const x of [-0.55, 0.55]) {
    m.cylinder('pot', 0.3, 0.26, 0.18, v(x, 1.08, 0), C.iron, 12)
    m.cylinder('pot-lid', 0.23, 0.23, 0.035, v(x, 1.19, 0), C.brass, 12)
    m.sphere('pot-knob', [0.06, 0.05, 0.06], v(x, 1.24, 0), C.iron)
  }
  m.slab('oven-mouth', 0.7, 0.04, 0.38, v(0, 0.43, -0.47), C.dark)
  m.beam('chimney', v(0.76, 0.99, 0.25), v(0.76, 1.2, 0.25), 0.08, C.iron)
  return m
}

function buildBreadOven() {
  const m = new Model('bread_oven')
  m.slab('oven-floor', 2.48, 2.3, 0.22, v(0, 0.11, 0), C.stoneDark)
  m.sphere('stone-dome', [2.55, 1.72, 2.2], v(0, 0.92, 0.06), C.stoneLight)
  m.slab('front-apron', 2.72, 0.2, 0.38, v(0, 0.3, -1.12), C.stone)
  m.slab('arch-opening', 0.92, 0.06, 0.76, v(0, 0.53, -1.17), C.dark)
  m.sphere('opening-top', [0.92, 0.54, 0.08], v(0, 0.91, -1.18), C.dark)
  m.box('arch-left', [0.14, 0.78, 0.14], v(-0.57, 0.54, -1.15), C.stone)
  m.box('arch-right', [0.14, 0.78, 0.14], v(0.57, 0.54, -1.15), C.stone)
  m.beam('wooden-peel', v(0.88, 0.08, -0.9), v(1.23, 1.22, -1.36), 0.035, C.woodLight)
  m.box('peel-blade', [0.33, 0.025, 0.24], v(1.23, 1.22, -1.36), C.woodLight, [0.35, 0, 0])
  return m
}

function buildWashtub() {
  const m = new Model('washtub')
  m.barrel('washtub-body', 0.46, 0.48, v(0, 0.24, 0), C.wood)
  m.torus('washtub-rim', 0.43, 0.035, v(0, 0.5, 0), C.woodLight, [Math.PI / 2, 0, 0])
  m.slab('soapy-water', 0.68, 0.68, 0.025, v(0, 0.49, 0), C.water)
  m.torus('water-suds', 0.26, 0.035, v(-0.08, 0.515, 0.03), C.cream, [Math.PI / 2, 0, 0])
  m.cylinder('plate', 0.16, 0.16, 0.035, v(0.18, 0.54, -0.03), C.stoneLight, 12)
  m.cylinder('plate', 0.13, 0.13, 0.03, v(-0.2, 0.55, 0.08), C.stone, 12)
  for (const x of [-0.3, 0.3]) m.box('wooden-leg', [0.09, 0.16, 0.09], v(x, 0.08, 0), C.woodDark)
  return m
}

function buildButcherBlock() {
  const m = new Model('butcher_block')
  m.slab('block', 0.76, 0.76, 0.5, v(0, 0.7, 0), C.woodLight)
  m.slab('block-top', 0.82, 0.82, 0.08, v(0, 0.99, 0), C.wood)
  for (const x of [-0.27, 0.27]) for (const z of [-0.27, 0.27]) {
    m.box('leg', [0.1, 0.48, 0.1], v(x, 0.25, z), C.woodDark)
  }
  m.box('cleaver-blade', [0.12, 0.38, 0.035], v(0.18, 1.18, -0.04), C.iron, [0, 0, -0.18])
  m.box('cleaver-handle', [0.08, 0.2, 0.08], v(0.18, 1.45, -0.04), C.woodDark, [0, 0, -0.18])
  return m
}

function buildHangingPots() {
  const m = new Model('hanging_pots')
  m.slab('wall-rack', 2.42, 0.11, 0.12, v(0, 1.05, 0), C.woodDark)
  m.box('rack-upper', [2.5, 0.08, 0.08], v(0, 1.15, -0.03), C.iron)
  for (const x of [-0.9, 0, 0.9]) {
    m.beam('rack-bracket', v(x, 0.95, 0.03), v(x, 1.12, 0.03), 0.035, C.iron)
    m.beam('pot-hook', v(x, 1.03, 0), v(x, 0.72, 0), 0.018, C.iron)
  }
  for (const [x, r] of [[-0.9, 0.23], [0, 0.28], [0.9, 0.2]]) {
    m.cylinder('copper-pot', r, r * 0.82, 0.15, v(x, 0.62, 0), C.copper, 12)
    m.torus('pot-rim', r * 0.85, 0.025, v(x, 0.72, 0), C.brass, [Math.PI / 2, 0, 0])
  }
  m.torus('hanging-pan', 0.23, 0.05, v(0.45, 0.48, 0), C.copper, [Math.PI / 2, 0, 0])
  m.beam('pan-handle', v(0.45, 0.5, 0), v(0.9, 0.5, 0), 0.025, C.iron)
  return m
}

function buildShopCounter() {
  const m = new Model('shop_counter')
  m.table('counter', 4.0, 0.82, 0.95, C.woodDark)
  m.slab('countertop', 4.2, 1, 0.1, v(0, 1.0, 0), C.wood)
  m.box('front-inlay', [2.7, 0.08, 0.025], v(0, 0.62, -0.43), C.brass)
  // Весы и товар на прилавке дают считываемый торговый силуэт.
  m.cylinder('scale-post', 0.035, 0.045, 0.28, v(-0.8, 1.18, 0), C.brass, 10)
  m.beam('scale-beam', v(-1.05, 1.32, 0), v(-0.55, 1.32, 0), 0.025, C.brass)
  for (const x of [-1.05, -0.55]) {
    m.torus('scale-pan', 0.13, 0.025, v(x, 1.18, 0), C.brass, [Math.PI / 2, 0, 0])
    m.beam('pan-chain', v(x, 1.31, 0), v(x, 1.18, 0), 0.012, C.iron)
  }
  m.cylinder('goods-jar', 0.15, 0.17, 0.23, v(0.35, 1.16, 0), C.blue, 10)
  m.slab('goods-box', 0.4, 0.35, 0.22, v(0.95, 1.16, 0), C.red)
  return m
}

function buildClothBolts() {
  const m = new Model('cloth_bolts')
  m.slab('stand-base', 0.96, 0.86, 0.1, v(0, 0.05, 0), C.woodDark)
  for (const x of [-0.4, 0.4]) {
    m.box('stand-post', [0.08, 1.26, 0.08], v(x, 0.68, 0), C.wood)
    m.box('upper-rail', [0.88, 0.08, 0.08], v(0, 1.3, 0), C.woodLight)
  }
  for (const [x, color] of [[-0.28, C.red], [0, C.blue], [0.28, C.green]]) {
    m.cylinder('cloth-roll', 0.17, 0.17, 0.68, v(x, 0.43, 0), color, 12)
    m.torus('roll-band', 0.14, 0.018, v(x, 0.43, 0), C.cream, [Math.PI / 2, 0, 0])
    m.cylinder('roll-core', 0.045, 0.045, 0.7, v(x, 0.43, 0), C.woodLight, 8)
  }
  return m
}

function buildMarketAwning() {
  const m = new Model('market_awning')
  for (const x of [-1.9, 1.9]) for (const z of [-1.1, 1.1]) {
    m.cylinder('awning-pole', 0.045, 0.06, 2.3, v(x, 1.15, z), C.woodDark, 10)
  }
  const stripes = [C.red, C.cream, C.blue, C.cream, C.red]
  for (let i = 0; i < stripes.length; i += 1) {
    const x = -1.76 + i * 0.88
    m.box('awning-cloth', [0.84, 0.045, 2.36], v(x, 2.28, 0), stripes[i], [0.02 * (i - 2), 0, 0])
  }
  m.beam('awning-front-edge', v(-1.9, 2.2, -1.1), v(1.9, 2.2, -1.1), 0.035, C.wood)
  m.beam('awning-back-edge', v(-1.9, 2.2, 1.1), v(1.9, 2.2, 1.1), 0.035, C.wood)
  return m
}

function buildNoticeBoard() {
  const m = new Model('notice_board')
  m.box('board', [1.25, 1.15, 0.12], v(0, 1.08, 0), C.woodDark)
  m.box('board-face', [1.1, 0.96, 0.035], v(0, 1.08, -0.08), C.wood)
  for (const [x, y, w] of [[-0.3, 1.3, 0.35], [0.25, 1.18, 0.42], [0, 0.83, 0.52]]) {
    m.box('blank-paper', [w, 0.02, 0.25], v(x, y, -0.11), C.paper, [0, 0, (x * 0.18)])
    m.sphere('pin', [0.045, 0.045, 0.045], v(x, y + 0.08, -0.14), C.brass)
  }
  for (const x of [-0.45, 0.45]) m.box('post', [0.1, 0.95, 0.1], v(x, 0.48, 0), C.woodDark)
  m.box('roof', [1.55, 0.12, 0.5], v(0, 1.75, 0), C.woodLight, [0.08, 0, 0])
  m.box('roof-ridge', [1.6, 0.08, 0.08], v(0, 1.82, 0), C.woodDark)
  return m
}

function buildScalesTable() {
  const m = new Model('scales_table')
  m.table('table', 0.88, 0.68, 0.83, C.wood)
  m.slab('table-top', 1, 0.8, 0.08, v(0, 0.88, 0), C.woodLight)
  m.cylinder('scale-column', 0.04, 0.06, 0.27, v(0, 1.055, 0), C.brass, 10)
  m.beam('balance-beam', v(-0.28, 1.19, 0), v(0.28, 1.19, 0), 0.025, C.brass)
  for (const x of [-0.28, 0.28]) {
    m.torus('balance-pan', 0.13, 0.025, v(x, 1.07, 0), C.brass, [Math.PI / 2, 0, 0])
    m.beam('balance-chain', v(x, 1.19, 0), v(x, 1.08, 0), 0.012, C.iron)
  }
  for (const [x, z, r] of [[0.43, 0.22, 0.055], [0.43, 0.05, 0.07], [0.43, -0.14, 0.085]]) {
    m.cylinder('weight', r, r * 1.1, r * 1.3, v(x, 0.95 + r, z), C.brass, 10)
  }
  return m
}

const BUILDERS = Object.freeze({
  folding_screen: buildFoldingScreen,
  bathtub: buildBathtub,
  cradle: buildCradle,
  standing_mirror: buildStandingMirror,
  coat_rack: buildCoatRack,
  kitchen_stove: buildKitchenStove,
  bread_oven: buildBreadOven,
  washtub: buildWashtub,
  butcher_block: buildButcherBlock,
  hanging_pots: buildHangingPots,
  shop_counter: buildShopCounter,
  cloth_bolts: buildClothBolts,
  market_awning: buildMarketAwning,
  notice_board: buildNoticeBoard,
  scales_table: buildScalesTable,
})

export const MODEL_IDS = Object.freeze(Object.keys(BUILDERS))

/** @param {string} id @returns {THREE.Group} */
export function createModel(id) {
  const build = BUILDERS[id]
  if (!build) throw new Error(`Unknown map-detail household model: ${id}`)
  const model = build()
  model.root.updateMatrixWorld(true)
  return model.root
}
