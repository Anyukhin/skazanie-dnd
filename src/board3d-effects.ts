import * as THREE from 'three'
import type { CombatAnimationCue, BoardPoint } from './combat-animation'
import type { TacticalMap } from './types'
import { revealedAt } from './tactical-map-client'
import { SPELL_SCHOOL_STYLES, spellBurstCells } from './spell-effects'
import { terrainHeightAt } from './board3d-terrain'

/** Пространственные акценты дополняют общий рисунок области, не считают попадания. */
export function createCombatEffect3D(cue: CombatAnimationCue, actors: readonly (BoardPoint & { id: string })[], map: TacticalMap) {
  const group = new THREE.Group()
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const at = (id: string) => actors.find((actor) => actor.id === id)
  const visible = (point?: BoardPoint): point is BoardPoint => Boolean(point && revealedAt(map, Math.floor(point.x + .5), Math.floor(point.y + .5)))
  const color = 'school' in cue ? SPELL_SCHOOL_STYLES[cue.school].primary
    : cue.kind === 'impact' && cue.tone === 'healing' ? '#85d8aa' : '#efb976'
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false })
  materials.add(material)
  const sphere = new THREE.SphereGeometry(.085, 8, 6)
  geometries.add(sphere)
  const sparks: Array<{ mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; phase: number }> = []
  const vector = (point: BoardPoint, height = .7) => new THREE.Vector3(point.x + .5, terrainHeightAt(map, point.x + .5, point.y + .5) + height, point.y + .5)
  const spark = (from: THREE.Vector3, to: THREE.Vector3, phase: number, scale = 1) => {
    const mesh = new THREE.Mesh(sphere, material)
    mesh.scale.setScalar(scale)
    group.add(mesh)
    sparks.push({ mesh, from, to, phase })
  }
  const beams: THREE.Mesh[] = []
  const beam = (from: BoardPoint, to: BoardPoint, lightning: boolean) => {
    if (!visible(from) || !visible(to)) return
    // Каждая часть луча проверяется отдельно: эффект не рисует путь сквозь туман.
    const steps = Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * 5))
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
  let travel = false
  if (cue.kind === 'projectile') {
    const from = cue.from ?? at(cue.actorId)
    if (visible(from)) for (let index = 0; index < Math.min(12, cue.projectileCount); index++) {
      const to = at(cue.targetIds[index % Math.max(1, cue.targetIds.length)]) ?? cue.to
      if (!visible(to)) continue
      for (let tail = 0; tail < 5; tail++) spark(vector(from), vector(to), index * .065 + tail * .025, 1.5 - tail * .2)
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
    const from = at(cue.actorId), to = at(cue.targetId)
    if (visible(from) && visible(to)) beam(from, to, false)
    if (visible(to) && cue.hit) for (let index = 0; index < 14; index++) {
      const angle = index * 2.4
      spark(vector(to), vector({ x: to.x + Math.cos(angle) * .45, y: to.y + Math.sin(angle) * .45 }, .3 + (index % 4) * .3), index / 22, .65)
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
      for (let index = 0; index < Math.min(64, Math.max(24, cells.length * 2)); index++) {
        const cell = cells[Math.floor(index * cells.length / Math.min(64, Math.max(24, cells.length * 2)))]
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
      for (const { mesh, from, to, phase } of sparks) {
        const t = THREE.MathUtils.clamp((progress - phase) / (1 - phase), 0, 1)
        mesh.position.lerpVectors(from, to, t)
        if (travel) mesh.position.y += Math.sin(t * Math.PI) * .45
        mesh.visible = t > 0 && t < 1 && revealedAt(map, Math.floor(mesh.position.x), Math.floor(mesh.position.z))
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
