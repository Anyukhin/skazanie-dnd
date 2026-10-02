/** Авторские игровые модели шахты и военного лагеря для листов 15–16. */
import { Model, THREE } from './map-detail-model-helpers.mjs'

const PI = Math.PI

const C = Object.freeze({
  wood: '#684a32',
  woodLight: '#9a7147',
  woodDark: '#3c2b22',
  rope: '#65513a',
  iron: '#414442',
  ironLight: '#777269',
  brass: '#9a7541',
  stone: '#686861',
  gravel: '#777269',
  obsidian: '#25292b',
  obsidianLight: '#3d4141',
  moss: '#536048',
  crystalBlue: '#516e86',
  crystalViolet: '#69577d',
  crystalLight: '#7689a0',
  fungusStem: '#9a8b68',
  fungusStemDark: '#615843',
  fungusRed: '#814f45',
  fungusOchre: '#9a7849',
  fungusPurple: '#68536f',
  canvas: '#7b6d55',
  canvasLight: '#a08b63',
  canvasDark: '#4f4a3d',
  leather: '#6f4b39',
  straw: '#aa8d50',
})

/** Приводит готовую модель к единому контракту фабрик. */
function root(model) {
  model.root.updateMatrixWorld(true)
  return model.root
}

function addTube(model, name, points, radius, color, tubularSegments = 12, radialSegments = 6) {
  const curve = new THREE.CatmullRomCurve3(
    points.map(point => new THREE.Vector3(...point)),
    false,
    'centripetal',
  )
  return model.mesh(name, new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false), [0, 0, 0], color)
}

/** Неровный многогранник с разными радиусами колец даёт кристаллу сколы. */
function createFacetedCrystalGeometry(radius, height, phase = 0) {
  const sides = 6
  const levels = [
    [0, 0.84], [height * 0.16, 1.04], [height * 0.78, 0.78], [height, 0.10],
  ]
  const positions = []
  for (const [y, scale] of levels) {
    for (let index = 0; index < sides; index += 1) {
      const angle = phase + index * PI * 2 / sides
      const wobble = 1 + 0.08 * Math.sin(index * 2.3 + phase * 4)
      positions.push(Math.cos(angle) * radius * scale * wobble, y, Math.sin(angle) * radius * scale * wobble)
    }
  }
  const indices = []
  for (let level = 0; level < levels.length - 1; level += 1) {
    for (let index = 0; index < sides; index += 1) {
      const next = (index + 1) % sides
      const a = level * sides + index
      const b = level * sides + next
      const c = (level + 1) * sides + next
      const d = (level + 1) * sides + index
      indices.push(a, b, d, b, c, d)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function addRivetRow(model, name, points, color = C.ironLight) {
  for (const [index, point] of points.entries()) {
    model.mesh(`${name}-${index}`, new THREE.DodecahedronGeometry(0.045, 0), point, color)
  }
}

function buildRopeBridge() {
  const m = new Model('rope_bridge')
  // Поперечные доски дают мосту читаемый ритм, а не вид плоской полосы.
  for (let index = 0; index < 7; index += 1) {
    const z = -0.52 + index * 0.17
    m.box('bridge-plank', [2.35, 0.10, 0.14], [0, 0.10, z], index % 2 ? C.woodLight : C.wood, [0, 0, (index % 3 - 1) * 0.025])
  }
  for (const x of [-1.08, 1.08]) {
    for (const z of [-0.58, 0.58]) m.beam('bridge-post', [x, 0.10, z], [x, 0.67, z], 0.045, C.rope)
    addTube(m, 'bridge-upper-rope', [[x, 0.67, -0.58], [x, 0.75, -0.22], [x, 0.69, 0.18], [x, 0.67, 0.58]], 0.035, C.rope, 12, 7)
    addTube(m, 'bridge-lower-rope', [[x, 0.27, -0.55], [x, 0.23, -0.18], [x, 0.24, 0.22], [x, 0.27, 0.55]], 0.025, C.rope, 10, 6)
    for (const z of [-0.58, 0.58]) {
      m.sphere('bridge-knot', [0.10, 0.10, 0.10], [x, 0.67, z], C.rope)
      m.torus('bridge-lashing', 0.07, 0.015, [x, 0.33, z], C.rope, [0, PI / 2, 0])
    }
  }
  // Два несущих каната проходят под досками и принимают их вес, поэтому
  // настил не висит отдельными плитками на перилах.
  for (const x of [-0.88, 0.88]) {
    addTube(m, 'bridge-under-cable', [[x, 0.10, -0.58], [x, 0.04, -0.18], [x, 0.04, 0.22], [x, 0.10, 0.58]], 0.042, C.rope, 12, 7)
    for (let index = 0; index < 7; index += 1) {
      const z = -0.52 + index * 0.17
      m.torus('bridge-plank-lashing', 0.055, 0.012, [x, 0.115, z], C.rope, [PI / 2, 0, 0])
    }
  }
  for (const z of [-0.58, 0.58]) {
    addTube(m, 'bridge-end-anchor', [[-1.10, 0.24, z], [-1.30, 0.16, z], [-1.42, 0.08, z]], 0.035, C.rope, 8, 6)
    addTube(m, 'bridge-end-anchor', [[1.10, 0.24, z], [1.30, 0.16, z], [1.42, 0.08, z]], 0.035, C.rope, 8, 6)
    m.cylinder('bridge-anchor-stake', 0.035, 0.055, 0.24, [-1.42, 0.12, z], C.woodDark, 8)
    m.cylinder('bridge-anchor-stake', 0.035, 0.055, 0.24, [1.42, 0.12, z], C.woodDark, 8)
  }
  return root(m)
}

function buildMineRail() {
  const m = new Model('mine_rail')
  m.slab('rail-ballast', 2.68, 0.98, 0.06, [0, 0.04, 0], C.gravel)
  for (const x of [-1.12, -0.80, -0.48, -0.16, 0.16, 0.48, 0.80, 1.12]) {
    m.box('rail-sleeper', [0.18, 0.07, 0.94], [x, 0.10, 0], C.woodDark)
    for (const z of [-0.31, 0.31]) {
      // Скоба обходит подошву рельса и крепится к той же шпале двумя болтами.
      m.box('rail-sleeper-clip', [0.035, 0.09, 0.18], [x - 0.09, 0.205, z], C.iron)
      addRivetRow(m, 'rail-clip-bolt', [[x - 0.09, 0.255, z - 0.055], [x - 0.09, 0.255, z + 0.055]], C.ironLight)
    }
  }
  for (const z of [-0.31, 0.31]) {
    m.box('iron-rail', [2.62, 0.08, 0.08], [0, 0.18, z], C.iron)
    m.box('rail-cap', [2.48, 0.035, 0.045], [0, 0.235, z], C.ironLight)
    for (const x of [-0.98, -0.64, -0.30, 0.04, 0.38, 0.72, 1.06]) {
      m.box('rail-foot-plate', [0.14, 0.035, 0.16], [x, 0.205, z], C.ironLight)
      addRivetRow(m, 'rail-rivet', [[x - 0.045, 0.235, z], [x + 0.045, 0.235, z]], C.iron)
    }
  }
  for (const x of [-1.31, 0, 1.31]) {
    m.box('rail-joint-plate', [0.08, 0.12, 0.44], [x, 0.19, 0], C.ironLight)
    addRivetRow(m, 'rail-joint-rivet', [[x, 0.27, -0.21], [x, 0.27, 0.21]], C.iron)
  }
  for (const [x, z, size] of [[-1.12, -0.43, 0.12], [-0.72, 0.42, 0.14], [-0.30, -0.43, 0.10], [0.12, 0.43, 0.13], [0.62, -0.43, 0.14], [1.06, 0.43, 0.10]]) {
    const stone = m.mesh('ballast-stone', new THREE.DodecahedronGeometry(size, 0), [x, 0.16, z], C.stone)
    stone.scale.set(1, 0.65, 0.8)
  }
  return root(m)
}

function buildMineCart() {
  const m = new Model('mine_cart')
  m.box('cart-floor', [0.92, 0.13, 0.78], [0, 0.42, 0.06], C.woodDark)
  m.box('cart-front', [1.02, 0.46, 0.10], [0, 0.68, -0.37], C.wood)
  m.box('cart-back', [1.02, 0.40, 0.10], [0, 0.65, 0.43], C.woodDark)
  for (const x of [-0.48, 0.48]) m.box('cart-side', [0.10, 0.43, 0.82], [x, 0.67, 0.04], C.wood)
  m.box('cart-rim-front', [1.12, 0.09, 0.12], [0, 0.94, -0.40], C.woodLight)
  m.box('cart-rim-back', [1.12, 0.09, 0.12], [0, 0.88, 0.44], C.woodLight)
  for (const z of [-0.39, 0.44]) {
    m.box('cart-iron-band', [1.06, 0.06, 0.045], [0, 0.70, z], C.iron)
    addRivetRow(m, 'cart-band-rivet', [[-0.39, 0.70, z], [0.39, 0.70, z]], C.ironLight)
  }
  for (const x of [-0.48, 0.48]) {
    m.box('cart-side-bracket', [0.04, 0.34, 0.13], [x, 0.64, -0.39], C.iron)
    m.box('cart-side-bracket', [0.04, 0.34, 0.13], [x, 0.64, 0.44], C.iron)
  }
  for (const [x, y, z, size, color] of [[-0.24, 1.02, 0.04, 0.26, C.ironLight], [0.05, 1.08, 0.13, 0.30, C.stone], [0.27, 1.00, -0.10, 0.24, C.iron], [-0.04, 1.18, -0.08, 0.19, C.ironLight]]) {
    const ore = m.mesh('ore-lump', new THREE.DodecahedronGeometry(size, 0), [x, y, z], color)
    ore.rotation.set(0.1 * x, 0.2 * z, -0.08)
    ore.scale.set(1, 0.85, 0.92)
  }
  for (const x of [-0.62, 0.62]) for (const z of [-0.27, 0.31]) {
    m.cylinder('cart-wheel', 0.22, 0.22, 0.12, [x, 0.26, z], C.iron, 10, [0, 0, PI / 2])
    m.cylinder('wheel-hub', 0.07, 0.07, 0.14, [x, 0.26, z], C.ironLight, 8, [0, 0, PI / 2])
    for (const angle of [0, PI / 2, PI, PI * 1.5]) {
      m.beam('cart-wheel-spoke', [x, 0.26, z], [x, 0.26 + Math.cos(angle) * 0.15, z + Math.sin(angle) * 0.15], 0.018, C.ironLight)
    }
  }
  for (const z of [-0.27, 0.31]) {
    // Оси проходят сквозь ступицы и связывают колёса с корпусом вагонетки.
    m.cylinder('cart-axle-through', 0.058, 0.058, 1.60, [0, 0.26, z], C.iron, 16, [0, 0, PI / 2])
    m.cylinder('cart-axle-collar', 0.09, 0.09, 0.06, [-0.50, 0.26, z], C.ironLight, 10, [0, 0, PI / 2])
    m.cylinder('cart-axle-collar', 0.09, 0.09, 0.06, [0.50, 0.26, z], C.ironLight, 10, [0, 0, PI / 2])
    for (const x of [-0.64, 0.64]) {
      m.cylinder('cart-wheel-washer', 0.105, 0.105, 0.045, [x, 0.26, z], C.ironLight, 12, [0, 0, PI / 2])
    }
  }
  m.beam('cart-coupling', [0, 0.31, -0.43], [0, 0.31, -0.70], 0.045, C.iron)
  m.box('cart-coupling-mount', [0.22, 0.16, 0.10], [0, 0.45, -0.42], C.iron)
  m.beam('cart-coupling-mount-brace', [0, 0.32, -0.42], [0, 0.48, -0.42], 0.040, C.iron)
  m.torus('coupling-ring', 0.10, 0.025, [0, 0.31, -0.70], C.ironLight, [PI / 2, 0, 0])
  m.beam('cart-dump-handle', [0.56, 0.72, 0.12], [0.72, 0.95, 0.12], 0.035, C.woodDark)
  m.torus('cart-dump-handle-grip', 0.065, 0.018, [0.76, 0.99, 0.12], C.ironLight, [PI / 2, 0, 0])
  return root(m)
}

function buildTimberShoring() {
  const m = new Model('timber_shoring')
  for (const x of [-1.14, 1.14]) {
    m.beam('shoring-post', [x, 0.05, 0], [x, 2.28, 0], 0.105, C.wood)
    m.box('shoring-foot', [0.30, 0.10, 0.42], [x, 0.06, 0], C.woodDark)
    m.box('shoring-nail-plate', [0.25, 0.32, 0.035], [x, 1.56, -0.11], C.iron)
  }
  m.beam('shoring-crossbeam', [-1.22, 2.10, 0], [1.22, 2.10, 0], 0.12, C.woodLight)
  m.beam('shoring-crossbeam-back', [-1.22, 1.94, 0.16], [1.22, 1.94, 0.16], 0.075, C.woodDark)
  m.beam('shoring-brace-left', [-1.12, 0.65, -0.02], [-0.72, 2.04, -0.02], 0.055, C.woodDark)
  m.beam('shoring-brace-right', [1.12, 0.65, -0.02], [0.72, 2.04, -0.02], 0.055, C.woodDark)
  // Задняя пара раскосов замыкает раму по глубине и передаёт нагрузку на стойки.
  m.beam('shoring-back-brace-left', [-1.10, 0.62, 0.14], [-0.72, 2.00, 0.14], 0.048, C.wood)
  m.beam('shoring-back-brace-right', [1.10, 0.62, 0.14], [0.72, 2.00, 0.14], 0.048, C.wood)
  for (const x of [-1.14, 1.14]) {
    for (const y of [0.20, 2.10]) {
      m.box('shoring-iron-collar', [0.28, 0.07, 0.30], [x, y, -0.09], C.iron)
      addBallistaBolt(m, 'shoring-collar-bolt', x - 0.07, y, -0.14)
      addBallistaBolt(m, 'shoring-collar-bolt', x + 0.07, y, -0.14)
    }
    m.box('shoring-wedge', [0.26, 0.12, 0.38], [x + (x < 0 ? 0.17 : -0.17), 0.16, -0.02], C.woodLight, [0, 0, x < 0 ? -0.18 : 0.18])
  }
  for (const x of [-1.14, 1.14]) {
    addTube(m, 'shoring-rope-lashing', [[x - 0.12, 0.14, -0.14], [x + 0.12, 0.14, -0.14], [x + 0.12, 0.28, -0.14], [x - 0.12, 0.28, -0.14]], 0.018, C.rope, 8, 5)
  }
  return root(m)
}

function addCrystal(m, name, x, z, height, radius, color, rotation) {
  const shard = m.mesh(name, createFacetedCrystalGeometry(radius, height), [x, 0.07, z], color, rotation)
  shard.rotation.set(...rotation)
  m.mesh(`${name}-base`, new THREE.DodecahedronGeometry(radius * 0.96, 0), [x, 0.08, z], C.stone).scale.set(1.15, 0.20, 1.05)
}

function buildCrystalCluster() {
  const m = new Model('crystal_cluster')
  m.slab('crystal-rubble', 1.08, 0.98, 0.07, [0, 0.035, 0], C.gravel)
  addCrystal(m, 'crystal-tall', -0.20, 0.06, 1.62, 0.22, C.crystalBlue, [-0.08, 0.08, -0.07])
  addCrystal(m, 'crystal-violet', 0.32, 0.08, 1.20, 0.25, C.crystalViolet, [0.10, -0.05, 0.10])
  addCrystal(m, 'crystal-left', -0.52, -0.20, 0.92, 0.20, C.crystalLight, [0.12, 0, -0.16])
  addCrystal(m, 'crystal-front', 0.02, -0.34, 0.78, 0.20, C.crystalViolet, [-0.12, 0.06, 0.04])
  addCrystal(m, 'crystal-back', 0.56, 0.34, 0.78, 0.16, C.crystalBlue, [0.05, -0.12, 0.14])
  // Малые осколки выходят из того же щебня и визуально связывают основания.
  addCrystal(m, 'crystal-chip-left', -0.73, -0.02, 0.38, 0.085, C.crystalBlue, [-0.18, 0.03, -0.12])
  addCrystal(m, 'crystal-chip-right', 0.75, 0.20, 0.32, 0.075, C.crystalViolet, [0.12, -0.08, 0.14])
  addTube(m, 'crystal-mineral-vein', [[-0.66, 0.11, -0.40], [-0.36, 0.14, -0.27], [-0.10, 0.12, -0.34]], 0.014, C.crystalLight, 8, 5)
  for (const [x, z, size] of [[-0.74, 0.22, 0.10], [0.67, -0.12, 0.12], [-0.24, -0.50, 0.09], [0.42, 0.48, 0.08]]) {
    const stone = m.mesh('crystal-stone', new THREE.DodecahedronGeometry(size, 0), [x, 0.10, z], C.stone)
    stone.scale.set(1, 0.7, 0.9)
  }
  return root(m)
}

function createMushroomCapGeometry(radius) {
  const profile = [
    new THREE.Vector2(0, 0.01),
    new THREE.Vector2(radius * 0.34, 0.015),
    new THREE.Vector2(radius * 0.78, 0.07),
    new THREE.Vector2(radius, 0.17),
    new THREE.Vector2(radius * 0.94, 0.25),
    new THREE.Vector2(radius * 0.55, 0.30),
    new THREE.Vector2(0, 0.33),
  ]
  const geometry = new THREE.LatheGeometry(profile, 18)
  geometry.computeVertexNormals()
  return geometry
}

function addMushroom(m, name, x, z, stemHeight, capRadius, stemColor, capColor) {
  m.cylinder(`${name}-stem`, capRadius * 0.22, capRadius * 0.30, stemHeight, [x, stemHeight / 2, z], stemColor, 8)
  m.mesh(`${name}-cap`, createMushroomCapGeometry(capRadius), [x, stemHeight, z], capColor)
  m.torus(`${name}-gills`, capRadius * 0.55, 0.035, [x, stemHeight + 0.035, z], C.fungusStemDark, [PI / 2, 0, 0])
  m.torus(`${name}-cap-seam`, capRadius * 0.84, 0.014, [x, stemHeight + 0.15, z], C.fungusStemDark, [PI / 2, 0, 0])
  for (let index = 0; index < 6; index += 1) {
    const angle = index * PI / 3
    m.beam(`${name}-gill-rib`, [x, stemHeight + 0.04, z], [x + Math.cos(angle) * capRadius * 0.74, stemHeight + 0.06, z + Math.sin(angle) * capRadius * 0.74], 0.009, C.fungusStemDark)
  }
  for (let index = 0; index < 4; index += 1) {
    const angle = PI / 4 + index * PI / 2
    m.beam(`${name}-root-flare`, [x, 0.08, z], [x + Math.cos(angle) * capRadius * 0.42, 0.055, z + Math.sin(angle) * capRadius * 0.42], 0.028, stemColor)
  }
  for (const [offsetX, offsetZ] of [[-0.24, -0.08], [0.16, 0.10], [0.04, -0.22]]) {
    m.sphere(`${name}-cap-spot`, [capRadius * 0.07, capRadius * 0.025, capRadius * 0.07], [x + offsetX * capRadius, stemHeight + 0.30, z + offsetZ * capRadius], C.fungusStemDark)
  }
}

function buildGiantFungus() {
  const m = new Model('giant_fungus')
  addMushroom(m, 'fungus-left', -0.82, 0.10, 1.40, 0.44, C.fungusStem, C.fungusRed)
  addMushroom(m, 'fungus-center', 0.05, -0.18, 1.76, 0.54, C.fungusStemDark, C.fungusOchre)
  addMushroom(m, 'fungus-right', 0.78, 0.27, 1.02, 0.36, C.fungusStem, C.fungusPurple)
  // Небольшие камни у ножек читаются как пещерный щебень, а не подложка.
  for (const [x, z] of [[-1.08, -0.20], [-0.40, 0.45], [0.38, 0.42], [1.05, -0.08]]) {
    const stone = m.mesh('fungus-stone', new THREE.DodecahedronGeometry(0.14, 0), [x, 0.07, z], C.stone)
    stone.scale.set(1, 0.58, 0.82)
  }
  return root(m)
}

function buildObsidianMonolith() {
  const m = new Model('obsidian_monolith')
  m.slab('monolith-foot', 1.02, 0.82, 0.12, [0, 0.06, 0], C.obsidianLight)
  m.cylinder('monolith-base', 0.48, 0.55, 0.82, [0, 0.41, 0], C.obsidian, 7, [0.03, 0.05, -0.04])
  m.cylinder('monolith-middle', 0.34, 0.46, 0.92, [0.05, 1.28, 0.02], C.obsidianLight, 6, [-0.04, -0.10, 0.08])
  m.cylinder('monolith-top', 0.18, 0.35, 0.92, [-0.04, 2.20, -0.01], C.obsidian, 6, [0.07, 0.02, -0.06])
  m.torus('monolith-foot-ring', 0.46, 0.025, [0, 0.12, 0], C.obsidianLight, [PI / 2, 0, 0])
  for (const [x, y, z, size, rotation] of [
    [-0.47, 0.18, -0.06, 0.16, [0.10, 0.20, -0.10]],
    [0.38, 0.64, 0.08, 0.12, [-0.12, 0.24, 0.08]],
    [-0.28, 1.70, 0.11, 0.10, [0.16, -0.20, 0.12]],
    [0.20, 2.64, -0.02, 0.12, [-0.10, 0.18, -0.08]],
  ]) {
    const chip = m.mesh('monolith-chipped-fragment', new THREE.DodecahedronGeometry(size, 0), [x, y, z], C.obsidianLight)
    chip.rotation.set(...rotation)
  }
  // Мох лежит в неровных рисках на передней грани, а не висит зелёными брусками.
  addTube(m, 'moss-crack-left', [[-0.26, 0.80, -0.43], [-0.18, 1.02, -0.47], [-0.28, 1.25, -0.43], [-0.20, 1.38, -0.39]], 0.019, C.moss, 8, 5)
  addTube(m, 'moss-crack-center', [[0.10, 1.44, -0.37], [0.17, 1.67, -0.39], [0.07, 1.88, -0.35], [0.13, 2.04, -0.31]], 0.017, C.moss, 8, 5)
  addTube(m, 'moss-crack-top', [[-0.10, 2.12, -0.31], [-0.04, 2.31, -0.28], [0.11, 2.46, -0.23], [0.14, 2.56, -0.19]], 0.016, C.moss, 8, 5)
  m.beam('obsidian-facet-line', [-0.26, 0.84, -0.44], [0.11, 1.48, -0.34], 0.012, C.obsidianLight)
  m.beam('obsidian-facet-line', [0.04, 1.50, -0.34], [-0.11, 2.05, -0.25], 0.010, C.obsidian)
  m.beam('moss-crack-branch-left', [-0.22, 1.22, -0.44], [-0.42, 1.36, -0.30], 0.018, C.moss)
  m.beam('moss-crack-branch-top', [0.08, 2.24, -0.27], [0.28, 2.38, -0.18], 0.016, C.moss)
  return root(m)
}

function buildCommandTent() {
  const m = new Model('command_tent')
  // Шестигранный конус и шесть швов дают шатру узнаваемый силуэт сверху.
  m.cylinder('tent-canopy', 0.14, 1.28, 1.78, [0, 1.06, 0], C.canvas, 6, [0, PI / 6, 0])
  m.cylinder('tent-pole', 0.055, 0.055, 2.08, [0, 1.04, 0], C.woodDark, 8)
  m.torus('tent-hem', 1.20, 0.045, [0, 0.18, 0], C.canvasLight, [PI / 2, 0, 0])
  for (let index = 0; index < 6; index += 1) {
    const angle = PI / 6 + (index * PI) / 3
    const wallX = Math.cos(angle) * 0.88
    const wallZ = Math.sin(angle) * 0.88
    // Нижние полотнища касаются общего подола и закрывают зазор под конусом.
    m.box('tent-wall-skirt', [0.86, 0.32, 0.045], [wallX, 0.30, wallZ], index % 2 ? C.canvas : C.canvasDark, [0, -angle, 0])
    m.beam('tent-seam', [0, 1.98, 0], [Math.cos(angle) * 1.20, 0.22, Math.sin(angle) * 1.20], 0.022, C.canvasLight)
  }
  // Наклон входа повторяет поверхность крыши; верх двери больше не висит перед шатром.
  m.box('tent-door', [0.48, 0.86, 0.05], [0, 0.69, -0.99], C.canvasDark, [0.45, 0, 0])
  m.beam('tent-door-frame-left', [-0.24, 0.28, -1.18], [-0.17, 1.10, -0.77], 0.024, C.woodDark)
  m.beam('tent-door-frame-right', [0.24, 0.28, -1.18], [0.17, 1.10, -0.77], 0.024, C.woodDark)
  m.beam('tent-door-rope-left', [-0.20, 1.10, -0.78], [-0.50, 0.30, -1.14], 0.018, C.rope)
  m.beam('tent-door-rope-right', [0.20, 1.10, -0.78], [0.50, 0.30, -1.14], 0.018, C.rope)
  for (let index = 0; index < 6; index += 1) {
    const angle = PI / 6 + index * PI / 3
    const x = Math.cos(angle) * 1.20
    const z = Math.sin(angle) * 1.20
    m.beam('tent-fold', [Math.cos(angle) * 0.18, 1.86, Math.sin(angle) * 0.18], [x * 0.94, 0.30, z * 0.94], 0.012, index % 2 ? C.canvasLight : C.canvasDark)
    m.beam('tent-guy-rope', [x * 0.76, 0.78, z * 0.76], [x * 1.10, 0.08, z * 1.10], 0.015, C.rope)
    m.cylinder('tent-guy-peg', 0.028, 0.042, 0.18, [x * 1.10, 0.09, z * 1.10], C.woodDark, 8)
  }
  m.sphere('tent-pole-finial', [0.10, 0.10, 0.10], [0, 2.12, 0], C.brass)
  return root(m)
}

function buildScoutTent() {
  const m = new Model('scout_tent')
  m.box('scout-roof-left', [2.62, 0.075, 0.76], [0, 0.93, -0.29], C.canvas, [0.56, 0, 0])
  m.box('scout-roof-right', [2.62, 0.075, 0.76], [0, 0.93, 0.29], C.canvasLight, [-0.56, 0, 0])
  m.beam('scout-ridge', [-1.32, 1.34, 0], [1.32, 1.34, 0], 0.045, C.woodDark)
  m.box('scout-front-wall', [2.42, 0.38, 0.06], [0, 0.32, -0.55], C.canvasDark)
  m.box('scout-back-wall', [2.42, 0.38, 0.06], [0, 0.32, 0.55], C.canvas)
  m.box('scout-entrance-opening', [0.78, 0.44, 0.025], [0, 0.35, -0.59], C.canvasDark)
  m.beam('scout-hem-left', [-1.30, 0.52, -0.56], [1.30, 0.52, -0.56], 0.020, C.canvasDark)
  m.beam('scout-hem-right', [-1.30, 0.52, 0.56], [1.30, 0.52, 0.56], 0.020, C.canvasLight)
  for (const x of [-0.88, -0.44, 0, 0.44, 0.88]) {
    m.beam('scout-roof-fold-left', [x, 1.31, 0], [x * 0.94, 0.57, -0.53], 0.012, C.canvasLight)
    m.beam('scout-roof-fold-right', [x, 1.31, 0], [x * 0.94, 0.57, 0.53], 0.012, C.canvasDark)
  }
  m.box('scout-front-flap', [0.66, 0.68, 0.04], [0, 0.64, -0.58], C.canvasDark)
  for (const x of [-1.27, 1.27]) {
    m.beam('scout-front-rope', [x, 0.54, -0.53], [x * 1.04, 0.10, -0.68], 0.018, C.rope)
    m.beam('scout-back-rope', [x, 0.54, 0.53], [x * 1.04, 0.10, 0.68], 0.018, C.rope)
    m.cylinder('scout-tent-peg', 0.028, 0.045, 0.18, [x * 1.04, 0.09, -0.68], C.woodDark, 8)
    m.cylinder('scout-tent-peg', 0.028, 0.045, 0.18, [x * 1.04, 0.09, 0.68], C.woodDark, 8)
  }
  m.beam('scout-front-pole', [-1.30, 0.08, -0.58], [-1.30, 1.30, 0], 0.035, C.wood)
  m.beam('scout-front-pole', [1.30, 0.08, -0.58], [1.30, 1.30, 0], 0.035, C.wood)
  m.beam('scout-ridge-guy-front', [0, 1.34, 0], [0, 0.08, -0.86], 0.016, C.rope)
  m.beam('scout-ridge-guy-back', [0, 1.34, 0], [0, 0.08, 0.86], 0.016, C.rope)
  m.cylinder('scout-ridge-peg-front', 0.028, 0.045, 0.18, [0, 0.09, -0.86], C.woodDark, 8)
  m.cylinder('scout-ridge-peg-back', 0.028, 0.045, 0.18, [0, 0.09, 0.86], C.woodDark, 8)
  return root(m)
}

function buildWeaponRack() {
  const m = new Model('weapon_rack')
  m.slab('rack-foot', 2.38, 0.42, 0.10, [0, 0.05, 0], C.woodDark)
  for (const x of [-1.06, 1.06]) {
    m.box('rack-post', [0.12, 1.20, 0.12], [x, 0.66, 0], C.wood)
    m.box('rack-cap', [0.20, 0.08, 0.20], [x, 1.29, 0], C.woodLight)
  }
  m.box('rack-top-rail', [2.25, 0.10, 0.12], [0, 1.20, 0], C.woodLight)
  m.box('rack-lower-rail', [2.25, 0.10, 0.12], [0, 0.36, 0], C.woodDark)
  m.box('rack-back-brace', [2.02, 0.10, 0.10], [0, 0.80, 0.08], C.woodDark)
  for (const x of [-1.06, 1.06]) {
    addRivetRow(m, 'rack-post-rivet', [[x, 0.58, -0.08], [x, 1.05, -0.08]], C.ironLight)
    m.beam('rack-diagonal-brace', [x * 0.92, 0.39, 0.08], [x * 0.74, 1.18, 0.08], 0.035, C.woodLight)
  }
  for (const [index, x] of [-0.82, -0.41, 0, 0.41, 0.82].entries()) {
    const tipX = x + (index % 2 ? 0.02 : -0.02)
    m.beam('spear-shaft', [x, 0.37, -0.02], [tipX, 1.26, -0.02], 0.024, C.woodLight)
    // Основание наконечника перекрывает торец древка, без видимого зазора.
    m.cylinder('spear-ferrule', 0.045, 0.050, 0.10, [tipX, 1.275, -0.02], C.ironLight, 10)
    m.cylinder('spear-head', 0.008, 0.065, 0.18, [tipX, 1.35, -0.02], C.iron, 10)
    m.torus('spear-socket', 0.038, 0.012, [x, 0.44, -0.02], C.iron, [PI / 2, 0, 0])
    m.torus('spear-retaining-loop', 0.040, 0.010, [x, 1.08, -0.02], C.leather, [PI / 2, 0, 0])
  }
  for (const [x, lean] of [[-0.60, -0.10], [0.02, 0.06], [0.60, 0.12]]) {
    m.box('sword-blade', [0.075, 0.72, 0.035], [x, 0.78, -0.20], C.ironLight, [0, 0, lean])
    m.box('sword-guard', [0.28, 0.045, 0.06], [x, 1.12, -0.20], C.brass, [0, 0, lean])
    m.box('sword-grip', [0.07, 0.20, 0.07], [x, 1.25, -0.20], C.leather, [0, 0, lean])
    m.torus('sword-scabbard-strap', 0.045, 0.012, [x, 0.62, -0.20], C.leather, [PI / 2, 0, 0])
  }
  return root(m)
}

function buildMantlet() {
  const m = new Model('mantlet')
  for (const [x, color] of [[-0.78, C.wood], [-0.26, C.woodLight], [0.26, C.wood], [0.78, C.woodLight]]) {
    m.box('mantlet-plank', [0.50, 1.55, 0.12], [x, 1.02, -0.18], color, [0.02 * (x / 0.26), 0, 0])
  }
  m.box('mantlet-top', [2.22, 0.14, 0.16], [0, 1.82, -0.18], C.woodDark)
  m.box('mantlet-bottom', [2.25, 0.14, 0.16], [0, 0.22, -0.18], C.woodDark)
  m.box('mantlet-view-slit', [1.26, 0.10, 0.045], [0, 1.44, -0.25], C.woodDark)
  for (const x of [-0.78, -0.26, 0.26, 0.78]) {
    m.box('mantlet-plank-seam', [0.025, 1.38, 0.025], [x + 0.24, 1.02, -0.25], C.woodDark)
    addRivetRow(m, 'mantlet-plank-rivet', [[x, 0.48, -0.27], [x, 1.55, -0.27]], C.ironLight)
  }
  m.beam('mantlet-brace-left', [-1.00, 0.28, 0.05], [-0.42, 1.74, -0.04], 0.055, C.iron)
  m.beam('mantlet-brace-right', [1.00, 0.28, 0.05], [0.42, 1.74, -0.04], 0.055, C.iron)
  m.beam('mantlet-axle', [-1.02, 0.34, 0.20], [1.02, 0.34, 0.20], 0.055, C.iron)
  addRivetRow(m, 'mantlet-brace-rivet', [[-0.72, 0.62, 0.08], [0.72, 0.62, 0.08], [-0.52, 1.39, -0.02], [0.52, 1.39, -0.02]], C.ironLight)
  for (const x of [-0.94, 0.94]) {
    m.cylinder('mantlet-wheel', 0.29, 0.29, 0.13, [x, 0.32, 0.20], C.iron, 10, [0, 0, PI / 2])
    m.torus('mantlet-wheel-rim', 0.23, 0.035, [x, 0.32, 0.20], C.ironLight, [0, PI / 2, 0])
    m.cylinder('mantlet-wheel-hub', 0.075, 0.075, 0.16, [x, 0.32, 0.20], C.woodDark, 8, [0, 0, PI / 2])
    for (let index = 0; index < 6; index += 1) {
      const angle = index * PI / 3
      m.beam('mantlet-wheel-spoke', [x, 0.32, 0.20], [x, 0.32 + Math.cos(angle) * 0.20, 0.20 + Math.sin(angle) * 0.20], 0.018, C.ironLight)
    }
    m.cylinder('mantlet-axle-collar', 0.10, 0.10, 0.08, [x, 0.34, 0.20], C.ironLight, 10, [0, 0, PI / 2])
  }
  m.beam('mantlet-rear-handle', [-0.70, 0.76, -0.12], [-0.70, 0.76, 0.62], 0.035, C.woodDark)
  m.beam('mantlet-rear-handle', [0.70, 0.76, -0.12], [0.70, 0.76, 0.62], 0.035, C.woodDark)
  return root(m)
}

/**
 * Плоское деревянное плечо баллисты в плоскости XY.
 * Экструзия оставляет настоящий профиль дерева, а не цилиндрический брус.
 */
function createBallistaLimbGeometry(side) {
  const points = [
    [0.00, 0.00], [0.16, 0.045], [0.38, 0.14], [0.64, 0.27],
    [0.90, 0.39], [1.16, 0.43], [1.22, 0.39], [1.17, 0.29],
    [0.93, 0.28], [0.66, 0.20], [0.39, 0.105], [0.14, 0.018],
  ].map(([x, y]) => [side * x, y])
  if (side < 0) points.reverse()
  const shape = new THREE.Shape()
  shape.moveTo(...points[0])
  for (const point of points.slice(1)) shape.lineTo(...point)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    steps: 1,
    curveSegments: 6,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.018,
    bevelThickness: 0.018,
  })
  geometry.translate(0, 0, -0.06)
  geometry.computeVertexNormals()
  return geometry
}

function addBallistaBolt(m, name, x, y, z, rotation = [PI / 2, 0, 0]) {
  m.cylinder(name, 0.035, 0.035, 0.055, [x, y, z], C.ironLight, 10, rotation)
  m.mesh(`${name}-head`, new THREE.DodecahedronGeometry(0.055, 0), [x, y, z], C.iron)
}

function addBallistaTorus(m, name, radius, tube, position, color, rotation) {
  return m.mesh(name, new THREE.TorusGeometry(radius, tube, 8, 24), position, color, rotation)
}

function addBallistaTorsionRope(m, x) {
  // Витки разнесены вдоль оси блока и реально охватывают его сердечник.
  for (const offset of [-0.085, -0.043, 0, 0.043, 0.085]) {
    addBallistaTorus(m, 'ballista-torsion-rope-wrap', 0.135, 0.018, [x + offset, 0.84, -0.50], C.rope, [0, 0, PI / 2])
  }
}

function buildBallista() {
  const m = new Model('ballista')
  // Станина собирается из отдельных досок: нижние продольные рельсы,
  // поперечины и настил сходятся в одних и тех же точках крепления.
  for (const x of [-0.88, 0.88]) {
    m.slab('ballista-bed-rail', 0.20, 2.28, 0.22, [x, 0.22, 0.08], C.woodDark)
    m.slab('ballista-bed-foot', 0.34, 0.30, 0.12, [x, 0.095, -0.78], C.wood)
    m.slab('ballista-bed-foot', 0.34, 0.30, 0.12, [x, 0.095, 0.94], C.wood)
  }
  for (const z of [-0.86, -0.15, 0.56, 0.94]) {
    m.slab('ballista-bed-crossboard', 1.94, 0.17, 0.16, [0, 0.34, z], C.wood)
  }
  for (const z of [-0.66, -0.28, 0.10, 0.48, 0.72]) {
    m.slab('ballista-deck-board', 1.48, 0.22, 0.095, [0, 0.44, z], z % 0.76 ? C.woodLight : C.wood)
  }
  // Опоры связывают торсионные узлы и ворот со станиной.
  for (const x of [-0.55, 0.55]) {
    m.slab('ballista-torsion-support', 0.20, 0.28, 0.66, [x, 0.76, -0.50], C.woodDark)
    m.slab('ballista-torsion-foot', 0.34, 0.32, 0.10, [x, 0.46, -0.50], C.wood)
    m.beam('ballista-torsion-brace', [x, 0.48, -0.44], [x, 0.73, -0.50], 0.035, C.woodLight)
    m.box('ballista-torsion-plate-front', [0.27, 0.40, 0.035], [x, 0.84, -0.66], C.iron)
    m.box('ballista-torsion-plate-back', [0.27, 0.40, 0.035], [x, 0.84, -0.34], C.iron)
    addBallistaBolt(m, 'ballista-torsion-bolt-front', x - 0.08, 0.84, -0.685)
    addBallistaBolt(m, 'ballista-torsion-bolt-front', x + 0.08, 0.84, -0.685)
    addBallistaTorsionRope(m, x)
    m.cylinder('ballista-torsion-hub', 0.072, 0.072, 0.31, [x, 0.84, -0.50], C.iron, 12, [0, 0, PI / 2])
    m.beam('ballista-bow-yoke', [x, 0.84, -0.50], [x * 0.18, 1.10, -0.68], 0.045, C.woodDark)
  }
  // Одна ось проходит через оба торсионных блока и принимает бросковый рычаг.
  m.cylinder('ballista-torsion-axle', 0.045, 0.045, 1.24, [0, 0.84, -0.50], C.iron, 12, [0, 0, PI / 2])
  // Передняя направляющая: две боковые рейки и центральный желоб удерживают стрелу.
  for (const x of [-0.15, 0.15]) m.slab('ballista-guide-rail', 0.09, 2.10, 0.13, [x, 0.90, -0.36], C.woodDark)
  m.slab('ballista-guide-bed', 0.34, 2.04, 0.07, [0, 0.995, -0.36], C.woodLight)
  m.box('ballista-guide-collar', [0.43, 0.11, 0.16], [0, 1.06, -0.48], C.iron)
  addBallistaBolt(m, 'ballista-guide-bolt-left', -0.18, 1.06, -0.58, [0, 0, 0])
  addBallistaBolt(m, 'ballista-guide-bolt-right', 0.18, 1.06, -0.58, [0, 0, 0])

  // Настоящие плоские изогнутые плечи из деревянного профиля.
  for (const side of [-1, 1]) {
    const limb = m.mesh('ballista-bow-limb', createBallistaLimbGeometry(side), [0, 1.10, -0.68], C.woodLight)
    limb.geometry.computeVertexNormals()
    m.box('ballista-limb-root-plate', [0.25, 0.16, 0.20], [side * 0.10, 1.10, -0.68], C.iron)
    addBallistaBolt(m, 'ballista-limb-root-bolt', side * 0.10, 1.10, -0.80)
  }
  m.beam('ballista-string-left', [-1.22, 1.49, -0.68], [0, 1.04, 0.54], 0.018, C.rope)
  m.beam('ballista-string-right', [0, 1.04, 0.54], [1.22, 1.49, -0.68], 0.018, C.rope)
  addBallistaTorus(m, 'ballista-string-nock', 0.07, 0.016, [0, 1.04, 0.54], C.rope, [PI / 2, 0, 0])
  // Бросковый рычаг связан с осью торсионов и заканчивается чашкой под стрелой.
  m.beam('ballista-throw-arm', [0, 0.84, -0.50], [0, 1.08, 0.42], 0.068, C.woodDark)
  m.slab('ballista-throw-arm-cup', 0.28, 0.24, 0.06, [0, 1.08, 0.42], C.iron)
  addBallistaBolt(m, 'ballista-throw-arm-bolt', 0, 0.98, 0.04, [0, 0, 0])

  // Стрела лежит в желобе; хвостовое оперение и металлический наконечник закреплены.
  m.cylinder('ballista-arrow-shaft', 0.030, 0.030, 2.42, [0, 1.07, -0.42], C.woodLight, 10, [PI / 2, 0, 0])
  m.cylinder('ballista-arrow-collar', 0.052, 0.052, 0.12, [0, 1.07, 0.65], C.iron, 10, [PI / 2, 0, 0])
  m.box('ballista-arrow-fletching-left', [0.07, 0.16, 0.28], [-0.045, 1.13, 0.67], C.canvasDark)
  m.box('ballista-arrow-fletching-right', [0.07, 0.16, 0.28], [0.045, 1.13, 0.67], C.canvasDark)
  m.cylinder('ballista-arrow-head', 0.11, 0, 0.27, [0, 1.07, -1.72], C.iron, 12, [PI / 2, 0, 0])
  m.cylinder('ballista-arrow-head-collar', 0.12, 0.12, 0.06, [0, 1.07, -1.56], C.ironLight, 10, [PI / 2, 0, 0])

  // Ворот прикручен к задним стойкам станины; рукоятка выходит из правой щеки.
  for (const x of [-0.64, 0.64]) {
    m.slab('ballista-winch-support', 0.15, 0.22, 0.42, [x, 0.62, 0.78], C.wood)
    m.box('ballista-winch-cheek', [0.08, 0.46, 0.42], [x, 0.74, 0.78], C.iron)
    addBallistaBolt(m, 'ballista-winch-cheek-bolt', x, 0.60, 0.58, [0, 0, 0])
    addBallistaBolt(m, 'ballista-winch-cheek-bolt', x, 0.88, 0.58, [0, 0, 0])
  }
  m.cylinder('ballista-winch-drum', 0.12, 0.12, 1.30, [0, 0.74, 0.78], C.woodDark, 14, [0, 0, PI / 2])
  for (const x of [-0.56, -0.34, -0.12, 0.12, 0.34, 0.56]) {
    addBallistaTorus(m, 'ballista-winch-rope-wrap', 0.12, 0.014, [x, 0.74, 0.78], C.rope, [0, 0, PI / 2])
  }
  m.cylinder('ballista-winch-axle', 0.045, 0.045, 1.48, [0, 0.74, 0.78], C.iron, 10, [0, 0, PI / 2])
  m.beam('ballista-winch-crank-arm', [0.73, 0.74, 0.78], [0.73, 1.00, 0.78], 0.032, C.iron)
  m.beam('ballista-winch-handle', [0.73, 1.00, 0.78], [0.94, 1.00, 0.78], 0.04, C.woodLight)
  m.sphere('ballista-winch-handle-grip', [0.09, 0.09, 0.16], [0.98, 1.00, 0.78], C.woodDark)
  // Подпорка от ворот к задней поперечине убирает впечатление висящего механизма.
  m.beam('ballista-winch-back-brace-left', [-0.60, 0.44, 0.70], [-0.64, 0.62, 0.78], 0.038, C.woodDark)
  m.beam('ballista-winch-back-brace-right', [0.60, 0.44, 0.70], [0.64, 0.62, 0.78], 0.038, C.woodDark)

  m.cylinder('ballista-pivot', 0.07, 0.07, 0.38, [0, 0.48, 0], C.iron, 10)
  addBallistaBolt(m, 'ballista-bed-pivot-bolt', 0, 0.48, -0.20, [0, 0, 0])
  return root(m)
}

export const MODEL_IDS = Object.freeze([
  'rope_bridge', 'mine_rail', 'mine_cart', 'timber_shoring', 'crystal_cluster',
  'giant_fungus', 'obsidian_monolith', 'command_tent', 'scout_tent',
  'weapon_rack', 'mantlet', 'ballista',
])

const BUILDERS = Object.freeze({
  rope_bridge: buildRopeBridge,
  mine_rail: buildMineRail,
  mine_cart: buildMineCart,
  timber_shoring: buildTimberShoring,
  crystal_cluster: buildCrystalCluster,
  giant_fungus: buildGiantFungus,
  obsidian_monolith: buildObsidianMonolith,
  command_tent: buildCommandTent,
  scout_tent: buildScoutTent,
  weapon_rack: buildWeaponRack,
  mantlet: buildMantlet,
  ballista: buildBallista,
})

/** @param {string} id @returns {import('three').Group} */
export function createModel(id) {
  const build = BUILDERS[id]
  if (!build) throw new Error(`Unknown mine/camp model: ${id}`)
  return build()
}
