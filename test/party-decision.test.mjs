import assert from 'node:assert/strict'
import test from 'node:test'
import { partyDecisionOpenedEvent, resolvePartyRoll, resolvePartyVote } from '../server/party-decision.mjs'

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
  const event = partyDecisionOpenedEvent({ ...state.agentInteraction, votes: { a: 'north' }, status: 'resolved', resolvedOptionId: 'north' }, 'a')
  assert.equal(event.event_type, 'PartyDecisionOpened')
  assert.deepEqual(event.payload.interaction.votes, {})
  assert.equal(event.payload.interaction.status, 'open')
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
