/** Авторские модели фронтира: снег, пустыня, болото, гавань, лагерь, магия и темница. */
import { Model, THREE, random } from './map-detail-model-helpers.mjs'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const PI = Math.PI
const TAU = PI * 2

const C = Object.freeze({
  wood: '#684a34',
  woodLight: '#a27a4e',
  woodDark: '#35261e',
  woodEdge: '#7d5738',
  woodGrey: '#7c6f5e',
  stone: '#7a776f',
  stoneLight: '#a3a096',
  stoneDark: '#4f4d48',
  iron: '#3f4442',
  ironLight: '#77766b',
  ironRust: '#6b4a36',
  steel: '#7d766c',
  brass: '#ae8140',
  gold: '#c09a42',
  rope: '#a58650',
  ropeDark: '#73583c',
  snow: '#e6eef0',
  snowShade: '#c8d8e2',
  ice: '#9cc9df',
  iceDeep: '#6fa6c8',
  iceLight: '#d6ecf4',
  sand: '#d2b071',
  sandLight: '#e2c58c',
  sandstone: '#c79a62',
  sandstoneLight: '#d9b37b',
  sandstoneDark: '#9c7444',
  redRock: '#a5532f',
  redRockLight: '#bf6a3e',
  redRockDark: '#7a3b22',
  cactus: '#5f7a3e',
  cactusDark: '#435a2c',
  spine: '#eadfb6',
  deadwood: '#b8a68c',
  deadwoodDark: '#8a7660',
  oasis: '#3fa7a3',
  oasisDeep: '#2c8a8c',
  grass: '#7d8f3a',
  grassDark: '#556a2a',
  grassDry: '#a39a55',
  bog: '#2b3423',
  moss: '#5d7a35',
  mossLight: '#86a046',
  mossDark: '#3e5527',
  mud: '#6b5235',
  mudLight: '#86684a',
  mudDark: '#4a3826',
  mudWet: '#3a2c1e',
  peat: '#3f3226',
  lily: '#7da13c',
  lilyDark: '#4f7a2e',
  lilyPetal: '#ecd2dc',
  lilyCenter: '#e2bf3e',
  reed: '#6f8a3a',
  reedDark: '#4c6528',
  reedDry: '#9c9152',
  cattail: '#6b4126',
  bark: '#76664f',
  barkDark: '#4f4232',
  rotten: '#8a6a44',
  hole: '#231b14',
  canvas: '#8f8a6e',
  canvasDark: '#6c6852',
  sailcloth: '#e2d8bf',
  sailShade: '#c7bb9d',
  leather: '#7a4a2a',
  bedGreen: '#5d6b3c',
  bedTan: '#c09a62',
  bedGrey: '#55575a',
  straw: '#c9a764',
  strawDark: '#9e7f45',
  float: '#b0602c',
  liquid: '#262b3a',
  mirror: '#2b3f63',
  page: '#efe3c4',
  bookCover: '#6b3524',
  ritual: '#a9a49a',
  ritualLight: '#c2bdb1',
  ritualDark: '#3f3e3a',
  shadow: '#1d1a17',
})

/** Криволинейная деталь с настоящим сечением, а не набором кубиков. */
function tube(model, name, points, radius, color, tubularSegments = 24, radialSegments = 8, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), closed, 'centripetal')
  return model.mesh(name, new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, closed), [0, 0, 0], color)
}

function tubeGeometry(points, radius, tubularSegments = 8, radialSegments = 4, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), closed, 'centripetal')
  const geometry = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, closed)
  geometry.deleteAttribute('uv')
  return geometry
}

/** Несколько готовых геометрий одним мешем (жилки, прутья, стебли). */
function merged(model, name, geometries, color) {
  for (const geometry of geometries) geometry.deleteAttribute('uv')
  const geometry = mergeGeometries(geometries.map((part) => part.index ? part.toNonIndexed() : part), false)
  return model.mesh(name, geometry, [0, 0, 0], color)
}

/** Геометрия трубки с сужением; без шапок-сфер, поэтому дёшева для веток и стеблей. */
function taperedTubeGeometry(points, radiusStart, radiusEnd, tubularSegments = 12, radialSegments = 6) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, 'centripetal')
  const geometry = new THREE.TubeGeometry(curve, tubularSegments, 1, radialSegments, false)
  const frames = curve.computeFrenetFrames(tubularSegments, false)
  const position = geometry.getAttribute('position')
  for (let row = 0; row <= tubularSegments; row += 1) {
    const radius = radiusStart + (radiusEnd - radiusStart) * row / tubularSegments
    const center = curve.getPointAt(row / tubularSegments)
    for (let column = 0; column <= radialSegments; column += 1) {
      const vertex = row * (radialSegments + 1) + column
      const angle = column / radialSegments * TAU
      // Как в TubeGeometry: −cos по нормали, иначе обход кольца зеркалится и грани смотрят внутрь.
      const offset = frames.normals[row].clone().multiplyScalar(-Math.cos(angle) * radius)
        .addScaledVector(frames.binormals[row], Math.sin(angle) * radius)
      position.setXYZ(vertex, center.x + offset.x, center.y + offset.y, center.z + offset.z)
    }
  }
  geometry.computeVertexNormals()
  return geometry
}

function taperedTube(model, name, points, radiusStart, radiusEnd, color, tubularSegments = 12, radialSegments = 6) {
  return model.mesh(name, taperedTubeGeometry(points, radiusStart, radiusEnd, tubularSegments, radialSegments), [0, 0, 0], color)
}

function ring(model, name, radius, tubeRadius, position, color, rotation = [0, 0, 0], radialSegments = 8, tubularSegments = 24, arc = TAU) {
  return model.mesh(name, new THREE.TorusGeometry(radius, tubeRadius, radialSegments, tubularSegments, arc), position, color, rotation)
}

function lathe(model, name, profile, position, color, segments = 24) {
  const points = profile.map(([radius, y]) => new THREE.Vector2(radius, y))
  return model.mesh(name, new THREE.LatheGeometry(points, segments), position, color)
}

function plank(model, name, size, position, color, rotation = [0, 0, 0]) {
  // Авторские размеры здесь записываются как [ширина, высота, глубина].
  const [width, height, depth] = size
  // Фаска из коробки 2×2×2: в шесть раз дешевле RoundedBoxGeometry.
  return model.mesh(name, roundedBox(width, height, depth, Math.min(.02, width / 5, height / 5, depth / 5)), position, color, rotation)
}

function addNail(model, name, position, color = C.ironLight) {
  return model.cylinder(name, .022, .024, .025, position, color, 10)
}

/** Недорогой эллипсоид: m.sphere даёт ~1000 треугольников, здесь их в разы меньше. */
function ellipsoid(model, name, size, position, color, rotation = [0, 0, 0], segments = [14, 9]) {
  const mesh = model.mesh(name, new THREE.SphereGeometry(.5, segments[0], segments[1]), position, color, rotation)
  mesh.scale.set(...size)
  return mesh
}

/** Брус между двумя точками с прямоугольным сечением и фаской. */
function bar(model, name, from, to, width, height, color, roll = 0) {
  const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to)
  const delta = end.clone().sub(start)
  const length = delta.length()
  const radius = Math.min(.02, width / 6, height / 6)
  const geometry = radius > .004 ? roundedBox(width, height, length, radius) : new THREE.BoxGeometry(width, height, length)
  const mesh = model.mesh(name, geometry, start.clone().add(end).multiplyScalar(.5).toArray(), color)
  const direction = delta.normalize()
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction)
  // Без крена брус держит «верх» к небу: поворот вокруг собственной оси выравнивает сечение.
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion)
  const wanted = new THREE.Vector3(0, 1, 0).sub(direction.clone().multiplyScalar(direction.y))
  if (wanted.lengthSq() > 1e-6) {
    wanted.normalize()
    const twist = Math.atan2(new THREE.Vector3().crossVectors(up, wanted).dot(direction), up.dot(wanted))
    quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(direction, twist + roll))
  }
  mesh.quaternion.copy(quaternion)
  return mesh
}

function roundedBox(width, height, depth, radius) {
  const geometry = new THREE.BoxGeometry(width, height, depth, 2, 2, 2)
  const position = geometry.getAttribute('position')
  const half = [width / 2 - radius, height / 2 - radius, depth / 2 - radius]
  const point = new THREE.Vector3(), inner = new THREE.Vector3()
  for (let index = 0; index < position.count; index += 1) {
    point.fromBufferAttribute(position, index)
    inner.set(Math.max(-half[0], Math.min(half[0], point.x)), Math.max(-half[1], Math.min(half[1], point.y)), Math.max(-half[2], Math.min(half[2], point.z)))
    const offset = point.clone().sub(inner)
    if (offset.lengthSq() > 1e-12) point.copy(inner).add(offset.normalize().multiplyScalar(radius))
    position.setXYZ(index, point.x, point.y, point.z)
  }
  geometry.computeVertexNormals()
  return geometry
}

/** Плоские грани без сглаживания: лёд, гранёный камень. */
function faceted(geometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry
  if (flat !== geometry) geometry.dispose()
  flat.deleteAttribute('normal')
  flat.computeVertexNormals()
  return flat
}

/** Много мелких одинаковых деталей одним мешем: шипы, заклёпки, травинки. */
function scatter(model, name, makeGeometry, placements, color) {
  const parts = placements.map(({ position, rotation = [0, 0, 0], scale = [1, 1, 1] }, index) => {
    const geometry = makeGeometry(index)
    geometry.deleteAttribute('uv')
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
      new THREE.Vector3(...scale),
    )
    geometry.applyMatrix4(matrix)
    return geometry.index ? geometry.toNonIndexed() : geometry
  })
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  return model.mesh(name, merged, [0, 0, 0], color)
}

/** Детерминированный шум по координате для контуров и рельефа плоских моделей. */
function hash2(x, z, seed) {
  let value = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1274126177)
  value = Math.imul(value ^ (value >>> 13), 1103515245)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295 * 2 - 1
}

function noise2(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z)
  const fx = x - x0, fz = z - z0
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz)
  const a = hash2(x0, z0, seed), b = hash2(x0 + 1, z0, seed)
  const c = hash2(x0, z0 + 1, seed), d = hash2(x0 + 1, z0 + 1, seed)
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz
}

/** Периодический шум по углу: контур замыкается без шва. */
function angleNoise(angle, seed, lobes = 5) {
  const x = Math.cos(angle) * lobes / 2, z = Math.sin(angle) * lobes / 2
  return noise2(x + 10, z + 10, seed) + .5 * noise2(x * 2.1 + 30, z * 2.1 + 30, seed + 11)
}

/**
 * Плоская органика сверху: полярная сетка с неровным контуром edge(angle) и
 * высотой height(x, z, t). Низ закрыт плоским диском, поэтому тело замкнуто.
 * Возвращает меш; высоту поверхности можно спросить у той же функции.
 */
function blob(model, name, { radius, edge = () => 1, height, rings = 10, sectors = 48, position = [0, 0, 0], color, base = 0 }) {
  const [rx, rz] = radius
  const positions = [], indices = []
  positions.push(0, base + height(0, 0, 0), 0)
  for (let ringIndex = 1; ringIndex <= rings; ringIndex += 1) {
    const t = ringIndex / rings
    for (let sector = 0; sector < sectors; sector += 1) {
      const angle = sector / sectors * TAU
      const reach = edge(angle) * t
      const x = Math.cos(angle) * rx * reach, z = Math.sin(angle) * rz * reach
      positions.push(x, base + height(x, z, t), z)
    }
  }
  for (let sector = 0; sector < sectors; sector += 1) indices.push(0, 1 + (sector + 1) % sectors, 1 + sector)
  for (let ringIndex = 1; ringIndex < rings; ringIndex += 1) {
    const inner = 1 + (ringIndex - 1) * sectors, outer = 1 + ringIndex * sectors
    for (let sector = 0; sector < sectors; sector += 1) {
      const next = (sector + 1) % sectors
      indices.push(inner + sector, inner + next, outer + sector, inner + next, outer + next, outer + sector)
    }
  }
  // Нижний диск: та же кромка, центр на уровне основания.
  const bottomCenter = positions.length / 3
  positions.push(0, base, 0)
  const rim = 1 + (rings - 1) * sectors
  const bottomRim = positions.length / 3
  for (let sector = 0; sector < sectors; sector += 1) {
    positions.push(positions[(rim + sector) * 3], base, positions[(rim + sector) * 3 + 2])
  }
  for (let sector = 0; sector < sectors; sector += 1) {
    const next = (sector + 1) % sectors
    indices.push(bottomCenter, bottomRim + sector, bottomRim + next)
    // Стенка от кромки поверхности до основания.
    indices.push(rim + sector, rim + next, bottomRim + sector, rim + next, bottomRim + next, bottomRim + sector)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return model.mesh(name, geometry, position, color)
}

/** Полусфера-кочка с шумом (камни, мох, снег, мешки). */
function mound(model, name, size, position, color, seed, { amount = .02, frequency = 6, widthSegments = 18, heightSegments = 6, rotation = [0, 0, 0] } = {}) {
  return model.lumpy(name, new THREE.SphereGeometry(.5, widthSegments, heightSegments, 0, TAU, 0, PI / 2), position, color, { size, amount, frequency, seed, rotation })
}

/** Камень с плоским низом: шум как у образцов, но не проваливается сквозь пол. */
function boulder(model, name, size, position, color, seed, { amount = .04, frequency = 3, detail = 2, flatten = -.3, facets = 5, cut = .37, rotation = [0, 0, 0] } = {}) {
  return model.lumpy(name, rockGeometry(detail, seed, facets, flatten, cut), position, color, { size, amount, frequency, seed, rotation })
}

/** Многогранник камня: несколько срезов-плоскостей дают сколы, низ ровный. */
function rockGeometry(detail, seed, facets, flatten, cut = .37) {
  const geometry = new THREE.IcosahedronGeometry(.5, detail)
  const pos = geometry.getAttribute('position')
  const next = random(seed * 31 + 7)
  const planes = []
  for (let index = 0; index < facets; index += 1) {
    const angle = next() * TAU, rise = .15 + next() * .75
    planes.push([new THREE.Vector3(Math.cos(angle) * Math.cos(rise), Math.sin(rise), Math.sin(angle) * Math.cos(rise)), cut + next() * .08])
  }
  const point = new THREE.Vector3()
  for (let index = 0; index < pos.count; index += 1) {
    point.fromBufferAttribute(pos, index)
    for (const [normal, distance] of planes) {
      const excess = point.dot(normal) - distance
      if (excess > 0) point.addScaledVector(normal, -excess)
    }
    if (point.y < flatten) point.y = flatten
    pos.setXYZ(index, point.x, point.y, point.z)
  }
  return geometry
}

/** Высота поверхности меша над точкой (x, z) — чтобы мох и пятна ложились, а не висели. */
function surfaceY(mesh, x, z, fallback = 0) {
  mesh.updateMatrixWorld(true)
  const raycaster = new THREE.Raycaster(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0))
  const hit = raycaster.intersectObject(mesh, false)[0]
  return hit ? hit.point.y : fallback
}

/** Пучок травинок одним мешем: тонкие конусы веером от центра. */
function grassTuft(model, name, center, color, seed, { count = 16, height = .2, spread = .08, lean = .5, radius = .012 } = {}) {
  const next = random(seed)
  const placements = []
  for (let index = 0; index < count; index += 1) {
    const angle = index / count * TAU + next() * .6
    const tilt = lean * (.4 + next() * .7)
    const h = height * (.6 + next() * .5)
    const dx = Math.cos(angle), dz = Math.sin(angle)
    placements.push({
      position: [center[0] + dx * spread * next() + dx * Math.sin(tilt) * h / 2, center[1] + Math.cos(tilt) * h / 2, center[2] + dz * spread * next() + dz * Math.sin(tilt) * h / 2],
      rotation: new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx * Math.sin(tilt), Math.cos(tilt), dz * Math.sin(tilt)))).toArray().slice(0, 3),
      scale: [1, h, 1],
    })
  }
  return scatter(model, name, () => new THREE.ConeGeometry(radius, 1, 4, 1), placements, color)
}

function finish(model, dimensions) {
  const root = model.root
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root, true)
  const size = bounds.getSize(new THREE.Vector3())
  if (![size.x, size.y, size.z].every((value) => Number.isFinite(value) && value > 0)) throw new Error(`Пустая frontier модель: ${root.name}`)
  const [width, depth, height] = dimensions
  root.scale.set(width / size.x, height / size.y, depth / size.z)
  root.updateMatrixWorld(true)
  const fitted = new THREE.Box3().setFromObject(root, true)
  root.position.set(-(fitted.min.x + fitted.max.x) / 2, -fitted.min.y, -(fitted.min.z + fitted.max.z) / 2)
  root.updateMatrixWorld(true)
  return root
}

// ------------------------------------------------------------------ снег

/**
 * Камень и снежная шапка с тем же шумом: шапка — тот же многогранник,
 * чуть крупнее и срезанный снизу, поэтому лежит по рельефу камня, а не висит над ним.
 * cover — уровень нижней кромки снега (−.5….5 от высоты камня), drips — потёки вниз.
 */
function snowCappedRock(m, rockName, snowName, size, position, rockColor, seed, { amount = .03, frequency = 4, detail = 2, cover = .1, drips = 0, flatten = -.3, facets = 5 } = {}) {
  boulder(m, rockName, size, position, rockColor, seed, { amount, frequency, detail, flatten, facets })
  const geometry = rockGeometry(detail, seed, facets, flatten)
  const pos = geometry.getAttribute('position')
  for (let index = 0; index < pos.count; index += 1) {
    const angle = Math.atan2(pos.getZ(index), pos.getX(index))
    const cut = cover - drips * Math.max(0, Math.sin(angle * 5 + seed)) ** 3 + .035 * angleNoise(angle, seed, 6)
    if (pos.getY(index) >= cut) continue
    // Нижние вершины прижимаются к срезу и стягиваются к сечению камня на этой высоте:
    // шапка кончается тонкой кромкой, а не юбкой шире камня.
    const x = pos.getX(index), z = pos.getZ(index)
    const reach = Math.hypot(x, z), limit = Math.sqrt(Math.max(0, .25 - cut * cut)) * .96
    const shrink = reach > limit ? limit / reach : 1
    pos.setXYZ(index, x * shrink, cut, z * shrink)
  }
  return m.lumpy(snowName, geometry, position, C.snow, { size: size.map((value) => value * 1.06), amount, frequency, seed })
}

function buildSnowdrift() {
  const m = new Model('snowdrift')
  // Контур «облаком», гребень волной вдоль X; подветренная сторона (+Z) круче.
  const edge = (angle) => 1 + .1 * angleNoise(angle, 3, 8) + .04 * Math.cos(angle * 2)
  const crest = (x) => -.05 + .07 * Math.sin(x * 4.4 + .6)
  // Пологий наветренный склон, плоская спина и крутой подветренный край.
  const height = (x, z, t) => {
    const along = Math.max(0, 1 - Math.abs(x / .72) ** 3)
    const dz = z - crest(x)
    const cross = Math.exp(-(Math.abs(dz / (dz < 0 ? .32 : .2)) ** 3))
    return Math.max(.004, (.24 * along ** .5 * cross + .014 * noise2(x * 9, z * 9, 5) + .02) * (1 - t ** 5))
  }
  blob(m, 'snow-drift-body', { radius: [.68, .36], edge, height, rings: 14, sectors: 72, color: C.snow })
  // Голубоватая кромка выглядывает из-под тела, как тень в штампе.
  blob(m, 'snow-drift-shade', { radius: [.71, .39], edge, height: (x, z, t) => .022 * (1 - t ** 3), rings: 4, sectors: 72, color: C.snowShade })
  for (const [x, z, w, d, h, seed] of [[-.56, .06, .30, .24, .10, 31], [.52, -.10, .30, .22, .12, 32], [.12, .24, .34, .16, .08, 33], [-.18, -.27, .30, .14, .07, 34]]) {
    mound(m, 'snow-drift-lobe', [w, h, d], [x, 0, z], C.snow, seed, { amount: .012, frequency: 9 })
  }
  for (const [x, z, seed] of [[-.30, -.10, 35], [.06, -.02, 36], [.36, -.12, 37]]) {
    mound(m, 'snow-drift-crest-clump', [.16, .07, .10], [x, height(x, z, .3) - .03, z], C.snow, seed, { amount: .01, frequency: 12 })
  }
  return finish(m, [1.4, .8, .32])
}

function buildSnowyBoulder() {
  const m = new Model('snowy_boulder')
  const size = [1.24, .86, 1.14]
  const cap = snowCappedRock(m, 'boulder-rock', 'snow-boulder-cap', size, [0, .30 * size[1], 0], C.stone, 81, { amount: .07, frequency: 2.4, detail: 3, cover: .27, drips: .26, flatten: -.3, facets: 7 })
  // Сколы камня пробивают снег на макушке и у подножия — пятна камня, как в штампе.
  for (const [x, z, w, d, h, turn, seed] of [[.30, .08, .24, .16, .08, .4, 83], [-.12, .26, .18, .12, .06, -.6, 84]]) {
    boulder(m, 'boulder-rock-knob', [w, h, d], [x, surfaceY(cap, x, z, .7) - h * .25, z], C.stoneDark, seed, { amount: .01, frequency: 8, detail: 1, flatten: -.5, rotation: [0, turn, 0] })
  }
  for (const [x, z, w, d, h, turn, seed] of [[-.52, -.24, .32, .26, .30, .2, 85], [.46, .38, .30, .24, .26, 1.1, 86]]) {
    boulder(m, 'boulder-rock-knob', [w, h, d], [x, h * .3, z], C.stoneDark, seed, { amount: .012, frequency: 8, detail: 1, flatten: -.3, rotation: [0, turn, 0] })
  }
  for (const [x, z, w, d, turn, seed] of [[-.42, .46, .52, .24, .5, 88], [.56, -.30, .36, .22, -.8, 89]]) {
    mound(m, 'snow-boulder-drift', [w, .14, d], [x, 0, z], C.snow, seed, { amount: .015, frequency: 8, rotation: [0, turn, 0] })
  }
  return finish(m, [1.3, 1.2, .9])
}

/** Гранёный столб льда: неровные кольца, вершина-острие и плоские грани. */
function iceCrystalGeometry(radius, height, seed, sides = 6) {
  const next = random(seed)
  const levels = [[0, .9], [height * .12, 1.05], [height * .52, .93], [height * .8, .7]]
  const phase = next() * PI
  const positions = []
  for (const [y, scale] of levels) {
    for (let index = 0; index < sides; index += 1) {
      const angle = phase + index * TAU / sides
      const wobble = 1 + .14 * (next() - .5)
      positions.push(Math.cos(angle) * radius * scale * wobble, y, Math.sin(angle) * radius * scale * wobble)
    }
  }
  const apex = positions.length / 3
  positions.push((next() - .5) * radius * .3, height, (next() - .5) * radius * .3)
  const bottom = positions.length / 3
  positions.push(0, 0, 0)
  const indices = []
  for (let level = 0; level < levels.length - 1; level += 1) {
    for (let index = 0; index < sides; index += 1) {
      const nextIndex = (index + 1) % sides
      const a = level * sides + index, b = level * sides + nextIndex
      const c = (level + 1) * sides + nextIndex, d = (level + 1) * sides + index
      indices.push(a, d, b, b, d, c)
    }
  }
  const top = (levels.length - 1) * sides
  for (let index = 0; index < sides; index += 1) {
    indices.push(top + index, apex, top + (index + 1) % sides)
    indices.push(index, (index + 1) % sides, bottom)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  return faceted(geometry)
}

function buildIcePillars() {
  const m = new Model('ice_pillars')
  // Высокий столб сзади, средний слева спереди, малый справа спереди — как в штампе.
  for (const [index, [x, z, height, radius, lean]] of [[.06, -.26, 1.40, .20, [.05, 0, -.04]], [-.38, .12, 1.02, .19, [-.04, 0, .07]], [.42, .30, .70, .15, [.03, 0, .08]]].entries()) {
    const seed = 101 + index * 7
    m.mesh(`ice-pillar-${index + 1}`, iceCrystalGeometry(radius, height, seed), [x, .02, z], C.ice, lean)
    // Спутник светлее и тоньше: даёт столбу вторую грань цвета.
    m.mesh(`ice-pillar-${index + 1}-shard`, iceCrystalGeometry(radius * .55, height * .62, seed + 1, 5), [x + radius * .55, .02, z + radius * .35], C.iceLight, [lean[0] - .12, 0, lean[2] - .22])
    m.mesh(`ice-pillar-${index + 1}-shard`, iceCrystalGeometry(radius * .45, height * .42, seed + 2, 5), [x - radius * .6, .02, z + radius * .25], C.iceDeep, [lean[0] + .1, 0, lean[2] + .25])
    const edge = (angle) => 1 + .16 * angleNoise(angle, seed, 7)
    blob(m, `snow-pillar-${index + 1}-base`, { radius: [radius * 1.8, radius * 1.7], edge, height: (px, pz, t) => .11 * (1 - t * t) + .012 * noise2(px * 14, pz * 14, seed), rings: 6, sectors: 40, position: [x, 0, z], color: C.snow })
  }
  const next = random(117)
  const chips = []
  for (let index = 0; index < 9; index += 1) {
    const angle = next() * TAU, reach = .22 + next() * .35
    chips.push({ position: [Math.cos(angle) * reach, .03, Math.sin(angle) * reach], rotation: [next() * PI, next() * PI, next() * PI], scale: [.05 + next() * .04, .04 + next() * .03, .05 + next() * .04] })
  }
  scatter(m, 'ice-chip', () => new THREE.OctahedronGeometry(1, 0), chips, C.iceLight)
  return finish(m, [1.3, 1.2, 1.4])
}

function buildFrozenPool() {
  const m = new Model('frozen_pool')
  const outline = (angle) => 1 + .07 * angleNoise(angle, 121, 5)
  blob(m, 'snow-ground', { radius: [.70, .69], edge: (angle) => 1 + .03 * angleNoise(angle, 122, 9), height: (x, z, t) => .03 * (1 - t ** 8), rings: 5, sectors: 64, color: C.snowShade })
  blob(m, 'ice-deep-rim', { radius: [.56, .55], edge: outline, height: (x, z, t) => .042 * (1 - t ** 12), rings: 4, sectors: 64, color: C.iceDeep })
  blob(m, 'ice-sheet', { radius: [.51, .50], edge: outline, height: (x, z, t) => (.047 + .002 * noise2(x * 6, z * 6, 123)) * (1 - t ** 14), rings: 8, sectors: 64, color: C.ice })
  // Трещины расходятся от точки удара и ветвятся; рёбра чуть выступают над льдом.
  const next = random(124)
  const origin = [.06, -.04]
  for (let crack = 0; crack < 6; crack += 1) {
    let angle = crack / 6 * TAU + next() * .5
    const points = [[origin[0], .049, origin[1]]]
    let [x, z] = origin
    while (Math.hypot(x, z) < .42) {
      angle += (next() - .5) * .7
      x += Math.cos(angle) * .09; z += Math.sin(angle) * .09
      points.push([x, .049, z])
      if (points.length === 3 && crack % 2 === 0) {
        const branch = angle + (next() > .5 ? .9 : -.9)
        tube(m, 'ice-crack-branch', [[x, .049, z], [x + Math.cos(branch) * .08, .049, z + Math.sin(branch) * .08], [x + Math.cos(branch + .3) * .16, .049, z + Math.sin(branch + .3) * .16]], .005, C.iceLight, 8, 4)
      }
    }
    tube(m, 'ice-crack', points, .007, C.iceLight, points.length * 3, 4)
  }
  // Кольцо камней со снежными шапками.
  const count = 17
  const stoneColors = [C.stone, C.stoneDark, C.stoneLight]
  for (let index = 0; index < count; index += 1) {
    const angle = index / count * TAU + next() * .12
    const reach = .60 * outline(angle) + (next() - .5) * .03
    const w = .17 + next() * .07, h = .10 + next() * .04
    snowCappedRock(m, 'rim-rock', 'snow-rim-cap', [w, h, w * (.8 + next() * .3)], [Math.cos(angle) * reach, .3 * h, Math.sin(angle) * reach * .98], stoneColors[index % 3], 125 + index, { amount: .012, frequency: 10, detail: 2, cover: .32 + next() * .08, facets: 4 })
  }
  return finish(m, [1.4, 1.4, .14])
}

function buildWinterCache() {
  const m = new Model('winter_cache')
  // Два ящика бок о бок; верх скрыт брезентом, видны доски боков.
  for (const [index, x] of [-.355, .355].entries()) {
    plank(m, 'cache-crate-body', [.64, .42, .60], [x, .21, 0], C.woodDark)
    for (const [row, y] of [.07, .21, .35].entries()) {
      const color = (row + index) % 2 ? C.wood : C.woodLight
      for (const z of [-.31, .31]) plank(m, 'cache-crate-plank', [.62, .12, .03], [x, y, z], color)
      for (const side of [-1, 1]) plank(m, 'cache-crate-plank', [.03, .12, .58], [x + side * .33, y, 0], color)
    }
    for (const sx of [-1, 1]) for (const z of [-.32, .32]) {
      plank(m, 'cache-crate-corner-post', [.06, .38, .05], [x + sx * .31, .19, z], C.woodEdge)
      addNail(m, 'cache-crate-iron-nail', [x + sx * .31, .12, z + Math.sign(z) * .03], C.ironLight).rotation.x = PI / 2
    }
  }
  // Брезент: ровный верх, складки, провис над щелью и свисающая кромка.
  m.drape('cache-canvas-tarp', 1.46, .76, (x, z) => {
    const out = Math.max(0, Math.abs(x) - .66, Math.abs(z) - .30)
    return .46 - .17 * (out / .08) ** 1.4 - .025 * Math.exp(-((x / .06) ** 2)) + .007 * Math.sin(x * 23 + z * 7) + .005 * noise2(x * 10, z * 10, 141)
  }, C.canvas, { segments: [30, 15], ragged: .02, seed: 7, thickness: .02 })
  for (const x of [-.355, .355]) {
    tube(m, 'cache-rope', [[x, .02, -.335], [x, .2, -.338], [x, .30, -.372], [x, .40, -.36], [x, .465, -.28], [x, .485, 0], [x, .465, .28], [x, .40, .36], [x, .30, .372], [x, .2, .338], [x, .02, .335]], .017, C.rope, 48, 6)
    ellipsoid(m, 'cache-rope-knot', [.06, .04, .07], [x, .49, -.05], C.ropeDark)
  }
  // Углы брезента подвязаны к ящикам короткими концами — как в штампе.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    tube(m, 'cache-rope-corner-tie', [[sx * .70, .34, sz * .36], [sx * .72, .26, sz * .345], [sx * .69, .17, sz * .325]], .012, C.ropeDark, 8, 5)
  }
  for (const [x, z, w, d, seed] of [[-.30, -.06, .22, .13, 142], [.32, .09, .18, .11, 143]]) {
    blob(m, 'snow-dust', { radius: [w, d], edge: (angle) => 1 + .09 * angleNoise(angle, seed, 5), height: (px, pz, t) => .02 * (1 - t * t), rings: 4, sectors: 32, position: [x, .468, z], color: C.snow })
  }
  for (const [x, z, w, d, seed] of [[-.62, .34, .36, .16, 144], [.58, -.36, .40, .14, 145]]) {
    mound(m, 'snow-cache-bank', [w, .13, d], [x, 0, z], C.snow, seed, { amount: .012, frequency: 9 })
  }
  return finish(m, [1.4, .7, .55])
}

function buildSnowCairn() {
  const m = new Model('snow_cairn')
  const stones = [C.stone, C.stoneDark, C.stoneLight]
  for (let index = 0; index < 3; index += 1) {
    const angle = index / 3 * TAU + .4
    const size = [.36, .30, .32]
    snowCappedRock(m, 'cairn-stone', 'snow-cairn-cap', size, [Math.cos(angle) * .16, .3 * size[1], Math.sin(angle) * .16], stones[index], 151 + index, { amount: .025, frequency: 5, detail: 2, cover: .3, drips: .14 })
  }
  // Ярусы уменьшаются кверху и слегка смещены — стопка сложена руками.
  for (const [index, [w, h, y, dx, dz]] of [[.56, .22, .32, .01, -.01], [.46, .19, .51, -.02, .01], [.36, .16, .67, .015, .0], [.27, .13, .80, -.01, .01]].entries()) {
    snowCappedRock(m, 'cairn-stone', 'snow-cairn-cap', [w, h, w * .92], [dx, y, dz], stones[(index + 1) % 3], 161 + index, { amount: .02, frequency: 6, detail: 2, cover: .3, drips: .16, facets: 3 })
  }
  taperedTube(m, 'cairn-marker-post-wood', [[0, .80, 0], [.01, 1.0, -.005], [.025, 1.25, -.012]], .032, .025, C.woodDark, 8, 7)
  m.cylinder('cairn-marker-post-top', .026, .026, .02, [.025, 1.25, -.012], C.wood, 8)
  tube(m, 'cairn-marker-rope-tie', [[-.03, 1.12, -.03], [.05, 1.13, -.02], [.05, 1.15, .02], [-.03, 1.14, .02]], .008, C.rope, 10, 4, true)
  blob(m, 'snow-cairn-base', { radius: [.40, .39], edge: (angle) => 1 + .1 * angleNoise(angle, 171, 6), height: (x, z, t) => .05 * (1 - t ** 2), rings: 5, sectors: 40, color: C.snowShade })
  return finish(m, [.8, .8, 1.3])
}

// --------------------------------------------------------------- пустыня
// Песок без отдельного правила сборщика ушёл бы в «дерево» по тёплому цвету,
// поэтому в именах песка стоит clay — гладкая штукатурка ближе всего к дюне.

function buildSandDune() {
  const m = new Model('sand_dune')
  const edge = (angle) => 1 + .07 * angleNoise(angle, 201, 5) + .07 * Math.cos(angle * 2 + .5)
  const crest = (x) => -.06 + .06 * Math.sin(x * 3.6 - .5)
  // Наветренный склон (+Z) длинный и в ряби, подветренный (−Z) короткий и крутой.
  const height = (x, z, t) => {
    const along = Math.max(0, 1 - Math.abs(x / .74) ** 2.4)
    const dz = z - crest(x)
    const cross = Math.exp(-((dz / (dz > 0 ? .26 : .1)) ** 2))
    const ripple = dz > .04 ? .006 * Math.sin(z * 60 + 2.5 * Math.sin(x * 4)) * Math.min(1, (dz - .04) * 12) : 0
    return Math.max(.003, (.27 * along ** .8 * cross + ripple + .006 * noise2(x * 7, z * 7, 202) + .012) * (1 - t ** 6))
  }
  blob(m, 'sand-dune-clay', { radius: [.70, .30], edge, height, rings: 18, sectors: 80, color: C.sand })
  blob(m, 'sand-dune-skirt-clay', { radius: [.72, .32], edge, height: (x, z, t) => .014 * (1 - t ** 3), rings: 3, sectors: 80, color: C.sandstoneDark })
  for (const [x, z, s, seed] of [[-.52, .18, .05, 203], [.46, .20, .04, 204], [.12, .26, .035, 205]]) {
    boulder(m, 'dune-sandstone-pebble', [s, s * .6, s * .8], [x, s * .18, z], C.sandstone, seed, { amount: .004, frequency: 20, detail: 1, facets: 2 })
  }
  return finish(m, [1.4, .6, .3])
}

function buildDesertBoulders() {
  const m = new Model('desert_boulders')
  // Большой валун сзади справа, средний слева спереди, малый справа спереди — как в штампе.
  for (const [x, z, w, d, h, color, seed, turn] of [
    [.14, -.14, .98, .86, .80, C.redRock, 211, .3],
    [-.42, .24, .56, .54, .48, C.redRockLight, 212, -.4],
    [.40, .36, .52, .42, .32, C.redRock, 213, .9],
  ]) {
    // Глубокие срезы дают песчанику угловатые сколы вместо мячика.
    boulder(m, 'desert-sandstone-rock', [w, h, d], [x, .3 * h, z], color, seed, { amount: .045, frequency: 3.4, detail: 3, facets: 10, cut: .29, rotation: [0, turn, 0] })
  }
  for (const [x, z, s, seed] of [[-.62, -.22, .12, 216], [-.12, .52, .09, 217], [.62, -.02, .10, 218], [-.30, -.40, .08, 219]]) {
    boulder(m, 'desert-sandstone-pebble', [s, s * .65, s * .85], [x, s * .2, z], C.redRockDark, seed, { amount: .008, frequency: 14, detail: 1, facets: 3 })
  }
  for (const [x, z, w, d, turn, seed] of [[-.08, .14, .70, .30, .5, 220], [.40, -.34, .44, .18, -.2, 221]]) {
    mound(m, 'sand-boulder-drift-clay', [w, .09, d], [x, 0, z], C.sand, seed, { amount: .01, frequency: 8, rotation: [0, turn, 0] })
  }
  return finish(m, [1.4, 1.2, .8])
}

/** Ребристое тело кактуса: профиль вращения и продольные рёбра по углу. */
function ribbedLathe(profile, ribs, depth) {
  const geometry = new THREE.LatheGeometry(profile.map(([radius, y]) => new THREE.Vector2(radius, y)), ribs * 4)
  const pos = geometry.getAttribute('position')
  for (let index = 0; index < pos.count; index += 1) {
    const x = pos.getX(index), z = pos.getZ(index)
    const angle = Math.atan2(x, z)
    const factor = 1 - depth * (.5 - .5 * Math.cos(ribs * angle))
    pos.setXYZ(index, x * factor, pos.getY(index), z * factor)
  }
  geometry.computeVertexNormals()
  return geometry
}

/** Колючки-точки по гребням рёбер: одна геометрия на весь кактус. */
function cactusSpines(profile, ribs, center, rows, rotation = 0) {
  const placements = []
  const radiusAt = (y) => {
    for (let index = 1; index < profile.length; index += 1) {
      const [r0, y0] = profile[index - 1], [r1, y1] = profile[index]
      if (y >= y0 && y <= y1) return r0 + (r1 - r0) * (y - y0) / Math.max(1e-6, y1 - y0)
    }
    return 0
  }
  const top = profile.at(-1)[1]
  for (let rib = 0; rib < ribs; rib += 1) {
    const angle = rib / ribs * TAU + rotation
    for (let row = 0; row < rows; row += 1) {
      const y = top * (.08 + .86 * (row + (rib % 2) * .5) / rows)
      const radius = radiusAt(y) + .006
      if (radius < .03) continue
      placements.push({ position: [center[0] + Math.sin(angle) * radius, center[1] + y, center[2] + Math.cos(angle) * radius], rotation: [0, angle, 0], scale: [.011, .011, .016] })
    }
  }
  return placements
}

function buildCactusCluster() {
  const m = new Model('cactus_cluster')
  const column = [[0, 0], [.17, 0], [.195, .06], [.205, .40], [.20, 1.12], [.188, 1.26], [.15, 1.34], [.08, 1.385], [0, 1.40]]
  const barrel = (r, h) => [[0, 0], [r * .74, 0], [r * .92, h * .14], [r, h * .40], [r * .96, h * .64], [r * .76, h * .86], [r * .40, h * .97], [0, h]]
  const parts = [
    ['cactus-plant-column', column, 14, [-.30, 0, -.30], C.cactus],
    ['cactus-plant-barrel', barrel(.25, .56), 16, [.30, 0, -.02], C.cactus],
    ['cactus-plant-barrel', barrel(.21, .44), 15, [-.10, 0, .38], C.cactusDark],
    ['cactus-plant-pup', barrel(.10, .18), 10, [.34, 0, .44], C.cactus],
  ]
  const spines = []
  for (const [name, profile, ribs, center, color] of parts) {
    m.mesh(name, ribbedLathe(profile, ribs, .16), center, color)
    spines.push(...cactusSpines(profile, ribs, center, name.endsWith('column') ? 12 : 5))
    const top = profile.at(-1)[1]
    // Венчик колючек на макушке.
    for (let index = 0; index < 6; index += 1) {
      const angle = index / 6 * TAU
      spines.push({ position: [center[0] + Math.cos(angle) * .03, top - .004, center[2] + Math.sin(angle) * .03], rotation: [0, angle, 0], scale: [.012, .012, .012] })
    }
  }
  scatter(m, 'cactus-plant-spine', () => new THREE.OctahedronGeometry(1, 0), spines, C.spine)
  for (const [x, z, w, d, seed] of [[-.30, -.30, .52, .48, 222], [.30, -.02, .62, .58, 223], [-.10, .38, .52, .50, 224]]) {
    mound(m, 'sand-cactus-clay', [w * .8, .045, d * .8], [x, 0, z], C.sand, seed, { amount: .012, frequency: 9 })
  }
  return finish(m, [1.1, 1.2, 1.4])
}

function buildDeadScrub() {
  const m = new Model('dead_scrub')
  const next = random(231)
  const levels = [[], [], []]
  const grow = (start, direction, length, radius, depth) => {
    const points = [start]
    let point = new THREE.Vector3(...start), heading = direction.clone()
    for (let step = 0; step < 3; step += 1) {
      heading.add(new THREE.Vector3(next() - .5, (next() - .5) * .5, next() - .5).multiplyScalar(.55)).normalize()
      point = point.clone().addScaledVector(heading, length / 3)
      points.push(point.toArray())
    }
    levels[depth].push(taperedTubeGeometry(points, radius, radius * .5, depth ? 6 : 10, depth ? 4 : 6))
    if (depth === 2) return
    const children = depth ? 2 + Math.floor(next() * 2) : 3
    for (let child = 0; child < children; child += 1) {
      const from = points[1 + Math.floor(next() * 2.99)]
      const side = (child % 2 ? 1 : -1) * (.45 + next() * .6)
      const turn = new THREE.Vector3(heading.x, 0, heading.z).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), side)
      const childHeading = turn.multiplyScalar(.85).add(new THREE.Vector3(0, .25 + next() * .35, 0)).normalize()
      grow(from, childHeading, length * (.5 + next() * .2), radius * .5, depth + 1)
    }
  }
  for (let limb = 0; limb < 7; limb += 1) {
    const azimuth = limb / 7 * TAU + next() * .5
    const rise = .32 + next() * .3
    grow([Math.cos(azimuth) * .03, .05, Math.sin(azimuth) * .03], new THREE.Vector3(Math.cos(azimuth) * Math.cos(rise), Math.sin(rise), Math.sin(azimuth) * Math.cos(rise) * .85), .42 + next() * .14, .034, 0)
  }
  for (const [depth, name, color] of [[0, 'scrub-deadwood-limb', C.deadwood], [1, 'scrub-deadwood-branch', C.deadwood], [2, 'scrub-deadwood-twig', C.deadwoodDark]]) {
    const merged = mergeGeometries(levels[depth].map((geometry) => { geometry.deleteAttribute('uv'); return geometry }), false)
    for (const geometry of levels[depth]) geometry.dispose()
    m.mesh(name, merged, [0, 0, 0], color)
  }
  // Корневой узел и пара корней, ушедших в сухую землю.
  m.lumpy('scrub-deadwood-root-knot', new THREE.DodecahedronGeometry(.5, 1), [0, .05, 0], C.deadwoodDark, { size: [.16, .14, .16], amount: .015, frequency: 9, seed: 232 })
  for (const angle of [.6, 2.4, 4.3]) {
    taperedTube(m, 'scrub-deadwood-root', [[0, .04, 0], [Math.cos(angle) * .12, .025, Math.sin(angle) * .12], [Math.cos(angle + .3) * .24, .01, Math.sin(angle + .3) * .22]], .025, .008, C.deadwoodDark, 8, 5)
  }
  mound(m, 'scrub-dirt-mound', [.42, .05, .38], [0, 0, 0], C.mud, 233, { amount: .01, frequency: 10 })
  return finish(m, [1.4, 1.2, .7])
}

function buildOasisPool() {
  const m = new Model('oasis_pool')
  // Почковидный пруд: залив у левого верхнего края, пучки травы — по диагонали, как в штампе.
  const edge = (angle) => 1 + .09 * Math.cos(2 * angle + .5) + .07 * angleNoise(angle, 241, 4)
  const bank = (x, z, t) => .02 + .075 * Math.exp(-(((t - .84) / .12) ** 2)) + .006 * noise2(x * 12, z * 12, 242)
  blob(m, 'oasis-bank-sand-clay', { radius: [.70, .60], edge, height: (x, z, t) => bank(x, z, t) * (1 - t ** 12), rings: 12, sectors: 72, color: C.sandLight })
  blob(m, 'oasis-water', { radius: [.55, .45], edge, height: (x, z, t) => .064 * (1 - t ** 24), rings: 4, sectors: 72, color: C.oasis })
  blob(m, 'oasis-deep-water', { radius: [.38, .28], edge: (angle) => edge(angle) * (1 + .08 * angleNoise(angle, 243, 3)), height: (x, z, t) => .067 * (1 - t ** 24), rings: 3, sectors: 48, position: [.03, 0, .02], color: C.oasisDeep })
  const next = random(244)
  const colors = [C.sandstone, C.sandstoneLight, C.sandstoneDark, C.sandstoneLight]
  const count = 26
  for (let index = 0; index < count; index += 1) {
    const angle = index / count * TAU + next() * .1
    const reach = .78 + next() * .1
    const x = Math.cos(angle) * .70 * edge(angle) * reach, z = Math.sin(angle) * .60 * edge(angle) * reach
    const w = .13 + next() * .07, h = .08 + next() * .04
    boulder(m, 'oasis-rim-sandstone', [w, h, w * (.75 + next() * .3)], [x, .05 + .3 * h, z], colors[index % 4], 245 + index, { amount: .01, frequency: 12, detail: 1, facets: 3, rotation: [0, angle, 0] })
  }
  for (const [x, z, seed] of [[-.44, -.36, 271], [.44, .30, 272]]) {
    grassTuft(m, 'oasis-grass-tuft', [x, .07, z], C.grass, seed, { count: 30, height: .16, spread: .09, lean: .9, radius: .012 })
    grassTuft(m, 'oasis-grass-tuft-dark', [x + .03, .07, z + .02], C.grassDark, seed + 1, { count: 16, height: .12, spread: .06, lean: 1, radius: .012 })
  }
  return finish(m, [1.4, 1.2, .2])
}

/** Кусок лежащего обелиска вдоль X: квадратное сечение сужается, торец скола неровный. */
function obeliskPieceGeometry(x0, x1, half0, half1, breakStart, breakEnd, seed) {
  const geometry = new THREE.BoxGeometry(1, 1, 1, 10, 3, 3)
  const pos = geometry.getAttribute('position')
  for (let index = 0; index < pos.count; index += 1) {
    const u = pos.getX(index) + .5, v = pos.getY(index), w = pos.getZ(index)
    const half = half0 + (half1 - half0) * u
    let x = x0 + (x1 - x0) * u
    const y = v * 2 * half, z = w * 2 * half
    // Скол — косой и рваный, только на торце со стороны излома.
    if ((u === 0 && breakStart) || (u === 1 && breakEnd)) x += .07 * v * 2 + .025 * w * 2 + .02 * noise2(v * 9, w * 9, seed)
    const grain = .004 * noise2(x * 11 + v, w * 11, seed + 3)
    pos.setXYZ(index, x, y + grain, z + grain)
  }
  geometry.computeVertexNormals()
  return faceted(geometry)
}

function buildBrokenObelisk() {
  const m = new Model('broken_obelisk')
  // Длинный кусок с пирамидионом слева, отколотое основание справа, повёрнуто и сдвинуто.
  const roll = .06
  m.mesh('obelisk-sandstone-shaft', obeliskPieceGeometry(-.52, .10, .14, .165, false, true, 251), [0, .175, 0], C.sandstone, [roll, 0, 0])
  const pyramidion = new THREE.ConeGeometry(.14 * Math.SQRT2, .19, 4, 1)
  pyramidion.rotateY(PI / 4)
  pyramidion.rotateZ(PI / 2)
  m.mesh('obelisk-sandstone-pyramidion', faceted(pyramidion), [-.615, .175, 0], C.sandstoneLight, [roll, 0, 0])
  m.mesh('obelisk-sandstone-base', obeliskPieceGeometry(.17, .70, .17, .19, true, false, 252), [0, .19, .02], C.sandstone, [-.05, -.07, 0])
  // Резьба на верхней грани: короткие знаки рядами, как стёртые иероглифы.
  const next = random(253)
  const marks = []
  for (let index = 0; index < 14; index += 1) {
    const x = -.46 + index * .04 + (index > 6 ? .02 : 0)
    if (x > .06) break
    marks.push({ position: [x, .175 + .152 + x * .02, (next() - .5) * .12], rotation: [0, next() > .5 ? 0 : PI / 2, 0], scale: [.02 + next() * .02, .006, .012] })
  }
  for (let index = 0; index < 8; index += 1) marks.push({ position: [.26 + index * .05, .19 + .19 - .004, (next() - .5) * .14 + .02], rotation: [0, next() > .5 ? 0 : PI / 2, 0], scale: [.02 + next() * .02, .006, .012] })
  scatter(m, 'obelisk-carving', () => new THREE.BoxGeometry(1, 1, 1), marks, C.sandstoneDark)
  tube(m, 'obelisk-sandstone-crack', [[-.30, .335, -.14], [-.22, .34, -.05], [-.25, .345, .06], [-.16, .343, .14]], .006, C.sandstoneDark, 10, 4)
  tube(m, 'obelisk-sandstone-crack', [[.36, .385, -.16], [.42, .385, -.04], [.40, .385, .10]], .006, C.sandstoneDark, 8, 4)
  for (const [x, z, s, seed] of [[.13, -.24, .06, 254], [.20, .25, .05, 255], [.08, .20, .04, 256]]) {
    boulder(m, 'obelisk-sandstone-chip', [s, s * .6, s * .9], [x, s * .18, z], C.sandstoneLight, seed, { amount: .004, frequency: 20, detail: 1, facets: 3 })
  }
  for (const [x, z, w, d, seed] of [[-.20, -.15, .60, .10, 257], [.40, .19, .50, .09, 258]]) {
    mound(m, 'sand-obelisk-drift-clay', [w, .09, d], [x, 0, z], C.sand, seed, { amount: .006, frequency: 12 })
  }
  return finish(m, [1.4, .45, .4])
}

// ----------------------------------------------------------------- болото

/** Угол в диапазоне (−π, π] — для «заливов» и «мысов» контура. */
function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

function buildBogPool() {
  const m = new Model('bog_pool')
  const edge = (angle) => 1 + .12 * angleNoise(angle, 301, 6)
  // Мыс заходит в воду слева, залив — справа сверху, как в штампе.
  const waterEdge = (angle) => edge(angle) * (1 - .5 * Math.exp(-((wrapAngle(angle - PI) / .2) ** 2)) + .1 * Math.exp(-((wrapAngle(angle + .9) / .3) ** 2)))
  const bank = (x, z, t) => (.02 + .075 * Math.exp(-(((t - .84) / .12) ** 2)) + .012 * noise2(x * 10, z * 10, 302)) * (1 - t ** 10)
  blob(m, 'bog-mud-bank-clay', { radius: [.70, .65], edge, height: bank, rings: 12, sectors: 80, color: C.mud })
  blob(m, 'bog-water', { radius: [.56, .51], edge: waterEdge, height: (x, z, t) => .056 * (1 - t ** 30), rings: 5, sectors: 80, color: C.bog })
  const next = random(303)
  const flecks = []
  for (let index = 0; index < 46; index += 1) {
    const angle = next() * TAU, reach = Math.sqrt(next()) * .8
    const x = Math.cos(angle) * .56 * waterEdge(angle) * reach, z = Math.sin(angle) * .51 * waterEdge(angle) * reach
    const s = .012 + next() * .022
    flecks.push({ position: [x, .057, z], rotation: [0, next() * PI, 0], scale: [s, .002, s * (.6 + next() * .6)] })
  }
  scatter(m, 'bog-moss-algae', () => new THREE.CylinderGeometry(1, 1, 1, 7), flecks, C.mossLight)
  // Мшистые кочки по берегу и на мысу.
  const mossColors = [C.moss, C.mossDark, C.mossLight]
  for (let index = 0; index < 18; index += 1) {
    const angle = index / 18 * TAU + next() * .2
    const t = .80 + next() * .12
    const x = Math.cos(angle) * .70 * edge(angle) * t, z = Math.sin(angle) * .65 * edge(angle) * t
    const w = .08 + next() * .1
    mound(m, 'bog-moss-hummock', [w, .04 + next() * .04, w * (.7 + next() * .5)], [x, bank(x, z, t) - .015, z], mossColors[index % 3], 304 + index, { amount: .01, frequency: 14, widthSegments: 12, heightSegments: 4 })
  }
  for (const [x, z, w, d, seed] of [[-.42, .02, .22, .12, 330], [-.30, -.02, .14, .10, 331]]) {
    mound(m, 'bog-moss-hummock', [w, .07, d], [x, .01, z], C.moss, seed, { amount: .012, frequency: 12, widthSegments: 14, heightSegments: 5 })
  }
  for (const [x, z, seed] of [[.50, .30, 332], [-.48, -.36, 333], [.10, -.58, 334]]) grassTuft(m, 'bog-grass-tuft', [x, .07, z], C.grassDark, seed, { count: 12, height: .1, spread: .04, lean: .8, radius: .009 })
  return finish(m, [1.4, 1.3, .14])
}

/** Лист кувшинки: круг с клиновидным вырезом, тонкая плита. */
function lilyPadGeometry(radius, notch) {
  const shape = new THREE.Shape()
  shape.moveTo(0, 0)
  shape.lineTo(Math.cos(notch / 2) * radius, Math.sin(notch / 2) * radius)
  shape.absarc(0, 0, radius, notch / 2, TAU - notch / 2, false)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: .012, bevelEnabled: false, curveSegments: 28 })
  geometry.rotateX(-PI / 2)
  return geometry
}

function buildLilyPadCluster() {
  const m = new Model('lily_pad_cluster')
  blob(m, 'lily-water', { radius: [.69, .64], edge: (angle) => 1 + .07 * angleNoise(angle, 311, 6), height: (x, z, t) => .03 * (1 - t ** 8), rings: 5, sectors: 64, color: '#24321f' })
  const veins = [], rims = []
  // Пять больших листьев вокруг, три малых между ними — раскладка штампа.
  const pads = [[-.24, -.30, .21, .5, C.lily], [.25, -.28, .24, 2.2, C.lilyDark], [-.42, .12, .20, 4.1, C.lily], [.30, .22, .24, 3.3, C.lily], [-.05, .36, .18, 5.6, C.lilyDark], [.02, -.02, .085, 1.4, C.lily], [-.56, -.24, .07, 3.0, C.lilyDark], [.57, -.04, .075, .3, C.lily]]
  for (const [index, [x, z, radius, turn, color]] of pads.entries()) {
    const y = .031 + index * .0012
    m.mesh('lily-leaf-pad', lilyPadGeometry(radius, .42), [x, y, z], color, [0, turn, 0])
    const arc = []
    for (let step = 0; step <= 24; step += 1) {
      const angle = .21 + step / 24 * (TAU - .42) + turn
      arc.push([x + Math.cos(angle) * radius * .97, y + .013, z - Math.sin(angle) * radius * .97])
    }
    rims.push(tubeGeometry(arc, .006, 36, 4))
    if (radius > .1) for (let vein = 0; vein < 7; vein += 1) {
      const angle = .4 + vein / 6 * (TAU - .8) + turn
      veins.push(tubeGeometry([[x, y + .013, z], [x + Math.cos(angle) * radius * .85, y + .013, z - Math.sin(angle) * radius * .85]], .0035, 3, 3))
    }
  }
  merged(m, 'lily-leaf-rim', rims, C.lilyDark)
  merged(m, 'lily-leaf-vein', veins, '#9cbf55')
  // Один цветок на малом листе в середине.
  const flower = [.02, .045, -.02]
  for (const [ring, count, length, tilt, offset] of [[0, 8, .075, .35, 0], [1, 6, .055, .75, .4]]) {
    for (let index = 0; index < count; index += 1) {
      const angle = index / count * TAU + offset
      const reach = length * .45
      ellipsoid(m, `lily-flower-petal${ring ? '-inner' : ''}`, [length, .018, length * .42], [flower[0] + Math.cos(angle) * reach, flower[1] + Math.sin(tilt) * reach * .6, flower[2] - Math.sin(angle) * reach], C.lilyPetal, [0, angle, tilt], [10, 6])
    }
  }
  m.cylinder('lily-flower-center', .018, .022, .02, [flower[0], flower[1] + .02, flower[2]], C.lilyCenter, 12)
  return finish(m, [1.4, 1.3, .08])
}

/** Лента листа: сужается к концу, изгибается наружу; обе стороны видны. */
function bladeGeometries(blades) {
  const positions = [], indices = []
  for (const { base, azimuth, height, lean, droop, width } of blades) {
    const dx = Math.cos(azimuth), dz = Math.sin(azimuth)
    const sx = -dz, sz = dx
    const steps = 6
    const start = positions.length / 3
    for (let step = 0; step <= steps; step += 1) {
      const s = step / steps
      const out = lean * s * s * height
      const cx = base[0] + dx * out, cy = base[1] + height * s - droop * s ** 3, cz = base[2] + dz * out
      const half = width * (1 - s) ** .8 / 2 + .0008
      positions.push(cx + sx * half, cy, cz + sz * half, cx - sx * half, cy, cz - sz * half)
    }
    for (let step = 0; step < steps; step += 1) {
      const a = start + step * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  // Две стороны с общими вершинами погасили бы нормали — разводим их.
  const split = geometry.toNonIndexed()
  geometry.dispose()
  split.computeVertexNormals()
  return split
}

function buildReedCluster() {
  const m = new Model('reed_cluster')
  const next = random(321)
  const groups = [[], [], []]
  for (let index = 0; index < 130; index += 1) {
    const azimuth = next() * TAU
    const reach = Math.sqrt(next()) * .12
    const height = .55 + next() * .5
    groups[index % 3].push({
      base: [Math.cos(azimuth) * reach, .02, Math.sin(azimuth) * reach],
      azimuth: azimuth + (next() - .5) * .5,
      height,
      lean: .18 + next() * .4,
      droop: next() * .35,
      width: .038 + next() * .026,
    })
  }
  for (const [index, [name, color]] of [['reed-leaf-green', C.reed], ['reed-leaf-dark', C.reedDark], ['reed-leaf-dry', C.reedDry]].entries()) {
    m.mesh(name, bladeGeometries(groups[index]), [0, 0, 0], color)
  }
  // Рогоз: стебель выше листвы, коричневый початок и тонкий шип над ним.
  const stalks = []
  for (let index = 0; index < 7; index += 1) {
    const azimuth = index / 7 * TAU + next() * .5
    const lean = .18 + next() * .2
    const top = 1.05 + next() * .25
    const tip = [Math.cos(azimuth) * lean * top * .5, top, Math.sin(azimuth) * lean * top * .5]
    const base = [Math.cos(azimuth) * .05, .02, Math.sin(azimuth) * .05]
    stalks.push(tubeGeometry([base, [base[0] + tip[0] * .3, top * .5, base[2] + tip[2] * .3], tip], .007, 10, 4))
    const along = new THREE.Vector3(tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]).normalize()
    const head = m.mesh('cattail-felt-head', new THREE.LatheGeometry([[0, 0], [.022, .01], [.028, .04], [.028, .13], [.022, .16], [0, .17]].map(([r, y]) => new THREE.Vector2(r, y)), 10), [tip[0] - along.x * .2, tip[1] - along.y * .2, tip[2] - along.z * .2], C.cattail)
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), along)
  }
  merged(m, 'reed-stalk', stalks, C.reedDry)
  mound(m, 'reed-mud-clay', [.42, .06, .40], [0, 0, 0], C.mudDark, 322, { amount: .01, frequency: 10 })
  return finish(m, [1.2, 1.2, 1.3])
}

function buildMudPatch() {
  const m = new Model('mud_patch')
  const edge = (angle) => 1 + .08 * angleNoise(angle, 351, 9) + .05 * angleNoise(angle, 352, 18)
  const surface = (x, z) => .062 + .01 * noise2(x * 8, z * 8, 353)
  const reachOf = (x, z) => Math.hypot(x / .68, z / .63) / edge(Math.atan2(z / .63, x / .68))
  const heightAt = (x, z) => surface(x, z) * (1 - Math.min(1, reachOf(x, z)) ** 4)
  blob(m, 'mud-clay-skirt', { radius: [.70, .65], edge, height: (x, z, t) => .012 * (1 - t ** 2), rings: 3, sectors: 96, color: C.mudDark })
  blob(m, 'mud-clay-patch', { radius: [.68, .63], edge, height: (x, z, t) => surface(x, z) * (1 - t ** 4), rings: 10, sectors: 96, color: C.mud })
  // Лужицы-пузыри с ободком и бликом — как пузыри грязи в штампе.
  for (const [x, z, r] of [[-.05, -.26, .085], [.26, -.06, .06], [-.24, .06, .045], [.02, .24, .10], [-.34, -.20, .03], [.16, -.36, .025]]) {
    const y = heightAt(x, z) + .002
    m.cylinder('mud-puddle-water', r, r, .006, [x, y, z], C.mudWet, 24)
    ring(m, 'mud-puddle-rim-clay', r, .012, [x, y, z], C.mudLight, [PI / 2, 0, 0], 6, 24).scale.set(1, 1, .5)
    ellipsoid(m, 'mud-puddle-glint-water', [r * .5, .004, r * .25], [x - r * .3, y + .004, z - r * .35], C.mudLight, [0, .5, 0], [8, 4])
  }
  // Цепочка следов сапога по правому краю.
  for (const [x, z, turn] of [[.40, .34, -.3], [.48, .14, -.2], [.42, -.10, -.35]]) {
    const y = heightAt(x, z) + .001
    const dx = Math.sin(turn), dz = Math.cos(turn)
    ellipsoid(m, 'mud-footprint-clay', [.07, .006, .10], [x - dx * .03, y, z - dz * .03], C.mudWet, [0, turn, 0], [10, 4])
    ellipsoid(m, 'mud-footprint-clay', [.06, .006, .05], [x + dx * .07, y, z + dz * .07], C.mudWet, [0, turn, 0], [10, 4])
  }
  return finish(m, [1.4, 1.3, .08])
}

function buildRottenLog() {
  const m = new Model('rotten_log')
  const length = 2.62, radius = .29, nx = 44, nt = 28, seed = 361
  const holes = [[-.55, .17, .10], [.38, .14, .09]]
  // Ствол лежит вдоль X: кора с продольными гребнями, лёгкий изгиб и две дыры-дупла сверху.
  const shape = (x, theta) => {
    const ridge = Math.abs(Math.sin(theta * 7 + .9 * noise2(x * 1.5, 0, seed))) - .5
    let r = radius * (1 + .05 * noise2(x * 3, theta * 2, seed + 1) + .035 * ridge - .04 * (x / length + .5))
    const top = Math.cos(theta)
    for (const [hx, ax, az] of holes) {
      const z = r * Math.sin(theta)
      const inside = 1 - ((x - hx) / ax) ** 2 - (z / az) ** 2
      if (inside > 0 && top > .5) r -= .16 * Math.min(1, inside * 2.2)
    }
    return r
  }
  const ends = (theta, side) => .05 * noise2(theta * 3, side * 5, seed + 2) + .04 * Math.sin(theta * 2 + side)
  const positions = [], indices = []
  for (let i = 0; i <= nx; i += 1) {
    const u = i / nx
    for (let j = 0; j < nt; j += 1) {
      const theta = j / nt * TAU
      let x = -length / 2 + u * length
      if (i === 0) x -= ends(theta, -1)
      if (i === nx) x += ends(theta, 1)
      const r = shape(x, theta)
      const sag = .02 * Math.sin(u * PI)
      positions.push(x, Math.max(.015, radius + r * Math.cos(theta) - sag), r * Math.sin(theta))
    }
  }
  for (let i = 0; i < nx; i += 1) for (let j = 0; j < nt; j += 1) {
    const a = i * nt + j, b = i * nt + (j + 1) % nt, c = (i + 1) * nt + j, d = (i + 1) * nt + (j + 1) % nt
    indices.push(a, b, c, b, d, c)
  }
  const body = new THREE.BufferGeometry()
  body.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  body.setIndex(indices)
  body.computeVertexNormals()
  const log = m.mesh('rotten-log-bark', body, [0, 0, 0], C.bark)
  // Торцы: рваный срез светлой трухи с тёмной сердцевиной.
  for (const [side, ringIndex] of [[-1, 0], [1, nx]]) {
    const cap = [], capIndex = []
    let cx = 0
    for (let j = 0; j < nt; j += 1) cx += positions[(ringIndex * nt + j) * 3] / nt
    cap.push(cx - side * .03, radius, 0)
    for (let j = 0; j < nt; j += 1) cap.push(...positions.slice((ringIndex * nt + j) * 3, (ringIndex * nt + j) * 3 + 3))
    for (let j = 0; j < nt; j += 1) side < 0 ? capIndex.push(0, 1 + (j + 1) % nt, 1 + j) : capIndex.push(0, 1 + j, 1 + (j + 1) % nt)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(cap, 3))
    geometry.setIndex(capIndex)
    geometry.computeVertexNormals()
    m.mesh('rotten-log-end-wood', geometry, [0, 0, 0], C.rotten)
    ellipsoid(m, 'rotten-log-end-hole', [.05, .17, .15], [cx - side * .01, radius, .01], C.hole, [0, 0, 0], [12, 8])
    for (let k = 0; k < 4; k += 1) {
      const angle = k / 4 * TAU + side
      const splinter = m.mesh('rotten-log-splinter-wood', new THREE.ConeGeometry(.025, .14, 3), [cx + side * .05, radius + Math.cos(angle) * .2, Math.sin(angle) * .2], C.rotten)
      splinter.rotation.set(0, 0, -side * PI / 2 + Math.sin(angle) * .3)
    }
  }
  for (const [hx, ax, az] of holes) {
    ellipsoid(m, 'rotten-log-hole', [ax * 1.6, .05, az * 1.6], [hx, radius * 2 - .16, 0], C.hole, [0, 0, 0], [14, 6])
    const rim = []
    for (let step = 0; step < 18; step += 1) {
      const angle = step / 18 * TAU
      const x = hx + Math.cos(angle) * ax * 1.02, z = Math.sin(angle) * az * 1.05
      rim.push([x, surfaceY(log, x, z, radius * 2) + .004, z])
    }
    tube(m, 'rotten-log-hole-rim-wood', rim, .016, C.rotten, 36, 5, true)
  }
  // Продольные трещины коры и пятна мха по верху.
  for (const theta of [-.5, .25, .9, -1.1]) {
    const crack = []
    for (let step = 0; step <= 8; step += 1) {
      const x = -1.05 + step * .26 + theta * .1
      const r = shape(x, theta) + .004
      crack.push([x, radius + r * Math.cos(theta), r * Math.sin(theta)])
    }
    tube(m, 'rotten-log-bark-crack', crack, .009, C.barkDark, 32, 4)
  }
  const next = random(362)
  for (let index = 0; index < 9; index += 1) {
    // Пятно ложится по нормали ствола, поэтому не тонет на скате и не висит над ним.
    const x = -1.15 + index * .28 + (next() - .5) * .1, theta = (next() - .5) * 1.6
    const r = shape(x, theta) - .018
    const w = .22 + next() * .16
    mound(m, 'rotten-log-moss', [w, .045, .10 + next() * .08], [x, radius + r * Math.cos(theta), r * Math.sin(theta)], index % 2 ? C.moss : C.mossLight, 363 + index, { amount: .01, frequency: 14, widthSegments: 12, heightSegments: 4, rotation: [theta, 0, 0] })
  }
  return finish(m, [2.8, .7, .6])
}

/** Тыква-погремушка: пузатое тело, узкое горло, тёмное отверстие сбоку. */
function addGourd(m, position, scale, turn, seed) {
  const s = scale
  m.group('totem-gourd', position, [0, turn, 0], () => {
    lathe(m, 'totem-gourd-fruit', [[0, -.10 * s], [.07 * s, -.09 * s], [.10 * s, -.05 * s], [.105 * s, .01 * s], [.08 * s, .06 * s], [.04 * s, .09 * s], [.03 * s, .13 * s], [.035 * s, .15 * s], [0, .155 * s]], [0, 0, 0], seed % 2 ? '#c49a5c' : '#b8884c', 16)
    ellipsoid(m, 'totem-gourd-opening', [.11 * s, .1 * s, .03 * s], [0, -.015 * s, -.088 * s], C.hole, [0, 0, 0], [12, 8])
    ring(m, 'totem-gourd-opening-rim-fruit', .05 * s, .008 * s, [0, -.015 * s, -.094 * s], '#d8b070', [0, 0, 0], 5, 16)
    tube(m, 'totem-cord', [[0, .15 * s, 0], [0, .24 * s, .01], [0, .32 * s, 0]], .006, C.ropeDark, 6, 4)
  })
}

function buildSwampTotem() {
  const m = new Model('swamp_totem')
  // Шесть жердей сходятся в связке на ~55% высоты и снова расходятся кверху.
  const poles = []
  const next = random(371)
  for (let index = 0; index < 6; index += 1) {
    const angle = index / 6 * TAU + .2
    const topAngle = angle + PI + (next() - .5) * .5
    const bottom = [Math.cos(angle) * .27, 0, Math.sin(angle) * .27]
    const top = [Math.cos(topAngle) * .20, 1.48 + next() * .12, Math.sin(topAngle) * .20]
    const mid = [(bottom[0] + top[0]) / 2 + (next() - .5) * .03, .82, (bottom[2] + top[2]) / 2 + (next() - .5) * .03]
    poles.push([bottom, mid, top])
    taperedTube(m, index % 2 ? 'totem-wood-pole' : 'totem-wood-pole-grey', [bottom, mid, top], .034, .022, index % 2 ? C.wood : C.woodGrey, 14, 6)
    // Сучки-обломки торчат из жердей.
    const stub = [mid[0] + (top[0] - mid[0]) * .5, 1.15 + next() * .1, mid[2] + (top[2] - mid[2]) * .5]
    taperedTube(m, 'totem-wood-twig', [stub, [stub[0] + Math.cos(angle) * .08, stub[1] + .07, stub[2] + Math.sin(angle) * .08]], .012, .005, C.woodGrey, 3, 4)
  }
  for (const y of [.76, .80, .84, .88]) ring(m, 'totem-rope-lashing', .075 + (y - .82) ** 2, .013, [0, y, 0], C.rope, [PI / 2, 0, 0], 6, 20)
  tube(m, 'totem-rope-lashing-cross', [[-.07, .74, -.03], [0, .82, -.08], [.07, .90, -.03]], .011, C.ropeDark, 10, 4)
  tube(m, 'totem-rope-lashing-cross', [[.07, .74, -.03], [0, .82, -.08], [-.07, .90, -.03]], .011, C.ropeDark, 10, 4)
  for (const [index, [bottom, mid, top]] of poles.entries()) {
    if (index % 2) continue
    const t = .35
    const at = [mid[0] + (top[0] - mid[0]) * t, mid[1] + (top[1] - mid[1]) * t, mid[2] + (top[2] - mid[2]) * t]
    mound(m, 'totem-moss', [.07, .05, .06], at, C.moss, 372 + index, { amount: .008, frequency: 20, widthSegments: 10, heightSegments: 4 })
    const low = [mid[0] + (bottom[0] - mid[0]) * .6, mid[1] + (bottom[1] - mid[1]) * .6, mid[2] + (bottom[2] - mid[2]) * .6]
    mound(m, 'totem-moss', [.06, .06, .05], low, C.mossDark, 380 + index, { amount: .008, frequency: 20, widthSegments: 10, heightSegments: 4 })
  }
  // Большая тыква висит по центру спереди, две малые — по бокам, как в штампе.
  addGourd(m, [0, 1.06, -.15], 1.25, 0, 1)
  addGourd(m, [-.24, .86, -.10], .95, .4, 2)
  addGourd(m, [.24, .86, -.10], .95, -.4, 3)
  tube(m, 'totem-cord', [[0, 1.46, -.02], [0, 1.40, -.10], [0, 1.32, -.15]], .006, C.ropeDark, 6, 4)
  for (const side of [-1, 1]) tube(m, 'totem-cord', [[side * .1, 1.2, -.05], [side * .2, 1.12, -.09], [side * .24, 1.08, -.10]], .006, C.ropeDark, 6, 4)
  mound(m, 'totem-mud-clay', [.48, .07, .46], [0, 0, 0], C.mudDark, 385, { amount: .012, frequency: 9 })
  return finish(m, [.7, .7, 1.6])
}

function buildPeatMound() {
  const m = new Model('peat_mound')
  const edge = (angle) => 1 + .07 * angleNoise(angle, 391, 7)
  const reachOf = (x, z) => Math.hypot(x / .68, z / .63) / edge(Math.atan2(z / .63, x / .68))
  const profile = (x, z, t) => (.26 * Math.max(0, 1 - t * t) ** .7 + .025 * noise2(x * 6, z * 6, 392) + .01) * (1 - t ** 8)
  const heightAt = (x, z) => profile(x, z, Math.min(1, reachOf(x, z)))
  blob(m, 'peat-clay-mound', { radius: [.68, .63], edge, height: profile, rings: 12, sectors: 64, color: C.peat })
  // Мох пятнами по всей кочке, трава пучками — как в штампе.
  const next = random(393)
  const mossColors = [C.moss, C.mossLight, C.mossDark, C.moss]
  for (let index = 0; index < 30; index += 1) {
    const angle = next() * TAU, reach = Math.sqrt(next()) * .85
    const x = Math.cos(angle) * .64 * reach, z = Math.sin(angle) * .58 * reach
    const w = .18 + next() * .18
    mound(m, 'peat-moss-patch', [w, .035 + next() * .03, w * (.6 + next() * .5)], [x, heightAt(x, z) - .02, z], mossColors[index % 4], 394 + index, { amount: .012, frequency: 14, widthSegments: 12, heightSegments: 4, rotation: [0, next() * PI, 0] })
  }
  for (let index = 0; index < 8; index += 1) {
    const angle = index / 8 * TAU + next() * .5, reach = .25 + next() * .55
    const x = Math.cos(angle) * .62 * reach, z = Math.sin(angle) * .56 * reach
    grassTuft(m, index % 3 ? 'peat-grass-tuft' : 'peat-grass-tuft-dry', [x, heightAt(x, z) - .01, z], index % 3 ? C.grass : C.grassDry, 420 + index, { count: 16, height: .14, spread: .05, lean: .7, radius: .01 })
  }
  return finish(m, [1.4, 1.3, .4])
}

// ----------------------------------------------------------------- гавань

/** Канат с видимой свивкой: основной жгут и две пряди, обвивающие его по спирали. */
function twistedRope(m, name, points, radius, color, strandColor, { segments = 96, twists = 18, closed = false } = {}) {
  tube(m, name, points, radius, color, segments, 8, closed)
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), closed, 'centripetal')
  const frames = curve.computeFrenetFrames(segments * 2, closed)
  const strands = []
  for (const phase of [0, PI]) {
    const path = []
    for (let step = 0; step <= segments * 2; step += 1) {
      const t = step / (segments * 2)
      const angle = t * twists * TAU + phase
      const center = curve.getPointAt(t)
      const offset = frames.normals[step].clone().multiplyScalar(Math.cos(angle) * radius * .78).addScaledVector(frames.binormals[step], Math.sin(angle) * radius * .78)
      path.push(center.add(offset).toArray())
    }
    strands.push(tubeGeometry(path, radius * .38, segments * 2, 4))
  }
  return merged(m, `${name}-strand`, strands, strandColor)
}

function buildMooringBollard() {
  const m = new Model('mooring_bollard')
  lathe(m, 'bollard-iron-plate', [[0, 0], [.43, 0], [.445, .02], [.44, .065], [.40, .088], [.25, .095], [0, .095]], [0, 0, 0], C.iron, 48)
  // Тумба-гриб: узкая шейка под канат и широкая скруглённая шляпа.
  lathe(m, 'bollard-iron-post', [[0, .09], [.23, .09], [.205, .13], [.175, .22], [.165, .40], [.172, .50], [.195, .56], [.228, .61], [.245, .655], [.243, .70], [.225, .745], [.18, .775], [.11, .794], [0, .80]], [0, 0, 0], C.iron, 48)
  ring(m, 'bollard-iron-cap-lip', .236, .016, [0, .632, 0], C.ironLight, [PI / 2, 0, 0], 6, 48)
  ring(m, 'bollard-iron-foot-ring', .215, .022, [0, .11, 0], C.ironLight, [PI / 2, 0, 0], 6, 40)
  const bolts = []
  for (let index = 0; index < 6; index += 1) {
    const angle = index / 6 * TAU + PI / 6
    bolts.push({ position: [Math.cos(angle) * .34, .115, Math.sin(angle) * .34], rotation: [0, angle, 0], scale: [1, 1, 1] })
  }
  scatter(m, 'bollard-iron-bolt', () => new THREE.CylinderGeometry(.038, .042, .04, 6), bolts, C.ironLight)
  scatter(m, 'bollard-iron-washer', () => new THREE.CylinderGeometry(.055, .055, .012, 16), bolts.map(({ position }) => ({ position: [position[0], .098, position[2]] })), C.iron)
  // Ржавые потёки на шляпе и плите.
  for (const [x, y, z, w, d, turn] of [[.08, .797, -.06, .12, .07, .4], [-.12, .79, .08, .08, .05, -.6], [.30, .092, .18, .1, .05, 1.1], [-.26, .093, -.28, .08, .05, .2]]) {
    ellipsoid(m, 'bollard-iron-rust', [w, .008, d], [x, y, z], C.ironRust, [0, turn, 0], [10, 4])
  }
  // Канат обмотан вокруг шейки двумя с половиной витками.
  const coil = []
  for (let step = 0; step <= 60; step += 1) {
    const t = step / 60
    const angle = t * 2.5 * TAU
    coil.push([Math.cos(angle) * .215, .25 + t * .21, Math.sin(angle) * .215])
  }
  twistedRope(m, 'bollard-rope', coil, .048, C.rope, C.ropeDark, { segments: 90, twists: 26 })
  return finish(m, [.9, .9, .8])
}

function buildCargoNet() {
  const m = new Model('cargo_net')
  // Мешки под сетью: мягкий холм с буграми отдельных мешков.
  const sacks = [[-.24, -.22, .07], [.22, -.20, .06], [-.20, .24, .06], [.24, .22, .07], [0, 0, .05]]
  const fall = (u) => Math.max(0, 1 - Math.abs(u / .6) ** 4) ** .5
  const surface = (x, z) => .44 * fall(x) * fall(z) + sacks.reduce((sum, [sx, sz, h]) => sum + h * Math.exp(-((x - sx) ** 2 + (z - sz) ** 2) / .03), 0) * fall(x) * fall(z)
  const square = (angle) => 1 / (Math.abs(Math.cos(angle)) ** 5 + Math.abs(Math.sin(angle)) ** 5) ** .2
  blob(m, 'cargo-sack-canvas', { radius: [.6, .6], edge: square, height: (x, z) => Math.max(.01, surface(x, z) - .02), rings: 14, sectors: 64, color: C.canvasDark })
  // Сетка: веревки по высоте холма, узлы на пересечениях, опушка у земли.
  const lines = []
  const knots = []
  const count = 9
  for (let index = 0; index < count; index += 1) {
    const u = -.56 + index / (count - 1) * 1.12
    const alongX = [], alongZ = []
    for (let step = 0; step <= 24; step += 1) {
      const v = -.64 + step / 24 * 1.28
      alongX.push([v, surface(v, u) + .012, u])
      alongZ.push([u, surface(u, v) + .012, v])
    }
    lines.push(tubeGeometry(alongX, .011, 30, 4), tubeGeometry(alongZ, .011, 30, 4))
    for (let other = 0; other < count; other += 1) {
      const w = -.56 + other / (count - 1) * 1.12
      knots.push({ position: [u, surface(u, w) + .014, w], rotation: [0, PI / 4, 0], scale: [.022, .016, .022] })
    }
  }
  merged(m, 'cargo-net-rope', lines, C.rope)
  scatter(m, 'cargo-net-knot', () => new THREE.OctahedronGeometry(1, 0), knots, C.ropeDark)
  const border = []
  for (let index = 0; index < 32; index += 1) {
    const angle = index / 32 * TAU
    border.push([Math.cos(angle) * .64 * square(angle), .02, Math.sin(angle) * .64 * square(angle)])
  }
  tube(m, 'cargo-net-border-rope', border, .018, C.ropeDark, 64, 5, true)
  // Четыре поплавка по углам, лежат по диагонали.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const yaw = Math.atan2(-sz, sx)
    m.group('cargo-float', [sx * .55, .085, sz * .55], [0, yaw, 0], () => {
      const body = lathe(m, 'cargo-float-wood', [[0, -.14], [.05, -.135], [.078, -.10], [.088, -.03], [.088, .03], [.078, .10], [.05, .135], [0, .14]], [0, 0, 0], C.float, 18)
      body.rotation.z = PI / 2
      for (const x of [-.07, .07]) ring(m, 'cargo-float-rope-band', .086, .009, [x, 0, 0], C.ropeDark, [0, PI / 2, 0], 5, 20)
    })
    tube(m, 'cargo-net-rope-tie', [[sx * .62, .03, sz * .62], [sx * .58, .10, sz * .58], [sx * .56, .17, sz * .56]], .012, C.rope, 8, 4)
  }
  return finish(m, [1.3, 1.3, .6])
}

function buildLobsterCage() {
  const m = new Model('lobster_cage')
  // Бочка лежит вдоль X; сечение — сплюснутый эллипс, чтобы ловушка стояла устойчиво.
  const cy = .32, ry = .29, rz = .37, half = .68
  const shrink = (x) => 1 - .14 * (x / half) ** 2
  const rods = []
  for (let index = 0; index < 20; index += 1) {
    const angle = index / 20 * TAU
    const path = []
    for (let step = 0; step <= 8; step += 1) {
      const x = -half + step / 8 * half * 2
      path.push([x, cy + Math.cos(angle) * ry * shrink(x) * 1.03, Math.sin(angle) * rz * shrink(x) * 1.03])
    }
    rods.push(tubeGeometry(path, .012, 16, 4))
  }
  merged(m, 'lobster-reed-rod', rods, C.straw)
  for (const x of [-.62, -.31, 0, .31, .62]) {
    const hoop = ring(m, 'lobster-wood-ring', ry * shrink(x), .022, [x, cy, 0], C.woodLight, [0, PI / 2, 0], 6, 32)
    hoop.scale.set(rz / ry, 1, 1)
    const lash = ring(m, 'lobster-rope-lashing', ry * shrink(x) + .012, .012, [x, cy, 0], C.rope, [0, PI / 2, 0], 4, 32)
    lash.scale.set(rz / ry, 1, 1)
  }
  // Тёмное нутро видно сквозь прутья сверху.
  const core = m.cylinder('lobster-shadow-core', ry * .9, ry * .9, half * 1.9, [0, cy, 0], C.shadow, 24, [0, 0, PI / 2])
  core.scale.set(1, 1, rz / ry)
  // Глухой торец сплетён, с другого конца — сетчатая воронка-вход.
  const end = lathe(m, 'lobster-reed-end', [[ry * shrink(half), 0], [ry * .8, .02], [ry * .5, .035], [0, .04]], [half, cy, 0], C.strawDark, 24)
  end.rotation.z = -PI / 2
  end.scale.set(1, 1, rz / ry)
  const funnel = lathe(m, 'lobster-net-funnel', [[.08, .26], [.14, .12], [ry * shrink(half) * .95, 0]], [-half, cy, 0], C.ropeDark, 20)
  funnel.rotation.z = -PI / 2
  funnel.scale.set(1, 1, rz / ry)
  ring(m, 'lobster-wood-ring-entrance', .08, .012, [-half + .26, cy, 0], C.woodLight, [0, PI / 2, 0], 5, 16)
  for (const z of [-.2, .2]) plank(m, 'lobster-wood-skid', [1.3, .05, .07], [0, .025, z], C.woodDark)
  return finish(m, [1.4, .8, .6])
}

/** Архимедова спираль в плоскости YZ — торец скатки. */
function endSpiral(center, turns, inner, outer, steps = 48) {
  const points = []
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const angle = t * turns * TAU
    const radius = inner + (outer - inner) * t
    points.push([center[0], center[1] + Math.cos(angle) * radius, center[2] + Math.sin(angle) * radius])
  }
  return points
}

function buildSailBundle() {
  const m = new Model('sail_bundle')
  // Скатка паруса лежит сзади, рей — спереди (+Z), как в штампе; обе связаны верёвками.
  const roll = [0, .165, -.06], rollRadius = .165, spar = [0, .048, .16], sparRadius = .048
  const body = new THREE.CylinderGeometry(rollRadius, rollRadius, 1.30, 40, 12, false)
  const pos = body.getAttribute('position')
  for (let index = 0; index < pos.count; index += 1) {
    const x = pos.getX(index), y = pos.getY(index), z = pos.getZ(index)
    const reach = Math.hypot(x, z)
    if (reach < 1e-4) continue
    const angle = Math.atan2(z, x)
    const fold = 1 + .05 * Math.sin(angle * 5 + y * 4) * Math.sin(y * 7) + .03 * noise2(angle * 2, y * 5, 431)
    pos.setXYZ(index, x * fold, y, z * fold)
  }
  body.computeVertexNormals()
  m.mesh('sail-canvas-roll', body, roll, C.sailcloth, [0, 0, PI / 2])
  for (const side of [-1, 1]) {
    tube(m, 'sail-canvas-spiral', endSpiral([side * .652, roll[1], roll[2]], 3, .02, rollRadius * .95, 72), .006, C.sailShade, 72, 4)
  }
  for (const [x0, x1, a0, a1] of [[-.5, -.2, .3, 1.4], [.1, .45, -.4, .9], [-.1, .2, 2.2, 3.0]]) {
    const path = []
    for (let step = 0; step <= 6; step += 1) {
      const t = step / 6, angle = a0 + (a1 - a0) * t
      path.push([x0 + (x1 - x0) * t, roll[1] + Math.cos(angle) * (rollRadius + .004), roll[2] + Math.sin(angle) * (rollRadius + .004)])
    }
    tube(m, 'sail-canvas-fold', path, .007, C.sailShade, 12, 4)
  }
  m.cylinder('yard-spar-wood', sparRadius, sparRadius, 1.40, spar, C.woodLight, 20, [0, 0, PI / 2])
  for (const side of [-1, 1]) m.cylinder('yard-iron-cap', sparRadius + .006, sparRadius + .006, .05, [side * .69, spar[1], spar[2]], C.iron, 20, [0, 0, PI / 2])
  // Перевязки: два витка вокруг скатки и рея вместе.
  const loop = (x) => {
    const points = []
    for (let step = 0; step < 20; step += 1) {
      const angle = step / 20 * TAU
      const cz = Math.sin(angle), cyy = Math.cos(angle)
      // Выпуклая оболочка двух кругов: верх и зад — по скатке, низ и перед — по рею.
      const towardSpar = cz * .87 - cyy * .5
      const source = towardSpar > .35 ? [spar, sparRadius] : [roll, rollRadius]
      points.push([x, source[0][1] + cyy * (source[1] + .014), source[0][2] + cz * (source[1] + .014)])
    }
    return points
  }
  for (const x of [-.38, .38]) for (const dx of [-.025, .025]) tube(m, 'sail-rope-tie', loop(x + dx), .014, C.rope, 48, 5, true)
  return finish(m, [1.4, .5, .35])
}

// ------------------------------------------------------------------ лагерь

function addBedroll(m, position, yaw, color, shade, seed) {
  const radius = .155, length = .56
  m.group('bedroll', position, [0, yaw, 0], () => {
    const body = new THREE.CylinderGeometry(radius, radius, length, 32, 6, false)
    const pos = body.getAttribute('position')
    for (let index = 0; index < pos.count; index += 1) {
      const x = pos.getX(index), y = pos.getY(index), z = pos.getZ(index)
      const reach = Math.hypot(x, z)
      if (reach < 1e-4) continue
      const bulge = 1 + .03 * Math.cos(y / length * PI) + .015 * noise2(Math.atan2(z, x) * 2, y * 6, seed)
      pos.setXYZ(index, x * bulge, y, z * bulge)
    }
    body.computeVertexNormals()
    m.mesh('bedroll-blanket', body, [0, radius, 0], color, [0, 0, PI / 2])
    tube(m, 'bedroll-blanket-spiral', endSpiral([length / 2 + .004, radius, 0], 3.2, .015, radius * .92, 72), .007, shade, 72, 4)
    for (const x of [-.15, .15]) {
      const strap = ring(m, 'bedroll-leather-strap', radius * 1.04, .016, [x, radius, 0], C.leather, [0, PI / 2, 0], 6, 32)
      strap.scale.set(1, 1, 1.9)
      m.mesh('bedroll-iron-buckle', new THREE.TorusGeometry(.026, .006, 4, 4), [x, radius * 2 + .02, 0], C.ironLight, [PI / 2, 0, PI / 4])
      plank(m, 'bedroll-leather-strap-tail', [.035, .008, .08], [x, radius * 2 + .018, .055], C.leather, [-.25, 0, 0])
    }
  })
}

function buildBedrollCluster() {
  const m = new Model('bedroll_cluster')
  // Зелёный сверху, песочный слева снизу, серый справа снизу; спирали смотрят наружу, как в штампе.
  addBedroll(m, [.04, 0, -.30], -PI / 2 + .12, C.bedGreen, C.mossDark, 441)
  addBedroll(m, [-.34, 0, .24], -PI / 4, C.bedTan, C.strawDark, 442)
  addBedroll(m, [.35, 0, .26], -3 * PI / 4, C.bedGrey, C.iron, 443)
  return finish(m, [1.3, 1.2, .35])
}

function addShield(m, position, paint, seed) {
  const radius = .27
  m.group('shield', position, [-.12, 0, 0], () => {
    m.mesh('shield-wood-face', new THREE.CylinderGeometry(radius, radius, .03, 40), [0, 0, 0], seed % 2 ? C.wood : C.woodEdge, [PI / 2, 0, 0])
    if (paint) m.mesh('shield-paint-wood', new THREE.CylinderGeometry(radius * .95, radius * .95, .004, 32, 1, false, 0, PI), [0, 0, -.017], paint, [PI / 2, 0, 0])
    for (const x of [-.16, -.055, .055, .16]) {
      const height = 2 * Math.sqrt(radius * radius - x * x) * .96
      plank(m, 'shield-wood-plank-seam', [.008, height, .006], [x, 0, -.016], C.woodDark)
    }
    ring(m, 'shield-iron-rim', radius, .02, [0, 0, 0], C.iron, [0, 0, 0], 6, 44)
    const boss = m.mesh('shield-iron-boss', new THREE.SphereGeometry(.07, 18, 8, 0, TAU, 0, PI / 2), [0, 0, -.015], C.ironLight, [-PI / 2, 0, 0])
    boss.scale.set(1, .8, 1)
    ring(m, 'shield-iron-boss-band', .075, .012, [0, 0, -.017], C.iron, [0, 0, 0], 5, 24)
    const rivets = []
    for (let index = 0; index < 12; index += 1) {
      const angle = index / 12 * TAU
      rivets.push({ position: [Math.cos(angle) * (radius - .035), Math.sin(angle) * (radius - .035), -.017], rotation: [PI / 2, 0, 0] })
    }
    scatter(m, 'shield-iron-rivet', () => new THREE.SphereGeometry(.011, 6, 3, 0, TAU, 0, PI / 2), rivets, C.ironLight)
  })
}

function buildShieldRack() {
  const m = new Model('shield_rack')
  // Рама стоит в плоскости XY, щиты смотрят вперёд (−Z) и опираются на поперечины.
  for (const x of [-.66, .66]) {
    plank(m, 'rack-foot-beam', [.10, .08, .50], [x, .04, 0], C.woodDark)
    plank(m, 'rack-wood-post', [.08, 1.20, .08], [x, .60, .04], C.wood)
    plank(m, 'rack-wood-post-cap', [.11, .04, .11], [x, 1.21, .04], C.woodEdge)
    for (const z of [-.18, .22]) bar(m, 'rack-wood-brace', [x, .07, z], [x, .32, .04 + Math.sign(z) * .03], .05, .05, C.woodEdge)
  }
  for (const y of [.10, .63, 1.14]) {
    plank(m, 'rack-wood-crossbar', [1.42, .07, .07], [0, y, .08], C.woodLight)
    for (const x of [-.66, .66]) {
      for (const tilt of [-1, 1]) tube(m, 'rack-rope-lashing', [[x - .06, y - .06 * tilt, .03], [x, y, .025], [x + .06, y + .06 * tilt, .03]], .009, C.rope, 6, 4)
      addNail(m, 'rack-iron-nail', [x, y, .03], C.ironLight).rotation.x = PI / 2
    }
  }
  plank(m, 'rack-wood-shelf-ledge', [1.30, .04, .12], [0, .14, -.02], C.wood)
  addShield(m, [-.32, .40, -.05], null, 1)
  addShield(m, [.32, .40, -.05], null, 2)
  addShield(m, [-.32, .93, -.02], null, 3)
  addShield(m, [.32, .93, -.02], '#5d6c7a', 4)
  for (const [x, y] of [[-.32, .66], [.32, .66], [-.32, 1.17], [.32, 1.17]]) {
    m.cylinder('rack-wood-peg', .016, .016, .12, [x, y, .02], C.woodDark, 10, [PI / 2, 0, 0])
  }
  return finish(m, [1.4, .5, 1.2])
}

/** Соломенный жгут: шероховатая органика вокруг оси. */
function strawBundle(m, name, profile, position, color, seed, rotation = [0, 0, 0]) {
  const geometry = new THREE.LatheGeometry(profile.map(([radius, y]) => new THREE.Vector2(radius, y)), 20)
  return m.lumpy(name, geometry, position, color, { amount: .012, frequency: 22, seed, rotation })
}

function buildCampDummy() {
  const m = new Model('camp_dummy')
  // Крестовина из двух брусьев (X сверху), стойка, соломенное тело с руками и головой.
  for (const [ax, az] of [[1, 1], [1, -1]]) {
    bar(m, 'dummy-wood-foot-beam', [-ax * .34, .045, -az * .34], [ax * .34, .045, az * .34], .09, .09, C.wood)
    for (const sign of [-1, 1]) bar(m, 'dummy-iron-cap', [sign * ax * .30, .045, sign * az * .30], [sign * ax * .35, .045, sign * az * .35], .10, .10, C.iron)
  }
  plank(m, 'dummy-iron-bracket', [.14, .10, .14], [0, .13, 0], C.iron)
  bar(m, 'dummy-wood-post', [0, .05, 0], [0, 1.25, 0], .085, .085, C.woodDark)
  strawBundle(m, 'dummy-straw-skirt', [[.05, 0], [.19, .0], [.17, .06], [.14, .16], [.12, .24]], [0, .56, 0], C.strawDark, 451)
  const fringe = []
  for (let index = 0; index < 28; index += 1) {
    const angle = index / 28 * TAU
    fringe.push({ position: [Math.cos(angle) * .19, .55, Math.sin(angle) * .19], rotation: [Math.sin(angle) * .5, 0, -Math.cos(angle) * .5], scale: [1, 1, 1] })
  }
  scatter(m, 'dummy-straw-fringe', () => new THREE.ConeGeometry(.018, .09, 4).rotateX(PI), fringe, C.straw)
  strawBundle(m, 'dummy-straw-torso', [[0, 0], [.12, 0], [.15, .08], [.17, .24], [.165, .36], [.13, .44], [.06, .47], [0, .48]], [0, .76, 0], C.straw, 452)
  strawBundle(m, 'dummy-straw-arm', [[0, -.33], [.05, -.32], [.065, -.25], [.06, 0], [.065, .25], [.05, .32], [0, .33]], [0, 1.12, 0], C.straw, 453, [0, 0, PI / 2])
  for (const side of [-1, 1]) {
    const hand = m.mesh('dummy-straw-hand', new THREE.ConeGeometry(.075, .11, 10, 1, true), [side * .37, 1.12, 0], C.strawDark)
    hand.rotation.z = side * PI / 2
    ring(m, 'dummy-rope-tie', .068, .012, [side * .28, 1.12, 0], C.rope, [0, PI / 2, 0], 5, 20)
  }
  m.lumpy('dummy-straw-head', new THREE.IcosahedronGeometry(.13, 3), [0, 1.37, 0], C.straw, { size: [1, 1.08, .95], amount: .015, frequency: 18, seed: 454 })
  const tuft = []
  for (let index = 0; index < 14; index += 1) {
    const angle = index / 14 * TAU
    tuft.push({ position: [Math.cos(angle) * .03, 1.51, Math.sin(angle) * .03], rotation: [Math.sin(angle) * .45, 0, -Math.cos(angle) * .45], scale: [1, 1, 1] })
  }
  scatter(m, 'dummy-straw-tuft', () => new THREE.ConeGeometry(.012, .10, 4), tuft, C.strawDark)
  for (const [y, radius] of [[1.235, .075], [.80, .155], [.95, .175]]) ring(m, 'dummy-rope-tie', radius, .013, [0, y, 0], C.rope, [PI / 2, 0, 0], 5, 28)
  tube(m, 'dummy-rope-tie-cross', [[-.15, .86, -.15], [0, 1.0, -.175], [.15, 1.14, -.13]], .011, C.rope, 10, 4)
  tube(m, 'dummy-rope-tie-cross', [[.15, .86, -.15], [0, 1.0, -.175], [-.15, 1.14, -.13]], .011, C.rope, 10, 4)
  return finish(m, [.8, .8, 1.6])
}

function addSpike(m, base, direction, length, spikes, collars) {
  const dir = new THREE.Vector3(...direction).normalize()
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  const rotation = new THREE.Euler().setFromQuaternion(quaternion).toArray().slice(0, 3)
  const center = new THREE.Vector3(...base).addScaledVector(dir, length / 2)
  spikes.push({ position: center.toArray(), rotation, scale: [1, length, 1] })
  collars.push({ position: new THREE.Vector3(...base).addScaledVector(dir, .02).toArray(), rotation, scale: [1, 1, 1] })
}

function buildSpikedBeamBarrier() {
  const m = new Model('spiked_beam_barrier')
  // «Рогатка» сверху — чёткий крест: два бруса одной длины по диагоналям габарита.
  // Нижний лежит на земле, верхний врублен в него и чуть поднят над перекрестьем;
  // концы обоих опираются на землю. Концы и шипы рассчитаны так, чтобы всё
  // помещалось в 1.4×1.2 без сжатия в finish.
  const reach = [.55, .45], half = Math.hypot(...reach), section = .2, notch = .09
  const ground = section / 2, crest = ground + notch
  const beams = [
    { axis: new THREE.Vector3(reach[0], 0, reach[1]).normalize(), height: () => ground, color: C.wood },
    { axis: new THREE.Vector3(reach[0], 0, -reach[1]).normalize(), height: (t) => ground + notch * (1 - Math.abs(t)), color: C.woodLight },
  ]
  const spikes = [], collars = [], nails = []
  for (const [index, { axis, height, color }] of beams.entries()) {
    const at = (t) => [axis.x * half * t, height(t), axis.z * half * t]
    if (index) {
      // Верхний брус — два отрезка от концов к перекрестью; излом закрыт накладкой.
      for (const s of [-1, 1]) bar(m, 'barrier-wood-beam', at(s), [-axis.x * half * s * .05, crest, -axis.z * half * s * .05], section, section, color)
    } else {
      bar(m, 'barrier-wood-beam', at(-1), at(1), section, section, color)
    }
    const side = new THREE.Vector3(-axis.z, 0, axis.x)
    for (const [t, elevation] of [[-.74, 68], [-.36, 74], [.36, 74], [.74, 68]]) {
      const [cx, cy, cz] = at(t)
      const angle = elevation * PI / 180
      for (const s of [-1, 1]) {
        const base = [cx + side.x * s * .08, cy + section * .3, cz + side.z * s * .08]
        addSpike(m, base, [side.x * s * Math.cos(angle), Math.sin(angle), side.z * s * Math.cos(angle)], .69, spikes, collars)
      }
      nails.push({ position: [cx, cy + section / 2 + .004, cz] })
    }
    // Концевые шипы продолжают брус и чуть задраны вверх.
    for (const s of [-1, 1]) {
      const [ex, ey, ez] = at(s)
      const angle = 20 * PI / 180
      addSpike(m, [ex, ey + .02, ez], [axis.x * s * Math.cos(angle), Math.sin(angle), axis.z * s * Math.cos(angle)], .17, spikes, collars)
      const [bx, by, bz] = at(s * .86)
      bar(m, 'barrier-iron-band-strap', [bx, by, bz], [bx + axis.x * s * .04, by, bz + axis.z * s * .04], section + .014, section + .014, C.iron)
    }
    if (!index) for (const s of [-1, 1]) bar(m, 'barrier-iron-band-strap', at(s * .17), at(s * .21), section + .014, section + .014, C.iron)
  }
  scatter(m, 'barrier-iron-spike', () => new THREE.ConeGeometry(.034, 1, 10, 1), spikes, C.steel)
  scatter(m, 'barrier-iron-band', () => new THREE.CylinderGeometry(.045, .045, .04, 10), collars, C.iron)
  scatter(m, 'barrier-iron-nail', () => new THREE.CylinderGeometry(.018, .018, .012, 8), nails, C.ironLight)
  // Железная накладка и болты на перекрестье, по оси верхнего бруса.
  const upper = beams[1].axis
  const yaw = Math.atan2(-upper.z, upper.x)
  plank(m, 'barrier-iron-plate', [.30, .02, .22], [0, crest + section / 2 + .008, 0], C.iron, [0, yaw, 0])
  for (const [u, v] of [[.09, .06], [.09, -.06], [-.09, .06], [-.09, -.06]]) {
    const x = upper.x * u - upper.z * v, z = upper.z * u + upper.x * v
    m.cylinder('barrier-iron-bolt', .02, .02, .03, [x, crest + section / 2 + .022, z], C.ironLight, 8)
  }
  return finish(m, [1.4, 1.2, .9])
}

// ------------------------------------------------------------------- магия

function buildAlchemyCauldron() {
  const m = new Model('alchemy_cauldron')
  // Один профиль вращения: внешний бок, отогнутая губа и внутренняя стенка — у котла есть толщина.
  lathe(m, 'cauldron-brass-pot', [[0, .10], [.22, .105], [.38, .16], [.50, .30], [.53, .42], [.505, .56], [.45, .66], [.435, .70], [.47, .725], [.48, .75], [.452, .765], [.415, .748], [.405, .70], [.465, .56], [.49, .42], [.46, .30], [.35, .20], [0, .17]], [0, 0, 0], C.brass, 56)
  ring(m, 'cauldron-brass-rim', .455, .028, [0, .748, 0], C.gold, [PI / 2, 0, 0], 8, 56)
  ring(m, 'cauldron-brass-band', .532, .018, [0, .42, 0], C.gold, [PI / 2, 0, 0], 6, 56)
  const rivets = []
  for (let index = 0; index < 18; index += 1) {
    const angle = index / 18 * TAU
    rivets.push({ position: [Math.cos(angle) * .545, .42, Math.sin(angle) * .545], rotation: [0, -angle, -PI / 2] })
  }
  scatter(m, 'cauldron-brass-rivet', () => new THREE.SphereGeometry(.014, 6, 3, 0, TAU, 0, PI / 2), rivets, C.brass)
  // Тёмное варево с медленными пузырями и разводом.
  m.cylinder('cauldron-liquid', .447, .447, .012, [0, .63, 0], C.liquid, 56)
  ring(m, 'cauldron-liquid-swirl', .22, .008, [.05, .637, -.03], '#353c52', [PI / 2, 0, 0], 4, 40, PI * 1.4)
  for (const [x, z, r] of [[.12, .10, .035], [-.16, -.05, .025], [.02, -.20, .02], [-.05, .22, .018]]) {
    m.mesh('cauldron-liquid-bubble', new THREE.SphereGeometry(r, 10, 5, 0, TAU, 0, PI / 2), [x, .636, z], '#3c4458')
  }
  // Ручки-кольца по бокам: полукольца лежат почти горизонтально, сверху читаются буквой D.
  for (const side of [-1, 1]) {
    const handle = []
    for (let step = 0; step <= 12; step += 1) {
      const t = -PI / 2 + step / 12 * PI
      handle.push([side * (.47 + Math.cos(t) * .10), .66 - Math.cos(t) * .04, Math.sin(t) * .13])
    }
    tube(m, 'cauldron-brass-handle', handle, .022, C.gold, 24, 7)
    for (const z of [-.13, .13]) plank(m, 'cauldron-brass-lug', [.06, .07, .04], [side * .465, .66, z], C.brass)
  }
  // Три ножки-лапы.
  for (let index = 0; index < 3; index += 1) {
    const angle = index / 3 * TAU + PI / 6
    const dx = Math.cos(angle), dz = Math.sin(angle)
    taperedTube(m, 'cauldron-brass-leg', [[dx * .30, .17, dz * .30], [dx * .38, .10, dz * .38], [dx * .42, .03, dz * .42]], .045, .032, C.brass, 10, 8)
    ellipsoid(m, 'cauldron-brass-leg-foot', [.10, .05, .10], [dx * .43, .025, dz * .43], C.brass, [0, -angle, 0], [12, 6])
  }
  return finish(m, [1.2, 1.2, .8])
}

function buildArcaneLectern() {
  const m = new Model('arcane_lectern')
  plank(m, 'lectern-wood-base', [.66, .08, .52], [0, .04, 0], C.woodDark)
  plank(m, 'lectern-wood-base-step', [.50, .07, .40], [0, .115, 0], C.wood)
  plank(m, 'lectern-wood-post', [.16, .78, .16], [0, .54, .02], C.wood)
  for (const y of [.18, .92]) plank(m, 'lectern-wood-post-collar', [.24, .06, .24], [0, y, .02], C.woodEdge)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) plank(m, 'lectern-brass-post-strip', [.02, .66, .02], [sx * .081, .55, .02 + sz * .081], C.brass)
  // Наклонная столешница поднимается к задней кромке; книга лежит на ней раскрытой.
  m.group('lectern-desk', [0, 1.04, .02], [-.40, 0, 0], () => {
    plank(m, 'lectern-desk-board', [1.0, .045, .74], [0, 0, 0], C.wood)
    plank(m, 'lectern-desk-frame-ledge', [1.0, .07, .05], [0, .035, -.36], C.woodDark)
    for (const x of [-.485, .485]) plank(m, 'lectern-desk-frame-side', [.04, .035, .74], [x, .03, 0], C.woodDark)
    plank(m, 'lectern-desk-frame-back', [1.0, .035, .04], [0, .03, .355], C.woodDark)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) plank(m, 'lectern-brass-corner', [.09, .012, .09], [sx * .46, .052, sz * .33], C.brass)
    plank(m, 'lectern-book-leather', [.84, .02, .58], [0, .033, 0], C.bookCover)
    // Страницы изогнуты от корешка, как у раскрытой книги.
    m.drape('lectern-book-page', .78, .52, (x) => .055 + .03 * Math.sin(PI * Math.min(1, Math.abs(x) / .39)) - .012 * (1 - Math.min(1, Math.abs(x) / .05)), C.page, { segments: [24, 4], thickness: .03 })
    const ink = []
    for (const side of [-1, 1]) for (let row = 0; row < 7; row += 1) {
      const x = side * .2, z = -.17 + row * .055
      const width = row === 6 ? .14 : .24
      ink.push({ position: [x, .055 + .03 * Math.sin(PI * .51) + .017, z], scale: [width, .002, .008] })
    }
    scatter(m, 'lectern-book-page-ink', () => new THREE.BoxGeometry(1, 1, 1), ink, '#5a4a3a')
    tube(m, 'lectern-ribbon-cloth', [[.03, .088, -.06], [.035, .09, -.24], [.04, .085, -.36], [.045, .03, -.40], [.05, -.08, -.395]], .009, '#8a2f2c', 16, 4)
  })
  return finish(m, [1.0, .7, 1.2])
}

/** Тёмная линия желобка, утопленная почти вровень с поверхностью. */
function grooveRing(m, name, radius, y, color, tube = .012) {
  const groove = ring(m, name, radius, tube, [0, y, 0], color, [PI / 2, 0, 0], 4, Math.max(24, Math.round(radius * 160)))
  groove.scale.set(1, 1, .35)
  return groove
}

function buildRitualCircle() {
  const m = new Model('ritual_circle')
  const top = .04
  lathe(m, 'ritual-stone-slab', [[0, 0], [.70, 0], [.70, top - .012], [.675, top], [0, top]], [0, 0, 0], C.ritual, 72)
  m.cylinder('ritual-stone-center-slab', .19, .195, .012, [0, top + .002, 0], C.ritualLight, 48)
  for (const radius of [.58, .48]) grooveRing(m, 'ritual-groove-ring', radius, top, C.ritualDark)
  grooveRing(m, 'ritual-groove-ring', .195, top + .007, C.ritualDark)
  grooveRing(m, 'ritual-groove-ring', .70, top - .006, C.ritualDark, .008)
  const lines = []
  // Крест из желобков: от центрального круга к краю, с разрывом на малых кругах.
  for (let index = 0; index < 4; index += 1) {
    const angle = index * PI / 2
    for (const [from, to] of [[.2, .46], [.60, .695]]) {
      const mid = (from + to) / 2
      lines.push({ position: [Math.cos(angle) * mid, top, Math.sin(angle) * mid], rotation: [0, -angle, 0], scale: [to - from, .008, .022] })
    }
    // Малые круги на сторонах света.
    const x = Math.cos(angle) * .53, z = Math.sin(angle) * .53
    const node = ring(m, 'ritual-groove-node', .068, .011, [x, top, z], C.ritualDark, [PI / 2, 0, 0], 4, 32)
    node.scale.set(1, 1, .35)
    m.cylinder('ritual-stone-node-slab', .056, .058, .008, [x, top + .002, z], C.ritualLight, 32)
  }
  // Стыки плит: короткие радиальные швы во внешнем поясе и диагонали внутри.
  for (let index = 0; index < 12; index += 1) {
    const angle = index / 12 * TAU + PI / 12
    lines.push({ position: [Math.cos(angle) * .64, top, Math.sin(angle) * .64], rotation: [0, -angle, 0], scale: [.11, .006, .01] })
  }
  for (let index = 0; index < 4; index += 1) {
    const angle = index * PI / 2 + PI / 4
    lines.push({ position: [Math.cos(angle) * .34, top, Math.sin(angle) * .34], rotation: [0, -angle, 0], scale: [.27, .006, .01] })
  }
  scatter(m, 'ritual-groove-line', () => new THREE.BoxGeometry(1, 1, 1), lines, C.ritualDark)
  // Руны в поясе между кольцами: по три знака в каждой четверти.
  const next = random(511)
  const strokes = []
  for (let quarter = 0; quarter < 4; quarter += 1) for (let rune = 0; rune < 3; rune += 1) {
    const angle = quarter * PI / 2 + PI / 4 + (rune - 1) * .32
    const cx = Math.cos(angle) * .53, cz = Math.sin(angle) * .53
    const parts = 2 + Math.floor(next() * 2)
    for (let stroke = 0; stroke < parts; stroke += 1) {
      const turn = -angle + (stroke === 0 ? 0 : (next() - .5) * 2.2)
      const offset = (stroke - (parts - 1) / 2) * .018
      strokes.push({ position: [cx + Math.cos(angle) * offset, top + .001, cz + Math.sin(angle) * offset], rotation: [0, turn + PI / 2, 0], scale: [.05 + next() * .02, .006, .008] })
    }
  }
  scatter(m, 'ritual-rune-carving', () => new THREE.BoxGeometry(1, 1, 1), strokes, C.ritualDark)
  return finish(m, [1.4, 1.4, .05])
}

function buildArcaneStone() {
  const m = new Model('arcane_stone')
  // Шестигранный помост с вершинами по ±X, скошенными боками и гладкой верхней плитой.
  m.mesh('arcane-stone-dais', faceted(new THREE.CylinderGeometry(.56, .70, .20, 6, 1)), [0, .10, 0], '#7d8580', [0, PI / 6, 0])
  m.mesh('arcane-stone-top-slab', faceted(new THREE.CylinderGeometry(.545, .56, .03, 6, 1)), [0, .215, 0], '#959c97', [0, PI / 6, 0])
  const hex = []
  for (let index = 0; index < 6; index += 1) {
    const angle = index / 6 * TAU
    hex.push([Math.cos(angle) * .48, .231, Math.sin(angle) * .48])
  }
  m.mesh('arcane-stone-groove-hex', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hex.map((point) => new THREE.Vector3(...point)), true, 'catmullrom', 0), 60, .011, 4, true), [0, 0, 0], C.ritualDark)
  for (const radius of [.36, .27, .18]) grooveRing(m, 'arcane-stone-groove-ring', radius, .231, C.ritualDark, .014)
  m.cylinder('arcane-stone-center-slab', .12, .125, .012, [0, .234, 0], '#a7ada8', 40)
  // Кромка верхней плиты чуть светлее — фаска ловит свет.
  return finish(m, [1.4, 1.3, .25])
}

function addFlask(m, kind, position, color, scale = 1) {
  const s = scale
  const profiles = {
    round: [[0, 0], [.06, .005], [.095, .04], [.105, .09], [.09, .14], [.05, .17], [.03, .19], [.03, .24], [.036, .25], [0, .25]],
    tall: [[0, 0], [.055, 0], [.06, .02], [.06, .20], [.045, .24], [.025, .26], [.025, .30], [0, .30]],
    vial: [[0, 0], [.035, 0], [.04, .03], [.04, .12], [.02, .14], [.02, .16], [0, .16]],
    squat: [[0, 0], [.08, 0], [.09, .03], [.09, .09], [.05, .13], [.025, .15], [.025, .18], [0, .18]],
  }
  const profile = profiles[kind].map(([radius, y]) => [radius * s, y * s])
  lathe(m, `potion-glass-${kind}`, profile, position, color, 18)
  const top = profile.at(-1)[1]
  m.cylinder('potion-stopper-wood', .028 * s, .024 * s, .045 * s, [position[0], position[1] + top + .015 * s, position[2]], C.woodLight, 12)
  const widest = Math.max(...profile.map(([radius]) => radius))
  ellipsoid(m, 'potion-glass-glint', [.018 * s, .045 * s, .01], [position[0] - widest * .45, position[1] + top * .42, position[2] - widest * .8], '#f2f4ee', [0, 0, .2], [8, 6])
}

function buildPotionCabinet() {
  const m = new Model('potion_cabinet')
  // Открытый спереди (−Z) шкафчик: две полки склянок и два ящика внизу. В именах нет «cabinet»: в нём прячется «net».
  for (const x of [-.625, .625]) plank(m, 'apothecary-side-board', [.05, 1.60, .50], [x, .80, 0], C.wood)
  plank(m, 'apothecary-back-board', [1.20, 1.50, .03], [0, .79, .235], C.woodDark)
  plank(m, 'apothecary-plinth-board', [1.30, .07, .50], [0, .035, 0], C.woodDark)
  for (const [y, height] of [[.52, .04], [1.04, .04], [1.50, .05]]) {
    plank(m, 'apothecary-shelf-board', [1.22, height, .48], [0, y, 0], C.woodLight)
    plank(m, 'apothecary-shelf-lip-wood', [1.22, .035, .025], [0, y + .03, -.235], C.woodEdge)
  }
  plank(m, 'apothecary-crest-board', [1.30, .09, .04], [0, 1.555, .22], C.woodEdge)
  for (const x of [-.625, .625]) plank(m, 'apothecary-post-cap-wood', [.08, .03, .08], [x, 1.615, -.21], C.woodEdge)
  // Ящики: две филёнки, разделитель и латунные кнопки.
  for (const x of [-.30, .30]) {
    plank(m, 'apothecary-drawer-front-wood', [.56, .40, .03], [x, .29, -.24], C.wood)
    plank(m, 'apothecary-drawer-panel-wood', [.46, .30, .012], [x, .29, -.258], C.woodEdge)
    ellipsoid(m, 'apothecary-brass-knob', [.045, .045, .04], [x, .30, -.272], C.brass, [0, 0, 0], [12, 8])
  }
  plank(m, 'apothecary-stile-wood', [.04, .44, .04], [0, .29, -.245], C.woodDark)
  for (const x of [-.58, .58]) for (const z of [-.2, .2]) plank(m, 'apothecary-foot-wood', [.08, .03, .08], [x, .005, z], C.woodDark)
  // Склянки: как в штампе — зелёная, тёмная, синяя высокая, красная, бирюзовая; ниже — синяя, янтарная, малая, тёмная, жёлтая.
  const row1 = [['round', -.46, '#3f9a4a', 1], ['round', -.24, '#4a3f6e', .78], ['tall', -.02, '#2f62c8', 1.15], ['round', .21, '#c03a3a', 1.02], ['squat', .45, '#3f9a8f', .9]]
  const row2 = [['round', -.46, '#3a8bb0', .85], ['round', -.22, '#d8a030', .95], ['vial', -.03, '#2f62c8', 1.1], ['squat', .19, '#40424e', .95], ['round', .44, '#d8b030', 1]]
  for (const [y, row] of [[.54, row2], [1.06, row1]]) {
    for (const [index, [kind, x, color, scale]] of row.entries()) addFlask(m, kind, [x, y, (index % 2 ? .04 : -.06)], color, scale)
  }
  return finish(m, [1.3, .5, 1.6])
}

function buildMagicMirror() {
  const m = new Model('magic_mirror')
  const a = .27, b = .54, center = [0, 1.07, -.02]
  // Зеркало в овальной золочёной раме на напольной подставке, стекло смотрит вперёд (−Z).
  m.group('mirror-swing', center, [-.06, 0, 0], () => {
    const ellipse = (rx, ry, z, steps = 48) => Array.from({ length: steps }, (_, index) => {
      const angle = index / steps * TAU
      return [Math.cos(angle) * rx, Math.sin(angle) * ry, z]
    })
    const shape = (rx, ry) => {
      const outline = new THREE.Shape()
      outline.absellipse(0, 0, rx, ry, 0, TAU, false, 0)
      return outline
    }
    const back = new THREE.ExtrudeGeometry(shape(a + .05, b + .05), { depth: .04, bevelEnabled: false, curveSegments: 48 })
    m.mesh('mirror-wood-back', back, [0, 0, -.005], C.woodDark)
    const glass = new THREE.ExtrudeGeometry(shape(a, b), { depth: .01, bevelEnabled: false, curveSegments: 48 })
    m.mesh('mirror-glass', glass, [0, 0, -.018], C.mirror)
    ellipsoid(m, 'mirror-glass-sheen', [a * .5, b * .9, .004], [-a * .35, b * .1, -.02], '#3b5582', [0, 0, .2], [16, 10])
    tube(m, 'mirror-gold-frame', ellipse(a + .03, b + .03, -.02, 40), .034, C.gold, 96, 8, true)
    tube(m, 'mirror-gold-frame-inner', ellipse(a + .002, b + .002, -.024, 40), .013, C.brass, 96, 6, true)
    const beads = ellipse(a + .075, b + .075, -.01, 44).map((position) => ({ position, scale: [.014, .014, .014] }))
    scatter(m, 'mirror-gold-bead', () => new THREE.SphereGeometry(1, 6, 4), beads, C.gold)
    for (const [x, y, s] of [[0, b + .09, .10], [0, -b - .09, .09]]) ellipsoid(m, 'mirror-gold-knob', [s, s, s * .8], [x, y, -.01], C.gold, [0, 0, 0], [16, 10])
    m.cylinder('mirror-gold-finial', .012, .025, .06, [0, b + .16, -.01], C.gold, 12)
    for (const side of [-1, 1]) m.cylinder('mirror-brass-pivot', .022, .022, .08, [side * (a + .065), 0, -.01], C.brass, 12, [0, 0, PI / 2])
  })
  // Подставка: две стойки на ножках, перекладина снизу, шарнирные шишки снаружи.
  for (const side of [-1, 1]) {
    const x = side * (a + .10)
    bar(m, 'mirror-stand-post-wood', [x, .04, -.01], [x, 1.11, -.02], .05, .05, C.wood)
    bar(m, 'mirror-stand-foot-wood', [x, .03, -.20], [x, .03, .20], .06, .06, C.woodDark)
    for (const z of [-.19, .19]) ellipsoid(m, 'mirror-gold-foot-cap', [.07, .04, .06], [x, .03, z], C.gold, [0, 0, 0], [12, 6])
    ellipsoid(m, 'mirror-gold-knob', [.06, .06, .06], [side * (a + .135), center[1], center[2]], C.gold, [0, 0, 0], [16, 10])
    ellipsoid(m, 'mirror-gold-post-finial', [.05, .06, .05], [x, 1.13, -.02], C.gold, [0, 0, 0], [12, 8])
  }
  bar(m, 'mirror-stand-beam', [-(a + .10), .22, .0], [a + .10, .22, .0], .04, .05, C.wood)
  return finish(m, [.8, .4, 1.7])
}

// ----------------------------------------------------------------- темница

/** Шестигранный пруток от точки до точки — дешевле цилиндра m.cylinder на 24 грани. */
function rodPlacement(from, to) {
  const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to)
  const delta = end.clone().sub(start)
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize())
  return { position: start.add(end).multiplyScalar(.5).toArray(), rotation: new THREE.Euler().setFromQuaternion(quaternion).toArray().slice(0, 3), scale: [1, delta.length(), 1] }
}

function buildPrisonCage() {
  const m = new Model('prison_cage')
  const h = 1.6, s = .62
  // Рама: угловые стойки, нижний и верхний пояса; дверь спереди (−Z).
  for (const x of [-s, s]) for (const z of [-s, s]) {
    bar(m, 'cage-iron-corner-post', [x, 0, z], [x, h, z], .075, .075, C.iron)
    plank(m, 'cage-iron-corner-plate', [.13, .02, .13], [x, h + .005, z], C.ironLight)
  }
  for (const y of [.05, h - .04]) {
    for (const z of [-s, s]) bar(m, 'cage-iron-frame', [-s, y, z], [s, y, z], .07, .06, C.iron)
    for (const x of [-s, s]) bar(m, 'cage-iron-frame', [x, y, -s], [x, y, s], .07, .06, C.iron)
  }
  const bars = [], bands = [], rivets = []
  const spacing = .124
  for (let index = 1; index < 10; index += 1) {
    const u = -s + index * spacing
    bars.push(rodPlacement([u, .08, s], [u, h - .07, s]))
    bars.push(rodPlacement([-s, .08, u], [-s, h - .07, u]))
    bars.push(rodPlacement([s, .08, u], [s, h - .07, u]))
    if (Math.abs(u) > .33) bars.push(rodPlacement([u, .08, -s], [u, h - .07, -s]))
  }
  for (const y of [.52, 1.06]) {
    for (const z of [-s, s]) bands.push({ position: [0, y, z], scale: [s * 2, .05, .018] })
    for (const x of [-s, s]) bands.push({ position: [x, y, 0], scale: [.018, .05, s * 2] })
    for (let index = 1; index < 10; index += 1) {
      const u = -s + index * spacing
      rivets.push({ position: [u, y, s + .012] }, { position: [-s - .012, y, u] }, { position: [s + .012, y, u] })
    }
  }
  // Верх: редкие поперечины, чтобы сверху была видна солома.
  for (const z of [-.31, 0, .31]) bars.push(rodPlacement([-s, h - .04, z], [s, h - .04, z]))
  bars.push(rodPlacement([0, h - .035, -s], [0, h - .035, s]))
  // Дверь: своя рама, прутья, петли слева и замок справа.
  for (const [from, to] of [[[-.32, .10, -s], [.32, .10, -s]], [[-.32, 1.40, -s], [.32, 1.40, -s]], [[-.32, .10, -s], [-.32, 1.40, -s]], [[.32, .10, -s], [.32, 1.40, -s]]]) {
    bar(m, 'cage-iron-door-frame', from, to, .05, .05, C.iron)
  }
  for (const x of [-.19, -.065, .065, .19]) bars.push(rodPlacement([x, .12, -s], [x, 1.38, -s]))
  bands.push({ position: [0, .75, -s - .012], scale: [.64, .05, .018] })
  scatter(m, 'cage-iron-bar', () => new THREE.CylinderGeometry(.017, .017, 1, 6), bars, C.iron)
  scatter(m, 'cage-iron-band', () => new THREE.BoxGeometry(1, 1, 1), bands, C.ironLight)
  scatter(m, 'cage-iron-rivet', () => new THREE.SphereGeometry(.014, 6, 3), rivets, C.ironLight)
  for (const y of [.32, 1.18]) {
    m.cylinder('cage-iron-hinge', .03, .03, .12, [-.35, y, -s - .02], C.ironLight, 10)
    plank(m, 'cage-iron-hinge-strap', [.14, .04, .012], [-.27, y, -s - .03], C.iron)
  }
  plank(m, 'cage-iron-lock', [.10, .14, .05], [.34, .75, -s - .045], C.ironRust)
  m.mesh('cage-lock-hole', new THREE.CylinderGeometry(.012, .012, .01, 10), [.34, .76, -s - .072], C.shadow, [PI / 2, 0, 0])
  bar(m, 'cage-iron-latch', [.22, .75, -s - .04], [.42, .75, -s - .04], .03, .02, C.ironLight)
  // Пол: доски, на них подстилка из соломы и рассыпанные стебли.
  for (let index = 0; index < 5; index += 1) plank(m, 'cage-floor-plank', [1.22, .03, .235], [0, .035, -.49 + index * .245], index % 2 ? C.wood : C.woodDark)
  mound(m, 'cage-straw-bedding', [1.0, .10, .86], [.04, .045, .06], C.straw, 531, { amount: .02, frequency: 9 })
  const next = random(532)
  const strands = []
  for (let index = 0; index < 50; index += 1) {
    const angle = next() * TAU, reach = Math.sqrt(next()) * .52
    strands.push({ position: [Math.cos(angle) * reach, .06 + next() * .04, Math.sin(angle) * reach], rotation: [PI / 2 + (next() - .5) * .3, 0, next() * PI], scale: [1, .14 + next() * .1, 1] })
  }
  scatter(m, 'cage-straw-strand', () => new THREE.CylinderGeometry(.005, .005, 1, 4), strands, C.strawDark)
  return finish(m, [1.3, 1.3, 1.6])
}

function buildDungeonRack() {
  const m = new Model('dungeon_rack')
  // Станина вдоль X, валы с канатом на торцах, рычаги торчат наружу по ±X, как в штампе.
  for (const x of [-1.3, 1.3]) for (const z of [-.5, .5]) plank(m, 'rack-wood-post', [.12, 1.0, .12], [x, .5, z], C.woodDark)
  for (const z of [-.5, .5]) {
    plank(m, 'rack-wood-side-beam', [2.72, .16, .12], [0, .56, z], C.wood)
    plank(m, 'rack-wood-stretcher', [2.6, .08, .08], [0, .15, z], C.woodDark)
  }
  for (const x of [-1.3, 1.3]) plank(m, 'rack-wood-end-stretcher', [.08, .08, 1.0], [x, .15, 0], C.woodDark)
  for (let index = 0; index < 5; index += 1) plank(m, 'rack-wood-bed-plank', [2.14, .05, .17], [0, .62, -.36 + index * .18], index % 2 ? C.woodLight : C.wood)
  for (const x of [-.9, 0, .9]) plank(m, 'rack-wood-bed-support', [.08, .06, .9], [x, .575, 0], C.woodDark)
  const nails = []
  for (let index = 0; index < 5; index += 1) for (const x of [-.9, 0, .9]) nails.push({ position: [x, .648, -.36 + index * .18] })
  scatter(m, 'rack-iron-nail', () => new THREE.CylinderGeometry(.014, .014, .01, 8), nails, C.ironLight)
  for (const side of [-1, 1]) {
    const x = side * 1.19
    m.cylinder('rack-wood-roller', .09, .09, .92, [x, .80, 0], C.woodLight, 24, [PI / 2, 0, 0])
    m.cylinder('rack-iron-axle', .03, .03, 1.12, [x, .80, 0], C.iron, 12, [PI / 2, 0, 0])
    for (const z of [-.44, .44]) ring(m, 'rack-iron-band', .092, .012, [x, .80, z], C.iron, [0, 0, 0], 5, 24)
    for (const z of [-.36, .36]) {
      for (const dz of [-.04, 0, .04]) ring(m, 'rack-rope-coil', .098, .016, [x, .80, z + dz], C.rope, [0, 0, 0], 5, 24)
      tube(m, 'rack-rope', [[x - side * .06, .87, z * .9], [side * .95, .74, z * .75], [side * .66, .66, z * .62]], .014, C.rope, 16, 5)
    }
    // Рычаг-ворот: стальной стержень из середины вала и деревянная рукоять.
    bar(m, 'rack-iron-crank', [x, .80, 0], [side * 1.46, .80, 0], .04, .04, C.iron)
    m.cylinder('rack-wood-crank-handle', .03, .03, .18, [side * 1.46, .88, 0], C.woodDark, 12)
    m.cylinder('rack-iron-ratchet', .13, .13, .03, [x, .80, .1], C.iron, 12, [PI / 2, 0, 0])
  }
  // Кандалы на ложе: кольца на скобах.
  for (const x of [-.62, .62]) for (const z of [-.22, .22]) {
    ring(m, 'rack-iron-manacle', .055, .014, [x, .655, z], C.iron, [PI / 2, 0, 0], 6, 20)
    ring(m, 'rack-iron-staple', .025, .009, [x + Math.sign(x) * .06, .66, z], C.ironLight, [0, PI / 2, 0], 5, 12)
  }
  for (const x of [-1.3, 1.3]) for (const z of [-.5, .5]) plank(m, 'rack-iron-post-cap', [.14, .02, .14], [x, 1.005, z], C.iron)
  return finish(m, [2.8, 1.2, 1.0])
}

function buildIronMaiden() {
  const m = new Model('iron_maiden')
  const depth = .84
  const profile = [[0, 0], [.31, 0], [.33, .03], [.33, .20], [.322, .90], [.315, 1.20], [.30, 1.35], [.27, 1.45], [.225, 1.52], [.205, 1.58], [.21, 1.68], [.195, 1.78], [.155, 1.85], [.085, 1.89], [0, 1.90]]
  const radiusAt = (y) => {
    for (let index = 1; index < profile.length; index += 1) {
      const [r0, y0] = profile[index - 1], [r1, y1] = profile[index]
      if (y >= y0 && y <= y1) return r0 + (r1 - r0) * (y - y0) / Math.max(1e-6, y1 - y0)
    }
    return 0
  }
  // Сечение — эллипс: «дева» шире, чем глубже.
  lathe(m, 'maiden-iron-body', profile, [0, 0, 0], C.steel, 40).scale.set(1, 1, depth)
  lathe(m, 'maiden-iron-plinth', [[0, 0], [.36, 0], [.37, .03], [.35, .06], [0, .06]], [0, 0, 0], C.iron, 40).scale.set(1, 1, depth)
  const seam = []
  for (let y = .07; y <= 1.84; y += .06) seam.push([0, y, -radiusAt(y) * depth - .003])
  tube(m, 'maiden-iron-seam', seam, .007, C.shadow, 60, 4)
  const rivets = []
  for (const y of [.26, .78, 1.28]) {
    const r = radiusAt(y) + .006
    ring(m, 'maiden-iron-band', r, .014, [0, y, 0], C.iron, [PI / 2, 0, 0], 5, 40).scale.set(1, depth, 1)
    for (let index = 0; index < 18; index += 1) {
      const angle = index / 18 * TAU
      rivets.push({ position: [Math.cos(angle) * (r + .01), y, Math.sin(angle) * (r + .01) * depth] })
    }
  }
  for (let y = .12; y < 1.75; y += .11) for (const x of [-.045, .045]) {
    const r = radiusAt(y)
    rivets.push({ position: [x, y, -Math.sqrt(Math.max(0, r * r - x * x)) * depth - .004] })
  }
  scatter(m, 'maiden-iron-rivet', () => new THREE.SphereGeometry(.012, 6, 4), rivets, C.ironLight)
  for (const y of [.50, 1.12]) m.cylinder('maiden-iron-hinge', .025, .025, .16, [-radiusAt(y) - .01, y, -.08], C.ironLight, 10)
  plank(m, 'maiden-iron-lock', [.07, .12, .03], [.07, .98, -radiusAt(.98) * depth - .012], C.ironRust)
  bar(m, 'maiden-iron-hasp', [-.03, .98, -radiusAt(.98) * depth - .02], [.06, .98, -radiusAt(.98) * depth - .02], .025, .02, C.iron)
  // Лицо-маска на голове: лоб, надбровья, нос, прорези глаз и рта.
  const face = -radiusAt(1.66) * depth
  ellipsoid(m, 'maiden-iron-face', [.20, .22, .07], [0, 1.66, face + .012], C.steel, [0, 0, 0], [18, 12])
  bar(m, 'maiden-iron-face-brow', [-.07, 1.715, face - .02], [.07, 1.715, face - .02], .03, .018, C.iron)
  bar(m, 'maiden-iron-face-nose', [0, 1.70, face - .02], [0, 1.635, face - .03], .022, .02, C.iron)
  for (const x of [-.04, .04]) ellipsoid(m, 'maiden-face-hole-eye', [.035, .014, .01], [x, 1.69, face - .022], C.shadow, [0, 0, 0], [10, 6])
  ellipsoid(m, 'maiden-face-hole-mouth', [.05, .01, .01], [0, 1.605, face - .018], C.shadow, [0, 0, 0], [10, 6])
  for (const [x, y, w, h, side] of [[.18, .55, .05, .18, 1], [-.12, 1.1, .04, .14, -1], [.05, .35, .04, .12, 1]]) {
    const z = -Math.sqrt(Math.max(0, radiusAt(y) ** 2 - x * x)) * depth
    ellipsoid(m, 'maiden-iron-rust', [w, h, .01], [x, y, z - .002], C.ironRust, [0, side * .3, 0], [10, 6])
  }
  return finish(m, [.7, .6, 1.9])
}

/** Цепь из звеньев вдоль кривой: соседние звенья повёрнуты на 90° вокруг оси цепи. */
function chainPlacements(points, step = .052) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, 'centripetal')
  const count = Math.max(2, Math.floor(curve.getLength() / step))
  const placements = []
  for (let index = 0; index <= count; index += 1) {
    const t = index / count
    const tangent = curve.getTangentAt(t)
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), tangent)
    if (index % 2) quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(tangent, PI / 2))
    placements.push({ position: curve.getPointAt(t).toArray(), rotation: new THREE.Euler().setFromQuaternion(quaternion).toArray().slice(0, 3), scale: [1.45, 1, 1] })
  }
  return placements
}

function buildManaclePost() {
  const m = new Model('manacle_post')
  plank(m, 'manacle-stone-slab', [.56, .12, .56], [0, .06, -.04], C.stoneLight)
  plank(m, 'manacle-stone-slab-step', [.44, .05, .44], [0, .145, -.04], C.stone)
  const pillar = new THREE.CylinderGeometry(.165, .175, 1.0, 20, 8, false)
  m.lumpy('manacle-stone-pillar', pillar, [0, .66, -.04], C.stoneLight, { amount: .012, frequency: 7, seed: 541 })
  m.lumpy('manacle-stone-pillar-top', new THREE.SphereGeometry(.17, 20, 6, 0, TAU, 0, PI / 2), [0, 1.155, -.04], C.stoneLight, { size: [1, .35, 1], amount: .008, frequency: 9, seed: 542 })
  tube(m, 'manacle-stone-crack', [[-.06, 1.0, -.21], [-.02, .86, -.215], [-.07, .70, -.215], [-.03, .52, -.214]], .006, C.stoneDark, 16, 4)
  tube(m, 'manacle-stone-crack', [[.09, 1.19, -.10], [.02, 1.19, -.02], [.05, 1.18, .06]], .006, C.stoneDark, 8, 4)
  ring(m, 'manacle-iron-band', .18, .02, [0, 1.0, -.04], C.iron, [PI / 2, 0, 0], 5, 32)
  const links = []
  for (const side of [-1, 1]) {
    ring(m, 'manacle-iron-ring', .045, .012, [side * .225, .98, -.04], C.iron, [0, 0, 0], 5, 16)
    // Цепь провисает до пола и ложится к кандалам спереди (+Z).
    links.push(...chainPlacements([[side * .225, .93, -.04], [side * .30, .60, .0], [side * .35, .25, .08], [side * .36, .03, .18], [side * .34, .025, .30]]))
    const cuff = ring(m, 'manacle-iron-cuff', .085, .022, [side * .33, .024, .40], C.ironRust, [PI / 2, 0, side * .4], 6, 26, TAU * .86)
    cuff.scale.set(1, 1, .7)
    m.cylinder('manacle-iron-hinge', .026, .026, .05, [side * .33, .028, .315], C.iron, 10)
    plank(m, 'manacle-iron-lock', [.05, .035, .035], [side * (.33 + .07), .022, .455], C.iron)
  }
  scatter(m, 'manacle-chain', () => new THREE.TorusGeometry(.026, .008, 5, 10), links, C.iron)
  return finish(m, [.9, .9, 1.2])
}

const BUILDERS = Object.freeze({
  snowdrift: buildSnowdrift,
  snowy_boulder: buildSnowyBoulder,
  ice_pillars: buildIcePillars,
  frozen_pool: buildFrozenPool,
  winter_cache: buildWinterCache,
  snow_cairn: buildSnowCairn,
  sand_dune: buildSandDune,
  desert_boulders: buildDesertBoulders,
  cactus_cluster: buildCactusCluster,
  dead_scrub: buildDeadScrub,
  oasis_pool: buildOasisPool,
  broken_obelisk: buildBrokenObelisk,
  bog_pool: buildBogPool,
  lily_pad_cluster: buildLilyPadCluster,
  reed_cluster: buildReedCluster,
  mud_patch: buildMudPatch,
  rotten_log: buildRottenLog,
  swamp_totem: buildSwampTotem,
  peat_mound: buildPeatMound,
  mooring_bollard: buildMooringBollard,
  cargo_net: buildCargoNet,
  lobster_cage: buildLobsterCage,
  sail_bundle: buildSailBundle,
  bedroll_cluster: buildBedrollCluster,
  shield_rack: buildShieldRack,
  camp_dummy: buildCampDummy,
  spiked_beam_barrier: buildSpikedBeamBarrier,
  alchemy_cauldron: buildAlchemyCauldron,
  arcane_lectern: buildArcaneLectern,
  ritual_circle: buildRitualCircle,
  arcane_stone: buildArcaneStone,
  potion_cabinet: buildPotionCabinet,
  magic_mirror: buildMagicMirror,
  prison_cage: buildPrisonCage,
  dungeon_rack: buildDungeonRack,
  iron_maiden: buildIronMaiden,
  manacle_post: buildManaclePost,
})

export const MODEL_IDS = Object.freeze(Object.keys(BUILDERS))

/** @param {string} id @returns {THREE.Group} */
export function createModel(id) {
  const build = Object.hasOwn(BUILDERS, id) ? BUILDERS[id] : null
  if (!build) throw new Error(`Unknown frontier model: ${id}`)
  return build()
}
