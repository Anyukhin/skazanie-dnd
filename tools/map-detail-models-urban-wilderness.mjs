/** Авторские модели лаборатории, порта, снега, пустыни и болота. */
import { Model, THREE } from './map-detail-model-helpers.mjs'

const PI = Math.PI

const C = Object.freeze({
  wood: '#684a34',
  woodLight: '#a27a4e',
  woodDark: '#35261e',
  woodEdge: '#7d5738',
  stone: '#867866',
  stoneLight: '#b09b78',
  stoneDark: '#554b42',
  iron: '#3f4442',
  ironLight: '#77766b',
  brass: '#ae8140',
  copper: '#a65e3d',
  copperDark: '#673b2d',
  blue: '#293e5a',
  blueLight: '#4e7281',
  rope: '#73583c',
  cloth: '#805f4d',
  clothLight: '#b08e68',
  red: '#81504a',
  green: '#596d4a',
  greenDark: '#304732',
  sand: '#a17e51',
  snow: '#bdc9c7',
  dark: '#282a28',
})

/** Криволинейная деталь с настоящим сечением, а не набором кубиков. */
function tube(model, name, points, radius, color, tubularSegments = 24, radialSegments = 8, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), closed, 'centripetal')
  return model.mesh(name, new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, closed), [0, 0, 0], color)
}

/** Трубка с естественным сужением к концу; полезна для корней, тросов и ручек. */
function taperedTube(model, name, points, radiusStart, radiusEnd, color, tubularSegments = 24, radialSegments = 8) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, 'centripetal')
  const geometry = new THREE.TubeGeometry(curve, tubularSegments, 1, radialSegments, false)
  const frames = curve.computeFrenetFrames(tubularSegments, false)
  const position = geometry.getAttribute('position')
  for (let row = 0; row <= tubularSegments; row += 1) {
    const radius = radiusStart + (radiusEnd - radiusStart) * row / tubularSegments
    const center = curve.getPointAt(row / tubularSegments)
    for (let column = 0; column <= radialSegments; column += 1) {
      const vertex = row * (radialSegments + 1) + column
      const angle = column / radialSegments * PI * 2
      const offset = frames.normals[row].clone().multiplyScalar(Math.cos(angle) * radius)
        .addScaledVector(frames.binormals[row], Math.sin(angle) * radius)
      position.setXYZ(vertex, center.x + offset.x, center.y + offset.y, center.z + offset.z)
    }
  }
  geometry.computeVertexNormals()
  return model.mesh(name, geometry, [0, 0, 0], color)
}

function ring(model, name, radius, tubeRadius, position, color, rotation = [0, 0, 0], radialSegments = 8, tubularSegments = 24) {
  return model.mesh(name, new THREE.TorusGeometry(radius, tubeRadius, radialSegments, tubularSegments), position, color, rotation)
}

function lathe(model, name, profile, position, color, segments = 24) {
  const points = profile.map(([radius, y]) => new THREE.Vector2(radius, y))
  return model.mesh(name, new THREE.LatheGeometry(points, segments), position, color)
}

function prism(model, name, outline, depth, position, color, bevel = 0.008) {
  const shape = new THREE.Shape()
  outline.forEach(([x, y], index) => index ? shape.lineTo(x, y) : shape.moveTo(x, y))
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSegments: bevel > 0 ? 1 : 0,
    bevelSize: bevel,
    bevelThickness: bevel * .75,
    curveSegments: 2,
    steps: 1,
  })
  geometry.translate(0, 0, -depth / 2)
  return model.mesh(name, geometry, position, color)
}

function finish(model, dimensions) {
  const root = model.root
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root, true)
  const size = bounds.getSize(new THREE.Vector3())
  if (![size.x, size.y, size.z].every((value) => Number.isFinite(value) && value > 0)) throw new Error(`Пустая urban-wilderness модель: ${root.name}`)
  const [width, depth, height] = dimensions
  root.scale.set(width / size.x, height / size.y, depth / size.z)
  root.updateMatrixWorld(true)
  const fitted = new THREE.Box3().setFromObject(root, true)
  root.position.set(-(fitted.min.x + fitted.max.x) / 2, -fitted.min.y, -(fitted.min.z + fitted.max.z) / 2)
  root.updateMatrixWorld(true)
  return root
}

function plank(model, name, size, position, color, rotation = [0, 0, 0]) {
  // Авторские размеры здесь записываются как [ширина, высота, глубина].
  const [width, height, depth] = size
  const board = model.slab(name, width, depth, height, position, color)
  board.rotation.set(...rotation)
  return board
}

function addNail(model, name, position, color = C.ironLight) {
  return model.cylinder(name, .022, .024, .025, position, color, 10)
}

function buildAlchemyTable() {
  const m = new Model('alchemy_table')
  plank(m, 'alchemy-top', [2.62, .12, .98], [0, .88, 0], C.woodLight)
  plank(m, 'alchemy-top-edge-front', [2.66, .15, .07], [0, .82, -.49], C.woodDark)
  plank(m, 'alchemy-top-edge-back', [2.66, .15, .07], [0, .82, .49], C.woodDark)
  for (const [x, z] of [[-1.08, -.36], [1.08, -.36], [-1.08, .36], [1.08, .36]]) {
    lathe(m, 'alchemy-turned-leg', [[.09, 0], [.105, .04], [.075, .12], [.065, .28], [.082, .34], [.064, .49], [.068, .70], [.10, .77]], [x, .02, z], C.woodDark, 20)
    ring(m, 'alchemy-leg-foot', .105, .024, [x, .045, z], C.woodEdge, [PI / 2, 0, 0], 6, 18)
  }
  plank(m, 'alchemy-apron-front', [2.22, .18, .08], [0, .68, -.39], C.wood)
  plank(m, 'alchemy-apron-back', [2.22, .18, .08], [0, .68, .39], C.wood)
  plank(m, 'alchemy-apron-left', [.08, .18, .70], [-1.11, .68, 0], C.wood)
  plank(m, 'alchemy-apron-right', [.08, .18, .70], [1.11, .68, 0], C.wood)
  plank(m, 'alchemy-shelf', [2.15, .08, .63], [0, .28, .02], C.woodDark)
  for (const x of [-.88, -.29, .29, .88]) {
    plank(m, 'alchemy-shelf-cleat', [.08, .24, .10], [x, .42, -.27], C.woodEdge)
    addNail(m, 'alchemy-shelf-nail', [x, .45, -.33])
  }
  for (const x of [-.98, .98]) {
    plank(m, 'alchemy-shelf-upright', [.075, .50, .075], [x, .57, .27], C.wood)
    addNail(m, 'alchemy-metal-shelf-upright-rivet', [x, .58, .23])
  }
  plank(m, 'alchemy-shelf-back-rail', [2.05, .075, .075], [0, .78, .27], C.woodLight)
  for (const x of [-.52, .36]) {
    plank(m, 'alchemy-drawer-front', [.68, .19, .075], [x, .70, -.43], C.woodEdge)
    ring(m, 'alchemy-brass-drawer-pull', .045, .013, [x, .70, -.48], C.brass, [PI / 2, 0, 0], 6, 16)
  }
  // Стекло получает настоящий пузатый профиль, горло и пробку.
  for (const [index, [x, z, color, scale]] of [
    [-.86, -.20, C.blueLight, 1], [-.57, .23, C.green, .82], [.46, -.18, C.red, 1.08], [.78, .20, C.blue, .76],
  ].entries()) {
    const s = scale
    lathe(m, `alchemy-glass-flask-${index + 1}`, [[0, 0], [.10 * s, .02], [.15 * s, .08], [.17 * s, .18], [.13 * s, .27], [.065 * s, .32], [.055 * s, .43], [.065 * s, .46]], [x, .94, z], color, 20)
    ring(m, 'alchemy-glass-flask-lip', .064 * s, .012, [x, 1.40, z], color, [PI / 2, 0, 0], 6, 18)
    m.cylinder('alchemy-flask-cork', .045 * s, .045 * s, .055, [x, 1.435, z], C.woodLight, 10)
  }
  lathe(m, 'alchemy-stone-mortar', [[.05, 0], [.19, .02], [.22, .08], [.19, .16], [.13, .18], [.10, .23]], [-.05, .95, .08], C.stone, 20)
  ring(m, 'alchemy-stone-mortar-rim', .18, .024, [-.05, 1.17, .08], C.stoneLight, [PI / 2, 0, 0], 8, 24)
  tube(m, 'alchemy-stone-pestle', [[-.14, 1.17, .16], [.00, 1.34, .18], [.12, 1.48, .18]], .026, C.stoneDark, 16, 7)
  tube(m, 'alchemy-brass-scale-post', [[.42, .96, .32], [.42, 1.30, .32]], .035, C.brass, 10, 8)
  tube(m, 'alchemy-brass-scale-beam', [[.20, 1.33, .32], [.65, 1.33, .32]], .019, C.brass, 10, 7)
  for (const x of [.20, .65]) {
    ring(m, 'alchemy-brass-scale-pan', .095, .016, [x, 1.20, .32], C.brass, [PI / 2, 0, 0], 6, 20)
    tube(m, 'alchemy-metal-scale-chain', [[x, 1.32, .32], [x, 1.21, .32]], .009, C.iron, 8, 5)
  }
  m.cylinder('alchemy-metal-scale-weight', .055, .06, .08, [.20, 1.25, .32], C.iron, 12)
  for (const x of [-.36, -.18, 0, .18, .36]) m.beam('alchemy-edge-grain', [x, .955, -.46], [x + .04, .955, -.31], .006, C.woodDark)
  m.slab('alchemy-reagent-stain', .24, .16, .012, [-.15, .947, -.30], C.green)
  return finish(m, [2.8, 1.3, 1])
}

function buildCrystalOrb() {
  const m = new Model('crystal_orb')
  lathe(m, 'orb-brass-pedestal', [[.08, 0], [.27, .03], [.30, .09], [.22, .14], [.18, .20], [.14, .28], [.18, .34], [.25, .39]], [0, .03, 0], C.brass, 28)
  ring(m, 'orb-metal-foot-inlay', .27, .022, [0, .07, 0], C.iron, [PI / 2, 0, 0], 7, 28)
  for (const angle of [PI / 6, PI / 6 + 2 * PI / 3, PI / 6 + 4 * PI / 3]) {
    const x = Math.cos(angle), z = Math.sin(angle)
    tube(m, 'orb-brass-tripod-leg', [[0, .35, 0], [x * .16, .30, z * .16], [x * .43, .06, z * .43]], .032, C.brass, 14, 7)
    m.slab('orb-brass-foot-pad', .18, .12, .055, [x * .45, .035, z * .45], C.brass)
    tube(m, 'orb-metal-tripod-brace', [[x * .16, .30, z * .16], [x * .33, .20, z * .33]], .014, C.iron, 8, 6)
  }
  m.cylinder('orb-brass-collar', .22, .24, .10, [0, .45, 0], C.brass, 24)
  m.cylinder('orb-iron-neck', .095, .13, .22, [0, .59, 0], C.iron, 20)
  lathe(m, 'orb-brass-seated-cup', [[.12, 0], [.22, .02], [.25, .08], [.20, .15], [.14, .18]], [0, .47, 0], C.brass, 24)
  for (const angle of [PI / 6, PI / 6 + 2 * PI / 3, PI / 6 + 4 * PI / 3]) {
    const x = Math.cos(angle), z = Math.sin(angle)
    m.cylinder('orb-metal-seat-rivet', .025, .025, .035, [x * .24, .58, z * .24], C.ironLight, 12)
  }
  m.mesh('orb-crystal', new THREE.IcosahedronGeometry(.55, 4), [0, .98, 0], C.blue)
  ring(m, 'orb-brass-meridian', .31, .018, [0, .98, 0], C.brass, [0, 0, 0], 7, 32)
  ring(m, 'orb-brass-equator', .30, .016, [0, .98, 0], C.brass, [PI / 2, 0, 0], 7, 32)
  for (const angle of [PI / 4, 3 * PI / 4, 5 * PI / 4, 7 * PI / 4]) {
    const x = Math.cos(angle), z = Math.sin(angle)
    tube(m, 'orb-brass-cage-rib', [[x * .15, .50, z * .15], [x * .43, .76, z * .43], [x * .48, 1.18, z * .48]], .018, C.brass, 16, 7)
  }
  tube(m, 'orb-brass-axis-top', [[0, 1.43, 0], [0, 1.55, 0]], .018, C.brass, 8, 6)
  return finish(m, [1, 1, 1.2])
}

function buildArcaneCoil() {
  const m = new Model('arcane_coil')
  m.slab('coil-metal-base', 1.18, 1.18, .09, [0, .045, 0], C.iron)
  m.slab('coil-copper-base-inlay', 1.02, 1.02, .025, [0, .105, 0], C.copperDark)
  const outer = []
  for (let index = 0; index <= 96; index += 1) {
    const angle = index / 96 * PI * 4.3
    const radius = .49 - index / 96 * .17
    outer.push([Math.cos(angle) * radius, .18 + index / 96 * .19, Math.sin(angle) * radius])
  }
  tube(m, 'coil-copper-spiral', outer, .036, C.copper, 96, 8)
  const inner = []
  for (let index = 0; index <= 72; index += 1) {
    const angle = index / 72 * PI * 3.2
    const radius = .27 - index / 72 * .09
    inner.push([Math.cos(angle) * radius, .38 + index / 72 * .13, Math.sin(angle) * radius])
  }
  tube(m, 'coil-brass-inner-spiral', inner, .028, C.brass, 72, 7)
  for (const angle of [PI / 4, 3 * PI / 4, 5 * PI / 4, 7 * PI / 4]) {
    const x = Math.cos(angle) * .49, z = Math.sin(angle) * .49
    lathe(m, 'coil-ceramic-insulator', [[.04, 0], [.09, .02], [.10, .09], [.07, .16], [.09, .23], [.06, .28]], [x, .11, z], C.ironLight, 18)
    ring(m, 'coil-brass-insulator-cap', .075, .018, [x, .40, z], C.brass, [PI / 2, 0, 0], 7, 20)
    tube(m, 'coil-metal-post-clamp', [[x * .86, .42, z * .86], [x, .42, z]], .020, C.iron, 8, 6)
    tube(m, 'coil-metal-radial-bus', [[x * .20, .13, z * .20], [x * .49, .18, z * .49]], .016, C.ironLight, 14, 6)
    m.cylinder('coil-brass-bus-bolt', .028, .032, .035, [x * .20, .16, z * .20], C.brass, 12)
  }
  ring(m, 'coil-metal-outer-mount', .56, .026, [0, .13, 0], C.ironLight, [PI / 2, 0, 0], 7, 32)
  ring(m, 'coil-inner-mount', .20, .022, [0, .50, 0], C.copperDark, [PI / 2, 0, 0], 7, 24)
  tube(m, 'coil-copper-closed-return-a', [[.49, .18, 0], [.53, .22, .10], [.47, .26, .24], [.30, .32, .32], [.19, .37, .24]], .016, C.copperDark, 24, 7, true)
  tube(m, 'coil-copper-closed-return-b', [[.27, .38, 0], [.24, .42, -.10], [.06, .46, -.19], [-.145, .51, -.171]], .014, C.copperDark, 20, 7, true)
  m.cylinder('coil-copper-terminal-a', .055, .065, .11, [.50, .20, 0], C.copperDark, 16)
  m.cylinder('coil-copper-terminal-b', .055, .065, .11, [-.145, .51, -.171], C.copperDark, 16)
  return finish(m, [1.4, 1.4, 1.1])
}

function addAnchorLink(model, name, x, y, z, rotation, radius = .075) {
  return ring(model, name, radius, .020, [x, y, z], C.ironLight, rotation, 8, 24)
}

function buildAnchor() {
  const m = new Model('anchor')
  const y = .16
  tube(m, 'anchor-iron-shank', [[0, y, .50], [0, y, .30], [0, y, -.05], [0, y, -.38]], .062, C.iron, 24, 8)
  ring(m, 'anchor-iron-crown-ring', .105, .028, [0, y, .51], C.ironLight, [PI / 2, 0, 0], 8, 24)
  tube(m, 'anchor-iron-stock', [[-.54, y, .29], [-.25, y, .34], [0, y, .29], [.25, y, .34], [.54, y, .29]], .060, C.ironLight, 24, 8)
  for (const side of [-1, 1]) {
    tube(m, `anchor-iron-fluke-${side}`, [[0, y, .46], [side * .24, y, .32], [side * .45, y, .13], [side * .58, y, -.06]], .068, C.iron, 24, 8)
    tube(m, `anchor-iron-fluke-hook-${side}`, [[side * .58, y, -.06], [side * .54, y, -.18], [side * .43, y, -.22]], .052, C.iron, 16, 7)
    m.cylinder(`anchor-iron-fluke-cap-${side}`, .06, .03, .12, [side * .42, y, -.22], C.ironLight, 8, [PI / 2, 0, 0])
  }
  lathe(m, 'anchor-iron-collar', [[.07, 0], [.10, .04], [.105, .13], [.07, .18]], [0, y, .26], C.ironLight, 18)
  const chain = [[0, y, .58], [.08, y, .54], [.16, y, .46], [.18, y, .35], [.16, y, .24], [.09, y, .14], [.01, y, .08], [-.05, y, 0]]
  for (const [index, [x, chainY, z]] of chain.entries()) addAnchorLink(m, 'anchor-chain-link', x, chainY + .008, z, index % 2 ? [PI / 2, 0, 0] : [0, 0, 0])
  return finish(m, [1.4, 1.4, .35])
}

function buildCapstan() {
  const m = new Model('capstan')
  lathe(m, 'capstan-base', [[.16, 0], [.46, .02], [.53, .09], [.52, .15], [.39, .19]], [0, .02, 0], C.woodDark, 28)
  lathe(m, 'capstan-drum', [[.23, .18], [.28, .24], [.32, .34], [.34, .57], [.29, .68], [.24, .73]], [0, 0, 0], C.wood, 28)
  for (const y of [.21, .67]) ring(m, 'capstan-steel-band', .32, .026, [0, y, 0], C.iron, [PI / 2, 0, 0], 8, 28)
  lathe(m, 'capstan-top', [[.22, .72], [.36, .75], [.40, .82], [.34, .88], [.12, .91]], [0, 0, 0], C.woodLight, 28)
  m.cylinder('capstan-steel-axis', .07, .07, 1.03, [0, .46, 0], C.iron, 16)
  ring(m, 'capstan-iron-top-plate', .32, .020, [0, .87, 0], C.ironLight, [PI / 2, 0, 0], 7, 28)
  for (let index = 0; index < 8; index += 1) {
    const angle = index * PI / 4
    const x = Math.cos(angle), z = Math.sin(angle)
    tube(m, 'capstan-drum-stave-seam', [[x * .333, .25, z * .333], [x * .342, .66, z * .342]], .009, C.woodDark, 12, 5)
    m.cylinder('capstan-iron-base-bolt', .024, .028, .035, [x * .38, .17, z * .38], C.ironLight, 12)
  }
  for (let index = 0; index < 6; index += 1) {
    const angle = index * PI / 3
    const x = Math.cos(angle), z = Math.sin(angle)
    tube(m, 'capstan-iron-handle-socket', [[x * .17, .82, z * .17], [x * .29, .83, z * .29]], .052, C.iron, 12, 7)
    tube(m, 'capstan-handle', [[x * .19, .82, z * .19], [x * .43, .84, z * .43], [x * .66, .84, z * .66]], .034, C.woodLight, 18, 7)
    ring(m, 'capstan-iron-handle-ferrule', .050, .014, [x * .39, .84, z * .39], C.iron, [0, 0, angle], 6, 16)
    lathe(m, 'capstan-grip', [[0, 0], [.07, .02], [.075, .11], [.06, .18], [0, .20]], [x * .70, .75, z * .70], C.woodDark, 16)
    m.cylinder('capstan-bolt', .025, .025, .035, [x * .30, .91, z * .30], C.ironLight, 8)
  }
  m.cylinder('capstan-head-hub', .13, .15, .20, [0, .78, 0], C.woodDark, 24)
  for (let index = 0; index < 6; index += 1) {
    const angle = index * PI / 3
    const x = Math.cos(angle), z = Math.sin(angle)
    tube(m, 'capstan-head-spoke', [[x * .06, .79, z * .06], [x * .20, .82, z * .20]], .040, C.woodDark, 12, 7)
  }
  return finish(m, [1.4, 1.4, 1])
}

function buildDockCrane() {
  const m = new Model('dock_crane')
  plank(m, 'crane-foot-front', [1.65, .13, .18], [0, .065, -.58], C.woodDark)
  plank(m, 'crane-foot-back', [1.65, .13, .18], [0, .065, .58], C.woodDark)
  for (const z of [-.46, .46]) {
    tube(m, 'crane-upright', [[-.68, .12, z], [-.68, 1.10, z], [-.62, 2.15, z]], .085, C.wood, 24, 8)
    tube(m, 'crane-rear-brace', [[.50, .12, z], [.12, .87, z], [-.62, 2.05, z]], .052, C.woodDark, 18, 7)
    m.slab('crane-upright-foot', .24, .24, .12, [-.68, .12, z], C.woodEdge)
  }
  plank(m, 'crane-bottom-crossbar', [1.36, .13, .13], [-.08, .74, -.50], C.woodLight)
  plank(m, 'crane-bottom-crossbar-back', [1.36, .13, .13], [-.08, .74, .50], C.woodLight)
  tube(m, 'crane-metal-frame-tie-low', [[-.68, .92, -.46], [-.68, .92, .46]], .035, C.iron, 16, 7)
  tube(m, 'crane-metal-frame-tie-high', [[-.65, 1.52, -.46], [-.65, 1.52, .46]], .032, C.iron, 16, 7)
  plank(m, 'crane-top-crossbar', [1.48, .14, .14], [-.68, 2.16, 0], C.woodLight)
  ring(m, 'crane-metal-swivel-plate', .28, .035, [-.62, 2.25, 0], C.iron, [PI / 2, 0, 0], 8, 24)
  tube(m, 'crane-boom', [[-.62, 2.24, 0], [-.62, 2.12, -.55], [-.62, 1.95, -1.22]], .10, C.woodLight, 24, 8)
  tube(m, 'crane-metal-boom-side-brace', [[-.62, 2.10, .40], [-.62, 2.02, -.35], [-.62, 1.92, -1.16]], .036, C.iron, 18, 7)
  tube(m, 'crane-guy-rope-front', [[-.62, 2.16, .42], [-.62, 2.02, -.30], [-.62, 1.94, -1.20]], .018, C.rope, 20, 6)
  tube(m, 'crane-guy-rope-back', [[-.62, 2.16, -.42], [-.62, 2.02, -.30], [-.62, 1.94, -1.20]], .018, C.rope, 20, 6)
  m.cylinder('crane-metal-end-pin', .08, .08, .30, [-.62, 1.94, -1.20], C.ironLight, 16, [0, PI / 2, 0])
  for (const x of [-.76, -.48]) plank(m, 'crane-pulley-cheek', [.08, .30, .32], [x, 1.82, -1.20], C.woodDark)
  ring(m, 'crane-pulley', .16, .042, [-.62, 1.82, -1.20], C.woodDark, [0, PI / 2, 0], 8, 28)
  ring(m, 'crane-metal-pulley-hub', .065, .018, [-.62, 1.82, -1.20], C.ironLight, [0, PI / 2, 0], 7, 20)
  tube(m, 'crane-rope-over-block', [[-.62, 1.98, -1.20], [-.62, 1.88, -1.20], [-.62, 1.66, -1.20]], .018, C.rope, 18, 7)
  tube(m, 'crane-rope', [[-.62, 1.66, -1.20], [-.62, 1.38, -1.20], [-.62, 1.06, -1.20]], .018, C.rope, 24, 7)
  ring(m, 'crane-metal-hook-eye', .09, .020, [-.62, 1.00, -1.20], C.iron, [PI / 2, 0, 0], 7, 20)
  m.cylinder('crane-rope-hook-thimble', .035, .040, .11, [-.62, 1.02, -1.20], C.rope, 12)
  tube(m, 'crane-rope-eye-link', [[-.62, 1.07, -1.20], [-.62, 1.01, -1.20]], .024, C.rope, 10, 6)
  tube(m, 'crane-metal-hook', [[-.62, 1.00, -1.20], [-.62, .83, -1.20], [-.52, .77, -1.20], [-.47, .82, -1.20]], .026, C.iron, 20, 7)
  m.cylinder('crane-winch-drum', .13, .13, .48, [-.68, 1.18, -.10], C.woodDark, 20, [PI / 2, 0, 0])
  m.cylinder('crane-winch-axle', .038, .038, .72, [-.68, 1.18, -.10], C.iron, 12, [PI / 2, 0, 0])
  for (const z of [-.30, .10]) ring(m, 'crane-winch-rope-wrap', .13, .015, [-.68, 1.18, z], C.rope, [0, 0, 0], 6, 18)
  for (const x of [-1.02, -.34]) ring(m, 'crane-metal-winch-side', .15, .024, [x, 1.18, -.10], C.ironLight, [PI / 2, 0, 0], 7, 22)
  tube(m, 'crane-winch-handle', [[-1.04, 1.18, -.10], [-1.13, 1.36, -.10], [-1.13, 1.48, -.10]], .025, C.ironLight, 14, 7)
  for (const x of [-.60, -.18]) addNail(m, 'crane-metal-plate-rivet', [x, .16, -.60])
  return finish(m, [2.8, 2.8, 2.6])
}

function buildCargoSled() {
  const m = new Model('cargo_sled')
  for (const z of [-.43, .43]) {
    const runnerPath = [[-1.30, .10, z], [-1.08, .08, z], [-.55, .07, z], [.10, .07, z], [.72, .08, z], [1.04, .10, z], [1.20, .14, z], [1.32, .23, z], [1.36, .35, z], [1.34, .46, z]]
    // Один непрерывный полоз: прямая длина и загнутый вверх нос лежат в одной плоскости X/Y.
    tube(m, 'sled-wood-runner', runnerPath, .082, C.woodDark, 48, 10)
    tube(m, 'sled-metal-runner-shoe', runnerPath.map(([x, y, pz]) => [x, y - .052, pz]), .022, C.iron, 48, 8)
  }
  for (let index = 0; index < 7; index += 1) {
    const x = -.90 + index * .32
    plank(m, 'sled-platform-plank', [.27, .10, .94], [x, .30, 0], index % 2 ? C.woodLight : C.wood)
    for (const z of [-.37, .37]) {
      plank(m, 'sled-platform-support-pad', [.16, .10, .12], [x, .21, z], C.woodEdge)
      addNail(m, 'sled-metal-platform-rivet', [x, .36, z])
    }
  }
  for (const x of [-.92, -.30, .32, .94]) {
    tube(m, 'sled-upright-cleat', [[x, .11, -.44], [x, .42, -.44]], .045, C.woodEdge, 12, 7)
    tube(m, 'sled-upright-cleat', [[x, .11, .44], [x, .42, .44]], .045, C.woodEdge, 12, 7)
  }
  tube(m, 'sled-side-rail-left', [[-.92, .43, -.44], [-.30, .43, -.44], [.32, .43, -.44], [.94, .43, -.44]], .035, C.woodLight, 24, 7)
  tube(m, 'sled-side-rail-right', [[-.92, .43, .44], [-.30, .43, .44], [.32, .43, .44], [.94, .43, .44]], .035, C.woodLight, 24, 7)
  for (const x of [-.75, -.10, .55]) {
    tube(m, 'sled-metal-diagonal-brace-left', [[x, .18, -.44], [x + .22, .40, -.44]], .020, C.iron, 12, 6)
    tube(m, 'sled-metal-diagonal-brace-right', [[x, .18, .44], [x + .22, .40, .44]], .020, C.iron, 12, 6)
  }
  tube(m, 'sled-front-crossbar', [[-1.08, .38, -.48], [-1.08, .38, .48]], .050, C.woodLight, 18, 7)
  tube(m, 'sled-nose-yoke', [[1.18, .27, -.46], [1.18, .27, .46]], .050, C.woodLight, 18, 7)
  return finish(m, [2.8, 1.3, .7])
}

function ovalFrame(model, name, x, z, color) {
  const points = []
  for (let index = 0; index < 20; index += 1) {
    const angle = index / 20 * PI * 2
    points.push([x + Math.cos(angle) * .27, .08, z + Math.sin(angle) * .46])
  }
  return tube(model, name, points, .032, color, 40, 7, true)
}

function buildSnowshoePair() {
  const m = new Model('snowshoe_pair')
  for (const [index, x] of [-.34, .34].entries()) {
    const color = index ? C.wood : C.woodLight
    ovalFrame(m, `snowshoe-${index + 1}-frame`, x, 0, color)
    for (const z of [-.30, -.15, 0, .15, .30]) tube(m, `snowshoe-${index + 1}-cross-lacing`, [[x - .20, .09, z], [x + .20, .09, z]], .010, C.rope, 12, 5)
    tube(m, `snowshoe-${index + 1}-center-lacing`, [[x, .09, -.40], [x, .09, .40]], .010, C.rope, 18, 5)
    for (const z of [-.30, -.15, 0, .15, .30]) {
      tube(m, `snowshoe-${index + 1}-diagonal-lacing-a`, [[x - .19, .095, z - .08], [x + .19, .095, z + .08]], .008, C.rope, 10, 5)
      tube(m, `snowshoe-${index + 1}-diagonal-lacing-b`, [[x + .19, .097, z - .08], [x - .19, .097, z + .08]], .008, C.rope, 10, 5)
    }
    m.slab(`snowshoe-${index + 1}-metal-binding-plate`, .22, .28, .025, [x, .12, -.02], C.iron)
    for (const z of [-.15, .15]) m.cylinder(`snowshoe-${index + 1}-metal-binding`, .028, .028, .18, [x, .16, z], C.woodDark, 8, [PI / 2, 0, 0])
    for (const z of [-.15, .15]) {
      tube(m, `snowshoe-${index + 1}-leather-strap`, [[x - .19, .14, z], [x, .18, z], [x + .19, .14, z]], .018, C.cloth, 14, 6)
      ring(m, `snowshoe-${index + 1}-metal-strap-buckle`, .040, .010, [x, .19, z], C.ironLight, [PI / 2, 0, 0], 6, 16)
    }
    for (const z of [-.39, .39]) for (const dx of [-.12, .12]) {
      const tooth = m.mesh(`snowshoe-${index + 1}-metal-crampon-tooth`, new THREE.ConeGeometry(.022, .075, 8), [x + dx, .035, z], C.iron)
      tooth.rotation.z = PI
    }
    for (const z of [-.40, .40]) tube(m, `snowshoe-${index + 1}-tail`, [[x, .08, z], [x, .12, z + (z > 0 ? .08 : -.08)]], .024, color, 12, 6)
  }
  return finish(m, [1.3, 1.3, .15])
}

function archWedge(model, name, centerY, innerRadius, outerRadius, start, end, depth, color) {
  const points = [
    [Math.cos(start) * outerRadius, centerY + Math.sin(start) * outerRadius],
    [Math.cos(end) * outerRadius, centerY + Math.sin(end) * outerRadius],
    [Math.cos(end) * innerRadius, centerY + Math.sin(end) * innerRadius],
    [Math.cos(start) * innerRadius, centerY + Math.sin(start) * innerRadius],
  ]
  return prism(model, name, points, depth, [0, 0, 0], color, .012)
}

function buildSandstoneArch() {
  const m = new Model('sandstone_arch')
  for (const side of [-1, 1]) {
    const x = side * 1.03
    for (let index = 0; index < 3; index += 1) plank(m, 'arch-pillar-block', [.52, .55, .70], [x + (index % 2 ? side * .025 : 0), .36 + index * .52, 0], index % 2 ? C.stoneLight : C.stone)
    for (const y of [.635, 1.155, 1.675]) plank(m, 'arch-pillar-mortar-joint', [.55, .018, .715], [x, y, 0], C.stoneDark)
    plank(m, 'arch-foundation', [.70, .78, .24], [x, .12, 0], C.stoneDark)
  }
  const centerY = 1.24
  for (let index = 0; index < 9; index += 1) {
    const start = (18 + index * 16) * PI / 180
    const end = (18 + (index + 1) * 16 - 2) * PI / 180
    archWedge(m, 'arch-vault-stone', centerY, .54, .96, start, end, .70, index % 3 === 1 ? C.stoneLight : C.stone)
    if (index % 2 === 0) ring(m, 'arch-stone-chisel-mark', .035, .008, [Math.cos((start + end) / 2) * .76, centerY + Math.sin((start + end) / 2) * .76, -.37], C.stoneDark, [PI / 2, 0, 0], 5, 12)
    const face = archWedge(m, 'arch-front-voussoir-face', centerY, .57, .92, start, end, .065, index % 3 === 1 ? C.stoneLight : C.stoneDark)
    face.position.z = -.36
    archWedge(m, 'arch-inner-lining-stone', centerY, .51, .59, start, end, .72, C.stoneDark)
    const backFace = archWedge(m, 'arch-back-voussoir-face', centerY, .57, .92, start, end, .065, index % 3 === 1 ? C.stoneLight : C.stoneDark)
    backFace.position.z = .36
  }
  prism(m, 'arch-broken-cap', [[.66, 1.74], [1.02, 1.92], [1.17, 1.67], [.84, 1.52]], .70, [0, 0, 0], C.stoneDark, .015)
  for (const [x, y, z, size, color] of [[.70, .12, -.35, .16, C.stoneLight], [.91, .10, -.22, .13, C.stone], [1.16, .16, .28, .18, C.stoneDark], [-.80, .11, .32, .11, C.stoneLight]]) m.mesh('arch-rubble', new THREE.DodecahedronGeometry(size, 1), [x, y, z], color)
  return finish(m, [2.8, .8, 2.6])
}

function clothPanel(model, name, leftRidge, rightRidge, rightEave, leftEave, color) {
  const columns = 12, rows = 6
  const positions = [], indices = []
  const lerp = (a, b, t) => a + (b - a) * t
  const point = (u, v) => {
    const ridge = leftRidge.map((value, index) => lerp(value, rightRidge[index], u))
    const eave = leftEave.map((value, index) => lerp(value, rightEave[index], u))
    return ridge.map((value, index) => lerp(value, eave[index], v))
  }
  for (let row = 0; row <= rows; row += 1) for (let column = 0; column <= columns; column += 1) {
    const p = point(column / columns, row / rows)
    p[1] -= Math.sin(column / columns * PI) * .025 * (1 - row / rows)
    positions.push(...p)
  }
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const a = row * (columns + 1) + column
    const b = a + 1
    const c = a + columns + 1
    const d = c + 1
    indices.push(a, c, b, b, c, d)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return model.mesh(name, geometry, [0, 0, 0], color)
}

function clothGable(model, name, x, color) {
  const thickness = .028
  const positions = [
    x - thickness / 2, .34, -1.20, x - thickness / 2, .34, 1.20, x - thickness / 2, 1.68, 0,
    x + thickness / 2, .34, -1.20, x + thickness / 2, .34, 1.20, x + thickness / 2, 1.68, 0,
  ]
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex([0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 2, 5, 4, 2, 4, 1, 1, 4, 3, 1, 3, 0])
  geometry.computeVertexNormals()
  return model.mesh(name, geometry, [0, 0, 0], color)
}

function buildNomadTent() {
  const m = new Model('nomad_tent')
  const colors = [C.red, C.clothLight, C.sand, C.cloth, C.red]
  for (let index = 0; index < colors.length; index += 1) {
    const left = -1.25 + index * .50
    const right = left + .50
    clothPanel(m, 'tent-front-roof-cloth', [left, 1.68, 0], [right, 1.68, 0], [right, .34, -1.20], [left, .34, -1.20], colors[index])
    clothPanel(m, 'tent-back-roof-cloth', [left, 1.68, 0], [right, 1.68, 0], [right, .34, 1.20], [left, .34, 1.20], colors[(index + 2) % colors.length])
  }
  clothGable(m, 'tent-cloth-left-gable', -1.25, C.cloth)
  clothGable(m, 'tent-cloth-right-gable', 1.25, C.red)
  clothPanel(m, 'tent-back-wall', [-1.22, .34, 1.205], [1.22, .34, 1.205], [1.22, .11, 1.205], [-1.22, .11, 1.205], C.cloth)
  clothPanel(m, 'tent-front-wall-left', [-1.22, .34, -1.205], [-.25, .34, -1.205], [-.25, .11, -1.205], [-1.22, .11, -1.205], C.red)
  clothPanel(m, 'tent-front-wall-right', [.25, .34, -1.205], [1.22, .34, -1.205], [1.22, .11, -1.205], [.25, .11, -1.205], C.clothLight)
  clothPanel(m, 'tent-door-flap', [-.25, .34, -1.215], [.25, .34, -1.215], [.10, .10, -1.24], [-.08, .12, -1.24], C.red)
  tube(m, 'tent-ridge-rope', [[-1.29, 1.70, 0], [0, 1.73, 0], [1.29, 1.70, 0]], .035, C.rope, 24, 7)
  for (const x of [-1.25, -.75, -.25, .25, .75, 1.25]) tube(m, 'tent-front-seam', [[x, 1.69, 0], [x, .95, -.64], [x, .34, -1.20]], .014, C.rope, 16, 6)
  for (const x of [-1.25, -.75, -.25, .25, .75, 1.25]) tube(m, 'tent-back-seam', [[x, 1.69, 0], [x, .95, .64], [x, .34, 1.20]], .014, C.rope, 16, 6)
  tube(m, 'tent-front-eave-rope', [[-1.25, .34, -1.21], [0, .34, -1.21], [1.25, .34, -1.21]], .024, C.rope, 20, 6)
  tube(m, 'tent-back-eave-rope', [[-1.25, .34, 1.21], [0, .34, 1.21], [1.25, .34, 1.21]], .024, C.rope, 20, 6)
  for (const [x, z] of [[-1.25, -1.20], [1.25, -1.20], [-1.25, 1.20], [1.25, 1.20]]) {
    m.cylinder('tent-corner-peg', .035, .045, .28, [x, .14, z], C.woodDark, 10)
    tube(m, 'tent-guy-line', [[x, .36, z], [x * 1.05, .12, z * 1.06]], .012, C.rope, 10, 5)
  }
  m.cylinder('tent-center-pole', .05, .06, 1.66, [0, .83, 0], C.woodDark, 14)
  return finish(m, [2.8, 2.8, 1.8])
}

function buildMangroveRoots() {
  const m = new Model('mangrove_roots')
  lathe(m, 'mangrove-stump', [[.15, 0], [.30, .05], [.34, .20], [.29, .55], [.25, .80], [.21, .88]], [0, .02, 0], C.woodDark, 28)
  ring(m, 'mangrove-stump-growth-ring', .20, .018, [0, .88, 0], C.woodLight, [PI / 2, 0, 0], 7, 24)
  const roots = [
    [[0, .18, 0], [-.26, .20, -.18], [-.55, .33, -.32], [-.98, .18, -.60], [-1.32, .08, -.74]],
    [[0, .17, 0], [.30, .27, -.12], [.66, .36, -.27], [1.05, .16, -.46], [1.34, .07, -.58]],
    [[0, .20, 0], [.18, .36, .34], [.46, .52, .65], [.70, .23, 1.04], [.96, .08, 1.28]],
    [[0, .20, 0], [-.25, .32, .31], [-.56, .45, .54], [-.92, .19, .83], [-1.22, .08, 1.08]],
    [[0, .28, 0], [-.14, .54, -.10], [-.22, .78, -.28], [-.52, .33, -.78], [-.74, .08, -1.26]],
    [[0, .28, 0], [.16, .56, .12], [.27, .80, .25], [.46, .36, .71], [.60, .08, 1.26]],
    [[-.05, .17, 0], [-.47, .18, .05], [-.78, .28, .10], [-1.12, .14, .28], [-1.34, .08, .34]],
    [[.05, .17, 0], [.44, .18, .05], [.78, .25, .10], [1.12, .14, .27], [1.35, .08, .35]],
  ]
  for (const [rootIndex, path] of roots.entries()) {
    const radius = rootIndex < 4 ? .125 : .092
    taperedTube(m, `mangrove-root-${rootIndex + 1}`, path, radius, radius * .38, rootIndex % 2 ? C.wood : C.woodLight, 34, 9)
    if (rootIndex < 4) {
      const branch = path[2]
      const end = [branch[0] * 1.12, branch[1] + .10, branch[2] * 1.08]
      taperedTube(m, `mangrove-root-branch-${rootIndex + 1}`, [branch, [branch[0] * 1.08, branch[1] + .12, branch[2] * 1.03], end], .060, .020, C.woodDark, 22, 8)
      m.mesh('mangrove-root-junction', new THREE.DodecahedronGeometry(.105, 1), branch, C.wood)
    }
  }
  ring(m, 'mangrove-root-collar', .34, .075, [0, .20, 0], C.wood, [PI / 2, 0, 0], 8, 28)
  return finish(m, [2.8, 2.8, 1.4])
}

function buildSwampBoardwalk() {
  const m = new Model('swamp_boardwalk')
  for (const z of [-.42, .42]) {
    tube(m, 'boardwalk-lag', [[-1.28, .11, z], [-.64, .10, z], [0, .10, z], [.64, .11, z], [1.28, .10, z]], .072, C.woodDark, 30, 8)
    ring(m, 'boardwalk-metal-lag-end', .085, .018, [-1.22, .11, z], C.iron, [PI / 2, 0, 0], 6, 16)
    for (const x of [-.96, -.32, .32, .96]) ring(m, 'boardwalk-metal-lag-strap', .085, .012, [x, .11, z], C.iron, [0, PI / 2, 0], 7, 20)
  }
  const plankColors = [C.wood, C.woodLight, C.woodDark, C.wood, C.woodLight]
  for (let index = 0; index < 5; index += 1) {
    const x = -.98 + index * .49
    plank(m, 'boardwalk-plank', [.40, .13, 1.04], [x, .25, 0], plankColors[index], [0, 0, (index - 2) * .012])
    for (const z of [-.37, .37]) {
      plank(m, 'boardwalk-mortise-block', [.13, .10, .13], [x, .185, z], C.woodEdge)
      addNail(m, 'boardwalk-metal-fastener', [x, .34, z])
      ring(m, 'boardwalk-fastener-washer', .030, .008, [x, .356, z], C.ironLight, [0, 0, 0], 6, 12)
    }
    for (const z of [-.20, .20]) tube(m, 'boardwalk-board-grain', [[x - .12, .322, z], [x + .12, .322, z + .01]], .006, C.woodDark, 10, 5)
  }
  for (const x of [-.95, -.32, .32, .95]) {
    tube(m, 'boardwalk-under-crossbrace', [[x, .04, -.48], [x, .04, .48]], .035, C.woodEdge, 14, 7)
    addNail(m, 'boardwalk-metal-brace-nail', [x, .13, -.42])
  }
  tube(m, 'boardwalk-side-rope-front', [[-1.24, .08, -.48], [0, .08, -.48], [1.24, .08, -.48]], .018, C.rope, 24, 6)
  tube(m, 'boardwalk-side-rope-back', [[-1.24, .08, .48], [0, .08, .48], [1.24, .08, .48]], .018, C.rope, 24, 6)
  return finish(m, [2.8, 1.3, .35])
}

export const MODEL_IDS = Object.freeze([
  'alchemy_table', 'crystal_orb', 'arcane_coil', 'anchor',
  'capstan', 'dock_crane', 'cargo_sled', 'snowshoe_pair',
  'sandstone_arch', 'nomad_tent', 'mangrove_roots', 'swamp_boardwalk',
])

const BUILDERS = Object.freeze({
  alchemy_table: buildAlchemyTable,
  crystal_orb: buildCrystalOrb,
  arcane_coil: buildArcaneCoil,
  anchor: buildAnchor,
  capstan: buildCapstan,
  dock_crane: buildDockCrane,
  cargo_sled: buildCargoSled,
  snowshoe_pair: buildSnowshoePair,
  sandstone_arch: buildSandstoneArch,
  nomad_tent: buildNomadTent,
  mangrove_roots: buildMangroveRoots,
  swamp_boardwalk: buildSwampBoardwalk,
})

/** @param {string} id @returns {THREE.Group} */
export function createModel(id) {
  const build = BUILDERS[id]
  if (!build) throw new Error(`Unknown urban-wilderness model: ${id}`)
  return build()
}
