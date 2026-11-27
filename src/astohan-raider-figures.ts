import * as THREE from 'three'

/** Внешние слои человекоподобных противников. Их оружие и публичный
 * loadout остаются владельцу модели. */
export type RaiderSlug = 'bandit' | 'bandit-captain' | 'veteran' | 'berserker' | 'orc' | 'gnoll' | 'hobgoblin' | 'bugbear'
type RaiderInput = { kind?: string; label?: string; archetype?: string }
const SUPPORTED = new Set<RaiderSlug>(['bandit', 'bandit-captain', 'veteran', 'berserker', 'orc', 'gnoll', 'hobgoblin', 'bugbear'])

function text(value: unknown) {
  return String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е')
}
function slugOf(value: unknown) {
  return text(value).replace(/[^a-zа-я0-9]+/gu, '-')
}

export function raiderSlug(input: RaiderInput): RaiderSlug | null {
  if (input.kind !== 'enemy') return null
  const value = slugOf(input.label) + '-' + slugOf(input.archetype)
  const match = (pattern: RegExp, slug: RaiderSlug) => pattern.test(value) ? slug : null
  return match(/капитан|bandit-captain|captain/u, 'bandit-captain')
    ?? match(/ветеран|veteran/u, 'veteran')
    ?? match(/берсерк|berserker/u, 'berserker')
    ?? match(/гнолл|gnoll/u, 'gnoll')
    ?? match(/багбир|bugbear/u, 'bugbear')
    ?? match(/хобгоблин|hobgoblin/u, 'hobgoblin')
    ?? match(/орк|orc/u, 'orc')
    ?? match(/разбойник|bandit|бандит/u, 'bandit')
}

function material(color: string, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: .82, metalness: .03, ...options })
}
function bone(root: THREE.Object3D, names: readonly string[]) {
  let result: THREE.Object3D | undefined
  root.traverse(object => { if (!result && names.includes(object.name)) result = object })
  return result ?? root
}
function add(root: THREE.Object3D, object: THREE.Object3D, name: string) {
  object.name = 'astohan-raider-' + name
  object.userData.board3dPickable = false
  object.traverse(child => { child.userData.board3dPickable = false })
  const mesh = object as THREE.Mesh
  if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true }
  root.add(object)
  return object
}
function strap(root: THREE.Object3D, name: string, color: string, position: [number, number, number], rotation: [number, number, number]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(.045, .58, .024), material(color, { roughness: .9 }))
  mesh.position.set(...position)
  mesh.rotation.set(...rotation)
  return add(root, mesh, name)
}

function raiderHumanoid(root: THREE.Object3D, style: RaiderSlug) {
  const torso = bone(root, ['spine_03', 'spine_02', 'spine_01', 'torso', 'rig-torso'])
  const head = bone(root, ['Head', 'head', 'rig-head'])
  const chest = style === 'veteran' || style === 'bandit-captain' ? '#66727a' : style === 'berserker' ? '#5c4439' : '#523a2d'
  const trim = style === 'bandit-captain' ? '#a44734' : style === 'veteran' ? '#936b35' : '#76543b'
  const dark = style === 'orc' || style === 'hobgoblin' ? '#31373c' : '#222629'
  strap(torso, 'cross-strap-left', chest, [-.10, -.02, .13], [0, 0, -.28])
  strap(torso, 'cross-strap-right', trim, [.10, -.02, .135], [0, 0, .28])
  const belt = new THREE.Mesh(new THREE.TorusGeometry(.205, .025, 7, 18), material(trim, { roughness: .72 }))
  belt.rotation.x = Math.PI / 2
  belt.position.set(0, -.17, 0)
  add(torso, belt, 'belt')
  if (style === 'bandit-captain' || style === 'veteran') {
    const pauldron = new THREE.Mesh(new THREE.SphereGeometry(.12, 8, 5), material(chest, { metalness: .22, roughness: .6 }))
    pauldron.scale.set(1.45, .55, 1.2)
    pauldron.position.set(-.20, .12, 0)
    add(torso, pauldron, 'shoulder')
  }
  if (style === 'bandit-captain') {
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(.205, .175, .12, 5), material('#68352f'))
    hat.scale.z = 1.17
    hat.rotation.y = Math.PI / 5
    hat.position.set(0, .16, .012)
    add(head, hat, 'captain-hat')
  }
  if (style === 'veteran') {
    const shield = new THREE.Mesh(new THREE.CylinderGeometry(.22, .16, .052, 7), material('#6e796b', { metalness: .18 }))
    shield.rotation.x = Math.PI / 2
    shield.scale.z = 1.40
    shield.position.set(.22, -.025, -.19)
    add(torso, shield, 'veteran-backplate')
  }
  if (style === 'berserker') {
    const fur = new THREE.Mesh(new THREE.TorusGeometry(.16, .045, 8, 18), material('#4d392f', { roughness: 1 }))
    fur.rotation.x = Math.PI / 2
    fur.position.set(0, .14, 0)
    add(torso, fur, 'fur-collar')
  }
  if (style === 'bandit' || style === 'berserker') {
    const hood = new THREE.Mesh(new THREE.SphereGeometry(.17, 9, 6), material(dark, { roughness: .94 }))
    hood.scale.set(1.12, .86, .92)
    hood.position.set(0, .04, .015)
    add(head, hood, 'hood')
  }
  if (style === 'orc') {
    const tusk = material('#c9b993', { roughness: .94 })
    for (const side of [-1, 1]) {
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(.028, .12, 6), tusk)
      tooth.position.set(side * .065, -.055, .13)
      tooth.rotation.z = side * -.22
      add(head, tooth, 'tusk-' + side)
    }
  }
  if (style === 'hobgoblin') {
    const crest = new THREE.Mesh(new THREE.BoxGeometry(.13, .23, .035), material('#8f392f', { roughness: .74 }))
    crest.position.set(0, .17, -.01)
    add(head, crest, 'crest')
  }
  root.userData.astohanRaiderStyle = style
}

function customGnoll() {
  const root = new THREE.Group()
  const fur = material('#69564b', { roughness: .94 })
  const dark = material('#382a27', { roughness: .98 })
  const boneMaterial = material('#d2bd91', { roughness: .9 })
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), fur)
  body.scale.set(.42, .64, .31); body.position.set(0, .74, 0)
  add(root, body, 'gnoll-body')
  const snout = new THREE.Mesh(new THREE.ConeGeometry(.15, .38, 8), dark)
  snout.rotation.x = Math.PI / 2; snout.position.set(0, 1.15, .29); add(root, snout, 'gnoll-muzzle')
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(.10, .34, 6), fur)
    ear.position.set(side * .20, 1.35, 0); ear.rotation.z = side * -.42; add(root, ear, 'gnoll-ear-' + side)
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(.08, .40, 4, 8), fur)
    arm.position.set(side * .38, .75, .05); arm.rotation.z = side * -.38; add(root, arm, 'gnoll-arm-' + side)
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(.073, .37, 4, 8), dark)
    leg.position.set(side * .16, .26, .02); leg.rotation.x = -.34; add(root, leg, 'gnoll-leg-' + side)
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(.025, .13, 5), boneMaterial)
    tooth.position.set(side * .07, 1.10, .41); tooth.rotation.x = Math.PI; add(root, tooth, 'gnoll-tooth-' + side)
  }
  return root
}
function customBugbear() {
  const root = new THREE.Group()
  const fur = material('#745643', { roughness: 1 })
  const dark = material('#332a28', { roughness: .94 })
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), fur)
  body.scale.set(.46, .72, .34); body.position.set(0, .81, 0); add(root, body, 'bugbear-body')
  const head = new THREE.Mesh(new THREE.SphereGeometry(.25, 10, 6), fur)
  head.position.set(0, 1.48, .02); head.scale.set(1.08, 1, .98); add(root, head, 'bugbear-head')
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(.16, 9, 5), dark)
  jaw.scale.set(1.1, .55, .86); jaw.position.set(0, 1.40, .18); add(root, jaw, 'bugbear-jaw')
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(.09, .53, 4, 8), fur)
    arm.position.set(side * .43, .73, 0); arm.rotation.z = side * -.28; add(root, arm, 'bugbear-arm-' + side)
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(.126, .28, 4, 8), dark)
    leg.position.set(side * .22, .26, .04); leg.rotation.z = side * .23; add(root, leg, 'bugbear-leg-' + side)
    const ear = new THREE.Mesh(new THREE.ConeGeometry(.10, .23, 6), fur)
    ear.position.set(side * .24, 1.57, .01); ear.rotation.z = side * -.35; add(root, ear, 'bugbear-ear-' + side)
  }
  return root
}
export function buildAstohanRaider(slug: string): THREE.Group | null {
  if (slug === 'gnoll') return customGnoll()
  if (slug === 'bugbear') return customBugbear()
  return null
}
/** Накладка следует костям выбранного локального GLB или процедурного тела. */
export function decorateRaider(root: THREE.Group, slug: string): void {
  if (!SUPPORTED.has(slug as RaiderSlug) || slug === 'gnoll' || slug === 'bugbear') return
  raiderHumanoid(root, slug as RaiderSlug)
}
