// Парное сравнение отбора трёх фактов для рассказчика на размеченных вопросах.
// Запуск из любого каталога: node eval/narrator-fact-recall.mjs
import { readFileSync } from 'node:fs'
import { retrieveWorldMemory } from '../server/world-memory.mjs'

const corpus = JSON.parse(readFileSync(new URL('./graph-retrieval-cases-2026-10-01.json', import.meta.url), 'utf8'))
const visibleFacts = corpus.memory.facts.filter(fact => ['public', 'party'].includes(fact.visibility))
const factIds = new Set(visibleFacts.map(fact => fact.id))
const memory = { ...corpus.memory, facts: visibleFacts }

function evaluate(label, options) {
  let hits = 0
  let expected = 0
  let questionsWithFacts = 0
  let selectedOnAnswerable = 0
  let correctlyEmpty = 0
  let unanswerable = 0
  const missed = []
  for (const scenario of corpus.cases.filter(entry => entry.viewer === 'player')) {
    const gold = scenario.gold.filter(id => factIds.has(id))
    if (!gold.length && !scenario.no_answer) continue
    const records = retrieveWorldMemory(memory, { isPartyMember: true }, {
      query: scenario.query, limit: 3, whenUnmatched: 'none', ...options,
    })
    const selected = new Set(records.filter(record => record.kind === 'fact').map(record => record.id))
    if (scenario.no_answer) {
      unanswerable++
      if (!selected.size) correctlyEmpty++
      continue
    }
    questionsWithFacts++
    selectedOnAnswerable += selected.size
    for (const id of gold) {
      expected++
      if (selected.has(id)) hits++
      else missed.push([scenario.id, id])
    }
  }
  return { label, questionsWithFacts, hits, expected, selectedOnAnswerable, correctlyEmpty, unanswerable, missed }
}

console.log(JSON.stringify([
  evaluate('limit_then_filter', {}),
  evaluate('filter_then_limit', { kind: 'fact' }),
], null, 2))
