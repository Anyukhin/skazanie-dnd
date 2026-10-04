// Линия огня «существо → существо»: клиент и сервер берут одни и те же клетки.
//
// Сервер (`actorTrajectoryDetails`) соединяет площади стрелка и цели только
// через раскрытые клетки. Клиент прежде этого не учитывал и подсвечивал цель,
// по которой сервер отказывал с `TRAJECTORY_BLOCKED` (стенд 2026-10-04: герой в
// нераскрытой клетке). Колонна линию не режет ни там, ни там — она даёт
// укрытие; это тоже закреплено здесь, потому что первым подозрением была она.
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { actorTrajectoryDetails } from '../server/rules/tactical-geometry.mjs'
import { HIDDEN_LINE_OF_FIRE_REASON, revealedLineOfFireCells } from '../src/line-of-fire.mjs'

const key = (cell) => `${cell.x},${cell.y}`

function scene({ hidden = [], pillar = null, ogreAt = { x: 6, y: 2 } } = {}) {
  const hiddenKeys = new Set(hidden.map(key))
  const cells = Array.from({ length: 50 }, (_, index) => {
    const cell = { x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }
    if (hiddenKeys.has(key(cell))) cell.revealed = false
    if (pillar && key(pillar) === key(cell)) cell.feature = 'pillar'
    return cell
  })
  return normalizeCampaignState({
    sessionCode: 'LOF-1',
    players: [{ id: 'archer', character: 'Лучница', hp: 10, maxHp: 10, armor: 13, speed: 30, x: 1, y: 2, abilities: { dex: 14 } }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 30, maxHp: 30, armor: 11, speed: 40, size: 'large', footprint: { version: 1, size: 2 }, ...ogreAt, alive: true }],
    scene: { turn: 1, cells },
    mechanics: { combat: { active: false, round: 0, active_index: 0, initiative: [], action_economy: {} } },
  })
}

/** Клетки, которые сервер использовал как концы линии. */
function serverEnds(state) {
  const pairs = actorTrajectoryDetails(state, 'archer', 'ogre', state.mechanics.positions.archer, state.mechanics.positions.ogre)
  return {
    starts: [...new Set(pairs.map((pair) => key(pair.start)))].sort(),
    ends: [...new Set(pairs.map((pair) => key(pair.end)))].sort(),
    open: pairs.some((pair) => !pair.blocked),
  }
}

/** Те же концы глазами клиента. Площадь огра 2×2 от верхнего левого угла. */
function clientEnds(state) {
  const ogre = state.mechanics.positions.ogre
  const footprint = [0, 1].flatMap((dy) => [0, 1].map((dx) => ({ x: ogre.x + dx, y: ogre.y + dy })))
  const result = revealedLineOfFireCells(state.scene.cells, [state.mechanics.positions.archer], footprint)
  return { starts: result.starts.map(key).sort(), ends: result.ends.map(key).sort() }
}

test('всё раскрыто — клиент и сервер берут все клетки площадей', () => {
  const state = scene()
  const server = serverEnds(state)
  assert.deepEqual(clientEnds(state), { starts: server.starts, ends: server.ends })
  assert.equal(server.ends.length, 4)
  assert.equal(server.open, true)
})

test('стрелок в тумане — линии нет ни у сервера, ни у клиента', () => {
  const state = scene({ hidden: [{ x: 1, y: 2 }] })
  const server = serverEnds(state)
  assert.equal(server.open, false, 'сервер отказал бы TRAJECTORY_BLOCKED')
  assert.deepEqual(clientEnds(state).starts, [], 'клиент тоже не подсветит цель')
  assert.ok(HIDDEN_LINE_OF_FIRE_REASON.length > 0)
})

test('большая цель наполовину в тумане — целятся только в раскрытую половину', () => {
  const state = scene({ hidden: [{ x: 7, y: 2 }, { x: 7, y: 3 }] })
  const server = serverEnds(state)
  assert.deepEqual(clientEnds(state).ends, server.ends)
  assert.deepEqual(server.ends, ['6,2', '6,3'])
})

test('у сцены без клеток фильтра нет, как и на сервере', () => {
  const starts = [{ x: 0, y: 0 }]
  const ends = [{ x: 3, y: 0 }]
  assert.deepEqual(revealedLineOfFireCells([], starts, ends), { starts, ends })
})

test('колонна на линии огня не перекрывает её — она даёт укрытие', () => {
  const state = scene({ pillar: { x: 4, y: 2 } })
  assert.equal(serverEnds(state).open, true)
})
