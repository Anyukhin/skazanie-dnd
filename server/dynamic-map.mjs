import { createHash } from 'node:crypto'

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

function randomFor(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function featuresFor(theme, layout, pattern, material) {
  const value = `${theme} ${layout} ${pattern} ${material}`.toLocaleLowerCase('ru')
  if (/дом|комнат|кабинет|камор|спальн|хижин|таверн|small-room/iu.test(value)) {
    return ['bed', 'table', 'chair', 'chair', 'fireplace', 'bookshelf', 'barrel', 'chest', 'crate', 'torch']
  }
  if (/пещ|шахт|подзем|cave-cluster|cavern/iu.test(value)) {
    return ['rock', 'rock', 'mushroom', 'mushroom', 'bones', 'torch', 'rune', 'stairs', 'chest', 'campfire']
  }
  if (/склеп|крипт|гробниц|crypt/iu.test(value)) {
    return ['grave', 'grave', 'pillar', 'altar', 'bones', 'torch', 'statue', 'stairs', 'chest']
  }
  if (/лес|болот|чащ|роща|луг|grass|wild|natural/iu.test(value)) {
    return ['tree', 'tree', 'bush', 'bush', 'rock', 'campfire', 'rune', 'chest', 'stairs']
  }
  if (/город|деревн|рынок|улиц|порт|village|streets/iu.test(value)) {
    return ['barrel', 'crate', 'wagon', 'well', 'table', 'torch', 'chest', 'stairs', 'statue']
  }
  if (/храм|дворец|мрамор|marble|courtyard|great-hall/iu.test(value)) {
    return ['pillar', 'pillar', 'statue', 'altar', 'torch', 'rune', 'chest', 'stairs']
  }
  if (/косм|станци|тех|кибер|металл|metal/iu.test(value)) {
    return ['console', 'console', 'crate', 'pillar', 'rune', 'stairs', 'chest', 'torch']
  }
  if (/дорог|тракт|мост|bridge/iu.test(value)) {
    return ['wagon', 'campfire', 'rock', 'bush', 'crate', 'chest', 'stairs']
  }
  if (/пустын|пес|sand/iu.test(value)) return ['rock', 'rock', 'campfire', 'bones', 'rune', 'chest', 'stairs']
  if (/руин|развал|keep|ruins/iu.test(value)) return ['pillar', 'statue', 'rock', 'bones', 'torch', 'rune', 'chest', 'stairs']
  return ['rock', 'torch', 'rune', 'chest', 'stairs', 'crate']
}

function featureCellScore(feature, cell, byPosition, centerX, centerY, placed, random) {
  const adjacentWalls = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .filter(([dx, dy]) => !walkable(byPosition.get(key(cell.x + dx, cell.y + dy)))).length
  const centerDistance = Math.abs(cell.x - centerX) + Math.abs(cell.y - centerY)
  const table = placed.find((entry) => entry.feature === 'table')
  const tableDistance = table ? Math.abs(cell.x - table.x) + Math.abs(cell.y - table.y) : 99
  let score = random() * 2
  if (['bed', 'bookshelf', 'fireplace', 'barrel', 'crate', 'grave', 'tree', 'bush', 'rock', 'pillar', 'console'].includes(feature)) score += adjacentWalls * 4 + centerDistance * .15
  if (feature === 'table' || feature === 'altar' || feature === 'statue' || feature === 'well') score += Math.max(0, 8 - centerDistance) * 1.2
  if (feature === 'chair') score += tableDistance <= 1 ? 14 : tableDistance === 2 ? 7 : -tableDistance
  if (feature === 'stairs' || feature === 'chest' || feature === 'rune') score += cell.x * .6
  if (feature === 'campfire') score += Math.max(0, 6 - centerDistance)
  if (['tree', 'bush'].includes(feature)) score += cell.material === 'grass' ? 8 : -5
  if (feature === 'rock') score += cell.material === 'earth' ? 3 : 0
  return score
}

const PATTERNS = new Set(['small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural'])
const MATERIALS = new Set(['stone', 'wood', 'earth', 'grass', 'sand', 'metal', 'marble', 'ice'])

function visualMaterial(theme, layout, requested) {
  if (MATERIALS.has(requested)) return requested
  const value = `${theme} ${layout}`.toLocaleLowerCase('ru')
  if (/косм|станци|тех|кибер|металл|лаборатор/u.test(value)) return 'metal'
  if (/лед|снег|мороз|аркти/u.test(value)) return 'ice'
  if (/пустын|пес|дюн/u.test(value)) return 'sand'
  if (/лес|роща|луг|сад|болот/u.test(value)) return 'grass'
  if (/таверн|дом|кают|деревян/u.test(value)) return 'wood'
  if (/дворец|храм|мрамор/u.test(value)) return 'marble'
  if (/пещ|шахт|земл|пустош/u.test(value)) return 'earth'
  return 'stone'
}

function scaleSize(scale) {
  if (scale === 'room') return { width: 9, height: 7 }
  if (scale === 'stronghold') return { width: 23, height: 17 }
  if (scale === 'region') return { width: 25, height: 19 }
  return { width: 15, height: 11 }
}

const key = (x, y) => `${x},${y}`
const walkable = (cell) => cell?.type === 'floor' || cell?.type === 'door'

function footprintFor(layout, pattern, x, y, width, height, random) {
  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  const nx = Math.abs((x - cx) / Math.max(1, cx))
  const ny = Math.abs((y - cy) / Math.max(1, cy))
  if (pattern === 'bridge') {
    const roadY = Math.round(cy + Math.sin((x / Math.max(1, width - 1)) * Math.PI * 2) * Math.max(1, height * .08))
    return Math.abs(y - roadY) <= 2 || (x <= cx && y === Math.floor(cy))
  }
  if (pattern === 'cave-cluster') layout = 'cavern'
  if (layout === 'cavern') {
    const wobble = 0.06 + random() * 0.18
    return nx ** 2 + ny ** 2 <= 1.05 - wobble || (y === Math.floor(cy) && x <= cx)
  }
  if (layout === 'radial') return nx ** 2 + ny ** 2 <= 1.02 || (y === Math.floor(cy) && x <= cx)
  if (layout === 'ruins') {
    const cutCorner = (nx > .82 && ny > .62) || (ny > .84 && nx > .68)
    const brokenEdge = (x === 0 || x === width - 1 || y === 0 || y === height - 1) && random() < .55
    return !cutCorner && !brokenEdge
  }
  if (layout === 'winding' || layout === 'open') {
    return nx ** 2 + ny ** 2 <= 1.1 - random() * .12 || (y === Math.floor(cy) && x <= cx)
  }
  return true
}

function connectedWalkable(cells, entrance) {
  const byPosition = new Map(cells.map((cell) => [key(cell.x, cell.y), cell]))
  const start = byPosition.get(key(entrance.x, entrance.y))
  const reached = new Set()
  if (!walkable(start)) return reached
  const queue = [start]
  reached.add(key(start.x, start.y))
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    for (const [x, y] of [[current.x + 1, current.y], [current.x - 1, current.y], [current.x, current.y + 1], [current.x, current.y - 1]]) {
      const position = key(x, y)
      const next = byPosition.get(position)
      if (!walkable(next) || reached.has(position)) continue
      reached.add(position)
      queue.push(next)
    }
  }
  return reached
}

/** Generates a deterministic, connected tactical map from a bounded
 * cartographer specification. Organic layouts omit cells outside their
 * footprint, so the board can be cavernous, circular or broken rather than
 * always presenting a rectangular slab. */
export function generateDynamicSceneMap({ seed, theme = '', danger = 'средняя', width, height, scale, layout = 'rooms', pattern = 'natural', material, openness = 0.6, water = 0.04, featureCount } = {}) {
  const scaleDefault = scale ? scaleSize(scale) : { width: 13, height: 9 }
  width = clampInteger(width, scaleDefault.width, 7, 25)
  height = clampInteger(height, scaleDefault.height, 7, 19)
  while (width * height > 500) width -= 1
  pattern = PATTERNS.has(pattern) ? pattern : 'natural'
  material = visualMaterial(theme, layout, material)
  const random = randomFor(`${seed}:${theme}:${danger}:${width}:${height}:${layout}:${pattern}:${material}`)
  const centerX = Math.floor(width / 2)
  const centerY = Math.floor(height / 2)
  const openChance = Math.max(0.35, Math.min(0.85, Number(openness) || 0.6))
  const waterChance = Math.max(0, Math.min(0.3, Number(water) || 0))
  const streetXs = new Set([centerX, Math.max(2, Math.floor(width / 3)), Math.min(width - 3, Math.floor(width * 2 / 3))])
  const streetYs = new Set([centerY, Math.max(2, Math.floor(height / 3)), Math.min(height - 3, Math.floor(height * 2 / 3))])
  const cells = []

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!footprintFor(layout, pattern, x, y, width, height, random)) continue
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1
      const entranceRoad = y === centerY && x <= centerX
      const centralSpine = y === centerY || x === centerX
      const trailY = centerY + Math.round(Math.sin((x / Math.max(1, width - 1)) * Math.PI * 2) * Math.max(1, Math.floor(height * .1)))
      const scenicTrail = material === 'grass' && y === trailY
      const streets = streetXs.has(x) || streetYs.has(y)
      const chamber = (x >= 2 && x <= Math.max(3, centerX - 2) && y >= 2 && y <= height - 3)
        || (x <= width - 3 && x >= Math.min(width - 4, centerX + 2) && y >= 2 && y <= height - 3)
      const distance = Math.max(Math.abs(x - centerX), Math.abs(y - centerY))
      let passable = false
      if (!border || entranceRoad) {
        if (pattern === 'small-room') passable = !border
        else if (pattern === 'great-hall') passable = !border && !((x % 4 === 0) && (y % 4 === 0) && x > 1 && y > 1)
        else if (pattern === 'courtyard') passable = !border && (x > 1 && y > 1 && x < width - 2 && y < height - 2 || centralSpine)
        else if (pattern === 'keep') passable = centralSpine || chamber || (x > 1 && y > 1 && x < width - 2 && y < height - 2 && random() < openChance * .32)
        else if (pattern === 'crypt') passable = centralSpine || (x % 4 !== 0 && y % 3 !== 0 && random() < openChance * .7)
        else if (pattern === 'bridge') passable = true
        else if (layout === 'streets' || pattern === 'village') passable = streets || random() < openChance * 0.42
        else if (layout === 'open') passable = entranceRoad || random() < openChance
        else if (layout === 'winding') passable = entranceRoad || scenicTrail || centralSpine || (Math.abs(y - centerY) <= 2 && random() < openChance) || random() < openChance * 0.28
        else if (layout === 'cavern') passable = entranceRoad || centralSpine || random() < openChance * .88
        else if (layout === 'radial') passable = entranceRoad || centralSpine || distance === Math.max(2, Math.floor(Math.min(width, height) / 3)) || random() < openChance * .22
        else if (layout === 'ruins') passable = entranceRoad || centralSpine || chamber || ((x + y) % 3 !== 0 && random() < openChance * .58)
        else passable = centralSpine || chamber || random() < openChance * 0.48
      }
      let type = passable ? 'floor' : 'wall'
      if (passable && !centralSpine && random() < waterChance) type = 'water'
      if ((layout === 'streets' || layout === 'ruins') && type === 'wall' && !border && (streetXs.has(x - 1) || streetXs.has(x + 1) || streetYs.has(y - 1) || streetYs.has(y + 1)) && random() < 0.14) type = 'door'
      const cellMaterial = material === 'grass' && type === 'floor' && (scenicTrail || entranceRoad) ? 'earth' : material
      cells.push({ x, y, type, revealed: passable && x <= 2, material: cellMaterial, variant: Math.floor(random() * 6), pattern })
    }
  }

  const byPosition = new Map(cells.map((cell) => [key(cell.x, cell.y), cell]))
  const ensureFloor = (x, y) => {
    let cell = byPosition.get(key(x, y))
    if (!cell) {
      cell = { x, y, type: 'floor', revealed: x <= 2, material: material === 'grass' ? 'earth' : material, variant: Math.floor(random() * 6), pattern }
      cells.push(cell)
      byPosition.set(key(x, y), cell)
    }
    cell.type = 'floor'
    cell.revealed = x <= 2
    if (material === 'grass') cell.material = 'earth'
  }
  for (let x = 1; x <= centerX; x += 1) ensureFloor(x, centerY)
  ensureFloor(centerX, centerY)

  // Remove unreachable floor/door islands. Water and walls may remain as
  // scenery, but every cell on which an actor can stand is reachable.
  const entrance = { x: 1, y: centerY }
  const reached = connectedWalkable(cells, entrance)
  for (const cell of cells) {
    if (walkable(cell) && !reached.has(key(cell.x, cell.y))) {
      cell.type = 'wall'
      cell.revealed = false
    }
  }

  const candidates = cells.filter((cell) => cell.type === 'floor' && reached.has(key(cell.x, cell.y)) && !(cell.x <= 2 && cell.y === centerY))
  const features = featuresFor(theme, layout, pattern, material)
  const count = clampInteger(featureCount, danger === 'высокая' ? 8 : danger === 'низкая' ? 4 : 6, 2, 12)
  const placed = []
  for (let index = 0; index < count && candidates.length; index += 1) {
    const feature = features[index % features.length]
    let chosenIndex = 0
    let chosenScore = Number.NEGATIVE_INFINITY
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const score = featureCellScore(feature, candidates[candidateIndex], byPosition, centerX, centerY, placed, random)
      if (score > chosenScore) {
        chosenIndex = candidateIndex
        chosenScore = score
      }
    }
    const chosen = candidates.splice(chosenIndex, 1)[0]
    chosen.feature = feature
    placed.push(chosen)
  }
  // Every tactical scene keeps one explicit exit/continuation marker. Semantic
  // props still fill the map, while small feature budgets remain traversable by
  // the scene director and compatible with existing campaign maps.
  if (placed.length && !placed.some((cell) => cell.feature === 'stairs')) placed[placed.length - 1].feature = 'stairs'
  const finalByPosition = new Map(cells.map((cell) => [key(cell.x, cell.y), cell]))
  for (const cell of cells) {
    const edges = []
    for (const [label, x, y] of [['n', cell.x, cell.y - 1], ['e', cell.x + 1, cell.y], ['s', cell.x, cell.y + 1], ['w', cell.x - 1, cell.y]]) {
      const neighbor = finalByPosition.get(key(x, y))
      if (!neighbor || (walkable(cell) && !walkable(neighbor))) edges.push(label)
    }
    cell.edge_mask = edges.join('')
  }
  return cells.sort((left, right) => left.y - right.y || left.x - right.x)
}
