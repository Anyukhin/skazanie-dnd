import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_COUNTS,
  OLD_LIMITS,
  countMemory,
  embeddingCapability,
  generatedMemory,
  phaseEvents,
  retrievalCorpus,
} from '../eval/world-data-measurements.mjs'

test('long campaign measurement plan crosses every previous memory cap', () => {
  for (const [name, limit] of Object.entries(OLD_LIMITS)) {
    assert.ok(DEFAULT_COUNTS[name] > limit, `${name} must exceed the former limit`)
  }
  const phases = phaseEvents(DEFAULT_COUNTS)
  assert.deepEqual(phases.map((phase) => phase.name), [
    'entities', 'facts', 'relationships', 'quests', 'threads', 'epistemic_claims', 'summaries', 'knowledge_ledger',
  ])
  assert.deepEqual(Object.fromEntries(phases.map((phase) => [phase.name, phase.events.length])), DEFAULT_COUNTS)
  const fact = phases.find((phase) => phase.name === 'facts').events[0]
  assert.equal(fact.event_type, 'WorldFactRecorded')
  assert.equal(fact.payload.fact.subject_id, 'npc:measurement-1')
})

test('synthetic memory corpus keeps private knowledge and obsolete rumor distinguishable', () => {
  const memory = generatedMemory()
  const counts = countMemory(memory)
  assert.equal(counts.entities, 5)
  assert.equal(counts.facts, 9)
  assert.equal(memory.facts.find((fact) => fact.id === 'fact:old-route').status, 'superseded')
  assert.equal(memory.facts.find((fact) => fact.id === 'fact:private-seal').visibility, 'gm_only')
  assert.equal(memory.epistemic_claims.find((claim) => claim.id === 'rumor:old-smugglers').truth_status, 'refuted')
  assert.ok(memory.knowledge_ledger.some((entry) => entry.hero_id === 'hero-1' && entry.fact_id === 'fact:private-seal'))
})

test('fixed RU retrieval corpus covers required categories and separation', () => {
  const corpus = retrievalCorpus()
  assert.ok(corpus.rules.some((item) => item.category === 'no_answer'))
  assert.ok(corpus.rules.some((item) => item.category === 'ambiguity'))
  assert.ok(corpus.rules.some((item) => item.category === 'paraphrase'))
  assert.ok(corpus.memory.some((item) => item.category === 'private_hidden'))
  assert.ok(corpus.memory.some((item) => item.category === 'obsolete'))
  assert.ok(corpus.memory.every((item) => item.viewer && typeof item.viewer === 'object'))
})

test('trained embedding capability is reported without exposing credentials', () => {
  const capability = embeddingCapability()
  assert.ok(['unavailable', 'configured'].includes(capability.status))
  assert.equal(Object.hasOwn(capability, 'api_key'), false)
  assert.equal(Object.hasOwn(capability, 'token'), false)
})
