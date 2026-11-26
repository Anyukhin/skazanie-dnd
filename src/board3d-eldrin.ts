import * as THREE from 'three'

type Section = [x: number, y: number, z: number, radius: number]

/** Мелкие борозды и островки лишайника на коре. Край справа оставлен белым для листьев и глаз. */
export function eldrinBarkTexture(): THREE.DataTexture {
  const size = 256, pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    const phase = y / size * Math.PI * 2
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4
      const drift = 2.4 * Math.sin(phase + x * .047) + 1.3 * Math.cos(2 * phase - x * .11)
      const cut = Math.pow(.5 + .5 * Math.cos((x + drift) * .91 + .7 * Math.sin(x * .16)), 5)
      const fleck = .5 + .5 * Math.sin(47 * x + 13 * y) * Math.cos(3 * x - 29 * y)
      const moss = Math.max(0, Math.sin(x * .08 + 2 * Math.sin(phase)) * Math.cos(phase + x * .044) - .55) * fleck
      const tone = x >= size - 8 ? 255 : 242 - 68 * cut - 16 * fleck
      pixels[index] = tone
      pixels[index + 1] = Math.min(255, tone + moss * 49)
      pixels[index + 2] = tone - moss * 35
      pixels[index + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

/** Великое Древо на поляне. Лицо смотрит на юг, навстречу тропе к корням. */
export function eldrinOakGeometry(form: 'tree' | 'bust' = 'tree'): THREE.BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const color = new THREE.Color()
  const offset = new THREE.Vector3()
  const tau = 2 * Math.PI
  function vertex(x: number, y: number, z: number, pigment: THREE.Color, light = 1, u = .995, v = .5) {
    const index = positions.length / 3
    positions.push(x, y, z)
    colors.push(pigment.r * light, pigment.g * light, pigment.b * light)
    uvs.push(u, v)
    return index
  }

  // Радиусы меняются вдоль оси ветви. Продольные борозды продолжаются через
  // изгибы, поэтому основание корня плавно переходит в ствол и в скулы лица.
  function limb(sections: Section[], pigment: string, sides = 13, grooves = .12) {
    const curve = new THREE.CatmullRomCurve3(sections.map(([x, y, z]) => new THREE.Vector3(x, y, z)))
    const steps = (sections.length - 1) * 4
    const frames = curve.computeFrenetFrames(steps, false)
    const length = curve.getLength()
    const base = positions.length / 3
    color.set(pigment)
    for (let i = 0; i <= steps; i++) {
      const u = i / steps
      const t = curve.getUtoTmapping(u, u * length) * (sections.length - 1)
      const lower = Math.min(Math.floor(t), sections.length - 2)
      const radius = THREE.MathUtils.lerp(sections[lower][3], sections[lower + 1][3], t - lower)
      const center = curve.getPointAt(u)
      for (let j = 0; j < sides; j++) {
        const theta = j * tau / sides
        const ridge = Math.cos(7 * theta + u * 1.9) + .42 * Math.sin(3 * theta - u * 2.5)
        const r = radius * (1 + ridge * grooves)
        offset.copy(frames.normals[i]).multiplyScalar(Math.cos(theta) * r)
          .addScaledVector(frames.binormals[i], Math.sin(theta) * r)
        const grain = .09 * Math.sin(13 * theta + 1.5 * Math.sin(3 * u) + u) + .05 * Math.cos(5 * theta - 2 * u)
        const barkU = grooves ? .48 + Math.cos(theta) * Math.min(.46, .82 * radius) : .995
        vertex(center.x + offset.x, center.y + offset.y, center.z + offset.z, color, .88 + ridge * grooves + grain, barkU, u * length)
        if (i < steps) {
          const a = base + i * sides + j
          const b = base + i * sides + (j + 1) % sides
          indices.push(a, b, a + sides, b, b + sides, a + sides)
        }
      }
    }
  }

  const bark = '#68503c', ridge = '#7d6347', hollow = '#2c241f', gold = '#dfad52'
  const crowns: THREE.Vector3[] = []
  if (form === 'bust') {
    // У фишки собственный замкнутый силуэт. Лицо и кора те же, что у дерева.
    limb([[0, .68, 0, .01], [0, .79, .03, .24], [-.02, 1.06, .01, .37],
      [-.06, 1.35, 0, .42], [.02, 1.98, -.03, .46], [-.02, 2.21, -.06, .39],
      [.04, 2.33, -.08, .21], [.08, 2.37, -.1, .002]], bark, 36)
  } else {
    limb([[0, .02, 0, .53], [.05, .5, -.02, .46], [-.06, 1.35, 0, .42],
      [.04, 2.02, -.03, .47], [-.08, 2.75, -.04, .37], [.06, 3.42, -.1, .24], [0, 3.96, -.06, .025]], bark, 36)
    for (let i = 0; i < 9; i++) {
      const angle = i * tau / 9 + .16 * Math.sin(i)
      const x = Math.cos(angle), z = Math.sin(angle)
      const reach = 1.34 + .17 * Math.cos(i * 2)
      limb([[x * .29, .93 + .12 * z, z * .29, .22], [x * .52, .33, z * .5, .2],
        [x * .97, .15, z * .9, .115], [x * reach, .055, z * reach, .045],
        [x * reach - z * .23, .026, z * reach + x * .23, .012]], bark)
      const height = 3.18 + .27 * Math.cos(i * 2.8)
      limb([[x * .16, 2.05 + .22 * z, z * .16, .28], [x * .46, 2.56, z * .43, .23],
        [x * .91 - z * .12, height - .28, z * .88, .15],
        [x * 1.22, height, z * 1.1, .094], [x * 1.42, height + .34, z * 1.31, .024]], bark, 18)
      for (const side of [-1, 1]) {
        const tip = new THREE.Vector3(x * 1.13 - side * z * .33, height + .43 + .1 * side, z * 1.05 + side * x * .33)
        limb([[x * .79, height - .34, z * .74, .1], [x * .98 - side * z * .19, height + .07, z * .91 + side * x * .15, .065],
          [tip.x, tip.y, tip.z, .012]], i % 3 ? ridge : '#777145', 10)
        crowns.push(tip)
      }
    }
    crowns.push(new THREE.Vector3(-.35, 4.01, -.12), new THREE.Vector3(.23, 4.14, .08))
  }

  // Лоб, веки и нос вырастают из наплывов коры. Подбородок распадается на
  // тонкие корни; золотые прожилки идут по трещинам у висков.
  for (const side of [-1, 1]) {
    const s = side
    limb([[s * .043, 1.85, .39, .057], [s * .15, 1.84, .456, .084], [s * .29, 1.89, .38, .065], [s * .39, 2.06, .2, .015]], ridge)
    limb([[s * .063, 1.71, .425, .026], [s * .179, 1.73, .466, .052], [s * .29, 1.79, .396, .022]], hollow)
    limb([[s * .12, 1.744, .495, .006], [s * .177, 1.756, .502, .022], [s * .225, 1.768, .467, .006]], gold, 9)
    limb([[s * .09, 1.66, .444, .026], [s * .21, 1.675, .448, .038], [s * .34, 1.78, .31, .025]], ridge)
    limb([[s * .33, 1.68, .31, .075], [s * .23, 1.48, .395, .08], [s * .25, 1.24, .34, .061], [s * .14, .87, .39, .024]], ridge)
    limb([[s * .29, 1.90, .41, .012], [s * .34, 2.02, .36, .018], [s * .31, 2.13, .38, .012], [s * .39, 2.27, .30, .004]], gold, 8, 0)
    for (let i = 0; i < 3; i++) {
      const x = .23 + .039 * i
      limb([[s * .15, 1.63 - i * .038, .398, .006], [s * x, 1.627 - i * .058, .425 - .014 * i, .015],
        [s * (x + .05), 1.67 - i * .043, .375 - .01 * i, .004]], bark, 8)
    }
  }
  limb([[0, 1.84, .39, .071], [-.02, 1.68, .456, .084], [-.027, 1.48, .526, .107], [.03, 1.465, .50, .038]], ridge, 18)
  limb([[-.18, 1.30, .378, .013], [-.07, 1.32, .432, .025], [.045, 1.315, .447, .03], [.17, 1.33, .39, .013]], hollow)
  for (let i = -2; i <= 2; i++) {
    const x = i * .062
    limb([[x, 1.26, .4 - x * x, .058], [x * .91, 1.09, .45 - x * x, .05],
      [x * .78 - .026, .89, .427, .032], [x - .045, .67 + Math.abs(x), .365, .004]], ridge, 10)
  }

  // Плотные шапки имеют нерегулярный край: каждая розетка собрана из
  // перекрывающихся, чуть согнутых листьев с собственной средней жилкой.
  const leafTones = ['#384e32', '#526842', '#697a48', '#728150', '#889052'].map(tone => new THREE.Color(tone))
  let seed = 44983
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (const cluster of crowns) {
    for (let spray = 0; spray < 112; spray++) {
      const a = random() * tau
      const elevation = random() * 2 - 1
      const spread = Math.sqrt(1 - elevation * elevation) * (.65 + random() * .35)
      const cx = cluster.x + Math.cos(a) * spread * .58
      const cy = cluster.y + elevation * .43
      const cz = cluster.z + Math.sin(a) * spread * .55
      const tone = leafTones[Math.min(4, Math.floor((elevation + 1) * 1.35 + random() * 2))]
      for (let leaf = 0; leaf < 3; leaf++) {
        const heading = a + leaf * 2.09 + random() * .35
        const x = Math.cos(heading), z = Math.sin(heading)
        const length = .095 + random() * .11, width = length * .37
        const middle = length * .54
        const a0 = vertex(cx, cy, cz, tone, .78)
        vertex(cx + x * middle - z * width, cy + .012, cz + z * middle + x * width, tone)
        vertex(cx + x * middle, cy + .044, cz + z * middle, tone, 1.12)
        vertex(cx + x * middle + z * width, cy + .012, cz + z * middle - x * width, tone)
        vertex(cx + x * length, cy - .025, cz + z * length, tone)
        indices.push(a0, a0 + 1, a0 + 2, a0, a0 + 2, a0 + 3, a0 + 1, a0 + 4, a0 + 2, a0 + 2, a0 + 4, a0 + 3)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}
