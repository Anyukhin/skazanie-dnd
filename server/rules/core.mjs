// @ts-check
/**
 * Примитивы движка правил, которые нужны и самому `rules-engine.mjs`, и
 * вынесенным из него модулям: редакция по умолчанию, ошибка валидации и
 * безопасное целое. Модуль — лист: он ничего не знает о состоянии кампании.
 */
import { DND_2014_RULESET_ID, LEGACY_DEFAULT_RULESET_ID } from '../ruleset-config.mjs'

export const DEFAULT_RULESET_ID = LEGACY_DEFAULT_RULESET_ID

/** @param {{ ruleset_id?: unknown } | null | undefined} state */
export const usesDnd2014 = (state) => String(state?.ruleset_id ?? DEFAULT_RULESET_ID) === DND_2014_RULESET_ID

export class RulesValidationError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'RULES_VALIDATION_FAILED') {
    super(message)
    this.name = 'RulesValidationError'
    this.code = code
  }
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function safeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : fallback
}
