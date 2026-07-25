const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u
const TYPES = new Set(['vote', 'roll', 'choice'])

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

export function normalizePartyDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PartyDecisionError('Групповое решение должно быть объектом')
  }
  const decisionId = id(value.id, 'Решение')
  const type = TYPES.has(value.type) ? value.type : 'vote'
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
  const votes = Object.fromEntries(Object.entries(value.votes ?? {})
    .map(([heroId, optionId]) => [String(heroId), String(optionId)])
    .filter(([heroId, optionId]) => SAFE_ID.test(heroId) && optionIds.has(optionId))
    .slice(0, 20))
  const resolvedOptionId = value.resolvedOptionId == null ? null : String(value.resolvedOptionId)
  const status = value.status === 'resolved' && optionIds.has(resolvedOptionId) ? 'resolved' : 'open'
  const eligibleActorIds = [...new Set((value.eligibleActorIds ?? value.eligible_actor_ids ?? [])
    .map(String).filter((candidate) => SAFE_ID.test(candidate)))].slice(0, 20)
  const defaultRequired = type === 'choice' ? 1 : Math.floor(Math.max(1, eligibleActorIds.length) / 2) + 1
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
    requiredVotes: Math.max(1, Math.min(Math.max(1, eligibleActorIds.length), Number(value.requiredVotes ?? value.required_votes) || defaultRequired)),
    policyVersion: 'skazanie:party-decision:v1',
    ...(type === 'roll' ? { difficulty: Math.max(5, Math.min(25, Number(value.difficulty) || 12)) } : {}),
    ...(value.roll && typeof value.roll === 'object' ? { roll: structuredClone(value.roll) } : {}),
    resolutionPrompt: text(value.resolutionPrompt, 360),
    createdAt: Math.max(0, Number(value.createdAt) || 0),
  }
}

export function partyDecisionOpenedEvent(interaction, actorId = null, { eligibleHeroIds = [] } = {}) {
  const eligibleActorIds = [...new Set(eligibleHeroIds.map(String).filter((candidate) => SAFE_ID.test(candidate)))].slice(0, 20)
  const type = TYPES.has(interaction?.type) ? interaction.type : 'vote'
  const requiredVotes = type === 'choice' ? 1 : Math.floor(Math.max(1, eligibleActorIds.length) / 2) + 1
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
        requiredVotes,
      }),
    },
  }
}

export function resolvePartyRoll(state, {
  interactionId,
  heroId,
  roll,
} = {}) {
  const interaction = normalizePartyDecision(state?.agentInteraction)
  if (interaction.id !== id(interactionId, 'Решение')) {
    throw new PartyDecisionError('Групповое решение устарело', 'PARTY_DECISION_CONFLICT')
  }
  if (interaction.status !== 'open' || interaction.type !== 'roll') {
    throw new PartyDecisionError('Общий бросок уже завершён или сейчас не требуется', 'PARTY_DECISION_CLOSED')
  }
  const actor = id(heroId, 'Герой')
  const party = new Set((state?.partyMemberIds?.length ? state.partyMemberIds : state?.players?.map((player) => player.id) ?? []).map(String))
  if (!party.has(actor)) throw new PartyDecisionError('Герой не входит в отряд', 'ACTOR_FORBIDDEN')
  const eligible = interaction.eligibleActorIds.filter((candidate) => party.has(candidate))
  if (eligible.length && !eligible.includes(actor)) {
    throw new PartyDecisionError('Герой не участвовал при открытии общего броска', 'ACTOR_FORBIDDEN')
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
      target_ids: eligible,
      source_rule_ids: [],
      payload: {
        roll_id: resolvedRoll.roll_id,
        expression: '1d20',
        dice: [die],
        modifier: 0,
        total,
        purpose: 'party_decision',
      },
    }, {
      event_type: 'PartyDecisionResolved',
      actor_id: actor,
      visibility: 'party',
      target_ids: eligible,
      source_rule_ids: [],
      payload: {
        interaction_id: interaction.id,
        resolved_option_id: winner.id,
        votes: {},
        eligible_hero_ids: eligible,
        required_votes: 1,
        difficulty: interaction.difficulty,
        success,
        roll: resolvedRoll,
      },
    }],
  }
}

export function resolvePartyVote(state, {
  interactionId,
  heroId,
  optionId,
  eligibleHeroIds,
} = {}) {
  const interaction = normalizePartyDecision(state?.agentInteraction)
  if (interaction.id !== id(interactionId, 'Решение')) {
    throw new PartyDecisionError('Групповое решение устарело', 'PARTY_DECISION_CONFLICT')
  }
  if (interaction.status !== 'open' || interaction.type === 'roll') {
    throw new PartyDecisionError('Голосование уже завершено или не принимает голоса', 'PARTY_DECISION_CLOSED')
  }
  const voter = id(heroId, 'Герой')
  const party = new Set((state?.partyMemberIds?.length ? state.partyMemberIds : state?.players?.map((player) => player.id) ?? []).map(String))
  if (!party.has(voter)) throw new PartyDecisionError('Герой не входит в отряд', 'ACTOR_FORBIDDEN')
  const selected = id(optionId, 'Вариант')
  if (!interaction.options.some((option) => option.id === selected)) {
    throw new PartyDecisionError('Вариант решения не найден', 'PARTY_OPTION_NOT_FOUND')
  }
  const snapshottedEligible = interaction.eligibleActorIds.filter((candidate) => party.has(candidate))
  const eligible = snapshottedEligible.length
    ? snapshottedEligible
    : [...new Set((eligibleHeroIds ?? [...party]).map(String).filter((candidate) => party.has(candidate)))]
  if (!eligible.includes(voter)) throw new PartyDecisionError('Герой не участвовал при открытии голосования', 'ACTOR_FORBIDDEN')
  const votes = { ...interaction.votes, [voter]: selected }
  const required = interaction.eligibleActorIds.length
    ? interaction.requiredVotes
    : interaction.type === 'choice' ? 1 : Math.floor(Math.max(1, eligible.length) / 2) + 1
  const winner = interaction.options.find((option) => (
    eligible.filter((candidate) => votes[candidate] === option.id).length >= required
  ))
  const events = [{
    event_type: 'PartyVoteCast',
    actor_id: voter,
    visibility: 'party',
    target_ids: eligible,
    source_rule_ids: [],
    payload: {
      interaction_id: interaction.id,
      hero_id: voter,
      option_id: selected,
      eligible_hero_ids: eligible,
      required_votes: required,
    },
  }]
  if (winner) {
    events.push({
      event_type: 'PartyDecisionResolved',
      actor_id: voter,
      visibility: 'party',
      target_ids: eligible,
      source_rule_ids: [],
      payload: {
        interaction_id: interaction.id,
        resolved_option_id: winner.id,
        votes,
        eligible_hero_ids: eligible,
        required_votes: required,
      },
    })
  }
  return { events, votes, required, resolvedOptionId: winner?.id ?? null }
}
