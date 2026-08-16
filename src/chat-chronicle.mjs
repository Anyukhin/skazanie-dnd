export const CHRONICLE_FILTERS = Object.freeze(['all', 'story', 'combat'])

/**
 * Фильтр хроники. Обычно вид записи задаёт говорящий, но у системной ленты есть
 * исключения — врезка «Пока вас не было…» и конверт почты отряда: их пишет
 * сервер системной записью, а читаются они как рассказ. Без третьего признака
 * они прятались бы под фильтром «Рассказ» и всплывали под «Боем» — ровно
 * наоборот тому, чем являются.
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
