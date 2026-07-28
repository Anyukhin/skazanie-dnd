import { createHash, randomUUID } from 'node:crypto'

import { Adjudicator } from './adjudicator.mjs'
import { answerKnownLore } from './agent-router.mjs'
import { AutonomousCampaignOrchestrator } from './autonomous-orchestrator.mjs'
import { IdempotencyConflictError } from './event-store.mjs'
import { deterministicNarratorFor, renderDeterministicNarration } from './deterministic-narration.mjs'
import './encounter-narration.mjs'
import { IntentParser, buildRuleQueries } from './intent-parser.mjs'
import './merchant-narration.mjs'
import { ensureNpcSocialState, npcConversationNarration, npcProfileAtWorldTime, npcSocialForViewer, relationshipTier } from './npc-social.mjs'
import { assertNpcSocialCheckFingerprint, buildNpcSocialCheckPolicy, npcSocialCheckOutcome } from './npc-social-check.mjs'
import { NARRATOR_PROMPT_VERSION, Narrator, deterministicNarration } from './narrator.mjs'
import { actorNameResolver, eventSummary, normalizeCampaignState } from './rules-engine.mjs'
import './scene-narration.mjs'
import { buildNarrationBrief, projectVisibleState, validateAllowedCommands, verifyNarration } from './security.mjs'
import { campaignStateForViewer, mechanicsForViewer, turnExplanationForViewer } from './viewer-projection.mjs'
import { campaignConceptForAgent } from './agent-context.mjs'
import { buildTurnExplanation } from './trace-store.mjs'
import { retrieveWorldMemory } from './world-memory.mjs'

// A JSON request cannot manufacture this identity. Only server-owned world
// orchestration may attach it to derived AdvanceScene/merchant commands.
export const DIRECTOR_COMMAND_CAPABILITY = Symbol('skazanie:director-command-capability')

function emptyEffects() {
  return { roll: null, reveal: [], spawn: [], objective: null, grantItems: [] }
}

/**
 * Narrator receives only a small supplemental memory window. The committed
 * events already carry the current result; three ranked facts are enough to
 * connect that result to the nearby canon without turning every narration into
 * a full-world prompt.
 */
export const NARRATION_WORLD_FACT_LIMIT = 3
const memoryText = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

function narrationMemoryQuery(state, message, events) {
  return [
    message,
    state.scene?.title,
    state.scene?.location,
    state.scene?.objective,
    ...(events ?? []).map((event) => eventSummary(event)),
  ].filter(Boolean).join(' ').slice(0, 4_000)
}

function narrationWorldFacts(state, viewer, message, events) {
  // A hero may legitimately have a personal gm_only fact in the canonical
  // viewer projection. Narrator has a stricter contract: remove such facts
  // before retrieval so they cannot consume ranking slots or leak through a
  // wrapper record's summary.
  const publicMemory = {
    ...(state.worldMemory ?? {}),
    facts: (state.worldMemory?.facts ?? []).filter((fact) => ['public', 'party'].includes(fact.visibility)),
  }
  const records = retrieveWorldMemory(publicMemory, {
    playerId: viewer.playerId,
    partyIds: viewer.partyIds,
    isPartyMember: viewer.isPartyMember,
  }, {
    query: narrationMemoryQuery(state, message, events),
    limit: NARRATION_WORLD_FACT_LIMIT,
    asOfMinutes: state.mechanics?.world_time?.elapsed_minutes,
  })
  return records
    .filter((record) => record.kind === 'fact' && ['public', 'party'].includes(record.fact?.visibility))
    .map((record) => ({
      id: memoryText(record.fact?.id, 120),
      subject: memoryText(record.entity?.name || record.fact?.subject_id, 120),
      predicate: memoryText(record.fact?.predicate, 80),
      summary: memoryText(record.fact?.summary || record.fact?.object, 280),
    }))
    .filter((fact) => fact.id && fact.summary)
    .slice(0, NARRATION_WORLD_FACT_LIMIT)
}

/**
 * Story context gives the narrator continuity, not authority: active quests,
 * plot threads, recent scene summaries, the party roster, NPCs presently in
 * the scene and their open promises. Every entry is bounded, party-visible
 * and still passes the narrator projection with the rest of the brief.
 */
export const NARRATION_STORY_LIMITS = Object.freeze({
  quests: 2, threads: 2, summaries: 2, heroes: 6, npcs: 4, promises: 4,
})

const partyVisibleRecord = (value) => ['public', 'party'].includes(String(value?.visibility ?? '').toLowerCase())

function narrationQuestClock(clock) {
  const max = Number(clock?.max)
  if (!Number.isSafeInteger(max) || max <= 0) return null
  return { label: memoryText(clock.label, 80), current: Math.max(0, Number(clock.current) || 0), max }
}

export function narrationStoryContext(state, viewer = {}) {
  const memory = state.worldMemory ?? {}
  const active_quests = (memory.quests ?? [])
    .filter((quest) => quest.status === 'active' && partyVisibleRecord(quest))
    .slice(-NARRATION_STORY_LIMITS.quests)
    .map((quest) => {
      const clock = narrationQuestClock(quest.clock)
      return {
        title: memoryText(quest.title, 160),
        summary: memoryText(quest.summary, 400),
        objectives: (Array.isArray(quest.objectives) ? quest.objectives : []).slice(0, 3).map((objective) => memoryText(objective, 200)).filter(Boolean),
        ...(clock ? { clock } : {}),
      }
    })
    .filter((quest) => quest.title)
  const active_threads = (memory.threads ?? [])
    .filter((thread) => thread.status === 'active' && partyVisibleRecord(thread))
    .slice(-NARRATION_STORY_LIMITS.threads)
    .map((thread) => ({ title: memoryText(thread.title, 160), summary: memoryText(thread.summary, 300) }))
    .filter((thread) => thread.title)
  const recent_summaries = (memory.summaries ?? [])
    .filter(partyVisibleRecord)
    .slice(-NARRATION_STORY_LIMITS.summaries)
    .map((summary) => ({ title: memoryText(summary.title, 160), summary: memoryText(summary.summary, 500) }))
    .filter((summary) => summary.title && summary.summary)
  const heroes = (state.players ?? [])
    .slice(0, NARRATION_STORY_LIMITS.heroes)
    .map((actor) => ({ id: String(actor?.id ?? ''), name: memoryText(actor?.character || actor?.name, 120) }))
    .filter((hero) => hero.id && hero.name)

  const social = ensureNpcSocialState(state.social, state)
  const sceneLocation = memoryText(state.scene?.location, 180).toLocaleLowerCase('ru')
  const presentProfiles = social.npcs
    .map((npc) => npcProfileAtWorldTime(npc, state))
    .filter((npc) => npc.available !== false && partyVisibleRecord(npc))
    .filter((npc) => npc.location && sceneLocation && npc.location.toLocaleLowerCase('ru') === sceneLocation)
    .slice(0, NARRATION_STORY_LIMITS.npcs)
  const relationships = social.relationships ?? {}
  const present_npcs = presentProfiles.map((npc) => ({
    id: String(npc.id),
    name: memoryText(npc.name, 120),
    role: memoryText(npc.role, 120),
    public_summary: memoryText(npc.public_summary, 300),
    voice: memoryText(npc.voice, 200),
    relationship: relationshipTier(relationships[npc.id]?.[viewer?.playerId] ?? 0),
  })).filter((npc) => npc.id && npc.name)
  const presentIds = new Set(presentProfiles.map((npc) => String(npc.id)))
  const npcNames = new Map(presentProfiles.map((npc) => [String(npc.id), npc.name]))
  const promiseVisible = (promise) => promise.visibility === 'party'
    || (promise.visibility === 'specific_player' && String(promise.hero_id) === String(viewer?.playerId ?? ''))
  const open_promises = (social.promises ?? [])
    .filter((promise) => promise.status === 'open' && promiseVisible(promise) && presentIds.has(String(promise.npc_id)))
    .slice(-NARRATION_STORY_LIMITS.promises)
    .map((promise) => ({
      npc: memoryText(npcNames.get(String(promise.npc_id)) || promise.npc_id, 120),
      direction: memoryText(promise.direction, 40),
      text: memoryText(promise.text, 280),
      ...(promise.due_hint ? { due_hint: memoryText(promise.due_hint, 160) } : {}),
    }))
    .filter((promise) => promise.text)
  return { active_quests, active_threads, recent_summaries, heroes, present_npcs, open_promises }
}

function narrationSocialConsequences(events, state) {
  const promises = new Map((state.social?.promises ?? []).map((promise) => [String(promise.id), promise]))
  return (events ?? [])
    .filter((event) => event.event_type === 'NpcPromiseResolved')
    .map((event) => {
      const promiseId = memoryText(event.payload?.promise_id, 120)
      const promise = promises.get(promiseId)
      return {
        promise_id: promiseId,
        status: memoryText(event.payload?.status, 30),
        npc_id: memoryText(promise?.npc_id, 120),
        direction: memoryText(promise?.direction, 40),
        text: memoryText(promise?.text, 280),
        consequence_delta: Number.isSafeInteger(Number(event.payload?.consequence_delta))
          ? Number(event.payload.consequence_delta)
          : 0,
      }
    })
    .filter((entry) => entry.promise_id && entry.status)
    .slice(-6)
}

// `purpose` — служебный ключ броска (`ability_check:wis`). Игроку он попадал
// в карточку результата как есть, вместо названия проверки.
const ABILITY_CHECK_LABELS = Object.freeze({
  str: 'Проверка Силы',
  dex: 'Проверка Ловкости',
  con: 'Проверка Телосложения',
  int: 'Проверка Интеллекта',
  wis: 'Проверка Мудрости',
  cha: 'Проверка Харизмы',
})
const SAVING_THROW_LABELS = Object.freeze({
  str: 'Спасбросок Силы',
  dex: 'Спасбросок Ловкости',
  con: 'Спасбросок Телосложения',
  int: 'Спасбросок Интеллекта',
  wis: 'Спасбросок Мудрости',
  cha: 'Спасбросок Харизмы',
})

export function rollPurposeLabel(purpose) {
  const value = String(purpose ?? '').trim()
  if (!value) return 'Проверка'
  const [kind, detail = ''] = value.split(':')
  const ability = detail.toLowerCase()
  if (kind === 'ability_check') return ABILITY_CHECK_LABELS[ability] ?? 'Проверка характеристики'
  if (kind === 'saving_throw') return SAVING_THROW_LABELS[ability] ?? 'Спасбросок'
  if (kind === 'attack_roll' || kind === 'attack') return 'Бросок атаки'
  if (kind === 'initiative') return 'Инициатива'
  if (kind === 'death_save') return 'Спасбросок от смерти'
  if (kind === 'free_roll') return 'Свободный бросок'
  // Незнакомый служебный ключ лучше не показывать вовсе, чем показывать сырым.
  return /^[a-z0-9_:.-]+$/i.test(value) ? 'Проверка' : value
}

function rollForClient(roll) {
  if (!roll) return null
  return {
    roll_id: roll.roll_id,
    actor_id: String(roll.actor_id ?? roll.actorId ?? ''),
    value: roll.kept ?? roll.dice?.[0] ?? 0,
    modifier: Number(roll.modifier) || 0,
    total: Number(roll.total) || 0,
    label: rollPurposeLabel(roll.purpose),
    success: typeof roll.success === 'boolean' ? roll.success : undefined,
  }
}

export function eventsToClientEffects(events, rolls = []) {
  const effects = emptyEffects()
  effects.roll = rollForClient(rolls[0])
  for (const event of events ?? []) {
    if (event.event_type === 'AreaRevealed') effects.reveal.push(...(event.payload?.cells ?? []))
    if (event.event_type === 'ObjectiveUpdated') effects.objective = event.payload?.objective ?? null
    if (event.event_type === 'EntitySpawned') effects.spawn.push(event.payload?.entity)
    if (event.event_type === 'ItemGranted') effects.grantItems.push({ ...event.payload?.item, ownerId: event.target_ids?.[0] ?? event.actor_id })
  }
  return effects
}

function visibleChanges(events) {
  return (events ?? []).map((event) => ({
    event_type: event.event_type,
    actor_id: event.actor_id,
    target_ids: event.target_ids,
    payload: event.payload,
    source_rule_ids: event.source_rule_ids,
    ruling_id: event.ruling_id ?? null,
    visibility: event.visibility ?? 'public',
  }))
}

function whyNarration(explanation, resolveName) {
  if (!explanation) return 'Для этой кампании ещё нет сохранённого механического решения.'
  const rules = explanation.rules_used?.length ? `Правила: ${explanation.rules_used.join(', ')}.` : 'Официальное правило не выбрано; использовано временное решение.'
  const rolls = explanation.rolls?.length
    ? `Броски: ${explanation.rolls.map((roll) => `${roll.expression} = ${roll.total}`).join('; ')}.`
    : 'Бросков не было.'
  const events = explanation.events?.length
    ? `События: ${explanation.events.map((event) => eventSummary(event, resolveName)).join('; ')}.`
    : 'Механических событий не было.'
  return `${rules} ${rolls} ${events}`
}

function modelIdentifiers(narration) {
  return {
    narrator: narration?.provider ?? null,
  }
}

function structuredCommandTurnId(campaignId, idempotencyKey) {
  const digest = createHash('sha256')
    .update(String(campaignId))
    .update('\0')
    .update(String(idempotencyKey))
    .digest('hex')
    .slice(0, 32)
  return `turn-${digest}`
}

function cachedNarration(trace, brief, knownRuleIds) {
  const cached = trace?.narration_result
  const text = typeof cached?.narration === 'string' ? cached.narration.trim() : ''
  if (!text) return null
  const verification = verifyNarration(text, brief, { knownRuleIds })
  if (!verification.valid) return null
  return {
    narration: text,
    suggestions: Array.isArray(cached.suggestions)
      ? cached.suggestions.slice(0, 3).map((suggestion) => String(suggestion).slice(0, 120)).filter(Boolean)
      : [],
    verification: cached.verification && typeof cached.verification === 'object'
      ? cached.verification
      : verification,
    prompt_version: String(cached.prompt_version || NARRATOR_PROMPT_VERSION),
    provider: String(cached.provider || 'cached-idempotent-replay'),
  }
}

function deterministicReplayNarration(brief, knownRuleIds, resolveName) {
  const fallback = deterministicNarration(brief, resolveName)
  return {
    ...fallback,
    verification: verifyNarration(fallback.narration, brief, { knownRuleIds }),
    prompt_version: NARRATOR_PROMPT_VERSION,
    provider: 'deterministic-idempotent-replay',
  }
}

function deterministicMechanicsNarration(brief, knownRuleIds, resolveName) {
  const fallback = deterministicNarration(brief, resolveName)
  return {
    ...fallback,
    suggestions: [],
    verification: verifyNarration(fallback.narration, brief, { knownRuleIds }),
    prompt_version: 'mechanics-log/v1',
    provider: 'deterministic-mechanics',
  }
}

/**
 * Один путь для всех детерминированных рассказчиков вместо трёх почти
 * одинаковых обёрток. Кто именно отвечает за события, решает реестр в
 * `deterministic-narration.mjs`, а не лестница тернарных операторов здесь.
 */
function deterministicNarratorResponse(narrator, events, state, brief, knownRuleIds) {
  const rendered = renderDeterministicNarration(narrator, {
    events,
    state,
    fallbackNarration: deterministicNarration(brief, actorNameResolver(state)).narration,
  })
  return { ...rendered, verification: verifyNarration(rendered.narration, brief, { knownRuleIds }) }
}

/**
 * Отказ обязан подсказывать выход. Прежнее «Уточните имя собеседника.» было
 * тупиком: игрок не знал, кто вообще есть в сцене, и ход тратился впустую.
 */
function availableNpcNames(state) {
  const sceneLocation = String(state?.scene?.location ?? '').trim().toLocaleLowerCase('ru')
  return (state?.social?.npcs ?? [])
    .filter((npc) => npc?.available !== false)
    .filter((npc) => {
      const npcLocation = String(npc?.location ?? '').trim().toLocaleLowerCase('ru')
      return !sceneLocation || !npcLocation || sceneLocation === npcLocation
    })
    .map((npc) => String(npc?.name ?? '').trim())
    .filter(Boolean)
    .slice(0, 6)
}

function humanMissingInformation(values, state) {
  const labels = {
    message: 'само действие',
    target_id: 'цель действия',
    npc_id: 'имя собеседника',
    available_npc: 'доступного собеседника',
  }
  const missing = [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]
  if (missing.includes('npc_id') || missing.includes('available_npc')) {
    const names = availableNpcNames(state)
    return names.length
      ? `Назовите собеседника по имени. Сейчас рядом: ${names.join(', ')}.`
      : 'Рядом нет никого, с кем можно заговорить. Осмотритесь или дойдите туда, где есть люди.'
  }
  return missing.length ? `Уточните ${missing.map((value) => labels[value] ?? 'деталь действия').join(' и ')}.` : 'Опишите действие подробнее, чтобы его можно было разрешить по правилам.'
}

function noWorldChangeConstraint(plan) {
  return plan?.ruling_draft?.world_change === false
    || (Array.isArray(plan?.narration_constraints) && plan.narration_constraints.includes('no-unconfirmed-world-changes'))
}

export class GameOrchestrator {
  constructor({
    intentParser = new IntentParser(),
    ruleRetriever = null,
    adjudicator = new Adjudicator(),
    rulesEngine,
    eventStore,
    traceStore = null,
    narrator = new Narrator(),
    npcSocialController = null,
    unknownActionHandler = null,
    idFactory = randomUUID,
    now = () => Date.now(),
  } = {}) {
    if (!rulesEngine) throw new TypeError('GameOrchestrator требует RulesEngine')
    if (!eventStore) throw new TypeError('GameOrchestrator требует EventStore')
    this.intentParser = intentParser
    this.ruleRetriever = ruleRetriever
    this.adjudicator = adjudicator
    this.rulesEngine = rulesEngine
    this.eventStore = eventStore
    this.traceStore = traceStore
    this.narrator = narrator
    this.npcSocialController = npcSocialController
    this.unknownActionHandler = unknownActionHandler ?? new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, now })
    this.idFactory = idFactory
    this.now = now
  }

  explanation(campaignId, turnId = null, viewer = null) {
    if (!this.traceStore) return null
    const trace = turnId ? this.traceStore.get(campaignId, turnId) : this.traceStore.latest(campaignId)
    return buildTurnExplanation(trace, viewer)
  }

  freeActionResponse({
    freeAction,
    campaignId,
    playerId,
    viewer,
    message,
    intent,
    retrievalQueries,
    retrievedRules,
    plan,
    authoritativeState,
    idempotencyKey,
    turnId,
    started,
    mode,
  }) {
    const state = freeAction.state ?? authoritativeState
    const committedEvents = Array.isArray(freeAction.events) ? freeAction.events : []
    const publicCommittedEvents = mechanicsForViewer(committedEvents, { isPartyMember: true }, playerId, state)
    const constraints = [
      ...(Array.isArray(plan?.narration_constraints) ? plan.narration_constraints : []),
      ...(noWorldChangeConstraint(plan) ? ['no-unconfirmed-world-changes'] : []),
      ...(Array.isArray(freeAction.narration_constraints) ? freeAction.narration_constraints : []),
    ]
    const brief = buildNarrationBrief({
      visible_events: publicCommittedEvents,
      visible_state_changes: visibleChanges(publicCommittedEvents),
      known_environment: {
        scene: projectVisibleState(state.scene ?? {}, viewer, { forNarrator: true }) ?? {},
        campaign_premise: campaignConceptForAgent(state),
        world_memory: { facts: narrationWorldFacts(state, viewer, message, publicCommittedEvents) },
        story_context: narrationStoryContext(state, viewer),
        social_consequences: narrationSocialConsequences(publicCommittedEvents, state),
      },
      permitted_npc_reactions: [],
      narration_constraints: constraints,
      viewer,
    })
    const candidateNarration = String(freeAction.narration ?? '').trim()
    const candidateVerification = verifyNarration(candidateNarration, brief, { knownRuleIds: [] })
    const narration = candidateVerification.valid && candidateNarration
      ? candidateNarration
      : freeAction.kind === 'clarification'
        ? 'Опишите действие подробнее, чтобы его можно было разрешить по правилам.'
        : 'Действие не получило подтверждённого последствия. Уточните, чего герой хочет добиться.'
    const verification = verifyNarration(narration, brief, { knownRuleIds: [] })
    const idempotentReplay = Boolean(freeAction.duplicate)
    const response = {
      narration,
      suggestions: Array.isArray(freeAction.suggestions) ? freeAction.suggestions : [],
      effects: eventsToClientEffects(committedEvents, freeAction.rolls ?? []),
      provider: 'deterministic-free-action',
      model: 'server-policy',
      turn_id: turnId,
      engine_mode: mode,
      state_version: state.state_version,
      mechanics: committedEvents,
      visible_state_changes: projectVisibleState(visibleChanges(publicCommittedEvents), viewer) ?? [],
      authoritative_state: state,
      verification,
      ruling: freeAction.ruling ?? null,
      // Ставки объявляются игроку вместе с исходом: характеристика, СЛ и цена провала.
      ...(freeAction.stakes ? { stakes: freeAction.stakes } : {}),
      explanation_url: `/api/campaigns/${encodeURIComponent(campaignId)}/turns/${encodeURIComponent(turnId)}/explanation`,
      idempotent_replay: idempotentReplay,
      turn_consumed: false,
      action_kind: 'free',
      free_action_outcome: freeAction.kind,
      ...(freeAction.rejected ? { rejected: true } : {}),
    }
    if (!idempotentReplay) {
      this.saveTrace({
        turnId,
        campaignId,
        idempotencyKey,
        mode,
        intent,
        retrievalQueries,
        retrievedRules,
        plan: {
          ...plan,
          proposed_commands: freeAction.commands ?? [],
          ruling_required: Boolean(freeAction.ruling),
          ruling_draft: freeAction.ruling ?? null,
          narration_constraints: constraints,
        },
        engineResult: { commands: freeAction.commands ?? [], events: committedEvents, rolls: freeAction.rolls ?? [] },
        stateBefore: authoritativeState.state_version,
        stateAfter: state.state_version,
        verification,
        latency: this.now() - started,
        narration: {
          narration,
          suggestions: response.suggestions,
          verification,
          prompt_version: 'free-action/v1',
          provider: response.provider,
        },
        ruling: freeAction.ruling ?? null,
      })
    }
    return response
  }

  async handle(input) {
    const started = this.now()
    const originalState = normalizeCampaignState(input.state ?? {})
    const campaignId = String(input.campaignId ?? input.campaign_id ?? originalState.sessionCode ?? originalState.campaign_id ?? '')
    const playerId = String(input.playerId ?? input.player_id ?? originalState.activePlayerId ?? '')
    const message = String(input.message ?? input.action ?? '').trim().slice(0, 2000)
    const idempotencyKey = String(input.idempotencyKey ?? input.idempotency_key ?? this.idFactory())
    const directorCapability = input.commandCapability === DIRECTOR_COMMAND_CAPABILITY
    const rulesContext = {
      allowedActorIds: input.allowedActorIds ?? [playerId],
      isAdmin: input.user?.role === 'admin',
      isDirector: directorCapability,
    }
    let turnId = Array.isArray(input.commands)
      ? structuredCommandTurnId(campaignId, idempotencyKey)
      : this.idFactory()
    const mode = 'enforce'

    if (message === '/why' || input.why === true) {
      const rawExplanation = this.explanation(campaignId, input.turnId ?? input.turn_id, {
        playerId,
        isPartyMember: true,
        role: input.user?.role,
      })
      const explanation = turnExplanationForViewer(rawExplanation, input.user ?? {}, playerId, originalState)
      return { narration: whyNarration(explanation, actorNameResolver(originalState)), suggestions: [], effects: emptyEffects(), provider: 'RulesEngine', model: 'deterministic', engine_mode: mode, turn_id: explanation?.turn_id ?? null, state_version: originalState.state_version, explanation, turn_consumed: false }
    }

    const viewer = { playerId, partyIds: input.partyIds ?? [], isPartyMember: true, role: input.user?.role }
    const visibleState = campaignStateForViewer(originalState, input.user ?? {}, playerId) ?? {}
    visibleState.social = npcSocialForViewer(originalState.social, {
      playerId,
      isAdmin: input.user?.role === 'admin',
      isPartyMember: true,
      state: originalState,
    })
    const worldkeeperViewer = {
      playerId,
      isAdmin: input.user?.role === 'admin',
      isPartyMember: true,
      role: input.user?.role,
    }
    const worldkeeperState = { ...visibleState, worldMemory: originalState.worldMemory }
    const loreAnswer = input.commands ? null : answerKnownLore(message, worldkeeperState, { viewer: worldkeeperViewer })
    if (loreAnswer) {
      const loreIntent = {
        actor_id: playerId, intent: 'known_lore_query', approach: 'deterministic',
        targets: [], mentioned_entities: [], missing_information: [],
        requires_clarification: false, confidence: 1, raw_message: message,
      }
      const lorePlan = { rule_ids: [], proposed_commands: [], roll_requests: [], ruling_required: false, narration_constraints: ['known-world-facts-only'], confidence: 1 }
      const response = { ...loreAnswer, engine_mode: mode, turn_id: turnId, state_version: originalState.state_version }
      this.saveTrace({ turnId, campaignId, mode, intent: loreIntent, retrievalQueries: [], retrievedRules: { results: [], confidence: 1, count: 0 }, plan: lorePlan, stateBefore: originalState.state_version, stateAfter: originalState.state_version, verification: { valid: true }, latency: this.now() - started })
      return response
    }
    const intent = input.commands
      ? { actor_id: playerId, intent: 'structured_commands', approach: 'api', targets: [], mentioned_entities: [], missing_information: [], requires_clarification: false, confidence: 1, raw_message: message }
      : await this.intentParser.parse({ message, playerId, visibleState })
    let socialRequest = null
    if (!input.commands && intent.intent === 'social' && this.npcSocialController) {
      const socialNpcIds = new Set((originalState.social?.npcs ?? []).map((npc) => String(npc.id)))
      const npcId = (intent.targets ?? []).map(String).find((candidate) => socialNpcIds.has(candidate))
      if (!npcId) {
        intent.requires_clarification = true
        intent.missing_information = ['npc_id']
      } else socialRequest = { npcId }
    }
    const retrievalQueries = buildRuleQueries(intent, originalState)
    const retrievedRules = this.ruleRetriever && retrievalQueries.length
      ? await this.ruleRetriever.search({ queries: retrievalQueries, ruleset_id: originalState.ruleset_id, enabled_packs: originalState.enabled_rule_packs, limit: 10 })
      : { results: [], confidence: 0, count: 0 }
    const freeActionRequest = !input.commands && ['improvised_action', 'unknown'].includes(intent.intent)
    let plan = input.commands
      ? { rule_ids: [...new Set(input.commands.flatMap((command) => command.source_rule_ids ?? []))], proposed_commands: input.commands, roll_requests: [], ruling_required: false, ruling_draft: null, narration_constraints: [], confidence: 1 }
      : socialRequest
        ? {
            rule_ids: [],
            proposed_commands: [],
            roll_requests: [],
            ruling_required: false,
            ruling_draft: null,
            narration_constraints: ['server-social-check-before-dialogue', 'npc-dialogue-from-committed-event-only'],
            confidence: intent.confidence,
          }
        : freeActionRequest
          ? {
              rule_ids: [],
              proposed_commands: [],
              roll_requests: [],
              ruling_required: false,
              ruling_draft: null,
              narration_constraints: ['free-action-committed-consequences-only'],
              confidence: intent.confidence,
            }
        : await this.adjudicator.createPlan({ intent, state: originalState, retrievedRules })
    plan = { ...plan, proposed_commands: validateAllowedCommands(plan.proposed_commands ?? []).map((command, index) => ({ ...command, campaign_id: campaignId, command_id: `${idempotencyKey}:${index + 1}` })) }

    const loaded = await this.eventStore.load(campaignId)
    const authoritativeState = normalizeCampaignState(loaded.state)
    const duplicate = typeof this.eventStore.getByIdempotencyKey === 'function'
      ? await this.eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
      : null
    if (freeActionRequest) {
      turnId = structuredCommandTurnId(campaignId, idempotencyKey)
      const freeAction = await this.unknownActionHandler.handleUnknownAction({
        campaignId,
        action: message,
        idempotencyKey,
        playerId,
        intent,
      })
      return this.freeActionResponse({
        freeAction,
        campaignId,
        playerId,
        viewer,
        message,
        intent,
        retrievalQueries,
        retrievedRules,
        plan,
        authoritativeState,
        idempotencyKey,
        turnId,
        started,
        mode,
      })
    }
    if (socialRequest && !duplicate) {
      const social = ensureNpcSocialState(authoritativeState.social, authoritativeState)
      const persistedProfile = social.npcs.find((npc) => npc.id === socialRequest.npcId)
      const profile = persistedProfile ? npcProfileAtWorldTime(persistedProfile, authoritativeState) : null
      const sceneLocation = String(authoritativeState.scene?.location ?? '').trim().toLocaleLowerCase('ru')
      const npcLocation = String(profile?.location ?? '').trim().toLocaleLowerCase('ru')
      const unavailable = !profile || profile.available === false || authoritativeState.mechanics?.combat?.active || (sceneLocation && npcLocation && sceneLocation !== npcLocation)
      if (unavailable) {
        intent.requires_clarification = true
        intent.missing_information = ['available_npc']
      }
    }


    if (intent.requires_clarification || plan.clarification_required) {
      const narration = humanMissingInformation(intent.missing_information ?? plan.missing_information, authoritativeState)
      const response = { narration, suggestions: [], effects: emptyEffects(), provider: 'RulesEngine', model: 'deterministic', turn_id: turnId, engine_mode: mode, state_version: authoritativeState.state_version, mechanics: [], visible_state_changes: [], authoritative_state: authoritativeState, turn_consumed: false }
      this.saveTrace({ turnId, campaignId, mode, intent, retrievalQueries, retrievedRules, plan, stateBefore: authoritativeState.state_version, stateAfter: authoritativeState.state_version, verification: { valid: true }, latency: this.now() - started })
      return response
    }

    let socialBaseState = authoritativeState
    let precedingEvents = []
    let precedingRolls = []
    let precedingCommands = []
    let socialTurn = null
    if (socialRequest) {
      const policy = buildNpcSocialCheckPolicy({ state: authoritativeState, npcId: socialRequest.npcId, heroId: playerId, message, turnId })
      const checkKey = `${idempotencyKey}:social-check`
      let checkCommit = policy && typeof this.eventStore.getByIdempotencyKey === 'function'
        ? await this.eventStore.getByIdempotencyKey(campaignId, checkKey)
        : null
      let checkCommand = null
      if (!duplicate && policy && !checkCommit) {
        checkCommand = {
          command_type: 'MakeAbilityCheck', actor_id: playerId, social_check: { requested: true },
          campaign_id: campaignId, command_id: `${checkKey}:1`,
        }
        rulesContext.isSocialController = true
        rulesContext.socialCheck = policy
        const checkPlan = { rule_ids: [], proposed_commands: [checkCommand], roll_requests: [], ruling_required: false, ruling_draft: null, narration_constraints: [], confidence: 1 }
        const checkResult = this.rulesEngine.resolvePlan(checkPlan, authoritativeState, rulesContext)
        try {
          checkCommit = await this.eventStore.commit({
            campaign_id: campaignId, expected_state_version: authoritativeState.state_version,
            idempotency_key: checkKey, command_id: checkKey, events: checkResult.events,
          })
        } catch (error) {
          if (!(error instanceof IdempotencyConflictError) && error?.code !== 'IDEMPOTENCY_CONFLICT') throw error
          checkCommit = await this.eventStore.getByIdempotencyKey(campaignId, checkKey)
          if (!checkCommit) throw error
        }
        precedingCommands = checkResult.commands
        precedingRolls = checkResult.rolls
      }
      let checkOutcome = null
      if (policy && checkCommit) {
        const checkEvent = (checkCommit.events ?? []).find((event) => event.event_type === 'AbilityCheckResolved' && event.payload?.social_check)
        assertNpcSocialCheckFingerprint(checkEvent, policy)
        checkOutcome = npcSocialCheckOutcome(checkEvent)
        if (!checkOutcome) throw new Error('Committed social check has no usable outcome')
        precedingEvents = checkCommit.events ?? []
        if (!precedingRolls.length) precedingRolls = [checkEvent.payload]
        const latest = await this.eventStore.load(campaignId)
        socialBaseState = normalizeCampaignState(latest.state)
      }
      if (!duplicate) {
        socialTurn = await this.npcSocialController.respond({
          state: socialBaseState, playerId, npcId: socialRequest.npcId, message, turnId, checkOutcome,
        })
        if (!socialTurn) throw new Error('NPC is no longer available for this social turn')
        rulesContext.isSocialController = true
        rulesContext.socialCheckOutcome = checkOutcome
        const socialCommand = {
          command_type: 'RecordNpcSocialTurn', actor_id: playerId, conversation: socialTurn.conversation,
          campaign_id: campaignId, command_id: `${idempotencyKey}:dialogue`,
        }
        plan = {
          ...plan, proposed_commands: validateAllowedCommands([socialCommand]),
          confidence: socialTurn.confidence,
          social_check: policy ? { check_id: policy.check_id, skill: policy.skill } : null,
        }
      }
    }

    let engineResult
    let committed
    if (duplicate) {
      committed = duplicate
      engineResult = { commands: plan.proposed_commands, events: duplicate.events, rolls: duplicate.events.filter((event) => event.event_type === 'DieRolled').map((event) => event.payload), state: duplicate.state }
    } else {
      if (plan.ruling_required && !plan.proposed_commands.length) {
        const ruling = { id: this.idFactory(), campaign_id: campaignId, ...plan.ruling_draft }
        plan = { ...plan, ruling_draft: ruling, proposed_commands: [{ command_type: 'RecordRuling', actor_id: playerId || null, ruling, ruling_id: ruling.id, campaign_id: campaignId, command_id: `${idempotencyKey}:ruling` }] }
      }
      let resolutionState = socialRequest ? socialBaseState : authoritativeState
      for (let attempt = 0; attempt < 3; attempt += 1) {
        engineResult = this.rulesEngine.resolvePlan(plan, resolutionState, rulesContext)
        if (!engineResult.events.length) throw new Error('Enforce-ход не создал ни события, ни ruling')
        try {
          committed = await this.eventStore.commit({ campaign_id: campaignId, expected_state_version: resolutionState.state_version, idempotency_key: idempotencyKey, command_id: idempotencyKey, events: engineResult.events })
          break
        } catch (error) {
          if (error?.code === 'STATE_VERSION_CONFLICT' && attempt < 2) {
            const latest = await this.eventStore.load(campaignId)
            resolutionState = normalizeCampaignState(latest.state)
            continue
          }
          if (!(error instanceof IdempotencyConflictError) && error?.code !== 'IDEMPOTENCY_CONFLICT') throw error
          committed = await this.eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
          if (!committed) throw error
          break
        }
      }
    }

    const mainEvents = committed.events ?? engineResult.events
    const committedEvents = [...precedingEvents, ...mainEvents]
    const publicCommittedEvents = mechanicsForViewer(committedEvents, input.user ?? {}, playerId, committed.state)
    engineResult = {
      ...engineResult,
      commands: [...precedingCommands, ...(engineResult.commands ?? [])],
      events: committedEvents,
      rolls: [...precedingRolls, ...(engineResult.rolls ?? [])],
    }
    const changes = visibleChanges(committedEvents)
    const brief = buildNarrationBrief({
      visible_events: publicCommittedEvents,
      visible_state_changes: visibleChanges(publicCommittedEvents),
      known_environment: {
        scene: projectVisibleState(committed.state.scene ?? {}, viewer, { forNarrator: true }) ?? {},
        campaign_premise: campaignConceptForAgent(committed.state),
        world_memory: {
          facts: narrationWorldFacts(committed.state, viewer, message, publicCommittedEvents),
        },
        story_context: narrationStoryContext(committed.state, viewer),
        social_consequences: narrationSocialConsequences(publicCommittedEvents, committed.state),
      },
      permitted_npc_reactions: [],
      viewer,
    })
    const resolvedRuleIds = [...new Set([...(plan.rule_ids ?? []), ...committedEvents.flatMap((event) => event.source_rule_ids ?? [])])]
    const idempotentReplay = Boolean(duplicate || committed.duplicate)
    const replayTrace = idempotentReplay && this.traceStore && typeof this.traceStore.get === 'function'
      ? this.traceStore.get(campaignId, turnId)
      : null
    const storedSocialNarration = npcConversationNarration(committedEvents, committed.state)
    const resolveActorName = actorNameResolver(committed.state)
    // Кто рассказывает про эти события, знает реестр. Раньше выбор был записан
    // лестницей `?:` дважды — здесь и в ветке повтора, — и расходились они
    // молча.
    const deterministicNarrator = deterministicNarratorFor(committedEvents)
    const deterministicResponse = deterministicNarrator
      ? deterministicNarratorResponse(deterministicNarrator, committedEvents, committed.state, brief, resolvedRuleIds)
      : null
    const replayFallback = deterministicResponse
      ?? storedSocialNarration
      ?? deterministicReplayNarration(brief, resolvedRuleIds, resolveActorName)
    const structuredMechanics = Array.isArray(input.commands) && !deterministicNarrator
    const narration = idempotentReplay
      ? cachedNarration(replayTrace, brief, resolvedRuleIds) ?? replayFallback
      : deterministicResponse
        ?? storedSocialNarration
        ?? (structuredMechanics
          ? deterministicMechanicsNarration(brief, resolvedRuleIds, resolveActorName)
          : await this.narrator.render(brief, { knownRuleIds: resolvedRuleIds }))
    const response = {
      narration: narration.narration,
      ...(narration.journal_author ? { journal_author: narration.journal_author } : {}),
      suggestions: narration.suggestions,
      effects: eventsToClientEffects(committedEvents, engineResult.rolls),
      provider: narration.provider,
      model: 'orchestrated',
      turn_id: turnId,
      engine_mode: mode,
      state_version: committed.state_version,
      mechanics: committedEvents,
      visible_state_changes: projectVisibleState(changes, viewer) ?? [],
      authoritative_state: committed.state,
      verification: narration.verification,
      ruling: plan.ruling_draft ?? null,
      explanation_url: `/api/campaigns/${encodeURIComponent(campaignId)}/turns/${encodeURIComponent(turnId)}/explanation`,
      idempotent_replay: idempotentReplay,
      ...(storedSocialNarration ? { turn_consumed: true, action_kind: 'social' } : {}),
    }
    if (!idempotentReplay) {
      this.saveTrace({ turnId, campaignId, idempotencyKey, mode, intent, retrievalQueries, retrievedRules, plan, engineResult: { ...engineResult, events: committedEvents }, stateBefore: authoritativeState.state_version, stateAfter: committed.state_version, verification: narration.verification, latency: this.now() - started, narration, ruling: plan.ruling_draft })
    }
    return response
  }

  saveTrace({ turnId, campaignId, idempotencyKey = null, mode, intent, retrievalQueries, retrievedRules, plan, engineResult = {}, stateBefore, stateAfter, verification = {}, latency, narration = null, ruling = null }) {
    if (!this.traceStore) return null
    return this.traceStore.save({
      turn_id: turnId,
      campaign_id: campaignId,
      idempotency_key: idempotencyKey,
      engine_mode: mode,
      prompt_versions: { intent_parser: 'intent_parser/v1', adjudicator: 'adjudicator/v1', narrator: narration?.prompt_version ?? null, verifier: 'verifier/v1' },
      model_identifiers: modelIdentifiers(narration),
      intent,
      retrieval_queries: retrievalQueries,
      retrieved_rule_ids: [...new Set([...(plan.rule_ids ?? []), ...(retrievedRules.results?.map((result) => result.rule_id) ?? []), ...(engineResult.events ?? []).flatMap((event) => event.source_rule_ids ?? [])])],
      adjudication_plan: plan,
      validated_commands: engineResult.commands ?? plan.proposed_commands ?? [],
      rolls: engineResult.rolls ?? [],
      events: engineResult.events ?? [],
      state_version_before: stateBefore,
      state_version_after: stateAfter,
      verification_result: verification,
      latency_ms: latency,
      token_usage: {},
      narration_result: narration ? {
        narration: narration.narration,
        suggestions: narration.suggestions ?? [],
        verification: narration.verification ?? verification,
        prompt_version: narration.prompt_version ?? null,
        provider: narration.provider ?? null,
      } : null,
      ruling,
    })
  }
}
