import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildDataOnlyContext } from './security.mjs'

/** Голос хранителя. Модель выбирает ссылки, сервер собирает текст сам. */
export const LORE_KEEPER_PROMPT_VERSION = 'lore_keeper/v2'
const prompt = readFileSync(fileURLToPath(new URL('../prompts/lore_keeper/v2.txt', import.meta.url)), 'utf8')
const PLAN_KINDS = new Set(['found', 'heard', 'known', 'lead'])

function arrayFor(material, kind) {
  const value = material?.[kind]
  return Array.isArray(value) ? value : []
}

function planEntryKey(entry) {
  return `${entry.kind}:${entry.index}`
}

/** Проверяет, что модель вернула только ссылки на разрешённый материал. */
export function validateLorePlan(result, material = {}) {
  const reasons = []
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { valid: false, reasons: ['plan_required'], plan: [] }
  if (!Array.isArray(result.plan)) reasons.push('plan_required')
  if (Object.keys(result).some((key) => key !== 'plan')) reasons.push('extra_fields')
  const plan = Array.isArray(result.plan) ? result.plan : []
  if (plan.length > arrayFor(material, 'found').length + arrayFor(material, 'heard').length + arrayFor(material, 'known').length + 1) reasons.push('plan_too_long')
  const seen = new Set()
  let leads = 0
  for (const entry of plan) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some((key) => !['kind', 'index'].includes(key))) {
      reasons.push('invalid_reference'); continue
    }
    if (typeof entry.kind !== 'string' || !PLAN_KINDS.has(entry.kind)
      || !Number.isSafeInteger(entry.index) || entry.index < 0
      || entry.index >= arrayFor(material, entry.kind).length) {
      reasons.push('invalid_reference'); continue
    }
    const key = planEntryKey(entry)
    if (seen.has(key)) reasons.push('duplicate_reference')
    if (entry.kind === 'lead') leads += 1
    seen.add(key)
  }
  if (leads > 1) reasons.push('too_many_leads')
  for (const kind of ['found', 'heard', 'known']) {
    for (let index = 0; index < arrayFor(material, kind).length; index += 1) {
      if (!seen.has(`${kind}:${index}`)) reasons.push(`missing_${kind}:${index}`)
    }
  }
  return { valid: reasons.length === 0, reasons, plan }
}

function leadText(entry) {
  const name = String(entry?.name ?? '').trim()
  const role = String(entry?.role ?? '').trim().toLocaleLowerCase('ru')
  if (!name) return ''
  return role ? `${name} (${role})` : name
}

/** Собирает игроку только строки из серверного материала. */
export function renderLorePlan(plan, material = {}) {
  const parts = []
  let foundHeader = false
  let heardHeader = false
  const found = arrayFor(material, 'found')
  const heard = arrayFor(material, 'heard')
  const known = arrayFor(material, 'known')
  for (const entry of plan) {
    if (entry.kind === 'found') {
      const text = String(found[entry.index] ?? '').trim()
      if (text) { parts.push(`${foundHeader ? '' : 'Из того, что вы нашли: '}${text}`); foundHeader = true }
    } else if (entry.kind === 'heard') {
      const source = heard[entry.index] ?? {}
      const who = String(source.who ?? '').trim()
      const line = String(source.line ?? '').trim()
      if (who && line) { parts.push(`${heardHeader ? '' : 'Вам говорили — '}${who}: «${line}»`); heardHeader = true }
    } else if (entry.kind === 'known') {
      const text = String(known[entry.index] ?? '').trim()
      if (text) parts.push(text)
    } else if (entry.kind === 'lead') {
      const lead = leadText(arrayFor(material, 'lead')[entry.index])
      if (lead) parts.push(`Знать больше может ${lead}.`)
    }
  }
  if (material.hook) parts.unshift(`Известно немногое: ${String(material.hook).trim()}`)
  if (material.unknown) parts.unshift('Прямого ответа на этот вопрос пока нет.')
  return parts.join(' ').replace(/\s+/gu, ' ').trim()
}

/** Совместимое имя для генератора эталонов и старых входов проверки. */
export function verifyLoreAnswer(answer, material = {}) {
  const result = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : null
  return validateLorePlan(result, material)
}

export class LoreVoice {
  /** @param {{ llmClient?: any, timeoutMs?: number }} [options] */
  constructor({ llmClient = null, timeoutMs = 9_000 } = {}) {
    this.llmClient = llmClient
    this.timeoutMs = timeoutMs
  }

  /** @param {{ question: string, material: any, location?: string, hero?: string }} input */
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
        temperature: 0.2,
        maxTokens: 300,
        role: 'lore_keeper',
      }, { timeoutMs: this.timeoutMs, usageRole: 'lore_keeper' })
      const verdict = validateLorePlan(result, material)
      if (!verdict.valid) return null
      const narration = renderLorePlan(verdict.plan, material)
      return narration ? { narration, prompt_version: LORE_KEEPER_PROMPT_VERSION } : null
    } catch {
      return null
    }
  }
}
