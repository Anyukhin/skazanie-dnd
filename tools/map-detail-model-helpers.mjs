/** Общие примитивы авторского набора детализации; координаты — метры. */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export { THREE }

/** Материал определяется деталью, чтобы железная петля не получила фактуру дерева. */
function materialKind(name, color) {
  if (/iron|metal|brass|bronze|copper|steel|chain|hinge|bolt|screw|nail|washer|blade|wire|winch|желез|металл|латун|бронз|цеп|болт|гвозд|лезви|провол/i.test(name)) return 'metal'
  if (/water|glass|liquid|orb|crystal|ember|flame|вода|плам|стекл|жидк/i.test(name)) return 'flat'
  if (/cloth|fabric|canvas|blanket|pillow|cushion|curtain|tent|sail|leather|rope|cord|twine|thread|ткан|одеял|подуш|полот|штор|кожа|канат|верёв|бечев/i.test(name)) return 'cloth'
  if (/stone|brick|rock|coal|mortar|slab-stone|кам|кирп|скал|уголь|плит/i.test(name)) return 'stone'
  const hsl = new THREE.Color(color).getHSL({ h: 0, s: 0, l: 0 })
  return hsl.s < .15 ? 'stone' : hsl.h < .16 || hsl.h > .94 ? 'wood' : 'flat'
}

/** Детерминированный шум по координате: одинаковая точка шва смещается одинаково. */
function lattice(x, y, z, seed) {
  let value = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647) ^ Math.imul(seed | 0, 1274126177)
  value = Math.imul(value ^ (value >>> 13), 1103515245)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295 * 2 - 1
}

function valueNoise(x, y, z, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
  const fx = x - x0, fy = y - y0, fz = z - z0
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz)
  let total = 0
  for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) {
    total += lattice(x0 + dx, y0 + dy, z0 + dz, seed) * (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz)
  }
  return total
}

/** Повторяемая последовательность чисел [0, 1) для разброса соломы, камней и щепы. */
export function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

export class Model {
  constructor(id) {
    this.root = new THREE.Group()
    this.root.name = id
    this.materials = new Map()
  }

  material(color, kind = 'wood') {
    const key = `${color}:${kind}`
    if (!this.materials.has(key)) this.materials.set(key, new THREE.MeshStandardMaterial({
      color, roughness: .8, metalness: kind === 'metal' ? .65 : 0,
    }))
    this.materials.get(key).name = kind
    return this.materials.get(key)
  }

  mesh(name, geometry, position, color, rotation = [0, 0, 0]) {
    const mesh = new THREE.Mesh(geometry, this.material(color, materialKind(name, color)))
    mesh.name = name
    mesh.position.set(...position)
    mesh.rotation.set(...rotation)
    this.root.add(mesh)
    return mesh
  }

  box(name, size, position, color, rotation = [0, 0, 0]) {
    const radius = Math.min(.035, ...size.map(value => value / 7))
    return this.mesh(name, new RoundedBoxGeometry(...size, 2, radius), position, color, rotation)
  }

  slab(name, w, d, h, position, color) {
    const radius = Math.min(.035, w / 8, d / 8, h / 4)
    return this.mesh(name, new RoundedBoxGeometry(w, h, d, 2, radius), position, color)
  }

  cylinder(name, top, bottom, height, position, color, segments = 32, rotation = [0, 0, 0]) {
    if (segments >= 8 && segments < 24) segments = 24
    return this.mesh(name, new THREE.CylinderGeometry(top, bottom, height, segments), position, color, rotation)
  }

  sphere(name, size, position, color) {
    const small = Math.max(...size) < .06
    const mesh = this.mesh(name, new THREE.SphereGeometry(.5, small ? 16 : 28, small ? 10 : 18), position, color)
    mesh.scale.set(...size)
    return mesh
  }

  torus(name, radius, tube, position, color, rotation = [0, 0, 0]) {
    const geometry = tube < .02 ? new THREE.TorusGeometry(radius, tube, 10, 32) : new THREE.TorusGeometry(radius, tube, 12, 36)
    return this.mesh(name, geometry, position, color, rotation)
  }

  /**
   * Органическая форма: вершины сдвигаются от центра детерминированным шумом.
   * Швы сферы сливаются заранее, поэтому поверхность не трескается.
   */
  lumpy(name, geometry, position, color, { size = [1, 1, 1], amount = .06, frequency = 3, seed = 1, rotation = [0, 0, 0] } = {}) {
    geometry.deleteAttribute('uv')
    geometry.deleteAttribute('normal')
    const merged = mergeVertices(geometry, 1e-5)
    geometry.dispose()
    merged.scale(...size)
    const pos = merged.attributes.position
    const point = new THREE.Vector3(), direction = new THREE.Vector3()
    for (let index = 0; index < pos.count; index++) {
      point.fromBufferAttribute(pos, index)
      direction.set(point.x / size[0], point.y / size[1], point.z / size[2]).normalize()
      const noise = valueNoise(point.x * frequency, point.y * frequency, point.z * frequency, seed)
        + .45 * valueNoise(point.x * frequency * 2.3, point.y * frequency * 2.3, point.z * frequency * 2.3, seed + 7)
      point.addScaledVector(direction, noise * amount)
      pos.setXYZ(index, point.x, point.y, point.z)
    }
    merged.computeVertexNormals()
    return this.mesh(name, merged, position, color, rotation)
  }

  /** Трубка по сглаженной кривой с плавным сужением; начало закрыто полусферой. */
  taperTube(name, points, startRadius, endRadius, color, segments = 18, radial = 10) {
    const curve = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point)), false, 'centripetal')
    const geometry = new THREE.TubeGeometry(curve, segments, 1, radial, false)
    const pos = geometry.attributes.position
    const center = new THREE.Vector3(), point = new THREE.Vector3()
    for (let ring = 0; ring <= segments; ring++) {
      curve.getPointAt(ring / segments, center)
      const t = ring / segments
      const radius = startRadius + (endRadius - startRadius) * t
      for (let step = 0; step <= radial; step++) {
        const index = ring * (radial + 1) + step
        point.fromBufferAttribute(pos, index).sub(center).multiplyScalar(radius).add(center)
        pos.setXYZ(index, point.x, point.y, point.z)
      }
    }
    geometry.computeVertexNormals()
    const tube = this.mesh(name, geometry, [0, 0, 0], color)
    this.sphere(`${name}-cap`, [startRadius * 2, startRadius * 2, startRadius * 2], points[0], color)
    if (endRadius > .015) this.sphere(`${name}-tip`, [endRadius * 2, endRadius * 2, endRadius * 2], points.at(-1), color)
    return tube
  }

  /** Детали, созданные внутри build, переносятся в общую группу с собственным поворотом. */
  group(name, position, rotation, build) {
    const group = new THREE.Group()
    group.name = name
    group.position.set(...position)
    group.rotation.set(...rotation)
    const before = new Set(this.root.children)
    build()
    for (const child of [...this.root.children]) if (!before.has(child)) group.add(child)
    this.root.add(group)
    return group
  }

  /**
   * Ткань как сетка в плоскости XZ: height(x, z) задаёт высоту каждой вершины,
   * ragged — глубину рваного края. Толщина даёт видимую кромку сбоку.
   */
  drape(name, width, depth, height, color, { segments = [14, 14], ragged = 0, seed = 3, thickness = .02 } = {}) {
    const [sx, sz] = segments
    const geometry = new THREE.BoxGeometry(width, thickness, depth, sx, 1, sz)
    const pos = geometry.attributes.position
    for (let index = 0; index < pos.count; index++) {
      let x = pos.getX(index), z = pos.getZ(index)
      if (ragged) {
        const edge = Math.max(Math.abs(x) / (width / 2), Math.abs(z) / (depth / 2))
        if (edge > .999) {
          const bite = (valueNoise(x * 9, 0, z * 9, seed) * .5 + .5) * ragged
          x -= Math.sign(x) * (Math.abs(x) / (width / 2) > .999 ? bite : 0)
          z -= Math.sign(z) * (Math.abs(z) / (depth / 2) > .999 ? bite : 0)
        }
      }
      pos.setXYZ(index, x, pos.getY(index) + height(x, z), z)
    }
    geometry.deleteAttribute('normal')
    geometry.deleteAttribute('uv')
    const merged = mergeVertices(geometry, 1e-5)
    geometry.dispose()
    merged.computeVertexNormals()
    return this.mesh(name, merged, [0, 0, 0], color)
  }

  beam(name, from, to, radius, color) {
    const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to)
    const delta = end.clone().sub(start)
    const mesh = this.cylinder(name, radius, radius, delta.length(), start.clone().add(end).multiplyScalar(.5).toArray(), color, 24)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize())
    return mesh
  }

  table(name, width, depth, height, color) {
    const group = new THREE.Group()
    group.name = name
    const top = this.slab(`${name}-top`, width, depth, .12, [0, height - .06, 0], color)
    group.add(top)
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      group.add(this.box(`${name}-leg`, [.12, height - .12, .12], [x * (width / 2 - .13), (height - .12) / 2, z * (depth / 2 - .13)], color))
    }
    this.root.add(group)
    return group
  }

  barrel(name, radius, height, position, color) {
    const group = new THREE.Group()
    group.name = name
    group.position.set(...position)
    group.add(this.cylinder(`${name}-body`, radius * .88, radius * .88, height, [0, height / 2, 0], color, 12))
    for (const y of [height * .18, height * .82]) {
      group.add(this.torus(`${name}-hoop`, radius * .9, .025, [0, y, 0], '#444541', [Math.PI / 2, 0, 0]))
    }
    this.root.add(group)
    return group
  }
}
