import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { hasClearTrajectory, normalizeCampaignState, replayEvents, resolveCommand, spellTargetsAt } from '../server/rules-engine.mjs'
import { isTransparentCell, isTransparentMapCell, sightEdgeBlocked } from '../server/rules/tactical-geometry.mjs'
import { createTacticalMap, serializeTacticalMap, setCell, setDoor, setEdge } from '../server/tactical-map.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

// Линия действия и линия обзора по D&D 5e 2014: заслоняет только сплошное
// препятствие (стена, закрытая дверь, тонкая стена на ребре). Вода и прочая
// непроходимая, но открытая местность взгляда и заклинания не останавливают.

function dice(values = Array.from({ length: 40 }, () => 4)) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `loe-roll-${++id}`, now: () => '2026-10-01T12:00:00.000Z' })
}

const options = (diceService = dice()) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function openMap(width = 12, height = 5) {
  return createTacticalMap({ width, height, locationId: 'loe-field', fill: { passable: true, revealed: true, material: 'stone' } })
}

/** Маг в (1,1), громила в (9,1); карта задаётся слоями, клетки выводит нормализация. */
function field(map, { enemies = [{ id: 'brute', x: 9, y: 1 }], mage = { x: 1, y: 1 } } = {}) {
  return normalizeCampaignState({
    sessionCode: 'LOE-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: 'wizard', level: 9, hp: 40, maxHp: 40, armor: 13, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 18, cha: 12 }, inventory: [], ...mage }],
    enemies: enemies.map((enemy) => ({ name: enemy.id, creature_type: 'humanoid', hp: 200, maxHp: 200, armor: 13, speed: 30, abilities: { str: 16, dex: 1, con: 14, int: 8, wis: 8, cha: 8 }, alive: true, ...enemy })),
    scene: { turn: 1, map: serializeTacticalMap(map) },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, ...enemies.map((enemy) => ({ actor_id: enemy.id, total: 5 }))],
        action_economy: Object.fromEntries([['mage'], ...enemies.map((enemy) => [enemy.id])]
          .map(([id]) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
      },
    },
  })
}

const castCommand = (spellId, to) => ({ command_type: 'CastSpell', command_id: `loe:${spellId}`, actor_id: 'mage', spell_id: spellId, to, server_authoritative: true })
const damagedIds = (result) => result.events.filter((event) => event.event_type === 'DamageApplied').flatMap((event) => event.target_ids)

// --- п. 1: линия и стена из wallCells останавливаются на рёбрах ---------------
// Луч Молнии длиной 100 футов задаётся направлением: игрок целится в клетку
// перед препятствием (3,1), а луч летит дальше неё. Точку за дверью сервер и
// так не примет — её отсекает проверка траектории до точки прицела.

test('Молния обрывается на закрытой двери: ближний задет, дальний за дверью — нет', () => {
  const map = openMap()
  // Дверь закрыта и не помечена blocksSight: закрытую дверь узнают по ребру,
  // как это делает клиентский прицел.
  setDoor(map, { id: 'door-5-1', x: 5, y: 1, dir: 'e', state: 'closed', blocksMove: true, blocksSight: false })
  const state = field(map, { enemies: [{ id: 'near', x: 4, y: 1 }, { id: 'brute', x: 9, y: 1 }] })
  const result = resolveCommand(castCommand('lightning-bolt', { x: 3, y: 1 }), state, options())
  assert.deepEqual(damagedIds(result), ['near'])
})

test('Молния проходит открытую дверь и бьёт цель за ней', () => {
  const map = openMap()
  setDoor(map, { id: 'door-5-1', x: 5, y: 1, dir: 'e', state: 'open', blocksMove: false, blocksSight: false })
  const state = field(map, { enemies: [{ id: 'near', x: 4, y: 1 }, { id: 'brute', x: 9, y: 1 }] })
  const result = resolveCommand(castCommand('lightning-bolt', { x: 3, y: 1 }), state, options())
  assert.deepEqual(damagedIds(result).sort(), ['brute', 'near'])
})

test('Молния не проходит сквозь тонкую стену на ребре клетки', () => {
  const map = openMap()
  setEdge(map, 5, 1, 6, 1, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
  const state = field(map)
  assert.deepEqual(spellTargetsAt(state, castCommand('lightning-bolt', { x: 3, y: 1 }), canonicalCombatSpellFor('lightning-bolt')), [])
  const result = resolveCommand(castCommand('lightning-bolt', { x: 3, y: 1 }), state, options())
  assert.deepEqual(damagedIds(result), [])
})

test('Стена огня не переходит через тонкую стену в соседнее помещение', () => {
  const map = openMap()
  // Горизонтальная перегородка между рядами 1 и 2 в столбце стены.
  setEdge(map, 5, 1, 5, 2, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
  const state = field(map, { mage: { x: 1, y: 2 } })
  const result = resolveCommand(castCommand('wall-of-fire', { x: 5, y: 2 }), state, options())
  const effect = result.events.find((event) => event.event_type === 'SpellAreaCreated')?.payload.effect
  assert.ok(effect, 'стена обязана создать область')
  assert.deepEqual(effect.cells, [{ x: 5, y: 2 }, { x: 5, y: 3 }, { x: 5, y: 4 }])

  // Без перегородки стена занимает весь столбец карты: ограничение дала кромка, а не длина.
  const free = resolveCommand(castCommand('wall-of-fire', { x: 5, y: 2 }), field(openMap(), { mage: { x: 1, y: 2 } }), options())
  assert.deepEqual(free.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect.cells.map(({ y }) => y), [0, 1, 2, 3, 4])
})

// --- п. 2: вода прозрачна во всех серверных путях -----------------------------

test('правило прозрачности клетки одно: стена и край карты заслоняют, вода и пол — нет', () => {
  assert.equal(isTransparentCell({ type: 'floor' }), true)
  assert.equal(isTransparentCell({ type: 'door' }), true)
  assert.equal(isTransparentCell({ type: 'water' }), true)
  assert.equal(isTransparentCell({ type: 'wall' }), false)
  assert.equal(isTransparentCell(undefined), false)
  assert.equal(isTransparentMapCell({ passable: true, surface: 'none' }), true)
  assert.equal(isTransparentMapCell({ passable: false, surface: 'water' }), true)
  assert.equal(isTransparentMapCell({ passable: false, surface: 'none' }), false)
  assert.equal(isTransparentMapCell(null), false)
  const map = openMap()
  setDoor(map, { id: 'door', x: 2, y: 2, dir: 'e', state: 'closed', blocksMove: true, blocksSight: false })
  assert.equal(sightEdgeBlocked(map, { x: 2, y: 2 }, { x: 3, y: 2 }), true, 'закрытая дверь')
  assert.equal(sightEdgeBlocked(map, { x: 2, y: 1 }, { x: 3, y: 2 }), false, 'диагональ мимо двери')
  assert.equal(sightEdgeBlocked(map, { x: 2, y: 2 }, { x: 3, y: 3 }), true, 'диагональ задевает кромку двери')
  assert.equal(sightEdgeBlocked(null, { x: 2, y: 2 }, { x: 3, y: 2 }), false, 'без карты рёбер нет')
})

test('Молния летит над водой и бьёт цель на том берегу', () => {
  const map = openMap()
  setCell(map, 5, 1, { passable: false, surface: 'water' })
  const state = field(map)
  assert.equal(state.scene.cells.find((cell) => cell.x === 5 && cell.y === 1).type, 'water')
  const result = resolveCommand(castCommand('lightning-bolt', { x: 3, y: 1 }), state, options())
  assert.deepEqual(damagedIds(result), ['brute'])
})

test('Молния по-прежнему обрывается на клетке-стене', () => {
  const map = openMap()
  setCell(map, 5, 1, { passable: false, surface: 'none' })
  const state = field(map)
  assert.equal(state.scene.cells.find((cell) => cell.x === 5 && cell.y === 1).type, 'wall')
  const result = resolveCommand(castCommand('lightning-bolt', { x: 3, y: 1 }), state, options())
  assert.deepEqual(damagedIds(result), [])
})

function fireballField(blocker) {
  const map = createTacticalMap({ width: 22, height: 22, locationId: 'loe-river', fill: { passable: true, revealed: true, material: 'stone' } })
  for (let y = 0; y < 22; y += 1) setCell(map, 12, y, blocker)
  return normalizeCampaignState({
    sessionCode: 'LOE-RIVER', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Лира', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12,
      speed: 30, abilities: { int: 18, wis: 10, dex: 12, con: 12 }, proficiency: 3, x: 1, y: 10,
      knownSpellIds: ['fireball'], preparedSpellIds: ['fireball'], inventory: [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'pouch' })] }],
    enemies: [{ id: 'shore', name: 'На том берегу', hp: 20, maxHp: 20, x: 13, y: 10, alive: true }],
    scene: { map: serializeTacticalMap(map) },
    mechanics: { resources: { mage: { spell_slots_3: { current: 2, max: 2 } } },
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'mage', total: 20 }],
        action_economy: { mage: { action: true, bonus_action: true, reaction: true } } } },
  })
}

test('все пути области и атаки согласны: река не заслоняет, стена заслоняет', () => {
  const fireball = canonicalCombatSpellFor('fireball', { rulesetId: 'dnd_5e_2014' })
  const command = { command_type: 'CastSpell', command_id: 'loe-fireball', actor_id: 'mage', spell_id: 'fireball', to: { x: 10, y: 10 }, slot_level: 3, server_authoritative: true }
  const variants = {
    'circle-grid-v2, обход углов': fireball,
    'circle-grid-v2, прямая': { ...fireball, spreadsAroundCorners: false },
    'старая сетка, обход углов': { ...fireball, areaGeometryVersion: undefined },
    'старая сетка, прямая': { ...fireball, areaGeometryVersion: undefined, spreadsAroundCorners: false },
  }
  const river = fireballField({ passable: false, surface: 'water' })
  const wall = fireballField({ passable: false, surface: 'none' })
  for (const [label, spell] of Object.entries(variants)) {
    assert.deepEqual(spellTargetsAt(river, command, spell).map((actor) => actor.id), ['shore'], `${label}: вода прозрачна`)
    assert.deepEqual(spellTargetsAt(wall, command, spell), [], `${label}: стена заслоняет`)
  }
  assert.equal(hasClearTrajectory(river, { x: 10, y: 10 }, { x: 13, y: 10 }), true, 'выстрел через реку')
  assert.equal(hasClearTrajectory(wall, { x: 10, y: 10 }, { x: 13, y: 10 }), false, 'выстрел сквозь стену')
})

test('разведка шагом смотрит через воду, но не сквозь стену', () => {
  const build = (blocker) => {
    const map = createTacticalMap({ width: 16, height: 3, locationId: 'loe-scout', fill: { passable: true, revealed: false, material: 'stone' } })
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x <= 4; x += 1) setCell(map, x, y, { revealed: true })
      setCell(map, 6, y, blocker)
    }
    return field(map, { enemies: [{ id: 'far', x: 15, y: 0 }], mage: { x: 2, y: 1 } })
  }
  const move = { command_type: 'MoveActor', command_id: 'loe-scout', actor_id: 'mage', to: { x: 4, y: 1 }, server_authoritative: true }
  const revealedBy = (state) => resolveCommand(move, state, options()).events
    .filter((event) => event.event_type === 'AreaRevealed')
    .flatMap((event) => event.payload.cells.map(({ x, y }) => `${x},${y}`))
  const acrossWater = revealedBy(build({ passable: false, surface: 'water' }))
  assert.ok(acrossWater.includes('6,1'), 'саму воду видно')
  assert.ok(acrossWater.includes('7,1'), 'берег за водой виден')
  const behindWall = revealedBy(build({ passable: false, surface: 'none' }))
  assert.ok(behindWall.includes('6,1'), 'стену видно')
  assert.equal(behindWall.includes('7,1'), false, 'сквозь стену не смотрят')
})

// --- п. 3: путь шага в журнале боя ------------------------------------------

function detourField() {
  const map = openMap(8, 4)
  // Глухая стена в столбце 3, проход только снизу: прямой путь невозможен.
  for (const y of [0, 1, 2]) setCell(map, 3, y, { passable: false, surface: 'none' })
  // Маг в (2,1), цель шага (4,1): обход вниз ровно 6 клеток — 30 футов скорости.
  return field(map, { enemies: [{ id: 'far', x: 7, y: 0 }], mage: { x: 2, y: 1 } })
}
const detourMove = { command_type: 'MoveActor', command_id: 'loe-move', actor_id: 'mage', to: { x: 4, y: 1 }, server_authoritative: true }

test('журнал боя хранит путь шага в формате события и переживает replay', () => {
  const state = detourField()
  const result = resolveCommand(detourMove, state, options())
  const moved = result.events.find((event) => event.event_type === 'ActorMoved')
  assert.equal(moved.payload.path.length, 6, 'обход длиннее прямой в две клетки')
  assert.ok(moved.payload.path.some((cell) => cell.y === 3), 'путь огибает стену снизу')
  const after = replayEvents(state, result.events)
  const entry = after.battleLog.find((item) => item.type === 'move')
  assert.deepEqual(entry.path, moved.payload.path)
  assert.deepEqual(entry.path.at(-1), { x: 4, y: 1 }, 'конечная клетка последней')
  assert.equal(entry.path.some((cell) => cell.x === 2 && cell.y === 1), false, 'стартовая клетка не входит')
  assert.deepEqual(replayEvents(state, result.events), after, 'replay детерминирован')

  const view = campaignStateForViewer(after, { role: 'player', heroIds: ['mage'] }, 'mage')
  assert.deepEqual(view.battleLog.find((item) => item.type === 'move').path, moved.payload.path)
})

test('старое ActorMoved без маркера проигрывается в прежний журнал без пути', () => {
  const state = detourField()
  const result = resolveCommand(detourMove, state, options())
  const legacy = result.events.map((event) => {
    if (event.event_type !== 'ActorMoved') return event
    const { battle_log_path_version: _version, ...payload } = event.payload
    return { ...event, payload }
  })
  const entry = replayEvents(state, legacy).battleLog.find((item) => item.type === 'move')
  assert.ok(entry, 'запись перемещения есть')
  assert.equal(Object.hasOwn(entry, 'path'), false)
})

test('путь через туман зрителю не уходит: снимается целиком, концы остаются', () => {
  const state = detourField()
  const result = resolveCommand(detourMove, state, options())
  const after = replayEvents(state, result.events)
  const hidden = after.battleLog.find((item) => item.type === 'move').path.find((cell) => cell.y === 3)
  after.scene.cells = after.scene.cells.map((cell) => cell.x === hidden.x && cell.y === hidden.y ? { ...cell, revealed: false } : cell)
  const view = campaignStateForViewer(after, { role: 'player', heroIds: ['mage'] }, 'mage')
  const entry = view.battleLog.find((item) => item.type === 'move')
  assert.equal(Object.hasOwn(entry, 'path'), false)
  assert.deepEqual(entry.from, { x: 2, y: 1 })
  assert.deepEqual(entry.to, { x: 4, y: 1 })

  // Скрытый конец снимает и концы, и путь.
  after.scene.cells = after.scene.cells.map((cell) => cell.x === 4 && cell.y === 1 ? { ...cell, revealed: false } : cell)
  const blind = campaignStateForViewer(after, { role: 'player', heroIds: ['mage'] }, 'mage').battleLog.find((item) => item.type === 'move')
  assert.equal(Object.hasOwn(blind, 'path'), false)
  assert.equal(Object.hasOwn(blind, 'to'), false)
})
