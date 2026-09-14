/**
 * Небольшая библиотека оригинальных моделей для поселения и подземелья.
 *
 * API намеренно не занимается экспортом и публикацией: сборщик GLB владеет
 * I/O, а этот модуль только создаёт свежую параметрическую THREE.Group.
 * Все рецепты детерминированы, их основание лежит на y=0, а габарит после
 * `finish()` центрирован по x/z. `footprint` в каталоге — семантический
 * габарит записи карты в клетках; геометрия помещается внутрь него.
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

const COLORS = Object.freeze({
  wood: '#65462f',
  woodLight: '#98714a',
  woodDark: '#30251d',
  stone: '#6d6d66',
  stoneLight: '#9b9888',
  stoneDark: '#383a36',
  metal: '#494b49',
  metalLight: '#77776c',
  water: '#3f7071',
  glass: '#6d9290',
  straw: '#b18a48',
  rope: '#8d7046',
  earth: '#57412e',
  bone: '#d6c9a9',
  boneShadow: '#897c65',
  dark: '#191817',
  ember: '#b15b32',
})

/** @typedef {{w:number,h:number}} Footprint */
/** @typedef {{assetId:string,key:string,label:string,category:string,file:string,yaw:number,textures:readonly string[],footprint:Footprint}} ExtraModelSpec */

const entry = (assetId, key, label, category, footprint, textures) => Object.freeze({
  assetId,
  key,
  label,
  category,
  file: `${key}.glb`,
  yaw: 0,
  textures: Object.freeze([...textures]),
  footprint: Object.freeze({ ...footprint }),
})

/** Каталог подключается сборщиком к общему manifest, но сам ничего не пишет. */
/** @type {readonly ExtraModelSpec[]} */
export const EXTRA_MODELS = Object.freeze([
  entry('tree_dead', 'sk-tree-dead', 'Мёртвое дерево', 'Поселение', { w: 0.62, h: 0.62 }, ['wood']),
  entry('wagon_wheel', 'sk-wagon-wheel', 'Колесо телеги', 'Поселение', { w: 0.62, h: 0.62 }, ['wood', 'metal']),
  entry('hitching_post', 'sk-hitching-post', 'Коновязь', 'Поселение', { w: 0.62, h: 0.62 }, ['wood', 'metal']),
  entry('water_trough', 'sk-water-trough', 'Поилка', 'Поселение', { w: 2, h: 1 }, ['wood', 'metal', 'water']),
  entry('well', 'sk-well', 'Колодец', 'Поселение', { w: 2, h: 2 }, ['stone', 'wood', 'metal', 'rope', 'dark']),
  entry('lamp_post', 'sk-lamp-post', 'Фонарь на столбе', 'Поселение', { w: 0.62, h: 0.62 }, ['metal', 'glass', 'ember']),
  entry('haystack', 'sk-haystack', 'Стог сена', 'Поселение', { w: 2, h: 2 }, ['straw', 'rope', 'earth']),
  entry('milestone', 'sk-milestone', 'Придорожный камень', 'Поселение', { w: 0.62, h: 0.62 }, ['stone']),
  entry('roadside_shrine', 'sk-roadside-shrine', 'Придорожная часовня', 'Поселение', { w: 0.62, h: 0.62 }, ['stone', 'wood']),
  entry('grave', 'sk-grave', 'Могила', 'Склеп', { w: 2, h: 1 }, ['stone', 'earth']),
  entry('bone_pile', 'sk-bone-pile', 'Куча костей', 'Склеп', { w: 0.9, h: 0.76 }, ['bone', 'dark']),
  entry('rubble_heap', 'sk-rubble-heap', 'Куча обломков', 'Подземелье', { w: 0.62, h: 0.62 }, ['stone', 'earth']),
])

const SPEC_BY_ASSET = new Map(EXTRA_MODELS.map((item) => [item.assetId, item]))

function material(name, color = COLORS[name] ?? COLORS.stone, options = {}) {
  const value = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.86,
    metalness: name.startsWith('metal') ? 0.45 : 0.035,
    ...options,
  })
  // sharedtextureembed подбирает текстуру по этому стабильному имени.
  value.name = name
  return value
}

function mesh(parent, name, geometry, value, position = [0, 0, 0], rotation = [0, 0, 0], castShadow = true) {
  const object = new THREE.Mesh(geometry, value)
  object.name = name
  object.position.set(...position)
  object.rotation.set(...rotation)
  object.castShadow = castShadow
  object.receiveShadow = true
  parent.add(object)
  return object
}

function box(parent, name, size, position, value, rotation = [0, 0, 0], castShadow = true) {
  return mesh(parent, name, new THREE.BoxGeometry(...size), value, position, rotation, castShadow)
}

function roundedBox(parent, name, size, position, value, radius = 0.035, rotation = [0, 0, 0], castShadow = true) {
  const safeRadius = Math.min(radius, ...size.map((item) => Math.max(0.001, item / 2)))
  return mesh(parent, name, new RoundedBoxGeometry(...size, 2, safeRadius), value, position, rotation, castShadow)
}

function cylinder(parent, name, radiusTop, radiusBottom, height, position, value, segments = 10, rotation = [0, 0, 0], castShadow = true) {
  return mesh(parent, name, new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), value, position, rotation, castShadow)
}

function torus(parent, name, radius, tube, position, value, rotation = [0, 0, 0], castShadow = true) {
  return mesh(parent, name, new THREE.TorusGeometry(radius, tube, 8, 18), value, position, rotation, castShadow)
}

function cone(parent, name, radius, height, position, value, segments = 8, castShadow = true) {
  return cylinder(parent, name, 0, radius, height, position, value, segments, [0, 0, 0], castShadow)
}

function rock(parent, name, size, position, value, rotation = [0, 0, 0]) {
  const object = mesh(parent, name, new THREE.DodecahedronGeometry(0.5, 0), value, position, rotation)
  object.scale.set(...size)
  return object
}

/** Тонкий цилиндр между двумя мировыми точками, удобный для ветвей и костей. */
function beam(parent, name, start, end, radius, value, segments = 8, castShadow = true) {
  const a = new THREE.Vector3(...start)
  const b = new THREE.Vector3(...end)
  const direction = b.clone().sub(a)
  const length = direction.length()
  if (length < 0.0001) return null
  const object = mesh(parent, name, new THREE.CylinderGeometry(radius * 0.82, radius, length, segments), value,
    a.clone().add(b).multiplyScalar(0.5), [0, 0, 0], castShadow)
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  return object
}

function arch(parent, name, width, bottom, radius, depth, value) {
  const outer = radius + width / 2
  const inner = Math.max(0.035, radius - width / 2)
  const shape = new THREE.Shape()
  const segments = 16
  shape.moveTo(-outer, bottom)
  for (let index = 0; index <= segments; index += 1) {
    const angle = Math.PI - (index * Math.PI) / segments
    shape.lineTo(Math.cos(angle) * outer, bottom + Math.sin(angle) * outer)
  }
  shape.lineTo(inner, bottom)
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index * Math.PI) / segments
    shape.lineTo(Math.cos(angle) * inner, bottom + Math.sin(angle) * inner)
  }
  shape.lineTo(-inner, bottom)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1, steps: 1 })
  geometry.translate(0, 0, -depth / 2)
  return mesh(parent, name, geometry, value)
}

function tube(parent, name, points, radius, value, segments = 8, radialSegments = 6) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, 'centripetal')
  return mesh(parent, name, new THREE.TubeGeometry(curve, segments, radius, radialSegments, false), value)
}

/**
 * Рецепты добавляют только прямых детей root, поэтому сдвиг не ломает
 * локальные pivot-ы и делает проверяемыми bounds модели независимо от рецепта.
 */
function finish(root, assetId) {
  const footprint = SPEC_BY_ASSET.get(assetId)?.footprint
  root.name = `settlement:${assetId}`
  root.userData = { assetId, recipe: 'skazanie-settlement-props-v1', footprint: footprint ? { ...footprint } : undefined }
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

function buildDeadTree() {
  const root = new THREE.Group()
  const wood = material('wood', COLORS.wood)
  const dark = material('wood', COLORS.woodDark)
  const cut = material('wood', COLORS.woodLight)

  beam(root, 'dead-tree-trunk', [-0.01, 0.07, 0], [-0.015, 0.72, 0.015], 0.105, wood, 8)
  beam(root, 'dead-tree-trunk-upper', [-0.015, 0.66, 0.015], [-0.065, 1.16, 0.02], 0.085, wood, 7)
  beam(root, 'dead-tree-crown', [-0.065, 1.1, 0.02], [0.02, 1.46, 0.015], 0.065, dark, 7)
  beam(root, 'dead-tree-branch-left', [-0.035, 0.85, 0.015], [-0.23, 1.16, 0.035], 0.048, wood, 7)
  beam(root, 'dead-tree-branch-left-tip', [-0.23, 1.16, 0.035], [-0.27, 1.38, 0.04], 0.032, dark, 7)
  beam(root, 'dead-tree-branch-right', [-0.05, 0.99, 0.015], [0.21, 1.2, -0.035], 0.046, wood, 7)
  beam(root, 'dead-tree-branch-right-tip', [0.21, 1.2, -0.035], [0.27, 1.38, -0.04], 0.028, dark, 7)
  beam(root, 'dead-tree-crown-cut', [0.015, 1.43, 0.015], [0.025, 1.49, 0.015], 0.05, cut, 7, false)
  beam(root, 'dead-tree-left-cut', [-0.26, 1.36, 0.04], [-0.275, 1.41, 0.04], 0.032, cut, 7, false)
  beam(root, 'dead-tree-right-cut', [0.26, 1.36, -0.04], [0.275, 1.4, -0.04], 0.028, cut, 7, false)
  beam(root, 'dead-tree-root-left', [-0.02, 0.1, 0], [-0.23, 0.035, 0.06], 0.04, dark, 7)
  beam(root, 'dead-tree-root-right', [-0.005, 0.1, 0], [0.2, 0.035, -0.06], 0.04, dark, 7)
  beam(root, 'dead-tree-root-front', [0, 0.1, 0.01], [0.02, 0.035, 0.2], 0.035, dark, 7)
  return finish(root, 'tree_dead')
}

function buildWagonWheel() {
  const root = new THREE.Group()
  const wood = material('wood', COLORS.wood)
  const dark = material('wood', COLORS.woodDark)
  const metal = material('metal', COLORS.metal, { metalness: 0.58, roughness: 0.54 })
  const centerY = 0.3
  // TorusGeometry по умолчанию лежит в X/Y: это та же вертикальная плоскость,
  // в которой beam-спицы идут от ступицы к ободу.
  torus(root, 'wagon-wheel-rim', 0.258, 0.038, [0, centerY, 0], wood)
  torus(root, 'wagon-wheel-tread', 0.258, 0.012, [0, centerY, -0.042], metal, undefined, false)
  for (let index = 0; index < 8; index += 1) {
    const angle = index * Math.PI / 4
    beam(root, `wagon-wheel-spoke-${index + 1}`, [0, centerY, 0], [Math.sin(angle) * 0.245, centerY + Math.cos(angle) * 0.245, 0], 0.018, dark, 6)
  }
  cylinder(root, 'wagon-wheel-hub', 0.07, 0.075, 0.11, [0, centerY, 0], dark, 10, [Math.PI / 2, 0, 0])
  cylinder(root, 'wagon-wheel-hub-cap', 0.045, 0.045, 0.122, [0, centerY, 0.006], metal, 8, [Math.PI / 2, 0, 0], false)
  return finish(root, 'wagon_wheel')
}

function buildHitchingPost() {
  const root = new THREE.Group()
  const wood = material('wood', COLORS.wood)
  const dark = material('wood', COLORS.woodDark)
  const metal = material('metal', COLORS.metal, { metalness: 0.62, roughness: 0.5 })
  roundedBox(root, 'hitching-post-foot', [0.28, 0.09, 0.24], [0, 0.045, 0], dark, 0.025)
  cylinder(root, 'hitching-post-shaft', 0.06, 0.085, 0.83, [0, 0.48, 0], wood, 8)
  roundedBox(root, 'hitching-post-cap', [0.16, 0.07, 0.16], [0, 0.91, 0], dark, 0.025)
  box(root, 'hitching-post-crossbar', [0.5, 0.075, 0.075], [0, 0.76, 0], wood, [0, 0, 0])
  for (const x of [-0.17, 0.17]) {
    torus(root, 'hitching-post-ring', 0.072, 0.013, [x, 0.7, 0.06], metal, [0, 0, 0], false)
    box(root, 'hitching-post-ring-staple', [0.025, 0.12, 0.025], [x, 0.73, 0.005], metal, undefined, false)
  }
  return finish(root, 'hitching_post')
}

function buildWaterTrough() {
  const root = new THREE.Group()
  const wood = material('wood', COLORS.wood)
  const dark = material('wood', COLORS.woodDark)
  const metal = material('metal', COLORS.metal, { metalness: 0.48, roughness: 0.55 })
  const water = material('water', COLORS.water, { transparent: true, opacity: 0.78, roughness: 0.3 })
  const width = 1.72
  const depth = 0.72
  roundedBox(root, 'trough-bottom', [width, 0.12, depth], [0, 0.1, 0], wood, 0.035)
  for (const z of [-depth / 2 + 0.055, depth / 2 - 0.055]) {
    roundedBox(root, 'trough-side-wall', [width, 0.38, 0.11], [0, 0.32, z], wood, 0.025)
    box(root, 'trough-side-rim', [width + 0.02, 0.045, 0.035], [0, 0.53, z], dark, undefined, false)
  }
  for (const x of [-width / 2 + 0.055, width / 2 - 0.055]) {
    roundedBox(root, 'trough-end-wall', [0.11, 0.38, depth - 0.08], [x, 0.32, 0], wood, 0.025)
    box(root, 'trough-end-band', [0.035, 0.32, depth - 0.1], [x + Math.sign(x) * 0.06, 0.32, 0], metal, undefined, false)
  }
  // Открытая чаша: вода лежит ниже кромки, а между стенами остаётся пустой объём.
  box(root, 'trough-water', [width - 0.24, 0.022, depth - 0.22], [0, 0.41, 0], water, undefined, false)
  for (const x of [-0.6, 0.6]) {
    box(root, 'trough-leg-front', [0.11, 0.16, 0.1], [x, 0.02, 0.24], dark)
    box(root, 'trough-leg-back', [0.11, 0.16, 0.1], [x, 0.02, -0.24], dark)
  }
  return finish(root, 'water_trough')
}

function buildWell() {
  const root = new THREE.Group()
  const stone = material('stone', COLORS.stone)
  const stoneLight = material('stone', COLORS.stoneLight)
  const stoneDark = material('stone', COLORS.stoneDark)
  const wood = material('wood', COLORS.wood)
  const darkWood = material('wood', COLORS.woodDark)
  const metal = material('metal', COLORS.metal, { metalness: 0.55, roughness: 0.54 })
  const dark = material('dark', COLORS.dark)

  // Два неполных ряда блоков и торцевые кольца оставляют настоящий проём.
  for (const [course, y] of [[0, 0.11], [1, 0.31]]) {
    for (let index = 0; index < 10; index += 1) {
      const angle = index * Math.PI * 2 / 10 + (course ? Math.PI / 10 : 0)
      const radius = 0.59
      const block = roundedBox(root, 'well-masonry-block', [0.34, 0.17, 0.23],
        [Math.cos(angle) * radius, y, Math.sin(angle) * radius], course ? stone : stoneLight, 0.025,
        [0, -angle - Math.PI / 2, 0])
      block.userData.course = course
    }
  }
  torus(root, 'well-masonry-lower-ring', 0.59, 0.105, [0, 0.2, 0], stoneDark, [Math.PI / 2, 0, 0])
  torus(root, 'well-masonry-upper-ring', 0.59, 0.105, [0, 0.42, 0], stoneLight, [Math.PI / 2, 0, 0])
  cylinder(root, 'well-opening', 0.47, 0.47, 0.025, [0, 0.39, 0], dark, 16, undefined, false)

  for (const x of [-0.67, 0.67]) {
    cylinder(root, 'well-post', 0.065, 0.09, 0.84, [x, 0.75, 0], wood, 8)
    box(root, 'well-post-brace', [0.1, 0.12, 0.24], [x, 0.48, 0], darkWood)
  }
  cylinder(root, 'well-winch-axle', 0.04, 0.04, 1.48, [0, 1.03, 0], wood, 8, [0, 0, Math.PI / 2])
  torus(root, 'well-winch-spool', 0.095, 0.018, [0, 1.03, 0], metal, [0, Math.PI / 2, 0])
  beam(root, 'well-rope', [0, 0.98, 0], [0, 0.55, 0], 0.014, material('rope', COLORS.rope), 6, false)
  cylinder(root, 'well-crank-arm', 0.025, 0.025, 0.2, [0.74, 0.92, 0], metal, 7, [0, 0, Math.PI / 2], false)
  box(root, 'well-crank-handle', [0.055, 0.16, 0.055], [0.84, 0.82, 0], metal, undefined, false)

  const roof = material('wood', COLORS.woodDark)
  box(root, 'well-roof-board-left', [0.78, 0.1, 1.35], [-0.3, 1.34, 0], roof, [0, 0, 0.56])
  box(root, 'well-roof-board-right', [0.78, 0.1, 1.35], [0.3, 1.34, 0], roof, [0, 0, -0.56])
  cylinder(root, 'well-roof-ridge', 0.045, 0.045, 1.38, [0, 1.58, 0], wood, 8, [Math.PI / 2, 0, 0])
  return finish(root, 'well')
}

function buildLampPost() {
  const root = new THREE.Group()
  const metal = material('metal', COLORS.metal, { metalness: 0.66, roughness: 0.48 })
  const metalLight = material('metal', COLORS.metalLight, { metalness: 0.55, roughness: 0.5 })
  const glass = material('glass', COLORS.glass, { transparent: true, opacity: 0.38, roughness: 0.22 })
  const ember = material('ember', COLORS.ember, { emissive: COLORS.ember, emissiveIntensity: 0.42, transparent: true, opacity: 0.86 })
  cylinder(root, 'lamp-post-base', 0.15, 0.18, 0.12, [0, 0.06, 0], metalLight, 10)
  cylinder(root, 'lamp-post-shaft', 0.045, 0.065, 1.24, [0, 0.68, 0], metal, 8)
  cylinder(root, 'lamp-post-collar', 0.105, 0.105, 0.06, [0, 1.25, 0], metalLight, 10)
  for (const [x, z] of [[-0.11, -0.11], [0.11, -0.11], [-0.11, 0.11], [0.11, 0.11]]) {
    box(root, 'lamp-frame-post', [0.025, 0.25, 0.025], [x, 1.4, z], metal, undefined, false)
  }
  box(root, 'lamp-glass-front', [0.19, 0.18, 0.018], [0, 1.4, 0.116], glass, undefined, false)
  box(root, 'lamp-glass-back', [0.19, 0.18, 0.018], [0, 1.4, -0.116], glass, undefined, false)
  box(root, 'lamp-glass-left', [0.018, 0.18, 0.19], [-0.116, 1.4, 0], glass, undefined, false)
  box(root, 'lamp-glass-right', [0.018, 0.18, 0.19], [0.116, 1.4, 0], glass, undefined, false)
  cylinder(root, 'lamp-ember', 0.055, 0.055, 0.07, [0, 1.35, 0], ember, 8, undefined, false)
  roundedBox(root, 'lamp-roof', [0.34, 0.07, 0.34], [0, 1.56, 0], metalLight, 0.025)
  cone(root, 'lamp-finial', 0.055, 0.12, [0, 1.65, 0], metal, 8)
  return finish(root, 'lamp_post')
}

function buildHaystack() {
  const root = new THREE.Group()
  const straw = material('straw', COLORS.straw)
  const rope = material('rope', COLORS.rope)
  const earth = material('earth', COLORS.earth)
  const profile = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(0.42, 0.03),
    new THREE.Vector2(0.64, 0.16),
    new THREE.Vector2(0.72, 0.42),
    new THREE.Vector2(0.68, 0.68),
    new THREE.Vector2(0.5, 0.94),
    new THREE.Vector2(0.27, 1.14),
    new THREE.Vector2(0, 1.22),
  ]
  mesh(root, 'haystack-body', new THREE.LatheGeometry(profile, 14), straw)
  for (const [y, radius] of [[0.3, 0.69], [0.62, 0.66], [0.86, 0.55]]) {
    torus(root, 'haystack-rope-band', radius, 0.022, [0, y, 0], rope, [Math.PI / 2, 0, 0], false)
  }
  for (const [x, z, rot] of [[-0.25, 0.25, 0.3], [0.26, -0.18, -0.24], [0, 0.36, 0.08]]) {
    cone(root, 'haystack-loose-straw', 0.08, 0.24, [x, 1.08, z], straw, 6, false).rotation.z = rot
  }
  cylinder(root, 'haystack-earth-shadow', 0.5, 0.66, 0.025, [0, 0.012, 0], earth, 12, undefined, false)
  return finish(root, 'haystack')
}

function buildMilestone() {
  const root = new THREE.Group()
  const stone = material('stone', COLORS.stone)
  const light = material('stone', COLORS.stoneLight)
  const dark = material('stone', COLORS.stoneDark)
  roundedBox(root, 'milestone-base', [0.5, 0.12, 0.3], [0, 0.06, 0], dark, 0.035)
  roundedBox(root, 'milestone-body', [0.38, 0.64, 0.2], [0, 0.4, 0], stone, 0.06)
  roundedBox(root, 'milestone-cap', [0.42, 0.1, 0.23], [0, 0.77, 0], light, 0.04)
  box(root, 'milestone-arrow-stem', [0.035, 0.22, 0.018], [0, 0.42, 0.115], dark, undefined, false)
  box(root, 'milestone-arrow-left', [0.14, 0.035, 0.018], [-0.055, 0.34, 0.115], dark, [0, 0, -0.55], false)
  box(root, 'milestone-arrow-right', [0.14, 0.035, 0.018], [0.055, 0.34, 0.115], dark, [0, 0, 0.55], false)
  return finish(root, 'milestone')
}

function buildRoadsideShrine() {
  const root = new THREE.Group()
  const stone = material('stone', COLORS.stone)
  const light = material('stone', COLORS.stoneLight)
  const dark = material('stone', COLORS.stoneDark)
  const wood = material('wood', COLORS.wood)
  const width = 0.54
  box(root, 'shrine-back', [0.46, 0.96, 0.1], [0, 0.5, -0.09], stone)
  for (const x of [-0.22, 0.22]) roundedBox(root, 'shrine-pilaster', [0.1, 0.72, 0.24], [x, 0.4, 0], light, 0.025)
  box(root, 'shrine-niche', [0.32, 0.42, 0.018], [0, 0.58, 0.115], dark, undefined, false)
  arch(root, 'shrine-arch', 0.095, 0.72, 0.19, 0.24, light)
  box(root, 'shrine-shelf', [width, 0.08, 0.28], [0, 0.34, 0.02], light, undefined, false)
  box(root, 'shrine-canopy', [0.58, 0.08, 0.34], [0, 1.01, 0], wood, [0, 0, 0.08])
  cylinder(root, 'shrine-finial', 0.035, 0.045, 0.11, [0, 1.1, 0], light, 7)
  box(root, 'shrine-icon-stem', [0.03, 0.2, 0.025], [0, 0.63, 0.13], light, undefined, false)
  box(root, 'shrine-icon-crossbar', [0.12, 0.03, 0.025], [0, 0.68, 0.13], light, undefined, false)
  return finish(root, 'roadside_shrine')
}

function buildGrave() {
  const root = new THREE.Group()
  const stone = material('stone', COLORS.stone)
  const light = material('stone', COLORS.stoneLight)
  const dark = material('stone', COLORS.stoneDark)
  const earth = material('earth', COLORS.earth)
  cylinder(root, 'grave-mound', 0.26, 0.44, 0.24, [0, 0.12, 0.12], earth, 12, [0, 0, 0], false)
  roundedBox(root, 'grave-foot', [0.72, 0.1, 0.3], [0, 0.05, -0.22], dark, 0.025)
  roundedBox(root, 'grave-headstone', [0.5, 0.72, 0.15], [0, 0.43, -0.23], stone, 0.07)
  box(root, 'grave-cross-vertical', [0.055, 0.3, 0.025], [0, 0.46, -0.145], light, undefined, false)
  box(root, 'grave-cross-horizontal', [0.2, 0.055, 0.025], [0, 0.53, -0.145], light, undefined, false)
  box(root, 'grave-plaque', [0.24, 0.08, 0.018], [0, 0.3, -0.145], dark, undefined, false)
  return finish(root, 'grave')
}

function buildBonePile() {
  const root = new THREE.Group()
  const bone = material('bone', COLORS.bone)
  const shadow = material('bone', COLORS.boneShadow)
  const dark = material('dark', COLORS.dark)

  // Три U-образных ребра образуют узнаваемую клетку, а не россыпь шаров.
  for (const [index, z] of [-0.14, 0, 0.14].entries()) {
    const depth = index * 0.02
    tube(root, `bone-rib-${index + 1}`, [
      [-0.25, 0.09, z], [-0.29, 0.19, z], [-0.24, 0.32, z],
      [-0.12, 0.4, z], [0, 0.42, z], [0.12, 0.4, z],
      [0.24, 0.32, z], [0.29, 0.19, z], [0.25, 0.09, z],
    ].map(([x, y, pointZ]) => [x, y + depth, pointZ]), 0.026, bone, 12, 6)
  }
  for (const z of [-0.14, 0, 0.14]) beam(root, 'bone-spine', [0, 0.11, z], [0, 0.4, z], 0.032, shadow, 7)
  beam(root, 'bone-femur-left', [-0.33, 0.075, -0.26], [0.3, 0.1, 0.2], 0.04, bone, 8)
  beam(root, 'bone-femur-right', [-0.28, 0.12, 0.25], [0.32, 0.08, -0.17], 0.038, bone, 8)
  for (const [x, y, z] of [[-0.33, 0.075, -0.26], [0.3, 0.1, 0.2], [-0.28, 0.12, 0.25], [0.32, 0.08, -0.17]]) {
    cylinder(root, 'bone-joint', 0.055, 0.045, 0.07, [x, y, z], bone, 7, [Math.PI / 2, 0, 0])
  }
  box(root, 'bone-pile-shadow', [0.64, 0.018, 0.5], [0, 0.012, 0], dark, undefined, false)
  return finish(root, 'bone_pile')
}

function buildRubbleHeap() {
  const root = new THREE.Group()
  const stone = material('stone', COLORS.stone)
  const light = material('stone', COLORS.stoneLight)
  const dark = material('stone', COLORS.stoneDark)
  const earth = material('earth', COLORS.earth)
  box(root, 'rubble-dust', [0.52, 0.02, 0.48], [0, 0.01, 0], earth, undefined, false)
  const stones = [
    ['rubble-rock-large', [0.23, 0.2, 0.21], [-0.15, 0.12, 0.07], stone, [0.14, 0.2, 0.08]],
    ['rubble-rock-high', [0.17, 0.28, 0.16], [0.03, 0.17, -0.08], light, [-0.1, 0.05, 0.2]],
    ['rubble-rock-right', [0.18, 0.16, 0.2], [0.19, 0.09, 0.1], dark, [0.2, 0.1, -0.1]],
    ['rubble-rock-front', [0.18, 0.12, 0.15], [0.06, 0.07, 0.2], stone, [0.3, 0.1, 0.04]],
    ['rubble-rock-left', [0.12, 0.1, 0.12], [-0.25, 0.06, -0.1], light, [0.1, 0.2, 0.3]],
    ['rubble-slab', [0.3, 0.08, 0.12], [-0.02, 0.07, 0.16], dark, [-0.1, 0.25, 0.2]],
  ]
  for (const [name, size, position, value, rotation] of stones) rock(root, name, size, position, value, rotation)
  return finish(root, 'rubble_heap')
}

const BUILDERS = new Map([
  ['tree_dead', buildDeadTree],
  ['wagon_wheel', buildWagonWheel],
  ['hitching_post', buildHitchingPost],
  ['water_trough', buildWaterTrough],
  ['well', buildWell],
  ['lamp_post', buildLampPost],
  ['haystack', buildHaystack],
  ['milestone', buildMilestone],
  ['roadside_shrine', buildRoadsideShrine],
  ['grave', buildGrave],
  ['bone_pile', buildBonePile],
  ['rubble_heap', buildRubbleHeap],
])

/** Создаёт свежую модель; неизвестный id оставляет существующий fallback. */
export function createExtraModel(assetId) {
  const builder = BUILDERS.get(assetId)
  return builder ? builder() : null
}
