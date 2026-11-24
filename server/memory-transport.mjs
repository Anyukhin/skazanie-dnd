// @ts-check

/** Версия компактной публичной формы памяти мира. */
export const MEMORY_TRANSPORT_VERSION = 2

/** Capability живёт только на серверной копии пользователя и не сериализуется. */
export const MEMORY_TRANSPORT_CAPABILITY = Symbol('skazanie:memory-transport-v2')

/**
 * @param {Record<string, any> | null | undefined} user
 * @param {number} version
 * @returns {Record<string, any> | null | undefined}
 */
export function withMemoryTransportCapability(user, version) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return user
  const copy = { ...user }
  if (Number(version) === MEMORY_TRANSPORT_VERSION && copy.role !== 'admin') {
    Object.defineProperty(copy, MEMORY_TRANSPORT_CAPABILITY, { value: MEMORY_TRANSPORT_VERSION })
  }
  return copy
}

/**
 * @param {Record<string, any> | null | undefined} user
 * @returns {boolean}
 */
export function memoryTransportV2For(user) {
  const scoped = /** @type {Record<PropertyKey, any> | null | undefined} */ (user)
  return scoped?.role !== 'admin' && scoped?.[MEMORY_TRANSPORT_CAPABILITY] === MEMORY_TRANSPORT_VERSION
}

/**
 * Удаляет только дублирующий public alias после viewer projection.
 * Каноническое состояние и legacy/v1-ответы не проходят через эту функцию.
 *
 * @param {Record<string, any>} memory
 * @param {boolean} [enabled]
 * @returns {Record<string, any>}
 */
export function compactWorldMemoryForTransport(memory, enabled = true) {
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) return memory
  if (!enabled) return memory
  if (!Array.isArray(memory.knowledge_ledger) || !Array.isArray(memory.knowledge_revealed)) return memory
  const { knowledge_revealed: _knowledgeRevealed, ...compact } = memory
  return compact
}
