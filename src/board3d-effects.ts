import * as THREE from 'three'
import { strikeImpactProgress, type CombatAnimationCue, type BoardPoint } from './combat-animation'
import type { TacticalMap } from './types'
import { revealedAt } from './tactical-map-client'
import { SPELL_SCHOOL_STYLES, spellBurstCells, type SpellEffectDetail } from './spell-effects'
import { terrainHeightAt } from './board3d-terrain'
import { actorPresentationCenter } from './tactical-ui'
import type { ActorFootprint } from './types'

type CombatVisualActor = BoardPoint & { id: string; footprint?: ActorFootprint }
type PhysicalProjectileKind = 'arrow' | 'bolt' | 'bullet' | 'stone' | 'dart' | 'thrown'
const RANGED_MODEL_KEYS = new Set([
  'shortbow', 'longbow', 'light-crossbow', 'hand-crossbow', 'heavy-crossbow',
  'sling', 'blowgun', 'musket', 'pistol',
])

/** Возвращает центр площади существа, сохраняя один клеточный якорь в тумане. */
function visualCenter(map: TacticalMap, point: BoardPoint, actor?: CombatVisualActor | null) {
  return actor
    ? actorPresentationCenter(map, actor, { x: point.x, y: point.y })
    : { x: point.x + .5, y: point.y + .5 }
}

/** Пространственные акценты дополняют общий рисунок области, не считают попадания. */
export function createCombatEffect3D(
  cue: CombatAnimationCue,
  actors: readonly CombatVisualActor[],
  map: TacticalMap,
  requestedDetail?: SpellEffectDetail,
) {
  const group = new THREE.Group()
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const detailRank = (value: SpellEffectDetail) => value === 'full' ? 2 : value === 'reduced' ? 1 : 0
  const declaredDetail = cue.detail ?? 'full'
  const detail = requestedDetail && detailRank(requestedDetail) < detailRank(declaredDetail) ? requestedDetail : declaredDetail
  const at = (id: string | undefined): CombatVisualActor | null => id ? actors.find((actor) => actor.id === id) ?? null : null
  const visible = (point?: BoardPoint | null): point is BoardPoint => Boolean(point && revealedAt(map, Math.floor(point.x + .5), Math.floor(point.y + .5)))
  const color = 'school' in cue ? SPELL_SCHOOL_STYLES[cue.school].primary
    : cue.kind === 'impact' && cue.tone === 'healing' ? '#85d8aa' : '#efb976'
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false })
  materials.add(material)
  const sphere = new THREE.SphereGeometry(.085, 8, 6)
  geometries.add(sphere)
  const sparks: Array<{ mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; phase: number; until: number }> = []
  const projectiles: Array<{ root: THREE.Group; from: THREE.Vector3; to: THREE.Vector3; phase: number; arrival: number; arc: number }> = []
  const vector = (point: BoardPoint, height = .7, actor?: CombatVisualActor | null) => {
    const center = visualCenter(map, point, actor)
    const terrainPoint = actor ? point : { x: point.x + .5, y: point.y + .5 }
    return new THREE.Vector3(center.x, terrainHeightAt(map, terrainPoint.x, terrainPoint.y) + height, center.y)
  }
  const spark = (from: THREE.Vector3, to: THREE.Vector3, phase: number, scale = 1, until = 1) => {
    const mesh = new THREE.Mesh(sphere, material)
    mesh.scale.setScalar(scale)
    group.add(mesh)
    sparks.push({ mesh, from, to, phase, until })
  }
  const beams: THREE.Mesh[] = []
  const beam = (
    from: BoardPoint,
    to: BoardPoint,
    lightning: boolean,
    fromActor?: CombatVisualActor | null,
    toActor?: CombatVisualActor | null,
  ) => {
    if (!visible(from) || !visible(to)) return
    // Каждая часть луча проверяется отдельно: эффект не рисует путь сквозь туман.
    const density = detail === 'full' ? 5 : detail === 'reduced' ? 2 : 1
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * density))
    const start = vector(from, .7, fromActor), finish = vector(to, .7, toActor)
    let previous = start.clone()
    for (let index = 1; index <= steps; index++) {
      const progress = index / steps
      const next = new THREE.Vector3(
        start.x + (finish.x - start.x) * progress,
        start.y + (finish.y - start.y) * progress + (lightning ? Math.sin(index * 7.3) * .14 : 0),
        start.z + (finish.z - start.z) * progress,
      )
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
  const trajectoryVisible = (
    from: BoardPoint,
    to: BoardPoint,
    fromActor?: CombatVisualActor | null,
    toActor?: CombatVisualActor | null,
  ) => {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))))
    const start = visualCenter(map, from, fromActor)
    const finish = visualCenter(map, to, toActor)
    for (let index = 0; index <= steps; index += 1) {
      const progress = index / steps
      if (!revealedAt(map, Math.floor(start.x + (finish.x - start.x) * progress), Math.floor(start.y + (finish.y - start.y) * progress))) return false
    }
    return true
  }
  const projectile = (
    from: BoardPoint,
    to: BoardPoint,
    kind: PhysicalProjectileKind,
    fromActor?: CombatVisualActor | null,
    toActor?: CombatVisualActor | null,
  ) => {
    if (!visible(from) || !visible(to) || !trajectoryVisible(from, to, fromActor, toActor)) return false
    const root = new THREE.Group()
    root.userData.projectileKind = kind
    const isArrow = kind === 'arrow'
    const isBolt = kind === 'bolt'
    const isDart = kind === 'dart'
    const isBullet = kind === 'bullet'
    const isStone = kind === 'stone'
    const startHeight = isArrow ? .92 : isBolt ? .88 : isDart ? .84 : isBullet ? .78 : isStone ? .8 : .8
    const finishHeight = isArrow ? .84 : isBolt ? .8 : isDart ? .78 : isBullet ? .75 : isStone ? .72 : .72
    const start = vector(from, startHeight, fromActor)
    const finish = vector(to, finishHeight, toActor)
    if (isArrow || isBolt || isDart) {
      const shaftLength = isArrow ? .72 : isBolt ? .56 : .44
      const shaftRadius = isArrow ? .026 : isBolt ? .031 : .022
      const headRadius = isArrow ? .09 : isBolt ? .075 : .055
      const headLength = isArrow ? .2 : isBolt ? .15 : .13
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 6), material)
      const head = new THREE.Mesh(new THREE.ConeGeometry(headRadius, headLength, 6), material)
      shaft.position.y = .02
      head.position.y = shaftLength / 2 + headLength / 2
      root.add(shaft, head)
      geometries.add(shaft.geometry)
      geometries.add(head.geometry)
    } else if (isBullet) {
      const bullet = new THREE.Mesh(new THREE.CylinderGeometry(.045, .045, .14, 8), material)
      root.add(bullet)
      geometries.add(bullet.geometry)
    } else if (isStone) {
      const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(.065, 1), material)
      root.add(stone)
      geometries.add(stone.geometry)
    } else {
      const mesh = new THREE.Mesh(sphere, material)
      mesh.scale.setScalar(1.45)
      geometries.add(mesh.geometry)
      root.add(mesh)
    }
    group.add(root)
    const arc = isArrow ? .28 : isBolt ? .2 : isDart ? .32 : isBullet ? .08 : isStone ? .38 : .5
    projectiles.push({ root, from: start, to: finish, phase: 0, arrival: cue.kind === 'strike' ? strikeImpactProgress(cue) : 1, arc })
    if (kind === 'thrown' || isStone) {
      const trailCount = detail === 'full' ? 5 : detail === 'reduced' ? 3 : 1
      const arrival = cue.kind === 'strike' ? strikeImpactProgress(cue) : 1
      for (let index = 0; index < trailCount; index += 1) spark(start, finish, index * .035, 1.1 - index * .14, arrival)
    }
    return true
  }
  let travel = false
  if (cue.kind === 'projectile') {
    const sourceActor = at(cue.actorId)
    const from = cue.from ?? sourceActor
    const projectileCount = detail === 'full' ? Math.min(12, cue.projectileCount) : detail === 'reduced' ? Math.min(6, cue.projectileCount) : 1
    const trailCount = detail === 'full' ? 5 : detail === 'reduced' ? 3 : 1
    if (visible(from)) for (let index = 0; index < projectileCount; index++) {
      const targetActor = at(cue.targetIds[index % Math.max(1, cue.targetIds.length)])
      const to = targetActor ?? cue.to
      if (!visible(to)) continue
      for (let tail = 0; tail < trailCount; tail++) spark(
        vector(from, .7, sourceActor),
        vector(to, .7, targetActor),
        index * .065 + tail * .025,
        1.5 - tail * .2,
      )
    }
    travel = true
  } else if (cue.kind === 'beam') {
    const sourceActor = at(cue.actorId)
    const from = cue.from ?? sourceActor
    if (visible(from)) {
      let previous: BoardPoint = from
      let previousActor: CombatVisualActor | null = sourceActor
      const targets = cue.points?.length
        ? cue.points.map((point, index) => ({ point, actor: at(cue.targetIds[index]) }))
        : cue.targetIds.map((id) => ({ point: at(id), actor: at(id) }))
      for (const target of targets) {
        if (!visible(target.point)) continue
        beam(previous, target.point, true, previousActor, target.actor)
        if (cue.chain) { previous = target.point; previousActor = target.actor }
      }
    }
  } else if (cue.kind === 'strike') {
    const sourceActor = at(cue.actorId)
    const targetActor = at(cue.targetId)
    const from = cue.from ?? sourceActor
    const to = cue.to ?? targetActor
    const modelKey = cue.loadout?.main_hand?.model_key
    const projectileKind = cue.attackKind === 'thrown'
      ? 'thrown' as const
      : cue.attackKind === 'ranged' || (cue.attackKind == null && (cue.equipment === 'bow' || RANGED_MODEL_KEYS.has(String(modelKey ?? ''))))
        ? modelKey === 'light-crossbow' || modelKey === 'hand-crossbow' || modelKey === 'heavy-crossbow'
          ? 'bolt' as const
          : modelKey === 'musket' || modelKey === 'pistol'
            ? 'bullet' as const
            : modelKey === 'sling'
              ? 'stone' as const
              : modelKey === 'blowgun' || modelKey === 'dart'
                ? 'dart' as const
                : 'arrow' as const
        : null
    let launched = false
    if (projectileKind) {
      // Явный дальний/метательный удар рисуется только по зафиксированной
      // сервером траектории. Позиции текущего кадра не могут заменить её:
      // между событием и доставкой участники уже могли сделать ход.
      if (cue.from && cue.to) launched = projectile(cue.from, cue.to, projectileKind, sourceActor, targetActor)
    } else if (visible(from) && visible(to)) {
      beam(from, to, false, sourceActor, targetActor)
    }
    const impactSparks = detail === 'full' ? 14 : detail === 'reduced' ? 8 : 3
    const impactProgress = projectileKind ? strikeImpactProgress(cue) : 0
    if (visible(to) && cue.hit && (!projectileKind || launched)) {
      const impactCenter = vector(to, .7, targetActor)
      for (let index = 0; index < impactSparks; index++) {
        const angle = index * 2.4
        const end = impactCenter.clone().add(new THREE.Vector3(
          Math.cos(angle) * .45,
          -.4 + (index % 4) * .3,
          Math.sin(angle) * .45,
        ))
        spark(impactCenter.clone(), end, projectileKind ? impactProgress + index * .012 : index / (impactSparks + 8), .65)
      }
    }
  } else {
    const burst = cue.kind === 'burst' ? spellBurstCells(map, cue, actors) : null
    const center = cue.kind === 'burst' ? burst?.[0]
      : cue.kind === 'aura' ? cue.center ?? at(cue.actorId)
        : cue.kind === 'channel' ? cue.position ?? at(cue.targetId ?? cue.actorId)
          : 'targetId' in cue ? at(cue.targetId) : undefined
    const centerActor = cue.kind === 'aura' && !cue.center
      ? at(cue.actorId)
      : cue.kind === 'channel' && !cue.position
        ? at(cue.targetId ?? cue.actorId)
        : 'targetId' in cue ? at(cue.targetId) : null
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
        const cellActor = !burst && centerActor ? centerActor : null
        if (cellActor) {
          const origin = vector(cell, healing ? .05 : .25, cellActor)
          const endpoint = origin.clone().add(new THREE.Vector3(
            Math.cos(angle) * radius,
            .1 + (index % 7) * .19,
            Math.sin(angle) * radius,
          ))
          if (!revealedAt(map, Math.floor(endpoint.x), Math.floor(endpoint.z))) continue
          spark(origin, endpoint, index / 90, .65 + (index % 3) * .3)
        } else {
          if (!visible(end)) continue
          spark(vector(cell, healing ? .05 : .25), vector(end, .35 + (index % 7) * .19), index / 90, .65 + (index % 3) * .3)
        }
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
