import * as THREE from 'three'

type Vec3 = [number, number, number]
type Parts = { root: THREE.Group; body: THREE.Material; dark: THREE.Material; light: THREE.Material; accent: THREE.Material; wing: THREE.Material }

const COLORS = {
  fur: '#594434', furLight: '#9a7650', furDark: '#2b211d', feather: '#6a7884',
  bone: '#c1b294', scale: '#65715c', horn: '#403832', eye: '#d9a13e',
  venom: '#76a05a', red: '#9e3b32', wing: '#4e4149', metal: '#657076',
} as const

function mat(color: string, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: .86, metalness: 0, ...options })
}

function mark<T extends THREE.Object3D>(mesh: T, name: string, root: THREE.Group, pos?: Vec3) {
  mesh.name = name
  if (pos) mesh.position.set(...pos)
  mesh.castShadow = true; mesh.receiveShadow = true
  mesh.userData.board3dPickable = false
  root.add(mesh)
  return mesh
}

function sphere(root: THREE.Group, name: string, pos: Vec3, scale: Vec3, material: THREE.Material, segments = 8) {
  const mesh = mark(new THREE.Mesh(new THREE.SphereGeometry(1, segments, Math.max(5, Math.floor(segments / 2))), material), name, root, pos)
  mesh.scale.set(...scale)
  return mesh
}

function between(root: THREE.Group, name: string, from: Vec3, to: Vec3, radius: number, material: THREE.Material, radial = 7) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), delta = b.clone().sub(a)
  const mesh = mark(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.08, delta.length(), radial), material), name, root)
  mesh.position.copy(a).add(b).multiplyScalar(.5)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize())
  return mesh
}

function wing(root: THREE.Group, side: number, membraneMaterial: THREE.Material, bone: THREE.Material, size = 1) {
  const x = side * .28
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    x, .9, -.12, side * 1.05 * size, 1.42 * size, .08,
    side * 1.38 * size, .83 * size, .3, side * .68 * size, .56 * size, .45,
  ], 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3]); geometry.computeVertexNormals()
  const membrane = membraneMaterial.clone() as THREE.MeshStandardMaterial
  membrane.side = THREE.DoubleSide
  mark(new THREE.Mesh(geometry, membrane), 'wing-membrane-' + side, root)
  between(root, 'wing-bone-' + side, [x, .84, -.1], [side * 1.23 * size, 1.08 * size, .22], .035, bone)
  between(root, 'wing-finger-' + side, [side * 1.23 * size, 1.08 * size, .22], [side * 1.33 * size, .86 * size, .3], .025, bone)
  for (let i = 0; i < 3; i++) {
    const start: Vec3 = [side * (.40 + i * .09), .92 + i * .04, .03]
    const end: Vec3 = [side * (.88 + i * .18) * size, 1.20 - i * .13, .18 + i * .05]
    between(root, 'wing-finger-' + side + '-' + i, start, end, .018, bone, 6)
  }
}

function eyes(root: THREE.Group, pos: Vec3, scale = .055) {
  const socket = mat('#171719', { roughness: 1 })
  const eye = mat(COLORS.eye, { emissive: COLORS.eye, emissiveIntensity: .45 })
  for (const side of [-1, 1]) {
    const x = pos[0] + side * scale * 1.7
    sphere(root, 'eye-socket-' + side, [x, pos[1], pos[2]], [scale * 1.45, scale * 1.3, scale * .38], socket)
    sphere(root, 'eye-' + side, [x, pos[1], pos[2] + scale * .42], [scale * .52, scale * .52, scale * .22], eye, 8)
  }
}

function legs(root: THREE.Group, count: number, material: THREE.Material, toe: THREE.Material, spread = .32, height = .55) {
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1, z = i < 2 ? .22 : -.28, x = side * spread
    between(root, 'leg-' + i, [x, height, z], [x * 1.13, .16, z + (i < 2 ? .06 : -.06)], .095, material)
    between(root, 'ankle-' + i, [x * 1.13, .2, z + (i < 2 ? .06 : -.06)], [x * 1.13, .07, z + .18], .062, toe)
  }
}

function base(profile: string, body: string, dark: string, light: string, accent: string): Parts {
  const root = new THREE.Group(); root.name = 'astohan-' + profile; root.userData.actorProfile = profile; root.userData.board3dPickable = false
  return { root, body: mat(body), dark: mat(dark), light: mat(light), accent: mat(accent), wing: mat(COLORS.wing, { roughness: .92 }) }
}

function owlbear() {
  const p = base('owlbear', COLORS.fur, COLORS.furDark, COLORS.furLight, COLORS.bone)
  sphere(p.root, 'body', [0, .66, 0], [.62, .62, .73], p.body)
  sphere(p.root, 'feathered-chest', [0, .8, .47], [.42, .45, .18], p.light)
  sphere(p.root, 'owl-head', [0, 1.28, .34], [.46, .42, .38], p.light)
  sphere(p.root, 'owl-face-disc', [0, 1.3, .72], [.38, .34, .055], p.light)
  sphere(p.root, 'beak', [0, 1.23, .84], [.13, .1, .15], p.accent, 6); eyes(p.root, [0, 1.4, .79], .09)
  legs(p.root, 4, p.body, p.accent, .33, .68); wing(p.root, -1, p.dark, p.light, .72); wing(p.root, 1, p.dark, p.light, .72)
  return p.root
}

function harpy() {
  const p = base('harpy', '#8d604d', COLORS.furDark, '#c7a789', COLORS.feather)
  sphere(p.root, 'torso', [0, .76, 0], [.34, .55, .25], p.body); sphere(p.root, 'head', [0, 1.32, .1], [.25, .28, .25], p.light)
  sphere(p.root, 'beak', [0, 1.3, .38], [.08, .08, .12], p.accent, 6); eyes(p.root, [0, 1.4, .3], .04)
  wing(p.root, -1, p.dark, p.light, .8); wing(p.root, 1, p.dark, p.light, .8)
  for (const side of [-1, 1]) for (let i = 0; i < 3; i++) between(p.root, 'flight-feather', [side * (.3 + i * .08), .96 + i * .07, .04], [side * (.85 + i * .12), 1.18 + i * .13, .15], .018, p.light)
  for (const side of [-1, 1]) { between(p.root, 'talon-leg', [side * .13, .48, 0], [side * .2, .08, .15], .045, p.body); for (let i = 0; i < 3; i++) between(p.root, 'talon', [side * .2, .08, .15], [side * (.2 + i * .045), .045, .25], .018, p.accent) }
  return p.root
}

function manticore() {
  const p = base('manticore', '#8b4937', COLORS.furDark, '#bb7045', COLORS.horn)
  sphere(p.root, 'lion-body', [0, .62, 0], [.62, .48, .83], p.body); sphere(p.root, 'mane', [0, .95, .58], [.5, .48, .24], p.dark); sphere(p.root, 'lion-head', [0, .93, .65], [.4, .37, .42], p.light)
  eyes(p.root, [0, .99, .98], .07); sphere(p.root, 'muzzle', [0, .85, 1], [.27, .19, .23], p.light); legs(p.root, 4, p.body, p.dark, .35, .56); wing(p.root, -1, p.dark, p.light, .72); wing(p.root, 1, p.dark, p.light, .72)
  between(p.root, 'tail', [0, .52, -.7], [.18, .65, -1.0], .09, p.body)
  between(p.root, 'tail-up', [.18, .65, -1.0], [.35, 1.02, -1.25], .075, p.body)
  const barb = mark(new THREE.Mesh(new THREE.ConeGeometry(.16, .42, 6), p.accent), 'tail-stinger', p.root, [.35, 1.22, -1.29])
  barb.rotation.x = Math.PI * .52
  return p.root
}

function displacer() {
  const p = base('displacer-beast', '#283942', '#172127', '#4c6b72', '#b47b54')
  sphere(p.root, 'body', [0, .6, 0], [.55, .43, .9], p.body); sphere(p.root, 'head', [0, .79, .72], [.35, .3, .4], p.light); eyes(p.root, [0, .84, 1.03], .045); legs(p.root, 6, p.body, p.dark, .32, .5)
  for (const side of [-1, 1]) { between(p.root, 'tentacle', [side * .2, .62, .28], [side * .8, .9, .8], .045, p.accent); between(p.root, 'tentacle-tip', [side * .8, .9, .8], [side * 1.05, .56, .98], .03, p.accent) }
  return p.root
}

function basilisk() {
  const p = base('basilisk', '#536043', '#29352a', '#8f9b68', COLORS.venom)
  sphere(p.root, 'body', [0, .45, 0], [.55, .38, .9], p.body); sphere(p.root, 'head', [0, .62, .78], [.38, .32, .45], p.light); eyes(p.root, [0, .7, 1.13], .05); legs(p.root, 6, p.body, p.dark, .3, .4)
  for (let i = 0; i < 6; i++) between(p.root, 'crest', [0, .72 - .035 * i, .12 + i * .12], [0, .98 - .05 * i, .16 + i * .12], .045, p.accent)
  return p.root
}

function gorgon() {
  const p = base('gorgon', '#53636a', '#293238', '#88969a', COLORS.horn)
  sphere(p.root, 'metal-body', [0, .68, 0], [.58, .54, .78], p.body); sphere(p.root, 'bull-head', [0, .99, .62], [.38, .36, .4], p.light); eyes(p.root, [0, 1.05, .96], .045); legs(p.root, 4, p.dark, p.accent, .36, .6)
  for (const side of [-1, 1]) between(p.root, 'horn', [side * .18, 1.18, .75], [side * .52, 1.45, .92], .065, p.accent)
  for (let i = 0; i < 5; i++) between(p.root, 'metal-spine', [0, 1.03, -.55 - i * .18], [0, 1.18, -.65 - i * .18], .04, p.accent)
  return p.root
}

function chimera() {
  const p = base('chimera', '#8b553a', '#30322c', '#b4875e', COLORS.horn)
  sphere(p.root, 'lion-body', [0, .6, 0], [.62, .5, .8], p.body); legs(p.root, 4, p.body, p.dark, .35, .57); wing(p.root, -1, p.dark, p.light, .75); wing(p.root, 1, p.dark, p.light, .75)
  sphere(p.root, 'lion-head', [-.18, .98, .72], [.28, .28, .35], p.light); sphere(p.root, 'goat-head', [.2, 1.05, .7], [.25, .32, .32], p.light); sphere(p.root, 'dragon-head', [0, 1.3, .62], [.24, .23, .38], p.dark)
  for (const side of [-1, 1]) between(p.root, 'goat-horn', [.2 + side * .12, 1.22, .72], [.2 + side * .27, 1.5, .66], .04, p.accent)
  eyes(p.root, [0, 1.34, .92], .04); between(p.root, 'serpent-tail', [0, .52, -.7], [0, .62, -1.35], .08, p.dark); return p.root
}

function couatl() {
  const p = base('couatl', '#3c6681', '#223b57', '#a8cb80', COLORS.red)
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, .2, -.95), new THREE.Vector3(.22, .34, -.38), new THREE.Vector3(-.18, .48, .15), new THREE.Vector3(0, .75, .65)])
  mark(new THREE.Mesh(new THREE.TubeGeometry(curve, 18, .16, 8, false), p.body), 'serpent-body', p.root); wing(p.root, -1, p.dark, p.light, .55); wing(p.root, 1, p.dark, p.light, .55); sphere(p.root, 'head', [0, .8, .82], [.22, .22, .3], p.light); eyes(p.root, [0, .86, 1.07], .04); return p.root
}

function wyvern() {
  const p = base('wyvern', '#5d5754', '#28262b', '#8e8070', COLORS.horn)
  sphere(p.root, 'body', [0, .7, 0], [.48, .42, .72], p.body); sphere(p.root, 'head', [0, .85, .72], [.29, .27, .36], p.light); eyes(p.root, [0, .92, 1], .04); legs(p.root, 2, p.body, p.dark, .3, .53); wing(p.root, -1, p.dark, p.light, .85); wing(p.root, 1, p.dark, p.light, .85); between(p.root, 'tail', [0, .6, -.5], [0, .62, -1.45], .06, p.body); between(p.root, 'tail-stinger', [0, .62, -1.45], [0, .72, -1.72], .12, p.accent); return p.root
}

export function buildAstohanChimeraFamily(slug: string): THREE.Group | null {
  const builders: Record<string, () => THREE.Group> = { owlbear, harpy, manticore, 'displacer-beast': displacer, basilisk, gorgon, chimera, couatl, wyvern }
  return builders[slug]?.() ?? null
}
