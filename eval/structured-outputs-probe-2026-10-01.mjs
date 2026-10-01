// Проверка, принимает ли RouterAI `response_format: json_schema` (strict) и
// соблюдает ли его модель, а не просто не падает.
// node eval/structured-outputs-probe-2026-10-01.mjs --output eval/structured-outputs-probe-2026-10-01.json [--budget-rub 2]
//
// Для каждой модели — три запроса с боевым профилем reasoning (`reasoningProfileFor`):
//   control      — json_object; системный промпт требует ДРУГИЕ ключи, чем схема;
//   schema       — тот же промпт + json_schema strict: если ответ всё равно
//                  соответствует схеме, а не промпту, схема исполняется провайдером;
//   schema_union — схема с nullable-полем через `type: [..., 'null']` и вложенным
//                  объектом (так описаны необязательные поля Директора и NPC).
// «Принят, но проигнорирован» виден по тому, что schema-ответ повторяет control.
// Ключ берётся из .env и нигде не печатается; storage не используется.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

process.loadEnvFile(new URL('../.env', import.meta.url))
const root = new URL('../', import.meta.url).href
const { reasoningProfileFor } = await import(`${root}server/model-style-profiles.mjs`)
const args = process.argv.slice(2)
const opt = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d
const output = opt('--output')
const budgetRub = Number(opt('--budget-rub', '2'))
assert.ok(output && budgetRub > 0 && budgetRub <= 3)
assert.ok(process.env.ROUTERAI_API_KEY, 'Не настроен ROUTERAI_API_KEY')
const baseUrl = (process.env.ROUTERAI_BASE_URL || 'https://routerai.ru/api/v1').replace(/\/$/, '')
assert.equal(new URL(baseUrl).origin, 'https://routerai.ru')
const catalog = JSON.parse(readFileSync(new URL('./routerai-catalog-2026-10-01.json', import.meta.url), 'utf8'))

const MODELS = (opt('--models') ?? 'openai/gpt-6-luna,google/gemini-2.5-flash-lite,z-ai/glm-5.3-flash,deepseek/deepseek-v4-flash,openai/gpt-4.1-nano').split(',')

const adversarial = [
  { role: 'system', content: 'Ты описываешь погоду. Верни только JSON-объект {"colour": строка, "mood": строка, "poem": строка из двух строк}.' },
  { role: 'user', content: 'Опиши небо над северным трактом перед грозой.' },
]
const strictSchema = {
  name: 'probe_verdict',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'count'],
    properties: {
      verdict: { type: 'string', enum: ['ясно', 'пасмурно', 'гроза'] },
      count: { type: 'integer' },
    },
  },
}
const unionMessages = [
  { role: 'system', content: 'Ты помощник трактирщика. Верни JSON по схеме: reply — реплика, promise — обещание или null, если обещания нет.' },
  { role: 'user', content: 'Можно у вас переночевать? Заплачу утром.' },
]
const unionSchema = {
  name: 'probe_union',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'stance', 'promise'],
    properties: {
      reply: { type: 'string' },
      stance: { type: 'string', enum: ['friendly', 'neutral', 'guarded', 'hostile'] },
      promise: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['direction', 'text', 'due_hint'],
        properties: {
          direction: { type: 'string', enum: ['npc_to_party', 'party_to_npc'] },
          text: { type: 'string' },
          due_hint: { type: 'string' },
        },
      },
    },
  },
}

const PROBES = [
  { id: 'control', messages: adversarial, response_format: { type: 'json_object' } },
  { id: 'schema', messages: adversarial, response_format: { type: 'json_schema', json_schema: strictSchema } },
  { id: 'schema_union', messages: unionMessages, response_format: { type: 'json_schema', json_schema: unionSchema } },
]

function conforms(probeId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (probeId === 'control') return false
  if (probeId === 'schema') {
    return Object.keys(value).sort().join(',') === 'count,verdict' && ['ясно', 'пасмурно', 'гроза'].includes(value.verdict) && Number.isInteger(value.count)
  }
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'promise,reply,stance' || typeof value.reply !== 'string') return false
  if (!['friendly', 'neutral', 'guarded', 'hostile'].includes(value.stance)) return false
  if (value.promise === null) return true
  const p = value.promise
  return p && typeof p === 'object' && Object.keys(p).sort().join(',') === 'direction,due_hint,text'
    && ['npc_to_party', 'party_to_npc'].includes(p.direction) && typeof p.text === 'string' && typeof p.due_hint === 'string'
}

const report = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {
  schema_version: 1, created_at: new Date().toISOString(), endpoint: baseUrl,
  note: 'control — json_object при промпте с чужими ключами; schema — тот же промпт со strict json_schema; schema_union — nullable вложенный объект.',
  schemas: { strict: strictSchema, union: unionSchema }, probes: [],
}
const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
const spent = () => report.probes.reduce((s, p) => s + (p.usage_cost ?? p.catalog_cost_rub ?? 0), 0)

for (const model of MODELS) {
  const pricing = catalog.data.find(e => e.id === model)?.pricing
  assert.ok(pricing, `нет цены ${model}`)
  const reasoning = reasoningProfileFor(model)
  for (const probe of PROBES) {
    if (report.probes.some(p => p.model === model && p.probe === probe.id)) continue
    const ceiling = 600 * pricing.prompt + 400 * pricing.completion
    assert.ok(spent() + ceiling < budgetRub, `бюджет ${budgetRub} ₽ исчерпан`)
    const body = { model, messages: probe.messages, temperature: 0, max_tokens: 400, response_format: probe.response_format }
    if (reasoning) body.reasoning = reasoning
    const row = { model, probe: probe.id, reasoning }
    const started = performance.now()
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ROUTERAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      row.status = response.status
      const text = await response.text()
      if (!response.ok) {
        row.ok = false
        row.provider_error = text.slice(0, 600)
      } else {
        const payload = JSON.parse(text)
        const content = String(payload.choices?.[0]?.message?.content ?? '')
        row.ok = true
        row.response_model = payload.model ?? null
        row.finish_reason = payload.choices?.[0]?.finish_reason ?? null
        row.content = content.slice(0, 1200)
        row.usage = payload.usage ?? null
        row.usage_cost = typeof payload.usage?.cost === 'number' ? payload.usage.cost : null
        row.catalog_cost_rub = payload.usage ? (payload.usage.prompt_tokens || 0) * pricing.prompt + (payload.usage.completion_tokens || 0) * pricing.completion : null
        let parsed = null
        try { parsed = JSON.parse(content) } catch {}
        row.json_parsed = parsed != null
        row.keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : null
        row.conforms_to_schema = conforms(probe.id, parsed)
      }
    } catch (error) {
      row.ok = false
      row.error = String(error?.name ?? 'ERROR')
    }
    row.latency_ms = Math.round(performance.now() - started)
    report.probes.push(row)
    save()
    console.log(JSON.stringify({ model, probe: probe.id, status: row.status, keys: row.keys, conforms: row.conforms_to_schema, ms: row.latency_ms, spent: Number(spent().toFixed(4)) }))
  }
}

report.summary = Object.fromEntries(MODELS.map(model => {
  const rows = report.probes.filter(p => p.model === model)
  const by = id => rows.find(p => p.probe === id)
  const schema = by('schema')
  const union = by('schema_union')
  const verdict = !schema?.ok ? `rejected (HTTP ${schema?.status ?? 'n/a'})`
    : schema.finish_reason === 'length' && !schema.json_parsed ? 'inconclusive-truncated-by-reasoning'
    : schema.conforms_to_schema && union?.conforms_to_schema ? 'enforced'
      : schema.conforms_to_schema ? 'enforced-flat-only'
        : 'accepted-but-ignored'
  return [model, { verdict, control_keys: by('control')?.keys ?? null, schema_keys: schema?.keys ?? null, union_conforms: union?.conforms_to_schema ?? null }]
}))
report.spent_rub = spent()
save()
console.log(JSON.stringify({ output, summary: report.summary, spent_rub: report.spent_rub }))
