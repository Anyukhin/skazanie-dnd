import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// Толчок даёт выбор: сбить с ног или оттолкнуть на 5 футов — так и в 2014, и в
// 2024. До 2026-10-04 был только первый исход (исследование PR #136).

const WIDTH = 12
function fixture({ ruleset = '2014', enemyX = 2, enemy = {}, walls = [], extraEnemies = [], allies = [] } = {}) {
  return normalizeCampaignState({
    sessionCode: 'SHOVE-PUSH',
    ...(ruleset === '2014' ? { ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'] } : {}),
    partyMemberIds: ['hero', ...allies.map((ally) => ally.id)],
    players: [
      { id: 'hero', character: 'Боец', characterClass: 'fighter', level: 5, hp: 40, maxHp: 40, armor: 16, speed: 30, proficiency: 3,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x: 1, y: 1 },
      ...allies,
    ],
    enemies: [
      { id: 'enemy', name: 'Противник', hp: 30, maxHp: 30, armor: 12, speed: 30,
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, x: enemyX, y: 1, alive: true, ...enemy },
      ...extraEnemies,
    ],
    scene: { turn: 1, cells: Array.from({ length: WIDTH * 3 }, (_, i) => ({
      x: i % WIDTH, y: Math.floor(i / WIDTH), type: walls.some((wall) => wall.x === i % WIDTH && wall.y === Math.floor(i / WIDTH)) ? 'wall' : 'floor', revealed: true,
    })) },
    mechanics: { combat: { active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'enemy', total: 10 }, ...extraEnemies.map((other) => ({ actor_id: other.id, total: 5 }))],
      action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } },
  })
}

function shove(state, shoveMode, values = [18, 2]) {
  let id = 0
  return resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'shove', target_id: 'enemy',
    ...(shoveMode ? { shove_mode: shoveMode } : {}), server_authoritative: true,
  }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `shove-roll-${++id}` }),
    context: { serverAuthoritativeCombat: true },
  })
}

const after = (state, result) => result.events.reduce(applyGameEvent, state)
const enemyAt = (state) => state.mechanics.positions?.enemy ?? { x: state.enemies[0].x, y: state.enemies[0].y }

for (const ruleset of ['2014', '2024']) {
  test(`${ruleset}: успешный толчок «оттолкнуть» сдвигает цель на 5 футов и не сбивает с ног`, () => {
    const state = fixture({ ruleset })
    const result = shove(state, 'push')
    const moved = result.events.find((event) => event.event_type === 'ActorMoved')
    assert.ok(moved, 'цель сдвинута')
    assert.equal(moved.payload.forced_movement, true)
    assert.equal(moved.payload.action_id, 'shove')
    assert.deepEqual(moved.payload.to, { x: 3, y: 1 })
    assert.equal(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'prone'), false)
    const next = after(state, result)
    assert.deepEqual(enemyAt(next), { x: 3, y: 1 })
    assert.equal(next.mechanics.combat.action_economy.hero.action, false, 'толчок стоит действия')
    assert.deepEqual(replayEvents(state, result.events).mechanics.positions, next.mechanics.positions)
  })
}

test('без выбора толчок по-прежнему сбивает с ног', () => {
  const state = fixture()
  const result = shove(state)
  assert.ok(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'prone'))
  assert.equal(result.events.some((event) => event.event_type === 'ActorMoved'), false)
})

test('проигранное состязание цель не сдвигает', () => {
  const state = fixture()
  const result = shove(state, 'push', [2, 18])
  assert.equal(result.events.find((event) => event.event_type === 'ContestedCheckResolved').payload.success, false)
  assert.equal(result.events.some((event) => event.event_type === 'ActorMoved'), false)
})

test('стена, другое существо и край карты останавливают цель, а действие всё равно потрачено', () => {
  for (const [label, state] of [
    ['стена', fixture({ walls: [{ x: 3, y: 1 }] })],
    ['существо', fixture({ extraEnemies: [{ id: 'other', name: 'Другой', hp: 10, maxHp: 10, armor: 10, abilities: { str: 10, dex: 10 }, x: 3, y: 1, alive: true }] })],
  ]) {
    const result = shove(state, 'push')
    assert.equal(result.events.find((event) => event.event_type === 'ContestedCheckResolved').payload.success, true, label)
    assert.equal(result.events.some((event) => event.event_type === 'ActorMoved'), false, label)
    assert.deepEqual(enemyAt(after(state, result)), { x: 2, y: 1 }, label)
    assert.equal(after(state, result).mechanics.combat.action_economy.hero.action, false, label)
  }
  const edge = fixture({ enemyX: WIDTH - 1 })
  edge.players[0].x = WIDTH - 2
  edge.mechanics.positions = { ...(edge.mechanics.positions ?? {}), hero: { x: WIDTH - 2, y: 1 } }
  const atEdge = shove(edge, 'push')
  assert.equal(atEdge.events.some((event) => event.event_type === 'ActorMoved'), false, 'за край карты не выталкивает')
})

test('вынужденное перемещение не провоцирует атак по возможности', () => {
  const ally = { id: 'ally', character: 'Союзник', hp: 20, maxHp: 20, armor: 14, abilities: { str: 14, dex: 12 }, inventory: [], x: 1, y: 2 }
  const state = fixture({ allies: [ally] })
  const result = shove(state, 'push')
  assert.ok(result.events.some((event) => event.event_type === 'ActorMoved'))
  assert.equal(result.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
})

test('цель больше чем на один размер крупнее толкнуть нельзя, и действие не тратится', () => {
  for (const size of ['huge', 'gargantuan']) {
    const state = fixture({ enemy: { size } })
    assert.throws(() => shove(state, 'push'), (error) => error.code === 'SHOVE_TARGET_TOO_LARGE', size)
    assert.throws(() => shove(state), (error) => error.code === 'SHOVE_TARGET_TOO_LARGE', size)
    assert.equal(state.mechanics.combat.action_economy.hero.action, true)
  }
  assert.ok(shove(fixture({ enemy: { size: 'large' } }), 'push').events.some((event) => event.event_type === 'ActorMoved'), 'большую цель средний герой толкает')
})

test('незнакомый исход толчка отклоняется до броска', () => {
  assert.throws(() => shove(fixture(), 'throw'), (error) => error.code === 'SHOVE_MODE_UNKNOWN')
})

test('хроника называет отброшенным цель, а не того, кто толкнул', async () => {
  const { combatNarration } = await import('../server/combat-narration.mjs')
  const state = fixture()
  const result = shove(state, 'push')
  const text = combatNarration(result.events, after(state, result))
  assert.match(text, /Противник отброшен на 5 фт/u)
  assert.doesNotMatch(text, /Боец перемещается/u)
})

test('хроника идёт по порядку: сначала толчок, потом отлёт', async () => {
  const { combatNarration } = await import('../server/combat-narration.mjs')
  const state = fixture()
  const result = shove(state, 'push')
  const types = result.events.map((event) => event.event_type)
  assert.ok(types.indexOf('CombatActionUsed') < types.indexOf('ActorMoved'))
  const text = combatNarration(result.events, after(state, result))
  assert.ok(text.indexOf('использует «Толчок»') < text.indexOf('отброшен'), text)
})
