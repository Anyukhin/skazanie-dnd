// @ts-check
import { placeProps } from './prop-placement.mjs'
import {
  SIZE_CLASSES,
  addProp,
  addZone,
  attachLevelTransitions,
  cellAt,
  createTacticalMap,
  doorwayEdgeAt,
  edgeBetween,
  floorVariantAt,
  reachableCells,
  setCell,
  setDoor,
  setEdge,
  validateTacticalMap,
} from './tactical-map.mjs'

/**
 * Тема «здание с участком» — сцена-эталон из раздела 1
 * `docs/tactical-map-plan.md`: здание из трёх помещений, внешняя территория с
 * деревьями и тропой, мебель, расставленная осмысленно, стены с дверными и
 * оконными проёмами, около 26×26 клеток.
 *
 * **Про толщину стен.** Стена живёт на ребре (решение Р2), и рендер рисует её
 * именно так. Но правила движения в Rules Engine пока читают проходимость
 * клетки, а не ребро, поэтому стена обязана дополнительно занимать клетку:
 * иначе герой пройдёт сквозь неё. Когда движение переедет на рёбра, клетки
 * стены можно будет убрать, а рёбра останутся на месте.
 */

export const BUILDING_GENERATOR = Object.freeze({ id: 'building-with-yard', version: '2' })

/** Генератор authored-крепости: геометрия одна на все столы, seed меняет только отделку. */
export const ARES_FORTRESS_GENERATOR = Object.freeze({ id: 'ares-fortress', version: '1' })

/** Крепость занимает карту класса `area`, чтобы двор не сжимался до нескольких клеток. */
export const ARES_FORTRESS_SIZE = Object.freeze({ width: 40, height: 36 })

/** Размер сцены-эталона. */
export const REFERENCE_SIZE = Object.freeze({ width: 26, height: 26 })

/**
 * @typedef {object} RoomPlan
 * @property {string} zoneId
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

/**
 * Планировка здания: общий зал плюс два меньших помещения.
 *
 * Экспортируется ради `server/level-generator.mjs`: верхний этаж нарезается той
 * же логикой, что и первый, и второй копии этого правила быть не должно.
 *
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} interior
 * @returns {{rooms: RoomPlan[], partitionX: number, partitionY: number}}
 */
export function planRooms(interior) {
  // Зал занимает примерно две трети ширины: за стойкой и столами нужно место,
  // а подсобка и кладовая мелкие по назначению.
  const partitionX = Math.round(interior.minX + (interior.maxX - interior.minX) * 0.62)
  const partitionY = Math.round(interior.minY + (interior.maxY - interior.minY) * 0.5)
  return {
    partitionX,
    partitionY,
    rooms: [
      { zoneId: 'hall', minX: interior.minX, minY: interior.minY, maxX: partitionX - 1, maxY: interior.maxY },
      { zoneId: 'kitchen', minX: partitionX + 1, minY: interior.minY, maxX: interior.maxX, maxY: partitionY - 1 },
      { zoneId: 'store', minX: partitionX + 1, minY: partitionY + 1, maxX: interior.maxX, maxY: interior.maxY },
    ],
  }
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @param {string} kind
 * @param {{blocksMove?: boolean, blocksSight?: boolean, cover?: string}} [options]
 */
export function edgesAround(map, x, y, kind, options = {}) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighbor = cellAt(map, x + dx, y + dy)
    if (!neighbor || !neighbor.passable) continue
    setEdge(map, x, y, x + dx, y + dy, {
      kind,
      blocksMove: options.blocksMove !== false,
      blocksSight: options.blocksSight !== false,
      cover: options.cover ?? 'three_quarters',
    })
  }
}

/**
 * Собирает карту здания с участком. Детерминирована от `seed`.
 *
 * @param {object} [options]
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @param {string} [options.theme]
 * @param {boolean} [options.withProps] расставлять ли предметы
 * @param {Array<{offset?: number, label?: string}>} [options.levels] объявленные этажи локации
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function generateBuildingScene({
  seed = 'building',
  width = REFERENCE_SIZE.width,
  height = REFERENCE_SIZE.height,
  locationId = '',
  theme = 'tavern',
  withProps = true,
  levels = [],
} = {}) {
  const safeWidth = Math.max(16, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(16, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { ...BUILDING_GENERATOR },
    theme,
    tilesetId: 'building',
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })
  addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Участок' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Общий зал' })
  addZone(map, { id: 'kitchen', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Кухня' })
  addZone(map, { id: 'store', kind: 'interior', material: 'wood', lightLevel: 'dark', floorDirection: 'vertical', label: 'Кладовая' })
  addZone(map, { id: 'walls', kind: 'interior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: '' })

  // Вариант тайла — позиционный шум от сида (`floorVariantAt`), а не бросок из
  // общей последовательности: тон клетки обязан зависеть от её координат, а не
  // от того, в каком порядке генератор до неё дошёл.
  /** @param {number} x @param {number} y */
  const variantAt = (x, y) => floorVariantAt(seed, x, y)

  // --- участок --------------------------------------------------------
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      setCell(map, x, y, {
        passable: true,
        material: 'grass',
        zone: 'yard',
        variant: variantAt(x, y),
        revealed: false,
        moveCost: 1,
      })
    }
  }

  // --- здание ----------------------------------------------------------
  const building = {
    minX: Math.max(2, Math.round(safeWidth * 0.22)),
    minY: Math.max(2, Math.round(safeHeight * 0.18)),
    maxX: Math.min(safeWidth - 3, Math.round(safeWidth * 0.78)),
    maxY: Math.min(safeHeight - 4, Math.round(safeHeight * 0.72)),
  }
  const interior = { minX: building.minX + 1, minY: building.minY + 1, maxX: building.maxX - 1, maxY: building.maxY - 1 }
  const { rooms, partitionX, partitionY } = planRooms(interior)

  /** @param {number} x @param {number} y */
  const roomAt = (x, y) => rooms.find((room) => x >= room.minX && x <= room.maxX && y >= room.minY && y <= room.maxY)
  for (let y = building.minY; y <= building.maxY; y += 1) {
    for (let x = building.minX; x <= building.maxX; x += 1) {
      const perimeter = x === building.minX || x === building.maxX || y === building.minY || y === building.maxY
      const partition = x === partitionX || (x > partitionX && y === partitionY)
      const room = roomAt(x, y)
      if (perimeter || partition || !room) {
        setCell(map, x, y, { passable: false, material: 'stone', zone: 'walls', variant: variantAt(x, y) })
        continue
      }
      const zone = map.zones.find((entry) => entry.id === room.zoneId)
      setCell(map, x, y, {
        passable: true,
        material: zone?.material ?? 'wood',
        zone: room.zoneId,
        variant: variantAt(x, y),
      })
    }
  }

  // --- стены на рёбрах --------------------------------------------------
  for (let y = building.minY; y <= building.maxY; y += 1) {
    for (let x = building.minX; x <= building.maxX; x += 1) {
      const own = cellAt(map, x, y)
      if (own && !own.passable) edgesAround(map, x, y, 'wall')
    }
  }

  // --- проёмы ------------------------------------------------------------
  const hall = rooms[0]
  const entranceX = Math.round((hall.minX + hall.maxX) / 2)
  openDoorway(map, entranceX, building.maxY, 'front-door')
  openDoorway(map, partitionX, Math.round((interior.minY + partitionY) / 2), 'kitchen-door')
  openDoorway(map, partitionX, Math.round((partitionY + interior.maxY) / 2), 'store-door')

  // Окна: два на северной стене зала, одно на западной. Окно оставляет стену
  // непроходимой, но перестаёт перекрывать обзор.
  openWindow(map, Math.round(hall.minX + (hall.maxX - hall.minX) * 0.3), building.minY)
  openWindow(map, Math.round(hall.minX + (hall.maxX - hall.minX) * 0.7), building.minY)
  openWindow(map, building.minX, Math.round((interior.minY + interior.maxY) / 2))

  // --- тропа от края карты ко входу ------------------------------------
  for (let y = building.maxY + 1; y < safeHeight; y += 1) {
    const drift = Math.round(Math.sin((y - building.maxY) * 0.6) * 1.4)
    for (const x of [entranceX + drift, entranceX + drift + 1]) {
      if (cellAt(map, x, y)) setCell(map, x, y, { material: 'earth', variant: variantAt(x, y) })
    }
  }

  // --- ограда участка ---------------------------------------------------
  const plot = { minX: 1, minY: 1, maxX: safeWidth - 2, maxY: safeHeight - 2 }
  for (let x = plot.minX; x < plot.maxX; x += 1) {
    if (Math.abs(x - entranceX) <= 1) continue
    railBetween(map, x, plot.maxY, x, plot.maxY + 1)
    railBetween(map, x, plot.minY - 1, x, plot.minY)
  }
  for (let y = plot.minY; y < plot.maxY; y += 1) {
    railBetween(map, plot.minX - 1, y, plot.minX, y)
    railBetween(map, plot.maxX, y, plot.maxX + 1, y)
  }

  // --- точки появления и оверлеи ----------------------------------------
  map.spawnPoints.push({ id: 'party-entrance', x: entranceX, y: safeHeight - 2, role: 'party' })
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: map.zones.filter((zone) => zone.label).map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }

  // Отряд видит участок и подход к дому; внутренности — нет.
  for (let y = building.maxY; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell) setCell(map, x, y, { revealed: true })
    }
  }

  if (withProps) {
    placeProps(map, {
      seed: `${seed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
      zones: [
        { zoneId: 'hall', purpose: 'hall', theme: 'interior', density: 22, require: ['bar_counter', 'fireplace', 'table_round', 'table_long', 'stairs_up', 'chandelier'] },
        { zoneId: 'kitchen', purpose: 'kitchen', theme: 'interior', density: 26, require: ['cupboard', 'barrel', 'crate', 'shelf_wall'] },
        { zoneId: 'store', purpose: 'store', theme: 'interior', density: 30, require: ['crate_stack', 'barrel_stack', 'sack', 'chest'] },
        // Двор наполняется крупным и узнаваемым: деревья, кусты, поленница,
        // телега. Мелочь вроде цветов и колёс приходит только спутником и не
        // участвует в случайном доборе — иначе двор превращается в россыпь
        // непонятных значков вместо участка с деревьями.
        {
          zoneId: 'yard', purpose: 'exterior',
          theme: 'yard',
          density: 10,
          require: ['tree_oak', 'tree_birch', 'tree_pine', 'well', 'cart', 'woodpile'],
          prefer: ['tree_oak', 'tree_birch', 'tree_pine', 'tree_dead', 'bush', 'shrub', 'boulder', 'haystack', 'woodpile'],
        },
      ],
    })
  }
  // Лестница в зале стоит здесь с самого начала, но переходом становится только
  // когда у локации объявлены этажи (заявка `levels` архитектора). Без заявки
  // вызов ничего не меняет, и одноэтажная таверна собирается ровно как прежде.
  ensureDeclaredTransitions(map, levels, 'hall')
  return map
}

/**
 * Рисует прямоугольный корпус комнаты. Периметр остаётся клетками стены, а
 * соседние проходы потом получают настоящие двери на рёбрах.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} rect
 * @param {string} zoneId
 * @param {string} material
 */
function paintFortressRoom(map, rect, zoneId, material) {
  for (let y = rect.minY; y <= rect.maxY; y += 1) {
    for (let x = rect.minX; x <= rect.maxX; x += 1) {
      const border = x === rect.minX || x === rect.maxX || y === rect.minY || y === rect.maxY
      setCell(map, x, y, {
        passable: !border,
        material: border ? 'stone' : material,
        zone: border ? 'walls' : zoneId,
        variant: floorVariantAt(map.seed, x, y),
      })
    }
  }
}

/**
 * Внешние стены и корпуса имеют одну серверную границу: непроходимая клетка
 * плюс ребро-стена. Поэтому старый `scene.cells` и TacticalMap совпадают.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 */
function outlineFortressWalls(map) {
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.passable) continue
      edgesAround(map, x, y, 'wall')
    }
  }
}

/**
 * Ставит дверь по уже выбранному ребру. `setDoor` остаётся единственным
 * владельцем согласования записи двери и ребра.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{id: string, x: number, y: number, dir: 'e'|'s'}} door
 */
function addFortressDoor(map, door) {
  setDoor(map, {
    ...door,
    state: 'closed',
    blocksMove: false,
    blocksSight: false,
  })
}

/**
 * Смысловой план предметов крепости. `purpose` не расширяет схему зоны: это
 * подсказка владельцу расстановки, чтобы склад и казарма не получали один
 * случайный каталог.
 *
 * @param {string} seed
 * @param {import('./tactical-map.mjs').TacticalMap} map
 */
function placeAresFortressProps(seed, map) {
  placeProps(map, {
    seed: `${seed}:props`,
    maxProps: SIZE_CLASSES.area.maxProps,
    zones: [
      {
        zoneId: 'gallery', purpose: 'hall', theme: 'building', density: 22,
        require: ['table_small', 'candelabra', 'banner', 'chair', 'chandelier'],
        prefer: ['table_small', 'candelabra', 'banner', 'chair', 'chandelier', 'bookshelf'],
      },
      {
        zoneId: 'barracks', purpose: 'barracks', theme: 'building', density: 24,
        require: ['bunk_bed', 'bunk_bed', 'chest', 'table_long', 'bench'],
        prefer: ['bunk_bed', 'bed', 'chest', 'table_long', 'bench', 'bookshelf', 'lantern_wall'],
      },
      {
        zoneId: 'stables', purpose: 'stable', theme: 'yard', density: 22,
        require: ['haystack', 'water_trough', 'hitching_post'],
        prefer: ['haystack', 'water_trough', 'hitching_post', 'woodpile', 'lamp_post'],
      },
      {
        zoneId: 'storehouse', purpose: 'store', theme: 'building', density: 30,
        require: ['crate_stack', 'barrel_stack', 'chest', 'shelf_wall'],
        prefer: ['crate_stack', 'barrel_stack', 'crate', 'barrel', 'sack', 'chest', 'shelf_wall'],
      },
      {
        zoneId: 'workshop', purpose: 'workshop', theme: 'building', density: 32,
        // `workshop` уже добавляет стол и полку через semantic_props; здесь
        // закрепляем снабжение и топливо, чтобы мастерская не стала вторым
        // залом даже при малом бюджете зоны.
        require: ['crate', 'barrel', 'firewood_stack'],
        prefer: ['crate', 'barrel', 'firewood_stack', 'chest', 'cauldron'],
      },
      {
        zoneId: 'exterior', purpose: 'exterior', theme: 'yard', density: 6,
        require: ['tree_oak', 'bush', 'boulder'],
        prefer: ['tree_oak', 'tree_pine', 'tree_dead', 'bush', 'shrub', 'boulder', 'rock_small'],
      },
      {
        zoneId: 'courtyard', purpose: 'courtyard', theme: 'yard', density: 8,
        require: ['well', 'water_trough', 'woodpile', 'lamp_post'],
        prefer: ['well', 'water_trough', 'woodpile', 'lamp_post', 'campfire', 'bush'],
      },
    ],
  })
}

/**
 * Авторская «Крепость Ареса»: внешний двор с тремя воротами и пять
 * функциональных корпусов вокруг него. В отличие от общего генератора здания
 * здесь seed не меняет топологию: повторный вход возвращает тот же двор,
 * двери и комнаты, а меняется только порядок вариантов пола и предметов.
 *
 * @param {object} [options]
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @param {string} [options.theme]
 * @param {boolean} [options.withProps]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function generateAresFortressScene({
  seed = 'ares-fortress',
  width = ARES_FORTRESS_SIZE.width,
  height = ARES_FORTRESS_SIZE.height,
  locationId = '',
  theme = 'authored-palace',
  withProps = true,
} = {}) {
  const safeWidth = Math.max(36, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(36, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { ...ARES_FORTRESS_GENERATOR },
    theme,
    tilesetId: 'fortress',
    sizeClass: 'area',
  })

  addZone(map, { id: 'courtyard', kind: 'exterior', material: 'grass', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Большой внутренний двор' })
  addZone(map, { id: 'exterior', kind: 'exterior', material: 'grass', lightLevel: 'bright', floorDirection: 'horizontal', label: '' })
  addZone(map, { id: 'gallery', kind: 'interior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Военная галерея' })
  addZone(map, { id: 'barracks', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'vertical', label: 'Казарма' })
  addZone(map, { id: 'stables', kind: 'interior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Конюшня' })
  addZone(map, { id: 'storehouse', kind: 'interior', material: 'wood', lightLevel: 'dark', floorDirection: 'vertical', label: 'Военный склад' })
  addZone(map, { id: 'workshop', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Мастерская' })
  addZone(map, { id: 'walls', kind: 'interior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: '' })

  // Трёхклеточный внешний пояс даёт место крупным деревьям и камням. Один
  // срезанный угол с каждой диагонали делает контур крепости менее коробочным,
  // но диагональный срез не открывает ортогональный проход во двор.
  const outer = { minX: 3, minY: 3, maxX: safeWidth - 4, maxY: safeHeight - 4 }
  const courtyard = { minX: outer.minX + 1, minY: outer.minY + 1, maxX: outer.maxX - 1, maxY: outer.maxY - 1 }
  const centerX = Math.floor((outer.minX + outer.maxX) / 2)

  // Внешняя площадка остаётся клетками карты: через ворота можно выйти за
  // стену, а не упереться в край прямоугольника.
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      setCell(map, x, y, {
        passable: true,
        material: 'grass',
        zone: x < outer.minX || x > outer.maxX || y < outer.minY || y > outer.maxY ? 'exterior' : '',
        variant: floorVariantAt(seed, x, y),
        revealed: false,
      })
    }
  }
  for (let y = courtyard.minY; y <= courtyard.maxY; y += 1) {
    for (let x = courtyard.minX; x <= courtyard.maxX; x += 1) {
      setCell(map, x, y, { passable: true, material: 'grass', zone: 'courtyard' })
    }
  }

  // Основа двора — трава. Позже в нём появятся earth-карманы и каменные
  // дорожки; так покрытие различается даже без растрового арта.

  // Наружная стена крепости.
  for (let x = outer.minX; x <= outer.maxX; x += 1) {
    for (const y of [outer.minY, outer.maxY]) setCell(map, x, y, { passable: false, material: 'stone', zone: 'walls' })
  }
  for (let y = outer.minY; y <= outer.maxY; y += 1) {
    for (const x of [outer.minX, outer.maxX]) setCell(map, x, y, { passable: false, material: 'stone', zone: 'walls' })
  }

  const gallery = { minX: Math.round(safeWidth * 0.28), minY: 5, maxX: Math.round(safeWidth * 0.72), maxY: 13 }
  const barracks = { minX: 5, minY: 16, maxX: Math.round(safeWidth * 0.28), maxY: Math.min(courtyard.maxY - 3, Math.round(safeHeight * 0.82)) }
  const stables = { minX: Math.round(safeWidth * 0.72), minY: 16, maxX: safeWidth - 6, maxY: barracks.maxY }
  const workshopTop = Math.min(courtyard.maxY - 5, Math.round(safeHeight * 0.72))
  // Оставляем полосу перед главными воротами свободной: южная дверь мастерской
  // не должна занять сам проезд во двор.
  const workshopBottom = courtyard.maxY - 1
  const storehouse = { minX: Math.round(safeWidth * 0.33), minY: workshopTop, maxX: centerX, maxY: workshopBottom }
  const workshop = { minX: centerX, minY: workshopTop, maxX: Math.round(safeWidth * 0.67), maxY: workshopBottom }
  const galleryEastDoorY = gallery.minY + 4
  const barracksDoorY = Math.floor((barracks.minY + barracks.maxY) / 2)
  const stablesDoorY = Math.floor((stables.minY + stables.maxY) / 2)
  const storehouseDoorX = storehouse.minX + 2
  const workshopDoorX = workshop.minX + 2
  const storeWorkshopDoorY = Math.floor((workshopTop + workshopBottom) / 2)
  paintFortressRoom(map, gallery, 'gallery', 'stone')
  paintFortressRoom(map, barracks, 'barracks', 'wood')
  paintFortressRoom(map, stables, 'stables', 'earth')
  paintFortressRoom(map, storehouse, 'storehouse', 'wood')
  paintFortressRoom(map, workshop, 'workshop', 'stone')

  // Проёмы в корпусах. Дверь — проход в стене, а не декоративная клетка:
  // вокруг неё остаются косяки и стены, соседняя зона достижима по ребру.
  setCell(map, centerX, gallery.maxY, { passable: true, material: 'stone', zone: 'gallery' })
  setCell(map, gallery.maxX, galleryEastDoorY, { passable: true, material: 'stone', zone: 'gallery' })
  setCell(map, barracks.maxX, barracksDoorY, { passable: true, material: 'wood', zone: 'barracks' })
  setCell(map, stables.minX, stablesDoorY, { passable: true, material: 'earth', zone: 'stables' })
  setCell(map, storehouseDoorX, storehouse.minY, { passable: true, material: 'wood', zone: 'storehouse' })
  setCell(map, workshopDoorX, workshop.minY, { passable: true, material: 'stone', zone: 'workshop' })
  setCell(map, centerX, storeWorkshopDoorY, { passable: true, material: 'wood', zone: 'storehouse' })

  // Ворота оставляют внешний двор частью той же карты и дают три реальные
  // входа: главный проезд и две боковые калитки.
  const sideGateY = gallery.maxY + 1
  setCell(map, centerX, outer.maxY, { passable: true, material: 'stone', zone: 'courtyard' })
  setCell(map, outer.minX, sideGateY, { passable: true, material: 'stone', zone: 'courtyard' })
  setCell(map, outer.maxX, sideGateY, { passable: true, material: 'stone', zone: 'courtyard' })
  for (const corner of [
    { x: outer.minX, y: outer.minY },
    { x: outer.maxX, y: outer.maxY },
  ]) {
    setCell(map, corner.x, corner.y, { passable: true, material: 'grass', zone: 'exterior' })
  }

  /** @param {number} x @param {number} fromY @param {number} toY @param {number} [halfWidth] */
  const paintVerticalPath = (x, fromY, toY, halfWidth = 0) => {
    const low = Math.min(fromY, toY)
    const high = Math.max(fromY, toY)
    for (let y = low; y <= high; y += 1) {
      for (let dx = -halfWidth; dx <= halfWidth; dx += 1) {
        const cell = cellAt(map, x + dx, y)
        if (cell?.passable && cell.zone === 'courtyard') setCell(map, x + dx, y, { material: 'stone' })
      }
    }
  }
  /** @param {number} y @param {number} fromX @param {number} toX @param {number} [halfWidth] */
  const paintHorizontalPath = (y, fromX, toX, halfWidth = 0) => {
    const low = Math.min(fromX, toX)
    const high = Math.max(fromX, toX)
    for (let x = low; x <= high; x += 1) {
      for (let dy = -halfWidth; dy <= halfWidth; dy += 1) {
        const cell = cellAt(map, x, y + dy)
        if (cell?.passable && cell.zone === 'courtyard') setCell(map, x, y + dy, { material: 'stone' })
      }
    }
  }

  // Земляные карманы остаются между дорожками: это место для дворовой жизни,
  // а не единая каменная площадка.
  const earthPockets = [
    { minX: courtyard.minX + 2, maxX: courtyard.minX + 6, minY: courtyard.minY + 2, maxY: courtyard.minY + 6 },
    { minX: courtyard.maxX - 6, maxX: courtyard.maxX - 2, minY: courtyard.maxY - 6, maxY: courtyard.maxY - 2 },
  ]
  for (const pocket of earthPockets) {
    for (let y = pocket.minY; y <= pocket.maxY; y += 1) {
      for (let x = pocket.minX; x <= pocket.maxX; x += 1) {
        if (cellAt(map, x, y)?.zone === 'courtyard') setCell(map, x, y, { material: 'earth' })
      }
    }
  }
  // Главная ось идёт от ворот к галерее, а короткие ответвления — к каждому
  // корпусу. Проверка зоны не даёт дорожке прорезать стены зданий.
  paintVerticalPath(centerX, gallery.maxY + 1, courtyard.maxY, 1)
  paintHorizontalPath(galleryEastDoorY, centerX, gallery.maxX + 1)
  paintHorizontalPath(barracksDoorY, barracks.maxX + 1, centerX)
  paintHorizontalPath(stablesDoorY, centerX, stables.minX - 1)
  const workshopPathY = workshopTop - 1
  paintHorizontalPath(workshopPathY, storehouseDoorX, workshopDoorX)
  paintVerticalPath(storehouseDoorX, workshopPathY, storehouse.minY - 1)
  paintVerticalPath(workshopDoorX, workshopPathY, workshop.minY - 1)

  outlineFortressWalls(map)
  addFortressDoor(map, { id: 'gallery-courtyard-door', x: centerX, y: gallery.maxY, dir: 's' })
  addFortressDoor(map, { id: 'gallery-east-door', x: gallery.maxX, y: galleryEastDoorY, dir: 'e' })
  addFortressDoor(map, { id: 'barracks-door', x: barracks.maxX, y: barracksDoorY, dir: 'e' })
  addFortressDoor(map, { id: 'stables-door', x: stables.minX - 1, y: stablesDoorY, dir: 'e' })
  addFortressDoor(map, { id: 'storehouse-door', x: storehouseDoorX, y: storehouse.minY, dir: 's' })
  addFortressDoor(map, { id: 'workshop-door', x: workshopDoorX, y: workshop.minY, dir: 's' })
  addFortressDoor(map, { id: 'storehouse-workshop-door', x: centerX, y: storeWorkshopDoorY, dir: 'e' })
  addFortressDoor(map, { id: 'main-gate', x: centerX, y: outer.maxY - 1, dir: 's' })
  addFortressDoor(map, { id: 'west-sally', x: outer.minX, y: sideGateY, dir: 'e' })
  addFortressDoor(map, { id: 'east-sally', x: outer.maxX - 1, y: sideGateY, dir: 'e' })

  if (withProps) placeAresFortressProps(seed, map)

  // Авторский пролог начинается в галерее. Выбираем свободную клетку рядом с
  // картографическим столом, чтобы партия и король действительно стояли в
  // одной функциональной комнате, а не на случайном дворе.
  const table = map.props.find((prop) => prop.assetId === 'table_long' && prop.footprint.some((cell) => cellAt(map, cell.x, cell.y)?.zone === 'gallery'))
    ?? map.props.find((prop) => prop.assetId === 'table_small' && prop.footprint.some((cell) => cellAt(map, cell.x, cell.y)?.zone === 'gallery'))
  if (table) table.id = 'war-table'
  const occupied = new Set(map.props.flatMap((prop) => prop.footprint.map((cell) => `${cell.x},${cell.y}`)))
  /** @type {Array<{x: number, y: number}>} */
  const galleryCells = []
  for (let y = gallery.minY + 1; y < gallery.maxY; y += 1) {
    for (let x = gallery.minX + 1; x < gallery.maxX; x += 1) {
      if (cellAt(map, x, y)?.passable && !occupied.has(`${x},${y}`)) galleryCells.push({ x, y })
    }
  }
  /** @param {{x: number, y: number}} cell @param {{x: number, y: number}} anchor @returns {number} */
  const distance = (cell, anchor) => Math.abs(cell.x - anchor.x) + Math.abs(cell.y - anchor.y)
  const tableAnchor = table?.footprint[0] ?? { x: centerX, y: gallery.minY + 3 }
  galleryCells.sort((left, right) => distance(left, tableAnchor) - distance(right, tableAnchor) || left.x - right.x || left.y - right.y)
  const partyStart = galleryCells[0] ?? { x: centerX, y: gallery.minY + 2 }
  map.spawnPoints.push({ id: 'party-war-gallery', x: partyStart.x, y: partyStart.y, role: 'party' })
  const kingStart = galleryCells.find((cell) => cell !== partyStart && distance(cell, tableAnchor) > 0) ?? partyStart
  map.spawnPoints.push({ id: 'king-war-gallery', x: kingStart.x, y: kingStart.y, role: 'neutral' })

  // Общий план королевской крепости известен приглашённой партии. Двери и
  // непроходимые стены всё равно проверяются при каждом физическом переходе.
  for (let y = courtyard.minY; y <= courtyard.maxY; y += 1) {
    for (let x = courtyard.minX; x <= courtyard.maxX; x += 1) {
      if (cellAt(map, x, y)) setCell(map, x, y, { revealed: true })
    }
  }
  for (let y = gallery.minY; y <= gallery.maxY; y += 1) {
    for (let x = gallery.minX; x <= gallery.maxX; x += 1) {
      if (cellAt(map, x, y)) setCell(map, x, y, { revealed: true })
    }
  }
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: map.zones.filter((zone) => zone.label).map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }
  return map
}

/**
 * Сборка authored-крепости с тем же отчётом, что и общий building-generator.
 *
 * @param {Parameters<typeof generateAresFortressScene>[0]} [options]
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, fallback: string, warnings: string[]}}
 */
export function buildAresFortressScene(options = {}) {
  const map = generateAresFortressScene(options)
  const report = validateTacticalMap(map)
  const reachability = reachabilityIssues(map)
  return {
    map,
    fallback: 'none',
    warnings: [...report.errors.map((issue) => issue.code), ...reachability, ...tacticalFitnessWarnings(map)],
  }
}

/**
 * Привязывает объявленные этажи к лестницам зала и достраивает недостающие.
 *
 * Одной привязки мало: `placeProps` ставит лестницу наравне с мебелью, и на
 * части сидов она не помещается — `stairs_up` занимает две клетки у стены.
 * Пока лестница была декором, это ничего не значило; с объявленным вторым
 * этажом это дыра: этаж есть, а подняться нечем. Поэтому недостающий крючок
 * ставится явно, по первой свободной клетке зала у стены.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Array<{offset?: number, label?: string}>} levels
 * @param {string} zoneId зона, в которой ищется место под лестницу
 */
function ensureDeclaredTransitions(map, levels, zoneId) {
  const declared = Array.isArray(levels) ? levels : []
  if (!declared.length) return
  const attached = attachLevelTransitions(map, declared)
  const covered = new Set(attached.map((prop) => prop.transition?.toLevel))
  /** @type {Set<string>} */
  const occupied = new Set()
  for (const prop of map.props) for (const cell of prop.footprint) occupied.add(`${cell.x},${cell.y}`)
  for (const level of declared) {
    const toLevel = Number(level?.offset)
    if (!Number.isSafeInteger(toLevel) || toLevel === map.levelIndex || covered.has(toLevel)) continue
    const spot = freeWallCellIn(map, zoneId, occupied)
    if (!spot) continue
    addProp(map, {
      id: `level-transition-${toLevel}`,
      assetId: toLevel > map.levelIndex ? 'stairs_up' : 'stairs_down',
      x: spot.x + 0.5,
      y: spot.y + 0.5,
      rotation: 0,
      scale: 1,
      // Одна клетка, а не штатный след 2×1: лестница обязана встать даже в
      // тесном зале, а её точные координаты нужны парному переходу этажом выше.
      footprint: [{ x: spot.x, y: spot.y }],
      zOrder: 0,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      interactive: true,
      transition: { toLevel, label: String(level?.label ?? '') },
    })
    covered.add(toLevel)
    occupied.add(`${spot.x},${spot.y}`)
  }
}

/**
 * Первая свободная проходимая клетка зоны, у которой есть стена: лестница
 * прижимается к кладке, а не встаёт посреди зала. Обход по y, затем x —
 * результат детерминирован.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 * @param {Set<string>} occupied
 * @returns {{x: number, y: number}|null}
 */
function freeWallCellIn(map, zoneId, occupied) {
  /** @type {{x: number, y: number}|null} */
  let anywhere = null
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell || !cell.passable || cell.zone !== zoneId || occupied.has(`${x},${y}`)) continue
      if (!anywhere) anywhere = { x, y }
      const nearWall = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dx, dy]) => cellAt(map, x + dx, y + dy)?.passable !== true)
      if (nearWall) return { x, y }
    }
  }
  return anywhere
}

/**
 * Превращает клетку стены в проход: клетка становится проходимой, а дверь
 * встаёт на её собственное ребро — то же соглашение, что при преобразовании
 * старых карт, поэтому обратная совместимость сохраняется.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @param {string} id
 */
export function openDoorway(map, x, y, id) {
  const cell = cellAt(map, x, y)
  if (!cell) return
  setCell(map, x, y, { passable: true, material: 'wood' })
  // Рёбра-стены вокруг будущего проёма были построены, пока он сам был стеной.
  // Проём обязан их снять, иначе клетка станет проходимой, но окружённой
  // стенами — и внутрь здания пути не будет. Рёбра к соседям-стенам остаются:
  // это косяки.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighbor = cellAt(map, x + dx, y + dy)
    if (!neighbor || !neighbor.passable) continue
    setEdge(map, x, y, x + dx, y + dy, { kind: 'none' })
  }
  // Дверь встаёт поперёк прохода. Прежде направление угадывалось условием
  // «восток проходим, а юг нет», и на проходе вдоль вертикальной стены полотно
  // садилось на глухое ребро: дверь была, а перекрывать ей было нечего.
  const edge = doorwayEdgeAt(map, x, y)
  if (!edge) return
  setDoor(map, {
    id,
    x: edge.x,
    y: edge.y,
    dir: edge.dir,
    state: 'closed',
    // Признаки стены — про сам проём: он открыт. Проход перекрывает полотно
    // двери, и спрашивают о нём отдельно (`doorBlocksStep`).
    blocksMove: false,
    blocksSight: false,
  })
}

/**
 * Окно: стена остаётся непроходимой, но её рёбра перестают перекрывать обзор.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 */
export function openWindow(map, x, y) {
  const cell = cellAt(map, x, y)
  if (!cell || cell.passable) return
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighbor = cellAt(map, x + dx, y + dy)
    if (!neighbor || !neighbor.passable) continue
    setEdge(map, x, y, x + dx, y + dy, { kind: 'window', blocksMove: true, blocksSight: false, cover: 'three_quarters' })
  }
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 */
function railBetween(map, ax, ay, bx, by) {
  if (!cellAt(map, ax, ay) || !cellAt(map, bx, by)) return
  if (edgeBetween(map, ax, ay, bx, by)) return
  setEdge(map, ax, ay, bx, by, { kind: 'rail', blocksMove: true, blocksSight: false, cover: 'half' })
}

/**
 * Сборка с проверкой и тремя ступенями отката (`docs/tactical-map-plan.md`,
 * раздел 10): ослабить необязательные требования, затем упростить планировку,
 * затем отдать минимальную безопасную комнату. Игра не останавливается никогда.
 *
 * @param {{seed?: string, width?: number, height?: number, locationId?: string, theme?: string, withProps?: boolean, levels?: Array<{offset?: number, label?: string}>}} [options]
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, fallback: string, warnings: string[]}}
 */
export function buildBuildingScene(options = {}) {
  const attempts = [
    { fallback: 'none', build: () => generateBuildingScene(options) },
    { fallback: 'no_props', build: () => generateBuildingScene({ ...options, withProps: false }) },
    { fallback: 'safe_room', build: () => safeRoom(options) },
  ]
  /** @type {string[]} */
  let lastErrors = []
  for (const attempt of attempts) {
    let map
    try {
      map = attempt.build()
    } catch (error) {
      lastErrors = [String(error instanceof Error ? error.message : error)]
      continue
    }
    const report = validateTacticalMap(map)
    const reachability = reachabilityIssues(map)
    if (report.ok && !reachability.length) {
      return { map, fallback: attempt.fallback, warnings: tacticalFitnessWarnings(map) }
    }
    lastErrors = [...report.errors.map((issue) => issue.code), ...reachability]
  }
  // Последняя ступень обязана быть валидной по построению; если и она нет —
  // отдаём её всё равно, но с честным предупреждением.
  const map = safeRoom(options)
  return { map, fallback: 'safe_room', warnings: [`не удалось собрать сцену: ${lastErrors.join(', ')}`] }
}

/**
 * Все помещения обязаны быть достижимы от точки появления отряда.
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {string[]}
 */
export function reachabilityIssues(map) {
  const spawn = map.spawnPoints.find((point) => point.role === 'party') ?? map.spawnPoints[0]
  if (!spawn) return ['SPAWN_POINT_MISSING']
  const reached = reachableCells(map, spawn.x, spawn.y)
  /** @type {string[]} */
  const issues = []
  for (const zone of map.zones) {
    if (!zone.label) continue
    let total = 0
    let seen = 0
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const cell = cellAt(map, x, y)
        if (!cell || !cell.passable || cell.zone !== zone.id) continue
        total += 1
        if (reached.has(`${x},${y}`)) seen += 1
      }
    }
    if (total && !seen) issues.push(`ZONE_UNREACHABLE:${zone.id}`)
  }
  return issues
}

/**
 * Проверка тактической пригодности — предупреждением, а не отказом
 * (`docs/tactical-map-plan.md`, раздел 10, последний абзац).
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {string[]}
 */
export function tacticalFitnessWarnings(map) {
  /** @type {string[]} */
  const warnings = []
  let passable = 0
  let covered = 0
  let open = 0
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell || !cell.passable) continue
      passable += 1
      const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .filter(([dx, dy]) => cellAt(map, x + dx, y + dy)?.passable).length
      if (neighbours >= 4) open += 1
      if (neighbours <= 2) covered += 1
    }
  }
  if (!passable) return ['NO_PASSABLE_CELLS']
  const coverShare = covered / passable
  const openShare = open / passable
  if (coverShare > 0.6) warnings.push('TOO_MANY_CORRIDORS: карта из коридоров обесценивает дальний бой')
  if (openShare > 0.9) warnings.push('TOO_OPEN: пустой зал обесценивает укрытия')
  const props = map.props.filter((prop) => prop.cover !== 'none').length
  if (props < 4) warnings.push('LOW_COVER: укрытий почти нет')
  return warnings
}

/**
 * Минимальная безопасная комната — последняя ступень отката.
 * @param {{seed?: string, locationId?: string, theme?: string}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function safeRoom({ seed = 'safe', locationId = '', theme = 'tavern' } = {}) {
  const map = createTacticalMap({
    width: 11,
    height: 9,
    locationId,
    seed: String(seed),
    generator: { ...BUILDING_GENERATOR },
    theme,
    sizeClass: 'arena',
  })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Комната' })
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 11; x += 1) {
      const border = x === 0 || y === 0 || x === 10 || y === 8
      setCell(map, x, y, {
        passable: !border,
        material: border ? 'stone' : 'wood',
        zone: 'hall',
        revealed: true,
        variant: floorVariantAt(seed, x, y),
      })
    }
  }
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 11; x += 1) {
      const own = cellAt(map, x, y)
      if (own && !own.passable) edgesAround(map, x, y, 'wall')
    }
  }
  map.spawnPoints.push({ id: 'party-entrance', x: 1, y: 4, role: 'party' })
  map.overlays = { compass: true, scaleBar: true, roomLabels: [{ zoneId: 'hall', label: 'Комната' }] }
  return map
}
