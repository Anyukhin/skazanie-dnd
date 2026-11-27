import {
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three'

export type GhostMaidInput = { id: string; color?: string }
export type GhostMaidRig = {
  motion: Group
  parts: Map<string, Object3D>
  rest: Map<Object3D, { position: Vector3; rotation: { x: number; y: number; z: number } }>
}

function register(rig: GhostMaidRig, key: string, object: Object3D): Object3D {
  object.name = `rig-${key}`
  rig.parts.set(key, object)
  rig.rest.set(object, { position: object.position.clone(), rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z } })
  return object
}

function part(rig: GhostMaidRig, key: string, position: [number, number, number]): Group {
  const object = new Group()
  object.position.set(...position)
  register(rig, key, object)
  rig.motion.add(object)
  return object
}

function material(color: string, opacity: number, emissive: string, roughness = .45): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color, emissive, emissiveIntensity: .42, roughness, metalness: .02,
    transparent: opacity < 1, opacity, depthWrite: false, side: DoubleSide,
  })
}

function mesh(parent: Object3D, geometry: BufferGeometry, surface: MeshStandardMaterial, name: string, position: [number, number, number] = [0, 0, 0]) {
  const object = new Mesh(geometry, surface)
  object.name = name
  object.position.set(...position)
  object.castShadow = true
  object.receiveShadow = true
  parent.add(object)
  return object
}

function lathe(parent: Object3D, name: string, points: Array<[number, number]>, surface: MeshStandardMaterial, segments = 48) {
  return mesh(parent, new LatheGeometry(points.map(([radius, y]) => new Vector2(radius, y)), segments), surface, name)
}

function curve(parent: Object3D, name: string, points: Array<[number, number, number]>, radius: number, surface: MeshStandardMaterial) {
  const path = new CatmullRomCurve3(points.map(([x, y, z]) => new Vector3(x, y, z)))
  return mesh(parent, new TubeGeometry(path, Math.max(8, points.length * 4), radius, 8, false), surface, name)
}

function apronGeometry(): ExtrudeGeometry {
  const shape = new Shape()
  shape.moveTo(-.14, .2)
  shape.lineTo(.14, .2)
  shape.lineTo(.19, -.35)
  shape.quadraticCurveTo(0, -.42, -.19, -.35)
  shape.closePath()
  return new ExtrudeGeometry(shape, { depth: .018, bevelEnabled: true, bevelSegments: 3, bevelSize: .008, bevelThickness: .006 })
}

function base(root: Group, accent: MeshStandardMaterial) {
  mesh(root, new CylinderGeometry(.29, .34, .05, 32), material('#465e63', .95, '#203e43', .58), 'miniature-base', [0, .025, 0])
  mesh(root, new CylinderGeometry(.205, .205, .008, 32), accent, 'miniature-base-inlay', [0, .055, 0])
  const rim = mesh(root, new TorusGeometry(.28, .012, 10, 48), material('#b49b73', .95, '#3b3228', .5), 'miniature-base-rim', [0, .058, 0])
  rim.rotation.x = -Math.PI / 2
}

export function buildGhostMaidModel(input: GhostMaidInput): { root: Group; rig: GhostMaidRig } {
  const root = new Group()
  root.name = 'procedural-ghost-maid-' + input.id
  const motion = new Group()
  motion.name = 'actor-motion'
  root.add(motion)
  const rig: GhostMaidRig = { motion, parts: new Map(), rest: new Map() }
  const dress = material('#9ad8d9', .43, '#55cbd3', .35)
  const linen = material('#d6f4ed', .57, '#8de7ec', .3)
  const face = material('#d9f8f5', .78, '#63ccd2', .4)
  const dark = material('#254c57', .92, '#2e8994', .42)
  const eye = material('#163a4a', .95, '#69e2e6', .2)
  const accent = material(input.color || '#75d8e1', .95, '#2e8994', .5)
  base(root, accent)

  const torso = part(rig, 'torso', [0, .7, 0])
  const head = part(rig, 'head', [0, 1.28, 0])
  const leftArm = part(rig, 'leftArm', [-.2, .92, 0])
  const rightArm = part(rig, 'rightArm', [.2, .92, 0])
  const dressPoints: Array<[number, number]> = [[.08, -.51], [.16, -.50], [.23, -.46], [.27, -.39], [.30, -.29], [.31, -.17], [.29, -.03], [.25, .1], [.21, .22]]
  lathe(torso, 'ghost-maid-skirt', dressPoints, dress, 40)
  lathe(torso, 'ghost-maid-bodice', [[.13, .15], [.17, .2], [.19, .28], [.18, .39], [.14, .48]], dress, 32)
  for (let index = -2; index <= 2; index += 1) {
    const x = index * .065
    curve(torso, 'ghost-maid-skirt-fold-' + index, [[x * .72, .2, -.22], [x, -.08, -.28], [x * 1.18, -.38, -.24]], .012, linen)
  }
  mesh(torso, apronGeometry(), linen, 'ghost-maid-apron', [0, -.01, -.235])
  curve(torso, 'ghost-maid-apron-tie', [[-.17, .23, -.24], [0, .2, -.26], [.17, .23, -.24]], .014, dark)
  curve(torso, 'ghost-maid-apron-seam', [[-.11, .15, -.255], [0, -.24, -.255], [.11, .15, -.255]], .008, linen)
  mesh(torso, new TorusGeometry(.22, .018, 8, 24), dark, 'ghost-maid-waist-tie', [0, .18, 0],)

  // Лицо держит анатомический порядок: надбровья, глаза, переносица, нос,
  // губы и подбородок. Все детали остаются частью головы и не отрываются.
  mesh(head, new SphereGeometry(.17, 24, 16), face, 'ghost-maid-face', [0, 0, 0])
  mesh(head, new SphereGeometry(.045, 12, 8), linen, 'ghost-maid-eye-white-left', [-.058, .015, -.152])
  mesh(head, new SphereGeometry(.045, 12, 8), linen, 'ghost-maid-eye-white-right', [.058, .015, -.152])
  mesh(head, new SphereGeometry(.018, 12, 8), eye, 'ghost-maid-eye-left', [-.058, .015, -.188])
  mesh(head, new SphereGeometry(.018, 12, 8), eye, 'ghost-maid-eye-right', [.058, .015, -.188])
  curve(head, 'ghost-maid-brow-left', [[-.105, .07, -.145], [-.06, .085, -.17], [-.02, .07, -.155]], .012, dark)
  curve(head, 'ghost-maid-brow-right', [[.02, .07, -.155], [.06, .085, -.17], [.105, .07, -.145]], .012, dark)
  mesh(head, new SphereGeometry(.025, 12, 8), face, 'ghost-maid-nose', [0, -.005, -.18])
  curve(head, 'ghost-maid-nose-bridge', [[0, .045, -.16], [0, .01, -.19], [0, -.025, -.18]], .013, face)
  curve(head, 'ghost-maid-lips', [[-.045, -.065, -.16], [0, -.078, -.178], [.045, -.065, -.16]], .009, dark)
  mesh(head, new SphereGeometry(.046, 12, 8), face, 'ghost-maid-chin', [0, -.115, -.13],)

  // Мягкий чепец, без острия. Вуаль обрамляет лицо и переходит в плечи.
  lathe(head, 'ghost-maid-cap', [[.03, .1], [.1, .105], [.17, .13], [.2, .17], [.18, .22], [.12, .25]], linen, 32)
  mesh(head, new TorusGeometry(.18, .016, 8, 24), linen, 'ghost-maid-cap-rim', [0, .105, 0])
  curve(head, 'ghost-maid-veil-left', [[-.16, .1, -.02], [-.2, -.03, -.12], [-.14, -.16, -.08]], .012, linen)
  curve(head, 'ghost-maid-veil-right', [[.16, .1, -.02], [.2, -.03, -.12], [.14, -.16, -.08]], .012, linen)

  // Рукава соединены с плечами и сходятся в молитвенно сложенных руках.
  const sleeve = (arm: Group, side: number) => {
    curve(arm, 'ghost-maid-sleeve-' + side, [[0, .12, 0], [side * .015, -.08, -.01], [-side * .16, -.23, -.12]], .067, dress)
    curve(arm, 'ghost-maid-cuff-' + side, [[-side * .15, -.22, -.12], [-side * .16, -.27, -.17]], .045, linen)
    mesh(arm, new SphereGeometry(.046, 16, 10), face, 'ghost-maid-hand-' + side, [-side * .16, -.31, -.19])
  }
  sleeve(leftArm, -1); sleeve(rightArm, 1)
  curve(root, 'ghost-maid-hand-join', [[-.03, .61, -.19], [0, .57, -.22], [.03, .61, -.19]], .025, face)

  // Подол распадается крупными прикреплёнными прядями, а не отдельными палочками.
  for (let index = 0; index < 6; index += 1) {
    const angle = Math.PI * 2 * index / 6
    const start = new Vector3(Math.cos(angle) * .22, .2, Math.sin(angle) * .22)
    const end = new Vector3(Math.cos(angle + .2) * (.27 + (index % 2) * .03), -.08 - (index % 3) * .03, Math.sin(angle + .2) * (.27 + (index % 2) * .03))
    curve(torso, 'ghost-maid-dissolve-' + index, [[start.x, start.y, start.z], [(start.x + end.x) / 2, .04, (start.z + end.z) / 2], [end.x, end.y, end.z]], .014, linen)
  }
  return { root, rig }
}

function boneByName(root: Object3D, ...names: string[]): Object3D | null {
  for (const name of names) {
    const found = root.getObjectByName(name)
    if (found) return found
  }
  return null
}

function ghostOverlayMaterial(color: string, opacity: number, emissive = '#7bb9be') {
  return new MeshStandardMaterial({
    color, emissive, emissiveIntensity: .18, roughness: .62,
    transparent: opacity < 1, opacity, depthWrite: opacity >= .9,
    side: DoubleSide,
  })
}

/** Полотнище с моделированными складками. Альфа вершин растворяет край подола. */
function clothSheet(columns: number, rows: number, point: (u: number, v: number) => [number, number, number, number]) {
  const xyz: number[] = [], rgba: number[] = [], indices: number[] = []
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const [x, y, z, alpha] = point(col / columns, row / rows)
    xyz.push(x, y, z); rgba.push(1, 1, 1, alpha)
    if (row < rows && col < columns) {
      const a = row * (columns + 1) + col, b = a + columns + 1
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(xyz, 3))
  geo.setAttribute('color', new Float32BufferAttribute(rgba, 4))
  geo.setIndex(indices); geo.computeVertexNormals()
  return geo
}

/** Одежда строится в исходной позе Quaternius и привязывается к живому скелету. */
export function addGhostMaidGlbOverlays(root: Group): void {
  const head = boneByName(root, 'Head'), torso = boneByName(root, 'spine_02'), hips = boneByName(root, 'pelvis')
  if (!head || !torso || !hips) return
  // У каждого экземпляра свой parse GLB. Меняем каждый локальный материал
  // один раз и сохраняем рисунок исходной фактуры, в том числе брови и губы.
  const recolored = new Set<MeshStandardMaterial>()
  root.traverse(node => {
    const piece = node as Mesh
    if (!piece.isMesh) return
    if (piece.name === 'Feet' || piece.name === 'Legs') piece.visible = false
    piece.castShadow = false
    for (const surface of Array.isArray(piece.material) ? piece.material : [piece.material]) {
      if (!(surface instanceof MeshStandardMaterial) || recolored.has(surface)) continue
      recolored.add(surface)
      surface.transparent = true; surface.opacity = surface.name.includes('Peasant') ? .85 : .96
      surface.depthWrite = true; surface.emissive.set('#619095')
      surface.emissiveIntensity = surface.name.includes('Superhero') ? .29 : .16
      surface.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
          #include <color_fragment>
          float tone = pow(clamp(dot(diffuseColor.rgb, vec3(.2126, .7152, .0722)), 0.0, 1.0), .74);
          diffuseColor.rgb = mix(vec3(.022,.049,.063), vec3(.63,.80,.79), tone);
        `)
      }
    }
  })
  const linen = ghostOverlayMaterial('#c3d5cf', .93, '#578182')
  const gown = ghostOverlayMaterial('#718b91', .93, '#446d72')
  linen.vertexColors = true; gown.vertexColors = true
  const trim = ghostOverlayMaterial('#9fb4ac', .9, '#53777a')
  function sew(bone: Object3D, name: string, geometry: BufferGeometry, fabric: MeshStandardMaterial) {
    const patch = new Mesh(geometry, fabric)
    patch.name = name; patch.receiveShadow = true
    root.add(patch); bone.attach(patch)
  }
  // Перед чепца проходит над бровями. Сзади ткань закрывает собранные волосы.
  const cap = clothSheet(48, 12, (u,v) => {
    const a = u * Math.PI * 2, front = Math.cos(a)
    const r = Math.cos(v * Math.PI / 2) * (1 + .06 * Math.sin(v * Math.PI))
    const gather = 1 + .032 * Math.cos(14 * a) * (1 - v)
    const brim = 1.655 + .060 * front
    return [.134 * Math.sin(a) * r * gather, brim + (1.815 - brim) * Math.sin(v * Math.PI / 2),
      -.027 + .152 * front * r * gather, 1]
  })
  sew(head, 'ghost-maid-glb-cap', cap, linen)
  const brimPoints = Array.from({ length: 33 }, (_,i) => {
    const a = i * Math.PI / 16
    return new Vector3(.135 * Math.sin(a), 1.655 + .060 * Math.cos(a), -.027 + .153 * Math.cos(a))
  })
  sew(head, 'ghost-maid-glb-cap-seam', new TubeGeometry(new CatmullRomCurve3(brimPoints), 48, .0045, 6, false), trim)
  const edging = clothSheet(64, 3, (u,v) => {
    const a = u * Math.PI * 2, front = Math.cos(a)
    const ripple = .004 * (1 - v) * Math.sin(20 * a)
    return [(.137 + ripple) * Math.sin(a), 1.654 + .060 * front - v * (.015 + .005 * Math.sin(20*a)),
      -.027 + (.155 + ripple) * front, .96]
  })
  sew(head, 'ghost-maid-coif-edge', edging, linen)
  for (const side of [-1, 1]) {
    sew(head, 'ghost-maid-coif-tie', clothSheet(4, 8, (u,v) =>
      [side * (.118 - .055*v*v + (u-.5)*.019), 1.669 - .142*v,
        .004 + .078*v + .008*Math.sin(v*Math.PI), 1]), linen)
  }

  const skirtPoint = (a: number, v: number): [number, number, number] => {
    const fold = (.004 + .018 * v) * Math.cos(10 * a + .55 * v)
    const flare = Math.sin(v * Math.PI / 2) * .045 + .135 * v
    return [( .145 + flare + fold) * Math.sin(a), 1.08 - .94 * v + .022 * v**4 * Math.sin(7 * a),
      -.022 + (.126 + flare + fold) * Math.cos(a)]
  }
  sew(hips, 'ghost-maid-glb-skirt', clothSheet(64, 14, (u,v) => [...skirtPoint(u * Math.PI * 2,v), 1 - .7 * v**7]), gown)
  // Передник повторяет складки юбки с небольшим зазором и не проваливается в неё.
  sew(hips, 'ghost-maid-glb-apron', clothSheet(24, 11, (u,t) => {
    const a = (u - .5) * 1.78, v = t * (.81 - .055 * Math.abs(2*u-1)**3)
    const [x,y,z] = skirtPoint(a,v)
    return [x + .016 * Math.sin(a), y + .005, z + .021 * Math.cos(a), 1 - .18*t**5]
  }), linen)
  sew(torso, 'ghost-maid-glb-apron-bib', clothSheet(12, 8, (u,v) => {
    const x = (u-.5) * (.165 + .024*v)
    return [x, 1.338 - .256*v, .176 - .025*v - .026 * (2*u-1)**2, 1]
  }), linen)
  const sash = clothSheet(40, 2, (u,v) => {
    const a = u * 2 * Math.PI
    return [.163 * Math.sin(a), 1.09 - v * .029, -.02 + .148 * Math.cos(a), 1]
  })
  sew(hips, 'ghost-maid-glb-waistband', sash, linen)
}
