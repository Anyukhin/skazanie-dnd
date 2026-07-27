import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { eventSummary } from './rules-engine.mjs'
import { DeterministicNarrationVerifier, assertNarrationBrief, buildDataOnlyContext } from './security.mjs'

export const NARRATOR_PROMPT_VERSION = 'narrator/v1'
/** Постоянный серверный текст: он и только он стоит снаружи блока данных. */
const REPAIR_INSTRUCTION = 'Исправь нарушения предыдущего варианта: они перечислены в секции narration_violations.'
const promptPath = fileURLToPath(new URL('../prompts/narrator/v1.txt', import.meta.url))
const narratorPrompt = readFileSync(promptPath, 'utf8')

function safeSuggestions(value) {
  return Array.isArray(value) ? value.slice(0, 3).map((item) => String(item).slice(0, 120)).filter(Boolean) : []
}

export function deterministicNarration(brief, resolveName) {
  assertNarrationBrief(brief)
  const summaries = brief.visible_events.map((event) => eventSummary(event, resolveName)).filter(Boolean)
  const narration = summaries.length
    ? summaries.slice(0, 4).join('. ').replace(/\.+$/u, '') + '.'
    : 'Ситуация остаётся открытой: подтверждённых механических последствий пока нет.'
  return { narration, suggestions: [] }
}

export class Narrator {
  constructor({ llmClient = null, verifier = new DeterministicNarrationVerifier(), maxAttempts = 2 } = {}) {
    this.llmClient = llmClient
    this.verifier = verifier
    this.maxAttempts = Math.max(1, Math.min(3, Number(maxAttempts) || 2))
  }

  async render(brief, { knownRuleIds = [], style = 'Кратко и конкретно', timeoutMs = null } = {}) {
    assertNarrationBrief(brief)
    if (!this.llmClient) {
      const fallback = deterministicNarration(brief)
      return { ...fallback, verification: this.verifier.verify(fallback.narration, brief, { knownRuleIds }), prompt_version: NARRATOR_PROMPT_VERSION, provider: 'deterministic' }
    }

    const requestedTimeout = Number(timeoutMs)
    const deadlineController = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? new AbortController()
      : null
    const deadline = deadlineController
      ? setTimeout(() => {
          const error = new Error('Истекло время на необязательное повествование')
          error.code = 'NARRATION_DEADLINE'
          deadlineController.abort(error)
        }, requestedTimeout)
      : null
    try {
      let lastVerification = null
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        // Перечень нарушений несёт куски предыдущего ответа модели: `match`
        // приходит из её же текста. Модель — недоверенный генератор, поэтому
        // сам перечень уходит отдельной секцией внутрь UNTRUSTED_DATA, а
        // снаружи остаётся только постоянная серверная фраза.
        const violations = lastVerification?.violations?.length ? lastVerification.violations : null
        const repair = violations ? `\n${REPAIR_INSTRUCTION}` : ''
        let output
        try {
          output = await this.llmClient.completeJson({
            messages: [
              { role: 'system', content: narratorPrompt },
              {
                role: 'user',
                content: `${buildDataOnlyContext({
                  narration_brief: brief,
                  style,
                  ...(violations ? { narration_violations: violations } : {}),
                })}${repair}`,
              },
            ],
            temperature: 0.55,
            jsonExpected: 'object',
            signal: deadlineController?.signal,
          })
        } catch (error) {
          const fallback = deterministicNarration(brief)
          return {
            ...fallback,
            verification: {
              ...this.verifier.verify(fallback.narration, brief, { knownRuleIds }),
              provider_error: String(error?.code ?? error?.name ?? 'LLM_PROVIDER_ERROR').slice(0, 80),
            },
            prompt_version: NARRATOR_PROMPT_VERSION,
            provider: 'deterministic-provider-fallback',
          }
        }
        const result = { narration: String(output?.narration || '').trim(), suggestions: safeSuggestions(output?.suggestions) }
        lastVerification = this.verifier.verify(result.narration, brief, { knownRuleIds })
        if (lastVerification.valid && result.narration) {
          return { ...result, verification: lastVerification, prompt_version: NARRATOR_PROMPT_VERSION, provider: this.llmClient.constructor?.name ?? 'llm' }
        }
      }

      const fallback = deterministicNarration(brief)
      return {
        ...fallback,
        verification: { ...this.verifier.verify(fallback.narration, brief, { knownRuleIds }), repaired_from: lastVerification?.violations ?? [] },
        prompt_version: NARRATOR_PROMPT_VERSION,
        provider: 'deterministic-fallback',
      }
    } finally {
      if (deadline) clearTimeout(deadline)
    }
  }
}
