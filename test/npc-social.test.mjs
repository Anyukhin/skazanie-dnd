import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { NpcSocialController } from '../server/npc-social-controller.mjs'
import { FileTraceStore } from '../server/trace-store.mjs'
import {
  NPC_DOSSIER_PROFILE_LIMIT,
  npcProfileAtWorldTime,
  npcSocialForViewer,
  promiseDueOffsetMinutes,
  relationshipTier,
} from '../server/npc-social.mjs'
import { buildNpcSocialCheckPolicy, classifyNpcSocialCheck, npcSocialCheckOutcome } from '../server/npc-social-check.mjs'
import { mechanicsForViewer } from '../server/viewer-projection.mjs'
import {
  RulesValidationError,
  RulesEngine,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'

function dice(values = []) {
  return new DiceService({ rng: new SequenceDiceRng(values) })
}

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'NPC-SOCIAL',
    activePlayerId: 'hero',
    partyMemberIds: ['hero', 'rogue'],
    scene: { title: 'Market', location: 'Market Square', cells: [] },
    players: [
      { id: 'hero', character: 'Ada', hp: 10, maxHp: 10, abilities: { cha: 14, wis: 12 }, proficiency: 2, inventory: [] },
      { id: 'rogue', character: 'Ren', hp: 10, maxHp: 10, abilities: { cha: 8, wis: 14 }, proficiency: 2, inventory: [] },
    ],
    merchants: [{ id: 'marta', name: 'Marta', location: 'Market Square', available: true, stock: [] }],
    social: {
      npcs: [{
        id: 'marta', name: 'Marta', role: 'merchant', location: 'Market Square',
        public_summary: 'A careful trader.', voice: 'Brief and direct.',
        goals: ['Find the hidden crown'], beliefs: ['The duke is a traitor'],
        known_fact_ids: [], visibility: 'party', available: true,
      }],
      relationships: { marta: { hero: 3, rogue: -4 } },
      conversations: [],
      promises: [],
    },
  })
}

function socialCommand(overrides = {}) {
  return {
    command_type: 'RecordNpcSocialTurn',
    actor_id: 'hero',
    conversation: {
      id: 'conversation:one',
      npc_id: 'marta',
      hero_id: 'hero',
      player_message: 'Can you help us?',
      npc_reply: 'Bring me the ledger and I will help.',
      stance: 'friendly',
      disclosed_fact_ids: [],
      relationship_delta: 1,
      visibility: 'party',
      promise: {
        id: 'promise:one', direction: 'npc_to_party',
        text: 'Marta will provide help after receiving the ledger.',
        due_hint: 'After the ledger is delivered.', visibility: 'party',
      },
      ...overrides,
    },
  }
}

test('social projection exposes public NPC data but hides motives, beliefs and other hero relationships', () => {
  const visible = npcSocialForViewer(campaign().social, { playerId: 'hero', isPartyMember: true })

  assert.equal(visible.npcs[0].name, 'Marta')
  assert.equal(visible.relationships.marta.hero, 3)
  assert.equal(visible.relationships.marta.rogue, undefined)
  assert.doesNotMatch(JSON.stringify(visible), /hidden crown|duke is a traitor|known_fact_ids/u)
})

test('persistent NPC schedules and inventories are normalized, replayed, and projected without private leaks', () => {
  const initial = campaign()
  const npc = {
    ...initial.social.npcs[0],
    speech_profile: {
      pace: 'быстро, короткими фразами',
      lexicon: 'торговые термины и названия товара',
      mannerism: 'перед ценой говорит «счёт любит точность»',
    },
    schedule: [
      { id: 'market-hours', days: [0, 1, 2, 3, 4], start_minute: 540, end_minute: 1_020, location: 'Market Square', available: true, summary: 'Open market hours.', visibility: 'party' },
      { id: 'private-errand', days: [0], start_minute: 1_020, end_minute: 1_140, location: 'Duke Archive', available: false, summary: 'PRIVATE_ARCHIVE_ROUTE', visibility: 'gm_only' },
    ],
    inventory: [
      { id: 'map', name: 'Town map', quantity: 2, description: 'A public route map.', visibility: 'party' },
      { id: 'ledger', name: 'SECRET_LEDGER', quantity: 1, description: 'PRIVATE_DEBT_LIST', visibility: 'gm_only' },
    ],
  }
  const result = resolveCommand({ command_type: 'UpsertNpcSocialProfile', npc }, initial, {
    diceService: dice(), context: { isAdmin: true },
  })
  assert.deepEqual(result.events.map((event) => event.event_type), ['NpcSocialProfileUpserted'])
  const replayed = replayEvents(initial, result.events)
  const stored = replayed.social.npcs.find((entry) => entry.id === 'marta')
  assert.equal(stored.schedule.length, 2)
  assert.equal(stored.inventory.length, 2)
  assert.deepEqual(stored.speech_profile, npc.speech_profile)

  const marketTime = { mechanics: { world_time: { elapsed_minutes: 600 } } }
  const errandTime = { mechanics: { world_time: { elapsed_minutes: 1_050 } } }
  assert.equal(npcProfileAtWorldTime(stored, marketTime).location, 'Market Square')
  assert.equal(npcProfileAtWorldTime(stored, marketTime).available, true)
  assert.equal(npcProfileAtWorldTime(stored, errandTime).location, 'Duke Archive')
  assert.equal(npcProfileAtWorldTime(stored, errandTime).available, false)

  const visibleMarket = npcSocialForViewer(replayed.social, { playerId: 'hero', isPartyMember: true, state: marketTime })
  assert.deepEqual(visibleMarket.npcs[0].inventory, [{ id: 'map', name: 'Town map', quantity: 2, description: 'A public route map.' }])
  assert.equal(visibleMarket.npcs[0].schedule, undefined)
  const visibleErrand = npcSocialForViewer(replayed.social, { playerId: 'hero', isPartyMember: true, state: errandTime })
  assert.equal(visibleErrand.npcs[0].available, false)
  assert.equal(visibleErrand.npcs[0].location, '')
  assert.doesNotMatch(JSON.stringify(visibleErrand), /SECRET_LEDGER|PRIVATE_DEBT_LIST|PRIVATE_ARCHIVE_ROUTE|Duke Archive/u)
})

test('NPC profile management rejects overlapping schedules and invalid inventory before an event is produced', () => {
  const initial = campaign()
  const overlapping = {
    ...initial.social.npcs[0],
    schedule: [
      { id: 'morning', days: [], start_minute: 480, end_minute: 720, location: 'Market Square', available: true },
      { id: 'overlap', days: [0], start_minute: 700, end_minute: 800, location: 'Market Square', available: true },
    ],
  }
  assert.throws(
    () => resolveCommand({ command_type: 'UpsertNpcSocialProfile', npc: overlapping }, initial, { diceService: dice(), context: { isAdmin: true } }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_SCHEDULE_CONFLICT',
  )
  const invalidInventory = {
    ...initial.social.npcs[0],
    inventory: [{ id: 'coin', name: 'Coin', quantity: -1, visibility: 'party' }],
  }
  assert.throws(
    () => resolveCommand({ command_type: 'UpsertNpcSocialProfile', npc: invalidInventory }, initial, { diceService: dice(), context: { isAdmin: true } }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_INVENTORY_INVALID',
  )
  const incompleteSpeechProfile = {
    ...initial.social.npcs[0],
    speech_profile: { pace: 'быстро', lexicon: 'торговые слова' },
  }
  assert.throws(
    () => resolveCommand({ command_type: 'UpsertNpcSocialProfile', npc: incompleteSpeechProfile }, initial, { diceService: dice(), context: { isAdmin: true } }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_SPEECH_PROFILE_INVALID',
  )
})

test('a scheduled unavailable NPC cannot be addressed even when their private destination is hidden', () => {
  const initial = campaign()
  initial.mechanics.world_time = { elapsed_minutes: 1_050 }
  initial.social.npcs[0].schedule = [
    { id: 'private-errand', days: [0], start_minute: 1_020, end_minute: 1_140, location: 'Duke Archive', available: false, visibility: 'gm_only' },
  ]
  assert.throws(
    () => resolveCommand(socialCommand(), initial, { diceService: dice(), context: { isSocialController: true } }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_NPC_UNAVAILABLE',
  )
})

test('a server-confirmed social turn is event sourced and replayable with relationship and promise', () => {
  const initial = campaign()
  const result = resolveCommand(socialCommand(), initial, {
    diceService: dice(), context: { isSocialController: true },
  })

  assert.deepEqual(result.events.map((event) => event.event_type), [
    'NpcConversationRecorded', 'NpcRelationshipAdjusted', 'NpcPromiseRecorded',
  ])
  const replayed = replayEvents(initial, result.events)
  assert.equal(replayed.social.relationships.marta.hero, 4)
  assert.equal(replayed.social.conversations[0].npc_reply, 'Bring me the ledger and I will help.')
  assert.equal(replayed.social.promises[0].status, 'open')
  assert.equal(replayed.social.npcs[0].dossier.length, 1)
  assert.deepEqual(replayed.social.npcs[0].dossier[0].provenance, {
    source_kind: 'NpcConversationRecorded',
    source_conversation_id: 'conversation:one',
    source_event_ids: [result.events[0].event_id],
  })
})

test('NPC dossier is bounded, deduplicated, visibility-safe and survives replay plus arc carry-over', () => {
  const initial = campaign()
  const privateConversation = {
    event_id: 'event:private-conversation',
    event_type: 'NpcConversationRecorded',
    payload: {
      conversation: {
        id: 'conversation:private',
        npc_id: 'marta',
        hero_id: 'hero',
        player_message: 'Что говорят о герцоге?',
        npc_reply: 'Я слышала обвинение, но не знаю, правда ли это.',
        stance: 'guarded',
        disclosed_fact_ids: [],
        disclosed_claim_ids: ['claim:duke-rumor'],
        visibility: 'specific_player',
      },
    },
    target_ids: ['marta', 'hero'],
    visibility: 'specific_player',
  }
  const once = applyGameEvent(initial, privateConversation)
  const twice = applyGameEvent(once, privateConversation)
  assert.deepEqual(twice.social.npcs[0].dossier, once.social.npcs[0].dossier)
  assert.deepEqual(once.social.npcs[0].dossier[0].disclosed_claims, [{
    id: 'claim:duke-rumor',
    truth_status: 'unknown',
  }])
  assert.equal(once.social.npcs[0].dossier[0].epistemic_status, 'contains_unverified_claims')

  let accumulated = twice
  for (let index = 0; index < NPC_DOSSIER_PROFILE_LIMIT + 4; index += 1) {
    accumulated = applyGameEvent(accumulated, {
      event_id: `event:dossier:${index}`,
      event_type: 'NpcConversationRecorded',
      payload: {
        conversation: {
          id: `conversation:dossier:${index}`,
          npc_id: 'marta',
          hero_id: 'hero',
          player_message: `Вопрос ${index}`,
          npc_reply: `Ответ ${index}`,
          stance: index % 2 ? 'friendly' : 'neutral',
          disclosed_fact_ids: [],
          disclosed_claim_ids: [],
          visibility: 'party',
        },
      },
      target_ids: ['marta', 'hero'],
      visibility: 'party',
    })
  }
  assert.equal(accumulated.social.npcs[0].dossier.length, NPC_DOSSIER_PROFILE_LIMIT)
  assert.equal(new Set(accumulated.social.npcs[0].dossier.map((entry) => entry.id)).size, NPC_DOSSIER_PROFILE_LIMIT)

  const heroView = npcSocialForViewer(once.social, { playerId: 'hero', isPartyMember: true })
  const rogueView = npcSocialForViewer(once.social, { playerId: 'rogue', isPartyMember: true })
  assert.equal(heroView.npcs[0].dossier.length, 1)
  assert.equal(rogueView.npcs[0].dossier.length, 0)
  assert.doesNotMatch(JSON.stringify(heroView.npcs[0].dossier), /hidden crown|duke is a traitor/iu)

  const transitioned = applyGameEvent(accumulated, {
    event_id: 'event:arc:completed',
    event_type: 'CampaignArcCompleted',
    payload: {
      closed_arc: { arc_number: 1, final_chapter: 1 },
      next_arc: { arc_number: 2 },
      epilogue: 'Первая арка завершена.',
      hook: 'Новая дорога зовёт.',
    },
    visibility: 'party',
  })
  assert.deepEqual(transitioned.social.npcs[0].dossier, accumulated.social.npcs[0].dossier)
  assert.deepEqual(
    normalizeCampaignState(transitioned).social.npcs[0].dossier,
    normalizeCampaignState(accumulated).social.npcs[0].dossier,
  )
})

test('players cannot forge NPC turns and the social validator rejects unknown fact disclosure', () => {
  const initial = campaign()
  assert.throws(
    () => resolveCommand(socialCommand(), initial, { diceService: dice(), context: {} }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_FORBIDDEN',
  )
  assert.throws(
    () => resolveCommand(socialCommand({ disclosed_fact_ids: ['fact:unknown'] }), initial, {
      diceService: dice(), context: { isSocialController: true },
    }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_FACT_FORBIDDEN',
  )
})

test('раскрытый NPC факт становится персональным знанием героя и переживает replay', () => {
  const initial = campaign()
  initial.worldMemory = {
    schema_version: 2,
    entities: [{ id: 'npc:marta', kind: 'npc', name: 'Marta', summary: '', aliases: [], visibility: 'party', tags: [] }],
    facts: [{
      id: 'fact:route', subject_id: 'npc:marta', predicate: 'knows_route',
      object: 'The old aqueduct is safe.', summary: 'The old aqueduct is safe.',
      visibility: 'gm_only', source_event_ids: [], source_command_id: '', supersedes_fact_id: '', status: 'active',
    }],
    quests: [], knowledge: {}, knowledge_ledger: [],
  }
  initial.social.npcs[0].known_fact_ids = ['fact:route']
  const result = resolveCommand(socialCommand({ disclosed_fact_ids: ['fact:route'] }), initial, {
    diceService: dice(), context: { isSocialController: true },
  })

  assert.deepEqual(result.events.map((event) => event.event_type), [
    'NpcConversationRecorded', 'KnowledgeRevealed', 'NpcRelationshipAdjusted', 'NpcPromiseRecorded',
  ])
  const replayed = replayEvents(initial, result.events)
  assert.deepEqual(replayed.worldMemory.knowledge.hero, ['fact:route'])
  assert.equal(replayed.worldMemory.knowledge_ledger[0].source_kind, 'npc')
  assert.deepEqual(replayed.worldMemory.knowledge_ledger[0].source_event_ids, [result.events[0].event_id])
  assert.deepEqual(replayed.worldMemory.knowledge.rogue, undefined)
})

test('social turns are rejected when the NPC is elsewhere, unavailable or combat is active', () => {
  const elsewhere = campaign()
  elsewhere.social.npcs[0].location = 'Docks'
  elsewhere.merchants[0].location = 'Docks'
  assert.throws(
    () => resolveCommand(socialCommand(), elsewhere, { diceService: dice(), context: { isSocialController: true } }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_WRONG_LOCATION',
  )

  const unavailable = campaign()
  unavailable.social.npcs[0].available = false
  unavailable.merchants[0].available = false
  assert.throws(
    () => resolveCommand(socialCommand(), unavailable, { diceService: dice(), context: { isSocialController: true } }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_NPC_UNAVAILABLE',
  )

  const combat = campaign()
  combat.mechanics.combat.active = true
  assert.throws(
    () => resolveCommand(socialCommand(), combat, { diceService: dice(), context: { isSocialController: true } }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_DURING_COMBAT',
  )
})


test('LLM receives no private motives and cannot forge identity, facts or an excessive relationship change', async () => {
  let request = null
  const controller = new NpcSocialController({
    llmClient: {
      completeJson: async (input) => {
        request = input
        return {
          npc_id: 'forged-npc', reply: 'I can discuss only what I know.', stance: 'friendly',
          disclosed_fact_ids: ['fact:unknown'], relationship_delta: 99, confidence: 0.8,
          promise: { direction: 'npc_to_party', text: 'I will reserve a room.', due_hint: 'Tonight.' },
        }
      },
    },
  })

  const result = await controller.respond({
    state: campaign(), playerId: 'hero', npcId: 'marta', message: 'Tell me everything.', turnId: 'turn-1',
  })
  const sent = request.messages.map((message) => message.content).join('\n')

  assert.doesNotMatch(sent, /hidden crown|duke is a traitor|known_fact_ids/u)
  assert.equal(result.npc_id, 'marta')
  assert.deepEqual(result.disclosed_fact_ids, [])
  assert.equal(result.relationship_delta, 2)
  assert.match(result.promise.id, /^promise:/u)
})

test('NPC receives only its structured beliefs and rumors, keeps them separate from canonical facts, and cannot disclose another holder claim', async () => {
  let request = null
  const state = campaign()
  state.worldMemory = {
    ...state.worldMemory,
    entities: [
      ...(state.worldMemory.entities ?? []),
      { id: 'marta', kind: 'npc', name: 'Marta', summary: 'Trader', visibility: 'party', aliases: [], tags: [] },
      { id: 'npc:other', kind: 'npc', name: 'Other', summary: 'Other NPC', visibility: 'party', aliases: [], tags: [] },
    ],
    epistemic_claims: [
      {
        id: 'rumor:marta-key', kind: 'rumor', holder_entity_id: 'marta', subject_entity_id: '',
        predicate: 'heard', claim: 'The key is in the market.', summary: 'A market rumor.',
        visibility: 'gm_only', truth_status: 'unknown', source_event_ids: ['event:gossip'],
      },
      {
        id: 'belief:other', kind: 'belief', holder_entity_id: 'npc:other', subject_entity_id: '',
        predicate: 'believes', claim: 'Another private belief.', summary: 'Not Marta knowledge.',
        visibility: 'gm_only', truth_status: 'unknown', source_event_ids: ['event:thought'],
      },
    ],
  }
  const controller = new NpcSocialController({
    llmClient: {
      completeJson: async (input) => {
        request = input
        return {
          reply: 'I heard the key is in the market.',
          disclosed_fact_ids: [],
          disclosed_claim_ids: ['rumor:marta-key', 'belief:other'],
          relationship_delta: 0,
        }
      },
    },
  })
  const result = await controller.respond({
    state, playerId: 'hero', npcId: 'marta', message: 'What have you heard?', turnId: 'turn-claim',
  })
  const sent = request.messages.map((message) => message.content).join('\n')

  assert.match(sent, /rumor:marta-key/u)
  assert.doesNotMatch(sent, /belief:other|Another private belief/u)
  assert.deepEqual(result.disclosed_fact_ids, [])
  assert.deepEqual(result.disclosed_claim_ids, ['rumor:marta-key'])
})

test('NPC retrieval ranks facts by the player message deterministically without expanding the disclosure allowlist', async () => {
  const state = campaign()
  state.worldMemory = {
    ...state.worldMemory,
    entities: [
      ...(state.worldMemory.entities ?? []),
      { id: 'npc:marta', kind: 'npc', name: 'Marta', summary: 'Trader', visibility: 'party', aliases: [], tags: [] },
    ],
    facts: Array.from({ length: 10 }, (_, index) => ({
      id: index === 0 ? 'fact:route' : `fact:irrelevant-${index}`,
      subject_id: 'npc:marta', predicate: 'knows',
      object: index === 0 ? 'The old aqueduct is open.' : `Market detail ${index}.`,
      summary: index === 0 ? 'Старый акведук открыт для прохода.' : `Рыночная деталь ${index}.`,
      visibility: 'party', source_event_ids: [`event:fact-${index}`], status: 'active', recorded_at_minutes: 0,
    })),
  }
  const requests = []
  const controller = new NpcSocialController({
    llmClient: { completeJson: async (input) => {
      requests.push(input)
      return { reply: 'Об акведуке я могу рассказать.', disclosed_fact_ids: [], disclosed_claim_ids: [], relationship_delta: 0 }
    } },
  })

  await controller.respond({ state, playerId: 'hero', npcId: 'marta', message: 'Что известно про старый акведук?', turnId: 'retrieve-1' })
  await controller.respond({ state, playerId: 'hero', npcId: 'marta', message: 'Что известно про старый акведук?', turnId: 'retrieve-2' })
  const first = requests[0].messages[1].content

  assert.match(first, /<<<UNTRUSTED_DATA:npc_social_brief>>>/u)
  assert.match(first, /fact:route/u)
  assert.doesNotMatch(first, /fact:irrelevant-9|Рыночная деталь 9/u)
  assert.equal(requests[1].messages[1].content, first)
})

test('orchestrator commits NPC dialogue once and replays the stored reply without calling LLM or Narrator again', async () => {
  const initial = campaign()
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-social-'))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
  })
  await eventStore.initializeCampaign({
    campaign_id: 'NPC-SOCIAL',
    initial_state: initial,
    ruleset_id: initial.ruleset_id,
    ruleset_version: initial.ruleset_version,
    enabled_rule_packs: initial.enabled_rule_packs,
    enabled_house_rules: initial.enabled_house_rules,
  })
  let socialCalls = 0
  let narratorCalls = 0
  const fallback = new NpcSocialController()
  const orchestrator = new GameOrchestrator({
    modeResolver: () => 'enforce',
    intentParser: { parse: async ({ message, playerId }) => ({
      actor_id: playerId, intent: 'social', approach: 'conversation', targets: ['marta'],
      mentioned_entities: ['marta'], missing_information: [], requires_clarification: false,
      confidence: 1, raw_message: message,
    }) },
    adjudicator: { createPlan: async () => { throw new Error('Adjudicator must not handle a recognized NPC conversation') } },
    npcSocialController: {
      respond: async (input) => { socialCalls += 1; return fallback.respond(input) },
    },
    narrator: { render: async () => { narratorCalls += 1; throw new Error('Narrator must not rewrite committed NPC dialogue') } },
    rulesEngine: new RulesEngine({ diceService: dice() }),
    eventStore,
    idFactory: () => 'social-turn',
  })
  const input = {
    state: initial, campaignId: 'NPC-SOCIAL', playerId: 'hero',
    message: 'I speak with Marta.', idempotencyKey: 'social-request-1',
  }

  const first = await orchestrator.handle(input)
  const second = await orchestrator.handle(input)

  assert.equal(first.action_kind, 'social')
  assert.equal(first.turn_consumed, true)
  assert.equal(second.idempotent_replay, true)
  assert.equal(second.narration, first.narration)
  assert.equal(socialCalls, 1)
  assert.equal(narratorCalls, 0)
  assert.equal((await eventStore.load('NPC-SOCIAL')).state.social.conversations.length, 1)
})

test('orchestrator с реальным parser обращается к присутствующему NPC по роли', async () => {
  const initial = campaign()
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-role-resolution-'))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
  })
  await eventStore.initializeCampaign({
    campaign_id: 'NPC-SOCIAL',
    initial_state: initial,
    ruleset_id: initial.ruleset_id,
    ruleset_version: initial.ruleset_version,
    enabled_rule_packs: initial.enabled_rule_packs,
    enabled_house_rules: initial.enabled_house_rules,
  })
  const fallback = new NpcSocialController()
  let selectedNpcId = null
  const orchestrator = new GameOrchestrator({
    npcSocialController: {
      respond: async (input) => {
        selectedNpcId = input.npcId
        return fallback.respond(input)
      },
    },
    narrator: { render: async () => { throw new Error('Социальную реплику не должен переписывать Narrator') } },
    rulesEngine: new RulesEngine({ diceService: dice() }),
    eventStore,
    idFactory: () => 'social-role-turn',
  })
  const result = await orchestrator.handle({
    state: initial,
    campaignId: 'NPC-SOCIAL',
    playerId: 'hero',
    message: '\u0413\u043e\u0432\u043e\u0440\u044e \u0442\u043e\u0440\u0433\u043e\u0432\u0446\u0443: \u0434\u043e\u0431\u0440\u044b\u0439 \u0434\u0435\u043d\u044c.',
    idempotencyKey: 'social-by-role',
  })

  assert.equal(selectedNpcId, 'marta')
  assert.equal(result.action_kind, 'social')
  assert.ok(result.mechanics.some((event) => event.event_type === 'NpcConversationRecorded'))
  assert.equal((await eventStore.load('NPC-SOCIAL')).state.social.conversations[0].npc_id, 'marta')
})

test('двое присутствующих NPC с одной ролью дают clarification без броска и мутации', async () => {
  const initial = campaign()
  initial.social.npcs.push({
    ...initial.social.npcs[0],
    id: 'olga',
    name: 'Ольга',
  })
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-role-ambiguity-'))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
  })
  await eventStore.initializeCampaign({
    campaign_id: 'NPC-SOCIAL',
    initial_state: initial,
    ruleset_id: initial.ruleset_id,
    ruleset_version: initial.ruleset_version,
    enabled_rule_packs: initial.enabled_rule_packs,
    enabled_house_rules: initial.enabled_house_rules,
  })
  const before = await eventStore.load('NPC-SOCIAL')
  const orchestrator = new GameOrchestrator({
    npcSocialController: { respond: async () => { throw new Error('Неоднозначный NPC не должен вызывать контроллер') } },
    rulesEngine: new RulesEngine({ diceService: dice([20]) }),
    eventStore,
    idFactory: () => 'social-ambiguous-turn',
  })
  const result = await orchestrator.handle({
    state: initial,
    campaignId: 'NPC-SOCIAL',
    playerId: 'hero',
    message: '\u0413\u043e\u0432\u043e\u0440\u044e \u0442\u043e\u0440\u0433\u043e\u0432\u0446\u0443: \u0434\u043e\u0431\u0440\u044b\u0439 \u0434\u0435\u043d\u044c.',
    idempotencyKey: 'social-ambiguous',
  })
  const after = await eventStore.load('NPC-SOCIAL')

  assert.match(result.narration, /несколько собеседников/u)
  assert.deepEqual(result.mechanics, [])
  assert.equal(result.turn_consumed, false)
  assert.equal(after.state_version, before.state_version)
})

test('explicit npc_id selects a visible social target and participates in the request fingerprint', async () => {
  const initial = campaign()
  initial.social.npcs.push(
    {
      ...initial.social.npcs[0],
      id: 'borin',
      name: 'Borin',
      visibility: 'party',
    },
    {
      ...initial.social.npcs[0],
      id: 'hidden-npc',
      name: 'Hidden',
      visibility: 'gm_only',
    },
  )
  const root = mkdtempSync(join(tmpdir(), 'skazanie-explicit-npc-'))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
  })
  await eventStore.initializeCampaign({
    campaign_id: 'EXPLICIT-NPC',
    initial_state: { ...initial, sessionCode: 'EXPLICIT-NPC' },
    ruleset_id: initial.ruleset_id,
    ruleset_version: initial.ruleset_version,
    enabled_rule_packs: initial.enabled_rule_packs,
    enabled_house_rules: initial.enabled_house_rules,
  })
  const fallback = new NpcSocialController()
  let socialCalls = 0
  const orchestrator = new GameOrchestrator({
    intentParser: { parse: async ({ message, playerId }) => ({
      actor_id: playerId, intent: 'exploration', approach: 'look', targets: [],
      mentioned_entities: [], missing_information: [], requires_clarification: false,
      confidence: 1, raw_message: message,
    }) },
    adjudicator: { createPlan: async () => { throw new Error('Explicit npc_id must select the social path') } },
    npcSocialController: {
      respond: async (input) => { socialCalls += 1; return fallback.respond(input) },
    },
    narrator: { render: async () => { throw new Error('Committed NPC dialogue must not be rewritten') } },
    rulesEngine: new RulesEngine({ diceService: dice() }),
    eventStore,
    traceStore: new FileTraceStore({ rootDir: join(root, 'traces') }),
  })
  const base = {
    state: { ...initial, sessionCode: 'EXPLICIT-NPC' },
    campaignId: 'EXPLICIT-NPC',
    playerId: 'hero',
    message: 'Hello there.',
    idempotencyKey: 'explicit-target-1',
    npcId: 'marta',
    user: { role: 'player' },
  }

  const first = await orchestrator.handle(base)
  const replay = await orchestrator.handle(base)

  assert.equal(first.action_kind, 'social')
  assert.equal(first.mechanics.some((event) => event.payload?.conversation?.npc_id === 'marta'), true)
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.narration, first.narration)
  assert.equal(socialCalls, 1)
  await assert.rejects(
    orchestrator.handle({ ...base, npcId: 'borin' }),
    (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
  )
  await assert.rejects(
    orchestrator.handle({ ...base, message: 'A different request.' }),
    (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
  )
  await assert.rejects(
    orchestrator.handle({ ...base, npcId: undefined }),
    (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
  )
  const differentKey = await orchestrator.handle({ ...base, idempotencyKey: 'explicit-target-2' })
  assert.notEqual(differentKey.turn_id, first.turn_id)
  assert.equal(replay.turn_id, first.turn_id)
})

test('direct orchestrator caller cannot select a hidden explicit npc_id', async () => {
  const initial = campaign()
  initial.social.npcs.push({
    ...initial.social.npcs[0],
    id: 'hidden-npc',
    name: 'Hidden',
    visibility: 'gm_only',
  })
  const root = mkdtempSync(join(tmpdir(), 'skazanie-hidden-explicit-npc-'))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
  })
  await eventStore.initializeCampaign({
    campaign_id: 'HIDDEN-NPC',
    initial_state: { ...initial, sessionCode: 'HIDDEN-NPC' },
  })
  let socialCalls = 0
  const orchestrator = new GameOrchestrator({
    intentParser: { parse: async ({ message, playerId }) => ({
      actor_id: playerId, intent: 'unknown', approach: '', targets: [],
      mentioned_entities: [], missing_information: [], requires_clarification: false,
      confidence: 1, raw_message: message,
    }) },
    adjudicator: { createPlan: async () => { throw new Error('Hidden target must not reach adjudication') } },
    npcSocialController: { respond: async () => { socialCalls += 1; return null } },
    rulesEngine: new RulesEngine({ diceService: dice() }),
    eventStore,
  })

  const result = await orchestrator.handle({
    state: { ...initial, sessionCode: 'HIDDEN-NPC' },
    campaignId: 'HIDDEN-NPC',
    playerId: 'hero',
    message: 'Speak.',
    idempotencyKey: 'hidden-explicit',
    npcId: 'hidden-npc',
    user: { role: 'player' },
  })

  assert.equal(result.turn_consumed, false)
  assert.match(result.narration, /собеседник|рядом/iu)
  assert.equal(socialCalls, 0)
})

test('an explicit npc_id conflicts with a duplicate non-social request', async () => {
  const initial = campaign()
  const root = mkdtempSync(join(tmpdir(), 'skazanie-explicit-after-command-'))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
  })
  await eventStore.initializeCampaign({ campaign_id: 'EXPLICIT-AFTER-COMMAND', initial_state: { ...initial, sessionCode: 'EXPLICIT-AFTER-COMMAND' } })
  const orchestrator = new GameOrchestrator({
    rulesEngine: new RulesEngine({ diceService: dice() }),
    eventStore,
    traceStore: new FileTraceStore({ rootDir: join(root, 'traces') }),
    npcSocialController: new NpcSocialController(),
  })
  const common = {
    state: { ...initial, sessionCode: 'EXPLICIT-AFTER-COMMAND' },
    campaignId: 'EXPLICIT-AFTER-COMMAND',
    playerId: 'hero',
    message: 'System command.',
    idempotencyKey: 'non-social-then-explicit',
  }
  await orchestrator.handle({
    ...common,
    commands: [{ command_type: 'ApplyHealing', actor_id: 'hero', amount: 1 }],
  })

  await assert.rejects(
    orchestrator.handle({ ...common, npcId: 'marta', user: { role: 'player' } }),
    (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
  )
})

test('social check classifier and policy choose a server-owned skill, ability and DC', () => {
  assert.equal(classifyNpcSocialCheck('\u0443\u0431\u0435\u0436\u0434\u0430\u044e \u041c\u0430\u0440\u0442\u0443 \u043f\u043e\u043c\u043e\u0447\u044c.'), 'persuasion')
  assert.equal(classifyNpcSocialCheck('\u043e\u0431\u043c\u0430\u043d\u044b\u0432\u0430\u044e \u041c\u0430\u0440\u0442\u0443.'), 'deception')
  assert.equal(classifyNpcSocialCheck('\u0443\u0433\u0440\u043e\u0436\u0430\u044e \u041c\u0430\u0440\u0442\u0435.'), 'intimidation')
  assert.equal(classifyNpcSocialCheck('\u043f\u0440\u043e\u043d\u0438\u0446\u0430\u0442\u0435\u043b\u044c\u043d\u043e \u0438\u0437\u0443\u0447\u0430\u044e \u0435\u0451 \u043c\u043e\u0442\u0438\u0432\u044b.'), 'insight')
  assert.equal(classifyNpcSocialCheck('I persuade Marta to open the gate.'), 'persuasion')
  assert.equal(classifyNpcSocialCheck('I lie to Marta about the seal.'), 'deception')
  assert.equal(classifyNpcSocialCheck('I threaten Marta.'), 'intimidation')
  assert.equal(classifyNpcSocialCheck("I use insight to read Marta's motives."), 'insight')
  assert.equal(classifyNpcSocialCheck('I ask Marta about the weather.'), null)

  const policy = buildNpcSocialCheckPolicy({
    state: campaign(), npcId: 'marta', heroId: 'hero', message: 'I persuade Marta to help.', turnId: 'turn-policy',
  })
  assert.equal(policy.skill, 'persuasion')
  assert.equal(policy.ability, 'cha')
  assert.equal(policy.difficulty, 12)
  assert.equal(policy.visibility, 'specific_player')
})

test('social ability check ignores forged modifier and DC and hides the real DC from player mechanics', () => {
  const state = campaign()
  const policy = buildNpcSocialCheckPolicy({
    state, npcId: 'marta', heroId: 'hero', message: 'I persuade Marta to help.', turnId: 'turn-check',
  })
  const command = {
    command_type: 'MakeAbilityCheck', actor_id: 'hero', modifier: 99, difficulty: 1,
    social_check: { check_id: 'forged', npc_id: 'forged', skill: 'deception' },
  }
  assert.throws(
    () => resolveCommand(command, state, { diceService: dice([10]), context: { allowedActorIds: ['hero'] } }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_CHECK_FORBIDDEN',
  )

  const result = resolveCommand(command, state, {
    diceService: dice([10]), context: { isSocialController: true, socialCheck: policy, allowedActorIds: ['hero'] },
  })
  const event = result.events.find((candidate) => candidate.event_type === 'AbilityCheckResolved')
  assert.equal(event.payload.skill, 'persuasion')
  assert.equal(event.payload.ability, 'cha')
  assert.equal(event.payload.modifier, 4)
  assert.equal(event.payload.difficulty, 12)
  assert.equal(event.payload.total, 14)
  assert.equal(event.payload.success, true)
  assert.equal(event.payload.social_check.request_fingerprint, policy.request_fingerprint)
  assert.equal(npcSocialCheckOutcome(event).degree, 'success')

  const projected = mechanicsForViewer([event], { role: 'player', heroIds: ['hero'] }, 'hero')[0]
  assert.equal(projected.payload.difficulty, undefined)
  assert.equal(projected.payload.social_check.request_fingerprint, undefined)
  assert.equal(projected.payload.social_check.difficulty_hidden, true)
})

test('LLM sees only the final outcome and cannot turn failure into a promise or positive relationship change', async () => {
  let request = null
  const controller = new NpcSocialController({
    llmClient: { completeJson: async (input) => {
      request = input
      return {
        reply: 'Of course, I agree.', stance: 'friendly', disclosed_fact_ids: [],
        relationship_delta: 2, promise: { direction: 'npc_to_party', text: 'I will open the gate.' }, confidence: 1,
      }
    } },
  })
  const checkOutcome = {
    check_id: 'social-check:failure', npc_id: 'marta', skill: 'persuasion', ability: 'cha',
    roll_id: 'roll-failure', total: 7, modifier: 4, success: false, degree: 'failure',
  }
  const result = await controller.respond({
    state: campaign(), playerId: 'hero', npcId: 'marta', message: 'I persuade Marta.', turnId: 'turn-failure', checkOutcome,
  })
  const sent = request.messages[1].content
  assert.match(sent, /"resolved_check":\{"skill":"persuasion","ability":"cha","success":false,"degree":"failure"\}/u)
  assert.doesNotMatch(sent, /"difficulty"|"total"|"modifier"|"roll_id"/u)
  assert.equal(result.relationship_delta, 0)
  assert.equal(result.promise, null)
  assert.deepEqual(result.conversation.check, checkOutcome)
})

test('orchestrator commits the social roll before LLM, then replays both commits without rerolling', async () => {
  const initial = campaign()
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-social-check-'))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
  })
  const checkedInitial = { ...initial, sessionCode: 'NPC-SOCIAL-CHECK' }
  await eventStore.initializeCampaign({
    campaign_id: 'NPC-SOCIAL-CHECK',
    initial_state: checkedInitial,
    ruleset_id: checkedInitial.ruleset_id,
    ruleset_version: checkedInitial.ruleset_version,
    enabled_rule_packs: checkedInitial.enabled_rule_packs,
    enabled_house_rules: checkedInitial.enabled_house_rules,
  })
  const fallback = new NpcSocialController()
  let socialCalls = 0
  let narratorCalls = 0
  let observedOutcome = null
  const orchestrator = new GameOrchestrator({
    modeResolver: () => 'enforce',
    intentParser: { parse: async ({ message, playerId }) => ({
      actor_id: playerId, intent: 'social', approach: 'persuasion', targets: ['marta'],
      mentioned_entities: ['marta'], missing_information: [], requires_clarification: false, confidence: 1, raw_message: message,
    }) },
    adjudicator: { createPlan: async () => { throw new Error('Adjudicator must not handle a recognized social check') } },
    npcSocialController: { respond: async (input) => {
      socialCalls += 1
      const storedCheck = await eventStore.getByIdempotencyKey('NPC-SOCIAL-CHECK', 'checked-social:social-check')
      assert.ok(storedCheck, 'LLM must run only after the check commit exists')
      observedOutcome = input.checkOutcome
      return fallback.respond(input)
    } },
    narrator: { render: async () => { narratorCalls += 1; throw new Error('Narrator must not rewrite committed NPC dialogue') } },
    rulesEngine: new RulesEngine({ diceService: dice([18]) }),
    eventStore,
    idFactory: () => 'checked-social-turn',
  })
  const input = {
    state: checkedInitial, campaignId: 'NPC-SOCIAL-CHECK', playerId: 'hero',
    message: 'I persuade Marta to help us.', idempotencyKey: 'checked-social',
  }

  const first = await orchestrator.handle(input)
  const replay = await orchestrator.handle(input)
  const checkBatch = await eventStore.getByIdempotencyKey('NPC-SOCIAL-CHECK', 'checked-social:social-check')
  const dialogueBatch = await eventStore.getByIdempotencyKey('NPC-SOCIAL-CHECK', 'checked-social')
  const checkEvent = first.mechanics.find((event) => event.event_type === 'AbilityCheckResolved')

  assert.ok(checkBatch)
  assert.ok(dialogueBatch)
  assert.deepEqual(first.mechanics.slice(0, 2).map((event) => event.event_type), ['AbilityCheckResolved', 'NpcConversationRecorded'])
  assert.equal(checkEvent.payload.total, 22)
  assert.equal(checkEvent.payload.success, true)
  assert.equal(observedOutcome.success, true)
  assert.equal(observedOutcome.degree, 'strong_success')
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.narration, first.narration)
  assert.equal(replay.mechanics.filter((event) => event.event_type === 'AbilityCheckResolved').length, 1)
  assert.equal(socialCalls, 1)
  assert.equal(narratorCalls, 0)
  assert.equal((await eventStore.load('NPC-SOCIAL-CHECK')).state.social.conversations.length, 1)
})
test('relationship tiers are deterministic, projected per hero, and emit a crossing event', () => {
  assert.equal(relationshipTier(-50), 'hostile')
  assert.equal(relationshipTier(-20), 'unfriendly')
  assert.equal(relationshipTier(0), 'neutral')
  assert.equal(relationshipTier(20), 'friendly')
  assert.equal(relationshipTier(50), 'trusted')

  const initial = campaign()
  initial.social.relationships.marta.hero = 19
  const result = resolveCommand(socialCommand({ relationship_delta: 1, promise: null }), initial, {
    diceService: dice(), context: { isSocialController: true },
  })
  assert.deepEqual(result.events.map((event) => event.event_type), [
    'NpcConversationRecorded', 'NpcRelationshipAdjusted', 'NpcRelationshipTierChanged',
  ])
  const tierEvent = result.events[2]
  assert.equal(tierEvent.payload.score_before, 19)
  assert.equal(tierEvent.payload.score_after, 20)
  assert.equal(tierEvent.payload.tier_before, 'neutral')
  assert.equal(tierEvent.payload.tier_after, 'friendly')

  const replayed = replayEvents(initial, result.events)
  const viewer = npcSocialForViewer(replayed.social, { playerId: 'hero', isPartyMember: true })
  assert.equal(replayed.social.relationship_tiers.marta.hero, 'friendly')
  assert.equal(viewer.relationship_tiers.marta.hero, 'friendly')
  assert.equal(viewer.relationship_tiers.marta.rogue, undefined)
})

test('promise hints become deterministic deadlines and AdvanceTime breaks an overdue promise once', () => {
  assert.equal(promiseDueOffsetMinutes('\u0447\u0435\u0440\u0435\u0437 2 \u0447\u0430\u0441\u0430'), 120)
  assert.equal(promiseDueOffsetMinutes('in 3 days'), 4_320)
  assert.equal(promiseDueOffsetMinutes('\u0437\u0430\u0432\u0442\u0440\u0430'), 1_440)
  assert.equal(promiseDueOffsetMinutes('after the ledger arrives'), null)

  const initial = campaign()
  initial.social.relationships.marta.hero = -10
  const promised = resolveCommand(socialCommand({
    relationship_delta: 0,
    promise: {
      id: 'promise:deadline', direction: 'party_to_npc', text: 'The hero will deliver the ledger.',
      due_hint: '\u0447\u0435\u0440\u0435\u0437 2 \u0447\u0430\u0441\u0430', visibility: 'specific_player',
    },
  }), initial, { diceService: dice(), context: { isSocialController: true } })
  let state = replayEvents(initial, promised.events)
  assert.equal(state.social.promises[0].created_at_minutes, 0)
  assert.equal(state.social.promises[0].deadline_minutes, 120)
  assert.equal(state.social.promises[0].status, 'open')

  const almost = resolveCommand({ command_type: 'AdvanceTime', amount: 119, unit: 'minute' }, state, {
    diceService: dice(), context: { isDirector: true },
  })
  assert.deepEqual(almost.events.map((event) => event.event_type), ['TimeAdvanced'])
  state = replayEvents(state, almost.events)
  assert.equal(state.mechanics.world_time.elapsed_minutes, 119)
  assert.equal(state.social.promises[0].status, 'open')

  const deadline = resolveCommand({ command_type: 'AdvanceTime', amount: 1, unit: 'minute' }, state, {
    diceService: dice(), context: { isDirector: true },
  })
  assert.deepEqual(deadline.events.map((event) => event.event_type), [
    'TimeAdvanced', 'NpcPromiseResolved', 'NpcRelationshipAdjusted', 'NpcRelationshipTierChanged',
  ])
  state = replayEvents(state, deadline.events)
  assert.equal(state.mechanics.world_time.elapsed_minutes, 120)
  assert.equal(state.social.promises[0].status, 'broken')
  assert.equal(state.social.promises[0].resolved_at_minutes, 120)
  assert.equal(state.social.promises[0].resolution_reason, 'deadline')
  assert.equal(state.social.promises[0].consequence_delta, -15)
  assert.equal(state.social.relationships.marta.hero, -25)
  assert.equal(state.social.relationship_tiers.marta.hero, 'unfriendly')

  const later = resolveCommand({ command_type: 'AdvanceTime', amount: 60, unit: 'minute' }, state, {
    diceService: dice(), context: { isDirector: true },
  })
  assert.deepEqual(later.events.map((event) => event.event_type), ['TimeAdvanced'])
})

test('NPC controller receives the authoritative tier and only open promise summaries', async () => {
  const state = campaign()
  state.social.relationships.marta.hero = 55
  state.social.promises = [{
    id: 'promise:brief', npc_id: 'marta', hero_id: 'hero', direction: 'npc_to_party',
    text: 'Marta will reserve a room.', due_hint: 'tomorrow', status: 'open', visibility: 'specific_player',
    source_conversation_id: '', created_at_minutes: 0, deadline_minutes: 1_440,
  }]
  let request = null
  const controller = new NpcSocialController({
    llmClient: { completeJson: async (input) => { request = input; return { reply: 'I remember.', relationship_delta: 0 } } },
  })
  await controller.respond({ state, playerId: 'hero', npcId: 'marta', message: 'Do you remember?', turnId: 'brief-turn' })
  const sent = request.messages[1].content
  assert.match(sent, /"relationship":\{"score":55,"tier":"trusted"\}/u)
  assert.match(sent, /"open_promises":\[\{"id":"promise:brief","direction":"npc_to_party","text":"Marta will reserve a room\.","due_hint":"tomorrow"\}\]/u)
  assert.doesNotMatch(sent, /deadline_minutes|consequence_delta|resolution_reason/u)
})
test('only the system can resolve a promise and fulfillment applies a fixed relationship consequence', () => {
  const initial = campaign()
  initial.social.relationships.marta.hero = 19
  const recorded = resolveCommand(socialCommand({
    relationship_delta: 0,
    promise: {
      id: 'promise:manual', direction: 'party_to_npc', text: 'The hero will return the ledger.',
      due_hint: 'after finding it', visibility: 'specific_player',
    },
  }), initial, { diceService: dice(), context: { isSocialController: true } })
  const promised = replayEvents(initial, recorded.events)

  assert.throws(
    () => resolveCommand({ command_type: 'ResolveNpcPromise', promise_id: 'promise:manual', status: 'fulfilled' }, promised, { diceService: dice(), context: {} }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_SOCIAL_FORBIDDEN',
  )

  const resolved = resolveCommand({ command_type: 'ResolveNpcPromise', promise_id: 'promise:manual', status: 'fulfilled' }, promised, {
    diceService: dice(), context: { isDirector: true },
  })
  assert.deepEqual(resolved.events.map((event) => event.event_type), [
    'NpcPromiseResolved', 'NpcRelationshipAdjusted', 'NpcRelationshipTierChanged',
  ])
  const replayed = replayEvents(promised, resolved.events)
  assert.equal(replayed.social.promises[0].status, 'fulfilled')
  assert.equal(replayed.social.promises[0].resolution_reason, 'manual')
  assert.equal(replayed.social.promises[0].consequence_delta, 8)
  assert.equal(replayed.social.relationships.marta.hero, 27)
  assert.equal(replayed.social.relationship_tiers.marta.hero, 'friendly')
})
