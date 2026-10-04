export const CHRONICLE_FILTERS = Object.freeze(['all', 'story', 'combat'])

/** Убирает транспортные метки из подписи маршрута, сохраняя исходный запрос в состоянии. */
export function chronicleMessageText(text) {
  return String(text ?? '').replace(/^\s*\[(?:ГЛОБАЛЬНАЯ КАРТА|РЕШЕНИЕ ГРУППЫ)\]\s*(?:\[destination_location_id=[^\]\r\n]{1,120}\]\s*)?/u, '')
}

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

/**
 * Следить ли за лентой после события прокрутки. Отпускает низ только движение
 * вверх: плавная прокрутка к новой записи сама шлёт события `scroll`, пока ещё
 * не доехала до низа, и прежняя проверка «у низа ли мы» на первом же таком
 * событии выключала слежение — дальше ответы копились счётчиком «↓ N», хотя
 * игрок ленту не трогал. Живой прогон 2026-10-02.
 *
 * @param {{ scrollHeight: number, clientHeight: number, scrollTop: number }} viewport
 * @param {number} previousScrollTop положение ленты на прошлом событии
 * @param {boolean} following следили ли за лентой до этого события
 */
export function chronicleFollowAfterScroll(viewport, previousScrollTop, following) {
  if (isChronicleNearBottom(viewport)) return true
  return viewport.scrollTop < previousScrollTop - 1 ? false : following
}
