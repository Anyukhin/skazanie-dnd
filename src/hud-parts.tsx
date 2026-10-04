/* Детали игрового стола по макетам «Игровой стол» и «Редизайн · бой»:
   мини-карта, полоса ячеек заклинаний, выбор круга ячейки, спасброски от
   смерти, подсказка плитки, ручка ширины меню и выбор палитры.

   Каждый элемент показывает только серверное состояние, которое уже пришло в
   проекции, и вызывает только существующие команды: своей механики здесь нет.
   Чего сервер не знает (вдохновение, наборы оружия, варианты реплик), того
   здесь и не рисуется. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TacticalMap } from './types'
import type { BoardAnimationActor } from './TacticalBoard'
import { passableAt, revealedAt } from './tactical-map-client'
import { Palette } from 'lucide-react'
import { applyPalette, loadPalette, PALETTES, type PaletteId } from './ui-palette'

/* ---------------- хранилище настроек зрителя ---------------- */

/** localStorage без исключений: приватный режим или запрет не ломают стол. */
export const viewerStorage = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string) {
    try { window.localStorage.setItem(key, value) } catch { /* настройка необязательна */ }
  },
  remove(key: string) {
    try { window.localStorage.removeItem(key) } catch { /* настройка необязательна */ }
  },
}

/** Цвет из токена палитры в виде, понятном canvas. */
function resolveCssColor(probe: HTMLElement | null, expression: string, fallback: string) {
  if (!probe) return fallback
  probe.style.color = ''
  probe.style.color = expression
  const value = getComputedStyle(probe).color
  return value || fallback
}

/** Номер палитры: меняется при смене `data-pal`, чтобы холсты перерисовались. */
export function usePaletteVersion() {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((value) => value + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-pal'] })
    return () => observer.disconnect()
  }, [])
  return version
}

/* ---------------- мини-карта ---------------- */

export const MINIMAP_STORAGE_KEY = 'skazanie.board.minimap'

export function useMinimapPreference() {
  const [visible, setVisible] = useState(() => viewerStorage.get(MINIMAP_STORAGE_KEY) !== 'off')
  const toggle = useCallback(() => setVisible((current) => {
    const next = !current
    if (next) viewerStorage.remove(MINIMAP_STORAGE_KEY)
    else viewerStorage.set(MINIMAP_STORAGE_KEY, 'off')
    return next
  }), [])
  return [visible, toggle] as const
}

const MINIMAP_WIDTH = 168
const MINIMAP_HEIGHT = 108

/**
 * Мини-карта поверх поля: раскрытые клетки (проходимые светлее стен) и фишки
 * тех, кого игрок и так видит на доске. Нераскрытое не рисуется — туман войны
 * на мини-карте тот же, что на поле. Клик ставит выбранную клетку в центр поля.
 */
export function BoardMiniMap({ map, actors, focusActorId, onPick }: {
  map: TacticalMap
  actors: readonly BoardAnimationActor[]
  focusActorId?: string
  onPick: (x: number, y: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const probeRef = useRef<HTMLSpanElement | null>(null)
  const paletteVersion = usePaletteVersion()
  const scale = Math.max(1, Math.min(MINIMAP_WIDTH / Math.max(1, map.width), MINIMAP_HEIGHT / Math.max(1, map.height)))
  const offsetX = (MINIMAP_WIDTH - map.width * scale) / 2
  const offsetY = (MINIMAP_HEIGHT - map.height * scale) / 2
  const actorSignature = actors.map((actor) => `${actor.id}:${actor.x},${actor.y}:${actor.kind}:${actor.defeated ? 1 : 0}`).join('|')

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(MINIMAP_WIDTH * ratio)
    canvas.height = Math.round(MINIMAP_HEIGHT * ratio)
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const probe = probeRef.current
    const colors = {
      back: resolveCssColor(probe, 'var(--well)', '#0c0a08'),
      floor: resolveCssColor(probe, 'color-mix(in srgb, var(--text2) 34%, var(--raise))', '#5a534b'),
      wall: resolveCssColor(probe, 'var(--frame)', '#4a3a28'),
      hero: resolveCssColor(probe, 'var(--ally)', '#7fb38a'),
      self: resolveCssColor(probe, 'var(--acc2)', '#e8bf82'),
      enemy: resolveCssColor(probe, 'var(--enemy)', '#d8695c'),
      npc: resolveCssColor(probe, 'var(--npc)', '#7fb3a6'),
    }
    context.fillStyle = colors.back
    context.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT)
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (!revealedAt(map, x, y)) continue
        context.fillStyle = passableAt(map, x, y) ? colors.floor : colors.wall
        context.fillRect(offsetX + x * scale, offsetY + y * scale, Math.ceil(scale), Math.ceil(scale))
      }
    }
    const dot = Math.max(2.5, scale * .9)
    for (const actor of actors) {
      if (actor.defeated || !revealedAt(map, actor.x, actor.y)) continue
      const own = actor.id === focusActorId
      context.fillStyle = own ? colors.self : actor.kind === 'enemy' ? colors.enemy : actor.kind === 'neutral' ? colors.npc : colors.hero
      const size = (actor.footprint?.size ?? 1) * scale
      const radius = own ? dot * .75 + 1 : dot * .6
      context.beginPath()
      context.arc(offsetX + actor.x * scale + size / 2, offsetY + actor.y * scale + size / 2, Math.max(radius, size * .35), 0, Math.PI * 2)
      context.fill()
    }
  }, [map, actorSignature, focusActorId, paletteVersion, scale, offsetX, offsetY])

  const pick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.floor(((event.clientX - rect.left) * MINIMAP_WIDTH / rect.width - offsetX) / scale)
    const y = Math.floor(((event.clientY - rect.top) * MINIMAP_HEIGHT / rect.height - offsetY) / scale)
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return
    onPick(x, y)
  }

  return <div className="board-minimap">
    <span ref={probeRef} className="board-minimap-probe" aria-hidden="true" />
    <canvas
      ref={canvasRef}
      style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
      onClick={pick}
      role="img"
      aria-label="Мини-карта: раскрытая часть локации и участники. Щелчок ставит место в центр поля"
      title="Мини-карта. Щелчок — показать это место на поле"
    />
  </div>
}

/* ---------------- привязка к полю ---------------- */

/**
 * Рамка поля на экране — для плашек, которые стоят над полем, а живут в
 * корне приложения (окно реакции). Без поля (другой раздел) — `null`, и
 * плашка встаёт по центру экрана.
 */
export function useBoardFrame() {
  const [frame, setFrame] = useState<{ left: number; width: number; bottom: number } | null>(null)
  useLayoutEffect(() => {
    const stage = document.querySelector<HTMLElement>('.map-stage')
    if (!stage) { setFrame(null); return }
    const measure = () => {
      const rect = stage.getBoundingClientRect()
      setFrame(rect.width > 0 ? { left: rect.left, width: rect.width, bottom: Math.max(0, window.innerHeight - rect.bottom) } : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  return frame
}

/* ---------------- ячейки заклинаний ---------------- */

export const SPELL_LEVEL_ROMANS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']

export type SpellSlotPool = { level: number; current: number; max: number }

/** Ячейки по кругам из серверных запасов `spell_slots_N` (и ячейки договора). */
export function spellSlotPools(resources: Readonly<Record<string, { current?: number; max?: number } | undefined>>) {
  const levels: SpellSlotPool[] = []
  for (let level = 1; level <= 9; level += 1) {
    const pool = resources[`spell_slots_${level}`]
    const max = Math.max(0, Number(pool?.max ?? 0))
    if (max > 0) levels.push({ level, current: Math.max(0, Number(pool?.current ?? 0)), max })
  }
  const pactPool = resources.pact_slots
  const pact = pactPool && Number(pactPool.max ?? 0) > 0
    ? { current: Math.max(0, Number(pactPool.current ?? 0)), max: Math.max(0, Number(pactPool.max ?? 0)) }
    : null
  return { levels, pact }
}

/**
 * Полоса ячеек над плитками, как в макете заклинателя: круг, камни и остаток.
 * Щелчок по кругу оставляет в колоде заклинаний только заклинания, которые
 * этим кругом можно сотворить, — это экранная выборка, ресурс не тратится.
 */
export function SpellSlotBar({ resources, filterLevel, concentration, onToggleLevel }: {
  resources: Readonly<Record<string, { current?: number; max?: number } | undefined>>
  filterLevel: number | null
  concentration?: string | null
  onToggleLevel: (level: number) => void
}) {
  const { levels, pact } = spellSlotPools(resources)
  const barRef = useRef<HTMLDivElement | null>(null)
  const [compact, setCompact] = useState(false)
  const signature = levels.map((pool) => `${pool.level}:${pool.current}/${pool.max}`).join('|') + (pact ? `|p${pact.current}/${pact.max}` : '') + (concentration ?? '')
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const measure = () => {
      bar.classList.remove('compact')
      const overflow = bar.scrollWidth > bar.clientWidth + 1
      if (overflow) bar.classList.add('compact')
      setCompact(overflow)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [signature])
  if (!levels.length && !pact) return null
  return <div ref={barRef} className={`hud-slotbar${compact ? ' compact' : ''}`} role="group" aria-label="Ячейки заклинаний">
    {levels.map((pool) => {
      const roman = SPELL_LEVEL_ROMANS[pool.level - 1]
      const pressed = filterLevel === pool.level
      return <button
        key={pool.level}
        type="button"
        className="hud-slot"
        aria-pressed={pressed}
        onClick={() => onToggleLevel(pool.level)}
        title={`Ячейки ${roman} круга: ${pool.current} из ${pool.max}. ${pressed ? 'Щелчок — показать все заклинания' : 'Щелчок — показать заклинания, доступные этому кругу'}`}
        aria-label={`Ячейки ${roman} круга: ${pool.current} из ${pool.max}`}
      >{roman}{Array.from({ length: pool.max }, (_, index) => <i key={index} className={index < pool.current ? '' : 'off'} aria-hidden="true" />)}<em>{pool.current}/{pool.max}</em></button>
    })}
    {pact && <span className="hud-slot pact" title={`Ячейки договора: ${pact.current} из ${pact.max}. Восстанавливаются после короткого отдыха`} aria-label={`Ячейки договора: ${pact.current} из ${pact.max}`}>Договор{Array.from({ length: pact.max }, (_, index) => <i key={index} className={index < pact.current ? '' : 'off'} aria-hidden="true" />)}<em>{pact.current}/{pact.max}</em></span>}
    {concentration && <span className="hud-slot concentration" title={`Концентрация: ${concentration}. Урон требует спасброска Телосложения`}>◎ {concentration}</span>}
  </div>
}

/* ---------------- выбор круга ячейки ---------------- */

/**
 * Всплывающий выбор круга, как `.upc` макета: появляется, когда заклинание
 * можно сотворить ячейками нескольких кругов. Выбор кладётся в тот же
 * `slot_level` команды `CastSpell`, что и список «Ячейка» в параметрах действия.
 */
export function UpcastPopover({ spellName, baseLevel, pools, selectedLevel, anchor, onPick, onClose }: {
  spellName: string
  baseLevel: number
  pools: readonly SpellSlotPool[]
  selectedLevel: number | null
  anchor: DOMRect
  onPick: (level: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const width = element.offsetWidth
    const height = element.offsetHeight
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, anchor.left + anchor.width / 2 - width / 2))
    const top = Math.max(8, anchor.top - height - 10)
    setPosition({ left, top })
  }, [anchor])
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)')
      ?? ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    first?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    const onDown = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose() }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true) }
  }, [onClose])
  const usable = pools.filter((pool) => pool.level >= baseLevel)
  return <div ref={ref} className="hud-upcast" role="dialog" aria-label={`Круг ячейки: ${spellName}`} style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}>
    <h3>{spellName}</h3>
    <p>Выберите круг ячейки. Чем выше круг, тем сильнее эффект — насколько, решает сервер по правилам заклинания.</p>
    <div className="hud-upcast-list">
      {usable.map((pool) => <button
        key={pool.level}
        type="button"
        disabled={pool.current <= 0}
        aria-pressed={selectedLevel === pool.level}
        onClick={() => onPick(pool.level)}
      ><b>{SPELL_LEVEL_ROMANS[pool.level - 1]}</b><span>{pool.level === baseLevel ? 'обычный круг' : `+${pool.level - baseLevel} к кругу`}</span><span>{pool.current} / {pool.max}</span></button>)}
    </div>
  </div>
}

/* ---------------- спасброски от смерти ---------------- */

/**
 * Самоцветы спасбросков, как `.ds` макета. Бросает их сервер сам в начале хода
 * героя (`DeathSavingThrowRolled`), поэтому кнопки броска здесь нет: панель
 * только показывает счёт и говорит, чего ждать.
 */
export function DeathSavesPanel({ name, successes, failures, stable, dead }: { name: string; successes: number; failures: number; stable: boolean; dead: boolean }) {
  const row = (count: number, tone: 'ok' | 'no', label: string) => <div className={`hud-ds-row ${tone}`} aria-label={`${label}: ${Math.min(3, count)} из 3`}>
    <span>{label}</span>{[0, 1, 2].map((index) => <i key={index} className={index < count ? 'on' : ''} aria-hidden="true" />)}
  </div>
  return <section className="hud-death-saves" aria-label={`Спасброски от смерти: ${name}`}>
    <div className="hud-ds-title">Спасброски от смерти</div>
    {row(successes, 'ok', 'Успехи')}
    {row(failures, 'no', 'Провалы')}
    <p className="hud-ds-note">{dead ? `${name}: путь окончен.` : stable ? `${name}: состояние стабильно, но сознания нет. Поднимет только лечение.` : 'Бросок d20 делает сервер в начале хода героя: 10+ — успех, 20 — встать с 1 хитом.'}</p>
  </section>
}

/* ---------------- подсказка плитки действия ---------------- */

type TileTip = { left: number; top: number; title: string; cost: string; costKind: string; body: string; meta: string }

/**
 * Подсказка плитки, как `.tip` макета: название, цена в экономике хода и
 * описание. Текст берётся из самой плитки (`title`, подпись и метка цены),
 * которую уже собрал сервер-ориентированный код колоды; пока подсказка на
 * экране, системная всплывашка браузера подавлена, чтобы не было двух.
 */
export function useTileTooltip(containerRef: React.RefObject<HTMLElement | null>) {
  const [tip, setTip] = useState<TileTip | null>(null)
  const current = useRef<{ tile: HTMLElement; title: string } | null>(null)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const release = () => {
      if (current.current) {
        if (!current.current.tile.getAttribute('title')) current.current.tile.setAttribute('title', current.current.title)
        current.current = null
      }
      setTip(null)
    }
    const show = (target: EventTarget | null) => {
      const tile = (target as HTMLElement | null)?.closest?.('.action-tile') as HTMLElement | null
      if (!tile || !container.contains(tile)) return
      if (current.current?.tile === tile) return
      release()
      const title = tile.getAttribute('title') ?? ''
      if (!title) return
      tile.removeAttribute('title')
      current.current = { tile, title }
      const name = tile.querySelector('strong')?.textContent?.trim() ?? ''
      const costElement = tile.querySelector('.action-cost')
      const cost = costElement?.textContent?.trim() ?? ''
      const costKind = [...(costElement?.classList ?? [])].find((name) => name !== 'action-cost') ?? ''
      const meta = tile.querySelector('small')?.textContent?.trim() ?? ''
      const body = name && title.startsWith(name) ? title.slice(name.length).replace(/^\s*[—:-]\s*/, '') : title
      const rect = tile.getBoundingClientRect()
      setTip({ left: rect.left + rect.width / 2, top: rect.top, title: name || title, cost, costKind, body, meta })
    }
    const over = (event: Event) => show(event.target)
    const out = (event: Event) => {
      const next = (event as PointerEvent | FocusEvent).relatedTarget as Node | null
      if (current.current && next && current.current.tile.contains(next)) return
      release()
    }
    container.addEventListener('pointerover', over)
    container.addEventListener('pointerout', out)
    container.addEventListener('focusin', over)
    container.addEventListener('focusout', out)
    container.addEventListener('pointerdown', release)
    return () => {
      container.removeEventListener('pointerover', over)
      container.removeEventListener('pointerout', out)
      container.removeEventListener('focusin', over)
      container.removeEventListener('focusout', out)
      container.removeEventListener('pointerdown', release)
      release()
    }
  }, [containerRef])
  return tip
}

export function TileTooltip({ tip }: { tip: TileTip | null }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!tip || !ref.current) { setPosition(null); return }
    const width = ref.current.offsetWidth
    const height = ref.current.offsetHeight
    setPosition({
      left: Math.min(window.innerWidth - width - 8, Math.max(8, tip.left - width / 2)),
      top: Math.max(8, tip.top - height - 10),
    })
  }, [tip])
  if (!tip) return null
  return <div ref={ref} className="hud-tip" role="tooltip" style={position ?? { visibility: 'hidden', left: 0, top: 0 }}>
    <div className="hud-tip-head"><h3>{tip.title}</h3>{tip.cost && <span className={`hud-tip-cost ${tip.costKind}`}><i aria-hidden="true" />{tip.cost}</span>}</div>
    {tip.meta && <p className="hud-tip-meta">{tip.meta}</p>}
    {tip.body && <p>{tip.body}</p>}
  </div>
}

/* ---------------- сетка плиток ---------------- */

/**
 * Сколько колонок плиток помещается в лоток: плитки идут строками, как в
 * макете (2 ряда), а свободные места до края показываются пустыми гнёздами.
 * Если плиток больше, чем помещается, лоток прокручивается вбок, как раньше.
 */
export function useFitColumns(ref: React.RefObject<HTMLElement | null>, fallback = 7) {
  const [columns, setColumns] = useState(fallback)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const style = getComputedStyle(element)
      const sample = element.querySelector<HTMLElement>('.action-tile, .action-tile-empty')
      const slot = sample?.getBoundingClientRect().width || 64
      const gap = parseFloat(style.columnGap) || 4
      const width = element.clientWidth
      if (width > 0) setColumns(Math.max(1, Math.floor((width + gap) / (slot + gap))))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return columns
}

/* ---------------- ручка ширины меню ---------------- */

export const RAIL_WIDTH_KEY = 'skazanie.ui.rail-width'
const RAIL_LIMITS = [64, 260] as const
const RAIL_WIDE_FROM = 150

function applyRailWidth(width: number | null) {
  const root = document.documentElement
  if (width == null) {
    root.style.removeProperty('--ui-rail-width')
    delete root.dataset.rail
    return
  }
  root.style.setProperty('--ui-rail-width', `${width}px`)
  if (width >= RAIL_WIDE_FROM) root.dataset.rail = 'wide'
  else delete root.dataset.rail
}

/** Сброс ширины меню и хроники — кнопка в настройках и двойной щелчок по ручкам. */
export function resetColumnWidths(serverWidthKey: string) {
  viewerStorage.remove(RAIL_WIDTH_KEY)
  viewerStorage.remove(serverWidthKey)
  applyRailWidth(null)
  document.documentElement.style.removeProperty('--ui-server-column')
  window.dispatchEvent(new CustomEvent('skazanie:columns-reset'))
}

/**
 * Ручка у правого края меню разделов (`.grip` макета). Ширина 64–260 px;
 * от 150 px подписи пунктов встают в строку рядом со значком. Значение
 * переживает перезагрузку, двойной щелчок или Enter возвращают обычную.
 */
export function RailGrip() {
  const [width, setWidth] = useState<number | null>(() => {
    const saved = Number(viewerStorage.get(RAIL_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= RAIL_LIMITS[0] ? Math.min(RAIL_LIMITS[1], saved) : null
  })
  const [dragging, setDragging] = useState(false)
  useEffect(() => { applyRailWidth(width) }, [width])
  useEffect(() => {
    const reset = () => setWidth(null)
    window.addEventListener('skazanie:columns-reset', reset)
    return () => window.removeEventListener('skazanie:columns-reset', reset)
  }, [])
  const clamp = (value: number) => Math.round(Math.min(RAIL_LIMITS[1], Math.max(RAIL_LIMITS[0], value)))
  const commit = (value: number | null) => {
    setWidth(value)
    if (value == null) viewerStorage.remove(RAIL_WIDTH_KEY)
    else viewerStorage.set(RAIL_WIDTH_KEY, String(value))
  }
  const current = () => (document.querySelector('.app-rail') as HTMLElement | null)?.getBoundingClientRect().width ?? 84
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    setDragging(true)
    document.body.classList.add('is-resizing-columns')
    const left = (document.querySelector('.app-rail') as HTMLElement | null)?.getBoundingClientRect().left ?? 0
    let last: number | null = null
    const move = (moveEvent: PointerEvent) => { last = clamp(moveEvent.clientX - left); setWidth(last) }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      setDragging(false)
      document.body.classList.remove('is-resizing-columns')
      if (last != null) commit(last)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }
  const key = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = clamp(current() - step)
    else if (event.key === 'ArrowRight') next = clamp(current() + step)
    else if (event.key === 'Home') next = RAIL_LIMITS[0]
    else if (event.key === 'End') next = RAIL_LIMITS[1]
    else if (event.key === 'Enter') { event.preventDefault(); commit(null); return }
    if (next != null) { event.preventDefault(); commit(next) }
  }
  return <div
    className={`column-grip rail-grip${dragging ? ' on' : ''}`}
    role="separator"
    aria-orientation="vertical"
    aria-label="Ширина меню разделов"
    aria-valuemin={RAIL_LIMITS[0]}
    aria-valuemax={RAIL_LIMITS[1]}
    aria-valuenow={width ?? 84}
    tabIndex={0}
    title="Потяните, чтобы изменить ширину. Двойной щелчок — вернуть обычную"
    onPointerDown={start}
    onDoubleClick={() => commit(null)}
    onKeyDown={key}
  ><i aria-hidden="true" /></div>
}

/* ---------------- палитры в настройках ---------------- */

/** Карточка настроек «Палитра и колонки»: свой выбор, своё хранилище. */
export function PaletteSettingsCard({ serverWidthKey }: { serverWidthKey: string }) {
  const [palette, setPalette] = useState<PaletteId>(() => loadPalette())
  const [resetDone, setResetDone] = useState(false)
  return <div className="settings-card settings-palette-card">
    <div className="settings-card-title"><Palette size={20} /><span><b>Палитра и колонки</b><small>Только в этом браузере</small></span></div>
    <PalettePicker
      value={palette}
      onChange={(id) => setPalette(applyPalette(id))}
      onResetColumns={() => { resetColumnWidths(serverWidthKey); setResetDone(true); window.setTimeout(() => setResetDone(false), 1800) }}
    />
    {resetDone && <p className="palette-reset-note" role="status">Ширина меню и хроники — по умолчанию.</p>}
  </div>
}

export function PalettePicker({ value, onChange, onResetColumns }: { value: PaletteId; onChange: (id: PaletteId) => void; onResetColumns: () => void }) {
  return <div className="palette-picker">
    <div className="palette-grid" role="radiogroup" aria-label="Палитра интерфейса">
      {PALETTES.map((palette) => {
        const [bg, raise, acc, text, hp] = palette.preview
        return <button
          key={palette.id}
          type="button"
          role="radio"
          aria-checked={palette.id === value}
          className="palette-card"
          onClick={() => onChange(palette.id)}
        >
          <span className="palette-preview" style={{ background: bg }} aria-hidden="true">
            <span className="palette-preview-title" style={{ background: raise, color: text }}>Причал в тумане</span>
            <span className="palette-preview-row">
              <span style={{ width: '38%', height: 6, background: hp }} />
              <span style={{ width: 15, height: 15, background: raise, boxShadow: `inset 0 0 0 1.5px ${acc}` }} />
              <span style={{ width: 15, height: 15, background: raise }} />
              <span style={{ marginLeft: 'auto', width: 30, height: 13, background: acc }} />
            </span>
            <span className="palette-preview-line" style={{ background: text }} />
          </span>
          <b>{palette.name}</b>
          <small>{palette.description}</small>
        </button>
      })}
    </div>
    <div className="palette-actions">
      <small>Палитра меняет цвета интерфейса в этом браузере. Ширину меню и хроники можно менять, потянув за край колонки.</small>
      <button type="button" onClick={onResetColumns}>Сбросить ширину колонок</button>
    </div>
  </div>
}
