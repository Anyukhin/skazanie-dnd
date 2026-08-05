import type { TacticalDoorState, TacticalMap } from './types'
import { LIGHT_SOURCE_ASSETS, lightSourceAssetId } from './board-lighting'
import { cellAt, revealedAt } from './tactical-map-client'
import type { BoardContext2D, BoardScene, BoardViewport } from './board-render'

/**
 * Живой слой доски — этап L7 (`docs/multilevel-map-plan.md`, раздел 7.3).
 *
 * Всё здесь рисуется на `board-effects-canvas` поверх статичной местности:
 * базовый холст и тайловый кэш не трогаются вовсе. Модуль чистый — ни канвы
 * своей, ни React, ни `Date.now()`: время приходит параметром, фазы выводятся
 * из идентификаторов. Поэтому кадр целиком воспроизводим и меряется поддельным
 * контекстом, как и остальная отрисовка.
 *
 * Три источника движения:
 *
 * - мерцание огня у предметов из `LIGHT_SOURCE_ASSETS`;
 * - блики на поверхности воды;
 * - короткий поворот створки при смене состояния двери.
 *
 * Первые два выключаются `prefers-reduced-motion`, третий тоже: у пользователя,
 * который просил не двигать картинку, дверь просто мгновенно перерисуется
 * штатной инвалидацией тайла.
 */

/** Период мерцания огня. Свеча колеблется медленно — это не стробоскоп. */
export const FIRE_FLICKER_PERIOD_MS = 2_600

/** Второй, более частый обертон: без него мерцание читается синусоидой. */
export const FIRE_FLICKER_OVERTONE = 0.61

/** Размах мерцания: доля радиуса ореола. Пять процентов — предел заметности. */
export const FIRE_FLICKER_AMPLITUDE = 0.06

/** Базовая непрозрачность живого ореола поверх запечённого в тайл. */
export const FIRE_HALO_ALPHA = 0.05

/** Период пробега блика по воде. */
export const WATER_GLINT_PERIOD_MS = 7_000

export const WATER_GLINT_ALPHA = 0.13

/** Длительность поворота створки двери. */
export const DOOR_SWING_MS = 150

/** Цвет блика на воде: холодный, светлее самой воды. */
const WATER_GLINT_COLOR = '#cfe8ef'

/** Смена состояния двери, которую ещё показывает створка. */
export type BoardDoorSwing = {
  doorId: string
  state: TacticalDoorState
  /** Момент начала в той же шкале, что и `timeMs` кадра. */
  startedAt: number
}

export type AmbientFire = {
  id: string
  x: number
  y: number
  /** Радиус ореола в клетках — тот же, что у запечённого света. */
  radius: number
  /** Фаза колебания, доля периода. Детерминирована идентификатором предмета. */
  phase: number
}

export type AmbientWaterCell = { x: number; y: number; phase: number }

/**
 * Фаза по идентификатору: доля периода в [0, 1). Два факела в одной комнате
 * обязаны мерцать вразнобой, но каждый — всегда одинаково, и от кадра к кадру
 * фаза не должна «переезжать».
 */
export function ambientPhase(id: string) {
  let hash = 0x811c9dc5
  const source = String(id)
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d)
  return ((hash ^ (hash >>> 13)) >>> 0) / 0x100000000
}

/** Попадает ли клетка в окно просмотра с запасом в одну клетку. */
function inView(view: BoardViewport | undefined, x: number, y: number, margin = 1) {
  if (!view) return true
  return x >= view.x - margin && x <= view.x + view.width + margin
    && y >= view.y - margin && y <= view.y + view.height + margin
}

type AmbientCache = { signature: string; fires: AmbientFire[]; water: AmbientWaterCell[] }

/**
 * Разбор карты на источники движения делается один раз на карту, а не на кадр:
 * обход 100×100 шестьдесят раз в секунду — это и есть весь бюджет кадра.
 * Ключ — объект карты, отпечаток страхует от правки на месте (тот же приём,
 * что у `lightGridFor`).
 */
const ambientCache = new WeakMap<TacticalMap, AmbientCache>()

function ambientSourcesOf(map: TacticalMap): AmbientCache {
  const cached = ambientCache.get(map)
  if (cached && cached.signature === map.terrainHash) return cached
  const fires: AmbientFire[] = []
  for (const prop of map.props) {
    const assetId = lightSourceAssetId(prop.assetId)
    if (!assetId) continue
    const x = Math.floor(prop.x)
    const y = Math.floor(prop.y)
    if (!cellAt(map, x, y)) continue
    fires.push({ id: prop.id, x, y, radius: LIGHT_SOURCE_ASSETS[assetId].radius, phase: ambientPhase(prop.id) })
  }
  const water: AmbientWaterCell[] = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell || cell.surface !== 'water') continue
      water.push({ x, y, phase: ambientPhase(`${map.seed}:${x}:${y}`) })
    }
  }
  const entry: AmbientCache = { signature: map.terrainHash, fires, water }
  ambientCache.set(map, entry)
  return entry
}

/**
 * Видимый огонь: раскрытый и попавший в окно. Нераскрытый огонь не мерцает —
 * иначе слой эффектов выдавал бы, где в тумане горит очаг.
 */
export function ambientFires(map: TacticalMap, view?: BoardViewport): AmbientFire[] {
  return ambientSourcesOf(map).fires.filter((fire) => (
    revealedAt(map, fire.x, fire.y) && inView(view, fire.x, fire.y, fire.radius)
  ))
}

/** Видимая вода: раскрытая и попавшая в окно. */
export function ambientWaterCells(map: TacticalMap, view?: BoardViewport): AmbientWaterCell[] {
  return ambientSourcesOf(map).water.filter((cell) => (
    revealedAt(map, cell.x, cell.y) && inView(view, cell.x, cell.y)
  ))
}

/**
 * Есть ли на экране что анимировать. На этом держится главное требование
 * этапа: без огня и воды в окне цикл `requestAnimationFrame` **не заводится**,
 * а не крутится вхолостую, сжигая батарею ноутбука за игровой вечер.
 */
export function hasAmbientMotion(map: TacticalMap | null | undefined, view?: BoardViewport, reducedMotion = false) {
  if (!map || reducedMotion) return false
  return ambientFires(map, view).length > 0 || ambientWaterCells(map, view).length > 0
}

/**
 * Колебание огня в момент `timeMs`: значение в [−1, 1]. Две синусоиды с
 * несоизмеримыми периодами дают неровное пламя вместо честного синуса, но
 * остаются чистой функцией времени и фазы.
 */
export function fireFlicker(timeMs: number, phase: number) {
  const base = Math.sin(((timeMs / FIRE_FLICKER_PERIOD_MS) + phase) * Math.PI * 2)
  const overtone = Math.sin(((timeMs / (FIRE_FLICKER_PERIOD_MS * FIRE_FLICKER_OVERTONE)) + phase * 1.7) * Math.PI * 2)
  return base * 0.65 + overtone * 0.35
}

function circlePath(context: BoardContext2D, x: number, y: number, radius: number) {
  context.beginPath()
  context.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2)
  context.fill()
}

function drawFireFlicker(
  context: BoardContext2D, scene: BoardScene, fires: readonly AmbientFire[], timeMs: number,
) {
  const size = scene.cellSize
  context.fillStyle = scene.palette.lightWarm
  for (const fire of fires) {
    const pulse = fireFlicker(timeMs, fire.phase)
    const radius = fire.radius * size * (1 + pulse * FIRE_FLICKER_AMPLITUDE)
    const centerX = (fire.x + 0.5) * size
    const centerY = (fire.y + 0.5) * size
    context.globalAlpha = Math.max(0, FIRE_HALO_ALPHA * (1 + pulse * 0.4))
    circlePath(context, centerX, centerY, radius)
    // Ядро у самого огня: там колебание заметнее, а размер меньше.
    context.globalAlpha = Math.max(0, FIRE_HALO_ALPHA * 1.4 * (1 + pulse * 0.6))
    circlePath(context, centerX, centerY, radius * 0.34)
  }
  context.globalAlpha = 1
}

function drawWaterGlints(
  context: BoardContext2D, scene: BoardScene, cells: readonly AmbientWaterCell[], timeMs: number,
) {
  const size = scene.cellSize
  context.strokeStyle = WATER_GLINT_COLOR
  context.lineWidth = Math.max(1, size / 18)
  for (const cell of cells) {
    const drift = ((timeMs / WATER_GLINT_PERIOD_MS) + cell.phase) % 1
    const alpha = WATER_GLINT_ALPHA * Math.sin(drift * Math.PI)
    if (alpha <= 0.004) continue
    const left = cell.x * size
    const top = cell.y * size + size * (0.18 + drift * 0.64)
    context.globalAlpha = alpha
    context.beginPath()
    context.moveTo(left + size * 0.14, top)
    context.lineTo(left + size * 0.62, top - size * 0.05)
    context.stroke()
  }
  context.globalAlpha = 1
}

/**
 * Створка в движении. Дверь живёт на ребре, поэтому створка — это полоса вдоль
 * ребра, повёрнутая вокруг петли: закрытие ведёт её к ребру, открытие — от
 * него. Через `DOOR_SWING_MS` анимация кончается, и дверь дорисовывает уже
 * тайловый кэш — своим штатным механизмом инвалидации по `terrainHash`.
 */
function drawDoorSwings(
  context: BoardContext2D, scene: BoardScene, swings: readonly BoardDoorSwing[], timeMs: number,
) {
  const size = scene.cellSize
  const thickness = Math.max(1.5, size / 6)
  for (const swing of swings) {
    const door = scene.map.doors.find((entry) => entry.id === swing.doorId)
    if (!door) continue
    const progress = Math.max(0, Math.min(1, (timeMs - swing.startedAt) / DOOR_SWING_MS))
    if (progress >= 1) continue
    const opening = swing.state === 'open' || swing.state === 'broken'
    // Открытие уводит створку от косяка, закрытие — возвращает к нему.
    const turn = (opening ? progress : 1 - progress) * (Math.PI / 2)
    const vertical = door.dir === 'e'
    const hingeX = (vertical ? door.x + 1 : door.x) * size
    const hingeY = (vertical ? door.y : door.y + 1) * size
    context.save()
    context.globalAlpha = 0.9
    context.fillStyle = scene.palette.door
    context.translate(hingeX, hingeY)
    context.rotate(vertical ? turn : -turn)
    if (vertical) context.fillRect(-thickness / 2, 0, thickness, size)
    else context.fillRect(0, -thickness / 2, size, thickness)
    context.restore()
    context.globalAlpha = 1
  }
}

export type AmbientFrameOptions = {
  /** Время кадра, мс. Приходит извне — модуль часов не заводит. */
  timeMs: number
  view?: BoardViewport
  reducedMotion?: boolean
  doorSwings?: readonly BoardDoorSwing[]
}

/**
 * Кадр живого слоя целиком. Координаты — абсолютные клеточные, как у остальных
 * рендереров эффектов (`drawLingeringSpellEffects`): холст эффектов совпадает с
 * базовым по геометрии.
 *
 * Пустая сцена не рисует ничего — ни одной команды. Именно это даёт циклу
 * право заснуть: список команд пуст, значит и кадр не нужен.
 */
export function drawAmbientEffects(context: BoardContext2D, scene: BoardScene, options: AmbientFrameOptions) {
  if (options.reducedMotion === true) return
  const swings = (options.doorSwings ?? []).filter((swing) => options.timeMs - swing.startedAt < DOOR_SWING_MS)
  const fires = ambientFires(scene.map, options.view)
  const water = ambientWaterCells(scene.map, options.view)
  if (!fires.length && !water.length && !swings.length) return
  context.save()
  if (fires.length) drawFireFlicker(context, scene, fires, options.timeMs)
  if (water.length) drawWaterGlints(context, scene, water, options.timeMs)
  if (swings.length) drawDoorSwings(context, scene, swings, options.timeMs)
  // Прозрачность возвращается руками: поддельный контекст тестов не обязан
  // хранить стек состояний.
  context.globalAlpha = 1
  context.restore()
}

/**
 * Нужен ли следующий кадр. Цикл спрашивает это после каждой отрисовки и
 * останавливается, как только движение кончилось: догорела последняя створка,
 * ушёл из окна последний огонь, пользователь попросил не двигать картинку.
 */
export function ambientFrameWanted(
  map: TacticalMap | null | undefined,
  options: AmbientFrameOptions,
) {
  if (options.reducedMotion === true) return false
  const swings = (options.doorSwings ?? []).some((swing) => options.timeMs - swing.startedAt < DOOR_SWING_MS)
  return swings || hasAmbientMotion(map, options.view)
}
