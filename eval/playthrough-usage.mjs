const EVENING_ACTIONS = 150
const roundRub = (value) => Math.round(value * 100) / 100

/** Цена берётся из подтверждённых списаний. Без полной сверки прогноз не строится. */
export function playthroughUsage(report, actions) {
  const tokens = report.committed_tokens ?? 0
  const completed = report.completed_requests ?? 0
  const confirmed = report.confirmed_cost_requests ?? 0
  const cost = confirmed || report.provider_cost > 0 ? report.provider_cost : null
  const unknown = report.unknown_cost_requests ?? Math.max(0, (report.requests ?? 0) - confirmed)
  const representative = actions > 0 && completed > 0 && completed === report.requests && completed === confirmed && cost != null
  const perAction = representative ? cost / actions : null
  return {
    requests: report.requests, completed_requests: completed, failed_requests: report.failed_requests,
    interrupted_requests: report.interrupted_requests ?? 0, unknown_cost_requests: unknown,
    tokens, input_tokens: report.input_tokens, output_tokens: report.output_tokens,
    cost_rub: cost,
    per_action_rub: perAction == null ? null : Math.round(perAction * 1000) / 1000,
    per_evening_rub: perAction == null ? null : roundRub(perAction * EVENING_ACTIONS),
  }
}

export function budgetCriterion(live, usage) {
  const criterion = { id: 8, name: 'Бюджет', score: null }
  if (!live) return { ...criterion, detail: 'Прогон без модели' }
  if (!usage) return { ...criterion, detail: 'Журнал расхода недоступен' }
  const count = `Попыток ${usage.requests}, успешно ${usage.completed_requests}, ошибок ${usage.failed_requests}, обрывов ${usage.interrupted_requests}, токенов ${usage.tokens}.`
  const spent = `${usage.cost_rub == null ? 'Подтверждённых списаний нет.' : `Подтверждено ${usage.cost_rub} ₽.`} Вызовов с неизвестной стоимостью ${usage.unknown_cost_requests}.`
  const evening = usage.per_evening_rub
  if (evening == null) return { ...criterion, detail: `${count} ${spent} Данных для прогноза на вечер недостаточно.` }
  return { ...criterion, score: evening <= 50 ? 10 : evening <= 75 ? 6 : 3,
    detail: `${count} ${spent} ≈${usage.per_action_rub} ₽ на реплику, ≈${evening} ₽ за ${EVENING_ACTIONS} реплик (цель ≤ 50 ₽).` }
}
