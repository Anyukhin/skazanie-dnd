// Проверка, принимает ли RouterAI каждый уровень reasoning для каждой модели.
// node eval/reasoning-level-probe-2026-10-01.mjs --output eval/reasoning-level-probe-2026-10-01.json [--budget-rub 3]
// Один короткий JSON-запрос с задачей «на подумать» на каждую пару (модель, уровень):
// фиксируется HTTP-статус, текст ошибки провайдера (без заголовков), reasoning_tokens,
// completion_tokens, usage.cost и задержка. «Принят, но проигнорирован» видно по тому,
// что reasoning_tokens и задержка не растут с уровнем.
// Ключ берётся из .env и нигде не печатается; storage не используется.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

process.loadEnvFile(new URL('../.env', import.meta.url))
const args = process.argv.slice(2)
const opt = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d
const output = opt('--output')
const budgetRub = Number(opt('--budget-rub', '3'))
assert.ok(output && budgetRub > 0 && budgetRub <= 5)
assert.ok(process.env.ROUTERAI_API_KEY, 'Не настроен ROUTERAI_API_KEY')
const baseUrl = (process.env.ROUTERAI_BASE_URL || 'https://routerai.ru/api/v1').replace(/\/$/, '')
assert.equal(new URL(baseUrl).origin, 'https://routerai.ru')
const catalog = JSON.parse(readFileSync(new URL('./routerai-catalog-2026-10-01.json', import.meta.url), 'utf8'))

const LEVELS = {
  'openai/gpt-6-luna': ['default', 'off', 'minimal', 'low', 'medium', 'high'],
  'openai/gpt-6-luna-pro': ['default', 'off', 'low', 'medium'],
  'z-ai/glm-5.3-flash': ['default', 'off', 'minimal', 'low', 'medium'],
  'deepseek/deepseek-v4-flash': ['default', 'off', 'low'],
  'google/gemini-2.5-flash-lite': ['default', 'off', 'low'],
}
const reasoningOf = level => level === 'default' ? null : level === 'off' ? { enabled: false } : { effort: level }
const messages = [
  { role: 'system', content: 'Ты проверяешь тактическую геометрию. Верни только JSON-объект {"reachable": boolean, "squares": integer}.' },
  { role: 'user', content: 'Сетка 5 футов на клетку, диагональ стоит 5 футов. Герой стоит в (2,3), скорость 30 футов. Клетки (3,4), (4,5) и (5,6) — трудная местность (двойная цена). Стена занимает весь столбец x=6, кроме клетки (6,1). Может ли герой за один ход дойти до (7,2)? squares — минимальное число клеток пути с учётом трудной местности, или -1.' },
]
const report = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : { schema_version: 1, created_at: new Date().toISOString(), endpoint: baseUrl, messages, probes: [] }
const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
const spent = () => report.probes.reduce((s, p) => s + (p.usage_cost ?? p.catalog_cost_rub ?? 0), 0)

for (const [model, levels] of Object.entries(LEVELS)) {
  const pricing = catalog.data.find(e => e.id === model).pricing
  for (const level of levels) {
    if (report.probes.some(p => p.model === model && p.level === level)) continue
    assert.ok(spent() + 2000 * pricing.completion + 1000 * pricing.prompt < budgetRub, 'бюджет исчерпан')
    const reasoning = reasoningOf(level)
    const body = { model, messages, max_tokens: 2000, response_format: { type: 'json_object' }, ...(reasoning ? { reasoning } : {}) }
    if (model === 'z-ai/glm-5.3-flash') delete body.response_format
    const started = performance.now()
    const probe = { model, level, reasoning, requested_at: new Date().toISOString() }
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ROUTERAI_API_KEY}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
      })
      const text = await response.text()
      probe.status = response.status
      let payload = null
      try { payload = JSON.parse(text) } catch { /* не JSON */ }
      if (!response.ok) {
        probe.ok = false
        probe.error = String(payload?.error?.message ?? text).slice(0, 400)
      } else {
        const message = payload?.choices?.[0]?.message ?? {}
        const usage = payload?.usage ?? null
        probe.ok = true
        probe.response_model = payload?.model ?? null
        probe.content = String(message.content ?? '').slice(0, 400)
        probe.reasoning_returned_chars = String(message.reasoning ?? message.reasoning_content ?? '').length
        probe.finish_reason = payload?.choices?.[0]?.finish_reason ?? null
        probe.usage = usage
        probe.reasoning_tokens = usage?.completion_tokens_details?.reasoning_tokens ?? null
        probe.usage_cost = typeof usage?.cost === 'number' ? usage.cost : null
        probe.catalog_cost_rub = usage ? (usage.prompt_tokens ?? 0) * pricing.prompt + (usage.completion_tokens ?? 0) * pricing.completion : null
        try { probe.answer = JSON.parse(String(message.content ?? '').replace(/^```(?:json)?|```$/gm, '').trim()) } catch { probe.answer = null }
      }
    } catch (error) {
      probe.ok = false
      probe.error = String(error?.name ?? 'ERROR')
    }
    probe.latency_ms = Math.round(performance.now() - started)
    report.probes.push(probe)
    save()
    console.log(JSON.stringify({ model, level, status: probe.status, ok: probe.ok, ms: probe.latency_ms, rt: probe.reasoning_tokens, ct: probe.usage?.completion_tokens, cost: probe.usage_cost, err: probe.error?.slice(0, 160), ans: probe.answer }))
  }
}
report.spent_rub = spent()
save()
console.log(JSON.stringify({ output, probes: report.probes.length, spent_rub: report.spent_rub }))
