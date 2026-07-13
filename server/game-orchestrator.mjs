import { createHash, randomUUID } from 'node:crypto'

import { Adjudicator } from './adjudicator.mjs'
import { CampaignNotFoundError, IdempotencyConflictError } from './event-store.mjs'
import { EngineModeResolver } from './engine-mode.mjs'
import { encounterNarration, hasEncounterEvent } from './encounter-narration.mjs'
import { IntentParser, buildRuleQueries } from './intent-parser.mjs'
import { hasMerchantEvent, merchantNarration } from './merchant-narration.mjs'
import { NARRATOR_PROMPT_VERSION, Narrator, deterministicNarration } from './narrator.mjs'
import { eventSummary, normalizeCampaignState } from './rules-engine.mjs'
import { hasSceneEvent, sceneNarration, sceneSuggestions } from './scene-narration.mjs'
import { buildNarrationBrief, projectVisibleState, validateAllowedCommands, verifyNarration } from './security.mjs'
import { buildTurnExplanation, compareShadowResults } from './trace-store.mjs'

// A JSON request cannot manufacture this identity. Only server-owned world
// orchestration may attach it to derived AdvanceScene/merchant commands.
export const DIRECTOR_COMMAND_CAPABILITY = Symbol('skazanie:director-command-capability')

function emptyEffects() {
  return { roll: null, reveal: [], spawn: [], objective: null, grantItems: [] }
}

function rollForLegacy(roll) {
  if (!roll) return null
  return {
    roll_id: roll.roll_id,
    value: roll.kept ?? roll.dice?.[0] ?? 0,
    modifier: Number(roll.modifier) || 0,
    total: Number(roll.total) || 0,
    label: String(roll.purpose || 'Проверка'),
    success: typeof roll.success === 'boolean' ? roll.success : undefined,
  }
}

export function eventsToLegacyEffects(events, rolls = []) {
  const effects = emptyEffects()
  effects.roll = rollForLegacy(rolls[0])
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

function whyNarration(explanation) {
  if (!explanation) return 'Для этой кампании ещё нет сохранённого механического решения.'
  const rules = explanation.rules_used?.length ? `Правила: ${explanation.rules_used.join(', ')}.` : 'Официальное правило не выбрано; использовано временное решение.'
  const rolls = explanation.rolls?.length
    ? `Броски: ${explanation.rolls.map((roll) => `${roll.expression} = ${roll.total}`).join('; ')}.`
    : 'Бросков не было.'
  const events = explanation.events?.length ? `События: ${explanation.events.map(eventSummary).join('; ')}.` : 'Механических событий не было.'
  return `${rules} ${rolls} ${events}`
}

function modelIdentifiers(narration, legacy) {
  return {
    narrator: narration?.provider ?? null,
    legacy_provider: legacy?.provider ?? null,
    legacy_model: legacy?.model ?? null,
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

function deterministicReplayNarration(brief, knownRuleIds) {
  const fallback = deterministicNarration(brief)
  return {
    ...fallback,
    verification: verifyNarration(fallback.narration, brief, { knownRuleIds }),
    prompt_version: NARRATOR_PROMPT_VERSION,
    provider: 'deterministic-idempotent-replay',
  }
}

function deterministicMechanicsNarration(brief, knownRuleIds) {
  const fallback = deterministicNarration(brief)
  return {
    ...fallback,
    suggestions: [],
    verification: verifyNarration(fallback.narration, brief, { knownRuleIds }),
    prompt_version: 'mechanics-log/v1',
    provider: 'deterministic-mechanics',
  }
}

function deterministicMerchantNarration(events, state, brief, knownRuleIds) {
  const narration = merchantNarration(events, state) ?? deterministicNarration(brief).narration
  return {
    narration,
    suggestions: [],
    verification: verifyNarration(narration, brief, { knownRuleIds }),
    prompt_version: 'merchant-narrator/v1',
    provider: 'deterministic-merchant',
  }
}

function deterministicEncounterNarration(events, brief, knownRuleIds) {
  const narration = encounterNarration(events) ?? deterministicNarration(brief).narration
  return {
    narration,
    suggestions: [],
    verification: verifyNarration(narration, brief, { knownRuleIds }),
    prompt_version: 'encounter-narrator/v1',
    provider: 'deterministic-encounter',
  }
}

function deterministicSceneNarration(events, state, brief, knownRuleIds) {
  const narration = sceneNarration(events, state) ?? deterministicNarration(brief).narration
  return {
    narration,
    suggestions: sceneSuggestions(events),
    verification: verifyNarration(narration, brief, { knownRuleIds }),
    prompt_version: 'scene-narrator/v1',
    provider: 'deterministic-scene',
  }
}

export class GameOrchestrator {
  constructor({
    modeResolver = new EngineModeResolver(),
    intentParser = new IntentParser(),
    ruleRetriever = null,
    adjudicator = new Adjudicator(),
    rulesEngine,
    eventStore,
    traceStore = null,
    narrator = new Narrator(),
    legacyHandler = null,
    idFactory = randomUUID,
    now = () => Date.now(),
  } = {}) {
    if (!rulesEngine) throw new TypeError('GameOrchestrator требует RulesEngine')
    if (!eventStore) throw new TypeError('GameOrchestrator требует EventStore')
    this.modeResolver = modeResolver
    this.intentParser = intentParser
    this.ruleRetriever = ruleRetriever
    this.adjudicator = adjudicator
    this.rulesEngine = rulesEngine
    this.eventStore = eventStore
    this.traceStore = traceStore
    this.narrator = narrator
    this.legacyHandler = legacyHandler
    this.idFactory = idFactory
    this.now = now
  }

  async ensureCampaign(campaignId, state) {
    try { return await this.eventStore.load(campaignId) }
    catch (error) {
      if (!(error instanceof CampaignNotFoundError) && error?.code !== 'CAMPAIGN_NOT_FOUND') throw error
      return this.eventStore.importLegacySnapshot({
        campaign_id: campaignId,
        legacy_state: state,
        idempotency_key: `legacy-import:${campaignId}`,
        ruleset_id: state.ruleset_id,
        ruleset_version: state.ruleset_version,
        enabled_rule_packs: state.enabled_rule_packs,
        enabled_house_rules: state.enabled_house_rules,
      })
    }
  }

  async synchronizeLegacyState(campaignId, state, synchronizationKey) {
    const loaded = await this.ensureCampaign(campaignId, state)
    const idempotencyKey = `legacy-sync:${campaignId}:${synchronizationKey}`
    const duplicate = typeof this.eventStore.getByIdempotencyKey === 'function'
      ? await this.eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
      : null
    if (duplicate) return duplicate
    return this.eventStore.commit({
      campaign_id: campaignId,
      expected_state_version: loaded.state_version,
      idempotency_key: idempotencyKey,
      command_id: `legacy-sync-${synchronizationKey}`,
      events: [{
        event_type: 'LegacyStateSynchronized',
        actor_id: null,
        target_ids: [],
        payload: { state: normalizeCampaignState(state), source: 'legacy_room_snapshot' },
        source_rule_ids: [],
        ruling_id: null,
        visibility: 'gm_only',
      }],
    })
  }

  explanation(campaignId, turnId = null) {
    if (!this.traceStore) return null
    const trace = turnId ? this.traceStore.get(campaignId, turnId) : this.traceStore.latest(campaignId)
    return buildTurnExplanation(trace)
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
    const turnId = Array.isArray(input.commands)
      ? structuredCommandTurnId(campaignId, idempotencyKey)
      : this.idFactory()
    const configuredMode = typeof this.modeResolver === 'function'
      ? this.modeResolver(input)
      : this.modeResolver.resolve({ testMode: input.testMode, user: input.user, campaign: { ...originalState, ...(input.campaign ?? {}) } })
    // Structured actions are the one canonical gameplay path. The old mode
    // resolver remains only for importing snapshots and legacy free-form
    // narration; buttons/API commands always commit authoritative events.
    const mode = Array.isArray(input.commands) ? 'enforce' : configuredMode

    if (message === '/why' || input.why === true) {
      const explanation = this.explanation(campaignId, input.turnId ?? input.turn_id)
      return { narration: whyNarration(explanation), suggestions: [], effects: emptyEffects(), provider: 'RulesEngine', model: 'deterministic', engine_mode: mode, turn_id: explanation?.turn_id ?? null, state_version: originalState.state_version, explanation, turn_consumed: false }
    }

    const viewer = { playerId, partyIds: input.partyIds ?? [], isPartyMember: true, role: input.user?.role }
    const visibleState = projectVisibleState(originalState, viewer) ?? {}
    const intent = input.commands
      ? { actor_id: playerId, intent: 'structured_commands', approach: 'api', targets: [], mentioned_entities: [], missing_information: [], requires_clarification: false, confidence: 1, raw_message: message }
      : await this.intentParser.parse({ message, playerId, visibleState })
    const retrievalQueries = buildRuleQueries(intent, originalState)
    const retrievedRules = this.ruleRetriever && retrievalQueries.length
      ? await this.ruleRetriever.search({ queries: retrievalQueries, ruleset_id: originalState.ruleset_id, enabled_packs: originalState.enabled_rule_packs, limit: 10 })
      : { results: [], confidence: 0, count: 0 }
    let plan = input.commands
      ? { rule_ids: [...new Set(input.commands.flatMap((command) => command.source_rule_ids ?? []))], proposed_commands: input.commands, roll_requests: [], ruling_required: false, ruling_draft: null, narration_constraints: [], confidence: 1 }
      : await this.adjudicator.createPlan({ intent, state: originalState, retrievedRules })
    plan = { ...plan, proposed_commands: validateAllowedCommands(plan.proposed_commands ?? []).map((command, index) => ({ ...command, campaign_id: campaignId, command_id: `${idempotencyKey}:${index + 1}` })) }

    let legacyResult = null
    if (mode === 'legacy' || mode === 'shadow') {
      if (!this.legacyHandler) throw new TypeError('Для legacy/shadow требуется legacyHandler')
      legacyResult = await this.legacyHandler({ ...input, state: originalState, message, playerId, idempotencyKey, retrievedRules })
      legacyResult.effects ??= emptyEffects()
    }

    if (mode === 'legacy') {
      const response = { ...legacyResult, turn_id: turnId, engine_mode: mode, state_version: originalState.state_version }
      this.saveTrace({ turnId, campaignId, mode, intent, retrievalQueries, retrievedRules, plan, stateBefore: originalState.state_version, stateAfter: originalState.state_version, legacyResult, latency: this.now() - started })
      return response
    }

    let loaded = await this.ensureCampaign(campaignId, originalState)
    if (mode === 'shadow' && input.roomVersion != null) loaded = await this.synchronizeLegacyState(campaignId, originalState, input.roomVersion)
    const authoritativeState = normalizeCampaignState(loaded.state)

    if (mode === 'shadow') {
      let engineResult
      try {
        engineResult = plan.proposed_commands.length
          ? this.rulesEngine.resolvePlan(plan, authoritativeState, rulesContext)
          : { commands: [], events: [], rolls: [], state: authoritativeState }
      } catch (error) {
        engineResult = { commands: [], events: [], rolls: [], state: authoritativeState, error: { code: error.code ?? 'SHADOW_ERROR', message: error.message } }
      }
      const comparison = compareShadowResults(legacyResult, engineResult)
      if (engineResult.error) comparison.differences.push({ field: 'engine_error', ...engineResult.error })
      const response = { ...legacyResult, turn_id: turnId, engine_mode: mode, state_version: authoritativeState.state_version, shadow_comparison: comparison }
      this.saveTrace({ turnId, campaignId, mode, intent, retrievalQueries, retrievedRules, plan, engineResult, comparison, stateBefore: authoritativeState.state_version, stateAfter: authoritativeState.state_version, legacyResult, latency: this.now() - started })
      return response
    }

    if (intent.requires_clarification || plan.clarification_required) {
      const narration = `Нужно уточнение: ${(intent.missing_information ?? plan.missing_information ?? []).join(', ')}.`
      const response = { narration, suggestions: [], effects: emptyEffects(), provider: 'RulesEngine', model: 'deterministic', turn_id: turnId, engine_mode: mode, state_version: authoritativeState.state_version, mechanics: [], visible_state_changes: [], turn_consumed: false }
      this.saveTrace({ turnId, campaignId, mode, intent, retrievalQueries, retrievedRules, plan, stateBefore: authoritativeState.state_version, stateAfter: authoritativeState.state_version, verification: { valid: true }, latency: this.now() - started })
      return response
    }

    const duplicate = typeof this.eventStore.getByIdempotencyKey === 'function'
      ? await this.eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
      : null
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
      engineResult = this.rulesEngine.resolvePlan(plan, authoritativeState, rulesContext)
      if (!engineResult.events.length) throw new Error('Enforce-ход не создал ни события, ни ruling')
      try {
        committed = await this.eventStore.commit({ campaign_id: campaignId, expected_state_version: authoritativeState.state_version, idempotency_key: idempotencyKey, command_id: idempotencyKey, events: engineResult.events })
      } catch (error) {
        if (!(error instanceof IdempotencyConflictError) && error?.code !== 'IDEMPOTENCY_CONFLICT') throw error
        committed = await this.eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
        if (!committed) throw error
      }
    }

    const committedEvents = committed.events ?? engineResult.events
    const changes = visibleChanges(committedEvents)
    const brief = buildNarrationBrief({
      visible_events: committedEvents,
      visible_state_changes: changes,
      known_environment: projectVisibleState(committed.state.scene ?? {}, viewer, { forNarrator: true }) ?? {},
      permitted_npc_reactions: [],
      viewer,
    })
    const resolvedRuleIds = [...new Set([...(plan.rule_ids ?? []), ...committedEvents.flatMap((event) => event.source_rule_ids ?? [])])]
    const idempotentReplay = Boolean(duplicate || committed.duplicate)
    const replayTrace = idempotentReplay && this.traceStore && typeof this.traceStore.get === 'function'
      ? this.traceStore.get(campaignId, turnId)
      : null
    const replayFallback = hasSceneEvent(committedEvents)
      ? deterministicSceneNarration(committedEvents, committed.state, brief, resolvedRuleIds)
      : hasMerchantEvent(committedEvents)
        ? deterministicMerchantNarration(committedEvents, committed.state, brief, resolvedRuleIds)
        : hasEncounterEvent(committedEvents)
          ? deterministicEncounterNarration(committedEvents, brief, resolvedRuleIds)
          : deterministicReplayNarration(brief, resolvedRuleIds)
    const structuredMechanics = Array.isArray(input.commands)
      && !hasSceneEvent(committedEvents)
      && !hasMerchantEvent(committedEvents)
      && !hasEncounterEvent(committedEvents)
    const narration = idempotentReplay
      ? cachedNarration(replayTrace, brief, resolvedRuleIds) ?? replayFallback
      : hasSceneEvent(committedEvents)
        ? deterministicSceneNarration(committedEvents, committed.state, brief, resolvedRuleIds)
        : hasMerchantEvent(committedEvents)
          ? deterministicMerchantNarration(committedEvents, committed.state, brief, resolvedRuleIds)
          : hasEncounterEvent(committedEvents)
            ? deterministicEncounterNarration(committedEvents, brief, resolvedRuleIds)
            : structuredMechanics
              ? deterministicMechanicsNarration(brief, resolvedRuleIds)
              : await this.narrator.render(brief, { knownRuleIds: resolvedRuleIds })
    const response = {
      narration: narration.narration,
      suggestions: narration.suggestions,
      effects: eventsToLegacyEffects(committedEvents, engineResult.rolls),
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
    }
    if (!idempotentReplay) {
      this.saveTrace({ turnId, campaignId, idempotencyKey, mode, intent, retrievalQueries, retrievedRules, plan, engineResult: { ...engineResult, events: committedEvents }, stateBefore: authoritativeState.state_version, stateAfter: committed.state_version, verification: narration.verification, latency: this.now() - started, narration, ruling: plan.ruling_draft })
    }
    return response
  }

  saveTrace({ turnId, campaignId, idempotencyKey = null, mode, intent, retrievalQueries, retrievedRules, plan, engineResult = {}, comparison = null, stateBefore, stateAfter, verification = {}, latency, legacyResult = null, narration = null, ruling = null }) {
    if (!this.traceStore) return null
    return this.traceStore.save({
      turn_id: turnId,
      campaign_id: campaignId,
      idempotency_key: idempotencyKey,
      engine_mode: mode,
      prompt_versions: { intent_parser: 'intent_parser/v1', adjudicator: 'adjudicator/v1', narrator: narration?.prompt_version ?? null, verifier: 'verifier/v1' },
      model_identifiers: modelIdentifiers(narration, legacyResult),
      intent,
      retrieval_queries: retrievalQueries,
      retrieved_rule_ids: [...new Set([...(plan.rule_ids ?? []), ...(retrievedRules.results?.map((result) => result.rule_id) ?? []), ...(engineResult.events ?? []).flatMap((event) => event.source_rule_ids ?? [])])],
      adjudication_plan: plan,
      validated_commands: engineResult.commands ?? plan.proposed_commands ?? [],
      rolls: engineResult.rolls ?? [],
      events: engineResult.events ?? [],
      shadow_comparison: comparison,
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
