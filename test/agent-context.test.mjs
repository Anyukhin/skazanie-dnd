import assert from 'node:assert/strict'
import test from 'node:test'

import { campaignConceptForAgent } from '../server/agent-context.mjs'
import { AGENT_ROLES, answerKnownLore } from '../server/agent-router.mjs'

test('shared campaign premise is bounded for every creative role and excludes unrelated private state', () => {
  const state = {
    campaignConcept: {
      preset: 'Frontier',
      tone: 'Hopeful mystery',
      premise: 'A vanished road returns each new moon.',
      boundaries: 'No sexual violence; fade to black.',
      themes: 'memory, duty',
      private_solution: 'The road is a dragon.',
    },
    secretGmNotes: 'Never expose this.',
  }
  const premise = campaignConceptForAgent(state)
  for (const role of Object.values(AGENT_ROLES)) {
    assert.equal(premise.premise, 'A vanished road returns each new moon.', role.id)
    assert.equal(premise.tone, 'Hopeful mystery', role.id)
    assert.equal(premise.boundaries, 'No sexual violence; fade to black.', role.id)
  }
  assert.equal(Object.hasOwn(premise, 'private_solution'), false)
  assert.doesNotMatch(JSON.stringify(premise), /Never expose this/u)
})

test('deterministic Worldkeeper receives the same premise contract without treating it as a canonical fact', () => {
  const result = answerKnownLore('Что я знаю об этом месте?', {
    campaignConcept: { premise: 'A lost road.', tone: 'mystery', boundaries: 'PG-13' },
    worldMemory: { entities: [], facts: [], quests: [], knowledge: {} },
    partyMemberIds: ['hero'],
    adventure: {},
    scene: {},
  }, { viewer: { playerId: 'hero', isPartyMember: true } })

  assert.equal(result.agent_context.campaign_premise.premise, 'A lost road.')
  assert.equal(result.agent_context.campaign_premise.tone, 'mystery')
  assert.equal(result.agent_context.campaign_premise.boundaries, 'PG-13')
  assert.doesNotMatch(result.narration, /A lost road/u)
})
