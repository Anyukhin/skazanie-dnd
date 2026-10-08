import { createHash } from 'node:crypto'

import { assetById } from './asset-registry.mjs'
import {
  addProp,
  addSpawnPoint,
  addZone,
  cellAt,
  createTacticalMap,
  edgeBetween,
  edgeNeighbor,
  reachableCells,
  setCell,
  setDoor,
  setEdge,
} from './tactical-map.mjs'
import { thinWalls } from './thin-walls.mjs'
import { applyRoomFloors, buildingWallStyleFor } from './room-floors.mjs'

/**
 * Поселение — отдельный генератор геометрии, а не вариант раскраски четырёх
 * одинаковых домов. Его результат всё ещё обычная TacticalMap, поэтому старые
 * проекция, движение, реквизит и сохранение не получают второго формата.
 */
// v5 (2026-10-03): дверь дома в глубине — по тропе до улицы, и тропа проложена.
// v6 (2026-10-08): рыночная площадь шире, на ней ряды лотков с проходами.
export const SETTLEMENT_GENERATOR = Object.freeze({ id: 'settlement-layout', version: '6' })

const TOPOLOGIES = new Set(['organic', 'linear', 'crossroads', 'market', 'courtyard', 'harbor', 'river', 'terraced', 'gate'])
const CLIMATES = new Set(['temperate', 'arid', 'cold', 'wetland'])
const ARCHITECTURES = new Set(['wood', 'stone', 'sand', 'metal', 'marble', 'ice'])
const DENSITIES = new Set(['sparse', 'mixed', 'dense'])
const BUILDING_USES = new Set(['dwelling', 'tavern', 'shop', 'manor'])

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))
const key = (x, y) => `${x},${y}`

function integer(value, fallback) {
  return Number.isSafeInteger(Number(value)) ? Number(value) : fallback
}

function randomFor(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function pickArchitecture(theme, design) {
  if (ARCHITECTURES.has(design?.architecture)) return design.architecture
  const value = `${theme?.id ?? ''} ${theme?.label ?? ''} ${theme?.houseMaterial ?? ''}`.toLocaleLowerCase('ru')
  if (/пустын|оазис|пес/u.test(value)) return 'sand'
  if (/порт|гаван|мрамор|дворец/u.test(value)) return 'stone'
  if (/(?<![а-яё])(?:лед|лёд|льд)|снег|(?<![а-яё])север|тундр/u.test(value)) return 'ice'
  if (/металл|станци|тех/u.test(value)) return 'metal'
  return theme?.houseMaterial && ARCHITECTURES.has(theme.houseMaterial) ? theme.houseMaterial : 'wood'
}

function designFor(theme, seed, input = {}) {
  const value = `${theme?.id ?? ''} ${theme?.label ?? ''}`.toLocaleLowerCase('ru')
  const random = randomFor(`settlement-design:${seed}:${value}`)
  const topology = TOPOLOGIES.has(input.topology)
    ? input.topology
    : /порт|гаван/u.test(value) ? 'harbor'
      : /рек|берег|канал/u.test(value) ? 'river'
        : /рынок|торгов/u.test(value) ? 'market'
          : /ворот|застав|крепост/u.test(value) ? 'gate'
            : ['organic', 'linear', 'crossroads', 'market', 'courtyard', 'terraced', 'gate', 'harbor', 'river'][Math.floor(random() * 9)]
  const climate = CLIMATES.has(input.climate)
    ? input.climate
    : /пустын|оазис|пес/u.test(value) ? 'arid'
      : /(?<![а-яё])(?:лед|лёд|льд)|снег|(?<![а-яё])север|тундр/u.test(value) ? 'cold'
        : /болот|топ|плавн|берег/u.test(value) ? 'wetland'
          : 'temperate'
  const density = DENSITIES.has(input.density) ? input.density : random() < 0.25 ? 'sparse' : random() < 0.75 ? 'mixed' : 'dense'
  const buildingUse = BUILDING_USES.has(input.building_use) ? input.building_use : /таверн|трактир/u.test(value) ? 'tavern' : /рынок|торгов|лавк/u.test(value) ? 'shop' : 'dwelling'
  const scale = ['village', 'town', 'city'].includes(input.scale) ? input.scale : ''
  // Площадь посреди деревни: её просит центр программы сцены — навес,
  // колодец, костёр, вокруг которых стоят люди (`server/scene-program-layout.mjs`).
  return { topology, climate, architecture: pickArchitecture(theme, input), density, building_use: buildingUse, scale, square: input.square === true }
}

function materials(design, theme) {
  const surface = design.climate === 'arid' ? 'sand' : design.climate === 'cold' ? 'ice' : design.climate === 'wetland' ? 'grass' : 'grass'
  const street = design.climate === 'arid' ? 'sand' : design.architecture === 'metal' ? 'metal' : theme?.streetMaterial && ARCHITECTURES.has(theme.streetMaterial) ? theme.streetMaterial : 'earth'
  return { surface, street, building: design.architecture }
}

function rectCells(rect) {
  const cells = []
  for (let y = rect.y; y < rect.y + rect.h; y += 1) for (let x = rect.x; x < rect.x + rect.w; x += 1) cells.push({ x, y })
  return cells
}

function shapeCells(spec) {
  const cells = new Map(rectCells(spec).map((cell) => [key(cell.x, cell.y), cell]))
  if (spec.extension) for (const cell of rectCells(spec.extension)) cells.set(key(cell.x, cell.y), cell)
  return [...cells.values()]
}

function edgeFor(from, to) {
  if (to.x === from.x + 1 && to.y === from.y) return { x: from.x, y: from.y, dir: 'e' }
  if (to.x === from.x - 1 && to.y === from.y) return { x: to.x, y: to.y, dir: 'e' }
  if (to.y === from.y + 1 && to.x === from.x) return { x: from.x, y: from.y, dir: 's' }
  return { x: to.x, y: to.y, dir: 's' }
}

function labelFor(design, index) {
  const labels = {
    dwelling: ['Дом', 'Жильё', 'Подворье', 'Семейный двор'],
    tavern: ['Таверна', 'Постоялый двор', 'Питейный дом', 'Гостевой двор'],
    shop: ['Лавка', 'Склад', 'Торговый дом', 'Мастерская'],
    manor: ['Усадьба', 'Дом старосты', 'Резиденция', 'Контора'],
    // «Сеновал» — задняя комната крупного амбара, а не имя постройки.
    barn: ['Амбар', 'Конюшня', 'Скотный двор', 'Сарай'],
    workshop: ['Мастерская', 'Столярня', 'Красильня', 'Гончарня'],
  }
  const list = labels[design.building_use] ?? labels.dwelling
  // Таверна, лавка и амбар в поселении одни — номер им не нужен.
  if (design.building_use !== 'dwelling') return list[index % list.length]
  return `${list[index % list.length]} ${index + 1}`
}

/**
 * Состав поселения. Прежде все дома получали одно назначение сцены, и
 * деревня была рядом одинаковых жилищ. Теперь самая крупная постройка —
 * таверна, следующие — лавка и амбар (в плотном городе вместо амбара —
 * мастерская), остальное — жильё. Особым назначением занимается не больше
 * половины построек: деревня остаётся деревней. Назначение самой сцены
 * (например, «рынок» — лавка) идёт первым.
 *
 * @param {Array<{w: number, h: number}>} specs
 * @param {{building_use: string, density: string}} design
 * @returns {string[]}
 */
function settlementUses(specs, design) {
  const order = specs.map((spec, index) => ({ index, area: spec.w * spec.h }))
    .sort((left, right) => right.area - left.area || left.index - right.index)
  const uses = specs.map(() => 'dwelling')
  const plan = design.building_use !== 'dwelling' ? [design.building_use] : []
  // Город держит больше заведений: две таверны, лавки, мастерские и дом
  // градоначальника; амбара в городе нет.
  const urban = design.scale === 'town' || design.scale === 'city'
  const wanted = urban
    ? ['tavern', 'manor', 'shop', 'shop', 'workshop', 'tavern', 'shop', 'workshop', ...(design.scale === 'city' ? ['manor', 'shop', 'workshop'] : [])]
    : ['tavern', 'shop', design.density === 'dense' ? 'workshop' : 'barn']
  for (const use of wanted) if (urban || !plan.includes(use)) plan.push(use)
  const special = Math.min(plan.length, Math.floor(specs.length * (urban ? 0.45 : 0.5)))
  for (let rank = 0; rank < special; rank += 1) uses[order[rank].index] = plan[rank]
  // Амбару нужен пол хотя бы на 28 клеток: в избу 4×5 стог с проходом не
  // встаёт, и «амбар» выходил пустой коробкой. Тесный амбар меняется местами
  // с самым просторным жильём, а если такого нет — остаётся жильём.
  const floor = (/** @type {number} */ index) => Math.max(0, specs[index].w - 2) * Math.max(0, specs[index].h - 2)
  const barn = uses.findIndex((use) => use === 'barn')
  if (barn >= 0 && floor(barn) < 28) {
    const roomy = order.map((entry) => entry.index).find((index) => uses[index] === 'dwelling' && floor(index) >= 28)
    if (roomy !== undefined) { uses[roomy] = 'barn'; uses[barn] = 'dwelling' } else uses[barn] = 'dwelling'
  }
  return uses
}

function canPlace(spec, occupied, map) {
  return shapeCells(spec).every((cell) => {
    const position = key(cell.x, cell.y)
    return cell.x >= 2 && cell.y >= 2 && cell.x < map.width - 2 && cell.y < map.height - 2
      && !occupied.has(position) && cellAt(map, cell.x, cell.y)?.surface !== 'water'
      && !['street', 'square'].includes(cellAt(map, cell.x, cell.y)?.zone)
  })
}

function densityCount(density, random) {
  const ranges = {
    sparse: [4, 6],
    mixed: [6, 9],
    dense: [8, 11],
  }
  const [minimum, maximum] = ranges[density] ?? ranges.mixed
  return minimum + Math.floor(random() * (maximum - minimum + 1))
}

const BUILDING_SIZES = Object.freeze([
  [5, 8], [6, 6], [8, 5], [7, 7], [9, 5], [5, 9], [8, 7],
])
const DENSE_BUILDING_SIZES = Object.freeze([
  [5, 6], [6, 5], [6, 6], [7, 5], [5, 7], [7, 6],
])
const SPARSE_BUILDING_SIZES = Object.freeze([
  [6, 6], [8, 5], [7, 7], [9, 5], [5, 9], [8, 7],
])

function reserveSpec(occupied, spec) {
  for (const cell of shapeCells(spec)) {
    occupied.add(key(cell.x, cell.y))
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) occupied.add(key(cell.x + dx, cell.y + dy))
  }
}

function planSpec(specs, occupied, spec, map) {
  if (!canPlace(spec, occupied, map)) return false
  specs.push(spec)
  reserveSpec(occupied, spec)
  return true
}

function shuffled(items, random) {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const value = result[index]
    result[index] = result[swap]
    result[swap] = value
  }
  return result
}

function sizeFor(index, random, density) {
  const offset = Math.floor(random() * BUILDING_SIZES.length)
  const sizes = density === 'dense' ? DENSE_BUILDING_SIZES : density === 'sparse' ? SPARSE_BUILDING_SIZES : BUILDING_SIZES
  const pair = sizes[(index + offset) % sizes.length]
  return { w: pair[0], h: pair[1] }
}

function makeSpec(x, y, w, h, extension = null) {
  return { x, y, w, h, extension, doorX: x + Math.floor(w / 2), doorY: y + h - 1 }
}

function fitsRegion(spec, region) {
  return shapeCells(spec).every((cell) => (
    cell.x >= region.x && cell.y >= region.y
      && cell.x < region.x + region.w && cell.y < region.y + region.h
  ))
}

function organicExtension(x, y, size, region) {
  const candidates = [
    { x: x + size.w - 1, y: y + size.h - 3, w: 3, h: 3 },
    { x: x + size.w - 3, y: y + size.h - 1, w: 3, h: 3 },
    { x: x - 2, y: y + size.h - 3, w: 3, h: 3 },
    { x: x + size.w - 3, y: y - 2, w: 3, h: 3 },
  ]
  return candidates.find((extension) => fitsRegion(makeSpec(x, y, size.w, size.h, extension), region)) ?? null
}

/**
 * Заполняет заданные области кандидатами. Отдельный планировщик позволяет
 * отказаться от тесного корпуса до его записи в карту и тем самым не выдавать
 * частично перекрытые или недостижимые здания.
 */
function planInRegions(map, random, target, regions, { organic = false, density = 'mixed' } = {}) {
  const specs = []
  const occupied = new Set()
  const shuffledRegions = shuffled(regions, random)
  let attempt = 0
  while (specs.length < target && attempt < target * 160) {
    const region = shuffledRegions[attempt % shuffledRegions.length]
    const size = sizeFor(specs.length + attempt, random, density)
    const maxX = region.x + region.w - size.w
    const maxY = region.y + region.h - size.h
    attempt += 1
    if (maxX < region.x || maxY < region.y) continue
    const x = region.x + Math.floor(random() * (maxX - region.x + 1))
    const y = region.y + Math.floor(random() * (maxY - region.y + 1))
    const extension = organic && random() < 0.6 ? organicExtension(x, y, size, region) : null
    const spec = makeSpec(x, y, size.w, size.h, extension)
    if (!fitsRegion(spec, region)) continue
    planSpec(specs, occupied, spec, map)
  }
  // Случайные кандидаты дают живой сдвиг корпусов, но на плотной схеме могут
  // случайно занять единственное место для соседнего дома. Сетка здесь —
  // детерминированная страховка, а не основной шаблон: она добирает цель,
  // если область всё ещё позволяет разместить корпус с проходом вокруг него.
  for (const region of shuffledRegions) {
    for (let y = region.y; y <= region.y + region.h - 5 && specs.length < target; y += 7) {
      for (let x = region.x; x <= region.x + region.w - 5 && specs.length < target; x += 6) {
        const size = sizeFor(specs.length, random, density)
        if (x + size.w > region.x + region.w || y + size.h > region.y + region.h) continue
        const extension = organic ? organicExtension(x, y, size, region) : null
        const spec = makeSpec(x, y, size.w, size.h, extension)
        if (!fitsRegion(spec, region)) continue
        planSpec(specs, occupied, spec, map)
      }
    }
  }
  return specs
}

function planGateBuildings(map, random, target, regions, density) {
  if (density !== 'dense') return planInRegions(map, random, target, regions, { density })
  const specs = []
  const occupied = new Set()
  for (const region of shuffled(regions, random)) {
    const heightRange = Math.max(1, Math.min(2, region.h - 6))
    const firstHeight = 6 + Math.floor(random() * heightRange)
    const secondHeight = 6 + Math.floor(random() * heightRange)
    const firstExtension = firstHeight + 2 <= region.h && random() < 0.5
      ? { x: region.x + 1, y: region.y + firstHeight - 1, w: 3, h: 3 }
      : null
    const slots = [
      makeSpec(region.x, region.y, 5, firstHeight, firstExtension),
      makeSpec(region.x + 6, region.y, 5, secondHeight),
    ].filter((spec) => fitsRegion(spec, region))
    for (const spec of slots) {
      if (specs.length >= target) return specs
      planSpec(specs, occupied, spec, map)
    }
  }
  return specs
}

function addBuilding(map, spec, index, design, occupied) {
  if (!canPlace(spec, occupied, map)) return false
  const zoneId = `building-${index + 1}`
  const footprint = shapeCells(spec)
  const footprintKeys = new Set(footprint.map((cell) => key(cell.x, cell.y)))
  addZone(map, { id: zoneId, kind: 'interior', material: design.architecture, lightLevel: 'dim', floorDirection: index % 2 ? 'vertical' : 'horizontal', label: labelFor(design, index) })
  for (const cell of footprint) {
    const boundary = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !footprintKeys.has(key(cell.x + dx, cell.y + dy)))
    setCell(map, cell.x, cell.y, {
      passable: !boundary, material: design.architecture, zone: boundary ? '' : zoneId, revealed: true,
    })
    if (boundary) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighbor = { x: cell.x + dx, y: cell.y + dy }
        if (footprintKeys.has(key(neighbor.x, neighbor.y)) || !cellAt(map, neighbor.x, neighbor.y)?.passable) continue
        setEdge(map, cell.x, cell.y, neighbor.x, neighbor.y, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
      }
    }
  }
  const candidates = footprint
    .filter((cell) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !footprintKeys.has(key(cell.x + dx, cell.y + dy))))
    .sort((left, right) => Math.abs(left.x - spec.doorX) + Math.abs(left.y - spec.doorY) - Math.abs(right.x - spec.doorX) - Math.abs(right.y - spec.doorY))
  const door = candidates.find((cell) => {
    const neighbors = [[cell.x + 1, cell.y], [cell.x - 1, cell.y], [cell.x, cell.y + 1], [cell.x, cell.y - 1]]
    const inside = neighbors.some(([x, y]) => footprintKeys.has(key(x, y)) && cellAt(map, x, y)?.passable)
    const outside = neighbors.some(([x, y]) => !footprintKeys.has(key(x, y)) && cellAt(map, x, y)?.passable && cellAt(map, x, y)?.surface !== 'water')
    return inside && outside
  }) ?? candidates[0]
  if (!door) return false
  const outside = [[door.x + 1, door.y], [door.x - 1, door.y], [door.x, door.y + 1], [door.x, door.y - 1]]
    .map(([x, y]) => ({ x, y }))
    .find((cell) => cellAt(map, cell.x, cell.y)?.passable && cellAt(map, cell.x, cell.y)?.surface !== 'water' && !footprintKeys.has(key(cell.x, cell.y)))
  if (!outside) return false
  setCell(map, door.x, door.y, { passable: true, material: design.architecture, zone: zoneId, revealed: true })
  const edge = edgeFor(door, outside)
  setDoor(map, { id: `${zoneId}-door`, ...edge, state: 'open', blocksMove: false, blocksSight: false })
  // Небольшой амбар — одно помещение под сено и скот; крупный делится на
  // конюшню и сеновал, иначе это пустой зал на сорок клеток.
  const largeBarn = design.building_use === 'barn' && (spec.w - 2) * (spec.h - 2) >= LARGE_HOUSE_FLOOR
  if (!spec.extension && (design.building_use !== 'barn' || largeBarn)) partitionHouse(map, spec, zoneId, index, design, door)
  openHouseWindows(map, footprint, footprintKeys, door)
  for (const cell of footprint) {
    occupied.add(key(cell.x, cell.y))
    // Оставляем один внешний шаг вокруг корпуса: соседние стены не должны
    // запирать дверь следующего здания и превращать декорацию в тупик.
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) occupied.add(key(cell.x + dx, cell.y + dy))
  }
  return true
}

function paintStreet(map, x, y, material, allowWater = false) {
  const cell = cellAt(map, x, y)
  if (cell && (allowWater || cell.surface !== 'water')) setCell(map, x, y, { passable: true, surface: 'none', material, zone: 'street', revealed: true })
}

function paintSquare(map, x, y, material) {
  const cell = cellAt(map, x, y)
  if (cell && cell.surface !== 'water') setCell(map, x, y, { passable: true, surface: 'none', material, zone: 'square', revealed: true })
}

function cellKey(cell) {
  return key(cell.x, cell.y)
}

function routeIgnoringEdges(map, from, target, blockedZone) {
  const startKey = cellKey(from)
  const targetKey = cellKey(target)
  const queue = [from]
  const previous = new Map([[startKey, null]])
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    if (cellKey(current) === targetKey) break
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: current.x + dx, y: current.y + dy }
      const nextKey = cellKey(next)
      if (previous.has(nextKey)) continue
      const cell = cellAt(map, next.x, next.y)
      if (!cell?.passable || cell.surface === 'water') continue
      if (cell.zone === blockedZone && nextKey !== targetKey) continue
      previous.set(nextKey, current)
      queue.push(next)
    }
  }
  if (!previous.has(targetKey)) return null
  const path = []
  let cursor = target
  while (cursor) {
    path.push(cursor)
    cursor = previous.get(cellKey(cursor)) ?? null
  }
  return path.reverse()
}

function openRouteEdges(map, path) {
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1]
    const current = path[index]
    if (edgeBetween(map, previous.x, previous.y, current.x, current.y)?.kind === 'door') continue
    setEdge(map, previous.x, previous.y, current.x, current.y, { kind: 'none' })
  }
}

function ensureBuildingReachability(map, spawn) {
  let reached = reachableCells(map, spawn.x, spawn.y, { throughDoors: true })
  const buildingZones = map.zones.filter((zone) => zone.id.startsWith('building-'))
  for (const zone of buildingZones) {
    const door = map.doors.find((entry) => entry.id === `${zone.id}-door`)
    if (!door) throw new Error(`У зоны ${zone.id} нет двери`)
    const endpoints = [{ x: door.x, y: door.y }, edgeNeighbor(door)]
    const inside = endpoints.find((cell) => cellAt(map, cell.x, cell.y)?.zone === zone.id)
    const outside = endpoints.find((cell) => cell !== inside && cellAt(map, cell.x, cell.y)?.passable)
    if (!inside || !outside) throw new Error(`У двери ${door.id} нет внутренней и внешней стороны`)
    if (!reached.has(cellKey(outside))) {
      const path = routeIgnoringEdges(map, spawn, outside, zone.id)
      if (!path) throw new Error(`Не удалось проложить путь к двери ${door.id}`)
      openRouteEdges(map, path)
      reached = reachableCells(map, spawn.x, spawn.y, { throughDoors: true })
    }
    const interior = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.passable && cell.zone === zone.id) interior.push({ x, y })
    }
    if (!interior.length || interior.some((cell) => !reached.has(cellKey(cell)))) {
      throw new Error(`Зона ${zone.id} осталась недостижимой`)
    }
  }
  for (const door of map.doors) {
    const endpoints = [{ x: door.x, y: door.y }, edgeNeighbor(door)]
    if (!endpoints.some((cell) => reached.has(cellKey(cell)))) throw new Error(`Дверь ${door.id} осталась недостижимой`)
  }
}

/** Вторая комната дома по назначению здания. */
const BACK_ROOM_LABELS = Object.freeze({ dwelling: 'Спальня', tavern: 'Кухня', shop: 'Кладовая', manor: 'Кабинет', workshop: 'Кладовая', barn: 'Сеновал' })

/** Третья комната крупного дома — за второй перегородкой в задней части. */
const SIDE_ROOM_LABELS = Object.freeze({ dwelling: 'Кладовая', tavern: 'Кладовая', shop: 'Мастерская', manor: 'Спальня', workshop: 'Спальня', barn: 'Кладовая' })

/**
 * С какой площади пола (клеток внутри стен) дом считается крупным: такой дом
 * делится на три комнаты, а не на две.
 */
export const LARGE_HOUSE_FLOOR = 35

/**
 * Перегородка с дверью: дом делится на жилую комнату у входа и заднюю
 * (спальню, кладовую, кухню). Однокомнатная коробка 7×3 — сарай, а не дом:
 * в ней негде поставить кровать отдельно от очага и некуда отступить.
 *
 * Делится только прямоугольный корпус, у которого вдоль длинной оси хватает
 * места на две комнаты: передняя не уже трёх клеток, задняя — не уже двух.
 * Дверной проём входа всегда остаётся в передней комнате.
 */
function partitionHouse(map, spec, zoneId, index, design, frontDoor) {
  const inner = { minX: spec.x + 1, minY: spec.y + 1, maxX: spec.x + spec.w - 2, maxY: spec.y + spec.h - 2 }
  const width = inner.maxX - inner.minX + 1
  const height = inner.maxY - inner.minY + 1
  const vertical = width >= height
  const length = vertical ? width : height
  if (length < 6 || width * height < 15) return
  // Внутренняя клетка у входной двери: по ней видно, какая сторона передняя.
  const entry = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: frontDoor.x + dx, y: frontDoor.y + dy }))
    .find((cell) => cell.x >= inner.minX && cell.x <= inner.maxX && cell.y >= inner.minY && cell.y <= inner.maxY)
    ?? { x: frontDoor.x, y: frontDoor.y }
  const front = Math.max(3, Math.ceil((length - 1) * 0.55))
  const back = length - 1 - front
  if (back < 2) return
  const start = vertical ? inner.minX : inner.minY
  const entryAxis = vertical ? entry.x : entry.y
  // Передняя комната — со стороны входа; если вход ближе к дальнему концу,
  // комнаты меняются местами.
  const entryNearStart = entryAxis - start < length / 2
  let wallAt = entryNearStart ? start + front : start + back
  // Стена не встаёт напротив входной двери: сдвигается на клетку вглубь,
  // если задней комнате хватает места, иначе к двери.
  const end = start + length - 1
  if (wallAt === entryAxis) wallAt = entryNearStart ? (end - (wallAt + 1) >= 2 ? wallAt + 1 : wallAt - 1) : (wallAt - 1 - start >= 2 ? wallAt - 1 : wallAt + 1)
  if (wallAt === entryAxis || wallAt <= start || wallAt >= end) return
  const backZone = `${zoneId}-back`
  addZone(map, { id: backZone, kind: 'interior', material: design.architecture, lightLevel: 'dim', floorDirection: vertical ? 'vertical' : 'horizontal', label: BACK_ROOM_LABELS[design.building_use] ?? 'Комната' })
  /** @type {Array<{x: number, y: number}>} */
  const wall = []
  for (let along = vertical ? inner.minY : inner.minX; along <= (vertical ? inner.maxY : inner.maxX); along += 1) {
    wall.push(vertical ? { x: wallAt, y: along } : { x: along, y: wallAt })
  }
  const isBack = (/** @type {number} */ x, /** @type {number} */ y) => {
    const axis = vertical ? x : y
    return entryNearStart ? axis > wallAt : axis < wallAt
  }
  for (let y = inner.minY; y <= inner.maxY; y += 1) for (let x = inner.minX; x <= inner.maxX; x += 1) {
    if (isBack(x, y)) setCell(map, x, y, { zone: backZone })
  }
  for (const cell of wall) {
    setCell(map, cell.x, cell.y, { passable: false, material: design.architecture, zone: '' })
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = cellAt(map, cell.x + dx, cell.y + dy)
      if (!neighbor?.passable) continue
      setEdge(map, cell.x, cell.y, cell.x + dx, cell.y + dy, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
    }
  }
  // Крупный дом: задняя часть делится ещё раз поперёк, и у каждой из двух
  // задних комнат своя дверь в переднюю. Дом на тридцать с лишним клеток
  // пола с одной перегородкой — два зала, а не жильё.
  const alongOf = (/** @type {{x: number, y: number}} */ cell) => (vertical ? cell.y - inner.minY : cell.x - inner.minX)
  const backDepth = entryNearStart ? end - wallAt : wallAt - start
  const split = width * height >= LARGE_HOUSE_FLOOR && wall.length >= 7 && backDepth >= 3
  const middle = Math.floor(wall.length / 2)
  /** @type {Array<{cell: {x: number, y: number}, zone: string}>} */
  const doorways = []
  if (split) {
    const sideZone = `${zoneId}-side`
    addZone(map, { id: sideZone, kind: 'interior', material: design.architecture, lightLevel: 'dim', floorDirection: vertical ? 'horizontal' : 'vertical', label: SIDE_ROOM_LABELS[design.building_use] ?? 'Комната' })
    for (let y = inner.minY; y <= inner.maxY; y += 1) for (let x = inner.minX; x <= inner.maxX; x += 1) {
      if (isBack(x, y) && alongOf({ x, y }) > middle) setCell(map, x, y, { zone: sideZone })
    }
    for (let y = inner.minY; y <= inner.maxY; y += 1) for (let x = inner.minX; x <= inner.maxX; x += 1) {
      if (!isBack(x, y) || alongOf({ x, y }) !== middle) continue
      setCell(map, x, y, { passable: false, material: design.architecture, zone: '' })
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!cellAt(map, x + dx, y + dy)?.passable) continue
        setEdge(map, x, y, x + dx, y + dy, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
      }
    }
    doorways.push({ cell: wall[Math.floor(middle / 2)], zone: backZone })
    doorways.push({ cell: wall[middle + 1 + Math.floor((wall.length - middle - 1) / 2)], zone: sideZone })
  } else {
    doorways.push({ cell: wall[middle], zone: backZone })
  }
  // Клетка проёма принадлежит задней комнате, а полотно двери стоит на
  // ребре к передней.
  for (const { cell: doorway, zone } of doorways) {
    setCell(map, doorway.x, doorway.y, { passable: true, material: design.architecture, zone })
    const toFront = vertical
      ? { x: doorway.x + (entryNearStart ? -1 : 1), y: doorway.y }
      : { x: doorway.x, y: doorway.y + (entryNearStart ? -1 : 1) }
    const toBack = vertical
      ? { x: doorway.x + (entryNearStart ? 1 : -1), y: doorway.y }
      : { x: doorway.x, y: doorway.y + (entryNearStart ? 1 : -1) }
    setEdge(map, doorway.x, doorway.y, toBack.x, toBack.y, { kind: 'none' })
    setEdge(map, doorway.x, doorway.y, toFront.x, toFront.y, { kind: 'none' })
    setDoor(map, { id: `${zone}-door`, ...edgeFor(doorway, toFront), state: 'closed', blocksMove: false, blocksSight: false })
  }
}

/**
 * Окна в наружных стенах дома: через стену на улицу, по одному на каждые три
 * клетки фасада, не в углу и не рядом с дверью. Окно не пропускает, но
 * пропускает взгляд — с улицы видно, кто внутри, и наоборот.
 */
function openHouseWindows(map, footprint, footprintKeys, frontDoor) {
  const doorCells = map.doors.flatMap((door) => [{ x: door.x, y: door.y }, edgeNeighbor(door)])
  const nearDoor = (cell) => doorCells.some((door) => Math.abs(door.x - cell.x) + Math.abs(door.y - cell.y) <= 1)
  let placed = 0
  for (const cell of footprint) {
    if (placed >= 6) break
    const own = cellAt(map, cell.x, cell.y)
    if (!own || own.passable || (cell.x === frontDoor.x && cell.y === frontDoor.y) || nearDoor(cell)) continue
    // Ровно одна сторона — улица, противоположная — комната: не угол.
    const outward = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => !footprintKeys.has(key(cell.x + dx, cell.y + dy)))
    if (outward.length !== 1) continue
    const [dx, dy] = outward[0]
    const outside = cellAt(map, cell.x + dx, cell.y + dy)
    const inside = cellAt(map, cell.x - dx, cell.y - dy)
    if (!outside?.passable || outside.surface === 'water' || !inside?.passable) continue
    // Шаг вдоль фасада: вдоль стены сумма координат растёт на единицу, и
    // окно встаёт на каждую третью клетку.
    if ((cell.x + cell.y) % 3 !== 0) continue
    setEdge(map, cell.x, cell.y, cell.x + dx, cell.y + dy, { kind: 'window', blocksMove: true, blocksSight: false, cover: 'three_quarters' })
    setEdge(map, cell.x, cell.y, cell.x - dx, cell.y - dy, { kind: 'window', blocksMove: true, blocksSight: false, cover: 'three_quarters' })
    placed += 1
  }
}



/**
 * Деревня по улице: дома встают вдоль уже проложенной улицы с обеих сторон,
 * дверью к ней, через палисадник в одну клетку. Между соседями — двор не
 * меньше двух клеток. Так строится и прямая, и кривая улица, и перекрёсток,
 * и берег реки: планировщик идёт по клеткам улицы, а не по заранее
 * нарезанным областям. Прежний случайный подбор по областям ставил на
 * карту 30×28 от двух до шести домов.
 *
 * @returns {Array<ReturnType<typeof makeSpec>>}
 */
function frontageSpecs(map, random, target) {
  const occupied = new Set()
  /** @type {Array<ReturnType<typeof makeSpec>>} */
  const specs = []
  const streetAt = (/** @type {number} */ x, /** @type {number} */ y) => ['street', 'square'].includes(cellAt(map, x, y)?.zone ?? '')
  /** @type {Array<{x: number, y: number, dx: number, dy: number}>} */
  const fronts = []
  for (let y = 1; y < map.height - 1; y += 1) for (let x = 1; x < map.width - 1; x += 1) {
    if (!streetAt(x, y)) continue
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const land = cellAt(map, x + dx, y + dy)
      if (land?.passable && land.surface !== 'water' && !streetAt(x + dx, y + dy)) fronts.push({ x, y, dx, dy })
    }
  }
  // Укладка по порядку вдоль каждой стороны улицы: случайный обход
  // оставлял между домами обрезки короче дома, и на улицу вставало вдвое
  // меньше дворов. Сторона выбирается случайно, чтобы деревни различались.
  const sideOrder = shuffled(['-1,0', '1,0', '0,-1', '0,1'], random)
  // Сначала переулки: дом у переулка короче улицы, а главная улица добирает
  // промежутки между ними.
  const laneFirst = random() < 0.5
  // Дворы у площади — первыми: дом у площади смотрит на неё дверью, а не
  // на боковую улицу (план карт, «дома к площади»).
  const onSquare = (/** @type {{x: number, y: number}} */ front) => Number(cellAt(map, front.x, front.y)?.zone === 'square')
  fronts.sort((left, right) => onSquare(right) - onSquare(left)
    || (laneFirst ? Number(Boolean(right.dx)) - Number(Boolean(left.dx)) : 0)
    || sideOrder.indexOf(`${left.dy},${left.dx}`) - sideOrder.indexOf(`${right.dy},${right.dx}`)
    || (left.dy ? left.x - right.x || left.y - right.y : left.y - right.y || left.x - right.x))
  for (const front of fronts) {
    if (specs.length >= target) break
    // Дом деревни просторнее городского: в нём перегородка и спальня,
    // а в амбар встаёт стог.
    // Первые три двора и затем каждый пятый — крупные: постоялый двор, лавка
    // с жильём, амбар, дом старосты — 35–48 клеток пола; остальные — изба
    // на 15–28. Без гарантии раскладка из одних изб выигрывала по числу.
    const large = specs.filter((spec) => spec.w * spec.h >= 63).length < 3 || random() < 0.2
    const w = large ? 9 + Math.floor(random() * 2) : 7 + Math.floor(random() * 3)
    const h = large ? 7 + Math.floor(random() * 2) : 5 + Math.floor(random() * 2)
    // Дом стоит в клетке от улицы и смотрит на неё дверью.
    let spec
    if (front.dy === -1) {
      spec = makeSpec(front.x - Math.floor(w / 2), front.y - 1 - h, w, h)
      spec.doorX = front.x; spec.doorY = spec.y + h - 1
    } else if (front.dy === 1) {
      spec = makeSpec(front.x - Math.floor(w / 2), front.y + 2, w, h)
      spec.doorX = front.x; spec.doorY = spec.y
    } else if (front.dx === -1) {
      spec = makeSpec(front.x - 1 - h, front.y - Math.floor(w / 2), h, w)
      spec.doorX = spec.x + h - 1; spec.doorY = front.y
    } else {
      spec = makeSpec(front.x + 2, front.y - Math.floor(w / 2), h, w)
      spec.doorX = spec.x; spec.doorY = front.y
    }
    if (!canPlace(spec, occupied, map)) continue
    specs.push(spec)
    // Двор вокруг дома — две клетки: соседний дом не встаёт вплотную.
    for (const cell of shapeCells(spec)) for (let ry = -2; ry <= 2; ry += 1) for (let rx = -2; rx <= 2; rx += 1) occupied.add(key(cell.x + rx, cell.y + ry))
  }
  return specs
}

/**
 * Второй ряд дворов: дома в глубине, за первым рядом вдоль улицы. Дверь
 * смотрит на сторону, ближайшую к улице, тропу к ней прокладывает общая
 * проверка достижимости. Двор вокруг — те же две клетки.
 *
 * @param {Array<ReturnType<typeof makeSpec>>} specs уже поставленные дома
 * @returns {Array<ReturnType<typeof makeSpec>>}
 */
function backRowSpecs(map, specs, random, target) {
  const occupied = new Set()
  const reserve = (/** @type {ReturnType<typeof makeSpec>} */ spec) => {
    for (const cell of shapeCells(spec)) for (let ry = -2; ry <= 2; ry += 1) for (let rx = -2; rx <= 2; rx += 1) occupied.add(key(cell.x + rx, cell.y + ry))
  }
  specs.forEach(reserve)
  if (!map.zones.some((zone) => zone.id === 'street' || zone.id === 'square')) return []
  // Стены домов — препятствие для тропы: она обходит соседей, а не идёт сквозь.
  const walls = new Set(specs.flatMap((spec) => shapeCells(spec).map(cellKey)))
  const result = []
  const sizes = shuffled([[7, 5], [6, 5], [5, 6], [5, 7], [6, 6]], random)
  for (let y = 2; y < map.height - 6 && specs.length + result.length < target; y += 1) {
    for (let x = 2; x < map.width - 6 && specs.length + result.length < target; x += 1) {
      for (const [w, h] of sizes) {
        const spec = makeSpec(x, y, w, h)
        if (!canPlace(spec, occupied, map)) continue
        // Дверь — на той стороне, откуда настоящая тропа до улицы короче
        // всего. Прежде дверь смотрела на ближайшую клетку улицы по прямой,
        // и у дома в углу деревни она выходила в чужой двор, а тропы не было
        // вовсе (замечание владельца 2026-10-03: «Дом 9» без дорожки).
        const own = new Set(shapeCells(spec).map(cellKey))
        const blocked = new Set([...walls, ...own])
        let best = null
        for (const side of doorSides(spec)) {
          const route = routeToRoad(map, side.outside, blocked)
          if (!route) continue
          // Дверь к краю карты — в забор околицы, и тропа шла бы вдоль края:
          // такая сторона дороже, чем тропа на шесть клеток длиннее.
          const atEdge = side.outside.x <= 1 || side.outside.y <= 1 || side.outside.x >= map.width - 2 || side.outside.y >= map.height - 2
          const cost = route.length + (atEdge ? EDGE_DOOR_PENALTY : 0)
          if (!best || cost < best.cost) best = { side, route, cost }
        }
        if (!best || best.route.length > MAX_DOOR_PATH) continue
        spec.doorX = best.side.door.x
        spec.doorY = best.side.door.y
        result.push(spec)
        reserve(spec)
        for (const cell of own) walls.add(cell)
        break
      }
    }
  }
  return result
}

/** Длиннее этой тропы дом в глубине не ставится: к нему пришлось бы идти через полдеревни. */
const MAX_DOOR_PATH = 14

/** Цена двери, что смотрит на край карты, — в клетках тропы. */
const EDGE_DOOR_PENALTY = 6

/**
 * Середины четырёх сторон дома: клетка двери в стене и клетка снаружи.
 * @param {ReturnType<typeof makeSpec>} spec
 */
function doorSides(spec) {
  const midX = spec.x + Math.floor(spec.w / 2)
  const midY = spec.y + Math.floor(spec.h / 2)
  return [
    { door: { x: midX, y: spec.y + spec.h - 1 }, outside: { x: midX, y: spec.y + spec.h } },
    { door: { x: midX, y: spec.y }, outside: { x: midX, y: spec.y - 1 } },
    { door: { x: spec.x, y: midY }, outside: { x: spec.x - 1, y: midY } },
    { door: { x: spec.x + spec.w - 1, y: midY }, outside: { x: spec.x + spec.w, y: midY } },
  ]
}

/** Улица, площадь или уже проложенная тропа. */
function roadAt(map, x, y) {
  return ['street', 'square', 'path'].includes(cellAt(map, x, y)?.zone ?? '')
}

/**
 * Кратчайшая тропа по открытой земле от клетки до улицы: от `start` до первой
 * клетки, что сама дорога или стоит к ней вплотную. `null` — пути нет.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{x: number, y: number}} start
 * @param {Set<string>} blocked клетки построек
 * @returns {Array<{x: number, y: number}>|null}
 */
function routeToRoad(map, start, blocked) {
  const open = (/** @type {number} */ x, /** @type {number} */ y) => {
    const cell = cellAt(map, x, y)
    return Boolean(cell?.passable) && cell?.surface !== 'water' && !blocked.has(key(x, y))
      && x > 0 && y > 0 && x < map.width - 1 && y < map.height - 1
  }
  const touchesRoad = (/** @type {number} */ x, /** @type {number} */ y) => roadAt(map, x, y)
    || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => roadAt(map, x + dx, y + dy))
  if (!open(start.x, start.y)) return null
  // Клетка у края карты втрое дороже: тропа идёт между домами, а не вдоль
  // забора околицы. Поиск — Дейкстра по малым целым ценам, по корзинам.
  const costOf = (/** @type {number} */ x, /** @type {number} */ y) => (x <= 1 || y <= 1 || x >= map.width - 2 || y >= map.height - 2 ? 3 : 1)
  const previous = new Map([[cellKey(start), null]])
  const best = new Map([[cellKey(start), 0]])
  /** @type {Array<Array<{x: number, y: number}>>} */
  const buckets = [[start]]
  for (let distance = 0; distance < buckets.length; distance += 1) {
    for (const current of buckets[distance] ?? []) {
      if (best.get(cellKey(current)) !== distance) continue
      if (touchesRoad(current.x, current.y)) {
        const route = []
        for (let step = current; step; step = previous.get(cellKey(step))) route.unshift(step)
        return route
      }
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const next = { x: current.x + dx, y: current.y + dy }
        if (!open(next.x, next.y)) continue
        const total = distance + costOf(next.x, next.y)
        if (total >= (best.get(cellKey(next)) ?? Number.POSITIVE_INFINITY)) continue
        best.set(cellKey(next), total)
        previous.set(cellKey(next), current)
        ;(buckets[total] ??= []).push(next)
      }
    }
  }
  return null
}

/**
 * Тропа от каждой двери дома, которая не выходит прямо к улице: клетки
 * открытой земли до ближайшей улицы получают зону `path` и материал улицы.
 * Обстановку на тропу расстановка не ставит — у зоны нет плана, — поэтому
 * тропа остаётся проходом.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} material
 * @returns {number} сколько троп проложено
 */
function layDoorPaths(map, material) {
  const buildingCells = new Set()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell) continue
    if (String(cell.zone).startsWith('building-') || (!cell.passable && cell.zone === '')) buildingCells.add(key(x, y))
  }
  let laid = 0
  for (const door of map.doors) {
    if (!/^building-\d+-door$/u.test(door.id)) continue
    const outside = [{ x: door.x, y: door.y }, edgeNeighbor(door)]
      .find((point) => !String(cellAt(map, point.x, point.y)?.zone ?? '').startsWith('building-') && cellAt(map, point.x, point.y)?.passable)
    if (!outside) continue
    const route = routeToRoad(map, outside, buildingCells)
    // Дверь у самой улицы (палисадник в клетку) тропы не требует.
    if (!route || route.length === 1) continue
    if (!map.zones.some((zone) => zone.id === 'path')) addZone(map, { id: 'path', kind: 'exterior', material, lightLevel: 'bright', floorDirection: 'horizontal' })
    for (const point of route) if (!roadAt(map, point.x, point.y)) setCell(map, point.x, point.y, { material, zone: 'path', revealed: true })
    laid += 1
  }
  return laid
}

/**
 * Переулки деревни: от улицы вверх и вниз отходят проезды в две клетки, не
 * ближе дюжины клеток друг к другу и к краю. Переулок идёт до третьей клетки
 * от края карты и останавливается у воды. Возвращает прежнее состояние
 * закрашенных клеток, чтобы переулки можно было снять.
 *
 * @returns {Array<{x: number, y: number, before: Record<string, any>}>}
 */
function paintVillageLanes(map, random, material) {
  /** @type {Array<{x: number, y: number, before: Record<string, any>}>} */
  const painted = []
  const streetAt = (/** @type {number} */ x, /** @type {number} */ y) => ['street', 'square'].includes(cellAt(map, x, y)?.zone ?? '')
  // Главная улица — самая длинная горизонтальная полоса улицы.
  const rows = Array.from({ length: map.height }, (_, y) => y)
    .map((y) => ({ y, count: Array.from({ length: map.width }, (_, x) => x).filter((x) => streetAt(x, y)).length }))
    .filter((row) => row.count >= map.width * 0.6)
  if (!rows.length) return painted
  const top = Math.min(...rows.map((row) => row.y))
  const bottom = Math.max(...rows.map((row) => row.y))
  const spacing = 12 + Math.floor(random() * 3)
  const first = 9 + Math.floor(random() * 4)
  // Переулок не встаёт рядом с другой поперечной улицей (перекрёсток, мост):
  // между ними не поместился бы ни один дом.
  const crossStreetNear = (/** @type {number} */ laneX) => Array.from({ length: map.height }, (_, y) => y)
    .filter((y) => y < top || y > bottom)
    .some((y) => Array.from({ length: 22 }, (_, i) => laneX - 10 + i).some((x) => streetAt(x, y)))
  for (let laneX = first; laneX + 1 < map.width - 8; laneX += spacing) {
    if (crossStreetNear(laneX)) continue
    // Переулок идёт в одну сторону или в обе: так деревня не выглядит сеткой.
    const roll = random()
    const directions = roll < 0.4 ? [-1, 1] : roll < 0.7 ? [-1] : [1]
    for (const direction of directions) {
      for (let y = direction < 0 ? top - 1 : bottom + 1; y >= 3 && y <= map.height - 4; y += direction) {
        const cells = [laneX, laneX + 1].map((x) => ({ x, cell: cellAt(map, x, y) }))
        if (cells.some(({ cell }) => !cell || cell.surface === 'water' || !cell.passable)) break
        for (const { x, cell } of cells) {
          if (streetAt(x, y)) continue
          painted.push({ x, y, before: { passable: cell.passable, surface: cell.surface, material: cell.material, zone: cell.zone, revealed: cell.revealed } })
          paintStreet(map, x, y, material)
        }
      }
    }
  }
  return painted
}

/**
 * Площадь посреди деревни: прямоугольник 9×7 вокруг клетки улицы, ближайшей
 * к середине карты. Деревня с навесом или колодцем в центре сцены прежде
 * ставила его прямо на проезжую улицу — площади у деревни не было вовсе.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} material
 */
function carveVillageSquare(map, material) {
  const middle = { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) }
  let center = null
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (cellAt(map, x, y)?.zone !== 'street') continue
    const distance = Math.abs(x - middle.x) + Math.abs(y - middle.y)
    if (!center || distance < center.distance) center = { x, y, distance }
  }
  if (!center) return
  for (let y = center.y - 3; y <= center.y + 3; y += 1) for (let x = center.x - 4; x <= center.x + 4; x += 1) {
    if (x < 2 || y < 2 || x > map.width - 3 || y > map.height - 3) continue
    paintSquare(map, x, y, material)
  }
}

/** Наименьшая рыночная площадь деревни: ширина вдоль улицы и глубина. */
const MARKET_SQUARE = Object.freeze({ width: 16, height: 11 })

/** Лотков на площади не больше: ещё два-три добавит обстановка площади. */
export const MARKET_STALLS_MAX = 9

/**
 * Предмет каталога на карте: одна или несколько клеток, свойства из реестра.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} assetId
 * @param {string} id
 * @param {Array<{x: number, y: number}>} footprint
 */
function addMarketProp(map, assetId, id, footprint) {
  const asset = assetById(assetId)
  if (!asset) return
  const xs = footprint.map((cell) => cell.x)
  const ys = footprint.map((cell) => cell.y)
  const span = asset.scaleRange.max - asset.scaleRange.min
  addProp(map, {
    id, assetId, rotation: 0,
    x: (Math.min(...xs) + Math.max(...xs) + 1) / 2, y: (Math.min(...ys) + Math.max(...ys) + 1) / 2,
    scale: Number((asset.scaleRange.min + span / 2).toFixed(3)), footprint, zOrder: 0,
    blocksMove: asset.blocksMove, blocksSight: asset.blocksSight, cover: asset.cover,
    destructible: asset.destructible, hp: asset.hp, interactive: asset.interactive,
  })
}

/**
 * Торговые ряды на рыночной площади: лотки 2×2 рядами вдоль улицы, между
 * лотками ряда — проход в клетку, между рядами — проход в две. Проходы
 * размечаются зоной `path`: на них расстановка ничего не ставит, а проверка
 * карты ловит предмет поперёк прохода (`PATH_BLOCKED`). Свободными
 * остаются и край площади в клетку — тротуар перед домами, — и улицы, что
 * входят на площадь: по ним отряд идёт насквозь. Подход к двери дома
 * (клетка перед порогом и следующая за ней) лотком не занимается. В конце
 * ряда, где лоток уже не встаёт, — телега или ящики с бочкой.
 *
 * Обзор 2026-10-08: на «Суконной площади» стояло три навеса.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} seed
 * @param {string} material
 * @returns {{stalls: number, goods: number}}
 */
function layMarketRows(map, seed, material) {
  /** @type {Array<{x: number, y: number}>} */
  const square = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.zone === 'square') square.push({ x, y })
  if (!square.length) return { stalls: 0, goods: 0 }
  const minX = Math.min(...square.map((cell) => cell.x))
  const maxX = Math.max(...square.map((cell) => cell.x))
  const minY = Math.min(...square.map((cell) => cell.y))
  const maxY = Math.max(...square.map((cell) => cell.y))
  const road = (/** @type {number} */ x, /** @type {number} */ y) => ['street', 'path'].includes(cellAt(map, x, y)?.zone ?? '')
  // Улицы, что входят на площадь, идут насквозь: их ряды и столбцы свободны.
  const throughRows = new Set()
  const throughColumns = new Set()
  for (let y = minY; y <= maxY; y += 1) if (road(minX - 1, y) || road(maxX + 1, y)) throughRows.add(y)
  for (let x = minX; x <= maxX; x += 1) if (road(x, minY - 1) || road(x, maxY + 1)) throughColumns.add(x)
  // Подход к двери: клетка за порогом и следующая за ней.
  /** @type {Set<string>} */
  const approaches = new Set()
  for (const door of map.doors) {
    const next = edgeNeighbor(door)
    const step = { x: next.x - door.x, y: next.y - door.y }
    for (const point of [{ x: door.x, y: door.y }, next, { x: door.x - step.x, y: door.y - step.y }, { x: next.x + step.x, y: next.y + step.y }]) {
      approaches.add(key(point.x, point.y))
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) approaches.add(key(point.x + dx, point.y + dy))
    }
  }
  const taken = new Set(map.props.flatMap((prop) => (prop.footprint ?? []).map((cell) => key(cell.x, cell.y))))
  const free = (/** @type {number} */ x, /** @type {number} */ y) => {
    const cell = cellAt(map, x, y)
    return cell?.zone === 'square' && cell.passable && x > minX && x < maxX && y > minY && y < maxY
      && !throughRows.has(y) && !throughColumns.has(x) && !approaches.has(key(x, y)) && !taken.has(key(x, y))
  }
  // Кварталы рядов — полосы между сквозными улицами по горизонтали.
  /** @type {Array<{from: number, to: number}>} */
  const bands = []
  for (let y = minY + 1; y < maxY; y += 1) {
    if (throughRows.has(y)) continue
    const last = bands[bands.length - 1]
    if (last && last.to === y - 1) last.to = y
    else bands.push({ from: y, to: y })
  }
  const random = randomFor(`settlement-market:${seed}`)
  const goodsKinds = ['crate', 'barrel', 'sack']
  let stalls = 0
  let goods = 0
  let carts = 0
  /** @type {Array<{x: number, y: number}>} */
  const aisles = []
  for (const band of bands) {
    // Ряды в полосе: лоток в две клетки, проход в две; ряд прижат к улице,
    // если полоса уже двух рядов.
    for (let rowY = band.from; rowY + 1 <= band.to && stalls < MARKET_STALLS_MAX; rowY += 4) {
      let x = minX + 1
      /** @param {string} assetId @param {Array<{x: number, y: number}>} footprint */
      const put = (assetId, footprint) => {
        addMarketProp(map, assetId, `market-${assetId === 'cart' ? 'cart' : 'goods'}-${goods + 1}`, footprint)
        for (const cell of footprint) taken.add(key(cell.x, cell.y))
        goods += 1
      }
      // Первый ряд площади начинается с подводы: телега и ящик с товаром.
      if (!carts && free(x, rowY) && free(x + 1, rowY) && free(x, rowY + 1)) {
        put('cart', [{ x, y: rowY }, { x: x + 1, y: rowY }])
        put(goodsKinds[Math.floor(random() * goodsKinds.length)], [{ x, y: rowY + 1 }])
        carts += 1
        x += 3
      }
      let afterStall = false
      while (x < maxX) {
        const footprint = [{ x, y: rowY }, { x: x + 1, y: rowY }, { x, y: rowY + 1 }, { x: x + 1, y: rowY + 1 }]
        if (stalls < MARKET_STALLS_MAX && footprint.every((cell) => free(cell.x, cell.y))) {
          addMarketProp(map, 'market_stall', `market-stall-${stalls + 1}`, footprint)
          for (const cell of footprint) taken.add(key(cell.x, cell.y))
          stalls += 1
          afterStall = true
          x += 3
          continue
        }
        // Ряд упёрся в улицу или край: в проходе за последним лотком — товар
        // лавочника, ящик или мешок над бочкой.
        if (afterStall && free(x - 1, rowY) && free(x - 1, rowY + 1)) {
          put(goodsKinds[Math.floor(random() * goodsKinds.length)], [{ x: x - 1, y: rowY }])
          put('barrel', [{ x: x - 1, y: rowY + 1 }])
        }
        afterStall = false
        x += 1
      }
      // Проход за рядом — две клетки, если за ним в полосе есть следующий ряд.
      if (rowY + 5 <= band.to) {
        for (let aisleX = minX + 1; aisleX < maxX; aisleX += 1) {
          for (const aisleY of [rowY + 2, rowY + 3]) if (free(aisleX, aisleY)) aisles.push({ x: aisleX, y: aisleY })
        }
      }
    }
  }
  // Ни телеги, ни ящика не встало (ряды упёрлись в улицы и в подходы к
  // дверям): товар — у первого лотка, где рядом свободно и не проход.
  if (!goods) {
    const aisleKeys = new Set(aisles.map((cell) => key(cell.x, cell.y)))
    const stallCells = new Set(map.props.filter((prop) => prop.assetId === 'market_stall').flatMap((prop) => prop.footprint.map((cell) => key(cell.x, cell.y))))
    const spot = square.find((cell) => free(cell.x, cell.y) && !aisleKeys.has(key(cell.x, cell.y))
      && [[1, 0], [-1, 0]].some(([dx, dy]) => stallCells.has(key(cell.x + dx, cell.y + dy))))
    if (spot) {
      addMarketProp(map, goodsKinds[Math.floor(random() * goodsKinds.length)], 'market-goods-1', [spot])
      goods += 1
    }
  }
  if (aisles.length) {
    if (!map.zones.some((zone) => zone.id === 'path')) addZone(map, { id: 'path', kind: 'exterior', material, lightLevel: 'bright', floorDirection: 'horizontal' })
    for (const cell of aisles) setCell(map, cell.x, cell.y, { zone: 'path', material })
  }
  return { stalls, goods }
}

/** Наименьший размер карты поселения по масштабу. */
const SETTLEMENT_MIN_SIZE = Object.freeze({ village: { width: 44, height: 38 }, town: { width: 48, height: 44 }, city: { width: 56, height: 52 } })

/**
 * Город: сетка улиц, площадь в центре, кварталы с домами вдоль улиц.
 *
 * Главная улица идёт с запада на восток — по ней отряд входит в город, —
 * поперечная пересекает её на площади. Между ними переулки шириной в две
 * клетки делят землю на кварталы примерно 11×12. В квартале дома стоят двумя
 * рядами: передний смотрит дверью на улицу сверху, задний — на улицу снизу,
 * между рядами — дворы. Соседние дома разделяет проулок в клетку.
 *
 * Гавань и река сохраняют своё: вода у восточного края с причалами или река
 * поперёк города с мостами по каждой улице.
 *
 * @returns {Array<ReturnType<typeof makeSpec>>}
 */
function townSpecs(map, design, random, materialsForMap) {
  const width = map.width
  const height = map.height
  const centerX = Math.floor(width / 2)
  const centerY = Math.floor(height / 2)
  const harbor = design.topology === 'harbor'
  const river = design.topology === 'river'
  const landRight = harbor ? width - 6 : width - 1
  /** @type {Array<{from: number, to: number}>} */
  const verticals = []
  /** @type {Array<{from: number, to: number}>} */
  const horizontals = []
  // Поперечная улица — три клетки, переулки — две, шаг около тринадцати.
  // Переулки делят каждую половину на равные кварталы не шире 11 и не выше
  // 12 клеток: так в квартал встают два-три дома в ряд и два ряда.
  /** @param {number} start @param {number} end @param {number} block */
  const lanesBetween = (start, end, block) => {
    const span = end - start + 1
    // Кварталы не уже заданного: квартал в 10 клеток вмещает один дом,
    // в 11 — уже два.
    const count = Math.max(1, Math.floor((span + 2) / (block + 2)))
    /** @type {Array<{from: number, to: number}>} */
    const lanes = []
    for (let index = 1; index < count; index += 1) {
      const at = start + Math.round((span * index) / count) - 1
      lanes.push({ from: at, to: at + 1 })
    }
    return lanes
  }
  // Кольцевая улица вдоль края: у крайних кварталов тоже есть улица, на
  // которую смотрят двери, а не глухая кромка карты.
  verticals.push({ from: 2, to: 3 }, { from: landRight - 4, to: landRight - 3 })
  horizontals.push({ from: 2, to: 3 }, { from: height - 4, to: height - 3 })
  verticals.push({ from: centerX - 1, to: centerX + 1 })
  verticals.push(...lanesBetween(4, centerX - 2, 11), ...lanesBetween(centerX + 2, landRight - 5, 11))
  horizontals.push({ from: centerY - 1, to: centerY + 1 })
  horizontals.push(...lanesBetween(4, centerY - 2, 12), ...lanesBetween(centerY + 2, height - 5, 12))
  const street = materialsForMap.street
  for (const line of verticals) for (let x = line.from; x <= line.to; x += 1) for (let y = 1; y < height - 1; y += 1) paintStreet(map, x, y, street)
  for (const line of horizontals) for (let y = line.from; y <= line.to; y += 1) for (let x = 0; x < landRight; x += 1) paintStreet(map, x, y, street)
  if (harbor) {
    for (let y = 0; y < height; y += 1) for (let x = landRight; x < width; x += 1) setCell(map, x, y, { passable: false, surface: 'water', material: materialsForMap.surface, zone: 'water', revealed: true })
    // Причалы — продолжение каждой поперечной улицы в воду.
    for (const line of horizontals) for (let x = landRight; x < width - 1; x += 1) paintStreet(map, x, line.from, 'wood', true)
  }
  if (river) {
    const riverY = horizontals.find((line) => line.from > centerY + 2)?.from ?? centerY + 6
    for (let y = riverY; y <= riverY + 1; y += 1) for (let x = 0; x < width; x += 1) setCell(map, x, y, { passable: false, surface: 'water', material: 'stone', zone: 'water', revealed: true })
    const bridge = ['stone', 'marble', 'metal'].includes(design.architecture) ? design.architecture : 'wood'
    for (const line of verticals) for (let x = line.from; x <= line.to; x += 1) for (let y = riverY; y <= riverY + 1; y += 1) paintStreet(map, x, y, bridge, true)
    // Городской канал одет в камень: набережная — кромка на ребре между
    // мостовой и водой. Пройти по воде и без неё нельзя, кромка — это
    // отрисовка и укрытие у края, мосты её не получают.
    for (let x = 0; x < width; x += 1) {
      for (const [landY, waterY] of [[riverY - 1, riverY], [riverY + 2, riverY + 1]]) {
        const land = cellAt(map, x, landY)
        const water = cellAt(map, x, waterY)
        if (!land?.passable || water?.surface !== 'water' || water.passable) continue
        setEdge(map, x, landY, x, waterY, { kind: 'ledge', blocksMove: false, blocksSight: false, cover: 'none' })
      }
    }
  }
  // Площадь на перекрёстке главной и поперечной. Рыночная — шире, под ряды
  // лотков с проходами между ними (`layMarketRows`).
  const market = design.topology === 'market'
  const squareW = (design.scale === 'city' ? 12 : 10) + (market ? 6 : 0)
  const squareH = (design.scale === 'city' ? 10 : 8) + (market ? 4 : 0)
  for (let y = centerY - Math.floor(squareH / 2); y < centerY - Math.floor(squareH / 2) + squareH; y += 1) {
    for (let x = centerX - Math.floor(squareW / 2); x < centerX - Math.floor(squareW / 2) + squareW; x += 1) paintSquare(map, x, y, street)
  }
  // Кварталы — промежутки между линиями улиц.
  const cuts = (/** @type {Array<{from: number, to: number}>} */ lines, /** @type {number} */ limit) => {
    const sorted = [...lines].sort((left, right) => left.from - right.from)
    /** @type {Array<{from: number, to: number}>} */
    const spans = []
    let start = 2
    for (const line of sorted) {
      if (line.from - 1 >= start) spans.push({ from: start, to: line.from - 1 })
      start = line.to + 1
    }
    if (limit >= start) spans.push({ from: start, to: limit })
    return spans
  }
  const columns = cuts(verticals, landRight - 3)
  const rows = cuts(horizontals, height - 3)
  /** @type {Array<ReturnType<typeof makeSpec>>} */
  const specs = []
  const occupied = new Set()
  const isStreet = (/** @type {number} */ x, /** @type {number} */ y) => ['street', 'square'].includes(cellAt(map, x, y)?.zone ?? '')
  // Крупные дома: часть кварталов целиком отдаётся одному-двум домам на
  // всю глубину квартала — постоялый двор, дом купца, гильдия. Прежде все
  // дома города были 5–7 на 5–6 клеток, с полом в 9–20 клеток.
  const blocks = rows.flatMap((row) => columns.map((column) => ({ row, column })))
    .filter(({ row, column }) => column.to - column.from + 1 >= 5 && row.to - row.from + 1 >= 8)
  const deepCount = Math.max(2, Math.round(blocks.length * 0.15))
  const deepBlocks = new Set(shuffled(blocks.map((_, index) => index), random).slice(0, deepCount).map((index) => `${blocks[index].row.from}:${blocks[index].column.from}`))
  for (const row of rows) {
    for (const column of columns) {
      const blockH = row.to - row.from + 1
      const blockW = column.to - column.from + 1
      if (blockW < 5 || blockH < 5) continue
      if (deepBlocks.has(`${row.from}:${column.from}`)) {
        // Дверь — к улице сверху, если она есть, иначе снизу.
        const streetAbove = isStreet(column.from + 1, row.from - 1)
        // Глубина 9–10 клеток: за домом остаётся двор, а пол — 40–70 клеток.
        const h = Math.min(blockH, 9 + Math.floor(random() * 2))
        const y = streetAbove ? row.from : row.to - h + 1
        let x = column.from
        while (x <= column.to - 7) {
          const remaining = column.to - x + 1
          let w = 8 + Math.floor(random() * 3)
          if (remaining - w - 1 < 7) w = Math.min(remaining, 11)
          const spec = makeSpec(x, y, w, h)
          spec.doorX = x + Math.floor(w / 2)
          spec.doorY = streetAbove ? y : y + h - 1
          if (canPlace(spec, occupied, map)) {
            specs.push(spec)
            reserveSpec(occupied, spec)
          }
          x += w + 1
        }
        continue
      }
      // Два ряда, если квартал глубже одиннадцати клеток, иначе один —
      // к той улице, что есть (сверху важнее: так дома смотрят на главную).
      const streetAbove = isStreet(column.from + 1, row.from - 1)
      const streetBelow = isStreet(column.from + 1, row.to + 1)
      const lanes = []
      const depth = () => 5 + Math.floor(random() * 2)
      if (blockH >= 11) {
        const top = depth()
        const bottom = Math.min(depth(), blockH - top - 1)
        lanes.push({ y: row.from, h: top, door: 'top' }, { y: row.to - bottom + 1, h: bottom, door: 'bottom' })
      } else {
        const h = Math.min(blockH, depth() + (blockH >= 8 ? 1 : 0))
        lanes.push(streetBelow && !streetAbove ? { y: row.to - h + 1, h, door: 'bottom' } : { y: row.from, h, door: 'top' })
      }
      for (const lane of lanes) {
        let x = column.from
        while (x <= column.to - 4) {
          const remaining = column.to - x + 1
          // Узкие городские дома, два-три в ряд: остаток короче пяти клеток
          // достаётся последнему дому, а не пустует.
          // Ширина от узкого дома в пять клеток до широкого в девять.
          let w = 5 + Math.floor(random() * 3)
          if (remaining - w - 1 < 5) w = Math.min(remaining, 9)
          if (w < 5) break
          // Иногда участок пустует: сад, огород или пепелище — город не
          // сплошная стена домов.
          const gardenChance = design.density === 'dense' ? 0.06 : design.density === 'sparse' ? 0.22 : 0.12
          if (random() >= gardenChance) {
            const spec = makeSpec(x, lane.y, w, lane.h)
            spec.doorX = x + Math.floor(w / 2)
            spec.doorY = lane.door === 'top' ? lane.y : lane.y + lane.h - 1
            if (canPlace(spec, occupied, map)) {
              specs.push(spec)
              reserveSpec(occupied, spec)
            }
          }
          x += w + 1
        }
      }
    }
  }
  return specs
}

function buildingSpecs(map, design, random) {
  const width = map.width
  const height = map.height
  const centerX = Math.floor(width / 2)
  const centerY = Math.floor(height / 2)
  const requested = densityCount(design.density, random)
  const regions = []
  const addRegion = (x, y, w, h) => regions.push({ x, y, w, h })
  const outerWidth = width - 4
  const outerHeight = height - 4
  if (design.topology === 'crossroads') {
    for (let y = 0; y < height; y += 1) for (let dx = -1; dx <= 1; dx += 1) paintStreet(map, centerX + dx, y, 'earth')
    const leftWidth = Math.max(12, centerX - 3)
    const rightWidth = Math.max(12, width - centerX - 4)
    const topHeight = Math.max(10, centerY - 3)
    const bottomHeight = Math.max(10, height - centerY - 3)
    addRegion(2, 2, leftWidth, topHeight)
    addRegion(centerX + 3, 2, rightWidth, topHeight)
    addRegion(2, centerY + 2, leftWidth, bottomHeight)
    addRegion(centerX + 3, centerY + 2, rightWidth, bottomHeight)
    return planInRegions(map, random, Math.min(requested, 8), regions, { density: design.density })
  }
  if (design.topology === 'linear') {
    const laneHeight = Math.max(9, Math.floor((height - 8) / 2))
    addRegion(2, 2, outerWidth, laneHeight)
    addRegion(2, height - laneHeight - 2, outerWidth, laneHeight)
    return planInRegions(map, random, requested, regions, { density: design.density })
  }
  if (design.topology === 'market') {
    // Рыночная площадь — под ряды лотков с проходами (`layMarketRows`):
    // 16–18 клеток вдоль улицы и 11–12 поперёк. Прежняя площадь 8–11 клеток
    // с улицей посередине вмещала три навеса.
    const squareW = MARKET_SQUARE.width + Math.floor(random() * 3)
    const squareH = MARKET_SQUARE.height + Math.floor(random() * 2)
    const squareX = centerX - Math.floor(squareW / 2)
    const squareY = centerY - Math.floor(squareH / 2)
    for (let y = squareY; y < squareY + squareH; y += 1) for (let x = squareX; x < squareX + squareW; x += 1) paintSquare(map, x, y, 'earth')
    addRegion(2, 2, outerWidth, Math.max(6, squareY - 3))
    addRegion(2, squareY + squareH + 2, outerWidth, Math.max(6, height - (squareY + squareH + 4)))
    addRegion(2, squareY + 1, Math.max(6, squareX - 3), Math.max(6, squareH - 1))
    addRegion(squareX + squareW + 2, squareY + 1, Math.max(6, width - (squareX + squareW + 4)), Math.max(6, squareH - 1))
    return planInRegions(map, random, Math.min(requested, 9), regions, { density: design.density })
  }
  if (design.topology === 'courtyard') {
    const courtWidth = 7 + Math.floor(random() * 3)
    const courtHeight = 6 + Math.floor(random() * 3)
    const courtX = centerX - Math.floor(courtWidth / 2)
    const courtY = centerY - Math.floor(courtHeight / 2)
    for (let y = courtY; y < courtY + courtHeight; y += 1) for (let x = courtX; x < courtX + courtWidth; x += 1) paintSquare(map, x, y, 'earth')
    addRegion(2, 2, outerWidth, Math.max(6, courtY - 3))
    addRegion(2, courtY + 1, Math.max(6, courtX - 3), Math.max(6, courtHeight - 1))
    addRegion(courtX + courtWidth + 2, courtY + 1, Math.max(6, width - (courtX + courtWidth + 4)), Math.max(6, courtHeight - 1))
    addRegion(2, courtY + courtHeight + 2, outerWidth, Math.max(6, height - (courtY + courtHeight + 4)))
    return planInRegions(map, random, Math.min(requested, 9), regions, { density: design.density })
  }
  if (design.topology === 'harbor') {
    const shoreline = width - 4
    for (const y of [Math.floor(height * 0.25), Math.floor(height * 0.5), Math.floor(height * 0.75)]) {
      for (let x = shoreline - 2; x < width; x += 1) paintStreet(map, x, y, 'wood', true)
    }
    const landWidth = shoreline - 3
    addRegion(2, 2, landWidth, Math.max(8, Math.floor((height - 7) / 2)))
    addRegion(2, Math.floor(height / 2) + 2, landWidth, Math.max(8, Math.floor((height - 7) / 2)))
    return planInRegions(map, random, Math.min(requested, 9), regions, { density: design.density })
  }
  if (design.topology === 'river') {
    // Река петляет: русло уходит по синусоиде на две клетки вверх и вниз и
    // местами разливается шире. Прямая полоса через всю карту читалась
    // каналом, а не деревенской речкой.
    const riverY = centerY
    const swing = 2
    const phase = random() * Math.PI * 2
    /** @param {number} x */
    const course = (x) => riverY + Math.round(Math.sin((x / Math.max(1, width - 1)) * Math.PI * 2.4 + phase) * swing)
    /** @param {number} x */
    const spread = (x) => (Math.sin(x * 0.53 + phase * 1.7) > 0.75 ? 2 : 1)
    for (let x = 0; x < width; x += 1) {
      for (let y = course(x) - spread(x); y <= course(x) + spread(x); y += 1) {
        if (cellAt(map, x, y)) setCell(map, x, y, { passable: false, surface: 'water', material: 'stone', zone: 'water', revealed: true })
      }
    }
    // Пологий берег: полоса песка вдоль воды, где к реке спускаются за водой.
    for (let x = 0; x < width; x += 1) {
      for (const y of [course(x) - spread(x) - 1, course(x) + spread(x) + 1]) {
        const bank = cellAt(map, x, y)
        if (bank?.passable && bank.surface !== 'water') setCell(map, x, y, { material: 'sand' })
      }
    }
    const bridgeXs = [1, Math.max(3, centerX - 1), Math.max(5, width - 4)]
    const bridgeMaterial = ['stone', 'marble', 'metal'].includes(design.architecture) ? design.architecture : 'wood'
    for (const bridgeX of bridgeXs) for (let x = bridgeX; x <= Math.min(width - 1, bridgeX + 2); x += 1) for (let y = 0; y < height; y += 1) paintStreet(map, x, y, bridgeMaterial, true)
    // Дома стоят выше и ниже самого дальнего изгиба, берег и проход вдоль
    // него остаются открытыми.
    const reach = swing + 2
    addRegion(2, 2, outerWidth, Math.max(8, riverY - reach - 5))
    addRegion(2, riverY + reach + 3, outerWidth, Math.max(8, height - riverY - reach - 5))
    return planInRegions(map, random, requested, regions, { density: design.density })
  }
  if (design.topology === 'gate') {
    const wallX = Math.floor(width * 0.5)
    const gateY = centerY
    for (let y = 1; y < height - 1; y += 1) {
      if (y === gateY || y === gateY + 1) continue
      setEdge(map, wallX - 1, y, wallX, y, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
    }
    setDoor(map, { id: 'city-gate', x: wallX - 1, y: gateY, dir: 'e', state: 'open', blocksMove: false, blocksSight: false })
    for (let x = 0; x < width; x += 1) paintStreet(map, x, gateY, 'earth')
    for (let x = wallX - 3; x <= wallX + 3; x += 1) paintStreet(map, x, gateY + 1, 'earth')
    addRegion(2, 2, Math.max(11, wallX - 4), Math.max(8, gateY - 4))
    addRegion(2, gateY + 3, Math.max(11, wallX - 4), Math.max(8, height - gateY - 5))
    addRegion(wallX + 2, 2, Math.max(11, width - wallX - 4), Math.max(8, gateY - 4))
    addRegion(wallX + 2, gateY + 3, Math.max(11, width - wallX - 4), Math.max(8, height - gateY - 5))
    const target = design.density === 'dense' ? 7 + Math.floor(random() * 2) : Math.min(requested, 6)
    return planGateBuildings(map, random, target, regions, design.density)
  }
  if (design.topology === 'terraced') {
    const rowHeight = 8
    const rowCount = Math.max(2, Math.floor((height - 4) / rowHeight))
    for (let row = 0; row < rowCount; row += 1) {
      const y = 2 + row * rowHeight
      for (let x = 0; x < width; x += 1) paintStreet(map, x, y, 'earth')
      addRegion(2, y + 1, outerWidth, Math.max(6, Math.min(rowHeight - 2, height - y - 2)))
    }
    return planInRegions(map, random, requested, regions, { density: design.density })
  }
  // Органическая схема не использует сетку кварталов: изгиб улицы и L-образные
  // пристройки меняют силуэт, а здания отбираются из общего поля с зазором.
  const phase = random() * Math.PI * 2
  const bend = Math.max(2, Math.floor(height * (0.1 + random() * 0.04)))
  for (let x = 0; x < width; x += 1) {
    const roadY = centerY + Math.round(Math.sin((x / Math.max(1, width - 1)) * Math.PI * 1.5 + phase) * bend)
    for (let dy = -1; dy <= 1; dy += 1) paintStreet(map, x, roadY + dy, 'earth')
  }
  addRegion(2, 2, outerWidth, outerHeight)
  return planInRegions(map, random, requested, regions, { organic: true, density: design.density })
}

/**
 * @param {object} options
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @param {Record<string, any>} [options.theme]
 * @param {Record<string, any>} [options.design]
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, warnings: string[], uses?: Record<string, string>}} `uses` — назначение каждой постройки по id её зоны
 */
export function buildSettlementScene(options = {}) {
  // Улица и кварталы — первая попытка; если какой-то дом остался без пути,
  // поселение собирается прежним подбором по областям, а не падает.
  try {
    return buildSettlementOnce({ ...options, planner: 'street' })
  } catch {
    return buildSettlementOnce({ ...options, planner: 'regions' })
  }
}

/**
 * @param {{seed?: string, width?: number, height?: number, locationId?: string, theme?: Record<string, any>, design?: Record<string, any>, planner?: 'street'|'regions'}} options
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, warnings: string[], uses?: Record<string, string>}}
 */
function buildSettlementOnce({ seed = 'settlement', width = 30, height = 30, locationId = '', theme = {}, design = {}, planner = 'street' } = {}) {
  const chosen = designFor(theme, seed, design)
  const random = randomFor(`settlement:${seed}:${chosen.topology}`)
  // Масштаб задаёт наименьший размер: деревня — от 40×34, город — от 48×44,
  // столица — от 56×52. Прежде любой город сжимался в 26–40 клеток и
  // получал четыре-девять домов.
  const minimum = SETTLEMENT_MIN_SIZE[/** @type {'village'|'town'|'city'} */ (chosen.scale)] ?? { width: 26, height: 26 }
  const safeWidth = clamp(Math.max(integer(width, 30), minimum.width), 26, 60)
  const safeHeight = clamp(Math.max(integer(height, 30), minimum.height), 26, 60)
  const materialsForMap = materials(chosen, theme)
  const map = createTacticalMap({
    width: safeWidth, height: safeHeight, locationId, seed: String(seed), generator: { ...SETTLEMENT_GENERATOR },
    theme: String(theme?.id ?? 'settlement'), sizeClass: 'area',
  })
  const commonLabel = chosen.scale === 'city' ? 'Город' : chosen.scale === 'town' ? 'Город' : chosen.scale === 'village' ? 'Деревня' : 'Поселение'
  addZone(map, { id: 'common', kind: 'exterior', material: materialsForMap.surface, lightLevel: 'bright', floorDirection: 'horizontal', label: commonLabel })
  addZone(map, { id: 'street', kind: 'exterior', material: materialsForMap.street, lightLevel: 'bright', floorDirection: 'horizontal', label: 'Улицы' })
  const urban = chosen.scale === 'town' || chosen.scale === 'city'
  // Площадь посреди поселения — площадь, а не «внутренний двор»: так
  // называется двор внутри одного дома.
  const villageSquare = chosen.square && !urban && chosen.topology !== 'market' && chosen.topology !== 'courtyard'
  if (urban || chosen.topology === 'market' || chosen.topology === 'courtyard' || villageSquare) {
    addZone(map, { id: 'square', kind: 'exterior', material: materialsForMap.street, lightLevel: 'bright', floorDirection: 'horizontal', label: chosen.topology === 'market' || urban ? 'Торговая площадь' : 'Площадь' })
  }
  // Река течёт: у неё своя фактура струй, у гавани — прежняя стоячая вода.
  if (chosen.topology === 'river' || chosen.topology === 'harbor') addZone(map, { id: 'water', kind: 'exterior', material: materialsForMap.surface, lightLevel: 'bright', floorDirection: 'horizontal', label: chosen.topology === 'river' ? 'Река' : 'Вода', ...(chosen.topology === 'river' ? { floor: 'river' } : {}) })
  for (let y = 0; y < safeHeight; y += 1) for (let x = 0; x < safeWidth; x += 1) setCell(map, x, y, { passable: true, material: materialsForMap.surface, zone: 'common', revealed: true })
  const centerY = Math.floor(safeHeight / 2)
  if (chosen.topology !== 'organic' && !urban) {
    for (let x = 0; x < safeWidth; x += 1) for (let dy = -1; dy <= 1; dy += 1) paintStreet(map, x, centerY + dy, materialsForMap.street)
  }
  if (chosen.topology === 'harbor' && !urban) for (let y = 0; y < safeHeight; y += 1) for (let x = safeWidth - 4; x < safeWidth; x += 1) setCell(map, x, y, { passable: false, surface: 'water', material: materialsForMap.surface, zone: 'water', revealed: true })
  const occupied = new Set()
  // Деревня: улицы прокладывает прежний планировщик своей топологии, а дома
  // ставятся вдоль них; если по улице встало меньше, остаётся прежний набор.
  const legacy = urban && planner === 'street' ? [] : buildingSpecs(map, chosen, random)
  // Площадь вырезается по уже проложенной улице и до домов: дома встают
  // вдоль улиц и площади, поэтому дома у площади смотрят на неё дверью.
  if (villageSquare) carveVillageSquare(map, materialsForMap.street)
  // Редкая застройка — хутор или выселки: три-пять дворов, а не деревня.
  const villageTarget = chosen.density === 'dense' ? 14 : chosen.density === 'sparse' ? 5 : 12
  const villageStreet = planner === 'street' && !urban && chosen.scale === 'village'
  // Переулки от главной улицы: одна улица на 36 клеток вмещает четыре-шесть
  // дворов, с переулками — вдвое больше. Если и так не вышло больше
  // прежнего набора, переулки стираются, чтобы не резать его дома.
  const lanes = villageStreet && chosen.density !== 'sparse' ? paintVillageLanes(map, random, materialsForMap.street) : []
  // Укладка вдоль улиц зависит от того, с какой стороны начать: из шести
  // порядков берётся самый застроенный. Крупный двор весит как полтора
  // обычных — иначе выигрывала бы раскладка из одних изб.
  const weight = (/** @type {Array<ReturnType<typeof makeSpec>>} */ list) => list.reduce((sum, spec) => sum + (spec.w * spec.h >= 63 ? 1.6 : 1), 0)
  const alongStreet = villageStreet
    ? Array.from({ length: 6 }, (_, attempt) => frontageSpecs(map, randomFor(`settlement-frontage:${seed}:${attempt}`), villageTarget))
      .reduce((best, next) => (weight(next) > weight(best) ? next : best), [])
    : []
  if (alongStreet.length) alongStreet.push(...backRowSpecs(map, alongStreet, random, villageTarget))
  // Улица выигрывает и при чуть меньшем числе дворов: у неё дома смотрят
  // дверью на улицу и бывают крупными, у прежнего подбора — россыпь
  // одинаковых коробок. Прежний набор остаётся, только если улица дала
  // заметно меньше.
  const streetWins = alongStreet.length > 0 && (alongStreet.length >= legacy.length || alongStreet.length >= Math.min(8, legacy.length - 1))
  if (!streetWins) for (const { x, y, before } of lanes) setCell(map, x, y, before)
  const specs = urban && planner === 'street' ? townSpecs(map, chosen, random, materialsForMap) : streetWins ? alongStreet : legacy
  // Город не бывает меньше дюжины дворов: если кварталы встали тесно,
  // добор идёт вторым рядом в глубине кварталов.
  const urbanTarget = chosen.scale === 'city' ? 18 : 14
  if (urban && planner === 'street' && specs.length < urbanTarget) specs.push(...backRowSpecs(map, specs, random, urbanTarget))
  const uses = settlementUses(specs, chosen)
  /** @type {Record<string, string>} */
  const buildingUses = {}
  for (let index = 0; index < specs.length; index += 1) {
    if (addBuilding(map, specs[index], index, { ...chosen, building_use: uses[index], architecture: materialsForMap.building }, occupied)) {
      buildingUses[`building-${index + 1}`] = uses[index]
    }
  }
  for (let y = 0; y < safeHeight; y += 1) for (let x = 0; x < safeWidth; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.zone === 'common' && (x === 0 || x === safeWidth - 1 || y === 0 || y === safeHeight - 1)) setCell(map, x, y, { passable: false, material: materialsForMap.surface, zone: '' })
  }
  // К каждой двери, что не выходит прямо на улицу, — тропа (версия 5).
  layDoorPaths(map, materialsForMap.street)
  const entranceRow = Array.from({ length: safeHeight }, (_, y) => y)
    .filter((y) => cellAt(map, 1, y)?.zone === 'street')
    .sort((left, right) => Math.abs(left - centerY) - Math.abs(right - centerY))[0] ?? centerY
  const spawn = { x: 1, y: entranceRow }
  setCell(map, spawn.x, spawn.y, { passable: true, surface: 'none', material: materialsForMap.street, zone: 'street', revealed: true })
  addSpawnPoint(map, { id: 'party-entrance', ...spawn, role: 'party' })
  ensureBuildingReachability(map, spawn)
  // Стены домов — на рёбрах клеток (`server/thin-walls.mjs`).
  thinWalls(map)
  // Торговые ряды — после тонких стен: двери уже на своих местах, и подход к
  // ним лотком не занимается.
  if (chosen.topology === 'market') layMarketRows(map, String(seed), materialsForMap.street)
  // Пол каждой комнаты — по её назначению: кухня трактира каменная, амбар
  // земляной, зал усадьбы в паркете. Назначение дома знает `buildingUses`.
  for (const [zoneId, use] of Object.entries(buildingUses)) {
    applyRoomFloors(map, {
      use, architecture: materialsForMap.building,
      wall: buildingWallStyleFor({ use, architecture: materialsForMap.building, urban }),
      zones: (zone) => zone.id === zoneId || zone.id.startsWith(`${zoneId}-`),
    })
  }
  map.overlays = {
    compass: true, scaleBar: true,
    roomLabels: map.zones.filter((zone) => zone.label).map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }
  return { map, warnings: [], uses: buildingUses }
}
