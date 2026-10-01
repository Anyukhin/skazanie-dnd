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
