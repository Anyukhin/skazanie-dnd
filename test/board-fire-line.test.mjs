import assert from 'node:assert/strict'
import test from 'node:test'
import { createTacticalMap, serializeTacticalMap, setCell, setEdge } from '../server/tactical-map.mjs'
import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [board] } = await compileClientModules(['src/dungeon-map-parts.tsx'], { args: ['src/phb-rules.d.ts'] })
const attacker = { id: 'archer', x: 0, y: 0 }
const target = { id: 'foe', x: 3, y: 0 }
const bow = { item_id: 'bow', in_range: false, unreachable_reason: 'линия удара перекрыта' }

function scenario(hiddenX = -1, wall = true) {
  const map = createTacticalMap({ width: 4, height: 1, seed: 'weapon-fire-line' })
  const cells = Array.from({ length: 4 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: x !== hiddenX }))
  for (const { x, revealed } of cells) setCell(map, x, 0, { passable: true, revealed })
  if (wall) setEdge(map, 1, 0, 2, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
  return {
    scene: { cells, map: serializeTacticalMap(map) },
    combatForecast: { actor_id: attacker.id, targets: { [target.id]: [bow] } },
  }
}

test('точка обрыва видимой линии совпадает со стеной и прогнозом выбранного оружия', () => {
  const state = scenario()
  const line = board.visibleWeaponFireLine(state, attacker, target, 'bow')
  assert.deepEqual(line.start, { x: 0, y: 0 })
  assert.deepEqual([line.obstruction.x, line.obstruction.y], [2, 0])
  assert.equal(board.visibleWeaponFireLine(state, attacker, target, 'crossbow'), null)
  assert.equal(board.visibleWeaponFireLine({ ...state, combatForecast: undefined }, attacker, target, 'bow'), null)
  state.combatForecast.targets.foe = [{ ...bow, in_range: true, unreachable_reason: null }]
  assert.equal(board.visibleWeaponFireLine(state, attacker, target, 'bow'), null, 'расходящийся прогноз не рисует преграду')
})

test('линия и блокирующая клетка скрыты, пока путь или цель закрыты туманом', () => {
  for (const unseen of [1, 2, 3]) assert.equal(board.visibleWeaponFireLine(scenario(unseen), attacker, target, 'bow'), null)
  const open = scenario(-1, false)
  open.combatForecast.targets.foe = [{ ...bow, in_range: true, unreachable_reason: null }]
  assert.equal(board.visibleWeaponFireLine(open, attacker, target, 'bow').obstruction, null)
})
