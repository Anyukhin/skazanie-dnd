import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { answerKnownLore } from '../server/player-request-router.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { FileTraceStore } from '../server/trace-store.mjs'

function dialogueOrchestrator({ discussed } = {}) {
  const traceStore = new FileTraceStore({ rootDir: join(mkdtempSync(join(tmpdir(), 'skazanie-dialogue-trace-')), 'traces') })
  const orchestrator = Object.create(GameOrchestrator.prototype)
  orchestrator.traceStore = traceStore
  orchestrator.narrationMemory = new Map()
  orchestrator.actionAdjudicator = { discuss: discussed ?? (async () => { throw new Error('discussion must stay silent') }) }
  orchestrator.clarificationRegistry = {
    recentDialogue: () => [],
    rememberDialogue: () => {},
  }
  orchestrator.now = () => 150
  return { orchestrator, traceStore }
}

const state = {
  state_version: 3,
  scene: { title: 'Зал', location: 'Зал' },
  adventure: {},
  worldMemory: { facts: [], quests: [], threads: [], knowledge_ledger: [], knowledge_revealed: [] },
}

test('question сохраняет режим table_talk и upstream источника обсуждения', async () => {
  const { orchestrator, traceStore } = dialogueOrchestrator({
    discussed: async () => ({
      narration: 'Можно обсудить безопасный способ.',
      reading: { source: 'agent-adjudicator' },
    }),
  })
  const result = await orchestrator.nonActionResponse({
    campaignId: 'DIALOGUE-TRACE', playerId: 'hero', requestKind: 'question',
    message: 'Можно ли отвлечь собеседника стуком по столу?', state,
    turnId: 'turn-question', mode: 'enforce', viewer: { playerId: 'hero', isPartyMember: true },
    idempotencyKey: 'question-trace', started: 100,
  })

  assert.equal(result.provider, 'deterministic-dialogue')
  assert.equal(result.turn_consumed, false)
  assert.deepEqual(result.verification.response_plan, {
    version: 'dialogue-response-plan/v1', mode: 'table_talk', speech_act: 'answer_question',
  })
  assert.deepEqual(result.verification.origin, {
    source: 'template', reason: 'server_policy', upstream: 'agent-adjudicator',
  })
  const trace = traceStore.get('DIALOGUE-TRACE', 'turn-question')
  assert.equal(trace.narration_result.narration, result.narration)
  assert.deepEqual(trace.narration_result.verification.origin, result.verification.origin)
  assert.equal(trace.prompt_versions.narrator, null)
  assert.equal(trace.state_version_before, 3)
  assert.equal(trace.state_version_after, 3)
})

test('discussion остаётся silence и всё равно получает trace provenance', async () => {
  const { orchestrator, traceStore } = dialogueOrchestrator()
  const result = await orchestrator.nonActionResponse({
    campaignId: 'DIALOGUE-SILENCE', playerId: 'hero', requestKind: 'discussion',
    message: 'Давайте подождём товарища', state,
    turnId: 'turn-discussion', mode: 'enforce', viewer: { playerId: 'hero', isPartyMember: true },
    idempotencyKey: 'discussion-trace', started: 100,
  })

  assert.equal(result.narration, '')
  assert.equal(result.verification.response_plan.mode, 'silence')
  assert.equal(result.verification.response_plan.speech_act, 'none')
  assert.deepEqual(result.verification.origin, {
    source: 'template', reason: 'server_policy', upstream: 'party-chat',
  })
  const trace = traceStore.get('DIALOGUE-SILENCE', 'turn-discussion')
  assert.equal(trace.narration_result.narration, '')
  assert.equal(trace.narration_result.verification.response_plan.mode, 'silence')
})

test('question trace не перезаписывает механический trace при повторном idempotency key', async () => {
  const { orchestrator, traceStore } = dialogueOrchestrator({
    discussed: async () => ({ narration: 'Ответ.', reading: { source: 'deterministic-default' } }),
  })
  traceStore.save({
    turn_id: 'turn-collision', campaign_id: 'DIALOGUE-COLLISION', state_version_before: 1, state_version_after: 2,
    events: [{ event_type: 'DamageApplied' }], narration_result: { narration: 'Механический ход.' },
  })
  await orchestrator.nonActionResponse({
    campaignId: 'DIALOGUE-COLLISION', playerId: 'hero', requestKind: 'question',
    message: 'Почему?', state, turnId: 'turn-collision', mode: 'enforce',
    viewer: { playerId: 'hero', isPartyMember: true }, idempotencyKey: 'collision', started: 100,
  })

  assert.deepEqual(traceStore.get('DIALOGUE-COLLISION', 'turn-collision').events, [{ event_type: 'DamageApplied' }])
})

test('table_talk trace не попадает в recent narration memory', () => {
  const { orchestrator, traceStore } = dialogueOrchestrator()
  traceStore.save({
    turn_id: 'turn-mechanics-memory', campaign_id: 'DIALOGUE-MEMORY', created_at: '2026-09-09T10:00:01.000Z',
    events: [{ event_type: 'DamageApplied' }], narration_result: { narration: 'Механический итог.' },
  })
  traceStore.save({
    turn_id: 'turn-table-memory', campaign_id: 'DIALOGUE-MEMORY', created_at: '2026-09-09T10:00:02.000Z',
    narration_result: {
      narration: 'Личный ответ игроку.',
      verification: { response_plan: { mode: 'table_talk' } },
    },
  })

  assert.deepEqual(orchestrator.recentNarrationsFor('DIALOGUE-MEMORY'), ['Механический итог.'])
  assert.deepEqual(orchestrator.explanation('DIALOGUE-MEMORY').events, [{ event_type: 'DamageApplied' }])
})

function freeActionState() {
  return normalizeCampaignState({
    sessionCode: 'FREE-META', activePlayerId: 'hero',
    scene: { title: 'Зал', location: 'Зал', objective: 'Осмотреть зал', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, abilities: { str: 14 }, inventory: [] }],
  })
}

function freeActionInput(state, traceStore, narrator) {
  const orchestrator = Object.create(GameOrchestrator.prototype)
  orchestrator.traceStore = traceStore
  orchestrator.narrator = narrator
  orchestrator.recentNarrationsFor = () => []
  orchestrator.rememberNarration = () => {}
  orchestrator.now = () => 200
  return { orchestrator, state }
}

test('free-action trace сохраняет origin и prompt_version Narrator, а template не маскируется под llm', async () => {
  const state = freeActionState()
  const traceStore = new FileTraceStore({ rootDir: join(mkdtempSync(join(tmpdir(), 'skazanie-free-trace-')), 'traces') })
  const renderedVerification = {
    valid: true,
    violations: [],
    response_plan: { version: 'narrator-response-plan/v1', mode: 'world_narration', speech_act: 'report_result' },
    origin: { source: 'llm', reason: 'generated', elapsed_ms: 17 },
  }
  const { orchestrator } = freeActionInput(state, traceStore, {
    render: async () => ({
      narration: 'Подтверждённый итог остаётся прежним.',
      provider: 'TestNarrator',
      prompt_version: 'narrator/v9',
      verification: renderedVerification,
    }),
  })
  const input = {
    freeAction: {
      kind: 'auto_success', state,
      reading: { source: 'agent-adjudicator', goal_summary: 'Проверяю зал', approach_summary: 'внимательно' },
      events: [{ event_type: 'TimeAdvanced', payload: { minutes: 1 }, visibility: 'party' }],
    },
    campaignId: 'FREE-META', playerId: 'hero', viewer: { playerId: 'hero', isPartyMember: true },
    message: 'Проверяю зал', intent: {}, retrievalQueries: [], retrievedRules: { results: [] },
    plan: { narration_constraints: [] }, authoritativeState: state,
    idempotencyKey: 'free-meta-llm', turnId: 'turn-free-llm', started: 100, mode: 'enforce',
  }
  const modelResult = await orchestrator.freeActionResponse(input)
  assert.equal(modelResult.provider, 'TestNarrator')
  assert.equal(modelResult.prompt_version, 'narrator/v9')
  assert.equal(modelResult.verification.origin.source, 'llm')
  assert.equal(modelResult.verification.response_plan.speech_act, 'report_result')
  assert.equal(traceStore.get('FREE-META', 'turn-free-llm').narration_result.prompt_version, 'narrator/v9')

  const templateTraceStore = new FileTraceStore({ rootDir: join(mkdtempSync(join(tmpdir(), 'skazanie-free-template-')), 'traces') })
  const { orchestrator: templateOrchestrator } = freeActionInput(state, templateTraceStore, {
    render: async () => ({
      narration: 'Провайдер недоступен.', provider: 'deterministic', prompt_version: 'narrator/v9',
      verification: { valid: true, violations: [], origin: { source: 'template', reason: 'no_provider', elapsed_ms: 0 } },
    }),
  })
  const templateResult = await templateOrchestrator.freeActionResponse({
    ...input,
    idempotencyKey: 'free-meta-template', turnId: 'turn-free-template',
  })
  assert.equal(templateResult.verification.origin.source, 'template')
  assert.equal(templateResult.verification.origin.reason, 'no_provider')
  assert.equal(templateResult.prompt_version, 'deterministic-free-action/v1')
  assert.notEqual(templateResult.verification.origin.source, 'llm')
})

test('free-action template сохраняет codes rejection и provider_error Narrator', async () => {
  const state = freeActionState()
  const traceStore = new FileTraceStore({ rootDir: join(mkdtempSync(join(tmpdir(), 'skazanie-free-rejection-')), 'traces') })
  const { orchestrator } = freeActionInput(state, traceStore, {
    render: async () => ({
      narration: 'Отклонённый черновик.',
      provider: 'deterministic-fallback',
      prompt_version: 'narrator/v9',
      verification: {
        valid: true,
        violations: [],
        repaired_from: [{ code: 'RENDER_GUARD', message: 'raw text must not be retained', match: 'секрет' }],
        provider_error: 'LLM_TIMEOUT',
        response_plan: { version: 'narrator-response-plan/v1', mode: 'world_narration', speech_act: 'report_result' },
        origin: { source: 'template', reason: 'verification_rejected', elapsed_ms: 2 },
      },
    }),
  })
  const result = await orchestrator.freeActionResponse({
    freeAction: {
      kind: 'auto_success', state,
      reading: { source: 'agent-adjudicator', goal_summary: 'Проверяю зал', approach_summary: 'внимательно' },
      events: [{ event_type: 'TimeAdvanced', payload: { minutes: 1 }, visibility: 'party' }],
    },
    campaignId: 'FREE-REJECTION', playerId: 'hero', viewer: { playerId: 'hero', isPartyMember: true },
    message: 'Проверяю зал', intent: {}, retrievalQueries: [], retrievedRules: { results: [] },
    plan: { narration_constraints: [] }, authoritativeState: state,
    idempotencyKey: 'free-rejection', turnId: 'turn-free-rejection', started: 100, mode: 'enforce',
  })

  assert.equal(result.verification.provider_error, 'LLM_TIMEOUT')
  assert.deepEqual(result.verification.repaired_from, [{ code: 'RENDER_GUARD', match: 'секрет' }])
  assert.equal(traceStore.get('FREE-REJECTION', 'turn-free-rejection').narration_result.verification.provider_error, 'LLM_TIMEOUT')
  assert.deepEqual(traceStore.get('FREE-REJECTION', 'turn-free-rejection').narration_result.verification.repaired_from, [{ code: 'RENDER_GUARD', match: 'секрет' }])
})

test('hazard_contact показывает подтверждённый урон после отклонения черновика', async () => {
  const state = freeActionState()
  const traceStore = new FileTraceStore({ rootDir: join(mkdtempSync(join(tmpdir(), 'skazanie-hazard-trace-')), 'traces') })
  const { orchestrator } = freeActionInput(state, traceStore, {
    render: async () => { throw new Error('hazard_contact should use grounded template') },
  })
  const result = await orchestrator.freeActionResponse({
    freeAction: {
      kind: 'hazard_contact',
      state,
      narration: 'Обрушение или тяжёлый предмет — герой получает 5 урона.',
      reading: { source: 'agent-adjudicator', goal_summary: 'Врезаюсь в стену', approach_summary: 'движением' },
      events: [{
        event_type: 'DamageApplied', actor_id: 'hazard', target_ids: ['hero'], visibility: 'party',
        payload: { damage_type: 'bludgeoning', amount: 5, raw_amount: 5, applied_amount: 5, hp_before: 37, hp_after: 32 },
      }],
    },
    campaignId: 'FREE-META', playerId: 'hero', viewer: { playerId: 'hero', isPartyMember: true },
    message: 'Врезаюсь в стену', intent: {}, retrievalQueries: [], retrievedRules: { results: [] },
    plan: { narration_constraints: [] }, authoritativeState: state,
    idempotencyKey: 'hazard-grounded', turnId: 'turn-hazard-grounded', started: 100, mode: 'enforce',
  })

  assert.match(result.narration, /урон|поврежд/iu)
  assert.doesNotMatch(result.narration, /не получило подтверждённого последствия/u)
  assert.equal(result.verification.valid, true)
  assert.ok(result.verification.repaired_from?.length, 'отклонённые нарушения черновика должны попасть в metadata')
  assert.equal(result.verification.origin.reason, 'verification_rejected')
  assert.ok(traceStore.get('FREE-META', 'turn-hazard-grounded').narration_result.verification.repaired_from?.length)
})

test('ответ Хранителя говорит простым языком и не обещает скрытую память', () => {
  const known = answerKnownLore('Что я знаю про архивариуса?', {
    adventure: { currentHook: 'Печать открывает путь к забытому королю' },
  })
  assert.match(known.narration, /Герои уже знают:/u)
  assert.doesNotMatch(known.narration, /Скрытых сведений сверх этой памяти/u)

  const unknown = answerKnownLore('Что я знаю про архивариуса?', {})
  assert.match(unknown.narration, /Пока ничего подтверждённого об этом не известно/u)
})
