import * as THREE from 'three'
import { attackOutcome, attackVisualStyleForActor, strikeImpactProgress, strikeLaunchProgress, strikeMotionProgress, type CombatAnimationCue, type BoardPoint, type AttackActorVisual, type AttackOutcome, type AttackVisualStyle } from './combat-animation'
import type { TacticalMap } from './types'
import { revealedAt } from './tactical-map-client'
import { SPELL_SCHOOL_STYLES, spellBurstCells, type SpellEffectDetail } from './spell-effects'
import { terrainHeightAt } from './board3d-terrain'
import { actorPresentationCenter } from './tactical-ui'
import type { ActorFootprint } from './types'

type CombatVisualActor = BoardPoint & AttackActorVisual & { id: string; footprint?: ActorFootprint }
type PhysicalProjectileKind = 'arrow' | 'bolt' | 'bullet' | 'stone' | 'dart' | 'thrown' | 'thrown-dagger' | 'thrown-spear' | 'thrown-axe' | 'thrown-net'
const RANGED_MODEL_KEYS = new Set([
  'shortbow', 'longbow', 'light-crossbow', 'hand-crossbow', 'heavy-crossbow',
  'sling', 'blowgun', 'musket', 'pistol',
])

function thrownProjectileKind(modelKey: unknown): Extract<PhysicalProjectileKind, `thrown${string}`> {
  const key = String(modelKey ?? '').toLocaleLowerCase('en-US')
  if (key === 'dagger') return 'thrown-dagger'
  if (key === 'net') return 'thrown-net'
  if (['javelin', 'spear', 'trident', 'lance', 'pike', 'glaive', 'halberd'].includes(key)) return 'thrown-spear'
  if (['handaxe', 'battleaxe', 'greataxe'].includes(key)) return 'thrown-axe'
  return 'thrown'
}

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
  const attackStyle: AttackVisualStyle | null = cue.kind === 'strike' ? attackVisualStyleForActor(cue, at(cue.actorId)) : null
  const outcome: AttackOutcome | null = cue.kind === 'strike' ? attackOutcome(cue) : null
  const attackColor = outcome === 'critical' ? '#ffe5a1' : outcome === 'blocked' ? '#8fc5ee' : outcome === 'miss' ? '#adb5c0'
    : attackStyle === 'pierce' ? '#e8edf6' : attackStyle === 'bludgeon' ? '#d59a63' : attackStyle === 'natural' ? '#d7a36c' : attackStyle === 'unarmed' ? '#efc08d' : '#efb976'
  const color = cue.kind === 'strike' ? attackColor : 'school' in cue ? SPELL_SCHOOL_STYLES[cue.school].primary
    : cue.kind === 'impact' && cue.tone === 'healing' ? '#85d8aa' : '#efb976'
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false })
  materials.add(material)
  const sphere = new THREE.SphereGeometry(.085, 8, 6)
  geometries.add(sphere)
  const projectileTrailGeometry = new THREE.CylinderGeometry(.018, .006, 1, 6)
  geometries.add(projectileTrailGeometry)
  const netGeometry = new THREE.PlaneGeometry(.78, .78, 4, 4)
  geometries.add(netGeometry)
  const netMaterial = new THREE.MeshBasicMaterial({ color: '#d7c5a1', transparent: true, opacity: .8, wireframe: true, depthWrite: false })
  materials.add(netMaterial)
  const sparks: Array<{ mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; phase: number; until: number }> = []
  const projectiles: Array<{ root: THREE.Group; trail: THREE.Mesh; trailLength: number; from: THREE.Vector3; to: THREE.Vector3; phase: number; arrival: number; arc: number; kind: PhysicalProjectileKind }> = []
  const strikeArcs: Array<{ root: THREE.Group; outcome: AttackOutcome }> = []
  const strikeMarkers: Array<{ root: THREE.Mesh }> = []
  const impactFlashes: Array<{ mesh: THREE.Mesh; phase: number; until: number }> = []
  const netContours: Array<{ mesh: THREE.Mesh; phase: number; until: number }> = []
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
  const strikeArc = (
    from: BoardPoint,
    to: BoardPoint,
    style: AttackVisualStyle,
    strikeOutcome: AttackOutcome,
    fromActor?: CombatVisualActor | null,
    toActor?: CombatVisualActor | null,
  ) => {
    if (!visible(from) || !visible(to) || !trajectoryVisible(from, to, fromActor, toActor) || !['slash', 'pierce', 'bludgeon', 'natural', 'unarmed'].includes(style)) return
    const center = vector(to, .76, toActor)
    const root = new THREE.Group()
    root.userData.attackStyle = style
    root.userData.attackOutcome = strikeOutcome
    root.position.copy(center)
    const dx = to.x - from.x
    const dz = to.y - from.y
    root.rotation.y = Math.atan2(dx, dz)
    const geometry = style === 'pierce'
      ? new THREE.ConeGeometry(.1, .62, 6)
      : style === 'natural'
        ? new THREE.TorusGeometry(.3, .04, 6, 18, Math.PI * .65)
      : style === 'bludgeon'
        ? new THREE.TorusGeometry(.36, .048, 6, 18)
        : new THREE.TorusGeometry(style === 'unarmed' ? .24 : .44, style === 'unarmed' ? .032 : .042, 6, 18, style === 'unarmed' ? Math.PI * .72 : Math.PI * .92)
    geometries.add(geometry)
    const mesh = new THREE.Mesh(geometry, material)
    if (style === 'pierce') {
      const direction = new THREE.Vector3(dx, 0, dz)
      if (direction.lengthSq() > 1e-8) mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
    }
    else mesh.rotation.x = Math.PI / 2
    root.add(mesh)
    group.add(root)
    strikeArcs.push({ root, outcome: strikeOutcome })
    if (strikeOutcome === 'critical' || strikeOutcome === 'blocked') {
      const markerGeometry = new THREE.TorusGeometry(strikeOutcome === 'critical' ? .38 : .3, .035, 6, 20)
      geometries.add(markerGeometry)
      const marker = new THREE.Mesh(markerGeometry, material)
      marker.userData.attackOutcome = strikeOutcome
      marker.position.copy(center)
      marker.rotation.x = Math.PI / 2
      group.add(marker)
      strikeMarkers.push({ root: marker })
    }
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
    const isThrown = kind.startsWith('thrown')
    const startHeight = isArrow ? .92 : isBolt ? .88 : isDart ? .84 : isBullet ? .78 : isStone ? .8 : .8
    const finishHeight = isArrow ? .84 : isBolt ? .8 : isDart ? .78 : isBullet ? .75 : isStone ? .72 : .72
    const start = vector(from, startHeight, fromActor)
    const finish = vector(to, finishHeight, toActor)
    if (isArrow || isBolt || isDart) {
      const shaftLength = isArrow ? .84 : isBolt ? .68 : .52
      const shaftRadius = isArrow ? .032 : isBolt ? .036 : .026
      const headRadius = isArrow ? .11 : isBolt ? .09 : .065
      const headLength = isArrow ? .22 : isBolt ? .18 : .15
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 6), material)
      const head = new THREE.Mesh(new THREE.ConeGeometry(headRadius, headLength, 6), material)
      shaft.position.y = .02
      head.position.y = shaftLength / 2 + headLength / 2
      root.add(shaft, head)
      geometries.add(shaft.geometry)
      geometries.add(head.geometry)
    } else if (isBullet) {
      const bullet = new THREE.Mesh(new THREE.CylinderGeometry(.055, .055, .16, 8), material)
      root.add(bullet)
      geometries.add(bullet.geometry)
    } else if (isStone) {
      const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(.065, 1), material)
      root.add(stone)
      geometries.add(stone.geometry)
    } else if (kind === 'thrown-net') {
      const net = new THREE.Mesh(netGeometry, netMaterial)
      net.rotation.y = Math.PI / 4
      root.add(net)
    } else if (isThrown) {
      // Снимок loadout выбирает силуэт метаемого предмета; после события
      // текущий инвентарь на него не влияет.
      const geometry = kind === 'thrown-spear'
        ? new THREE.ConeGeometry(.035, .78, 6)
        : kind === 'thrown-axe'
          ? new THREE.BoxGeometry(.22, .28, .07)
          : new THREE.ConeGeometry(kind === 'thrown-dagger' ? .06 : .075, kind === 'thrown-dagger' ? .34 : .42, 6)
      const thrownWeapon = new THREE.Mesh(geometry, material)
      root.add(thrownWeapon)
      geometries.add(thrownWeapon.geometry)
    } else {
      const mesh = new THREE.Mesh(sphere, material)
      mesh.scale.setScalar(1.45)
      geometries.add(mesh.geometry)
      root.add(mesh)
    }
    const trail = new THREE.Mesh(projectileTrailGeometry, material)
    trail.userData.projectileTrail = true
    group.add(root, trail)
    const arc = isArrow ? .28 : isBolt ? .2 : isDart ? .32 : isBullet ? .08 : isStone ? .38 : .5
    const launch = cue.kind === 'strike' ? strikeLaunchProgress(cue) : 0
    const trailLength = isArrow ? .28 : isBolt ? .24 : isDart ? .22 : isBullet ? .16 : isStone ? .2 : .3
    projectiles.push({ root, trail, trailLength, from: start, to: finish, phase: launch, arrival: cue.kind === 'strike' ? strikeImpactProgress(cue) : 1, arc, kind })
    if (isThrown || isStone) {
      const trailCount = detail === 'full' ? 5 : detail === 'reduced' ? 3 : 1
      const arrival = cue.kind === 'strike' ? strikeImpactProgress(cue) : 1
      for (let index = 0; index < trailCount; index += 1) spark(start, finish, launch + index * .035, 1.1 - index * .14, arrival)
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
    const strikeStyle = attackVisualStyleForActor(cue, sourceActor)
    const projectileKind = cue.attackKind === 'thrown'
      ? thrownProjectileKind(modelKey)
      : cue.attackKind === 'ranged' || (cue.attackKind == null && (cue.equipment === 'bow' || RANGED_MODEL_KEYS.has(String(modelKey ?? ''))))
        ? modelKey === 'light-crossbow' || modelKey === 'hand-crossbow' || modelKey === 'heavy-crossbow'
          ? 'bolt' as const
          : modelKey === 'musket' || modelKey === 'pistol'
            ? 'bullet' as const
            : modelKey === 'wand'
              ? 'dart' as const
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
      strikeArc(from, to, strikeStyle, outcome ?? (cue.hit ? 'hit' : 'miss'), sourceActor, targetActor)
    }
    const impactSparks = outcome === 'critical'
      ? detail === 'full' ? 24 : detail === 'reduced' ? 12 : 5
      : detail === 'full' ? 14 : detail === 'reduced' ? 8 : 3
    const impactProgress = strikeImpactProgress(cue)
    if (visible(to) && cue.hit && (!projectileKind || launched)) {
      const impactCenter = vector(to, .7, targetActor)
      const flash = new THREE.Mesh(sphere, material)
      flash.userData.impactFlash = true
      flash.position.copy(impactCenter)
      group.add(flash)
      impactFlashes.push({ mesh: flash, phase: impactProgress, until: Math.min(1, impactProgress + (outcome === 'critical' ? .3 : .2)) })
      if (projectileKind === 'thrown-net' && launched) {
        const contour = new THREE.Mesh(netGeometry, netMaterial)
        contour.userData.netContour = true
        contour.position.copy(vector(to, .12, targetActor))
        contour.rotation.x = -Math.PI / 2
        group.add(contour)
        netContours.push({ mesh: contour, phase: impactProgress, until: Math.min(1, impactProgress + .28) })
      }
      for (let index = 0; index < impactSparks; index++) {
        const angle = index * 2.4
        const end = impactCenter.clone().add(new THREE.Vector3(
          Math.cos(angle) * .45,
          -.4 + (index % 4) * .3,
          Math.sin(angle) * .45,
        ))
        spark(impactCenter.clone(), end, impactProgress + index * .012, .65)
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
      for (const { root, trail, trailLength, from, to, phase, arrival, arc, kind } of projectiles) {
        const t = THREE.MathUtils.clamp((progress - phase) / (arrival - phase), 0, 1)
        root.position.lerpVectors(from, to, t)
        root.position.y += Math.sin(t * Math.PI) * arc
        const direction = to.clone().sub(from).normalize()
        root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction)
        if (kind.startsWith('thrown')) root.rotateY(t * Math.PI * 8)
        root.scale.setScalar(kind === 'thrown-net' ? .35 + t * .95 : 1)
        const active = progress > phase && progress < arrival && t < 1 && revealedAt(map, Math.floor(root.position.x), Math.floor(root.position.z))
        root.visible = active
        trail.position.copy(root.position).addScaledVector(direction, -trailLength * .5)
        trail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction)
        trail.scale.set(1, trailLength, 1)
        trail.visible = active
      }
      for (const { mesh, from, to, phase, until } of sparks) {
        const t = THREE.MathUtils.clamp((progress - phase) / (until - phase), 0, 1)
        mesh.position.lerpVectors(from, to, t)
        if (travel) mesh.position.y += Math.sin(t * Math.PI) * .45
        mesh.visible = t > 0 && t < 1 && progress < until && revealedAt(map, Math.floor(mesh.position.x), Math.floor(mesh.position.z))
      }
      for (const mesh of beams) mesh.visible = progress > .13 && progress < .8
      for (const { root, outcome: strikeOutcome } of strikeArcs) {
        const motion = cue.kind === 'strike' ? strikeMotionProgress(cue, progress) : progress
        const t = motion
        const visibleWindow = progress > .04 && progress < .92
        const strength = t <= .5 ? .55 + t * .9 : Math.max(0, 1 - (t - .5) * 1.8)
        root.scale.setScalar(strength)
        root.rotation.z = (strikeOutcome === 'miss' ? -.35 : .2) + t * (strikeOutcome === 'blocked' ? -.3 : .65)
        root.visible = visibleWindow && strength > .08
      }
      for (const { root } of strikeMarkers) {
        const impact = cue.kind === 'strike' ? strikeImpactProgress(cue) : .3
        const t = THREE.MathUtils.clamp((progress - impact) / .62, 0, 1)
        root.scale.setScalar(.35 + t * 1.7)
        root.visible = progress >= impact && t < 1
      }
      for (const { mesh, phase, until } of impactFlashes) {
        const t = THREE.MathUtils.clamp((progress - phase) / Math.max(.001, until - phase), 0, 1)
        mesh.scale.setScalar((1 - t) * 3.2)
        mesh.visible = progress >= phase && progress < until && revealedAt(map, Math.floor(mesh.position.x), Math.floor(mesh.position.z))
      }
      netMaterial.opacity = Math.sin(progress * Math.PI) * .85
      for (const { mesh, phase, until } of netContours) {
        const t = THREE.MathUtils.clamp((progress - phase) / Math.max(.001, until - phase), 0, 1)
        mesh.scale.setScalar(1 + t * .35)
        mesh.visible = progress >= phase && progress < until && revealedAt(map, Math.floor(mesh.position.x), Math.floor(mesh.position.z))
      }
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}
