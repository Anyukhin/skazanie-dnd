// Сводка замеров strict json_schema: до/после по моделям и ролям.
// node eval/structured-outputs-analyze-2026-10-01.mjs eval/structured-outputs-before-2026-10-01.json eval/structured-outputs-after-2026-10-01.json [--write]
// С --write сводка дописывается в каждый отчёт полем summary. Сети не трогает.
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const files = args.filter(a => !a.startsWith('--'))
const percentile = (values, p) => {
  const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const mean = values => values.length ? values.reduce((s, v) => s + v, 0) / values.length : null

function summarize(report) {
  const groups = new Map()
  for (const row of report.cases) {
    const key = `${row.profile}|${row.role}`
    if (!groups.has(key)) groups.set(key, { profile: row.profile, role: row.role, rows: [], calls: [] })
    groups.get(key).rows.push(row)
  }
  for (const call of report.calls) {
    const key = `${call.profile}|${call.role}`
    groups.get(key)?.calls.push(call)
  }
  return [...groups.values()].map(({ profile, role, rows, calls }) => {
    const ok = calls.filter(c => c.ok)
    const cost = calls.map(c => c.usage_cost ?? c.catalog_cost_rub ?? 0)
    return {
      profile, role,
      cases: rows.length,
      called: rows.filter(r => r.called).length,
      // Явная просьба о бое решается Директором без модели: такие случаи не входят в долю валидных.
      valid: rows.filter(r => r.called && r.valid).length,
      invalid_reasons: [...new Set(rows.filter(r => r.called && !r.valid).map(r => r.fallback_reason ?? r.provider_error ?? 'fallback'))].map(s => String(s).slice(0, 160)),
      call_errors: calls.filter(c => !c.ok).map(c => c.error_code),
      json_schema_sent: calls.filter(c => c.json_schema).length,
      latency_p50_ms: percentile(calls.map(c => c.latency_ms), 50),
      latency_p95_ms: percentile(calls.map(c => c.latency_ms), 95),
      prompt_tokens_avg: Math.round(mean(ok.map(c => c.usage?.prompt_tokens ?? 0)) ?? 0),
      cached_tokens_avg: Math.round(mean(ok.map(c => c.usage?.prompt_tokens_details?.cached_tokens ?? 0)) ?? 0),
      completion_tokens_avg: Math.round(mean(ok.map(c => c.usage?.completion_tokens ?? 0)) ?? 0),
      rub_per_100_calls: Number(((mean(cost) ?? 0) * 100).toFixed(3)),
      injection_safe: rows.filter(r => r.injection_safe === false).length === 0,
      voice_marker: rows.filter(r => r.voice_marker === true).length,
    }
  })
}

for (const file of files) {
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const summary = summarize(report)
  console.log(`\n${file} (json_schema=${report.json_schema ?? false}, spent ${Number(report.spent_rub ?? 0).toFixed(3)} ₽)`)
  console.table(summary.map(({ invalid_reasons, call_errors, ...rest }) => rest))
  for (const s of summary) if (s.invalid_reasons.length || s.call_errors.length) console.log(s.profile, s.role, JSON.stringify({ invalid_reasons: s.invalid_reasons, call_errors: s.call_errors }))
  if (args.includes('--write')) {
    report.summary = summary
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  }
}
