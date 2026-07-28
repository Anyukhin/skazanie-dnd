import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator, NPC_REACTION_LIMIT, narrationNpcReactions } from '../server/game-orchestrator.mjs'
import { applyGameEvent, normalizeCampaignState, RulesEngine } from '../server/rules-engine.mjs'

const npc = (id, name, relationship) => ({ id, name, relationship })

test('реакция по умолчанию выводится из отношения NPC к смотрящему герою', () => {
  const reactions = narrationNpcReactions([
    npc('npc:mira', 'Мира', 'friendly'),
    npc('npc:grim', 'Грим', 'hostile'),
    npc('npc:tam', 'Там', 'neutral'),
  ], [])
  assert.deepEqual(reactions.map((entry) => entry.reaction), ['welcoming', 'cold', 'attentive'])
  assert.ok(reactions.every((entry) => entry.description), 'у каждой реакции обязано быть описание для рассказчика')
})

test('исход социальной проверки перекрывает отношение — но только у своего NPC', () => {
  const events = [{
    event_type: 'AbilityCheckResolved', actor_id: 'hero',
    payload: { ability: 'cha', skill: 'persuasion', total: 17, difficulty: 12, success: true, social_check: { check_id: 'c1', npc_id: 'npc:grim', skill: 'persuasion' } },
  }]
  const reactions = narrationNpcReactions([npc('npc:mira', 'Мира', 'friendly'), npc('npc:grim', 'Грим', 'hostile')], events)
  assert.equal(reactions.find((entry) => entry.npc_id === 'npc:grim').reaction, 'persuaded')
  assert.equal(reactions.find((entry) => entry.npc_id === 'npc:mira').reaction, 'welcoming')
})

test('проваленная социальная проверка не превращается в согласие', () => {
  const events = [{
    event_type: 'AbilityCheckResolved', actor_id: 'hero',
    payload: { ability: 'cha', skill: 'persuasion', total: 8, difficulty: 15, success: false, social_check: { check_id: 'c2', npc_id: 'npc:mira', skill: 'persuasion' } },
  }]
  const reactions = narrationNpcReactions([npc('npc:mira', 'Мира', 'trusted')], events)
  assert.equal(reactions[0].reaction, 'unconvinced')
})

test('насилие в сцене перекрывает и отношение, и исход проверки', () => {
  const events = [
    { event_type: 'DamageApplied', actor_id: 'hero', payload: { amount: 5 } },
    { event_type: 'AbilityCheckResolved', actor_id: 'hero', payload: { success: true, social_check: { check_id: 'c3', npc_id: 'npc:mira', skill: 'persuasion' } } },
  ]
  const reactions = narrationNpcReactions([npc('npc:mira', 'Мира', 'trusted')], events)
  assert.equal(reactions[0].reaction, 'alarmed')
})

test('реакций не больше предела, даже когда NPC в сцене много', () => {
  const many = Array.from({ length: 9 }, (_, index) => npc(`npc:${index}`, `Гость ${index}`, 'neutral'))
  assert.equal(narrationNpcReactions(many, []).length, NPC_REACTION_LIMIT)
})

test('без NPC в сцене список реакций пуст — рассказчику нечего показывать', () => {
  assert.deepEqual(narrationNpcReactions([], []), [])
})

test('NarrationBrief оркестратора несёт разрешённые реакции присутствующих NPC', async () => {
  const state = normalizeCampaignState({
    sessionCode: 'NPC-REACTIONS',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    scene: { title: 'Трактир', location: 'Трактир «Пустой кубок»', objective: 'Расспросить хозяйку', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, abilities: { cha: 14 }, inventory: [] }],
    social: {
      npcs: [
        { id: 'npc:mira', name: 'Мира', role: 'хозяйка', location: 'Трактир «Пустой кубок»', public_summary: 'Знает всех.', voice: 'Быстро.', visibility: 'party', available: true },
        { id: 'npc:far', name: 'Страж заставы', role: 'страж', location: 'Дальняя застава', public_summary: 'Далеко.', voice: 'Сухо.', visibility: 'party', available: true },
      ],
      relationships: { 'npc:mira': { hero: 30 } },
      promises: [], conversations: [],
    },
  })
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-reactions-'))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
  })
  await eventStore.initializeCampaign({ campaign_id: state.sessionCode, initial_state: state })
  let brief = null
  const orchestrator = new GameOrchestrator({
    intentParser: { parse: async ({ message }) => ({
      actor_id: 'hero', intent: 'free_action', approach: 'test', targets: [], mentioned_entities: [],
      missing_information: [], requires_clarification: false, confidence: 1, raw_message: message,
    }) },
    adjudicator: { createPlan: async () => ({
      rule_ids: [], proposed_commands: [{ command_type: 'ApplyHealing', actor_id: 'hero', amount: 1 }],
      roll_requests: [], ruling_required: false, ruling_draft: null, narration_constraints: [], confidence: 1,
    }) },
    narrator: { render: async (value) => {
      brief = value
      return { narration: 'Подтверждённое последствие.', suggestions: [], verification: { valid: true }, provider: 'test' }
    } },
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([]) }) }),
    eventStore,
    idFactory: () => 'reaction-turn',
  })
  await orchestrator.handle({
    state, campaignId: state.sessionCode, playerId: 'hero', message: 'Осматриваюсь в зале',
    idempotencyKey: 'npc-reactions-1', user: { role: 'player' },
  })
  assert.ok(brief)
  // Только NPC текущей локации: страж дальней заставы в списке не появляется.
  assert.deepEqual(brief.permitted_npc_reactions.map((entry) => entry.npc_id), ['npc:mira'])
  assert.equal(brief.permitted_npc_reactions[0].reaction, 'welcoming')
})
