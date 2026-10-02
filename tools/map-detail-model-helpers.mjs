/** Общие примитивы авторского набора детализации; координаты — метры. */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

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
