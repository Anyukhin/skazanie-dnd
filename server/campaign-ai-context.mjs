import { AsyncLocalStorage } from 'node:async_hooks'

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

// Творческие параметры Рассказчика живут рядом с моделью и стилем кампании,
// а не внутри самого агента. RouterAI принимает оба штрафа в диапазоне
// [-2, 2]; умеренные значения уменьшают самоповтор, не ломая связность прозы.
export const NARRATOR_GENERATION_PARAMETERS = Object.freeze({
  temperature: 0.8,
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

export function runWithCampaignAiSettings(settings, operation) {
  const value = settings && typeof settings === 'object'
    ? {
        model: String(settings.model ?? '').trim(),
        narratorStyle: normalizeNarratorStyle(settings.narratorStyle),
        improvMode: normalizeImprovMode(settings.improvMode),
      }
    : null
  return campaignAiContext.run(value, operation)
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
