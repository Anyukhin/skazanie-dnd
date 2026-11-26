import { renderLorePlan, validateLorePlan } from '../server/lore-voice.mjs'

// План модели приватен. Восстанавливаем только порядки, начало которых
// дословно совпало с репликой, используя тот же рендер, что и игра.
function matchesRenderedPlan(answer, material) {
  const references = ['found', 'heard', 'known', 'lead'].flatMap(kind =>
    (material[kind] ?? []).map((_, index) => ({ kind, index })))
  const withoutClosing = { ...material, unknown: false, hook: '' }
  function matches(plan, remaining) {
    if (renderLorePlan(plan, material) === answer && validateLorePlan({ plan }, material).valid) return true
    return remaining.some(ref => {
      const next = [...plan, ref]
      const prefix = renderLorePlan(next, withoutClosing)
      return prefix && answer.includes(prefix) && matches(next, remaining.filter(entry => entry !== ref))
    })
  }
  return matches([], references)
}

/**
 * Проверка ответа хранителя относительно материала, отданного сервером.
 * Канонический ответ можно сверить дословно даже при отсутствии сведений.
 */
export function traceLoreAnswer(answer, lore) {
  const material = lore?.lore_material
  const claims = (material?.heard?.length ?? 0) + (material?.found?.length ?? 0) + (material?.known?.length ?? 0)
  if (lore?.narration && answer === lore.narration) return { status: 'checked', claims, reasons: [] }
  if (!material) return { status: 'unverified', claims: 0, reasons: [] }
  return { status: 'checked', claims, reasons: matchesRenderedPlan(answer, material) ? [] : ['unsupported_answer'] }
}
