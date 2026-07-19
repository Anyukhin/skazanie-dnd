import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ensureNpcSocialState, relationshipTier } from './npc-social.mjs'

const prompt = readFileSync(fileURLToPath(new URL('../prompts/npc_controller/social_v1.txt', import.meta.url)), 'utf8')
const STANCES = new Set(['friendly', 'neutral', 'guarded', 'hostile'])
const DIRECTIONS = new Set(['npc_to_party', 'party_to_npc'])

const clean = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

function stableId(namespace, ...parts) {
  const digest = createHash('sha256').update(parts.map((part) => clean(part, 1_000)).join('\0')).digest('hex').slice(0, 24)
  return `${namespace}:${digest}`
}

function npcFacts(state, profile) {
  const allowedIds = new Set(profile.known_fact_ids ?? [])
  for (const fact of state.worldMemory?.facts ?? []) if (['public', 'party'].includes(fact.visibility)) allowedIds.add(String(fact.id))
  const entities = new Map((state.worldMemory?.entities ?? []).map((entity) => [String(entity.id), entity]))
  return (state.worldMemory?.facts ?? []).filter((fact) => fact.status === 'active' && allowedIds.has(String(fact.id))).map((fact) => ({
    id: String(fact.id),
    subject: clean(entities.get(String(fact.subject_id))?.name, 160),
    summary: clean(fact.summary || fact.object, 500),
  })).slice(0, 30)
}

function briefFor(state, profile, playerId, message, checkOutcome = null) {
  const social = ensureNpcSocialState(state.social, state)
  return {
    npc: {
      id: profile.id, name: profile.name, role: profile.role,
      public_summary: profile.public_summary, voice: profile.voice,
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
      .filter((entry) => entry.npc_id === profile.id && entry.hero_id === playerId)
      .slice(-6)
      .map((entry) => ({ player_message: entry.player_message, npc_reply: entry.npc_reply, stance: entry.stance, ...(entry.check ? { check: { skill: entry.check.skill, success: entry.check.success, degree: entry.check.degree } } : {}) })),
    speakable_facts: npcFacts(state, profile),
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
  const facts = npcFacts(state, profile)
  const allowedFactIds = new Set(facts.map((fact) => fact.id))
  const disclosedFactIds = [...new Set((Array.isArray(raw?.disclosed_fact_ids) ? raw.disclosed_fact_ids : [])
    .map(String).filter((factId) => allowedFactIds.has(factId)))].slice(0, 20)
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
    const profile = social.npcs.find((npc) => npc.id === String(npcId))
    if (!profile || profile.available === false) return null
    const facts = npcFacts(state, profile)
    if (!this.llmClient) return { ...normalizedResult({}, profile, state, String(playerId), message, turnId, checkOutcome), provider: 'deterministic-social-fallback' }
    try {
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `UNTRUSTED_DATA\n${JSON.stringify(briefFor(state, profile, String(playerId), message, checkOutcome))}` },
        ],
        temperature: 0.7,
        maxTokens: 700,
      })
      return { ...normalizedResult(result, profile, state, String(playerId), message, turnId, checkOutcome), provider: this.llmClient.constructor?.name ?? 'llm' }
    } catch (error) {
      return { ...normalizedResult({}, profile, state, String(playerId), message, turnId, checkOutcome), provider: 'deterministic-social-fallback', provider_error: clean(error?.code ?? error?.name ?? 'LLM_PROVIDER_ERROR', 80), facts_available: facts.length }
    }
  }
}
