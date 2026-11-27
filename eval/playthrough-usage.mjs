const EVENING_ACTIONS = 150
const roundRub = (value) => Math.round(value * 100) / 100

/** Журнал включает неуспешные и ещё зарезервированные вызовы. Нулевой
 * агрегат цены также возвращается, когда поставщик не прислал стоимость. */
export function playthroughUsage(report, actions, model, pricing) {
  const tokens = report.committed_tokens ?? 0
  const completed = report.completed_requests ?? 0
  let cost = null
  let source = 'нет данных о стоимости'
  if (report.provider_cost > 0) {
    cost = report.provider_cost
    source = 'учтено по данным поставщика'
  } else if (tokens > 0 && report.input_tokens + report.output_tokens === tokens
      && pricing?.prompt != null && pricing?.completion != null) {
    const estimate = report.input_tokens * pricing.prompt + report.output_tokens * pricing.completion
    if (Number.isFinite(estimate)) {
      cost = estimate
      source = 'оценка по каталогу для ' + model
    }
  }
  const representative = actions > 0 && completed > 0 && completed === report.requests && tokens > 0 && cost != null
  const perAction = representative ? cost / actions : null
  return {
    requests: report.requests, completed_requests: completed, failed_requests: report.failed_requests,
    tokens, input_tokens: report.input_tokens, output_tokens: report.output_tokens,
    cost_rub: cost == null ? null : roundRub(cost), cost_source: source,
    per_action_rub: perAction == null ? null : Math.round(perAction * 1000) / 1000,
    per_evening_rub: perAction == null ? null : roundRub(perAction * EVENING_ACTIONS),
  }
}

export function budgetCriterion(live, usage) {
  const criterion = { id: 8, name: 'Бюджет', score: null }
  if (!live) return { ...criterion, detail: 'Прогон без модели' }
  if (!usage) return { ...criterion, detail: 'Журнал расхода недоступен' }
  const count = `Попыток ${usage.requests}, успешно ${usage.completed_requests}, ошибок ${usage.failed_requests}, токенов ${usage.tokens}.`
  const spent = usage.cost_rub == null ? 'Стоимость неизвестна.' : `Расход ≈${usage.cost_rub} ₽ (${usage.cost_source}).`
  const evening = usage.per_evening_rub
  if (evening == null) return { ...criterion, detail: `${count} ${spent} Данных для прогноза на вечер недостаточно.` }
  return { ...criterion, score: evening <= 50 ? 10 : evening <= 75 ? 6 : 3,
    detail: `${count} ${spent} ≈${usage.per_action_rub} ₽ на реплику, ≈${evening} ₽ за ${EVENING_ACTIONS} реплик (цель ≤ 50 ₽).` }
}
