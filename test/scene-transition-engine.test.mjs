import assert from 'node:assert/strict'
import test from 'node:test'

import { createSceneTransition } from '../server/adventure-director.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
  resolveCommands,
} from '../server/rules-engine.mjs'

const PRIVATE_SECRET_MARKERS = [
  'OLD-CELL-HIDDEN-SECRET',
  'OLD-CELL-SECRET',
  'ENGINE-GM-SECRET',
  'ENGINE-HIDDEN-SECRET',
  'ENGINE-NPC-PRIVATE-SECRET',
  'ENGINE-PLAYER-PRIVATE-SECRET',
  'ENGINE-PRIVATE-NOTES-SECRET',
  'ENGINE-CUSTOM-PRIVATE-SECRET',
]

const PRIVATE_ADVENTURE_FIELDS = [
  'gm_only',
  'hidden_information',
  'npc_private',
  'specific_player',
  'private_notes',
  'custom_private_memory',
]

function dice() {
  return new DiceService({
    rng: new SequenceDiceRng([]),
    idFactory: () => 'unused-roll',
    now: () => '2026-07-12T00:00:00.000Z',
  })
}

function options(context = {}) {
  return { diceService: dice(), context }
}

function baseState(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'SCENE-ENGINE',
    state_version: 0,
    engine_mode: 'enforce',
    activePlayerId: 'hero-b',
    partyMemberIds: ['hero-a', 'hero-b', 'hero-c', 'hero-d'],
    players: ['hero-a', 'hero-b', 'hero-c', 'hero-d'].map((id, index) => ({
      id,
      character: `Hero ${index + 1}`,
      hp: 10,
      maxHp: 10,
      inventory: [],
      x: 8 + index,
      y: 8,
    })),
    enemies: [{ id: 'old-wolf', hp: 7, maxHp: 7, x: 6, y: 6 }],
    entities: [{ id: 'old-altar', kind: 'altar', x: 5, y: 5 }],
    mapFeedback: [{ id: 'old-feedback', x: 6, y: 6, text: '-3', kind: 'damage' }],
    suggestions: ['Старое действие'],
    agentInteraction: { id: 'resolved-choice', status: 'resolved', options: [], resolvedOptionId: 'leave' },
    scene: {
      title: 'Старый склеп',
      location: 'Склеп Норвин',
      mood: 'Холод',
      objective: 'Найти печать',
      turn: 7,
      cells: [{
        x: 8,
        y: 8,
        type: 'floor',
        revealed: true,
        hidden_information: 'OLD-CELL-HIDDEN-SECRET',
        secret: 'OLD-CELL-SECRET',
      }],
    },
    adventure: {
      chapter: 2,
      history: [],
      gm_only: { villain: 'ENGINE-GM-SECRET' },
      hidden_information: { route: 'ENGINE-HIDDEN-SECRET' },
      npc_private: { archivist: 'ENGINE-NPC-PRIVATE-SECRET' },
      specific_player: { 'hero-a': 'ENGINE-PLAYER-PRIVATE-SECRET' },
      private_notes: 'ENGINE-PRIVATE-NOTES-SECRET',
      custom_private_memory: 'ENGINE-CUSTOM-PRIVATE-SECRET',
      currentHook: 'Печать архивариуса',
      visitedLocations: ['Склеп Норвин'],
    },
    mechanics: {
      positions: {
        'hero-a': { x: 8, y: 8 },
        'hero-b': { x: 9, y: 8 },
        'hero-c': { x: 10, y: 8 },
        'hero-d': { x: 11, y: 8 },
        'old-wolf': { x: 6, y: 6 },
      },
      combat: {
        active: false,
        round: 9,
        initiative: [{ actor_id: 'old-wolf', total: 18 }],
        active_index: 0,
        action_economy: { 'old-wolf': { action: false } },
      },
    },
    ...overrides,
  })
}

function sceneArgs() {
  return {
    title: 'Глава 3 · Северный город',
    location: 'Северный город',
    mood: 'Шумный вечер у городских ворот',
    objective: 'Найти снабженца каравана',
    transition: 'Отряд покидает склеп и выходит на северный тракт.',
    arrival: 'К закату впереди поднимаются стены Северного города.',
    hook: 'Знак на воротах повторяет печать архивариуса.',
    theme: 'городские улицы',
    danger: 'низкая',
    scene_kind: 'settlement',
    settlement_type: 'city',
    seed: 'scene-engine:chapter-3:north-city',
    outcome: 'Склеп остался позади.',
    objective_status: 'unresolved',
    carry_unresolved: true,
    suggestions: ['Осмотреть ворота', 'Расспросить стражу', 'Найти рынок'],
    map: { layout: 'streets', width: 7, height: 7, openness: 0.68, water: 0, featureCount: 4 },
  }
}

function sceneCommerce() {
  return {
    version: 'skazanie:scene-commerce-plan-v1',
    action: 'create',
    settlement_type: 'city',
    theme: 'provisions',
    budget_cp: 50_000,
    reason: 'Городская сцена получает базовую торговую точку.',
    outcome: 'created',
    merchant_id: null,
  }
}

function advanceCommand(overrides = {}) {
  return {
    command_type: 'AdvanceScene',
    command_id: 'advance-scene-3',
    expected_state_version: 0,
    request_fingerprint: 'scene-request-fingerprint',
    party_decision: { interaction_id: 'resolved-choice', resolved_option_id: 'leave' },
    scene_args: sceneArgs(),
    scene_commerce: sceneCommerce(),
    ...overrides,
  }
}

test('AdvanceScene разрешён только admin/director context и не требует actor_id', () => {
  const state = baseState()
  for (const context of [{}, { isAdmin: false }, { isDirector: false }]) {
    assert.throws(
      () => resolveCommand(advanceCommand(), state, options(context)),
      (error) => error instanceof RulesValidationError && error.code === 'SCENE_ADVANCE_FORBIDDEN',
    )
  }

  for (const context of [{ isAdmin: true }, { isDirector: true }]) {
    const result = resolveCommand(advanceCommand({ actor_id: 'old-wolf' }), state, options(context))
    assert.equal(result.command.actor_id, null)
    assert.equal(result.events[0].event_type, 'SceneAdvanced')
    assert.deepEqual(result.events[0].target_ids, state.partyMemberIds)
  }

  assert.throws(
    () => resolveCommand(advanceCommand({ party_decision: undefined }), state, options({ isDirector: true })),
    (error) => error instanceof RulesValidationError && error.code === 'PARTY_DECISION_REQUIRED',
  )
})

test('AdvanceScene отклоняет active combat и устаревшую expected_state_version', () => {
  const activeCombat = baseState({
    mechanics: {
      combat: { active: true, round: 2, initiative: [{ actor_id: 'hero-a' }], active_index: 0, action_economy: {} },
    },
  })
  assert.throws(
    () => resolveCommand(advanceCommand(), activeCombat, options({ isDirector: true })),
    (error) => error instanceof RulesValidationError && error.code === 'SCENE_ADVANCE_DURING_COMBAT',
  )
  assert.throws(
    () => resolveCommand(advanceCommand({ expected_state_version: 12 }), baseState(), options({ isAdmin: true })),
    (error) => error instanceof RulesValidationError && error.code === 'STATE_VERSION_CONFLICT',
  )
})

test('AdvanceScene детерминированно коммитит каноническую сцену и уникальные клетки входа', () => {
  const initial = baseState()
  const first = resolveCommand(advanceCommand(), initial, options({ isDirector: true }))
  const second = resolveCommand(advanceCommand(), initial, options({ isDirector: true }))
  assert.deepEqual(first.events, second.events)

  const canonical = createSceneTransition(sceneArgs(), initial)
  const event = first.events[0]
  assert.equal(event.event_type, 'SceneAdvanced')
  assert.equal(event.actor_id, null)
  assert.equal(event.payload.request_fingerprint, 'scene-request-fingerprint')
  assert.deepEqual(event.payload.party_decision, { interaction_id: 'resolved-choice', resolved_option_id: 'leave' })
  assert.equal(event.payload.location_before, 'Склеп Норвин')
  assert.equal(event.payload.location_after, 'Северный город')
  assert.deepEqual(event.payload.scene, {
    ...canonical.scene,
    theme: 'городские улицы',
    danger: 'низкая',
    scene_kind: 'settlement',
    settlement_type: 'city',
  })
  assert.deepEqual(event.payload.adventure, canonical.adventure)
  for (const field of PRIVATE_ADVENTURE_FIELDS) {
    assert.equal(Object.hasOwn(event.payload.adventure, field), false)
  }
  const serializedEvent = JSON.stringify(event)
  for (const marker of PRIVATE_SECRET_MARKERS) assert.equal(serializedEvent.includes(marker), false)
  assert.equal(event.payload.transition, canonical.transition)
  assert.equal(event.payload.arrival, canonical.arrival)
  assert.deepEqual(event.payload.suggestions, canonical.suggestions)
  assert.equal(event.payload.theme, 'городские улицы')
  assert.equal(event.payload.danger, 'низкая')
  assert.equal(event.payload.scene_kind, 'settlement')
  assert.equal(event.payload.settlement_type, 'city')
  assert.deepEqual(event.payload.scene_commerce, sceneCommerce())

  const positions = event.payload.party_positions
  assert.deepEqual(positions.map((position) => position.actor_id), initial.partyMemberIds)
  assert.equal(new Set(positions.map((position) => `${position.x},${position.y}`)).size, initial.partyMemberIds.length)
  const cells = new Map(event.payload.scene.cells.map((cell) => [`${cell.x},${cell.y}`, cell]))
  for (const position of positions) assert.match(String(cells.get(`${position.x},${position.y}`)?.type), /^(?:floor|door)$/u)
  const distances = positions.map((position) => Math.abs(position.x - event.payload.entrance.x) + Math.abs(position.y - event.payload.entrance.y))
  assert.deepEqual(distances, [...distances].sort((left, right) => left - right))
})

test('SceneAdvanced reducer очищает старую сцену, размещает отряд и точно replay-ится', () => {
  const initial = baseState()
  const command = advanceCommand()
  const result = resolveCommand(command, initial, options({ isAdmin: true }))
  const next = result.events.reduce((state, event) => applyGameEvent(state, event), initial)

  assert.equal(next.state_version, 1)
  assert.equal(next.scene.location, 'Северный город')
  assert.equal(next.adventure.chapter, 3)
  assert.deepEqual(next.adventure.gm_only, initial.adventure.gm_only)
  assert.deepEqual(next.adventure.hidden_information, initial.adventure.hidden_information)
  assert.deepEqual(next.adventure.npc_private, initial.adventure.npc_private)
  assert.deepEqual(next.adventure.specific_player, initial.adventure.specific_player)
  assert.equal(next.adventure.private_notes, initial.adventure.private_notes)
  assert.equal(Object.hasOwn(next.adventure, 'custom_private_memory'), false)
  assert.equal(next.adventure.history.at(-1).location, 'Склеп Норвин')
  assert.ok(next.adventure.visitedLocations.includes('Северный город'))
  assert.deepEqual(next.enemies, [])
  assert.deepEqual(next.entities, [])
  assert.deepEqual(next.mapFeedback, [])
  assert.deepEqual(next.mechanics.combat, { active: false, round: 0, initiative: [], active_index: -1, action_economy: {}, reaction_window: null })
  assert.equal(next.tacticalTurn, undefined)
  assert.equal(next.agentInteraction, null)
  assert.deepEqual(next.suggestions, result.events[0].payload.suggestions)

  const expectedPositions = new Map(result.events[0].payload.party_positions.map((position) => [position.actor_id, { x: position.x, y: position.y }]))
  assert.deepEqual(next.mechanics.positions, Object.fromEntries(expectedPositions))
  for (const player of next.players) {
    assert.deepEqual({ x: player.x, y: player.y }, expectedPositions.get(player.id))
    const cell = next.scene.cells.find((candidate) => candidate.x === player.x && candidate.y === player.y)
    assert.equal(cell?.revealed, true)
  }

  assert.deepEqual(replayEvents(initial, result.events), next)
  const batch = resolveCommands([command], initial, options({ isDirector: true }))
  assert.deepEqual(batch.state, next)
  assert.deepEqual(replayEvents(initial, batch.events), batch.state)
})
