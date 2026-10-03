import * as THREE from 'three'

/**
 * Цельная вальмовая крыша над домом любой прямоугольной формы — Г, Т, П.
 *
 * Высота ската в точке — расстояние до ближайшего края дома в метрике L∞
 * (по максимуму из смещений по осям), умноженное на уклон. Для прямоугольника
 * это обычная вальма: четыре ската, конёк по длинной стороне. Во внутреннем
 * углу Г-образного дома та же формула даёт ендову по диагонали, а над
 * крыльями — коньки, которые сами сходятся в одной точке. Сетка берётся с шагом
 * в полклетки: все рёбра и ендовы такой крыши лежат на её линиях и диагоналях,
 * поэтому скаты получаются ровными плоскостями без ступенек.
 *
 * Клетки дома — целочисленные квадраты: клетка (x, y) занимает [x, x+1] по X
 * и [y, y+1] по Z, высота 0 — линия карниза.
 */

export type HipFootprint = ReadonlySet<string>

export type HipRoofCovering = {
  /** Сколько мировых единиц накрывает повтор фактуры вдоль карниза и вверх по скату. */
  u: number
  v: number
  /** Доски кладутся вдоль ската, а не рядами вдоль карниза. */
  across?: boolean
}

export type HipRun = {
  /** Начало и конец отрезка края дома, высота 0. */
  start: THREE.Vector3
  end: THREE.Vector3
  /** Направление вдоль отрезка и наружу от дома. */
  along: THREE.Vector3
  outward: THREE.Vector3
  /** Угол на конце: выпуклый (крыша выходит за угол) или внутренний (ендова). */
  convexStart: boolean
  convexEnd: boolean
}

export const cellKey = (x: number, y: number) => `${x},${y}`

function parse(key: string) {
  const [x, y] = key.split(',').map(Number)
  return { x, y }
}

/** Расстояние L∞ от точки до ближайшей клетки вне дома: высота ската без уклона. */
export function createHipDistance(footprint: HipFootprint) {
  const outside: Array<{ x: number; y: number }> = []
  const seen = new Set<string>()
  for (const key of footprint) {
    const { x, y } = parse(key)
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const neighbor = cellKey(x + dx, y + dy)
      if (footprint.has(neighbor) || seen.has(neighbor)) continue
      seen.add(neighbor)
      outside.push({ x: x + dx, y: y + dy })
    }
  }
  return (px: number, pz: number) => {
    let best = Infinity
    for (const cell of outside) {
      const dx = Math.max(cell.x - px, 0, px - (cell.x + 1))
      const dz = Math.max(cell.y - pz, 0, pz - (cell.y + 1))
      const distance = Math.max(dx, dz)
      if (distance < best) best = distance
    }
    return best
  }
}

/** Отрезки края дома: соседние единичные рёбра с одной нормалью сливаются. */
export function hipRoofRuns(footprint: HipFootprint): HipRun[] {
  const inside = (x: number, y: number) => footprint.has(cellKey(x, y))
  const runs: HipRun[] = []
  // Четыре стороны: нормаль наружу и направление вдоль края.
  const sides = [
    { nx: 0, nz: -1, tx: 1, tz: 0 },
    { nx: 0, nz: 1, tx: -1, tz: 0 },
    { nx: -1, nz: 0, tx: 0, tz: -1 },
    { nx: 1, nz: 0, tx: 0, tz: 1 },
  ]
  for (const side of sides) {
    const visited = new Set<string>()
    for (const key of footprint) {
      const { x, y } = parse(key)
      if (inside(x + side.nx, y + side.nz) || visited.has(key)) continue
      // Идём назад до начала отрезка, затем вперёд до конца.
      let sx = x, sy = y
      while (inside(sx - side.tx, sy - side.tz) && !inside(sx - side.tx + side.nx, sy - side.tz + side.nz)) { sx -= side.tx; sy -= side.tz }
      let ex = sx, ey = sy
      visited.add(cellKey(ex, ey))
      while (inside(ex + side.tx, ey + side.tz) && !inside(ex + side.tx + side.nx, ey + side.tz + side.nz)) {
        ex += side.tx; ey += side.tz
        visited.add(cellKey(ex, ey))
      }
      // Угловые точки края в мировых координатах: сторона клетки со стороны нормали.
      const corner = (cx: number, cy: number, end: boolean) => {
        const centerX = cx + .5 + side.nx * .5, centerZ = cy + .5 + side.nz * .5
        const sign = end ? 1 : -1
        return new THREE.Vector3(centerX + side.tx * .5 * sign, 0, centerZ + side.tz * .5 * sign)
      }
      const beforeInside = inside(sx - side.tx, sy - side.tz)
      const afterInside = inside(ex + side.tx, ey + side.tz)
      runs.push({
        start: corner(sx, sy, false),
        end: corner(ex, ey, true),
        along: new THREE.Vector3(side.tx, 0, side.tz),
        outward: new THREE.Vector3(side.nx, 0, side.nz),
        // Отрезок оборвался, потому что дальше вдоль края дом кончился — угол
        // выпуклый; потому что дом продолжается наружу — внутренний угол.
        convexStart: !beforeInside,
        convexEnd: !afterInside,
      })
    }
  }
  return runs
}

/** Наибольшая высота без уклона: половина ширины самого широкого крыла. */
export function hipRoofDepth(footprint: HipFootprint, distance = createHipDistance(footprint)) {
  let best = 0
  for (const key of footprint) {
    const { x, y } = parse(key)
    for (const [ox, oz] of [[.5, .5], [0, 0], [.5, 0], [0, .5], [1, 1], [1, .5], [.5, 1]]) best = Math.max(best, distance(x + ox, y + oz))
  }
  return best
}

/**
 * Поверхность крыши со свесом: треугольники по полуклеткам и трапеции свеса
 * по краю. UV — в повторах фактуры: вдоль карниза и вверх по скату, поэтому
 * ряды черепицы на каждом скате идут параллельно его карнизу.
 */
export function createHipRoofGeometry(footprint: HipFootprint, { slope, overhang, covering }: { slope: number; overhang: number; covering?: HipRoofCovering }) {
  const distance = createHipDistance(footprint)
  const positions: number[] = []
  const heights: number[] = []
  const vertex = (x: number, z: number, d: number) => { positions.push(x, d * slope, z); heights.push(d) }
  for (const key of footprint) {
    const { x, y } = parse(key)
    for (const sx of [0, .5]) for (const sz of [0, .5]) {
      const x0 = x + sx, z0 = y + sz, x1 = x0 + .5, z1 = z0 + .5
      const corners: Array<[number, number]> = [[x0, z0], [x0, z1], [x1, z1], [x1, z0]]
      const cx = x0 + .25, cz = z0 + .25
      const center = distance(cx, cz)
      for (let index = 0; index < 4; index += 1) {
        const [ax, az] = corners[index], [bx, bz] = corners[(index + 1) % 4]
        vertex(ax, az, distance(ax, az))
        vertex(bx, bz, distance(bx, bz))
        vertex(cx, cz, center)
      }
    }
  }
  // Свес: трапеция наружу от каждого отрезка края, со срезом 45° в углах —
  // на выпуклом углу соседние свесы смыкаются, на внутреннем не налезают.
  for (const run of hipRoofRuns(footprint)) {
    const outer = (point: THREE.Vector3, extend: number) => point.clone().addScaledVector(run.outward, overhang).addScaledVector(run.along, extend * overhang)
    const a = run.start, b = run.end
    const a2 = outer(a, run.convexStart ? -1 : 1), b2 = outer(b, run.convexEnd ? 1 : -1)
    const quad: Array<[THREE.Vector3, number]> = [[a, 0], [b, 0], [b2, -overhang], [a2, -overhang]]
    for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) for (const [point, d] of [quad[i], quad[j], quad[k]]) vertex(point.x, point.z, d)
  }
  // Обход треугольников вверх нормалью и UV по плоскости каждого.
  const uv: number[] = []
  const slant = Math.hypot(1, slope)
  for (let base = 0; base < positions.length; base += 9) {
    const p = [0, 1, 2].map((index) => new THREE.Vector3(positions[base + index * 3], positions[base + index * 3 + 1], positions[base + index * 3 + 2]))
    const normal = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]))
    if (normal.y < 0) {
      // Меняем местами вторую и третью вершины вместе с высотами.
      for (let c = 0; c < 3; c += 1) {
        const tmp = positions[base + 3 + c]; positions[base + 3 + c] = positions[base + 6 + c]; positions[base + 6 + c] = tmp
      }
      const vertexIndex = base / 3
      const tmp = heights[vertexIndex + 1]; heights[vertexIndex + 1] = heights[vertexIndex + 2]; heights[vertexIndex + 2] = tmp
      normal.negate()
    }
    // Уклон плоскости — вдоль одной из осей: у каждого ската свой карниз.
    const alongX = Math.abs(normal.x) >= Math.abs(normal.z)
    const upSign = alongX ? -Math.sign(normal.x || 1) : -Math.sign(normal.z || 1)
    for (let index = 0; index < 3; index += 1) {
      const x = positions[base + index * 3], z = positions[base + index * 3 + 2]
      const up = heights[base / 3 + index] * slant
      // u растёт вправо, если смотреть вверх по скату.
      const side = alongX ? z * upSign : -x * upSign
      if (!covering) uv.push(x, z)
      else if (covering.across) uv.push(up / covering.u, side / covering.v)
      else uv.push(side / covering.u, up / covering.v)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Стропила для среза крыши: от карниза внутрь до ребра или ендовы, где скат
 * перестаёт подниматься. Возвращает начало и конец каждого на высоте ската.
 */
export function hipRoofRafters(footprint: HipFootprint, slope: number, spacing = 1.1) {
  const distance = createHipDistance(footprint)
  const rafters: Array<{ from: THREE.Vector3; to: THREE.Vector3 }> = []
  for (const run of hipRoofRuns(footprint)) {
    const length = run.start.distanceTo(run.end)
    const count = Math.max(1, Math.round(length / spacing))
    for (let index = 0; index < count; index += 1) {
      const point = run.start.clone().addScaledVector(run.along, (index + .5) * length / count)
      const inward = run.outward.clone().negate()
      let travel = 0
      const step = .05
      while (travel < 50) {
        const next = point.clone().addScaledVector(inward, travel + step)
        if (distance(next.x, next.z) < travel + step - 1e-4) break
        travel += step
      }
      if (travel < .1) continue
      const to = point.clone().addScaledVector(inward, travel)
      to.y = travel * slope
      rafters.push({ from: point, to })
    }
  }
  return rafters
}
