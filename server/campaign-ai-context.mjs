import { AsyncLocalStorage } from 'node:async_hooks'

import { campaignRoleReasoning } from './model-style-profiles.mjs'

export const NARRATOR_STYLES = Object.freeze({
  neutral: {
    id: 'neutral',
    label: 'Нейтральный',
    instruction: 'Нейтральный литературный русский: ясно, образно и без нарочитой канцелярской или шутливой интонации.',
  },
  formal: {
    id: 'formal',
    label: 'Официальный',
    instruction: 'Сдержанный официальный русский: точные формулировки, серьёзный тон и минимум разговорных оборотов.',
  },
  ironic: {
    id: 'ironic',
    label: 'Ироничный',
    instruction: 'Лёгкая доброжелательная ирония без пародии, унижения героев и нарушения подтверждённых фактов.',
  },
})

// Режим импровизации — насколько свободно Режиссёр перестраивает историю под
// незапланированные действия отряда. Значение только объявлено и доставляется
// до контекста Режиссёра; выбор промпта по нему делается отдельной задачей.
export const IMPROV_MODES = Object.freeze({
  // Описание пишется со строчной буквы: интерфейс печатает его через тире
  // сразу после подписи — «Сюжет — свобода в сценах…».
  story: {
    id: 'story',
    label: 'Сюжет',
    description: 'свобода в сценах, но главная линия в приоритете',
  },
  chaos: {
    id: 'chaos',
    label: 'Хаос',
    description: 'можно всё, мир подстраивается под выбор отряда',
  },
})

export const DEFAULT_IMPROV_MODE = 'story'

/**
 * Профиль рассуждений, который выбирает лидер кампании. Это не сырой уровень
 * RouterAI, а проверенная замером раскладка по ролям
 * (`docs/model-reasoning-sweep-2026-10-01.md`): размышления не повысили
 * точность ни в одной роли, а арбитр свободного действия и создание мира на
 * высоких уровнях ломаются. Поэтому профиль меняет только творческие роли,
 * а конкретные уровни для каждой модели лежат в `REASONING_PROFILES`
 * (`server/model-style-profiles.mjs`). `auto` — профиль сервера
 * `reasoningProfileFor`. Описания пишутся со строчной буквы: интерфейс
 * печатает их через тире после подписи.
 */
export const REASONING_LEVELS = Object.freeze({
  auto: { id: 'auto', label: 'Авто', description: 'без размышлений: быстрее всего и, по замеру, без выдуманных фактов' },
  thoughtful: { id: 'thoughtful', label: 'Вдумчивее', description: 'Режиссёр и NPC коротко размышляют; ответ на секунду-две дольше, точнее по замеру не стало' },
  deep: { id: 'deep', label: 'Глубже', description: 'рассказчик и Режиссёр думают дольше всех; реплика NPC — до 8 секунд' },
})

export const DEFAULT_REASONING_LEVEL = 'auto'

// Творческие параметры Рассказчика живут рядом с моделью и стилем кампании,
// а не внутри самого агента. RouterAI принимает оба штрафа в диапазоне
// [-2, 2]; умеренные значения уменьшают самоповтор, не ломая связность прозы.
export const NARRATOR_GENERATION_PARAMETERS = Object.freeze({
  temperature: 0.4,
  frequencyPenalty: 0.35,
  presencePenalty: 0.2,
})

const campaignAiContext = new AsyncLocalStorage()
const modelAttemptContext = new AsyncLocalStorage()

const MODEL_TURN_TIMEOUT_MS = 12_000
const MODEL_TURN_OLLAMA_RESERVE_MS = 5_000

export function normalizeNarratorStyle(value) {
  const id = String(value ?? '').trim().toLowerCase()
  return Object.hasOwn(NARRATOR_STYLES, id) ? id : 'neutral'
}

export function normalizeImprovMode(value) {
  const id = String(value ?? '').trim().toLowerCase()
  return Object.hasOwn(IMPROV_MODES, id) ? id : DEFAULT_IMPROV_MODE
}

export function normalizeReasoningLevel(value) {
  const id = String(value ?? '').trim().toLowerCase()
  return Object.hasOwn(REASONING_LEVELS, id) ? id : DEFAULT_REASONING_LEVEL
}

export function runWithCampaignAiSettings(settings, operation) {
  const value = settings && typeof settings === 'object'
    ? {
        model: String(settings.model ?? '').trim(),
        narratorStyle: normalizeNarratorStyle(settings.narratorStyle),
        improvMode: normalizeImprovMode(settings.improvMode),
        reasoningLevel: normalizeReasoningLevel(settings.reasoningLevel),
      }
    : null
  return campaignAiContext.run(value, operation)
}

/** Начать запрос с отдельным журналом попыток провайдера. */
export function runWithModelAttemptCollector(operation, timeoutMs = MODEL_TURN_TIMEOUT_MS, reserveMs = MODEL_TURN_OLLAMA_RESERVE_MS) {
  if (modelAttemptContext.getStore()) return operation()
  return modelAttemptContext.run({ attempts: [], deadline: performance.now() + timeoutMs, timeoutMs, reserveMs }, operation)
}

export function currentModelTurnBudget(requestedTimeout, hasProviderFallback) {
  const context = modelAttemptContext.getStore()
  if (!context) return null
  const now = performance.now()
  const remainingMs = Math.max(0, context.deadline - now)
  const timeoutMs = Math.min(requestedTimeout ?? Infinity, remainingMs)
  const localReserve = timeoutMs * context.reserveMs / context.timeoutMs
  const cloudDeadline = hasProviderFallback ? Math.min(context.deadline - context.reserveMs, now + timeoutMs - localReserve) : null
  return { timeoutMs, cloudDeadline }
}

function modelAttemptIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(value) && !value.includes('://') ? value : ''
}

/** Попытка видна и тогда, когда внешний таймер не дал дождаться ответа. */
export function startModelAttempt({ role, provider, model, schemaRequested, fallbackReason }) {
  const collector = modelAttemptContext.getStore()?.attempts
  if (!collector || collector.length >= 32) return null
  const attempt = { started: performance.now(), fields: {
    role: modelAttemptIdentifier(role) || 'unknown',
    provider: modelAttemptIdentifier(provider) || 'unknown',
    model: modelAttemptIdentifier(model) || 'unknown',
    schema_requested: schemaRequested,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
  }, result: null }
  collector.push(attempt)
  return attempt
}

export function finishModelAttempt(attempt, { response, error, failed = false }) {
  if (!attempt) return
  const resolved = modelAttemptIdentifier(response?.model)
  const status = error?.status
  attempt.result = {
    duration_ms: Math.floor(performance.now() - attempt.started),
    outcome: failed ? 'error' : 'success',
    ...(resolved && !failed ? { resolved_model: resolved } : {}),
    ...(failed ? { error_code: modelAttemptIdentifier(error?.code ?? error?.name) || 'LLM_ERROR' } : {}),
    ...(Number.isInteger(status) && status >= 100 && status < 600 ? { http_status: status } : {}),
  }
}

export function currentModelAttempts() {
  return (modelAttemptContext.getStore()?.attempts ?? []).map((attempt) => ({ ...attempt.fields, ...(attempt.result ?? {
    duration_ms: Math.floor(performance.now() - attempt.started),
    outcome: 'error', error_code: 'LLM_ATTEMPT_INTERRUPTED',
  }) }))
}

/**
 * Рассуждения, которые кампания заказала для этой модели и этой роли, или
 * `null`, если действует профиль сервера. Выбор лидера касается только
 * выбранной им модели: резервные модели цепочки остаются на своих проверенных
 * профилях. И только ролей, которые явно себя назвали (`role` в запросе):
 * непомеченный вызов — арбитр, создание мира, мораль, архитектор — всегда
 * идёт по профилю сервера, так что новый вызов модели безопасен по умолчанию.
 */
export function campaignReasoningFor(modelId, role = '') {
  const settings = currentCampaignAiSettings()
  if (!settings?.model || settings.model !== String(modelId ?? '')) return null
  return campaignRoleReasoning(settings.model, normalizeReasoningLevel(settings.reasoningLevel), role)
}

export function currentCampaignAiSettings() {
  return campaignAiContext.getStore() ?? null
}

export function currentCampaignModel() {
  return currentCampaignAiSettings()?.model ?? ''
}

export function currentNarratorStyle() {
  return currentCampaignAiSettings()?.narratorStyle ?? 'neutral'
}

export function currentImprovMode() {
  return currentCampaignAiSettings()?.improvMode ?? DEFAULT_IMPROV_MODE
}

export function currentNarratorStyleInstruction() {
  const settings = currentCampaignAiSettings()
  return settings ? NARRATOR_STYLES[currentNarratorStyle()].instruction : ''
}

export function currentNarratorGenerationParameters() {
  return NARRATOR_GENERATION_PARAMETERS
}
