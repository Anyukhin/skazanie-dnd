#!/usr/bin/env node
/** Авторские детализированные модели для бытовых предметов листов 30–31. */
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

/** Тонкая тканевая панель с небольшой провисью по глубине; UV идут по всей полосе. */
function saggingCloth(m, name, width, depth, position, color, sag = 0.07) {
  const halfDepth = depth / 2
  const thickness = 0.045
  const positions = []
  const uvs = []
  for (const layer of [1, -1]) for (let row = 0; row <= 2; row += 1) for (let column = 0; column <= 1; column += 1) {
    const z = -halfDepth + row * halfDepth
    const y = -sag * (1 - (z / halfDepth) ** 2) + layer * thickness / 2
    positions.push((column - 0.5) * width, y, z)
    uvs.push(column, row / 2)
  }
  const top = (row, column) => row * 2 + column
  const bottom = (row, column) => 6 + row * 2 + column
  const indices = []
  const quad = (a, b, c, d) => indices.push(a, b, c, a, c, d)
  for (let row = 0; row < 2; row += 1) {
    quad(top(row, 0), top(row + 1, 0), top(row + 1, 1), top(row, 1))
    quad(bottom(row, 0), bottom(row, 1), bottom(row + 1, 1), bottom(row + 1, 0))
    quad(top(row, 0), bottom(row, 0), bottom(row + 1, 0), top(row + 1, 0))
    quad(top(row, 1), top(row + 1, 1), bottom(row + 1, 1), bottom(row, 1))
  }
  quad(top(0, 0), top(0, 1), bottom(0, 1), bottom(0, 0))
  quad(top(2, 0), bottom(2, 0), bottom(2, 1), top(2, 1))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return m.mesh(name, geometry, position, color)
}

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
    m.box('panel-foot', [0.95, 0.08, 0.18], v(x, 0.05, 0), C.woodDark, [0, yaw, 0])
    m.box('panel-medallion', [0.18, 0.18, 0.03], v(x, 1.34, -0.068), C.brass, [0, yaw, 0])
    m.box('panel-lower-rail', [0.7, 0.06, 0.08], v(x, 0.22, -0.056), C.woodLight, [0, yaw, 0])
  }
  m.cylinder('hinge', 0.035, 0.035, 1.55, v(-0.44, 0.9, -0.08), C.brass, 8)
  m.cylinder('hinge', 0.035, 0.035, 1.55, v(0.44, 0.9, -0.08), C.brass, 8)
  for (const y of [0.38, 1.42]) {
    m.torus('hinge-pin', 0.065, 0.018, v(-0.44, y, -0.08), C.brass, [Math.PI / 2, 0, 0])
    m.torus('hinge-pin', 0.065, 0.018, v(0.44, y, -0.08), C.brass, [Math.PI / 2, 0, 0])
  }
  return m
}

function buildBathtub() {
  const m = new Model('bathtub')
  // Деревянная ванна собрана из торцов, клёпок и широких железных обручей.
  m.slab('tub-body', 1.95, 0.82, 0.52, v(0, 0.36, 0), C.wood)
  m.slab('inner-water', 1.57, 0.56, 0.035, v(0, 0.64, 0), C.water)
  m.box('rim-front', [2.12, 0.09, 0.1], v(0, 0.67, -0.4), C.woodLight)
  m.box('rim-back', [2.12, 0.09, 0.1], v(0, 0.67, 0.4), C.woodLight)
  m.box('rim-left', [0.1, 0.09, 0.72], v(-1.0, 0.67, 0), C.woodLight)
  m.box('rim-right', [0.1, 0.09, 0.72], v(1.0, 0.67, 0), C.woodLight)
  for (const x of [-0.84, -0.56, -0.28, 0, 0.28, 0.56, 0.84]) {
    m.box('stave', [0.035, 0.5, 0.035], v(x, 0.36, -0.416), C.woodLight)
    m.box('stave', [0.035, 0.5, 0.035], v(x, 0.36, 0.416), C.woodLight)
  }
  for (const x of [-0.63, 0, 0.63]) {
    m.box('iron-band', [0.055, 0.055, 0.9], v(x, 0.37, 0), C.iron)
  }
  for (const x of [-0.78, 0.78]) for (const z of [-0.27, 0.27]) {
    m.box('short-leg', [0.1, 0.18, 0.1], v(x, 0.09, z), C.iron)
    m.sphere('claw-foot-brass', [0.12, 0.08, 0.12], v(x, 0.04, z), C.brass)
  }
  m.cylinder('drain', 0.05, 0.06, 0.03, v(0.35, 0.675, 0.16), C.iron, 10)
  m.beam('faucet-neck', v(0.72, 0.69, 0.4), v(0.72, 0.98, 0.4), 0.035, C.brass)
  m.beam('faucet-spout', v(0.72, 0.98, 0.4), v(0.5, 0.98, 0.4), 0.035, C.brass)
  m.beam('faucet-manifold-brass', v(0.6, 0.7, 0.4), v(0.84, 0.7, 0.4), 0.025, C.brass)
  for (const x of [0.6, 0.84]) m.cylinder('faucet-handle-brass', 0.05, 0.05, 0.16, v(x, 0.78, 0.4), C.brass, 8)
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
  m.slab('pillow', 0.3, 0.34, 0.08, v(-0.22, 0.59, 0), C.cream)
  for (const x of [-0.27, 0, 0.27]) m.box('headboard-slat', [0.035, 0.34, 0.05], v(-0.42, 0.78, x), C.woodLight)
  m.beam('headboard-post-left', v(-0.42, 0.82, -0.21), v(-0.42, 1.0, -0.21), 0.04, C.woodLight)
  m.beam('headboard-post-right', v(-0.42, 0.82, 0.21), v(-0.42, 1.0, 0.21), 0.04, C.woodLight)
  for (const z of [-0.21, 0.21]) m.sphere('headboard-finial', [0.08, 0.08, 0.08], v(-0.42, 1.03, z), C.brass)
  for (const z of [-0.21, 0.21]) {
    m.beam('rocker', v(-0.48, 0.1, z), v(0.48, 0.1, z), 0.055, C.woodDark)
    m.beam('rocker-tip', v(-0.48, 0.1, z), v(-0.38, 0.2, z), 0.055, C.woodDark)
    m.beam('rocker-tip', v(0.38, 0.2, z), v(0.48, 0.1, z), 0.055, C.woodDark)
  }
  for (const x of [-0.3, 0.3]) {
    m.box('rocker-support', [0.07, 0.32, 0.07], v(x, 0.27, -0.21), C.wood)
    m.box('rocker-support', [0.07, 0.32, 0.07], v(x, 0.27, 0.21), C.wood)
  }
  m.beam('cradle-blanket-fold', v(-0.12, 0.63, -0.18), v(0.35, 0.63, -0.18), 0.018, C.woodDark)
  return m
}

function buildStandingMirror() {
  const m = new Model('standing_mirror')
  m.slab('mirror-glass', 0.56, 0.06, 1.34, v(0, 1.03, 0), C.blue)
  m.box('frame-top', [0.76, 0.1, 0.1], v(0, 1.75, 0), C.woodDark)
  m.box('frame-bottom', [0.76, 0.1, 0.1], v(0, 0.31, 0), C.woodDark)
  m.box('frame-left', [0.1, 1.45, 0.1], v(-0.33, 1.03, 0), C.woodLight)
  m.box('frame-right', [0.1, 1.45, 0.1], v(0.33, 1.03, 0), C.woodLight)
  m.box('inner-frame-top', [0.52, 0.035, 0.04], v(0, 1.68, -0.055), C.brass)
  m.box('inner-frame-bottom', [0.52, 0.035, 0.04], v(0, 0.38, -0.055), C.brass)
  m.slab('base', 0.78, 0.42, 0.1, v(0, 0.05, 0.04), C.woodDark)
  m.slab('left-foot', 0.28, 0.46, 0.08, v(-0.25, 0.08, 0.04), C.wood)
  m.slab('right-foot', 0.28, 0.46, 0.08, v(0.25, 0.08, 0.04), C.wood)
  m.beam('rear-brace', v(0, 0.08, 0.18), v(0, 1.2, 0.08), 0.045, C.wood)
  m.box('ornament', [0.16, 0.07, 0.05], v(0, 1.78, -0.02), C.brass)
  m.sphere('ornament-gem', [0.05, 0.05, 0.025], v(0, 1.79, -0.055), C.red)
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
  m.box('cloak-collar', [0.24, 0.08, 0.1], v(-0.2, 1.5, -0.03), C.woodDark, [0, 0, -0.08])
  for (const y of [1.2, 1.38]) m.sphere('cloak-button', [0.035, 0.035, 0.025], [-0.2, y, -0.08], C.brass)
  m.sphere('hat-crown', [0.2, 0.12, 0.2], v(0.22, 1.72, 0), C.woodDark)
  m.cylinder('hat-brim', 0.15, 0.15, 0.035, v(0.22, 1.66, 0), C.woodDark, 10)
  m.torus('hat-band', 0.12, 0.018, v(0.22, 1.7, 0), C.red, [Math.PI / 2, 0, 0])
  m.sphere('post-finial', [0.09, 0.09, 0.09], v(0, 1.66, 0), C.brass)
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
    m.beam('pot-handle', v(x - 0.3, 1.1, 0), v(x - 0.45, 1.1, 0), 0.025, C.iron)
  }
  m.box('oven-mouth-frame-metal', [0.88, 0.08, 0.5], v(0, 0.43, -0.48), C.iron)
  m.slab('oven-mouth', 0.7, 0.04, 0.38, v(0, 0.43, -0.53), C.dark)
  m.beam('oven-handle', v(-0.25, 0.55, -0.58), v(0.25, 0.55, -0.58), 0.03, C.brass)
  for (const x of [-0.8, 0.8]) m.cylinder('stove-knob', 0.055, 0.055, 0.04, v(x, 0.73, -0.5), C.brass, 10, [Math.PI / 2, 0, 0])
  m.beam('chimney', v(0.76, 0.99, 0.25), v(0.76, 1.2, 0.25), 0.08, C.iron)
  m.box('chimney-cap', [0.26, 0.05, 0.26], v(0.76, 1.23, 0.25), C.stoneLight)
  m.beam('stove-firebar-metal', v(-0.28, 0.35, -0.57), v(0.28, 0.35, -0.57), 0.025, C.iron)
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
  for (const [x, y] of [[-0.4, 0.97], [0.4, 0.97], [-0.25, 1.14], [0.25, 1.14], [0, 1.24]]) {
    m.box('arch-voussoir', [0.23, 0.16, 0.16], [x, y, -1.19], C.stoneLight, [0, 0, x * 0.45])
  }
  m.cylinder('oven-fire', 0.16, 0.2, 0.04, [0, 0.36, -1.21], C.red, 10)
  m.beam('oven-chimney', v(0.7, 1.55, 0.18), v(0.7, 1.96, 0.18), 0.1, C.stoneDark)
  m.beam('wooden-peel', v(0.88, 0.08, -0.9), v(1.23, 1.22, -1.36), 0.035, C.woodLight)
  m.box('peel-blade', [0.33, 0.025, 0.24], v(1.23, 1.22, -1.36), C.woodLight, [0.35, 0, 0])
  return m
}

function buildWashtub() {
  const m = new Model('washtub')
  m.barrel('washtub-body', 0.46, 0.48, v(0, 0.24, 0), C.wood)
  m.torus('washtub-rim', 0.43, 0.035, v(0, 0.73, 0), C.woodLight, [Math.PI / 2, 0, 0])
  for (const y of [0.12, 0.36]) m.torus('washtub-hoop', 0.42, 0.022, v(0, y, 0), C.iron, [Math.PI / 2, 0, 0])
  m.cylinder('soapy-water', 0.36, 0.4, 0.025, v(0, 0.73, 0), C.water, 16)
  m.torus('water-suds', 0.26, 0.035, v(-0.08, 0.755, 0.03), C.cream, [Math.PI / 2, 0, 0])
  m.cylinder('plate', 0.16, 0.16, 0.035, v(0.18, 0.78, -0.03), C.stoneLight, 12)
  m.cylinder('plate', 0.13, 0.13, 0.03, v(-0.2, 0.79, 0.08), C.stone, 12)
  m.box('washboard', [0.28, 0.45, 0.05], v(-0.35, 0.76, -0.1), C.woodLight, [0.24, 0, 0])
  for (const y of [0.62, 0.73, 0.84]) m.box('washboard-rib', [0.24, 0.025, 0.06], v(-0.35, y, -0.15), C.woodDark, [0.24, 0, 0])
  m.cylinder('soap', 0.09, 0.1, 0.07, v(0.26, 0.8, 0.08), C.cream, 10)
  for (const x of [-0.3, 0.3]) m.box('wooden-leg', [0.09, 0.16, 0.09], v(x, 0.08, 0), C.woodDark)
  return m
}

function buildButcherBlock() {
  const m = new Model('butcher_block')
  m.slab('block', 0.76, 0.76, 0.5, v(0, 0.7, 0), C.woodLight)
  m.slab('block-top', 0.82, 0.82, 0.08, v(0, 0.99, 0), C.wood)
  for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) {
    m.box('end-grain', [0.025, 0.02, 0.22], v(x, 1.04, z), C.woodLight)
  }
  for (const x of [-0.27, 0.27]) for (const z of [-0.27, 0.27]) {
    m.box('leg', [0.1, 0.48, 0.1], v(x, 0.25, z), C.woodDark)
  }
  m.slab('lower-shelf', 0.6, 0.55, 0.08, v(0, 0.18, 0), C.wood)
  for (const x of [-0.22, 0.22]) m.box('chopping-groove', [0.035, 0.015, 0.55], v(x, 1.045, 0), C.woodDark)
  m.box('cleaver-blade', [0.12, 0.38, 0.035], v(0.18, 1.18, -0.04), C.iron, [0, 0, -0.18])
  m.box('cleaver-handle', [0.08, 0.2, 0.08], v(0.18, 1.45, -0.04), C.woodDark, [0, 0, -0.18])
  m.torus('cleaver-rivet', 0.03, 0.012, v(0.18, 1.37, -0.09), C.brass, [Math.PI / 2, 0, 0])
  return m
}

function buildHangingPots() {
  const m = new Model('hanging_pots')
  m.slab('wall-rack', 2.42, 0.11, 0.12, v(0, 1.05, 0), C.woodDark)
  m.box('rack-upper', [2.5, 0.08, 0.08], v(0, 1.15, -0.03), C.iron)
  for (const x of [-0.9, 0, 0.9]) {
    m.beam('rack-bracket', v(x, 0.95, 0.03), v(x, 1.12, 0.03), 0.035, C.iron)
    m.beam('pot-chain-metal', v(x, 1.12, -0.04), v(x, 0.8, -0.04), 0.018, C.iron)
    m.beam('pot-hook-metal', v(x, 0.8, -0.04), v(x + 0.08, 0.74, 0), 0.018, C.iron)
  }
  for (const [x, r] of [[-0.9, 0.23], [0, 0.28], [0.9, 0.2]]) {
    m.cylinder('copper-pot', r, r * 0.82, 0.15, v(x, 0.62, 0), C.copper, 12)
    m.torus('pot-rim', r * 0.85, 0.025, v(x, 0.72, 0), C.brass, [Math.PI / 2, 0, 0])
    m.cylinder('pot-lid', r * 0.62, r * 0.62, 0.025, v(x, 0.74, 0), C.iron, 12)
    m.sphere('pot-knob', [0.045, 0.045, 0.045], v(x, 0.78, 0), C.brass)
    m.beam('pot-handle', v(x - r, 0.64, 0), v(x - r - 0.12, 0.64, 0), 0.018, C.iron)
  }
  m.torus('hanging-pan', 0.23, 0.05, v(0.45, 0.48, 0), C.copper, [Math.PI / 2, 0, 0])
  m.beam('pan-handle', v(0.45, 0.5, 0), v(0.9, 0.5, 0), 0.025, C.iron)
  m.beam('pan-chain-metal', v(0.45, 1.12, -0.04), v(0.45, 0.55, -0.04), 0.018, C.iron)
  m.beam('pan-hook-metal', v(0.45, 0.55, -0.04), v(0.53, 0.5, 0), 0.018, C.iron)
  m.beam('ladle-handle', v(-0.4, 1.12, -0.04), v(-0.4, 0.47, 0), 0.018, C.woodLight)
  m.torus('ladle-bowl', 0.11, 0.025, v(-0.4, 0.46, 0), C.copper, [Math.PI / 2, 0, 0])
  return m
}

function buildShopCounter() {
  const m = new Model('shop_counter')
  m.table('counter', 4.0, 0.82, 0.95, C.woodDark)
  m.slab('countertop', 4.2, 1, 0.1, v(0, 1.0, 0), C.wood)
  m.box('front-inlay', [2.7, 0.08, 0.025], v(0, 0.62, -0.43), C.brass)
  for (const x of [-1.4, 0, 1.4]) m.box('front-panel', [1.1, 0.55, 0.035], v(x, 0.37, -0.43), C.wood)
  m.box('front-fascia', [4, 0.1, 0.08], v(0, 0.18, -0.43), C.woodDark)
  m.box('front-fascia', [4, 0.1, 0.08], v(0, 0.9, -0.43), C.wood)
  for (const x of [-0.7, 0.7]) m.box('front-stile', [0.24, 0.74, 0.08], v(x, 0.54, -0.43), C.woodDark)
  m.box('counter-drawer', [0.8, 0.24, 0.08], v(1.1, 0.75, -0.46), C.woodLight)
  m.torus('counter-drawer-handle', 0.055, 0.018, v(1.1, 0.75, -0.52), C.brass, [Math.PI / 2, 0, 0])
  // Весы и товар на прилавке дают считываемый торговый силуэт.
  m.cylinder('scale-post', 0.035, 0.045, 0.28, v(-0.8, 1.18, 0), C.brass, 10)
  m.beam('scale-beam', v(-1.05, 1.32, 0), v(-0.55, 1.32, 0), 0.025, C.brass)
  for (const x of [-1.05, -0.55]) {
    m.torus('scale-pan', 0.13, 0.025, v(x, 1.18, 0), C.brass, [Math.PI / 2, 0, 0])
    m.beam('pan-chain', v(x, 1.31, 0), v(x, 1.18, 0), 0.012, C.iron)
  }
  m.cylinder('goods-jar', 0.15, 0.17, 0.23, v(0.35, 1.16, 0), C.blue, 10)
  m.cylinder('goods-jar-lid', 0.12, 0.12, 0.035, v(0.35, 1.29, 0), C.brass, 10)
  m.slab('goods-box', 0.4, 0.35, 0.22, v(0.95, 1.16, 0), C.red)
  m.box('goods-box-band', [0.42, 0.035, 0.04], v(0.95, 1.18, -0.19), C.brass)
  return m
}

function buildClothBolts() {
  const m = new Model('cloth_bolts')
  m.slab('stand-base', 0.96, 0.86, 0.1, v(0, 0.05, 0), C.woodDark)
  for (const x of [-0.4, 0.4]) {
    m.box('stand-post', [0.08, 1.26, 0.08], v(x, 0.68, 0), C.wood)
  }
  m.box('upper-rail', [0.88, 0.08, 0.08], v(0, 0.85, 0), C.woodLight)
  for (const [x, color] of [[-0.28, C.red], [0, C.blue], [0.28, C.green]]) {
    m.cylinder('cloth-roll', 0.17, 0.17, 0.68, v(x, 0.43, 0), color, 12)
    m.torus('roll-band', 0.14, 0.018, v(x, 0.43, 0), C.cream, [Math.PI / 2, 0, 0])
    m.cylinder('roll-core', 0.045, 0.045, 0.7, v(x, 0.43, 0), C.woodLight, 8)
    m.cylinder('roll-cap', 0.08, 0.08, 0.025, v(x, 0.79, 0), C.cream, 10)
    m.box('roll-label', [0.12, 0.07, 0.02], v(x, 0.43, -0.18), C.paper)
  }
  m.beam('stand-brace-left', v(-0.4, 0.15, 0), v(0, 0.42, 0), 0.025, C.woodDark)
  m.beam('stand-brace-right', v(0.4, 0.15, 0), v(0, 0.42, 0), 0.025, C.woodDark)
  return m
}

function buildMarketAwning() {
  const m = new Model('market_awning')
  for (const x of [-1.9, 1.9]) for (const z of [-1.1, 1.1]) {
    m.cylinder('awning-pole', 0.045, 0.06, 2.3, v(x, 1.15, z), C.woodDark, 10)
    m.sphere('awning-finial', [0.09, 0.09, 0.09], v(x, 2.32, z), C.brass)
  }
  const stripes = [C.red, C.cream, C.blue, C.cream, C.red]
  for (let i = 0; i < stripes.length; i += 1) {
    const x = -1.76 + i * 0.88
    saggingCloth(m, 'awning-cloth', 0.84, 2.36, v(x, 2.28, 0), stripes[i], 0.07)
  }
  for (const x of [-1.45, -0.5, 0.5, 1.45]) {
    m.beam('awning-tie', v(x, 2.26, -1.12), v(x, 2.04, -1.22), 0.018, C.woodLight)
    m.sphere('awning-grommet', [0.035, 0.035, 0.025], v(x, 2.22, -1.18), C.brass)
  }
  m.beam('awning-front-edge', v(-1.9, 2.28, -1.1), v(1.9, 2.28, -1.1), 0.035, C.wood)
  m.beam('awning-back-edge', v(-1.9, 2.28, 1.1), v(1.9, 2.28, 1.1), 0.035, C.wood)
  m.beam('awning-side-edge', v(-1.9, 2.28, -1.1), v(-1.9, 2.28, 1.1), 0.035, C.wood)
  m.beam('awning-side-edge', v(1.9, 2.28, -1.1), v(1.9, 2.28, 1.1), 0.035, C.wood)
  return m
}

function buildNoticeBoard() {
  const m = new Model('notice_board')
  m.box('board', [1.25, 1.15, 0.12], v(0, 1.08, 0), C.woodDark)
  m.box('board-face', [1.1, 0.96, 0.035], v(0, 1.08, -0.08), C.wood)
  for (const [x, y, w] of [[-0.3, 1.3, 0.35], [0.25, 1.18, 0.42], [0, 0.83, 0.52]]) {
    m.box('blank-paper', [w, 0.25, 0.02], v(x, y, -0.11), C.paper, [0, 0, (x * 0.18)])
    m.sphere('pin', [0.045, 0.045, 0.045], v(x, y + 0.08, -0.14), C.brass)
    m.box('notice-line', [w * 0.65, 0.012, 0.018], v(x, y - 0.04, -0.125), C.woodDark)
  }
  for (const x of [-0.45, 0.45]) m.box('post', [0.1, 1.65, 0.1], v(x, 0.85, 0), C.woodDark)
  m.box('post-crossbar', [1.02, 0.08, 0.1], v(0, 0.16, 0), C.wood)
  for (const x of [-0.45, 0.45]) m.sphere('post-foot', [0.14, 0.08, 0.14], v(x, 0.04, 0), C.woodDark)
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
  m.beam('scale-pointer', v(0, 1.19, 0), v(0, 0.98, -0.05), 0.018, C.iron)
  m.torus('scale-pivot', 0.055, 0.018, v(0, 1.19, 0), C.iron, [Math.PI / 2, 0, 0])
  for (const x of [-0.28, 0.28]) {
    m.torus('balance-pan', 0.13, 0.025, v(x, 1.07, 0), C.brass, [Math.PI / 2, 0, 0])
    m.beam('balance-chain', v(x, 1.19, 0), v(x, 1.08, 0), 0.012, C.iron)
    m.box('pan-floor', [0.2, 0.018, 0.2], v(x, 1.065, 0), C.brass)
  }
  for (const [x, z, r] of [[0.43, 0.22, 0.055], [0.43, 0.05, 0.07], [0.43, -0.14, 0.085]]) {
    m.cylinder('weight', r, r * 1.1, r * 1.3, v(x, 0.95 + r, z), C.brass, 10)
    m.torus('weight-handle', r * 0.45, 0.012, v(x, 0.95 + r * 1.65, z), C.brass, [Math.PI / 2, 0, 0])
  }
  m.box('scale-foot', [0.4, 0.05, 0.28], v(0, 0.91, 0), C.brass)
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
