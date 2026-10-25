import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Material,
  Matrix3,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  RepeatWrapping,
  SkinnedMesh,
  SRGBColorSpace,
  Vector3,
} from 'three'

/**
 * Доспех как оболочка по телу фигурки.
 *
 * Прежде доспех собирался из коробок, растянутых по габаритам частей тела:
 * кольчуга выходила прозрачной клеткой, латы — кубиками. Здесь берётся
 * собственная одежда и кожа модели, выбираются треугольники закрытых доспехом
 * частей, вершины чуть сдвигаются по нормали, и на них ложится материал брони.
 * Оболочка — тот же SkinnedMesh на том же скелете, поэтому она повторяет и
 * силуэт, и любую анимацию без отдельной подгонки.
 */

export type ArmorShellKind =
  | 'padded' | 'leather' | 'studded' | 'hide'
  | 'chain' | 'ring' | 'scale' | 'splint' | 'plate'

export type ArmorRegion = 'chest' | 'waist' | 'upper-arms' | 'forearms' | 'thighs' | 'shins' | 'shoulders'

export type ArmorShellLayer = {
  kind: ArmorShellKind
  regions: ArmorRegion[]
  /** Сдвиг поверх тела в долях роста фигурки. */
  offset: number
}

export type ArmorShellSpec = { layers: ArmorShellLayer[] }

/** Какой материал и какие части закрывает каждый доспех каталога. */
export const ARMOR_SHELLS: Record<string, ArmorShellSpec> = {
  'armor-padded': { layers: [{ kind: 'padded', regions: ['chest', 'waist', 'upper-arms'], offset: .006 }] },
  'armor-leather': { layers: [{ kind: 'leather', regions: ['chest', 'waist'], offset: .005 }] },
  'armor-studded': { layers: [{ kind: 'studded', regions: ['chest', 'waist', 'upper-arms'], offset: .005 }] },
  'armor-hide': { layers: [{ kind: 'hide', regions: ['chest', 'waist', 'upper-arms', 'thighs'], offset: .009 }] },
  'armor-chainshirt': { layers: [{ kind: 'chain', regions: ['chest', 'waist', 'upper-arms'], offset: .005 }] },
  'armor-ringmail': { layers: [{ kind: 'ring', regions: ['chest', 'waist', 'upper-arms', 'thighs'], offset: .006 }] },
  'armor-scalemail': { layers: [{ kind: 'scale', regions: ['chest', 'waist', 'upper-arms', 'thighs'], offset: .007 }] },
  'armor-chainmail': { layers: [{ kind: 'chain', regions: ['chest', 'waist', 'upper-arms', 'forearms', 'thighs'], offset: .005 }] },
  'armor-breastplate': { layers: [{ kind: 'plate', regions: ['chest', 'waist'], offset: .008 }] },
  'armor-halfplate': { layers: [
    { kind: 'chain', regions: ['upper-arms', 'thighs'], offset: .005 },
    { kind: 'plate', regions: ['chest', 'waist'], offset: .009 },
    { kind: 'plate', regions: ['shoulders'], offset: .02 },
  ] },
  'armor-splint': { layers: [
    { kind: 'splint', regions: ['chest', 'waist', 'upper-arms', 'forearms', 'thighs', 'shins'], offset: .008 },
    { kind: 'plate', regions: ['shoulders'], offset: .02 },
  ] },
  'armor-plate': { layers: [
    { kind: 'plate', regions: ['chest', 'waist', 'upper-arms', 'forearms', 'thighs', 'shins'], offset: .009 },
    { kind: 'plate', regions: ['shoulders'], offset: .022 },
  ] },
}

const REGION_BONES: Record<ArmorRegion, string[]> = {
  chest: ['spine', 'chest', 'torso', 'abdomen', 'claviclel', 'clavicler'],
  waist: ['pelvis', 'hips'],
  'upper-arms': ['upperarml', 'upperarmr', 'claviclel', 'clavicler', 'shoulderl', 'shoulderr'],
  forearms: ['lowerarml', 'lowerarmr', 'forearml', 'forearmr'],
  thighs: ['thighl', 'thighr', 'upperlegl', 'upperlegr'],
  shins: ['calfl', 'calfr', 'lowerlegl', 'lowerlegr'],
  shoulders: ['claviclel', 'clavicler', 'upperarml', 'upperarmr', 'shoulderl', 'shoulderr'],
}

const SKIP_MESH = /face|eye|brow|hair|beard|teeth|jaw|head|hand|feet|foot|boot/iu

function normalizedName(value: string): string {
  return value.replace(/[^a-z0-9]/giu, '').toLocaleLowerCase('en-US')
}

function tokenMatches(name: string, tokens: string[]): boolean {
  const value = normalizedName(name)
  return tokens.some((token) => value === token || value.startsWith(token) || value.endsWith(token))
}

type Pattern = { map: CanvasTexture; bump: CanvasTexture; color: string; metalness: number; roughness: number; bumpScale: number; repeatsPerUnit: number }
const patterns = new Map<ArmorShellKind, Pattern | null>()

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === 'undefined') return null
  const element = document.createElement('canvas')
  element.width = size; element.height = size
  const context = element.getContext('2d')
  return context ? [element, context] : null
}

/** Детерминированный шум: одинаковая фактура у всех героев и на каждом кадре. */
function noise(seed: number) {
  let value = seed >>> 0
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296 }
}

function texture(element: HTMLCanvasElement, srgb: boolean): CanvasTexture {
  const result = new CanvasTexture(element)
  result.wrapS = RepeatWrapping; result.wrapT = RepeatWrapping
  if (srgb) result.colorSpace = SRGBColorSpace
  result.anisotropy = 4
  return result
}

function drawPattern(kind: ArmorShellKind): Pattern | null {
  const size = 256
  const colorCanvas = canvas(size)
  const bumpCanvas = canvas(size)
  if (!colorCanvas || !bumpCanvas) return null
  const [colorElement, c] = colorCanvas
  const [bumpElement, b] = bumpCanvas
  const random = noise(kind.length * 7919 + kind.charCodeAt(0))
  const fill = (context: CanvasRenderingContext2D, value: string) => { context.fillStyle = value; context.fillRect(0, 0, size, size) }
  if (kind === 'chain' || kind === 'ring') {
    const ring = kind === 'chain'
    fill(c, '#2a2c2e'); fill(b, '#000')
    const cell = ring ? 32 : 42
    for (let row = -1; row <= size / (cell * .5) + 1; row += 1) {
      for (let col = -1; col <= size / cell + 1; col += 1) {
        const x = col * cell + (row % 2 ? cell / 2 : 0)
        const y = row * cell * .5
        c.lineWidth = ring ? 6 : 9; b.lineWidth = ring ? 6 : 9
        c.strokeStyle = ring ? '#a3a8ad' : '#8d8f8a'; b.strokeStyle = '#fff'
        c.beginPath(); c.ellipse(x, y, cell * .42, cell * .34, 0, 0, Math.PI * 2); c.stroke()
        b.beginPath(); b.ellipse(x, y, cell * .42, cell * .34, 0, 0, Math.PI * 2); b.stroke()
        c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 2
        c.beginPath(); c.ellipse(x - 2, y - 2, cell * .4, cell * .3, 0, Math.PI * 1.05, Math.PI * 1.6); c.stroke()
      }
    }
    return { map: texture(colorElement, true), bump: texture(bumpElement, false), color: '#ffffff', metalness: .72, roughness: .42, bumpScale: 2.2, repeatsPerUnit: ring ? 9 : 6 }
  }
  if (kind === 'scale') {
    fill(c, '#3a3428'); fill(b, '#000')
    const cell = 32
    for (let row = -1; row <= size / (cell * .55) + 1; row += 1) {
      for (let col = -1; col <= size / cell + 1; col += 1) {
        const x = col * cell + (row % 2 ? cell / 2 : 0)
        const y = row * cell * .55
        const gradient = c.createLinearGradient(x, y - cell * .2, x, y + cell * .55)
        gradient.addColorStop(0, '#d0b37a'); gradient.addColorStop(.55, '#8f7447'); gradient.addColorStop(1, '#4a3b25')
        c.fillStyle = gradient
        c.beginPath(); c.moveTo(x - cell / 2, y); c.quadraticCurveTo(x - cell / 2, y + cell * .62, x, y + cell * .62); c.quadraticCurveTo(x + cell / 2, y + cell * .62, x + cell / 2, y); c.closePath(); c.fill()
        c.strokeStyle = '#2b2215'; c.lineWidth = 2; c.stroke()
        const bump = b.createLinearGradient(x, y, x, y + cell * .62)
        bump.addColorStop(0, '#333'); bump.addColorStop(.7, '#fff'); bump.addColorStop(1, '#888')
        b.fillStyle = bump
        b.beginPath(); b.moveTo(x - cell / 2, y); b.quadraticCurveTo(x - cell / 2, y + cell * .62, x, y + cell * .62); b.quadraticCurveTo(x + cell / 2, y + cell * .62, x + cell / 2, y); b.closePath(); b.fill()
      }
    }
    return { map: texture(colorElement, true), bump: texture(bumpElement, false), color: '#ffffff', metalness: .62, roughness: .4, bumpScale: 2.6, repeatsPerUnit: 7 }
  }
  if (kind === 'leather' || kind === 'studded') {
    fill(c, '#5a3a22'); fill(b, '#777')
    for (let index = 0; index < 2600; index += 1) {
      const x = random() * size; const y = random() * size; const shade = random()
      c.fillStyle = shade > .5 ? 'rgba(120,80,48,.18)' : 'rgba(30,18,10,.2)'
      c.fillRect(x, y, 2 + random() * 5, 1 + random() * 2)
      b.fillStyle = shade > .5 ? 'rgba(255,255,255,.15)' : 'rgba(0,0,0,.15)'
      b.fillRect(x, y, 2 + random() * 5, 1 + random() * 2)
    }
    c.setLineDash([7, 5]); c.strokeStyle = 'rgba(214,176,120,.55)'; c.lineWidth = 2
    for (const y of [24, 152]) { c.beginPath(); c.moveTo(0, y); c.lineTo(size, y); c.stroke() }
    c.setLineDash([])
    b.fillStyle = '#333'; for (const y of [20, 148]) b.fillRect(0, y, size, 3)
    if (kind === 'studded') {
      for (let row = 0; row < 4; row += 1) for (let col = 0; col < 4; col += 1) {
        const x = col * 64 + (row % 2 ? 32 : 0) + 16; const y = row * 64 + 44
        const gradient = c.createRadialGradient(x - 2, y - 2, 1, x, y, 7)
        gradient.addColorStop(0, '#f2e6c8'); gradient.addColorStop(.6, '#9b8c6c'); gradient.addColorStop(1, '#3c3426')
        c.fillStyle = gradient; c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.fill()
        const bump = b.createRadialGradient(x, y, 0, x, y, 8)
        bump.addColorStop(0, '#fff'); bump.addColorStop(1, '#777')
        b.fillStyle = bump; b.beginPath(); b.arc(x, y, 8, 0, Math.PI * 2); b.fill()
      }
    }
    return { map: texture(colorElement, true), bump: texture(bumpElement, false), color: '#ffffff', metalness: kind === 'studded' ? .15 : .02, roughness: .72, bumpScale: 1.4, repeatsPerUnit: 3 }
  }
  if (kind === 'padded') {
    fill(c, '#8a7552'); fill(b, '#000')
    const cell = 64
    for (let row = -1; row <= size / cell + 1; row += 1) for (let col = -1; col <= size / cell + 1; col += 1) {
      const x = col * cell + (row % 2 ? cell / 2 : 0); const y = row * cell / 2
      const gradient = b.createRadialGradient(x, y, 2, x, y, cell * .5)
      gradient.addColorStop(0, '#fff'); gradient.addColorStop(1, '#000')
      b.fillStyle = gradient
      b.beginPath(); b.moveTo(x, y - cell / 2); b.lineTo(x + cell / 2, y); b.lineTo(x, y + cell / 2); b.lineTo(x - cell / 2, y); b.closePath(); b.fill()
      const shade = c.createRadialGradient(x - 6, y - 6, 2, x, y, cell * .5)
      shade.addColorStop(0, '#b29b72'); shade.addColorStop(1, '#6c5a3d')
      c.fillStyle = shade
      c.beginPath(); c.moveTo(x, y - cell / 2); c.lineTo(x + cell / 2, y); c.lineTo(x, y + cell / 2); c.lineTo(x - cell / 2, y); c.closePath(); c.fill()
      c.strokeStyle = '#4a3b26'; c.lineWidth = 2; c.stroke()
    }
    return { map: texture(colorElement, true), bump: texture(bumpElement, false), color: '#ffffff', metalness: 0, roughness: .9, bumpScale: 2, repeatsPerUnit: 4 }
  }
  if (kind === 'hide') {
    fill(c, '#5b4630'); fill(b, '#444')
    for (let index = 0; index < 5200; index += 1) {
      const x = random() * size; const y = random() * size; const length = 5 + random() * 10; const tone = random()
      c.strokeStyle = tone > .66 ? 'rgba(170,138,96,.55)' : tone > .33 ? 'rgba(96,72,46,.55)' : 'rgba(40,28,18,.5)'
      c.lineWidth = 1.4
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (random() - .5) * 4, y + length); c.stroke()
      b.strokeStyle = tone > .5 ? 'rgba(255,255,255,.4)' : 'rgba(0,0,0,.4)'
      b.beginPath(); b.moveTo(x, y); b.lineTo(x + (random() - .5) * 4, y + length); b.stroke()
    }
    return { map: texture(colorElement, true), bump: texture(bumpElement, false), color: '#ffffff', metalness: 0, roughness: .95, bumpScale: 2.4, repeatsPerUnit: 4 }
  }
  if (kind === 'splint') {
    fill(c, '#4a3322'); fill(b, '#000')
    for (let col = 0; col < 8; col += 1) {
      const x = col * 32 + 4
      const gradient = c.createLinearGradient(x, 0, x + 24, 0)
      gradient.addColorStop(0, '#5e6266'); gradient.addColorStop(.4, '#c3c8cc'); gradient.addColorStop(1, '#4b4f53')
      c.fillStyle = gradient; c.fillRect(x, 0, 24, size)
      const bump = b.createLinearGradient(x, 0, x + 24, 0)
      bump.addColorStop(0, '#444'); bump.addColorStop(.5, '#fff'); bump.addColorStop(1, '#444')
      b.fillStyle = bump; b.fillRect(x, 0, 24, size)
      c.fillStyle = '#d8c9a0'; for (const y of [30, 158]) { c.beginPath(); c.arc(x + 12, y, 3, 0, Math.PI * 2); c.fill() }
    }
    return { map: texture(colorElement, true), bump: texture(bumpElement, false), color: '#ffffff', metalness: .55, roughness: .45, bumpScale: 2, repeatsPerUnit: 4 }
  }
  // Латы: гладкая сталь с поперечными пластинами и заклёпками по краю.
  const gradient = c.createLinearGradient(0, 0, 0, size)
  gradient.addColorStop(0, '#c9ced3'); gradient.addColorStop(.5, '#9aa0a6'); gradient.addColorStop(1, '#c4c9ce')
  c.fillStyle = gradient; c.fillRect(0, 0, size, size)
  fill(b, '#bbb')
  for (const y of [0, 128]) {
    c.fillStyle = 'rgba(30,32,36,.65)'; c.fillRect(0, y, size, 4)
    c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(0, y + 4, size, 2)
    b.fillStyle = '#000'; b.fillRect(0, y, size, 5)
    for (let x = 16; x < size; x += 64) {
      c.fillStyle = '#e8dcc0'; c.beginPath(); c.arc(x, y + 12, 3.2, 0, Math.PI * 2); c.fill()
      b.fillStyle = '#fff'; b.beginPath(); b.arc(x, y + 12, 3.5, 0, Math.PI * 2); b.fill()
    }
  }
  return { map: texture(colorElement, true), bump: texture(bumpElement, false), color: '#ffffff', metalness: .82, roughness: .3, bumpScale: 1.6, repeatsPerUnit: 2.5 }
}

function patternFor(kind: ArmorShellKind): Pattern | null {
  if (!patterns.has(kind)) patterns.set(kind, drawPattern(kind))
  return patterns.get(kind) ?? null
}

const FALLBACK_COLORS: Record<ArmorShellKind, string> = {
  padded: '#8a7552', leather: '#5a3a22', studded: '#5a3a22', hide: '#5b4630',
  chain: '#8d9196', ring: '#86887f', scale: '#9a7f50', splint: '#7c8186', plate: '#b4b9bf',
}

export function armorShellMaterial(kind: ArmorShellKind): MeshStandardMaterial {
  const pattern = patternFor(kind)
  const material = new MeshStandardMaterial({
    name: `armor-shell-${kind}`,
    color: new Color(pattern?.color ?? FALLBACK_COLORS[kind]),
    metalness: pattern?.metalness ?? (kind === 'plate' || kind === 'chain' ? .7 : .1),
    roughness: pattern?.roughness ?? .6,
    map: pattern?.map ?? null,
    bumpMap: pattern?.bump ?? null,
    bumpScale: pattern?.bumpScale ?? 1,
  })
  material.userData.equipmentShell = true
  return material
}

function regionWeight(mesh: SkinnedMesh, index: number, tokens: string[]): number {
  const indices = mesh.geometry.getAttribute('skinIndex')
  const weights = mesh.geometry.getAttribute('skinWeight')
  if (!indices || !weights) return 0
  let value = 0
  for (let slot = 0; slot < Math.min(4, indices.itemSize, weights.itemSize); slot += 1) {
    const bone = mesh.skeleton?.bones[indices.getComponent(index, slot)]
    if (bone && tokenMatches(bone.name, tokens)) value += weights.getComponent(index, slot)
  }
  return value
}

/** Масштаб «единица геометрии → мир» по рёбрам треугольников в текущей позе. */
function bindToWorldScale(mesh: SkinnedMesh): number {
  const position = mesh.geometry.getAttribute('position')
  const index = mesh.geometry.index
  const triangles = Math.floor((index ? index.count : position.count) / 3)
  const a = new Vector3(); const b = new Vector3(); const wa = new Vector3(); const wb = new Vector3()
  let sum = 0; let count = 0
  const step = Math.max(1, Math.floor(triangles / 64))
  for (let triangle = 0; triangle < triangles; triangle += step) {
    const i0 = index ? index.getX(triangle * 3) : triangle * 3
    const i1 = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1
    a.fromBufferAttribute(position, i0); b.fromBufferAttribute(position, i1)
    const bindLength = a.distanceTo(b)
    if (bindLength < 1e-9) continue
    mesh.getVertexPosition(i0, wa); mesh.localToWorld(wa)
    mesh.getVertexPosition(i1, wb); mesh.localToWorld(wb)
    sum += wa.distanceTo(wb) / bindLength; count += 1
  }
  return count ? sum / count : 1
}

/**
 * Вес наплечника у вершины: плавно спадает от плечевого сустава, поэтому край
 * наплечника — дуга, а не ступеньки треугольников.
 */
function shoulderWeight(mesh: SkinnedMesh, height: number): ((index: number) => number) | null {
  const joints: Vector3[] = []
  mesh.skeleton?.bones.forEach((bone) => {
    if (/^upperarm[lr]$/u.test(normalizedName(bone.name))) joints.push(bone.getWorldPosition(new Vector3()))
  })
  if (!joints.length) return null
  const radius = height * .09
  const vertex = new Vector3()
  return (index) => {
    mesh.getVertexPosition(index, vertex); mesh.localToWorld(vertex)
    let best = 0
    for (const joint of joints) {
      if (vertex.y < joint.y - radius * .4) continue
      best = Math.max(best, Math.min(1, Math.max(0, (radius - joint.distanceTo(vertex)) / (radius * .35))))
    }
    return best
  }
}

type ShellVertex = { p: Vector3; n: Vector3; index: number[]; weight: number[]; w: number }

/**
 * Строит оболочки одного слоя доспеха на всех подходящих SkinnedMesh фигурки.
 *
 * Край оболочки проходит по линии уровня веса закрытых костей: треугольник,
 * который пересекает границу, режется по ней, а не выбрасывается целиком —
 * иначе подол и рукава выходили ступенчатыми. Узор кладётся в координатах
 * главной кости вершины: полосы шин и чешуя идут вдоль руки и ноги, а не
 * поперёк, как при проекции по осям всей фигурки.
 * Возвращает созданные меши: владелец добавляет их в сцену и освобождает.
 */
export function buildArmorShellLayer(root: Object3D, layer: ArmorShellLayer, height: number, material: Material): SkinnedMesh[] {
  const tokens = [...new Set(layer.regions.flatMap((region) => REGION_BONES[region]))]
  const threshold = .42
  const sources: SkinnedMesh[] = []
  root.traverse((object) => {
    if (!(object instanceof SkinnedMesh) || !object.skeleton) return
    if (object.userData.equipmentShell || object.userData.equipmentCoverageClone) return
    if (SKIP_MESH.test(object.name)) return
    sources.push(object)
  })
  const result: SkinnedMesh[] = []
  const pattern = patternFor(layer.kind)
  const repeatsPerWorld = (pattern?.repeatsPerUnit ?? 4) / Math.max(.25, height / 1.4)
  for (const source of sources) {
    const geometry = source.geometry
    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    const skinIndex = geometry.getAttribute('skinIndex')
    const skinWeight = geometry.getAttribute('skinWeight')
    const skeleton = source.skeleton
    if (!position || !normal || !skinIndex || !skinWeight || !skeleton) continue
    const index = geometry.index
    const total = index ? index.count : position.count
    const scale = bindToWorldScale(source)
    const offset = layer.offset * height / Math.max(1e-6, scale)
    const shoulders = layer.regions.includes('shoulders') ? shoulderWeight(source, height) : null
    // Из геометрии в пространство кости: boneInverse · bindMatrix. Масштаб
    // кости в мире переводит узор в метры фигурки, какими бы ни были единицы рига.
    const boneSpace = new Map<number, { matrix: Matrix4; normalMatrix: Matrix3; repeats: number }>()
    const boneFrame = (bone: number) => {
      let frame = boneSpace.get(bone)
      if (!frame) {
        const inverse = skeleton.boneInverses[bone] ?? new Matrix4()
        const matrix = inverse.clone().multiply(source.bindMatrix)
        const worldScale = skeleton.bones[bone]?.getWorldScale(new Vector3()) ?? new Vector3(1, 1, 1)
        frame = { matrix, normalMatrix: new Matrix3().getNormalMatrix(matrix), repeats: repeatsPerWorld * (worldScale.x + worldScale.y + worldScale.z) / 3 }
        boneSpace.set(bone, frame)
      }
      return frame
    }
    const cache = new Map<number, ShellVertex>()
    const vertexAt = (id: number): ShellVertex => {
      let vertex = cache.get(id)
      if (!vertex) {
        const slots = Math.min(4, skinIndex.itemSize, skinWeight.itemSize)
        const ids: number[] = []; const weights: number[] = []
        for (let slot = 0; slot < 4; slot += 1) {
          ids.push(slot < slots ? skinIndex.getComponent(id, slot) : 0)
          weights.push(slot < slots ? skinWeight.getComponent(id, slot) : 0)
        }
        let w = regionWeight(source, id, tokens)
        if (shoulders) w *= shoulders(id)
        vertex = { p: new Vector3().fromBufferAttribute(position, id), n: new Vector3().fromBufferAttribute(normal, id).normalize(), index: ids, weight: weights, w }
        cache.set(id, vertex)
      }
      return vertex
    }
    const between = (a: ShellVertex, b: ShellVertex): ShellVertex => {
      const span = b.w - a.w
      const share = Math.abs(span) < 1e-6 ? .5 : (threshold - a.w) / span
      const inside = a.w >= threshold ? a : b
      return {
        p: a.p.clone().lerp(b.p, share),
        n: a.n.clone().lerp(b.n, share).normalize(),
        index: inside.index, weight: inside.weight, w: threshold,
      }
    }
    const positions: number[] = []; const normals: number[] = []; const uvs: number[] = []
    const skinIndices: number[] = []; const skinWeights: number[] = []
    const q = [new Vector3(), new Vector3(), new Vector3()]
    const faceNormal = new Vector3()
    const emit = (triangle: ShellVertex[]) => {
      // Главная кость треугольника — с наибольшим весом в его вершинах.
      const votes = new Map<number, number>()
      for (const vertex of triangle) vertex.index.forEach((bone, slot) => votes.set(bone, (votes.get(bone) ?? 0) + vertex.weight[slot]))
      const bone = [...votes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 0
      const frame = boneFrame(bone)
      triangle.forEach((vertex, corner) => q[corner].copy(vertex.p).addScaledVector(vertex.n, offset).applyMatrix4(frame.matrix))
      faceNormal.copy(q[1]).sub(q[0]).cross(q[2].clone().sub(q[0]))
      const ax = Math.abs(faceNormal.x); const ay = Math.abs(faceNormal.y); const az = Math.abs(faceNormal.z)
      triangle.forEach((vertex, corner) => {
        const p = vertex.p.clone().addScaledVector(vertex.n, offset)
        positions.push(p.x, p.y, p.z); normals.push(vertex.n.x, vertex.n.y, vertex.n.z)
        const u = q[corner]
        if (ax >= ay && ax >= az) uvs.push(u.z * frame.repeats, u.y * frame.repeats)
        else if (ay >= az) uvs.push(u.x * frame.repeats, u.z * frame.repeats)
        else uvs.push(u.x * frame.repeats, u.y * frame.repeats)
        skinIndices.push(...vertex.index); skinWeights.push(...vertex.weight)
      })
    }
    for (let corner = 0; corner + 2 < total; corner += 3) {
      const triangle = [0, 1, 2].map((step) => vertexAt(index ? index.getX(corner + step) : corner + step))
      const inside = triangle.filter((vertex) => vertex.w >= threshold).length
      if (!inside) continue
      if (inside === 3) { emit(triangle); continue }
      // Отсечение по границе закрытой области (Сазерленд — Ходжмен для одной плоскости).
      const polygon: ShellVertex[] = []
      for (let step = 0; step < 3; step += 1) {
        const a = triangle[step]; const b = triangle[(step + 1) % 3]
        if (a.w >= threshold) polygon.push(a)
        if ((a.w >= threshold) !== (b.w >= threshold)) polygon.push(between(a, b))
      }
      for (let fan = 1; fan + 1 < polygon.length; fan += 1) emit([polygon[0], polygon[fan], polygon[fan + 1]])
    }
    if (!positions.length) continue
    const shellGeometry = new BufferGeometry()
    shellGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    shellGeometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
    shellGeometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
    shellGeometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(skinIndices), 4))
    shellGeometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeights, 4))
    shellGeometry.computeBoundingBox(); shellGeometry.computeBoundingSphere()
    const shell = new SkinnedMesh(shellGeometry, material)
    shell.name = `${source.name}:armor-${layer.kind}`
    shell.position.copy(source.position); shell.quaternion.copy(source.quaternion); shell.scale.copy(source.scale)
    shell.castShadow = true; shell.receiveShadow = true
    shell.frustumCulled = false
    shell.bind(skeleton, source.bindMatrix)
    shell.userData = { equipmentShell: true, shellSource: source }
    result.push(shell)
  }
  return result
}

export type CapeFrame = { center: Vector3; quaternion: Quaternion; size: Vector3 }

/**
 * Плащ — изогнутое полотно от плеч до колен за спиной. Строится в мировых
 * координатах позы калибровки; крепит его к кости груди сам rig.
 */
export function buildCapeGeometry(chest: CapeFrame, height: number): BufferGeometry {
  const rows = 10; const cols = 18
  const top = chest.center.y + chest.size.y * .38
  const bottom = Math.max(height * .24, chest.center.y - height * .43)
  const halfWidthTop = chest.size.x * .5 + height * .018
  const halfDepthTop = chest.size.z * .5 + height * .012
  const positions: number[] = []; const uvs: number[] = []; const colors: number[] = []; const indices: number[] = []
  const local = new Vector3()
  for (let row = 0; row <= rows; row += 1) {
    const t = row / rows
    const flare = 1 + t * .4
    const y = top + (bottom - top) * t
    for (let col = 0; col <= cols; col += 1) {
      const s = col / cols
      const theta = Math.PI - 1.75 + s * 3.5
      // Складки нарастают к подолу; у плеч полотно лежит гладко.
      const wave = Math.sin(s * Math.PI * 9)
      const fold = 1 + wave * .06 * Math.min(1, t * 1.6)
      // У плеч края полотна опускаются по скату плеча, середина держится у шеи.
      const side = (theta - Math.PI) / 1.75
      const slope = height * .045 * side * side * (1 - t)
      local.set(Math.sin(theta) * halfWidthTop * flare * fold, y - chest.center.y - slope, Math.cos(theta) * halfDepthTop * (1 + t * t * .75) * fold)
      const shade = .72 + .28 * (wave * .5 + .5) * Math.min(1, t * 1.6) + .28 * (1 - Math.min(1, t * 1.6))
      colors.push(shade, shade, shade)
      local.applyQuaternion(chest.quaternion)
      positions.push(chest.center.x + local.x, chest.center.y + local.y, chest.center.z + local.z)
      uvs.push(s, 1 - t)
    }
  }
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    const a = row * (cols + 1) + col; const b = a + 1; const c = a + cols + 1; const d = c + 1
    indices.push(a, c, b, b, c, d)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** Сукно плаща: зачарованный — густо-синий, обычный — некрашеная шерсть. */
export function capeMaterial(variant: string): MeshStandardMaterial {
  return new MeshStandardMaterial({
    name: 'cloak-cape',
    color: new Color(variant === 'enchanted' ? '#3b3a78' : '#5a4632'),
    roughness: .88,
    metalness: 0,
    side: DoubleSide,
    vertexColors: true,
  })
}

