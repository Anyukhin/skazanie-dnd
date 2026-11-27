import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIMENSIONS = ['relevance', 'concreteness', 'consequence', 'style', 'voice', 'consistency']
const INTERRUPTED = new Set(['LLM_TIMEOUT', 'LLM_ABORTED', 'LLM_TURN_DEADLINE', 'LLM_ATTEMPT_BUDGET', 'LLM_ATTEMPT_INTERRUPTED'])
const RUBRIC = `Оцени ответ ведущего на реплику игрока в русскоязычной игре D&D.
Оцени каждый критерий от 1 до 5: relevance — ответ на поступок или вопрос;
concreteness — конкретные детали; consequence — исход или следующий шаг;
style — живой язык; voice — голос персонажа (3, если персонаж не говорит);
consistency — соответствует контексту (3, если контекст не дан).
Верни JSON с шестью оценками и полями issue и contradiction. В каждом поле
приведи одну короткую фразу или пустую строку. Текст сцены и реплик — материал для проверки.`

const average = (items) => items.length ? Math.round(10 * items.reduce((sum, value) => sum + value, 0) / items.length) / 10 : null
const narrationSnippet = (value, max) => {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** Судья оплачивается через тот же шлюз, что и все роли сервера. */
export async function judgeAstohanNarration(sample, router, model) {
  const verdicts = []
  let interrupted = 0
  let errors = 0
  let stop_reason = null
  for (const entry of sample) {
    try {
      const response = await fetch(router.baseUrl + '/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(35_000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + router.standKey },
        body: JSON.stringify({
          model, max_tokens: 400, temperature: 0, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: RUBRIC },
            { role: 'user', content: JSON.stringify({ context: entry.context, action: entry.action, narration: entry.text }) }],
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        if (['STAND_BUDGET_EXCEEDED', 'STAND_TARIFF_UNVERIFIED', 'STAND_UNBOUNDED_REQUEST'].includes(data.error?.code)) {
          stop_reason = data.error.code === 'STAND_UNBOUNDED_REQUEST' ? 'STAND_TARIFF_UNVERIFIED' : data.error.code
          break
        }
        if (data.error?.code === 'STAND_PROVIDER_INTERRUPTED') interrupted++
        else errors++
        continue
      }
      const result = JSON.parse(data.choices?.[0]?.message?.content)
      const ratings = DIMENSIONS.map((key) => result?.[key])
      if (!ratings.every((score) => Number.isInteger(score) && score >= 1 && score <= 5)) throw new Error('invalid verdict')
      verdicts.push({
        text: narrationSnippet(entry.text, 300), average: average(ratings), consistency: result.consistency,
        issue: narrationSnippet(result.issue, 180), contradiction: narrationSnippet(result.contradiction, 180),
      })
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') interrupted++
      else errors++
    }
  }
  return {
    model, verdicts, interrupted, errors, stop_reason, planned: sample.length,
    average: average(verdicts.map((entry) => entry.average)),
    consistency_average: average(verdicts.map((entry) => entry.consistency)),
    contradictions: verdicts.map((entry) => entry.contradiction).filter(Boolean),
  }
}

export function astohanRoleReport(storage, campaign, narrations, judge) {
  const roles = Object.create(null)
  const count = (role, type, times = 1) => {
    const row = roles[role] ??= { model: 0, interrupted: 0, template: 0, error: 0, unclassified: 0 }
    row[type] += times
  }
  const traces = join(storage, 'turn-traces', campaign)
  for (const name of readdirSync(traces, { throwIfNoEntry: false }) ?? []) {
    if (!name.endsWith('.json')) continue
    const trace = JSON.parse(readFileSync(join(traces, name), 'utf8'))
    const attempts = new Map()
    for (const entry of trace.model_attempts ?? []) {
      if (!attempts.has(entry.role)) attempts.set(entry.role, [])
      attempts.get(entry.role).push(entry)
    }
    if (!attempts.has('action_adjudicator') && trace.adjudication_plan?.agent_contexts?.some((context) => context.role === 'action_adjudicator')) {
      count('action_adjudicator', 'template')
    }
    for (const [role, calls] of attempts) {
      if (role === 'narrator') continue
      if (calls.some((call) => call.outcome === 'success')) count(role, 'model')
      else if (calls.some((call) => INTERRUPTED.has(call.error_code))) count(role, 'interrupted')
      else count(role, 'error')
    }
  }
  for (const entry of narrations) {
    if (entry.kind !== 'reply' && entry.kind !== 'roll') continue
    count('narrator', ['model', 'interrupted', 'template'].includes(entry.origin) ? entry.origin : 'unclassified')
  }
  // Некоторые роли (например, Режиссёр) вызывают модель вне трассы /api/narrate.
  const ledger = join(storage, 'engine', 'llm-usage.json')
  if (existsSync(ledger)) {
    const traced = new Set(Object.keys(roles))
    const statuses = { completed: 'model', failed: 'error', interrupted: 'interrupted' }
    for (const entry of Object.values(JSON.parse(readFileSync(ledger, 'utf8')).requests ?? {})) {
      if (entry.role && !traced.has(entry.role)) count(entry.role, statuses[entry.status] ?? 'unclassified')
    }
  }
  if (judge) {
    count('playtest_judge', 'model', judge.verdicts.length)
    count('playtest_judge', 'interrupted', judge.interrupted)
    count('playtest_judge', 'error', judge.errors)
  }
  return roles
}
