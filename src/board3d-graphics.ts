import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { isFoliageMaterial } from './board3d-cutout'

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

/**
 * Холодный тон подземелья (ориентир — TaleSpire): тени и заливка уходят в
 * сине-бирюзовый, огни остаются тёплыми, и тёплые пятна читаются на холодном
 * фоне. Действует только в сумрачных и тёмных помещениях и подземельях
 * (`dungeonCoolness`), открытая местность и светлая таверна не меняются.
 * `moon` — цвет остатка солнца (лунный ключ), `moonBoost` и `fillBoost` —
 * насколько лунный ключ и заливка сильнее прежних: камень остаётся читаемым,
 * но в холодном свете. `warmth` — тёплый сдвиг цветокоррекции (у дневной
 * доски `BOARD3D_GRADE.warmth`), `backdrop` — фон.
 */
export const BOARD3D_DUNGEON_TONE = {
  moon: '#8ea6dc', sky: '#4d6aa6', ground: '#151b27', moonBoost: .6, fillBoost: .8, warmth: -.03,
  backdrop: ['#141d24', '#05080a'] as [string, string],
} as const

/**
 * Доля холодного тона: 0 до сумрака 0,6 (светлое помещение, открытая
 * местность), 1 — с 0,85 (сумрачный склеп, тёмная пещера).
 */
export function dungeonCoolness(darkness: number): number {
  return THREE.MathUtils.smoothstep(Math.max(0, Math.min(1, darkness)), .6, .85)
}

/** Свет сцены при данном сумраке: солнце и заливка гаснут, огни берут своё. */
export function lightingForDarkness(darkness: number) {
  const d = Math.max(0, Math.min(1, darkness))
  const cool = dungeonCoolness(d)
  const tone = BOARD3D_DUNGEON_TONE
  return {
    sun: BOARD3D_LIGHTING.sun.intensity * (1 - .94 * d) * (1 + tone.moonBoost * cool),
    sunColor: new THREE.Color(BOARD3D_LIGHTING.sun.color).lerp(new THREE.Color(tone.moon), cool).getStyle(),
    hemisphere: BOARD3D_LIGHTING.hemisphere.intensity * (1 - .8 * d) * (1 + tone.fillBoost * cool),
    hemisphereSky: new THREE.Color(BOARD3D_LIGHTING.hemisphere.sky).lerp(new THREE.Color('#7f8fae'), d).lerp(new THREE.Color(tone.sky), cool).getStyle(),
    hemisphereGround: new THREE.Color(BOARD3D_LIGHTING.hemisphere.ground).lerp(new THREE.Color(tone.ground), cool).getStyle(),
    environment: BOARD3D_LIGHTING.environmentIntensity * (1 - .75 * d),
    exposure: BOARD3D_LIGHTING.exposure * (1 + .12 * d),
    warmth: BOARD3D_GRADE.warmth + (tone.warmth - BOARD3D_GRADE.warmth) * cool,
    cool,
  }
}

/** Фон доски в подземелье остывает вместе со светом. */
export function dungeonBackdrop(colors: readonly [string, string], cool: number): [string, string] {
  const amount = Math.max(0, Math.min(1, cool))
  return [0, 1].map((index) => new THREE.Color(colors[index]).lerp(new THREE.Color(BOARD3D_DUNGEON_TONE.backdrop[index]), amount).getHexString()).map((hex) => `#${hex}`) as [string, string]
}

/**
 * Огонь предмета: жаровня, факел, свеча. Затухание мягче обратного квадрата:
 * при `decay` 2 пол под низким огнём выгорал в белый диск, а в двух клетках
 * уже темнело. С 1.5 яркость в двух-трёх клетках прежняя (множитель `scale`),
 * центр пятна вдвое спокойнее, и фактура пола под огнём видна. Сила следует
 * силе источника из реестра света (`LIGHT_SOURCE_ASSETS`): свеча светит
 * слабее жаровни, а не так же.
 */
export const BOARD3D_FIRE_LIGHT = { decay: 1.5, scale: .63, referenceStrength: 130, minShare: .45, maxShare: 1.15 } as const

export function fireLightFor(profile: { radius: number; strength: number }, darkness: number) {
  const d = Math.max(0, Math.min(1, darkness))
  const share = Math.max(BOARD3D_FIRE_LIGHT.minShare, Math.min(BOARD3D_FIRE_LIGHT.maxShare, profile.strength / BOARD3D_FIRE_LIGHT.referenceStrength))
  return {
    // В сумраке огни сильнее и шире: они — главный свет подземелья.
    intensity: (1.35 + 16 * d) * BOARD3D_FIRE_LIGHT.scale * share,
    distance: Math.min(8, profile.radius) * (1 + .7 * d),
    decay: BOARD3D_FIRE_LIGHT.decay,
  }
}

/**
 * Дыхание огня (ориентир — факелы TaleSpire): множитель яркости 0,84–1,16 из
 * трёх несоизмеримых частот. `seed` разводит фазы соседних огней, чтобы они не
 * мигали хором. Чистая функция времени — без случайности и состояния.
 */
export const BOARD3D_FIRE_FLICKER = { amplitude: .16 } as const

export function fireFlicker(seconds: number, seed: number): number {
  const phase = seed * 2.399963
  const wave = .5 * Math.sin(seconds * 7.3 + phase) + .3 * Math.sin(seconds * 13.1 + 1.7 * phase) + .2 * Math.sin(seconds * 23.7 + 2.9 * phase)
  return 1 + BOARD3D_FIRE_FLICKER.amplitude * wave
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
  /** Доля разрешения кадра для затенения: 1 — полное, .5 — вчетверо дешевле. */
  ambientOcclusionScale?: number
  /** Свечение огня и заклинаний поверх яркости кадра. */
  bloom: boolean
  /** Малая глубина резкости «настольной диорамы»: резкая полоса по центру. */
  tiltShift?: boolean
}

/**
 * Tilt-shift: резкая полоса вокруг центра экрана, к верхнему и нижнему краю
 * кадр мягко расплывается, как на макросъёмке миниатюр. Центр — точка, вокруг
 * которой вращается камера, поэтому то, что игрок рассматривает, всегда резко.
 * `band` — полуширина резкой полосы в долях высоты, `falloff` — ширина перехода,
 * `amount` — радиус размытия у края в пикселях кадра высотой 1080.
 */
export const BOARD3D_TILT_SHIFT = { band: .2, falloff: .3, amount: 2.6 }

const TiltShiftShader = {
  name: 'BoardTiltShiftShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    step: { value: new THREE.Vector2(1, 0) },
    band: { value: BOARD3D_TILT_SHIFT.band },
    falloff: { value: BOARD3D_TILT_SHIFT.falloff },
  },
  vertexShader: `varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 step; uniform float band; uniform float falloff;
varying vec2 vUv;
void main() {
  float blur = smoothstep(band, band + falloff, abs(vUv.y - .5));
  if (blur < .02) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
  vec2 offset = step * blur;
  vec4 sum = texture2D(tDiffuse, vUv) * .2270270270;
  sum += (texture2D(tDiffuse, vUv + offset * 1.3846153846) + texture2D(tDiffuse, vUv - offset * 1.3846153846)) * .3162162162;
  sum += (texture2D(tDiffuse, vUv + offset * 3.2307692308) + texture2D(tDiffuse, vUv - offset * 3.2307692308)) * .0702702703;
  gl_FragColor = sum;
}`,
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
 * Листва с просветами (`isFoliageMaterial`) тоже скрыта: проход нормалей
 * рисует её карточки сплошными прямоугольниками, и крона затеняла сама себя.
 * Стволы, мебель и стены затенение сохраняют.
 */
class BoardGTAOPass extends GTAOPass {
  private hiddenOverlays: THREE.Object3D[] = []
  private readonly resolutionScale: number

  constructor(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, resolutionScale = 1) {
    super(scene, camera, Math.max(1, Math.round(width * resolutionScale)), Math.max(1, Math.round(height * resolutionScale)))
    this.resolutionScale = resolutionScale
  }

  override setSize(width: number, height: number): void {
    super.setSize(Math.max(1, Math.round(width * this.resolutionScale)), Math.max(1, Math.round(height * this.resolutionScale)))
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean): void {
    this.scene.traverseVisible((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      if (materials.every((material) => (material.transparent && !material.depthWrite) || isFoliageMaterial(material))) this.hiddenOverlays.push(mesh)
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
  let tiltPasses: ShaderPass[] = []
  let settings: Board3DPostProcessing = { ambientOcclusion: false, bloom: false }
  let width = 1, height = 1
  let clipBox: THREE.Box3 | null = null
  let gradePass: ShaderPass | null = null
  let warmth: number = BOARD3D_GRADE.warmth

  const disposeComposer = () => {
    if (!composer) return
    for (const pass of composer.passes) pass.dispose()
    composer.renderTarget1.dispose()
    composer.renderTarget2.dispose()
    composer = null
    gtao = null
    bloom = null
    gradePass = null
    tiltPasses = []
  }

  /** Шаг размытия в текселях: радиус у края растёт с высотой кадра. */
  const updateTiltShift = () => {
    if (!tiltPasses.length) return
    const pixelRatio = renderer.getPixelRatio()
    const radius = BOARD3D_TILT_SHIFT.amount * Math.max(.5, height * pixelRatio / 1080)
    tiltPasses[0].uniforms.step.value.set(radius / (width * pixelRatio), 0)
    tiltPasses[1].uniforms.step.value.set(0, radius / (height * pixelRatio))
  }

  const build = () => {
    disposeComposer()
    if (!settings.ambientOcclusion && !settings.bloom && !settings.tiltShift) return
    const pixelRatio = renderer.getPixelRatio()
    // MSAA-цель сохраняет сглаживание, которое иначе даёт сам холст.
    const target = new THREE.WebGLRenderTarget(width * pixelRatio, height * pixelRatio, { type: THREE.HalfFloatType, samples: 4 })
    composer = new EffectComposer(renderer, target)
    composer.setPixelRatio(pixelRatio)
    composer.setSize(width, height)
    composer.addPass(new RenderPass(scene, camera))
    if (settings.ambientOcclusion) {
      const scale = Math.min(1, Math.max(.25, settings.ambientOcclusionScale ?? 1))
      gtao = new BoardGTAOPass(scene, camera, width * pixelRatio, height * pixelRatio, scale)
      // Радиус в мировых единицах: клетка — 1. Затенение держится у стыков
      // стен, мебели и ног и не расползается по всему полу. На уменьшенном
      // разрешении выборок вдвое меньше: шум сглаживает тот же фильтр.
      const samples = scale < 1 ? 8 : 16
      gtao.updateGtaoMaterial({ radius: .42, distanceExponent: 1.4, thickness: 1.2, scale: 1, samples })
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples })
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
    if (settings.tiltShift) {
      tiltPasses = [new ShaderPass(TiltShiftShader), new ShaderPass(TiltShiftShader)]
      for (const pass of tiltPasses) composer.addPass(pass)
      updateTiltShift()
    }
    gradePass = new ShaderPass(GradeShader)
    gradePass.uniforms.warmth.value = warmth
    composer.addPass(gradePass)
  }

  return {
    configure(next: Board3DPostProcessing) {
      const same = next.ambientOcclusion === settings.ambientOcclusion && next.bloom === settings.bloom
        && (next.ambientOcclusionScale ?? 1) === (settings.ambientOcclusionScale ?? 1) && Boolean(next.tiltShift) === Boolean(settings.tiltShift)
      if (same && (composer || (!next.ambientOcclusion && !next.bloom && !next.tiltShift))) return
      settings = { ...next }
      build()
    },
    setSize(nextWidth: number, nextHeight: number) {
      width = Math.max(1, nextWidth)
      height = Math.max(1, nextHeight)
      if (!composer) return
      composer.setPixelRatio(renderer.getPixelRatio())
      composer.setSize(width, height)
      updateTiltShift()
    },
    /** Смена DPR требует новой цели: EffectComposer не пересчитывает samples. */
    refresh() { build() },
    setSceneBounds(bounds: BoardBounds) {
      clipBox = new THREE.Box3(new THREE.Vector3(bounds.minX - 1, bounds.minY - 1, bounds.minZ - 1), new THREE.Vector3(bounds.maxX + 1, bounds.maxY + 3, bounds.maxZ + 1))
      gtao?.setSceneClipBox(clipBox)
    },
    get active() { return Boolean(composer) },
    /** Тёплый сдвиг цветокоррекции: в подземелье тень холодная (`lightingForDarkness`). */
    setWarmth(value: number) {
      warmth = Number.isFinite(value) ? value : BOARD3D_GRADE.warmth
      if (gradePass) gradePass.uniforms.warmth.value = warmth
    },
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
