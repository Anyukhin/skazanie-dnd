// Синтетические карты для эталонов: комнаты разных размеров и форм, дворы,
// улицы, тропы, двери во всех состояниях, окна, ограды, вода и лёд, точки
// появления и уже стоящие предметы. Всё — от ГПСЧ mulberry32, карта
// собирается API `tactical-map.mjs` и хранится сериализованной.
import { listAssets } from '../../../../server/asset-registry.mjs'
import * as t from '../../../../server/tactical-map.mjs'

const INTERIOR_ZONES = ['hall', 'kitchen', 'bedroom', 'store', 'barracks', 'forge', 'cells', 'nave', 'study', 'shop', 'chapel', 'cellar', 'inn-bar', 'room']
const EXTERIOR_ZONES = ['yard', 'field', 'street', 'square', 'path', 'common', 'garden', 'courtyard', 'stable-yard']
const INTERIOR_MATERIALS = ['wood', 'stone', 'marble', 'stone', 'wood', 'metal']
const EXTERIOR_MATERIALS = ['grass', 'grass', 'earth', 'sand', 'ice', 'stone', 'grass']

export const ALL_ASSETS = listAssets().filter((asset) => asset.kind === 'prop' || asset.kind === 'decal').map((asset) => asset.id)
export const ALL_THEMES = [...new Set(listAssets().flatMap((asset) => asset.themes))]

export function picker(random) {
  const pick = (list) => list[Math.floor(random() * list.length)]
  const int = (min, max) => min + Math.floor(random() * (max - min + 1))
  const chance = (p) => random() < p
  return { pick, int, chance }
}

/**
 * Прямоугольники зон: рекурсивный разрез карты на 1–5 частей.
 * @returns {Array<{x0: number, y0: number, x1: number, y1: number}>}
 */
function splitRegions(random, width, height, parts) {
  const { int, chance } = picker(random)
  let regions = [{ x0: 0, y0: 0, x1: width - 1, y1: height - 1 }]
  for (let step = 1; step < parts; step += 1) {
    regions.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))
    const region = regions[0]
    const wide = region.x1 - region.x0 >= region.y1 - region.y0
    const span = wide ? region.x1 - region.x0 : region.y1 - region.y0
    if (span < 6) break
    const cut = int(3, span - 3)
    regions = regions.slice(1)
    if (wide) {
      regions.push({ ...region, x1: region.x0 + cut - 1 }, { ...region, x0: region.x0 + cut })
    } else {
      regions.push({ ...region, y1: region.y0 + cut - 1 }, { ...region, y0: region.y0 + cut })
    }
  }
  return regions
}

/**
 * Синтетическая карта.
 * @param {number} index
 * @param {() => number} random
 */
export function syntheticMap(index, random) {
  const { pick, int, chance } = picker(random)
  const width = int(5, chance(0.15) ? 46 : 28)
  const height = int(5, chance(0.15) ? 40 : 24)
  const map = t.createTacticalMap({ width, height, seed: `syn-${index}`, theme: pick(['building', 'forest', 'settlement', 'cave', 'crypt', 'temple', '']) })
  const regions = splitRegions(random, width, height, int(1, 5))
  const used = new Set()
  const zoneOf = regions.map((region) => {
    const interior = chance(0.55)
    let id = pick(interior ? INTERIOR_ZONES : EXTERIOR_ZONES)
    while (used.has(id)) id = `${id}-${used.size}`
    used.add(id)
    const material = pick(interior ? INTERIOR_MATERIALS : EXTERIOR_MATERIALS)
    t.addZone(map, { id, kind: interior ? 'interior' : 'exterior', material, label: id })
    return { id, interior, material, region }
  })
  // Иногда клетки без зоны: проём графа или старая дверь.
  const zoneless = chance(0.2)
  const solidBorder = chance(0.5)
  for (const { id, interior, material, region } of zoneOf) {
    for (let y = region.y0; y <= region.y1; y += 1) {
      for (let x = region.x0; x <= region.x1; x += 1) {
        const border = x === 0 || y === 0 || x === width - 1 || y === height - 1
        let passable = !(solidBorder && border)
        // Срезанный угол — комната буквой Г; редкие непроходимые клетки.
        if (interior && chance(0.02)) passable = false
        if (!interior && chance(0.03)) passable = false
        let cellMaterial = material
        if (!interior && chance(0.12)) cellMaterial = pick(EXTERIOR_MATERIALS)
        const surface = !interior && chance(0.04) ? pick(['water', 'mud', 'ice', 'rubble']) : (cellMaterial === 'ice' && chance(0.5) ? 'ice' : 'none')
        t.setCell(map, x, y, {
          passable,
          material: cellMaterial,
          surface,
          zone: zoneless && chance(0.05) ? '' : id,
          revealed: true,
          variant: (x * 7 + y * 3) % 4,
          ...(chance(0.03) ? { moveCost: 2 } : {}),
        })
      }
    }
    if (chance(0.3)) {
      // Г-образная комната: угол региона непроходим.
      const cw = int(1, Math.max(1, Math.floor((region.x1 - region.x0) / 2)))
      const ch = int(1, Math.max(1, Math.floor((region.y1 - region.y0) / 2)))
      for (let y = region.y0; y < region.y0 + ch; y += 1) for (let x = region.x1 - cw + 1; x <= region.x1; x += 1) t.setCell(map, x, y, { passable: false })
    }
  }
  // Стены на рёбрах вокруг непроходимых клеток и между зонами с проёмами.
  let doorIndex = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const own = t.cellAt(map, x, y)
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const other = t.cellAt(map, x + dx, y + dy)
        if (!own || !other) continue
        if (own.passable !== other.passable) {
          if (chance(0.7)) t.setEdge(map, x, y, x + dx, y + dy, { kind: 'wall', cover: 'three_quarters' })
          continue
        }
        if (!own.passable) continue
        if (own.zone !== other.zone) {
          const roll = random()
          if (roll < 0.55) t.setEdge(map, x, y, x + dx, y + dy, { kind: 'wall', cover: 'three_quarters' })
          else if (roll < 0.62) t.setEdge(map, x, y, x + dx, y + dy, { kind: 'window', blocksMove: true, blocksSight: false, cover: 'half' })
          else if (roll < 0.66) t.setEdge(map, x, y, x + dx, y + dy, { kind: 'rail', cover: 'half' })
          else if (roll < 0.72) {
            doorIndex += 1
            t.setDoor(map, { id: `door-${doorIndex}`, x, y, dir: dx ? 'e' : 's', state: pick(['open', 'closed', 'locked', 'broken']), lockDc: int(0, 20) })
          }
        } else if (chance(0.015)) {
          t.setEdge(map, x, y, x + dx, y + dy, { kind: pick(['wall', 'window', 'rail', 'ledge']) })
        }
      }
    }
  }
  // Окна у внешних стен помещений.
  for (const { region, interior } of zoneOf) {
    if (!interior) continue
    for (let x = region.x0 + 1; x < region.x1; x += 1) {
      if (chance(0.15) && region.y0 > 0) t.setEdge(map, x, region.y0, x, region.y0 - 1, { kind: 'window', blocksMove: true, blocksSight: false })
    }
  }
  // Точки появления.
  const passable = []
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (t.cellAt(map, x, y)?.passable) passable.push({ x, y })
  if (passable.length && chance(0.8)) {
    const spawn = pick(passable)
    t.addSpawnPoint(map, { id: 'party', x: spawn.x, y: spawn.y, role: 'party' })
  }
  if (passable.length && chance(0.4)) {
    const spawn = pick(passable)
    t.addSpawnPoint(map, { id: 'enemy', x: spawn.x, y: spawn.y, role: 'enemy' })
  }
  // Уже стоящие предметы: мебель, опоры, утварь, настенное.
  const existing = chance(0.5) ? int(1, 12) : 0
  for (let number = 0; number < existing && passable.length; number += 1) {
    const cell = pick(passable)
    const assetId = pick(chance(0.5) ? ['table_round', 'table_long', 'writing_desk', 'altar', 'mug', 'candle', 'book_piles', 'torch_wall', 'banner', 'crate', 'barrel', 'bed', 'pillar', 'tree_oak', 'boulder', 'chair'] : ALL_ASSETS)
    const asset = listAssets().find((entry) => entry.id === assetId)
    const footprint = asset?.baseFootprint?.w ? [{ x: cell.x, y: cell.y }, ...(asset.baseFootprint.w > 1 && cell.x + 1 < width ? [{ x: cell.x + 1, y: cell.y }] : [])] : []
    t.addProp(map, {
      id: `old-${number}`,
      assetId,
      x: cell.x + (chance(0.8) ? 0.5 : random()),
      y: cell.y + 0.5,
      rotation: pick([0, 90, 180, 270, 45]),
      scale: chance(0.7) ? 1 : 0.5 + random(),
      footprint,
      blocksMove: asset?.blocksMove ?? false,
      blocksSight: asset?.blocksSight ?? false,
      cover: asset?.cover ?? 'none',
      interactive: chance(0.1),
      ...(chance(0.1) ? { state: pick(['broken', 'toppled', 'burned', 'open']) } : {}),
    })
  }
  return map
}
