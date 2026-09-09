import { Children, Fragment, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { BoardAnimationActor, TacticalBoardProps } from './TacticalBoard'
import { boardCameraKey } from './tactical-ui'
import { cellAt, revealedAt } from './tactical-map-client'
import { DEFAULT_BOARD_PALETTE, boardPaletteFrom, drawBoardEffects, drawBoardOverlay, type BoardScene } from './board-render'
import { COMBAT_ANIMATION_QUEUE_LIMIT, combatAnimationCuesFromBattleLog, combatAnimationCuesFromEvents, type CombatAnimationCue } from './combat-animation'
import { createSpellEffectRenderer, isSpellAnimationCue, systemPrefersReducedMotion } from './spell-effects'
import { createCombatEffect3D } from './board3d-effects'
import { createBoard3DScene } from './board3d-scene'
import { boardCameraFitZoom } from './board3d-camera'
import { createTerrainSurfaceGeometry, terrainHeightAt, visibleTerrainHeightRange } from './board3d-terrain'
import { createActorModel, createProceduralActorModel, loadActorModelManifest, availableActorModels, resolveModelProfile, DEFAULT_ACTOR_MODEL_MANIFEST, type ActorModel, type ActorModelManifest, type ActorPose } from './actor-models'

type Props = TacticalBoardProps & { onUnavailable: (message: string) => void }
type CameraState = { position: THREE.Vector3; target: THREE.Vector3; zoom: number }
const cameras = new Map<string, CameraState>()
const FPS_STORAGE_KEY = 'skazanie-3d-fps'

function hasBoardContent(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
    ? hasBoardContent(child.props.children)
    : child !== '')
}
type Runtime = {
  sync: () => void
  refresh: () => void
  skip: () => void
  reset: () => void
  turn: (angle: number) => void
  zoom: (factor: number) => void
}

function readModels(key: string): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([id, model]) => id.length < 200 && typeof model === 'string' && model.length < 120)) as Record<string, string>
      : {}
  } catch { return {} }
}

/** Только представление. Обработчики клеток и целей принадлежат общему DungeonMap. */
export default function TacticalBoard3D(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const runtime = useRef<Runtime | null>(null)
  const latest = useRef(props)
  latest.current = props
  const modelStorageKey = `skazanie-3d-models:${props.campaignId ?? ''}`
  const [models, setModels] = useState(() => readModels(modelStorageKey))
  const [catalog, setCatalog] = useState<ActorModelManifest>(DEFAULT_ACTOR_MODEL_MANIFEST)
  const settings = useRef({ models, catalog })
  settings.current = { models, catalog }
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
    const modelAbort = new AbortController()
    let disposed = false
    let frameId = 0
    let previousTime = 0
    let labelsDirty = true
    let measuredFrames = 0, measuredSince = performance.now(), measuredRenderMs = 0
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    } catch {
      latest.current.onUnavailable('Браузер не смог включить 3D-графику.')
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.35
    renderer.domElement.className = 'board3d-canvas'
    renderer.domElement.tabIndex = 0
    renderer.domElement.setAttribute('aria-label', 'Поле боя 3D. Стрелки выбирают клетку, Enter подтверждает. Перетаскивание двигает камеру, правая кнопка поворачивает.')
    element.prepend(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#191914')
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
    const hemisphere = new THREE.HemisphereLight('#e7e8de', '#51402b', 2.5)
    const sun = new THREE.DirectionalLight('#ffe7bd', 3)
    sun.position.set(-8, 18, 8)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = sun.shadow.camera.bottom = -22
    sun.shadow.camera.right = sun.shadow.camera.top = 22
    sun.shadow.camera.far = 90
    sun.shadow.normalBias = .025
    scene.add(hemisphere, sun, sun.target)
    const actorViews = new Map<string, { root: THREE.Group; model: ActorModel; key: string; defeated: boolean; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> }>()
    let terrain: ReturnType<typeof createBoard3DScene> | null = null
    let terrainMap: Props['map'] = null
    let terrainStyle = ''
    let palette = DEFAULT_BOARD_PALETTE
    let pending: CombatAnimationCue[] = []
    let active: { cue: CombatAnimationCue; started: number; effect: ReturnType<typeof createCombatEffect3D> | null } | null = null
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

    const makeLayer = (height: number) => {
      const canvas = document.createElement('canvas')
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.minFilter = THREE.LinearFilter
      texture.generateMipmaps = false
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 })
      const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>(new THREE.BufferGeometry(), material)
      mesh.position.y = height
      scene.add(mesh)
      return { canvas, texture, mesh, map: null as Props['map'], dispose() { texture.dispose(); material.dispose(); mesh.geometry.dispose() } }
    }
    const overlay = makeLayer(.022)
    const spell = makeLayer(.038)
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
        node.style.zIndex = String(20 + Math.round(screen.y))
      }
      const buttonsByActor = new Map([...element.querySelectorAll<HTMLElement>('[data-actor-id]')].map((node) => [node.dataset.actorId, node]))
      for (const [id, view] of actorViews) {
        const button = buttonsByActor.get(id)
        view.ring.material.color.set(button?.classList.contains('active-turn') || button?.classList.contains('selected') ? '#f2d489' : current.animationActors?.find((actor) => actor.id === id)?.color ?? '#9cafb0')
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
      for (const node of current.cells) {
        const classes = node.className.split(' ')
        const blast = classes.includes('blast-area')
        const route = classes.some((entry) => /^(move-path|route|pending-move|move-selected)/.test(entry))
        const reachable = classes.includes('reachable') || classes.includes('move-reachable')
        const hover = hoverKey === `${node.x},${node.y}`
        const selected = classes.some((entry) => ['command-center', 'scene-object-selected', 'loot-focused', 'move-target'].includes(entry))
        const danger = classes.includes('opportunity-risk') && (hover || route)
        if (!blast && !route && !reachable && !hover && !selected) continue
        context.fillStyle = blast || danger ? 'rgba(226,98,36,.48)' : route || selected ? 'rgba(228,191,100,.5)' : hover ? 'rgba(250,223,159,.3)' : 'rgba(194,169,103,.12)'
        context.fillRect(node.x * size + 1, node.y * size + 1, size - 2, size - 2)
        context.strokeStyle = blast || danger ? '#f6a05b' : '#e2c584'
        context.lineWidth = hover || route || selected ? 2 : 1
        context.strokeRect(node.x * size + 1, node.y * size + 1, size - 2, size - 2)
      }
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
    function invalidate() {
      if (!disposed && !frameId && !document.hidden) frameId = requestAnimationFrame(render)
    }
    function restoreActors() {
      labelsDirty = true
      for (const actor of latest.current.animationActors ?? []) {
        const view = actorViews.get(actor.id)
        if (!view) continue
        view.root.position.set(actor.x + .5, terrainHeightAt(latest.current.map, actor.x, actor.y), actor.y + .5)
        view.root.visible = true
        view.model.setPose(actor.defeated ? 'death' : 'idle', actor.defeated ? 1 : undefined)
        view.model.update(.001)
      }
    }
    function skip() {
      pending = []
      active?.effect?.dispose()
      active = null
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
        const cue = pending.shift()!
        active = { cue, started: now, effect: systemPrefersReducedMotion() ? null : createCombatEffect3D(cue, current.animationActors ?? [], current.map) }
        if (active.effect) scene.add(active.effect.group)
        const actorId = 'actorId' in cue ? cue.actorId : 'targetId' in cue ? cue.targetId : ''
        actorViews.get(actorId)?.model.setPose(cue.kind === 'move' ? 'walk' : cue.kind === 'strike' ? 'attack' : cue.kind === 'death' ? 'death' : isSpellAnimationCue(cue) ? 'cast' : 'hit', 0)
      }
      if (!active) return
      const { cue } = active
      const reduced = systemPrefersReducedMotion()
      const progress = Math.min(1, (now - active.started) / (reduced ? 120 : Math.max(1, cue.durationMs)))
      const actorAt = (id: string) => current.animationActors?.find((actor) => actor.id === id)
      const view = 'actorId' in cue ? actorViews.get(cue.actorId) : null
      if (!reduced && cue.kind === 'move' && view && current.map) {
        const route = [cue.from, ...cue.path, cue.to]
        const travel = progress * (route.length - 1)
        const index = Math.min(route.length - 2, Math.floor(travel))
        const from = route[index], to = route[index + 1]
        const x = from.x + (to.x - from.x) * (travel - index), y = from.y + (to.y - from.y) * (travel - index)
        view.root.visible = revealedAt(current.map, Math.floor(x), Math.floor(y))
        const fromHeight = terrainHeightAt(current.map, from.x, from.y), toHeight = terrainHeightAt(current.map, to.x, to.y)
        view.root.position.set(x + .5, fromHeight + (toHeight - fromHeight) * (travel - index), y + .5)
        if (to.x !== from.x || to.y !== from.y) view.root.rotation.y = Math.atan2(to.x - from.x, to.y - from.y)
      } else if (!reduced && cue.kind === 'strike' && view) {
        const from = actorAt(cue.actorId), to = actorAt(cue.targetId)
        if (from && to) {
          const length = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y))
          const lunge = Math.sin(progress * Math.PI) * .23
          view.root.position.set(from.x + .5 + (to.x - from.x) / length * lunge, terrainHeightAt(current.map, from.x, from.y), from.y + .5 + (to.y - from.y) / length * lunge)
          view.root.rotation.y = Math.atan2(to.x - from.x, to.y - from.y)
        }
      }
      const pose: ActorPose = cue.kind === 'move' ? 'walk' : cue.kind === 'strike' ? 'attack' : cue.kind === 'death' ? 'death' : isSpellAnimationCue(cue) ? 'cast' : 'hit'
      const animatedId = 'actorId' in cue ? cue.actorId : 'targetId' in cue ? cue.targetId : ''
      if (!reduced) actorViews.get(animatedId)?.model.setPose(pose, progress)
      if (!reduced && cue.kind === 'strike' && cue.hit && progress >= .3) {
        actorViews.get(cue.targetId)?.model.setPose('hit', Math.min(1, (progress - .3) / .7))
      }
      active.effect?.update(progress)
      const board = boardScene(spell.canvas), context = spell.canvas.getContext('2d')
      if (board && context) {
        context.clearRect(0, 0, spell.canvas.width, spell.canvas.height)
        if (isSpellAnimationCue(cue)) drawBoardEffects(context, board, [createSpellEffectRenderer({ cue, progress, actors: current.animationActors ?? [], reducedMotion: reduced, detail: 'full' })])
        spell.texture.needsUpdate = true
      }
      const resultActor = 'targetId' in cue && cue.targetId ? actorAt(cue.targetId) : 'actorId' in cue ? actorAt(cue.actorId) : null
      const message = cue.kind === 'impact' ? cue.tone === 'miss' ? 'Промах' : cue.amount == null ? '' : `${cue.tone === 'healing' ? '+' : '−'}${cue.amount}`
        : cue.kind === 'strike' ? !cue.hit ? 'Промах' : cue.amount == null ? '' : `−${cue.amount}`
          : cue.kind === 'channel' && cue.amount != null ? `+${cue.amount}` : cue.kind === 'condition' ? cue.label : ''
      floating.textContent = message
      if (resultActor && current.map && revealedAt(current.map, resultActor.x, resultActor.y)) {
        const screen = pointOnScreen(new THREE.Vector3(resultActor.x + .5, terrainHeightAt(current.map, resultActor.x, resultActor.y) + 1.8 + progress * .5, resultActor.y + .5))
        floating.style.left = `${screen.x}px`; floating.style.top = `${screen.y}px`
        floating.style.opacity = String(Math.min(1, (1 - progress) * 4))
      } else floating.textContent = ''
      if (progress >= 1) {
        active.effect?.dispose()
        active = null
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
        const motionAllowed = latest.current.animationsEnabled !== false && !systemPrefersReducedMotion()
        animate(now)
        if (motionAllowed) for (const actor of actorViews.values()) actor.model.update(delta)
        previousTime = now
        controls.update()
        if (labelsDirty || active?.cue.kind === 'move' || active?.cue.kind === 'strike') drawLabels()
        renderer.render(scene, camera)
        measuredFrames += 1
        measuredRenderMs += performance.now() - frameStarted
        if (now - measuredSince >= 1000) {
          // Диагностика остаётся в DOM-атрибутах, не загромождая игровой экран.
          renderer.domElement.dataset.fps = (measuredFrames * 1000 / (now - measuredSince)).toFixed(1)
          if (fpsOutput.current) fpsOutput.current.textContent = `${Math.round(measuredFrames * 1000 / (now - measuredSince))} FPS`
          renderer.domElement.dataset.renderMs = (measuredRenderMs / measuredFrames).toFixed(1)
          renderer.domElement.dataset.drawCalls = String(renderer.info.render.calls)
          renderer.domElement.dataset.triangles = String(renderer.info.render.triangles)
          measuredFrames = 0; measuredRenderMs = 0; measuredSince = now
        }
        if (active || pending.length) invalidate()
        // Движение следует частоте экрана без искусственной паузы между кадрами.
        // При reduced motion, выключенных анимациях и скрытой вкладке цикл спит.
        else if (fpsEnabled.current || (motionAllowed
          && [...actorViews.values()].some((actor) => !actor.defeated && actor.model.source === 'glb' && actor.model.idle))) {
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
      sun.position.set(controls.target.x - 8, heights.max + 25, controls.target.z + 8)
      sun.shadow.camera.far = Math.max(90, heights.max - heights.min + 60)
      sun.shadow.camera.updateProjectionMatrix()
      sun.target.position.copy(controls.target)
      invalidate()
    }
    let lastModels = settings.current.models, lastCatalog = settings.current.catalog
    function sync() {
      const current = latest.current, map = current.map
      if (!map || disposed) return
      labelsDirty = true
      const style = `${current.lighting}:${current.artUrl}:${current.artMode}:${current.themeKey}`
      if (terrainMap !== map || terrainStyle !== style) {
        const css = getComputedStyle(element)
        palette = boardPaletteFrom((name) => css.getPropertyValue(name))
        // Свежая проекция той же сцены не отменяет уже начатое действие.
        // Маску эффекта обновляем: скрывшаяся клетка не остаётся в старой геометрии.
        if (active) {
          active.effect?.dispose()
          active.effect = systemPrefersReducedMotion() ? null : createCombatEffect3D(active.cue, current.animationActors ?? [], map)
          if (active.effect) scene.add(active.effect.group)
        }
        terrain?.dispose()
        terrain = createBoard3DScene(map, { palette, lighting: current.lighting, artUrl: current.artUrl, artMode: current.artMode, onReady: invalidate })
        scene.add(terrain.group)
        terrainMap = map; terrainStyle = style
      }
      sun.castShadow = current.lighting !== false
      const modelsChanged = lastModels !== settings.current.models || lastCatalog !== settings.current.catalog
      lastModels = settings.current.models; lastCatalog = settings.current.catalog
      const visibleActors = (current.animationActors ?? []).filter((actor) => revealedAt(map, actor.x, actor.y))
      for (const [id, view] of actorViews) if (!visibleActors.some((actor) => actor.id === id) || modelsChanged) {
        view.model.dispose(); view.ring.geometry.dispose(); view.ring.material.dispose(); scene.remove(view.root); actorViews.delete(id)
      }
      for (const actor of visibleActors) {
        const key = `${actor.modelKey}:${actor.archetype}:${actor.kind}:${actor.label}`
        let view = actorViews.get(actor.id)
        if (view && view.key !== key) {
          view.model.dispose(); view.ring.geometry.dispose(); view.ring.material.dispose(); scene.remove(view.root); actorViews.delete(actor.id); view = undefined
        }
        if (!view) {
          const input = { ...actor, modelKey: settings.current.models[actor.id] ?? actor.modelKey }
          const model = createProceduralActorModel(input, settings.current.catalog)
          const root = new THREE.Group()
          root.add(model)
          const ring = new THREE.Mesh(new THREE.RingGeometry(.37, .405, 40), new THREE.MeshBasicMaterial({ color: actor.color ?? '#e2bb72', transparent: true, opacity: .85, side: THREE.DoubleSide }))
          ring.rotation.x = -Math.PI / 2; ring.position.y = .045
          root.add(ring); scene.add(root)
          view = { root, model, ring, key, defeated: Boolean(actor.defeated) }; actorViews.set(actor.id, view)
          const entry = resolveModelProfile(input, settings.current.catalog)
          if (entry.url) {
            const expected = view
            void createActorModel(input, { manifest: settings.current.catalog, signal: modelAbort.signal }).then((loaded) => {
              if (disposed || actorViews.get(actor.id) !== expected) { loaded.dispose(); return }
              root.remove(expected.model); expected.model.dispose()
              expected.model = loaded; root.add(loaded)
              labelsDirty = true
              const defeated = latest.current.animationActors?.find((item) => item.id === actor.id)?.defeated
              loaded.setPose(defeated ? 'death' : 'idle', defeated ? 1 : undefined)
              loaded.update(.001)
              if (loaded.source !== 'glb') setModelWarning(`Модель «${entry.name_ru ?? entry.key}» недоступна. Используется встроенная фигурка.`)
              invalidate()
            }).catch(() => { /* Отмена при уходе с карты не является ошибкой игрока. */ })
          }
        }
        view.root.visible = true
        if (!active || !('actorId' in active.cue) || active.cue.actorId !== actor.id) view.root.position.set(actor.x + .5, terrainHeightAt(map, actor.x, actor.y), actor.y + .5)
        if (actor.defeated || view.defeated !== Boolean(actor.defeated)) {
          view.model.setPose(actor.defeated ? 'death' : 'idle', actor.defeated ? 1 : undefined)
          view.model.update(.001)
        }
        view.defeated = Boolean(actor.defeated)
      }
      for (const layer of [overlay, spell]) {
        if (layer.map !== map) {
          layer.mesh.geometry.dispose()
          layer.mesh.geometry = createTerrainSurfaceGeometry(map)
          layer.map = map
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
      if (current.animationsEnabled === false || document.hidden) skip()
      else if (unseen.length) { pending = [...pending, ...unseen].slice(-COMBAT_ANIMATION_QUEUE_LIMIT); setPlaying(true) }
      paintOverlay()
      invalidate()
    }
    function resize() {
      labelsDirty = true
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight)
      renderer.setSize(width, height, false)
      const aspect = width / height
      camera.left = -7 * aspect; camera.right = 7 * aspect; camera.top = 7; camera.bottom = -7
      camera.updateProjectionMatrix()
      invalidate()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    const pointerCell = (event: PointerEvent | MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      cursor.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
      raycaster.setFromCamera(cursor, camera)
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
    function hover(x: number, y: number) {
      const key = `${x},${y}`
      if (key === hoverKey) return
      const cells = latest.current.cells
      cells.find((node) => `${node.x},${node.y}` === hoverKey)?.onPointerLeave?.()
      hoverKey = key
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
      const cell = pointerCell(event)
      hover(cell?.x ?? -1, cell?.y ?? -1)
    }
    const click = (event: MouseEvent) => {
      if (down?.moved || (down && down.button !== 0)) { down = null; return }
      down = null
      if (active) { skip(); return }
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
        const node = latest.current.cells.find((entry) => `${entry.x},${entry.y}` === hoverKey && entry.interactive)
        if (active) skip(); else node?.onActivate?.()
      } else if (event.key === 'Escape') skip()
    }
    const leave = () => { hover(-1, -1) }
    const contextMenu = (event: Event) => event.preventDefault()
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
    }
    resize(); reset()
    const saved = cameras.get(cameraKey)
    if (saved) { camera.position.copy(saved.position); camera.zoom = saved.zoom; controls.target.copy(saved.target); camera.updateProjectionMatrix(); controls.update() }
    const first = latest.current.animationActors?.find((actor) => latest.current.map && revealedAt(latest.current.map, actor.x, actor.y))
    if (first) keyboardCell = { x: first.x, y: first.y }
    try { sync() } catch { latest.current.onUnavailable('Не удалось подготовить 3D-карту.') }
    return () => {
      disposed = true
      modelAbort.abort()
      if (frameId) cancelAnimationFrame(frameId)
      cameras.set(cameraKey, { position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom })
      if (cameras.size > 100) cameras.delete(cameras.keys().next().value!)
      runtime.current = null
      observer.disconnect(); controls.dispose()
      document.removeEventListener('visibilitychange', visibility)
      renderer.domElement.removeEventListener('webglcontextlost', contextLost)
      active?.effect?.dispose(); terrain?.dispose()
      for (const view of actorViews.values()) { view.model.dispose(); view.ring.geometry.dispose(); view.ring.material.dispose() }
      overlay.dispose(); spell.dispose(); sun.shadow.dispose()
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); floating.remove()
    }
  }, [cameraKey, props.onUnavailable])

  useEffect(() => { runtime.current?.sync() }, [props, models, catalog])
  useEffect(() => { if (props.viewResetKey !== undefined) runtime.current?.reset() }, [props.viewResetKey])
  const chooseModel = (value: string) => {
    const next = { ...models }
    if (value) next[selectedModelActor] = value; else delete next[selectedModelActor]
    setModels(next)
    try { localStorage.setItem(modelStorageKey, JSON.stringify(next)) } catch { /* Выбор работает и без сохранения. */ }
  }
  return <div className="board3d" ref={host} role="group" aria-label="Тактическая карта 3D" onClickCapture={(event) => {
    if (playing && (event.target as HTMLElement).closest('.board3d-labels')) { event.preventDefault(); event.stopPropagation(); runtime.current?.skip() }
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
    {playing && <button type="button" className="board3d-skip" onClick={() => runtime.current?.skip()}>Пропустить анимацию</button>}
    <p className="board3d-help">Перетащить — сдвиг · Правая кнопка — поворот · {props.wheelZoomRequiresAltKey ? 'Alt + колесо' : 'Колесо'} — масштаб</p>
  </div>
}
