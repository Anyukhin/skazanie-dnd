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

function featuresFor(theme) {
  if (/город|деревн|таверн|улиц|порт/iu.test(theme)) return ['torch', 'chest', 'stairs', 'altar']
  if (/лес|болот|чащ|роща/iu.test(theme)) return ['rune', 'altar', 'chest', 'torch']
  if (/пещ|шахт|подзем|руин|храм|архив/iu.test(theme)) return ['torch', 'rune', 'stairs', 'altar', 'chest']
  return ['torch', 'rune', 'chest', 'stairs']
}

/** Generates a deterministic map from a cartographer specification. The model
 * chooses semantic parameters; this function enforces bounds and connectivity. */
export function generateDynamicSceneMap({ seed, theme = '', danger = 'средняя', width = 13, height = 9, layout = 'rooms', openness = 0.6, water = 0.04, featureCount } = {}) {
  width = clampInteger(width, 13, 7, 25)
  height = clampInteger(height, 9, 7, 19)
  while (width * height > 500) width -= 1
  const random = randomFor(`${seed}:${theme}:${danger}:${width}:${height}:${layout}`)
  const centerX = Math.floor(width / 2)
  const centerY = Math.floor(height / 2)
  const openChance = Math.max(0.35, Math.min(0.85, Number(openness) || 0.6))
  const waterChance = Math.max(0, Math.min(0.3, Number(water) || 0))
  const streetXs = new Set([centerX, Math.max(2, Math.floor(width / 3)), Math.min(width - 3, Math.floor(width * 2 / 3))])
  const streetYs = new Set([centerY, Math.max(2, Math.floor(height / 3)), Math.min(height - 3, Math.floor(height * 2 / 3))])
  const cells = []

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1
      const entranceRoad = y === centerY && x <= centerX
      const centralSpine = y === centerY || x === centerX
      const streets = streetXs.has(x) || streetYs.has(y)
      const chamber = x >= 2 && x <= Math.max(3, centerX - 2) && y >= 2 && y <= height - 3
        || x <= width - 3 && x >= Math.min(width - 4, centerX + 2) && y >= 2 && y <= height - 3
      let passable = false
      if (!border) {
        if (layout === 'streets') passable = streets || random() < openChance * 0.42
        else if (layout === 'open') passable = centralSpine || random() < openChance
        else if (layout === 'winding') passable = entranceRoad || centralSpine || (Math.abs(y - centerY) <= 2 && random() < openChance) || random() < openChance * 0.28
        else passable = centralSpine || chamber || random() < openChance * 0.48
      }
      let type = passable ? 'floor' : 'wall'
      if (passable && !centralSpine && random() < waterChance) type = 'water'
      if (layout === 'streets' && type === 'wall' && !border && (streetXs.has(x - 1) || streetXs.has(x + 1) || streetYs.has(y - 1) || streetYs.has(y + 1)) && random() < 0.12) type = 'door'
      cells.push({ x, y, type, revealed: passable && x <= 2 })
    }
  }

  const ensureFloor = (x, y) => {
    const cell = cells.find((candidate) => candidate.x === x && candidate.y === y)
    if (cell) { cell.type = 'floor'; cell.revealed = cell.x <= 2 }
  }
  for (let x = 1; x <= centerX; x += 1) ensureFloor(x, centerY)
  ensureFloor(centerX, centerY)

  const candidates = cells.filter((cell) => cell.type === 'floor' && !(cell.x <= 2 && cell.y === centerY))
  const features = featuresFor(theme)
  const count = clampInteger(featureCount, danger === 'высокая' ? 8 : danger === 'низкая' ? 4 : 6, 2, 12)
  for (let index = 0; index < count && candidates.length; index += 1) {
    const chosen = candidates.splice(Math.floor(random() * candidates.length), 1)[0]
    chosen.feature = index === 0 ? 'stairs' : features[Math.floor(random() * features.length)]
  }
  return cells
}
