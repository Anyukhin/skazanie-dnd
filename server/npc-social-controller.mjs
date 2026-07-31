import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ensureNpcSocialState, npcProfileAtWorldTime, relationshipTier } from './npc-social.mjs'
import { campaignConceptForAgent } from './agent-context.mjs'
import { promptForModel } from './model-style-profiles.mjs'
import { buildDataOnlyContext } from './security.mjs'
import { retrieveWorldMemory } from './world-memory.mjs'

export const NPC_SOCIAL_PROMPT_VERSION = 'npc_controller/social-v3'
const prompt = readFileSync(fileURLToPath(new URL('../prompts/npc_controller/social_v3.txt', import.meta.url)), 'utf8')
const STANCES = new Set(['friendly', 'neutral', 'guarded', 'hostile'])
const DIRECTIONS = new Set(['npc_to_party', 'party_to_npc'])
export const NPC_SOCIAL_MEMORY_LIMIT = 8

const clean = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

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

function heroName(state, heroId) {
  const expected = String(heroId ?? '')
  const hero = (state.players ?? []).find((player) => String(player?.id ?? '') === expected)
  return clean(hero?.character || hero?.name, 120) || expected
}

function conversationVisibleTo(entry, playerId) {
  return entry.visibility === 'party'
    || (entry.visibility === 'specific_player' && String(entry.hero_id) === String(playerId))
}

function briefFor(state, profile, playerId, message, checkOutcome = null) {
  const social = ensureNpcSocialState(state.social, state)
  return {
    campaign_premise: campaignConceptForAgent(state),
    // NPC знает, где идёт разговор: сцена делает реплику местной, а не общей.
    scene: {
      title: clean(state.scene?.title, 160),
      location: clean(state.scene?.location, 180),
      mood: clean(state.scene?.mood, 160),
      objective: clean(state.scene?.objective, 300),
    },
    // Цели и убеждения профиля намеренно не передаются: всё, что уходит в
    // модель, может дословно оказаться в реплике перед игроком, поэтому бриф
    // держит только party-видимые поля. Характер выражают voice и summary.
    npc: {
      id: profile.id, name: profile.name, role: profile.role,
      public_summary: profile.public_summary, voice: profile.voice,
      speech_profile: profile.speech_profile,
    },
    relationship: {
      score: social.relationships[profile.id]?.[playerId] ?? 0,
      tier: relationshipTier(social.relationships[profile.id]?.[playerId] ?? 0),
    },
    open_promises: social.promises
      .filter((entry) => entry.npc_id === profile.id && entry.hero_id === playerId && entry.status === 'open')
      .slice(-10)
      .map((entry) => ({ id: entry.id, direction: entry.direction, text: entry.text, due_hint: entry.due_hint })),
    recent_conversation: social.conversations
      .filter((entry) => entry.npc_id === profile.id
        && entry.hero_id === playerId
        && conversationVisibleTo(entry, playerId))
      .slice(-6)
      .map((entry) => ({ player_message: entry.player_message, npc_reply: entry.npc_reply, stance: entry.stance, ...(entry.check ? { check: { skill: entry.check.skill, success: entry.check.success, degree: entry.check.degree } } : {}) })),
    // NPC помнит отряд, а не одно лицо: последние разговоры с другими героями
    // видимы группе (visibility: party) и приходят с именем собеседника.
    recent_party_conversation: social.conversations
      .filter((entry) => entry.npc_id === profile.id
        && entry.hero_id !== playerId
        && conversationVisibleTo(entry, playerId))
      .slice(-4)
      .map((entry) => ({ hero: heroName(state, entry.hero_id), player_message: entry.player_message, npc_reply: entry.npc_reply, stance: entry.stance })),
    speakable_facts: npcFacts(state, profile, message),
    speakable_claims: npcClaims(state, profile, message),
    player_message: clean(message, 1_000),
    resolved_check: checkOutcome ? { skill: checkOutcome.skill, ability: checkOutcome.ability, success: checkOutcome.success, degree: checkOutcome.degree } : null,
  }
}

function fallbackReply(profile, facts, checkOutcome = null) {
  if (checkOutcome?.skill === 'insight') return checkOutcome.success ? `${profile.name}: the hero notices a meaningful reaction.` : `${profile.name}: the hero cannot read the NPC's motives.`
  if (checkOutcome) return checkOutcome.success ? `${profile.name} accepts the hero's approach.` : `${profile.name} is not convinced.`
  if (facts.length) return `${profile.name} отвечает: «${facts[0].summary}»`
  return `${profile.name} выслушивает героя, но не сообщает ничего нового.`
}

function normalizedResult(raw, profile, state, playerId, message, turnId, checkOutcome = null) {
  const facts = npcFacts(state, profile, message)
  const allowedFactIds = new Set(npcSpeakableFactRecords(state, profile).map((fact) => String(fact.id)))
  const disclosedFactIds = [...new Set((Array.isArray(raw?.disclosed_fact_ids) ? raw.disclosed_fact_ids : [])
    .map(String).filter((factId) => allowedFactIds.has(factId)))].slice(0, 20)
  const claims = npcClaims(state, profile, message)
  const allowedClaimIds = new Set(npcSpeakableClaimRecords(state, profile).map((claim) => String(claim.id)))
  const disclosedClaimIds = [...new Set((Array.isArray(raw?.disclosed_claim_ids) ? raw.disclosed_claim_ids : [])
    .map(String).filter((claimId) => allowedClaimIds.has(claimId)))].slice(0, 20)
  const reply = clean(raw?.reply, 1_000) || fallbackReply(profile, facts, checkOutcome)
  const stance = STANCES.has(raw?.stance) ? raw.stance : 'neutral'
  let relationshipDelta = Math.max(-2, Math.min(2, Number.isSafeInteger(Number(raw?.relationship_delta)) ? Number(raw.relationship_delta) : 0))
  let promise = null
  if (raw?.promise && typeof raw.promise === 'object' && !Array.isArray(raw.promise) && DIRECTIONS.has(raw.promise.direction)) {
    const promiseText = clean(raw.promise.text, 500)
    if (promiseText) promise = {
      id: stableId('promise', turnId, profile.id, playerId, promiseText),
      direction: raw.promise.direction,
      text: promiseText,
      due_hint: clean(raw.promise.due_hint, 240),
      visibility: 'party',
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
      visibility: 'party',
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
    const facts = npcFacts(state, profile, message)
    if (!this.llmClient) return {
      ...normalizedResult({}, profile, state, String(playerId), message, turnId, checkOutcome),
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
      })
      return {
        ...normalizedResult(result, profile, state, String(playerId), message, turnId, checkOutcome),
        provider: this.llmClient.constructor?.name ?? 'llm',
        prompt_version: NPC_SOCIAL_PROMPT_VERSION,
      }
    } catch (error) {
      return {
        ...normalizedResult({}, profile, state, String(playerId), message, turnId, checkOutcome),
        provider: 'deterministic-social-fallback',
        prompt_version: NPC_SOCIAL_PROMPT_VERSION,
        provider_error: clean(error?.code ?? error?.name ?? 'LLM_PROVIDER_ERROR', 80),
        facts_available: facts.length,
      }
    }
  }
}
