// Эталон для `model_style_profiles.rs`: добавки к промпту байт в байт,
// профили рассуждений, карточки моделей и таблицы — по всем известным моделям.
//
//   node rust/crates/sk-narration-base/fixtures/gen-model-style-profiles.mjs
import { writeFileSync } from 'node:fs'

import {
  MODEL_OPTIONS,
  REASONING_PROFILES,
  RECOMMENDED_MODEL,
  SELECTABLE_EXTRA_MODELS,
  STRUCTURED_OUTPUT_MODELS,
  campaignRoleReasoning,
  modelOptionFor,
  promptForModel,
  promptForModelRole,
  reasoningLevelAllowedFor,
  reasoningProfileFor,
  styleAddendumFor,
  supportsJsonSchema,
} from '../../../../server/model-style-profiles.mjs'

const models = [
  ...Object.keys(MODEL_OPTIONS), 'openai/gpt-5.6-luna', 'openai/gpt-5.6-luna-pro', 'z-ai/glm-5.2', 'vendor/unknown-model', '', null,
  'OPENAI/GPT-6-LUNA', ' openai/gpt-6-luna',
]
const roles = ['narrator', 'npc', 'shared', 'director', '', undefined]
const levels = ['auto', 'thoughtful', 'deep', 'high', '', null]
const cases = []
for (const model of models) {
  const client = model === null ? null : { model }
  const entry = {
    model,
    addendum: styleAddendumFor(model),
    prompt: promptForModel('база', client),
    roles: roles.map((role) => ({ role: role ?? null, prompt: promptForModelRole('база', client, role) })),
    reasoning: reasoningProfileFor(model),
    supportsJsonSchema: supportsJsonSchema(model),
  }
  if (typeof model === 'string') {
    entry.option = modelOptionFor(model)
    entry.optionRecommended = modelOptionFor(model, { recommended: RECOMMENDED_MODEL })
    entry.levels = levels.map((level) => ({ level, allowed: reasoningLevelAllowedFor(model, level) }))
    entry.campaign = levels.flatMap((level) => ['narrator', 'director', 'npc', ''].map((role) => ({ level, role, reasoning: campaignRoleReasoning(model, level, role) })))
  }
  cases.push(entry)
}
const fixture = {
  modelOptions: MODEL_OPTIONS,
  reasoningProfiles: REASONING_PROFILES,
  recommendedModel: RECOMMENDED_MODEL,
  selectableExtraModels: SELECTABLE_EXTRA_MODELS,
  structuredOutputModels: STRUCTURED_OUTPUT_MODELS,
  cases,
}
writeFileSync(new URL('./model-style-profiles.json', import.meta.url), `${JSON.stringify(fixture, null, 1)}\n`)
console.log(`моделей ${cases.length}`)
