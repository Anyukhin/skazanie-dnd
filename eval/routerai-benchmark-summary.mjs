// Пересчёт сохранённых замеров и слепых оценок; никаких запросов к модели.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const read = path => JSON.parse(readFileSync(path, 'utf8'))
const files = [
  'eval/routerai-benchmark-2026-09-07.json',
  'eval/routerai-prompt-ablation-2026-09-08.json',
  'eval/routerai-production-profiles-2026-09-08.json',
  'eval/routerai-holdout-2026-09-08.json',
  'eval/routerai-craft-v2-2026-09-08.json',
  'eval/routerai-json-probes-2026-09-08.json',
]
const baselineScores = read('eval/routerai-blind-baseline-scores-2026-09-08.json').scores
const followupScores = read('eval/routerai-blind-followup-scores-2026-09-08.json').scores
const shortHash = text => createHash('sha256').update(text).digest('hex').slice(0, 10)
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const median = values => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}
const rows = []
const probes = []
for (const file of files) {
  const report = read(file)
  probes.push(...(report.probes ?? []).map(sample => ({ file, ...sample })))
  for (const sample of report.samples) {
    const baseline = file === files[0]
    const id = `sample-${shortHash(baseline ? `${sample.model}/${sample.case_id}` : `${file}/${sample.profile}/${sample.model}/${sample.case_id}`)}`
    const scores = (baseline ? baselineScores : followupScores).find(score => score.sample_id === id) ?? null
    if (sample.ok && file !== files[1]) assert.ok(scores, `Нет слепой оценки ${id}`)
    rows.push({ file, ...sample, scores })
  }
}
const groups = [...new Set(rows.map(row => `${row.file}|${row.profile}|${row.model}`))].map(key => {
  const values = rows.filter(row => `${row.file}|${row.profile}|${row.model}` === key)
  const reviewed = values.filter(row => row.scores)
  const timed = values.filter(row => row.ok && row.latency_ms < 12000)
  return {
    file: values[0].file, profile: values[0].profile, model: values[0].model,
    calls: values.length, successful: values.filter(row => row.ok).length,
    within_12_seconds: timed.length, accepted_by_guard: values.filter(row => row.accepted).length,
    accepted_within_12_seconds: timed.filter(row => row.accepted).length,
    latency_median_ms: median(values.map(row => row.latency_ms)),
    first_delta_median_ms: median(values.map(row => row.first_delta_ms).filter(value => Number.isFinite(value))),
    reviewed: reviewed.length,
    fidelity_mean: mean(reviewed.map(row => row.scores.fidelity)),
    russian_mean: mean(reviewed.map(row => row.scores.russian)),
    table_mean: mean(reviewed.map(row => row.scores.table)),
    major_errors: reviewed.filter(row => ['world_change', 'contradiction'].includes(row.scores.severity)).length,
    major_errors_accepted_by_guard: reviewed.filter(row => row.accepted && ['world_change', 'contradiction'].includes(row.scores.severity)).length,
    provider_cost_sum_observed: values.reduce((sum, row) => sum + (typeof row.usage?.cost === 'number' ? row.usage.cost : 0), 0),
    missing_cost_count: values.filter(row => typeof row.usage?.cost !== 'number').length,
    zero_usage_with_nonempty_text: values.filter(row => row.ok && !(Number(row.usage?.prompt_tokens) > 0)).length,
  }
})
const all = [...rows, ...probes]
const summary = {
  recalculated_at: new Date().toISOString(), network_calls: 0,
  live_calls_in_source_reports: all.length, narration_calls: rows.length, json_calls: probes.length,
  provider_cost_sum_observed: all.reduce((sum, row) => sum + (typeof row.usage?.cost === 'number' ? row.usage.cost : 0), 0),
  missing_cost_count: all.filter(row => typeof row.usage?.cost !== 'number').length,
  note: 'Сумма cost неполна и не является сверкой списаний. Валюта численно согласуется с RUB, но текстовый контракт API её не объявляет. latency включает ожидание тайм-аута; оценки субъективны, 0..4, без названий моделей. У ablation только исходные тексты и машинный guard, без слепых баллов.',
  groups, probes: probes.map(({ messages, raw_text, ...probe }) => probe),
}
writeFileSync('eval/routerai-summary-2026-09-08.json', `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
