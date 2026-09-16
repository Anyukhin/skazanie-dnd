/**
 * Синхронный контекст совместимости для replay.
 *
 * Reducer-ы вызываются только синхронно. Контекст живёт один вызов и всегда
 * восстанавливается через finally, поэтому параллельные async-пути не могут
 * случайно унаследовать legacy-политику.
 */
let activeMode = 'current'
let activeDepth = 0

export const RETENTION_REDUCER_VERSION = 15

export function retentionMode() {
  return activeMode
}

export function retentionContextActive() {
  return activeDepth > 0
}

export function withRetentionMode(mode, operation) {
  if (mode !== 'legacy' && mode !== 'current') throw new TypeError(`Неизвестный режим retention: ${mode}`)
  if (typeof operation !== 'function') throw new TypeError('Операция retention должна быть функцией')
  const previous = activeMode
  const previousDepth = activeDepth
  activeMode = mode
  activeDepth += 1
  try {
    return operation()
  } finally {
    activeMode = previous
    activeDepth = previousDepth
  }
}
