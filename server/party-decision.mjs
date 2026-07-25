const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u
const TYPES = new Set(['vote', 'roll', 'choice'])

export const PARTY_DECISION_POLICY_VERSION = 'skazanie:party-decision-policy:v1'
export const DEFAULT_PARTY_DECISION_POLICY = Object.freeze({
  schemaVersion: 1,
  policyVersion: PARTY_DECISION_POLICY_VERSION,
  voterScope: 'account',
  decisionTtlMs: 120_000,
  quorumMode: 'majority_of_active_voters',
  disconnectAction: 'abstain',
  expiryResolution: 'plurality_first_option',
  visibility: 'party',
})

export class PartyDecisionError extends Error {
  constructor(message, code = 'INVALID_PARTY_DECISION') {
    super(message)
    this.name = 'PartyDecisionError'
    this.code = code
  }
}

function id(value, label) {
  const normalized = String(value ?? '').trim()
  if (!SAFE_ID.test(normalized)) throw new PartyDecisionError(`${label} содержит недопустимый идентификатор`)
  return normalized
}

function text(value, maximum, fallback = '') {
  return String(value ?? fallback).normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

function uniqueIds(value, maximum = 20) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter((candidate) => SAFE_ID.test(candidate)))].slice(0, maximum)
}

function safeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : fallback
}

export function normalizePartyDecisionPolicy(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const rawTtl = source.decisionTtlMs ?? source.decision_ttl_ms ?? source.ttlMs
  return {
    schemaVersion: 1,
    policyVersion: PARTY_DECISION_POLICY_VERSION,
    voterScope: source.voterScope === 'hero' || source.voter_scope === 'hero' ? 'hero' : 'account',
    decisionTtlMs: Math.max(1_000, Math.min(30 * 60 * 1_000, safeNumber(rawTtl, DEFAULT_PARTY_DECISION_POLICY.decisionTtlMs))),
    quorumMode: 'majority_of_active_voters',
    disconnectAction: 'abstain',
    expiryResolution: 'plurality_first_option',
    visibility: 'party',
  }
}

function requiredVotesFor(type, voterCount) {
  if (type === 'choice') return voterCount > 0 ? 1 : 0
  return voterCount > 0 ? Math.floor(voterCount / 2) + 1 : 0
}

function normalizedVoterMap(value, eligibleActorIds, voterScope) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const result = {}
  for (const actorId of eligibleActorIds) {
    const candidate = String(source[actorId] ?? '').trim()
    result[actorId] = SAFE_ID.test(candidate)
      ? candidate
      : voterScope === 'account' ? `hero:${actorId}` : actorId
  }
  return result
}

function normalizedAbstentions(value, eligibleVoterIds) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const allowed = new Set(eligibleVoterIds)
  return Object.fromEntries(Object.entries(source)
    .map(([voterId, reason]) => [String(voterId), text(reason, 80, 'abstain')])
    .filter(([voterId]) => SAFE_ID.test(voterId) && (!allowed.size || allowed.has(voterId)))
    .slice(0, 20))
}

export function normalizePartyDecision(value, { policy = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PartyDecisionError('Групповое решение должно быть объектом')
  }
  const decisionId = id(value.id, 'Решение')
  const type = TYPES.has(value.type) ? value.type : 'vote'
  const decisionPolicy = normalizePartyDecisionPolicy(policy ?? value.policy)
  const options = (Array.isArray(value.options) ? value.options : []).slice(0, 6).map((option) => ({
    id: id(option?.id, 'Вариант решения'),
    label: text(option?.label, 180),
  }))
  if (options.length < 1 || options.some((option) => !option.label)) {
    throw new PartyDecisionError('Групповое решение не содержит допустимых вариантов')
  }
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new PartyDecisionError('Идентификаторы вариантов решения должны быть уникальны')
  }
  const optionIds = new Set(options.map((option) => option.id))
  const eligibleActorIds = uniqueIds(value.eligibleActorIds ?? value.eligible_actor_ids)
  const voterByActorId = normalizedVoterMap(value.voterByActorId ?? value.voter_by_actor_id, eligibleActorIds, decisionPolicy.voterScope)
  const derivedVoterIds = eligibleActorIds.map((actorId) => voterByActorId[actorId]).filter(Boolean)
  const eligibleVoterIds = uniqueIds(value.eligibleVoterIds ?? value.eligible_voter_ids ?? derivedVoterIds)
  const abstentionInput = value.abstentions ?? value.abstentionReasons ?? {}
  const abstentions = normalizedAbstentions(abstentionInput, eligibleVoterIds)
  const abstainedVoterIds = uniqueIds(value.abstainedVoterIds ?? value.abstained_voter_ids ?? Object.keys(abstentions))
    .filter((voterId) => !eligibleVoterIds.length || eligibleVoterIds.includes(voterId))
  const defaultActiveVoterIds = eligibleVoterIds.filter((voterId) => !abstainedVoterIds.includes(voterId))
  const activeVoterIds = uniqueIds(value.activeVoterIds ?? value.active_voter_ids ?? defaultActiveVoterIds)
    .filter((voterId) => !eligibleVoterIds.length || eligibleVoterIds.includes(voterId))
    .filter((voterId) => !abstainedVoterIds.includes(voterId))
  const votes = {}
  for (const [actorId, optionId] of Object.entries(value.votes ?? {})) {
    const normalizedActorId = String(actorId)
    const normalizedOptionId = String(optionId)
    if (!SAFE_ID.test(normalizedActorId) || !optionIds.has(normalizedOptionId)) continue
    if (eligibleActorIds.length && !eligibleActorIds.includes(normalizedActorId)) continue
    const voterId = voterByActorId[normalizedActorId] ?? normalizedActorId
    if (abstainedVoterIds.includes(voterId) || (activeVoterIds.length && !activeVoterIds.includes(voterId))) continue
    for (const previousActorId of Object.keys(votes)) {
      if ((voterByActorId[previousActorId] ?? previousActorId) === voterId) delete votes[previousActorId]
    }
    votes[normalizedActorId] = normalizedOptionId
  }
  const resolvedOptionId = value.resolvedOptionId == null ? null : String(value.resolvedOptionId)
  const status = value.status === 'resolved' && optionIds.has(resolvedOptionId) ? 'resolved' : 'open'
  const createdAt = Math.max(0, safeNumber(value.createdAt ?? value.created_at, 0))
  const rawExpiresAt = safeNumber(value.expiresAt ?? value.expires_at, 0)
  const expiresAt = rawExpiresAt > 0
    ? Math.max(createdAt, rawExpiresAt)
    : createdAt > 0 ? createdAt + decisionPolicy.decisionTtlMs : 0
  const calculatedRequired = requiredVotesFor(type, activeVoterIds.length || eligibleVoterIds.length)
  const rawRequired = safeNumber(value.requiredVotes ?? value.required_votes, calculatedRequired)
  const maximumRequired = activeVoterIds.length || eligibleVoterIds.length
  const requiredVotes = Math.max(0, Math.min(maximumRequired, rawRequired))
  return {
    id: decisionId,
    type,
    title: text(value.title, 100, 'Решение отряда'),
    description: text(value.description, 360),
    options,
    votes,
    status,
    ...(status === 'resolved' ? { resolvedOptionId } : {}),
    eligibleActorIds,
    eligibleVoterIds,
    voterByActorId,
    activeVoterIds,
    abstainedVoterIds,
    abstentions,
    requiredVotes,
    voterScope: decisionPolicy.voterScope,
    policy: decisionPolicy,
    policyVersion: PARTY_DECISION_POLICY_VERSION,
    ...(type === 'roll' ? { difficulty: Math.max(5, Math.min(25, safeNumber(value.difficulty, 12))) } : {}),
    ...(value.roll && typeof value.roll === 'object' ? { roll: structuredClone(value.roll) } : {}),
    resolutionPrompt: text(value.resolutionPrompt, 360),
    createdAt,
    expiresAt,
    ...(value.resolutionReason ? { resolutionReason: text(value.resolutionReason, 80) } : {}),
  }
}

function partyIds(state) {
  return new Set((state?.partyMemberIds?.length
    ? state.partyMemberIds
    : state?.players?.map((player) => player.id) ?? []).map(String))
}

function participantContext(interaction, eligibleHeroIds = []) {
  const snapshottedHeroes = uniqueIds(interaction.eligibleActorIds)
  const eligibleActors = snapshottedHeroes.length
    ? snapshottedHeroes
    : uniqueIds(eligibleHeroIds)
  const voterByActorId = normalizedVoterMap(interaction.voterByActorId, eligibleActors, interaction.voterScope)
  const derivedVoterIds = eligibleActors.map((actorId) => voterByActorId[actorId])
  const eligibleVoters = uniqueIds(interaction.eligibleVoterIds?.length ? interaction.eligibleVoterIds : derivedVoterIds)
  const abstainedVoters = uniqueIds(interaction.abstainedVoterIds)
  const activeVoters = uniqueIds(interaction.activeVoterIds?.length
    ? interaction.activeVoterIds
    : eligibleVoters.filter((voterId) => !abstainedVoters.includes(voterId)))
    .filter((voterId) => !abstainedVoters.includes(voterId))
  const required = interaction.eligibleActorIds.length || interaction.eligibleVoterIds.length
    ? interaction.requiredVotes
    : requiredVotesFor(interaction.type, activeVoters.length || eligibleVoters.length)
  return {
    eligibleActors,
    voterByActorId,
    eligibleVoters,
    abstainedVoters,
    activeVoters,
    required,
  }
}

function voterFor(context, actorId) {
  return context.voterByActorId[actorId] ?? actorId
}

function cleanVotes(interaction, context, { includeInactive = false } = {}) {
  const votes = {}
  for (const [actorId, optionId] of Object.entries(interaction.votes ?? {})) {
    if (!context.eligibleActors.includes(String(actorId))) continue
    const voterId = voterFor(context, String(actorId))
    if (!includeInactive && context.activeVoters.length && !context.activeVoters.includes(voterId)) continue
    if (context.abstainedVoters.includes(voterId)) continue
    if (!interaction.options.some((option) => option.id === String(optionId))) continue
    for (const previousActorId of Object.keys(votes)) {
      if (voterFor(context, previousActorId) === voterId) delete votes[previousActorId]
    }
    votes[String(actorId)] = String(optionId)
  }
  return votes
}

function winnerFor(interaction, context, votes, { requireQuorum = true } = {}) {
  const counts = new Map(interaction.options.map((option) => [option.id, 0]))
  for (const [actorId, optionId] of Object.entries(votes)) {
    const voterId = voterFor(context, actorId)
    if (context.activeVoters.length && !context.activeVoters.includes(voterId)) continue
    if (counts.has(optionId)) counts.set(optionId, counts.get(optionId) + 1)
  }
  if (!requireQuorum) {
    const highest = Math.max(0, ...counts.values())
    return interaction.options.find((option) => counts.get(option.id) === highest) ?? interaction.options[0]
  }
  return interaction.options.find((option) => counts.get(option.id) >= context.required) ?? null
}

function partyTargets(context) {
  return context.eligibleActors
}

function partyDecisionEvent(eventType, actorId, context, payload = {}) {
  return {
    event_type: eventType,
    actor_id: actorId ?? null,
    visibility: 'party',
    target_ids: partyTargets(context),
    source_rule_ids: [],
    payload: {
      eligible_hero_ids: context.eligibleActors,
      eligible_voter_ids: context.eligibleVoters,
      active_voter_ids: context.activeVoters,
      required_votes: context.required,
      ...payload,
    },
  }
}

export function partyDecisionOpenedEvent(interaction, actorId = null, {
  eligibleHeroIds = [],
  eligibleVoterIds = [],
  voterByHeroId = {},
  policy = null,
} = {}) {
  const decisionPolicy = normalizePartyDecisionPolicy(policy ?? interaction?.policy)
  const eligibleActorIds = uniqueIds(eligibleHeroIds)
  const mappedVoters = normalizedVoterMap(voterByHeroId, eligibleActorIds, decisionPolicy.voterScope)
  const derivedVoterIds = eligibleActorIds.map((heroId) => mappedVoters[heroId])
  const voters = uniqueIds(eligibleVoterIds.length ? eligibleVoterIds : derivedVoterIds)
  const createdAt = Math.max(0, safeNumber(interaction?.createdAt ?? interaction?.created_at, Date.now()))
  const requiredVotes = interaction?.type === 'choice' ? 1 : requiredVotesFor(interaction?.type, voters.length)
  return {
    event_type: 'PartyDecisionOpened',
    actor_id: actorId ? id(actorId, 'Инициатор') : null,
    visibility: 'party',
    target_ids: [],
    source_rule_ids: [],
    payload: {
      interaction: normalizePartyDecision({
        ...interaction,
        votes: {},
        status: 'open',
        roll: undefined,
        eligibleActorIds,
        eligibleVoterIds: voters,
        voterByActorId: mappedVoters,
        activeVoterIds: voters,
        abstainedVoterIds: [],
        abstentions: {},
        requiredVotes,
        policy: decisionPolicy,
        createdAt,
        expiresAt: createdAt + decisionPolicy.decisionTtlMs,
      }, { policy: decisionPolicy }),
    },
  }
}

function validatePartyVoteState(state, interactionId, type = null) {
  const interaction = normalizePartyDecision(state?.agentInteraction)
  if (interaction.id !== id(interactionId, 'Решение')) {
    throw new PartyDecisionError('Групповое решение устарело', 'PARTY_DECISION_CONFLICT')
  }
  if (interaction.status !== 'open' || (type && interaction.type !== type)) {
    throw new PartyDecisionError(type === 'roll' ? 'Общий бросок уже завершён или сейчас не требуется' : 'Голосование уже завершено или не принимает голоса', 'PARTY_DECISION_CLOSED')
  }
  return interaction
}

function assertHeroInParty(state, heroId) {
  const actor = id(heroId, 'Герой')
  const party = partyIds(state)
  if (!party.has(actor)) throw new PartyDecisionError('Герой не входит в отряд', 'ACTOR_FORBIDDEN')
  return actor
}

export function resolvePartyRoll(state, {
  interactionId,
  heroId,
  roll,
} = {}) {
  const interaction = validatePartyVoteState(state, interactionId, 'roll')
  const actor = assertHeroInParty(state, heroId)
  const context = participantContext(interaction, [...partyIds(state)])
  if (context.eligibleActors.length && !context.eligibleActors.includes(actor)) {
    throw new PartyDecisionError('Герой не участвовал при открытии общего броска', 'ACTOR_FORBIDDEN')
  }
  const voterId = voterFor(context, actor)
  if (context.activeVoters.length && !context.activeVoters.includes(voterId)) {
    throw new PartyDecisionError('Этот участник уже воздержался', 'PARTY_DECISION_ABSTAINED')
  }
  const total = Number(roll?.total)
  const die = Number(roll?.dice?.[0] ?? total)
  if (!Number.isSafeInteger(total) || total < 1 || total > 20 || !Number.isSafeInteger(die) || die < 1 || die > 20) {
    throw new PartyDecisionError('Серверный результат общего броска недопустим', 'INVALID_PARTY_ROLL')
  }
  const success = total >= interaction.difficulty
  const winner = interaction.options[success ? 0 : 1] ?? interaction.options[0]
  const player = (state?.players ?? []).find((candidate) => String(candidate?.id ?? '') === actor)
  const rolledAt = Date.parse(String(roll?.created_at ?? ''))
  const resolvedRoll = {
    id: String(roll.roll_id ?? roll.id ?? ''),
    roll_id: String(roll.roll_id ?? roll.id ?? ''),
    kind: 'party',
    expression: '1d20',
    sides: 20,
    value: die,
    total,
    playerId: actor,
    playerName: text(player?.character ?? player?.name, 120, 'Герой'),
    rolledAt: Number.isFinite(rolledAt) ? rolledAt : 0,
    purpose: 'party_decision',
  }
  return {
    resolvedOptionId: winner.id,
    roll: resolvedRoll,
    events: [{
      event_type: 'DieRolled',
      actor_id: actor,
      visibility: 'party',
      target_ids: partyTargets(context),
      source_rule_ids: [],
      payload: {
        roll_id: resolvedRoll.roll_id,
        expression: '1d20',
        dice: [die],
        modifier: 0,
        total,
        purpose: 'party_decision',
      },
    }, partyDecisionEvent('PartyDecisionResolved', actor, context, {
      interaction_id: interaction.id,
      resolved_option_id: winner.id,
      votes: {},
      abstained_voter_ids: context.abstainedVoters,
      resolution_reason: 'roll',
      required_votes: 1,
      difficulty: interaction.difficulty,
      success,
      roll: resolvedRoll,
    })],
  }
}

export function resolvePartyVote(state, {
  interactionId,
  heroId,
  optionId,
  eligibleHeroIds,
} = {}) {
  const interaction = validatePartyVoteState(state, interactionId)
  if (interaction.type === 'roll') throw new PartyDecisionError('Общий бросок не принимает голоса', 'PARTY_DECISION_CLOSED')
  const voter = assertHeroInParty(state, heroId)
  const selected = id(optionId, 'Вариант')
  if (!interaction.options.some((option) => option.id === selected)) {
    throw new PartyDecisionError('Вариант решения не найден', 'PARTY_OPTION_NOT_FOUND')
  }
  const context = participantContext(interaction, eligibleHeroIds ?? [...partyIds(state)])
  if (context.eligibleActors.length && !context.eligibleActors.includes(voter)) {
    throw new PartyDecisionError('Герой не участвовал при открытии голосования', 'ACTOR_FORBIDDEN')
  }
  const voterId = voterFor(context, voter)
  if (context.activeVoters.length && !context.activeVoters.includes(voterId)) {
    throw new PartyDecisionError('Этот участник уже воздержался', 'PARTY_DECISION_ABSTAINED')
  }
  const votes = cleanVotes(interaction, context)
  let replacedActorId = null
  for (const actorId of Object.keys(votes)) {
    if (voterFor(context, actorId) === voterId) {
      replacedActorId = actorId
      delete votes[actorId]
    }
  }
  votes[voter] = selected
  const winner = winnerFor(interaction, context, votes)
  const events = [partyDecisionEvent('PartyVoteCast', voter, context, {
    interaction_id: interaction.id,
    hero_id: voter,
    voter_id: voterId,
    option_id: selected,
    ...(replacedActorId ? { replaced_hero_id: replacedActorId } : {}),
    votes,
  })]
  if (winner) {
    events.push(partyDecisionEvent('PartyDecisionResolved', voter, context, {
      interaction_id: interaction.id,
      resolved_option_id: winner.id,
      votes,
      abstained_voter_ids: context.abstainedVoters,
      resolution_reason: 'quorum',
    }))
  }
  return { events, votes, required: context.required, resolvedOptionId: winner?.id ?? null }
}

export function resolvePartyAbstain(state, {
  interactionId,
  heroId,
} = {}) {
  const interaction = validatePartyVoteState(state, interactionId)
  if (interaction.type === 'roll') throw new PartyDecisionError('Общий бросок не принимает abstain', 'PARTY_DECISION_CLOSED')
  const actor = assertHeroInParty(state, heroId)
  const context = participantContext(interaction, [...partyIds(state)])
  if (context.eligibleActors.length && !context.eligibleActors.includes(actor)) {
    throw new PartyDecisionError('Герой не участвовал при открытии голосования', 'ACTOR_FORBIDDEN')
  }
  const voterId = voterFor(context, actor)
  if (context.activeVoters.length && !context.activeVoters.includes(voterId)) {
    throw new PartyDecisionError('Этот участник уже воздержался', 'PARTY_DECISION_ABSTAINED')
  }
  const activeVoterIds = context.activeVoters.filter((candidate) => candidate !== voterId)
  const abstainedVoterIds = [...new Set([...context.abstainedVoters, voterId])]
  const votes = cleanVotes(interaction, context)
  for (const existingActorId of Object.keys(votes)) {
    if (voterFor(context, existingActorId) === voterId) delete votes[existingActorId]
  }
  const nextContext = { ...context, activeVoters: activeVoterIds, abstainedVoters: abstainedVoterIds, required: requiredVotesFor(interaction.type, activeVoterIds.length) }
  const events = [partyDecisionEvent('PartyDecisionAbstained', actor, nextContext, {
    interaction_id: interaction.id,
    hero_id: actor,
    voter_id: voterId,
    reason: 'explicit',
    abstained_voter_ids: abstainedVoterIds,
    abstentions: { ...interaction.abstentions, [voterId]: 'explicit' },
    votes,
  })]
  const winner = activeVoterIds.length ? winnerFor(interaction, nextContext, votes) : interaction.options[0]
  if (winner) {
    events.push(partyDecisionEvent('PartyDecisionResolved', actor, nextContext, {
      interaction_id: interaction.id,
      resolved_option_id: winner.id,
      votes,
      abstained_voter_ids: abstainedVoterIds,
      resolution_reason: activeVoterIds.length ? 'quorum_after_abstain' : 'all_voters_abstained',
    }))
  }
  return { events, votes, required: nextContext.required, resolvedOptionId: winner?.id ?? null }
}

export function partyDecisionActiveVoterIds(interactionValue, connectedHeroIds = []) {
  const interaction = normalizePartyDecision(interactionValue)
  const connected = new Set(connectedHeroIds.map(String))
  const context = participantContext(interaction, [...connected])
  return [...new Set(context.eligibleActors
    .filter((actorId) => connected.has(actorId))
    .map((actorId) => voterFor(context, actorId)))]
}

export function partyDecisionPresenceEvents(state, { activeVoterIds = [] } = {}) {
  const interaction = validatePartyVoteState(state, state?.agentInteraction?.id)
  const context = participantContext(interaction)
  const activeNow = new Set(uniqueIds(activeVoterIds))
  const activeVoterIdsAfter = context.activeVoters.filter((voterId) => activeNow.has(voterId))
  const departed = context.activeVoters.filter((voterId) => !activeNow.has(voterId))
  if (!departed.length) return { events: [], activeVoterIds: context.activeVoters, abstainedVoterIds: context.abstainedVoters }
  const abstainedVoterIds = [...new Set([...context.abstainedVoters, ...departed])]
  const nextContext = {
    ...context,
    activeVoters: activeVoterIdsAfter,
    abstainedVoters: abstainedVoterIds,
    required: requiredVotesFor(interaction.type, activeVoterIdsAfter.length),
  }
  const votes = cleanVotes(interaction, context)
  for (const actorId of Object.keys(votes)) {
    if (departed.includes(voterFor(context, actorId))) delete votes[actorId]
  }
  const events = [partyDecisionEvent('PartyDecisionAbstained', null, nextContext, {
    interaction_id: interaction.id,
    voter_id: departed[0],
    reason: 'disconnected',
    abstained_voter_ids: abstainedVoterIds,
    abstentions: Object.fromEntries(departed.map((voterId) => [voterId, 'disconnected'])),
    votes,
  })]
  const winner = activeVoterIdsAfter.length ? winnerFor(interaction, nextContext, votes) : interaction.options[0]
  if (winner) {
    events.push(partyDecisionEvent('PartyDecisionResolved', null, nextContext, {
      interaction_id: interaction.id,
      resolved_option_id: winner.id,
      votes,
      abstained_voter_ids: abstainedVoterIds,
      resolution_reason: activeVoterIdsAfter.length ? 'quorum_after_disconnect' : 'all_voters_absent',
    }))
  }
  return { events, activeVoterIds: activeVoterIdsAfter, abstainedVoterIds }
}

export function partyDecisionExpiryEvents(state, { now = Date.now() } = {}) {
  const interaction = state?.agentInteraction ? normalizePartyDecision(state.agentInteraction) : null
  if (!interaction || interaction.status !== 'open' || !interaction.expiresAt || Number(now) < interaction.expiresAt) return { events: [] }
  const context = participantContext(interaction)
  const votes = cleanVotes(interaction, context)
  const winner = winnerFor(interaction, context, votes, { requireQuorum: false })
  return {
    events: [partyDecisionEvent('PartyDecisionExpired', null, context, {
      interaction_id: interaction.id,
      resolved_option_id: winner.id,
      votes,
      abstained_voter_ids: context.abstainedVoters,
      resolution_reason: 'expired',
      expired_at: interaction.expiresAt,
    })],
  }
}
