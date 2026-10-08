import assert from 'node:assert/strict'
import test from 'node:test'

import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { MAP_PREVIEW_PRESETS } from '../server/map-quality.mjs'
import { cellAt, deserializeTacticalMap } from '../server/tactical-map.mjs'

/**
 * Обзор карт 2026-10-08: в храме колонны стояли сеткой во всех помещениях
 * (23–41 опора, до 42% предметов), мозаичных кругов набиралось до семи.
 * Колоннада теперь в нефе (огромные притвор и алтарная на большой карте тоже
 * получают опоры — без них там нет укрытий), мозаика — одна на помещение.
 */

const preset = MAP_PREVIEW_PRESETS.find((entry) => entry.id === 'temple')

function temple(seed) {
  const geometry = generateSceneGeometry({ ...preset.input, seed })
  return geometry.map?.layers ? geometry.map : deserializeTacticalMap(geometry.map)
}

const zoneLabelOf = (map, prop) => {
  const cell = prop.footprint[0] ?? { x: Math.floor(prop.x), y: Math.floor(prop.y) }
  const zoneId = cellAt(map, cell.x, cell.y)?.zone
  return map.zones.find((zone) => zone.id === zoneId)?.label ?? ''
}

test('колоннада храма — в нефе; вне нефа только в огромном зале, в ризнице никогда', () => {
  for (let index = 1; index <= 8; index += 1) {
    const map = temple(`temple:colonnade-${index}`)
    const sizeOf = (label) => {
      const zone = map.zones.find((entry) => entry.label === label)
      let cells = 0
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
        const cell = cellAt(map, x, y)
        if (cell?.passable && cell.zone === zone?.id) cells += 1
      }
      return cells
    }
    for (const pillar of map.props.filter((prop) => prop.id.startsWith('colonnade'))) {
      const label = zoneLabelOf(map, pillar)
      if (label === 'Неф') continue
      assert.notEqual(label, 'Ризница', `сид ${index}: колонна в ризнице`)
      // Мягкий отказ притвора и алтарной: опоры только в зале от 250 клеток.
      assert.ok(sizeOf(label) >= 250, `сид ${index}: колонна в «${label}» на ${sizeOf(label)} клетках`)
    }
  }
})

test('в каждом помещении храма не больше одной мозаики и двух хоругвей', () => {
  for (let index = 1; index <= 8; index += 1) {
    const map = temple(`temple:decor-${index}`)
    const perRoom = new Map()
    for (const prop of map.props.filter((entry) => ['mosaic', 'temple_banner'].includes(entry.assetId))) {
      const key = `${zoneLabelOf(map, prop)}:${prop.assetId}`
      perRoom.set(key, (perRoom.get(key) ?? 0) + 1)
    }
    for (const [key, count] of perRoom) {
      const limit = key.endsWith(':mosaic') ? 1 : 2
      assert.ok(count <= limit, `сид ${index}: ${key} × ${count}`)
    }
  }
})
