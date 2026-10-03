// @ts-check
/**
 * Карта по программе сцены — этап 3 `docs/map-generation-plan.md`.
 *
 * Генератор темы строит улицу, дома и обстановку, но о словах сцены не знает.
 * Программа (`server/scene-requirements.mjs`) говорит, что обязано стоять на
 * карте и где: центр сцены — посреди открытой площадки, в нескольких шагах от
 * входа отряда; настилы — приподнятым деревянным полом без лазания; камни на
 * пороге — у дверей домов. Этот модуль ставит их **после** темы и **до**
 * остального обещанного, поэтому центр получает лучшее место, а не остаток.
 *
 * Чего модуль не делает: не двигает дома к площади и не разворачивает их
 * двери — это геометрия поселения, и она остаётся за `scene-themes.mjs`.
 * Посты жителей ставит `npc-positioning.mjs` по той же программе; здесь им
 * только обеспечивается предмет.
 *
 * Детерминированно: всё от сида карты и программы. Карта уже сыгранного места
 * лежит в памяти локации и сюда не попадает, поэтому старые кампании и replay
 * не меняются.
 */
import { createHash } from 'node:crypto'
import { assetById } from './asset-registry.mjs'
import { ensurePropAccess, placeRequiredProps } from './prop-placement.mjs'
import { normalizeSceneRequirements, requirementAssets, requirementTerrain } from './scene-requirements.mjs'
import { addProp, cellAt, edgeNeighbor, reachableCells, setCell } from './tactical-map.mjs'

/** @typedef {import('./tactical-map.mjs').TacticalMap} TacticalMap */

/** Версия расстановки по программе; её ставят только новые карты. */
export const SCENE_PROGRAM_LAYOUT_VERSION = 'scene-program-layout/v1'

/** Высота настила в футах: шаг на него не требует лазания (`OPEN_TERRAIN_MAX_STEP_FEET`). */
export const PLATFORM_ELEVATION_FEET = 2

/**
 * Наибольший шаг между соседними клетками без лазания — тот же предел, что у
 * рельефа открытой местности (`OPEN_TERRAIN_MAX_STEP_FEET` в `scene-themes.mjs`).
 */
const OPEN_STEP_FEET = 3

/** Центр сцены — в этих пределах шагов от входа отряда. */
const FOCUS_DISTANCE = Object.freeze({ min: 6, max: 10 })

/** @param {string} value */
const hashNumber = (value) => createHash('sha256').update(value).digest().readUInt32LE(0)

/**
 * Клетки, которые заняты предметом, мешающим шагу.
 * @param {TacticalMap} map
 * @returns {Set<string>}
 */
function blockedByProps(map) {
  /** @type {Set<string>} */
  const blocked = new Set()
  for (const prop of map.props) {
    if (!prop.blocksMove || prop.mount) continue
    const footprint = prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
    for (const point of footprint) blocked.add(`${point.x},${point.y}`)
  }
  return blocked
}

/**
 * Клетки у дверей: обе стороны полотна и по клетке за ними — их не занимает
 * ничто, как и в обычной расстановке.
 * @param {TacticalMap} map
 * @returns {Set<string>}
 */
function doorApproaches(map) {
  /** @type {Set<string>} */
  const cells = new Set()
  for (const door of map.doors) {
    const next = edgeNeighbor(door)
    const step = { x: next.x - door.x, y: next.y - door.y }
    for (const point of [{ x: door.x, y: door.y }, next, { x: door.x - step.x, y: door.y - step.y }, { x: next.x + step.x, y: next.y + step.y }]) cells.add(`${point.x},${point.y}`)
  }
  return cells
}

/**
 * Наружные проходимые клетки, досягаемые от входа отряда.
 * @param {TacticalMap} map
 * @returns {{ cells: Array<{x: number, y: number}>, party: {x: number, y: number}|null }}
 */
function openGround(map) {
  const party = map.spawnPoints.find((point) => point.role === 'party') ?? null
  const kind = new Map(map.zones.map((zone) => [zone.id, zone.kind]))
  const reached = party ? reachableCells(map, party.x, party.y, { blockedCells: blockedByProps(map) }) : null
  /** @type {Array<{x: number, y: number}>} */
  const cells = []
  for (let y = 1; y < map.height - 1; y += 1) for (let x = 1; x < map.width - 1; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.passable || cell.surface === 'water' || kind.get(cell.zone) === 'interior') continue
    if (reached && !reached.has(`${x},${y}`)) continue
    cells.push({ x, y })
  }
  return { cells, party }
}

/**
 * Простор вокруг клетки: шагов до ближайшей непроходимой, занятой или
 * дверной клетки (до `limit`). Чем больше, тем больше площадь вокруг.
 * @param {TacticalMap} map
 * @param {{x: number, y: number}} point
 * @param {Set<string>} taken
 * @param {number} limit
 */
function clearance(map, point, taken, limit) {
  for (let radius = 1; radius <= limit; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
      const x = point.x + dx
      const y = point.y + dy
      const cell = cellAt(map, x, y)
      if (!cell?.passable || cell.surface === 'water' || taken.has(`${x},${y}`)) return radius - 1
    }
  }
  return limit
}

/**
 * Центр сцены: предмет из `assets` посреди самой открытой площадки, в 6–10
 * шагах от входа отряда. Уже стоящий на открытом месте предмет того же вида
 * засчитывается — второй колодец на площадь не ставится.
 *
 * @param {TacticalMap} map
 * @param {string[]} assets
 * @param {{ seed: string }} options
 * @returns {string|null} id предмета центра или null, если места нет
 */
export function placeSceneFocus(map, assets, { seed }) {
  const asset = assets.map((id) => assetById(id)).find(Boolean)
  if (!asset) return null
  const ids = new Set(assets)
  const { cells, party } = openGround(map)
  const open = new Set(cells.map((cell) => `${cell.x},${cell.y}`))
  const existing = map.props.find((prop) => ids.has(prop.assetId) && open.has(`${Math.floor(prop.x)},${Math.floor(prop.y)}`))
  if (existing) return existing.id
  const taken = new Set([...blockedByProps(map), ...doorApproaches(map)])
  const width = Math.max(1, asset.baseFootprint.w || 1)
  const height = Math.max(1, asset.baseFootprint.h || 1)
  const tie = hashNumber(`${seed}:${SCENE_PROGRAM_LAYOUT_VERSION}:focus`)
  /** @type {{ x: number, y: number, score: number, footprint: Array<{x: number, y: number}> }|null} */
  let best = null
  for (const [index, cell] of cells.entries()) {
    /** @type {Array<{x: number, y: number}>} */
    const footprint = []
    for (let dy = 0; dy < height; dy += 1) for (let dx = 0; dx < width; dx += 1) footprint.push({ x: cell.x + dx, y: cell.y + dy })
    if (footprint.some((point) => !open.has(`${point.x},${point.y}`) || taken.has(`${point.x},${point.y}`))) continue
    // Простор считается от каждой клетки предмета: навес 3×2 не встаёт в
    // проулок, где свободна лишь одна его клетка.
    const room = Math.min(...footprint.map((point) => clearance(map, point, taken, 4)))
    if (room < 1) continue
    const steps = party ? Math.abs(cell.x - party.x) + Math.abs(cell.y - party.y) : FOCUS_DISTANCE.min
    const away = steps < FOCUS_DISTANCE.min ? FOCUS_DISTANCE.min - steps : steps > FOCUS_DISTANCE.max ? steps - FOCUS_DISTANCE.max : 0
    // Простор важнее расстояния: площадь посреди деревни лучше пятачка у входа.
    const score = room * 10 - away * 2 - ((index + tie) % 7) / 10
    if (!best || score > best.score) best = { x: cell.x, y: cell.y, score, footprint }
  }
  if (!best) return null
  const span = asset.scaleRange.max - asset.scaleRange.min
  const prop = addProp(map, {
    id: `program-focus-${asset.id}`,
    assetId: asset.id,
    x: best.x + width / 2,
    y: best.y + height / 2,
    rotation: 0,
    scale: Number((asset.scaleRange.min + span / 2).toFixed(3)),
    footprint: best.footprint,
    zOrder: 0,
    blocksMove: asset.blocksMove,
    blocksSight: asset.blocksSight,
    cover: asset.cover,
    destructible: asset.destructible,
    hp: asset.hp,
    interactive: asset.interactive,
  })
  return prop.id
}

/**
 * Настилы: прямоугольники 3×2 приподнятого деревянного пола на открытой
 * земле. Высота два фута — шаг, а не стена, поэтому на настил всходят без
 * лазания, и путь к нему не меняется. Один настил от другого и от предметов —
 * через клетку прохода.
 *
 * @param {TacticalMap} map
 * @param {number} count
 * @param {{ seed: string }} options
 * @returns {number} сколько настилов построено
 */
export function buildPlatforms(map, count, { seed }) {
  const { cells } = openGround(map)
  const open = new Set(cells.map((cell) => `${cell.x},${cell.y}`))
  // Проход вокруг настила не держат только предметы, мешающие шагу; под самим
  // настилом не лежит ничего — даже цветы и трава.
  const blocked = new Set([...blockedByProps(map), ...doorApproaches(map)])
  const covered = new Set(blocked)
  for (const prop of map.props) {
    const footprint = prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
    for (const point of footprint) covered.add(`${point.x},${point.y}`)
  }
  const party = map.spawnPoints.find((point) => point.role === 'party')
  const level = (/** @type {number} */ x, /** @type {number} */ y) => cellAt(map, x, y)?.elevation ?? 0
  // Кандидаты — по порядку сида: настилы встают в разных местах у разных деревень.
  const order = cells
    .map((cell, index) => ({ cell, key: hashNumber(`${seed}:${SCENE_PROGRAM_LAYOUT_VERSION}:platform:${index}`) }))
    .sort((left, right) => left.key - right.key)
  let built = 0
  // Два прохода. Первый — с полем вокруг: клетка прохода по периметру, чтобы
  // настил не прилипал к дому. Второй, если мест не хватило, — только сам
  // настил и хотя бы две клетки подхода: в лесу свободного поля 5×4 почти нет,
  // а высота шагу не мешает, поэтому настил среди деревьев проход не запирает.
  for (const strict of [true, false]) {
    for (const { cell } of order) {
      if (built >= count) break
      /** @type {Array<{x: number, y: number}>} */
      const footprint = []
      for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 3; dx += 1) footprint.push({ x: cell.x + dx, y: cell.y + dy })
      // На склоне настил ровный и стоит на два фута выше самой высокой земли
      // под собой, а шаг с него на соседнюю землю — не больше трёх футов, как
      // и везде на открытой местности.
      const top = Math.max(...footprint.map((point) => level(point.x, point.y))) + PLATFORM_ELEVATION_FEET
      let fits = true
      let approach = 0
      for (let dy = -1; dy <= 2 && fits; dy += 1) for (let dx = -1; dx <= 3 && fits; dx += 1) {
        const key = `${cell.x + dx},${cell.y + dy}`
        const inside = dx >= 0 && dx <= 2 && dy >= 0 && dy <= 1
        const ground = level(cell.x + dx, cell.y + dy)
        if (inside) {
          if (!open.has(key) || covered.has(key) || top - ground > PLATFORM_ELEVATION_FEET + OPEN_STEP_FEET) fits = false
          continue
        }
        const usable = open.has(key) && !blocked.has(key) && Math.abs(top - ground) <= OPEN_STEP_FEET
        if (usable) approach += 1
        else if (strict) fits = false
      }
      if (!fits || approach < 2) continue
      // У самого входа настил мешал бы отряду встать: не ближе пяти шагов.
      if (party && footprint.some((point) => Math.abs(point.x - party.x) + Math.abs(point.y - party.y) < 5)) continue
      for (const point of footprint) setCell(map, point.x, point.y, { material: 'wood', elevation: top })
      // Соседний настил — не вплотную: клетки вокруг этого заняты для следующих.
      for (let dy = -1; dy <= 2; dy += 1) for (let dx = -1; dx <= 3; dx += 1) {
        blocked.add(`${cell.x + dx},${cell.y + dy}`)
        covered.add(`${cell.x + dx},${cell.y + dy}`)
      }
      built += 1
    }
  }
  return built
}

/**
 * Камни на пороге: плоский камень на наружной клетке у двери дома — по одному
 * у стольких домов, сколько обещано («у ближайших домов» — у ближайших ко
 * входу отряда). Камень плоский и шаг не держит, поэтому проём не запирает.
 *
 * @param {TacticalMap} map
 * @param {number} count
 * @returns {number}
 */
export function placeThresholdStones(map, count) {
  const asset = assetById('path_stone')
  if (!asset) return 0
  const kind = new Map(map.zones.map((zone) => [zone.id, zone.kind]))
  const party = map.spawnPoints.find((point) => point.role === 'party')
  const busy = new Set(map.props.map((prop) => `${Math.floor(prop.x)},${Math.floor(prop.y)}`))
  /** @type {Array<{x: number, y: number, steps: number, door: string}>} */
  const outside = []
  for (const door of map.doors) {
    const next = edgeNeighbor(door)
    for (const point of [{ x: door.x, y: door.y }, next]) {
      const cell = cellAt(map, point.x, point.y)
      const other = point === next ? cellAt(map, door.x, door.y) : cellAt(map, next.x, next.y)
      if (!cell?.passable || kind.get(cell.zone) === 'interior' || kind.get(other?.zone ?? '') !== 'interior') continue
      const steps = party ? Math.abs(point.x - party.x) + Math.abs(point.y - party.y) : 0
      outside.push({ x: point.x, y: point.y, steps, door: door.id })
    }
  }
  outside.sort((left, right) => left.steps - right.steps || left.door.localeCompare(right.door))
  let placed = 0
  for (const point of outside) {
    if (placed >= count) break
    if (busy.has(`${point.x},${point.y}`)) continue
    addProp(map, {
      id: `program-threshold-${point.door}`,
      assetId: asset.id,
      x: point.x + 0.5,
      y: point.y + 0.5,
      rotation: 0,
      scale: asset.scaleRange.min,
      footprint: [],
      zOrder: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      destructible: asset.destructible,
      hp: asset.hp,
      interactive: asset.interactive,
    })
    busy.add(`${point.x},${point.y}`)
    placed += 1
  }
  return placed
}

/**
 * Программа сцены на карте: центр, настилы, камни на пороге, затем остальное
 * обещанное прежней расстановкой. Мутирует карту.
 *
 * @param {TacticalMap} map
 * @param {unknown} program `scene.map_requirements` или список `items`
 * @param {{ seed: string }} options
 * @returns {TacticalMap}
 */
export function applyScenePlan(map, program, { seed }) {
  const source = program && typeof program === 'object' && !Array.isArray(program) ? /** @type {Record<string, any>} */ (program) : {}
  const items = normalizeSceneRequirements(program)
  if (!items.length) return map
  const focus = typeof source.focus === 'string' ? source.focus : ''
  if (focus) placeSceneFocus(map, requirementAssets(focus), { seed: `${seed}:focus` })
  for (const item of items) {
    if (requirementTerrain(item.id) === 'platform') buildPlatforms(map, item.count, { seed: `${seed}:platform` })
    if (item.id === 'threshold_stone') placeThresholdStones(map, Math.max(2, item.count))
  }
  const promised = items
    .filter((item) => item.id !== 'threshold_stone' && !requirementTerrain(item.id))
    .map((item) => ({ assets: requirementAssets(item.id), count: item.count }))
    .filter((item) => item.assets.length)
  if (promised.length) placeRequiredProps(map, promised, { seed: `${seed}:scene-requirements` })
  ensurePropAccess(map)
  return map
}
