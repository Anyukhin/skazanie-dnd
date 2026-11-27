import * as THREE from 'three'

export type AstohanBeastSlug = 'brown-bear' | 'giant-boar' | 'lion' | 'hyena' | 'jackal' | 'dire-wolf' | 'hell-hound'
const SLUGS = new Set<AstohanBeastSlug>(['brown-bear', 'giant-boar', 'lion', 'hyena', 'jackal', 'dire-wolf', 'hell-hound'])
const slugOf = (value: unknown) => String(value ?? '').trim().toLowerCase().replaceAll('_', '-').replace(/\s+/gu, '-')
export function isAstohanBeastSlug(value: unknown): value is AstohanBeastSlug { return SLUGS.has(slugOf(value) as AstohanBeastSlug) }

function mat(color: string, options: THREE.MeshStandardMaterialParameters = {}) { return new THREE.MeshStandardMaterial({ color, roughness: .86, ...options }) }
function add(root: THREE.Group, name: string, geometry: THREE.BufferGeometry, material: THREE.Material, position: [number, number, number], scale?: [number, number, number], rotation?: [number, number, number]) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = name; mesh.position.set(...position)
  if (scale) mesh.scale.set(...scale)
  if (rotation) mesh.rotation.set(...rotation)
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.board3dPickable = false; root.add(mesh)
  return mesh
}
const sphere = (root: THREE.Group, name: string, radius: number, position: [number, number, number], material: THREE.Material, scale: [number, number, number]) => add(root, name, new THREE.SphereGeometry(radius, 12, 8), material, position, scale)
const cone = (root: THREE.Group, name: string, radius: number, height: number, position: [number, number, number], material: THREE.Material, rotation: [number, number, number] = [0, 0, 0]) => add(root, name, new THREE.ConeGeometry(radius, height, 8), material, position, undefined, rotation)
const cylinder = (root: THREE.Group, name: string, radius: number, height: number, position: [number, number, number], material: THREE.Material) => add(root, name, new THREE.CylinderGeometry(radius, radius * 1.08, height, 8), material, position)
function tube(root: THREE.Group, name: string, points: Array<[number, number, number]>, radius: number, material: THREE.Material) {
  return add(root, name, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point))), 10, radius, 7, false), material, [0, 0, 0])
}
function legs(root: THREE.Group, hide: THREE.Material, claw: THREE.Material, spread: number, front: number, back: number, height: number, radius: number) {
  const places: Array<[number, number]> = [[-spread, front], [spread, front], [-spread, back], [spread, back]]
  for (let index = 0; index < places.length; index += 1) {
    const [x, z] = places[index]; cylinder(root, 'leg-' + index, radius, height, [x, height / 2, z], hide)
    sphere(root, 'paw-' + index, radius * 1.2, [x, .05, z + .04], hide, [1.25, .58, 1.35])
    for (let clawIndex = -1; clawIndex <= 1; clawIndex += 1) cone(root, 'claw-' + index + '-' + clawIndex, .012, .09, [x + clawIndex * .03, .06, z + .1], claw, [Math.PI, 0, 0])
  }
}

function face(root: THREE.Group, hide: THREE.Material, dark: THREE.Material, eye: THREE.Material, muzzle: THREE.Material,
  head: [number, number, number], headScale: [number, number, number], muzzlePosition: [number, number, number],
  muzzleScale: [number, number, number], earsHeight: number, earsRadius: number) {
  const neck = sphere(root, 'neck', 1, [head[0], head[1] - .23, head[2] - .22], hide, [headScale[0] * .78, .37, .29])
  neck.rotation.x = .53
  sphere(root, 'head', 1, head, hide, headScale)
  sphere(root, 'muzzle', .16, muzzlePosition, muzzle, muzzleScale)
  for (const side of [-1, 1]) {
    sphere(root, 'eye-' + side, .028,
      [head[0] + side * headScale[0] * .42, head[1] + .05, head[2] + headScale[2] * .90],
      eye, [1, 1, .55])
    const headTop = head[1] + headScale[1]
    cone(root, 'ear-' + side, earsRadius, earsHeight,
      [side * earsRadius * 1.9, headTop - earsHeight * .20, head[2] - .02], dark)
  }
}

function makePalette(slug: AstohanBeastSlug) {
  if (slug === 'hell-hound') return ['#522a25', '#2c1e24', '#67352a', '#c47447', '#f2c05b'] as const
  if (slug === 'lion') return ['#b27a3d', '#674126', '#8d5b31', '#d1b078', '#b45c2e'] as const
  if (slug === 'brown-bear') return ['#614332', '#38291f', '#8f6749', '#dac7a0', '#cf8851'] as const
  if (slug === 'giant-boar') return ['#80604b', '#4e372d', '#8d6c55', '#ead5ad', '#a74732'] as const
  if (slug === 'hyena') return ['#826b58', '#4c4039', '#9c8367', '#d5c49f', '#b95d39'] as const
  if (slug === 'jackal') return ['#ad8d60', '#5c4937', '#8d704e', '#dbcaa3', '#bf7542'] as const
  return ['#6b6f74', '#353d43', '#82878b', '#d9cfad', '#b3d27b'] as const
}

export function buildAstohanBeast(value: unknown): THREE.Group | null {
  const slug = slugOf(value) as AstohanBeastSlug
  if (!SLUGS.has(slug)) return null
  const [hideColor, darkColor, muzzleColor, clawColor, eyeColor] = makePalette(slug)
  const hide = mat(hideColor), dark = mat(darkColor), muzzle = mat(muzzleColor), claw = mat(clawColor), eye = mat(eyeColor)
  const root = new THREE.Group()
  root.name = 'astohan-beast:' + slug; root.userData.astohanBeastSlug = slug; root.userData.board3dPickable = false
  if (slug === 'brown-bear') {
    sphere(root, 'body', .5, [0, .79, -.05], hide, [1.16, 1.12, 1.45])
    sphere(root, 'shoulder-fur', .41, [0, 1.03, .28], hide, [1.28, .76, .82])
    sphere(root, 'neck-fur', .31, [0, 1.26, .38], dark, [1.35, .83, .72])
    legs(root, hide, claw, .3, .34, -.38, .66, .12)
    face(root, hide, dark, eye, muzzle, [0, 1.45, .54], [.38, .42, .38], [0, 1.34, .86], [.75, .65, .72], .22, .13)
    sphere(root, 'bear-nose', .08, [0, 1.35, .98], dark, [1.3, .75, .75])
    tube(root, 'tail', [[0, .75, -.71], [0, .75, -.86], [0, .88, -.93]], .13, dark)
  } else if (slug === 'giant-boar') {
    sphere(root, 'body', .48, [0, .68, -.05], hide, [1.18, .92, 1.62])
    sphere(root, 'boar-shoulder', .34, [0, .82, .36], hide, [1.28, .82, .72])
    sphere(root, 'boar-neck', .27, [0, .94, .58], dark, [1.22, .82, .70])
    legs(root, dark, claw, .29, .39, -.43, .5, .1)
    face(root, hide, dark, eye, muzzle, [0, 1.02, .75], [.36, .34, .44], [0, .91, 1.08], [1, .72, .72], .18, .1)
    sphere(root, 'boar-snout', .15, [0, .91, 1.16], muzzle, [1.05, .72, .72])
    for (let index = 0; index < 7; index += 1) cone(root, 'bristle-' + index, .045, .26, [-.5 + index * .17, 1.06 + .04 * Math.sin(index), -.2], dark, [0, 0, Math.PI / 2])
    for (const side of [-1, 1]) cone(root, 'tusk-' + side, .035, .26, [side * .18, .94, 1.14], claw, [Math.PI, 0, side * .28])
  } else if (slug === 'lion') {
    sphere(root, 'body', .42, [0, .83, -.08], hide, [1.1, .9, 1.72]); legs(root, dark, claw, .25, .43, -.44, .58, .085)
    face(root, hide, dark, eye, muzzle, [0, 1.39, .69], [.32, .34, .34], [0, 1.3, .95], [.72, .58, .78], .15, .1)
    add(root, 'mane', new THREE.TorusGeometry(.38, .12, 8, 14), dark, [0, 1.3, .34], [.92, 1, 1.18], [Math.PI / 2, 0, 0])
    tube(root, 'tail', [[0, .84, -.72], [.05, 1.05, -1.08], [.2, 1.22, -1.24]], .045, hide)
    sphere(root, 'tail-tuft', .1, [.2, 1.22, -1.24], dark, [1, 1.25, 1])
  } else if (slug === 'hyena') {
    sphere(root, 'body', .4, [0, .72, -.08], hide, [1.08, .98, 1.55]); legs(root, dark, claw, .25, .4, -.41, .57, .08)
    face(root, hide, dark, eye, muzzle, [0, 1.26, .67], [.28, .38, .33], [0, 1.15, .94], [.74, .56, .95], .28, .1)
    for (let index = 0; index < 6; index += 1) cone(root, 'mane-' + index, .045, .22, [-.35 + index * .14, 1.12 + .04 * Math.sin(index), -.35], dark, [0, 0, Math.PI / 2])
    tube(root, 'tail', [[0, .8, -.63], [.1, .94, -1.05], [.12, 1.06, -1.3]], .04, dark)
  } else if (slug === 'jackal') {
    sphere(root, 'body', .32, [0, .68, -.12], hide, [1.02, .84, 1.62]); legs(root, dark, claw, .2, .42, -.43, .58, .06)
    face(root, hide, dark, eye, muzzle, [0, 1.36, .67], [.23, .31, .26], [0, 1.28, .93], [.57, .52, 1.12], .42, .075)
    tube(root, 'tail', [[0, .82, -.53], [.08, 1, -.91], [.04, 1.18, -1.15]], .035, dark)
  } else {
    const fiery = slug === 'hell-hound'
    sphere(root, 'body', .39, [0, .78, -.08], hide, [1.08, .94, 1.65]); legs(root, dark, claw, .23, .43, -.44, .61, .075)
    face(root, hide, dark, eye, muzzle, [0, 1.39, .72], [.28, .34, .3], [0, 1.27, .99], [.63, .55, .92], .32, .085)
    tube(root, 'tail', [[0, .82, -.67], [.11, 1.06, -1.04], [.18, 1.22, -1.22]], .04, dark)
    if (fiery) for (const [x, z] of [[-.24, -.35], [0, -.48], [.24, -.35]] as Array<[number, number]>) cone(root, 'ember-ridge', .055, .18, [x, 1.1, z], mat('#b84b36', { emissive: '#b84b36', emissiveIntensity: .36 }), [0, 0, Math.PI / 2])
  }
  const bounds = new THREE.Box3().setFromObject(root, true)
  if (bounds.min.y < 0) root.position.y -= bounds.min.y
  root.userData.astohanBeastHeight = bounds.max.y - Math.min(0, bounds.min.y)
  return root
}
