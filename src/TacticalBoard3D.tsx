import { Children, Fragment, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { BoardAnimationActor, TacticalBoardProps } from './TacticalBoard'
import { actorFootprintSize, actorPresentationCenter, actorPresentationSize, boardCameraKey } from './tactical-ui'
import { cellAt, revealedAt } from './tactical-map-client'
import { DEFAULT_BOARD_PALETTE, boardPaletteFrom, drawBoardEffects, drawBoardOverlay, type BoardScene } from './board-render'
import { moveDifficultPath, moveReachFill, moveReachOutline, moveRoutePath } from './move-preview'
import { COMBAT_ANIMATION_QUEUE_LIMIT, combatAnimationCuesFromBattleLog, combatAnimationCuesFromEvents, combatAnimationUsesReducedMotion, shouldDeferDefeat, attackOutcome, strikeImpactProgress, strikeMotionProgress, strikeUsesProjectile, type CombatAnimationCue } from './combat-animation'
import { createSpellEffectRenderer, isSpellAnimationCue, systemPrefersReducedMotion } from './spell-effects'
import { createCombatEffect3D } from './board3d-effects'
import { createSpellEffect3D } from './board3d-spell-effects'
import { BOARD3D_WALL_HEIGHT, createBoard3DScene, nearestPropPickTarget } from './board3d-scene'
import { combatAudioSpatialFromScreen } from './combat-audio'
import type { Board3DRoofMode } from './board3d-roofs'
import { boardCameraFitZoom, shouldInitialFitBoardCamera } from './board3d-camera'
import { createTerrainSurfaceGeometry, terrainHeightAt, visibleTerrainHeightRange } from './board3d-terrain'
import { createActorModel, createProceduralActorModel, getModelAssetDiagnostics, loadActorModelManifest, availableActorModels, resolveModelProfile, DEFAULT_ACTOR_MODEL_MANIFEST, type ActorModel, type ActorModelManifest, type ActorPose } from './actor-models'
import { LEGACY_CATALOG_REVISION } from './prop-model-catalog'
import { mapSignaturesFor } from './board3d-scene-signature'
import { BOARD3D_QUALITY, board3DQuality, cueForQuality, type Board3DQuality } from './board3d-quality'
import { BOARD3D_LIGHTING, boardDarkness, lightingForDarkness, boardEffectLights, createBoardBackdropTexture, createBoardEnvironment, createBoardRenderPipeline, fitSunShadow } from './board3d-graphics'
import { surroundingsBackdrop } from './board3d-surroundings'
import type { TacticalMap } from './types'

type Props = TacticalBoardProps & { onUnavailable: (message: string) => void }
type CameraState = { position: THREE.Vector3; target: THREE.Vector3; zoom: number }
const cameras = new Map<string, CameraState>()
const FPS_STORAGE_KEY = 'skazanie-3d-fps'
const QUALITY_STORAGE_KEY = 'skazanie-3d-quality'
/** Медиана кадра дольше этого (меньше ~24 кадров) — повод снизить качество. */
const AUTO_QUALITY_FRAME_MS = 42
const ROOF_STORAGE_KEY = 'skazanie-3d-roofs'

function roofModeValue(value: unknown): Board3DRoofMode {
  // По умолчанию — без крыши, как в наборных диорамах: каркас среза
  // перечёркивал зал балками. Выбранный игроком режим сохраняется.
  return value === 'full' || value === 'cutaway' ? value : 'hidden'
}

function hasBoardContent(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
    ? hasBoardContent(child.props.children)
    : child !== '')
}

type TargetPreviewCell = { x: number; y: number; className: string }

/** Только временная область прицеливания; дальность и постоянные эффекты сюда не попадают. */
export function targetPreviewCells(cells: readonly TargetPreviewCell[]) {
  return cells.filter((cell) => {
    const classes = cell.className.split(/\s+/u)
    return classes.includes('blast-area') && classes.includes('spell-preview-cell')
  })
}

type Runtime = {
  sync: () => void
  refresh: () => void
  skip: () => void
  reset: () => void
  turn: (angle: number) => void
  zoom: (factor: number) => void
  /** Сдвинуть камеру так, чтобы клетка оказалась в центре (мини-карта). С
   *  `onlyIfHidden` — только если клетка ушла из кадра (камера за героем). */
  focus: (x: number, y: number, onlyIfHidden?: boolean) => void
}

function readModels(key: string): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([id, model]) => id.length < 200 && typeof model === 'string' && model.length < 120)) as Record<string, string>
      : {}
  } catch { return {} }
}

/**
 * Поза исполнителя реплики. `null` — реплика не двигает фигурку: промах
 * заклинанием, лечение и объявленное состояние («Ярость», «Уклонение») не
 * должны выглядеть как вздрагивание от удара.
 */
function poseForCue(cue: CombatAnimationCue): ActorPose | null {
  if (cue.kind === 'move') return 'walk'
  if (cue.kind === 'strike') return strikeUsesProjectile(cue) ? 'ranged-attack' : 'attack'
  if (cue.kind === 'death') return 'death'
  if (cue.kind === 'impact') return cue.tone === 'damage' ? 'hit' : null
  if (cue.kind === 'condition') return null
  return isSpellAnimationCue(cue) ? 'cast' : 'hit'
}

type MoveCue = Extract<CombatAnimationCue, { kind: 'move' }>

/**
 * Маршрут анимации шага. Сервер кладёт конечную клетку последней в `path`, а
 * стартовую не кладёт; повтор `to` давал пустой последний отрезок, и фигурка
 * приходила раньше и стояла в позе ходьбы. Соседние дубли схлопываются.
 */
export function moveRoute(cue: Pick<MoveCue, 'from' | 'to' | 'path'>): Array<{ x: number; y: number }> {
  const route = [cue.from]
  for (const step of [...cue.path, cue.to]) {
    const last = route[route.length - 1]
    if (last.x !== step.x || last.y !== step.y) route.push(step)
  }
  return route
}

/** Шагов цикла ходьбы на клетку: клип не растягивается на весь путь. */
const WALK_CYCLES_PER_CELL = .5

/**
 * Клетка, в которой фигурка должна стоять, пока её ход ещё в очереди. Снимок
 * уже знает конечную позицию, но показывать её до анимации нельзя: фигурка
 * сначала стояла бы у цели, а потом «отпрыгивала» к старту и шла заново.
 */
export function queuedStartCell(actorId: string, cues: readonly (CombatAnimationCue | undefined)[]): { x: number; y: number } | null {
  for (const cue of cues) {
    if (!cue || !('actorId' in cue) || cue.actorId !== actorId) continue
    if (cue.kind === 'move') return cue.from
    if (cue.kind === 'channel' && cue.channelType === 'teleport' && cue.from) return cue.from
  }
  return null
}

function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from))
}

/** Для атаки берётся экипировка на момент события, затем возвращается текущая. */
function applyStrikeAppearance(model: ActorModel, cue: Extract<CombatAnimationCue, { kind: 'strike' }>): void {
  if (cue.loadout !== undefined) model.setAppearance({
    version: 2, profile: model.profile, equipment: cue.equipment ?? 'unknown', loadout: cue.loadout,
  })
  else if (cue.equipment !== undefined) model.setEquipment(cue.equipment)
}

function cueActsOnActor(cue: CombatAnimationCue | undefined, actorId: string): boolean {
  if (!cue) return false
  if ('actorId' in cue && cue.actorId === actorId) return true
  return (cue.kind === 'death' || cue.kind === 'impact') && cue.targetId === actorId
}

/** Подошва стоит на верхней раскрытой клетке занимаемой площади. */
function actorGround(map: TacticalMap | null | undefined, actor: BoardAnimationActor, anchor: { x: number; y: number } = actor): number {
  const side = actorPresentationSize(map, actor, anchor)
  let height = terrainHeightAt(map ?? null, anchor.x, anchor.y)
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    height = Math.max(height, terrainHeightAt(map ?? null, anchor.x + x, anchor.y + y))
  }
  return height
}

function actorHeight(map: TacticalMap, actor: BoardAnimationActor, catalog: ActorModelManifest): number {
  // Площадь — правило, рост — представление: существо 4×4 не обязано быть
  // вчетверо выше человека. Модель сохраняет пропорции своего профиля.
  return (resolveModelProfile(actor, catalog).height ?? 1.25) * (1 + .4 * (actorPresentationSize(map, actor) - 1))
}

/** Только представление. Обработчики клеток и целей принадлежат общему DungeonMap. */
export default function TacticalBoard3D(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const targetHintElement = useRef<HTMLSpanElement>(null)
  const moveLabelElement = useRef<HTMLSpanElement>(null)
  const moveRiskElement = useRef<HTMLSpanElement>(null)
  const runtime = useRef<Runtime | null>(null)
  const latest = useRef(props)
  latest.current = props
  const modelStorageKey = `skazanie-3d-models:${props.campaignId ?? ''}`
  const [models, setModels] = useState(() => readModels(modelStorageKey))
  const [catalog, setCatalog] = useState<ActorModelManifest>(DEFAULT_ACTOR_MODEL_MANIFEST)
  const [quality, setQuality] = useState<Board3DQuality>(() => {
    try { return board3DQuality(localStorage.getItem(QUALITY_STORAGE_KEY)) } catch { return 'balanced' }
  })
  const [roofMode, setRoofMode] = useState<Board3DRoofMode>(() => {
    try { return roofModeValue(localStorage.getItem(ROOF_STORAGE_KEY)) } catch { return 'hidden' }
  })
  // Автоснижение качества: только пока игрок сам его не выбирал. Большая
  // нарисованная карта на «Обычном» тяжела для встроенной видеокарты
  // (Миттлайд 84×70: ~12 кадров на Iris Xe против ~56 на «Экономном»).
  const autoQuality = useRef((() => { try { return localStorage.getItem(QUALITY_STORAGE_KEY) === null } catch { return false } })())
  const [qualityNote, setQualityNote] = useState('')
  const lowerQuality = useRef<(next: Board3DQuality) => void>(() => {})
  lowerQuality.current = (next) => {
    setQuality(next)
    setQualityNote(`Качество снижено до «${BOARD3D_QUALITY[next].label}»: кадров мало. Можно вернуть в меню качества.`)
  }
  const settings = useRef({ models, catalog, quality, roofMode })
  settings.current = { models, catalog, quality, roofMode }
  const [playing, setPlaying] = useState(false)
  const [modelActor, setModelActor] = useState('')
  const [modelWarning, setModelWarning] = useState('')
  const [showFps, setShowFps] = useState(() => {
    try { return localStorage.getItem(FPS_STORAGE_KEY) === 'true' } catch { return false }
  })
  const fpsOutput = useRef<HTMLOutputElement>(null)
  const fpsEnabled = useRef(showFps)
  fpsEnabled.current = showFps
  const cameraKey = boardCameraKey(props.map?.locationId, props.levelIndex ?? 0, props.campaignId ?? '')
  const actors = (props.animationActors ?? []).filter((actor) => props.map && revealedAt(props.map, actor.x, actor.y))
  const selectedModelActor = actors.some((actor) => actor.id === modelActor) ? modelActor : actors[0]?.id ?? ''

  useEffect(() => { setModels(readModels(modelStorageKey)) }, [modelStorageKey])
  useEffect(() => {
    runtime.current?.refresh()
    if (!showFps || !fpsOutput.current) return
    const value = host.current?.querySelector<HTMLCanvasElement>('.board3d-canvas')?.dataset.fps
    fpsOutput.current.textContent = value ? `${Math.round(Number(value))} FPS` : '— FPS'
  }, [showFps])
  useEffect(() => {
    let disposed = false
    void loadActorModelManifest().then((value) => { if (!disposed) setCatalog(value) }).catch(() => {
      if (!disposed) setModelWarning('Каталог моделей недоступен. Используются встроенные фигурки.')
    })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (!host.current || !latest.current.map) return
    const element = host.current
    const sceneAbort = new AbortController()
    let disposed = false
    let frameId = 0
    let previousTime = 0
    let labelsDirty = true
    let measuredFrames = 0, measuredSince = performance.now(), measuredRenderMs = 0
    let renderedFrames = 0
    let renderSamples: number[] = [], frameSamples: number[] = []
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    } catch {
      latest.current.onUnavailable('Браузер не смог включить 3D-графику.')
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, BOARD3D_QUALITY[settings.current.quality].maxDpr))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = BOARD3D_LIGHTING.exposure
    // Постобработка вызывает render несколько раз за кадр; счётчики draw calls
    // сбрасывает конвейер в начале кадра, а не каждый проход.
    renderer.info.autoReset = false
    renderer.domElement.className = 'board3d-canvas'
    const gl = renderer.getContext()
    const debugRenderer = gl.getExtension('WEBGL_debug_renderer_info')
    renderer.domElement.dataset.gpu = String(gl.getParameter(debugRenderer?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER))
    renderer.domElement.tabIndex = 0
    renderer.domElement.setAttribute('aria-label', 'Поле боя 3D. Стрелки выбирают клетку, Enter подтверждает. Перетаскивание двигает камеру, правая кнопка поворачивает.')
    element.prepend(renderer.domElement)
    const scene = new THREE.Scene()
    let backdrop = createBoardBackdropTexture()
    let backdropKey = ''
    scene.background = backdrop ?? new THREE.Color('#191914')
    const environment = createBoardEnvironment(renderer)
    if (environment) {
      scene.environment = environment.texture
      scene.environmentIntensity = BOARD3D_LIGHTING.environmentIntensity
    }
    // Прицел — интерфейс поверх кадра: отдельная сцена не проходит через
    // тонмаппинг и постобработку.
    const uiScene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-8, 8, 6, -6, .1, 500)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
    controls.touches.ONE = THREE.TOUCH.PAN
    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE
    controls.minPolarAngle = .22
    controls.maxPolarAngle = 1.16
    controls.minZoom = .05
    controls.maxZoom = 5
    controls.screenSpacePanning = false
    controls.enableDamping = false
    const saved = cameras.get(cameraKey)
    let initialCameraFit = Boolean(saved)
    const hemisphere = new THREE.HemisphereLight(BOARD3D_LIGHTING.hemisphere.sky, BOARD3D_LIGHTING.hemisphere.ground, BOARD3D_LIGHTING.hemisphere.intensity)
    const sun = new THREE.DirectionalLight(BOARD3D_LIGHTING.sun.color, BOARD3D_LIGHTING.sun.intensity)
    sun.position.set(-8, 18, 8)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = sun.shadow.camera.bottom = -22
    sun.shadow.camera.right = sun.shadow.camera.top = 22
    sun.shadow.camera.far = 90
    sun.shadow.normalBias = BOARD3D_LIGHTING.sun.normalBias
    sun.shadow.bias = BOARD3D_LIGHTING.sun.bias
    // В r186 PCF-тень мягкая по радиусу выборки (диск Фогеля).
    sun.shadow.radius = BOARD3D_LIGHTING.sun.shadowRadius
    scene.add(hemisphere, sun, sun.target)
    const pipeline = createBoardRenderPipeline(renderer, scene, uiScene, camera)
    // Пул огней для вспышек эффектов живёт в сцене всегда: число источников
    // постоянно, и первая вспышка не пересобирает шейдеры всех материалов.
    const effectLights = [0, 1].map((index) => {
      const light = new THREE.PointLight('#ffffff', 0, 6, 2)
      light.name = `effect-light-${index}`
      light.castShadow = false
      scene.add(light)
      return light
    })
    const applyEffectLights = (group?: THREE.Object3D | null) => {
      const wanted = latest.current.lighting === false || BOARD3D_QUALITY[settings.current.quality].detail === 'minimal'
        ? [] : boardEffectLights(group?.userData.lights)
      effectLights.forEach((light, index) => {
        const next = wanted[index]
        if (!next) { light.intensity = 0; return }
        light.position.set(next.x, next.y, next.z)
        light.color.set(next.color)
        light.intensity = next.intensity * BOARD3D_LIGHTING.effectLightScale
        light.distance = next.distance
      })
    }
    type ActorView = { root: THREE.Group; model: ActorModel; key: string; defeated: boolean; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; abort: AbortController }
    const actorViews = new Map<string, ActorView>()
    let terrain: ReturnType<typeof createBoard3DScene> | null = null
    let terrainSignature = ''
    let terrainStyle = ''
    let lastMap: TacticalMap | null = null
    // created/disposed — логические экземпляры карты, overlay и actor-view;
    // объём GPU читается отдельно через renderer.info.memory.
    const diagnostics = { rebuilds: 0, rebuildReason: 'none', syncReason: 'none', prepMs: 0, created: 0, disposed: 0, referenceSame: 0, contentChanged: 0 }
    const publishModelDiagnostics = () => {
      const model = getModelAssetDiagnostics()
      renderer.domElement.dataset.modelFetches = String(model.fetches)
      renderer.domElement.dataset.modelCacheHits = String(model.cacheHits)
      renderer.domElement.dataset.modelParses = String(model.parses)
      renderer.domElement.dataset.modelCachedBytes = String(model.cachedBytes)
      renderer.domElement.dataset.modelEntries = String(model.entries)
      renderer.domElement.dataset.modelPending = String(model.pending)
    }
    const publishDiagnostics = (catalogRevision: string) => {
      renderer.domElement.dataset.rebuilds = String(diagnostics.rebuilds)
      renderer.domElement.dataset.rebuildReason = diagnostics.rebuildReason
      renderer.domElement.dataset.syncReason = diagnostics.syncReason
      renderer.domElement.dataset.prepMs = diagnostics.prepMs.toFixed(2)
      renderer.domElement.dataset.created = String(diagnostics.created)
      renderer.domElement.dataset.disposed = String(diagnostics.disposed)
      renderer.domElement.dataset.referenceSame = String(diagnostics.referenceSame)
      renderer.domElement.dataset.contentChanged = String(diagnostics.contentChanged)
      renderer.domElement.dataset.catalogRevision = catalogRevision
      renderer.domElement.dataset.locationId = latest.current.map?.locationId ?? ''
      publishModelDiagnostics()
    }
    let palette = DEFAULT_BOARD_PALETTE
    const trackedShadowTextures = new WeakSet<THREE.Texture>()
    function trackPointShadowDisposal() {
      for (const light of terrain?.group.getObjectByName('local-lights')?.children ?? []) {
        if (!(light instanceof THREE.PointLight)) continue
        const texture = light.shadow.map?.depthTexture
        if (!texture || !('isCubeDepthTexture' in texture) || trackedShadowTextures.has(texture)) continue
        const properties = renderer.properties.get(texture) as { __webglTexture?: WebGLTexture; __cacheKey?: string }
        // Three r186 создаёт CubeDepthTexture вне общего кэша WebGLTextures,
        // но dispose удаляет только записи этого кэша. Замыкаем освобождение
        // именно этого дескриптора; обычные текстуры остаются владельцу Three.
        if (!properties.__webglTexture || properties.__cacheKey !== undefined) continue
        const handle = properties.__webglTexture
        const release = () => {
          gl.deleteTexture(handle)
          texture.removeEventListener('dispose', release)
          trackedShadowTextures.delete(texture)
        }
        trackedShadowTextures.add(texture)
        texture.addEventListener('dispose', release)
      }
    }
    let pending: CombatAnimationCue[] = []
    let lastAnimateAt = 0
    let active: {
      cue: CombatAnimationCue
      started: number
      effect: ReturnType<typeof createCombatEffect3D> | null
    } | null = null
    let knownBatch = latest.current.visualBatch?.id
    const seen = new Set(combatAnimationCuesFromBattleLog(latest.current.battleLog ?? []).map((cue) => cue.id))
    for (const cue of combatAnimationCuesFromEvents(latest.current.visualBatch?.events ?? [])) seen.add(cue.id)
    const raycaster = new THREE.Raycaster()
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const cursor = new THREE.Vector2()
    let hoverKey = ''
    let keyboardCell = { x: 0, y: 0 }
    const floating = document.createElement('div')
    floating.className = 'board3d-floating-result'
    floating.setAttribute('aria-hidden', 'true')
    element.append(floating)

    const makeLayer = (height: number, options: { depthTest?: boolean; renderOrder?: number } = {}) => {
      const canvas = document.createElement('canvas')
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.minFilter = THREE.LinearFilter
      texture.generateMipmaps = false
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        depthTest: options.depthTest ?? true,
        side: options.depthTest === false ? THREE.DoubleSide : THREE.FrontSide,
        polygonOffset: options.depthTest !== false,
        polygonOffsetFactor: -1,
      })
      const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>(new THREE.BufferGeometry(), material)
      mesh.position.y = height
      mesh.renderOrder = options.renderOrder ?? 0
      scene.add(mesh)
      diagnostics.created += 1
      return { canvas, texture, mesh, geometryKey: '', dispose() { texture.dispose(); material.dispose(); mesh.geometry.dispose() } }
    }
    const overlay = makeLayer(.022)
    const spell = makeLayer(.038)
    // Прицел — UI-слой: он должен быть виден вокруг и поверх реквизита, а
    // обычный overlay сохраняет проверку глубины для дальности и зон местности.
    const targetPreviewGroup = new THREE.Group()
    targetPreviewGroup.renderOrder = 12
    uiScene.add(targetPreviewGroup)
    let targetPreviewFillGeometry: THREE.PlaneGeometry | null = null
    let targetPreviewFillMaterial: THREE.MeshBasicMaterial | null = null
    let targetPreviewEdgeGeometry: THREE.BufferGeometry | null = null
    let targetPreviewEdgeMaterial: THREE.MeshBasicMaterial | null = null
    let targetPreviewOutlineGeometry: THREE.BufferGeometry | null = null
    let targetPreviewOutlineMaterial: THREE.LineBasicMaterial | null = null
    const clearTargetPreview = () => {
      targetPreviewGroup.clear()
      targetPreviewFillGeometry?.dispose(); targetPreviewFillGeometry = null
      targetPreviewFillMaterial?.dispose(); targetPreviewFillMaterial = null
      targetPreviewEdgeGeometry?.dispose(); targetPreviewEdgeGeometry = null
      targetPreviewEdgeMaterial?.dispose(); targetPreviewEdgeMaterial = null
      targetPreviewOutlineGeometry?.dispose(); targetPreviewOutlineGeometry = null
      targetPreviewOutlineMaterial?.dispose(); targetPreviewOutlineMaterial = null
    }
    const disposeActorView = (id: string, view: ActorView) => {
      view.abort.abort()
      view.model.dispose(); view.ring.geometry.dispose(); view.ring.material.dispose(); scene.remove(view.root); actorViews.delete(id)
      diagnostics.disposed += 1
    }
    const projected = new THREE.Vector3()
    const projectedNext = new THREE.Vector3()
    const pointOnScreen = (point: THREE.Vector3, width = element.clientWidth, height = element.clientHeight) => {
      projected.copy(point).project(camera)
      return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2, visible: projected.z >= -1 && projected.z <= 1 }
    }
    function drawLabels() {
      const current = latest.current
      // Размер окна читается до записи стилей: чередование чтения/записи на
      // сотнях клеток заставляло браузер пересчитывать layout для каждой клетки.
      const width = element.clientWidth, height = element.clientHeight
      const actorsByCell = new Map<string, BoardAnimationActor>()
      for (const actor of current.animationActors ?? []) {
        const key = `${actor.x},${actor.y}`
        if (!actorsByCell.has(key)) actorsByCell.set(key, actor)
      }
      for (const node of element.querySelectorAll<HTMLElement>('[data-board3d-cell]')) {
        const [x, y] = (node.dataset.board3dCell ?? '').split(',').map(Number)
        const actor = actorsByCell.get(`${x},${y}`)
        const actorView = actor ? actorViews.get(actor.id) : undefined
        const position = actorView?.root.position
        if (actorView) { node.dataset.modelSource = actorView.model.source; node.dataset.modelKey = actorView.model.modelKey }
        else { delete node.dataset.modelSource; delete node.dataset.modelKey }
        const world = position?.clone() ?? new THREE.Vector3(x + .5, terrainHeightAt(current.map, x, y), y + .5)
        const screen = pointOnScreen(world, width, height)
        projectedNext.copy(world).add(new THREE.Vector3(1, 0, 0)).project(camera)
        const size = THREE.MathUtils.clamp(Math.hypot((projectedNext.x + 1) * width / 2 - screen.x, (1 - projectedNext.y) * height / 2 - screen.y), 14, 150)
        node.style.left = `${screen.x}px`
        node.style.top = `${screen.y}px`
        node.style.width = `${size}px`
        node.style.height = `${size}px`
        node.style.setProperty('--cell', `${size}px`)
        node.style.visibility = screen.visible ? 'visible' : 'hidden'
        // Соседние дверные зоны могут перекрываться после проекции. Горячая
        // дверь должна выиграть hit-test у дальней, иначе клик по открываемой
        // двери попадает в безопасную подсказку соседней.
        const reachableDoor = node.querySelector('.door-hotspot:not(.door-hotspot--out-of-reach)')
        node.style.zIndex = String(20 + Math.round(screen.y) + (reachableDoor ? 100 : 0))
        // Дверь лежит на ребре, а не в центре клетки. В перспективе и после
        // поворота камеры это ребро больше не совпадает с «восточной» или
        // «южной» стороной экранного квадрата, поэтому хит-зона считается по
        // двум спроецированным концам дверного проёма.
        for (const hotspot of node.querySelectorAll<HTMLButtonElement>('.door-hotspot')) {
          const edge = hotspot.dataset.doorEdge
          if (edge !== 'e' && edge !== 's' && edge !== 'w' && edge !== 'n') continue
          const vertical = edge === 'e' || edge === 'w'
          const edgeX = edge === 'e' ? x + 1 : x
          const edgeY = edge === 's' ? y + 1 : y
          const otherX = edge === 'e' ? x + 1 : edge === 'w' ? x - 1 : x
          const otherY = edge === 's' ? y + 1 : edge === 'n' ? y - 1 : y
          const terrainY = Math.max(
            terrainHeightAt(current.map, x, y),
            terrainHeightAt(current.map, otherX, otherY),
          ) + .08
          const projectDoorPoint = (fraction: number, heightOffset = 0) => pointOnScreen(
            vertical
              ? new THREE.Vector3(edgeX, terrainY + heightOffset, y + fraction)
              : new THREE.Vector3(x + fraction, terrainY + heightOffset, edgeY),
            width,
            height,
          )
          const points = [.22, .78].flatMap((fraction) => [
            projectDoorPoint(fraction),
            projectDoorPoint(fraction, BOARD3D_WALL_HEIGHT),
          ])
          const padding = Math.max(5, Math.min(12, size * .12))
          const minX = Math.min(...points.map((point) => point.x))
          const maxX = Math.max(...points.map((point) => point.x))
          const minY = Math.min(...points.map((point) => point.y))
          const maxY = Math.max(...points.map((point) => point.y))
          const hitWidth = Math.max(18, Math.min(size * 1.5, maxX - minX + padding * 2))
          const hitHeight = Math.max(18, Math.min(size * 1.5, maxY - minY + padding * 2))
          const centreX = (minX + maxX) / 2
          const centreY = (minY + maxY) / 2
          hotspot.style.left = `${centreX - screen.x + size / 2 - hitWidth / 2}px`
          hotspot.style.top = `${centreY - screen.y + size / 2 - hitHeight / 2}px`
          hotspot.style.right = 'auto'
          hotspot.style.bottom = 'auto'
          hotspot.style.width = `${hitWidth}px`
          hotspot.style.height = `${hitHeight}px`
        }
      }
      const buttonsByActor = new Map([...element.querySelectorAll<HTMLElement>('[data-actor-id]')].map((node) => [node.dataset.actorId, node]))
      for (const [id, view] of actorViews) {
        const button = buttonsByActor.get(id)
        const cell = button?.closest<HTMLElement>('[data-board3d-cell]')
        const spellColor = cell?.classList.contains('spell-affected-ally') ? '#ffd277'
          : cell?.classList.contains('spell-affected-enemy') ? '#ff867a'
            : cell?.classList.contains('spell-affected-neutral') ? '#e3d9bb' : null
        const selected = button?.classList.contains('active-turn') || button?.classList.contains('selected')
        view.ring.material.color.set(selected ? '#f2d489' : spellColor ?? current.animationActors?.find((actor) => actor.id === id)?.color ?? '#9cafb0')
        view.ring.material.opacity = spellColor && !selected ? .96 : .85
      }
      const hint = current.targetHint
      if (hint && targetHintElement.current) {
        const offset = hint.anchor === 'grid-intersection' ? 0 : .5
        const screen = pointOnScreen(new THREE.Vector3(hint.point.x + offset, terrainHeightAt(current.map, hint.point.x, hint.point.y), hint.point.y + offset), width, height)
        targetHintElement.current.style.left = `${Math.max(112, Math.min(width - 112, screen.x))}px`
        targetHintElement.current.style.top = `${Math.min(height - 32, screen.y + 22)}px`
        targetHintElement.current.style.visibility = screen.visible ? 'visible' : 'hidden'
      }
      // Итог хода — справа от цели, у правого края окна — слева; метка атаки
      // по возможности — на шаге, который уводит из досягаемости врага.
      const movePreview = current.movePreview
      const moveEnd = movePreview?.path[movePreview.path.length - 1]
      if (moveLabelElement.current && movePreview?.label && moveEnd) {
        const screen = pointOnScreen(new THREE.Vector3(moveEnd.x + .5, terrainHeightAt(current.map, moveEnd.x, moveEnd.y), moveEnd.y + .5), width, height)
        const flip = screen.x > width - 190
        moveLabelElement.current.classList.toggle('flip', flip)
        moveLabelElement.current.style.left = `${screen.x + (flip ? -24 : 24)}px`
        moveLabelElement.current.style.top = `${screen.y}px`
        moveLabelElement.current.style.visibility = screen.visible ? 'visible' : 'hidden'
      }
      if (moveRiskElement.current && movePreview?.risk) {
        const risk = movePreview.risk
        const screen = pointOnScreen(new THREE.Vector3(risk.x + .5, terrainHeightAt(current.map, Math.round(risk.x), Math.round(risk.y)), risk.y + .5), width, height)
        moveRiskElement.current.style.left = `${screen.x}px`
        moveRiskElement.current.style.top = `${screen.y}px`
        moveRiskElement.current.style.visibility = screen.visible ? 'visible' : 'hidden'
      }
      labelsDirty = false
    }
    function boardScene(canvas: HTMLCanvasElement): BoardScene | null {
      const map = latest.current.map
      if (!map) return null
      const size = Math.max(4, Math.min(48, Math.floor(2048 / Math.max(map.width, map.height))))
      if (canvas.width !== map.width * size || canvas.height !== map.height * size) {
        canvas.width = map.width * size
        canvas.height = map.height * size
      }
      return { map, cellSize: size, palette }
    }
    function clipVisible(context: CanvasRenderingContext2D, board: BoardScene) {
      context.beginPath()
      for (let y = 0; y < board.map.height; y++) for (let x = 0; x < board.map.width; x++) {
        if (revealedAt(board.map, x, y)) context.rect(x * board.cellSize, y * board.cellSize, board.cellSize, board.cellSize)
      }
      context.clip()
    }
    function paintOverlay() {
      const current = latest.current
      const board = boardScene(overlay.canvas), context = overlay.canvas.getContext('2d')
      if (!board || !context) return
      const size = board.cellSize
      context.clearRect(0, 0, overlay.canvas.width, overlay.canvas.height)
      context.save()
      clipVisible(context, board)
      drawBoardOverlay(context, board, current.overlayCells)
      drawBoardEffects(context, board, current.effectRenderers ?? [])
      for (const actor of current.animationActors ?? []) {
        const side = actorPresentationSize(current.map, actor)
        if (side <= 1) continue
        context.strokeStyle = actor.color ?? '#c6b889'
        context.lineWidth = 1.5
        context.strokeRect(actor.x * size + 2, actor.y * size + 2, side * size - 4, side * size - 4)
      }
      const movePreview = current.movePreview
      for (const node of current.cells) {
        const classes = node.className.split(' ')
        const spellPreview = classes.includes('spell-preview-cell')
        if (spellPreview) continue
        const blast = classes.includes('blast-area') && !spellPreview
        const route = classes.some((entry) => /^(move-path|route|pending-move|move-selected)/.test(entry))
        const reachable = classes.includes('reachable') || classes.includes('move-reachable')
        const hover = hoverKey === `${node.x},${node.y}`
        // Цель хода и опасный выход из ближнего боя показывает нить маршрута
        // с меткой; заливка клетки поверх неё только путала бы.
        const selected = classes.some((entry) => ['command-center', 'scene-object-selected', 'loot-focused', ...(movePreview ? [] : ['move-target'])].includes(entry))
        const danger = !movePreview && classes.includes('opportunity-risk') && (hover || route)
        if (!blast && !route && !reachable && !hover && !selected) continue
        context.fillStyle = blast || danger ? 'rgba(226,98,36,.48)' : route || selected ? 'rgba(228,191,100,.5)' : hover ? 'rgba(250,223,159,.3)' : 'rgba(194,169,103,.12)'
        context.fillRect(node.x * size + 1, node.y * size + 1, size - 2, size - 2)
        context.strokeStyle = blast || danger ? '#f6a05b' : '#e2c584'
        context.lineWidth = hover || route || selected ? 2 : 1
        context.strokeRect(node.x * size + 1, node.y * size + 1, size - 2, size - 2)
      }
      if (movePreview) {
        // Та же геометрия, что у двумерной доски: строка пути в долях клетки,
        // холст масштабируется до клетки текстуры. Линии толще, чем в 2D:
        // слой лежит на земле под травой и в наклоне камеры сужается.
        context.save()
        context.scale(size, size)
        context.lineCap = 'round'
        context.lineJoin = 'round'
        const fill = moveReachFill(movePreview)
        if (fill) { context.fillStyle = 'rgba(232,189,106,.12)'; context.fill(new Path2D(fill)) }
        const outline = moveReachOutline(movePreview)
        if (outline) {
          const edge = new Path2D(outline)
          context.strokeStyle = 'rgba(10,7,4,.55)'; context.lineWidth = .17; context.stroke(edge)
          context.strokeStyle = '#efc777'; context.lineWidth = .09; context.stroke(edge)
        }
        const routePath = moveRoutePath(movePreview)
        if (routePath) {
          const thread = new Path2D(routePath)
          context.strokeStyle = 'rgba(10,7,4,.6)'; context.lineWidth = .32; context.stroke(thread)
          context.strokeStyle = '#efc777'; context.lineWidth = .17; context.stroke(thread)
          const difficult = moveDifficultPath(movePreview)
          if (difficult) {
            context.setLineDash([.05, .19])
            context.strokeStyle = '#24170a'; context.lineWidth = .17; context.stroke(new Path2D(difficult))
            context.setLineDash([])
          }
        }
        const end = movePreview.path[movePreview.path.length - 1]
        if (end) {
          context.beginPath()
          context.arc(end.x + .5, end.y + .5, .36, 0, Math.PI * 2)
          context.fillStyle = 'rgba(232,189,106,.18)'; context.fill()
          context.strokeStyle = '#efc777'; context.lineWidth = .09; context.stroke()
        }
        context.restore()
      }
      // Метки хода стоят над картой экранными элементами: их место
      // пересчитывается вместе с остальными подписями.
      labelsDirty = true
      if (current.trajectory) {
        const path = current.trajectory
        context.strokeStyle = '#f8db98'
        context.lineWidth = 2
        context.setLineDash([7, 5])
        context.beginPath()
        context.moveTo(path.x1 / 100 * overlay.canvas.width, path.y1 / 100 * overlay.canvas.height)
        context.lineTo(path.x2 / 100 * overlay.canvas.width, path.y2 / 100 * overlay.canvas.height)
        context.stroke()
      }
      context.restore()
      overlay.texture.needsUpdate = true
    }
    function paintTargetPreview() {
      const current = latest.current
      const map = current.map
      if (!map) {
        clearTargetPreview()
        renderer.domElement.dataset.previewCellCount = '0'
        return
      }
      const cells = targetPreviewCells(current.cells).filter((cell) => revealedAt(map, cell.x, cell.y))
      renderer.domElement.dataset.previewCellCount = String(cells.length)
      clearTargetPreview()
      if (!cells.length) {
        renderer.domElement.dataset.previewGeometryVertexCount = '0'
        return
      }
      const occupied = new Set(cells.map((cell) => `${cell.x},${cell.y}`))
      const color = current.targetHint?.tone === 'blocked' ? '#ed7771' : current.targetPreviewColor ?? '#f09a4d'
      const edgeColor = new THREE.Color(color).offsetHSL(0, 0, .2)
      targetPreviewFillGeometry = new THREE.PlaneGeometry(1, 1)
      targetPreviewFillGeometry.rotateX(-Math.PI / 2)
      targetPreviewFillMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: .32,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      })
      for (const cell of cells) {
        const fill = new THREE.Mesh(targetPreviewFillGeometry, targetPreviewFillMaterial)
        fill.position.set(cell.x + .5, terrainHeightAt(map, cell.x, cell.y) + .06, cell.y + .5)
        fill.renderOrder = 1000
        targetPreviewGroup.add(fill)
      }
      const positions: number[] = [], edgePositions: number[] = [], edgeIndices: number[] = []
      let edgeVertex = 0
      const addEdge = (x1: number, z1: number, x2: number, z2: number, y: number) => {
        positions.push(x1, y, z1, x2, y, z2)
        const width = .12
        const length = Math.max(.001, Math.hypot(x2 - x1, z2 - z1))
        const nx = -(z2 - z1) / length * width / 2, nz = (x2 - x1) / length * width / 2
        edgePositions.push(x1 + nx, y, z1 + nz, x2 + nx, y, z2 + nz, x2 - nx, y, z2 - nz, x1 - nx, y, z1 - nz)
        edgeIndices.push(edgeVertex, edgeVertex + 1, edgeVertex + 2, edgeVertex, edgeVertex + 2, edgeVertex + 3)
        edgeVertex += 4
      }
      for (const cell of cells) {
        const y = terrainHeightAt(map, cell.x, cell.y) + .085
        if (!occupied.has(`${cell.x},${cell.y - 1}`)) addEdge(cell.x, cell.y, cell.x + 1, cell.y, y)
        if (!occupied.has(`${cell.x + 1},${cell.y}`)) addEdge(cell.x + 1, cell.y, cell.x + 1, cell.y + 1, y)
        if (!occupied.has(`${cell.x},${cell.y + 1}`)) addEdge(cell.x + 1, cell.y + 1, cell.x, cell.y + 1, y)
        if (!occupied.has(`${cell.x - 1},${cell.y}`)) addEdge(cell.x, cell.y + 1, cell.x, cell.y, y)
      }
      targetPreviewEdgeGeometry = new THREE.BufferGeometry()
      targetPreviewEdgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3))
      targetPreviewEdgeGeometry.setIndex(edgeIndices)
      targetPreviewEdgeMaterial = new THREE.MeshBasicMaterial({ color: '#271b20', transparent: true, opacity: .9, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
      const edgeMesh = new THREE.Mesh(targetPreviewEdgeGeometry, targetPreviewEdgeMaterial)
      edgeMesh.renderOrder = 1000
      targetPreviewGroup.add(edgeMesh)
      targetPreviewOutlineGeometry = new THREE.BufferGeometry()
      targetPreviewOutlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      targetPreviewOutlineMaterial = new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 1, depthTest: false, depthWrite: false, toneMapped: false })
      const outline = new THREE.LineSegments(targetPreviewOutlineGeometry, targetPreviewOutlineMaterial)
      outline.renderOrder = 1001
      targetPreviewGroup.add(outline)
      renderer.domElement.dataset.previewGeometryVertexCount = String(positions.length / 3)
    }
    function invalidate() {
      if (!disposed && !frameId && !document.hidden) frameId = requestAnimationFrame(render)
    }
    /** Ставит фигурку в покое: в клетку снимка или в старт ещё не показанного хода. */
    function placeActor(actor: BoardAnimationActor, view: ActorView) {
      const map = latest.current.map
      const queued = latest.current.animationsEnabled === false ? null : queuedStartCell(actor.id, [active?.cue, ...pending])
      const anchor = queued ? { ...actor, ...queued } : actor
      const center = actorPresentationCenter(map, actor, anchor)
      view.root.position.set(center.x, actorGround(map, actor, anchor), center.y)
    }
    function restoreActors() {
      labelsDirty = true
      for (const actor of latest.current.animationActors ?? []) {
        const view = actorViews.get(actor.id)
        if (!view) continue
        placeActor(actor, view)
        view.root.visible = true
        view.model.setAppearance(actor.appearance)
        const deferDeath = latest.current.animationsEnabled !== false && actor.defeated && shouldDeferDefeat(actor.id, active?.cue, pending)
        view.model.setPose(deferDeath ? 'idle' : actor.defeated ? 'death' : 'idle', deferDeath ? 0 : actor.defeated ? 1 : undefined)
        view.model.update(.001)
      }
    }
    function deferQueuedDefeats() {
      if (latest.current.animationsEnabled === false) return
      for (const actor of latest.current.animationActors ?? []) {
        if (!actor.defeated || !shouldDeferDefeat(actor.id, active?.cue, pending)) continue
        const model = actorViews.get(actor.id)?.model
        model?.setPose('idle', 0)
        model?.update(.001)
      }
    }
    function skip() {
      latest.current.combatAudio?.cancel()
      pending = []
      active?.effect?.dispose()
      active = null
      applyEffectLights(null)
      spell.canvas.getContext('2d')?.clearRect(0, 0, spell.canvas.width, spell.canvas.height)
      spell.texture.needsUpdate = true
      floating.textContent = ''
      restoreActors()
      setPlaying(false)
      invalidate()
    }
    function animate(now: number) {
      const current = latest.current
      if (!active && pending.length && current.map) {
        const cue = cueForQuality(pending.shift()!, settings.current.quality)
        const cueReducedMotion = combatAnimationUsesReducedMotion(cue)
        const audioActor = cue.kind === 'strike'
          ? current.animationActors?.find((actor) => actor.id === cue.actorId)
          : undefined
        // Стерео по месту на экране: подготовка и выпуск звучат у исполнителя,
        // контакт — у цели; событие за кадром тише.
        const width = element.clientWidth, height = element.clientHeight
        const spatialFor = (id?: string) => {
          const root = id ? actorViews.get(id)?.root : undefined
          return root ? combatAudioSpatialFromScreen({ ...pointOnScreen(root.position, width, height), width, height }) : undefined
        }
        const sourceId = 'actorId' in cue ? cue.actorId : undefined
        const targetId = 'targetId' in cue && cue.targetId ? cue.targetId : 'targetIds' in cue ? cue.targetIds?.[0] : undefined
        current.combatAudio?.schedule(
          { ...cue, durationMs: cueReducedMotion ? Math.max(120, cue.durationMs) : cue.durationMs },
          { ...(audioActor ? { actor: audioActor } : {}), spatial: { source: spatialFor(sourceId), target: spatialFor(targetId) } },
        )
        active = {
          cue,
          started: now,
          effect: current.animationsEnabled === false || cueReducedMotion ? null : createSpellEffect3D(cue, current.animationActors ?? [], current.map)
            ?? createCombatEffect3D(cue, current.animationActors ?? [], current.map),
        }
        if (active.effect) scene.add(active.effect.group)
        const actorId = 'actorId' in cue ? cue.actorId : 'targetId' in cue ? cue.targetId : ''
        const model = actorViews.get(actorId)?.model
        if (current.animationsEnabled !== false && cue.kind === 'strike' && model) applyStrikeAppearance(model, cue)
        const startPose = poseForCue(cue)
        if (current.animationsEnabled !== false && startPose) model?.setPose(startPose, 0)
        lastAnimateAt = now
      }
      if (!active) return
      const { cue } = active
      const reduced = combatAnimationUsesReducedMotion(cue)
      const progress = Math.min(1, (now - active.started) / (reduced ? 120 : Math.max(1, cue.durationMs)))
      if (current.animationsEnabled === false) {
        // Анимации выключили посреди реплики: без восстановления фигурка
        // осталась бы замороженной в середине шага или замаха.
        if (active.effect) { active.effect.dispose(); active.effect = null; restoreActors() }
        floating.textContent = ''
        if (progress >= 1) { active = null; restoreActors(); if (!pending.length) setPlaying(false) }
        return
      }
      const turnStep = 1 - Math.exp(-Math.max(0, now - lastAnimateAt) / 55)
      lastAnimateAt = now
      // Поворот догоняет направление по кратчайшей дуге: на углах маршрута
      // фигурка разворачивается за пару кадров, а не рывком.
      const face = (root: THREE.Object3D, yaw: number) => { root.rotation.y += shortestAngle(root.rotation.y, yaw) * turnStep }
      const actorAt = (id: string) => current.animationActors?.find((actor) => actor.id === id)
      const view = 'actorId' in cue ? actorViews.get(cue.actorId) : null
      let walkPhase: number | null = null
      if (!reduced && cue.kind === 'move' && view && current.map) {
        const route = moveRoute(cue)
        if (route.length < 2) route.push(route[0])
        const travel = progress * (route.length - 1)
        walkPhase = (travel * WALK_CYCLES_PER_CELL) % 1
        const index = Math.min(route.length - 2, Math.floor(travel))
        const from = route[index], to = route[index + 1]
        const x = from.x + (to.x - from.x) * (travel - index), y = from.y + (to.y - from.y) * (travel - index)
        const actor = actorAt(cue.actorId)
        view.root.visible = revealedAt(current.map, Math.floor(x), Math.floor(y))
          && (!actor || actorPresentationSize(current.map, actor, { x, y }) === actorFootprintSize(actor))
        const center = actor ? actorPresentationCenter(current.map, actor, { x, y }) : { x: x + .5, y: y + .5 }
        const fromHeight = actor ? actorGround(current.map, actor, { ...actor, ...from }) : terrainHeightAt(current.map, from.x, from.y)
        const toHeight = actor ? actorGround(current.map, actor, { ...actor, ...to }) : terrainHeightAt(current.map, to.x, to.y)
        view.root.position.set(center.x, fromHeight + (toHeight - fromHeight) * (travel - index), center.y)
        if (to.x !== from.x || to.y !== from.y) face(view.root, Math.atan2(to.x - from.x, to.y - from.y))
      } else if (cue.kind === 'channel' && cue.channelType === 'teleport' && view && current.map) {
        const position = reduced || progress >= .6 ? cue.position : cue.from
        view.root.visible = Boolean(position && (reduced || progress < .4 || progress >= .6) && revealedAt(current.map, position.x, position.y))
        if (position) {
          const actor = actorAt(cue.actorId)
          const center = actor ? actorPresentationCenter(current.map, actor, position) : { x: position.x + .5, y: position.y + .5 }
          view.root.position.set(center.x, actor ? actorGround(current.map, actor, position) : terrainHeightAt(current.map, position.x, position.y), center.y)
        }
      } else if (!reduced && cue.kind === 'strike' && view) {
        const from = cue.from ?? actorAt(cue.actorId), to = cue.to ?? actorAt(cue.targetId)
        if (from && to) {
          const actor = actorAt(cue.actorId), target = actorAt(cue.targetId)
          const sourceCenter = actor ? actorPresentationCenter(current.map, actor, from) : { x: from.x + .5, y: from.y + .5 }
          const targetCenter = target ? actorPresentationCenter(current.map, target, to) : { x: to.x + .5, y: to.y + .5 }
          const dx = targetCenter.x - sourceCenter.x, dy = targetCenter.y - sourceCenter.y
          const length = Math.max(1, Math.hypot(dx, dy))
          const lunge = strikeUsesProjectile(cue) ? 0 : Math.sin(strikeMotionProgress(cue, progress) * Math.PI) * .23
          view.root.visible = Boolean(current.map && revealedAt(current.map, from.x, from.y))
            && (!actor || actorPresentationSize(current.map, actor, from) === actorFootprintSize(actor))
          view.root.position.set(sourceCenter.x + dx / length * lunge, actor ? actorGround(current.map, actor, { ...actor, ...from }) : terrainHeightAt(current.map, from.x, from.y), sourceCenter.y + dy / length * lunge)
          if (dx || dy) face(view.root, Math.atan2(dx, dy))
        }
      }
      const pose = poseForCue(cue)
      const animatedId = 'actorId' in cue ? cue.actorId : 'targetId' in cue ? cue.targetId : ''
      if (!reduced && pose) actorViews.get(animatedId)?.model.setPose(pose, walkPhase ?? progress)
      if (!reduced && cue.kind === 'strike' && cue.hit && progress >= strikeImpactProgress(cue)) {
        const impact = strikeImpactProgress(cue)
        actorViews.get(cue.targetId)?.model.setPose('hit', Math.min(1, (progress - impact) / (1 - impact)))
      }
      active.effect?.update(progress)
      applyEffectLights(active.effect?.group)
      const board = boardScene(spell.canvas), context = spell.canvas.getContext('2d')
      if (board && context) {
        context.clearRect(0, 0, spell.canvas.width, spell.canvas.height)
        if (isSpellAnimationCue(cue)) drawBoardEffects(context, board, [createSpellEffectRenderer({ cue, progress, actors: current.animationActors ?? [], reducedMotion: reduced, detail: cue.detail ?? 'full' })])
        spell.texture.needsUpdate = true
      }
      const resultActor = 'targetId' in cue && cue.targetId ? actorAt(cue.targetId) : 'actorId' in cue ? actorAt(cue.actorId) : null
      const message = cue.kind === 'impact' ? cue.tone === 'miss' ? 'Промах' : cue.amount == null ? '' : `${cue.tone === 'healing' ? '+' : '−'}${cue.amount}`
        : cue.kind === 'strike' ? progress < strikeImpactProgress(cue) ? '' : attackOutcome(cue) === 'blocked' ? 'Перехвачено' : !cue.hit ? 'Промах' : `${cue.critical ? 'Крит! ' : ''}${cue.amount == null ? '' : `−${cue.amount}`}`
          : cue.kind === 'channel' && cue.amount != null ? `+${cue.amount}` : cue.kind === 'condition' ? cue.label : ''
      floating.textContent = message
      if (resultActor && current.map && revealedAt(current.map, resultActor.x, resultActor.y)) {
        // Цифра стоит над тем местом, где фигурка видна сейчас, а не над
        // клеткой из снимка, куда она ещё только придёт.
        const resultView = actorViews.get(resultActor.id)
        const center = resultView ? { x: resultView.root.position.x, y: resultView.root.position.z } : actorPresentationCenter(current.map, resultActor)
        const ground = resultView ? resultView.root.position.y : actorGround(current.map, resultActor)
        const height = resultView?.model.modelHeight ?? 1.25
        const screen = pointOnScreen(new THREE.Vector3(center.x, ground + height + .55 + progress * .5, center.y))
        floating.style.left = `${screen.x}px`; floating.style.top = `${screen.y}px`
        floating.style.opacity = String(Math.min(1, (1 - progress) * 4))
      } else floating.textContent = ''
      if (progress >= 1) {
        active.effect?.dispose()
        active = null
        applyEffectLights(null)
        restoreActors()
        floating.textContent = ''
        context?.clearRect(0, 0, spell.canvas.width, spell.canvas.height)
        spell.texture.needsUpdate = true
        if (!pending.length) setPlaying(false)
      }
    }
    function render(now: number) {
      frameId = 0
      if (disposed || document.hidden) return
      const frameStarted = performance.now()
      try {
        const delta = Math.min(.05, (now - previousTime) / 1000 || 0)
        const motionAllowed = latest.current.animationsEnabled !== false
          && !(active ? combatAnimationUsesReducedMotion(active.cue) : systemPrefersReducedMotion())
        animate(now)
        if (motionAllowed) terrain?.animate(now)
        if (motionAllowed) {
          const cue = latest.current.animationsEnabled === false ? undefined : active?.cue
          for (const [id, actor] of actorViews) {
            if (BOARD3D_QUALITY[settings.current.quality].idle || (cue && (
              ('actorId' in cue && cue.actorId === id) || ('targetId' in cue && cue.targetId === id)
              || ('targetIds' in cue && cue.targetIds?.includes(id))
            ))) actor.model.update(delta)
          }
        }
        if (previousTime && now - previousTime < 250) frameSamples.push(now - previousTime)
        previousTime = now
        controls.update()
        if (labelsDirty || active?.cue.kind === 'move' || active?.cue.kind === 'strike') drawLabels()
        pipeline.render()
        trackPointShadowDisposal()
        renderedFrames += 1
        renderer.domElement.dataset.frames = String(renderedFrames)
        measuredFrames += 1
        const renderMs = performance.now() - frameStarted
        measuredRenderMs += renderMs
        renderSamples.push(renderMs)
        if (renderSamples.length > 240) renderSamples.shift()
        if (frameSamples.length > 240) frameSamples.shift()
        if (now - measuredSince >= 1000) {
          // Диагностика остаётся в DOM-атрибутах, не загромождая игровой экран.
          renderer.domElement.dataset.fps = (measuredFrames * 1000 / (now - measuredSince)).toFixed(1)
          if (fpsOutput.current) fpsOutput.current.textContent = `${Math.round(measuredFrames * 1000 / (now - measuredSince))} FPS`
          renderer.domElement.dataset.renderMs = (measuredRenderMs / measuredFrames).toFixed(1)
          const percentile = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * .95)].toFixed(2) : ''
          renderer.domElement.dataset.renderP95Ms = percentile(renderSamples)
          renderer.domElement.dataset.frameP95Ms = percentile(frameSamples)
          renderer.domElement.dataset.drawCalls = String(renderer.info.render.calls)
          renderer.domElement.dataset.triangles = String(renderer.info.render.triangles)
          renderer.domElement.dataset.memoryGeometries = String(renderer.info.memory.geometries)
          renderer.domElement.dataset.memoryTextures = String(renderer.info.memory.textures)
          renderer.domElement.dataset.queueLength = String(pending.length + (active ? 1 : 0))
          publishModelDiagnostics()
          // Медиана интервала между кадрами непрерывной отрисовки (анимация,
          // камера): простой без движения сюда не попадает и за тормоза не идёт.
          if (autoQuality.current && frameSamples.length >= 30) {
            const median = [...frameSamples].sort((a, b) => a - b)[Math.floor(frameSamples.length / 2)]
            const current = settings.current.quality
            const next: Board3DQuality | null = current === 'high' ? 'balanced' : current === 'balanced' ? 'low' : null
            if (median > AUTO_QUALITY_FRAME_MS && next) {
              lowerQuality.current(next)
              frameSamples.length = 0
              renderer.domElement.dataset.autoQuality = next
            }
          }
          measuredFrames = 0; measuredRenderMs = 0; measuredSince = now
        }
        if (active || pending.length) invalidate()
        // Движение следует частоте экрана без искусственной паузы между кадрами.
        // При reduced motion, выключенных анимациях и скрытой вкладке цикл спит.
        else if (fpsEnabled.current || (motionAllowed && BOARD3D_QUALITY[settings.current.quality].idle
          && (terrain?.animated || [...actorViews.values()].some((actor) => !actor.defeated && actor.model.source === 'glb' && actor.model.idle)))) {
          invalidate()
        }
      } catch {
        latest.current.onUnavailable('Не удалось отрисовать 3D-карту.')
      }
    }
    function reset() {
      const map = latest.current.map
      if (!map) return
      const points: Array<{ x: number; y: number }> = []
      for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (revealedAt(map, x, y)) points.push({ x, y })
      if (!points.length) points.push({ x: 0, y: 0 })
      const minX = Math.min(...points.map((point) => point.x)), maxX = Math.max(...points.map((point) => point.x))
      const minY = Math.min(...points.map((point) => point.y)), maxY = Math.max(...points.map((point) => point.y))
      const heights = visibleTerrainHeightRange(map)
      controls.target.set((minX + maxX + 1) / 2, (heights.min + heights.max) / 2, (minY + maxY + 1) / 2)
      const distance = Math.max(maxX - minX + 1, maxY - minY + 1, heights.max - heights.min + 2) * 2 + 30
      camera.position.copy(controls.target).add(new THREE.Vector3(10, 17, 13).normalize().multiplyScalar(distance))
      camera.far = Math.max(500, distance * 4)
      camera.updateProjectionMatrix()
      controls.update()
      camera.zoom = boardCameraFitZoom(camera, { minX, minY, maxX, maxY }, element.clientWidth, element.clientHeight, heights)
      camera.updateProjectionMatrix()
      controls.update()
      invalidate()
    }
    let lastCatalog = settings.current.catalog
    let lastQuality = ''
    function sync() {
      const current = latest.current, map = current.map
      if (!map || disposed) return
      labelsDirty = true
      const qualityKey = settings.current.quality, profile = BOARD3D_QUALITY[qualityKey]
      const qualityChanged = lastQuality !== qualityKey
      if (qualityChanged) {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.maxDpr))
        // Карта теней пересоздаётся под новый размер при следующем кадре.
        sun.shadow.mapSize.set(profile.shadowSize, profile.shadowSize)
        sun.shadow.dispose(); sun.shadow.map = null; sun.shadow.mapPass = null
        pipeline.configure({ ambientOcclusion: profile.ambientOcclusion, ambientOcclusionScale: profile.ambientOcclusionScale, bloom: profile.bloom, tiltShift: profile.tiltShift })
        pipeline.refresh()
        lastQuality = qualityKey
        measuredFrames = 0; measuredRenderMs = 0; measuredSince = performance.now()
        renderSamples = []; frameSamples = []; previousTime = 0
        renderer.domElement.dataset.quality = qualityKey
        renderer.domElement.dataset.pixelRatio = String(renderer.getPixelRatio())
        resize()
      }
      renderer.shadowMap.enabled = current.lighting !== false && profile.shadows
      const style = `${current.lighting}:${current.artUrl}:${current.artMode}:${current.themeKey}:${profile.pointLightShadows}:${pipeline.active}:${profile.detail}`
      const signatures = mapSignaturesFor(map)
      const referenceSame = lastMap === map
      const contentChanged = Boolean(terrainSignature && terrainSignature !== signatures.staticKey)
      if (referenceSame) diagnostics.referenceSame += 1
      if (contentChanged) diagnostics.contentChanged += 1
      lastMap = map
      const mapChanged = terrainSignature !== signatures.staticKey
      const styleChanged = terrainStyle !== style
      // Смена качества эффекта не требует пересборки неподвижного окружения.
      // Свежая проекция также обновляет маску уже начатого действия.
      if (active && (mapChanged || styleChanged || qualityChanged)) {
        active.effect?.dispose()
        active.cue = cueForQuality(active.cue, qualityKey)
        active.effect = current.animationsEnabled === false || combatAnimationUsesReducedMotion(active.cue) ? null : createSpellEffect3D(active.cue, current.animationActors ?? [], map)
          ?? createCombatEffect3D(active.cue, current.animationActors ?? [], map)
        if (active.effect) scene.add(active.effect.group)
      }
      if (mapChanged || styleChanged) {
        const preparedAt = performance.now()
        const css = getComputedStyle(element)
        palette = boardPaletteFrom((name) => css.getPropertyValue(name))
        if (terrain) { terrain.dispose(); diagnostics.disposed += 1 }
        // Сумрак карты: в подземелье солнце гаснет, огни берут своё.
        const darkness = current.lighting === false ? 0 : boardDarkness(map, (x, y) => cellAt(map, x, y))
        const ambience = lightingForDarkness(darkness)
        sun.intensity = ambience.sun
        hemisphere.intensity = ambience.hemisphere
        hemisphere.color.set(ambience.hemisphereSky)
        scene.environmentIntensity = ambience.environment
        renderer.toneMappingExposure = ambience.exposure
        renderer.domElement.dataset.darkness = darkness.toFixed(2)
        renderer.domElement.dataset.sunIntensity = sun.intensity.toFixed(2)
        // Фон — в тон окрестностям места: лес, луг, горы или толща камня.
        const [backdropCenter, backdropEdge] = surroundingsBackdrop(map)
        if (backdropKey !== `${backdropCenter}${backdropEdge}`) {
          const next = createBoardBackdropTexture(backdropCenter, backdropEdge)
          if (next) {
            backdrop?.dispose()
            backdrop = next
            scene.background = next
            backdropKey = `${backdropCenter}${backdropEdge}`
          }
        }
        terrain = createBoard3DScene(map, { palette, lighting: current.lighting, pointLightShadows: profile.pointLightShadows, roofMode: settings.current.roofMode, artUrl: current.artUrl, artMode: current.artMode, artOverlayOpacity: pipeline.active ? BOARD3D_LIGHTING.linearArtOverlayOpacity : undefined, landscapeDetail: profile.detail, darkness, floorParallax: profile.detail !== 'minimal', onReady: invalidate })
        diagnostics.created += 1
        diagnostics.rebuilds += 1
        diagnostics.rebuildReason = !terrainSignature ? 'initial' : mapChanged ? 'content-changed' : 'style-changed'
        diagnostics.syncReason = !terrainSignature ? 'initial' : mapChanged ? 'content-changed' : 'style-changed'
        diagnostics.prepMs = performance.now() - preparedAt
        scene.add(terrain.group)
        if (mapChanged) {
          const heights = visibleTerrainHeightRange(map)
          const bounds = { minX: 0, minZ: 0, maxX: map.width, maxZ: map.height, minY: heights.min, maxY: heights.max + 2 }
          fitSunShadow(sun, bounds)
          pipeline.setSceneBounds(bounds)
        }
        terrainSignature = signatures.staticKey; terrainStyle = style
      } else diagnostics.syncReason = referenceSame ? 'reference-same' : 'content-same'
      terrain?.setRoofMode(settings.current.roofMode)
      sun.castShadow = current.lighting !== false && profile.shadows
      const catalogChanged = lastCatalog !== settings.current.catalog
      lastCatalog = settings.current.catalog
      const visibleActors = (current.animationActors ?? []).filter((actor) => revealedAt(map, actor.x, actor.y))
      for (const [id, view] of actorViews) if (!visibleActors.some((actor) => actor.id === id) || catalogChanged) {
        disposeActorView(id, view)
      }
      for (const actor of visibleActors) {
        const modelKey = settings.current.models[actor.id] ?? actor.modelKey
        const side = actorPresentationSize(map, actor)
        const key = `${modelKey}:${actor.appearance?.version ?? ''}:${actor.appearance?.profile ?? ''}:${actor.archetype}:${actor.kind}:${actor.label}:${actor.color}:${side}`
        let view = actorViews.get(actor.id)
        if (view && view.key !== key) {
          disposeActorView(actor.id, view); view = undefined
        }
        if (!view) {
          const input = { ...actor, modelKey }
          const height = actorHeight(map, input, settings.current.catalog)
          const model = createProceduralActorModel(input, settings.current.catalog, height)
          model.onEquipmentChange = invalidate
          const cue = latest.current.animationsEnabled === false ? undefined : active?.cue
          if (cue?.kind === 'strike' && cue.actorId === actor.id) applyStrikeAppearance(model, cue)
          const root = new THREE.Group()
          root.add(model)
          const ring = new THREE.Mesh(new THREE.RingGeometry(.405 * side - .035, .405 * side, 40), new THREE.MeshBasicMaterial({ color: actor.color ?? '#e2bb72', transparent: true, opacity: .85, side: THREE.DoubleSide }))
          ring.rotation.x = -Math.PI / 2; ring.position.y = .045
          root.add(ring); scene.add(root)
          view = { root, model, ring, key, defeated: Boolean(actor.defeated), abort: new AbortController() }; actorViews.set(actor.id, view)
          diagnostics.created += 1
          const entry = resolveModelProfile(input, settings.current.catalog)
          if (entry.url) {
            const expected = view
            void createActorModel(input, { manifest: settings.current.catalog, height, signal: AbortSignal.any([sceneAbort.signal, view.abort.signal]) }).then((loaded) => {
              diagnostics.created += 1
              if (disposed || actorViews.get(actor.id) !== expected) { loaded.dispose(); diagnostics.disposed += 1; return }
              root.remove(expected.model); expected.model.dispose(); diagnostics.disposed += 1
              expected.model = loaded; root.add(loaded)
              loaded.onEquipmentChange = invalidate
              labelsDirty = true
              const currentActor = latest.current.animationActors?.find((item) => item.id === actor.id)
              const cue = latest.current.animationsEnabled === false ? undefined : active?.cue
              const defeated = currentActor?.defeated
              const acting = cueActsOnActor(cue, actor.id)
              const targetStrike = cue?.kind === 'strike' && cue.targetId === actor.id ? cue : undefined
              const targetImpact = cue?.kind === 'impact' && cue.targetId === actor.id ? cue : undefined
              const progress = active ? Math.min(1, (performance.now() - active.started) / Math.max(1, active.cue.durationMs)) : 0
              const deferDeath = Boolean(latest.current.animationsEnabled !== false && defeated && shouldDeferDefeat(actor.id, cue, pending))
              if (acting && cue?.kind === 'strike') applyStrikeAppearance(loaded, cue)
              else loaded.setAppearance(currentActor?.appearance)
              if (targetStrike) {
                const impact = strikeImpactProgress(targetStrike)
                const hit = targetStrike.hit && progress >= impact
                loaded.setPose(hit ? 'hit' : 'idle', hit ? Math.min(1, (progress - impact) / (1 - impact)) : 0)
              } else if (targetImpact) {
                loaded.setPose('hit', progress)
              } else if (deferDeath) {
                loaded.setPose('idle', 0)
              } else if (cue && acting) {
                loaded.setPose(poseForCue(cue) ?? 'idle', active ? progress : undefined)
              } else {
                loaded.setPose(defeated ? 'death' : 'idle', defeated ? 1 : undefined)
              }
              loaded.update(.001)
              if (loaded.source !== 'glb') setModelWarning(`Модель «${entry.name_ru ?? entry.key}» недоступна. Используется встроенная фигурка.`)
              invalidate()
            }).catch(() => { /* Отмена при уходе с карты не является ошибкой игрока. */ })
          }
        }
        if (current.animationsEnabled === false || !(active?.cue.kind === 'strike' && active.cue.actorId === actor.id)) view.model.setAppearance(actor.appearance)
        view.root.visible = true
        if (actor.defeated || view.defeated !== Boolean(actor.defeated)) {
          view.model.setPose(actor.defeated ? 'death' : 'idle', actor.defeated ? 1 : undefined)
          view.model.update(.001)
        }
        view.defeated = Boolean(actor.defeated)
      }
      for (const layer of [overlay, spell]) {
        if (layer.geometryKey !== signatures.geometryKey) {
          layer.mesh.geometry.dispose()
          diagnostics.disposed += 1
          layer.mesh.geometry = createTerrainSurfaceGeometry(map)
          layer.geometryKey = signatures.geometryKey
          diagnostics.created += 1
        }
      }
      const fresh: CombatAnimationCue[] = []
      if (current.visualBatch && current.visualBatch.id !== knownBatch) {
        knownBatch = current.visualBatch.id
        fresh.push(...combatAnimationCuesFromEvents(current.visualBatch.events))
      }
      fresh.push(...combatAnimationCuesFromBattleLog(current.battleLog ?? []))
      const unseen = fresh.filter((cue) => { if (seen.has(cue.id)) return false; seen.add(cue.id); return true })
      if (seen.size > 1500) { const recent = [...seen].slice(-750); seen.clear(); recent.forEach((id) => seen.add(id)) }
      if (document.hidden || (current.animationsEnabled === false && (!current.combatAudio || current.combatAudio.getSettings().muted))) skip()
      else if (unseen.length) { pending = [...pending, ...unseen].slice(-COMBAT_ANIMATION_QUEUE_LIMIT); setPlaying(true) }
      // Позиции ставятся после постановки новых реплик: фигурка, чей ход ещё
      // в очереди, ждёт на старте, а не в конечной клетке снимка.
      for (const actor of visibleActors) {
        const view = actorViews.get(actor.id)
        const animating = current.animationsEnabled !== false && active && 'actorId' in active.cue && active.cue.actorId === actor.id
        if (view && !animating) placeActor(actor, view)
      }
      deferQueuedDefeats()
      paintOverlay()
      paintTargetPreview()
      publishDiagnostics(map.catalogRevision ?? LEGACY_CATALOG_REVISION)
      invalidate()
    }
    function resize() {
      labelsDirty = true
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight)
      renderer.setSize(width, height, false)
      pipeline.setSize(width, height)
      const aspect = width / height
      camera.left = -7 * aspect; camera.right = 7 * aspect; camera.top = 7; camera.bottom = -7
      camera.updateProjectionMatrix()
      if (latest.current.map && shouldInitialFitBoardCamera(width, height, initialCameraFit, Boolean(saved))) {
        // Первый ResizeObserver часто приходит после создания canvas. Только
        // переход из нулевого layout в настоящий выполняет fit; дальнейшие
        // изменения размера сохраняют панораму и zoom игрока.
        initialCameraFit = true
        reset()
      }
      invalidate()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    const pointerRay = (event: PointerEvent | MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      cursor.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
      raycaster.setFromCamera(cursor, camera)
      return raycaster.ray
    }
    const pointerCell = (event: PointerEvent | MouseEvent) => {
      pointerRay(event)
      const ground = terrain?.group.getObjectByName('ground-plane')
      if (ground) ground.updateWorldMatrix(true, false)
      const point = (ground ? raycaster.intersectObject(ground, false)[0]?.point : null)
        ?? raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3())
      if (!point || !latest.current.map) return null
      const cell = { x: Math.floor(point.x), y: Math.floor(point.z) }
      // В исследовании общий обработчик может разрешить шаг в ещё не
      // раскрытую клетку. Туман ограничивает рисунок, а не подменяет команду.
      return cellAt(latest.current.map, cell.x, cell.y) ? cell : null
    }
    const actorAtPointer = () => {
      const map = latest.current.map
      if (!map) return null
      let selected: { id: string; distance: number } | null = null
      const point = new THREE.Vector3()
      for (const [id, view] of actorViews) {
        const actor = latest.current.animationActors?.find((candidate) => candidate.id === id)
        if (!actor || !view.root.visible || !revealedAt(map, actor.x, actor.y)) continue
        const bounds = new THREE.Box3().setFromObject(view.root)
        const side = actorPresentationSize(map, actor)
        if (side > 1) {
          // Углы занятого квадрата выбирают ту же цель, даже если сама фигура
          // уже площади. Высота бокса остаётся высотой видимой модели.
          const center = view.root.position
          bounds.min.x = Math.min(bounds.min.x, center.x - side / 2)
          bounds.max.x = Math.max(bounds.max.x, center.x + side / 2)
          bounds.min.z = Math.min(bounds.min.z, center.z - side / 2)
          bounds.max.z = Math.max(bounds.max.z, center.z + side / 2)
        }
        const hit = raycaster.ray.intersectBox(bounds, point)
        if (!hit) continue
        const distance = raycaster.ray.origin.distanceToSquared(hit)
        if (!selected || distance < selected.distance) selected = { id, distance }
      }
      return selected?.id ?? null
    }
    const propAtPointer = () => nearestPropPickTarget(raycaster.ray, terrain?.getPropPickTargets() ?? [])?.propId ?? null
    const activateActor = (actorId: string) => {
      const node = [...element.querySelectorAll<HTMLElement>('[data-actor-id]')]
        .find((candidate) => candidate.dataset.actorId === actorId)
      if (node) { node.click(); return }
      latest.current.onActorActivate?.(actorId)
    }
    function hover(x: number, y: number) {
      const key = `${x},${y}`
      if (key === hoverKey) return
      const cells = latest.current.cells
      cells.find((node) => `${node.x},${node.y}` === hoverKey)?.onPointerLeave?.()
      hoverKey = key
      latest.current.onCellHover?.(x >= 0 && y >= 0 ? { x, y } : null)
      const node = cells.find((entry) => entry.x === x && entry.y === y)
      node?.onPointerEnter?.()
      renderer.domElement.title = node?.title ?? latest.current.cellHints?.get(key)?.title ?? ''
      renderer.domElement.setAttribute('aria-label', node?.ariaLabel ?? latest.current.cellHints?.get(key)?.ariaLabel ?? 'Поле боя 3D. Стрелки выбирают клетку, Enter подтверждает.')
      paintOverlay(); invalidate()
    }
    let down: { x: number; y: number; button: number; moved: boolean } | null = null
    const pointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY, button: event.button, moved: false } }
    const pointerMove = (event: PointerEvent) => {
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) down.moved = true
      if (down?.moved) return
      pointerRay(event)
      const actorId = actorAtPointer()
      if (actorId) {
        const actor = latest.current.animationActors?.find((candidate) => candidate.id === actorId)
        if (actor) { hover(actor.x, actor.y); return }
      }
      const cell = pointerCell(event)
      hover(cell?.x ?? -1, cell?.y ?? -1)
    }
    const click = (event: MouseEvent) => {
      if (down?.moved || (down && down.button !== 0)) { down = null; return }
      down = null
      if (active && latest.current.animationsEnabled !== false) {
        skip()
        // Щелчок по пустой клетке в бою — ещё и выбор клетки (см. passClickThroughAnimation).
        if (!latest.current.passClickThroughAnimation) return
        pointerRay(event)
        if (actorAtPointer() || propAtPointer()) return
      }
      pointerRay(event)
      const actorId = actorAtPointer()
      if (actorId) { activateActor(actorId); return }
      const propId = propAtPointer()
      if (propId && latest.current.onPropActivate) { latest.current.onPropActivate(propId); return }
      const cell = pointerCell(event)
      latest.current.onBackgroundActivate?.()
      if (cell) latest.current.cells.find((node) => node.x === cell.x && node.y === cell.y && node.interactive)?.onActivate?.()
    }
    const keyDown = (event: KeyboardEvent) => {
      const directions: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }
      if (directions[event.key]) {
        event.preventDefault()
        const [x, y] = directions[event.key]
        const map = latest.current.map
        keyboardCell = { x: THREE.MathUtils.clamp(keyboardCell.x + x, 0, (map?.width ?? 1) - 1), y: THREE.MathUtils.clamp(keyboardCell.y + y, 0, (map?.height ?? 1) - 1) }
        if (map && cellAt(map, keyboardCell.x, keyboardCell.y)) hover(keyboardCell.x, keyboardCell.y)
        else hover(-1, -1)
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        if (event.key === 'Enter' && latest.current.onConfirmAiming) {
          latest.current.onConfirmAiming()
          return
        }
        const node = latest.current.cells.find((entry) => `${entry.x},${entry.y}` === hoverKey && entry.interactive)
        const [x, y] = hoverKey.split(',').map(Number)
        const actor = latest.current.animationActors?.find((candidate) => {
          const size = actorPresentationSize(latest.current.map, candidate)
          return !candidate.defeated && x >= candidate.x && x < candidate.x + size && y >= candidate.y && y < candidate.y + size
        })
        if (active && latest.current.animationsEnabled !== false) skip()
        else if (actor && latest.current.map && revealedAt(latest.current.map, x, y)) activateActor(actor.id)
        else node?.onActivate?.()
      } else if (event.key === 'Escape') skip()
    }
    const leave = () => { hover(-1, -1) }
    const contextMenu = (event: Event) => {
      event.preventDefault()
      if (!down?.moved) latest.current.onCancelAiming?.()
    }
    const wheelGuard = (event: WheelEvent) => { controls.enableZoom = !latest.current.wheelZoomRequiresAltKey || event.altKey }
    const visibility = () => {
      measuredFrames = 0; measuredRenderMs = 0; measuredSince = performance.now()
      skip(); sync()
    }
    const contextLost = (event: Event) => { event.preventDefault(); latest.current.onUnavailable('Соединение с 3D-графикой потеряно.') }
    renderer.domElement.addEventListener('pointerdown', pointerDown)
    renderer.domElement.addEventListener('pointermove', pointerMove)
    renderer.domElement.addEventListener('pointerleave', leave)
    renderer.domElement.addEventListener('click', click)
    renderer.domElement.addEventListener('keydown', keyDown)
    renderer.domElement.addEventListener('contextmenu', contextMenu)
    renderer.domElement.addEventListener('wheel', wheelGuard, { capture: true, passive: true })
    renderer.domElement.addEventListener('webglcontextlost', contextLost)
    document.addEventListener('visibilitychange', visibility)
    const cameraChanged = () => { labelsDirty = true; invalidate() }
    controls.addEventListener('change', cameraChanged)
    runtime.current = { sync, refresh: invalidate, skip, reset,
      turn(angle) { camera.position.sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).add(controls.target); controls.update(); invalidate() },
      zoom(factor) { labelsDirty = true; camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom); camera.updateProjectionMatrix(); invalidate() },
      focus(x, y, onlyIfHidden) {
        if (onlyIfHidden) {
          const onScreen = new THREE.Vector3(x + .5, controls.target.y, y + .5).project(camera)
          if (Math.abs(onScreen.x) < .6 && Math.abs(onScreen.y) < .6) return
        }
        const shift = new THREE.Vector3(x + .5 - controls.target.x, 0, y + .5 - controls.target.z); controls.target.add(shift); camera.position.add(shift); controls.update(); labelsDirty = true; invalidate() },
    }
    resize()
    if (saved) { camera.position.copy(saved.position); camera.zoom = saved.zoom; controls.target.copy(saved.target); camera.updateProjectionMatrix(); controls.update() }
    const first = latest.current.animationActors?.find((actor) => latest.current.map && revealedAt(latest.current.map, actor.x, actor.y))
    if (first) keyboardCell = { x: first.x, y: first.y }
    try { sync() } catch { latest.current.onUnavailable('Не удалось подготовить 3D-карту.') }
    return () => {
      disposed = true
      sceneAbort.abort()
      if (frameId) cancelAnimationFrame(frameId)
      if (initialCameraFit) cameras.set(cameraKey, { position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom })
      else cameras.delete(cameraKey)
      if (cameras.size > 100) cameras.delete(cameras.keys().next().value!)
      runtime.current = null
      latest.current.combatAudio?.cancel()
      observer.disconnect(); controls.dispose()
      document.removeEventListener('visibilitychange', visibility)
      renderer.domElement.removeEventListener('webglcontextlost', contextLost)
      active?.effect?.dispose()
      if (terrain) { terrain.dispose(); diagnostics.disposed += 1 }
      for (const [id, view] of actorViews) disposeActorView(id, view)
      clearTargetPreview()
      diagnostics.disposed += 2
      overlay.dispose(); spell.dispose(); sun.shadow.dispose()
      pipeline.dispose(); environment?.dispose(); backdrop?.dispose()
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); floating.remove()
    }
  }, [cameraKey, props.onUnavailable])

  useEffect(() => { runtime.current?.sync() }, [props, models, catalog, quality, roofMode])
  useEffect(() => { if (props.viewResetKey !== undefined) runtime.current?.reset() }, [props.viewResetKey])
  useEffect(() => { if (props.focusRequest) runtime.current?.focus(props.focusRequest.x, props.focusRequest.y, props.focusRequest.onlyIfHidden) }, [props.focusRequest])
  const chooseModel = (value: string) => {
    const next = { ...models }
    if (value) next[selectedModelActor] = value; else delete next[selectedModelActor]
    setModels(next)
    try { localStorage.setItem(modelStorageKey, JSON.stringify(next)) } catch { /* Выбор работает и без сохранения. */ }
  }
  return <div className="board3d" ref={host} data-animation-playing={props.animationsEnabled !== false && playing} role="group" aria-label="Тактическая карта 3D" onContextMenu={(event) => {
    if (props.onCancelAiming && !(event.target as HTMLElement).closest('canvas')) { event.preventDefault(); props.onCancelAiming() }
  }} onClickCapture={(event) => {
    if (props.animationsEnabled !== false && playing && (event.target as HTMLElement).closest('.board3d-labels')) { event.preventDefault(); event.stopPropagation(); runtime.current?.skip() }
  }}>
    <div className="board3d-tools" role="group" aria-label="Камера 3D">
      <button type="button" onClick={() => runtime.current?.turn(-Math.PI / 4)} aria-label="Повернуть камеру влево">↶</button>
      <button type="button" onClick={() => runtime.current?.turn(Math.PI / 4)} aria-label="Повернуть камеру вправо">↷</button>
      <button type="button" onClick={() => runtime.current?.zoom(1.25)} aria-label="Приблизить карту">+</button>
      <button type="button" onClick={() => runtime.current?.zoom(.8)} aria-label="Отдалить карту">−</button>
      <button type="button" onClick={() => runtime.current?.reset()}>Вся карта</button>
      <button type="button" aria-label="Показывать FPS" aria-pressed={showFps} onClick={() => {
        const value = !showFps
        setShowFps(value)
        try { localStorage.setItem(FPS_STORAGE_KEY, String(value)) } catch { /* Счётчик работает без сохранения. */ }
      }}>FPS</button>
      <select className="board3d-quality" aria-label="Качество 3D" title="Качество 3D" value={quality} onChange={(event) => {
        const next = board3DQuality(event.target.value)
        // Выбор игрока сильнее автоснижения: дальше качество не трогаем.
        autoQuality.current = false
        setQualityNote('')
        setQuality(next)
        try { localStorage.setItem(QUALITY_STORAGE_KEY, next) } catch { /* Профиль работает без сохранения. */ }
      }}>{Object.entries(BOARD3D_QUALITY).map(([key, profile]) => <option key={key} value={key}>{profile.label}</option>)}</select>
      {qualityNote && <span className="board3d-quality-note" role="status">{qualityNote}</span>}
      <select className="board3d-roof-mode" aria-label="Крыша" title="Отображение крыши и сводов" value={roofMode} onChange={(event) => {
        const next = roofModeValue(event.target.value)
        setRoofMode(next)
        try { localStorage.setItem(ROOF_STORAGE_KEY, next) } catch { /* Режим работает без сохранения. */ }
      }}>
        <option value="cutaway">Срез крыши</option>
        <option value="full">Полная крыша</option>
        <option value="hidden">Без крыши</option>
      </select>
      <details className="board3d-models">
        <summary>Фигурки</summary>
        <div>
          <label>Участник<select aria-label="Участник для выбора фигурки" value={selectedModelActor} onChange={(event) => setModelActor(event.target.value)} disabled={!actors.length}>{actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.label}</option>)}</select></label>
          <label>Модель<select aria-label="Модель фигурки" value={models[selectedModelActor] ?? ''} onChange={(event) => chooseModel(event.target.value)} disabled={!actors.length}><option value="">По персонажу</option>{availableActorModels(catalog).map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
          <p>Внешний вид сохраняется в этом браузере.</p>
          {modelWarning && <p role="status">{modelWarning}</p>}
        </div>
      </details>
    </div>
    {showFps && <output className="board3d-fps" ref={fpsOutput} aria-label="Частота кадров" aria-live="off" title="Частота отрисовки 3D-карты">— FPS</output>}
    <div className="board3d-labels">
      {props.cells.filter((node) => props.map && revealedAt(props.map, node.x, node.y) && (node.hotspot || hasBoardContent(node.children))).map((node) => <div key={`${node.x},${node.y}`} data-board3d-cell={`${node.x},${node.y}`} className={`board3d-cell ${node.className}`} title={node.title}>
        {node.interactive && <button type="button" className="board3d-cell-action" tabIndex={-1} aria-label={node.ariaLabel} onClick={node.onActivate} />}
        {node.children}
        {node.hotspot && <div className="board3d-hotspot">{node.hotspot}</div>}
      </div>)}
    </div>
    {props.targetHint && <span ref={targetHintElement} className={`board-target-hint ${props.targetHint.tone}`} role="status">{props.targetHint.text}</span>}
    {props.movePreview?.risk && <span ref={moveRiskElement} className="move-risk-mark" aria-hidden="true" style={{ visibility: 'hidden' }}>!</span>}
    {props.movePreview?.label && props.movePreview.path.length > 0 && <span ref={moveLabelElement} className="move-preview-label" aria-hidden="true" style={{ visibility: 'hidden' }}>
      <strong>{props.movePreview.label.main}</strong>
      {props.movePreview.label.sub && <small>{props.movePreview.label.sub}</small>}
      {props.movePreview.label.note && <small>{props.movePreview.label.note}</small>}
      {props.movePreview.label.risk && <small className="risk">{props.movePreview.label.risk}</small>}
    </span>}
    {props.animationsEnabled !== false && playing && <button type="button" className="board3d-skip" onClick={() => runtime.current?.skip()}>Пропустить анимацию</button>}
    <p className="board3d-help">Перетащить — сдвиг · Правая кнопка — поворот · {props.wheelZoomRequiresAltKey ? 'Alt + колесо' : 'Колесо'} — масштаб</p>
  </div>
}
