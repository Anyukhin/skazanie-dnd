import * as THREE from 'three'

export type CampaignSummonSlug =
  | 'spiritual-weapon' | 'beast' | 'animal' | 'fey' | 'lesser-demon'
  | 'shadowspawn' | 'undead' | 'woodland' | 'faithful-hound' | 'aberration'
  | 'construct' | 'elemental' | 'greater-demon'

const PREFIX = 'astohan-summon-'
const SLUGS = new Set<CampaignSummonSlug>([
  'spiritual-weapon', 'beast', 'animal', 'fey', 'lesser-demon', 'shadowspawn',
  'undead', 'woodland', 'faithful-hound', 'aberration', 'construct', 'elemental',
  'greater-demon',
])

export function isCampaignSummonKey(key: string | undefined): key is string {
  return Boolean(key?.startsWith(PREFIX) && SLUGS.has(key.slice(PREFIX.length) as CampaignSummonSlug))
}

function material(color: string, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: .78, ...options })
}

function add(root: THREE.Group, name: string, geometry: THREE.BufferGeometry, surface: THREE.Material, position: [number, number, number], scale?: [number, number, number]) {
  const mesh = new THREE.Mesh(geometry, surface)
  mesh.name = name
  mesh.position.set(...position)
  if (scale) mesh.scale.set(...scale)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.board3dPickable = false
  root.add(mesh)
  return mesh
}

function sphere(root: THREE.Group, name: string, radius: number, position: [number, number, number], surface: THREE.Material, scale?: [number, number, number]) {
  return add(root, name, new THREE.SphereGeometry(radius, 10, 7), surface, position, scale)
}

function cone(root: THREE.Group, name: string, radius: number, height: number, position: [number, number, number], surface: THREE.Material, rotation: [number, number, number] = [0, 0, 0]) {
  const mesh = add(root, name, new THREE.ConeGeometry(radius, height, 7), surface, position)
  mesh.rotation.set(...rotation)
  return mesh
}

function tube(root: THREE.Group, name: string, points: Array<[number, number, number]>, radius: number, surface: THREE.Material) {
  return add(root, name, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point))), 8, radius, 6, false), surface, [0, 0, 0])
}

function humanoidSpirit(root: THREE.Group, surface: THREE.Material, accent: THREE.Material, wings = false) {
  sphere(root, 'summon-head', .17, [0, 1.2, .08], surface, [.86, 1, .9])
  add(root, 'summon-body', new THREE.CapsuleGeometry(.22, .56, 4, 8), surface, [0, .72, 0], [.78, 1, .72])
  for (const side of [-1, 1]) {
    add(root, 'summon-arm', new THREE.CylinderGeometry(.055, .07, .47, 7), surface, [side * .24, .7, 0], [1, 1, 1])
    add(root, 'summon-leg', new THREE.CylinderGeometry(.07, .085, .52, 7), surface, [side * .11, .27, 0])
  }
  sphere(root, 'summon-eye-l', .028, [-.065, 1.23, .14], accent)
  sphere(root, 'summon-eye-r', .028, [.065, 1.23, .14], accent)
  if (wings) for (const side of [-1, 1]) {
    const wing = add(root, 'summon-wing', new THREE.ConeGeometry(.32, .72, 5), accent, [side * .31, .82, -.03], [1, .8, .45])
    wing.rotation.z = side * .75
  }
}

function creature(root: THREE.Group, surface: THREE.Material, accent: THREE.Material, h = .78, horns = false) {
  sphere(root, 'summon-body', .34, [0, h * .55, -.05], surface, [1.2, .9, 1.5])
  for (const side of [-1, 1]) {
    add(root, 'summon-leg', new THREE.CylinderGeometry(.07, .08, h * .55, 7), surface, [side * .22, h * .25, .24])
    add(root, 'summon-leg', new THREE.CylinderGeometry(.07, .08, h * .55, 7), surface, [side * .22, h * .25, -.35])
  }
  sphere(root, 'summon-head', .25, [0, h * .88, .38], surface, [.95, .9, 1.1])
  sphere(root, 'summon-eye-l', .026, [-.08, h * .92, .57], accent)
  sphere(root, 'summon-eye-r', .026, [.08, h * .92, .57], accent)
  for (const side of [-1, 1]) {
    const ear = cone(root, 'summon-ear', .08, .25, [side * .12, h * 1.10, .35], surface)
    ear.rotation.z = side * .45
  }
  if (horns) for (const side of [-1, 1]) {
    const horn = cone(root, 'summon-horn', .07, .32, [side * .15, h * 1.12, .16], accent)
    horn.rotation.z = side * .28
  }
  tube(root, 'summon-tail', [[0, h*.56, -.50], [sideTail(h), h*.68, -.76], [sideTail(h)*1.4, h*.86, -.85]], .035, surface)
}

function sideTail(height: number) { return height > 1 ? .12 : .06 }

export function buildCampaignSummon(key: string): THREE.Group | null {
  if (!key.startsWith(PREFIX)) return null
  const slug = key.slice(PREFIX.length) as CampaignSummonSlug
  if (!SLUGS.has(slug)) return null
  const root = new THREE.Group()
  root.name = key
  root.userData.board3dPickable = false
  const spectral = material(slug === 'spiritual-weapon' ? '#cfb56a' : slug === 'elemental' ? '#5b9ea4' : '#768ca1', {
    transparent: slug === 'shadowspawn' || slug === 'fey' || slug === 'undead',
    opacity: slug === 'shadowspawn' || slug === 'fey' || slug === 'undead' ? .74 : 1,
    emissive: slug === 'elemental' ? '#245b70' : '#18253a',
    emissiveIntensity: slug === 'elemental' ? .28 : .05,
  })
  const accent = material(slug === 'greater-demon' || slug === 'lesser-demon' ? '#a94b3f' : '#d5c788', { roughness: .64 })
  if (slug === 'spiritual-weapon') {
    const hilt = add(root, 'weapon-hilt', new THREE.CylinderGeometry(.055, .07, .72, 8), accent, [0, .45, 0])
    hilt.rotation.z = Math.PI / 2
    add(root, 'weapon-blade', new THREE.ConeGeometry(.17, .86, 6), spectral, [0, 1.14, 0], [1, 1, .5])
    add(root, 'weapon-guard', new THREE.BoxGeometry(.5, .045, .07), accent, [0, .78, 0])
  } else if (slug === 'beast' || slug === 'animal' || slug === 'faithful-hound') {
    creature(root, spectral, accent, slug === 'faithful-hound' ? .66 : .78)
  } else if (slug === 'fey' || slug === 'shadowspawn' || slug === 'undead') {
    humanoidSpirit(root, spectral, accent, slug === 'fey')
    if (slug === 'undead') sphere(root, 'summon-skull-mask', .16, [0, 1.19, .20], accent, [.8, .85, .45])
  } else if (slug === 'woodland') {
    sphere(root, 'summon-woodland-body', .32, [0, .65, 0], spectral, [1, 1.6, 1])
    for (const side of [-1, 1]) tube(root, 'summon-branch-arm', [[0,.82,0],[side*.3,.98,.04],[side*.38,1.2,.1]], .035, accent)
    sphere(root, 'summon-leaf-crown', .38, [0, 1.25, 0], accent, [1.2, .65, 1])
  } else if (slug === 'lesser-demon' || slug === 'greater-demon') {
    humanoidSpirit(root, spectral, accent)
    for (const side of [-1, 1]) cone(root, 'summon-demon-horn', .08, .36, [side*.15,1.42,.03], accent)
  } else if (slug === 'aberration') {
    sphere(root, 'summon-aberration-body', .38, [0, .72, 0], spectral, [1.1, 1.4, 1])
    for (let i=0;i<5;i++) tube(root,'summon-tentacle',[[0,.62,0],[Math.cos(i*1.25)*.3,.35,Math.sin(i*1.25)*.3],[Math.cos(i*1.25)*.47,.06,Math.sin(i*1.25)*.47]],.025,accent)
    sphere(root,'summon-aberration-eye',.09,[0,1.12,.2],accent,[1,.7,.4])
  } else if (slug === 'construct') {
    add(root, 'summon-construct-body', new THREE.BoxGeometry(.58,.8,.45), spectral, [0,.56,0])
    for (const side of [-1,1]) add(root,'summon-construct-core',new THREE.SphereGeometry(.075,8,6),accent,[side*.13,.66,.25])
  } else if (slug === 'elemental') {
    for (let i=0;i<5;i++) {
      const rock = add(root,'summon-elemental-limb',new THREE.IcosahedronGeometry(.18,0),spectral,[Math.sin(i*1.7)*.28,.25+i*.18,Math.cos(i*1.7)*.24])
      rock.rotation.set(i*.4,i*.7,i*.2)
    }
  }
  root.traverse(node => { node.userData.board3dPickable = false })
  return root
}
