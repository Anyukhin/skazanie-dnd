// Собирает компактный отчёт из сырых проб RouterAI.
// Системные сообщения намеренно не копируются в итоговый файл.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const [rawPath, outputPath, casePath] = process.argv.slice(2)
if (!rawPath || !outputPath) throw new Error('Нужны пути к raw JSON и итоговому JSON')
const raw = JSON.parse(readFileSync(rawPath, 'utf8'))
const caseFileSha256 = casePath ? createHash('sha256').update(readFileSync(casePath)).digest('hex') : null

// Тарифы RouterAI, полученные GET /api/v1/models 2026-11-27.
const pricing = {
  'qwen/qwen3.8-27b': { prompt: 0.00001868377875, completion: 0.0001121026725 },
  'deepseek/deepseek-v4.1-flash': { prompt: 0.0000059542533765, completion: 0.000023817013506 },
  'z-ai/glm-5.3-flash': { prompt: 0.000004180895862, completion: 0.0000095714329425 },
  'openai/gpt-6-luna': { prompt: 0.000010676445, completion: 0.000053382225 },
}

const text = (value, limit) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit)
const providerCost = usage => Number.isFinite(Number(usage?.cost)) ? Number(usage.cost) : null
const tariffCost = (model, usage) => {
  const rate = pricing[model]
  const input = Number(usage?.prompt_tokens) || 0
  const output = Number(usage?.completion_tokens) || 0
  return rate ? input * rate.prompt + output * rate.completion : null
}
const qualityFlags = sample => {
  const final = text(sample.final_text, 3_000)
  const rawText = text(sample.raw_text, 6_000)
  const plan = sample.verification?.response_plan ?? {}
  const flags = {
    server_accepted: Boolean(sample.accepted),
    server_verification_valid: sample.verification?.valid === true,
    memory_requested: plan.include_memory === true,
    memory_reference: /камн|льв|син|караван|карт|обещ/iu.test(`${rawText} ${final}`),
    reasoning_leak: /\b(?:stop|FINAL|final answer|hmm|wait)\b/iu.test(rawText),
    untrusted_payload_echo: /ДРАКОН_ПОБЕЖДЕН|тысяч[аеи]\s+золот/iu.test(final),
  }
  if (sample.case_id === 'open-promise') flags.promise_overclaim = /(?:получ|вруч|найден|лежит|наш[её]л)/iu.test(final)
  if (sample.case_id === 'forward-hook') flags.failure_invented_clue = /направлен|след\s+вед[её]т|нов[аяо]\s+улиц/iu.test(final)
  return flags
}

const samples = raw.samples.map(sample => {
  const usage = sample.usage ?? {}
  return {
    model: sample.model,
    profile: sample.profile,
    case_id: sample.case_id,
    response_model: sample.response_model,
    accepted: sample.accepted,
    fits_default_deadline: sample.fits_default_deadline,
    latency_ms: sample.latency_ms,
    first_delta_ms: sample.first_delta_ms,
    render_ms: sample.render_ms,
    usage: {
      prompt_tokens: usage.prompt_tokens ?? null,
      completion_tokens: usage.completion_tokens ?? null,
      total_tokens: usage.total_tokens ?? null,
      provider_cost: providerCost(usage),
      tariff_estimate: tariffCost(sample.model, usage),
    },
    raw_text: text(sample.raw_text, 6_000),
    raw_truncated: text(sample.raw_text, 6_000).length < String(sample.raw_text ?? '').length,
    final_text: text(sample.final_text, 1_500),
    final_provider: sample.final_provider,
    verification: {
      valid: sample.verification?.valid === true,
      violations: sample.verification?.violations ?? [],
      origin: sample.verification?.origin ?? null,
      response_plan: sample.verification?.response_plan ?? null,
      repair_codes: (sample.verification?.repaired_after ?? []).map(entry => entry.code).filter(Boolean),
    },
    quality_flags: qualityFlags(sample),
  }
})

const requests = (raw.requests ?? []).map(request => ({
  model: request.model,
  profile: request.profile,
  repeat: request.repeat,
  case_id: request.case_id,
  ok: request.ok,
  error_code: request.error_code,
  response_model: request.response_model,
  latency_ms: request.latency_ms,
  cost_ceiling_rub: request.cost_ceiling_rub,
  usage: request.usage ? {
    prompt_tokens: request.usage.prompt_tokens ?? null,
    completion_tokens: request.usage.completion_tokens ?? null,
    total_tokens: request.usage.total_tokens ?? null,
    provider_cost: providerCost(request.usage),
    tariff_estimate: tariffCost(request.model, request.usage),
  } : null,
  raw_text: text(request.raw_text, 6_000),
  raw_truncated: text(request.raw_text, 6_000).length < String(request.raw_text ?? '').length,
}))

const totals = Object.fromEntries([...new Set(samples.map(sample => sample.model))].map(model => {
  const group = samples.filter(sample => sample.model === model)
  const attempts = requests.filter(request => request.model === model)
  const sum = key => group.reduce((total, sample) => total + (Number(sample.usage[key]) || 0), 0)
  const attemptSum = key => attempts.reduce((total, request) => total + (Number(request.usage?.[key]) || 0), 0)
  const renderTimes = group.map(sample => sample.render_ms).filter(Number.isFinite).sort((a, b) => a - b)
  const median = renderTimes.length
    ? (renderTimes.length % 2 ? renderTimes[(renderTimes.length - 1) / 2] : (renderTimes[renderTimes.length / 2 - 1] + renderTimes[renderTimes.length / 2]) / 2)
    : null
  return [model, {
    cases: group.length,
    accepted: group.filter(sample => sample.accepted).length,
    within_12s: group.filter(sample => sample.fits_default_deadline).length,
    prompt_tokens: sum('prompt_tokens'),
    completion_tokens: sum('completion_tokens'),
    provider_cost: sum('provider_cost'),
    tariff_estimate: sum('tariff_estimate'),
    median_render_ms: median,
    quality_flags: Object.fromEntries([...new Set(group.flatMap(sample => Object.keys(sample.quality_flags)))].map(flag => [flag, group.filter(sample => sample.quality_flags[flag] === true).length])),
    attempts: attempts.length,
    attempt_prompt_tokens: attemptSum('prompt_tokens'),
    attempt_completion_tokens: attemptSum('completion_tokens'),
    attempt_provider_cost: attemptSum('provider_cost'),
    attempt_tariff_estimate: attemptSum('tariff_estimate'),
  }]
}))

writeFileSync(outputPath, `${JSON.stringify({
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source: 'RouterAI GET /api/v1/models + eval/routerai-narrator-benchmark.mjs',
  synthetic_only: true,
  models: Object.keys(totals),
  pricing_per_token: pricing,
  source_run: {
    cases: raw.cases.map(entry => entry.id),
    case_file: casePath ?? null,
    case_file_sha256: caseFileSha256,
    models: [...new Set((raw.requests ?? raw.samples).map(entry => entry.model))],
    repeats: raw.run_config?.repeats ?? 1,
    profile: 'craft',
    timeout_ms: 30_000,
    addendum: 'eval/routerai-narrator-craft-v1.txt',
    reasoning: {
      'qwen/qwen3.8-27b': { enabled: false },
      'deepseek/deepseek-v4.1-flash': { enabled: false },
      'z-ai/glm-5.3-flash': { effort: 'low' },
      'openai/gpt-6-luna': { enabled: false },
    },
    requests: requests.length,
    legacy_attempts_excluded: true,
  },
  totals,
  requests,
  samples,
  note: 'provider_cost is the usage field returned by RouterAI. tariff_estimate is recomputed from the live model catalog. Raw prompts are omitted from this compact report.',
}, null, 2)}\n`)
