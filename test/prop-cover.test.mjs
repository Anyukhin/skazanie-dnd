import assert from 'node:assert/strict'
import test from 'node:test'

import { coverBetween } from '../server/rules/tactical-geometry.mjs'
import { addProp, createTacticalMap, legacyCellsFromTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'

/**
 * Обзор карт 2026-10-08: дубы, валуны и брёвна сгенерированного леса в бою не
 * прикрывали. Старые клетки несли в `feature` id предмета (`tree_oak`), которого
 * нет в таблице укрытий, а предмет больше клетки в них не доезжал вовсе.
 * Укрытие теперь берётся из самого предмета карты: его `cover` и `footprint`.
 */

const hero = { id: 'hero', character: 'Стрелок', hp: 20, maxHp: 20, armor: 14, speed: 30, x: 0, y: 2 }
const enemy = { id: 'enemy', name: 'Разбойник', hp: 20, maxHp: 20, armor: 12, speed: 30, alive: true, x: 8, y: 2 }

function arena(props = []) {
  const map = createTacticalMap({ width: 10, height: 5, fill: { passable: true, revealed: true, material: 'grass' } })
  for (const prop of props) addProp(map, prop)
  return normalizeCampaignState({
    sessionCode: 'PROP-COVER', players: [hero], enemies: [enemy], partyMemberIds: ['hero'],
    scene: { turn: 1, map: serializeTacticalMap(map), cells: legacyCellsFromTacticalMap(map) },
  })
}

test('дуб на линии выстрела даёт укрытие в три четверти по всем своим клеткам', () => {
  // Дуб 2×2 стоит клетками (4,1)–(5,2): линия по ряду y=2 идёт через его нижнюю половину.
  const state = arena([{ id: 'oak', assetId: 'tree_oak', x: 5, y: 2, footprint: [{ x: 4, y: 1 }, { x: 5, y: 1 }, { x: 4, y: 2 }, { x: 5, y: 2 }], blocksMove: true, cover: 'three_quarters' }])
  const cover = coverBetween(state, 'hero', 'enemy', { x: 0, y: 2 }, { x: 8, y: 2 })
  assert.equal(cover.level, 'three-quarters')
  assert.equal(cover.armorClassBonus, 5)
  assert.deepEqual(cover.scenery, ['tree_oak'])
})

test('бревно даёт половинное укрытие, а предмет без укрытия — никакого', () => {
  const log = arena([{ id: 'log', assetId: 'rotten_log', x: 4.5, y: 2.5, footprint: [{ x: 4, y: 2 }], blocksMove: true, cover: 'half' }])
  assert.equal(coverBetween(log, 'hero', 'enemy', { x: 0, y: 2 }, { x: 8, y: 2 }).level, 'half')
  const flowers = arena([{ id: 'flowers', assetId: 'flowers', x: 4.5, y: 2.5, footprint: [{ x: 4, y: 2 }], cover: 'none' }])
  assert.equal(coverBetween(flowers, 'hero', 'enemy', { x: 0, y: 2 }, { x: 8, y: 2 }).level, 'none')
  // Дуб в стороне от линии не прикрывает.
  const aside = arena([{ id: 'oak', assetId: 'tree_oak', x: 5, y: 0, footprint: [{ x: 4, y: 0 }, { x: 5, y: 0 }], blocksMove: true, cover: 'three_quarters' }])
  assert.equal(coverBetween(aside, 'hero', 'enemy', { x: 0, y: 2 }, { x: 8, y: 2 }).level, 'none')
})
