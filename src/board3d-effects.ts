import * as THREE from 'three'
import { strikeImpactProgress, type AttackKind, type CombatAnimationCue, type BoardPoint } from './combat-animation'
import type { TacticalMap } from './types'
import { revealedAt } from './tactical-map-client'
import { SPELL_SCHOOL_STYLES, spellBurstCells, type SpellEffectDetail } from './spell-effects'
import { terrainHeightAt } from './board3d-terrain'

/** Пространственные акценты дополняют общий рисунок области, не считают попадания. */
export function createCombatEffect3D(
  cue: CombatAnimationCue,
  actors: readonly (BoardPoint & { id: string })[],
  map: TacticalMap,
  requestedDetail?: SpellEffectDetail,
) {
  const group = new THREE.Group()
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const detailRank = (value: SpellEffectDetail) => value === 'full' ? 2 : value === 'reduced' ? 1 : 0
  const declaredDetail = cue.detail ?? 'full'
  const detail = requestedDetail && detailRank(requestedDetail) < detailRank(declaredDetail) ? requestedDetail : declaredDetail
  const at = (id: string) => actors.find((actor) => actor.id === id)
  const visible = (point?: BoardPoint): point is BoardPoint => Boolean(point && revealedAt(map, Math.floor(point.x + .5), Math.floor(point.y + .5)))
  const color = 'school' in cue ? SPELL_SCHOOL_STYLES[cue.school].primary
    : cue.kind === 'impact' && cue.tone === 'healing' ? '#85d8aa' : '#efb976'
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false })
  materials.add(material)
  const sphere = new THREE.SphereGeometry(.085, 8, 6)
  geometries.add(sphere)
  const sparks: Array<{ mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; phase: number; until: number }> = []
  const projectiles: Array<{ root: THREE.Group; from: THREE.Vector3; to: THREE.Vector3; phase: number; arrival: number; arc: number }> = []
  const vector = (point: BoardPoint, height = .7) => new THREE.Vector3(point.x + .5, terrainHeightAt(map, point.x + .5, point.y + .5) + height, point.y + .5)
  const spark = (from: THREE.Vector3, to: THREE.Vector3, phase: number, scale = 1, until = 1) => {
    const mesh = new THREE.Mesh(sphere, material)
    mesh.scale.setScalar(scale)
    group.add(mesh)
    sparks.push({ mesh, from, to, phase, until })
  }
  const beams: THREE.Mesh[] = []
  const beam = (from: BoardPoint, to: BoardPoint, lightning: boolean) => {
    if (!visible(from) || !visible(to)) return
    // Каждая часть луча проверяется отдельно: эффект не рисует путь сквозь туман.
    const density = detail === 'full' ? 5 : detail === 'reduced' ? 2 : 1
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * density))
    const start = vector(from), finish = vector(to)
    let previous = start.clone()
    for (let index = 1; index <= steps; index++) {
      const progress = index / steps
      const point = { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress }
      const next = new THREE.Vector3(point.x + .5, start.y + (finish.y - start.y) * progress + (lightning ? Math.sin(index * 7.3) * .14 : 0), point.y + .5)
      if (revealedAt(map, Math.floor(next.x), Math.floor(next.z)) && revealedAt(map, Math.floor(previous.x), Math.floor(previous.z))) {
        const direction = next.clone().sub(previous)
        const geometry = new THREE.CylinderGeometry(.028, .05, direction.length(), 6)
        geometries.add(geometry)
        const mesh = new THREE.Mesh(geometry, material)
        mesh.position.copy(previous).add(next).multiplyScalar(.5)
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
        group.add(mesh)
        beams.push(mesh)
      }
      previous = next
    }
  }
  const trajectoryVisible = (from: BoardPoint, to: BoardPoint) => {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))))
    for (let index = 0; index <= steps; index += 1) {
      const progress = index / steps
      if (!revealedAt(map, Math.floor(from.x + (to.x - from.x) * progress + .5), Math.floor(from.y + (to.y - from.y) * progress + .5))) return false
    }
    return true
  }
  const projectile = (from: BoardPoint, to: BoardPoint, kind: 'arrow' | 'thrown') => {
    if (!visible(from) || !visible(to) || !trajectoryVisible(from, to)) return false
    const root = new THREE.Group()
    const start = vector(from, kind === 'arrow' ? .92 : .8)
    const finish = vector(to, kind === 'arrow' ? .84 : .72)
    if (kind === 'arrow') {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(.026, .026, .72, 6), material)
      const head = new THREE.Mesh(new THREE.ConeGeometry(.09, .2, 6), material)
      shaft.position.y = .02
      head.position.y = .47
      root.add(shaft, head)
      geometries.add(shaft.geometry)
      geometries.add(head.geometry)
    } else {
      const mesh = new THREE.Mesh(sphere, material)
      mesh.scale.setScalar(1.45)
      root.add(mesh)
    }
    group.add(root)
    projectiles.push({ root, from: start, to: finish, phase: 0, arrival: cue.kind === 'strike' ? strikeImpactProgress(cue) : 1, arc: kind === 'arrow' ? .28 : .5 })
    if (kind === 'thrown') {
      const trailCount = detail === 'full' ? 5 : detail === 'reduced' ? 3 : 1
      const arrival = cue.kind === 'strike' ? strikeImpactProgress(cue) : 1
      for (let index = 0; index < trailCount; index += 1) spark(start, finish, index * .035, 1.1 - index * .14, arrival)
    }
    return true
  }
  const attackProjectileKind = (attackKind: AttackKind | undefined, equipment: string | undefined) => {
    if (attackKind === 'thrown') return 'thrown' as const
    if (attackKind === 'ranged' || (attackKind == null && equipment === 'bow')) return 'arrow' as const
    return null
  }
  let travel = false
  if (cue.kind === 'projectile') {
    const from = cue.from ?? at(cue.actorId)
    const projectileCount = detail === 'full' ? Math.min(12, cue.projectileCount) : detail === 'reduced' ? Math.min(6, cue.projectileCount) : 1
    const trailCount = detail === 'full' ? 5 : detail === 'reduced' ? 3 : 1
    if (visible(from)) for (let index = 0; index < projectileCount; index++) {
      const to = at(cue.targetIds[index % Math.max(1, cue.targetIds.length)]) ?? cue.to
      if (!visible(to)) continue
      for (let tail = 0; tail < trailCount; tail++) spark(vector(from), vector(to), index * .065 + tail * .025, 1.5 - tail * .2)
    }
    travel = true
  } else if (cue.kind === 'beam') {
    const from = cue.from ?? at(cue.actorId)
    if (visible(from)) {
      let previous: BoardPoint = from
      const targets = (cue.points?.length ? cue.points : cue.targetIds.map(at)).filter(visible)
      for (const to of targets) {
        beam(previous, to, true)
        if (cue.chain) previous = to
      }
    }
  } else if (cue.kind === 'strike') {
    const from = cue.from ?? at(cue.actorId), to = cue.to ?? at(cue.targetId)
    const projectileKind = attackProjectileKind(cue.attackKind, cue.equipment)
    let launched = false
    if (projectileKind) {
      // Явный дальний/метательный удар рисуется только по зафиксированной
      // сервером траектории. Позиции текущего кадра не могут заменить её:
      // между событием и доставкой участники уже могли сделать ход.
      if (cue.from && cue.to) launched = projectile(cue.from, cue.to, projectileKind)
    } else if (visible(from) && visible(to)) {
      beam(from, to, false)
    }
    const impactSparks = detail === 'full' ? 14 : detail === 'reduced' ? 8 : 3
    const impactProgress = projectileKind ? strikeImpactProgress(cue) : 0
    if (visible(to) && cue.hit && (!projectileKind || launched)) for (let index = 0; index < impactSparks; index++) {
      const angle = index * 2.4
      spark(vector(to), vector({ x: to.x + Math.cos(angle) * .45, y: to.y + Math.sin(angle) * .45 }, .3 + (index % 4) * .3), projectileKind ? impactProgress + index * .012 : index / (impactSparks + 8), .65)
    }
  } else {
    const burst = cue.kind === 'burst' ? spellBurstCells(map, cue, actors) : null
    const center = cue.kind === 'burst' ? burst?.[0]
      : cue.kind === 'aura' ? cue.center ?? at(cue.actorId)
        : cue.kind === 'channel' ? cue.position ?? at(cue.targetId ?? cue.actorId)
          : 'targetId' in cue ? at(cue.targetId) : undefined
    if (visible(center)) {
      const cells = burst ?? [center]
      const healing = cue.kind === 'channel' && cue.channelType === 'healing'
      const capacity = detail === 'full' ? 64 : detail === 'reduced' ? 40 : 18
      const minimum = detail === 'full' ? 24 : detail === 'reduced' ? 12 : 4
      const count = Math.min(capacity, Math.max(minimum, cells.length * 2))
      for (let index = 0; index < count; index++) {
        const cell = cells[Math.floor(index * cells.length / count)]
        if (!cell) continue
        const angle = index * 2.39996
        const radius = .35
        const end = { x: cell.x + Math.cos(angle) * radius, y: cell.y + Math.sin(angle) * radius }
        if (!visible(end)) continue
        spark(vector(cell, healing ? .05 : .25), vector(end, .35 + (index % 7) * .19), index / 90, .65 + (index % 3) * .3)
      }
    }
  }
  return {
    group,
    update(progress: number) {
      material.opacity = Math.sin(progress * Math.PI) * .9
      for (const { root, from, to, phase, arrival, arc } of projectiles) {
        const t = THREE.MathUtils.clamp((progress - phase) / (arrival - phase), 0, 1)
        root.position.lerpVectors(from, to, t)
        root.position.y += Math.sin(t * Math.PI) * arc
        const direction = to.clone().sub(from).normalize()
        root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction)
        root.visible = progress > phase && progress < arrival && t < 1 && revealedAt(map, Math.floor(root.position.x), Math.floor(root.position.z))
      }
      for (const { mesh, from, to, phase, until } of sparks) {
        const t = THREE.MathUtils.clamp((progress - phase) / (until - phase), 0, 1)
        mesh.position.lerpVectors(from, to, t)
        if (travel) mesh.position.y += Math.sin(t * Math.PI) * .45
        mesh.visible = t > 0 && t < 1 && progress < until && revealedAt(map, Math.floor(mesh.position.x), Math.floor(mesh.position.z))
      }
      for (const mesh of beams) mesh.visible = progress > .13 && progress < .8
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}
