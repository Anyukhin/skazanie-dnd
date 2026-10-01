import * as THREE from 'three'
import { attackOutcome, attackVisualStyleForActor, strikeImpactProgress, strikeLaunchProgress, strikeMotionProgress, type CombatAnimationCue, type BoardPoint, type AttackActorVisual, type AttackOutcome, type AttackVisualStyle } from './combat-animation'
import type { TacticalMap } from './types'
import { revealedAt } from './tactical-map-client'
import { SPELL_SCHOOL_STYLES, spellBurstCells, type SpellEffectDetail } from './spell-effects'
import { terrainHeightAt } from './board3d-terrain'
import { actorPresentationCenter } from './tactical-ui'
import { effectLightRig } from './board3d-spell-effects'
import type { ActorFootprint } from './types'

type CombatVisualActor = BoardPoint & AttackActorVisual & { id: string; footprint?: ActorFootprint }
type PhysicalProjectileKind = 'arrow' | 'bolt' | 'bullet' | 'stone' | 'dart' | 'thrown' | 'thrown-dagger' | 'thrown-spear' | 'thrown-axe' | 'thrown-net'
const RANGED_MODEL_KEYS = new Set([
  'shortbow', 'longbow', 'light-crossbow', 'hand-crossbow', 'heavy-crossbow',
  'sling', 'blowgun', 'musket', 'pistol',
])
const UP = new THREE.Vector3(0, 1, 0)

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

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number(value) || 0))
const easeOutCubic = (value: number) => 1 - (1 - clamp01(value)) ** 3

/** Цвет ярче единицы проходит порог bloom на «Обычном» и «Высоком». */
function glow(color: THREE.ColorRepresentation, strength: number) {
  return new THREE.Color(color).multiplyScalar(strength)
}

function additive(color: THREE.ColorRepresentation, opacity: number, extra: THREE.MeshBasicMaterialParameters = {}) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, ...extra })
}

/** Цвет следа по оружию: сталь клинка, тёплое дерево и железо дробящего. */
const WEAPON_TRAIL_COLORS: Partial<Record<AttackVisualStyle, string>> = {
  slash: '#e2eaf6',
  pierce: '#eef3fb',
  bludgeon: '#eab27a',
  natural: '#efc08a',
  unarmed: '#f3cfa2',
}

/**
 * Исход меняет яркость и оттенок следа, а не только форму: крит — золотой и
 * яркий, промах — тусклый серый, блок — холодный синий щит.
 */
function strikePalette(style: AttackVisualStyle, outcome: AttackOutcome) {
  const base = WEAPON_TRAIL_COLORS[style] ?? '#efb976'
  if (outcome === 'critical') return { core: glow('#fff1b8', 3), halo: glow('#ffc24f', 1.2), impact: glow('#fff3c4', 3) }
  if (outcome === 'miss') return { core: glow('#a7b0bd', 1.05), halo: glow('#707986', .8), impact: glow('#a7b0bd', 1) }
  if (outcome === 'blocked') return { core: glow('#d4e9ff', 2), halo: glow('#8fc5ee', 1), impact: glow('#e3f2ff', 2.4) }
  return { core: glow(base, 2), halo: glow(base, .9), impact: glow('#fff2d6', 2.6) }
}

/**
 * Дуга следа гаснет к хвосту вершинными цветами: при аддитивном смешивании
 * тёмный хвост исчезает, а голова удара остаётся яркой.
 */
function trailArcGeometry(radius: number, tube: number, arc: number, segments: number) {
  const geometry = new THREE.TorusGeometry(radius, tube, 5, segments, arc)
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute
  const colors = new Float32Array(positions.count * 3)
  for (let index = 0; index < positions.count; index += 1) {
    let angle = Math.atan2(positions.getY(index), positions.getX(index))
    if (angle < -1e-6) angle += Math.PI * 2
    const level = clamp01(angle / arc) ** 1.4
    colors[index * 3] = colors[index * 3 + 1] = colors[index * 3 + 2] = level
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
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
  const track = <T extends THREE.BufferGeometry>(geometry: T) => { geometries.add(geometry); return geometry }
  const own = <T extends THREE.Material>(value: T) => { materials.add(value); return value }
  const detailRank = (value: SpellEffectDetail) => value === 'full' ? 2 : value === 'reduced' ? 1 : 0
  const declaredDetail = cue.detail ?? 'full'
  const detail = requestedDetail && detailRank(requestedDetail) < detailRank(declaredDetail) ? requestedDetail : declaredDetail
  const lights = effectLightRig(group, detail)
  const at = (id: string | undefined): CombatVisualActor | null => id ? actors.find((actor) => actor.id === id) ?? null : null
  const visible = (point?: BoardPoint | null): point is BoardPoint => Boolean(point && revealedAt(map, Math.floor(point.x + .5), Math.floor(point.y + .5)))
  const attackStyle: AttackVisualStyle | null = cue.kind === 'strike' ? attackVisualStyleForActor(cue, at(cue.actorId)) : null
  const outcome: AttackOutcome | null = cue.kind === 'strike' ? attackOutcome(cue) : null
  const attackColor = outcome === 'critical' ? '#ffe5a1' : outcome === 'blocked' ? '#8fc5ee' : outcome === 'miss' ? '#adb5c0'
    : attackStyle === 'pierce' ? '#e8edf6' : attackStyle === 'bludgeon' ? '#d59a63' : attackStyle === 'natural' ? '#d7a36c' : attackStyle === 'unarmed' ? '#efc08d' : '#efb976'
  const color = cue.kind === 'strike' ? attackColor : 'school' in cue ? SPELL_SCHOOL_STYLES[cue.school].primary
    : cue.kind === 'impact' && cue.tone === 'healing' ? '#85d8aa' : '#efb976'
  const material = own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false }))
  const sphere = track(new THREE.SphereGeometry(.085, 8, 6))
  const projectileTrailGeometry = track(new THREE.CylinderGeometry(.03, .004, 1, 6))
  const netGeometry = track(new THREE.PlaneGeometry(.78, .78, 4, 4))
  const netMaterial = own(new THREE.MeshBasicMaterial({ color: '#d7c5a1', transparent: true, opacity: .8, wireframe: true, depthWrite: false }))
  const palette = cue.kind === 'strike' ? strikePalette(attackStyle ?? 'slash', outcome ?? 'hit') : null
  const strikeCoreMaterial = palette ? own(additive(palette.core, .95, { vertexColors: true })) : null
  const strikeHaloMaterial = palette && detail !== 'minimal' ? own(additive(palette.halo, .4, { vertexColors: true })) : null
  const flatCoreMaterial = palette ? own(additive(palette.core, .95)) : null
  const impactMaterial = palette ? own(additive(palette.impact, .95)) : null
  const projectileStreakMaterial = palette ? own(additive(palette.halo, .5)) : null
  const spikeGeometry = track(new THREE.ConeGeometry(.026, .36, 4))
  const sparks: Array<{ mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; phase: number; until: number }> = []
  const projectiles: Array<{ root: THREE.Group; trail: THREE.Mesh; trailLength: number; from: THREE.Vector3; to: THREE.Vector3; direction: THREE.Vector3; phase: number; arrival: number; arc: number; kind: PhysicalProjectileKind }> = []
  type ArcLayer = { mesh: THREE.Mesh; lag: number; scale: number }
  const strikeArcs: Array<{ root: THREE.Group; outcome: AttackOutcome; style: AttackVisualStyle; layers: ArcLayer[]; thrust: THREE.Mesh[] }> = []
  const strikeMarkers: Array<{ root: THREE.Object3D; kind: 'critical' | 'shield' | 'shock' }> = []
  const impactFlashes: Array<{ mesh: THREE.Mesh; phase: number; until: number; scale: number }> = []
  const spikes: Array<{ mesh: THREE.Mesh; origin: THREE.Vector3; direction: THREE.Vector3; phase: number; until: number; reach: number }> = []
  const netContours: Array<{ mesh: THREE.Mesh; phase: number; until: number }> = []
  let lightAt: THREE.Vector3 | null = null
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
  /**
   * Искры попадания — короткие лучи-«трещины» от точки удара, а не облако
   * частиц: несколько штрихов, которые вылетают и сразу гаснут.
   */
  const spikeBurst = (origin: THREE.Vector3, count: number, phase: number, reach: number, facing?: THREE.Vector3) => {
    for (let index = 0; index < count; index += 1) {
      const angle = index * 2.39996 + .4
      const direction = new THREE.Vector3(Math.cos(angle), .35 + (index % 3) * .3, Math.sin(angle)).normalize()
      if (facing) direction.addScaledVector(facing, -.6).normalize()
      const mesh = new THREE.Mesh(spikeGeometry, impactMaterial ?? material)
      mesh.quaternion.setFromUnitVectors(UP, direction)
      mesh.position.copy(origin)
      group.add(mesh)
      spikes.push({ mesh, origin, direction, phase: phase + (index % 3) * .012, until: Math.min(1, phase + .22), reach })
    }
  }
  const strikeArc = (
    from: BoardPoint,
    to: BoardPoint,
    style: AttackVisualStyle,
    strikeOutcome: AttackOutcome,
    fromActor?: CombatVisualActor | null,
    toActor?: CombatVisualActor | null,
  ) => {
    if (!visible(from) || !visible(to) || !trajectoryVisible(from, to, fromActor, toActor) || !['slash', 'pierce', 'bludgeon', 'natural', 'unarmed'].includes(style)) return null
    const center = vector(to, .76, toActor)
    const root = new THREE.Group()
    root.userData.attackStyle = style
    root.userData.attackOutcome = strikeOutcome
    const source = visualCenter(map, from, fromActor)
    const target = visualCenter(map, to, toActor)
    const dx = target.x - source.x
    const dz = target.y - source.y
    const length = Math.hypot(dx, dz) || 1
    const direction = new THREE.Vector3(dx / length, 0, dz / length)
    const side = new THREE.Vector3(direction.z, 0, -direction.x)
    root.position.copy(center)
    // Промах — смазанный след рядом с целью, а не дуга по ней.
    if (strikeOutcome === 'miss') root.position.addScaledVector(side, .48).addScaledVector(direction, .2)
    root.rotation.y = Math.atan2(direction.x, direction.z)
    const size = strikeOutcome === 'critical' ? 1.35 : strikeOutcome === 'miss' ? 1.1 : 1
    const layers: ArcLayer[] = []
    const thrust: THREE.Mesh[] = []
    const segments = detail === 'full' ? 28 : detail === 'reduced' ? 20 : 14
    const addArc = (radius: number, arc: number, lag = 0, scale = 1) => {
      const core = new THREE.Mesh(track(trailArcGeometry(radius * size, .03 * size, arc, segments)), strikeCoreMaterial!)
      root.add(core)
      layers.push({ mesh: core, lag, scale })
      if (strikeHaloMaterial) {
        const halo = new THREE.Mesh(track(trailArcGeometry(radius * size, .09 * size, arc, segments)), strikeHaloMaterial)
        root.add(halo)
        layers.push({ mesh: halo, lag, scale })
      }
    }
    if (style === 'pierce') {
      // Укол — прямой выпад сквозь цель, а не дуга.
      const core = new THREE.Mesh(track(new THREE.ConeGeometry(.045 * size, .95 * size, 6)), flatCoreMaterial!)
      core.rotation.x = Math.PI / 2
      root.add(core)
      thrust.push(core)
      if (strikeHaloMaterial) {
        const halo = new THREE.Mesh(track(new THREE.ConeGeometry(.13 * size, .95 * size, 6)), own(additive(palette!.halo, .3)))
        halo.rotation.x = Math.PI / 2
        root.add(halo)
        thrust.push(halo)
      }
    } else if (style === 'natural') {
      // Когти: три параллельных росчерка.
      for (const radius of [.26, .34, .42]) addArc(radius, Math.PI * .6)
    } else if (style === 'bludgeon') {
      addArc(.4, Math.PI * .75)
    } else {
      addArc(style === 'unarmed' ? .26 : .46, style === 'unarmed' ? Math.PI * .7 : Math.PI * .95)
    }
    if (strikeOutcome === 'miss' && style !== 'pierce' && strikeHaloMaterial) {
      // Смазанный «двойник» отстаёт от следа и читается как взмах мимо.
      const ghost = new THREE.Mesh(layers[layers.length - 1].mesh.geometry, strikeHaloMaterial)
      root.add(ghost)
      layers.push({ mesh: ghost, lag: .55, scale: 1.12 })
    }
    group.add(root)
    strikeArcs.push({ root, outcome: strikeOutcome, style, layers, thrust })
    const impactAt = strikeImpactProgress(cue as Extract<CombatAnimationCue, { kind: 'strike' }>)
    if (strikeOutcome === 'critical') {
      const marker = new THREE.Mesh(track(new THREE.TorusGeometry(.38, .035, 6, 24)), flatCoreMaterial!)
      marker.userData.attackOutcome = strikeOutcome
      marker.position.copy(center)
      marker.rotation.x = Math.PI / 2
      group.add(marker)
      strikeMarkers.push({ root: marker, kind: 'critical' })
    }
    if (strikeOutcome === 'blocked') {
      // Блок: гранёный щит между атакующим и целью и искры отражения.
      const shield = new THREE.Group()
      shield.userData.attackOutcome = strikeOutcome
      const plate = new THREE.Mesh(track(new THREE.CircleGeometry(.36, 6)), own(additive(palette!.halo, .35, { side: THREE.DoubleSide })))
      const rim = new THREE.Mesh(track(new THREE.RingGeometry(.32, .38, 6)), own(additive(palette!.core, .95, { side: THREE.DoubleSide })))
      shield.add(plate, rim)
      shield.position.copy(center).addScaledVector(direction, -.4)
      shield.rotation.y = Math.atan2(direction.x, direction.z)
      group.add(shield)
      strikeMarkers.push({ root: shield, kind: 'shield' })
      if (detail !== 'minimal') spikeBurst(shield.position.clone(), detail === 'full' ? 4 : 3, impactAt, .5, direction)
    }
    if (style === 'bludgeon' && (strikeOutcome === 'hit' || strikeOutcome === 'critical') && detail !== 'minimal') {
      // Дробящий удар отдаётся кольцом по полу под целью.
      const shock = new THREE.Mesh(track(new THREE.TorusGeometry(.3, .022, 5, 20)), flatCoreMaterial!)
      shock.rotation.x = -Math.PI / 2
      shock.position.copy(center).setY(center.y - .7)
      group.add(shock)
      strikeMarkers.push({ root: shock, kind: 'shock' })
    }
    return { center, direction }
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
        const geometry = track(new THREE.CylinderGeometry(.028, .05, direction.length(), 6))
        const mesh = new THREE.Mesh(geometry, material)
        mesh.position.copy(previous).add(next).multiplyScalar(.5)
        mesh.quaternion.setFromUnitVectors(UP, direction.normalize())
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
    if (cue.kind === 'strike' && !cue.hit) {
      // Промах уходит мимо цели и дальше за неё; видимость проверяется
      // каждый кадр, поэтому снаряд гаснет у края тумана.
      const flight = finish.clone().sub(start).setY(0)
      const span = flight.length() || 1
      flight.multiplyScalar(1 / span)
      finish.addScaledVector(flight, 1.2).add(new THREE.Vector3(flight.z, 0, -flight.x).multiplyScalar(.42))
    }
    if (isArrow || isBolt || isDart) {
      const shaftLength = isArrow ? .84 : isBolt ? .68 : .52
      const shaftRadius = isArrow ? .032 : isBolt ? .036 : .026
      const headRadius = isArrow ? .11 : isBolt ? .09 : .065
      const headLength = isArrow ? .22 : isBolt ? .18 : .15
      const shaft = new THREE.Mesh(track(new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 6)), material)
      const head = new THREE.Mesh(track(new THREE.ConeGeometry(headRadius, headLength, 6)), material)
      shaft.position.y = .02
      head.position.y = shaftLength / 2 + headLength / 2
      root.add(shaft, head)
    } else if (isBullet) {
      root.add(new THREE.Mesh(track(new THREE.CylinderGeometry(.055, .055, .16, 8)), material))
    } else if (isStone) {
      root.add(new THREE.Mesh(track(new THREE.IcosahedronGeometry(.065, 1)), material))
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
      root.add(new THREE.Mesh(track(geometry), material))
    } else {
      const mesh = new THREE.Mesh(sphere, material)
      mesh.scale.setScalar(1.45)
      root.add(mesh)
    }
    const trail = new THREE.Mesh(projectileTrailGeometry, projectileStreakMaterial ?? material)
    trail.userData.projectileTrail = true
    group.add(root, trail)
    const arc = isArrow ? .28 : isBolt ? .2 : isDart ? .32 : isBullet ? .08 : isStone ? .38 : .5
    const launch = cue.kind === 'strike' ? strikeLaunchProgress(cue) : 0
    const trailLength = isArrow ? .55 : isBolt ? .5 : isDart ? .4 : isBullet ? .45 : isStone ? .3 : .38
    const arrival = cue.kind === 'strike' ? strikeImpactProgress(cue) : 1
    const direction = finish.clone().sub(start).normalize()
    projectiles.push({ root, trail, trailLength, from: start, to: finish, direction, phase: launch, arrival, arc, kind })
    if (isThrown || isStone) {
      const trailCount = detail === 'full' ? 3 : detail === 'reduced' ? 2 : 1
      for (let index = 0; index < trailCount; index += 1) spark(start, finish, launch + index * .035, 1.1 - index * .2, arrival)
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
    const critical = outcome === 'critical'
    const spikeCount = critical
      ? detail === 'full' ? 8 : detail === 'reduced' ? 6 : 3
      : detail === 'full' ? 6 : detail === 'reduced' ? 4 : 0
    const impactProgress = strikeImpactProgress(cue)
    if (visible(to) && cue.hit && (!projectileKind || launched)) {
      const impactCenter = vector(to, .7, targetActor)
      const flash = new THREE.Mesh(sphere, impactMaterial ?? material)
      flash.userData.impactFlash = true
      flash.position.copy(impactCenter)
      group.add(flash)
      impactFlashes.push({ mesh: flash, phase: impactProgress, until: Math.min(1, impactProgress + (critical ? .3 : .2)), scale: critical ? 4.6 : 3 })
      if (projectileKind === 'thrown-net' && launched) {
        const contour = new THREE.Mesh(netGeometry, netMaterial)
        contour.userData.netContour = true
        contour.position.copy(vector(to, .12, targetActor))
        contour.rotation.x = -Math.PI / 2
        group.add(contour)
        netContours.push({ mesh: contour, phase: impactProgress, until: Math.min(1, impactProgress + .28) })
      }
      spikeBurst(impactCenter, spikeCount, impactProgress, critical ? .75 : .5)
      // Свет даёт только крит: обычный удар не должен мигать всей сценой.
      if (critical) lightAt = impactCenter.clone().setY(impactCenter.y + .3)
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
  const strikeCue = cue.kind === 'strike' ? cue : null
  const impactAt = strikeCue ? strikeImpactProgress(strikeCue) : .3
  return {
    group,
    update(progressValue: number) {
      const progress = clamp01(progressValue)
      lights.clear()
      const fade = Math.sin(progress * Math.PI)
      material.opacity = fade * .9
      for (const { root, trail, trailLength, from, to, direction, phase, arrival, arc, kind } of projectiles) {
        const t = THREE.MathUtils.clamp((progress - phase) / (arrival - phase), 0, 1)
        root.position.lerpVectors(from, to, t)
        root.position.y += Math.sin(t * Math.PI) * arc
        root.quaternion.setFromUnitVectors(UP, direction)
        if (kind.startsWith('thrown')) root.rotateY(t * Math.PI * 8)
        root.scale.setScalar(kind === 'thrown-net' ? .35 + t * .95 : 1)
        const active = progress > phase && progress < arrival && t < 1 && revealedAt(map, Math.floor(root.position.x), Math.floor(root.position.z))
        root.visible = active
        trail.position.copy(root.position).addScaledVector(direction, -trailLength * .5)
        trail.quaternion.setFromUnitVectors(UP, direction)
        trail.scale.set(1, trailLength * Math.min(1, t * 4), 1)
        trail.visible = active
      }
      for (const { mesh, from, to, phase, until } of sparks) {
        const t = THREE.MathUtils.clamp((progress - phase) / (until - phase), 0, 1)
        mesh.position.lerpVectors(from, to, t)
        if (travel) mesh.position.y += Math.sin(t * Math.PI) * .45
        mesh.visible = t > 0 && t < 1 && progress < until && revealedAt(map, Math.floor(mesh.position.x), Math.floor(mesh.position.z))
      }
      for (const mesh of beams) mesh.visible = progress > .13 && progress < .8
      const motion = strikeCue ? strikeMotionProgress(strikeCue, progress) : progress
      // След живёт вокруг момента контакта (motion .5): взмах, удар, растворение.
      const swing = clamp01((motion - .16) / .5)
      const trailFade = Math.sin(Math.PI * clamp01((motion - .12) / .78))
      if (strikeCoreMaterial) strikeCoreMaterial.opacity = .95 * trailFade
      if (strikeHaloMaterial) strikeHaloMaterial.opacity = .4 * trailFade
      for (const { root, outcome: strikeOutcome, style, layers, thrust } of strikeArcs) {
        const sweep = easeOutCubic(swing)
        for (const layer of layers) {
          const angle = -1.7 + (sweep - layer.lag * .35) * 2.3
          if (style === 'bludgeon') layer.mesh.rotation.set(0, Math.PI / 2, -angle * .9 + .5)
          else layer.mesh.rotation.set(Math.PI / 2 - (style === 'natural' ? .9 : .42), 0, angle)
          layer.mesh.scale.setScalar(layer.scale)
          if (style === 'bludgeon') layer.mesh.position.set(0, .22, 0)
        }
        for (const mesh of thrust) mesh.position.set(0, 0, -.75 + sweep * (strikeOutcome === 'miss' ? 1.2 : .95))
        root.visible = progress > .03 && progress < .95 && trailFade > .05
      }
      for (const { root, kind } of strikeMarkers) {
        const t = THREE.MathUtils.clamp((progress - impactAt) / (kind === 'shield' ? .5 : .4), 0, 1)
        if (kind === 'shield') root.scale.setScalar(.6 + easeOutCubic(t / .25) * .5)
        else root.scale.setScalar(.35 + easeOutCubic(t) * (kind === 'critical' ? 2.1 : 1.8))
        root.visible = progress >= impactAt - (kind === 'shield' ? .06 : 0) && t < 1
      }
      if (flatCoreMaterial) flatCoreMaterial.opacity = .95 * clamp01(1 - clamp01((progress - impactAt) / .45)) * (progress < impactAt ? trailFade : 1)
      for (const { mesh, phase, until, scale } of impactFlashes) {
        const t = THREE.MathUtils.clamp((progress - phase) / Math.max(.001, until - phase), 0, 1)
        mesh.scale.setScalar(Math.max(.05, (1 - t) * scale * (.5 + .5 * easeOutCubic(t / .2))))
        mesh.visible = progress >= phase && progress < until && revealedAt(map, Math.floor(mesh.position.x), Math.floor(mesh.position.z))
      }
      for (const { mesh, origin, direction, phase, until, reach } of spikes) {
        const t = THREE.MathUtils.clamp((progress - phase) / Math.max(.001, until - phase), 0, 1)
        mesh.position.copy(origin).addScaledVector(direction, .12 + reach * easeOutCubic(t))
        mesh.scale.set(1, Math.max(.05, 1 - t), 1)
        mesh.visible = progress >= phase && t < 1 && revealedAt(map, Math.floor(mesh.position.x), Math.floor(mesh.position.z))
      }
      netMaterial.opacity = fade * .85
      for (const { mesh, phase, until } of netContours) {
        const t = THREE.MathUtils.clamp((progress - phase) / Math.max(.001, until - phase), 0, 1)
        mesh.scale.setScalar(1 + t * .35)
        mesh.visible = progress >= phase && progress < until && revealedAt(map, Math.floor(mesh.position.x), Math.floor(mesh.position.z))
      }
      if (lightAt && progress >= impactAt) {
        const t = clamp01((progress - impactAt) / .3)
        lights.add(lightAt, '#ffd27a', 5.5 * (1 - t) ** 2, 4.5)
      }
      if (progress >= 1) lights.clear()
    },
    dispose() {
      group.removeFromParent()
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((entry) => entry.dispose())
    },
  }
}
