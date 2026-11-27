import * as THREE from 'three'
import type { TacticalMap } from './types'
import type { SurroundingsBiome } from './board3d-surroundings'

export type BoardBackdropStyle = 'landscape' | 'atlas' | 'classic'
type Biome = Exclude<SurroundingsBiome, 'indoor'>
type Detail = 'full' | 'reduced' | 'minimal'

// Палитра лугов, тёмных ложбин и освещённых гребней. Цвет задан в sRGB.
const PAINT: Record<Biome, [string, string, number, number]> = {
  meadow: ['#465740', '#92a071', 4.8, .45], forest: ['#294a42', '#71876a', 6, .95],
  deadwood: ['#473f43', '#897e70', 5, 0], mountain: ['#384e57', '#9baba6', 14, .61],
  rock: ['#3c3738', '#656059', 6, 0], sea: ['#275060', '#507985', 0, 0],
}

function noise(x: number, z: number) {
  const ix = Math.floor(x), iz = Math.floor(z)
  const u = THREE.MathUtils.smoothstep(x - ix, 0, 1), v = THREE.MathUtils.smoothstep(z - iz, 0, 1)
  const lattice = (a: number, b: number) => {
    let h = Math.imul(a, 374761393) + Math.imul(b, 668265263)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(lattice(ix, iz), lattice(ix + 1, iz), u),
    THREE.MathUtils.lerp(lattice(ix, iz + 1), lattice(ix + 1, iz + 1), u), v)
}

/** Простой силуэт дальней ели. Светлые кончики неровных лап отделены от тени
 * предыдущего яруса; у земли виден ствол. Один меш для всей дальней рощи. */
function spruceGeometry() {
  const positions: number[] = [], colors: number[] = [], indices: number[] = []
  const shade = new THREE.Color('#294b3c'), needle = new THREE.Color('#628364'), wood = new THREE.Color('#665746')
  const add = (x: number, y: number, z: number, color: THREE.Color, light: number) => {
    const i = positions.length / 3
    positions.push(x, y, z); colors.push(color.r * light, color.g * light, color.b * light)
    return i
  }
  for (let i = 0; i < 5; i++) {
    const a = i * 2 * Math.PI / 5
    add(.029 * Math.cos(a), 0, .029 * Math.sin(a), wood, .78)
    add(.023 * Math.cos(a), .42, .023 * Math.sin(a), wood, 1)
    const b = (i + 1) % 5 * 2
    indices.push(i * 2, i * 2 + 1, b, i * 2 + 1, b + 1, b)
  }
  for (let tier = 0; tier < 4; tier++) {
    const y = .20 + .16 * tier, radius = .29 - .047 * tier
    const peak = add(.014*tier, y + .35, -.009*tier, needle, 1.17)
    const first = positions.length / 3
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6 + tier * .91, tip = i % 2 === 0
      const r = radius * (tip ? 1 + .11 * Math.sin(i*3+tier) : .57)
      const light = .92 - .22 * Math.cos(a) + .15 * Math.sin(a)
      add(.010*tier + r*Math.cos(a), y + (tip ? -.025 * Math.cos(i+tier) : .066), r*Math.sin(a), tip ? needle : shade, light)
      indices.push(peak, first + (i + 1) % 12, first + i)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  g.setIndex(indices)
  return g
}

/** Мягкое пятно под кроной или камнем. Матрица задаёт ориентацию склона и размер. */
export function createGroundShadows(matrices: readonly THREE.Matrix4[], opacity: number) {
  const xyz = [0, 0, 0], rgba = [1, 1, 1, .39], indices: number[] = []
  for (let i=0; i<9; i++) {
    const a=i*Math.PI*2/9
    xyz.push(.42*Math.cos(a),0,.33*Math.sin(a)); rgba.push(1,1,1,0)
    indices.push(0,1+(i+1)%9,1+i)
  }
  const g=new THREE.BufferGeometry()
  g.setAttribute('position',new THREE.Float32BufferAttribute(xyz,3))
  g.setAttribute('color',new THREE.Float32BufferAttribute(rgba,4)); g.setIndex(indices)
  const shade = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({
    color: '#172c26', vertexColors: true, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
  }), matrices.length)
  matrices.forEach((matrix,i) => shade.setMatrixAt(i,matrix))
  shade.raycast = () => {}
  return shade
}

/** Одна полоса за периметром. Вход — размеры, сид и открытое описание окрестностей. */
export function createDistantTerrain(map: Pick<TacticalMap, 'width' | 'height' | 'seed' | 'surroundings'>,
  biome: Biome, style: Exclude<BoardBackdropStyle, 'classic'>, detail: Detail, margin: number, drop: number,
  groundDetail?: { texture: THREE.Texture; cells: number }) {
  const { width, height } = map
  const atlas = style === 'atlas'
  const step = atlas ? (detail === 'minimal' ? 3.8 : 1.65) : detail === 'minimal' ? 5 : detail === 'reduced' ? 3 : 2
  const far = margin + 55
  const xSteps = Math.min(256, Math.ceil((width + 2 * far) / step)), zSteps = Math.min(256, Math.ceil((height + 2 * far) / step))
  const count = 2 * (xSteps + zSteps), rings = Math.ceil(far / step)
  const positions: number[] = [], colors: number[] = [], contours: number[] = [], indices: number[] = [], groves: number[] = []
  const palette = Object.fromEntries(Object.entries(PAINT).map(([k, [lo, hi, relief, wood]]) =>
    [k, { lo: new THREE.Color(lo), hi: new THREE.Color(hi), relief, wood }])) as Record<Biome, { lo: THREE.Color; hi: THREE.Color; relief: number; wood: number }>
  const sides = map.surroundings?.sides
  const side = (dir: 'w' | 'e' | 'n' | 's') => palette[sides?.[dir] as Biome] ?? palette[biome]
  let seed = 2166136261
  for (const char of String(map.seed ?? '')) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619)
  const sx = seed & 1023, sz = (seed >>> 12) & 1023
  const color = new THREE.Color(), high = new THREE.Color()
  const haze = new THREE.Color(atlas ? '#8c8c78' : '#789397')
  const paper = new THREE.Color('#bbac8d'), inkWash = new THREE.Color('#7c8878'), seaWash = new THREE.Color('#698b93')
  function vertex(x: number, z: number, distance: number) {
    const dx = Math.max(-x, x - width, 0), dz = Math.max(-z, z - height, 0)
    const blend = THREE.MathUtils.smoothstep(dz / (dx + dz), .08, .92)
    const westEast = side(x < 0 ? 'w' : 'e'), northSouth = side(z < 0 ? 'n' : 's')
    const relief = THREE.MathUtils.lerp(westEast.relief, northSouth.relief, blend)
    const ridge = 1 - Math.abs(2 * noise((x + sx) * .045 + .65 * noise(z * .1, sx), (z + sz) * .083) - 1)
    const broad = noise((x + sx) * .044, (z + sz) * .033)
    const fine = noise((x + sx) * .16, (z + sz) * .14)
    const form = .62 * broad + .32 * ridge * ridge + .13 * fine
    const ascent = THREE.MathUtils.smoothstep(distance, margin - 2, margin + 10)
    const crest = (form + .07 * (fine - .5)) * relief + .38 * Math.sin(.13 * x + .09 * z)
    const land = Math.min(1, relief / 2)
    const contour = form * (4 + relief) + .75 * noise(x * .14 + sx, z * .12)
    const y = -drop - .12 + (atlas ? -.08 : ascent * (crest - 1.3) * land)
    positions.push(x, y, z); contours.push(contour, land)
    const woods = THREE.MathUtils.lerp(westEast.wood, northSouth.wood, blend)
      * THREE.MathUtils.smoothstep(noise(x * .105 + sx, z * .085 + sz) + broad * .24, .43, .79)
      * THREE.MathUtils.smoothstep(distance, margin - 4, margin + 2) * (1 - THREE.MathUtils.smoothstep(distance, far - 30, far - 16))
    groves.push(woods)
    if (atlas) {
      color.copy(inkWash).lerp(paper, .30 + .60 * form).lerp(seaWash, 1 - land)
    } else {
      color.copy(westEast.lo).lerp(northSouth.lo, blend)
      high.copy(westEast.hi).lerp(northSouth.hi, blend)
      color.lerp(high, THREE.MathUtils.clamp(.02 + form * .93 - woods * .28, 0, 1))
    }
    color.lerp(haze, .58 * THREE.MathUtils.smoothstep(distance, margin + 4, far - 8))
    colors.push(color.r, color.g, color.b, 1 - THREE.MathUtils.smoothstep(distance, far - 18, far))
  }
  for (let ring = 0; ring <= rings; ring++) {
    const d = 1 + (far - 1) * ring / rings
    for (let i = 0; i < xSteps; i++) vertex(-d + (width + 2 * d) * i / xSteps, -d, d)
    for (let i = 0; i < zSteps; i++) vertex(width + d, -d + (height + 2 * d) * i / zSteps, d)
    for (let i = 0; i < xSteps; i++) vertex(width + d - (width + 2 * d) * i / xSteps, height + d, d)
    for (let i = 0; i < zSteps; i++) vertex(-d, height + d - (height + 2 * d) * i / zSteps, d)
    if (ring === rings) continue
    for (let i = 0; i < count; i++) {
      const a = ring * count + i, b = ring * count + (i + 1) % count
      indices.push(a, b, a + count, b, b + count, a + count)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  geometry.setAttribute('landform', new THREE.Float32BufferAttribute(contours, 2))
  geometry.setIndex(indices); geometry.computeVertexNormals()
  // Светотень дальних склонов запечена в цвет. Тёплый свет над миниатюрами
  // тогда не окрашивает в жёлтый воздушную дымку и бумагу атласа.
  if (!atlas) {
    const shade = geometry.getAttribute('color'), normal = geometry.getAttribute('normal')
    const sun = new THREE.Vector3(-.85, 1, .55).normalize(), n = new THREE.Vector3()
    for (let i = 0; i < shade.count; i++) {
      const light = .73 + .45 * n.fromBufferAttribute(normal, i).dot(sun)
      shade.setXYZ(i, shade.getX(i) * light, shade.getY(i) * light, shade.getZ(i) * light)
    }
  }
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })
  if (!atlas && groundDetail) {
    material.onBeforeCompile = shader => {
      shader.uniforms.fringeGrain = { value: groundDetail.texture }
      shader.uniforms.fringeTile = { value: 1 / Math.max(1, groundDetail.cells) }
      shader.vertexShader = 'attribute vec2 landform; varying vec3 vFringe;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFringe = vec3(position.xz,landform.y);')
      shader.fragmentShader = 'varying vec3 vFringe; uniform sampler2D fringeGrain; uniform float fringeTile;\n' + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 uv = vFringe.xy * fringeTile * .76;
        vec3 weights = vec3(.2126,.7152,.0722);
        float mean = max(.025,dot(texture2D(fringeGrain,vec2(.5),10.).rgb,weights));
        float brushed = dot(texture2D(fringeGrain,uv).rgb,weights)/mean;
        float wash = dot(texture2D(fringeGrain,uv*.21+vec2(.37,.16)).rgb,weights)/mean;
        float detail = mix(.62,1.33,clamp((.64*brushed+.36*wash)-.48,0.,1.));
        diffuseColor.rgb *= mix(1., detail, vFringe.z);
      `)
    }
  }
  if (atlas) {
    material.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute vec2 landform; varying vec2 vLandform; varying vec2 vPaper;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvLandform = landform; vPaper = position.xz;')
      shader.fragmentShader = 'varying vec2 vLandform; varying vec2 vPaper;\n' + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        float h = vLandform.x * 1.18 + .12*sin(vPaper.x*.44+sin(vPaper.y*.42));
        float width = max(.022, fwidth(h));
        float line = 1. - smoothstep(width * .20, width * 1.12, abs(fract(h + .5) - .5));
        float major = 1. - smoothstep(width * .20, width * .92, abs(fract(h / 4. + .5) - .5) * 4.);
        float grain = fract(sin(dot(floor(vPaper * 11.), vec2(37.31, 41.87))) * 1946.32);
        diffuseColor.rgb *= 1. + .043 * (grain - .5);
        diffuseColor.rgb *= 1. - (.19 * line + .22 * major) * smoothstep(0.,.8,vLandform.y) * (1.-smoothstep(.38,.95,width));
      `)
    }
  }
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = atlas ? 'surroundings-atlas' : 'surroundings-hills'
  mesh.renderOrder = -3
  mesh.raycast = () => {}
  if (!atlas) {
    // Семена группируются на склонах. Барицентрическая посадка сохраняет
    // контакт с землёй даже при грубой сетке на экономном качестве.
    const trees: THREE.Matrix4[] = [], shadows: THREE.Matrix4[] = [], tints: THREE.Color[] = []
    const object = new THREE.Object3D(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const up = new THREE.Vector3(0,1,0), normal = new THREE.Vector3(), edge = new THREE.Vector3()
    const position = geometry.getAttribute('position'), mistTint = new THREE.Color(1.03, 1.18, 1.30)
    let state = seed >>> 0
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
    const budget = detail === 'minimal' ? 260 : detail === 'reduced' ? 1500 : 2400
    const samples = budget * 4
    for (let i = 0; i < samples && trees.length < budget; i++) {
      const face = 3 * Math.floor(random() * (indices.length / 3))
      const ia = indices[face], ib = indices[face + 1], ic = indices[face + 2]
      if (random() > (groves[ia] + groves[ib] + groves[ic]) / 3) continue
      a.fromBufferAttribute(position, ia); b.fromBufferAttribute(position, ib); c.fromBufferAttribute(position, ic)
      const u = Math.sqrt(random()), v = random()
      object.position.copy(a).multiplyScalar(1 - u).addScaledVector(b, u * (1 - v)).addScaledVector(c, u * v)
      const size = 1.25 + random() * 2.1
      object.scale.set(size * (.78 + random() * .28), size, size)
      object.rotation.y = random() * Math.PI * 2
      object.updateMatrix(); trees.push(object.matrix.clone())
      const fog = THREE.MathUtils.smoothstep(Math.max(-object.position.x, object.position.x - width,
        -object.position.z, object.position.z - height), margin, far - 8)
      tints.push(new THREE.Color().setRGB(.94, 1, .89).lerp(mistTint, fog).multiplyScalar(.80 + random() * .34))
      normal.crossVectors(b.sub(a), edge.subVectors(c,a)).normalize()
      object.quaternion.setFromUnitVectors(up, normal)
      object.position.addScaledVector(normal,.027)
      object.updateMatrix(); shadows.push(object.matrix.clone())
    }
    if (trees.length) {
      const forest = new THREE.InstancedMesh(spruceGeometry(), new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide}), trees.length)
      forest.name = 'surroundings-distant-groves'
      for (let i=0; i<trees.length; i++) { forest.setMatrixAt(i, trees[i]); forest.setColorAt(i, tints[i]) }
      forest.renderOrder = -2; forest.raycast = () => {}
      mesh.add(forest)
      if (detail !== 'minimal') {
        const shade = createGroundShadows(shadows, 1)
        shade.name = 'surroundings-grove-shade'; shade.renderOrder = -2
        mesh.add(shade)
      }
    }
  }
  return mesh
}
