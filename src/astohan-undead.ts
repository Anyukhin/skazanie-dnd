import * as THREE from 'three'

type Palette = { bone: string; dark: string; cloth: string; accent: string; glow: string }
const PALETTES: Record<string, Palette> = {
  bone: { bone: '#c3b28f', dark: '#554d42', cloth: '#302b2b', accent: '#8f473d', glow: '#e1a14a' },
  ghost: { bone: '#bfe9dc', dark: '#24484d', cloth: '#85d1c4', accent: '#d0fff0', glow: '#8de9d3' },
  ghoul: { bone: '#c9d2a4', dark: '#344034', cloth: '#3b3129', accent: '#b65b45', glow: '#a4d17b' },
  mummy: { bone: '#d2bd91', dark: '#655644', cloth: '#a28e68', accent: '#8b4d3d', glow: '#d4a855' },
  wight: { bone: '#d7e2d2', dark: '#17212a', cloth: '#263847', accent: '#a4473d', glow: '#9dd3e0' },
  zombie: { bone: '#a4b18a', dark: '#354034', cloth: '#46503d', accent: '#a65b46', glow: '#b5c06f' },
  minotaur: { bone: '#c7b492', dark: '#40362d', cloth: '#51372b', accent: '#8f443b', glow: '#d29a45' },
}

function mat(color: string, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: .86, metalness: .02, ...options })
}

function mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, name: string, position: [number, number, number] = [0, 0, 0], rotation: [number, number, number] = [0, 0, 0], scale?: [number, number, number]) {
  const object = new THREE.Mesh(geometry, material)
  object.name = name
  object.position.set(...position)
  object.rotation.set(...rotation)
  if (scale) object.scale.set(...scale)
  object.castShadow = !(material.transparent && !material.depthWrite)
  object.receiveShadow = object.castShadow
  parent.add(object)
  return object
}

function box(parent: THREE.Object3D, material: THREE.Material, name: string, size: [number, number, number], position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) {
  return mesh(parent, new THREE.BoxGeometry(1, 1, 1), material, name, position, rotation, size)
}

function sphere(parent: THREE.Object3D, material: THREE.Material, name: string, radius: number, position: [number, number, number], scale: [number, number, number] = [1, 1, 1]) {
  return mesh(parent, new THREE.SphereGeometry(radius, 10, 7), material, name, position, [0, 0, 0], scale)
}

function cone(parent: THREE.Object3D, material: THREE.Material, name: string, radius: number, height: number, position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) {
  return mesh(parent, new THREE.ConeGeometry(radius, height, 8, 1), material, name, position, rotation)
}

function cylinder(parent: THREE.Object3D, material: THREE.Material, name: string, radius: number, height: number, position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) {
  return mesh(parent, new THREE.CylinderGeometry(radius, radius * 1.06, height, 8, 1), material, name, position, rotation)
}

function beam(parent: THREE.Object3D, material: THREE.Material, name: string, from: THREE.Vector3, to: THREE.Vector3, radius: number) {
  const direction = new THREE.Vector3().subVectors(to, from)
  const object = cylinder(parent, material, name, radius, direction.length(), [0, 0, 0])
  object.position.copy(from).add(to).multiplyScalar(.5)
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  return object
}

function eyes(parent: THREE.Object3D, color: string, y: number, z: number, spread = .075) {
  const glow = mat(color, { emissive: color, emissiveIntensity: 1.2 })
  sphere(parent, glow, 'eye-left', .018, [-spread, y, z])
  sphere(parent, glow, 'eye-right', .018, [spread, y, z])
}

function humanoid(profile: string, palette: Palette, transparent = false) {
  const root = new THREE.Group()
  root.name = 'astohan-undead-' + profile
  const opts = transparent ? { transparent: true, opacity: .58, depthWrite: false, side: THREE.DoubleSide } : {}
  const bone = mat(palette.bone, opts)
  const cloth = mat(palette.cloth, opts)
  const dark = mat(palette.dark, opts)
  box(root, cloth, 'torso', [.38, .54, .27], [0, .64, 0])
  box(root, dark, 'pelvis', [.34, .22, .25], [0, .35, 0])
  for (const side of [-1, 1]) {
    cylinder(root, bone, 'arm-' + side, .055, .43, [side * .28, .63, 0], [0, 0, side * .18])
    cylinder(root, dark, 'leg-' + side, .07, .45, [side * .13, .17, 0])
    sphere(root, bone, 'hand-' + side, .065, [side * .30, .38, .01])
    sphere(root, dark, 'foot-' + side, .08, [side * .13, .035, .10], [1, .35, 1.4])
  }
  sphere(root, bone, 'head', .17, [0, 1.08, .01], [1, 1.05, .92])
  eyes(root, palette.glow, 1.11, .15)
  root.userData.undeadProfile = profile
  return root
}

function crawlingClaw(palette: Palette) {
  const root = new THREE.Group()
  root.name = 'astohan-undead-crawling-claw'
  const bone = mat(palette.bone)
  const dark = mat(palette.dark)
  sphere(root, bone, 'claw-palm', .18, [0, .16, 0], [1.3, .55, 1.05])
  for (let i = 0; i < 5; i += 1) {
    const x = (i - 2) * .105
    const from = new THREE.Vector3(x, .15, .13)
    const to = new THREE.Vector3(x * 1.35, .055, .40 + Math.abs(i - 2) * .035)
    beam(root, bone, 'claw-finger-' + i, from, to, .032)
    cone(root, dark, 'claw-tip-' + i, .042, .15, [to.x, .025, to.z], [Math.PI / 2, 0, 0])
  }
  root.userData.undeadProfile = 'crawling-claw'
  return root
}

function flameSkull(palette: Palette) {
  const root = new THREE.Group()
  root.name = 'astohan-undead-flameskull'
  root.position.y = .52
  const bone = mat(palette.bone)
  const socket = mat('#10151a')
  const glow = mat(palette.glow, { emissive: palette.glow, emissiveIntensity: 1.4 })
  sphere(root, bone, 'flameskull-cranium', .22, [0, .21, 0], [1, 1.1, .85])
  box(root, bone, 'flameskull-jaw', [.27, .08, .18], [0, .04, .025])
  for (const x of [-.08, .08]) {
    sphere(root, socket, 'flameskull-socket', .055, [x, .23, .18], [1, 1, .45])
    sphere(root, glow, 'flameskull-eye', .018, [x, .23, .19])
  }
  for (let i = 0; i < 3; i += 1) cone(root, glow, 'flame-tongue-' + i, .11 - i * .018, .28 + i * .08, [(i - 1) * .08, .51 + i * .04, 0], [0, (i - 1) * .15, 0])
  root.userData.undeadProfile = 'flameskull'
  root.userData.floating = true
  return root
}

function ghost(profile: string, palette: Palette) {
  const opts = { transparent: true, opacity: .58, depthWrite: false, side: THREE.DoubleSide }
  const root = humanoid(profile, palette, true)
  root.name = 'astohan-undead-' + profile
  root.children.filter(child => child.name.startsWith('leg-') || child.name.startsWith('foot-')).forEach(child => child.visible = false)
  cone(root, mat(palette.cloth, opts), 'ghost-tail', .34, .48, [0, .19, 0], [Math.PI, 0, 0])
  sphere(root, mat(palette.bone, opts), 'ghost-face', .13, [0, 1.08, .13], [1, 1.1, .4])
  return root
}

function mummy(palette: Palette) {
  const root = humanoid('mummy', palette)
  const band = mat(palette.bone)
  for (let i = 0; i < 5; i += 1) box(root, band, 'mummy-bandage-' + i, [.39 - i * .025, .028, .29], [0, .42 + i * .1, -.14], [0, .2 * Math.sin(i), .1 * Math.cos(i)])
  box(root, mat(palette.dark), 'mummy-veil', [.27, .15, .04], [0, 1.12, .15])
  return root
}

function ghoul(profile: string, palette: Palette) {
  const root = new THREE.Group()
  root.name = 'astohan-undead-' + profile
  root.rotation.x = -.12
  const skin = mat(palette.bone, { roughness: .94 })
  const shadow = mat(palette.dark, { roughness: .97 })
  const claws = mat(palette.accent)
  sphere(root, shadow, 'ghoul-hunched-back', .26, [0, .49, -.05], [1.1, 1.0, 1.42])
  sphere(root, skin, 'ghoul-torso', .27, [0, .46, .10], [1.05, .82, 1.18])
  sphere(root, skin, 'ghoul-head', .19, [0, .78, .31], [1.0, .95, 1.18])
  cone(root, shadow, 'ghoul-jaw', .12, .22, [0, .67, .49], [Math.PI / 2, 0, 0])
  box(root, shadow, 'ghoul-shoulder-shadow', [.52, .12, .16], [0, .61, .08], [.12, 0, 0])
  for (const side of [-1, 1]) {
    beam(root, skin, 'ghoul-arm-' + side, new THREE.Vector3(side * .19, .59, .13), new THREE.Vector3(side * .34, .22, .34), .055)
    sphere(root, skin, 'ghoul-hand-' + side, .065, [side * .34, .18, .36], [1.2, .8, 1.3])
    for (let finger = -1; finger <= 1; finger++) {
      const from = new THREE.Vector3(side * (.34 + finger * .03), .18, .40)
      const to = new THREE.Vector3(side * (.38 + finger * .05), .07, .50 + Math.abs(finger) * .025)
      beam(root, claws, 'ghoul-claw-' + side + (finger === 0 ? '' : '-finger-' + finger), from, to, .018)
    }
    beam(root, shadow, 'ghoul-thigh-' + side, new THREE.Vector3(side * .12, .35, .02), new THREE.Vector3(side * .18, .11, .12), .065)
  }
  for (const x of [-.07, .07]) sphere(root, claws, 'ghoul-eye', .022, [x, .82, .47])
  root.userData.undeadProfile = profile
  return root
}

function wight(profile: string, palette: Palette) {
  const root = humanoid(profile, palette)
  cone(root, mat(palette.dark), 'wight-cloak', .4, .8, [0, .5, -.02])
  box(root, mat(palette.accent), 'wight-collar', [.32, .06, .05], [0, .88, .12])
  beam(root, mat(palette.accent), 'wight-blade', new THREE.Vector3(.3, .48, .03), new THREE.Vector3(.3, .98, .03), .025)
  return root
}

function minotaurSkeleton(palette: Palette) {
  const root = humanoid('minotaur-skeleton', palette)
  const bone = mat(palette.bone)
  const dark = mat(palette.dark)
  sphere(root, bone, 'minotaur-skull', .26, [0, 1.1, .04], [1.25, .95, 1.05])
  for (const side of [-1, 1]) beam(root, bone, 'minotaur-horn-' + side, new THREE.Vector3(side * .13, 1.17, .02), new THREE.Vector3(side * .40, 1.34, .10), .042)
  sphere(root, dark, 'minotaur-nostril', .018, [0, 1.08, .27])
  box(root, dark, 'minotaur-axe-haft', [.04, .75, .04], [.34, .60, .05], [0, 0, .13])
  cone(root, mat(palette.accent, { metalness: .35, roughness: .48 }), 'minotaur-axe-head', .12, .28, [.34, .96, .05], [Math.PI / 2, 0, Math.PI / 2])
  return root
}

/** Возвращает null для обычного skeleton, который уже выбирается штатным GLB. */
export function buildAstohanUndead(slugValue: string): THREE.Group | null {
  const slug = String(slugValue ?? '').toLowerCase().replace(/_/g, '-')
  if (slug === 'skeleton') return null
  if (slug === 'crawling-claw') return crawlingClaw(PALETTES.bone)
  if (slug === 'flameskull') return flameSkull(PALETTES.bone)
  if (['specter', 'banshee', 'ghost'].includes(slug)) return ghost(slug, PALETTES.ghost)
  if (slug === 'mummy') return mummy(PALETTES.mummy)
  if (['ghoul', 'ghast'].includes(slug)) return ghoul(slug, PALETTES.ghoul)
  if (['wight', 'vampire-spawn'].includes(slug)) return wight(slug, PALETTES.wight)
  if (slug === 'minotaur-skeleton') return minotaurSkeleton(PALETTES.minotaur)
  if (slug === 'zombie') return wight('zombie', PALETTES.zombie)
  return null
}
