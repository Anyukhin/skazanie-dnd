import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TacticalMap, TacticalMaterial } from './types'
import {
  DEFAULT_BOARD_PALETTE, TILE_CELLS, boardPaletteFrom, createTileCache, drawBoardOverlay,
  syncTileCache, visibleTiles,
  type BoardOverlayCell, type BoardPalette, type BoardScene, type BoardTexture, type TileSurface,
} from './board-render'

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

/** Текстуры местности. Их отсутствие — штатный путь Р6, доска остаётся играбельной. */
const TERRAIN_TEXTURES: Array<[TacticalMaterial, string]> = [
  ['stone', '/assets/maps/terrain/stone.webp'],
  ['wood', '/assets/maps/terrain/wood.webp'],
  ['earth', '/assets/maps/terrain/earth.webp'],
  ['grass', '/assets/maps/terrain/grass.webp'],
  ['sand', '/assets/maps/terrain/sand.webp'],
  ['marble', '/assets/maps/terrain/marble.webp'],
  ['metal', '/assets/maps/terrain/metal.webp'],
]

const loadedTextures = new Map<string, BoardTexture>()
const loadedArt = new Map<string, BoardTexture>()

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
  children?: React.ReactNode
}

/** Подсказка клетки, у которой нет собственного узла: причина недоступности. */
export type BoardCellHint = { title?: string; ariaLabel?: string }

export function TacticalBoard({
  map, columns, rows, irregular, ariaLabel, themeKey, artUrl, cells, cellHints, overlayCells, decoration,
  onBackgroundActivate,
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
  decoration?: React.ReactNode
  onBackgroundActivate?: () => void
}) {
  const [zoom, setZoom] = useState(1)
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [cellPixels, setCellPixels] = useState(0)
  const [assetsVersion, setAssetsVersion] = useState(0)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cacheRef = useRef(createTileCache())
  const paletteRef = useRef<BoardPalette>(DEFAULT_BOARD_PALETTE)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; startPanX: number; startPanY: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const hovered = useRef<string | null>(null)

  useEffect(() => {
    const notify = () => setAssetsVersion((value) => value + 1)
    for (const [, url] of TERRAIN_TEXTURES) loadImage(url, loadedTextures, notify)
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

  const textures = useMemo(() => {
    const available = new Map<string, BoardTexture>()
    for (const [material, url] of TERRAIN_TEXTURES) {
      const texture = loadedTextures.get(url)
      if (texture) available.set(material, texture)
    }
    // Лёд текстуры не имеет — он рисуется заливкой и декалью.
    return available
  }, [assetsVersion])

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
    const scene: BoardScene = {
      map,
      palette: paletteRef.current,
      cellSize,
      textures,
      art: artUrl ? loadedArt.get(artUrl) ?? null : null,
      artKey: artUrl ?? '',
    }

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
  }, [map, columns, rows, cellPixels, zoom, textures, artUrl, overlayCells, assetsVersion])

  useEffect(() => { paint() }, [paint, pan.x, pan.y])

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
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
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
        if (suppressClick.current) {
          suppressClick.current = false
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
        className={`board-frame ${irregular ? 'irregular' : ''}`}
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
                onPointerDown={(event) => { if (node.interactive) event.stopPropagation() }}
                onPointerUp={(event) => { if (node.interactive) event.stopPropagation() }}
                onClick={(event) => {
                  if (!node.interactive) return
                  event.stopPropagation()
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
      </div>
    </div>
  )
}
