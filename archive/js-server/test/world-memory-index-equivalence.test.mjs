import assert from 'node:assert/strict'
import test from 'node:test'
import { applyWorldMemoryEvent, normalizeWorldMemory, normalizeWorldMemoryLegacy } from '../server/world-memory.mjs'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function fixture() {
  const pairs = [['hero-b', 'fact-2'], ['hero-a', 'fact-1'], ['hero-b', 'fact-1'], ['hero-a', 'fact-1'], ['hero-a', 'fact-3']]
  return {
    entities: [{ id: 'entity', kind: 'npc', name: 'Свидетель', visibility: 'party' }],
    facts: [1, 2, 3].map((index) => ({ id: `fact-${index}`, subject_id: 'entity', predicate: 'knows', object: `Сведение ${index}`, source_event_ids: [`event-${index}`] })),
    knowledge_ledger: pairs.map(([hero_id, fact_id], index) => ({ id: `knowledge-${index}`, hero_id, fact_id })),
    knowledge: { 'hero-a': ['fact-1', 'fact-2'], 'hero-c': ['fact-3'] },
  }
}

test('подготовленная память применяет связанные события как общий путь и остаётся нормализованной', () => {
  const events = [
    { event_type: 'WorldEntityUpserted', payload: { entity: { id: 'other', kind: 'npc', name: 'Другой свидетель' } } },
    { event_type: 'WorldFactRecorded', payload: { fact: { id: 'fact-new', subject_id: 'entity', predicate: 'knows', object: 'Новое сведение', supersedes_fact_id: 'fact-1' } } },
    { event_type: 'WorldRelationshipRecorded', payload: { relationship: { id: 'relation', from_entity_id: 'entity', to_entity_id: 'other', relation: 'knows', summary: 'Знакомы' } } },
    { event_type: 'QuestUpserted', payload: { schema_version: 2, quest: { id: 'quest', title: 'Узнать правду', status: 'offered', entity_ids: ['entity'] } } },
    { event_type: 'QuestAccepted', payload: { schema_version: 1, quest_id: 'quest' } },
    { event_type: 'QuestClockAdvanced', payload: { quest_id: 'quest', amount: 1 } },
    { event_type: 'QuestResolved', payload: { quest_id: 'quest', outcome: 'success', summary: 'Правда установлена' } },
    { event_type: 'NarrativeThreadUpserted', payload: { thread: { id: 'thread', title: 'Новая нить', quest_ids: ['quest'], entity_ids: ['entity'] } } },
    { event_type: 'NarrativeThreadClockAdvanced', payload: { thread_id: 'thread', amount: 1 } },
    { event_type: 'NpcBeliefRecorded', payload: { claim: { id: 'claim', holder_entity_id: 'entity', claim: 'Свидетель уверен в своих словах' } } },
    { event_type: 'EpistemicClaimTruthResolved', payload: { claim_id: 'claim', truth_status: 'confirmed', source_event_ids: ['proof'] } },
    { event_type: 'NarrativeSummaryRecorded', payload: { summary: { id: 'summary', title: 'Встреча', summary: 'Свидетели встретились', entity_ids: ['entity', 'other'] } } },
    { event_type: 'KnowledgeRevealed', event_id: 'reveal-new', target_ids: ['hero-a'], payload: { fact_id: 'fact-new' } },
  ]
  let memory = normalizeWorldMemory(fixture())
  for (const event of events) {
    const expected = applyWorldMemoryEvent(memory, event)
    const actual = applyWorldMemoryEvent(structuredClone(memory), event, { prepared: true })
    assert.deepEqual(actual, expected, event.event_type)
    assert.deepEqual(normalizeWorldMemory(actual), actual, `${event.event_type}: результат уже канонический`)
    memory = actual
  }
})

test('Rules Engine не меняет исходную память при использовании подготовленного пути', () => {
  const initial = normalizeCampaignState({ worldMemory: fixture() })
  const saved = structuredClone(initial)
  const next = applyGameEvent(initial, { event_type: 'WorldFactRecorded', payload: { fact: {
    id: 'new-fact', subject_id: 'entity', predicate: 'knows', object: 'Подтверждённое сведение',
  } } })
  assert.deepEqual(initial, saved)
  next.worldMemory.facts[0].source_event_ids.push('unrelated')
  assert.deepEqual(initial, saved)
  assert.equal(next.worldMemory.facts.length, initial.worldMemory.facts.length + 1)
})

for (const normalize of [normalizeWorldMemory, normalizeWorldMemoryLegacy]) {
  test(`${normalize.name}: индекс знаний сохраняет порядок, повторы и смешанный старый формат`, () => {
    const input = fixture()
    const saved = structuredClone(input)
    const memory = normalize(input)
    assert.deepEqual(memory.knowledge, {
      'hero-b': ['fact-2', 'fact-1'], 'hero-a': ['fact-1', 'fact-3', 'fact-2'], 'hero-c': ['fact-3'],
    })
    assert.equal(memory.knowledge_ledger.length, 7)
    assert.deepEqual(normalize(memory), memory)
    memory.facts[0].source_event_ids.push('new-event')
    memory.knowledge_ledger[0].summary = 'Новое описание'
    memory.knowledge['hero-a'].push('fact-other')
    assert.deepEqual(input, saved, 'нормализация не оставляет изменяемых ссылок на вход')
  })
}
