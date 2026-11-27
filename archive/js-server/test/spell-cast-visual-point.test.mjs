import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice() {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(Array.from({ length: 40 }, () => 3)),
    idFactory: () => `spell-visual-roll-${++id}`,
    now: () => '2026-09-17T12:00:00.000Z',
  })
}

function fireballState() {
  const cells = Array.from({ length: 12 * 6 }, (_, index) => ({
    x: index % 12,
    y: Math.floor(index / 12),
    type: 'floor',
    revealed: true,
  }))
  cells.find((cell) => cell.x === 10 && cell.y === 5).revealed = false
  return normalizeCampaignState({
    sessionCode: 'SPELL-VISUAL-POINT',
    partyMemberIds: ['wizard'],
    players: [{
      id: 'wizard', character: 'Мира', role: 'Волшебник', level: 5,
      hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3,
      abilities: { int: 18, dex: 12 }, inventory: [], x: 1, y: 1,
    }],
    enemies: [
      { id: 'enemy-a', name: 'A', hp: 30, maxHp: 30, armor: 10, speed: 30, abilities: { dex: 8 }, x: 7, y: 1, alive: true },
      { id: 'enemy-b', name: 'B', hp: 30, maxHp: 30, armor: 10, speed: 30, abilities: { dex: 8 }, x: 7, y: 2, alive: true },
    ],
    scene: { title: 'Арена', location: 'Арена', location_id: 'arena', turn: 1, cells },
    mechanics: {
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'wizard', total: 20 }, { actor_id: 'enemy-a', total: 10 }, { actor_id: 'enemy-b', total: 9 }],
        active_index: 0,
        action_economy: {
          wizard: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          'enemy-a': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          'enemy-b': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

test('Fireball сохраняет выбранную пустую точку в SpellCast, replay и viewer projection', () => {
  const state = fireballState()
  const target = { x: 6, y: 1 }
  const result = resolveCommand({
    command_type: 'CastSpell', command_id: 'fireball-visual-point', actor_id: 'wizard', spell_id: 'fireball', to: target,
    server_authoritative: true,
  }, state, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const spellCast = result.events.find((event) => event.event_type === 'SpellCast')

  assert.ok(spellCast)
  assert.deepEqual(spellCast.payload.from, { x: 1, y: 1 })
  assert.deepEqual(spellCast.payload.to, target)
  assert.equal(spellCast.payload.area_shape, 'sphere')
  assert.equal(spellCast.payload.radius_feet, 20)

  const replayed = replayEvents(state, result.events)
  const directlyReduced = result.events.reduce((current, event) => applyGameEvent(current, event), state)
  assert.deepEqual(replayed, directlyReduced)
  assert.deepEqual(spellCast.payload.to, target, 'replay не должен менять сохранённое событие')

  const viewer = { role: 'player', heroIds: ['wizard'] }
  const projected = mechanicsForViewer([spellCast], viewer, 'wizard', replayed)[0]
  assert.deepEqual(projected.payload.to, target)
  const projectedSpell = campaignStateForViewer(replayed, viewer, 'wizard').battleLog.findLast((entry) => entry.type === 'spell')
  assert.equal(projectedSpell?.spellId, 'fireball')
  assert.deepEqual(projectedSpell?.from, { x: 1, y: 1 })
  assert.deepEqual(projectedSpell?.to, target)
  assert.deepEqual(projectedSpell?.area, { x: 6, y: 1, radiusFeet: 20 })
})

test('проекция не пропускает визуальную точку в тумане', () => {
  const state = fireballState()
  const visibleEvent = {
    event_type: 'SpellCast', actor_id: 'wizard', target_ids: ['enemy-a'], visibility: 'public',
    payload: { spell_id: 'fireball', to: { x: 10, y: 5 }, from: { x: 1, y: 1 } },
  }
  const projected = mechanicsForViewer([visibleEvent], { role: 'player', heroIds: ['wizard'] }, 'wizard', state)[0]
  assert.equal(projected.payload.to, undefined)
  assert.deepEqual(projected.payload.from, { x: 1, y: 1 })

  const hiddenLogState = structuredClone(state)
  hiddenLogState.battleLog = [{
    id: 'hidden-spell', type: 'spell', actorId: 'wizard', targetId: 'enemy-a',
    from: { x: 10, y: 5 }, to: { x: 10, y: 5 }, area: { x: 10, y: 5, radiusFeet: 20 }, spellId: 'fireball',
  }]
  const hiddenLog = campaignStateForViewer(hiddenLogState, { role: 'player', heroIds: ['wizard'] }, 'wizard').battleLog[0]
  assert.equal(hiddenLog.from, undefined)
  assert.equal(hiddenLog.to, undefined)
  assert.equal(hiddenLog.area, undefined)
})

test('replay и observer сохраняют признак телепорта в battleLog', () => {
  const state = fireballState()
  const result = resolveCommand({
    command_type: 'CastSpell', command_id: 'misty-step-visual', actor_id: 'wizard', spell_id: 'misty-step', to: { x: 5, y: 4 },
    server_authoritative: true,
  }, state, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  assert.ok(result.events.some((event) => event.event_type === 'ActorMoved' && event.payload.teleport === true))
  const replayed = replayEvents(state, result.events)
  const move = campaignStateForViewer(replayed, { role: 'player', heroIds: ['wizard'] }, 'wizard').battleLog.at(-1)
  assert.equal(move?.type, 'move')
  assert.equal(move?.teleport, true)
  assert.deepEqual(move?.from, { x: 1, y: 1 })
  assert.deepEqual(move?.to, { x: 5, y: 4 })
})
