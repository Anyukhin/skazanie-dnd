import * as THREE from 'three'
import type { TacticalDoorState } from './types'

/** Полотно на петле в локальных координатах дверного проёма. Доски выпилены
 * по внутренней дуге кладки. Ручки и накладки поворачиваются вместе с ними. */
export function createLibraryLeaf(state: TacticalDoorState, east: boolean, spring: number, radius: number,
  oak: THREE.Material, iron: THREE.Material, owned: Set<THREE.BufferGeometry>) {
  const leaf = new THREE.Group()
  const width = .89
  const piece = (shape: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    owned.add(shape)
    const object = new THREE.Mesh(shape, material)
    object.position.set(x, y, z)
    object.castShadow = true
    object.receiveShadow = true
    leaf.add(object)
    return object
  }
  if (state === 'broken') {
    for (let i = 0; i < 3; i++) {
      const board = piece(new THREE.BoxGeometry(.13, .045, .54), oak, (i - 1) * .18, .045, i * .06)
      board.rotation.y = (i - 1) * .39
    }
    return leaf
  }
  const head = (x: number) => spring + Math.sqrt(Math.max(0, (radius - .114) ** 2 - x ** 2))
  const planks: THREE.Shape[] = []
  for (let i = 0; i < 7; i++) {
    const x0 = (i / 7 - .5) * width + .003, x1 = ((i + 1) / 7 - .5) * width - .003
    const plank = new THREE.Shape()
    plank.moveTo(x0, .015)
    plank.lineTo(x1, .015)
    for (let j = 0; j <= 6; j++) {
      const x = THREE.MathUtils.lerp(x1, x0, j / 6)
      plank.lineTo(x, head(x))
    }
    plank.closePath()
    planks.push(plank)
  }
  piece(new THREE.ExtrudeGeometry(planks, {depth:.064, bevelSize:.002, bevelThickness:.003, bevelSegments:1, steps:1}),
    oak, 0, 0, -.032)
  for (const y of [.23, spring - .12]) piece(new THREE.BoxGeometry(width * .97,.046,.078), iron, 0, y, 0)
  const ring = new THREE.TorusGeometry(.048,.009,6,18)
  for (const side of [-1,1]) {
    piece(ring, iron, width * .29, .64, side * .054)
    if (state === 'locked') piece(new THREE.BoxGeometry(.068,.082,.026), iron, width * .29, .553, side * .053)
  }
  if (state === 'open') {
    // Левая кромка остаётся у косяка при вращении всего полотна на 90°.
    const angle = east ? Math.PI / 2 : -Math.PI / 2
    leaf.rotation.y = angle
    leaf.position.set(-width / 2, 0, -Math.sin(angle) * width / 2)
  }
  return leaf
}
