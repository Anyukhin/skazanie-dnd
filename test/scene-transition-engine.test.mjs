import assert from 'node:assert/strict'
import test from 'node:test'

import { createSceneTransition } from '../server/adventure-director.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { addProp, addSpawnPoint, createTacticalMap, legacyCellsFromTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'
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

function structuralCells(cells) {
  return (Array.isArray(cells) ? cells : [])
    .map(({ revealed, ...cell }) => cell)
    .sort((left, right) => left.y - right.y || left.x - right.x)
}

function playableCells() {
  return Array.from({ length: 13 * 9 }, (_, index) => {
    const x = index % 13
    const y = Math.floor(index / 13)
    return { x, y, type: 'floor', revealed: x <= 2, material: 'stone', variant: 0, pattern: 'small-room', edge_mask: '' }
  })
}

function blockingEntranceMap() {
  const map = createTacticalMap({ width: 7, height: 7, locationId: 'prop-scene', seed: 'prop-scene', theme: 'crypt' })
  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) setCell(map, x, y, { type: 'floor', passable: true, revealed: true, material: 'stone' })
  }
  addSpawnPoint(map, { id: 'party-entrance', x: 3, y: 3, role: 'party' })
  addProp(map, {
    id: 'blocking-sarcophagus', assetId: 'sarcophagus', x: 3.5, y: 2.5,
    footprint: [{ x: 3, y: 2 }, { x: 4, y: 2 }], blocksMove: true,
  })
  return map
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
    assert.equal(result.events[0].event_type, 'PartyDecisionConsumed')
    assert.deepEqual(result.events[1].target_ids, state.partyMemberIds)
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
  const event = first.events.find((candidate) => candidate.event_type === 'SceneAdvanced')
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
  assert.equal(Object.hasOwn(event.payload, 'suggestions'), false)
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

test('новый спавн отряда не ставит героя на blocking prop, а старый SceneAdvanced replay сохраняет позицию', () => {
  const map = blockingEntranceMap()
  const serializedMap = serializeTacticalMap(map)
  const cells = legacyCellsFromTacticalMap(map)
  const initial = baseState({
    worldMap: {
      version: 1, seed: 'scene-engine', name: 'Сцены', width: 100, height: 100, currentLocationId: 'old',
      regions: [], locations: [{ id: 'prop-scene', name: 'Проповый зал', kind: 'dungeon', x: 1, y: 1, regionId: '' }], routes: [],
    },
    locationMaps: { 'prop-scene': { version: 1, cells, map: serializedMap } },
  })
  const scene_args = {
    title: 'Проповый зал', location: 'Проповый зал', location_id: 'prop-scene',
    mood: 'Тесный зал', objective: 'Пройти дальше', theme: 'склеп', scene_kind: 'dungeon', seed: 'prop-scene',
  }
  const result = resolveCommand(advanceCommand({ scene_args }), initial, options({ isDirector: true }))
  const sceneEvent = result.events.find((event) => event.event_type === 'SceneAdvanced')
  const propCells = new Set(map.props.filter((prop) => prop.blocksMove).flatMap((prop) => prop.footprint.map((cell) => `${cell.x},${cell.y}`)))
  assert.equal(sceneEvent.payload.party_positions.length, initial.partyMemberIds.length)
  for (const position of sceneEvent.payload.party_positions) assert.equal(propCells.has(`${position.x},${position.y}`), false)
  assert.deepEqual(replayEvents(initial, result.events).mechanics.positions,
    Object.fromEntries(sceneEvent.payload.party_positions.map(({ actor_id, x, y }) => [actor_id, { x, y }])))

  const legacyEvent = {
    event_type: 'SceneAdvanced', actor_id: null, target_ids: initial.partyMemberIds, visibility: 'party',
    payload: {
      scene: sceneEvent.payload.scene, worldMap: sceneEvent.payload.worldMap, adventure: sceneEvent.payload.adventure,
      party_positions: initial.partyMemberIds.map((actor_id, index) => ({ actor_id, x: index === 0 ? 3 : index === 1 ? 3 : index + 2, y: index < 2 ? 3 - index : 3 })),
    },
  }
  const legacy = applyGameEvent(initial, legacyEvent)
  assert.deepEqual({ x: legacy.players.find((player) => player.id === 'hero-b').x, y: legacy.players.find((player) => player.id === 'hero-b').y }, { x: 3, y: 2 })
})

test('SceneAdvanced reducer очищает старую сцену, размещает отряд и точно replay-ится', () => {
  const initial = baseState()
  const command = advanceCommand()
  const result = resolveCommand(command, initial, options({ isAdmin: true }))
  const next = result.events.reduce((state, event) => applyGameEvent(state, event), initial)

  assert.equal(next.state_version, result.events.length)
  assert.deepEqual(result.events.map((event) => event.event_type), [
    'PartyDecisionConsumed', 'SceneAdvanced', 'WorldEntityUpserted', 'QuestUpserted', 'QuestUpserted',
    'WorldFactRecorded', 'WorldFactRecorded', 'NarrativeSummaryRecorded',
  ])
  assert.equal(next.worldMemory.summaries.at(-1).kind, 'scene')
  assert.deepEqual(next.worldMemory.summaries.at(-1).source_event_ids, [
    result.events.find((event) => event.event_type === 'SceneAdvanced').event_id,
  ])
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
  // Форма боевого состояния зафиксирована целиком намеренно: новое поле обязано
  // пройти через это утверждение, а не появиться в снимке молча. `truce` и
  // `parley_attempts` — состояние переговоров посреди боя (`server/parley.mjs`),
  // и на новой сцене оно обнулено вместе с очередью.
  assert.deepEqual(next.mechanics.combat, { active: false, round: 0, initiative: [], active_index: -1, action_economy: {}, reaction_window: null, readied: {}, group_initiative: false, turn_completed: [], truce: null, parley_attempts: 0 })
  assert.equal(next.tacticalTurn, undefined)
  assert.equal(next.agentInteraction, null)
  const sceneAdvanced = result.events.find((event) => event.event_type === 'SceneAdvanced')
  assert.equal(Object.hasOwn(next, 'suggestions'), false)

  const expectedPositions = new Map(sceneAdvanced.payload.party_positions.map((position) => [position.actor_id, { x: position.x, y: position.y }]))
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

test('повторный вход использует карту location_id, сохраняет изменение и replay-ит её', () => {
  const initial = baseState({
    scene: {
      title: 'Старый склеп', location: 'Склеп Норвин', mood: 'Холод', objective: 'Найти печать', turn: 7,
      cells: playableCells(),
    },
  })
  const locationId = initial.worldMap.currentLocationId
  const changedCell = initial.scene.cells.find((cell) => cell.x === 4 && cell.y === 4)

  const mutation = resolveCommand({
    command_type: 'SpawnEntity',
    entity: { id: 'opened-chest', kind: 'chest', x: changedCell.x, y: changedCell.y },
  }, initial, options({ isAdmin: true }))
  const changed = mutation.events.reduce((state, event) => applyGameEvent(state, event), initial)
  assert.equal(changed.locationMaps[locationId].cells.find((cell) => cell.x === changedCell.x && cell.y === changedCell.y)?.feature, 'chest')

  const leave = resolveCommand(advanceCommand({
    expected_state_version: changed.state_version,
    party_decision: undefined,
    scene_args: { ...sceneArgs(), location: 'Северный город' },
  }), changed, options({ isAdmin: true }))
  const away = leave.events.reduce((state, event) => applyGameEvent(state, event), changed)

  const returned = resolveCommand(advanceCommand({
    expected_state_version: away.state_version,
    party_decision: undefined,
    scene_args: {
      ...sceneArgs(),
      title: 'Возвращение в склеп',
      location: 'Другая подпись не должна менять ID',
      location_id: locationId,
      theme: 'совсем другая геометрия',
      seed: 'chapter-999-random-seed',
      map: { layout: 'open', width: 25, height: 19 },
    },
  }), away, options({ isAdmin: true }))
  const returnEvent = returned.events.find((event) => event.event_type === 'SceneAdvanced')
  assert.equal(returnEvent.payload.scene.location_id, locationId)
  assert.deepEqual(structuralCells(returnEvent.payload.scene.cells), structuralCells(changed.locationMaps[locationId].cells))
  assert.equal(returnEvent.payload.scene.cells.find((cell) => cell.x === changedCell.x && cell.y === changedCell.y)?.feature, 'chest')

  const sequential = returned.events.reduce(
    (state, event) => applyGameEvent(state, event),
    leave.events.reduce((state, event) => applyGameEvent(state, event), changed),
  )
  const replayed = replayEvents(initial, [...mutation.events, ...leave.events, ...returned.events])
  assert.deepEqual(replayed, sequential)
  assert.equal(replayed.locationMaps[locationId].cells.find((cell) => cell.x === changedCell.x && cell.y === changedCell.y)?.feature, 'chest')
})
