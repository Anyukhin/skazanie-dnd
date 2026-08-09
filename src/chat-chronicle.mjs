export const CHRONICLE_FILTERS = Object.freeze(['all', 'story', 'combat'])

/**
 * Фильтр хроники. Обычно вид записи задаёт говорящий, но у системной ленты есть
 * исключение — врезка «Пока вас не было…»: её пишет сервер системной записью, а
 * читается она как рассказ. Без третьего признака она пряталась бы под
 * фильтром «Рассказ» и всплывала под «Боем» — ровно наоборот тому, чем она
 * является.
 *
 * @param {'narrator' | 'player' | 'system'} speaker
 * @param {'all' | 'story' | 'combat'} filter
 * @param {boolean} [isStoryCard] системная запись, которая относится к рассказу
 */
export function chronicleMatchesFilter(speaker, filter, isStoryCard = false) {
  if (filter === 'combat') return speaker === 'system' && !isStoryCard
  if (filter === 'story') return speaker === 'narrator' || speaker === 'player' || isStoryCard
  return true
}

/**
 * @param {{ scrollHeight: number, clientHeight: number, scrollTop: number }} viewport
 * @param {number} [threshold]
 */
export function isChronicleNearBottom(viewport, threshold = 56) {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= threshold
}
