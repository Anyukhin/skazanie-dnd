// Оценка поиска по памяти мира (`retrieveWorldMemory`) на размеченном наборе
// eval/graph-retrieval-cases-2026-10-01.json.
//
//   node eval/graph-retrieval-eval-2026-10-01.mjs [выходной.json]
//
// Метрики:
// - recall@5 — доля эталонных записей в первых пяти (среднее по вопросам с ответом);
// - top-1 — первая запись входит в эталон;
// - no-answer — для вопросов без ответа поиск вернул пустой список;
// - answered — для вопросов с ответом поиск вернул хоть что-то;
// - утечки — запись gm_only, чужое личное знание или запись из `forbidden`
//   (достижимая только через gm_only-ребро) в выдаче игроку;
// - задержка — по каждому запросу 30 повторов на наборе и на наборе ×20.
//
// Варианты вызова (опции, которых нет у старой версии, она просто игнорирует):
// - default — как зовут Рассказчик, Режиссёр и разговор NPC;
// - strict — `whenUnmatched: 'none'`, как зовёт Хранитель знаний;
// - without_neighbours — strict без шага по графу (вклад одних лексических правок).
// Верхние `totals` и `cases` — вариант default, чтобы файл «до» и «после»
// сравнивались один к одному.
//
// Модель не вызывается; всё детерминировано.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'

import { retrieveWorldMemory } from '../server/world-memory.mjs'

const root = resolve(import.meta.dirname, '..')
const output = process.argv[2] ? resolve(process.argv[2]) : null
const dataset = JSON.parse(readFileSync(resolve(root, 'eval/graph-retrieval-cases-2026-10-01.json'), 'utf8'))
const { memory, cases, viewers } = dataset
const K = 5
const REPEATS = 30

const byId = new Map()
for (const collection of ['facts', 'relationships', 'quests', 'threads', 'epistemic_claims', 'summaries']) {
  for (const record of memory[collection] ?? []) byId.set(record.id, { collection, record })
}
const otherHeroKnowledge = new Set((memory.knowledge_ledger ?? []).filter((entry) => entry.hero_id !== viewers.player.playerId).map((entry) => entry.fact_id))

function leakOf(entry, testCase) {
  if (testCase.viewer === 'gm') return null
  const source = byId.get(entry.id)?.record
  if (!source) return null
  if (source.visibility === 'gm_only') return otherHeroKnowledge.has(entry.id) ? 'other_hero_knowledge' : 'gm_only'
  if (testCase.forbidden?.includes(entry.id)) return 'gm_only_edge'
  return null
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

function round(value, digits = 3) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

// Набор ×20 для задержки: те же записи с суффиксом id, связи внутри копии.
function scaledMemory(times) {
  const suffix = (value, index) => (value ? `${value}~${index}` : value)
  const copy = { schema_version: 2, entities: [], facts: [], relationships: [], quests: [], threads: [], epistemic_claims: [], summaries: [], knowledge_ledger: [] }
  for (let index = 0; index < times; index += 1) {
    copy.entities.push(...memory.entities.map((item) => ({ ...item, id: suffix(item.id, index) })))
    copy.facts.push(...memory.facts.map((item) => ({ ...item, id: suffix(item.id, index), subject_id: suffix(item.subject_id, index) })))
    copy.relationships.push(...memory.relationships.map((item) => ({ ...item, id: suffix(item.id, index), from_entity_id: suffix(item.from_entity_id, index), to_entity_id: suffix(item.to_entity_id, index) })))
    copy.quests.push(...memory.quests.map((item) => ({ ...item, id: suffix(item.id, index), entity_ids: item.entity_ids.map((id) => suffix(id, index)) })))
    copy.threads.push(...memory.threads.map((item) => ({ ...item, id: suffix(item.id, index), entity_ids: item.entity_ids.map((id) => suffix(id, index)), quest_ids: item.quest_ids.map((id) => suffix(id, index)) })))
    copy.epistemic_claims.push(...memory.epistemic_claims.map((item) => ({ ...item, id: suffix(item.id, index), holder_entity_id: suffix(item.holder_entity_id, index), subject_entity_id: suffix(item.subject_entity_id, index) })))
    copy.summaries.push(...memory.summaries.map((item) => ({ ...item, id: suffix(item.id, index), entity_ids: item.entity_ids.map((id) => suffix(id, index)) })))
  }
  return copy
}

const VARIANTS = {
  default: {},
  strict: { whenUnmatched: 'none' },
  without_neighbours: { whenUnmatched: 'none', neighbours: false },
}

function latency(source, options = {}) {
  const samples = []
  for (const testCase of cases) {
    const viewer = viewers[testCase.viewer]
    retrieveWorldMemory(source, viewer, { query: testCase.query, limit: K, ...options })
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const started = performance.now()
      retrieveWorldMemory(source, viewer, { query: testCase.query, limit: K, ...options })
      samples.push(performance.now() - started)
    }
  }
  return { mean_ms: round(samples.reduce((sum, value) => sum + value, 0) / samples.length), p95_ms: round(percentile(samples, 0.95)), samples: samples.length }
}

const evaluate = (options) => cases.map((testCase) => {
  const viewer = viewers[testCase.viewer]
  const retrieved = retrieveWorldMemory(memory, viewer, { query: testCase.query, limit: K, ...options })
  const ids = retrieved.map((entry) => entry.id)
  const gold = new Set(testCase.gold)
  const hits = ids.filter((id) => gold.has(id))
  const leaks = retrieved.map((entry) => ({ id: entry.id, reason: leakOf(entry, testCase) })).filter((entry) => entry.reason)
  return {
    id: testCase.id, query: testCase.query, viewer: testCase.viewer, hop: testCase.hop, no_answer: testCase.no_answer,
    gold: testCase.gold, retrieved: ids,
    recall_at_5: testCase.no_answer ? null : round(hits.length / gold.size),
    top1: testCase.no_answer ? null : gold.has(ids[0]),
    no_answer_correct: testCase.no_answer ? ids.length === 0 : null,
    answered: testCase.no_answer ? null : ids.length > 0,
    leaks,
  }
})
const variantResults = Object.fromEntries(Object.entries(VARIANTS).map(([name, options]) => [name, evaluate(options)]))
const results = variantResults.default

// Санитарная проверка разметки: эталон должен быть виден этому зрителю.
const labelErrors = []
for (const testCase of cases) {
  for (const id of testCase.gold) {
    const source = byId.get(id)?.record
    if (!source) labelErrors.push(`${testCase.id}: нет записи ${id}`)
    else if (testCase.viewer !== 'gm' && source.visibility === 'gm_only') labelErrors.push(`${testCase.id}: эталон ${id} скрыт от игрока`)
  }
}
if (labelErrors.length) throw new Error(`Ошибки разметки:\n${labelErrors.join('\n')}`)

function totalsOf(entries) {
  return {
    all: aggregate(entries),
    direct: aggregate(entries.filter((entry) => !entry.hop && !entry.no_answer)),
    hop: aggregate(entries.filter((entry) => entry.hop)),
    no_answer: aggregate(entries.filter((entry) => entry.no_answer)),
    player_only: aggregate(entries.filter((entry) => entry.viewer === 'player')),
  }
}

function aggregate(subset) {
  const answerable = subset.filter((entry) => !entry.no_answer)
  const unanswerable = subset.filter((entry) => entry.no_answer)
  const mean = (values) => (values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null)
  return {
    cases: subset.length,
    recall_at_5: mean(answerable.map((entry) => entry.recall_at_5)),
    top1: mean(answerable.map((entry) => (entry.top1 ? 1 : 0))),
    answered: mean(answerable.map((entry) => (entry.answered ? 1 : 0))),
    no_answer_correct: mean(unanswerable.map((entry) => (entry.no_answer_correct ? 1 : 0))),
    leaks: subset.reduce((sum, entry) => sum + entry.leaks.length, 0),
  }
}

const memoryCounts = Object.fromEntries(['entities', 'facts', 'relationships', 'quests', 'threads', 'epistemic_claims', 'summaries'].map((key) => [key, memory[key].length]))
const report = {
  generated_at: new Date().toISOString(),
  k: K,
  memory: memoryCounts,
  totals: totalsOf(results),
  variants: Object.fromEntries(Object.entries(variantResults).map(([name, entries]) => [name, { options: VARIANTS[name], totals: totalsOf(entries) }])),
  latency: {
    fixture: latency(memory),
    scaled_x20: { ...latency(scaledMemory(20)), records: memoryCounts.facts * 20 + memoryCounts.relationships * 20 },
    scaled_x20_without_neighbours: latency(scaledMemory(20), VARIANTS.without_neighbours),
  },
  cases: results,
  cases_strict: variantResults.strict.map(({ id, retrieved, recall_at_5, top1, no_answer_correct, leaks }) => ({ id, retrieved, recall_at_5, top1, no_answer_correct, leaks })),
}

const text = `${JSON.stringify(report, null, 2)}\n`
if (output) writeFileSync(output, text, 'utf8')
const brief = Object.fromEntries(Object.entries(report.variants).map(([name, variant]) => [name,
  Object.fromEntries(Object.entries(variant.totals).map(([key, value]) => [key, [value.recall_at_5, value.top1, value.no_answer_correct, value.leaks]]))]))
process.stdout.write(`recall@5, top1, no_answer, leaks:\n${JSON.stringify(brief)}\n${JSON.stringify(report.latency)}\n`)
for (const entry of variantResults.strict) {
  const mark = entry.no_answer ? (entry.no_answer_correct ? 'ok ' : 'NO ') : `${entry.recall_at_5 === 1 ? 'ok ' : entry.recall_at_5 > 0 ? '~  ' : 'NO '}`
  process.stdout.write(`${mark}${entry.id} ${entry.query} -> ${entry.retrieved.join(', ')}${entry.leaks.length ? `  LEAK ${JSON.stringify(entry.leaks)}` : ''}\n`)
}
