import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ensureNpcSocialState, npcProfileAtWorldTime, relationshipTier, npcBehaviorPolicy } from './npc-social.mjs'
import { agentContextMetadata, boundedSelectionMetadata, campaignConceptForAgent, sceneContextForAgent } from './agent-context.mjs'
import { promptForModel } from './model-style-profiles.mjs'
import { buildDataOnlyContext } from './security.mjs'
import { tavernTableMood } from './tavern-life.mjs'
import { retrieveWorldMemory } from './world-memory.mjs'

export const NPC_SOCIAL_PROMPT_VERSION = 'npc_controller/social-v5'
const prompt = readFileSync(fileURLToPath(new URL('../prompts/npc_controller/social_v5.txt', import.meta.url)), 'utf8')
const STANCES = new Set(['friendly', 'neutral', 'guarded', 'hostile'])
const DIRECTIONS = new Set(['npc_to_party', 'party_to_npc'])
export const NPC_SOCIAL_MEMORY_LIMIT = 8

const NPC_SOCIAL_RESPONSE_FIELDS = new Set([
  'npc_id', 'reply', 'stance', 'disclosed_fact_ids', 'disclosed_claim_ids',
  'relationship_delta', 'promise', 'confidence',
])

const clean = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

function structurallyValidSocialResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !NPC_SOCIAL_RESPONSE_FIELDS.has(key))) return false
  if (typeof value.reply !== 'string' || value.reply.trim() === '') return false
  if (Object.hasOwn(value, 'npc_id') && typeof value.npc_id !== 'string') return false
  if (Object.hasOwn(value, 'stance') && !STANCES.has(value.stance)) return false
  for (const key of ['disclosed_fact_ids', 'disclosed_claim_ids']) {
    if (Object.hasOwn(value, key) && (!Array.isArray(value[key]) || !value[key].every((entry) => typeof entry === 'string'))) return false
  }
  if (Object.hasOwn(value, 'relationship_delta')
    && (typeof value.relationship_delta !== 'number' || !Number.isFinite(value.relationship_delta))) return false
  if (Object.hasOwn(value, 'confidence')
    && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence))) return false
  if (Object.hasOwn(value, 'promise') && value.promise !== null) {
    const promise = value.promise
    if (!promise || typeof promise !== 'object' || Array.isArray(promise)
      || Object.keys(promise).some((key) => !['direction', 'text', 'due_hint'].includes(key))
      || !DIRECTIONS.has(promise.direction)
      || typeof promise.text !== 'string' || promise.text.trim() === ''
      || typeof promise.due_hint !== 'string' || promise.due_hint.trim() === '') return false
  }
  return true
}

function selectionFields(metadata, prefix) {
  return {
    [`${prefix}_scope`]: metadata.scope,
    [`${prefix}_status`]: metadata.status,
    [`${prefix}_availability`]: metadata.availability,
    [`${prefix}_complete_within_scope`]: metadata.complete_within_scope,
    ...(metadata.truncation_reason ? { [`${prefix}_truncation_reason`]: metadata.truncation_reason } : {}),
  }
}

function stableId(namespace, ...parts) {
  const digest = createHash('sha256').update(parts.map((part) => clean(part, 1_000)).join('\0')).digest('hex').slice(0, 24)
  return `${namespace}:${digest}`
}

function npcSpeakableFactRecords(state, profile) {
  const allowedIds = new Set(profile.known_fact_ids ?? [])
  for (const fact of state.worldMemory?.facts ?? []) if (['public', 'party'].includes(fact.visibility)) allowedIds.add(String(fact.id))
  return (state.worldMemory?.facts ?? []).filter((fact) => fact.status === 'active' && allowedIds.has(String(fact.id)))
}

function npcSpeakableClaimRecords(state, profile) {
  return (state.worldMemory?.epistemic_claims ?? [])
    .filter((claim) => String(claim.holder_entity_id) === String(profile.id))
}

function retrievalMemory(state, { facts = [], claims = [] } = {}) {
  return {
    ...(state.worldMemory ?? {}),
    facts,
    relationships: [],
    quests: [],
    threads: [],
    epistemic_claims: claims,
    summaries: [],
  }
}

function npcFacts(state, profile, message = '') {
  const speakable = npcSpeakableFactRecords(state, profile)
  const allowedIds = new Set(speakable.map((fact) => String(fact.id)))
  const records = retrieveWorldMemory(retrievalMemory(state, { facts: speakable }), { isAdmin: true }, {
    query: clean(message, 1_000), limit: NPC_SOCIAL_MEMORY_LIMIT,
  })
  return records.filter((record) => record.kind === 'fact' && allowedIds.has(String(record.fact?.id))).map((record) => ({
    id: String(record.fact.id),
    subject: clean(record.entity?.name, 160),
    summary: clean(record.fact.summary || record.fact.object, 500),
  }))
}

function npcClaims(state, profile, message = '') {
  const speakable = npcSpeakableClaimRecords(state, profile)
  const allowedIds = new Set(speakable.map((claim) => String(claim.id)))
  const records = retrieveWorldMemory(retrievalMemory(state, { claims: speakable }), { isAdmin: true }, {
    query: clean(message, 1_000), limit: NPC_SOCIAL_MEMORY_LIMIT,
  })
  return records.filter((record) => ['belief', 'rumor'].includes(record.kind) && allowedIds.has(String(record.claim?.id))).map((record) => ({
    id: String(record.claim.id),
    kind: record.claim.kind === 'rumor' ? 'rumor' : 'belief',
    summary: clean(record.claim.summary || record.claim.claim, 500),
    truth_status: ['confirmed', 'refuted'].includes(record.claim.truth_status) ? record.claim.truth_status : 'unknown',
  }))
}

function privateKnowledgeUsed(state, profile, facts, claims, disclosedFactIds = [], disclosedClaimIds = []) {
  const privateFactIds = new Set(npcSpeakableFactRecords(state, profile)
    .filter((fact) => !['public', 'party'].includes(fact.visibility))
    .map((fact) => String(fact.id)))
  const privateClaimIds = new Set(npcSpeakableClaimRecords(state, profile)
    .filter((claim) => !['public', 'party'].includes(claim.visibility))
    .map((claim) => String(claim.id)))
  return facts.some((fact) => privateFactIds.has(String(fact.id)))
    || claims.some((claim) => privateClaimIds.has(String(claim.id)))
    || disclosedFactIds.some((factId) => privateFactIds.has(String(factId)))
    || disclosedClaimIds.some((claimId) => privateClaimIds.has(String(claimId)))
}

function heroName(state, heroId) {
  const expected = String(heroId ?? '')
  const hero = (state.players ?? []).find((player) => String(player?.id ?? '') === expected)
  return clean(hero?.character || hero?.name, 120) || expected
}

function conversationVisibleTo(entry, playerId) {
  return entry.visibility === 'party'
    || (entry.visibility === 'specific_player' && String(entry.hero_id) === String(playerId))
}

function memoryTerms(value) {
  return new Set(clean(value, 1_000).toLocaleLowerCase('ru').match(/[\p{L}\p{N}]{4,}/gu) ?? [])
}

function relevantNpcMemory(social, profile, playerId, message) {
  const query = memoryTerms(message)
  const score = (text) => [...memoryTerms(text)].filter((term) => query.has(term)).length
  const conversations = social.conversations
    .filter((entry) => entry.npc_id === profile.id && conversationVisibleTo(entry, playerId))
    .map((entry, index) => ({ entry, relevance: score(`${entry.player_message} ${entry.npc_reply}`), recency: index }))
  const dossiers = (profile.dossier ?? [])
    .filter((entry) => entry.visibility === 'party' || (entry.visibility === 'specific_player' && String(entry.hero_id) === String(playerId)))
    .map((entry, index) => ({ entry, relevance: score(entry.summary), recency: index, dossier: true }))
  return [...conversations, ...dossiers].sort((a, b) => b.relevance - a.relevance || b.recency - a.recency).slice(0, 8).map(({ entry, dossier }) => dossier
    ? { kind: 'dossier', id: entry.id, hero_id: entry.hero_id, summary: entry.summary, stance: entry.stance }
    : { kind: 'conversation', id: entry.id, hero_id: entry.hero_id, player_message: entry.player_message, npc_reply: entry.npc_reply, stance: entry.stance })
}

function privateNpcContextUsed(social, profile, playerId) {
  return social.conversations.some((entry) => entry.npc_id === profile.id
    && entry.hero_id === playerId && entry.visibility === 'specific_player')
    || (profile.dossier ?? []).some((entry) => entry.visibility === 'specific_player'
      && String(entry.hero_id) === String(playerId))
}

function briefFor(state, profile, playerId, message, checkOutcome = null) {
  const social = ensureNpcSocialState(state.social, state)
  const currentConversation = social.conversations
    .filter((entry) => entry.npc_id === profile.id
      && entry.hero_id === playerId
      && conversationVisibleTo(entry, playerId))
  const partyConversation = social.conversations
    .filter((entry) => entry.npc_id === profile.id
      && entry.hero_id !== playerId
      && conversationVisibleTo(entry, playerId))
  const openPromises = social.promises
    .filter((entry) => entry.npc_id === profile.id && entry.hero_id === playerId && entry.status === 'open')
  const relevantMemory = relevantNpcMemory(social, profile, playerId, message)
  const speakableFacts = npcFacts(state, profile, message)
  const speakableClaims = npcClaims(state, profile, message)
  const relevantMemoryCandidateCount = currentConversation.length
    + (profile.dossier ?? []).filter((entry) => entry.visibility === 'party'
      || (entry.visibility === 'specific_player' && String(entry.hero_id) === String(playerId))).length
  const speakableFactCount = npcSpeakableFactRecords(state, profile).length
  const speakableClaimCount = npcSpeakableClaimRecords(state, profile).length
  const factSelection = boundedSelectionMetadata({ scope: 'facts_known_to_npc_and_available_for_dialogue', candidateCount: speakableFactCount, limit: NPC_SOCIAL_MEMORY_LIMIT })
  const claimSelection = boundedSelectionMetadata({ scope: 'claims_held_by_npc_and_available_for_dialogue', candidateCount: speakableClaimCount, limit: NPC_SOCIAL_MEMORY_LIMIT })
  const promiseSelection = boundedSelectionMetadata({ scope: 'open_promises_between_npc_and_active_hero', candidateCount: openPromises.length, limit: 10 })
  const conversationSelection = boundedSelectionMetadata({ scope: 'visible_conversation_with_active_hero', candidateCount: currentConversation.length, limit: 6 })
  const partyConversationSelection = boundedSelectionMetadata({ scope: 'party_visible_conversation_with_other_heroes', candidateCount: partyConversation.length, limit: 4 })
  const memorySelection = boundedSelectionMetadata({ scope: 'visible_relevant_npc_memory', candidateCount: relevantMemoryCandidateCount, limit: NPC_SOCIAL_MEMORY_LIMIT })
  return {
    context_metadata: agentContextMetadata(state, { role: 'npc_social', actorId: playerId, targetId: profile.id, contractVersion: NPC_SOCIAL_PROMPT_VERSION }),
    campaign_premise: campaignConceptForAgent(state),
    // NPC знает, где идёт разговор: сцена делает реплику местной, а не общей.
    scene: {
      title: clean(state.scene?.title, 160),
      location: clean(state.scene?.location, 180),
      mood: clean(state.scene?.mood, 160),
      spatial_context: sceneContextForAgent(state, playerId).spatial_context,
    },
    // Цели и убеждения профиля намеренно не передаются: всё, что уходит в
    // модель, может дословно оказаться в реплике перед игроком, поэтому бриф
    // держит только party-видимые поля. Характер выражают voice и summary.
    npc: {
      id: profile.id, name: profile.name, role: profile.role,
      public_summary: profile.public_summary, voice: profile.voice,
      speech_profile: profile.speech_profile,
      behavior_policy: npcBehaviorPolicy(profile, social.relationships[profile.id]?.[playerId] ?? 0),
    },
    relationship: {
      score: social.relationships[profile.id]?.[playerId] ?? 0,
      tier: relationshipTier(social.relationships[profile.id]?.[playerId] ?? 0),
    },
    // Застолье собеседник видит: перед ним человек с кружкой, и разговор от
    // этого другой. Данными, а не числом в СЛ — проверку это не подменяет, её
    // считает Rules Engine той же прибавкой, что показал ручной бросок.
    table: tavernTableMood(state, playerId),
    open_promises: openPromises
      .slice(-10)
      .map((entry) => ({ id: entry.id, direction: entry.direction, text: entry.text, due_hint: entry.due_hint })),
    recent_conversation: currentConversation
      .slice(-6)
      .map((entry) => ({ player_message: entry.player_message, npc_reply: entry.npc_reply, stance: entry.stance, ...(entry.check ? { check: { skill: entry.check.skill, success: entry.check.success, degree: entry.check.degree } } : {}) })),
    // NPC помнит отряд, а не одно лицо: последние разговоры с другими героями
    // видимы группе (visibility: party) и приходят с именем собеседника.
    recent_party_conversation: partyConversation
      .slice(-4)
      .map((entry) => ({ hero: heroName(state, entry.hero_id), player_message: entry.player_message, npc_reply: entry.npc_reply, stance: entry.stance })),
    // Релевантный архив дополняет короткое окно последних реплик; visibility
    // проверяется до ранжирования, поэтому чужая личная беседа не просачивается.
    relevant_memory: relevantMemory,
    speakable_facts: speakableFacts,
    speakable_claims: speakableClaims,
    ...selectionFields(conversationSelection, 'recent_conversation'),
    ...selectionFields(partyConversationSelection, 'recent_party_conversation'),
    ...selectionFields(memorySelection, 'relevant_memory'),
    ...selectionFields(factSelection, 'speakable_facts'),
    ...selectionFields(claimSelection, 'speakable_claims'),
    ...selectionFields(promiseSelection, 'open_promises'),
    player_message: clean(message, 1_000),
    resolved_check: checkOutcome ? { skill: checkOutcome.skill, ability: checkOutcome.ability, success: checkOutcome.success, degree: checkOutcome.degree } : null,
  }
}

/**
 * Детерминированный ответ, когда модели нет или она не ответила.
 *
 * Слух здесь не украшение, а единственная дорога дошедшей молвы к столу: она
 * пишется `gm_only` и из проекции состояния игроку не видна — он узнаёт её
 * только из уст NPC (`server/world-deeds.mjs`). Пока фолбэк молчал о слухах,
 * вторая половина петли обрывалась ровно на последнем шаге: слух доходил до
 * держателя и там умирал.
 *
 * Порядок источников — от твёрдого к зыбкому: сначала факт, который NPC знает,
 * потом молва, за которую он не отвечает. Возвращается и список раскрытых
 * утверждений: реплика и провенанс расходиться не должны.
 *
 * @returns {{ reply: string, claimIds: string[] }}
 */
function fallbackDisclosure(profile, facts, claims, checkOutcome = null, memory = [], message = '') {
  // Исход проверки — механика, а не разговор: раскрывать по нему нечего.
  if (checkOutcome?.skill === 'insight') return { reply: checkOutcome.success ? `${profile.name}: the hero notices a meaningful reaction.` : `${profile.name}: the hero cannot read the NPC's motives.`, claimIds: [] }
  if (checkOutcome) return { reply: checkOutcome.success ? `${profile.name} accepts the hero's approach.` : `${profile.name} is not convinced.`, claimIds: [] }
  const request = clean(message, 1_000).toLocaleLowerCase('ru')
  if (/(?:пообещ|обещани|помоги|проведи|передай|открой)/iu.test(request)) {
    return { reply: 'Нового обещания пока нет; уточним конкретную помощь.', claimIds: [] }
  }
  if (/(?:напомни|вспомни|сигнал|договор|обещал|что мы)/iu.test(request)) {
    const remembered = memory.find((entry) => entry.kind === 'conversation' && entry.npc_reply)
    if (remembered) return { reply: `${profile.name} напоминает: «${clean(remembered.npc_reply, 500)}»`, claimIds: [] }
  }
  if (facts.length) return { reply: `${profile.name} отвечает: «${facts[0].summary}»`, claimIds: [] }
  const rumor = claims.find((claim) => claim.kind === 'rumor')
  if (rumor) return { reply: `${profile.name} понижает голос: «${rumor.summary}»`, claimIds: [rumor.id] }
  const belief = claims[0]
  if (belief) return { reply: `${profile.name} отвечает: «${belief.summary}»`, claimIds: [belief.id] }
  return { reply: `${profile.name} выслушивает героя, но не сообщает ничего нового.`, claimIds: [] }
}

function promiseWithinBoundary(promise, profile) {
  const text = clean(promise?.text, 500).toLocaleLowerCase('ru')
  const policy = npcBehaviorPolicy(profile).boundaries
  if (policy.protects_people && /убить|убью|напад|пытк|погуб|выдам\s+людей/iu.test(text)) return false
  if (policy.keeps_secrets && /раскро|выдам|расскажу|сообщу\s+тайн|открою\s+секрет/iu.test(text)) return false
  return true
}

function normalizedResult(raw, profile, state, playerId, message, turnId, checkOutcome = null) {
  const social = ensureNpcSocialState(state.social, state)
  const facts = npcFacts(state, profile, message)
  const memory = relevantNpcMemory(social, profile, playerId, message)
  const claims = npcClaims(state, profile, message)
  const allowedFactIds = new Set(npcSpeakableFactRecords(state, profile).map((fact) => String(fact.id)))
  const disclosedFactIds = [...new Set((Array.isArray(raw?.disclosed_fact_ids) ? raw.disclosed_fact_ids : [])
    .map(String).filter((factId) => allowedFactIds.has(factId)))].slice(0, 20)
  const allowedClaimIds = new Set(npcSpeakableClaimRecords(state, profile).map((claim) => String(claim.id)))
  const modelReply = typeof raw?.reply === 'string' ? clean(raw.reply, 1_000) : ''
  const fallback = fallbackDisclosure(profile, facts, claims, checkOutcome, memory, message)
  // Раскрытие фолбэка добавляется только тогда, когда прозвучала его реплика:
  // иначе провенанс обещал бы то, чего NPC не говорил.
  const disclosedClaimIds = [...new Set([
    ...(Array.isArray(raw?.disclosed_claim_ids) ? raw.disclosed_claim_ids : []).map(String),
    ...(modelReply ? [] : fallback.claimIds),
  ].filter((claimId) => allowedClaimIds.has(claimId)))].slice(0, 20)
  const responseVisibility = privateNpcContextUsed(social, profile, playerId)
    || privateKnowledgeUsed(state, profile, facts, claims, disclosedFactIds, disclosedClaimIds)
    ? 'specific_player'
    : 'party'
  const reply = modelReply || fallback.reply
  const stance = STANCES.has(raw?.stance) ? raw.stance : 'neutral'
  let relationshipDelta = Math.max(-2, Math.min(2, Number.isSafeInteger(Number(raw?.relationship_delta)) ? Number(raw.relationship_delta) : 0))
  let promise = null
  if (raw?.promise && typeof raw.promise === 'object' && !Array.isArray(raw.promise) && DIRECTIONS.has(raw.promise.direction)) {
    const promiseText = clean(raw.promise.text, 500)
    const dueHint = clean(raw.promise.due_hint, 240)
    if (promiseText && dueHint && promiseWithinBoundary({ ...raw.promise, text: promiseText }, profile)) promise = {
      id: stableId('promise', turnId, profile.id, playerId, promiseText),
      direction: raw.promise.direction,
      text: promiseText,
      due_hint: dueHint,
      visibility: responseVisibility,
    }
  }
  if (checkOutcome?.skill === 'insight') {
    relationshipDelta = 0
    promise = null
  } else if (checkOutcome && !checkOutcome.success) {
    relationshipDelta = Math.min(0, relationshipDelta)
    promise = null
  }
  return {
    npc_id: profile.id,
    reply,
    stance,
    disclosed_fact_ids: disclosedFactIds,
    disclosed_claim_ids: disclosedClaimIds,
    relationship_delta: relationshipDelta,
    promise,
    confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0)),
    visibility: responseVisibility,
    conversation: {
      id: stableId('conversation', turnId, profile.id, playerId),
      npc_id: profile.id,
      hero_id: playerId,
      player_message: clean(message, 1_000),
      npc_reply: reply,
      stance,
      disclosed_fact_ids: disclosedFactIds,
      disclosed_claim_ids: disclosedClaimIds,
      relationship_delta: relationshipDelta,
      visibility: responseVisibility,
      ...(promise ? { promise } : {}),
      ...(checkOutcome ? { check: checkOutcome } : {}),
    },
  }
}

export class NpcSocialController {
  constructor({ llmClient = null } = {}) {
    this.llmClient = llmClient
  }

  async respond({ state = {}, playerId = '', npcId = '', message = '', turnId = '', checkOutcome = null } = {}) {
    const social = ensureNpcSocialState(state.social, state)
    const persistedProfile = social.npcs.find((npc) => npc.id === String(npcId))
    const profile = persistedProfile ? npcProfileAtWorldTime(persistedProfile, state) : null
    if (!profile || profile.available === false) return null
    const contextMetadata = agentContextMetadata(state, { role: 'npc_social', actorId: playerId, targetId: profile.id, contractVersion: NPC_SOCIAL_PROMPT_VERSION })
    const facts = npcFacts(state, profile, message)
    if (!this.llmClient) return {
      ...normalizedResult({}, profile, state, String(playerId), message, turnId, checkOutcome),
      context_metadata: contextMetadata,
      provider: 'deterministic-social-fallback',
      prompt_version: NPC_SOCIAL_PROMPT_VERSION,
    }
    try {
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: promptForModel(prompt, this.llmClient) },
          { role: 'user', content: buildDataOnlyContext({ npc_social_brief: briefFor(state, profile, String(playerId), message, checkOutcome) }) },
        ],
        temperature: 0.7,
        maxTokens: 700,
      }, { timeoutMs: 20_000 })
      if (!structurallyValidSocialResponse(result)) throw new Error('NPC_SOCIAL_RESPONSE_INVALID_SHAPE')
      return {
        ...normalizedResult(result, profile, state, String(playerId), message, turnId, checkOutcome),
        context_metadata: contextMetadata,
        provider: this.llmClient.constructor?.name ?? 'llm',
        prompt_version: NPC_SOCIAL_PROMPT_VERSION,
      }
    } catch (error) {
      return {
        ...normalizedResult({}, profile, state, String(playerId), message, turnId, checkOutcome),
        context_metadata: contextMetadata,
        provider: 'deterministic-social-fallback',
        prompt_version: NPC_SOCIAL_PROMPT_VERSION,
        provider_error: clean(error?.code ?? error?.name ?? 'LLM_PROVIDER_ERROR', 80),
        facts_available: facts.length,
      }
    }
  }
}
