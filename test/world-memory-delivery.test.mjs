import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { DirectorAgent } from '../server/director-agent.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { DIRECTOR_COMMAND_CAPABILITY, GameOrchestrator } from '../server/game-orchestrator.mjs'
import { applyGameEvent, normalizeCampaignState, RulesEngine } from '../server/rules-engine.mjs'
import { retrieveWorldMemory } from '../server/world-memory.mjs'

function campaign(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'WORLD-MEMORY-DELIVERY',
    activePlayerId: 'hero',
    partyMemberIds: ['hero', 'rogue'],
    scene: { title: 'Северные ворота', location: 'Северные ворота', objective: 'Найти след каравана', cells: [] },
    players: [
      { id: 'hero', character: 'Ада', hp: 10, maxHp: 10, abilities: { str: 12 }, inventory: [] },
      { id: 'rogue', character: 'Рен', hp: 9, maxHp: 10, abilities: { dex: 14 }, inventory: [] },
    ],
    ...overrides,
  })
}

async function runNarration(state, playerId, proposedCommand) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-world-memory-delivery-'))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
  })
  await eventStore.initializeCampaign({ campaign_id: state.sessionCode, initial_state: state })
  let brief = null
  const orchestrator = new GameOrchestrator({
    intentParser: { parse: async ({ message }) => ({
      actor_id: playerId, intent: 'free_action', approach: 'test', targets: [], mentioned_entities: [],
      missing_information: [], requires_clarification: false, confidence: 1, raw_message: message,
    }) },
    adjudicator: { createPlan: async () => ({
      rule_ids: [], proposed_commands: [proposedCommand], roll_requests: [], ruling_required: false,
      ruling_draft: null, narration_constraints: [], confidence: 1,
    }) },
    narrator: { render: async (value) => {
      brief = value
      return { narration: 'Подтверждённое последствие.', suggestions: [], verification: { valid: true }, provider: 'test' }
    } },
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([]) }) }),
    eventStore,
    idFactory: () => 'delivery-turn',
  })
  const response = await orchestrator.handle({
    state, campaignId: state.sessionCode, playerId, message: 'Продолжаю искать след каравана',
    idempotencyKey: `delivery-${playerId}-${proposedCommand.command_type}`,
    user: { role: 'player' },
    ...(proposedCommand.command_type === 'AdvanceTime' ? { commandCapability: DIRECTOR_COMMAND_CAPABILITY } : {}),
  })
  assert.equal(response.provider, 'test')
  assert.ok(brief)
  return { brief, response }
}

function memoryWithFacts() {
  return {
    entities: [
      { id: 'location:gates', kind: 'location', name: 'Северные ворота', summary: 'Ворота у старой дороги.', visibility: 'party' },
      { id: 'npc:warden', kind: 'npc', name: 'Страж ворот', summary: 'Свидетель событий.', visibility: 'party' },
    ],
    facts: [
      {
        id: 'fact:hero-secret', subject_id: 'npc:warden', predicate: 'hid_evidence',
        object: 'Страж спрятал личную улику героя.', summary: 'СЕКРЕТ ТОЛЬКО ДЛЯ HERO', visibility: 'gm_only',
        source_event_ids: ['event:secret'], recorded_at_minutes: 0,
      },
      {
        id: 'fact:party-route', subject_id: 'location:gates', predicate: 'route_open',
        object: 'Северная дорога открыта.', summary: 'Северная дорога к следу каравана открыта.', visibility: 'party',
        source_event_ids: ['event:route'], recorded_at_minutes: 0,
      },
    ],
    knowledge_ledger: [{
      id: 'knowledge:hero-secret', hero_id: 'hero', fact_id: 'fact:hero-secret', summary: 'личное знание героя',
      source_event_ids: ['event:secret'], revealed_event_id: 'event:reveal', source_kind: 'knowledge_revealed', recorded_at_minutes: 0,
    }],
    quests: [], threads: [], relationships: [], epistemic_claims: [], summaries: [],
  }
}

test('NarrationBrief получает только публичную/групповую релевантную память и не раскрывает личный gm_only факт', async () => {
  const state = campaign({ worldMemory: memoryWithFacts() })
  const forRogue = await runNarration(state, 'rogue', { command_type: 'ApplyHealing', actor_id: 'rogue', amount: 1 })
  const forHero = await runNarration(state, 'hero', { command_type: 'ApplyHealing', actor_id: 'hero', amount: 1 })

  for (const { brief } of [forRogue, forHero]) {
    const facts = brief.known_environment.world_memory.facts
    assert.ok(facts.some((fact) => fact.id === 'fact:party-route'))
    assert.equal(facts.some((fact) => fact.id === 'fact:hero-secret'), false)
    assert.doesNotMatch(JSON.stringify(brief), /СЕКРЕТ ТОЛЬКО ДЛЯ HERO/u)
  }
})

test('нарушенное обещание из AdvanceTime доходит до NarrationBrief как подтверждённое последствие', async () => {
  const state = campaign({
    social: {
      npcs: [{ id: 'marta', name: 'Марта', role: 'свидетель', location: 'Северные ворота', available: true }],
      relationships: { marta: { hero: 5 } }, conversations: [],
      promises: [{
        id: 'promise:late', npc_id: 'marta', hero_id: 'hero', direction: 'npc_to_party',
        text: 'Марта принесёт карту к рассвету.', due_hint: 'через 1 минуту', status: 'open', visibility: 'specific_player',
        source_conversation_id: '', created_at_minutes: 0, deadline_minutes: 1,
      }],
    },
    mechanics: { world_time: { elapsed_minutes: 0 } },
  })
  const { brief, response } = await runNarration(state, 'hero', { command_type: 'AdvanceTime', amount: 1, unit: 'minute' })
  const consequence = brief.known_environment.social_consequences.find((entry) => entry.promise_id === 'promise:late')

  assert.deepEqual(consequence, {
    promise_id: 'promise:late', status: 'broken', npc_id: 'marta', direction: 'npc_to_party',
    text: 'Марта принесёт карту к рассвету.', consequence_delta: -8,
  })
  assert.ok(brief.visible_events.some((event) => event.event_type === 'NpcPromiseResolved' && event.payload.status === 'broken'))

  const directorRequests = []
  await new DirectorAgent({ llmClient: { completeJson: async (input) => {
    directorRequests.push(input)
    return { type: 'continue_exploration', reason: 'Сохранить причинную линию обещания.' }
  } } }).choose({ state: response.authoritative_state, playerAction: 'Продолжить путь после задержки Марты' })
  assert.match(directorRequests[0].messages[1].content, /promise:late/u)
  assert.match(directorRequests[0].messages[1].content, /Марта принесёт карту к рассвету/u)
})

test('retrieval памяти сохраняет один и тот же порядок на фиксированном наборе фактов', () => {
  const state = campaign({ worldMemory: memoryWithFacts() })
  const options = { query: 'северная дорога караван', limit: 4 }
  const first = retrieveWorldMemory(state.worldMemory, { playerId: 'rogue', isPartyMember: true }, options)
  const second = retrieveWorldMemory(state.worldMemory, { playerId: 'rogue', isPartyMember: true }, options)

  assert.deepEqual(second, first)
  assert.deepEqual(first.filter((entry) => entry.kind === 'fact').map((entry) => entry.id), ['fact:party-route'])
})
