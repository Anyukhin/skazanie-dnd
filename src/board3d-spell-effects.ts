import * as THREE from 'three'
import { actorPresentationCenter, actorPresentationSize } from './tactical-ui'
import { terrainHeightAt } from './board3d-terrain'
import { cellAt, edgeBetween, revealedAt } from './tactical-map-client'
import { projectileEndpoints, projectileVolley, spellBurstCells, spellChannelTargetIds, spellEffectPalette, spellIdFromEffect, type SpellEffectDetail } from './spell-effects'
import type { ActorFootprint, TacticalMap } from './types'
import type { BoardPoint, CombatAnimationCue, SpellAnimationCue } from './combat-animation'

type SpellEffectActor = BoardPoint & { id: string; footprint?: ActorFootprint }
type SpellEffect3D = {
  group: THREE.Group
  update: (progress: number) => void
  dispose: () => void
}

type SpellStyle = ReturnType<typeof spellEffectPalette>

function targetOutcomeIsMiss(cue: SpellAnimationCue, targetId: string | undefined) {
  if (!targetId) return false
  const outcome = cue.targetOutcomes?.[targetId]
  return outcome === 'miss' || outcome === 'blocked'
}

function cueDamageType(cue: SpellAnimationCue) {
  return 'damageType' in cue ? cue.damageType : undefined
}

function styleFor(cue: SpellAnimationCue): SpellStyle {
  return spellEffectPalette(cue.spellId, {
    school: cue.school,
    damageType: cueDamageType(cue),
    ...(cue.visualFamily ? { visualFamily: cue.visualFamily } : {}),
    ...(cue.kind === 'channel' && cue.channelType === 'healing' ? { kind: 'healing' } : {}),
  })
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number(value) || 0))

function actorFor(actors: readonly SpellEffectActor[], id: string | undefined) {
  return id ? actors.find((actor) => actor.id === id) ?? null : null
}

/**
 * Высота пола под существом. Модель крупного существа стоит на максимуме
 * рельефа по всей своей площади (как `actorGround` в TacticalBoard3D), и
 * эффект над ним поднимается от той же высоты, а не от высоты anchor-клетки.
 */
export function actorGroundHeight(map: TacticalMap, actor: SpellEffectActor, anchor: BoardPoint = actor) {
  const side = actorPresentationSize(map, actor, anchor)
  let height = terrainHeightAt(map, anchor.x, anchor.y)
  for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) {
    height = Math.max(height, terrainHeightAt(map, anchor.x + x, anchor.y + y))
  }
  return height
}

function visualPoint(map: TacticalMap, point: BoardPoint, actor?: SpellEffectActor | null, height = .7) {
  const center = actor ? actorPresentationCenter(map, actor, point) : { x: point.x + .5, y: point.y + .5 }
  const ground = actor ? actorGroundHeight(map, actor, point) : terrainHeightAt(map, point.x, point.y)
  return new THREE.Vector3(center.x, ground + height, center.y)
}

// Временные векторы кадра: update() вызывается каждый кадр и не должен
// плодить мусор. Значения из них сразу копируются в позиции и буферы.
const scratchA = new THREE.Vector3()
const scratchB = new THREE.Vector3()
const scratchC = new THREE.Vector3()
const scratchD = new THREE.Vector3()
const scratchE = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

/**
 * Динамический свет эффекта. Доска держит пул из двух PointLight и каждый
 * кадр читает `group.userData.lights`: координаты мировые, `distance` — в
 * клетках. Массив и его элементы создаются один раз; update() только
 * переписывает поля и длину массива.
 */
export type EffectLight = { x: number; y: number; z: number; color: string; intensity: number; distance: number }
export const EFFECT_LIGHT_LIMIT = 2

export function effectLightRig(group: THREE.Object3D, detail: SpellEffectDetail) {
  const pool: EffectLight[] = Array.from({ length: EFFECT_LIGHT_LIMIT }, () => ({ x: 0, y: 0, z: 0, color: '#ffffff', intensity: 0, distance: 4 }))
  const active: EffectLight[] = []
  group.userData.lights = active
  // На «Экономном» свет не пересчитывается вовсе: пул доски остаётся тёмным.
  const enabled = detail !== 'minimal'
  return {
    clear() { active.length = 0 },
    add(point: { x: number; y: number; z: number }, color: string, intensity: number, distance: number) {
      if (!enabled || active.length >= EFFECT_LIGHT_LIMIT || !(intensity > .03)) return
      const light = pool[active.length]
      light.x = point.x; light.y = point.y; light.z = point.z
      light.color = color
      light.intensity = Math.min(6, intensity)
      light.distance = Math.max(3, Math.min(8, distance))
      active.push(light)
    },
  }
}

const easeOutCubic = (value: number) => 1 - (1 - clamp01(value)) ** 3
const easeOutQuad = (value: number) => 1 - (1 - clamp01(value)) ** 2
const smoothstep = (from: number, to: number, value: number) => {
  const t = clamp01((value - from) / Math.max(1e-6, to - from))
  return t * t * (3 - 2 * t)
}
/** Детерминированный шум: одинаковый рисунок при повторе той же реплики. */
const noise = (seed: number) => {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return value - Math.floor(value)
}

/**
 * Цвет ярче единицы: при включённом тонмаппинге ядро проходит порог bloom
 * на «Обычном» и «Высоком», а на «Экономном» просто остаётся ярким.
 */
function glow(color: THREE.ColorRepresentation, strength: number) {
  return new THREE.Color(color).multiplyScalar(strength)
}

function additive(color: THREE.ColorRepresentation, opacity: number, extra: THREE.MeshBasicMaterialParameters = {}) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, ...extra })
}

/**
 * Открытый цилиндр с основанием на y=0, который гаснет к верху вершинными
 * цветами. При аддитивном смешивании чёрный край ничего не добавляет, поэтому
 * столб света растворяется без отдельной прозрачности.
 */
function fadeColumnGeometry(radiusBottom: number, radiusTop: number, height: number, segments: number) {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments, 4, true)
  geometry.translate(0, height / 2, 0)
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute
  const colors = new Float32Array(positions.count * 3)
  for (let index = 0; index < positions.count; index += 1) {
    const level = (1 - clamp01(positions.getY(index) / height)) ** 1.5
    colors[index * 3] = colors[index * 3 + 1] = colors[index * 3 + 2] = level
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

/**
 * Полусфера с основанием на полу: купол взрыва не уходит под землю. Вершинный
 * цвет гаснет к макушке — при камере сверху это даёт яркий край и прозрачную
 * середину, поэтому фигурки внутри области остаются видны.
 */
function domeGeometry(segments: number) {
  const geometry = new THREE.SphereGeometry(1, segments, Math.max(4, Math.floor(segments / 2)), 0, Math.PI * 2, 0, Math.PI / 2)
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute
  const colors = new Float32Array(normals.count * 3)
  for (let index = 0; index < normals.count; index += 1) {
    const level = .05 + .95 * (1 - Math.abs(normals.getY(index))) ** 2.2
    colors[index * 3] = colors[index * 3 + 1] = colors[index * 3 + 2] = level
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

/** Хвост снаряда: открытый конус, широкий у ядра и сходящийся назад. */
function trailGeometry(segments: number) {
  return new THREE.ConeGeometry(1, 1, segments, 1, true)
}

/** Растягивает хвост-конус от головы снаряда к точке позади него. */
function orientTrail(mesh: THREE.Mesh, head: THREE.Vector3, tail: THREE.Vector3, radius: number) {
  const direction = scratchE.subVectors(tail, head)
  const length = direction.length()
  if (length < .02) { mesh.visible = false; return }
  mesh.position.copy(head).add(tail).multiplyScalar(.5)
  mesh.scale.set(radius, length, radius)
  mesh.quaternion.setFromUnitVectors(UP, direction.multiplyScalar(1 / length))
}

function areaVisualPoint(
  map: TacticalMap,
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  point: BoardPoint,
  height = .7,
) {
  if (cue.geometryVersion === 'circle-grid-v2' && (cue.shape === 'sphere' || cue.shape === 'cylinder')) {
    const origin = cue.gridOrigin ?? point
    return new THREE.Vector3(origin.x, terrainHeightAt(map, origin.x, origin.y) + height, origin.y)
  }
  return visualPoint(map, point, null, height)
}

function visible(map: TacticalMap, point: BoardPoint | null | undefined) {
  return Boolean(point && revealedAt(map, Math.floor(point.x), Math.floor(point.y)))
}

function visiblePath(map: TacticalMap, from: BoardPoint, to: BoardPoint) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 2))
  let previous: BoardPoint | null = null
  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps
    const point = { x: Math.floor(from.x + (to.x - from.x) * progress), y: Math.floor(from.y + (to.y - from.y) * progress) }
    if (!revealedAt(map, point.x, point.y)) return false
    if (previous && (previous.x !== point.x || previous.y !== point.y) && edgeBetween(map, previous.x, previous.y, point.x, point.y)?.blocksSight) return false
    previous = point
  }
  return true
}

type BurstFootprint = { all: BoardPoint[]; present: BoardPoint[]; visible: BoardPoint[]; fogged: boolean }

function burstCellsWithoutFog(map: TacticalMap, cue: Extract<SpellAnimationCue, { kind: 'burst' }>, actors: readonly SpellEffectActor[]) {
  return spellBurstCells(map, cue, actors, { includeHidden: true })
}

function burstFootprint(map: TacticalMap, cue: Extract<SpellAnimationCue, { kind: 'burst' }>, actors: readonly SpellEffectActor[]): BurstFootprint {
  const all = burstCellsWithoutFog(map, cue, actors)
  const present = all.filter((point) => Boolean(cellAt(map, Math.floor(point.x), Math.floor(point.y))))
  const visibleCells = present.filter((point) => revealedAt(map, Math.floor(point.x), Math.floor(point.y)))
  const fogged = present.some((point) => !revealedAt(map, Math.floor(point.x), Math.floor(point.y)))
  return { all, present, visible: visibleCells, fogged }
}

/** Край карты не является туманом: только существующая скрытая клетка блокирует объём. */
function burstVolumeVisible(map: TacticalMap, cue: Extract<SpellAnimationCue, { kind: 'burst' }>, actors: readonly SpellEffectActor[]) {
  const footprint = burstFootprint(map, cue, actors)
  return footprint.present.length > 0 && !footprint.fogged
}

function visibleRadius(map: TacticalMap, center: BoardPoint, radiusCells: number) {
  const radius = Math.max(.35, Number(radiusCells) || .35)
  let limit = radius
  const samples = Math.max(12, Math.ceil(radius * 10))
  for (let index = 0; index < samples; index += 1) {
    const angle = index * Math.PI * 2 / samples
    for (let distance = .5; distance <= radius; distance += .5) {
      const x = Math.floor(center.x + Math.cos(angle) * distance)
      const y = Math.floor(center.y + Math.sin(angle) * distance)
      const cell = cellAt(map, x, y)
      if (cell && !cell.revealed) { limit = Math.min(limit, Math.max(.35, distance - .35)); break }
    }
  }
  return limit
}

/**
 * Полуширина квадратного (чебышёвского) контура, урезанная до первой скрытой
 * клетки внутри квадрата. Край карты туманом не считается.
 */
function visibleSquareHalfWidth(map: TacticalMap, center: { x: number; y: number }, halfWidth: number) {
  const half = Math.max(.35, Number(halfWidth) || .35)
  let limit = half
  for (let y = Math.floor(center.y - half); y < Math.ceil(center.y + half); y += 1) {
    for (let x = Math.floor(center.x - half); x < Math.ceil(center.x + half); x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell || cell.revealed) continue
      const dx = Math.max(0, x - center.x, center.x - (x + 1))
      const dy = Math.max(0, y - center.y, center.y - (y + 1))
      limit = Math.min(limit, Math.max(.35, Math.max(dx, dy)))
    }
  }
  return limit
}

/** Плоский квадратный контур на полу: RingGeometry с четырьмя сегментами. */
function squareOutlineGeometry(halfWidth: number, thickness: number) {
  const inner = Math.max(.001, halfWidth - thickness) * Math.SQRT2
  const outer = (halfWidth + thickness) * Math.SQRT2
  const geometry = new THREE.RingGeometry(inner, outer, 4, 1, Math.PI / 4)
  geometry.userData.halfWidth = halfWidth
  return geometry
}

function detailOf(cue: SpellAnimationCue): SpellEffectDetail {
  return cue.detail ?? 'full'
}

function resources() {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const track = <T extends THREE.BufferGeometry>(geometry: T) => { geometries.add(geometry); return geometry }
  const material = <T extends THREE.Material>(value: T) => { materials.add(value); return value }
  return { geometries, materials, track, material }
}

function setLinePoints(line: THREE.Line, first: THREE.Vector3, second: THREE.Vector3, third?: THREE.Vector3) {
  const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute
  positions.setXYZ(0, first.x, first.y, first.z)
  positions.setXYZ(1, second.x, second.y, second.z)
  if (third) positions.setXYZ(2, third.x, third.y, third.z)
  positions.needsUpdate = true
}

function createFireball(
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  const sourceActor = actorFor(actors, cue.actorId)
  const origin = cue.origin ?? sourceActor
  const center = cue.center ?? (cue.cells?.length
    ? {
      x: cue.cells.reduce((sum, point) => sum + point.x, 0) / cue.cells.length,
      y: cue.cells.reduce((sum, point) => sum + point.y, 0) / cue.cells.length,
    }
    : undefined)
  if (!origin || !center || !visible(map, origin) || !visible(map, center) || !visiblePath(map, origin, center)) return null

  const detail = detailOf(cue)
  const footprint = burstFootprint(map, cue, actors)
  // Выборка ограничивает только тлеющие клетки. Контур строится по всем
  // видимым клеткам footprint, иначе в нём появляются разрывы.
  const visibleCells = footprint.visible
  const emberCells = sampledCells(visibleCells, detail === 'full' ? 22 : detail === 'reduced' ? 14 : 6)
  if (!footprint.present.length || !visibleCells.length) return null
  const { geometries, materials, track, material } = resources()
  const group = new THREE.Group()
  const lights = effectLightRig(group, detail)
  const style = styleFor(cue)
  const segments = detail === 'full' ? 22 : detail === 'reduced' ? 16 : 10
  // Вложенные аддитивные слои дают градиент без шейдера: короткое горячее
  // ядро, оранжевое тело и тёмно-красная оболочка, яркая только по краю.
  const coreMaterial = material(additive(glow('#fff1c9', 3.2), 1))
  const haloMaterial = material(additive(glow('#ff8a2c', 1.5), .72))
  const shellMaterial = material(additive(glow('#ff4a18', 1.35), .8, { vertexColors: true }))
  const flameMaterial = material(additive(glow('#ffa040', 1.05), .38))
  const flashMaterial = material(additive(glow('#fff0bc', 1.9), .85))
  const waveMaterial = material(additive(glow('#ffb45c', 1.7), .9))
  const trailMaterial = material(additive(glow('#ff8c38', 1.3), .62))
  const emberMaterials = ['#ff5a1a', '#ff7426', '#e8401a'].map((color) => material(additive(glow(color, 1), 0)))
  const contourMaterial = material(new THREE.LineBasicMaterial({ color: style.secondary, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }))
  const dome = track(domeGeometry(segments))
  const orb = new THREE.Mesh(track(new THREE.SphereGeometry(.15, detail === 'full' ? 12 : 8, 6)), coreMaterial)
  const halo = new THREE.Mesh(track(new THREE.SphereGeometry(.3, detail === 'full' ? 12 : 8, 6)), haloMaterial)
  // Порядок первых четырёх детей — контракт тестов: [ядро, ореол, купол, волна].
  const explosion = new THREE.Mesh(dome, shellMaterial)
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(1, .03, 6, detail === 'full' ? 48 : detail === 'reduced' ? 32 : 20)), waveMaterial)
  ring.rotation.x = -Math.PI / 2
  group.add(orb, halo, explosion, ring)
  const flame = detail === 'minimal' ? null : new THREE.Mesh(dome, flameMaterial)
  const flash = new THREE.Mesh(track(new THREE.SphereGeometry(1, segments, Math.max(4, Math.floor(segments / 2)))), flashMaterial)
  if (flame) group.add(flame)
  group.add(flash)
  const trail = new THREE.Mesh(track(trailGeometry(detail === 'full' ? 10 : 7)), trailMaterial)
  group.add(trail)

  const ground = terrainHeightAt(map, center.x, center.y)
  const from = visualPoint(map, origin, sourceActor, .78)
  const to = areaVisualPoint(map, cue, center, .78)
  const footprintRadius = visibleCells.reduce((maximum, cell) => Math.max(maximum, Math.hypot(cell.x + .5 - to.x, cell.y + .5 - to.z) + .5), 0)
  const blastRadius = Math.max(1.2, Math.min(5, footprintRadius || (Number(cue.sizeFeet) || 10) / 5))
  const emberGeometry = track(new THREE.CircleGeometry(.12, detail === 'full' ? 9 : 6))
  const embers = emberCells.map((cell, index) => {
    const mesh = new THREE.Mesh(emberGeometry, emberMaterials[index % emberMaterials.length])
    mesh.rotation.x = -Math.PI / 2
    // Смещение внутри клетки убирает «сетку горошин»: угли лежат вразброс.
    const jitterX = (noise(index * 2.7 + 1.3) - .5) * .5, jitterZ = (noise(index * 5.1 + .7) - .5) * .5
    mesh.position.set(cell.x + .5 + jitterX, terrainHeightAt(map, cell.x, cell.y) + .035, cell.y + .5 + jitterZ)
    group.add(mesh)
    // Клетка загорается, когда до неё доходит фронт взрыва.
    const reach = clamp01(Math.hypot(cell.x + .5 - to.x, cell.y + .5 - to.z) / blastRadius)
    return { mesh, reach, seed: noise(index + 1) }
  })
  const contourKeys = new Set(visibleCells.map((cell) => `${cell.x},${cell.y}`))
  const contourPoints: THREE.Vector3[] = []
  const edge = (x1: number, z1: number, x2: number, z2: number, y: number) => {
    contourPoints.push(new THREE.Vector3(x1, y, z1), new THREE.Vector3(x2, y, z2))
  }
  for (const cell of visibleCells) {
    const x = cell.x, y = cell.y, level = terrainHeightAt(map, x, y) + .06
    if (!contourKeys.has(`${x},${y - 1}`)) edge(x, y, x + 1, y, level)
    if (!contourKeys.has(`${x + 1},${y}`)) edge(x + 1, y, x + 1, y + 1, level)
    if (!contourKeys.has(`${x},${y + 1}`)) edge(x + 1, y + 1, x, y + 1, level)
    if (!contourKeys.has(`${x - 1},${y}`)) edge(x, y + 1, x, y, level)
  }
  const contour = contourPoints.length
    ? new THREE.LineSegments(track(new THREE.BufferGeometry().setFromPoints(contourPoints)), contourMaterial)
    : null
  if (contour) group.add(contour)
  const blastAllowed = footprint.present.length > 0 && !footprint.fogged
  // Синхронно с плоским drawBurst: взрыв начинается после прилёта шара.
  const arrival = .56
  const explosionStart = arrival
  const arcHeight = .42
  const flightPoint = (travel: number, target: THREE.Vector3) => {
    target.lerpVectors(from, to, travel)
    target.y = from.y + (to.y - from.y) * travel + Math.sin(travel * Math.PI) * arcHeight
    return target
  }
  const lightPoint = new THREE.Vector3(to.x, ground + 1.1, to.z)

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      lights.clear()
      // Полёт ускоряется к цели: шар «падает» в точку взрыва.
      const travel = Math.min(1, (progress / arrival) ** 1.25)
      const position = flightPoint(travel, scratchA)
      const pulse = 1 + Math.sin(progress * 60) * .08
      orb.position.copy(position); halo.position.copy(position)
      orb.scale.setScalar(pulse); halo.scale.setScalar(1 + travel * .25)
      orb.visible = halo.visible = progress < arrival && visible(map, { x: position.x, y: position.z })
      trail.visible = orb.visible
      if (orb.visible) orientTrail(trail, position, flightPoint(Math.max(0, travel - (detail === 'full' ? .2 : .14)), scratchB), .13 * (1 + travel * .3))
      if (orb.visible) lights.add(position, '#ff9442', 2.2 + travel * 1.2, 4)

      const e = clamp01((progress - explosionStart) / (1 - explosionStart))
      const blastVisible = e > 0 && e < 1 && blastAllowed && visible(map, center)
      // Быстрый ease-out: купол почти сразу занимает область, затем медленно
      // поднимается и редеет, открывая фигурки внутри.
      const expand = easeOutCubic(e / .34)
      explosion.position.set(to.x, ground, to.z)
      explosion.scale.set(blastRadius * (.25 + .75 * expand), blastRadius * (.1 + .3 * expand) * (1 + e * .4), blastRadius * (.25 + .75 * expand))
      shellMaterial.opacity = .62 * smoothstep(0, .06, e) * (1 - smoothstep(.25, .72, e))
      explosion.visible = blastVisible
      if (flame) {
        flame.position.copy(explosion.position)
        flame.scale.set(blastRadius * .55 * (.2 + .8 * expand), blastRadius * .3 * (.2 + .8 * expand), blastRadius * .55 * (.2 + .8 * expand))
        flameMaterial.opacity = .38 * (1 - smoothstep(.15, .55, e))
        flame.visible = blastVisible && flameMaterial.opacity > .01
      }
      // Горячее ядро: самая яркая и самая короткая часть вспышки.
      flash.position.set(to.x, ground + .45, to.z)
      flash.scale.setScalar(Math.max(.05, blastRadius * .24 * (.4 + .6 * easeOutCubic(e / .15))))
      flashMaterial.opacity = .85 * (1 - smoothstep(.04, .24, e))
      flash.visible = blastVisible && flashMaterial.opacity > .01
      // Ударная волна бежит по полу до края области и гаснет.
      const wave = clamp01(e / .3)
      ring.position.set(to.x, ground + .08, to.z)
      ring.scale.setScalar(Math.max(.2, blastRadius * (.15 + .95 * easeOutQuad(wave))))
      waveMaterial.opacity = .95 * (1 - wave) ** 1.3
      ring.visible = blastVisible && wave < 1
      // Тление: клетки вспыхивают по фронту и медленно остывают, мерцая.
      const smoulder = smoothstep(.12, .35, e) * (1 - smoothstep(.7, 1, e))
      emberMaterials.forEach((entry, index) => { entry.opacity = .7 * smoulder * (.72 + .28 * Math.sin(e * 34 + index * 2.1)) })
      for (const ember of embers) {
        const lit = expand * 1.05 >= ember.reach
        ember.mesh.scale.setScalar(.7 + .3 * ember.seed + .12 * Math.sin(e * 23 + ember.seed * 6.28))
        ember.mesh.visible = lit && e > 0 && e < 1 && smoulder > .01 && visible(map, { x: ember.mesh.position.x, y: ember.mesh.position.z })
      }
      if (contour) {
        const contourProgress = clamp01((e - .04) / .5)
        const vertexCount = Math.floor(contourPoints.length * contourProgress / 2) * 2
        contour.geometry.setDrawRange(0, vertexCount)
        contourMaterial.opacity = .7 * smoothstep(0, .1, e) * (1 - smoothstep(.85, 1, e))
        contour.visible = vertexCount > 1 && e < 1 && visibleCells.length > 0
      }
      if (blastVisible) {
        // Резкий пик света и затухание до тлеющего отсвета.
        const peak = smoothstep(0, .05, e) * Math.exp(-e * 7)
        lights.add(lightPoint, '#ff8a3a', 6 * peak + 1.1 * smoulder, blastRadius * 1.7)
      }
      if (progress >= 1) lights.clear()
      group.visible = visible(map, center) && (orb.visible || explosion.visible || flash.visible || ring.visible || contour?.visible === true || embers.some(({ mesh }) => mesh.visible))
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}

type ProjectilePath = { from: THREE.Vector3; to: THREE.Vector3; targetId?: string; phase: number; arrival: number; arc: number; index: number; count: number }

function projectilePaths(
  cue: Extract<SpellAnimationCue, { kind: 'projectile' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
  maximum: number,
) {
  const { from: origin, fromActor: source, targets } = projectileEndpoints(cue, actors)
  if (!origin || !visible(map, origin)) return [] as ProjectilePath[]
  // Цель и её id берутся из одной и той же отфильтрованной записи: исход
  // промаха не может уехать к соседней цели, когда одна из них скрыта.
  const reachable = targets.filter(({ to }) => visible(map, to) && visiblePath(map, origin, to))
  if (!reachable.length) return [] as ProjectilePath[]
  const from = visualPoint(map, origin, source, .78)
  const ends = reachable.map(({ to, toActor }) => visualPoint(map, to, toActor, .72))
  const volley = projectileVolley(cue.projectileCount, reachable.length, maximum)
  return volley.map(({ target }, index): ProjectilePath => ({
    from,
    to: ends[target],
    targetId: reachable[target].targetId,
    phase: .08 + index * .035,
    arrival: .7 + Math.min(.16, index * .025),
    arc: .22 + (index % 3) * .06,
    index,
    count: volley.length,
  }))
}

type ProjectileLook = {
  core: THREE.ColorRepresentation
  halo: THREE.ColorRepresentation
  trail: THREE.ColorRepresentation
  impact: THREE.ColorRepresentation
  light: string
  flightLight: boolean
  /** Амплитуда волнистости траектории в клетках: магические стрелы «плывут». */
  wobble: number
  /** Разлёт залпа в стороны: дротики расходятся веером и сходятся на цели. */
  spread: number
  arc: number
  trailLength: number
  size: number
}

function projectileLook(style: SpellStyle): ProjectileLook {
  const family = String(style.family)
  const base: ProjectileLook = {
    core: glow(style.secondary, 2.4), halo: glow(style.primary, 1.2), trail: glow(style.primary, 1.1), impact: glow(style.secondary, 2),
    light: style.primary, flightLight: false, wobble: 0, spread: .18, arc: 1, trailLength: .22, size: 1,
  }
  if (family === 'fire') return { ...base, core: glow('#fff0c4', 3.2), halo: glow('#ff7424', 1.6), trail: glow('#ff8a34', 1.3), impact: glow('#ffc36a', 2.6), light: '#ff8a3a', flightLight: true, trailLength: .3, size: 1.1 }
  if (family === 'cold') return { ...base, core: glow('#f2feff', 3), halo: glow('#78d6f2', 1.3), trail: glow('#a8ecff', 1.2), impact: glow('#e8fbff', 2.4), light: '#9fe2ff', arc: .35, trailLength: .42 }
  if (family === 'force') return { ...base, core: glow('#f1f2ff', 3), halo: glow('#8e9cff', 1.4), trail: glow('#a5b0ff', 1.2), impact: glow('#b9c2ff', 1.9), light: '#9aa6ff', wobble: .16, spread: .32, trailLength: .26, size: .82 }
  if (family === 'acid') return { ...base, core: glow('#f2ffb8', 2.2), halo: glow('#9cc43c', 1.2), trail: glow('#b6cf5c', .9), impact: glow('#d8f07a', 2), light: '#b8e05a', arc: 1.7, trailLength: .16 }
  if (family === 'poison') return { ...base, core: glow('#e4ffcc', 2), halo: glow('#5fae5c', 1.1), trail: glow('#70b86e', .9), impact: glow('#b8e39b', 1.8), light: '#7fd27a', wobble: .08 }
  if (family === 'necrotic') return { ...base, core: glow('#efe0ff', 1.8), halo: glow('#6d4f93', 1.1), trail: glow('#876b9e', .9), impact: glow('#cdb2ef', 1.8), light: '#8a7dff', wobble: .1 }
  if (family === 'radiant' || family === 'light') return { ...base, core: glow('#fffbe6', 3.2), halo: glow('#f0c860', 1.5), trail: glow('#ffe39a', 1.2), impact: glow('#fff3bd', 2.8), light: '#ffe2a0', flightLight: true, arc: .5 }
  if (family === 'lightning') return { ...base, core: glow('#f2fdff', 3.4), halo: glow('#5cc8ff', 1.4), trail: glow('#9be6ff', 1.3), impact: glow('#e9fbff', 2.8), light: '#a8dcff', flightLight: true, arc: .2, wobble: .06, trailLength: .36 }
  if (family === 'psychic') return { ...base, wobble: .14, spread: .26 }
  return base
}

function createProjectile(
  cue: Extract<SpellAnimationCue, { kind: 'projectile' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  const detail = detailOf(cue)
  const paths = projectilePaths(cue, actors, map, detail === 'full' ? 8 : detail === 'reduced' ? 4 : 1)
  if (!paths.length) return null
  const { geometries, materials, track, material } = resources()
  const group = new THREE.Group()
  const lights = effectLightRig(group, detail)
  const style = styleFor(cue)
  const look = projectileLook(style)
  const family = String(style.family)
  const coreMaterial = material(additive(look.core, 1))
  const haloMaterial = material(additive(look.halo, .55))
  const trailMaterial = material(additive(look.trail, .55))
  const impactMaterial = material(additive(look.impact, .85))
  const flashMaterial = material(additive(look.impact, .9))
  const coreGeometry = track(family === 'weapon'
    ? new THREE.BoxGeometry(.28, .08, .08)
      : family === 'earth' ? new THREE.DodecahedronGeometry(.13, 0)
        : family === 'swarm' ? new THREE.IcosahedronGeometry(.13, 0)
          : new THREE.SphereGeometry(.1 * look.size, detail === 'full' ? 10 : 7, 5))
  const haloGeometry = detail === 'minimal' ? null : track(new THREE.SphereGeometry(.21 * look.size, detail === 'full' ? 10 : 7, 5))
  const tailGeometry = track(trailGeometry(detail === 'full' ? 8 : 6))
  const impactGeometry = track(new THREE.TorusGeometry(.22, .025, 5, detail === 'full' ? 18 : 10))
  const flashGeometry = track(new THREE.SphereGeometry(.2, detail === 'full' ? 10 : 7, 5))
  const entries = paths.map((path) => {
    const root = new THREE.Group()
    // Порядок важен: ядро — первая сфера корня (её ищут тесты высоты старта).
    const trail = new THREE.Mesh(tailGeometry, trailMaterial)
    const orb = new THREE.Mesh(coreGeometry, coreMaterial)
    const halo = haloGeometry ? new THREE.Mesh(haloGeometry, haloMaterial) : null
    const impact = new THREE.Mesh(impactGeometry, impactMaterial)
    impact.rotation.x = -Math.PI / 2
    const flash = new THREE.Mesh(flashGeometry, flashMaterial)
    root.add(trail, orb)
    if (halo) root.add(halo)
    root.add(impact, flash)
    group.add(root)
    const miss = targetOutcomeIsMiss(cue, path.targetId)
    const horizontal = new THREE.Vector3(path.to.x - path.from.x, 0, path.to.z - path.from.z)
    const direction = horizontal.lengthSq() > 1e-8 ? horizontal.normalize() : new THREE.Vector3(1, 0, 0)
    const side = new THREE.Vector3(direction.z, 0, -direction.x)
    const sign = path.index % 2 ? -1 : 1
    // Промах проходит мимо цели и гаснет за ней: читается без вспышки.
    const end = miss
      ? path.to.clone().addScaledVector(direction, 1.15).addScaledVector(side, .55 * sign).add(new THREE.Vector3(0, -.22, 0))
      : path.to
    const fan = path.count > 1 ? (path.index - (path.count - 1) / 2) * look.spread : 0
    return { ...path, root, orb, halo, impact, flash, trail, miss, end, side, fan, seed: noise(path.index + 3) * Math.PI * 2 }
  })
  type Entry = typeof entries[number]
  const pathPoint = (entry: Entry, flight: number, target: THREE.Vector3) => {
    const eased = flight * flight * (3 - 2 * flight)
    target.lerpVectors(entry.from, entry.end, eased)
    const bow = Math.sin(flight * Math.PI)
    target.y += bow * entry.arc * look.arc
    const sway = entry.fan * bow + (cue.motion === 'reduced' ? 0 : look.wobble * Math.sin(flight * Math.PI * 3 + entry.seed) * bow)
    target.addScaledVector(entry.side, sway)
    return target
  }

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      lights.clear()
      let flightLight: THREE.Vector3 | null = null
      let impactLight: THREE.Vector3 | null = null
      let impactStrength = 0
      for (const entry of entries) {
        const flight = clamp01((progress - entry.phase) / Math.max(.01, entry.arrival - entry.phase))
        const position = pathPoint(entry, flight, scratchA)
        const fadeOut = entry.miss ? 1 - smoothstep(.72, 1, flight) : 1
        entry.orb.position.copy(position)
        entry.orb.scale.setScalar(Math.max(.05, fadeOut) * (1 + Math.sin(progress * 50 + entry.seed) * .08))
        entry.orb.visible = progress >= entry.phase && progress < entry.arrival && fadeOut > .04 && visible(map, { x: position.x, y: position.z })
        if (entry.halo) {
          entry.halo.position.copy(position)
          entry.halo.scale.setScalar(Math.max(.05, fadeOut))
          entry.halo.visible = entry.orb.visible
        }
        entry.trail.visible = entry.orb.visible
        if (entry.orb.visible) {
          const tail = pathPoint(entry, Math.max(0, flight - look.trailLength * (detail === 'minimal' ? .7 : 1)), scratchB)
          orientTrail(entry.trail, position, tail, .085 * look.size * Math.max(.2, fadeOut))
          if (look.flightLight && !flightLight) flightLight = scratchC.copy(position)
        }
        const hitPhase = clamp01((progress - entry.arrival) / .24)
        const impact = Math.sin(Math.PI * hitPhase)
        const landed = progress >= entry.arrival && impact > 0 && !entry.miss && visible(map, { x: entry.to.x, y: entry.to.z })
        entry.impact.position.copy(entry.to)
        entry.impact.scale.setScalar(.55 + easeOutCubic(hitPhase) * 1.6)
        entry.impact.visible = landed
        entry.flash.position.copy(entry.to)
        entry.flash.scale.setScalar(Math.max(.05, 1.6 * (1 - hitPhase) * (.4 + .6 * easeOutCubic(hitPhase / .25))))
        entry.flash.visible = landed && hitPhase < .9
        if (landed && (1 - hitPhase) > impactStrength) { impactStrength = 1 - hitPhase; impactLight = scratchD.copy(entry.to) }
      }
      if (flightLight) lights.add(flightLight, look.light, 2.2, 4)
      if (impactLight) lights.add(impactLight, look.light, (family === 'necrotic' ? 1.6 : 3.8) * impactStrength ** 1.5, family === 'necrotic' ? 3 : 4.5)
      if (progress >= 1) lights.clear()
      group.visible = entries.some(({ orb, trail, impact, flash }) => orb.visible || trail.visible || impact.visible || flash.visible)
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}

function beamPoints(cue: Extract<SpellAnimationCue, { kind: 'beam' }>, actors: readonly SpellEffectActor[]) {
  const source = actorFor(actors, cue.actorId)
  const from = cue.from ?? source
  if (!from) return [] as Array<{ point?: BoardPoint; actor?: SpellEffectActor | null; targetId?: string }>
  const result: Array<{ point?: BoardPoint; actor?: SpellEffectActor | null; targetId?: string }> = [{ point: from, actor: source }]
  if (cue.points?.length) {
    cue.targetIds.forEach((targetId, index) => result.push({ point: cue.points?.[index], actor: actorFor(actors, targetId), targetId }))
  } else {
    cue.targetIds.forEach((id) => {
      const actor = actorFor(actors, id)
      result.push({ point: actor ?? undefined, actor, targetId: id })
    })
  }
  return result
}

type BeamPoint = { point?: BoardPoint; actor?: SpellEffectActor | null; targetId?: string }
type LineSegment = { from: THREE.Vector3; midpoint: THREE.Vector3; to: THREE.Vector3; targetId?: string }

function lineSegments(
  points: ReadonlyArray<BeamPoint>,
  map: TacticalMap,
  chain: boolean,
  branchFromPrimary = false,
  pronouncedCurve = false,
) {
  const pairs = branchFromPrimary && points.length > 2
    ? points.slice(1).map((next, index) => ({ entry: index === 0 ? points[0] : points[1], next }))
    : points.slice(0, chain ? points.length : Math.min(points.length, 2) - 1)
      .map((entry, index) => ({ entry, next: points[index + 1] }))
  return pairs
    .map(({ entry, next }, index): LineSegment | null => {
      if (!next?.point || !entry?.point || !visible(map, entry.point) || !visible(map, next.point) || !visiblePath(map, entry.point, next.point)) return null
      const from = visualPoint(map, entry.point, entry.actor, .82)
      const to = visualPoint(map, next.point, next.actor, .82)
      const midpoint = from.clone().lerp(to, .5)
      const lateral = new THREE.Vector3(to.z - from.z, 0, -(to.x - from.x)).normalize().multiplyScalar((pronouncedCurve ? .95 : .12) + (index % 2) * (pronouncedCurve ? .14 : .05))
      midpoint.add(lateral)
      if (pronouncedCurve) midpoint.y += .3
      return { from, midpoint, to, targetId: next.targetId }
    })
    .filter((segment): segment is LineSegment => Boolean(segment))
}

function createLineEffect(
  cue: SpellAnimationCue,
  segments: readonly LineSegment[],
  map: TacticalMap,
  detail: SpellEffectDetail,
): SpellEffect3D | null {
  if (!segments.length) return null
  const { geometries, materials, track, material } = resources()
  const group = new THREE.Group()
  const lights = effectLightRig(group, detail)
  const style = styleFor(cue)
  const lightning = String(style.family) === 'lightning'
  const psychicWhip = style.visualVariant === 'psychic-whip'
  const tube = !lightning && !psychicWhip
  const outerColor = lightning ? '#1b77ba' : style.secondary
  const coreColor = lightning ? '#9ceeff' : style.primary
  const lightColor = lightning ? '#a8dcff' : String(style.family) === 'necrotic' ? '#8a7dff' : style.primary
  const outer = material(new THREE.LineBasicMaterial({ color: outerColor, transparent: true, opacity: lightning ? .22 : .35, blending: THREE.AdditiveBlending, depthWrite: false }))
  const core = material(new THREE.LineBasicMaterial({ color: coreColor, transparent: true, opacity: lightning ? .62 : .95, blending: THREE.AdditiveBlending, depthWrite: false }))
  const hitMaterial = material(additive(glow(lightning ? '#d6fbff' : style.secondary, 1.8), .8))
  const hitGeometry = track(new THREE.TorusGeometry(.16, .018, 5, detail === 'full' ? 14 : 9))
  const flashMaterial = material(additive(glow(lightning ? '#f2fdff' : style.secondary, 2.6), .9))
  const flashGeometry = track(new THREE.SphereGeometry(.2, detail === 'full' ? 10 : 7, 5))
  // Молния: тонкое ядро ярче порога bloom и широкий бледный ореол вокруг.
  const lightningOuterMaterial = lightning ? material(additive(glow('#3d9dff', 1.1), .34)) : null
  const lightningCoreMaterial = lightning ? material(additive(glow('#eafcff', 3.4), 1)) : null
  const lightningGeometry = lightning ? track(new THREE.CylinderGeometry(.03, .03, 1, 6)) : null
  const lightningBranchGeometry = lightning ? track(new THREE.CylinderGeometry(.018, .018, 1, 5)) : null
  const tubeCoreMaterial = tube ? material(additive(glow(style.secondary, 2.2), .95)) : null
  const tubeGlowMaterial = tube && detail !== 'minimal' ? material(additive(glow(style.primary, 1.1), .3)) : null
  const tubeGeometry = tube ? track(new THREE.CylinderGeometry(.028, .028, 1, 6)) : null
  const whipMaterial = psychicWhip
    ? material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .92, blending: THREE.NormalBlending, depthWrite: false }))
    : null
  const whipGeometry = psychicWhip
    ? track(new THREE.CylinderGeometry(.05, .05, 1, detail === 'full' ? 7 : 6))
    : null
  const pieceCount = detail === 'full' ? 6 : detail === 'reduced' ? 4 : 2
  const rerolls = detail === 'full' ? 7 : detail === 'reduced' ? 5 : 3
  const lines = segments.map(({ from, midpoint, to, targetId }, segmentIndex) => {
    const miss = targetOutcomeIsMiss(cue, targetId)
    const horizontal = new THREE.Vector3(to.x - from.x, 0, to.z - from.z)
    const direction = horizontal.lengthSq() > 1e-8 ? horizontal.clone().normalize() : new THREE.Vector3(1, 0, 0)
    const side = new THREE.Vector3(direction.z, 0, -direction.x)
    // Промах уходит мимо фигуры, а не упирается в неё без вспышки.
    const end = miss ? to.clone().addScaledVector(direction, .9).addScaledVector(side, .5) : to
    const line = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([from, from, from])), core)
    group.add(line)
    const glowLine = detail === 'minimal' ? null : new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([from, from, from])), outer)
    if (glowLine) group.add(glowLine)
    const hit = new THREE.Mesh(hitGeometry, hitMaterial)
    hit.rotation.x = -Math.PI / 2
    hit.position.copy(to)
    group.add(hit)
    const flash = new THREE.Mesh(flashGeometry, flashMaterial)
    flash.position.copy(to)
    group.add(flash)
    const jagged = lightning ? Array.from({ length: pieceCount + 1 }, () => new THREE.Vector3()) : []
    const lightningPieces = lightning
      ? Array.from({ length: pieceCount }, (_, pieceIndex) => {
        const outerPiece = new THREE.Mesh(lightningGeometry!, lightningOuterMaterial!)
        const corePiece = new THREE.Mesh(lightningGeometry!, lightningCoreMaterial!)
        group.add(outerPiece, corePiece)
        return { outer: outerPiece, core: corePiece, pieceIndex }
      })
      : []
    const branches = lightning && detail !== 'minimal'
      ? Array.from({ length: detail === 'full' ? 2 : 1 }, (_, branchIndex) => {
        const branch = new THREE.Mesh(lightningBranchGeometry!, lightningCoreMaterial!)
        group.add(branch)
        return { branch, branchIndex, anchor: 1, end: new THREE.Vector3() }
      })
      : []
    const tubePieces = tube
      ? [0, 1].map(() => {
        const coreTube = new THREE.Mesh(tubeGeometry!, tubeCoreMaterial!)
        const glowTube = tubeGlowMaterial ? new THREE.Mesh(tubeGeometry!, tubeGlowMaterial) : null
        group.add(coreTube)
        if (glowTube) group.add(glowTube)
        return { core: coreTube, glow: glowTube }
      })
      : []
    const whipPieces = psychicWhip
      ? Array.from({ length: detail === 'full' ? 8 : 6 }, () => {
        const mesh = new THREE.Mesh(whipGeometry!, whipMaterial!)
        group.add(mesh)
        return mesh
      })
      : []
    return { line, glow: glowLine, hit, flash, from, midpoint, to, end, miss, side, targetId, jagged, lightningPieces, branches, tubePieces, whipPieces, seed: segmentIndex * 31.7 + 5, bucket: -1 }
  })
  type LineEntry = typeof lines[number]
  const boltDirection = new THREE.Vector3()
  const lightPoint = new THREE.Vector3()
  /** Новый зигзаг молнии: перерисовывается несколько раз за эффект. */
  const rollBolt = (entry: LineEntry, bucket: number) => {
    entry.bucket = bucket
    const count = entry.jagged.length - 1
    boltDirection.subVectors(entry.end, entry.from)
    const length = boltDirection.length()
    const amplitude = Math.min(.34, .1 + length * .03)
    for (const [index, point] of entry.jagged.entries()) {
      point.lerpVectors(entry.from, entry.end, index / count)
      if (index === 0 || index === count) continue
      const lateral = (noise(entry.seed + index * 7.13 + bucket * 13.71) - .5) * 2 * amplitude
      point.addScaledVector(entry.side, lateral)
      point.y += (noise(entry.seed + index * 3.91 + bucket * 5.37) - .5) * amplitude * .8
    }
    for (const branch of entry.branches) {
      branch.anchor = 1 + Math.floor(noise(entry.seed + branch.branchIndex * 9.1 + bucket * 2.3) * Math.max(1, count - 1))
      const anchor = entry.jagged[Math.min(count - 1, branch.anchor)]
      const sideSign = branch.branchIndex % 2 ? -1 : 1
      branch.end.copy(anchor)
        .addScaledVector(entry.side, sideSign * (.24 + noise(entry.seed + bucket * 4.1 + branch.branchIndex) * .22))
        .addScaledVector(boltDirection, .12 / Math.max(.001, length))
      branch.end.y -= .12 + noise(entry.seed + bucket * 1.7) * .14
    }
  }

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      lights.clear()
      // Короткая подготовка делает луч читаемым как cast → flight → hit.
      const segmentProgress = clamp01((progress - .08) / .84) * lines.length
      const bucket = Math.min(rerolls - 1, Math.floor(progress * rerolls))
      const flicker = lightning ? .55 + .45 * noise(bucket * 3.31 + 1) : 1
      const lightningFade = 1 - smoothstep(.84, 1, progress)
      if (lightningCoreMaterial && lightningOuterMaterial) {
        lightningCoreMaterial.opacity = flicker * lightningFade
        lightningOuterMaterial.opacity = .34 * flicker * lightningFade
      }
      let lightAt: THREE.Vector3 | null = null
      let lightStrength = 0
      lines.forEach((entry, index) => {
        const { line, glow: glowLine, hit, flash, from, midpoint, end, jagged, lightningPieces, branches, tubePieces, whipPieces } = entry
        const local = clamp01(segmentProgress - index)
        const current = local < .5
          ? scratchA.lerpVectors(from, midpoint, local * 2)
          : scratchA.lerpVectors(midpoint, end, (local - .5) * 2)
        setLinePoints(line, from, local < .5 ? current : midpoint, current)
        if (glowLine) setLinePoints(glowLine, from, local < .5 ? current : midpoint, current)
        line.visible = !psychicWhip && !lightning && local > 0 && visible(map, { x: current.x, y: current.z })
        if (glowLine) glowLine.visible = line.visible
        if (tubePieces.length) {
          const [first, second] = tubePieces
          const firstEnd = local < .5 ? current : midpoint
          orientCylinder(first.core, from, firstEnd)
          first.core.visible = line.visible
          orientCylinder(second.core, midpoint, current)
          second.core.visible = line.visible && local > .5
          for (const piece of tubePieces) if (piece.glow) {
            piece.glow.position.copy(piece.core.position)
            piece.glow.quaternion.copy(piece.core.quaternion)
            piece.glow.scale.set(3.2, piece.core.scale.y, 3.2)
            piece.glow.visible = piece.core.visible
          }
        }
        if (whipPieces.length) {
          for (const [pieceIndex, piece] of whipPieces.entries()) {
            const pieceProgress = clamp01(local * whipPieces.length - pieceIndex)
            const startT = pieceIndex / whipPieces.length
            const endT = (pieceIndex + 1) / whipPieces.length
            const curvePoint = (t: number, target: THREE.Vector3) => {
              const inverse = 1 - t
              return target.copy(from).multiplyScalar(inverse * inverse)
                .addScaledVector(midpoint, 2 * inverse * t)
                .addScaledVector(end, t * t)
            }
            const pieceStart = curvePoint(startT, scratchB)
            const pieceEnd = curvePoint(startT + (endT - startT) * pieceProgress, scratchC)
            orientCylinder(piece, pieceStart, pieceEnd)
            piece.visible = pieceProgress > 0 && visible(map, { x: pieceEnd.x, y: pieceEnd.z })
          }
        }
        let struck = local > .72
        let strike = clamp01((local - .72) / .28)
        if (lightningPieces.length) {
          if (entry.bucket !== bucket) rollBolt(entry, bucket)
          // Разряд долетает почти мгновенно, затем держится и мерцает.
          const reveal = clamp01(local / .22)
          struck = reveal >= 1
          strike = clamp01((local - .22) / .4)
          for (const piece of lightningPieces) {
            const pieceProgress = clamp01(reveal * lightningPieces.length - piece.pieceIndex)
            const pieceStart = jagged[piece.pieceIndex]
            const pieceEnd = jagged[piece.pieceIndex + 1]
            const pieceCurrent = scratchB.lerpVectors(pieceStart, pieceEnd, pieceProgress)
            orientCylinder(piece.core, pieceStart, pieceCurrent)
            orientCylinder(piece.outer, pieceStart, pieceCurrent, 3.4)
            piece.outer.visible = piece.core.visible = pieceProgress > 0 && lightningFade > .02 && visible(map, { x: pieceCurrent.x, y: pieceCurrent.z })
          }
          for (const branch of branches) {
            const anchor = jagged[Math.min(jagged.length - 2, branch.anchor)]
            orientCylinder(branch.branch, anchor, branch.end)
            branch.branch.visible = struck && lightningFade > .02 && (bucket + branch.branchIndex) % 2 === 0 && visible(map, { x: branch.end.x, y: branch.end.z })
          }
          if (local > 0 && lightningFade > .02) {
            const strength = flicker * lightningFade
            if (strength > lightStrength) { lightStrength = strength; lightAt = lightPoint.copy(struck ? entry.end : jagged[Math.min(jagged.length - 1, Math.ceil(reveal * (jagged.length - 1)))]) }
          }
        }
        const hitVisible = struck && local < 1 && !entry.miss && visible(map, { x: entry.to.x, y: entry.to.z })
        hit.position.copy(entry.to)
        hit.scale.setScalar(.55 + Math.sin(Math.PI * strike) * .85)
        hit.visible = hitVisible || (lightning && struck && !entry.miss && lightningFade > .02 && visible(map, { x: entry.to.x, y: entry.to.z }))
        flash.position.copy(entry.to)
        flash.scale.setScalar(Math.max(.05, 1.5 * (1 - strike) * (.45 + .55 * easeOutCubic(strike / .2))))
        flash.visible = hit.visible && strike < .95
        if (!lightning && flash.visible && 1 - strike > lightStrength) { lightStrength = 1 - strike; lightAt = lightPoint.copy(entry.to) }
      })
      if (lightAt) lights.add(lightAt, lightColor, lightning ? 4.6 * lightStrength : 3 * lightStrength ** 1.5, lightning ? 5 : 4)
      if (lightning && lightStrength > 0) lights.add(lines[0].from, lightColor, 1.8 * lightStrength, 3.5)
      if (progress >= 1) lights.clear()
      group.visible = lines.some(({ line, hit, flash, lightningPieces, branches, tubePieces, whipPieces }) => line.visible || hit.visible || flash.visible || lightningPieces.some((piece) => piece.outer.visible) || branches.some(({ branch }) => branch.visible) || tubePieces.some((piece) => piece.core.visible) || whipPieces.some((piece) => piece.visible))
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}

function createBeam(
  cue: Extract<SpellAnimationCue, { kind: 'beam' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  const pronouncedCurve = spellEffectPalette(cue.spellId, { school: cue.school, damageType: cue.damageType }).visualVariant === 'psychic-whip'
  return createLineEffect(cue, lineSegments(beamPoints(cue, actors), map, cue.chain, cue.chain && cue.spellId === 'chain-lightning', pronouncedCurve), map, detailOf(cue))
}

function createBurstLine(
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  const source = actorFor(actors, cue.actorId)
  const origin = cue.origin ?? source
  if (!origin) return null
  // Видимость проверяется по тем же клеткам, что рисуются: луч сервера идёт
  // по одному из восьми направлений, а не по прямой до кликнутой клетки.
  const cells = burstCellsWithoutFog(map, cue, actors)
  const chebyshev = (point: BoardPoint) => Math.max(Math.abs(point.x - origin.x), Math.abs(point.y - origin.y))
  // Рисуется непрерывный от заклинателя отрезок до первой скрытой клетки.
  let end: BoardPoint | undefined
  for (const cell of [...cells].sort((left, right) => chebyshev(left) - chebyshev(right))) {
    if (!cellAt(map, Math.floor(cell.x), Math.floor(cell.y)) || !revealedAt(map, Math.floor(cell.x), Math.floor(cell.y))) break
    end = cell
  }
  if (!end) return null
  return createLineEffect(cue, lineSegments([
    { point: origin, actor: source },
    { point: end, actor: null },
  ], map, false), map, detailOf(cue))
}

function orientCylinder(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, radius = 1) {
  const direction = scratchD.subVectors(to, from)
  const length = Math.max(.001, direction.length())
  mesh.position.copy(from).add(to).multiplyScalar(.5)
  mesh.scale.set(radius, length, radius)
  if (length > .001) mesh.quaternion.setFromUnitVectors(UP, direction.multiplyScalar(1 / length))
}

function sampledCells(cells: readonly BoardPoint[], maximum: number) {
  if (cells.length <= maximum) return [...cells]
  const result: BoardPoint[] = []
  for (let index = 0; index < maximum; index += 1) result.push(cells[Math.floor(index * cells.length / maximum)])
  return result
}

function areaCellGeometry(shape: Extract<SpellAnimationCue, { kind: 'burst' }>['shape'], detail: SpellEffectDetail, family: string) {
  const segments = detail === 'full' ? 10 : detail === 'reduced' ? 7 : 5
  if (family === 'earth') return new THREE.DodecahedronGeometry(.35, 0)
  if (family === 'wind') return new THREE.TorusGeometry(.28, .045, 5, segments)
  if (family === 'water') return new THREE.CylinderGeometry(.3, .38, .28, segments)
  if (family === 'swarm') return new THREE.IcosahedronGeometry(.28, 0)
  if (family === 'weapon') return new THREE.BoxGeometry(.72, .12, .18)
  if (shape === 'line') return new THREE.BoxGeometry(.82, .14, .3)
  if (shape === 'cube') return new THREE.BoxGeometry(.84, .2, .84)
  if (shape === 'cylinder') return new THREE.CylinderGeometry(.37, .37, .22, segments)
  if (shape === 'cone') return new THREE.ConeGeometry(.38, .62, segments)
  return new THREE.SphereGeometry(.34, segments, Math.max(4, Math.floor(segments / 2)))
}

function createAreaBurst(
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  if (cue.shape === 'line' && cue.originMode === 'self') return createBurstLine(cue, actors, map)
  const footprint = burstFootprint(map, cue, actors)
  // Частично скрытый footprint остаётся в точном Canvas-слое. 3D не дорисовывает
  // недостающую половину выдуманной сферой или кубом.
  if (!footprint.present.length || footprint.fogged || !footprint.visible.length) return null
  const detail = detailOf(cue)
  const cells = sampledCells(footprint.visible, detail === 'full' ? 36 : detail === 'reduced' ? 24 : 10)
  const { geometries, materials, track, material } = resources()
  const group = new THREE.Group()
  const style = styleFor(cue)
  const lights = effectLightRig(group, detail)
  // Стихийная область подсвечивает пол в момент удара; прочие школы — без света.
  const areaFamily = String(style.family)
  const areaLight = areaFamily === 'fire' ? '#ff8a3a' : areaFamily === 'lightning' ? '#a8dcff' : areaFamily === 'radiant' ? '#ffe2a0'
    : areaFamily === 'cold' ? '#bfeeff' : areaFamily === 'thunder' ? '#c9a8ff' : areaFamily === 'necrotic' ? '#8a7dff' : null
  const areaMaterial = material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .1, blending: THREE.AdditiveBlending, depthWrite: false, wireframe: cue.shape === 'cube' }))
  const geometry = track(areaCellGeometry(cue.shape, detail, String(style.family)))
  const markers = cells.map((cell, index) => {
    const marker = new THREE.Mesh(geometry, areaMaterial)
    marker.position.set(cell.x + .5, terrainHeightAt(map, cell.x, cell.y) + .14, cell.y + .5)
    marker.rotation.y = (index % 4) * Math.PI / 2
    if (String(style.family) === 'wind') marker.rotation.x = Math.PI / 2
    if (String(style.family) === 'weapon') marker.rotation.y += Math.PI / 4
    group.add(marker)
    return marker
  })
  const center = cue.center ?? cells[Math.floor(cells.length / 2)]
  const jet = cue.shape === 'cone' && cue.originMode === 'self'
    ? createConeJet(cue, actors, map, style, detail, track, material, group)
    : null
  // Кольцо повторяет серверную область. circle-grid-v2 — круг радиуса r клеток
  // с центром на пересечении сетки; старая сфера — чебышёвский квадрат 2r+1
  // клеток, то есть контур с полушириной r+0.5 вокруг центра клетки.
  const roundArea = cue.shape === 'sphere' || cue.shape === 'cylinder'
  const circleGrid = roundArea && cue.geometryVersion === 'circle-grid-v2'
  const maximumCells = Math.max(4, map.width, map.height)
  const extent = circleGrid
    ? Math.max(.6, Math.min(maximumCells, Number(cue.sizeFeet) / 5 || 1))
    : Math.min(maximumCells, Math.max(0, Math.floor(Number(cue.sizeFeet) / 5) || 0)) + .5
  const ringCenter = !roundArea || !center ? null
    : circleGrid ? { x: (cue.gridOrigin ?? center).x, y: (cue.gridOrigin ?? center).y }
      : { x: center.x + .5, y: center.y + .5 }
  const ring = ringCenter
    ? new THREE.Mesh(track(circleGrid
      ? new THREE.TorusGeometry(extent, .025, 6, Math.min(96, Math.max(detail === 'full' ? 24 : 14, Math.ceil(extent * (detail === 'full' ? 10 : 6)))))
      : squareOutlineGeometry(extent, .025)), areaMaterial)
    : null
  if (ring) { ring.rotation.x = -Math.PI / 2; group.add(ring) }
  const baseHeight = ringCenter ? terrainHeightAt(map, ringCenter.x, ringCenter.y) : 0
  const visibleExtent = !ringCenter ? extent
    : circleGrid ? visibleRadius(map, ringCenter, extent) : visibleSquareHalfWidth(map, ringCenter, extent)
  const areaCenter = new THREE.Vector3()
  for (const cell of cells) areaCenter.add(scratchA.set(cell.x + .5, terrainHeightAt(map, cell.x, cell.y) + 1, cell.y + .5))
  areaCenter.multiplyScalar(1 / Math.max(1, cells.length))
  const areaSpan = cells.reduce((maximum, cell) => Math.max(maximum, Math.hypot(cell.x + .5 - areaCenter.x, cell.y + .5 - areaCenter.z)), 0)

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      const reveal = clamp01((progress - .08) / .28)
      const impact = clamp01((progress - .22) / .28)
      const fade = Math.sin(Math.PI * clamp01(progress))
      lights.clear()
      areaMaterial.opacity = (.12 + impact * .42) * Math.max(.35, fade)
      if (areaLight && progress < 1) lights.add(areaCenter, areaLight, 3.2 * Math.sin(Math.PI * clamp01((progress - .18) / .7)), areaSpan + 2.5)
      for (const [index, marker] of markers.entries()) {
        marker.visible = progress > .04 && progress < .96
        marker.scale.setScalar(.35 + reveal * (.65 + (index % 3) * .08))
        marker.position.y = terrainHeightAt(map, cells[index].x, cells[index].y) + .1 + reveal * .16
      }
      if (ringCenter && ring) {
        ring.position.set(ringCenter.x, baseHeight + .06, ringCenter.y)
        ring.scale.setScalar(Math.max(.1, visibleExtent / Math.max(.1, extent)) * (.5 + impact * .5))
        ring.visible = progress > .12 && progress < .96
      }
      jet?.update(progress)
      group.visible = markers.some((marker) => marker.visible) || Boolean(ring?.visible) || Boolean(jet?.visible)
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((entry) => entry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}

/** Детерминированный «шум» частицы: тот же кадр выглядит одинаково при повторе. */
const jetNoise = (index: number, salt: number) => {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453
  return value - Math.floor(value)
}

/**
 * Язык дыхания или конусного заклинания: поток раскалённых частиц из пасти
 * вдоль серверного конуса. Полуугол — 26,6°: у конуса D&D ширина на конце
 * равна длине. Клетки области по-прежнему рисует общий слой маркеров, язык
 * только показывает, откуда и куда ударило.
 */
function createConeJet(
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
  style: SpellStyle,
  detail: SpellEffectDetail,
  track: <T extends THREE.BufferGeometry>(geometry: T) => T,
  material: <T extends THREE.Material>(value: T) => T,
  group: THREE.Group,
) {
  const source = cue.origin ?? actorFor(actors, cue.actorId)
  const target = cue.center
  if (!source || !target || !visible(map, source)) return null
  const lengthCells = Math.max(1, Math.min(24, (Number(cue.sizeFeet) || 15) / 5))
  const from = new THREE.Vector3(source.x + .5, terrainHeightAt(map, source.x, source.y) + .75, source.y + .5)
  const direction = new THREE.Vector3(target.x - source.x, 0, target.y - source.y)
  if (direction.lengthSq() < .0001) return null
  direction.normalize()
  const side = new THREE.Vector3(-direction.z, 0, direction.x)
  const halfAngle = Math.atan(.5)
  const count = detail === 'full' ? 110 : detail === 'reduced' ? 60 : 20
  const geometry = track(new THREE.IcosahedronGeometry(.2, 1))
  // Горячая ось — светлый второй цвет палитры, тело — основной, края языка —
  // тёмный основной: три материала на весь поток.
  const core = material(new THREE.MeshBasicMaterial({ color: new THREE.Color(style.secondary).lerp(new THREE.Color('#fff4d0'), .25), transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false }))
  const body = material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .6, blending: THREE.AdditiveBlending, depthWrite: false }))
  const edge = material(new THREE.MeshBasicMaterial({ color: new THREE.Color(style.primary).multiplyScalar(.5), transparent: true, opacity: .35, blending: THREE.AdditiveBlending, depthWrite: false }))
  const particles = Array.from({ length: count }, (_, index) => {
    const angle = (jetNoise(index, 2) * 2 - 1) * halfAngle
    // Материал закреплён за частицей: ось языка горячее его краёв.
    const offAxis = Math.abs(angle) / halfAngle
    const mesh = new THREE.Mesh(geometry, offAxis < .3 ? core : offAxis < .75 ? body : edge)
    mesh.visible = false
    group.add(mesh)
    return {
      mesh,
      spawn: jetNoise(index, 1) * .5,
      angle,
      reach: .8 + jetNoise(index, 3) * .25,
      lift: jetNoise(index, 4),
      spin: jetNoise(index, 5) * Math.PI * 2,
    }
  })
  const LIFETIME = .42
  const point = new THREE.Vector3()
  const result = {
    visible: false,
    update(progress: number) {
      let any = false
      for (const particle of particles) {
        const age = (progress - .06 - particle.spawn) / LIFETIME
        const alive = age > 0 && age < 1
        particle.mesh.visible = alive
        if (!alive) continue
        any = true
        // Частица летит быстро и тормозит к концу языка, расходясь по углу.
        const travel = (1 - (1 - age) * (1 - age)) * lengthCells * particle.reach
        const spread = Math.sin(particle.angle * Math.min(1, .35 + age))
        point.copy(direction).multiplyScalar(travel * Math.cos(particle.angle))
          .addScaledVector(side, travel * spread)
        particle.mesh.position.copy(from).add(point)
        particle.mesh.position.y += Math.sin(age * Math.PI) * (.25 + particle.lift * .35) - age * .35
        const swell = (.5 + age * 2.2) * (1 - age * age * .5)
        particle.mesh.scale.setScalar(swell)
        particle.mesh.rotation.set(particle.spin + age * 3, particle.spin * .5, 0)
      }
      result.visible = any
    },
  }
  return result
}

function createAura(
  cue: Extract<SpellAnimationCue, { kind: 'aura' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  const carrierActor = actorFor(actors, cue.actorId)
  const anchor = cue.center ?? carrierActor
  if (!anchor || !visible(map, anchor)) return null
  const detail = detailOf(cue)
  const style = styleFor(cue)
  const family = String(style.family)
  const behavior = style.behavior
  const { geometries, materials, track, material } = resources()
  const group = new THREE.Group()
  const lights = effectLightRig(group, detail)
  // Аура считается от всей площади носителя: сервер меряет чебышёвскую
  // дистанцию между площадями, поэтому её граница — квадрат с полушириной
  // r + size/2 вокруг центра площади, а не круг радиуса r от anchor+0.5.
  const size = carrierActor ? actorPresentationSize(map, carrierActor, anchor) : 1
  const center = carrierActor ? actorPresentationCenter(map, carrierActor, anchor) : { x: anchor.x + .5, y: anchor.y + .5 }
  const concentration = cue.auraType === 'concentration'
  const radius = concentration ? .48 * size : Math.max(.65, Number(cue.radiusFeet) / 5 || 1) + size / 2
  const visibleArea = concentration ? visibleRadius(map, center, radius) : visibleSquareHalfWidth(map, center, radius)
  const segments = detail === 'full' ? 16 : 10
  const bodyMaterial = material(additive(style.primary, .22, { wireframe: true }))
  const accentMaterial = material(additive(glow(style.secondary, 1.5), .78))
  const floorMaterial = material(additive(style.primary, .1))
  const waveMaterial = material(additive(glow(style.secondary, 1.3), .6))
  // Ограждение — гранёный щит из крупных граней, прочие школы — гладкий купол.
  const domeGeometry = behavior === 'dome'
    ? new THREE.SphereGeometry(1, 7, 4)
    : new THREE.SphereGeometry(1, segments, detail === 'full' ? 9 : 6)
  const dome = new THREE.Mesh(track(domeGeometry), bodyMaterial)
  dome.scale.set(visibleArea, Math.max(.35, visibleArea * .62), visibleArea)
  const edgeGeometry = track(concentration
    ? new THREE.TorusGeometry(visibleArea, .028, 6, detail === 'full' ? 28 : 16)
    : squareOutlineGeometry(visibleArea, .028))
  const ring = new THREE.Mesh(edgeGeometry, accentMaterial)
  ring.rotation.x = -Math.PI / 2
  group.add(dome, ring)
  // Заливка пола делает границу читаемой и на пёстрой фактуре.
  const floor = new THREE.Mesh(track(concentration
    ? new THREE.CircleGeometry(visibleArea, detail === 'full' ? 28 : 16)
    : new THREE.PlaneGeometry(visibleArea * 2, visibleArea * 2)), floorMaterial)
  floor.rotation.x = -Math.PI / 2
  group.add(floor)
  // Волна от носителя к краю: аура «включается» и показывает свою площадь.
  const wave = detail === 'minimal' ? null : new THREE.Mesh(edgeGeometry, waveMaterial)
  if (wave) { wave.rotation.x = -Math.PI / 2; group.add(wave) }
  const count = detail === 'full' ? 6 : detail === 'reduced' ? 4 : 2
  const inward = behavior === 'inward'
  const runes = behavior === 'focus'
  // Некромантия: тени тянутся вниз; прорицание: знаки-руны обходят границу;
  // остальные школы — несколько поднимающихся искр.
  const shadowMaterial = inward ? material(new THREE.MeshBasicMaterial({ color: new THREE.Color(style.primary).multiplyScalar(.35), transparent: true, opacity: .6, depthWrite: false })) : null
  const motifGeometry = track(inward
    ? new THREE.ConeGeometry(.07, .62, 5)
    : runes ? new THREE.BoxGeometry(.2, .025, .1) : new THREE.IcosahedronGeometry(.05, 0))
  const particles = Array.from({ length: count }, (_, index) => {
    const mesh = new THREE.Mesh(motifGeometry, shadowMaterial ?? accentMaterial)
    if (inward) mesh.rotation.x = Math.PI
    group.add(mesh)
    return { mesh, angle: index * Math.PI * 2 / count, phase: index / count }
  })
  const ground = carrierActor ? actorGroundHeight(map, carrierActor, anchor) : terrainHeightAt(map, anchor.x, anchor.y)
  const centerWorld = new THREE.Vector3(center.x, ground, center.y)
  const lightPoint = new THREE.Vector3(center.x, ground + 1.2, center.y)
  const lightColor = family === 'radiant' || family === 'light' || family === 'healing' ? '#ffe2a6'
    : family === 'necrotic' || family === 'darkness' ? '#8a7dff'
      : family === 'fire' ? '#ff8a3a' : null
  const still = cue.motion === 'reduced'

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      lights.clear()
      const fade = cue.active === false ? 1 - progress : Math.sin(Math.PI * progress)
      const pulse = still ? 1 : .94 + Math.sin(progress * Math.PI * 2) * .06
      dome.position.set(centerWorld.x, centerWorld.y + Math.max(.3, visibleArea * .4), centerWorld.z)
      dome.rotation.y = still ? 0 : progress * .6
      ring.position.set(centerWorld.x, centerWorld.y + .05, centerWorld.z)
      ring.scale.setScalar(pulse)
      floor.position.set(centerWorld.x, centerWorld.y + .03, centerWorld.z)
      // Граница и заливка несут смысл, купол — только намёк на объём.
      bodyMaterial.opacity = fade * (behavior === 'dome' ? .2 : .07)
      accentMaterial.opacity = fade * .85
      floorMaterial.opacity = fade * .09
      dome.visible = fade > .015 && visibleArea > .3
      ring.visible = floor.visible = dome.visible
      if (wave) {
        const sweep = still ? 1 : clamp01(progress / .45)
        wave.position.set(centerWorld.x, centerWorld.y + .07, centerWorld.z)
        wave.scale.setScalar(Math.max(.05, .12 + .88 * easeOutCubic(sweep)))
        waveMaterial.opacity = .7 * (1 - sweep) * fade
        wave.visible = dome.visible && sweep < 1
      }
      const spin = still ? 0 : progress * Math.PI * (runes ? 1 : 2)
      for (const particle of particles) {
        const phase = still ? .5 : clamp01(progress * 1.2 - particle.phase * .2)
        const angle = particle.angle + spin
        const reach = visibleArea * (inward ? .92 - phase * .18 : .86)
        const height = inward ? .9 - phase * .75 : runes ? .32 + Math.sin(angle * 2) * .06 : .08 + phase * Math.max(.22, visibleArea * .72)
        particle.mesh.position.set(centerWorld.x + Math.cos(angle) * reach, ground + height, centerWorld.z + Math.sin(angle) * reach)
        if (runes) particle.mesh.rotation.y = -angle
        particle.mesh.visible = dome.visible && (runes || (phase > 0 && phase < 1))
      }
      if (shadowMaterial) shadowMaterial.opacity = .6 * fade
      if (lightColor && dome.visible) lights.add(lightPoint, lightColor, (lightColor === '#8a7dff' ? .9 : 1.5) * fade, Math.max(3, visibleArea + 1.5))
      if (progress >= 1) lights.clear()
      group.visible = dome.visible || particles.some(({ mesh }) => mesh.visible)
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((entry) => entry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}

function createHealing(
  cue: Extract<SpellAnimationCue, { kind: 'channel' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  const targetActor = actorFor(actors, cue.targetId ?? cue.actorId)
  const target = cue.position ?? targetActor
  if (!target || !visible(map, target)) return null
  const detail = detailOf(cue)
  const { geometries, materials, track, material } = resources()
  const group = new THREE.Group()
  const lights = effectLightRig(group, detail)
  const style = styleFor(cue)
  const actor = cue.position ? null : targetActor
  const size = actor ? actorPresentationSize(map, actor, target) : 1
  const center = visualPoint(map, target, actor, .08)
  const ground = center.y - .08
  const segments = detail === 'full' ? 18 : 12
  const ringMaterial = material(additive(glow(style.primary, 1.6), .9))
  const columnMaterial = material(additive(glow(style.secondary, 1.3), .6, { vertexColors: true, side: THREE.DoubleSide }))
  const coreMaterial = material(additive(glow('#fff1c2', 2.2), .8, { vertexColors: true }))
  const moteMaterial = material(additive(glow('#fff4c8', 2.4), .9))
  // Кольцо у ног, мягкий столб света и несколько искр, поднимающихся вверх:
  // лечение читается как «свет приходит к цели», без облака частиц.
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(.38 * size, .022, 6, segments)), ringMaterial)
  ring.rotation.x = -Math.PI / 2
  group.add(ring)
  const column = new THREE.Mesh(track(fadeColumnGeometry(.4 * size, .3 * size, 1.7 + size * .2, segments)), columnMaterial)
  group.add(column)
  const core = detail === 'minimal' ? null : new THREE.Mesh(track(fadeColumnGeometry(.1 * size, .05 * size, 2, 8)), coreMaterial)
  if (core) group.add(core)
  const count = detail === 'full' ? 5 : detail === 'reduced' ? 3 : 2
  const moteGeometry = track(new THREE.OctahedronGeometry(.05, 0))
  const particles = Array.from({ length: count }, (_, index) => {
    const mesh = new THREE.Mesh(moteGeometry, moteMaterial)
    group.add(mesh)
    return { mesh, phase: index / count, angle: index * 2.17 }
  })
  const lightPoint = new THREE.Vector3(center.x, ground + 1, center.z)

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      lights.clear()
      const fade = Math.sin(progress * Math.PI)
      const rise = easeOutCubic(progress / .35)
      ring.position.set(center.x, ground + .06, center.z)
      ring.scale.setScalar(.7 + easeOutCubic(progress) * .55)
      ringMaterial.opacity = fade * .9
      column.position.set(center.x, ground + .02, center.z)
      column.scale.set(1, Math.max(.05, rise), 1)
      column.rotation.y = progress * 1.5
      columnMaterial.opacity = fade * .55
      column.visible = fade > .02
      if (core) {
        core.position.copy(column.position)
        core.scale.set(1, Math.max(.05, rise), 1)
        coreMaterial.opacity = fade * .8
        core.visible = column.visible
      }
      for (const particle of particles) {
        const lift = clamp01(progress * 1.25 - particle.phase * .22)
        particle.mesh.position.set(
          center.x + Math.cos(particle.angle + progress * Math.PI * 2) * (.16 + lift * .14) * size,
          ground + .1 + lift * 1.3,
          center.z + Math.sin(particle.angle + progress * Math.PI * 2) * (.16 + lift * .14) * size,
        )
        particle.mesh.scale.setScalar(1 - lift * .5)
        particle.mesh.visible = lift > 0 && lift < 1 && fade > .02
      }
      if (fade > .02) lights.add(lightPoint, '#ffd98a', 2.4 * fade, 3.5)
      if (progress >= 1) lights.clear()
      group.visible = visible(map, target) && fade > .01
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}

function createChannel(
  cue: Extract<SpellAnimationCue, { kind: 'channel' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  if (cue.channelType === 'healing') return createHealing(cue, actors, map)
  const style = styleFor(cue)
  const isTeleport = cue.channelType === 'teleport' || style.family === 'teleport'
  const sourceActor = actorFor(actors, cue.actorId)
  const source = isTeleport ? cue.from : sourceActor
  if (isTeleport && cue.from && !visible(map, cue.from)) return null
  const targetActor = actorFor(actors, cue.targetId ?? cue.actorId)
  const target = cue.position ?? targetActor ?? actorFor(actors, cue.actorId)
  if (!target || !visible(map, target)) return null
  const detail = detailOf(cue)
  const { geometries, materials, track, material } = resources()
  const group = new THREE.Group()
  const family = String(style.family)
  const variant = style.visualVariant
  const targetLocalVariant = variant === 'target-light' || variant === 'target-bell' || variant === 'psychic-shard' || variant === 'swarm-target'
  const mobilityVariant = family === 'mobility'
    && (variant === 'mobility-trail' || variant === 'mobility-arc' || variant === 'mobility-haste')
  const variantMaterial = variant
    ? material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: mobilityVariant ? .94 : .75, blending: mobilityVariant ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, wireframe: variant === 'silence' }))
    : null
  const bodyMaterial = material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .28, blending: family === 'darkness' ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, wireframe: family === 'control' || family === 'darkness' || variant === 'silence' }))
  const accentMaterial = material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: mobilityVariant ? .92 : .8, blending: mobilityVariant ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false }))
  const targetBodyMaterial = targetLocalVariant
    ? material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .6, blending: THREE.NormalBlending, depthWrite: false }))
    : bodyMaterial
  const targetAccentMaterial = targetLocalVariant
    ? material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: .9, blending: THREE.NormalBlending, depthWrite: false }))
    : accentMaterial
  const mobilityShadowMaterial = mobilityVariant
    ? material(new THREE.LineBasicMaterial({ color: '#271b15', transparent: true, opacity: .9, blending: THREE.NormalBlending, depthWrite: false }))
    : null
  const mobilityCoreMaterial = mobilityVariant
    ? material(new THREE.LineBasicMaterial({ color: style.secondary, transparent: true, opacity: .98, blending: THREE.NormalBlending, depthWrite: false }))
    : null
  const mobilityMarkShadowMaterial = mobilityVariant
    ? material(new THREE.MeshBasicMaterial({ color: '#271b15', transparent: true, opacity: .9, blending: THREE.NormalBlending, depthWrite: false }))
    : null
  const mobilityMarkCoreMaterial = mobilityVariant
    ? material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: .98, blending: THREE.NormalBlending, depthWrite: false }))
    : null
  const ground = terrainHeightAt(map, target.x, target.y)
  const center = visualPoint(map, target, cue.position ? null : targetActor, .08)
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(mobilityVariant ? .68 : .38, mobilityVariant ? .04 : .024, 6, detail === 'full' ? 20 : 12)), accentMaterial)
  ring.rotation.x = -Math.PI / 2
  group.add(ring)
  const shieldLike = variant !== 'cancellation' && variant !== 'soul-transfer'
    && (style.family === 'protection' || (style.family === 'control' && variant !== 'silence') || style.family === 'darkness')
  // Ограждение — гранёный щит: крупные грани и светящиеся рёбра вместо
  // гладкого пузыря.
  const faceted = style.family === 'protection'
  const domeGeometry = shieldLike
    ? track(faceted ? new THREE.SphereGeometry(.62, 7, 4) : new THREE.SphereGeometry(.62, detail === 'full' ? 14 : 9, detail === 'full' ? 8 : 5))
    : null
  const dome = domeGeometry ? new THREE.Mesh(domeGeometry, bodyMaterial) : null
  if (dome) { dome.scale.y = 1.35; group.add(dome) }
  const facetMaterial = faceted && dome && detail !== 'minimal'
    ? material(additive(glow(style.secondary, 1.4), .7, { wireframe: true }))
    : null
  const facets = facetMaterial ? new THREE.Mesh(domeGeometry!, facetMaterial) : null
  if (facets) group.add(facets)
  const portal = style.family === 'teleport' || style.family === 'summon'
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.48, .035, 6, detail === 'full' ? 20 : 12)), accentMaterial)
    : null
  if (portal) { portal.rotation.y = style.family === 'teleport' ? Math.PI / 2 : 0; group.add(portal) }
  const departurePortal = isTeleport && source
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.48, .035, 6, detail === 'full' ? 20 : 12)), accentMaterial)
    : null
  if (departurePortal) { departurePortal.rotation.y = Math.PI / 2; group.add(departurePortal) }
  const count = targetLocalVariant || variant === 'silence' || variant === 'cancellation' || variant === 'soul-transfer' ? 0 : detail === 'full' ? 5 : detail === 'reduced' ? 3 : 1
  const particles = Array.from({ length: count }, (_, index) => {
    const mesh = new THREE.Mesh(track(new THREE.IcosahedronGeometry(.05, 0)), accentMaterial)
    group.add(mesh)
    return { mesh, angle: index * Math.PI * 2 / count, phase: index / count }
  })
  const sourcePoint = source ? visualPoint(map, source, cue.from ? null : sourceActor, .6) : center.clone()
  const travelVisible = !isTeleport && Boolean(source && visiblePath(map, source, target))
  const travel = !isTeleport && travelVisible
    ? new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([sourcePoint, sourcePoint, sourcePoint])), accentMaterial)
    : null
  if (travel) group.add(travel)
  const ghostMaterial = family === 'illusion' || family === 'invisibility'
    ? material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: .28, blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true }))
    : null
  const ghostA = ghostMaterial ? new THREE.Mesh(track(new THREE.SphereGeometry(.42, detail === 'full' ? 12 : 8, 6)), ghostMaterial) : null
  const ghostB = ghostMaterial && family === 'illusion' ? new THREE.Mesh(track(new THREE.SphereGeometry(.34, detail === 'full' ? 10 : 7, 5)), ghostMaterial) : null
  if (ghostA) group.add(ghostA)
  if (ghostB) group.add(ghostB)
  const focusRay = family === 'divination'
    ? new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([center, center, center])), accentMaterial)
    : null
  if (focusRay) group.add(focusRay)
  const lightColumn = family === 'light'
    ? new THREE.Mesh(track(new THREE.ConeGeometry(.55, 1.5, detail === 'full' ? 10 : 6)), accentMaterial)
    : null
  if (lightColumn) group.add(lightColumn)
  const morphCube = family === 'transmutation'
    ? new THREE.Mesh(track(new THREE.BoxGeometry(.58, .58, .58)), bodyMaterial)
    : null
  const morphSphere = family === 'transmutation'
    ? new THREE.Mesh(track(new THREE.SphereGeometry(.42, detail === 'full' ? 12 : 8, 6)), accentMaterial)
    : null
  if (morphCube) group.add(morphCube)
  if (morphSphere) group.add(morphSphere)
  const flightRing = family === 'flight'
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.42, .025, 6, detail === 'full' ? 20 : 12)), accentMaterial)
    : null
  if (flightRing) { flightRing.rotation.z = Math.PI / 2; group.add(flightRing) }
  const familyWave = family === 'enchantment' || family === 'restoration' || family === 'environment' || family === 'utility'
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.48, .018, 5, detail === 'full' ? 20 : 12)), accentMaterial)
    : null
  if (familyWave) { familyWave.rotation.x = -Math.PI / 2; group.add(familyWave) }
  const targetLight = variant === 'target-light'
    ? new THREE.Mesh(track(new THREE.ConeGeometry(.28, 1.05, detail === 'full' ? 8 : 6)), targetAccentMaterial)
    : null
  if (targetLight) group.add(targetLight)
  const targetBell = variant === 'target-bell'
    ? new THREE.Mesh(track(new THREE.CylinderGeometry(.25, .4, .4, detail === 'full' ? 10 : 7)), targetBodyMaterial)
    : null
  const targetBellRim = variant === 'target-bell'
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.4, .035, 6, detail === 'full' ? 16 : 10)), targetAccentMaterial)
    : null
  const targetBellGroundRim = variant === 'target-bell'
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.65, .035, 6, detail === 'full' ? 22 : 14)), targetAccentMaterial)
    : null
  if (targetBell) group.add(targetBell)
  if (targetBellRim) { targetBellRim.rotation.x = -Math.PI / 2; group.add(targetBellRim) }
  if (targetBellGroundRim) { targetBellGroundRim.rotation.x = -Math.PI / 2; group.add(targetBellGroundRim) }
  const targetShard = variant === 'psychic-shard'
    ? new THREE.Mesh(track(new THREE.OctahedronGeometry(.3, 0)), targetAccentMaterial)
    : null
  if (targetShard) group.add(targetShard)
  const targetSwarm = variant === 'swarm-target'
    ? Array.from({ length: detail === 'full' ? 7 : detail === 'reduced' ? 5 : 3 }, (_, index) => {
        const mesh = new THREE.Mesh(track(new THREE.IcosahedronGeometry(.09, 0)), targetAccentMaterial)
        group.add(mesh)
        return { mesh, angle: index * Math.PI * 2 / (detail === 'full' ? 7 : detail === 'reduced' ? 5 : 3), phase: index / (detail === 'full' ? 7 : detail === 'reduced' ? 5 : 3) }
      })
    : []
  const mobilityArcShadow = mobilityVariant && variant === 'mobility-arc'
    ? new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([center, center, center])), mobilityShadowMaterial!)
    : null
  if (mobilityArcShadow) group.add(mobilityArcShadow)
  const mobilityArc = family === 'mobility' && variant !== 'mobility-trail' && variant !== 'mobility-haste'
    ? new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([center, center, center])), mobilityVariant ? mobilityCoreMaterial! : accentMaterial)
    : null
  if (mobilityArc) group.add(mobilityArc)
  const mobilityStepShadows = variant === 'mobility-trail' && mobilityMarkShadowMaterial
    ? Array.from({ length: 4 }, () => {
      const mesh = new THREE.Mesh(track(new THREE.TorusGeometry(.26, .07, 5, 10)), mobilityMarkShadowMaterial)
      group.add(mesh)
      return mesh
    })
    : []
  const mobilityStepMarks = variant === 'mobility-trail'
    ? Array.from({ length: 4 }, (_, index) => {
      const mesh = new THREE.Mesh(track(new THREE.TorusGeometry(.2, .04, 5, 10)), mobilityMarkCoreMaterial ?? variantMaterial!)
      group.add(mesh)
      return { mesh, index, phase: index / 4 }
    })
    : []
  const mobilityHasteShadows = variant === 'mobility-haste' && mobilityShadowMaterial
    ? Array.from({ length: 3 }, () => {
      const line = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([center, center, center])), mobilityShadowMaterial)
      group.add(line)
      return line
    })
    : []
  const mobilityHasteTrails = variant === 'mobility-haste'
    ? Array.from({ length: 3 }, () => {
      const line = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([center, center, center])), mobilityCoreMaterial ?? accentMaterial)
      group.add(line)
      return line
    })
    : []
  const communicationLine = family === 'communication' && source
    ? new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([sourcePoint, sourcePoint, sourcePoint])), accentMaterial)
    : null
  if (communicationLine) group.add(communicationLine)
  const environmentParticles = family === 'environment' || family === 'restoration'
    ? Array.from({ length: detail === 'full' ? 4 : 2 }, (_, index) => {
      const mesh = new THREE.Mesh(track(new THREE.IcosahedronGeometry(.045, 0)), accentMaterial)
      group.add(mesh)
      return { mesh, angle: index * Math.PI * 2 / (detail === 'full' ? 4 : 2), phase: index / (detail === 'full' ? 4 : 2) }
    })
    : []
  const spectralOuterMaterial = variant === 'spectral-hand'
    ? material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .58, blending: THREE.AdditiveBlending, depthWrite: false }))
    : null
  const spectralCoreMaterial = variant === 'spectral-hand'
    ? material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: .96, blending: THREE.AdditiveBlending, depthWrite: false }))
    : null
  const spectralPalm = variant === 'spectral-hand'
    ? new THREE.Mesh(track(new THREE.SphereGeometry(.42, detail === 'full' ? 12 : 8, 6)), spectralOuterMaterial!)
    : null
  const spectralCorePalm = variant === 'spectral-hand'
    ? new THREE.Mesh(track(new THREE.SphereGeometry(.28, detail === 'full' ? 10 : 7, 5)), spectralCoreMaterial!)
    : null
  const spectralDigits = variant === 'spectral-hand'
    ? Array.from({ length: 5 }, (_, index) => new THREE.Mesh(track(new THREE.CylinderGeometry(.045, .055, .42, 6)), spectralCoreMaterial!))
    : []
  if (spectralPalm) group.add(spectralPalm)
  if (spectralCorePalm) group.add(spectralCorePalm)
  spectralDigits.forEach((mesh) => group.add(mesh))
  const trickParticles = variant === 'minor-tricks'
    ? Array.from({ length: detail === 'full' ? 5 : detail === 'reduced' ? 3 : 2 }, (_, index) => {
      const mesh = new THREE.Mesh(track(new THREE.IcosahedronGeometry(.045, 0)), variantMaterial!)
      group.add(mesh)
      return { mesh, angle: index * Math.PI * 2 / (detail === 'full' ? 5 : detail === 'reduced' ? 3 : 2), phase: index / (detail === 'full' ? 5 : detail === 'reduced' ? 3 : 2) }
    })
    : []
  const book = variant === 'borrowed-knowledge'
    ? new THREE.Mesh(track(new THREE.BoxGeometry(.5, .06, .34)), variantMaterial!)
    : null
  const bookSpine = variant === 'borrowed-knowledge'
    ? new THREE.Mesh(track(new THREE.BoxGeometry(.06, .075, .36)), accentMaterial)
    : null
  if (book) group.add(book)
  if (bookSpine) group.add(bookSpine)
  const chestBody = variant === 'secret-chest'
    ? new THREE.Mesh(track(new THREE.BoxGeometry(.52, .22, .36)), variantMaterial!)
    : null
  const chestLid = variant === 'secret-chest'
    ? new THREE.Mesh(track(new THREE.BoxGeometry(.56, .12, .4)), accentMaterial)
    : null
  if (chestBody) group.add(chestBody)
  if (chestLid) group.add(chestLid)
  const helmRing = variant === 'spelljamming-helm'
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.42, .035, 6, detail === 'full' ? 20 : 12)), variantMaterial!)
    : null
  const helmSeat = variant === 'spelljamming-helm'
    ? new THREE.Mesh(track(new THREE.BoxGeometry(.34, .12, .34)), accentMaterial)
    : null
  const helmSpokes = variant === 'spelljamming-helm'
    ? new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-.35, 0, 0), new THREE.Vector3(.35, 0, 0), new THREE.Vector3(0, 0, -.35), new THREE.Vector3(0, 0, .35)])), variantMaterial!)
    : null
  if (helmRing) { helmRing.rotation.x = -Math.PI / 2; group.add(helmRing) }
  if (helmSeat) group.add(helmSeat)
  if (helmSpokes) group.add(helmSpokes)
  const silenceRing = variant === 'silence'
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.52, .018, 6, detail === 'full' ? 20 : 12)), variantMaterial!)
    : null
  if (silenceRing) { silenceRing.rotation.x = -Math.PI / 2; group.add(silenceRing) }
  const cancellationRing = variant === 'cancellation'
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.58, .026, 6, detail === 'full' ? 22 : 14)), variantMaterial!)
    : null
  if (cancellationRing) { cancellationRing.rotation.x = -Math.PI / 2; group.add(cancellationRing) }
  const cancellationSplits = variant === 'cancellation'
    ? [0, 1].map(() => new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([center, center, center])), accentMaterial))
    : []
  cancellationSplits.forEach((line) => group.add(line))
  const soulMaterial = variant === 'soul-transfer'
    ? material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true }))
    : null
  const soulOrb = soulMaterial ? new THREE.Mesh(track(new THREE.SphereGeometry(.2, detail === 'full' ? 12 : 8, 6)), soulMaterial) : null
  const soulVessel = soulMaterial ? new THREE.Mesh(track(new THREE.TorusGeometry(.36, .025, 6, detail === 'full' ? 20 : 12)), soulMaterial) : null
  const soulLine = soulMaterial && source
    ? new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([sourcePoint, sourcePoint, sourcePoint])), soulMaterial)
    : null
  if (soulOrb) group.add(soulOrb)
  if (soulVessel) { soulVessel.rotation.x = -Math.PI / 2; group.add(soulVessel) }
  if (soulLine) group.add(soulLine)
  const lights = effectLightRig(group, detail)
  // Столб света: телепорт вспыхивает в точке ухода и прибытия, призыв
  // «собирает» существо снизу вверх.
  const columnMaterial = isTeleport || family === 'summon'
    ? material(additive(glow(style.primary, 1.7), .8, { vertexColors: true, side: THREE.DoubleSide }))
    : null
  const columnGeometry = columnMaterial ? track(fadeColumnGeometry(.42, .32, 1.8, detail === 'full' ? 16 : 10)) : null
  const arrivalColumn = columnGeometry ? new THREE.Mesh(columnGeometry, columnMaterial!) : null
  const departureColumn = isTeleport && source && columnGeometry ? new THREE.Mesh(columnGeometry, columnMaterial!) : null
  if (arrivalColumn) group.add(arrivalColumn)
  if (departureColumn) group.add(departureColumn)
  // Контроль: путы-кольца сжимаются вокруг фигуры.
  const bindingRings = family === 'control' && variant !== 'silence'
    ? Array.from({ length: detail === 'full' ? 3 : detail === 'reduced' ? 2 : 1 }, (_, index) => {
      const mesh = new THREE.Mesh(track(new THREE.TorusGeometry(.5, .022, 5, detail === 'full' ? 20 : 12)), accentMaterial)
      group.add(mesh)
      return { mesh, index }
    })
    : []
  // Некромантия, тьма и яд: тени тянутся вниз, к земле под целью.
  const inwardMotif = !targetLocalVariant && (family === 'necrotic' || family === 'darkness' || family === 'poison')
  const shadowMaterial = inwardMotif
    ? material(new THREE.MeshBasicMaterial({ color: new THREE.Color(style.primary).multiplyScalar(.35), transparent: true, opacity: .6, depthWrite: false }))
    : null
  const shadowGeometry = inwardMotif ? track(new THREE.ConeGeometry(.06, .55, 5)) : null
  const shadowCount = inwardMotif ? detail === 'full' ? 4 : detail === 'reduced' ? 3 : 1 : 0
  const shadows = Array.from({ length: shadowCount }, (_, index) => {
    const mesh = new THREE.Mesh(shadowGeometry!, shadowMaterial!)
    mesh.rotation.x = Math.PI
    group.add(mesh)
    return { mesh, angle: index * Math.PI * 2 / shadowCount + .4, phase: index / shadowCount }
  })
  // Прорицание: гранёное кольцо-руна медленно поворачивается под целью.
  const runeHex = family === 'divination'
    ? new THREE.Mesh(track(new THREE.RingGeometry(.52, .6, 6)), accentMaterial)
    : null
  if (runeHex) { runeHex.rotation.x = -Math.PI / 2; group.add(runeHex) }
  const lightColor = family === 'necrotic' || family === 'darkness' ? '#8a7dff'
    : family === 'radiant' || family === 'light' ? '#ffe2a0'
      : family === 'summon' ? style.secondary : null
  const teleportLight = '#8ff5e8'
  const lightPoint = new THREE.Vector3(center.x, ground + 1, center.z)
  const sourceGroundLevel = source ? terrainHeightAt(map, source.x, source.y) : ground
  const departureLight = new THREE.Vector3(sourcePoint.x, sourceGroundLevel + 1, sourcePoint.z)

  return {
    group,
    update(progressValue) {
      const progress = mobilityVariant && cue.motion === 'reduced' ? .72 : clamp01(progressValue)
      lights.clear()
      if (isTeleport) {
        const departure = source ? 1 - clamp01(progress / .4) : 0
        const arrival = source ? clamp01((progress - .6) / .4) : 1
        const sourceGround = sourceGroundLevel
        // Уход: столб вспыхивает и схлопывается к моменту исчезновения фигуры;
        // прибытие: тонкий луч раскрывается и тает.
        const leave = clamp01(progress / .4)
        const come = source ? clamp01((progress - .6) / .4) : progress
        if (departureColumn) {
          const width = 1 - smoothstep(.55, 1, leave) * .92
          departureColumn.position.set(sourcePoint.x, sourceGround, sourcePoint.z)
          departureColumn.scale.set(width, .35 + .65 * easeOutCubic(leave / .5), width)
          departureColumn.visible = leave < 1
        }
        if (arrivalColumn) {
          const width = .08 + .92 * easeOutCubic(come / .35)
          arrivalColumn.position.set(center.x, ground, center.z)
          arrivalColumn.scale.set(width, 1.15 - .25 * come, width)
          arrivalColumn.visible = (!source || progress >= .6) && come < 1
        }
        if (columnMaterial) columnMaterial.opacity = departureColumn?.visible ? .85 : .85 * (1 - smoothstep(.35, 1, come))
        const leaveFlash = source ? smoothstep(.16, .34, progress) * (1 - smoothstep(.36, .46, progress)) : 0
        const comeFlash = source
          ? smoothstep(.58, .63, progress) * (1 - smoothstep(.63, .95, progress))
          : smoothstep(0, .06, progress) * (1 - smoothstep(.06, .7, progress))
        lights.add(departureLight, teleportLight, 4 * leaveFlash, 4)
        lights.add(lightPoint, teleportLight, 4.5 * comeFlash, 4.5)
        if (progress >= 1) lights.clear()
        ring.position.set(center.x, ground + .05, center.z)
        ring.scale.setScalar(.65 + arrival * .55)
        ring.visible = arrival > .015
        if (portal) {
          portal.position.set(center.x, ground + .1, center.z)
          portal.scale.setScalar(.55 + arrival * .5)
          portal.visible = arrival > .015
        }
        if (departurePortal) {
          departurePortal.position.set(sourcePoint.x, sourceGround + .1, sourcePoint.z)
          departurePortal.scale.setScalar(.55 + departure * .5)
          departurePortal.visible = departure > .015
        }
        for (const particle of particles) {
          const active = departure > arrival ? departure : arrival
          const anchor = departure > arrival ? sourcePoint : center
          const phase = clamp01(active * 1.3 - particle.phase * .2)
          const radius = .25 + phase * .2
          particle.mesh.position.set(
            anchor.x + Math.cos(particle.angle + progress * Math.PI * 2) * radius,
            (departure > arrival ? sourceGround : ground) + .12 + phase * .8,
            anchor.z + Math.sin(particle.angle + progress * Math.PI * 2) * radius,
          )
          particle.mesh.visible = phase > 0 && phase < 1 && active > .02
        }
        bodyMaterial.opacity = Math.max(departure, arrival) * .24
        accentMaterial.opacity = Math.max(departure, arrival) * .8
        group.visible = ring.visible || Boolean(departurePortal?.visible || portal?.visible || departureColumn?.visible || arrivalColumn?.visible || particles.some(({ mesh }) => mesh.visible))
        return
      }
      const fade = Math.sin(Math.PI * progress)
      const lift = clamp01(progress * 1.2)
      ring.position.set(center.x, ground + .05, center.z)
      ring.scale.setScalar(.65 + fade * .55)
      ring.visible = fade > .015
      if (targetLocalVariant) ring.visible = false
      if (variant === 'cancellation' || variant === 'soul-transfer') ring.visible = false
      if (dome) {
        dome.position.set(center.x, ground + .5, center.z)
        dome.scale.set(.5 + fade * .3, (1.1 + fade * .3), .5 + fade * .3)
        dome.visible = fade > .02
        if (facets && facetMaterial) {
          facets.position.copy(dome.position)
          facets.scale.copy(dome.scale)
          facets.rotation.y = progress * .8
          facetMaterial.opacity = fade * .7
          facets.visible = dome.visible
        }
      }
      if (arrivalColumn && columnMaterial) {
        // Призыв: столб растёт снизу вверх и тает к концу.
        arrivalColumn.position.set(center.x, ground, center.z)
        arrivalColumn.scale.set(1, Math.max(.05, easeOutCubic(progress / .45)), 1)
        columnMaterial.opacity = fade * .7
        arrivalColumn.visible = fade > .02
      }
      for (const { mesh, index } of bindingRings) {
        const tighten = easeOutCubic(clamp01((progress - index * .08) / .55))
        mesh.position.set(center.x, ground + .3 + index * .38, center.z)
        mesh.rotation.set(-Math.PI / 2 + Math.sin(index * 1.7 + progress * 3) * .18, 0, progress * (index % 2 ? -2 : 2))
        mesh.scale.setScalar(1.55 - .75 * tighten)
        mesh.visible = fade > .02
      }
      for (const shadow of shadows) {
        const fall = clamp01(progress * 1.3 - shadow.phase * .25)
        const reach = .5 - fall * .16
        shadow.mesh.position.set(center.x + Math.cos(shadow.angle) * reach, ground + 1.05 - fall * .8, center.z + Math.sin(shadow.angle) * reach)
        shadow.mesh.scale.set(1, .6 + fall * .7, 1)
        shadow.mesh.visible = fall > 0 && fall < 1 && fade > .02
      }
      if (shadowMaterial) shadowMaterial.opacity = .6 * fade
      if (runeHex) {
        runeHex.position.set(center.x, ground + .07, center.z)
        runeHex.rotation.z = progress * Math.PI * .6
        runeHex.scale.setScalar(.8 + fade * .35)
        runeHex.visible = fade > .02
      }
      if (lightColor && fade > .02) lights.add(lightPoint, lightColor, (lightColor === '#8a7dff' ? 1 : 2) * fade, 3.5)
      if (progress >= 1) lights.clear()
      if (portal) {
        portal.position.set(center.x, ground + .1 + lift * .25, center.z)
        portal.scale.setScalar(.55 + fade * .5)
        portal.visible = fade > .015
      }
      if (travel) {
        const current = scratchA.lerpVectors(sourcePoint, center, progress)
        const middle = scratchB.lerpVectors(sourcePoint, center, .5)
        middle.y += .25
        setLinePoints(travel, sourcePoint, progress < .5 ? current : middle, current)
        travel.visible = progress > .04 && progress < .96
      }
      if (cancellationRing) {
        cancellationRing.position.set(center.x, ground + .06, center.z)
        cancellationRing.scale.setScalar(Math.max(.16, 1.1 - progress * .9))
        cancellationRing.visible = fade > .02 && progress < .92
      }
      if (cancellationSplits.length) {
        const base = scratchA.set(center.x, ground + .08, center.z)
        const splitPhase = clamp01((progress - .3) / .62)
        const radius = .08 + splitPhase * .48
        for (const [index, line] of cancellationSplits.entries()) {
          const direction = scratchD.set(index === 0 ? -radius : radius, .08 + splitPhase * .2, 0)
          setLinePoints(line, base, scratchB.copy(base).add(direction), scratchC.copy(base).addScaledVector(direction, 1.2))
          line.visible = splitPhase > 0 && splitPhase < 1 && fade > .02
        }
      }
      if (soulOrb && soulVessel) {
        const transfer = clamp01((progress - .08) / .84)
        const current = scratchA.lerpVectors(sourcePoint, center, transfer)
        soulOrb.position.copy(current)
        soulOrb.scale.setScalar(.7 + Math.sin(Math.PI * transfer) * .55)
        soulOrb.visible = transfer > 0 && transfer < 1 && fade > .02
        soulVessel.position.copy(center)
        soulVessel.scale.setScalar(.65 + Math.sin(Math.PI * transfer) * .45)
        soulVessel.visible = transfer > .6 && fade > .02
        if (soulLine) {
          const middle = scratchB.lerpVectors(sourcePoint, center, .5)
          middle.y += .22
          setLinePoints(soulLine, sourcePoint, transfer < .5 ? current : middle, current)
          soulLine.visible = transfer > .04 && transfer < .98
        }
        if (soulMaterial) soulMaterial.opacity = fade * .82
      }
      if (ghostA) {
        ghostA.position.set(center.x + Math.sin(progress * Math.PI * 2) * .14, ground + .6 + Math.sin(progress * Math.PI) * .15, center.z)
        ghostA.scale.setScalar(.65 + fade * .42)
        ghostA.visible = fade > .02
      }
      if (ghostB) {
        ghostB.position.set(center.x - Math.sin(progress * Math.PI * 2) * .2, ground + .5 + Math.cos(progress * Math.PI * 2) * .12, center.z + .12)
        ghostB.scale.setScalar(.55 + fade * .5)
        ghostB.visible = fade > .04
      }
      if (ghostMaterial) ghostMaterial.opacity = family === 'invisibility' ? fade * .18 : fade * .32
      if (focusRay) {
        const base = scratchA.set(center.x, ground + .08, center.z)
        const middle = scratchB.set(base.x, base.y + .45 + lift * .4, base.z)
        const end = scratchC.set(base.x, base.y + .9 + lift * .7, base.z)
        setLinePoints(focusRay, base, middle, end)
        focusRay.visible = fade > .02
      }
      if (lightColumn) {
        lightColumn.position.set(center.x, ground + .72, center.z)
        lightColumn.scale.set(.7 + fade * .5, .7 + lift * .6, .7 + fade * .5)
        lightColumn.visible = fade > .02
      }
      if (morphCube && morphSphere) {
        morphCube.position.set(center.x, ground + .38, center.z)
        morphSphere.position.copy(morphCube.position)
        morphCube.scale.setScalar(Math.max(.05, 1 - progress * 1.1))
        morphSphere.scale.setScalar(Math.max(.05, progress * 1.2))
        morphCube.visible = fade > .02 && progress < .9
        morphSphere.visible = fade > .02 && progress > .1
      }
      if (flightRing) {
        flightRing.position.set(center.x, ground + .45 + lift * .5, center.z)
        flightRing.scale.setScalar(.7 + fade * .45)
        flightRing.visible = fade > .02
      }
      if (familyWave) {
        familyWave.position.set(center.x, ground + .06, center.z)
        familyWave.scale.setScalar(.65 + fade * .65)
        familyWave.visible = fade > .02
      }
      if (targetLight) {
        targetLight.position.set(center.x, ground + 1.05 + (1 - progress) * .55, center.z)
        targetLight.rotation.x = Math.PI
        targetLight.scale.set(.9 + fade * .35, .8 + fade * .5, .9 + fade * .35)
        targetLight.visible = fade > .02
      }
      if (targetBell && targetBellRim) {
        targetBell.position.set(center.x, ground + 1.38, center.z)
        targetBellRim.position.set(center.x, ground + 1.18, center.z)
        if (targetBellGroundRim) targetBellGroundRim.position.set(center.x, ground + .08, center.z)
        targetBell.scale.setScalar(.85 + fade * .35)
        targetBellRim.scale.setScalar(.9 + fade * .5)
        if (targetBellGroundRim) targetBellGroundRim.scale.setScalar(.85 + fade * .3)
        const bellVisible = fade > .02
        targetBell.visible = targetBellRim.visible = bellVisible
        if (targetBellGroundRim) targetBellGroundRim.visible = bellVisible
      }
      if (targetShard) {
        targetShard.position.set(center.x, ground + 1.85 + Math.sin(progress * Math.PI) * .12, center.z)
        targetShard.rotation.set(progress * 1.8, progress * 2.4, progress * 1.1)
        targetShard.scale.setScalar(.9 + fade * .6)
        targetShard.visible = fade > .02
      }
      for (const swarm of targetSwarm) {
        const angle = swarm.angle + progress * Math.PI * 2
        const radius = .55 + Math.sin(Math.PI * clamp01(progress + swarm.phase)) * .2
        swarm.mesh.position.set(center.x + Math.cos(angle) * radius, ground + .9 + Math.sin(progress * Math.PI * 2 + swarm.phase * 4) * .2, center.z + Math.sin(angle) * radius)
        swarm.mesh.scale.setScalar(.9 + fade * .7)
        swarm.mesh.visible = fade > .02
      }
      if (mobilityArc) {
        if (mobilityArcShadow) {
          const base = scratchA.set(center.x + .48, ground + .1, center.z + .58)
          const right = scratchB.set(base.x + 1.08, base.y + .08, base.z - .12)
          const middle = scratchC.lerpVectors(base, right, .5)
          middle.y += .6 + lift * .2
          middle.z += .05
          setLinePoints(mobilityArcShadow, base, middle, right)
          setLinePoints(mobilityArc, base, middle, right)
          mobilityArcShadow.visible = mobilityArc.visible = fade > .02
        } else {
          const base = scratchA.set(center.x, ground + .12, center.z)
          const right = scratchB.set(base.x + .35 + lift * .15, base.y + .2 + lift * .45, base.z)
          const middle = variant === 'mobility-arc'
            ? scratchC.set(base.x, base.y + .34 + lift * .55, base.z)
            : scratchC.set(base.x - .35 - lift * .15, base.y + .2 + lift * .45, base.z)
          setLinePoints(mobilityArc, base, middle, right)
          mobilityArc.visible = fade > .02
        }
      }
      const mobilityRingScale = mobilityVariant ? .9 + fade * .12 : .65 + fade * .55
      ring.scale.setScalar(mobilityRingScale)
      for (const [index, step] of mobilityStepMarks.entries()) {
        const phase = clamp01(progress * 1.35 - step.phase * .42)
        const row = Math.floor(step.index / 2)
        const side = step.index % 2 ? 1 : -1
        step.mesh.position.set(center.x + side * (.52 + phase * .05), ground + .07, center.z + .72 - row * .78 - phase * .12)
        step.mesh.rotation.x = -Math.PI / 2
        const stepScale = .9 + phase * .24
        step.mesh.scale.set(stepScale * .92, stepScale * 1.45, stepScale)
        step.mesh.visible = phase > .02 && fade > .02
        const shadow = mobilityStepShadows[step.index]
        if (shadow) {
          shadow.position.copy(step.mesh.position)
          shadow.rotation.copy(step.mesh.rotation)
          shadow.scale.copy(step.mesh.scale)
          shadow.visible = step.mesh.visible
        }
      }
      if (mobilityStepMarks.length && variantMaterial) variantMaterial.opacity = fade * .9
      for (const [index, line] of mobilityHasteTrails.entries()) {
        const phase = clamp01((progress - index * .08) / .78)
        const base = scratchA.set(center.x + .42, ground + .12 + index * .08, center.z + .55 + index * .12)
        const end = scratchB.set(base.x + .98 + phase * .28, base.y + .02 + lift * .2, base.z - .12 + index * .12)
        const middle = scratchC.lerpVectors(base, end, .5)
        middle.x += .12
        middle.y += .04
        setLinePoints(line, base, middle, end)
        line.visible = phase > .02 && phase < 1.02 && fade > .02
        const shadow = mobilityHasteShadows[index]
        if (shadow) {
          setLinePoints(shadow, base, middle, end)
          shadow.visible = line.visible
        }
      }
      if (mobilityShadowMaterial) mobilityShadowMaterial.opacity = fade * .9
      if (mobilityCoreMaterial) mobilityCoreMaterial.opacity = fade * .98
      if (mobilityMarkShadowMaterial) mobilityMarkShadowMaterial.opacity = fade * .9
      if (mobilityMarkCoreMaterial) mobilityMarkCoreMaterial.opacity = fade * .98
      if (communicationLine) {
        const current = scratchA.lerpVectors(sourcePoint, center, progress)
        const middle = scratchB.lerpVectors(sourcePoint, center, .5)
        middle.y += .18
        setLinePoints(communicationLine, sourcePoint, progress < .5 ? current : middle, current)
        communicationLine.visible = progress > .06 && progress < .94
      }
      for (const particle of environmentParticles) {
        const phase = clamp01(progress * 1.25 - particle.phase * .22)
        particle.mesh.position.set(center.x + Math.cos(particle.angle + progress * Math.PI * 2) * (.16 + phase * .14), ground + .1 + phase * 1.05, center.z + Math.sin(particle.angle + progress * Math.PI * 2) * (.16 + phase * .14))
        particle.mesh.visible = phase > 0 && phase < 1 && fade > .02
      }
      if (spectralPalm) {
        const hand = scratchA.set(center.x + Math.sin(progress * Math.PI * 2) * .18, ground + .5 + lift * .28, center.z)
        spectralPalm.position.copy(hand)
        spectralPalm.scale.set(1.1 + fade * .18, .5 + fade * .1, 1.3 + fade * .18)
        spectralPalm.visible = fade > .02
        if (spectralCorePalm) {
          spectralCorePalm.position.copy(hand)
          spectralCorePalm.scale.set(.9 + fade * .12, .4 + fade * .08, 1.05 + fade * .14)
          spectralCorePalm.visible = spectralPalm.visible
        }
        for (const [index, digit] of spectralDigits.entries()) {
          digit.position.set(hand.x + (index - 2) * .12, hand.y + .2 + Math.abs(index - 2) * .02, hand.z + .2 + lift * .08)
          digit.rotation.x = -.35 - lift * .2
          digit.visible = spectralPalm.visible
        }
      }
      for (const trick of trickParticles) {
        const phase = clamp01(progress * 1.35 - trick.phase * .2)
        trick.mesh.position.set(center.x + Math.cos(trick.angle + progress * Math.PI * 4) * (.2 + phase * .2), ground + .25 + phase * .8, center.z + Math.sin(trick.angle + progress * Math.PI * 4) * (.2 + phase * .2))
        trick.mesh.rotation.set(progress * 3, progress * 2, progress)
        trick.mesh.visible = phase > 0 && phase < 1 && fade > .02
      }
      if (book) {
        book.position.set(center.x, ground + .48 + lift * .22, center.z)
        book.rotation.set(Math.sin(progress * Math.PI) * .12, progress * Math.PI * 1.5, Math.sin(progress * Math.PI * 2) * .08)
        book.visible = fade > .02
      }
      if (bookSpine) {
        bookSpine.position.copy(book?.position ?? center)
        bookSpine.rotation.copy(book?.rotation ?? new THREE.Euler())
        bookSpine.visible = Boolean(book?.visible)
      }
      if (chestBody && chestLid) {
        const chestFade = clamp01(1 - Math.max(0, progress - .48) / .52)
        chestBody.position.set(center.x, ground + .16, center.z)
        chestLid.position.set(center.x, ground + .3 + lift * .08, center.z)
        chestBody.scale.setScalar(.6 + chestFade * .4)
        chestLid.scale.setScalar(.6 + chestFade * .4)
        chestBody.visible = chestFade > .015
        chestLid.visible = chestBody.visible
        if (variantMaterial) variantMaterial.opacity = chestFade * .75
      }
      if (helmRing && helmSeat && helmSpokes) {
        helmRing.position.set(center.x, ground + .52, center.z)
        helmSeat.position.set(center.x, ground + .12, center.z)
        helmSpokes.position.set(center.x, ground + .52, center.z)
        helmRing.rotation.y = progress * Math.PI * 2
        helmSpokes.rotation.y = progress * Math.PI * 2
        helmRing.visible = helmSeat.visible = helmSpokes.visible = fade > .02
      }
      if (silenceRing) {
        silenceRing.position.set(center.x, ground + .06, center.z)
        silenceRing.scale.setScalar(Math.max(.2, 1.1 - progress * .78))
        silenceRing.visible = fade > .02
        if (variantMaterial) variantMaterial.opacity = fade * .25
      }
      for (const particle of particles) {
        const phase = clamp01(progress * 1.3 - particle.phase * .2)
        const radius = style.family === 'teleport' ? .25 + phase * .2 : .16 + phase * .1
        particle.mesh.position.set(
          center.x + Math.cos(particle.angle + progress * Math.PI * 2) * radius,
          ground + .12 + phase * (style.family === 'summon' ? 1.05 : .8),
          center.z + Math.sin(particle.angle + progress * Math.PI * 2) * radius,
        )
        particle.mesh.visible = phase > 0 && phase < 1 && fade > .02
      }
      bodyMaterial.opacity = targetLocalVariant ? .24 : fade * .24
      accentMaterial.opacity = targetLocalVariant ? .8 : fade * .8
      if (targetLocalVariant) {
        targetBodyMaterial.opacity = fade * .6
        targetAccentMaterial.opacity = fade * .9
      }
      group.visible = ring.visible || Boolean(dome?.visible || arrivalColumn?.visible || bindingRings.some(({ mesh }) => mesh.visible) || shadows.some(({ mesh }) => mesh.visible) || runeHex?.visible || portal?.visible || travel?.visible || ghostA?.visible || ghostB?.visible || focusRay?.visible || lightColumn?.visible || morphCube?.visible || morphSphere?.visible || flightRing?.visible || familyWave?.visible || targetLight?.visible || targetBell?.visible || targetBellRim?.visible || targetBellGroundRim?.visible || targetShard?.visible || targetSwarm.some(({ mesh }) => mesh.visible) || mobilityArc?.visible || mobilityArcShadow?.visible || mobilityStepMarks.some(({ mesh }) => mesh.visible) || mobilityStepShadows.some((mesh) => mesh.visible) || mobilityHasteTrails.some((line) => line.visible) || mobilityHasteShadows.some((line) => line.visible) || communicationLine?.visible || spectralPalm?.visible || spectralCorePalm?.visible || trickParticles.some(({ mesh }) => mesh.visible) || book?.visible || chestBody?.visible || helmRing?.visible || silenceRing?.visible || cancellationRing?.visible || cancellationSplits.some((line) => line.visible) || soulOrb?.visible || soulVessel?.visible || soulLine?.visible || particles.some(({ mesh }) => mesh.visible) || environmentParticles.some(({ mesh }) => mesh.visible))
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((entry) => entry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}

/**
 * Эффекты короткие и меняют геометрию каждый кадр. Отсечение по пирамиде
 * видимости потребовало бы пересчитывать bounding sphere на каждом кадре, а
 * эффект и так лежит в кадре доски, поэтому отсечение для него выключено.
 */
function withoutFrustumCulling(effect: SpellEffect3D | null) {
  effect?.group.traverse((object) => { object.frustumCulled = false })
  // Контракт света общий для всех эффектов: массив есть всегда, даже пустой.
  if (effect && !Array.isArray(effect.group.userData.lights)) effect.group.userData.lights = []
  return effect
}

/** Небольшой объёмный акцент подтверждённого spell-cue поверх 2D-слоя. */
export function createSpellEffect3D(
  cue: CombatAnimationCue,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  return withoutFrustumCulling(createSpellEffect3DUnculled(cue, actors, map))
}

function createSpellEffect3DUnculled(
  cue: CombatAnimationCue,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  if (cue.kind === 'burst' && spellIdFromEffect(cue.spellId) === 'fireball') return createFireball(cue, actors, map)
  if (cue.kind === 'projectile') return createProjectile(cue, actors, map)
  if (cue.kind === 'burst') return createAreaBurst(cue, actors, map)
  if (cue.kind === 'beam') return createBeam(cue, actors, map)
  if (cue.kind === 'aura') return createAura(cue, actors, map)
  if (cue.kind === 'channel' && cue.spellId === 'longstrider') {
    const effects = spellChannelTargetIds(cue).flatMap((targetId) => {
      if (!actorFor(actors, targetId)) return []
      const effect = createChannel({ ...cue, targetId, position: undefined }, actors, map)
      return effect ? [effect] : []
    })
    if (!effects.length) return null
    const group = new THREE.Group()
    effects.forEach((effect) => group.add(effect.group))
    return { group, update: (progress) => effects.forEach((effect) => effect.update(progress)), dispose: () => { effects.forEach((effect) => effect.dispose()); group.removeFromParent() } }
  }
  if (cue.kind === 'channel') return createChannel(cue, actors, map)
  return null
}
