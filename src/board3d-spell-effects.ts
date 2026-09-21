import * as THREE from 'three'
import { actorFootprintCells, actorPresentationCenter } from './tactical-ui'
import { terrainHeightAt } from './board3d-terrain'
import { cellAt, edgeBetween, revealedAt } from './tactical-map-client'
import { spellBurstCells, spellEffectPalette, spellIdFromEffect, spellVisualProfile, type SpellEffectDetail } from './spell-effects'
import { maskSpellAreaCells } from './spell-targeting'
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

function visualPoint(map: TacticalMap, point: BoardPoint, actor?: SpellEffectActor | null, height = .7) {
  const center = actor ? actorPresentationCenter(map, actor, point) : { x: point.x + .5, y: point.y + .5 }
  return new THREE.Vector3(center.x, terrainHeightAt(map, point.x, point.y) + height, center.y)
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
  line.geometry.computeBoundingSphere()
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
  const visibleCells = sampledCells(footprint.visible, detail === 'full' ? 36 : detail === 'reduced' ? 24 : 10)
  if (!footprint.present.length || !visibleCells.length) return null
  const { geometries, materials, track, material } = resources()
  const group = new THREE.Group()
  const style = styleFor(cue)
  const primary = style.primary
  const inner = material(new THREE.MeshBasicMaterial({ color: '#ffe0a3', transparent: true, opacity: .98, blending: THREE.AdditiveBlending, depthWrite: false }))
  const outer = material(new THREE.MeshBasicMaterial({ color: primary, transparent: true, opacity: .62, blending: THREE.AdditiveBlending, depthWrite: false }))
  const blast = material(new THREE.MeshBasicMaterial({ color: '#ffb25f', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }))
  const trailMaterial = material(new THREE.LineBasicMaterial({ color: style.secondary, transparent: true, opacity: .58, blending: THREE.AdditiveBlending, depthWrite: false }))
  const rayMaterial = material(new THREE.LineBasicMaterial({ color: '#ff8b42', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }))
  const cellMaterial = material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .38, blending: THREE.AdditiveBlending, depthWrite: false }))
  const contourMaterial = material(new THREE.LineBasicMaterial({ color: style.secondary, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }))
  const orb = new THREE.Mesh(track(new THREE.SphereGeometry(.17, detail === 'full' ? 12 : 8, 6)), inner)
  const halo = new THREE.Mesh(track(new THREE.SphereGeometry(.32, detail === 'full' ? 12 : 8, 6)), outer)
  const explosion = new THREE.Mesh(track(new THREE.SphereGeometry(1, detail === 'full' ? 12 : 8, 6)), blast)
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(1, .025, 6, detail === 'full' ? 20 : 12)), blast)
  ring.rotation.x = -Math.PI / 2
  group.add(orb, halo, explosion, ring)

  const trailPointCount = detail === 'full' ? 7 : detail === 'reduced' ? 4 : 2
  const trail = new THREE.Line(
    track(new THREE.BufferGeometry().setFromPoints(Array.from({ length: trailPointCount }, () => new THREE.Vector3()))),
    trailMaterial,
  )
  group.add(trail)

  const rayCount = detail === 'full' ? 8 : detail === 'reduced' ? 5 : 3
  const rays = Array.from({ length: rayCount }, (_, index) => {
    const line = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])), rayMaterial)
    group.add(line)
    return { line, angle: index * Math.PI * 2 / rayCount + .18 }
  })
  const ground = terrainHeightAt(map, center.x, center.y)
  const fireCellGeometry = track(new THREE.IcosahedronGeometry(.14, 0))
  const fireCells = visibleCells.map((cell) => {
    const mesh = new THREE.Mesh(fireCellGeometry, cellMaterial)
    mesh.position.set(cell.x + .5, terrainHeightAt(map, cell.x, cell.y) + .12, cell.y + .5)
    group.add(mesh)
    return mesh
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
  const from = visualPoint(map, origin, sourceActor, .78)
  const to = visualPoint(map, center, null, .78)
  const footprintRadius = visibleCells.reduce((maximum, cell) => Math.max(maximum, Math.hypot(cell.x - center.x, cell.y - center.y) + .7), 0)
  const blastRadius = Math.max(1.2, Math.min(5, footprintRadius || (Number(cue.sizeFeet) || 10) / 5))
  const blastAllowed = footprint.present.length > 0 && !footprint.fogged
  // Синхронно с плоским drawBurst: взрыв начинается после прилёта шара.
  const arrival = .56
  const explosionStart = arrival

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      const travel = Math.min(1, progress / arrival)
      const position = new THREE.Vector3().lerpVectors(from, to, travel)
      position.y = from.y + (to.y - from.y) * travel + Math.sin(travel * Math.PI) * .42
      const tail = Math.max(0, travel - (detail === 'full' ? .3 : .2))
      for (let index = 0; index < trailPointCount; index += 1) {
        const t = tail + (travel - tail) * index / Math.max(1, trailPointCount - 1)
        const point = new THREE.Vector3().lerpVectors(from, to, t)
        point.y = from.y + (to.y - from.y) * t + Math.sin(t * Math.PI) * .42
        ;(trail.geometry.getAttribute('position') as THREE.BufferAttribute).setXYZ(index, point.x, point.y, point.z)
      }
      ;(trail.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
      trail.geometry.computeBoundingSphere()
      orb.position.copy(position); halo.position.copy(position)
      orb.visible = halo.visible = progress < arrival && visible(map, { x: position.x, y: position.z })
      trail.visible = orb.visible
      trailMaterial.opacity = orb.visible ? .58 : 0

      const explosionProgress = clamp01((progress - explosionStart) / (1 - explosionStart))
      const burst = Math.sin(explosionProgress * Math.PI)
      const scale = blastRadius * (.18 + explosionProgress * .92)
      explosion.position.set(to.x, ground + .42, to.z)
      explosion.scale.setScalar(scale)
      explosion.visible = explosionProgress > 0 && blastAllowed && visible(map, center)
      blast.opacity = burst * .35
      ring.position.set(to.x, ground + .08, to.z)
      ring.scale.setScalar(Math.max(.2, blastRadius * (.18 + explosionProgress * .82)))
      ring.visible = explosion.visible
      rayMaterial.opacity = burst * .9
      for (const { line, angle } of rays) {
        const start = new THREE.Vector3(to.x, ground + .16, to.z)
        const distance = blastRadius * (.45 + explosionProgress * .9)
        const end = start.clone().add(new THREE.Vector3(Math.cos(angle) * distance, .18 + explosionProgress * .5, Math.sin(angle) * distance))
        setLinePoints(line, start, end)
        line.visible = explosion.visible
      }
      const cellPulse = .35 + explosionProgress * .9
      cellMaterial.opacity = .2 + burst * .5
      for (const cell of fireCells) {
        cell.scale.setScalar(cellPulse)
        cell.visible = explosionProgress > 0 && explosionProgress < 1 && visible(map, { x: cell.position.x, y: cell.position.z })
      }
      if (contour) {
        const contourProgress = clamp01((explosionProgress - .04) / .96)
        const vertexCount = Math.floor(contourPoints.length * contourProgress / 2) * 2
        contour.geometry.setDrawRange(0, vertexCount)
        contourMaterial.opacity = burst * .65
        contour.visible = vertexCount > 1 && explosionProgress < 1 && visibleCells.length > 0
      }
      group.visible = visible(map, center) && (orb.visible || explosion.visible || contour?.visible === true || fireCells.some((cell) => cell.visible))
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}

type ProjectilePath = { from: THREE.Vector3; to: THREE.Vector3; targetId?: string; phase: number; arrival: number; arc: number }

function projectilePaths(
  cue: Extract<SpellAnimationCue, { kind: 'projectile' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
  count: number,
) {
  const source = actorFor(actors, cue.actorId)
  const origin = cue.from ?? source
  if (!origin || !visible(map, origin)) return [] as ProjectilePath[]
  const targets: Array<SpellEffectActor | null> = cue.targetIds.map((id) => actorFor(actors, id)).filter((actor): actor is SpellEffectActor => Boolean(actor))
  if (!targets.length && cue.to) targets.push(null)
  const result: ProjectilePath[] = []
  for (let index = 0; index < count; index += 1) {
    const targetActor = targets[index % Math.max(1, targets.length)] ?? null
    const target = targetActor ?? cue.to
    if (!target || !visible(map, target) || !visiblePath(map, origin, target)) continue
    result.push({
      from: visualPoint(map, origin, source, .78),
      to: visualPoint(map, target, targetActor, .72),
      targetId: cue.targetIds[index % Math.max(1, cue.targetIds.length)],
      phase: .08 + index * .035,
      arrival: .7 + Math.min(.16, index * .025),
      arc: .22 + (index % 3) * .06,
    })
  }
  return result
}

function createProjectile(
  cue: Extract<SpellAnimationCue, { kind: 'projectile' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  const detail = detailOf(cue)
  const count = detail === 'full' ? Math.min(8, Math.max(1, cue.projectileCount))
    : detail === 'reduced' ? Math.min(4, Math.max(1, cue.projectileCount)) : 1
  const paths = projectilePaths(cue, actors, map, count)
  if (!paths.length) return null
  const { geometries, materials, track, material } = resources()
  const group = new THREE.Group()
  const style = styleFor(cue)
  const orbMaterial = material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .96, blending: THREE.AdditiveBlending, depthWrite: false }))
  const trailMaterial = material(new THREE.LineBasicMaterial({ color: style.secondary, transparent: true, opacity: .7, blending: THREE.AdditiveBlending, depthWrite: false }))
  const impactMaterial = material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false }))
  const orbGeometry = track(String(style.family) === 'weapon'
    ? new THREE.BoxGeometry(.28, .08, .08)
      : String(style.family) === 'earth' ? new THREE.DodecahedronGeometry(.13, 0)
        : String(style.family) === 'swarm' ? new THREE.IcosahedronGeometry(.13, 0)
          : new THREE.SphereGeometry(.16, detail === 'full' ? 10 : 7, 5))
  const impactGeometry = track(new THREE.TorusGeometry(.22, .025, 5, detail === 'full' ? 14 : 9))
  const trailPointCount = detail === 'full' ? 4 : detail === 'reduced' ? 3 : 2
  const entries = paths.map((path) => {
    const root = new THREE.Group()
    const orb = new THREE.Mesh(orbGeometry, orbMaterial)
    const impact = new THREE.Mesh(impactGeometry, impactMaterial)
    impact.rotation.x = -Math.PI / 2
    const trail = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints(Array.from({ length: trailPointCount }, () => new THREE.Vector3()))), trailMaterial)
    root.add(trail, orb, impact)
    group.add(root)
    return { ...path, root, orb, impact, trail }
  })

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      for (const entry of entries) {
        const flight = clamp01((progress - entry.phase) / Math.max(.01, entry.arrival - entry.phase))
        const eased = flight * flight * (3 - 2 * flight)
        const position = new THREE.Vector3().lerpVectors(entry.from, entry.to, eased)
        position.y += Math.sin(flight * Math.PI) * entry.arc
        entry.orb.position.copy(position)
        entry.orb.visible = progress >= entry.phase && progress < entry.arrival && visible(map, { x: position.x, y: position.z })
        const positions = entry.trail.geometry.getAttribute('position') as THREE.BufferAttribute
        const tail = Math.max(0, flight - (detail === 'full' ? .28 : .18))
        for (let index = 0; index < trailPointCount; index += 1) {
          const t = tail + (flight - tail) * index / Math.max(1, trailPointCount - 1)
          const point = new THREE.Vector3().lerpVectors(entry.from, entry.to, t)
          point.y += Math.sin(t * Math.PI) * entry.arc
          positions.setXYZ(index, point.x, point.y, point.z)
        }
        positions.needsUpdate = true
        entry.trail.geometry.computeBoundingSphere()
        entry.trail.visible = entry.orb.visible
        const impact = Math.sin(Math.PI * clamp01((progress - entry.arrival) / .24))
        entry.impact.position.copy(entry.to)
        entry.impact.scale.setScalar(.55 + impact * 1.4)
        entry.impact.visible = progress >= entry.arrival && impact > 0 && !targetOutcomeIsMiss(cue, entry.targetId) && visible(map, { x: entry.to.x, y: entry.to.z })
      }
      group.visible = entries.some(({ orb, trail, impact }) => orb.visible || trail.visible || impact.visible)
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
  if (!from) return [] as Array<{ point: BoardPoint; actor?: SpellEffectActor | null; targetId?: string }>
  const result: Array<{ point: BoardPoint; actor?: SpellEffectActor | null; targetId?: string }> = [{ point: from, actor: source }]
  if (cue.points?.length) {
    cue.points.forEach((point, index) => result.push({ point, actor: actorFor(actors, cue.targetIds[index]), targetId: cue.targetIds[index] }))
  } else {
    cue.targetIds.forEach((id) => {
      const actor = actorFor(actors, id)
      if (actor) result.push({ point: actor, actor, targetId: id })
    })
  }
  return result
}

type LineSegment = { from: THREE.Vector3; midpoint: THREE.Vector3; to: THREE.Vector3; targetId?: string }

function lineSegments(
  points: ReadonlyArray<{ point: BoardPoint; actor?: SpellEffectActor | null; targetId?: string }>,
  map: TacticalMap,
  chain: boolean,
) {
  return points.slice(0, chain ? points.length : Math.min(points.length, 2) - 1)
    .map((entry, index): LineSegment | null => {
      const next = points[index + 1]
      if (!next || !visible(map, entry.point) || !visible(map, next.point) || !visiblePath(map, entry.point, next.point)) return null
      const from = visualPoint(map, entry.point, entry.actor, .82)
      const to = visualPoint(map, next.point, next.actor, .82)
      const midpoint = from.clone().lerp(to, .5)
      const lateral = new THREE.Vector3(to.z - from.z, 0, -(to.x - from.x)).normalize().multiplyScalar(.12 + (index % 2) * .05)
      midpoint.add(lateral)
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
  const style = styleFor(cue)
  const lightning = String(style.family) === 'lightning'
  const outerColor = lightning ? '#1b77ba' : style.secondary
  const coreColor = lightning ? '#9ceeff' : style.primary
  const outer = material(new THREE.LineBasicMaterial({ color: outerColor, transparent: true, opacity: lightning ? .22 : .35, blending: THREE.AdditiveBlending, depthWrite: false }))
  const core = material(new THREE.LineBasicMaterial({ color: coreColor, transparent: true, opacity: lightning ? .62 : .95, blending: THREE.AdditiveBlending, depthWrite: false }))
  const hitMaterial = material(new THREE.MeshBasicMaterial({ color: lightning ? '#d6fbff' : style.secondary, transparent: true, opacity: .72, blending: THREE.AdditiveBlending, depthWrite: false }))
  const hitGeometry = track(new THREE.TorusGeometry(.16, .018, 5, detail === 'full' ? 14 : 9))
  const lightningOuterMaterial = lightning ? material(new THREE.MeshBasicMaterial({ color: '#1b77ba', transparent: true, opacity: .84, blending: THREE.AdditiveBlending, depthWrite: false })) : null
  const lightningCoreMaterial = lightning ? material(new THREE.MeshBasicMaterial({ color: '#a9f1ff', transparent: true, opacity: .98, blending: THREE.AdditiveBlending, depthWrite: false })) : null
  const lightningGeometry = lightning ? track(new THREE.CylinderGeometry(.045, .045, 1, 6)) : null
  const lightningBranchGeometry = lightning ? track(new THREE.CylinderGeometry(.025, .025, 1, 5)) : null
  const lines = segments.map(({ from, midpoint, to, targetId }, segmentIndex) => {
    const line = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([from, from, from])), core)
    group.add(line)
    const glow = detail === 'minimal' ? null : new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([from, from, from])), outer)
    if (glow) group.add(glow)
    const hit = new THREE.Mesh(hitGeometry, hitMaterial)
    hit.rotation.x = -Math.PI / 2
    hit.position.copy(to)
    group.add(hit)
    const jagged = lightning ? lightningPath({ from, midpoint, to }, segmentIndex) : []
    const pieceCount = detail === 'full' ? 4 : detail === 'reduced' ? 3 : 2
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
        return { branch, branchIndex }
      })
      : []
    return { line, glow, hit, from, midpoint, to, targetId, jagged, lightningPieces, branches }
  })

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      // Короткая подготовка делает луч читаемым как cast → flight → hit.
      const segmentProgress = clamp01((progress - .08) / .84) * lines.length
      lines.forEach(({ line, glow, hit, from, midpoint, to, targetId, jagged, lightningPieces, branches }, index) => {
        const local = clamp01(segmentProgress - index)
        const current = local < .5
          ? from.clone().lerp(midpoint, local * 2)
          : midpoint.clone().lerp(to, (local - .5) * 2)
        setLinePoints(line, from, local < .5 ? current : midpoint, current)
        if (glow) setLinePoints(glow, from, local < .5 ? current : midpoint, current)
        line.visible = local > 0 && visible(map, { x: current.x, y: current.z })
        if (glow) glow.visible = line.visible
        if (lightningPieces.length) {
          for (const piece of lightningPieces) {
            const pieceProgress = clamp01(local * lightningPieces.length - piece.pieceIndex)
            const pieceStart = jagged[Math.min(jagged.length - 2, Math.floor(piece.pieceIndex * (jagged.length - 1) / lightningPieces.length))]
            const pieceEnd = jagged[Math.min(jagged.length - 1, Math.floor((piece.pieceIndex + 1) * (jagged.length - 1) / lightningPieces.length))]
            const pieceCurrent = pieceStart.clone().lerp(pieceEnd, pieceProgress)
            orientCylinder(piece.outer, pieceStart, pieceCurrent)
            orientCylinder(piece.core, pieceStart, pieceCurrent)
            piece.outer.visible = piece.core.visible = pieceProgress > 0 && visible(map, { x: pieceCurrent.x, y: pieceCurrent.z })
          }
          for (const { branch, branchIndex } of branches) {
            const branchStart = to.clone()
            const branchEnd = branchStart.clone().add(new THREE.Vector3((branchIndex ? -.16 : .16), .16 + branchIndex * .05, branchIndex ? .12 : -.12))
            orientCylinder(branch, branchStart, branchEnd)
            branch.visible = local > .72 && local < 1 && visible(map, { x: to.x, y: to.z })
          }
        }
        hit.position.copy(to)
        hit.scale.setScalar(.55 + Math.sin(Math.PI * clamp01((local - .72) / .28)) * .85)
        hit.visible = local > .72 && local < 1 && !targetOutcomeIsMiss(cue, targetId) && visible(map, { x: to.x, y: to.z })
      })
      group.visible = lines.some(({ line, hit, lightningPieces, branches }) => line.visible || hit.visible || lightningPieces.some((piece) => piece.outer.visible) || branches.some(({ branch }) => branch.visible))
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
  return createLineEffect(cue, lineSegments(beamPoints(cue, actors), map, cue.chain), map, detailOf(cue))
}

function createBurstLine(
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  const source = actorFor(actors, cue.actorId)
  const origin = cue.origin ?? source
  const endpoint = cue.center ?? (cue.cells?.length && origin
    ? cue.cells.reduce((farthest, point) => Math.hypot(point.x - origin.x, point.y - origin.y) > Math.hypot(farthest.x - origin.x, farthest.y - origin.y) ? point : farthest)
    : undefined)
  const fullLineVisible = cue.cells?.length
    ? true
    : endpoint && origin
    ? maskSpellAreaCells(map, [endpoint], {
        origins: source ? actorFootprintCells(source) : [origin],
        spreadsAroundCorners: spellVisualProfile(cue.spellId, { areaShape: cue.shape, areaOrigin: cue.originMode, radius: cue.sizeFeet }).spreadsAroundCorners === true,
        radiusFeet: cue.sizeFeet,
      }).has(`${endpoint.x},${endpoint.y}`)
    : false
  if (!fullLineVisible) return null
  const cells = burstFootprint(map, cue, actors).visible
  // Выбранная клетка задаёт направление, но луч продолжается на всю длину.
  const center = cells.length
    ? cells.reduce((farthest, point) => {
      if (!farthest || !origin) return point
      return Math.hypot(point.x - origin.x, point.y - origin.y) > Math.hypot(farthest.x - origin.x, farthest.y - origin.y) ? point : farthest
    }, undefined as BoardPoint | undefined)
    : undefined
  if (!origin || !center) return null
  return createLineEffect(cue, lineSegments([
    { point: origin, actor: source },
    { point: center, actor: null },
  ], map, false), map, detailOf(cue))
}

function orientCylinder(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3) {
  const direction = to.clone().sub(from)
  const length = Math.max(.001, direction.length())
  mesh.position.copy(from).add(to).multiplyScalar(.5)
  mesh.scale.set(1, length, 1)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
}

function lightningPath(segment: LineSegment, index: number) {
  const direction = segment.to.clone().sub(segment.from)
  const normal = new THREE.Vector3(direction.z, 0, -direction.x).normalize()
  const points = [segment.from.clone()]
  for (const [step, sign] of [[.22, 1], [.46, -1], [.7, 1]] as const) {
    points.push(segment.from.clone().lerp(segment.to, step).add(normal.clone().multiplyScalar(sign * (.13 + (index % 2) * .045))).add(new THREE.Vector3(0, (step < .5 ? .08 : -.05) * sign, 0)))
  }
  points.push(segment.to.clone())
  return points
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
  const radius = Math.max(.6, Math.min(4, Number(cue.sizeFeet) / 5 || 1))
  const ring = cue.shape === 'sphere' || cue.shape === 'cylinder'
    ? new THREE.Mesh(track(new THREE.TorusGeometry(radius * .55, .025, 6, detail === 'full' ? 24 : 14)), areaMaterial)
    : null
  if (ring) { ring.rotation.x = -Math.PI / 2; group.add(ring) }
  const baseHeight = center ? terrainHeightAt(map, center.x, center.y) : 0
  const visibleRadiusCells = center ? visibleRadius(map, center, radius) : radius

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      const reveal = clamp01((progress - .08) / .28)
      const impact = clamp01((progress - .22) / .28)
      const fade = Math.sin(Math.PI * clamp01(progress))
      areaMaterial.opacity = (.12 + impact * .42) * Math.max(.35, fade)
      for (const [index, marker] of markers.entries()) {
        marker.visible = progress > .04 && progress < .96
        marker.scale.setScalar(.35 + reveal * (.65 + (index % 3) * .08))
        marker.position.y = terrainHeightAt(map, cells[index].x, cells[index].y) + .1 + reveal * .16
      }
      if (center && ring) {
        ring.position.set(center.x + .5, baseHeight + .06, center.y + .5)
        ring.scale.setScalar(Math.max(.3, visibleRadiusCells / Math.max(.1, radius)) * (.5 + impact * .5))
        ring.visible = progress > .12 && progress < .96
      }
      group.visible = markers.some((marker) => marker.visible) || Boolean(ring?.visible)
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((entry) => entry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}

function createAura(
  cue: Extract<SpellAnimationCue, { kind: 'aura' }>,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  const carrierActor = actorFor(actors, cue.actorId)
  const center = cue.center ?? carrierActor
  if (!center || !visible(map, center)) return null
  const detail = detailOf(cue)
  const style = styleFor(cue)
  const { geometries, materials, track, material } = resources()
  const group = new THREE.Group()
  const radius = cue.auraType === 'concentration' ? .48 : Math.max(.65, Number(cue.radiusFeet) / 5 || 1)
  const visibleArea = visibleRadius(map, center, radius)
  const bodyMaterial = material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true }))
  const accentMaterial = material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: .72, blending: THREE.AdditiveBlending, depthWrite: false }))
  const dome = new THREE.Mesh(track(new THREE.SphereGeometry(1, detail === 'full' ? 16 : 10, detail === 'full' ? 9 : 6)), bodyMaterial)
  dome.scale.set(visibleArea, Math.max(.35, visibleArea * .62), visibleArea)
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(visibleArea, .028, 6, detail === 'full' ? 28 : 16)), accentMaterial)
  ring.rotation.x = -Math.PI / 2
  group.add(dome, ring)
  const count = detail === 'full' ? 5 : detail === 'reduced' ? 3 : 1
  const particles = Array.from({ length: count }, (_, index) => {
    const mesh = new THREE.Mesh(track(new THREE.IcosahedronGeometry(.045, 0)), accentMaterial)
    group.add(mesh)
    return { mesh, angle: index * Math.PI * 2 / count, phase: index / count }
  })
  const ground = terrainHeightAt(map, center.x, center.y)

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      const fade = cue.active === false ? 1 - progress : Math.sin(Math.PI * progress)
      const pulse = .94 + Math.sin(progress * Math.PI * 2) * .06
      const centerWorld = new THREE.Vector3(center.x + .5, ground, center.y + .5)
      dome.position.copy(centerWorld).add(new THREE.Vector3(0, Math.max(.3, visibleArea * .4), 0))
      ring.position.copy(centerWorld).add(new THREE.Vector3(0, .05, 0))
      ring.scale.setScalar(pulse)
      bodyMaterial.opacity = fade * .22
      accentMaterial.opacity = fade * .78
      dome.visible = fade > .015 && visibleArea > .3
      ring.visible = dome.visible
      for (const particle of particles) {
        const phase = clamp01(progress * 1.2 - particle.phase * .2)
        particle.mesh.position.set(
          centerWorld.x + Math.cos(particle.angle + progress * Math.PI * 2) * visibleArea * .86,
          ground + .08 + phase * Math.max(.22, visibleArea * .72),
          centerWorld.z + Math.sin(particle.angle + progress * Math.PI * 2) * visibleArea * .86,
        )
        particle.mesh.visible = dome.visible && phase > 0 && phase < 1
      }
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
  const style = styleFor(cue)
  const green = material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .86, blending: THREE.AdditiveBlending, depthWrite: false }))
  const glow = material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: .45, blending: THREE.AdditiveBlending, depthWrite: false }))
  const lineMaterial = material(new THREE.LineBasicMaterial({ color: style.secondary, transparent: true, opacity: .75, blending: THREE.AdditiveBlending, depthWrite: false }))
  const ground = terrainHeightAt(map, target.x, target.y)
  const center = visualPoint(map, target, cue.position ? null : targetActor, .08)
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(.34, .02, 6, detail === 'full' ? 18 : 12)), green)
  ring.rotation.x = -Math.PI / 2
  group.add(ring)
  const column = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(center.x, ground + .08, center.z),
    new THREE.Vector3(center.x, ground + 1.3, center.z),
  ])), lineMaterial)
  group.add(column)
  const count = detail === 'full' ? 5 : detail === 'reduced' ? 3 : 2
  const particles = Array.from({ length: count }, (_, index) => {
    const mesh = new THREE.Mesh(track(new THREE.IcosahedronGeometry(.055, 0)), glow)
    group.add(mesh)
    return { mesh, phase: index / count, angle: index * 2.17 }
  })

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      const fade = Math.sin(progress * Math.PI)
      ring.position.set(center.x, ground + .06, center.z)
      ring.scale.setScalar(.75 + Math.sin(progress * Math.PI * 2) * .16)
      green.opacity = fade * .9
      lineMaterial.opacity = fade * .78
      column.visible = fade > .02
      const top = ground + .15 + Math.min(1.25, progress * 1.35)
      for (const particle of particles) {
        const rise = clamp01(progress * 1.25 - particle.phase * .22)
        particle.mesh.position.set(
          center.x + Math.cos(particle.angle + progress * Math.PI * 2) * (.13 + rise * .12),
          ground + .1 + rise * 1.18,
          center.z + Math.sin(particle.angle + progress * Math.PI * 2) * (.13 + rise * .12),
        )
        particle.mesh.visible = rise > 0 && rise < 1 && fade > .02
      }
      ;(column.geometry.getAttribute('position') as THREE.BufferAttribute).setXYZ(1, center.x, top, center.z)
      ;(column.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
      column.geometry.computeBoundingSphere()
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
  const variantMaterial = variant
    ? material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: .75, blending: THREE.AdditiveBlending, depthWrite: false, wireframe: variant === 'silence' }))
    : null
  const bodyMaterial = material(new THREE.MeshBasicMaterial({ color: style.primary, transparent: true, opacity: .28, blending: family === 'darkness' ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, wireframe: family === 'control' || family === 'darkness' || variant === 'silence' }))
  const accentMaterial = material(new THREE.MeshBasicMaterial({ color: style.secondary, transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false }))
  const ground = terrainHeightAt(map, target.x, target.y)
  const center = visualPoint(map, target, cue.position ? null : targetActor, .08)
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(.38, .024, 6, detail === 'full' ? 20 : 12)), accentMaterial)
  ring.rotation.x = -Math.PI / 2
  group.add(ring)
  const shieldLike = variant !== 'cancellation' && variant !== 'soul-transfer'
    && (style.family === 'protection' || (style.family === 'control' && variant !== 'silence') || style.family === 'darkness')
  const dome = shieldLike
    ? new THREE.Mesh(track(new THREE.SphereGeometry(.62, detail === 'full' ? 14 : 9, detail === 'full' ? 8 : 5)), bodyMaterial)
    : null
  if (dome) { dome.scale.y = 1.35; group.add(dome) }
  const portal = style.family === 'teleport' || style.family === 'summon'
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.48, .035, 6, detail === 'full' ? 20 : 12)), accentMaterial)
    : null
  if (portal) { portal.rotation.y = style.family === 'teleport' ? Math.PI / 2 : 0; group.add(portal) }
  const departurePortal = isTeleport && source
    ? new THREE.Mesh(track(new THREE.TorusGeometry(.48, .035, 6, detail === 'full' ? 20 : 12)), accentMaterial)
    : null
  if (departurePortal) { departurePortal.rotation.y = Math.PI / 2; group.add(departurePortal) }
  const count = variant === 'silence' || variant === 'cancellation' || variant === 'soul-transfer' ? 0 : detail === 'full' ? 5 : detail === 'reduced' ? 3 : 1
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
  const mobilityArc = family === 'mobility'
    ? new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([center, center, center])), accentMaterial)
    : null
  if (mobilityArc) group.add(mobilityArc)
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

  return {
    group,
    update(progressValue) {
      const progress = clamp01(progressValue)
      if (isTeleport) {
        const departure = source ? 1 - clamp01(progress / .4) : 0
        const arrival = source ? clamp01((progress - .6) / .4) : 1
        const sourceGround = source ? terrainHeightAt(map, source.x, source.y) : ground
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
        group.visible = ring.visible || Boolean(departurePortal?.visible || portal?.visible || particles.some(({ mesh }) => mesh.visible))
        return
      }
      const fade = Math.sin(Math.PI * progress)
      const lift = clamp01(progress * 1.2)
      ring.position.set(center.x, ground + .05, center.z)
      ring.scale.setScalar(.65 + fade * .55)
      ring.visible = fade > .015
      if (variant === 'cancellation' || variant === 'soul-transfer') ring.visible = false
      if (dome) {
        dome.position.set(center.x, ground + .5, center.z)
        dome.scale.set(.5 + fade * .3, (1.1 + fade * .3), .5 + fade * .3)
        dome.visible = fade > .02
      }
      if (portal) {
        portal.position.set(center.x, ground + .1 + lift * .25, center.z)
        portal.scale.setScalar(.55 + fade * .5)
        portal.visible = fade > .015
      }
      if (travel) {
        const current = new THREE.Vector3().lerpVectors(sourcePoint, center, progress)
        const middle = sourcePoint.clone().lerp(center, .5).add(new THREE.Vector3(0, .25, 0))
        setLinePoints(travel, sourcePoint, progress < .5 ? current : middle, current)
        travel.visible = progress > .04 && progress < .96
      }
      if (cancellationRing) {
        cancellationRing.position.set(center.x, ground + .06, center.z)
        cancellationRing.scale.setScalar(Math.max(.16, 1.1 - progress * .9))
        cancellationRing.visible = fade > .02 && progress < .92
      }
      if (cancellationSplits.length) {
        const base = new THREE.Vector3(center.x, ground + .08, center.z)
        const splitPhase = clamp01((progress - .3) / .62)
        const radius = .08 + splitPhase * .48
        for (const [index, line] of cancellationSplits.entries()) {
          const direction = index === 0 ? new THREE.Vector3(-radius, .08 + splitPhase * .2, 0) : new THREE.Vector3(radius, .08 + splitPhase * .2, 0)
          setLinePoints(line, base, base.clone().add(direction), base.clone().add(direction.multiplyScalar(1.2)))
          line.visible = splitPhase > 0 && splitPhase < 1 && fade > .02
        }
      }
      if (soulOrb && soulVessel) {
        const transfer = clamp01((progress - .08) / .84)
        const current = new THREE.Vector3().lerpVectors(sourcePoint, center, transfer)
        soulOrb.position.copy(current)
        soulOrb.scale.setScalar(.7 + Math.sin(Math.PI * transfer) * .55)
        soulOrb.visible = transfer > 0 && transfer < 1 && fade > .02
        soulVessel.position.copy(center)
        soulVessel.scale.setScalar(.65 + Math.sin(Math.PI * transfer) * .45)
        soulVessel.visible = transfer > .6 && fade > .02
        if (soulLine) {
          const middle = sourcePoint.clone().lerp(center, .5).add(new THREE.Vector3(0, .22, 0))
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
        const base = new THREE.Vector3(center.x, ground + .08, center.z)
        const middle = base.clone().add(new THREE.Vector3(0, .45 + lift * .4, 0))
        const end = base.clone().add(new THREE.Vector3(0, .9 + lift * .7, 0))
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
      if (mobilityArc) {
        const base = new THREE.Vector3(center.x, ground + .12, center.z)
        const left = base.clone().add(new THREE.Vector3(-.35 - lift * .15, .2 + lift * .45, 0))
        const right = base.clone().add(new THREE.Vector3(.35 + lift * .15, .2 + lift * .45, 0))
        setLinePoints(mobilityArc, base, left, right)
        mobilityArc.visible = fade > .02
      }
      if (communicationLine) {
        const current = new THREE.Vector3().lerpVectors(sourcePoint, center, progress)
        const middle = sourcePoint.clone().lerp(center, .5).add(new THREE.Vector3(0, .18, 0))
        setLinePoints(communicationLine, sourcePoint, progress < .5 ? current : middle, current)
        communicationLine.visible = progress > .06 && progress < .94
      }
      for (const particle of environmentParticles) {
        const phase = clamp01(progress * 1.25 - particle.phase * .22)
        particle.mesh.position.set(center.x + Math.cos(particle.angle + progress * Math.PI * 2) * (.16 + phase * .14), ground + .1 + phase * 1.05, center.z + Math.sin(particle.angle + progress * Math.PI * 2) * (.16 + phase * .14))
        particle.mesh.visible = phase > 0 && phase < 1 && fade > .02
      }
      if (spectralPalm) {
        const hand = new THREE.Vector3(center.x + Math.sin(progress * Math.PI * 2) * .18, ground + .5 + lift * .28, center.z)
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
      bodyMaterial.opacity = fade * .24
      accentMaterial.opacity = fade * .8
      group.visible = ring.visible || Boolean(dome?.visible || portal?.visible || travel?.visible || ghostA?.visible || ghostB?.visible || focusRay?.visible || lightColumn?.visible || morphCube?.visible || morphSphere?.visible || flightRing?.visible || familyWave?.visible || mobilityArc?.visible || communicationLine?.visible || spectralPalm?.visible || spectralCorePalm?.visible || trickParticles.some(({ mesh }) => mesh.visible) || book?.visible || chestBody?.visible || helmRing?.visible || silenceRing?.visible || cancellationRing?.visible || cancellationSplits.some((line) => line.visible) || soulOrb?.visible || soulVessel?.visible || soulLine?.visible || particles.some(({ mesh }) => mesh.visible) || environmentParticles.some(({ mesh }) => mesh.visible))
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((entry) => entry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}

/** Небольшой объёмный акцент подтверждённого spell-cue поверх 2D-слоя. */
export function createSpellEffect3D(
  cue: CombatAnimationCue,
  actors: readonly SpellEffectActor[],
  map: TacticalMap,
): SpellEffect3D | null {
  if (cue.kind === 'burst' && spellIdFromEffect(cue.spellId) === 'fireball') return createFireball(cue, actors, map)
  if (cue.kind === 'projectile') return createProjectile(cue, actors, map)
  if (cue.kind === 'burst') return createAreaBurst(cue, actors, map)
  if (cue.kind === 'beam') return createBeam(cue, actors, map)
  if (cue.kind === 'aura') return createAura(cue, actors, map)
  if (cue.kind === 'channel') return createChannel(cue, actors, map)
  return null
}
