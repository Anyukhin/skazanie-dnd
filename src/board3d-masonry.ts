import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

/** Детерминированный шум: тот же рисунок кладки при каждой пересборке. */
function cellNoise(x: number, y: number, salt = 0): number {
  const value = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453
  return value - Math.floor(value)
}

/**
 * Кладка в духе наборных диорам: стена собирается из отдельных камней с
 * фаской, ряды смещены вразбежку, размер и цвет каждого камня слегка
 * гуляют. Дерево — горизонтальные плахи. Только представление: граница
 * стены, её толщина и высота остаются теми же, что у правил и 2D.
 */

export type MasonryStyle = 'stone' | 'wood'

/** Прогон кладки вдоль ребра клетки или по стороне клетки-стены. */
export type MasonryRun = {
  /** Центр прогона в мире. */
  x: number
  z: number
  /** Нижняя отметка (пол клетки). */
  y: number
  /** Длина вдоль прогона и толщина поперёк, в клетках. */
  length: number
  thickness: number
  height: number
  /** true — прогон вдоль мирового X, иначе вдоль Z. */
  alongX: boolean
  style: MasonryStyle
  /** Базовый цвет; камни разнятся вокруг него. */
  color: string
  /** Детерминированное зерно прогона. */
  seed: number
}

const STONE_COURSE = .19
const MORTAR = .022

type Brick = { matrix: THREE.Matrix4; color: THREE.Color }

function stoneBricks(run: MasonryRun, out: Brick[]) {
  const courses = Math.max(1, Math.round(run.height / STONE_COURSE))
  const courseHeight = run.height / courses
  const object = new THREE.Object3D()
  const base = new THREE.Color(run.color)
  for (let course = 0; course < courses; course += 1) {
    // Ряд из двух-трёх камней; чётные ряды сдвинуты на полкамня.
    const perCourse = cellNoise(run.seed, course, 61) < .5 ? 2 : 3
    const stone = run.length / perCourse
    const offset = course % 2 ? stone / 2 : 0
    for (let index = -1; index <= perCourse; index += 1) {
      let start = index * stone + offset - run.length / 2
      let end = start + stone
      start = Math.max(start, -run.length / 2)
      end = Math.min(end, run.length / 2)
      if (end - start < .06) continue
      const n = (salt: number) => cellNoise(run.seed + index * 7.3, course, salt)
      const along = end - start - MORTAR * (1 + n(1) * .6)
      const tall = courseHeight - MORTAR * (1 + n(2) * .5)
      // Камни выступают из тела стены на долю шва и чуть гуляют по глубине.
      const deep = run.thickness + .035 + (n(3) - .5) * .03
      const center = (start + end) / 2 + (n(4) - .5) * .015
      const y = run.y + course * courseHeight + courseHeight / 2 + (n(5) - .5) * .01
      object.position.set(run.alongX ? run.x + center : run.x, y, run.alongX ? run.z : run.z + center)
      object.rotation.set((n(6) - .5) * .04, (n(7) - .5) * .05, (n(8) - .5) * .04)
      object.scale.set(run.alongX ? along : deep, tall, run.alongX ? deep : along)
      object.updateMatrix()
      const shade = .82 + n(9) * .3
      out.push({ matrix: object.matrix.clone(), color: base.clone().multiplyScalar(shade) })
    }
  }
}

function woodPlanks(run: MasonryRun, out: Brick[]) {
  const planks = Math.max(2, Math.round(run.height / .14))
  const plankHeight = run.height / planks
  const object = new THREE.Object3D()
  const base = new THREE.Color(run.color)
  for (let index = 0; index < planks; index += 1) {
    const n = (salt: number) => cellNoise(run.seed, index, salt)
    const deep = run.thickness + .03 + (n(1) - .5) * .02
    object.position.set(run.x, run.y + index * plankHeight + plankHeight / 2, run.z)
    object.rotation.set(0, 0, (n(2) - .5) * .03)
    const along = run.length - .02 - n(3) * .03
    object.scale.set(run.alongX ? along : deep, plankHeight - .018, run.alongX ? deep : along)
    object.updateMatrix()
    out.push({ matrix: object.matrix.clone(), color: base.clone().multiplyScalar(.8 + n(4) * .32) })
  }
}

export type MasonryDressing = { group: THREE.Group; count: number; dispose: () => void }

/**
 * Кладка по прогонам: камни и плахи — экземпляры одной скруглённой коробки,
 * поэтому сотни стен дают пару вызовов отрисовки.
 */
export function createMasonryDressing(runs: readonly MasonryRun[], name = 'masonry'): MasonryDressing {
  const group = new THREE.Group()
  group.name = name
  const bricks: Brick[] = [], planks: Brick[] = []
  for (const run of runs) {
    if (run.style === 'wood') woodPlanks(run, planks)
    else stoneBricks(run, bricks)
  }
  const geometry = new RoundedBoxGeometry(1, 1, 1, 1, .14)
  const stoneMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .9, metalness: 0 })
  const woodMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .82, metalness: 0 })
  for (const [list, material, label] of [[bricks, stoneMaterial, 'stone'], [planks, woodMaterial, 'wood']] as const) {
    if (!list.length) continue
    const mesh = new THREE.InstancedMesh(geometry, material, list.length)
    mesh.name = `${name}:${label}`
    list.forEach((brick, index) => { mesh.setMatrixAt(index, brick.matrix); mesh.setColorAt(index, brick.color) })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    group.add(mesh)
  }
  return {
    group,
    count: bricks.length + planks.length,
    dispose() {
      group.removeFromParent()
      group.clear()
      geometry.dispose()
      stoneMaterial.dispose()
      woodMaterial.dispose()
    },
  }
}

/** Природный цвет кладки по материалу клетки: камень серый, дерево тёплое. */
export const MASONRY_COLORS: Record<string, string> = {
  stone: '#8a8378', marble: '#bdb5a8', earth: '#8a7458', sand: '#b39c78', wood: '#7a5638', metal: '#6f747a', grass: '#868676', ice: '#a9c3cf',
}

/** Стиль кладки по материалу клетки стены. */
export function masonryStyleFor(material: string | undefined): MasonryStyle {
  return material === 'wood' ? 'wood' : 'stone'
}
