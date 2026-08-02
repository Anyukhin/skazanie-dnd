import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BattleEvent, CombatVisualBatch, TacticalMap } from './types'
import {
  DEFAULT_BOARD_PALETTE, TILE_CELLS, boardPaletteFrom, createTileCache, drawBoardEffects, drawBoardOverlay, drawMapDecorations,
  syncTileCache, terrainKeysFor, visibleTiles,
  type BoardEffectRenderer, type BoardOverlayCell, type BoardPalette, type BoardScene, type BoardTexture, type PropAtlas,
  type TerrainTiles, type TileSurface,
} from './board-render'
import {
  COMBAT_ANIMATION_QUEUE_LIMIT,
  combatAnimationCuesFromBattleLog,
  combatAnimationCuesFromEvents,
  type BoardPoint,
  type CombatAnimationCue,
} from './combat-animation'
import {
  createSpellEffectBudgetController,
  createSpellEffectRenderer,
  isSpellAnimationCue,
} from './spell-effects'
import { boardCameraKey } from './tactical-ui'
import './tactical-board.css'

/**
 * Тактическая доска. Местность (слои 1–7 плана) живёт на canvas и кэшируется
 * тайлами 16×16 клеток; рисуются только тайлы, попадающие в окно.
 *
 * Фишки и интерактив остаются в DOM поверх холста — это сознательное отступление
 * от §7 плана: на фишках висит вся доступность (`aria-label`, `title`, фокус,
 * клавиатура, вложенные кнопки цели), а самих фишек единицы. При этом DOM-узел
 * получает только активная клетка: занятая фишкой, досягаемая, входящая в
 * маршрут или в область команды. Пустая клетка узла не получает.
 */

/** Предел стороны холста: дальше браузеры отказываются выделять буфер. */
const MAX_CANVAS_SIDE = 8192
/** Reduced motion сохраняет статический акцент, но не растягивает пакет дольше 1,8 с. */
const REDUCED_MOTION_SPELL_CUE_MS = 120

/**
 * Кроссфейд при смене этажа (`docs/multilevel-map-plan.md`, 6.4). Держится
 * ровно столько, сколько идёт CSS-анимация: класс снимается по таймеру, и
 * постоянного rAF-цикла у доски не появляется.
 */
const LEVEL_CROSSFADE_MS = 400

/**
 * Манифест растровых штампов предметов. Собирается `pnpm props:atlas`; его
 * может не быть — тогда доска рисует предметы вектором (решение Р6 плана).
 */
const PROP_ATLAS_MANIFEST = '/assets/maps/props/prop-atlas.json'

/** Манифест фактур пола, поверхностей и стен. Собирается `pnpm terrain:tiles`. */
const TERRAIN_MANIFEST = '/assets/maps/terrain/terrain-tiles.json'

type TerrainManifest = {
  cellsPerTile: number
  floors: Record<string, string>
  surfaces: Record<string, string>
  walls: Record<string, string>
}

const loadedTextures = new Map<string, BoardTexture>()
const loadedArt = new Map<string, BoardTexture>()
let propAtlas: PropAtlas | null = null
let propAtlasAsked = false
let terrainManifest: TerrainManifest | null = null
let terrainAsked = false

function loadImage(url: string, into: Map<string, BoardTexture>, onReady: () => void) {
  if (into.has(url) || typeof Image !== 'function') return
  const image = new Image()
  image.decoding = 'async'
  image.onload = () => {
    if (!image.naturalWidth || !image.naturalHeight) return
    into.set(url, { image, width: image.naturalWidth, height: image.naturalHeight })
    onReady()
  }
  image.src = url
}

/**
 * Фактуры местности: манифест запрашивается один раз, а картинки — только те,
 * что нужны текущей карте. Весь набор весит около четырёх мегабайт, и тянуть
 * лёд с мрамором ради деревянной таверны незачем.
 *
 * Возвращается то, что **уже** загружено; недостающее ставится в очередь и
 * приезжает следующим кадром. Поэтому доска рисуется сразу, а не ждёт сети.
 */
function terrainTilesFor(keys: { floors: string[]; surfaces: string[]; walls: string[] }, onReady: () => void): TerrainTiles | null {
  const manifest = terrainManifest
  if (!manifest) return null
  const slots = [
    ['floors', keys.floors, manifest.floors],
    ['surfaces', keys.surfaces, manifest.surfaces],
    ['walls', keys.walls, manifest.walls],
  ] as const
  const ready = { floors: new Map<string, BoardTexture>(), surfaces: new Map<string, BoardTexture>(), walls: new Map<string, BoardTexture>() }
  let loaded = 0
  for (const [slot, wanted, paths] of slots) {
    for (const key of wanted) {
      const path = paths[key]
      if (!path) continue
      const url = `/assets/${path}`
      const texture = loadedTextures.get(url)
      if (!texture) {
        loadImage(url, loadedTextures, onReady)
        continue
      }
      ready[slot].set(key, texture)
      loaded += 1
    }
  }
  if (!loaded) return null
  return { cellsPerTile: manifest.cellsPerTile, ...ready, key: `tiles:${loaded}` }
}

function loadTerrainManifest(onReady: () => void) {
  if (terrainAsked || typeof fetch !== 'function') return
  terrainAsked = true
  void fetch(TERRAIN_MANIFEST)
    .then((response) => (response.ok ? response.json() : null))
    .then((manifest) => {
      if (!manifest?.cellsPerTile || !manifest?.floors) return
      terrainManifest = manifest
      onReady()
    })
    .catch(() => {})
}

/**
 * Атлас грузится один раз на всё приложение: он общий для всех карт и весит
 * пару мегабайт. Ошибка запроса не обрабатывается особо — доска остаётся
 * векторной, и это штатный путь, а не поломка.
 */
function loadPropAtlas(onReady: () => void) {
  if (propAtlasAsked || typeof fetch !== 'function') return
  propAtlasAsked = true
  void fetch(PROP_ATLAS_MANIFEST)
    .then((response) => (response.ok ? response.json() : null))
    .then((manifest) => {
      const frames = manifest?.frames
      if (!manifest?.image || !frames || !Object.keys(frames).length) return
      const url = `/assets/${manifest.image}`
      loadImage(url, loadedTextures, () => {
        const texture = loadedTextures.get(url)
        if (!texture) return
        propAtlas = { texture, frames, key: `${manifest.image}:${texture.width}x${texture.height}` }
        onReady()
      })
    })
    .catch(() => {})
}

/**
 * Поверхность тайла: `OffscreenCanvas`, если он есть, иначе обычный `<canvas>`
 * вне документа. Наличие проверяется, а не предполагается.
 */
function createTileSurface(size: number): TileSurface {
  const offscreen = (globalThis as { OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas }).OffscreenCanvas
  if (typeof offscreen === 'function') {
    const canvas = new offscreen(size, size)
    const context = canvas.getContext('2d')
    if (context) return { canvas, context }
  }
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Браузер не выдал 2D-контекст для доски')
  return { canvas, context }
}

export type BoardCellNode = {
  x: number
  y: number
  className: string
  interactive: boolean
  ariaLabel?: string
  title?: string
  onActivate?: () => void
  onPointerEnter?: () => void
  onPointerLeave?: () => void
  hotspot?: React.ReactNode
  children?: React.ReactNode
}

/** Подсказка клетки, у которой нет собственного узла: причина недоступности. */
export type BoardCellHint = { title?: string; ariaLabel?: string }

export type BoardAnimationActor = {
  id: string
  x: number
  y: number
  label: string
  color?: string
  kind: 'hero' | 'enemy' | 'summon' | 'neutral'
}

type BoardConditionState = Record<string, Array<{ id: string }>>

/**
 * Камера доски, пережившая размонтирование.
 *
 * Масштаб и панорама жили в состоянии компонента, а компонент умирает при уходе
 * в любой другой раздел: игрок наводил вид на нужный угол карты, заглядывал в
 * журнал — и возвращался к сброшенным 100% в исходной точке. Ключ — локация:
 * при переходе в новое место камера обязана сброситься, а при возврате из
 * раздела в ту же сцену — нет.
 *
 * Память намеренно только на время сессии: переживать перезагрузку страницы
 * камере незачем, а `sessionStorage` пришлось бы ещё и разбирать при чтении.
 *
 * Ключ составной: локация плюс этаж (`boardCameraKey`). Партия ходит по
 * лестнице внутри одной локации, и без номера этажа подвал наследовал бы
 * камеру зала — вид уезжал бы в пустоту за краем меньшей карты.
 */
const cameraByLocation = new Map<string, { zoom: number; pan: { x: number; y: number } }>()

export function TacticalBoard({
  map, columns, rows, irregular, ariaLabel, themeKey, artUrl, cells, cellHints, overlayCells, decoration,
  effectRenderers, battleLog, visualBatch, animationActors, animationsEnabled, conditions, conditionVersion, onBackgroundActivate,
  levelIndex = 0,
}: {
  map: TacticalMap | null
  columns: number
  rows: number
  irregular: boolean
  ariaLabel: string
  /** Ключ темы: при его смене палитра перечитывается из CSS. */
  themeKey: string
  artUrl: string | null
  cells: BoardCellNode[]
  /**
   * Подсказки клеток без узла. Наведение обслуживается внутри доски: если бы
   * клетка под указателем поднималась в состояние экрана, каждое движение мыши
   * пересобирало бы весь боевой слой.
   */
  cellHints?: Map<string, BoardCellHint>
  overlayCells: BoardOverlayCell[]
  /** Один упорядоченный конвейер для всех canvas-эффектов над подсветкой команд. */
  effectRenderers?: readonly BoardEffectRenderer[]
  decoration?: React.ReactNode
  battleLog?: BattleEvent[]
  visualBatch?: CombatVisualBatch | null
  animationActors?: BoardAnimationActor[]
  animationsEnabled?: boolean
  conditions?: BoardConditionState
  conditionVersion?: number
  onBackgroundActivate?: () => void
  /** Активный этаж локации: своя камера и кроссфейд при смене. */
  levelIndex?: number
}) {
  const cameraKey = boardCameraKey(map?.locationId, levelIndex)
  const [zoom, setZoom] = useState(() => cameraByLocation.get(cameraKey)?.zoom ?? 1)
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null)
  const [pan, setPan] = useState(() => cameraByLocation.get(cameraKey)?.pan ?? { x: 0, y: 0 })
  const lastCameraKey = useRef(cameraKey)
  const [dragging, setDragging] = useState(false)
  const [cellPixels, setCellPixels] = useState(0)
  const [assetsVersion, setAssetsVersion] = useState(0)
  useEffect(() => { cameraByLocation.set(cameraKey, { zoom, pan }) }, [cameraKey, zoom, pan])
  useEffect(() => {
    // Локация сменилась под живым компонентом — берём её камеру, а не чужую.
    if (lastCameraKey.current === cameraKey) return
    lastCameraKey.current = cameraKey
    const saved = cameraByLocation.get(cameraKey)
    setZoom(saved?.zoom ?? 1)
    setPan(saved?.pan ?? { x: 0, y: 0 })
  }, [cameraKey])

  /*
   * Кроссфейд этажа сделан CSS-анимацией самой рамки доски, а не снимком
   * холста поверх нового (вариант из 6.4 плана). Причина в том, что вместе с
   * этажом меняется размер карты: снимок пришлось бы держать на отдельном
   * холсте своей геометрии, тянуть его через смену `columns`/`rows` и следить,
   * чтобы он лёг раньше первой отрисовки нового пола. CSS-анимация не знает
   * ни о карте, ни о тайловом кэше, живёт ровно 400 мс и не заводит rAF-цикла
   * — а видно то же самое: старый пол растворяется, новый приходит со сдвигом
   * по вертикали.
   */
  const [levelShift, setLevelShift] = useState<'up' | 'down' | null>(null)
  const lastLevelIndex = useRef(levelIndex)
  useEffect(() => {
    if (lastLevelIndex.current === levelIndex) return
    const direction: 'up' | 'down' = levelIndex > lastLevelIndex.current ? 'up' : 'down'
    lastLevelIndex.current = levelIndex
    setLevelShift(direction)
    const timer = setTimeout(() => setLevelShift(null), LEVEL_CROSSFADE_MS)
    return () => clearTimeout(timer)
  }, [levelIndex])

  const frameRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const effectsCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const cacheRef = useRef(createTileCache())
  const paletteRef = useRef<BoardPalette>(DEFAULT_BOARD_PALETTE)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; startPanX: number; startPanY: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const hovered = useRef<string | null>(null)
  const animationActorsRef = useRef(animationActors ?? [])
  animationActorsRef.current = animationActors ?? []
  const spellEffectBudgetRef = useRef<ReturnType<typeof createSpellEffectBudgetController> | null>(null)
  if (!spellEffectBudgetRef.current) spellEffectBudgetRef.current = createSpellEffectBudgetController()
  const latestBattleLogRef = useRef(battleLog ?? [])
  latestBattleLogRef.current = battleLog ?? []
  const latestVisualBatchRef = useRef(visualBatch ?? null)
  latestVisualBatchRef.current = visualBatch ?? null
  const conditionEntries = Object.entries(conditions ?? {}).flatMap(([actorId, actorConditions]) => (
    actorConditions.map((condition) => `${actorId}|${String(condition.id)}`)
  )).sort()
  const conditionKey = conditionEntries.join(',')
  const latestConditionKeysRef = useRef(new Set(conditionEntries))
  latestConditionKeysRef.current = new Set(conditionEntries)
  const previousConditionKeys = useRef(new Set(conditionEntries))
  const initialBattleCues = useRef(combatAnimationCuesFromBattleLog(battleLog ?? []))
  const seenAnimationIds = useRef(new Set(initialBattleCues.current.map((cue) => cue.id)))
  const processedVisualBatches = useRef(new Set(visualBatch ? [visualBatch.id] : []))
  const [animationQueue, setAnimationQueue] = useState<CombatAnimationCue[]>([])
  const [activeAnimation, setActiveAnimation] = useState<CombatAnimationCue | null>(null)
  const activeAnimationRef = useRef<CombatAnimationCue | null>(null)
  activeAnimationRef.current = activeAnimation

  useEffect(() => {
    const notify = () => setAssetsVersion((value) => value + 1)
    loadPropAtlas(notify)
    loadTerrainManifest(notify)
  }, [])
  useEffect(() => {
    if (artUrl) loadImage(artUrl, loadedArt, () => setAssetsVersion((value) => value + 1))
  }, [artUrl])

  // Размер клетки задаётся темой в CSS (`--cell` с контейнерными единицами),
  // поэтому в пикселях он только измеряется: холст обязан совпасть с сеткой.
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const measure = () => setCellPixels(frame.clientWidth / Math.max(1, columns))
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [columns, rows])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || typeof getComputedStyle !== 'function') return
    const style = getComputedStyle(frame)
    paletteRef.current = boardPaletteFrom((name) => style.getPropertyValue(name))
    setAssetsVersion((value) => value + 1)
  }, [themeKey])

  // Какие фактуры нужны этой карте: пересчитывается только при смене карты,
  // обход всех клеток на каждый кадр был бы напрасной работой.
  const terrainKeys = useMemo(
    () => (map ? terrainKeysFor(map) : { floors: [], surfaces: [], walls: [] }),
    [map?.terrainHash],
  )
  const terrain = useMemo(
    () => terrainTilesFor(terrainKeys, () => setAssetsVersion((value) => value + 1)),
    [terrainKeys, assetsVersion],
  )

  const boardScene = useCallback((cellSize: number): BoardScene | null => {
    if (!map) return null
    return {
      map,
      palette: paletteRef.current,
      cellSize,
      terrain,
      art: artUrl ? loadedArt.get(artUrl) ?? null : null,
      artKey: artUrl ?? '',
      propAtlas,
    }
  }, [map, terrain, artUrl])

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const frame = frameRef.current
    if (!canvas || !frame || !map || cellPixels <= 0) return
    const context = canvas.getContext('2d')
    if (!context) return
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    const sideLimit = Math.floor(MAX_CANVAS_SIDE / Math.max(1, Math.max(columns, rows)))
    const cellSize = Math.max(2, Math.min(sideLimit, Math.round(cellPixels * zoom * ratio)))
    if (canvas.width !== columns * cellSize || canvas.height !== rows * cellSize) {
      canvas.width = columns * cellSize
      canvas.height = rows * cellSize
    }
    const scene = boardScene(cellSize)
    if (!scene) return

    // Видимое окно в координатах клеток: холст лежит внутри трансформированного
    // полотна, поэтому окно считается по фактическим экранным прямоугольникам.
    const frameRect = frame.getBoundingClientRect()
    const stage = frame.closest('.map-stage') ?? frame.parentElement
    const stageRect = stage?.getBoundingClientRect()
    const screenCell = frameRect.width / Math.max(1, columns)
    const view = stageRect && screenCell > 0
      ? {
          x: (stageRect.left - frameRect.left) / screenCell,
          y: (stageRect.top - frameRect.top) / screenCell,
          width: stageRect.width / screenCell,
          height: stageRect.height / screenCell,
        }
      : { x: 0, y: 0, width: columns, height: rows }

    const tiles = visibleTiles(map, view)
    const { entries } = syncTileCache(cacheRef.current, scene, tiles, createTileSurface)
    context.clearRect(0, 0, canvas.width, canvas.height)
    for (const entry of entries) {
      context.drawImage(
        entry.surface.canvas as CanvasImageSource,
        entry.tileX * TILE_CELLS * cellSize,
        entry.tileY * TILE_CELLS * cellSize,
      )
    }
    drawBoardOverlay(context, scene, overlayCells)
    drawBoardEffects(context, scene, effectRenderers ?? [])
    drawMapDecorations(context, scene)
  }, [map, columns, rows, cellPixels, zoom, overlayCells, effectRenderers, assetsVersion, boardScene])

  useEffect(() => { paint() }, [paint, pan.x, pan.y])

  const clearEffectsCanvas = useCallback(() => {
    const canvas = effectsCanvasRef.current
    const context = canvas?.getContext('2d')
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height)
  }, [])

  const skipAnimations = useCallback(() => {
    setAnimationQueue([])
    setActiveAnimation(null)
    clearEffectsCanvas()
  }, [clearEffectsCanvas])

  const enqueueAnimations = useCallback((incoming: readonly CombatAnimationCue[]) => {
    const fresh: CombatAnimationCue[] = []
    for (const cue of incoming) {
      if (seenAnimationIds.current.has(cue.id)) continue
      seenAnimationIds.current.add(cue.id)
      fresh.push(cue)
    }
    // Помечаем события даже при выключенных эффектах и в фоновой вкладке:
    // после возврата уже подтверждённые ходы не должны проигрываться заново.
    if (!fresh.length || animationsEnabled === false || (typeof document !== 'undefined' && document.hidden)) return
    setAnimationQueue((current) => [...current, ...fresh].slice(-COMBAT_ANIMATION_QUEUE_LIMIT))
  }, [animationsEnabled])

  const battleLogKey = (battleLog ?? []).map((event) => `${event.id}:${event.damage ?? ''}:${event.hpAfter ?? ''}`).join('|')
  useEffect(() => {
    if (visualBatch && !processedVisualBatches.current.has(visualBatch.id)) {
      processedVisualBatches.current.add(visualBatch.id)
      enqueueAnimations(combatAnimationCuesFromEvents(visualBatch.events))
    }
    enqueueAnimations(combatAnimationCuesFromBattleLog(battleLog ?? []))
  }, [battleLogKey, enqueueAnimations, visualBatch?.id])

  useEffect(() => {
    const next = new Set(conditionEntries)
    const includedByLiveBatch = new Set((visualBatch?.events ?? [])
      .filter((event) => event.event_type === 'ConditionAdded')
      .map((event) => `${String(event.target_ids?.[0] ?? event.payload?.target_id ?? event.payload?.actor_id ?? '')}|${String(event.payload?.condition ?? '')}`))
    const projectedEvents = conditionEntries.flatMap((entry) => {
      if (previousConditionKeys.current.has(entry) || includedByLiveBatch.has(entry)) return []
      const [actorId, condition] = entry.split('|')
      // Внутренние маркеры ресурсов содержат двоеточие или явный префикс
      // потраченного действия. Это учёт механики, а не видимое состояние.
      if (!actorId || !condition || condition.includes(':') || condition.startsWith('monster-action-used')) return []
      return [{
        event_id: `projected-condition:${conditionVersion ?? 0}:${actorId}:${condition}`,
        event_type: 'ConditionAdded',
        actor_id: actorId,
        target_ids: [actorId],
        payload: { target_id: actorId, condition },
      }]
    })
    previousConditionKeys.current = next
    enqueueAnimations(combatAnimationCuesFromEvents(projectedEvents))
  }, [conditionKey, conditionVersion, enqueueAnimations, visualBatch?.id])

  useEffect(() => {
    if (animationsEnabled !== false) return
    skipAnimations()
  }, [animationsEnabled, skipAnimations])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const dropBufferedVisuals = () => {
      skipAnimations()
      const batch = latestVisualBatchRef.current
      if (batch) {
        processedVisualBatches.current.add(batch.id)
        for (const cue of combatAnimationCuesFromEvents(batch.events)) seenAnimationIds.current.add(cue.id)
      }
      for (const cue of combatAnimationCuesFromBattleLog(latestBattleLogRef.current)) seenAnimationIds.current.add(cue.id)
      previousConditionKeys.current = new Set(latestConditionKeysRef.current)
    }
    const onVisibilityChange = () => {
      // Сбрасываем на обоих переходах: при скрытии сразу отменяем RAF, а при
      // возврате продвигаем отметку просмотренного через заторможенный рендер.
      dropBufferedVisuals()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [skipAnimations])

  useEffect(() => {
    if (activeAnimation || !animationQueue.length || animationsEnabled === false) return
    const [next, ...rest] = animationQueue
    setAnimationQueue(rest)
    setActiveAnimation(next)
  }, [activeAnimation, animationQueue, animationsEnabled])

  const actorAt = (id: string) => animationActorsRef.current.find((actor) => actor.id === id)

  const prepareEffectsContext = useCallback(() => {
    const base = canvasRef.current
    const canvas = effectsCanvasRef.current
    if (!base || !canvas || !base.width || !base.height) return null
    if (canvas.width !== base.width || canvas.height !== base.height) {
      canvas.width = base.width
      canvas.height = base.height
    }
    const context = canvas.getContext('2d')
    if (!context) return null
    const cellSize = base.width / Math.max(1, columns)
    const scene = boardScene(cellSize)
    if (!scene) return null
    return {
      canvas,
      context,
      cellSize,
      scene,
    }
  }, [boardScene, columns])

  const screenPoint = (position: BoardPoint, cellSize: number) => ({
    x: (position.x + .5) * cellSize,
    y: (position.y + .5) * cellSize,
  })

  const animationColor = (cue: CombatAnimationCue) => {
    if (cue.kind === 'impact') {
      if (cue.tone === 'healing') return '#8ad09a'
      if (cue.tone === 'miss') return '#d7cec2'
      const type = String(cue.damageType ?? '').toLocaleLowerCase('ru')
      if (/cold|холод/u.test(type)) return '#8bc9dd'
      if (/poison|acid|яд|кисл/u.test(type)) return '#9fc878'
      if (/radiant|излуч/u.test(type)) return '#f3d47e'
      if (/necrotic|некрот/u.test(type)) return '#b28ac5'
      return '#ef8b78'
    }
    return '#ef8b78'
  }

  const drawActor = (context: CanvasRenderingContext2D, position: BoardPoint, cellSize: number, actorId: string, alpha = 1) => {
    const actor = actorAt(actorId)
    const center = screenPoint(position, cellSize)
    const radius = Math.max(7, cellSize * .29)
    const color = actor?.color || (actor?.kind === 'enemy' ? '#bd6256' : actor?.kind === 'summon' ? '#70a78b' : actor?.kind === 'neutral' ? '#9d8f72' : '#d6a55a')
    context.save()
    context.globalAlpha = alpha
    context.beginPath()
    context.arc(center.x, center.y, radius, 0, Math.PI * 2)
    context.fillStyle = color
    context.shadowBlur = radius * .8
    context.shadowColor = color
    context.fill()
    context.shadowBlur = 0
    context.lineWidth = Math.max(2, cellSize * .045)
    context.strokeStyle = '#f7ead8'
    context.stroke()
    const initials = String(actor?.label ?? '').trim().split(/\s+/u).slice(0, 2).map((word) => word[0]).join('').toLocaleUpperCase('ru')
    if (initials) {
      context.fillStyle = '#17120e'
      context.font = `800 ${Math.max(10, Math.round(cellSize * .2))}px Manrope, sans-serif`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(initials, center.x, center.y + 1)
    }
    context.restore()
    return center
  }

  const drawFloatingText = (
    context: CanvasRenderingContext2D,
    position: BoardPoint,
    cellSize: number,
    text: string,
    color: string,
    progress: number,
  ) => {
    const center = screenPoint(position, cellSize)
    context.save()
    context.globalAlpha = Math.min(1, progress * 5) * Math.max(0, 1 - Math.max(0, progress - .72) / .28)
    context.fillStyle = color
    context.strokeStyle = 'rgba(18, 12, 9, .95)'
    context.lineWidth = Math.max(3, cellSize * .07)
    context.font = `900 ${Math.max(13, Math.round(cellSize * .27))}px Manrope, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const y = center.y - cellSize * (.25 + progress * .48)
    context.strokeText(text, center.x, y)
    context.fillText(text, center.x, y)
    context.restore()
  }

  useEffect(() => {
    if (!activeAnimation) {
      clearEffectsCanvas()
      return
    }
    let frameHandle = 0
    let cancelled = false
    const startedAt = performance.now()
    let previousFrameAt = startedAt
    const ghostIds = activeAnimation.kind === 'move' || activeAnimation.kind === 'strike'
      ? [activeAnimation.actorId]
      : []
    const ghosted = [...(frameRef.current?.querySelectorAll<HTMLElement>('[data-actor-id]') ?? [])]
      .filter((element) => ghostIds.includes(String(element.dataset.actorId)))
    ghosted.forEach((element) => element.classList.add('animation-ghosted'))

    const frame = (now: number) => {
      if (cancelled) return
      const prepared = prepareEffectsContext()
      if (!prepared) {
        setActiveAnimation(null)
        return
      }
      const { canvas, context, cellSize, scene } = prepared
      const spellCue = isSpellAnimationCue(activeAnimation)
      const durationMs = spellCue && activeAnimation.motion === 'reduced'
        ? Math.max(REDUCED_MOTION_SPELL_CUE_MS, activeAnimation.durationMs)
        : Math.max(1, activeAnimation.durationMs)
      const progress = Math.max(0, Math.min(1, (now - startedAt) / durationMs))
      const eased = 1 - Math.pow(1 - progress, 3)
      const frameDurationMs = Math.max(0, now - previousFrameAt)
      previousFrameAt = now
      context.clearRect(0, 0, canvas.width, canvas.height)

      if (spellCue) {
        const budget = spellEffectBudgetRef.current
        drawBoardEffects(context, scene, [
          createSpellEffectRenderer({
            cue: activeAnimation,
            progress,
            actors: animationActorsRef.current,
            detail: budget?.detail ?? activeAnimation.detail,
            frameDurationMs,
            reducedMotion: activeAnimation.motion === 'reduced',
          }),
        ])
        budget?.recordFrame(frameDurationMs)
      } else if (activeAnimation.kind === 'move') {
        const route = [activeAnimation.from, ...activeAnimation.path]
        const travel = eased * Math.max(1, route.length - 1)
        const index = Math.min(route.length - 2, Math.floor(travel))
        const local = Math.min(1, travel - index)
        const from = route[Math.max(0, index)] ?? activeAnimation.from
        const to = route[Math.min(route.length - 1, index + 1)] ?? activeAnimation.to
        drawActor(context, {
          x: from.x + (to.x - from.x) * local,
          y: from.y + (to.y - from.y) * local,
        }, cellSize, activeAnimation.actorId)
      } else if (activeAnimation.kind === 'strike') {
        const actor = actorAt(activeAnimation.actorId)
        const target = actorAt(activeAnimation.targetId)
        if (actor && target) {
          const dx = target.x - actor.x
          const dy = target.y - actor.y
          const length = Math.max(1, Math.hypot(dx, dy))
          const lunge = Math.sin(Math.min(1, progress / .58) * Math.PI) * .34
          drawActor(context, { x: actor.x + dx / length * lunge, y: actor.y + dy / length * lunge }, cellSize, activeAnimation.actorId)
          if (progress > .18) {
            const targetCenter = screenPoint(target, cellSize)
            context.save()
            context.globalAlpha = Math.max(0, 1 - progress) * .9
            context.beginPath()
            context.arc(targetCenter.x, targetCenter.y, cellSize * (.28 + progress * .42), 0, Math.PI * 2)
            context.lineWidth = Math.max(3, cellSize * .08)
            context.strokeStyle = activeAnimation.hit ? '#f4bb72' : '#d7cec2'
            context.shadowBlur = cellSize * .3
            context.shadowColor = context.strokeStyle
            context.stroke()
            context.restore()
            const label = activeAnimation.hit
              ? activeAnimation.amount != null && activeAnimation.amount > 0 ? `−${activeAnimation.amount}` : 'ПОПАДАНИЕ'
              : 'МИМО'
            drawFloatingText(context, target, cellSize, label, activeAnimation.hit ? '#ef8b78' : '#d7cec2', progress)
          }
        }
      } else if (activeAnimation.kind === 'impact') {
        const target = actorAt(activeAnimation.targetId)
        if (target) {
          const color = animationColor(activeAnimation)
          const center = screenPoint(target, cellSize)
          context.save()
          context.globalAlpha = Math.max(0, 1 - progress)
          context.beginPath()
          context.arc(center.x, center.y, cellSize * (.22 + eased * .48), 0, Math.PI * 2)
          context.fillStyle = `${color}33`
          context.fill()
          context.lineWidth = Math.max(2, cellSize * .06)
          context.strokeStyle = color
          context.stroke()
          context.restore()
          const label = activeAnimation.tone === 'healing'
            ? `+${activeAnimation.amount ?? 0}`
            : activeAnimation.tone === 'miss' ? 'МИМО' : `−${activeAnimation.amount ?? 0}`
          drawFloatingText(context, target, cellSize, label, color, progress)
        }
      } else if (activeAnimation.kind === 'death') {
        const target = actorAt(activeAnimation.targetId)
        if (target) {
          const alpha = Math.max(0, 1 - eased)
          const center = drawActor(context, target, cellSize, activeAnimation.targetId, alpha)
          context.save()
          context.globalAlpha = Math.min(1, progress * 3) * alpha
          context.strokeStyle = '#d9c2b2'
          context.lineWidth = Math.max(3, cellSize * .065)
          const radius = cellSize * .22
          context.beginPath()
          context.moveTo(center.x - radius, center.y - radius)
          context.lineTo(center.x + radius, center.y + radius)
          context.moveTo(center.x + radius, center.y - radius)
          context.lineTo(center.x - radius, center.y + radius)
          context.stroke()
          context.restore()
          drawFloatingText(context, target, cellSize, 'ВЫБЫЛ', '#e2c6ba', progress)
        }
      } else if (activeAnimation.kind === 'condition') {
        const target = actorAt(activeAnimation.targetId)
        if (target) {
          const center = screenPoint(target, cellSize)
          context.save()
          context.globalAlpha = Math.max(0, 1 - Math.max(0, progress - .65) / .35)
          context.beginPath()
          context.arc(center.x, center.y, cellSize * (.28 + Math.sin(progress * Math.PI) * .12), 0, Math.PI * 2)
          context.setLineDash([Math.max(4, cellSize * .1), Math.max(3, cellSize * .07)])
          context.lineWidth = Math.max(2, cellSize * .055)
          context.strokeStyle = '#c49bde'
          context.shadowBlur = cellSize * .24
          context.shadowColor = '#9e71bd'
          context.stroke()
          context.restore()
          drawFloatingText(context, target, cellSize, activeAnimation.label.toLocaleUpperCase('ru'), '#d8b9e8', progress)
        }
      }

      if (progress >= 1) {
        context.clearRect(0, 0, canvas.width, canvas.height)
        setActiveAnimation(null)
        return
      }
      frameHandle = requestAnimationFrame(frame)
    }
    frameHandle = requestAnimationFrame(frame)
    return () => {
      cancelled = true
      cancelAnimationFrame(frameHandle)
      ghosted.forEach((element) => element.classList.remove('animation-ghosted'))
    }
  }, [activeAnimation, clearEffectsCanvas, prepareEffectsContext])

  const cellFromPoint = useCallback((clientX: number, clientY: number) => {
    const frame = frameRef.current
    if (!frame) return null
    const rect = frame.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const x = Math.floor((clientX - rect.left) / (rect.width / Math.max(1, columns)))
    const y = Math.floor((clientY - rect.top) / (rect.height / Math.max(1, rows)))
    if (x < 0 || y < 0 || x >= columns || y >= rows) return null
    return { x, y }
  }, [columns, rows])

  const activeByKey = useMemo(() => {
    const index = new Map<string, BoardCellNode>()
    for (const node of cells) index.set(`${node.x},${node.y}`, node)
    return index
  }, [cells])

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    // Клик и перетаскивание различаются порогом смещения, а не местом нажатия:
    // с клетки можно и уйти в ход (отпустили на месте — сработает click), и
    // повести карту (сдвинулись дальше 3 px — click подавляется suppressClick).
    // Прочие кнопки — фишки, двери, меню — перетаскивание не начинают: у них
    // нажатие значит действие, а не захват карты.
    const control = (event.target as HTMLElement).closest('button')
    if (event.button !== 0 || (control && !control.classList.contains('board-cell'))) return
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startPanX: pan.x, startPanY: pan.y, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const position = cellFromPoint(event.clientX, event.clientY)
    const key = position ? `${position.x},${position.y}` : null
    if (key !== hovered.current) {
      hovered.current = key
      setHoverCell(position)
    }
    if (!drag.current || drag.current.pointerId !== event.pointerId) return
    event.preventDefault()
    const deltaX = event.clientX - drag.current.startX
    const deltaY = event.clientY - drag.current.startY
    if (Math.hypot(deltaX, deltaY) > 3) drag.current.moved = true
    setPan({ x: drag.current.startPanX + deltaX, y: drag.current.startPanY + deltaY })
  }
  const stopPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return
    suppressClick.current = drag.current.moved
    if (drag.current.moved) window.setTimeout(() => { suppressClick.current = false }, 0)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    drag.current = null
    setDragging(false)
  }
  const zoomWithWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey) return
    event.preventDefault()
    const direction = Math.sign(event.deltaY)
    if (!direction) return
    setZoom((value) => Math.max(.65, Math.min(1.6, Number((value - direction * .08).toFixed(2)))))
  }
  const leaveBoard = () => {
    if (hovered.current === null) return
    hovered.current = null
    setHoverCell(null)
  }

  // Узел-щуп существует только под указателем и только там, где подсказка есть,
  // а собственного узла у клетки нет.
  const hoverKey = hoverCell ? `${hoverCell.x},${hoverCell.y}` : ''
  const hoverHint = hoverCell && !activeByKey.has(hoverKey) ? cellHints?.get(hoverKey) : undefined

  /** Клавиатура: стрелки ведут фокус по активным клеткам, а не по всем. */
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const deltas: Record<string, [number, number]> = {
      ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1],
    }
    const delta = deltas[event.key]
    if (!delta) return
    const focused = (document.activeElement as HTMLElement | null)?.closest('.board-cell') as HTMLElement | null
    const origin = focused?.dataset.cell?.split(',').map(Number)
    const from = origin && origin.length === 2 && Number.isFinite(origin[0])
      ? { x: origin[0], y: origin[1] }
      : cells[0] ? { x: cells[0].x - delta[0], y: cells[0].y - delta[1] } : null
    if (!from) return
    const forward = cells.filter((node) => (
      node.interactive
      && (delta[0] ? Math.sign(node.x - from.x) === delta[0] : node.x === from.x)
      && (delta[1] ? Math.sign(node.y - from.y) === delta[1] : node.y === from.y)
    ))
    const next = forward.sort((left, right) => (
      (Math.abs(left.x - from.x) + Math.abs(left.y - from.y)) - (Math.abs(right.x - from.x) + Math.abs(right.y - from.y))
    ))[0]
    if (!next) return
    event.preventDefault()
    const element = frameRef.current?.querySelector<HTMLElement>(`.board-cell[data-cell="${next.x},${next.y}"]`)
    element?.focus()
  }

  return (
    <div
      className={'map-scroll ' + (dragging ? 'dragging' : '')}
      style={{
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        '--counter-scale': 1 / zoom,
      } as React.CSSProperties}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
      onPointerLeave={leaveBoard}
      onWheel={zoomWithWheel}
      onDoubleClick={() => { setPan({ x: 0, y: 0 }); setZoom(1) }}
      onKeyDown={moveFocus}
      onClickCapture={(event) => {
        if (activeAnimationRef.current) {
          skipAnimations()
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (suppressClick.current) {
          // Конец перетаскивания. Одного `return` мало: флаг уже сброшен, и
          // bubble-обработчик ниже принял бы этот же click за ход в клетку,
          // над которой отпустили кнопку.
          suppressClick.current = false
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (!(event.target as HTMLElement).closest('.map-token')) onBackgroundActivate?.()
      }}
      onClick={(event) => {
        // Клик по холсту переводится в координату клетки арифметикой, а не
        // поиском DOM-узла: пустая клетка узла не имеет.
        if (suppressClick.current || (event.target as HTMLElement).closest('button')) return
        const position = cellFromPoint(event.clientX, event.clientY)
        if (!position) return
        activeByKey.get(`${position.x},${position.y}`)?.onActivate?.()
      }}
      role="group"
      aria-label={ariaLabel}
    >
      <div
        ref={frameRef}
        className={`board-frame ${irregular ? 'irregular' : ''} ${levelShift ? `level-change-${levelShift}` : ''}`}
        style={{ width: `calc(var(--cell) * ${columns})`, height: `calc(var(--cell) * ${rows})` }}
      >
        <canvas ref={canvasRef} className="board-canvas" aria-hidden="true" />
        {decoration}
        <div
          className="board-cells"
          style={{
            gridTemplateColumns: `repeat(${columns}, var(--cell))`,
            gridTemplateRows: `repeat(${rows}, var(--cell))`,
          }}
        >
          {cells.map((node) => {
            const CellElement: 'button' | 'div' = node.interactive ? 'button' : 'div'
            return (
              <CellElement
                key={`${node.x}-${node.y}`}
                type={node.interactive ? 'button' : undefined}
                className={`board-cell ${node.interactive ? 'interactive' : ''} ${node.className}`}
                style={{ gridColumn: node.x + 1, gridRow: node.y + 1 }}
                data-cell={`${node.x},${node.y}`}
                aria-label={node.ariaLabel}
                title={node.title}
                onPointerEnter={node.onPointerEnter}
                onPointerLeave={node.onPointerLeave}
                onClick={(event) => {
                  if (!node.interactive) return
                  event.stopPropagation()
                  // Клик после перетаскивания карты — это конец жеста, а не ход.
                  if (suppressClick.current) return
                  node.onActivate?.()
                }}
                onKeyDown={(event) => {
                  if (!node.interactive || (event.key !== 'Enter' && event.key !== ' ')) return
                  event.preventDefault()
                  node.onActivate?.()
                }}
              >
                {node.children}
              </CellElement>
            )
          })}
          {hoverCell && hoverHint && (
            <div
              key={`hint-${hoverKey}`}
              className="board-cell hover-probe"
              style={{ gridColumn: hoverCell.x + 1, gridRow: hoverCell.y + 1 }}
              data-cell={hoverKey}
              aria-label={hoverHint.ariaLabel}
              title={hoverHint.title}
            />
          )}
        </div>
        <div
          className="board-hotspots"
          style={{
            gridTemplateColumns: `repeat(${columns}, var(--cell))`,
            gridTemplateRows: `repeat(${rows}, var(--cell))`,
          }}
        >
          {cells.filter((node) => node.hotspot).map((node) => (
            <div
              key={`hotspot-${node.x}-${node.y}`}
              className="board-hotspot-cell"
              style={{ gridColumn: node.x + 1, gridRow: node.y + 1 }}
            >
              {node.hotspot}
            </div>
          ))}
        </div>
        <canvas ref={effectsCanvasRef} className="board-effects-canvas" aria-hidden="true" />
        {activeAnimation && (
          <button
            type="button"
            className="board-animation-skip"
            onClick={(event) => { event.stopPropagation(); skipAnimations() }}
            aria-label="Пропустить боевые анимации"
          >
            Пропустить
          </button>
        )}
      </div>
    </div>
  )
}
