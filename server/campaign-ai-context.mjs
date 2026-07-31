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

export function runWithCampaignAiSettings(settings, operation) {
  const value = settings && typeof settings === 'object'
    ? {
        model: String(settings.model ?? '').trim(),
        narratorStyle: normalizeNarratorStyle(settings.narratorStyle),
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

export function currentNarratorStyleInstruction() {
  const settings = currentCampaignAiSettings()
  return settings ? NARRATOR_STYLES[currentNarratorStyle()].instruction : ''
}

export function currentNarratorGenerationParameters() {
  return NARRATOR_GENERATION_PARAMETERS
}
