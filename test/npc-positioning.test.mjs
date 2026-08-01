import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import {
  NPC_WORLD_POLICY_ID,
  npcCombatStanceEventDrafts,
  planSceneNpcPlacementEvents,
  sceneNpcsForViewer,
} from '../server/npc-positioning.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'
import {
  addProp,
  createTacticalMap,
  serializeTacticalMap,
  setCell,
} from '../server/tactical-map.mjs'
import { campaignStateForViewer, turnResultForViewer } from '../server/viewer-projection.mjs'

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `npc-roll-${++id}`,
    now: () => '2026-07-31T12:00:00.000Z',
  })
}

function openMap({ width = 9, height = 7, locationId = 'market' } = {}) {
  const map = createTacticalMap({ width, height, locationId, seed: `npc-map:${locationId}` })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setCell(map, x, y, { passable: true, revealed: true, material: 'stone' })
    }
  }
  addProp(map, {
    id: 'bar-1',
    assetId: 'bar_counter',
    x: width - 2,
    y: 2,
    footprint: [{ x: width - 2, y: 2 }],
    blocksMove: true,
  })
  addProp(map, {
    id: 'altar-1',
    assetId: 'altar',
    x: 2,
    y: height - 2,
    footprint: [{ x: 2, y: height - 2 }],
    blocksMove: true,
  })
  return map
}

function npcState({
  npcs = [
    { id: 'marta', name: 'Марта', role: 'трактирщица', location: 'Рынок', visibility: 'party', available: true, tags: ['faction:guild'] },
    { id: 'bor', name: 'Бор', role: 'стражник', location: 'Рынок', visibility: 'party', available: true, tags: ['faction:watch'] },
  ],
  combat = false,
} = {}) {
  const map = openMap()
  return normalizeCampaignState({
    state_version: 0,
    sessionCode: 'NPC-WORLD',
    scene: {
      title: 'Рынок',
      location: 'Рынок',
      location_id: 'market',
      map: serializeTacticalMap(map),
    },
    players: [{
      id: 'hero',
      character: 'Лира',
      hp: 20,
      maxHp: 20,
      armor: 14,
      abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      x: 0,
      y: 1,
      inventory: [{
        id: 'bomb',
        name: 'Огненная склянка',
        type: 'consumable',
        quantity: 2,
        combat: {
          kind: 'thrown-area',
          damage: '2d6',
          damageType: 'fire',
          normalRange: 30,
          radius: 5,
          saveAbility: 'dex',
          saveDc: 12,
          halfOnSave: true,
        },
      }],
    }],
    enemies: [{
      id: 'bandit',
      name: 'Бандит',
      hp: 12,
      maxHp: 12,
      armor: 13,
      alive: true,
      abilities: { dex: 10 },
      x: 6,
      y: 1,
    }],
    social: { npcs, relationships: {}, conversations: [], promises: [] },
    autonomy: { reputations: {} },
    mechanics: combat ? {
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'bandit' }],
        active_index: 0,
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement_spent: 0 } },
      },
    } : {},
  })
}

function applyCommand(state, command, context = { isDirector: true }) {
  const result = resolveCommand(command, state, { diceService: dice([]), context })
  return { result, state: result.events.reduce(applyGameEvent, state) }
}

test('Scene Architect получает детерминированный свободный пост у подходящего предмета', () => {
  const state = npcState()
  const first = planSceneNpcPlacementEvents(state)
  const second = planSceneNpcPlacementEvents(state)

  assert.deepEqual(first, second)
  assert.equal(first.length, 2)
  assert.equal(first[0].event_type, 'NpcPlaced')
  const marta = first.find((event) => event.payload.npc_id === 'marta')
  assert.equal(marta.payload.anchor_prop_id, 'bar-1')
  assert.equal(Math.max(Math.abs(marta.payload.x - 7), Math.abs(marta.payload.y - 2)), 1)
  assert.equal(state.scene.cells.find((cell) => cell.x === marta.payload.x && cell.y === marta.payload.y)?.revealed, true)
  assert.equal(state.scene.cells.find((cell) => cell.x === marta.payload.x && cell.y === marta.payload.y)?.type, 'floor')
})

test('NpcPlaced и schema-ready NpcMoved доступны только системному контуру и восстанавливаются replay', () => {
  const initial = npcState()
  assert.throws(
    () => resolveCommand({ command_type: 'PlaceNpc', npc_id: 'marta', to: { x: 6, y: 2 } }, initial, { diceService: dice([]), context: {} }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_WORLD_FORBIDDEN',
  )
  assert.throws(
    () => resolveCommand({ command_type: 'PlaceNpc', npc_id: 'marta', to: { x: 7, y: 2 } }, initial, { diceService: dice([]), context: { isDirector: true } }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_POST_INVALID',
  )

  const placed = applyCommand(initial, {
    command_type: 'PlaceNpc',
    command_id: 'place-marta',
    npc_id: 'marta',
    to: { x: 6, y: 2 },
  })
  assert.equal(placed.result.events[0].event_type, 'NpcPlaced')
  assert.deepEqual(placed.state.npc_world.placements[0], {
    npc_id: 'marta',
    location_id: 'market',
    x: 6,
    y: 2,
    anchor_prop_id: '',
    placement_reason: 'system-command',
    policy_id: NPC_WORLD_POLICY_ID,
    source_event_id: '',
  })

  const moved = applyCommand(placed.state, {
    command_type: 'MoveNpc',
    command_id: 'move-marta',
    npc_id: 'marta',
    to: { x: 5, y: 2 },
  })
  assert.equal(moved.result.events[0].event_type, 'NpcMoved')
  assert.deepEqual(moved.result.events[0].payload.from, { x: 6, y: 2 })
  assert.deepEqual(replayEvents(initial, [...placed.result.events, ...moved.result.events]), moved.state)

  const absent = structuredClone(moved.state)
  absent.social.npcs = absent.social.npcs.map((npc) => npc.id === 'marta' ? { ...npc, location: 'Дорога' } : npc)
  assert.throws(
    () => resolveCommand({ command_type: 'HarmNpc', npc_id: 'marta', amount: 1 }, absent, {
      diceService: dice([]),
      context: { isAdmin: true, serverAuthoritativeCombat: true },
    }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_NOT_PRESENT',
  )
})

test('пост привязан к location_id и снова виден после возвращения в локацию', () => {
  const initial = npcState()
  const placed = applyCommand(initial, {
    command_type: 'PlaceNpc',
    command_id: 'place-return',
    npc_id: 'marta',
    to: { x: 6, y: 2 },
  }).state
  const awayMap = openMap({ locationId: 'road' })
  const away = applyGameEvent(placed, {
    command_id: 'to-road',
    event_type: 'SceneAdvanced',
    actor_id: null,
    target_ids: [],
    visibility: 'party',
    payload: {
      scene: { title: 'Дорога', location: 'Дорога', location_id: 'road', map: serializeTacticalMap(awayMap) },
      party_positions: [{ actor_id: 'hero', x: 0, y: 1 }],
    },
  })
  assert.deepEqual(sceneNpcsForViewer(away), [])

  const returned = applyGameEvent(away, {
    command_id: 'back-to-market',
    event_type: 'SceneAdvanced',
    actor_id: null,
    target_ids: [],
    visibility: 'party',
    payload: {
      scene: { title: 'Рынок', location: 'Рынок', location_id: 'market', map: serializeTacticalMap(openMap()) },
      party_positions: [{ actor_id: 'hero', x: 0, y: 1 }],
    },
  })
  assert.deepEqual(sceneNpcsForViewer(returned).map(({ id, x, y }) => ({ id, x, y })), [{ id: 'marta', x: 6, y: 2 }])
})

test('AdvanceScene атомарно добавляет NpcPlaced для NPC новой локации', () => {
  const state = npcState({
    npcs: [{
      id: 'harbor-priest',
      name: 'Отец Рем',
      role: 'жрец',
      location: 'Лунная гавань',
      visibility: 'party',
      available: true,
    }],
  })
  const result = resolveCommand({
    command_type: 'AdvanceScene',
    command_id: 'advance-with-npc',
    scene_args: {
      title: 'Лунная гавань',
      location: 'Лунная гавань',
      location_id: 'moon-harbor',
      mood: 'Холодные фонари над водой',
      objective: 'Найти капитана',
      transition: 'Отряд идёт к гавани.',
      arrival: 'В тумане проступают причалы.',
      hook: 'Жрец ждёт у святилища.',
      theme: 'harbor',
      danger: 'низкая',
      scene_kind: 'settlement',
      settlement_type: 'town',
      seed: 'moon-harbor:npc-placement',
      map: { layout: 'streets', width: 9, height: 9, openness: 0.7, water: 0.1, featureCount: 5 },
    },
  }, state, { diceService: dice([]), context: { isAdmin: true } })

  const sceneIndex = result.events.findIndex((event) => event.event_type === 'SceneAdvanced')
  const placementIndex = result.events.findIndex((event) => event.event_type === 'NpcPlaced')
  assert.ok(sceneIndex >= 0)
  assert.ok(placementIndex > sceneIndex)
  assert.equal(result.events[placementIndex].payload.npc_id, 'harbor-priest')
  const canonicalLocationId = result.events[sceneIndex].payload.scene.location_id
  assert.equal(result.events[placementIndex].payload.location_id, canonicalLocationId)
  const replayed = replayEvents(state, result.events)
  assert.equal(replayed.npc_world.placements.some((placement) => placement.npc_id === 'harbor-priest' && placement.location_id === canonicalLocationId), true)
})

test('мирный NPC не входит в инициативу, но получает площадной урон, смерть и последствия свидетелей', () => {
  let state = npcState({ combat: true })
  state = applyCommand(state, {
    command_type: 'PlaceNpc',
    command_id: 'place-victim',
    npc_id: 'marta',
    to: { x: 2, y: 1 },
  }).state
  state = applyCommand(state, {
    command_type: 'PlaceNpc',
    command_id: 'place-witness',
    npc_id: 'bor',
    to: { x: 4, y: 1 },
  }).state

  assert.deepEqual(state.mechanics.combat.initiative.map((entry) => entry.actor_id), ['hero', 'bandit'])
  const result = resolveCommand({
    command_type: 'MakeAreaAttack',
    command_id: 'area-collateral',
    actor_id: 'hero',
    item_id: 'bomb',
    to: { x: 2, y: 1 },
    server_authoritative: true,
  }, state, {
    diceService: dice([4, 4, 2]),
    context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] },
  })
  const types = result.events.map((event) => event.event_type)
  assert.ok(types.includes('NpcSavingThrowResolved'))
  assert.ok(types.includes('NpcHarmed'))
  assert.ok(types.includes('NpcDied'))
  assert.ok(types.includes('NpcStanceChanged'))
  assert.ok(types.includes('WitnessConsequencePropagated'))
  assert.ok(types.includes('FactionReputationAdjusted'))
  assert.ok(types.includes('WorldFactRecorded'))

  const next = result.events.reduce(applyGameEvent, state)
  assert.equal(next.npc_world.vitals.marta.alive, false)
  assert.equal(next.npc_world.stances.marta.stance, 'dead')
  assert.equal(next.npc_world.stances.bor.stance, 'frightened')
  assert.equal(next.autonomy.reputations.watch, -5)
  const death = result.events.find((event) => event.event_type === 'NpcDied')
  const fact = next.worldMemory.facts.find((entry) => entry.subject_id === 'marta' && entry.predicate === 'died')
  assert.deepEqual(fact.source_event_ids, [death.event_id])
  assert.deepEqual(replayEvents(state, result.events), next)
})

test('CombatStarted меняет стойку ближайшего наблюдателя, не добавляя ему ход', () => {
  let state = npcState()
  state = applyCommand(state, {
    command_type: 'PlaceNpc',
    command_id: 'place-observer',
    npc_id: 'marta',
    to: { x: 2, y: 1 },
  }).state
  const result = resolveCommand({
    command_type: 'StartCombat',
    command_id: 'combat-with-observer',
    server_authoritative: true,
  }, state, {
    diceService: dice([10, 10]),
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
  const combat = result.events.find((event) => event.event_type === 'CombatStarted')
  assert.deepEqual(combat.payload.initiative.map((entry) => entry.actor_id).sort(), ['bandit', 'hero'])
  const stance = result.events.find((event) => event.event_type === 'NpcStanceChanged' && event.payload.npc_id === 'marta')
  assert.equal(stance.payload.stance, 'frightened')
  assert.equal(stance.payload.source_event_id, combat.event_id)
})

test('ближний промах на 1–2 пункта может задеть ровно одного соседнего NPC', () => {
  let state = npcState({ combat: true })
  state = applyCommand(state, {
    command_type: 'PlaceNpc',
    command_id: 'place-miss-target',
    npc_id: 'marta',
    to: { x: 6, y: 2 },
  }).state
  state.players[0] = { ...state.players[0], x: 5, y: 1 }
  state.mechanics.positions.hero = { x: 5, y: 1 }
  const result = resolveCommand({
    command_type: 'MakeAttack',
    command_id: 'near-miss',
    actor_id: 'hero',
    target_id: 'bandit',
    attack_modifier: 4,
    damage_expression: '1d6',
    damage_type: 'piercing',
  }, state, {
    diceService: dice([9, 3]),
    context: { allowedActorIds: ['hero'] },
  })

  assert.equal(result.events.find((event) => event.event_type === 'AttackResolved').payload.hit, false)
  const harms = result.events.filter((event) => event.event_type === 'NpcHarmed')
  assert.equal(harms.length, 1)
  assert.equal(harms[0].payload.npc_id, 'marta')
  assert.equal(harms[0].payload.trigger, 'miss-collateral')
})

test('паника от близкого боя распространяется не глубже одного кольца и ограничена числом NPC', () => {
  const npcs = Array.from({ length: 40 }, (_, index) => ({
    id: `npc-${String(index).padStart(2, '0')}`,
    name: `Свидетель ${index}`,
    role: 'горожанин',
    location: 'Рынок',
    visibility: 'party',
    available: true,
  }))
  const state = npcState({ npcs })
  state.npc_world = {
    schema_version: 1,
    placements: npcs.map((npc, index) => ({
      npc_id: npc.id,
      location_id: 'market',
      x: 1 + index % 8,
      y: 1 + Math.floor(index / 8),
      anchor_prop_id: '',
      placement_reason: 'test',
      policy_id: NPC_WORLD_POLICY_ID,
    })),
    vitals: {},
    stances: {},
  }
  const events = npcCombatStanceEventDrafts(state, {
    sourceEventId: 'combat-started:test',
    participantIds: ['hero', 'bandit'],
  })
  assert.ok(events.length > 0)
  assert.ok(events.length <= 24)
  assert.ok(events.every((event) => event.payload.propagation_depth <= 1))
  assert.ok(events.some((event) => event.payload.propagation_depth === 1))
  assert.ok(events.every((event) => event.payload.source_event_id === 'combat-started:test'))
})

test('проекция отдаёт bounded scene_npcs без серверных HP и приватного npc_world', () => {
  let state = npcState()
  state = applyCommand(state, {
    command_type: 'PlaceNpc',
    command_id: 'place-visible',
    npc_id: 'marta',
    to: { x: 6, y: 2 },
  }).state
  state = applyGameEvent(state, {
    event_type: 'NpcHarmed',
    event_id: 'harm-visible',
    command_id: 'harm-visible',
    actor_id: null,
    target_ids: ['marta'],
    visibility: 'party',
    payload: { npc_id: 'marta', hp_before: 4, hp_after: 2, max_hp: 4 },
  })

  const projected = campaignStateForViewer(state, { role: 'player' }, 'hero')
  assert.equal(projected.npc_world, undefined)
  assert.deepEqual(projected.scene_npcs, [{
    id: 'marta',
    name: 'Марта',
    role: 'трактирщица',
    location_id: 'market',
    x: 6,
    y: 2,
    anchor_prop_id: null,
    stance: 'neutral',
    alive: true,
    health_status: 'bloodied',
  }])
  assert.doesNotMatch(JSON.stringify(projected.scene_npcs), /hp|max_hp|goals|beliefs/iu)

  const turn = turnResultForViewer({
    authoritative_state: state,
    mechanics: [{
      event_type: 'NpcHarmed',
      target_ids: ['marta'],
      visibility: 'party',
      payload: {
        npc_id: 'marta',
        npc_name: 'Марта',
        hp_before: 4,
        hp_after: 2,
        max_hp: 4,
        raw_amount: 2,
        applied_amount: 2,
      },
    }],
  }, { role: 'player' }, 'hero')
  assert.equal(turn.mechanics[0].payload.hp_before, undefined)
  assert.equal(turn.mechanics[0].payload.hp_after, undefined)
  assert.equal(turn.mechanics[0].payload.max_hp, undefined)
  assert.equal(turn.mechanics[0].payload.applied_amount, 2)
})

test('повтор commit с тем же idempotency_key не применяет NpcHarmed дважды', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-npc-world-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  let state = npcState()
  state = applyCommand(state, {
    command_type: 'PlaceNpc',
    command_id: 'place-idempotent',
    npc_id: 'marta',
    to: { x: 6, y: 2 },
  }).state
  const resolved = resolveCommand({
    command_type: 'HarmNpc',
    command_id: 'harm-idempotent',
    npc_id: 'marta',
    amount: 1,
    damage_type: 'bludgeoning',
  }, state, {
    diceService: dice([]),
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent })
  await store.initializeCampaign({ campaign_id: 'npc-idempotency', initial_state: state })
  const request = {
    campaign_id: 'npc-idempotency',
    expected_state_version: 0,
    idempotency_key: 'same-npc-harm',
    command_id: 'harm-idempotent',
    events: resolved.events,
  }
  const first = await store.commit(request)
  const retry = await store.commit(request)
  assert.equal(first.state.npc_world.vitals.marta.hp, 3)
  assert.equal(retry.duplicate, true)
  assert.equal(retry.state.npc_world.vitals.marta.hp, 3)
})

test('собеседник, заведённый посреди кампании, сразу получает пост и попадает в проекцию', () => {
  // Отряд уже в сцене, новых NPC в ней нет: ровно то состояние, в котором
  // Режиссёр вводит собеседника по ходу игры.
  const state = npcState({ npcs: [] })
  const resolved = resolveCommand({
    command_type: 'UpsertNpcSocialProfile',
    command_id: 'npc-introduced',
    npc: {
      id: 'iara',
      name: 'Иара Вейр',
      role: 'хранительница архива',
      location: 'Рынок',
      public_summary: 'Хранит записи поселения.',
      voice: 'Говорит тихо и точно.',
      visibility: 'party',
      available: true,
    },
  }, state, { diceService: dice([]), context: { isAdmin: true, isDirector: true } })

  // Профиль без поста — это NPC, существующий только в тексте Рассказчика:
  // проекция отбрасывает его, и на поле токена нет.
  assert.ok(resolved.events.some((event) => event.event_type === 'NpcPlaced'),
    'новому собеседнику не запланировали пост')

  const after = replayEvents(state, resolved.events)
  const visible = sceneNpcsForViewer(after, { role: 'player' }, 'hero')
  const iara = visible.find((npc) => npc.id === 'iara')
  assert.ok(iara, 'новый собеседник не виден игроку на карте')
  assert.equal(typeof iara.x, 'number')
  assert.equal(typeof iara.y, 'number')
})

test('профиль NPC из другой локации поста в текущей сцене не занимает', () => {
  const state = npcState({ npcs: [] })
  const resolved = resolveCommand({
    command_type: 'UpsertNpcSocialProfile',
    command_id: 'npc-elsewhere',
    npc: {
      id: 'dalny',
      name: 'Дальний',
      role: 'мельник',
      location: 'Другая деревня',
      public_summary: 'Живёт в стороне.',
      voice: 'Говорит громко.',
      visibility: 'party',
      available: true,
    },
  }, state, { diceService: dice([]), context: { isAdmin: true, isDirector: true } })
  assert.equal(resolved.events.some((event) => event.event_type === 'NpcPlaced'), false,
    'NPC чужой локации не должен занимать клетку текущей сцены')
})
