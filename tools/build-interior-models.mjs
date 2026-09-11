#!/usr/bin/env node
// @ts-check
/** Детерминированные оригинальные интерьерные GLB для кандидата выпуска. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

import { validateCandidateOutputDir } from './import-environment-models.mjs'
import { encodePng } from './png-codec.mjs'

const URL_ROOT = '/assets/models/environment/'
const FAMILY = 'skazanie'
export const GENERATOR_VERSION = 3
const SOURCE_FILE = fileURLToPath(import.meta.url)
const SOURCE_BYTES = readFileSync(SOURCE_FILE)
export const GENERATOR_SHA256 = createHash('sha256').update(SOURCE_BYTES).digest('hex')
const GENERATOR_SOURCE = Object.freeze({
  path: `${FAMILY}/build-interior-models.mjs`, sha256: GENERATOR_SHA256, bytes: SOURCE_BYTES.length,
})

/** GLTFExporter собирает binary GLB через browser FileReader; Node уже умеет Blob. */
function ensureFileReader() {
  if (typeof globalThis.FileReader === 'function') return
  globalThis.FileReader = class {
    result = null
    error = null
    onloadend = null
    onerror = null

    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((value) => {
        this.result = value
        this.onloadend?.()
      }, (error) => {
        this.error = error
        this.onerror?.(error)
      })
    }
  }
}

const COLORS = Object.freeze({
  wood: '#674a35', woodLight: '#98704a', woodDark: '#332820',
  stone: '#6b6d68', stoneLight: '#9a988b', stoneDark: '#40433f',
  iron: '#3e4242', ironLight: '#68645b', brass: '#8a7045',
  ceramic: '#a78c70', ceramicDark: '#6c5547', glass: '#3e5b5a',
  coal: '#211d1a', ember: '#a74c2e', flame: '#d68a3e', cloth: '#5a4e58',
})

const TEXTURE_KIND = Object.freeze({
  bar_counter: 'wood', bar_shelf: 'wood', table_round: 'wood', table_small: 'wood',
  fireplace: 'stone', hearth_fire: 'stone', altar: 'stone', pillar: 'stone',
  sarcophagus: 'stone', crypt_niche: 'stone', brazier: 'stone', reliquary: 'stone',
})

/** @typedef {{assetId:string,key:string,label:string,category:string,file:string,footprint:{w:number,h:number},yaw:number}} InteriorSpec */

const spec = (assetId, key, label, category, footprint, file = `${key}.glb`, yaw = 0) => Object.freeze({
  assetId, key, label, category, file, footprint: Object.freeze({ ...footprint }), yaw,
})

/** @type {readonly InteriorSpec[]} */
export const INTERIOR_MODELS = Object.freeze([
  spec('bar_counter', 'sk-bar-counter', 'Барная стойка', 'Таверна', { w: 4, h: 1 }),
  spec('bar_shelf', 'sk-bar-shelf', 'Полка с бутылками', 'Таверна', { w: 3, h: 1 }),
  spec('fireplace', 'sk-fireplace', 'Камин с кладкой', 'Таверна', { w: 2, h: 1 }),
  spec('hearth_fire', 'sk-hearth-fire', 'Очаг с углями', 'Таверна', { w: 1, h: 1 }),
  spec('table_round', 'sk-table-round', 'Круглый стол', 'Таверна', { w: 2, h: 2 }),
  spec('table_small', 'sk-table-small', 'Малый стол', 'Таверна', { w: 1, h: 1 }),
  spec('altar', 'sk-altar', 'Каменный алтарь', 'Склеп', { w: 2, h: 1 }),
  spec('pillar', 'sk-pillar', 'Каменная колонна', 'Склеп', { w: 1, h: 1 }),
  spec('sarcophagus', 'sk-sarcophagus', 'Саркофаг с крышкой', 'Склеп', { w: 2, h: 1 }),
  spec('crypt_niche', 'sk-crypt-niche', 'Ниша склепа', 'Склеп', { w: 1, h: 1 }),
  spec('brazier', 'sk-brazier', 'Каменная жаровня', 'Склеп', { w: 1, h: 1 }),
  spec('reliquary', 'sk-reliquary', 'Реликварий', 'Склеп', { w: 1, h: 1 }),
])

const SPEC_BY_ASSET = new Map(INTERIOR_MODELS.map((item) => [item.assetId, item]))

function material(name, color, options = {}) {
  const value = new THREE.MeshStandardMaterial({ color, roughness: 0.86, metalness: 0.04, ...options })
  value.name = name
  return value
}

function box(parent, name, size, position, value, rotation = [0, 0, 0], castShadow = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), value)
  mesh.name = name
  mesh.position.set(...position)
  mesh.rotation.set(...rotation)
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function roundedBox(parent, name, size, position, value, radius = 0.04, rotation = [0, 0, 0], castShadow = true) {
  const safeRadius = Math.min(radius, ...size.map((value) => Math.max(0.001, value / 2)))
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(...size, 2, safeRadius), value)
  mesh.name = name
  mesh.position.set(...position)
  mesh.rotation.set(...rotation)
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function cylinder(parent, name, radiusTop, radiusBottom, height, position, value, segments = 12, rotation = [0, 0, 0], castShadow = true) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), value)
  mesh.name = name
  mesh.position.set(...position)
  mesh.rotation.set(...rotation)
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function cone(parent, name, radius, height, position, value, segments = 10, castShadow = true) {
  return cylinder(parent, name, 0, radius, height, position, value, segments, [0, 0, 0], castShadow)
}

function sphere(parent, name, size, position, value, castShadow = true) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), value)
  mesh.name = name
  mesh.position.set(...position)
  mesh.scale.set(...size)
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function torus(parent, name, radius, tube, position, value, rotation = [0, 0, 0], castShadow = true) {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 16), value)
  mesh.name = name
  mesh.position.set(...position)
  mesh.rotation.set(...rotation)
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function emptyNode(parent, name, y, userData = {}) {
  const node = new THREE.Group()
  node.name = name
  node.position.y = y
  node.userData = { ...userData }
  parent.add(node)
  return node
}

function rootFor(assetId) {
  const root = new THREE.Group()
  root.name = `interior:${assetId}`
  root.userData = { assetId, recipe: `skazanie-interior-v${GENERATOR_VERSION}` }
  return root
}

function bottle(parent, name, x, y, z, glass, ceramic) {
  cylinder(parent, `${name}-body`, 0.065, 0.075, 0.24, [x, y + 0.12, z], glass, 10)
  cylinder(parent, `${name}-neck`, 0.035, 0.045, 0.12, [x, y + 0.3, z], glass, 10)
  cylinder(parent, `${name}-cork`, 0.038, 0.038, 0.035, [x, y + 0.38, z], ceramic, 8)
}

function mug(parent, name, x, y, z, ceramic, dark) {
  cylinder(parent, `${name}-cup`, 0.065, 0.075, 0.13, [x, y + 0.065, z], ceramic, 10)
  torus(parent, `${name}-handle`, 0.055, 0.014, [x + 0.07, y + 0.075, z], dark, [0, Math.PI / 2, 0], false)
}

function log(parent, name, x, y, z, length, value, rotation = [0, 0, Math.PI / 2]) {
  cylinder(parent, name, 0.07, 0.08, length, [x, y, z], value, 8, rotation)
}

function arch(parent, prefix, width, centerY, radius, depth, value) {
  const outer = radius + width / 2
  const inner = Math.max(0.06, radius - width / 2)
  const shape = new THREE.Shape()
  const segments = 18
  shape.moveTo(-outer, centerY)
  for (let index = 0; index <= segments; index += 1) {
    const angle = Math.PI - (index * Math.PI) / segments
    shape.lineTo(Math.cos(angle) * outer, centerY + Math.sin(angle) * outer)
  }
  shape.lineTo(inner, centerY)
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index * Math.PI) / segments
    shape.lineTo(Math.cos(angle) * inner, centerY + Math.sin(angle) * inner)
  }
  shape.lineTo(-inner, centerY)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1, steps: 1 })
  geometry.translate(0, 0, -depth / 2)
  const mesh = new THREE.Mesh(geometry, value)
  mesh.name = `${prefix}-arch`
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function buildBarCounter() {
  const root = rootFor('bar_counter')
  const wood = material('wood-counter', COLORS.wood)
  const light = material('wood-counter-top', COLORS.woodLight)
  const dark = material('wood-counter-dark', COLORS.woodDark)
  const iron = material('iron-foot-rail', COLORS.iron, { metalness: 0.55, roughness: 0.58 })
  const ceramic = material('ceramic-mug', COLORS.ceramic)
  const ceramicDark = material('ceramic-shadow', COLORS.ceramicDark)
  const width = 3.45, depth = 0.72
  roundedBox(root, 'counter-body', [width, 0.82, depth], [0, 0.46, 0], wood, 0.055)
  roundedBox(root, 'counter-top', [width + 0.08, 0.12, depth + 0.08], [0, 0.91, 0], light, 0.045)
  box(root, 'counter-front-rail', [width + 0.02, 0.08, 0.07], [0, 0.79, depth / 2 + 0.015], dark)
  for (const x of [-1.18, 0, 1.18]) box(root, 'counter-panel-divider', [0.045, 0.63, 0.04], [x, 0.43, depth / 2 + 0.02], dark)
  for (const x of [-width / 2 + 0.08, width / 2 - 0.08]) box(root, 'counter-end-post', [0.12, 1.02, depth], [x, 0.51, 0], dark)
  cylinder(root, 'counter-foot-rail', 0.035, 0.035, width * 0.76, [0, 0.22, depth / 2 + 0.06], iron, 10, [0, 0, Math.PI / 2], false)
  box(root, 'counter-foot-rail-bracket', [0.05, 0.2, 0.05], [-width * 0.28, 0.3, depth / 2 + 0.05], iron, undefined, false)
  box(root, 'counter-foot-rail-bracket', [0.05, 0.2, 0.05], [width * 0.28, 0.3, depth / 2 + 0.05], iron, undefined, false)
  emptyNode(root, 'surface-top', 0.99, { role: 'support-surface', clearForProps: true })
  box(root, 'counter-tray', [0.43, 0.025, 0.24], [width * 0.27, 1.015, -0.04], ceramicDark, undefined, false)
  mug(root, 'counter-mug-left', width * 0.18, 1.025, -0.04, ceramic, ceramicDark)
  mug(root, 'counter-mug-right', width * 0.34, 1.025, -0.04, ceramic, ceramicDark)
  return root
}

function buildBarShelf() {
  const root = rootFor('bar_shelf')
  const wood = material('wood-shelf', COLORS.wood)
  const dark = material('wood-shelf-dark', COLORS.woodDark)
  const glass = material('bottle-glass', COLORS.glass, { metalness: 0.08, roughness: 0.34 })
  const amber = material('bottle-amber', '#8a5534', { metalness: 0.04, roughness: 0.4 })
  const ceramic = material('bottle-cork', COLORS.ceramicDark)
  const width = 2.55, depth = 0.36
  box(root, 'shelf-backboard', [width, 1.35, 0.09], [0, 0.72, -0.13], dark)
  for (const y of [0.22, 0.66, 1.1]) roundedBox(root, 'shelf-board', [width, 0.07, depth], [0, y, 0], wood, 0.018)
  for (const x of [-width / 2 + 0.06, width / 2 - 0.06]) box(root, 'shelf-side', [0.1, 1.38, depth], [x, 0.72, 0], wood)
  const positions = [[-0.82, 0.22, glass], [-0.45, 0.22, amber], [-0.1, 0.22, glass], [0.37, 0.22, amber], [0.78, 0.22, glass],
    [-0.65, 0.66, amber], [-0.22, 0.66, glass], [0.24, 0.66, amber], [0.67, 0.66, glass],
    [-0.42, 1.1, glass], [0.02, 1.1, amber], [0.45, 1.1, glass]]
  positions.forEach(([x, y, value], index) => bottle(root, `shelf-bottle-${index + 1}`, x, y, 0, value, ceramic))
  return root
}

function buildFireplace() {
  const root = rootFor('fireplace')
  const stone = material('fireplace-stone', COLORS.stone)
  const light = material('fireplace-trim', COLORS.stoneLight)
  const dark = material('fireplace-opening', COLORS.coal)
  const ember = material('fireplace-embers', COLORS.ember, { emissive: COLORS.ember, emissiveIntensity: 0.35 })
  const width = 1.7, depth = 0.58
  box(root, 'fireplace-hearth', [width, 0.14, depth], [0, 0.07, 0], light)
  box(root, 'fireplace-opening', [1.12, 0.66, 0.08], [0, 0.45, depth / 2 + 0.01], dark, undefined, false)
  for (const x of [-0.68, 0.68]) {
    box(root, 'fireplace-pier', [0.27, 0.98, depth], [x, 0.55, 0], stone)
    box(root, 'fireplace-pier-cap', [0.34, 0.1, depth + 0.04], [x, 1.05, 0], light)
  }
  arch(root, 'fireplace', 0.34, 0.89, 0.57, depth, stone)
  log(root, 'fireplace-log-a', -0.12, 0.2, 0.17, 0.7, ember)
  log(root, 'fireplace-log-b', 0.12, 0.23, 0.17, 0.68, ember, [0, 0, Math.PI / 2 + 0.18])
  for (const x of [-0.26, 0, 0.24]) sphere(root, 'fireplace-coal', [0.09, 0.05, 0.07], [x, 0.3, 0.2], ember, false)
  return root
}

function buildHearthFire() {
  const root = rootFor('hearth_fire')
  const stone = material('hearth-stone', COLORS.stone)
  const dark = material('hearth-coal', COLORS.coal)
  const ember = material('hearth-ember', COLORS.ember, { emissive: COLORS.ember, emissiveIntensity: 0.55 })
  const flame = material('hearth-flame', COLORS.flame, { emissive: COLORS.flame, emissiveIntensity: 0.8 })
  for (const [x, z] of [[-0.28, -0.2], [0.28, -0.2], [-0.28, 0.2], [0.28, 0.2]]) cylinder(root, 'hearth-stone', 0.13, 0.14, 0.12, [x, 0.06, z], stone, 8)
  box(root, 'hearth-coal-bed', [0.55, 0.045, 0.44], [0, 0.16, 0], dark, undefined, false)
  log(root, 'hearth-log-a', -0.12, 0.23, 0, 0.5, ember)
  log(root, 'hearth-log-b', 0.12, 0.24, 0, 0.46, ember)
  cone(root, 'hearth-flame', 0.28, 0.46, [0, 0.48, 0], flame)
  return root
}

function buildTableRound() {
  const root = rootFor('table_round')
  const wood = material('table-round-wood', COLORS.wood)
  const light = material('table-round-edge', COLORS.woodLight)
  const dark = material('table-round-pedestal', COLORS.woodDark)
  cylinder(root, 'table-round-top', 0.78, 0.78, 0.1, [0, 0.69, 0], wood, 16)
  torus(root, 'table-round-rim', 0.73, 0.035, [0, 0.69, 0], light, [Math.PI / 2, 0, 0])
  for (const x of [-.46, -.15, .15, .46]) {
    const length = 2 * Math.sqrt(.78 ** 2 - x ** 2) - .025
    box(root, 'table-round-plank-seam', [.009, .006, length], [x, .742, 0], dark, [0, 0, 0], false)
  }
  cylinder(root, 'table-round-pedestal', 0.14, 0.19, 0.62, [0, 0.34, 0], dark, 12)
  cylinder(root, 'table-round-foot', 0.34, 0.3, 0.08, [0, 0.05, 0], dark, 12)
  emptyNode(root, 'surface-top', 0.75, { role: 'support-surface', clearForProps: true })
  return root
}

function buildTableSmall() {
  const root = rootFor('table_small')
  const wood = material('table-small-wood', COLORS.wood)
  const light = material('table-small-top', COLORS.woodLight)
  const dark = material('table-small-legs', COLORS.woodDark)
  const width = 0.82
  roundedBox(root, 'table-small-top', [width, 0.1, width], [0, 0.64, 0], light, 0.035)
  roundedBox(root, 'table-small-apron-front', [0.66, 0.17, 0.06], [0, 0.54, 0.32], wood, 0.018)
  roundedBox(root, 'table-small-apron-back', [0.66, 0.17, 0.06], [0, 0.54, -0.32], wood, 0.018)
  for (const x of [-0.29, 0.29]) for (const z of [-0.29, 0.29]) box(root, 'table-small-leg', [0.08, 0.58, 0.08], [x, 0.3, z], dark)
  for (const x of [-0.14, 0.14]) box(root, 'table-small-plank-seam', [0.018, 0.012, 0.7], [x, 0.698, 0], dark, undefined, false)
  emptyNode(root, 'surface-top', 0.7, { role: 'support-surface', clearForProps: true })
  return root
}

function buildAltar() {
  const root = rootFor('altar')
  const stone = material('altar-stone', COLORS.stone)
  const light = material('altar-top', COLORS.stoneLight)
  const dark = material('altar-carving', COLORS.stoneDark)
  const brass = material('altar-inlay', COLORS.brass, { metalness: 0.52, roughness: 0.48 })
  roundedBox(root, 'altar-base', [1.68, 0.44, 0.68], [0, 0.22, 0], stone, 0.055)
  roundedBox(root, 'altar-step', [1.84, 0.1, 0.78], [0, 0.49, 0], light, 0.035)
  roundedBox(root, 'altar-top', [1.7, 0.1, 0.72], [0, 0.59, 0], light, 0.035)
  box(root, 'altar-front-recess', [0.8, 0.2, 0.035], [0, 0.3, 0.36], dark, undefined, false)
  box(root, 'altar-carving-vertical', [0.045, 0.14, 0.04], [0, 0.3, 0.385], brass, undefined, false)
  box(root, 'altar-carving-horizontal', [0.2, 0.045, 0.04], [0, 0.3, 0.385], brass, undefined, false)
  cylinder(root, 'altar-censer', 0.1, 0.12, 0.08, [0.5, 0.68, 0], brass, 10)
  emptyNode(root, 'surface-top', 0.68, { role: 'support-surface', clearForProps: true })
  return root
}

function buildPillar() {
  const root = rootFor('pillar')
  const stone = material('pillar-stone', COLORS.stone)
  const light = material('pillar-capital', COLORS.stoneLight)
  const dark = material('pillar-groove', COLORS.stoneDark)
  cylinder(root, 'pillar-base', 0.34, 0.36, 0.12, [0, 0.06, 0], light, 12)
  cylinder(root, 'pillar-shaft', 0.23, 0.27, 1.15, [0, 0.68, 0], stone, 12)
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) box(root, 'pillar-flute', [0.035, 0.9, 0.035], [Math.cos(angle) * 0.24, 0.68, Math.sin(angle) * 0.24], dark, undefined, false)
  cylinder(root, 'pillar-capital', 0.34, 0.3, 0.14, [0, 1.3, 0], light, 12)
  box(root, 'pillar-abacus', [0.72, 0.1, 0.72], [0, 1.42, 0], light)
  return root
}

function buildSarcophagus() {
  const root = rootFor('sarcophagus')
  const stone = material('sarcophagus-stone', COLORS.stone)
  const light = material('sarcophagus-lid', COLORS.stoneLight)
  const dark = material('sarcophagus-carving', COLORS.stoneDark)
  const cavity = material('sarcophagus-cavity', COLORS.coal)
  const brass = material('sarcophagus-brass', COLORS.brass, { metalness: 0.5, roughness: 0.5 })
  roundedBox(root, 'sarcophagus-base', [1.72, 0.14, 0.76], [0, 0.07, 0], dark, 0.025)
  roundedBox(root, 'sarcophagus-bottom', [1.5, 0.1, 0.62], [0, 0.14, 0], cavity, 0.02, [0, 0, 0], false)
  roundedBox(root, 'sarcophagus-wall-front', [1.55, 0.34, 0.09], [0, 0.31, 0.3], stone, 0.025)
  roundedBox(root, 'sarcophagus-wall-back', [1.55, 0.34, 0.09], [0, 0.31, -0.3], stone, 0.025)
  roundedBox(root, 'sarcophagus-wall-left', [0.09, 0.34, 0.52], [-0.73, 0.31, 0], stone, 0.025)
  roundedBox(root, 'sarcophagus-wall-right', [0.09, 0.34, 0.52], [0.73, 0.31, 0], stone, 0.025)
  box(root, 'sarcophagus-interior', [1.36, 0.045, 0.5], [0, 0.2, 0], cavity, undefined, false)
  roundedBox(root, 'sarcophagus-foot-front', [1.68, 0.08, 0.08], [0, 0.5, 0.33], light, 0.025)
  roundedBox(root, 'sarcophagus-foot-back', [1.68, 0.08, 0.08], [0, 0.5, -0.33], light, 0.025)
  roundedBox(root, 'sarcophagus-foot-left', [0.08, 0.08, 0.58], [-0.8, 0.5, 0], light, 0.025)
  roundedBox(root, 'sarcophagus-foot-right', [0.08, 0.08, 0.58], [0.8, 0.5, 0], light, 0.025)
  const hinge = new THREE.Group()
  hinge.name = 'hinge-lid'
  hinge.position.set(0, 0.52, -0.27)
  // `pivot` зарезервирован GLTFLoader как числовой Vector3; role-поле нельзя
  // называть им, иначе загрузчик превратит строку в NaN-координаты.
  hinge.userData = { animated: true, pivotRole: 'rear-hinge' }
  root.add(hinge)
  box(hinge, 'sarcophagus-lid', [1.5, 0.16, 0.66], [0, 0.09, 0.28], light)
  box(hinge, 'lid-border-front', [1.3, 0.035, 0.04], [0, 0.19, 0.6], dark, undefined, false)
  box(hinge, 'lid-border-left', [0.04, 0.035, 0.55], [-0.66, 0.19, 0.28], dark, undefined, false)
  box(hinge, 'lid-border-right', [0.04, 0.035, 0.55], [0.66, 0.19, 0.28], dark, undefined, false)
  box(hinge, 'lid-carving-cross', [0.06, 0.04, 0.34], [0, 0.2, 0.3], brass, undefined, false)
  box(hinge, 'lid-carving-crossbar', [0.2, 0.04, 0.06], [0, 0.2, 0.3], brass, undefined, false)
  return root
}

function buildCryptNiche() {
  const root = rootFor('crypt_niche')
  const stone = material('niche-stone', COLORS.stone)
  const light = material('niche-trim', COLORS.stoneLight)
  const dark = material('niche-recess', COLORS.stoneDark)
  const candle = material('niche-candle', COLORS.ceramic)
  const width = 0.78, depth = 0.28
  box(root, 'niche-back', [width, 1.28, 0.08], [0, 0.67, -0.12], dark)
  for (const x of [-0.34, 0.34]) {
    box(root, 'niche-pilaster', [0.15, 1.22, depth], [x, 0.62, 0], stone)
    box(root, 'niche-capital', [0.2, 0.1, depth + 0.04], [x, 1.24, 0], light)
  }
  arch(root, 'niche', 0.2, 1.15, 0.31, depth, light)
  box(root, 'niche-sill', [0.64, 0.1, 0.36], [0, 0.08, 0], light)
  cylinder(root, 'niche-candle-left', 0.035, 0.04, 0.24, [-0.2, 0.25, 0.02], candle, 8)
  cylinder(root, 'niche-candle-right', 0.035, 0.04, 0.24, [0.2, 0.25, 0.02], candle, 8)
  return root
}

function buildBrazier() {
  const root = rootFor('brazier')
  const stone = material('brazier-stone', COLORS.stone)
  const iron = material('brazier-iron', COLORS.iron, { metalness: 0.6, roughness: 0.55 })
  const coal = material('brazier-coal', COLORS.coal)
  const ember = material('brazier-ember', COLORS.ember, { emissive: COLORS.ember, emissiveIntensity: 0.5 })
  const flame = material('brazier-flame', COLORS.flame, { emissive: COLORS.flame, emissiveIntensity: 0.85 })
  cylinder(root, 'brazier-foot', 0.3, 0.34, 0.12, [0, 0.06, 0], stone, 10)
  cylinder(root, 'brazier-stem', 0.1, 0.13, 0.5, [0, 0.34, 0], iron, 10)
  cylinder(root, 'brazier-bowl', 0.34, 0.27, 0.18, [0, 0.66, 0], iron, 12)
  torus(root, 'brazier-rim', 0.33, 0.035, [0, 0.76, 0], iron, [Math.PI / 2, 0, 0])
  cylinder(root, 'brazier-coal-bed', 0.23, 0.23, 0.04, [0, 0.78, 0], coal, 10, undefined, false)
  for (const [x, z] of [[-0.1, 0], [0.1, 0.03], [0, 0.1]]) sphere(root, 'brazier-ember', [0.08, 0.055, 0.07], [x, 0.82, z], ember, false)
  cylinder(root, 'brazier-flame', 0, 0.2, 0.36, [0, 1.0, 0], flame, 7, undefined, false)
  return root
}

function buildReliquary() {
  const root = rootFor('reliquary')
  const stone = material('reliquary-stone', COLORS.stone)
  const light = material('reliquary-trim', COLORS.stoneLight)
  const iron = material('reliquary-metal', COLORS.ironLight, { metalness: 0.58, roughness: 0.5 })
  const glass = material('reliquary-glass', COLORS.glass, { transparent: true, opacity: 0.62, roughness: 0.22 })
  const brass = material('reliquary-lock', COLORS.brass, { metalness: 0.55, roughness: 0.45 })
  box(root, 'reliquary-base', [0.72, 0.12, 0.5], [0, 0.06, 0], stone)
  box(root, 'reliquary-body', [0.58, 0.58, 0.4], [0, 0.4, 0], light)
  box(root, 'reliquary-window', [0.35, 0.28, 0.025], [0, 0.43, 0.21], glass, undefined, false)
  for (const x of [-0.29, 0.29]) box(root, 'reliquary-band', [0.045, 0.62, 0.44], [x, 0.4, 0], iron, undefined, false)
  box(root, 'reliquary-roof', [0.68, 0.12, 0.48], [0, 0.76, 0], stone)
  box(root, 'reliquary-lock', [0.08, 0.12, 0.04], [0, 0.4, 0.235], brass, undefined, false)
  cylinder(root, 'reliquary-finial', 0.07, 0.08, 0.16, [0, 0.9, 0], brass, 8)
  return root
}

/** @param {string} assetId @returns {THREE.Group} */
export function createInteriorModel(assetId) {
  if (!SPEC_BY_ASSET.has(assetId)) throw new Error(`Неизвестная интерьерная модель: ${assetId}`)
  switch (assetId) {
    case 'bar_counter': return buildBarCounter()
    case 'bar_shelf': return buildBarShelf()
    case 'fireplace': return buildFireplace()
    case 'hearth_fire': return buildHearthFire()
    case 'table_round': return buildTableRound()
    case 'table_small': return buildTableSmall()
    case 'altar': return buildAltar()
    case 'pillar': return buildPillar()
    case 'sarcophagus': return buildSarcophagus()
    case 'crypt_niche': return buildCryptNiche()
    case 'brazier': return buildBrazier()
    case 'reliquary': return buildReliquary()
    default: throw new Error(`Нет рецепта интерьерной модели: ${assetId}`)
  }
}

/** @param {THREE.Object3D} object */
export function disposeInteriorModel(object) {
  const geometries = new Set()
  const materials = new Set()
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    geometries.add(child.geometry)
    for (const value of Array.isArray(child.material) ? child.material : [child.material]) materials.add(value)
  })
  for (const value of materials) value.dispose()
  for (const value of geometries) value.dispose()
}

function inAnimatedOrSupportSubtree(object) {
  let current = object
  while (current) {
    if (current.name === 'surface-top' || current.name === 'hinge-lid') return true
    current = current.parent
  }
  return false
}

/**
 * Сводит неподвижные соседние меши по общему материалу. Именованные узлы,
 * которые являются API для последующего размещения и анимации, намеренно
 * обходятся целиком.
 *
 * @param {THREE.Object3D} root
 */
export function mergeStaticInteriorMeshes(root) {
  const parents = new Set()
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && object.parent && !inAnimatedOrSupportSubtree(object)) parents.add(object.parent)
  })
  for (const parent of parents) {
    const byMaterial = new Map()
    for (const child of [...parent.children]) {
      if (!(child instanceof THREE.Mesh) || child.children.length || inAnimatedOrSupportSubtree(child)) continue
      const values = Array.isArray(child.material) ? [] : [child.material]
      for (const value of values) {
        const meshes = byMaterial.get(value) ?? []
        meshes.push(child)
        byMaterial.set(value, meshes)
      }
    }
    for (const [value, meshes] of byMaterial) {
      if (meshes.length < 2) continue
      const geometries = meshes.map((mesh) => {
        mesh.updateMatrix()
        const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
        geometry.applyMatrix4(mesh.matrix)
        return geometry
      })
      const merged = mergeGeometries(geometries, false)
      if (!merged) {
        geometries.forEach((geometry) => geometry.dispose())
        continue
      }
      const mergedMesh = new THREE.Mesh(merged, value)
      mergedMesh.name = `${parent.name || 'interior'}-static-${value.name || 'material'}`
      mergedMesh.castShadow = meshes.some((mesh) => mesh.castShadow)
      mergedMesh.receiveShadow = meshes.some((mesh) => mesh.receiveShadow)
      parent.add(mergedMesh)
      for (const mesh of meshes) {
        parent.remove(mesh)
        mesh.geometry.dispose()
      }
    }
  }
  return root
}

function texturePng(kind) {
  const width = 128
  const height = 128
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const wave = kind === 'wood'
      ? 7 * Math.sin((x + 5 * Math.sin(y / 19)) / 8) + 3 * Math.sin(y / 9)
      : 4 * Math.sin(x / 13) + 3 * Math.sin(y / 17) + 2 * Math.sin((x + y) / 23)
    const seam = kind === 'wood' && y % 32 < 2 ? -7 : kind === 'stone' && (x % 43 < 1 || y % 37 < 1) ? -4 : 0
    const value = Math.max(0, Math.min(255, Math.round((kind === 'wood' ? 210 : 190) + wave + seam)))
    const index = (y * width + x) * 4
    data[index] = value
    data[index + 1] = value
    data[index + 2] = value
    data[index + 3] = 255
  }
  return encodePng({ width, height, data })
}

function textureMaterial(name, kind) {
  if (kind === 'wood') return /wood|^table-(?:round|small)/iu.test(name)
  return /stone|trim|^altar-top|sarcophagus-(?:lid|carving)|pillar-(?:capital|groove)|niche-recess/iu.test(name)
}

function glbParts(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error('Ожидался GLB 2')
  const length = bytes.readUInt32LE(8)
  if (length !== bytes.length) throw new Error('Длина GLB не совпадает с заголовком')
  let offset = 12
  let json = null
  let binary = null
  while (offset + 8 <= length) {
    const chunkLength = bytes.readUInt32LE(offset)
    const chunkType = bytes.readUInt32LE(offset + 4)
    const end = offset + 8 + chunkLength
    if (end > length) throw new Error('Повреждённый chunk GLB')
    if (chunkType === 0x4e4f534a) json = JSON.parse(bytes.toString('utf8', offset + 8, end).trim())
    if (chunkType === 0x004e4942) binary = bytes.subarray(offset + 8, end)
    offset = end
  }
  if (!json || !binary) throw new Error('GLB должен иметь JSON и BIN chunk')
  return { json, binary }
}

/** @param {Buffer} bytes @param {'wood'|'stone'} kind */
export function embedInteriorTexture(bytes, kind) {
  const { json, binary } = glbParts(bytes)
  const image = texturePng(kind)
  const declaredLength = Number(json.buffers?.[0]?.byteLength)
  const imageOffset = Number.isSafeInteger(declaredLength) ? Math.max(declaredLength, binary.length) : binary.length
  const paddedPrefix = Buffer.alloc(imageOffset - binary.length)
  const imagePadded = Buffer.concat([image, Buffer.alloc((4 - image.length % 4) % 4)])
  const nextBinary = Buffer.concat([binary, paddedPrefix, imagePadded])
  json.buffers ??= [{}]
  json.buffers[0].byteLength = imageOffset + image.length
  json.bufferViews ??= []
  const imageView = json.bufferViews.length
  json.bufferViews.push({ buffer: 0, byteOffset: imageOffset, byteLength: image.length })
  json.images ??= []
  const imageIndex = json.images.length
  json.images.push({ name: `skazanie-${kind}-grain-v${GENERATOR_VERSION}`, bufferView: imageView, mimeType: 'image/png' })
  json.textures ??= []
  const textureIndex = json.textures.length
  json.textures.push({ name: `skazanie-${kind}-grain-v${GENERATOR_VERSION}`, source: imageIndex })
  let textured = 0
  for (const materialValue of json.materials ?? []) {
    if (textureMaterial(String(materialValue.name ?? ''), kind)) {
      materialValue.pbrMetallicRoughness ??= {}
      materialValue.pbrMetallicRoughness.baseColorTexture = { index: textureIndex }
      textured += 1
    }
  }
  if (!textured && json.materials?.[0]) {
    json.materials[0].pbrMetallicRoughness ??= {}
    json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: textureIndex }
  }
  const jsonChunk = Buffer.from(JSON.stringify(json))
  const jsonPadded = Buffer.concat([jsonChunk, Buffer.alloc((4 - jsonChunk.length % 4) % 4, 0x20)])
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(nextBinary.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonPadded.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + jsonHeader.length + jsonPadded.length + binHeader.length + nextBinary.length, 8)
  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, nextBinary])
}

/** @param {string} assetId @returns {Promise<Buffer>} */
export async function exportInteriorModel(assetId) {
  ensureFileReader()
  const model = createInteriorModel(assetId)
  const scene = new THREE.Scene()
  scene.name = 'skazanie-interior-export'
  mergeStaticInteriorMeshes(model)
  scene.add(model)
  try {
    const output = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true, trs: true })
    if (!(output instanceof ArrayBuffer)) throw new Error('GLTFExporter вернул текст вместо GLB')
    return embedInteriorTexture(Buffer.from(output), TEXTURE_KIND[assetId])
  } finally {
    disposeInteriorModel(scene)
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

async function writeIfAbsent(path, bytes) {
  await assertWritableFile(path, 'Файл кандидата')
  const existing = await readFile(path).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    if (!existing.equals(bytes)) throw new Error(`Существующий GLB отличается: ${path}`)
    return false
  }
  await writeFile(path, bytes, { flag: 'wx' })
  return true
}

async function assertWritableFile(path, label, required = false) {
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (!info) {
    if (required) throw new Error(`${label} не найден: ${path}`)
    return null
  }
  if (info.isSymbolicLink()) throw new Error(`${label} не может быть symlink/junction: ${path}`)
  if (!info.isFile()) throw new Error(`${label} должен быть обычным файлом: ${path}`)
  if (info.nlink > 1) throw new Error(`${label} не может быть hardlink (nlink=${info.nlink}): ${path}`)
  return info
}

async function assertCandidateDirectory(path, label) {
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error(`${label} должен быть обычным каталогом: ${path}`)
  return info
}

async function replaceFileAtomically(path, bytes) {
  const pending = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(pending, 'wx')
  let closed = false
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    closed = true
    await rename(pending, path)
  } finally {
    if (!closed) await handle.close().catch(() => {})
    await rm(pending, { force: true }).catch(() => {})
  }
}

/**
 * Добавляет оригинальные модели в уже подготовленный candidate. Кандидат
 * остаётся неактивным: после этого внешний рендерер должен добавить preview,
 * затем models:check заново запечатает receipt.
 *
 * @param {string} directory
 * @returns {Promise<{directory:string,added:string[],manifest:Record<string,unknown>,receiptStale:boolean}>}
 */
export async function addInteriorModelsToCandidate(directory) {
  const candidate = await validateCandidateOutputDir(directory, { requireExisting: true })
  const manifestPath = join(candidate, 'manifest.json')
  await assertWritableFile(manifestPath, 'manifest.json', true)
  const manifest = object(JSON.parse((await readFile(manifestPath)).toString('utf8')))
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.models)) throw new Error('Нужен candidate manifest version 1 с models')
  const build = object(manifest.build)
  if (!build || build.schema !== 'environment-candidate/v1' || !Array.isArray(build.sourceInputs)) throw new Error('Candidate не содержит build/sourceInputs')
  const models = manifest.models
  const modelKeys = new Set(models.flatMap((value) => object(value)?.key).filter((value) => typeof value === 'string'))
  const modelUrls = new Set(models.flatMap((value) => object(value)?.url).filter((value) => typeof value === 'string'))
  const familyDir = join(candidate, FAMILY)
  await assertCandidateDirectory(familyDir, 'Каталог skazanie')
  const familyFiles = ['LICENSE.txt', 'NOTICE.txt', ...INTERIOR_MODELS.map((item) => item.file)]
  await Promise.all(familyFiles.map((file) => assertWritableFile(join(familyDir, file), `Файл ${file}`)))
  const generated = await Promise.all(INTERIOR_MODELS.map(async (item) => ({ item, bytes: await exportInteriorModel(item.assetId) })))
  await mkdir(familyDir, { recursive: true })
  await assertCandidateDirectory(familyDir, 'Каталог skazanie')
  await writeIfAbsent(join(familyDir, 'LICENSE.txt'), Buffer.from('Оригинальные процедурные модели проекта «Сказание».\nИсточник: tools/build-interior-models.mjs.\nУсловия использования определяет владелец проекта; это не сторонний набор CC0.\n'))
  await writeIfAbsent(join(familyDir, 'NOTICE.txt'), Buffer.from(`Созданы из собственных геометрических рецептов проекта.\nГенератор: ${GENERATOR_VERSION}; SHA-256: ${GENERATOR_SHA256}.\nЭкспорт: Three.js r${THREE.REVISION}, GLTFExporter.\nМодели Quaternius и Kenney не изменяются и сохраняют собственные лицензии.\n`))
  const added = []
  for (const { item, bytes } of generated) {
    const url = `${URL_ROOT}${FAMILY}/${item.file}`
    const expected = { key: item.key, label: item.label, category: item.category, url, assetIds: [item.assetId], yaw: item.yaw }
    const existing = models.find((value) => object(value)?.key === item.key)
    if (existing) {
      const value = object(existing)
      if (!value || value.label !== expected.label || value.category !== expected.category || value.url !== expected.url
        || value.yaw !== expected.yaw || JSON.stringify(value.assetIds) !== JSON.stringify(expected.assetIds)) throw new Error(`Ключ модели уже занят другой записью: ${item.key}`)
    } else {
      if (modelUrls.has(url)) throw new Error(`URL модели уже занят: ${url}`)
      if (modelKeys.has(item.key)) throw new Error(`Ключ модели уже занят: ${item.key}`)
      models.push(expected)
      modelKeys.add(item.key); modelUrls.add(url)
    }
    const output = join(familyDir, item.file)
    if (await writeIfAbsent(output, bytes)) added.push(item.assetId)
  }
  const sources = Array.isArray(manifest.sources) ? [...manifest.sources] : []
  if (!sources.some((value) => object(value)?.url === 'internal://skazanie/interior-models')) {
    sources.push({ url: 'internal://skazanie/interior-models', license: 'ORIGINAL', author: 'Сказание' })
  }
  const sourceInputs = build.sourceInputs
    .filter((value) => object(value)?.path !== GENERATOR_SOURCE.path)
    .concat([GENERATOR_SOURCE])
    .sort((left, right) => String(object(left)?.path ?? '').localeCompare(String(object(right)?.path ?? '')))
  manifest.sources = sources
  manifest.models = models
  manifest.build = {
    ...build,
    interiorBuilderVersion: GENERATOR_VERSION,
    interiorGeneratorSha256: GENERATOR_SHA256,
    interiorModels: INTERIOR_MODELS.map(({ assetId, key }) => ({ assetId, key })),
    sourceInputs,
  }
  await replaceFileAtomically(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
  const receiptPath = join(candidate, 'receipt.json')
  return { directory: candidate, added, manifest, receiptStale: Boolean(await lstat(receiptPath).catch(() => null)) }
}

/** Псевдоним операции сборки для программных потребителей. */
export const buildInteriorModels = addInteriorModelsToCandidate

async function main() {
  const { values, positionals } = parseArgs({ options: { dir: { type: 'string' } }, allowPositionals: true })
  if (positionals.length || !values.dir) throw new Error('Используйте --dir <каталог-кандидат>')
  const result = await addInteriorModelsToCandidate(values.dir)
  process.stdout.write(`${JSON.stringify({ directory: result.directory, added: result.added, models: INTERIOR_MODELS.length, generatorSha256: GENERATOR_SHA256, receiptStale: result.receiptStale }, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
