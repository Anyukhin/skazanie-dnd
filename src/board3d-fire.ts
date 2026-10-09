import * as THREE from 'three'
import { fireFlicker } from './board3d-graphics'

/**
 * Видимый огонь у источников света (ориентир — факелы TaleSpire): яркое ядро
 * пламени, мягкий ореол вокруг и искры, поднимающиеся над огнём. Только
 * представление: свет и его сила — у точечных огней сцены (`fireLightFor`),
 * здесь — то, что видно глазом. У факела Quaternius и костра своего пламени в
 * модели нет вовсе, у жаровни оно тусклое и не доходит до свечения (bloom).
 *
 * Ядро и центр ореола ярче единицы: постобработка (bloom) даёт им сияние, на
 * «Экономном» без неё остаётся сам ореол. Всё — аддитивные спрайты и точки без
 * записи глубины: затенение (GTAO) их не видит, тень они не бросают. Движение
 * — чистая функция времени, без случайности и состояния.
 */

export type FirePoint = {
  /** Мировые координаты пламени: клетка — 1. */
  x: number
  y: number
  z: number
  /** Сила источника относительно жаровни (`BOARD3D_FIRE_LIGHT.referenceStrength`). */
  share: number
}

export type FireGlowDetail = 'full' | 'reduced' | 'minimal'

export const BOARD3D_FIRE_GLOW = {
  /** Ореол: радиус в клетках у свечи и у жаровни, яркость днём и в подземелье. */
  haloSize: [.7, 1.5] as const,
  haloOpacity: [.22, .55] as const,
  /** Ядро пламени: ширина и высота в клетках у жаровни, яркость (выше 1 — под bloom). */
  coreSize: [.2, .34] as const,
  coreBrightness: 2.6,
  /** Искры на огонь: «Высокое», «Обычное», «Экономное». */
  embers: { full: 7, reduced: 4, minimal: 0 } as const,
  /** Искра живёт столько секунд и поднимается на столько клеток. */
  emberLife: 1.9,
  emberRise: .9,
  /** На сколько клеток ореол выдвигается к камере: иначе пол срезал бы его нижнюю половину. */
  haloLift: .45,
} as const

const WARM_HALO = new THREE.Color('#ff9a3c')
const WARM_CORE = new THREE.Color('#ffc46b')
const WARM_EMBER = new THREE.Color('#ffae4a')

/** Мягкое пятно: прозрачность падает от центра к краю, квадрат — без шва. */
export function createGlowTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const dx = (x + .5) / size * 2 - 1, dy = (y + .5) / size * 2 - 1
    const falloff = Math.max(0, 1 - Math.hypot(dx, dy))
    const at = (y * size + x) * 4
    data[at] = data[at + 1] = data[at + 2] = 255
    data[at + 3] = Math.round(255 * falloff * falloff * falloff)
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

/** Язык пламени: капля, узкая сверху; ярче у основания. */
export function createFlameTexture(width = 32, height = 64): THREE.DataTexture {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    // Строка 0 — низ спрайта (flipY у DataTexture выключен).
    const v = (y + .5) / height, u = (x + .5) / width * 2 - 1
    // Круглое основание, острая верхушка.
    const half = v < .3 ? .9 * Math.sqrt(v / .3) : .9 * Math.max(0, 1 - (v - .3) / .65) ** .8
    const across = half > 0 ? Math.max(0, 1 - Math.abs(u) / half) : 0
    const along = Math.max(0, 1 - Math.abs(v - .32) / .7)
    const at = (y * width + x) * 4
    data[at] = data[at + 1] = data[at + 2] = 255
    data[at + 3] = Math.round(255 * Math.min(1, across * along * 1.6) ** 1.4)
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat)
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

function hash(index: number, salt: number): number {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453
  return value - Math.floor(value)
}

/**
 * Искра номер `index` огня номер `seed` в момент `seconds`: смещение от
 * пламени в клетках и яркость 0..1. Каждая искра рождается у пламени,
 * поднимается, сносится в сторону и гаснет; фазы искр разведены.
 */
export function emberAt(seconds: number, seed: number, index: number): { dx: number; dy: number; dz: number; glow: number } {
  const life = BOARD3D_FIRE_GLOW.emberLife * (.75 + .5 * hash(index, seed))
  const age = ((seconds / life + hash(index, seed + 7)) % 1 + 1) % 1
  const angle = hash(index, seed + 13) * Math.PI * 2 + seconds * .8
  const drift = .12 + .18 * hash(index, seed + 21)
  const fadeIn = Math.min(1, age / .12)
  return {
    dx: Math.cos(angle) * drift * age,
    dy: BOARD3D_FIRE_GLOW.emberRise * age,
    dz: Math.sin(angle) * drift * age,
    glow: fadeIn * (1 - age) ** 1.6,
  }
}

const lerp = (range: readonly [number, number], t: number) => range[0] + (range[1] - range[0]) * Math.max(0, Math.min(1, t))

type Flame = { point: FirePoint; seed: number; halo: THREE.Sprite; core: THREE.Sprite; haloScale: number; haloOpacity: number; coreScale: THREE.Vector2 }

/**
 * Огни карты. `darkness` — сумрак сцены (`boardDarkness`): днём ореол
 * бледнее, в подземелье — главный ориентир. `animate` вызывается кадром
 * сцены; без вызова огонь стоит.
 */
export function createFireGlow(points: readonly FirePoint[], detail: FireGlowDetail, darkness = 0) {
  const group = new THREE.Group()
  group.name = 'fire-glow'
  const glowTexture = createGlowTexture()
  const flameTexture = createFlameTexture()
  const owned: Array<{ dispose(): void }> = [glowTexture, flameTexture]
  const dark = Math.max(0, Math.min(1, darkness))
  const toCamera = new THREE.Vector3()
  const flames: Flame[] = points.map((point, index) => {
    const share = Math.max(.3, Math.min(1.2, point.share))
    const haloOpacity = lerp(BOARD3D_FIRE_GLOW.haloOpacity, dark) * (.6 + .4 * share)
    const haloMaterial = new THREE.SpriteMaterial({ map: glowTexture, color: WARM_HALO.clone().multiplyScalar(1.6), transparent: true, opacity: haloOpacity, depthWrite: false, blending: THREE.AdditiveBlending })
    const coreMaterial = new THREE.SpriteMaterial({ map: flameTexture, color: WARM_CORE.clone().multiplyScalar(BOARD3D_FIRE_GLOW.coreBrightness), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    owned.push(haloMaterial, coreMaterial)
    const halo = new THREE.Sprite(haloMaterial)
    halo.name = 'fire-halo'
    const haloScale = lerp(BOARD3D_FIRE_GLOW.haloSize, (share - .45) / .55)
    halo.scale.setScalar(haloScale)
    halo.position.set(point.x, point.y, point.z)
    // Ортокамера: сдвиг к камере не меняет места на экране, только глубину —
    // ореол не режется полом под огнём, а стена и крыша по-прежнему его закрывают.
    halo.onBeforeRender = (_renderer, _scene, camera) => {
      camera.getWorldDirection(toCamera).multiplyScalar(-BOARD3D_FIRE_GLOW.haloLift)
      halo.matrixWorld.setPosition(point.x + toCamera.x, point.y + toCamera.y, point.z + toCamera.z)
    }
    const core = new THREE.Sprite(coreMaterial)
    core.name = 'fire-core'
    // Низ языка — у пламени источника.
    core.center.set(.5, .08)
    const coreScale = new THREE.Vector2(...BOARD3D_FIRE_GLOW.coreSize).multiplyScalar(.55 + .45 * share)
    core.scale.set(coreScale.x, coreScale.y, 1)
    core.position.set(point.x, point.y - coreScale.y * .2, point.z)
    group.add(halo, core)
    return { point, seed: index + 1, halo, core, haloScale, haloOpacity, coreScale }
  })

  const perFire = BOARD3D_FIRE_GLOW.embers[detail]
  let embers: THREE.Points | null = null
  if (perFire > 0 && flames.length) {
    const count = perFire * flames.length
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    const material = new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    embers = new THREE.Points(geometry, material)
    embers.name = 'fire-embers'
    // Искры двигаются вершинами: рамки геометрии нет, отсекать по ней нельзя.
    embers.frustumCulled = false
    group.add(embers)
    owned.push(geometry, material)
  }

  const animate = (seconds: number) => {
    for (const flame of flames) {
      const breath = fireFlicker(seconds, flame.seed)
      flame.halo.scale.setScalar(flame.haloScale * (.92 + .08 * breath))
      ;(flame.halo.material as THREE.SpriteMaterial).opacity = flame.haloOpacity * breath
      flame.core.scale.set(flame.coreScale.x * (.94 + .06 * breath), flame.coreScale.y * (.82 + .18 * breath), 1)
    }
    if (!embers) return
    const position = embers.geometry.getAttribute('position') as THREE.BufferAttribute
    const color = embers.geometry.getAttribute('color') as THREE.BufferAttribute
    flames.forEach((flame, fire) => {
      for (let index = 0; index < perFire; index += 1) {
        const ember = emberAt(seconds, flame.seed, index)
        const at = fire * perFire + index
        position.setXYZ(at, flame.point.x + ember.dx, flame.point.y + ember.dy, flame.point.z + ember.dz)
        color.setXYZ(at, WARM_EMBER.r * ember.glow * 2, WARM_EMBER.g * ember.glow * 2, WARM_EMBER.b * ember.glow * 2)
      }
    })
    position.needsUpdate = true
    color.needsUpdate = true
  }
  animate(0)

  return {
    group,
    /** Число огней: сцена с огнём перерисовывается кадром. */
    count: flames.length,
    animate,
    dispose() {
      group.removeFromParent()
      for (const item of owned) item.dispose()
    },
  }
}
