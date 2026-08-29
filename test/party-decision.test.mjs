import assert from 'node:assert/strict'
import test from 'node:test'
import { applyGameEvent, normalizeCampaignState, replayEvents } from '../server/rules-engine.mjs'
import { partyDecisionExpiryEvents, partyDecisionOpenedEvent, partyDecisionPresenceEvents, resolvePartyAbstain, resolvePartyRoll, resolvePartyVote } from '../server/party-decision.mjs'

const state = {
  partyMemberIds: ['a', 'b', 'c', 'd'],
  players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
  agentInteraction: {
    id: 'decision-1', type: 'vote', title: 'Куда идти?', description: '',
    options: [{ id: 'north', label: 'На север' }, { id: 'south', label: 'На юг' }],
    votes: { a: 'north', b: 'north' }, status: 'open', resolutionPrompt: '', createdAt: 1,
  },
}

test('party decision open event strips forged votes and resolution', () => {
  const event = partyDecisionOpenedEvent({ ...state.agentInteraction, destinationLocationId: 'форт:Север', votes: { a: 'north' }, status: 'resolved', resolvedOptionId: 'north' }, 'a')
  assert.equal(event.event_type, 'PartyDecisionOpened')
  assert.deepEqual(event.payload.interaction.votes, {})
  assert.equal(event.payload.interaction.status, 'open')
  assert.equal(event.payload.interaction.destinationLocationId, 'форт:Север')

  const initial = normalizeCampaignState({ partyMemberIds: ['a'], players: [{ id: 'a' }] })
  const projected = applyGameEvent(initial, event)
  const replayed = replayEvents(initial, [event])
  assert.equal(projected.agentInteraction.destinationLocationId, 'форт:Север')
  assert.deepEqual(replayed, projected)
})

test('third eligible vote atomically emits vote and majority resolution', () => {
  const result = resolvePartyVote(state, {
    interactionId: 'decision-1', heroId: 'c', optionId: 'north',
    eligibleHeroIds: ['a', 'b', 'c', 'd'],
  })
  assert.deepEqual(result.events.map((event) => event.event_type), ['PartyVoteCast', 'PartyDecisionResolved'])
  assert.equal(result.events[1].payload.resolved_option_id, 'north')
  assert.equal(result.required, 3)
})

test('ineligible and unknown votes are rejected', () => {
  assert.throws(() => resolvePartyVote(state, {
    interactionId: 'decision-1', heroId: 'outsider', optionId: 'north',
    eligibleHeroIds: ['a', 'b', 'c', 'd'],
  }), { code: 'ACTOR_FORBIDDEN' })
  assert.throws(() => resolvePartyVote(state, {
    interactionId: 'decision-1', heroId: 'c', optionId: 'void',
    eligibleHeroIds: ['a', 'b', 'c', 'd'],
  }), { code: 'PARTY_OPTION_NOT_FOUND' })
})

test('party roll resolves from one server d20 and persists the selected outcome', () => {
  const rollState = {
    ...state,
    agentInteraction: {
      ...state.agentInteraction,
      type: 'roll',
      difficulty: 14,
      eligibleActorIds: ['a', 'b'],
      options: [{ id: 'success', label: 'Success' }, { id: 'failure', label: 'Failure' }],
    },
  }
  const result = resolvePartyRoll(rollState, {
    interactionId: 'decision-1',
    heroId: 'a',
    roll: {
      roll_id: 'roll-1',
      dice: [15],
      total: 15,
      created_at: '2026-07-24T00:00:00.000Z',
    },
  })
  assert.deepEqual(result.events.map((event) => event.event_type), ['DieRolled', 'PartyDecisionResolved'])
  assert.equal(result.resolvedOptionId, 'success')
  assert.equal(result.events[1].payload.roll.value, 15)
})

function applyEvents(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

function partyState() {
  return normalizeCampaignState({
    partyMemberIds: ['a', 'b', 'c'],
    players: [{ id: 'a', character: 'А' }, { id: 'b', character: 'Б' }, { id: 'c', character: 'В' }],
    partyDecisionPolicy: { decisionTtlMs: 10_000 },
  })
}

function openedEvent(createdAt = 100) {
  return partyDecisionOpenedEvent({
    id: 'decision-continuity', type: 'vote', title: 'Куда идти?', description: '',
    options: [{ id: 'north', label: 'На север' }, { id: 'south', label: 'На юг' }],
    votes: {}, status: 'open', resolutionPrompt: '', createdAt,
  }, null, {
    eligibleHeroIds: ['a', 'b', 'c'],
    eligibleVoterIds: ['account:a', 'account:b', 'account:c'],
    voterByHeroId: { a: 'account:a', b: 'account:b', c: 'account:c' },
    policy: { decisionTtlMs: 10_000 },
  })
}

test('отключение одного из трёх участников уменьшает кворум, два оставшихся завершают решение', () => {
  const initial = partyState()
  const opened = openedEvent()
  const openState = applyGameEvent(initial, opened)
  const presence = partyDecisionPresenceEvents(openState, { activeVoterIds: ['account:b', 'account:c'] })
  assert.deepEqual(presence.events.map((event) => event.event_type), ['PartyDecisionAbstained'])
  const disconnected = applyEvents(openState, presence.events)
  assert.deepEqual(disconnected.agentInteraction.activeVoterIds, ['account:b', 'account:c'])
  assert.deepEqual(disconnected.agentInteraction.abstainedVoterIds, ['account:a'])
  assert.equal(disconnected.agentInteraction.requiredVotes, 2)

  const firstVote = resolvePartyVote(disconnected, { interactionId: 'decision-continuity', heroId: 'b', optionId: 'north' })
  assert.deepEqual(firstVote.events.map((event) => event.event_type), ['PartyVoteCast'])
  const afterFirst = applyEvents(disconnected, firstVote.events)
  const secondVote = resolvePartyVote(afterFirst, { interactionId: 'decision-continuity', heroId: 'c', optionId: 'north' })
  assert.deepEqual(secondVote.events.map((event) => event.event_type), ['PartyVoteCast', 'PartyDecisionResolved'])
  assert.equal(secondVote.resolvedOptionId, 'north')
})

test('account-level policy не даёт одному аккаунту два голоса за разных героев', () => {
  const initial = partyState()
  const opened = partyDecisionOpenedEvent({
    id: 'account-vote', type: 'vote', title: 'Куда идти?', description: '',
    options: [{ id: 'north', label: 'На север' }, { id: 'south', label: 'На юг' }],
    votes: {}, status: 'open', resolutionPrompt: '', createdAt: 100,
  }, null, {
    eligibleHeroIds: ['a', 'b', 'c'],
    eligibleVoterIds: ['account:owner', 'account:guest'],
    voterByHeroId: { a: 'account:owner', b: 'account:owner', c: 'account:guest' },
    policy: { decisionTtlMs: 10_000 },
  })
  const openState = applyGameEvent(initial, opened)
  const first = resolvePartyVote(openState, { interactionId: 'account-vote', heroId: 'a', optionId: 'north' })
  const afterFirst = applyEvents(openState, first.events)
  const replacement = resolvePartyVote(afterFirst, { interactionId: 'account-vote', heroId: 'b', optionId: 'south' })
  assert.deepEqual(replacement.votes, { b: 'south' })
  assert.equal(replacement.resolvedOptionId, null)
  const afterReplacement = applyEvents(afterFirst, replacement.events)
  const guest = resolvePartyVote(afterReplacement, { interactionId: 'account-vote', heroId: 'c', optionId: 'north' })
  assert.deepEqual(guest.votes, { b: 'south', c: 'north' })
  assert.equal(guest.resolvedOptionId, null)
})

test('явное воздержание и истечение решения записываются и одинаково восстанавливаются replay', () => {
  const initial = partyState()
  const opened = openedEvent(100)
  const openState = applyGameEvent(initial, opened)
  const disconnected = applyEvents(openState, partyDecisionPresenceEvents(openState, { activeVoterIds: ['account:b', 'account:c'] }).events)
  const vote = resolvePartyVote(disconnected, { interactionId: 'decision-continuity', heroId: 'b', optionId: 'north' })
  const afterVote = applyEvents(disconnected, vote.events)
  const abstain = resolvePartyAbstain(afterVote, { interactionId: 'decision-continuity', heroId: 'c' })
  assert.deepEqual(abstain.events.map((event) => event.event_type), ['PartyDecisionAbstained', 'PartyDecisionResolved'])
  assert.equal(abstain.resolvedOptionId, 'north')

  const expiration = partyDecisionExpiryEvents(openState, { now: 10_101 })
  assert.deepEqual(expiration.events.map((event) => event.event_type), ['PartyDecisionExpired'])
  const projected = applyEvents(initial, [opened, ...expiration.events])
  const replayed = replayEvents(initial, [opened, ...expiration.events])
  assert.equal(projected.agentInteraction.status, 'resolved')
  assert.equal(projected.agentInteraction.resolutionReason, 'expired')
  assert.equal(projected.agentInteraction.resolvedOptionId, 'north')
  assert.deepEqual(replayed, projected)
})
