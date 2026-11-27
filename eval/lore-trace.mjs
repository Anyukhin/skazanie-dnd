import { serverCall } from '../test/kit/fixtures.mjs'

const matchesRenderedPlan = (answer, material) => serverCall('matchesRenderedLorePlan', answer, material)

/**
 * Проверка ответа хранителя относительно материала, отобранного сервером.
 * Канонический ответ можно сверить дословно даже при отсутствии сведений.
 */
export async function traceLoreAnswer(answer, lore, matchesPlan = matchesRenderedPlan) {
  const material = lore?.lore_material
  const claims = (material?.heard?.length ?? 0) + (material?.found?.length ?? 0) + (material?.known?.length ?? 0)
  if (lore?.narration && answer === lore.narration) return { status: 'checked', claims, reasons: [] }
  if (!material) return { status: 'unverified', claims: 0, reasons: [] }
  return { status: 'checked', claims, reasons: await matchesPlan(answer, material) ? [] : ['unsupported_answer'] }
}
