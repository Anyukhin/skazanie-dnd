// Сводка перебора уровней reasoning 2026-10-01 по сохранённым отчётам, без сети.
// node eval/reasoning-sweep-analyze-2026-10-01.mjs --output eval/reasoning-sweep-summary-2026-10-01.json
// Объединяет утренние отчёты (docs/model-benchmark-2026-10-01-gpt-6-luna.md) и новые
// отчёты перебора (docs/model-reasoning-sweep-2026-10-01.md). p95 — линейная интерполяция,
// как в утреннем отчёте; на 6 вызовах она практически равна максимуму.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : null
const read = path => existsSync(new URL(`../${path}`, import.meta.url)) ? JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) : null
const catalog = read('eval/routerai-catalog-2026-10-01.json')
const price = model => catalog.data.find(e => e.id === model).pricing
const levelOf = reasoning => reasoning == null ? 'default' : reasoning.enabled === false ? 'off' : reasoning.effort
const short = model => model.split('/')[1]
const q = (values, p) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const i = (v.length - 1) * p
  return Math.round(v[Math.floor(i)] + (v[Math.ceil(i)] - v[Math.floor(i)]) * (i - Math.floor(i)))
}
const mean = values => values.length ? values.reduce((s, x) => s + x, 0) / values.length : null
const r2 = x => x == null ? null : Math.round(x * 100) / 100
const r4 = x => x == null ? null : Math.round(x * 10000) / 10000
const catalogCost = (model, usage) => usage ? (Number(usage.prompt_tokens) || 0) * price(model).prompt + (Number(usage.completion_tokens) || 0) * price(model).completion : null

// Боевые бюджеты (серверный код): полный бюджет роли и доля основной модели в каскаде
// (FallbackLLMClient отдаёт первой модели 60% запрошенного времени, server/llm-client.mjs).
const BUDGETS = {
  narrator: { full_ms: 12_000, primary_ms: 7_200 },
  director: { full_ms: 12_000, primary_ms: 7_200 },
  adjudicator: { full_ms: 9_000, primary_ms: 5_400 },
  npc_social: { full_ms: 20_000, primary_ms: 12_000 },
  bootstrap: { full_ms: 45_000, primary_ms: 27_000 },
}

// ---------- Рассказчик ----------
const NARRATOR_FILES = [
  ['eval/narrator-comparison-gpt-6-luna-main-2026-10-01.json', 'morning'],
  ['eval/narrator-comparison-gpt-6-luna-low-2026-10-01.json', 'morning'],
  ['eval/narrator-comparison-gpt-6-luna-default-2026-10-01.json', 'morning'],
  ['eval/reasoning-sweep-narrator-n1-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-narrator-n2-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-narrator-n3-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-narrator-n4-control-2026-10-01.json', 'control'],
]
const narrator = {}
for (const [file, batch] of NARRATOR_FILES) {
  const report = read(file)
  if (!report) continue
  for (const s of report.samples) {
    const key = `${short(s.model)}/${levelOf(s.parameters?.reasoning ?? null)}${batch === 'control' ? ' [контроль вечером]' : ''}`
    const row = narrator[key] ??= { key, model: s.model, level: levelOf(s.parameters?.reasoning ?? null), sources: new Set(), samples: [] }
    row.sources.add(`${file} (${batch})`)
    row.samples.push(s)
  }
}
const narratorSummary = Object.values(narrator).map(({ key, model, level, sources, samples }) => {
  const ok = samples.filter(s => s.ok)
  const lat = ok.map(s => s.latency_ms)
  const usageCost = ok.map(s => s.usage?.cost).filter(Number.isFinite)
  return {
    key, model, level, sources: [...sources], calls: samples.length, generated: ok.length,
    accepted_by_guard: samples.filter(s => s.accepted).length,
    truncated_at_max_tokens: ok.filter(s => Number(s.usage?.completion_tokens) >= 1200).length,
    errors: samples.filter(s => !s.ok).map(s => `${s.case_id}#${s.repeat}: ${s.error_code}${s.status ? ` ${s.status}` : ''}`),
    guard_rejections: samples.filter(s => s.ok && !s.accepted).map(s => `${s.case_id}#${s.repeat}: ${(s.verification?.violations ?? []).map(v => v.code ?? v).join(',')}`),
    p50_ms: q(lat, 0.5), p95_ms: q(lat, 0.95), max_ms: lat.length ? Math.max(...lat) : null,
    within_primary_7200: ok.filter(s => s.latency_ms <= BUDGETS.narrator.primary_ms).length,
    within_full_12000: ok.filter(s => s.latency_ms <= BUDGETS.narrator.full_ms).length,
    mean_prompt_tokens: Math.round(mean(ok.map(s => Number(s.usage?.prompt_tokens) || 0)) ?? 0),
    mean_completion_tokens: Math.round(mean(ok.map(s => Number(s.usage?.completion_tokens) || 0)) ?? 0),
    mean_reasoning_tokens: Math.round(mean(ok.map(s => Number(s.usage?.completion_tokens_details?.reasoning_tokens) || 0)) ?? 0),
    usage_rub_per_100_calls: usageCost.length ? r2(mean(usageCost) * 100) : null,
    catalog_rub_per_100_calls: r2(mean(ok.map(s => catalogCost(model, s.usage)).filter(Number.isFinite)) * 100),
    spend_usage_rub: r4(usageCost.reduce((a, b) => a + b, 0)),
  }
}).sort((a, b) => a.key.localeCompare(b.key))

// ---------- JSON-роли ----------
const ROLE_FILES = [
  ['eval/json-roles-gpt-6-luna-2026-10-01.json', 'morning'],
  ['eval/json-roles-gpt-6-luna-default-2026-10-01.json', 'morning'],
  ['eval/npc-social-gpt-6-luna-addendum-2026-10-01.json', 'morning'],
  ['eval/reasoning-sweep-roles-luna-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-roles-lunapro-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-roles-glm-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-roles-other-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-roles-repeat-director-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-roles-repeat-npc-2026-10-01.json', 'sweep'],
]
const sentences = text => String(text).split(/(?<=[.!?…])\s+/u).filter(x => x.trim().length > 1).length
const roles = {}
for (const [file, batch] of ROLE_FILES) {
  const report = read(file)
  if (!report) continue
  // Утренний gpt-6-luna/off в роли NPC шёл без Luna-добавки (код поменяли после замера);
  // сейчас добавка в коде, поэтому утренний «off+luna-addendum» соответствует текущему off.
  const callsByCase = new Map()
  for (const c of report.cases) {
    const profile = report.profiles?.[c.profile]
    const model = profile?.model ?? c.profile
    let level = levelOf(profile?.reasoning ?? null)
    let variant = ''
    if (c.profile === 'gpt-6-luna/off+luna-addendum') variant = '+addendum'
    else if (batch === 'morning' && c.profile.startsWith('gpt-6-luna') && c.role === 'npc_social') variant = '-no-addendum'
    const key = `${c.role}|${short(model)}/${level}${variant}`
    const row = roles[key] ??= { key, role: c.role, model, level, variant, sources: new Set(), cases: [] }
    row.sources.add(`${file} (${batch})`)
    row.cases.push(c)
  }
  for (const call of report.calls) {
    const profile = report.profiles?.[call.profile]
    const model = profile?.model ?? call.model
    let variant = ''
    if (call.profile === 'gpt-6-luna/off+luna-addendum') variant = '+addendum'
    else if (batch === 'morning' && call.profile.startsWith('gpt-6-luna') && call.role === 'npc_social') variant = '-no-addendum'
    const key = `${call.role}|${short(model)}/${levelOf(profile?.reasoning ?? null)}${variant}`
    const list = callsByCase.get(key) ?? []
    list.push(call)
    callsByCase.set(key, list)
  }
  for (const [key, calls] of callsByCase) if (roles[key]) (roles[key].calls ??= []).push(...calls)
}
const rolesSummary = Object.values(roles).map(({ key, role, model, level, variant, sources, cases, calls = [] }) => {
  const budget = BUDGETS[role]
  const lat = cases.map(c => c.latency_ms).filter(Number.isFinite)
  const usageCost = calls.map(c => c.usage_cost).filter(Number.isFinite)
  const okCalls = calls.filter(c => c.ok)
  const valid = cases.filter(c => c.valid)
  const row = {
    key, role, model, level, variant, sources: [...sources], cases: cases.length, valid: valid.length,
    valid_within_full_budget: valid.filter(c => c.latency_ms != null && c.latency_ms <= budget.full_ms).length,
    valid_within_primary_share: valid.filter(c => c.latency_ms != null && c.latency_ms <= budget.primary_ms).length,
    full_budget_ms: budget.full_ms, primary_share_ms: budget.primary_ms,
    p50_ms: q(lat, 0.5), p95_ms: q(lat, 0.95), max_ms: lat.length ? Math.max(...lat) : null,
    invalid_reasons: cases.filter(c => !c.valid).map(c => `${c.case_id}#${c.repeat}: ${c.fallback_reason ?? c.provider_error ?? c.source ?? '?'}`),
    call_errors: calls.filter(c => !c.ok).map(c => `${c.error_code}${c.status ? ` ${c.status}` : ''} @${c.latency_ms}ms`),
    mean_completion_tokens: Math.round(mean(okCalls.map(c => Number(c.usage?.completion_tokens) || 0)) ?? 0),
    mean_reasoning_tokens: Math.round(mean(okCalls.map(c => Number(c.usage?.completion_tokens_details?.reasoning_tokens) || 0)) ?? 0),
    usage_rub_per_100_calls: usageCost.length ? r2(mean(usageCost) * 100) : null,
    catalog_rub_per_100_calls: okCalls.length ? r2(mean(okCalls.map(c => catalogCost(model, c.usage)).filter(Number.isFinite)) * 100) : null,
    spend_usage_rub: r4(usageCost.reduce((a, b) => a + b, 0)),
  }
  if (role === 'npc_social') {
    const replies = valid.map(c => c.reply)
    Object.assign(row, {
      voice_marker: valid.filter(c => c.voice_marker).length,
      injection_safe: cases.filter(c => c.injection_safe).length,
      mean_reply_chars: Math.round(mean(replies.map(r => r.length)) ?? 0),
      one_liners: replies.filter(r => sentences(r) <= 1).length,
    })
  }
  if (role === 'adjudicator') row.effects = cases.filter(c => c.valid).map(c => `${c.case_id}:${c.reading?.effect ?? '-'}`)
  if (role === 'director') row.intents = cases.filter(c => c.valid).map(c => `${c.case_id}:${c.intent?.type ?? '-'}`)
  return row
}).sort((a, b) => a.key.localeCompare(b.key))

// ---------- Создание кампании ----------
const BOOT_FILES = [
  ['eval/campaign-bootstrap-gpt-6-luna-2026-10-01.json', 'morning'],
  ['eval/reasoning-sweep-bootstrap-luna-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-bootstrap-other-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-bootstrap-repeat-2026-10-01.json', 'sweep'],
  ['eval/reasoning-sweep-bootstrap-deepseek-2026-10-01.json', 'sweep'],
]
const boot = {}
for (const [file, batch] of BOOT_FILES) {
  const report = read(file)
  if (!report) continue
  for (const c of report.cases) {
    const profile = report.profiles?.[c.profile]
    const key = `${short(profile.model)}/${levelOf(profile.reasoning)}`
    const row = boot[key] ??= { key, model: profile.model, level: levelOf(profile.reasoning), sources: new Set(), cases: [], calls: [] }
    row.sources.add(`${file} (${batch})`)
    row.cases.push(c)
  }
  for (const call of report.calls) {
    const profile = report.profiles?.[call.profile]
    const key = `${short(profile.model)}/${levelOf(profile.reasoning)}`
    boot[key]?.calls.push(call)
  }
}
const bootSummary = Object.values(boot).map(({ key, model, level, sources, cases, calls }) => {
  const usageCost = calls.map(c => c.usage_cost).filter(Number.isFinite)
  const valid = cases.filter(c => c.valid)
  return {
    key, model, level, sources: [...sources], runs: cases.length, model_world: valid.length,
    within_27s: cases.filter(c => c.within_primary_budget_27s && c.valid).length,
    within_45s: cases.filter(c => c.within_total_budget_45s && c.valid).length,
    model_latency_ms: cases.map(c => c.model_latency_ms),
    errors: cases.filter(c => c.error).map(c => c.error),
    locations: valid.map(c => c.quality?.locations), routes: valid.map(c => c.quality?.routes), npcs: valid.map(c => c.quality?.npcs),
    history_chars: valid.map(c => c.quality?.world_history_chars),
    injection_safe: cases.filter(c => c.injection_safe).length,
    mean_completion_tokens: Math.round(mean(calls.filter(c => c.ok).map(c => Number(c.usage?.completion_tokens) || 0)) ?? 0),
    mean_reasoning_tokens: Math.round(mean(calls.filter(c => c.ok).map(c => Number(c.usage?.completion_tokens_details?.reasoning_tokens) || 0)) ?? 0),
    usage_rub_per_call: usageCost.length ? r4(mean(usageCost)) : null,
    spend_usage_rub: r4(usageCost.reduce((a, b) => a + b, 0)),
  }
}).sort((a, b) => a.key.localeCompare(b.key))

const probe = read('eval/reasoning-level-probe-2026-10-01.json')
const sweepSpend = [
  ...narratorSummary.filter(r => r.sources.some(s => s.includes('reasoning-sweep'))),
].length
const spendOf = file => {
  const report = read(file)
  if (!report) return 0
  const items = report.samples ? [...report.samples, ...(report.probes ?? [])] : report.calls ?? report.probes ?? []
  return items.reduce((s, x) => s + (Number.isFinite(x.usage?.cost) ? x.usage.cost : Number.isFinite(x.usage_cost) ? x.usage_cost : x.catalog_cost_rub ?? 0), 0)
}
const sweepFiles = [
  'eval/reasoning-level-probe-2026-10-01.json',
  ...NARRATOR_FILES.filter(([, b]) => b !== 'morning').map(([f]) => f),
  ...ROLE_FILES.filter(([, b]) => b === 'sweep').map(([f]) => f),
  ...BOOT_FILES.filter(([, b]) => b === 'sweep').map(([f]) => f),
]
const spend = Object.fromEntries(sweepFiles.map(f => [f, r4(spendOf(f))]))
// Верхняя оценка вызовов без usage (ошибка, тайм-аут, обрыв JSON): средний вход
// успешных вызовов той же модели и роли (иначе 3000 токенов) + полный max_tokens.
const MAX_TOKENS = { narrator: 1200, director: 500, adjudicator: 700, npc_social: 700, bootstrap: 3200 }
function failedUpperBound(file, role) {
  const report = read(file)
  if (!report) return 0
  const items = report.samples ?? report.calls ?? []
  return items.filter(x => !x.ok).reduce((sum, x) => {
    const r = role ?? x.role
    const okSame = items.filter(y => y.ok && y.model === x.model && (role ?? y.role) === r && y.usage)
    const promptTokens = okSame.length ? mean(okSame.map(y => Number(y.usage.prompt_tokens) || 0)) : 3000
    return sum + promptTokens * price(x.model).prompt + MAX_TOKENS[r] * price(x.model).completion
  }, 0)
}
const unaccounted = Object.fromEntries(sweepFiles.filter(f => !f.includes('level-probe')).map(f => [f, r4(failedUpperBound(f, f.includes('narrator') ? 'narrator' : null))]))
const summary = {
  unaccounted_failed_calls_upper_rub: { ...unaccounted, total: r4(Object.values(unaccounted).reduce((a, b) => a + b, 0)) },
  created_at: new Date().toISOString(), network_calls: 0, budgets: BUDGETS, catalog: 'eval/routerai-catalog-2026-10-01.json',
  note: 'Пересчёт сохранённых отчётов без запросов к модели. morning — утренний замер (docs/model-benchmark-2026-10-01-gpt-6-luna.md), sweep — перебор уровней reasoning. usage_rub — поле usage.cost ответа RouterAI; catalog_rub — токены × цена снимка каталога без скидки кэша.',
  reasoning_probe: probe?.probes.map(p => ({ model: p.model, level: p.level, status: p.status, ok: p.ok, latency_ms: p.latency_ms, prompt_tokens: p.usage?.prompt_tokens ?? null, completion_tokens: p.usage?.completion_tokens ?? null, reasoning_tokens: p.reasoning_tokens, finish_reason: p.finish_reason, usage_cost: r4(p.usage_cost), answer: p.answer, error: p.error ?? null })) ?? null,
  narrator: narratorSummary.map(r => ({ ...r, sources: r.sources })),
  roles: rolesSummary,
  bootstrap: bootSummary,
  sweep_spend_rub: { ...spend, total: r4(Object.values(spend).reduce((a, b) => a + b, 0)) },
}
void sweepSpend
if (output) writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`)
else console.log(JSON.stringify(summary, null, 2))
