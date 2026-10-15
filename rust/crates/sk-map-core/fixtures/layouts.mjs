// Случайные планировки «до тонких стен» для эталонов sk-map-core: дворы,
// дома с кладкой клетками (одинарной и двойной), перегородки, служебная зона
// `walls`, двери в стене и в перегородке, окна, вода, дыры в контуре карты.
// Это вход проходов `thinWalls`, `applyRoomFloors`, `raiseDais`,
// `deepestRoom` и аудита в краевых случаях, до которых генераторы не доходят.

const PROP_ASSETS = ['barrel', 'crate', 'chair', 'table', 'urn', 'wardrobe', 'pillar', 'tree_oak', 'tree_pine', 'bush', 'shrub', 'chest', 'market_awning', 'well', 'campfire', 'altar', 'statue', 'bench', 'rug', 'brazier', 'haystack', 'bookshelf', 'grave', 'path_stone']

/**
 * Предметы на случайных клетках: одиночные и кучками, на опоре стены и на
 * столе, переходы, след в одну-две клетки и без следа (запасная клетка
 * `Math.floor(x)`), иногда за краем карты.
 *
 * @param {typeof import('../../../../server/tactical-map.mjs')} t
 * @param {any} map
 * @param {() => number} random
 */
export function sprinkleProps(t, map, random) {
  const int = (n) => Math.floor(random() * n)
  const pick = (items) => items[int(items.length)]
  const chance = (p) => random() < p
  const count = int(Math.max(2, Math.floor(map.width * map.height / 6)))
  for (let index = 0; index < count; index += 1) {
    const asset = pick(PROP_ASSETS)
    const x = chance(0.04) ? pick([-1, map.width, map.width + 2]) : int(map.width)
    const y = chance(0.04) ? pick([-1, map.height]) : int(map.height)
    const run = chance(0.15) ? 2 + int(3) : 1
    for (let step = 0; step < run; step += 1) {
      const px = x + (chance(0.5) ? step : 0)
      const py = y + (px === x ? step : 0)
      const footprint = chance(0.1) ? [] : chance(0.15) ? [{ x: px, y: py }, { x: px + 1, y: py }] : [{ x: px, y: py }]
      const prop = {
        id: `prop-${index}-${step}`, assetId: asset, x: px + (chance(0.3) ? 0.25 : 0.5), y: py + 0.5,
        footprint, blocksMove: chance(0.6), blocksSight: chance(0.25), cover: pick(['none', 'none', 'half', 'three_quarters']),
      }
      if (chance(0.06)) prop.mount = pick([{ kind: 'wall', side: pick(['n', 'e', 's', 'w']) }, { kind: 'surface', propId: 'prop-0-0' }])
      if (chance(0.04)) {
        prop.assetId = pick(['stairs_up', 'stairs_down', 'trapdoor'])
        prop.transition = { toLevel: prop.assetId === 'stairs_up' ? 1 : -1, label: 'Этаж' }
      }
      if (chance(0.02)) delete prop.x
      t.addProp(map, prop)
    }
  }
}

const LABELS = ['Общий зал', 'Кухня', 'Кладовая', 'Спальня', 'Камеры', 'Погреб', 'Мастерская', 'Алтарная', 'Неф', 'Салон', 'Кабинет', 'Конюшня', 'Склад', 'Горница', 'Казарма', 'Кузня', 'Зал', '']
const MATERIALS = ['stone', 'wood', 'earth', 'grass', 'sand', 'marble', 'metal', 'ice']

/**
 * @param {typeof import('../../../../server/tactical-map.mjs')} t
 * @param {() => number} random
 * @param {string} seed
 */
export function randomLayout(t, random, seed) {
  const int = (n) => Math.floor(random() * n)
  const pick = (items) => items[int(items.length)]
  const chance = (p) => random() < p
  const width = 6 + int(14)
  const height = 6 + int(12)
  const map = t.createTacticalMap({ width, height, seed, generator: { id: 'fixture-layout', version: '1' }, theme: pick(['', 'village', 'crypt']) })
  t.addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', label: 'Двор' })
  const useWallsZone = chance(0.35)
  if (useWallsZone) t.addZone(map, { id: 'walls', kind: 'interior', material: pick(MATERIALS), label: '' })
  if (chance(0.3)) t.addZone(map, { id: 'court', kind: 'exterior', material: 'stone', label: 'Внутренний двор' })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (chance(0.03)) continue
      t.setCell(map, x, y, { passable: true, zone: 'yard', material: 'grass', revealed: chance(0.5) })
    }
  }
  const zoneIds = []
  const buildings = 1 + int(3)
  for (let index = 0; index < buildings; index += 1) {
    const w = 4 + int(Math.max(1, width - 4))
    const h = 4 + int(Math.max(1, height - 4))
    const x0 = int(Math.max(1, width - w + 1))
    const y0 = int(Math.max(1, height - h + 1))
    const x1 = Math.min(width - 1, x0 + w - 1)
    const y1 = Math.min(height - 1, y0 + h - 1)
    const material = pick(MATERIALS)
    const thick = chance(0.2) ? 2 : 1
    const wallZone = useWallsZone && chance(0.6) ? 'walls' : ''
    const rooms = []
    const roomCount = chance(0.6) ? 2 : 1
    for (let r = 0; r < roomCount; r += 1) {
      const id = chance(0.15) ? pick(['hall', 'kitchen', 'store', 'cellar', 'bedroom', 'cells']) + `-${index}-${r}` : `b${index}-r${r}`
      if (zoneIds.includes(id)) continue
      t.addZone(map, { id, kind: 'interior', material, label: pick(LABELS) })
      zoneIds.push(id)
      rooms.push(id)
    }
    if (!rooms.length) continue
    const vertical = chance(0.5)
    const split = vertical ? x0 + Math.floor((x1 - x0) / 2) : y0 + Math.floor((y1 - y0) / 2)
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const ring = x - x0 < thick || x1 - x < thick || y - y0 < thick || y1 - y < thick
        const partition = rooms.length > 1 && (vertical ? x === split : y === split)
        if (ring || partition) {
          t.setCell(map, x, y, { passable: false, zone: wallZone, material, surface: 'none' })
          continue
        }
        const second = rooms.length > 1 && (vertical ? x > split : y > split)
        t.setCell(map, x, y, { passable: true, zone: rooms[second ? 1 : 0], material, elevation: chance(0.05) ? pick([5, -5, 10]) : 0 })
      }
    }
    // Двери: клетка кладки становится проёмом, полотно — на ребре к соседу.
    const doorCount = int(4)
    for (let d = 0; d < doorCount; d += 1) {
      const side = int(4)
      const x = side < 2 ? x0 + 1 + int(Math.max(1, x1 - x0 - 1)) : side === 2 ? x0 : x1
      const y = side >= 2 ? y0 + 1 + int(Math.max(1, y1 - y0 - 1)) : side === 0 ? y0 : y1
      const cell = t.cellAt(map, x, y)
      if (!cell || cell.passable) continue
      t.setCell(map, x, y, { passable: true, zone: pick([wallZone, rooms[0], '']), material })
      const outward = side === 0 ? [0, -1] : side === 1 ? [0, 1] : side === 2 ? [-1, 0] : [1, 0]
      const [dx, dy] = chance(0.5) ? outward : [-outward[0], -outward[1]]
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const edge = t.canonicalEdge(x, y, nx, ny)
      t.setDoor(map, { id: `door-${index}-${d}`, x: edge.x, y: edge.y, dir: edge.dir, state: pick(['open', 'closed', 'locked', 'broken']), lockDc: pick([0, 12]), blocksMove: chance(0.5), blocksSight: chance(0.5) })
    }
    // Проём в перегородке — дверь посреди стены между комнатами.
    if (rooms.length > 1 && chance(0.7)) {
      const along = vertical ? y0 + thick + int(Math.max(1, y1 - y0 - 2 * thick)) : x0 + thick + int(Math.max(1, x1 - x0 - 2 * thick))
      const x = vertical ? split : along
      const y = vertical ? along : split
      if (t.cellAt(map, x, y) && !t.cellAt(map, x, y).passable) {
        t.setCell(map, x, y, { passable: true, zone: pick([rooms[0], rooms[1], wallZone, '']), material })
        const [nx, ny] = vertical ? [x + (chance(0.5) ? 1 : -1), y] : [x, y + (chance(0.5) ? 1 : -1)]
        if (t.cellAt(map, nx, ny)) {
          const edge = t.canonicalEdge(x, y, nx, ny)
          t.setDoor(map, { id: `inner-${index}`, x: edge.x, y: edge.y, dir: edge.dir, state: pick(['open', 'closed']), blocksMove: chance(0.5), blocksSight: chance(0.5) })
        }
      }
    }
    // Окна наружу и случайные проёмы.
    for (let w2 = 0; w2 < int(4); w2 += 1) {
      const x = x0 + int(Math.max(1, x1 - x0 + 1))
      const y = pick([y0, y1])
      const ny = y === y0 ? y - 1 : y + 1
      if (ny < 0 || ny >= height || !t.cellAt(map, x, ny)) continue
      t.setEdge(map, x, y, x, ny, { kind: pick(['window', 'window', 'loophole', 'grate', 'rail', 'wall']), blocksMove: true, blocksSight: chance(0.3) })
    }
  }
  // Вода и одиночные камни во дворе.
  for (let index = 0; index < int(6); index += 1) {
    const x = int(width)
    const y = int(height)
    const cell = t.cellAt(map, x, y)
    if (!cell || cell.zone !== 'yard') continue
    t.setCell(map, x, y, chance(0.6) ? { passable: false, surface: 'water' } : { passable: false, material: 'stone' })
  }
  // Случайные рёбра-стены во дворе и проходы без двери.
  for (let index = 0; index < int(5); index += 1) {
    const x = int(width - 1)
    const y = int(height - 1)
    const [nx, ny] = chance(0.5) ? [x + 1, y] : [x, y + 1]
    if (!t.cellAt(map, x, y) || !t.cellAt(map, nx, ny)) continue
    t.setEdge(map, x, y, nx, ny, { kind: pick(['wall', 'window', 'ledge', 'none']), blocksMove: chance(0.7), blocksSight: chance(0.5) })
  }
  if (chance(0.9)) {
    const free = []
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (t.cellAt(map, x, y)?.passable) free.push([x, y])
    if (free.length) {
      const [x, y] = pick(free)
      t.addSpawnPoint(map, { id: 'party-entrance', x, y, role: 'party' })
    }
  }
  return map
}
