import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/**
 * Освещение и постобработка доски. Только представление: модуль не читает
 * карту, правила или события и не влияет на то, что игрок может сделать.
 */

/** Свет сцены. Полусфера слабее солнца, иначе тени тонут в заливке. */
export const BOARD3D_LIGHTING = {
  exposure: 1,
  hemisphere: { sky: '#dfe3dc', ground: '#4b3a26', intensity: .85 },
  sun: { color: '#ffe2b0', intensity: 3.1, shadowRadius: 3, normalBias: .02, bias: -.0004 },
  /** Отражения окружения дают металлу и коже GLB-моделей объём. */
  environmentIntensity: .22,
  /** Доля рисунка-подложки при линейном смешивании; на экране равна прежним 34 %. */
  linearArtOverlayOpacity: .14,
  /** Множитель яркости вспышек эффектов: эффект задаёт 0..6, доска переводит в канделы. */
  effectLightScale: 3,
} as const

/**
 * Вспышка света, которую эффект просит у доски через `group.userData.lights`.
 * Координаты мировые (клетка — 1), `distance` — радиус действия в клетках.
 */
export type BoardEffectLight = { x: number; y: number; z: number; color: string; intensity: number; distance: number }

/** Не больше двух вспышек; мусор из эффекта отбрасывается, а не ломает кадр. */
export function boardEffectLights(value: unknown): BoardEffectLight[] {
  if (!Array.isArray(value)) return []
  const lights: BoardEffectLight[] = []
  for (const item of value) {
    if (lights.length >= 2) break
    const light = item as Partial<BoardEffectLight> | null
    if (!light || typeof light !== 'object') continue
    const { x, y, z, intensity, distance, color } = light
    if (![x, y, z, intensity, distance].every((number) => typeof number === 'number' && Number.isFinite(number))) continue
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(color) || intensity! <= 0) continue
    lights.push({ x: x!, y: y!, z: z!, color, intensity: Math.min(8, intensity!), distance: Math.max(.5, Math.min(12, distance!)) })
  }
  return lights
}

/**
 * Сумрак карты: средний уровень темноты раскрытых проходимых клеток. В
 * помещении темнота — 1, сумрак — 0.85, светло — 0.6; снаружи 0.7, 0.35 и 0. Подземелье и склеп освещены факелами и
 * жаровнями, а не солнцем; открытая местность остаётся дневной.
 */
export function boardDarkness(map: { width: number; height: number; zones: ReadonlyArray<{ id: string; kind: string; lightLevel: string }> }, cellAt: (x: number, y: number) => { revealed: boolean; passable: boolean; zone: string } | null): number {
  // Под крышей солнца нет: помещение темнее открытого места того же уровня.
  const levels = new Map(map.zones.map((zone) => {
    const indoor = zone.kind === 'interior'
    const value = zone.lightLevel === 'dark' ? (indoor ? 1 : .7) : zone.lightLevel === 'dim' ? (indoor ? .85 : .35) : (indoor ? .6 : 0)
    return [zone.id, value]
  }))
  let total = 0, cells = 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(x, y)
    if (!cell?.revealed || !cell.passable) continue
    total += levels.get(cell.zone) ?? 0
    cells += 1
  }
  return cells ? Math.min(1, total / cells) : 0
}

/** Свет сцены при данном сумраке: солнце и заливка гаснут, огни берут своё. */
export function lightingForDarkness(darkness: number) {
  const d = Math.max(0, Math.min(1, darkness))
  return {
    sun: BOARD3D_LIGHTING.sun.intensity * (1 - .94 * d),
    hemisphere: BOARD3D_LIGHTING.hemisphere.intensity * (1 - .8 * d),
    hemisphereSky: new THREE.Color(BOARD3D_LIGHTING.hemisphere.sky).lerp(new THREE.Color('#7f8fae'), d).getStyle(),
    environment: BOARD3D_LIGHTING.environmentIntensity * (1 - .75 * d),
    exposure: BOARD3D_LIGHTING.exposure * (1 + .12 * d),
  }
}

/**
 * Цветокоррекция диорамы: чуть больше насыщенности и контраста, тёплый сдвиг
 * и мягкая виньетка. Работает после тонмаппинга, в цветах экрана.
 */
export const BOARD3D_GRADE = { saturation: 1.14, contrast: 1.07, warmth: .025, vignette: .32 }

const GradeShader = {
  name: 'BoardGradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    saturation: { value: BOARD3D_GRADE.saturation },
    contrast: { value: BOARD3D_GRADE.contrast },
    warmth: { value: BOARD3D_GRADE.warmth },
    vignette: { value: BOARD3D_GRADE.vignette },
  },
  vertexShader: `varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float saturation; uniform float contrast; uniform float warmth; uniform float vignette;
varying vec2 vUv;
void main() {
  vec4 color = texture2D(tDiffuse, vUv);
  float luma = dot(color.rgb, vec3(.2126, .7152, .0722));
  vec3 graded = mix(vec3(luma), color.rgb, saturation);
  graded = (graded - .5) * contrast + .5;
  graded.r *= 1. + warmth; graded.b *= 1. - warmth;
  float edge = smoothstep(.42, .95, distance(vUv, vec2(.5)));
  graded *= 1. - vignette * edge;
  gl_FragColor = vec4(clamp(graded, 0., 1.), color.a);
}`,
}

export type Board3DPostProcessing = {
  /** Мягкое затенение в углах, у стен и под фигурками. */
  ambientOcclusion: boolean
  /** Свечение огня и заклинаний поверх яркости кадра. */
  bloom: boolean
}

/** Палитра фона: тёплый центр под доской и тёмные края, как виньетка стола. */
export function createBoardBackdropTexture(center = '#2a2620', edge = '#0d0c0a'): THREE.Texture | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const context = canvas.getContext('2d')
    if (!context) return null
    const gradient = context.createRadialGradient(128, 118, 12, 128, 128, 182)
    gradient.addColorStop(0, center)
    gradient.addColorStop(.55, new THREE.Color(center).lerp(new THREE.Color(edge), .45).getStyle())
    gradient.addColorStop(1, edge)
    context.fillStyle = gradient
    context.fillRect(0, 0, 256, 256)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  } catch {
    return null
  }
}

/** Карта окружения из нейтральной «комнаты»: без внешних файлов и запросов. */
export function createBoardEnvironment(renderer: THREE.WebGLRenderer): { texture: THREE.Texture; dispose: () => void } | null {
  try {
    const generator = new THREE.PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    const target = generator.fromScene(room, .04)
    room.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) {
        mesh.geometry.dispose()
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose()
      }
    })
    generator.dispose()
    return { texture: target.texture, dispose: () => target.dispose() }
  } catch {
    return null
  }
}

export type BoardBounds = { minX: number; minZ: number; maxX: number; maxZ: number; minY: number; maxY: number }

/**
 * Камера тени солнца охватывает видимую карту целиком и не больше: на больших
 * картах края больше не остаются без теней, а на маленьких тень резче.
 */
export function fitSunShadow(sun: THREE.DirectionalLight, bounds: BoardBounds): void {
  const centerX = (bounds.minX + bounds.maxX) / 2, centerZ = (bounds.minZ + bounds.maxZ) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  const halfDiagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 2
  const height = Math.max(4, bounds.maxY - bounds.minY + 4)
  sun.target.position.set(centerX, centerY, centerZ)
  const direction = new THREE.Vector3(-.85, 1, .55).normalize()
  sun.position.copy(sun.target.position).addScaledVector(direction, halfDiagonal + height + 20)
  const camera = sun.shadow.camera
  camera.left = -halfDiagonal
  camera.right = halfDiagonal
  camera.top = halfDiagonal
  camera.bottom = -halfDiagonal
  camera.near = 1
  camera.far = 2 * (halfDiagonal + height) + 40
  camera.updateProjectionMatrix()
  sun.target.updateMatrixWorld()
  sun.updateMatrixWorld()
}

/**
 * GTAO по умолчанию учитывает все сетки. Полупрозрачные слои без записи
 * глубины — подсветка клеток, кольца под фигурками, вспышки заклинаний —
 * не являются поверхностями и не должны отбрасывать «грязь» на соседей.
 */
class BoardGTAOPass extends GTAOPass {
  private hiddenOverlays: THREE.Object3D[] = []

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean): void {
    this.scene.traverseVisible((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      if (materials.every((material) => material.transparent && !material.depthWrite)) this.hiddenOverlays.push(mesh)
    })
    for (const object of this.hiddenOverlays) object.visible = false
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive)
    } finally {
      for (const object of this.hiddenOverlays) object.visible = true
      this.hiddenOverlays.length = 0
    }
  }
}

/**
 * Конвейер кадра. Без постобработки — обычный `renderer.render`. С ней —
 * EffectComposer с MSAA-целью: RenderPass → GTAO → Bloom → OutputPass, где
 * последний делает тонмаппинг и перевод в sRGB. UI-слой (прицел) рисуется
 * отдельной сценой поверх готового кадра, чтобы его цвета не тонмапились.
 */
export function createBoardRenderPipeline(renderer: THREE.WebGLRenderer, scene: THREE.Scene, uiScene: THREE.Scene, camera: THREE.Camera) {
  let composer: EffectComposer | null = null
  let gtao: BoardGTAOPass | null = null
  let bloom: UnrealBloomPass | null = null
  let settings: Board3DPostProcessing = { ambientOcclusion: false, bloom: false }
  let width = 1, height = 1
  let clipBox: THREE.Box3 | null = null

  const disposeComposer = () => {
    if (!composer) return
    for (const pass of composer.passes) pass.dispose()
    composer.renderTarget1.dispose()
    composer.renderTarget2.dispose()
    composer = null
    gtao = null
    bloom = null
  }

  const build = () => {
    disposeComposer()
    if (!settings.ambientOcclusion && !settings.bloom) return
    const pixelRatio = renderer.getPixelRatio()
    // MSAA-цель сохраняет сглаживание, которое иначе даёт сам холст.
    const target = new THREE.WebGLRenderTarget(width * pixelRatio, height * pixelRatio, { type: THREE.HalfFloatType, samples: 4 })
    composer = new EffectComposer(renderer, target)
    composer.setPixelRatio(pixelRatio)
    composer.setSize(width, height)
    composer.addPass(new RenderPass(scene, camera))
    if (settings.ambientOcclusion) {
      gtao = new BoardGTAOPass(scene, camera, width * pixelRatio, height * pixelRatio)
      // Радиус в мировых единицах: клетка — 1. Затенение держится у стыков
      // стен, мебели и ног и не расползается по всему полу.
      gtao.updateGtaoMaterial({ radius: .42, distanceExponent: 1.4, thickness: 1.2, scale: 1, samples: 16 })
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 })
      gtao.blendIntensity = .85
      if (clipBox) gtao.setSceneClipBox(clipBox)
      composer.addPass(gtao)
    }
    if (settings.bloom) {
      // Порог выше яркости освещённого пола: светятся огонь, вспышки и
      // аддитивные эффекты заклинаний, а не светлые камни.
      bloom = new UnrealBloomPass(new THREE.Vector2(width * pixelRatio / 2, height * pixelRatio / 2), .4, .45, .95)
      composer.addPass(bloom)
    }
    composer.addPass(new OutputPass())
    composer.addPass(new ShaderPass(GradeShader))
  }

  return {
    configure(next: Board3DPostProcessing) {
      if (next.ambientOcclusion === settings.ambientOcclusion && next.bloom === settings.bloom && (composer || (!next.ambientOcclusion && !next.bloom))) return
      settings = { ...next }
      build()
    },
    setSize(nextWidth: number, nextHeight: number) {
      width = Math.max(1, nextWidth)
      height = Math.max(1, nextHeight)
      if (!composer) return
      composer.setPixelRatio(renderer.getPixelRatio())
      composer.setSize(width, height)
    },
    /** Смена DPR требует новой цели: EffectComposer не пересчитывает samples. */
    refresh() { build() },
    setSceneBounds(bounds: BoardBounds) {
      clipBox = new THREE.Box3(new THREE.Vector3(bounds.minX - 1, bounds.minY - 1, bounds.minZ - 1), new THREE.Vector3(bounds.maxX + 1, bounds.maxY + 3, bounds.maxZ + 1))
      gtao?.setSceneClipBox(clipBox)
    },
    get active() { return Boolean(composer) },
    render() {
      renderer.info.reset()
      if (composer) composer.render()
      else renderer.render(scene, camera)
      if (uiScene.children.length) {
        const autoClear = renderer.autoClear
        renderer.autoClear = false
        renderer.clearDepth()
        renderer.render(uiScene, camera)
        renderer.autoClear = autoClear
      }
    },
    dispose() { disposeComposer() },
  }
}
