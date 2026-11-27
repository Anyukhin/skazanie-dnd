import * as THREE from 'three'

type MaterialSet = { body: THREE.Material; dark: THREE.Material; light: THREE.Material; bone: THREE.Material; metal: THREE.Material }

function material(color: string, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: .86, metalness: 0, ...options })
}

function materials(slug: string): MaterialSet {
  if (slug === 'water-elemental') return {
    body: material('#3b91aa', { transparent: true, opacity: .82, roughness: .2, metalness: .05 }),
    dark: material('#18566c', { transparent: true, opacity: .82, roughness: .25 }),
    light: material('#9bd9d2', { transparent: true, opacity: .78, roughness: .15 }),
    bone: material('#d6f2e8', { transparent: true, opacity: .65 }),
    metal: material('#9ee7ed', { emissive: '#4ba9bd', emissiveIntensity: .15, transparent: true, opacity: .75 }),
  }
  if (slug === 'air-elemental') return {
    body: material('#b7d4df', { transparent: true, opacity: .58, roughness: .18 }),
    dark: material('#668ca4', { transparent: true, opacity: .55, roughness: .22 }),
    light: material('#e5f7f5', { transparent: true, opacity: .48, roughness: .1 }),
    bone: material('#d5f0f5', { transparent: true, opacity: .5 }),
    metal: material('#9fc4d5', { transparent: true, opacity: .42 }),
  }
  if (slug === 'awakened-shrub') return {
    body: material('#466044', { roughness: .98 }), dark: material('#263b28', { roughness: 1 }),
    light: material('#87a955', { roughness: .94 }), bone: material('#b4a17b', { roughness: .94 }),
    metal: material('#80613f', { roughness: .92 }),
  }
  const body = slug === 'troll' ? '#5a7b4c' : slug === 'hill-giant' ? '#765b45' : slug === 'ettin' ? '#6b6655' : '#6e563e'
  return { body: material(body), dark: material('#302c28'), light: material(slug === 'troll' ? '#9caf68' : '#a7835d'), bone: material('#d4c49a', { roughness: .95 }), metal: material('#68666a', { metalness: .45, roughness: .55 }) }
}

function add(root: THREE.Group, mesh: THREE.Mesh, name: string) {
  mesh.name = name
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.board3dPickable = false
  root.add(mesh)
  return mesh
}

function sphere(root: THREE.Group, name: string, radius: number, position: [number, number, number], materialValue: THREE.Material, scale: [number, number, number] = [1, 1, 1]) {
  const mesh = add(root, new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), materialValue), name)
  mesh.position.set(...position)
  mesh.scale.set(...scale)
  return mesh
}

function box(root: THREE.Group, name: string, size: [number, number, number], position: [number, number, number], materialValue: THREE.Material, rotation?: [number, number, number]) {
  const mesh = add(root, new THREE.Mesh(new THREE.BoxGeometry(...size), materialValue), name)
  mesh.position.set(...position)
  if (rotation) mesh.rotation.set(...rotation)
  return mesh
}

function cone(root: THREE.Group, name: string, radius: number, height: number, position: [number, number, number], materialValue: THREE.Material, rotation?: [number, number, number]) {
  const mesh = add(root, new THREE.Mesh(new THREE.ConeGeometry(radius, height, 8), materialValue), name)
  mesh.position.set(...position)
  if (rotation) mesh.rotation.set(...rotation)
  return mesh
}

function limb(root: THREE.Group, name: string, from: [number, number, number], to: [number, number, number], radius: number, materialValue: THREE.Material) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), delta = b.clone().sub(a)
  const mesh = add(root, new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.12, delta.length(), 8), materialValue), name)
  mesh.position.copy(a).add(b).multiplyScalar(.5)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize())
  return mesh
}

function club(root: THREE.Group, materialValue: THREE.Material, large = false, side = 1) {
  const scale = large ? 1.12 : .82
  limb(root, 'giant-club-handle', [side * .34, .58, .02], [side * .42, .16, .04], .055, materialValue)
  cone(root, 'giant-club-head', .14 * scale, .38 * scale, [side * .43, .78, .05], materialValue, [0, 0, -side * .15])
}

function humanoid(slug: string, p: MaterialSet) {
  const root = new THREE.Group()
  root.name = 'astohan-giant-' + slug
  const tall = slug === 'hill-giant' ? 1.75 : slug === 'ettin' ? 1.65 : slug === 'troll' ? 1.45 : 1.35
  const broad = slug === 'ogre' || slug === 'hill-giant' ? .5 : .4
  const torso = sphere(root, 'giant-torso', .38, [0, .72, 0], p.body, [broad / .38, .96, .70 / .38])
  torso.rotation.z = slug === 'troll' ? -.12 : slug === 'ettin' ? .08 : -.03
  sphere(root, 'giant-belly', .30, [0, .53, .18], p.light, [1.25, .84, .86])
  box(root, 'giant-ragged-belt', [broad * 1.48, .075, .28], [0, .44, .02], p.dark, [0, 0, slug === 'troll' ? -.08 : .04])
  for (const side of [-1, 1]) {
    const armTop = slug === 'troll' ? .95 : 1.02
    const handY = slug === 'troll' ? .18 : .43
    limb(root, 'giant-upper-arm', [side * broad * .62, armTop, 0], [side * (broad + .08), .62, .08], slug === 'troll' ? .10 : .082, p.body)
    limb(root, 'giant-forearm', [side * (broad + .08), .62, .08], [side * (broad + (slug === 'troll' ? .22 : .16)), handY, .16], slug === 'troll' ? .088 : .07, p.light)
    sphere(root, 'giant-hand', .095, [side * (broad + (slug === 'troll' ? .22 : .16)), handY - .025, .17], p.bone, [1.15, .72, 1])
    limb(root, 'giant-leg', [side * .18, .46, 0], [side * .23, .08, .05], .10, p.dark)
    sphere(root, 'giant-foot', .13, [side * .23, .065, .15], p.dark, [1.25, .48, 1.7])
  }
  const face = (name: string, x: number, y: number, scale: number, oneEye = false) => {
    sphere(root, name + '-head', .27 * scale, [x, y, .05], p.light, [1.08, 1.20, .90])
    sphere(root, name + '-jaw', .16 * scale, [x, y - .11 * scale, .22], p.body, [1.18, .56, .88])
    sphere(root, name + '-nose', .065 * scale, [x, y - .015 * scale, .28], p.bone, [1.3, .9, 1.2])
    box(root, name + '-brow', [oneEye ? .25 : .30, .045, .06], [x, y + .09 * scale, .25], p.dark, [0, 0, oneEye ? .08 : -.05])
    const eyes = oneEye ? [0] : [-.09, .09]
    for (const side of eyes) {
      sphere(root, name + '-eye', .040 * scale, [x + side * scale, y + .045 * scale, .26], p.bone, [1.18, 1, .52])
      sphere(root, name + '-pupil', .018 * scale, [x + side * scale, y + .045 * scale, .284], p.dark, [1, 1, .65])
    }
    for (const side of (oneEye ? [] : [-1, 1])) cone(root, name + '-tusk', .042 * scale, .15 * scale, [x + side * .10 * scale, y - .12 * scale, .27], p.bone, [Math.PI, 0, side * .18])
  }
  if (slug === 'ettin') {
    face('ettin-left', -.18, 1.34, .92)
    face('ettin-right', .18, 1.40, .98)
    for (const side of [-1, 1]) limb(root, 'ettin-neck', [side * .14, 1.05, 0], [side * .18, 1.24, .01], .09, p.dark)
    club(root, p.dark, false, -1); club(root, p.dark, false, 1)
  } else if (slug === 'cyclops') {
    face('cyclops', 0, 1.30, 1.18, true)
    for (const side of [-1, 1]) cone(root, 'cyclops-horn', .055, .18, [side * .15, 1.52, -.02], p.bone, [0, 0, side * .25])
    club(root, p.dark, true, 1)
  } else {
    face(slug, 0, slug === 'troll' ? 1.18 : 1.30, slug === 'troll' ? 1.12 : 1)
    if (slug === 'troll') {
      for (const side of [-1, 1]) cone(root, 'troll-ear', .08, .24, [side * .26, 1.27, .02], p.bone, [0, 0, side * .9])
      club(root, p.dark, false, 1)
    } else if (slug === 'hill-giant') {
      limb(root, 'hill-giant-trunk', [.56, .41, .20], [.39, 1.58, -.02], .099, p.dark)
      sphere(root, 'hill-giant-trunk-knot', .145, [.38, 1.60, -.02], p.dark, [1, 1.5, 1])
      const pelt = sphere(root, 'hill-giant-hide-mantle', .30, [-.29, .98, -.09], p.dark, [1.36, .56, 1.09])
      pelt.rotation.z = .48
    } else club(root, p.dark)
  }
  root.scale.setScalar(tall / 1.35)
  return root
}

function airElemental(p: MaterialSet) {
  const root = new THREE.Group(); root.name = 'astohan-air-elemental'
  for (let i = 0; i < 5; i++) {
    const angle = i * 1.257
    const y = .38 + i * .19
    const radius = .14 + i * .065
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, .055, 7, 16), p.body)
    ring.name = 'air-vortex-ring'; ring.position.set(Math.cos(angle) * .12, y, Math.sin(angle) * .12); ring.rotation.set(.2 + i * .12, angle, .5); ring.castShadow = true; ring.userData.board3dPickable = false; root.add(ring)
  }
  sphere(root, 'air-core', .14, [0, .62, 0], p.light, [1, 1.5, 1])
  return root
}

function waterElemental(p: MaterialSet) {
  const root = new THREE.Group(); root.name = 'astohan-water-elemental'
  sphere(root, 'water-body', .5, [0, .68, 0], p.body, [1.1, 1.2, .95])
  for (const side of [-1, 1]) limb(root, 'water-arm', [side * .25, .8, 0], [side * .62, 1.08, .12], .085, p.light)
  for (let i=0;i<3;i++) cone(root,'water-crown',.11,.35,[(-1+i)*.18,1.12,.02],p.light)
  return root
}

function awakenedShrub(p: MaterialSet) {
  const root = new THREE.Group(); root.name = 'astohan-awakened-shrub'
  sphere(root, 'shrub-body', .38, [0, .36, 0], p.body, [1.2, .8, 1])
  for (const side of [-1,1]) limb(root,'shrub-leg',[side*.13,.25,0],[side*.19,.05,.08],.045,p.dark)
  for (let i=0;i<7;i++) { const a=i*.9; limb(root,'shrub-branch',[0,.5,0],[Math.cos(a)*.45,.72+Math.sin(i)*.16,.18+Math.sin(a)*.42],.025,p.dark); sphere(root,'shrub-leaf',.10,[Math.cos(a)*.45,.72+Math.sin(i)*.16,.18+Math.sin(a)*.42],p.light,[1,.65,.5]) }
  return root
}

export function buildAstohanGiant(slugValue: string): THREE.Group | null {
  const slug = String(slugValue ?? '').toLowerCase().replace(/_/g, '-')
  const p = materials(slug)
  if (['ogre','troll','hill-giant','ettin','cyclops'].includes(slug)) return humanoid(slug, p)
  if (slug === 'air-elemental') return airElemental(p)
  if (slug === 'water-elemental') return waterElemental(p)
  if (slug === 'awakened-shrub') return awakenedShrub(p)
  return null
}
