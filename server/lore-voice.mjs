import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildDataOnlyContext } from './security.mjs'

/**
 * Голос хранителя знаний: ответ «что мы знаем о…» звучит как реплика ведущего,
 * а не как сводка «Из того, что вы нашли: … Вам говорили — …» (судья замеров
 * 2026-10-10: «звучит как служебная сводка», 3–5 из 10).
 *
 * Что отвечать, решает сервер: материал отбирает `answerKnownLore`
 * (`server/player-request-router.mjs`) из того, что отряд нашёл, слышал и
 * знает. Модель только пересказывает его. Ответ проверяется: без чисел и
 * служебных слов, без имён вне материала, и каждая находка должна остаться в
 * ответе по смыслу. Не прошёл — звучит прежний серверный ответ.
 */
export const LORE_KEEPER_PROMPT_VERSION = 'lore_keeper/v1'
const prompt = readFileSync(fileURLToPath(new URL('../prompts/lore_keeper/v1.txt', import.meta.url)), 'utf8')

const SERVICE_WORDS = /(?<![\p{L}])(?:бриф|сервер\p{L}*|материал\p{L}*|факт\p{L}*|lore_brief|json)(?![\p{L}])/iu

const stem = (word) => String(word ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е').slice(0, 5)
const stemsOf = (text) => new Set((String(text ?? '').match(/\p{L}{5,}/gu) ?? []).map(stem))

/**
 * Имена в ответе — слова с заглавной не в начале предложения. Каждое обязано
 * встречаться в материале, месте или имени героя: так модель не приводит
 * в ответ новых людей и места.
 */
function inventedNames(answer, allowedText) {
  const allowed = (String(allowedText ?? '').match(/\p{L}{3,}/gu) ?? []).map((word) => word.toLocaleLowerCase('ru').replace(/ё/gu, 'е'))
  // Имя склоняется: «Ила» — «Иле», «Илой»; «Дорр» — «Дорра». Своё имя — то,
  // что совпадает с разрешённым словом по основе: на всю длину короткого без
  // последней буквы, но не больше трёх букв.
  const known = (word) => {
    const value = word.toLocaleLowerCase('ru').replace(/ё/gu, 'е')
    return allowed.some((other) => {
      const shorter = Math.min(other.length, value.length)
      const need = Math.max(2, Math.min(3, shorter - 1))
      return other.slice(0, need) === value.slice(0, need)
    })
  }
  const names = []
  for (const match of String(answer).matchAll(/(?<![.!?…«"\n]\s{0,3})(?<=\p{L}[,;:—–-]?\s+)(\p{Lu}\p{Ll}{2,})/gu)) {
    if (!known(match[1])) names.push(match[1])
  }
  return names
}

/** Находка или сведение осталось в ответе: хотя бы две его основы (или одна у короткой). */
function keepsSubstance(answer, item) {
  const said = stemsOf(answer)
  const own = [...stemsOf(item)]
  if (!own.length) return true
  const shared = own.filter((value) => said.has(value)).length
  return shared >= Math.min(2, own.length)
}

/**
 * @param {string} answer
 * @param {{ found?: string[], heard?: Array<{ who: string, line: string }>, known?: string[], lead?: Array<{ name: string, role?: string }>, hook?: string }} material
 * @param {{ location?: string, hero?: string }} [context]
 * @returns {{ valid: boolean, reasons: string[] }}
 */
export function verifyLoreAnswer(answer, material = {}, context = {}) {
  const text = String(answer ?? '').trim()
  const reasons = []
  if (text.length < 30 || text.length > 900) reasons.push('length')
  if (/\d/u.test(text)) reasons.push('digits')
  if (SERVICE_WORDS.test(text)) reasons.push('service_words')
  const allowedText = JSON.stringify(material) + ` ${context.location ?? ''} ${context.hero ?? ''}`
  const names = inventedNames(text, allowedText)
  if (names.length) reasons.push(`invented_names:${names.slice(0, 3).join(',')}`)
  for (const item of [...(material.found ?? []), ...(material.known ?? [])]) {
    if (!keepsSubstance(text, item)) { reasons.push('lost_finding'); break }
  }
  for (const entry of material.heard ?? []) {
    if (!text.includes(String(entry.who ?? '').split(/\s+/u)[0] ?? '\u0000') && !keepsSubstance(text, entry.line)) { reasons.push('lost_testimony'); break }
  }
  return { valid: reasons.length === 0, reasons }
}

export class LoreVoice {
  /**
   * @param {{ llmClient?: any, timeoutMs?: number }} [options]
   */
  constructor({ llmClient = null, timeoutMs = 9_000 } = {}) {
    this.llmClient = llmClient
    this.timeoutMs = timeoutMs
  }

  /**
   * Пересказ материала голосом ведущего или `null`, если модели нет, она
   * ошиблась или ответ не прошёл проверку.
   *
   * @param {{ question: string, material: any, location?: string, hero?: string }} input
   * @returns {Promise<{ narration: string, prompt_version: string } | null>}
   */
  async retell({ question, material, location = '', hero = '' }) {
    if (!this.llmClient?.completeJson || !material) return null
    const hasMaterial = (material.found?.length ?? 0) + (material.heard?.length ?? 0) + (material.known?.length ?? 0) > 0 || Boolean(material.hook)
    if (!hasMaterial) return null
    try {
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: buildDataOnlyContext({ lore_brief: { question: String(question ?? '').slice(0, 400), ...material, location, hero } }) },
        ],
        temperature: 0.5,
        maxTokens: 600,
        role: 'lore_keeper',
      }, { timeoutMs: this.timeoutMs })
      const answer = String(result?.answer ?? '').replace(/\s+/gu, ' ').trim()
      if (!verifyLoreAnswer(answer, material, { location, hero }).valid) return null
      return { narration: answer, prompt_version: LORE_KEEPER_PROMPT_VERSION }
    } catch {
      return null
    }
  }
}
