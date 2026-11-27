import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'

const gridCells = (width, height) => Array.from({ length: width * height }, (_, index) => ({
  x: index % width,
  y: Math.floor(index / width),
  type: 'floor',
  revealed: true,
}))

const hero = (id, extra = {}) => ({
  id, character: id, level: 1, hp: 20, maxHp: 20, armor: 14, speed: 30,
  abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [],
  ...extra,
})

/*
 * UX-обход 2026-10-04, «Что сломано», пункт 3: пустое место героя («Место
 * героя 2», герой ещё не создан) вставало в инициативу первым, тратило ход и
 * показывало выдуманные ОЗ 10/10 и КД 10. Место без героя в бою не участвует;
 * созданный герой, который ещё повышает уровень до стартового, — участвует.
 */
test('пустое место героя не встаёт в инициативу, а созданный герой на повышении уровня — встаёт', () => {
  const initial = normalizeCampaignState({
    sessionCode: 'EMPTY-SEAT',
    partyMemberIds: ['hero', 'seat-2', 'seat-3'],
    activePlayerId: 'hero',
    players: [
      hero('hero', { x: 10, y: 10 }),
      hero('seat-2', { character: 'Место героя 2', hp: 10, maxHp: 10, armor: 10, characterSetupRequired: true, x: 11, y: 10 }),
      hero('seat-3', { characterSetupRequired: true, characterSetupStage: 'leveling', x: 10, y: 11 }),
    ],
    enemies: [],
    scene: { title: 'Поляна', location: 'Поляна', objective: 'Выжить', turn: 1, cells: gridCells(24, 24) },
    mechanics: { positions: { hero: { x: 10, y: 10 }, 'seat-2': { x: 11, y: 10 }, 'seat-3': { x: 10, y: 11 } } },
  })
  let rollId = 0
  const result = resolveCommands([
    {
      command_type: 'CreateEncounter',
      expected_state_version: initial.state_version,
      difficulty: 'easy',
      theme: 'beasts',
      seed: 'empty-seat',
      request_fingerprint: 'e'.repeat(64),
    },
    { command_type: 'StartCombat', actor_id: 'hero', server_authoritative: true },
  ], initial, {
    diceService: new DiceService({
      rng: new SequenceDiceRng([20, 18, 15, 12, 9, 6, 4, 2, 11, 8]),
      idFactory: () => `empty-seat-roll-${++rollId}`,
      now: () => '2026-10-04T12:00:00.000Z',
    }),
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
  const started = result.events.find((event) => event.event_type === 'CombatStarted')
  assert.ok(started, 'бой начался')
  const initiativeIds = started.payload.initiative.map((entry) => entry.actor_id)
  assert.ok(initiativeIds.includes('hero'))
  assert.ok(initiativeIds.includes('seat-3'), 'созданный герой на повышении уровня сражается')
  assert.equal(initiativeIds.includes('seat-2'), false, 'пустое место не бросает инициативу')
  assert.equal(started.payload.party_ids.includes('seat-2'), false)
  assert.deepEqual(replayEvents(initial, result.events), result.state)
})
