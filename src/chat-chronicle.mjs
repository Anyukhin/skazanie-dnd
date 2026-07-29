export const CHRONICLE_FILTERS = Object.freeze(['all', 'story', 'combat'])

/**
 * @param {'narrator' | 'player' | 'system'} speaker
 * @param {'all' | 'story' | 'combat'} filter
 */
export function chronicleMatchesFilter(speaker, filter) {
  if (filter === 'combat') return speaker === 'system'
  if (filter === 'story') return speaker === 'narrator' || speaker === 'player'
  return true
}

/**
 * @param {{ scrollHeight: number, clientHeight: number, scrollTop: number }} viewport
 * @param {number} [threshold]
 */
export function isChronicleNearBottom(viewport, threshold = 56) {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= threshold
}
